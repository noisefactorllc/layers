# Layers Agent — Phase 3 (Image Export) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the agent commands an agent needs to *see* its work and *get its output*: thumbnails, full-canvas bytes, exported PNG/JPG/WebP files, and paste-bytes-as-layer.

**Architecture:** All five commands live in `public/js/agent/commands.js`. Two new helpers in `public/js/agent/commands.js`: `canvasToBytes(canvas, format, quality, targetW?, targetH?)` produces `{ blob, base64, mimeType, width, height, sizeBytes }`; `compositeOnlyLayer(app, layerId)` reuses `app._renderLayerComposite([layerId])` to render a single layer. `exportImage` triggers a real browser download (matches human UI; the future MCP sidecar in Phase 7 catches the download via Playwright) AND returns the bytes inline so the page-side agent has them without depending on download capture. `pasteImageFromBytes` is a thin wrapper over Phase 2's `addLayer kind=media` source pipeline.

**Tech Stack:** Vanilla ES modules. Browser-native `OffscreenCanvas`, `FileReader`, `<a download>`. No new runtime dependencies. Playwright for tests.

**Reference spec:** `docs/plans/2026-05-07-layers-agent-instrumentation-design.md`
**Reference Phase 2 plan:** `docs/plans/2026-05-08-layers-agent-phase-2-plan.md`

---

## File structure

**Modify:**
- `public/js/agent/commands.js` — add 2 helpers (`canvasToBytes`, `blobToBase64`) plus 5 command handlers.
- `public/js/agent/schemas.js` — append schemas.
- `public/js/agent/index.js` — register each new command.

**Create (tests):**
- `tests/agent-imagery.spec.js` — `getCanvasImageBytes`, `getThumbnail`, `getLayerThumbnail`, `pasteImageFromBytes`.
- `tests/agent-export-image.spec.js` — `exportImage` (download-trigger + bytes-inline + format/quality variants).

**Snapshot (passive change):**
- The snapshot's `recentExports` array is already reserved (always `[]` in Phase 1/2). Phase 3 starts populating it: `exportImage` pushes one entry capped to last 50. `public/js/agent/snapshot.js` reads the array from a new module-scope buffer in `commands.js` exposed through `app._agentRecentExports`.

---

## Task 1: `getCanvasImageBytes`

**Files:**
- Modify: `public/js/agent/commands.js`, `public/js/agent/schemas.js`, `public/js/agent/index.js`
- Test: `tests/agent-imagery.spec.js`

`getCanvasImageBytes` returns the current rendered canvas as base64-encoded bytes at native resolution. No download trigger. Cheapest "give me what's on screen right now" path.

- [ ] **Step 1: Write the failing test**

Create `tests/agent-imagery.spec.js`:

```js
import { test, expect } from 'playwright/test'

async function bootApp(page) {
    await page.goto('/', { waitUntil: 'networkidle' })
    await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })
    await page.evaluate(async () => { await window.LayersAgent.ready })
    const visible = await page.evaluate(() => !!document.querySelector('.open-dialog-backdrop.visible'))
    if (visible) {
        await page.click('.media-option[data-type="solid"]')
        await page.waitForSelector('.canvas-size-dialog', { timeout: 5000 })
        await page.click('.canvas-size-dialog .action-btn.primary')
        await page.waitForSelector('.open-dialog-backdrop.visible', { state: 'hidden', timeout: 5000 })
    }
}

test.describe('getCanvasImageBytes', () => {
    test('returns base64 PNG bytes by default', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() => window.LayersAgent.getCanvasImageBytes())
        expect(env.ok).toBe(true)
        expect(env.result.format).toBe('png')
        expect(env.result.mimeType).toBe('image/png')
        expect(env.result.width).toBeGreaterThan(0)
        expect(env.result.height).toBeGreaterThan(0)
        expect(typeof env.result.bytes).toBe('string')
        expect(env.result.bytes.length).toBeGreaterThan(0)
        // PNG magic bytes are 89 50 4E 47 → in base64, every PNG starts with "iVBOR"
        expect(env.result.bytes.startsWith('iVBOR')).toBe(true)
    })

    test('honors format=jpg', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() =>
            window.LayersAgent.getCanvasImageBytes({ format: 'jpg', quality: 0.8 }))
        expect(env.ok).toBe(true)
        expect(env.result.format).toBe('jpg')
        expect(env.result.mimeType).toBe('image/jpeg')
        // JPEG magic in base64 starts with /9j/
        expect(env.result.bytes.startsWith('/9j/')).toBe(true)
    })

    test('rejects unknown format', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() =>
            window.LayersAgent.getCanvasImageBytes({ format: 'gif' }))
        expect(env.ok).toBe(false)
        expect(env.error.code).toBe('INVALID_ARGS_ENUM')
    })
})
```

