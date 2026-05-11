# Layers Agent — Phase 4-drawing (Drawing Strokes) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the agent's drawing primitives. Agents can now paint freehand strokes, draw rect/ellipse shapes, and fill connected regions — completing the third and final sub-phase of Phase 4.

**Architecture:** All commands live in `public/js/agent/commands.js`. `paintStroke` and `drawShape` push strokes onto a drawing layer's `strokes` array (creating one via `_ensureDrawingLayer()` if no `layerId` is supplied), then trigger `_rasterizeDrawingLayer()` to bake the strokes into the layer's draw canvas, then `_rebuild({force: true})`. `fillRegion` mirrors the existing `FillTool`: read composited pixels via `gl.readPixels`, flood-fill at the click point, create a new media layer via `_addMediaLayerFromCanvas`. A small `requireDrawingLayer(layerId, app)` helper ensures the target is actually a drawing layer.

**Tech Stack:** Vanilla ES modules. Browser-native `OffscreenCanvas` and WebGL2 readPixels. No new runtime dependencies. Playwright for tests.

**Reference spec:** `docs/plans/2026-05-07-layers-agent-instrumentation-design.md`
**Reference Phase 4-masks plan:** `docs/plans/2026-05-09-layers-agent-phase-4-masks-plan.md`

**Spec deviation: eraser mode deferred.** The design spec lists `paintStroke` with `mode: 'brush' | 'eraser'`. The existing `EraserTool` deletes whole strokes by ID rather than painting with destination-out compositing — fundamentally different from a brush stroke that erases. Implementing eraser mode would require either (a) a new `composite: 'destination-out'` field on strokes plus stroke-renderer changes, or (b) a new `eraseStroke({ layerId, strokeId })` command matching existing eraser semantics. Both are deferrable. Phase 4-drawing ships `paintStroke` as brush-only with no `mode` arg; the schema can grow non-breakingly later. The cleanup task is updated.

---

## File structure

**Modify:**
- `public/js/agent/commands.js` — add 3 handlers + `requireDrawingLayer` helper.
- `public/js/agent/schemas.js` — append schemas.
- `public/js/agent/index.js` — register each new command.

**Create (tests):**
- `tests/agent-drawing.spec.js` — paintStroke, drawShape, fillRegion all in one spec.

---

## Task 1: paintStroke

**Files:**
- Modify: `public/js/agent/commands.js`, `public/js/agent/schemas.js`, `public/js/agent/index.js`
- Test: `tests/agent-drawing.spec.js`

`paintStroke` pushes a path stroke onto a drawing layer's `strokes` array. If `layerId` is omitted, it ensures (creates if needed) a drawing layer above the active layer. Points accept either `[x, y]` tuples or `{x, y}` objects.

- [ ] **Step 1: Write the failing test**

Create `tests/agent-drawing.spec.js`:

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

