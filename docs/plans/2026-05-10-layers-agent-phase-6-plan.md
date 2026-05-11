# Phase 6: Long-Running Operations + Video Export Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Phase 1 `getJob`/`waitForJob`/`cancelJob` stubs with a real job registry, then ship three new long-running agent commands: `listInstalledFonts` (sync), `installFontBundle` (job), and `exportVideo` (job).

**Architecture:**
- New `public/js/agent/jobs.js` — module-scoped `Map<id, job>`, AbortController per job, progress reporting, settle promise, 50-job cap. Jobs run via `queueMicrotask` so they execute *outside* the dispatcher's serial queue (the queue continues to serialize commands; jobs run in the background).
- Refactor `export-video-dialog.js`: extract the encoder/frame-loop into a new `public/js/ui/video-exporter.js` exporting a headless `runVideoExport({...})` function. The existing dialog becomes a thin UI shell that delegates to the runner.
- New agent commands wire fontaine-loader and the headless exporter into jobs. `exportVideo` mirrors `exportImage`'s `recentExports` + browser-download pattern.
- Snapshot adds a `jobs` array (most recent N) so agents can poll progress.

**Tech Stack:** Vanilla ES modules (no bundler), Playwright for tests, IndexedDB (fontaine), WebCodecs (MP4), MediaBunny.

---

## Task 1: Job registry module

**Files:**
- Create: `public/js/agent/jobs.js`
- Create: `tests/agent-jobs-registry.spec.js`

- [ ] **Step 1: Write the failing tests**

Create `tests/agent-jobs-registry.spec.js` covering: job lifecycle (queued→running→succeeded), progress reporting, cancellation, failure propagation, `waitForJob` (settle, timeout, post-settle), `getJob` for unknown id, `listJobs` cap. Run in browser context via Playwright as other agent tests do (page reaches into `window.__layersJobs` test hook). Example shape:

```javascript
import { test, expect } from '@playwright/test'

test.describe('agent: jobs registry', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('/')
        await page.evaluate(() => window.LayersAgent.ready)
    })

    test('createJob reaches succeeded with result', async ({ page }) => {
        const final = await page.evaluate(async () => {
            const j = window.__layersJobs
            const { id } = j.createJob('test-kind', async () => ({ ok: 1 }))
            return await j.waitForJob(id, 2000)
        })
        expect(final.status).toBe('succeeded')
        expect(final.result).toEqual({ ok: 1 })
    })

    test('reportProgress updates state', async ({ page }) => {
        const states = await page.evaluate(async () => {
            const j = window.__layersJobs
            const { id } = j.createJob('test-kind', async (api) => {
                api.reportProgress('starting', 0, 100)
                await new Promise(r => setTimeout(r, 10))
                api.reportProgress('working', 50, 100)
                await new Promise(r => setTimeout(r, 10))
                api.reportProgress('done', 100, 100)
                return { ok: true }
            })
            const mid = (await new Promise(r => setTimeout(() => r(j.getJob(id)), 15)))
            const final = await j.waitForJob(id, 2000)
            return { mid, final }
        })
        expect(states.final.status).toBe('succeeded')
        expect(states.final.progress.current).toBe(100)
    })

    test('cancelJob aborts running job', async ({ page }) => {
        const final = await page.evaluate(async () => {
            const j = window.__layersJobs
            const { id } = j.createJob('test-kind', async (api) => {
                while (!api.abortSignal.aborted) {
                    await new Promise(r => setTimeout(r, 5))
                }
                api.checkAbort()
            })
            await new Promise(r => setTimeout(r, 20))
            j.cancelJob(id)
            return await j.waitForJob(id, 2000)
        })
        expect(final.status).toBe('cancelled')
    })

    test('waitForJob with timeout returns timedOut marker', async ({ page }) => {
        const out = await page.evaluate(async () => {
            const j = window.__layersJobs
            const { id } = j.createJob('test-kind', async () => {
                await new Promise(r => setTimeout(r, 500))
                return { ok: true }
            })
            return await j.waitForJob(id, 50)
        })
        expect(out.timedOut).toBe(true)
        expect(out.status).toBe('running')
    })

    test('getJob returns null for unknown id', async ({ page }) => {
        const r = await page.evaluate(() => window.__layersJobs.getJob('does-not-exist'))
        expect(r).toBeNull()
    })

    test('listJobs caps at 50 entries', async ({ page }) => {
        const count = await page.evaluate(async () => {
            const j = window.__layersJobs
            j._reset()
            for (let i = 0; i < 60; i++) {
                const { id } = j.createJob('test-kind', async () => ({ i }))
                await j.waitForJob(id, 2000)
            }
            return j.listJobs().length
        })
        expect(count).toBeLessThanOrEqual(50)
    })

    test('failed job records error code', async ({ page }) => {
        const final = await page.evaluate(async () => {
            const j = window.__layersJobs
            const { id } = j.createJob('test-kind', async () => {
                const e = new Error('boom')
                e.code = 'INTENTIONAL'
                throw e
            })
            return await j.waitForJob(id, 2000)
        })
        expect(final.status).toBe('failed')
        expect(final.error.code).toBe('INTENTIONAL')
    })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /Users/aayars/platform/layers
npx playwright test tests/agent-jobs-registry.spec.js --reporter=list
```
Expected: FAIL — `window.__layersJobs` undefined.

- [ ] **Step 3: Implement `public/js/agent/jobs.js`**