- [ ] **Step 2: Run test to verify it fails**

```
npx playwright test tests/agent-imagery.spec.js --reporter=line
```

Expected: FAIL — `getCanvasImageBytes` not registered.

- [ ] **Step 3: Add schema**

Modify `public/js/agent/schemas.js`. Append:

```js
    getCanvasImageBytes: {
        type: 'object',
        properties: {
            format: { type: 'string', enum: ['png', 'jpg', 'webp'] },
            quality: { type: 'number', min: 0, max: 1 }
        }
    },
```

- [ ] **Step 4: Add helpers + handler**

Modify `public/js/agent/commands.js`. Append (after the existing handlers):

```js
const FORMAT_TO_MIME = {
    png: 'image/png',
    jpg: 'image/jpeg',
    webp: 'image/webp'
}

/**
 * Read a blob as base64 (data-url-strip pattern).
 */
async function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onloadend = () => {
            const result = reader.result
            if (typeof result !== 'string') {
                reject(new Error('FileReader produced non-string result'))
                return
            }
            const comma = result.indexOf(',')
            resolve(comma >= 0 ? result.slice(comma + 1) : result)
        }
        reader.onerror = () => reject(reader.error || new Error('FileReader failed'))
        reader.readAsDataURL(blob)
    })
}

/**
 * Render `canvas` to bytes at the requested format/quality and (optionally) target size.
 * If target size matches canvas size, the canvas is encoded directly.
 * If target size differs, the canvas is drawn into an OffscreenCanvas at the target size
 * before encoding (high-quality 2D resampling — not a re-render of the shader graph).
 */
async function canvasToBytes(canvas, format, quality, targetW, targetH) {
    const mimeType = FORMAT_TO_MIME[format]
    if (!mimeType) {
        throw commandError('INVALID_ARGS_ENUM',
            `Unsupported format: ${format}`,
            { field: 'format', allowed: Object.keys(FORMAT_TO_MIME), got: format })
    }
    const sw = canvas.width
    const sh = canvas.height
    const tw = targetW && targetW > 0 ? targetW : sw
    const th = targetH && targetH > 0 ? targetH : sh

    let blob
    if (tw === sw && th === sh) {
        blob = await new Promise((resolve, reject) => {
            canvas.toBlob(b => b ? resolve(b) : reject(new Error('toBlob produced null')),
                mimeType, quality)
        })
    } else {
        const off = new OffscreenCanvas(tw, th)
        const ctx = off.getContext('2d')
        ctx.imageSmoothingEnabled = true
        ctx.imageSmoothingQuality = 'high'
        ctx.drawImage(canvas, 0, 0, sw, sh, 0, 0, tw, th)
        blob = await off.convertToBlob({ type: mimeType, quality })
    }

    const base64 = await blobToBase64(blob)
    return {
        blob,
        base64,
        mimeType,
        width: tw,
        height: th,
        sizeBytes: blob.size,
        format
    }
}

export async function getCanvasImageBytes(args, app) {
    const format = args?.format || 'png'
    const quality = args?.quality
    const out = await canvasToBytes(app._canvas, format, quality)
    return {
        result: {
            bytes: out.base64,
            mimeType: out.mimeType,
            format: out.format,
            width: out.width,
            height: out.height,
            sizeBytes: out.sizeBytes
        }
    }
}
```