test.describe('paintStroke', () => {
    test('paints a stroke onto a new drawing layer (auto-created)', async ({ page }) => {
        await bootApp(page)
        const before = await page.evaluate(() => window.layersApp._layers.length)
        const env = await page.evaluate(() =>
            window.LayersAgent.paintStroke({
                points: [[10, 10], [50, 50], [100, 100]],
                size: 5,
                color: '#ff0000'
            }))
        expect(env.ok).toBe(true)
        expect(env.result.layerId).toMatch(/^layer-/)
        const after = await page.evaluate(() => window.layersApp._layers.length)
        expect(after).toBe(before + 1)
        const drawingLayer = env.state.layers.find(l => l.id === env.result.layerId)
        expect(drawingLayer.sourceType).toBe('drawing')
        expect(drawingLayer.drawing.strokeCount).toBe(1)
    })

    test('paintStroke onto an existing drawing layer', async ({ page }) => {
        await bootApp(page)
        // Create a drawing layer explicitly first.
        const id = await page.evaluate(async () => {
            const env = await window.LayersAgent.addLayer({ kind: 'drawing' })
            return env.result.layerId
        })
        const env = await page.evaluate((layerId) =>
            window.LayersAgent.paintStroke({
                layerId,
                points: [[0, 0], [10, 10]],
                size: 3,
                color: '#000000'
            }), id)
        expect(env.ok).toBe(true)
        expect(env.result.layerId).toBe(id)
        const layer = env.state.layers.find(l => l.id === id)
        expect(layer.drawing.strokeCount).toBe(1)
    })

    test('paintStroke accepts {x,y} object points as well as [x,y] tuples', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() =>
            window.LayersAgent.paintStroke({
                points: [{ x: 10, y: 10 }, { x: 20, y: 20 }],
                size: 5,
                color: '#00ff00'
            }))
        expect(env.ok).toBe(true)
        const layer = env.state.layers.find(l => l.id === env.result.layerId)
        expect(layer.drawing.strokeCount).toBe(1)
    })

    test('CONFLICT_NOT_DRAWING_LAYER when layerId is not a drawing layer', async ({ page }) => {
        await bootApp(page)
        const id = await page.evaluate(() => window.layersApp._layers[0].id)  // base solid effect layer
        const env = await page.evaluate((layerId) =>
            window.LayersAgent.paintStroke({
                layerId,
                points: [[0, 0], [10, 10]],
                size: 5,
                color: '#000000'
            }), id)
        expect(env.ok).toBe(false)
        expect(env.error.code).toBe('CONFLICT_NOT_DRAWING_LAYER')
    })

    test('rejects too few points', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() =>
            window.LayersAgent.paintStroke({ points: [[0, 0]], size: 5, color: '#000000' }))
        expect(env.ok).toBe(false)
        expect(env.error.code).toBe('INVALID_ARGS_RANGE')
        expect(env.error.details.field).toBe('points')
    })

    test('rejects malformed point', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() =>
            window.LayersAgent.paintStroke({
                points: [[0, 0], [1, 'oops']], size: 5, color: '#000000'
            }))
        expect(env.ok).toBe(false)
        expect(env.error.code).toBe('INVALID_ARGS_TYPE')
    })

    test('NOT_FOUND_LAYER for missing id', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() =>
            window.LayersAgent.paintStroke({
                layerId: 'layer-nope',
                points: [[0, 0], [10, 10]],
                size: 5, color: '#000000'
            }))
        expect(env.ok).toBe(false)
        expect(env.error.code).toBe('NOT_FOUND_LAYER')
    })
})
```

- [ ] **Step 2: Run test to verify it fails**

```
npx playwright test tests/agent-drawing.spec.js --reporter=line
```

Expected: FAIL — `paintStroke` not registered.

- [ ] **Step 3: Add schema**

Modify `public/js/agent/schemas.js`. Append:

```js
    paintStroke: {
        type: 'object',
        required: ['points', 'size', 'color'],
        properties: {
            layerId: { type: 'string' },
            points: { type: 'array' },   // shape validated in handler (allow [x,y] or {x,y})
            size: { type: 'integer', min: 1, max: 200 },
            opacity: { type: 'number', min: 0, max: 1 },
            color: { type: 'string' }
        }
    },
```

- [ ] **Step 4: Add helpers + handler**

Modify `public/js/agent/commands.js`. Add the import at the top alongside the existing imports:

```js
import { createPathStroke, createShapeStroke } from '../drawing/stroke-model.js'
```

Append (after the existing `setMaskEnabled` and mask-modify handlers):

```js
/**
 * Look up a layer that is a drawing layer. Throws CONFLICT_NOT_DRAWING_LAYER
 * if the layer exists but isn't of sourceType 'drawing'.
 */
function requireDrawingLayer(layerId, app) {
    const layer = requireLayer(layerId, app)
    if (layer.sourceType !== 'drawing') {
        throw commandError('CONFLICT_NOT_DRAWING_LAYER',
            `Layer ${layerId} is not a drawing layer (sourceType=${layer.sourceType})`,
            { layerId, sourceType: layer.sourceType })
    }
    return layer
}

/**
 * Normalize an array of points; accept either [x,y] tuples or {x,y} objects.
 * Throws INVALID_ARGS_RANGE if fewer than 2 points; INVALID_ARGS_TYPE on malformed.
 */