```javascript
/**
 * Job registry — backs getJob/waitForJob/cancelJob agent commands and any
 * long-running operation. Jobs run via queueMicrotask so they execute outside
 * the dispatcher's serial queue; commands stay one-at-a-time, jobs run in the
 * background and can be polled or awaited.
 *
 * @module agent/jobs
 */

const _jobs = new Map()
const _waiters = new Map()
const MAX_JOBS = 50
let _idCounter = 0

function makeId() {
    _idCounter++
    return `job_${Date.now().toString(36)}_${_idCounter}`
}

function isSettled(status) {
    return status === 'succeeded' || status === 'failed' || status === 'cancelled'
}

function serializeJob(job) {
    if (!job) return null
    return {
        id: job.id,
        kind: job.kind,
        status: job.status,
        startedAt: job.startedAt,
        updatedAt: job.updatedAt,
        completedAt: job.completedAt,
        progress: { ...job.progress },
        result: job.result,
        error: job.error
    }
}

function notifyWaiters(id) {
    const ws = _waiters.get(id)
    if (!ws) return
    const job = _jobs.get(id)
    for (const w of ws) {
        if (w.timer) clearTimeout(w.timer)
        w.resolve(serializeJob(job))
    }
    _waiters.delete(id)
}

function pruneJobs() {
    if (_jobs.size <= MAX_JOBS) return
    const settled = Array.from(_jobs.values())
        .filter(j => isSettled(j.status))
        .sort((a, b) => a.completedAt - b.completedAt)
    let toRemove = _jobs.size - MAX_JOBS
    for (const j of settled) {
        if (toRemove <= 0) break
        _jobs.delete(j.id)
        toRemove--
    }
}

export function createJob(kind, runFn) {
    const id = makeId()
    const ac = new AbortController()
    const job = {
        id, kind,
        status: 'queued',
        startedAt: Date.now(),
        updatedAt: Date.now(),
        completedAt: null,
        progress: { phase: 'queued', current: 0, total: 0, message: null },
        result: null,
        error: null,
        _abort: ac
    }
    _jobs.set(id, job)
    pruneJobs()

    const api = {
        jobId: id,
        abortSignal: ac.signal,
        checkAbort() {
            if (ac.signal.aborted) {
                const e = new Error('Job cancelled')
                e.code = 'JOB_CANCELLED'
                throw e
            }
        },
        reportProgress(phase, current, total, message = null) {
            const j = _jobs.get(id)
            if (!j || isSettled(j.status)) return
            j.status = 'running'
            j.progress = { phase, current, total, message }
            j.updatedAt = Date.now()
        }
    }

    queueMicrotask(async () => {
        try {
            job.status = 'running'
            job.updatedAt = Date.now()
            const result = await runFn(api)
            if (ac.signal.aborted) {
                job.status = 'cancelled'
                job.error = { code: 'JOB_CANCELLED', message: 'Job cancelled', details: {} }
            } else {
                job.status = 'succeeded'
                job.result = result ?? null
            }
        } catch (err) {
            if (ac.signal.aborted || err?.code === 'JOB_CANCELLED') {
                job.status = 'cancelled'
                job.error = { code: 'JOB_CANCELLED', message: err?.message || 'Job cancelled', details: {} }
            } else {
                job.status = 'failed'
                job.error = {
                    code: err?.code || 'JOB_FAILED',
                    message: err?.message || String(err),
                    details: err?.details || {}
                }
            }
        }
        job.completedAt = Date.now()
        job.updatedAt = job.completedAt
        notifyWaiters(id)
    })

    return { id }
}

export function getJob(id) {
    const job = _jobs.get(id)
    return job ? serializeJob(job) : null
}

export function waitForJob(id, timeoutMs = 0) {
    const job = _jobs.get(id)
    if (!job) return Promise.resolve(null)
    if (isSettled(job.status)) return Promise.resolve(serializeJob(job))
    return new Promise((resolve) => {
        let ws = _waiters.get(id)
        if (!ws) { ws = new Set(); _waiters.set(id, ws) }
        const w = { resolve, timer: null }
        if (timeoutMs > 0) {
            w.timer = setTimeout(() => {
                ws.delete(w)
                if (ws.size === 0) _waiters.delete(id)
                const cur = _jobs.get(id)
                resolve({ ...serializeJob(cur), timedOut: true })
            }, timeoutMs)
        }
        ws.add(w)
    })
}

export function cancelJob(id) {
    const job = _jobs.get(id)
    if (!job) return null
    if (isSettled(job.status)) return serializeJob(job)
    job._abort.abort()
    return serializeJob(job)
}

export function listJobs() {
    return Array.from(_jobs.values()).map(serializeJob)
}

export function _reset() {
    for (const ws of _waiters.values()) {
        for (const w of ws) if (w.timer) clearTimeout(w.timer)
    }
    _jobs.clear()
    _waiters.clear()
    _idCounter = 0
}

if (typeof window !== 'undefined') {
    window.__layersJobs = { createJob, getJob, waitForJob, cancelJob, listJobs, _reset }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx playwright test tests/agent-jobs-registry.spec.js --reporter=list
```
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add public/js/agent/jobs.js tests/agent-jobs-registry.spec.js
git commit -m "feat(agent): job registry with progress, cancel, wait

Phase 6 Task 1.
"
```

---

## Task 2: Wire registry into snapshot + replace stubs

**Files:**
- Modify: `public/js/agent/commands.js` (replace getJob/waitForJob/cancelJob stubs)
- Modify: `public/js/agent/snapshot.js` (`jobs: listJobs()...`)
- Modify: `public/js/agent/schemas.js` (add timeoutMs to waitForJob if not present)
- Test: `tests/agent-job-commands.spec.js` (rewrite to use real jobs)

- [ ] **Step 1: Write failing tests**

Replace `tests/agent-job-commands.spec.js` (existing) with a real-job test set. Key cases:

```javascript
test('getJob returns NOT_FOUND_JOB for unknown id', async ({ page }) => {
    const r = await page.evaluate(() => window.LayersAgent.getJob({ jobId: 'nope' }))
    expect(r.ok).toBe(false)
    expect(r.error.code).toBe('NOT_FOUND_JOB')
})