- [ ] **Step 5: Register the command**

Modify `public/js/agent/index.js`. After the existing child-effect registrations:

```js
    registerCommand(LayersAgent, 'getCanvasImageBytes', commands.getCanvasImageBytes)
```

- [ ] **Step 6: Run tests to verify they pass**

```
npx playwright test tests/agent-imagery.spec.js --reporter=line
```

Expected: 3/3 PASS.

- [ ] **Step 7: Commit**

```
git add public/js/agent/commands.js public/js/agent/schemas.js public/js/agent/index.js tests/agent-imagery.spec.js
git commit -m "feat(agent): getCanvasImageBytes + canvasToBytes/blobToBase64 helpers"
```

---

## Task 2: `getThumbnail`

**Files:**
- Modify: `public/js/agent/commands.js`, `public/js/agent/schemas.js`, `public/js/agent/index.js`
- Test: extend `tests/agent-imagery.spec.js`

`getThumbnail` returns a small (≤ maxDimension on longest side) base64 image of the current canvas. Default maxDimension 256, default format jpg, default quality 0.85. Intended for cheap "look at what I just did" use by agents.

- [ ] **Step 1: Add failing tests**

Append to `tests/agent-imagery.spec.js`:

```js
test.describe('getThumbnail', () => {
    test('returns a small JPG thumbnail by default', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() => window.LayersAgent.getThumbnail())
        expect(env.ok).toBe(true)
        expect(env.result.format).toBe('jpg')
        expect(env.result.mimeType).toBe('image/jpeg')
        expect(env.result.width).toBeGreaterThan(0)
        expect(env.result.height).toBeGreaterThan(0)
        expect(Math.max(env.result.width, env.result.height)).toBeLessThanOrEqual(256)
        expect(env.result.bytes.startsWith('/9j/')).toBe(true)
    })

    test('honors maxDimension', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() => window.LayersAgent.getThumbnail({ maxDimension: 64 }))
        expect(env.ok).toBe(true)
        expect(Math.max(env.result.width, env.result.height)).toBeLessThanOrEqual(64)
    })

    test('preserves aspect ratio', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() => window.LayersAgent.getThumbnail({ maxDimension: 100 }))
        expect(env.ok).toBe(true)
        // Default canvas is 1024x1024 → both sides should be 100
        expect(env.result.width).toBe(100)
        expect(env.result.height).toBe(100)
    })

    test('rejects out-of-range maxDimension', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() => window.LayersAgent.getThumbnail({ maxDimension: 0 }))
        expect(env.ok).toBe(false)
        expect(env.error.code).toBe('INVALID_ARGS_RANGE')
    })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```
npx playwright test tests/agent-imagery.spec.js -g "getThumbnail" --reporter=line
```

Expected: FAIL.

- [ ] **Step 3: Add schema**

Modify `public/js/agent/schemas.js`. Append:

```js
    getThumbnail: {
        type: 'object',
        properties: {
            maxDimension: { type: 'integer', min: 1, max: 4096 },
            format: { type: 'string', enum: ['png', 'jpg', 'webp'] },
            quality: { type: 'number', min: 0, max: 1 }
        }
    },
```

- [ ] **Step 4: Add handler**

Modify `public/js/agent/commands.js`. Append:

```js
function thumbnailDimensions(srcWidth, srcHeight, maxDimension) {
    const longest = Math.max(srcWidth, srcHeight)
    if (longest <= maxDimension) {
        return { width: srcWidth, height: srcHeight }
    }
    const ratio = maxDimension / longest
    return {
        width: Math.max(1, Math.round(srcWidth * ratio)),
        height: Math.max(1, Math.round(srcHeight * ratio))
    }
}