function normalizePoints(points, fieldName, minCount = 2) {
    if (!Array.isArray(points) || points.length < minCount) {
        throw commandError('INVALID_ARGS_RANGE',
            `${fieldName} requires at least ${minCount} points, got ${points?.length ?? 0}`,
            { field: fieldName, min: minCount, value: points?.length ?? 0 })
    }
    const out = []
    for (let i = 0; i < points.length; i++) {
        const p = points[i]
        if (Array.isArray(p) && p.length >= 2 &&
            typeof p[0] === 'number' && typeof p[1] === 'number') {
            out.push({ x: p[0], y: p[1] })
        } else if (p && typeof p.x === 'number' && typeof p.y === 'number') {
            out.push({ x: p.x, y: p.y })
        } else {
            throw commandError('INVALID_ARGS_TYPE',
                `${fieldName}[${i}] must be [number, number] or {x, y}`,
                { field: `${fieldName}[${i}]`, expected: '[number, number] | {x, y}' })
        }
    }
    return out
}

export async function paintStroke({ layerId, points, size, opacity, color }, app) {
    const sanitized = normalizePoints(points, 'points', 2)
    let layer
    if (layerId) {
        layer = requireDrawingLayer(layerId, app)
    } else {
        layer = app._ensureDrawingLayer()
    }
    app._finalizePendingUndo?.()
    const stroke = createPathStroke({
        color,
        size,
        opacity: opacity ?? 1,
        points: sanitized
    })
    layer.strokes.push(stroke)
    await app._rasterizeDrawingLayer(layer)
    await app._rebuild?.({ force: true })
    app._markDirty?.()
    app._pushUndoState?.()
    return { result: { layerId: layer.id, strokeId: stroke.id } }
}
```

- [ ] **Step 5: Register the command**

Modify `public/js/agent/index.js`. After the existing `smoothMask` registration, append:

```js
    registerCommand(LayersAgent, 'paintStroke', commands.paintStroke)
```

- [ ] **Step 6: Run tests to verify they pass**

```
npx playwright test tests/agent-drawing.spec.js --reporter=line
```

Expected: 7/7 PASS.

Smoke check the rest:

```
npx playwright test tests/agent-*.spec.js --reporter=line
```

Expected: 156 (Phase 1+2+3+4-selections+masks) + 7 = 163 tests pass.

- [ ] **Step 7: Commit**

```
git add public/js/agent/commands.js public/js/agent/schemas.js public/js/agent/index.js tests/agent-drawing.spec.js
git commit -m "feat(agent): paintStroke command (brush-only)"
```

---

## Task 2: drawShape

**Files:**
- Modify: `public/js/agent/commands.js`, `public/js/agent/schemas.js`, `public/js/agent/index.js`
- Test: extend `tests/agent-drawing.spec.js`

`drawShape` pushes a `createShapeStroke()` onto a drawing layer. Same layer-targeting semantics as `paintStroke` (auto-create if `layerId` is omitted).

- [ ] **Step 1: Add failing tests**

Append to `tests/agent-drawing.spec.js`:

```js
test.describe('drawShape', () => {
    test('draws an outlined rect onto a new drawing layer', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() =>
            window.LayersAgent.drawShape({
                shape: 'rect',
                x: 100, y: 100, width: 200, height: 100,
                color: '#0000ff',
                size: 3
            }))
        expect(env.ok).toBe(true)
        const layer = env.state.layers.find(l => l.id === env.result.layerId)
        expect(layer.sourceType).toBe('drawing')
        expect(layer.drawing.strokeCount).toBe(1)
    })

    test('draws a filled ellipse', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() =>
            window.LayersAgent.drawShape({
                shape: 'ellipse',
                x: 50, y: 50, width: 100, height: 80,
                color: '#00aa00',
                size: 1,
                filled: true
            }))
        expect(env.ok).toBe(true)
        const layer = env.state.layers.find(l => l.id === env.result.layerId)
        expect(layer.drawing.strokeCount).toBe(1)
    })

    test('drawShape rejects unknown shape', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() =>
            window.LayersAgent.drawShape({
                shape: 'star',
                x: 0, y: 0, width: 10, height: 10,
                color: '#000000', size: 1
            }))
        expect(env.ok).toBe(false)
        expect(env.error.code).toBe('INVALID_ARGS_ENUM')
    })

    test('drawShape rejects non-positive width', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() =>
            window.LayersAgent.drawShape({
                shape: 'rect',
                x: 0, y: 0, width: 0, height: 10,
                color: '#000000', size: 1
            }))
        expect(env.ok).toBe(false)
        expect(env.error.code).toBe('INVALID_ARGS_RANGE')
    })

    test('drawShape onto a non-drawing layer returns CONFLICT', async ({ page }) => {
        await bootApp(page)
        const id = await page.evaluate(() => window.layersApp._layers[0].id)
        const env = await page.evaluate((layerId) =>
            window.LayersAgent.drawShape({
                layerId,
                shape: 'rect',
                x: 0, y: 0, width: 10, height: 10,
                color: '#000000', size: 1
            }), id)
        expect(env.ok).toBe(false)
        expect(env.error.code).toBe('CONFLICT_NOT_DRAWING_LAYER')
    })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```
npx playwright test tests/agent-drawing.spec.js -g "drawShape" --reporter=line
```