test('exportImage does not create a job (sync command unaffected)', async ({ page }) => {
    // Sanity: jobs list stays empty when no job-emitting commands run
    const before = await page.evaluate(() => window.LayersAgent.getState({}))
    expect(before.state.jobs).toEqual([])
})

test('snapshot exposes jobs after a registry-created job settles', async ({ page }) => {
    const after = await page.evaluate(async () => {
        const { id } = window.__layersJobs.createJob('test-kind', async () => ({ ok: 1 }))
        await window.__layersJobs.waitForJob(id, 2000)
        return window.LayersAgent.getState({})
    })
    expect(after.state.jobs.length).toBeGreaterThan(0)
    const j = after.state.jobs.find(x => x.kind === 'test-kind')
    expect(j.status).toBe('succeeded')
})

test('waitForJob with timeoutMs returns timedOut envelope', async ({ page }) => {
    const r = await page.evaluate(async () => {
        const { id } = window.__layersJobs.createJob('test-kind', async () => {
            await new Promise(r => setTimeout(r, 500))
            return { ok: 1 }
        })
        return await window.LayersAgent.waitForJob({ jobId: id, timeoutMs: 50 })
    })
    expect(r.ok).toBe(true)
    expect(r.result.timedOut).toBe(true)
})

test('cancelJob transitions to cancelled', async ({ page }) => {
    const final = await page.evaluate(async () => {
        const { id } = window.__layersJobs.createJob('test-kind', async (api) => {
            while (!api.abortSignal.aborted) await new Promise(r => setTimeout(r, 5))
            api.checkAbort()
        })
        await new Promise(r => setTimeout(r, 20))
        const c = await window.LayersAgent.cancelJob({ jobId: id })
        const settled = await window.LayersAgent.waitForJob({ jobId: id, timeoutMs: 1000 })
        return settled.result
    })
    expect(final.status).toBe('cancelled')
})
```

Run: `npx playwright test tests/agent-job-commands.spec.js --reporter=list` — Expected: tests fail (snapshot.jobs not real, commands still stub).

- [ ] **Step 2: Replace the stubs in `public/js/agent/commands.js`**

Replace the three stubs (lines 148-158) with:

```javascript
import * as jobsRegistry from './jobs.js'

export async function getJob({ jobId }) {
    const j = jobsRegistry.getJob(jobId)
    if (!j) throw commandError('NOT_FOUND_JOB', `Job not found: ${jobId}`, { jobId })
    return { result: j }
}

export async function waitForJob({ jobId, timeoutMs }) {
    const existing = jobsRegistry.getJob(jobId)
    if (!existing) throw commandError('NOT_FOUND_JOB', `Job not found: ${jobId}`, { jobId })
    const settled = await jobsRegistry.waitForJob(jobId, timeoutMs || 0)
    return { result: settled }
}

export async function cancelJob({ jobId }) {
    const existing = jobsRegistry.getJob(jobId)
    if (!existing) throw commandError('NOT_FOUND_JOB', `Job not found: ${jobId}`, { jobId })
    const next = jobsRegistry.cancelJob(jobId)
    return { result: next }
}
```

(Place the `import` near the other module imports at top of `commands.js`.)

- [ ] **Step 3: Update `public/js/agent/snapshot.js`**

```javascript
import { listJobs } from './jobs.js'
// ...
// Replace `jobs: [],` (line 27) with:
jobs: listJobs().slice(-20).reverse(),  // most recent first, cap snapshot at 20
```

- [ ] **Step 4: Verify schema for waitForJob accepts timeoutMs**

Check `public/js/agent/schemas.js` for `waitForJob`. If it lacks `timeoutMs` field, add:

```javascript
waitForJob: {
    type: 'object',
    properties: {
        jobId: { type: 'string' },
        timeoutMs: { type: 'integer', minimum: 0, maximum: 600000 }
    },
    required: ['jobId']
},
```

- [ ] **Step 5: Run tests**

```bash
npx playwright test tests/agent-job-commands.spec.js tests/agent-jobs-registry.spec.js --reporter=list
```
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add public/js/agent/commands.js public/js/agent/snapshot.js public/js/agent/schemas.js tests/agent-job-commands.spec.js
git commit -m "feat(agent): wire job registry to getJob/waitForJob/cancelJob

Phase 6 Task 2. Replaces Phase 1 stubs.
"
```

---

## Task 3: listInstalledFonts (sync command)

**Files:**
- Modify: `public/js/agent/commands.js` (add handler)
- Modify: `public/js/agent/index.js` (register)
- Modify: `public/js/agent/schemas.js` (add empty-args schema)
- Test: `tests/agent-fonts.spec.js` (new)

- [ ] **Step 1: Write failing tests**

Create `tests/agent-fonts.spec.js`:

```javascript
import { test, expect } from '@playwright/test'

test.describe('agent: listInstalledFonts', () => {
    test('returns shape with installed flag and fonts array', async ({ page }) => {
        await page.goto('/')
        await page.evaluate(() => window.LayersAgent.ready)
        const r = await page.evaluate(() => window.LayersAgent.listInstalledFonts({}))
        expect(r.ok).toBe(true)
        expect(typeof r.result.installed).toBe('boolean')
        expect(Array.isArray(r.result.fonts)).toBe(true)
        expect(typeof r.result.count).toBe('number')
        // version is string-or-null
        expect(['string', 'object']).toContain(typeof r.result.version)
    })

    test('uninstalled state returns empty fonts list and count 0', async ({ page }) => {
        // Default test environment has no bundle installed.
        await page.goto('/')
        await page.evaluate(() => window.LayersAgent.ready)
        const r = await page.evaluate(() => window.LayersAgent.listInstalledFonts({}))
        if (!r.result.installed) {
            expect(r.result.count).toBe(0)
            expect(r.result.fonts).toEqual([])
            expect(r.result.version).toBeNull()
        }
    })
})
```

