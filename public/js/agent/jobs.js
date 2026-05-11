/**
 * Job registry — backs getJob/waitForJob/cancelJob agent commands and any
 * long-running operation. Jobs run via queueMicrotask so they execute outside
 * the dispatcher's serial queue; commands stay one-at-a-time, jobs run in the
 * background and can be polled or awaited.
 *
 * @module agent/jobs
 */

/**
 * Job kinds emitted by the agent layer. Agents inspecting `snapshot.jobs`
 * can use this enum to dispatch on job type. Test-only kinds (those used
 * exclusively by tests/agent-jobs-registry.spec.js) are NOT included here.
 */
export const JOB_KINDS = Object.freeze({
    INSTALL_FONT_BUNDLE: 'install-font-bundle',
    EXPORT_VIDEO: 'export-video'
})

const _jobs = new Map()
const _waiters = new Map()
const MAX_JOBS = 50
// Hard cap on concurrently active (non-settled) jobs. Settled jobs only get
// pruned by `pruneJobs`; if every job in the registry is still active there's
// nothing for `pruneJobs` to delete, so we'd grow unbounded. createJob throws
// JOB_LIMIT_EXCEEDED once we hit this cap so callers fail fast.
const MAX_ACTIVE_JOBS = 20
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

/**
 * Drop oldest *settled* jobs to keep the registry under MAX_JOBS. Active
 * (queued/running) jobs are never pruned here — if too many are active,
 * `createJob` will refuse new ones up front via JOB_LIMIT_EXCEEDED.
 */
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

function countActiveJobs() {
    let n = 0
    for (const j of _jobs.values()) {
        if (!isSettled(j.status)) n++
    }
    return n
}

export function createJob(kind, runFn) {
    if (countActiveJobs() >= MAX_ACTIVE_JOBS) {
        const err = new Error(
            `Too many active jobs (limit ${MAX_ACTIVE_JOBS}). ` +
            'Wait for an existing job to settle, or cancel one.')
        err.code = 'JOB_LIMIT_EXCEEDED'
        err.details = { limit: MAX_ACTIVE_JOBS, active: countActiveJobs() }
        throw err
    }
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

/**
 * Test-only back door — gives Playwright specs direct registry access so they
 * don't have to round-trip through the agent envelope to create/inspect jobs.
 * NOT a public API. Production agents must use LayersAgent.{get,wait,cancel}Job.
 */
if (typeof window !== 'undefined') {
    window.__LAYERS_TEST_HOOKS = window.__LAYERS_TEST_HOOKS || {}
    window.__LAYERS_TEST_HOOKS.jobs = { createJob, getJob, waitForJob, cancelJob, listJobs, _reset }
}