Expected: FAIL.

- [ ] **Step 3: Add schema**

Modify `public/js/agent/schemas.js`. Append:

```js
    drawShape: {
        type: 'object',
        required: ['shape', 'x', 'y', 'width', 'height', 'color', 'size'],
        properties: {
            layerId: { type: 'string' },
            shape: { type: 'string', enum: ['rect', 'ellipse'] },
            x: { type: 'integer' },
            y: { type: 'integer' },
            width: { type: 'integer', min: 1 },
            height: { type: 'integer', min: 1 },
            color: { type: 'string' },
            size: { type: 'integer', min: 1, max: 200 },
            opacity: { type: 'number', min: 0, max: 1 },
            filled: { type: 'boolean' }
        }
    },
```

- [ ] **Step 4: Add handler**

Modify `public/js/agent/commands.js`. Append (after `paintStroke`):

```js
export async function drawShape({ layerId, shape, x, y, width, height, color, size, opacity, filled }, app) {
    let layer
    if (layerId) {
        layer = requireDrawingLayer(layerId, app)
    } else {
        layer = app._ensureDrawingLayer()
    }
    app._finalizePendingUndo?.()
    const stroke = createShapeStroke({
        type: shape,
        color,
        size,
        opacity: opacity ?? 1,
        x, y, width, height,
        filled: !!filled
    })
    layer.strokes.push(stroke)
    await app._rasterizeDrawingLayer(layer)
    await app._rebuild?.({ force: true })
    app._markDirty?.()
    app._pushUndoState?.()
    return { result: { layerId: layer.id, strokeId: stroke.id } }
}
```

- [ ] **Step 5: Register the command**

Modify `public/js/agent/index.js`. After `paintStroke`:

```js
    registerCommand(LayersAgent, 'drawShape', commands.drawShape)
```

- [ ] **Step 6: Run tests to verify they pass**

```
npx playwright test tests/agent-drawing.spec.js --reporter=line
```

Expected: 12/12 PASS (7 prior + 5 new).

- [ ] **Step 7: Commit**

```
git add public/js/agent/commands.js public/js/agent/schemas.js public/js/agent/index.js tests/agent-drawing.spec.js
git commit -m "feat(agent): drawShape command (rect + ellipse)"
```

---

## Task 3: fillRegion

**Files:**
- Modify: `public/js/agent/commands.js`, `public/js/agent/schemas.js`, `public/js/agent/index.js`
- Test: extend `tests/agent-drawing.spec.js`

`fillRegion` mirrors the existing `FillTool`: read composited canvas pixels, run flood-fill at the click point, create a NEW media layer holding the filled pixels.

Note: this differs from the `paintStroke`/`drawShape` model — `fillRegion` does not push a stroke onto a drawing layer; it creates a media layer. Same semantics as the human Fill tool.