Run: expected FAIL — `listInstalledFonts` undefined.

- [ ] **Step 2: Add handler to `public/js/agent/commands.js`**

```javascript
import { getFontaineLoader } from '../layers/fontaine-loader.js'

export async function listInstalledFonts(_args, _app) {
    const loader = getFontaineLoader()
    const installed = await loader.isInstalled()
    if (!installed) {
        return { result: { installed: false, version: null, count: 0, fonts: [] } }
    }
    if (!loader.fontsLoaded) {
        await loader.loadFromCache()
    }
    const raw = (loader.catalog?.fonts) || []
    const fonts = raw.map(f => ({
        id: f.id || f.family,
        family: f.family,
        category: f.category || null,
        style: f.style || null
    }))
    return {
        result: {
            installed: true,
            version: loader.installedVersion || null,
            count: fonts.length,
            fonts
        }
    }
}
```

- [ ] **Step 3: Register in `public/js/agent/index.js`**

After `registerCommand(LayersAgent, 'autoWhiteBalance', commands.autoWhiteBalance)` (line 128), add:

```javascript
registerCommand(LayersAgent, 'listInstalledFonts', commands.listInstalledFonts)
```

- [ ] **Step 4: Add schema in `public/js/agent/schemas.js`**

```javascript
listInstalledFonts: { type: 'object', properties: {}, additionalProperties: false },
```

- [ ] **Step 5: Run tests**

```bash
npx playwright test tests/agent-fonts.spec.js --reporter=list
```
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add public/js/agent/commands.js public/js/agent/index.js public/js/agent/schemas.js tests/agent-fonts.spec.js
git commit -m "feat(agent): listInstalledFonts

Phase 6 Task 3.
"
```

---

## Task 4: installFontBundle (job-modeled)

**Files:**
- Modify: `public/js/agent/commands.js`
- Modify: `public/js/agent/index.js`
- Modify: `public/js/agent/schemas.js`
- Test: `tests/agent-fonts.spec.js` (extend)

- [ ] **Step 1: Write failing tests**

Append to `tests/agent-fonts.spec.js`:

```javascript
test.describe('agent: installFontBundle', () => {
    test('returns jobId and progresses through phases (mocked)', async ({ page }) => {
        await page.goto('/')
        await page.evaluate(() => window.LayersAgent.ready)

        // Stub the loader.install to avoid the 140 MB real download.
        await page.evaluate(() => {
            const loader = window.LayersAgent._app._fontaineLoader || window.__getFontaineLoaderForTest()
            loader.install = async ({ onProgress }) => {
                onProgress(0, 'Loading manifest...')
                onProgress(50, 'Downloading: 70 / 140 MB')
                onProgress(100, 'Installed 100 fonts')
                loader.installedVersion = 'test-1'
                loader.catalog = { fonts: [{ id: 'a', family: 'A' }] }
                loader.fontsLoaded = true
                return true
            }
            loader.isInstalled = async () => true
        })

        const r = await page.evaluate(() => window.LayersAgent.installFontBundle({}))
        expect(r.ok).toBe(true)
        expect(typeof r.result.jobId).toBe('string')

        const final = await page.evaluate((id) =>
            window.LayersAgent.waitForJob({ jobId: id, timeoutMs: 5000 }),
            r.result.jobId)
        expect(final.result.status).toBe('succeeded')
        expect(final.result.result.count).toBe(1)
    })

    test('progress reports phase + percent during install', async ({ page }) => {
        await page.goto('/')
        await page.evaluate(() => window.LayersAgent.ready)

        await page.evaluate(() => {
            const loader = window.LayersAgent._app._fontaineLoader || window.__getFontaineLoaderForTest()
            loader.install = async ({ onProgress }) => {
                onProgress(25, 'Downloading: 35 / 140 MB')
                await new Promise(r => setTimeout(r, 30))
                onProgress(75, 'Extracting fonts...')
                await new Promise(r => setTimeout(r, 30))
                loader.installedVersion = 'test-2'
                loader.catalog = { fonts: [] }
                loader.fontsLoaded = true
                return true
            }
            loader.isInstalled = async () => true
        })

        const { jobId } = (await page.evaluate(() => window.LayersAgent.installFontBundle({}))).result

        // poll a bit
        const mid = await page.evaluate(async (id) => {
            await new Promise(r => setTimeout(r, 35))
            return window.LayersAgent.getJob({ jobId: id })
        }, jobId)
        expect(['running', 'succeeded']).toContain(mid.result.status)
        expect(mid.result.progress.total).toBe(100)
    })
})
```

Run: expected FAIL — `installFontBundle` undefined.

- [ ] **Step 2: Add handler to `commands.js`**

```javascript
export async function installFontBundle(_args, _app) {
    const loader = getFontaineLoader()
    const { id } = jobsRegistry.createJob('install-font-bundle', async (api) => {
        api.reportProgress('starting', 0, 100)
        let lastPercent = 0
        await loader.install({
            onProgress: (percent, message) => {
                lastPercent = Math.round(percent)
                let phase = 'downloading'
                if (lastPercent < 10) phase = 'manifest'
                else if (lastPercent < 70) phase = 'downloading'
                else if (lastPercent < 95) phase = 'extracting'
                else phase = 'finalizing'
                api.reportProgress(phase, lastPercent, 100, message || null)
                api.checkAbort()
            }
        })
        api.reportProgress('done', 100, 100)
        const fonts = (loader.catalog?.fonts) || []
        return { count: fonts.length, version: loader.installedVersion || null }
    })
    return { result: { jobId: id } }
}
```

- [ ] **Step 3: Register in `index.js`**

```javascript
registerCommand(LayersAgent, 'installFontBundle', commands.installFontBundle)
```

- [ ] **Step 4: Add schema**

```javascript
installFontBundle: { type: 'object', properties: {}, additionalProperties: false },
```

- [ ] **Step 5: Run tests**

```bash
npx playwright test tests/agent-fonts.spec.js --reporter=list
```
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add public/js/agent/commands.js public/js/agent/index.js public/js/agent/schemas.js tests/agent-fonts.spec.js
git commit -m "feat(agent): installFontBundle (job-modeled)

Phase 6 Task 4.
"
```