export async function getThumbnail(args, app) {
    const maxDim = args?.maxDimension ?? 256
    const format = args?.format || 'jpg'
    const quality = args?.quality ?? 0.85
    const { width: tw, height: th } = thumbnailDimensions(
        app._canvas.width, app._canvas.height, maxDim)
    const out = await canvasToBytes(app._canvas, format, quality, tw, th)
    return {
        result: {
            bytes: out.base64,
            mimeType: out.mimeType,
            format: out.format,
            width: out.width,
            height: out.height,
            sizeBytes: out.sizeBytes
        }
    }
}
```

- [ ] **Step 5: Register the command**

Modify `public/js/agent/index.js`. After `getCanvasImageBytes`:

```js
    registerCommand(LayersAgent, 'getThumbnail', commands.getThumbnail)
```

- [ ] **Step 6: Run tests to verify they pass**

```
npx playwright test tests/agent-imagery.spec.js --reporter=line
```

Expected: 7/7 PASS (3 prior + 4 new).

- [ ] **Step 7: Commit**

```
git add public/js/agent/commands.js public/js/agent/schemas.js public/js/agent/index.js tests/agent-imagery.spec.js
git commit -m "feat(agent): getThumbnail command"
```

---

## Task 3: `getLayerThumbnail`

**Files:**
- Modify: `public/js/agent/commands.js`, `public/js/agent/schemas.js`, `public/js/agent/index.js`
- Test: extend `tests/agent-imagery.spec.js`

Renders only the named layer (and its children/mask), then thumbnails the result. Uses the existing `_renderLayerComposite([layerId])` helper which temporarily makes only the named layer visible, rebuilds, captures, restores.

- [ ] **Step 1: Add failing tests**

Append to `tests/agent-imagery.spec.js`:

```js
test.describe('getLayerThumbnail', () => {
    test('returns a per-layer JPG thumbnail', async ({ page }) => {
        await bootApp(page)
        const id = await page.evaluate(() => window.layersApp._layers[0].id)
        const env = await page.evaluate((layerId) =>
            window.LayersAgent.getLayerThumbnail({ layerId }), id)
        expect(env.ok).toBe(true)
        expect(env.result.format).toBe('jpg')
        expect(Math.max(env.result.width, env.result.height)).toBeLessThanOrEqual(256)
        expect(env.result.bytes.startsWith('/9j/')).toBe(true)
    })

    test('NOT_FOUND_LAYER for missing id', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() =>
            window.LayersAgent.getLayerThumbnail({ layerId: 'layer-nope' }))
        expect(env.ok).toBe(false)
        expect(env.error.code).toBe('NOT_FOUND_LAYER')
    })

    test('honors maxDimension', async ({ page }) => {
        await bootApp(page)
        const id = await page.evaluate(() => window.layersApp._layers[0].id)
        const env = await page.evaluate((layerId) =>
            window.LayersAgent.getLayerThumbnail({ layerId, maxDimension: 32 }), id)
        expect(env.ok).toBe(true)
        expect(Math.max(env.result.width, env.result.height)).toBeLessThanOrEqual(32)
    })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```
npx playwright test tests/agent-imagery.spec.js -g "getLayerThumbnail" --reporter=line
```

Expected: FAIL.

- [ ] **Step 3: Add schema**

Modify `public/js/agent/schemas.js`. Append:

```js
    getLayerThumbnail: {
        type: 'object',
        required: ['layerId'],
        properties: {
            layerId: { type: 'string' },
            maxDimension: { type: 'integer', min: 1, max: 4096 },
            format: { type: 'string', enum: ['png', 'jpg', 'webp'] },
            quality: { type: 'number', min: 0, max: 1 }
        }
    },
```

- [ ] **Step 4: Add handler**

Modify `public/js/agent/commands.js`. Append:

```js
export async function getLayerThumbnail({ layerId, maxDimension, format, quality }, app) {
    requireLayer(layerId, app)
    const maxDim = maxDimension ?? 256
    const fmt = format || 'jpg'
    const q = quality ?? 0.85

    // _renderLayerComposite returns an HTMLImageElement of the canvas after
    // rendering only the named layer (and its children/mask). Draw it into
    // an offscreen canvas at the target thumbnail size.
    const sourceImg = await app._renderLayerComposite([layerId])
    if (!sourceImg) {
        throw commandError('RENDER_LAYER_COMPOSITE_FAILED',
            `Could not render layer ${layerId}`,
            { layerId })
    }

    const sw = sourceImg.naturalWidth || sourceImg.width
    const sh = sourceImg.naturalHeight || sourceImg.height
    const { width: tw, height: th } = thumbnailDimensions(sw, sh, maxDim)

    const off = new OffscreenCanvas(tw, th)
    const ctx = off.getContext('2d')
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(sourceImg, 0, 0, sw, sh, 0, 0, tw, th)

    const mimeType = FORMAT_TO_MIME[fmt]
    const blob = await off.convertToBlob({ type: mimeType, quality: q })
    const base64 = await blobToBase64(blob)
    return {
        result: {
            bytes: base64,
            mimeType,
            format: fmt,
            width: tw,
            height: th,
            sizeBytes: blob.size,
            layerId
        }
    }
}
```

- [ ] **Step 5: Register the command**

Modify `public/js/agent/index.js`. After `getThumbnail`:

```js
    registerCommand(LayersAgent, 'getLayerThumbnail', commands.getLayerThumbnail)
```

- [ ] **Step 6: Run tests to verify they pass**

```
npx playwright test tests/agent-imagery.spec.js --reporter=line
```

Expected: 10/10 PASS (7 prior + 3 new).

- [ ] **Step 7: Commit**

```
git add public/js/agent/commands.js public/js/agent/schemas.js public/js/agent/index.js tests/agent-imagery.spec.js
git commit -m "feat(agent): getLayerThumbnail command"
```

---

## Task 4: `exportImage`

**Files:**
- Modify: `public/js/agent/commands.js`, `public/js/agent/schemas.js`, `public/js/agent/index.js`, `public/js/agent/snapshot.js`
- Test: `tests/agent-export-image.spec.js`