- [ ] **Step 1: Add failing tests**

Append to `tests/agent-drawing.spec.js`:

```js
test.describe('fillRegion', () => {
    test('creates a new media layer with the filled region', async ({ page }) => {
        await bootApp(page)
        const before = await page.evaluate(() => window.layersApp._layers.length)
        const env = await page.evaluate(() =>
            window.LayersAgent.fillRegion({
                x: 100, y: 100,
                color: '#ff0000',
                tolerance: 32
            }))
        expect(env.ok).toBe(true)
        expect(env.result.layerId).toMatch(/^layer-/)
        const after = await page.evaluate(() => window.layersApp._layers.length)
        expect(after).toBe(before + 1)
        const layer = env.state.layers.find(l => l.id === env.result.layerId)
        expect(layer.sourceType).toBe('media')
    })

    test('rejects out-of-canvas point', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() =>
            window.LayersAgent.fillRegion({
                x: 99999, y: 0,
                color: '#000000', tolerance: 32
            }))
        expect(env.ok).toBe(false)
        expect(env.error.code).toBe('INVALID_ARGS_RANGE')
    })

    test('rejects out-of-range tolerance', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() =>
            window.LayersAgent.fillRegion({
                x: 0, y: 0,
                color: '#000000', tolerance: 999
            }))
        expect(env.ok).toBe(false)
        expect(env.error.code).toBe('INVALID_ARGS_RANGE')
    })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```
npx playwright test tests/agent-drawing.spec.js -g "fillRegion" --reporter=line
```

Expected: FAIL.

- [ ] **Step 3: Add schema**

Modify `public/js/agent/schemas.js`. Append:

```js
    fillRegion: {
        type: 'object',
        required: ['x', 'y', 'color'],
        properties: {
            x: { type: 'integer', min: 0 },
            y: { type: 'integer', min: 0 },
            color: { type: 'string' },
            tolerance: { type: 'integer', min: 0, max: 255 }
        }
    },
```

- [ ] **Step 4: Add handler**

Modify `public/js/agent/commands.js`. Append (after `drawShape`):

```js
export async function fillRegion({ x, y, color, tolerance }, app) {
    const canvas = app._canvas
    if (x >= canvas.width || y >= canvas.height) {
        throw commandError('INVALID_ARGS_RANGE',
            `Point (${x}, ${y}) is outside canvas (${canvas.width}x${canvas.height})`,
            { field: 'x|y', max: { x: canvas.width - 1, y: canvas.height - 1 } })
    }
    const tol = tolerance ?? 32

    // Read composited pixels from the WebGL canvas (mirrors FillTool._onClick).
    const gl = canvas.getContext('webgl') || canvas.getContext('webgl2')
    if (!gl) {
        throw commandError('INTERNAL_ERROR',
            'Could not get WebGL context for fill', {})
    }
    const w = canvas.width, h = canvas.height
    const pixels = new Uint8Array(w * h * 4)
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, pixels)

    // WebGL readPixels is bottom-up; flip vertically for image-space coords.
    const flipped = new Uint8ClampedArray(w * h * 4)
    for (let row = 0; row < h; row++) {
        const srcRow = (h - 1 - row) * w * 4
        const dstRow = row * w * 4
        flipped.set(pixels.subarray(srcRow, srcRow + w * 4), dstRow)
    }
    const imageData = new ImageData(flipped, w, h)

    // Flood fill at the click point. `floodFill` is already imported at the top
    // of commands.js (added in Phase 4-selections T4 for setMagicWandSelection).
    const mask = floodFill(imageData, x, y, tol)

    // Build a fill canvas masked by the flood-fill mask.
    const fillCanvas = document.createElement('canvas')
    fillCanvas.width = w
    fillCanvas.height = h
    const ctx = fillCanvas.getContext('2d')
    ctx.fillStyle = color
    ctx.fillRect(0, 0, w, h)
    const fillData = ctx.getImageData(0, 0, w, h)
    for (let i = 0; i < mask.data.length; i += 4) {
        if (mask.data[i + 3] === 0) {
            fillData.data[i + 3] = 0
        }
    }
    ctx.putImageData(fillData, 0, 0)

    app._finalizePendingUndo?.()
    await app._addMediaLayerFromCanvas(fillCanvas, 'Fill')
    app._markDirty?.()
    app._pushUndoState?.()
    const newLayer = app._layers[app._layers.length - 1]
    return { result: { layerId: newLayer.id } }
}
```

No new imports needed for `floodFill` — the static import was added in Phase 4-selections T4 for `setMagicWandSelection` and is reused here.

- [ ] **Step 5: Register the command**

Modify `public/js/agent/index.js`. After `drawShape`:

```js
    registerCommand(LayersAgent, 'fillRegion', commands.fillRegion)