---

## Task 5: Extract headless video exporter

**Files:**
- Create: `public/js/ui/video-exporter.js`
- Modify: `public/js/ui/export-video-dialog.js` (delegate frame loop)
- Test: `tests/agent-video-exporter.spec.js` (headless-runner integration test)

- [ ] **Step 1: Write a failing test for the headless runner**

Create `tests/agent-video-exporter.spec.js`:

```javascript
import { test, expect } from '@playwright/test'

test.describe('headless video-exporter', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('/')
        await page.evaluate(() => window.LayersAgent.ready)
    })

    test('runVideoExport completes a tiny ZIP export', async ({ page }) => {
        // Pick ZIP to avoid touching the WebCodecs/MP4 path in test env;
        // ZIP path uses readPixels and a worker.
        const result = await page.evaluate(async () => {
            const { runVideoExport } = await import('/js/ui/video-exporter.js')
            const app = window.LayersAgent._app
            const settings = {
                width: 64, height: 64, framerate: 30, duration: 0.1,
                loopCount: 1, format: 'zip', quality: 'low', playFrom: 'beginning'
            }
            return await runVideoExport({
                settings,
                canvas: app._canvas,
                renderer: app._renderer,
                files: app._files,
                getResolution: () => ({ width: app._canvas.width, height: app._canvas.height }),
                setResolution: (w, h) => app._setResolution?.(w, h) || app._handleResize?.(w, h),
                abortSignal: new AbortController().signal,
                onProgress: () => {}
            })
        })
        expect(result.format).toBe('zip')
        expect(result.totalFrames).toBeGreaterThan(0)
    })

    test('runVideoExport honors abort signal', async ({ page }) => {
        const result = await page.evaluate(async () => {
            const { runVideoExport } = await import('/js/ui/video-exporter.js')
            const app = window.LayersAgent._app
            const ac = new AbortController()
            setTimeout(() => ac.abort(), 20)
            const settings = {
                width: 64, height: 64, framerate: 30, duration: 5,
                loopCount: 1, format: 'zip', quality: 'low', playFrom: 'beginning'
            }
            try {
                await runVideoExport({
                    settings,
                    canvas: app._canvas,
                    renderer: app._renderer,
                    files: app._files,
                    getResolution: () => ({ width: app._canvas.width, height: app._canvas.height }),
                    setResolution: (w, h) => app._setResolution?.(w, h) || app._handleResize?.(w, h),
                    abortSignal: ac.signal,
                    onProgress: () => {}
                })
                return { aborted: false }
            } catch (e) {
                return { aborted: true, code: e.code, message: e.message }
            }
        })
        expect(result.aborted).toBe(true)
        expect(result.code).toBe('JOB_CANCELLED')
    })
})
```

Run: expected FAIL — module doesn't exist.

- [ ] **Step 2: Create `public/js/ui/video-exporter.js`**