`exportImage` produces a finalized export at the requested format/quality (and optionally width/height — high-quality 2D resample, not a shader re-render). Triggers a real browser download (matches human UI; the future MCP sidecar in Phase 7 will catch the download via Playwright's `page.on('download')`). Returns the bytes inline AND records an entry in `recentExports` so subsequent `getState` calls expose the export descriptor.

- [ ] **Step 1: Write the failing tests**

Create `tests/agent-export-image.spec.js`:

```js
import { test, expect } from 'playwright/test'

async function bootApp(page) {
    await page.goto('/', { waitUntil: 'networkidle' })
    await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })
    await page.evaluate(async () => { await window.LayersAgent.ready })
    const visible = await page.evaluate(() => !!document.querySelector('.open-dialog-backdrop.visible'))
    if (visible) {
        await page.click('.media-option[data-type="solid"]')
        await page.waitForSelector('.canvas-size-dialog', { timeout: 5000 })
        await page.click('.canvas-size-dialog .action-btn.primary')
        await page.waitForSelector('.open-dialog-backdrop.visible', { state: 'hidden', timeout: 5000 })
    }
}

test.describe('exportImage', () => {
    test('returns PNG bytes inline', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() =>
            window.LayersAgent.exportImage({ format: 'png', triggerDownload: false }))
        expect(env.ok).toBe(true)
        expect(env.result.format).toBe('png')
        expect(env.result.mimeType).toBe('image/png')
        expect(env.result.bytes.startsWith('iVBOR')).toBe(true)
        expect(env.result.sizeBytes).toBeGreaterThan(0)
        expect(env.result.filename).toMatch(/\.png$/)
    })

    test('exports JPG with custom quality', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() =>
            window.LayersAgent.exportImage({ format: 'jpg', quality: 0.5, triggerDownload: false }))
        expect(env.ok).toBe(true)
        expect(env.result.format).toBe('jpg')
        expect(env.result.bytes.startsWith('/9j/')).toBe(true)
    })

    test('honors target width/height (resampled)', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() =>
            window.LayersAgent.exportImage({
                format: 'png', width: 256, height: 256, triggerDownload: false
            }))
        expect(env.ok).toBe(true)
        expect(env.result.width).toBe(256)
        expect(env.result.height).toBe(256)
    })

    test('triggers a browser download by default and adds a recentExports entry', async ({ page }) => {
        await bootApp(page)
        const downloadPromise = page.waitForEvent('download', { timeout: 5000 })
        const env = await page.evaluate(() =>
            window.LayersAgent.exportImage({ format: 'png', filename: 'agent-test' }))
        const download = await downloadPromise
        expect(env.ok).toBe(true)
        expect(download.suggestedFilename()).toMatch(/\.png$/)
        expect(env.state.recentExports.length).toBeGreaterThan(0)
        const last = env.state.recentExports[env.state.recentExports.length - 1]
        expect(last.kind).toBe('image')
        expect(last.mimeType).toBe('image/png')
    })

    test('accepts a custom filename', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() =>
            window.LayersAgent.exportImage({
                format: 'png', filename: 'my-export', triggerDownload: false
            }))
        expect(env.ok).toBe(true)
        expect(env.result.filename).toBe('my-export.png')
    })

    test('rejects unknown format', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() =>
            window.LayersAgent.exportImage({ format: 'gif' }))
        expect(env.ok).toBe(false)
        expect(env.error.code).toBe('INVALID_ARGS_ENUM')
    })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```
npx playwright test tests/agent-export-image.spec.js --reporter=line
```

Expected: FAIL.

- [ ] **Step 3: Add schema**

Modify `public/js/agent/schemas.js`. Append:

```js
    exportImage: {
        type: 'object',
        properties: {
            format: { type: 'string', enum: ['png', 'jpg', 'webp'] },
            quality: { type: 'number', min: 0, max: 1 },
            width: { type: 'integer', min: 1, max: 8192 },
            height: { type: 'integer', min: 1, max: 8192 },
            filename: { type: 'string' },
            triggerDownload: { type: 'boolean' }
        }
    },
```

- [ ] **Step 4: Add the recentExports buffer + handler**

Modify `public/js/agent/commands.js`. Append:

```js
const RECENT_EXPORTS_CAP = 50
const _recentExports = []

/**
 * Snapshot exposes recentExports through this getter — module-scoped buffer
 * keeps history without polluting the LayersApp state.
 */
export function getRecentExports() {
    return _recentExports.slice()
}

function recordExport(entry) {
    _recentExports.push(entry)
    while (_recentExports.length > RECENT_EXPORTS_CAP) _recentExports.shift()
}

function makeExportId() {
    return `export-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
}

function timestampedFilename(baseName, ext) {
    if (baseName) return `${baseName}.${ext}`
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    return `layers-${ts}.${ext}`
}

function triggerBrowserDownload(blob, filename) {
    const url = URL.createObjectURL(blob)
    try {
        const a = document.createElement('a')
        a.href = url
        a.download = filename
        document.body.appendChild(a)
        a.click()
        document.body.removeChild(a)
    } finally {
        // Defer revoke so the click has time to consume the URL.
        setTimeout(() => URL.revokeObjectURL(url), 4000)
    }
}

export async function exportImage(args, app) {
    const format = args?.format || 'png'
    const quality = args?.quality
    const width = args?.width
    const height = args?.height
    const triggerDownload = args?.triggerDownload !== false   // defaults true
    const filename = timestampedFilename(args?.filename, format === 'jpg' ? 'jpg' : format)

    const out = await canvasToBytes(app._canvas, format, quality, width, height)

    if (triggerDownload) {
        triggerBrowserDownload(out.blob, filename)
    }

    const entry = {
        id: makeExportId(),
        path: null,                 // populated by the MCP sidecar in Phase 7
        filename,
        mimeType: out.mimeType,
        sizeBytes: out.sizeBytes,
        createdAt: new Date().toISOString(),
        kind: 'image'
    }
    recordExport(entry)

    return {
        result: {
            bytes: out.base64,
            mimeType: out.mimeType,
            format: out.format,
            width: out.width,
            height: out.height,
            sizeBytes: out.sizeBytes,
            filename,
            exportId: entry.id
        }
    }
}
```

- [ ] **Step 5: Wire snapshot to the recentExports buffer**

Modify `public/js/agent/snapshot.js`. Replace the `recentExports: []` literal in `buildSnapshot` with a getter call:

Before:
```js
        recentExports: [],
```

After:
```js
        recentExports: getRecentExports(),
```

Add the import at the top:

```js
import { getRecentExports } from './commands.js'
```

(This adds another circular import edge alongside the existing `index.js ↔ snapshot.js ↔ commands.js` triangle. ESM tolerates it because all three only read each other's bindings at call time. The pre-Phase-2 cleanup task to extract `constants.js` should also extract `getRecentExports` to a separate module if the cycle starts causing problems.)

- [ ] **Step 6: Register the command**

Modify `public/js/agent/index.js`. After `getLayerThumbnail`:

```js
    registerCommand(LayersAgent, 'exportImage', commands.exportImage)
```

- [ ] **Step 7: Run tests to verify they pass**

```
npx playwright test tests/agent-export-image.spec.js --reporter=line
```

Expected: 6/6 PASS.

Smoke check the rest:

```
npx playwright test tests/agent-*.spec.js --reporter=line
```

Expected: prior 92 + 10 imagery + 6 exportImage = 108. Adjusted snapshot wiring (recentExports now populated) should not break the golden — the golden uses an empty `recentExports` because no exports have happened in that test. Verify, refresh the golden if needed.

If the golden test fails because `recentExports` accumulates across tests in the same Playwright context, normalize that field in the snapshot golden test:

Modify `tests/agent-snapshot-golden.spec.js` `normalize()` to also clear `recentExports`:

```js
    if (Array.isArray(clone.recentExports)) clone.recentExports = []
```

- [ ] **Step 8: Commit**

```
git add public/js/agent/commands.js public/js/agent/schemas.js public/js/agent/index.js public/js/agent/snapshot.js tests/agent-export-image.spec.js tests/agent-snapshot-golden.spec.js
git commit -m "feat(agent): exportImage command with download trigger and recentExports tracking"
```

---

## Task 5: `pasteImageFromBytes`

**Files:**
- Modify: `public/js/agent/commands.js`, `public/js/agent/schemas.js`, `public/js/agent/index.js`
- Test: extend `tests/agent-imagery.spec.js`

Thin wrapper over Phase 2's `addLayer kind=media` source pipeline. The agent passes base64 bytes; we materialize them as a media layer.

- [ ] **Step 1: Add failing tests**

Append to `tests/agent-imagery.spec.js`:

```js
test.describe('pasteImageFromBytes', () => {
    const TINY_PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='

    test('adds a media layer from base64 bytes', async ({ page }) => {
        await bootApp(page)
        const before = await page.evaluate(() => window.layersApp._layers.length)
        const env = await page.evaluate((data) =>
            window.LayersAgent.pasteImageFromBytes({
                source: { kind: 'base64', data, mimeType: 'image/png' }
            }), TINY_PNG_B64)
        expect(env.ok).toBe(true)
        expect(env.result.layerId).toMatch(/^layer-/)
        const after = await page.evaluate(() => window.layersApp._layers.length)
        expect(after).toBe(before + 1)
        const layer = env.state.layers.find(l => l.id === env.result.layerId)
        expect(layer.sourceType).toBe('media')
    })

    test('rejects missing source', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() => window.LayersAgent.pasteImageFromBytes({}))
        expect(env.ok).toBe(false)
        expect(env.error.code).toBe('INVALID_ARGS_REQUIRED')
        expect(env.error.details.field).toBe('source')
    })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```
npx playwright test tests/agent-imagery.spec.js -g "pasteImageFromBytes" --reporter=line
```

Expected: FAIL.

- [ ] **Step 3: Add schema**

Modify `public/js/agent/schemas.js`. Append:

```js
    pasteImageFromBytes: {
        type: 'object',
        required: ['source'],
        properties: {
            source: { type: 'object' },
            name: { type: 'string' }
        }
    },
```

- [ ] **Step 4: Add handler**

Modify `public/js/agent/commands.js`. Append (note: this delegates to `addMediaLayer` from Phase 2 by setting `mediaType = 'image'`):

```js
export async function pasteImageFromBytes({ source, name }, app) {
    return addMediaLayer({ source, mediaType: 'image', name: name || 'pasted' }, app)
}
```

- [ ] **Step 5: Register the command**

Modify `public/js/agent/index.js`. After `exportImage`:

```js
    registerCommand(LayersAgent, 'pasteImageFromBytes', commands.pasteImageFromBytes)
```

- [ ] **Step 6: Run tests to verify they pass**

```
npx playwright test tests/agent-imagery.spec.js --reporter=line
```

Expected: 12/12 PASS (10 prior + 2 new).

- [ ] **Step 7: Commit**

```
git add public/js/agent/commands.js public/js/agent/schemas.js public/js/agent/index.js tests/agent-imagery.spec.js
git commit -m "feat(agent): pasteImageFromBytes command"
```

---

## Task 6: Phase 3 verification

**Files:** none — verification only.

- [ ] **Step 1: Run every agent spec**

```
npx playwright test tests/agent-*.spec.js --reporter=line
```

Expected: 92 (Phase 1+2) + 12 (imagery: 3 + 4 + 3 + 2) + 6 (export-image) = 110 tests pass.

(The Phase 1 snapshot count stays at 9 even after `recentExports` becomes populated, because `exportImage` is the only thing that records and no Phase 1/2 test runs it.)

- [ ] **Step 2: Run the full Layers suite to verify no regressions**

```
npx playwright test --reporter=line
```

Expected: existing non-agent tests pass. The same parallel-execution flakes (`clone-tool`, `move-tool`, `drag-reorder`) may appear; rerun in isolation to confirm they pass solo. Investigate any genuinely new failure.

- [ ] **Step 3: Refresh the snapshot golden if needed**

If Step 1 of Task 4 normalized `recentExports` correctly, the golden test passes. Otherwise:

```
UPDATE_GOLDEN=1 npx playwright test tests/agent-snapshot-golden.spec.js --reporter=line
```

Inspect the diff before committing; only commit if `recentExports` normalization is the only change.

- [ ] **Step 4: Manual smoke**

Boot the dev server:

```
npx http-server public -p 3002 -c-1
```

In a browser:
- App loads.
- In devtools console: `(await window.LayersAgent.getThumbnail()).result.bytes.length` returns a small base64 string (sub-50KB at default settings).
- `(await window.LayersAgent.exportImage()).result.filename` returns a sensible filename, and a real download appears in the browser.
- `(await window.LayersAgent.getState()).state.recentExports` includes the export entry.
- Existing UI export menu items still work.

- [ ] **Step 5: Tag the milestone (optional)**

```
git tag agent-phase-3
```

(Local only.)

---

## Out of scope for Phase 3 (deferred to later plans)

- Selections, masks-CRUD, drawing strokes — Phase 4.
- Project CRUD (`newProject`, `openProject`, `saveProject`, `deleteProject`), undo/redo control, settings mutation, view controls, image/canvas resize — Phase 5.
- Long-running ops + video export — Phase 6.
- The `layers-mcp` sidecar — Phase 7. (The `triggerDownload` flag on `exportImage` is the cooperation point: the sidecar's `page.on('download')` will catch the download, while agents that don't want it can disable it.)
- Agent-driven evals — Phase 8.
- High-quality re-render at target export size (current implementation 2D-resamples; adequate for most cases but not pixel-perfect for shader output). Re-render at target dimensions would integrate with Phase 5's canvas resize.