```

- [ ] **Step 6: Run tests to verify they pass**

```
npx playwright test tests/agent-drawing.spec.js --reporter=line
```

Expected: 15/15 PASS (12 prior + 3 new).

- [ ] **Step 7: Commit**

```
git add public/js/agent/commands.js public/js/agent/schemas.js public/js/agent/index.js tests/agent-drawing.spec.js
git commit -m "feat(agent): fillRegion command"
```

---

## Task 4: Phase 4-drawing verification (closes the original Phase 4)

**Files:** none — verification only.

This task closes Phase 4 in the original spec (selections + masks + drawing). After this lands the agent surface has full coverage of the spec's Phase 4 scope: 14 selection commands + 9 mask commands + 3 drawing commands = 26 commands across the three sub-phases.

- [ ] **Step 1: Run every agent spec**

```
npx playwright test tests/agent-*.spec.js --reporter=line
```

Expected: 156 (Phase 1+2+3+4-selections+4-masks fixup) + 15 (drawing) = 171 tests pass.

- [ ] **Step 2: Run the full Layers suite**

```
npx playwright test --reporter=line
```

Expected: existing non-agent tests still pass. Same parallel-execution flakes (`clone-tool`, `move-tool`, `drag-reorder`) may appear — confirm they pass in isolation and proceed.

- [ ] **Step 3: Manual smoke**

Boot the dev server:

```
npx http-server public -p 3002 -c-1
```

In a browser:
- App loads.
- Devtools console:
  ```js
  await window.LayersAgent.paintStroke({
      points: [[100, 100], [200, 200], [300, 100], [400, 200]],
      size: 10, color: '#ff00ff'
  })
  ```
- A new drawing layer appears with the painted stroke visible on the canvas.
- `await window.LayersAgent.drawShape({ shape: 'ellipse', x: 100, y: 300, width: 200, height: 100, color: '#00ffff', size: 3, filled: true })` — a filled cyan ellipse appears.
- `await window.LayersAgent.fillRegion({ x: 50, y: 50, color: '#ffff00', tolerance: 32 })` — a yellow region fills the connected area at (50,50).
- Existing UI brush/eraser/shape/fill tools still work.

- [ ] **Step 4: Tag the milestone (optional)**

```
git tag agent-phase-4-drawing
git tag agent-phase-4   # also tag completion of the original Phase 4
```

(Local only.)

---

## Out of scope for Phase 4-drawing (deferred)

- **Eraser mode for `paintStroke`** — the existing `EraserTool` deletes whole strokes by ID; "paint with destination-out" would require either a `composite: 'destination-out'` field on path strokes plus stroke-renderer changes, or a separate `eraseStroke({ layerId, strokeId })` command. The schema for `paintStroke` doesn't accept a `mode` arg yet, so adding it later is non-breaking.
- **`eraseStroke({ layerId, strokeId })`** — convenient companion to mirror the human `EraserTool`, deferred.
- **`clearDrawingLayer({ layerId })`** — wipe all strokes from a drawing layer, deferred.
- **Pressure-aware path strokes** — `createPathStroke` only stores `{x, y}`; pressure values would require model changes.
- **Project CRUD, undo/redo, settings, view, image/canvas resize** — Phase 5.
- **Long-running ops + video export** — Phase 6.
- **MCP sidecar** — Phase 7.
- **Agent-driven evals** — Phase 8.