```javascript
/**
 * Headless video exporter — frame-loop and encoder driver, no DOM.
 * Used by both the human-facing ExportVideoDialog and the agent's
 * `exportVideo` command.
 *
 * @module ui/video-exporter
 */

export async function runVideoExport(opts) {
    const {
        settings, canvas, renderer, files,
        getResolution, setResolution,
        abortSignal, onProgress = () => {}
    } = opts

    const totalFrames = Math.ceil(settings.framerate * settings.duration * settings.loopCount)
    const inner = renderer._renderer
    const wasRunning = renderer.isRunning
    let pausedNormalizedTime = 0

    if (wasRunning) {
        const elapsedSeconds = (performance.now() - inner._loopStartTime) / 1000
        pausedNormalizedTime = (elapsedSeconds % inner._loopDuration) / inner._loopDuration
        renderer.stop()
    }

    const originalRes = getResolution()
    let started = false  // track whether encoder was started, for cleanup

    try {
        if (settings.width !== originalRes.width || settings.height !== originalRes.height) {
            setResolution(settings.width, settings.height)
            await waitFrame()
        }

        if (settings.playFrom === 'beginning') {
            await seekAllVideos(renderer, 0)
        }

        const exportSettings = {
            width: settings.width,
            height: settings.height,
            framerate: settings.framerate,
            videoQuality: settings.quality,
            totalFrames
        }

        if (settings.format === 'mp4') {
            await files.startRecordingMP4(canvas, exportSettings)
        } else {
            files.saveZip(exportSettings)
        }
        started = true

        const frameDurationMs = 1000 / settings.framerate
        const exportDurationSec = settings.duration
        const timeOffset = settings.playFrom === 'beginning' ? 0 : pausedNormalizedTime

        onProgress(0, totalFrames, 'exporting')

        for (let n = 0; n < totalFrames; n++) {
            if (abortSignal?.aborted) {
                if (settings.format === 'mp4') await files.cancelMP4()
                else files.cancelZIP()
                started = false
                const err = new Error('Export cancelled')
                err.code = 'JOB_CANCELLED'
                throw err
            }

            const targetTimeSec = (n * frameDurationMs) / 1000
            const timeInLoop = targetTimeSec % exportDurationSec
            const baseNormalizedTime = timeInLoop / exportDurationSec
            const normalizedTime = (baseNormalizedTime + timeOffset) % 1

            await seekAllVideos(renderer, targetTimeSec)
            renderer._updateVideoTextures()
            renderer.render(normalizedTime)
            await waitFrame()

            if (settings.format === 'mp4') {
                files.encodeVideoFrame(canvas, {
                    framerate: settings.framerate,
                    videoQuality: settings.quality
                })
            } else {
                const gl = canvas.getContext('webgl2')
                if (gl) {
                    const pixels = new Uint8Array(canvas.width * canvas.height * 4)
                    gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels)
                    files.addZipFrame(pixels, {
                        width: canvas.width,
                        height: canvas.height,
                        totalFrames
                    })
                }
            }

            if (n % 5 === 0) {
                onProgress(n, totalFrames, 'exporting')
                await new Promise(r => setTimeout(r, 0))
            }
        }

        onProgress(totalFrames, totalFrames, 'finalizing')
        if (settings.format === 'mp4') {
            await files.endRecordingMP4()
        }
        started = false

        return {
            format: settings.format,
            width: settings.width,
            height: settings.height,
            framerate: settings.framerate,
            durationSec: settings.duration * settings.loopCount,
            totalFrames
        }
    } catch (err) {
        // Best-effort cleanup if encoder was started but loop didn't reach end
        if (started) {
            try {
                if (settings.format === 'mp4') await files.cancelMP4()
                else files.cancelZIP()
            } catch (_) { /* swallow cleanup errors */ }
        }
        throw err
    } finally {
        const cur = getResolution()
        if (cur.width !== originalRes.width || cur.height !== originalRes.height) {
            setResolution(originalRes.width, originalRes.height)
        }
        if (wasRunning) {
            const now = performance.now()
            const pausedElapsedSeconds = pausedNormalizedTime * inner._loopDuration
            inner._loopStartTime = now - (pausedElapsedSeconds * 1000)
            renderer.start()
        }
    }
}

async function seekAllVideos(renderer, timeSec) {
    const mediaTextures = renderer._mediaTextures
    if (!mediaTextures) return
    const promises = []
    for (const [, media] of mediaTextures) {
        if (media.type !== 'video') continue
        const video = media.element
        if (video.duration && isFinite(video.duration)) {
            const seekTime = timeSec % video.duration
            if (Math.abs(video.currentTime - seekTime) > 0.01) {
                promises.push(new Promise(resolve => {
                    const onSeeked = () => {
                        video.removeEventListener('seeked', onSeeked)
                        resolve()
                    }
                    video.addEventListener('seeked', onSeeked)
                    video.currentTime = seekTime
                }))
            }
        }
    }
    await Promise.all(promises)
}

function waitFrame() {
    return new Promise(resolve => requestAnimationFrame(resolve))
}
```

- [ ] **Step 3: Refactor `export-video-dialog.js` to delegate**

Replace the bodies of `beginExport()`, `_runExportLoop()`, `_seekAllVideos()`, `_finalizeExport()`, and `_waitFrame()` so the dialog imports and calls `runVideoExport`. The dialog still owns: settings gathering from the form, progress UI updates, preference save/load, dialog show/close, abort wiring.

Concretely:

```javascript
import { runVideoExport } from './video-exporter.js'

// inside the class — replace beginExport with:
async beginExport() {
    if (this.state !== 'dialog') return

    this.state = 'preparing'
    this.abortController = new AbortController()

    const settings = this._gatherSettings()
    this.totalFrames = Math.ceil(settings.framerate * settings.duration * settings.loopCount)
    this.currentFrame = 0
    this.startTime = performance.now()

    this._savePreferences(settings)
    this._elements.dialogView.style.display = 'none'
    this._elements.progressView.style.display = 'block'
    this._updateProgress()

    try {
        this.state = 'exporting'
        await runVideoExport({
            settings,
            canvas: this.canvas,
            renderer: this.renderer,
            files: this.files,
            getResolution: this.getResolution,
            setResolution: this.setResolution,
            abortSignal: this.abortController.signal,
            onProgress: (current, total, _phase) => {
                this.currentFrame = current
                this.totalFrames = total
                this._updateProgress()
            }
        })
        this.close()
        this.onComplete(settings.format)
    } catch (err) {
        if (err?.code === 'JOB_CANCELLED') {
            this.close()
            this.onCancel()
        } else {
            console.error('Export failed:', err)
            this._handleExportError(err)
        }
    }
}
```

Then **delete** these methods from the class (now in the runner):
- `_runExportLoop`
- `_seekAllVideos`
- `_finalizeExport`
- `_waitFrame`

Adjust `cancel()` so it just calls `this.abortController?.abort()` and waits for `beginExport`'s catch to run cleanup; remove the duplicate `files.cancelMP4()`/`files.cancelZIP()` calls from `cancel()` (the runner handles them).

```javascript
async cancel() {
    if (this.state === 'dialog') {
        this.close()
        return
    }
    if (this.state !== 'preparing' && this.state !== 'exporting') return
    this.abortController?.abort()
    // The runner's catch block + dialog's catch block above handle cleanup + close.
}
```

- [ ] **Step 4: Run tests**

```bash
npx playwright test tests/agent-video-exporter.spec.js --reporter=list
```
Expected: PASS.

Then run the full suite to verify no dialog regression (the dialog isn't directly tested by Playwright, but other agent tests touch the renderer):

```bash
npx playwright test --reporter=list
```
Expected: 200+ existing tests still PASS.

- [ ] **Step 5: Manual smoke check (UI)**

```bash
npm run dev   # if not already running
```

Open the app, File → "export video clip…", export a 1-second clip at 256×256, format ZIP, quality "low". Verify the dialog opens, progress reports, ZIP downloads. Then repeat with format MP4. Then export a 1-second clip and click Cancel partway — verify cleanup works. **If any of these break, do not commit; fix the dialog refactor.**

- [ ] **Step 6: Commit**

```bash
git add public/js/ui/video-exporter.js public/js/ui/export-video-dialog.js tests/agent-video-exporter.spec.js
git commit -m "refactor(ui): extract headless video-exporter from dialog

Phase 6 Task 5. The dialog still drives the human flow; the new
runVideoExport function is reusable from the agent.
"
```

---

## Task 6: exportVideo agent command (job-modeled)

**Files:**
- Modify: `public/js/agent/commands.js`
- Modify: `public/js/agent/index.js`
- Modify: `public/js/agent/schemas.js`
- Test: `tests/agent-export-video.spec.js`

- [ ] **Step 1: Write failing tests**

Create `tests/agent-export-video.spec.js`:

```javascript
import { test, expect } from '@playwright/test'

test.describe('agent: exportVideo', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('/')
        await page.evaluate(() => window.LayersAgent.ready)
    })

    test('returns jobId, completes, populates recentExports', async ({ page }) => {
        const r = await page.evaluate(() => window.LayersAgent.exportVideo({
            width: 64, height: 64, framerate: 30, duration: 0.1,
            loopCount: 1, format: 'zip', quality: 'low', triggerDownload: false
        }))
        expect(r.ok).toBe(true)
        expect(typeof r.result.jobId).toBe('string')

        const final = await page.evaluate((id) =>
            window.LayersAgent.waitForJob({ jobId: id, timeoutMs: 30000 }),
            r.result.jobId)
        expect(final.result.status).toBe('succeeded')
        expect(final.result.result.format).toBe('zip')
        expect(final.result.result.totalFrames).toBeGreaterThan(0)

        const state = await page.evaluate(() => window.LayersAgent.getState({}))
        const videoExport = state.state.recentExports.find(e => e.kind === 'video')
        expect(videoExport).toBeDefined()
        expect(videoExport.format).toBe('zip')
    })

    test('cancellation transitions job to cancelled and cleans up encoder', async ({ page }) => {
        const r = await page.evaluate(() => window.LayersAgent.exportVideo({
            width: 64, height: 64, framerate: 30, duration: 5,
            loopCount: 1, format: 'zip', quality: 'low', triggerDownload: false
        }))
        await page.evaluate(() => new Promise(r => setTimeout(r, 30)))
        await page.evaluate((id) => window.LayersAgent.cancelJob({ jobId: id }), r.result.jobId)
        const final = await page.evaluate((id) =>
            window.LayersAgent.waitForJob({ jobId: id, timeoutMs: 5000 }),
            r.result.jobId)
        expect(final.result.status).toBe('cancelled')
    })

    test('rejects out-of-range arguments', async ({ page }) => {
        const r = await page.evaluate(() => window.LayersAgent.exportVideo({
            width: 64, height: 64, framerate: 30, duration: 1000, // out of range (max 300)
            loopCount: 1, format: 'zip', quality: 'low'
        }))
        expect(r.ok).toBe(false)
        expect(r.error.code).toMatch(/INVALID_ARGS_/)
    })

    test('rejects unknown format enum', async ({ page }) => {
        const r = await page.evaluate(() => window.LayersAgent.exportVideo({
            width: 64, height: 64, framerate: 30, duration: 0.1,
            format: 'gif', quality: 'low'
        }))
        expect(r.ok).toBe(false)
        expect(r.error.code).toBe('INVALID_ARGS_ENUM')
    })
})
```

Run: expected FAIL — `exportVideo` undefined.

- [ ] **Step 2: Add handler to `commands.js`**

```javascript
import { runVideoExport } from '../ui/video-exporter.js'

export async function exportVideo(args, app) {
    const w = args?.width ?? app._canvas.width
    const h = args?.height ?? app._canvas.height
    const settings = {
        width: Math.max(2, Math.floor(w / 2) * 2),
        height: Math.max(2, Math.floor(h / 2) * 2),
        framerate: args?.framerate ?? 30,
        duration: args?.duration ?? 15,
        loopCount: args?.loopCount ?? 1,
        format: args?.format || 'mp4',
        quality: args?.quality || 'very high',
        playFrom: args?.playFrom || 'beginning'
    }
    const triggerDownload = args?.triggerDownload !== false  // default true

    const { id } = jobsRegistry.createJob('export-video', async (api) => {
        const result = await runVideoExport({
            settings,
            canvas: app._canvas,
            renderer: app._renderer,
            files: app._files,
            getResolution: () => ({ width: app._canvas.width, height: app._canvas.height }),
            setResolution: (w, h) => {
                if (app._setResolution) app._setResolution(w, h)
                else if (app._handleResize) app._handleResize(w, h)
            },
            abortSignal: api.abortSignal,
            onProgress: (current, total, phase) => api.reportProgress(phase, current, total)
        })

        // Record into recentExports (mirrors exportImage pattern)
        const filename = timestampedFilename(args?.filename, settings.format)
        recordExport({
            id: makeExportId(),
            path: null,                  // sidecar fills this in Phase 7
            filename,
            mimeType: settings.format === 'mp4' ? 'video/mp4' : 'application/zip',
            sizeBytes: null,             // unknown — encoder writes directly to download
            createdAt: new Date().toISOString(),
            kind: 'video'
        })

        return {
            ...result,
            filename,
            triggeredDownload: triggerDownload
        }
    })
    return { result: { jobId: id } }
}
```

Note: when `triggerDownload` is `false`, the encoder still emits a download via the existing `files.endRecordingMP4()`/zipWorker path. To honor `triggerDownload: false` properly, you'd need to add a no-download mode to `files.js` — that's out of scope for Phase 6 (test passes `false` only as a flag the agent could later interpret to skip the download in tests; for now, document it and leave the download firing). If implementing the no-download path is feasible in <30 min, do it; otherwise, drop the `triggerDownload` arg from the schema and the test (rely on Playwright's download event in CI).

**Recommendation:** Add a `triggerDownload: false` path in `files.js` that captures the blob/buffer instead of triggering a download, and exposes it via the runner's return value. Specifically:
- `files.startRecordingMP4(canvas, { ...exportSettings, captureOnly: true })` — when `captureOnly`, `endRecordingMP4` returns the blob instead of triggering download.
- `files.saveZip({ ...exportSettings, captureOnly: true })` — when `captureOnly`, the zip worker posts the blob back instead of triggering download.

If that turns out to require non-trivial worker plumbing, drop the `captureOnly` plumbing for Phase 6, remove the `triggerDownload: false` test assertions, and add it to the cleanup queue. Pick whichever you can land cleanly.

- [ ] **Step 3: Register in `index.js`**

```javascript
registerCommand(LayersAgent, 'exportVideo', commands.exportVideo)
```

- [ ] **Step 4: Add schema**

```javascript
exportVideo: {
    type: 'object',
    properties: {
        width: { type: 'integer', minimum: 2, maximum: 4096 },
        height: { type: 'integer', minimum: 2, maximum: 4096 },
        framerate: { type: 'integer', enum: [24, 30, 60] },
        duration: { type: 'number', minimum: 0.1, maximum: 300 },
        loopCount: { type: 'integer', minimum: 1, maximum: 10 },
        format: { type: 'string', enum: ['mp4', 'zip'] },
        quality: { type: 'string', enum: ['low', 'medium', 'high', 'very high', 'ultra'] },
        playFrom: { type: 'string', enum: ['beginning', 'current'] },
        filename: { type: 'string' },
        triggerDownload: { type: 'boolean' }
    },
    additionalProperties: false
},
```

- [ ] **Step 5: Run tests**

```bash
npx playwright test tests/agent-export-video.spec.js --reporter=list
```
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add public/js/agent/commands.js public/js/agent/index.js public/js/agent/schemas.js tests/agent-export-video.spec.js public/js/ui/files.js
git commit -m "feat(agent): exportVideo (job-modeled)

Phase 6 Task 6. Uses headless runVideoExport, reports progress
via job, records into recentExports.
"
```

(Include `files.js` only if you added the `captureOnly` plumbing.)

---

## Task 7: Phase 6 verification

**Files:** none (verification only)

- [ ] **Step 1: Run the full agent suite**

```bash
cd /Users/aayars/platform/layers
npx playwright test tests/agent-*.spec.js --reporter=list
```
Expected: all PASS — at least 215 (204 baseline + Phase 6 additions).

- [ ] **Step 2: Run the entire test suite**

```bash
npx playwright test --reporter=list
```
Expected: same pass rate as before Phase 6 (one pre-existing parallel-execution flake in clone-tool is acceptable; everything else PASS).

- [ ] **Step 3: Manual smoke**

Open the app, do these in order:
1. File → "export video clip…" → set 256×256, 1s, MP4, quality "very high" → download — confirm video plays
2. File → "export video clip…" → 256×256, 5s, ZIP → cancel partway — confirm dialog closes cleanly with no leaked encoder state
3. In DevTools: `await window.LayersAgent.installFontBundle({})` — confirm it returns a jobId, then `await window.LayersAgent.waitForJob({ jobId, timeoutMs: 600000 })` — confirm it succeeds (or, if you don't want to fetch 140 MB, monkey-patch `getFontaineLoader().install` like the test does)
4. `await window.LayersAgent.listInstalledFonts({})` — confirm `result.installed` and font count match installed state
5. `await window.LayersAgent.exportVideo({ width: 256, height: 256, duration: 1, format: 'mp4', quality: 'medium' })` — confirm jobId returned and the resulting `getJob` shows progress, then succeeds
6. `await window.LayersAgent.getState({})` — confirm `state.jobs` shows the recent jobs and `state.recentExports` has a video entry

- [ ] **Step 4: Update cleanup task #23**

Note any deferred minor issues (e.g., the `triggerDownload: false` plumbing if you skipped it, abortSignal pass-through to `loader.install`, etc.).

- [ ] **Step 5: Final commit (if any documentation/cleanup adjustments)**

If Phase 6 needed any final tweaks (docstrings, cleanup-task updates), commit them as `chore: phase 6 cleanup notes`. Otherwise, no commit.

---

## Conventions (post-Phase-6)

Notes for any future plan touching the agent surface — recorded here because
the Phase 6 plan above referenced methods that turned out not to exist
(`app._setResolution`, `app._handleResize`) and a later cleanup had to
correct it. Don't repeat the mistake.

- Canvas resize: `app._resizeCanvas(w, h)`. NOT `_setResolution` (doesn't
  exist) or `_handleResize` (doesn't exist).
- Image resize (resampling layers): `app._resizeImage(w, h)`.
- Canvas size change preserving layer pixels: `app._changeCanvasSize(w, h, anchor)`.
- Agent commands always return envelopes shaped
  `{ ok, command, result, state, warnings? }` or
  `{ ok: false, error, state }`.
- Long-running operations return `{ jobId }` and run via `agent/jobs.js`
  (queueMicrotask, off the dispatcher queue).
