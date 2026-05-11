# Layers Agent — Phase 4-selections (Selections + Crop) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the agent's selection toolkit. Agents can now set rectangular/oval/polygon/lasso/wand/color-range selections, modify them (expand/contract/feather/smooth/border), invert them, clear them, and crop the canvas to them.

**Architecture:** All commands live in `public/js/agent/commands.js`. They wrap `app._selectionManager.setSelection(path)` (the canonical single-method gate the existing UI also uses), the pure-function helpers exported from `public/js/selection/selection-modify.js`, and the existing `app._cropToSelection()`. Mode handling (replace/add/subtract/intersect) is **deferred** to a follow-up cleanup — Phase 4-selections is replace-only. The schema doesn't accept a `mode` arg, so the API can grow non-breakingly later.

**Tech Stack:** Vanilla ES modules. Browser-native `OffscreenCanvas` and `ImageData`. No new runtime dependencies. Playwright for tests.

**Reference spec:** `docs/plans/2026-05-07-layers-agent-instrumentation-design.md`
**Reference Phase 3 plan:** `docs/plans/2026-05-08-layers-agent-phase-3-plan.md`

**Scope decomposition:** Phase 4 in the original spec covers selections + masks + drawing strokes (~17 tasks). Splitting into three plans keeps each iteration tight: Plan 4-selections (this), Plan 4-masks (next), Plan 4-drawing (last).

---

## File structure

**Modify:**
- `public/js/agent/commands.js` — add ~13 selection-related handlers + a few small helpers.
- `public/js/agent/schemas.js` — append schemas.
- `public/js/agent/index.js` — register each new command.

**Create (tests):**
- `tests/agent-selections.spec.js` — set/clear/invert/select-all + the four setX selection variants + magic wand + color range.
- `tests/agent-selection-modify.spec.js` — expand/contract/feather/smooth/border + crop.

The plan estimate of ~13 commands across two test files keeps each spec focused and parallel-runnable.

---

## Task 1: selectAll, selectNone, selectInverse

**Files:**
- Modify: `public/js/agent/commands.js`, `public/js/agent/schemas.js`, `public/js/agent/index.js`
- Test: `tests/agent-selections.spec.js`

The basic selection ops:
- `selectAll()` — sets a rectangle selection covering the entire canvas.
- `selectNone()` — clears the selection.
- `selectInverse()` — inverts the current selection by rasterizing then calling `invertMask` from selection-modify.

- [ ] **Step 1: Write the failing test**

Create `tests/agent-selections.spec.js`:

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

test.describe('selectAll / selectNone / selectInverse', () => {
    test('selectAll covers the whole canvas', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() => window.LayersAgent.selectAll())
        expect(env.ok).toBe(true)
        expect(env.state.selection).not.toBeNull()
        expect(env.state.selection.kind).toBe('rectangle')
        expect(env.state.selection.bounds).toEqual({
            x: 0, y: 0,
            width: env.state.canvas.width,
            height: env.state.canvas.height
        })
    })

    test('selectNone clears the selection', async ({ page }) => {
        await bootApp(page)
        await page.evaluate(() => window.LayersAgent.selectAll())
        const env = await page.evaluate(() => window.LayersAgent.selectNone())
        expect(env.ok).toBe(true)
        expect(env.state.selection).toBeNull()
    })

    test('selectInverse on a rect produces a mask selection', async ({ page }) => {
        await bootApp(page)
        await page.evaluate(() => {
            window.layersApp._selectionManager._selectionPath = {
                type: 'rect', x: 100, y: 100, width: 200, height: 200
            }
            window.layersApp._selectionManager._drawMarchingAnts()
        })
        const env = await page.evaluate(() => window.LayersAgent.selectInverse())
        expect(env.ok).toBe(true)
        // After inversion the selection becomes a mask (color-range kind), since
        // SELECTION_KIND_MAP maps internal type 'mask' to public kind 'color-range'.
        expect(env.state.selection).not.toBeNull()
        expect(env.state.selection.kind).toBe('color-range')
    })

    test('selectInverse with no selection returns CONFLICT_NO_SELECTION', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() => window.LayersAgent.selectInverse())
        expect(env.ok).toBe(false)
        expect(env.error.code).toBe('CONFLICT_NO_SELECTION')
    })
})
```

- [ ] **Step 2: Run test to verify it fails**

```
npx playwright test tests/agent-selections.spec.js --reporter=line
```

Expected: FAIL — commands not registered.

- [ ] **Step 3: Add schemas**

Modify `public/js/agent/schemas.js`. Append to `SCHEMAS`:

```js
    selectAll: null,
    selectNone: null,
    selectInverse: null,
```

- [ ] **Step 4: Add helpers + handlers**

Modify `public/js/agent/commands.js`. Add the import at the top (alongside the existing imports):

```js
import { invertMask } from '../selection/selection-modify.js'
```

Append (after the existing `pasteImageFromBytes` handler):

```js
/**
 * Throw CONFLICT_NO_SELECTION if there's no active selection.
 */
function requireSelection(app) {
    const sm = app?._selectionManager
    if (!sm || !sm.hasSelection?.()) {
        throw commandError('CONFLICT_NO_SELECTION',
            'No active selection. Set one first with selectAll or setRectangleSelection.',
            {})
    }
    return sm
}

export async function selectAll(_args, app) {
    const sm = app?._selectionManager
    if (!sm) {
        throw commandError('INTERNAL_ERROR',
            'Selection manager not available', {})
    }
    sm.setSelection({
        type: 'rect',
        x: 0, y: 0,
        width: app._canvas.width,
        height: app._canvas.height
    })
    return { result: { ok: true } }
}

export async function selectNone(_args, app) {
    const sm = app?._selectionManager
    if (!sm) {
        throw commandError('INTERNAL_ERROR',
            'Selection manager not available', {})
    }
    sm.clearSelection()
    return { result: { ok: true } }
}

export async function selectInverse(_args, app) {
    const sm = requireSelection(app)
    const mask = sm.rasterizeSelection()
    if (!mask) {
        throw commandError('INTERNAL_ERROR',
            'Could not rasterize current selection',
            {})
    }
    sm.setSelection({ type: 'mask', data: invertMask(mask) })
    return { result: { ok: true } }
}
```

- [ ] **Step 5: Register the commands**

Modify `public/js/agent/index.js`. After the existing `pasteImageFromBytes` registration, append:

```js
    registerCommand(LayersAgent, 'selectAll', commands.selectAll)
    registerCommand(LayersAgent, 'selectNone', commands.selectNone)
    registerCommand(LayersAgent, 'selectInverse', commands.selectInverse)
```

- [ ] **Step 6: Run tests to verify they pass**

```
npx playwright test tests/agent-selections.spec.js --reporter=line
```

Expected: 4/4 PASS.

- [ ] **Step 7: Commit**

```
git add public/js/agent/commands.js public/js/agent/schemas.js public/js/agent/index.js tests/agent-selections.spec.js
git commit -m "feat(agent): selectAll, selectNone, selectInverse commands"
```

---

## Task 2: setRectangleSelection + setOvalSelection

**Files:**
- Modify: `public/js/agent/commands.js`, `public/js/agent/schemas.js`, `public/js/agent/index.js`
- Test: extend `tests/agent-selections.spec.js`

- [ ] **Step 1: Add failing tests**

Append to `tests/agent-selections.spec.js`:

```js
test.describe('setRectangleSelection / setOvalSelection', () => {
    test('setRectangleSelection sets a rect selection at given coords', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() =>
            window.LayersAgent.setRectangleSelection({ x: 50, y: 60, width: 200, height: 100 }))
        expect(env.ok).toBe(true)
        expect(env.state.selection.kind).toBe('rectangle')
        expect(env.state.selection.bounds).toEqual({ x: 50, y: 60, width: 200, height: 100 })
    })

    test('setOvalSelection sets an oval selection', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() =>
            window.LayersAgent.setOvalSelection({ x: 100, y: 200, width: 80, height: 40 }))
        expect(env.ok).toBe(true)
        expect(env.state.selection.kind).toBe('oval')
        // Oval bounds match the input bbox.
        expect(env.state.selection.bounds).toEqual({ x: 100, y: 200, width: 80, height: 40 })
    })

    test('setRectangleSelection rejects negative width', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() =>
            window.LayersAgent.setRectangleSelection({ x: 0, y: 0, width: -1, height: 100 }))
        expect(env.ok).toBe(false)
        expect(env.error.code).toBe('INVALID_ARGS_RANGE')
    })

    test('setRectangleSelection rejects missing required field', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() =>
            window.LayersAgent.setRectangleSelection({ x: 0, y: 0, width: 100 }))
        expect(env.ok).toBe(false)
        expect(env.error.code).toBe('INVALID_ARGS_REQUIRED')
        expect(env.error.details.field).toBe('height')
    })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```
npx playwright test tests/agent-selections.spec.js -g "setRectangleSelection" --reporter=line
```

Expected: FAIL.

- [ ] **Step 3: Add schemas**

Modify `public/js/agent/schemas.js`. Append:

```js
    setRectangleSelection: {
        type: 'object',
        required: ['x', 'y', 'width', 'height'],
        properties: {
            x: { type: 'integer' },
            y: { type: 'integer' },
            width: { type: 'integer', min: 1 },
            height: { type: 'integer', min: 1 }
        }
    },
    setOvalSelection: {
        type: 'object',
        required: ['x', 'y', 'width', 'height'],
        properties: {
            x: { type: 'integer' },
            y: { type: 'integer' },
            width: { type: 'integer', min: 1 },
            height: { type: 'integer', min: 1 }
        }
    },
```

- [ ] **Step 4: Add handlers**

Modify `public/js/agent/commands.js`. Append:

```js
export async function setRectangleSelection({ x, y, width, height }, app) {
    const sm = app?._selectionManager
    if (!sm) {
        throw commandError('INTERNAL_ERROR',
            'Selection manager not available', {})
    }
    sm.setSelection({ type: 'rect', x, y, width, height })
    return { result: { ok: true } }
}

export async function setOvalSelection({ x, y, width, height }, app) {
    const sm = app?._selectionManager
    if (!sm) {
        throw commandError('INTERNAL_ERROR',
            'Selection manager not available', {})
    }
    // SelectionManager's oval path uses center-radii form.
    sm.setSelection({
        type: 'oval',
        cx: x + width / 2,
        cy: y + height / 2,
        rx: width / 2,
        ry: height / 2
    })
    return { result: { ok: true } }
}
```

- [ ] **Step 5: Register the commands**

Modify `public/js/agent/index.js`. After the prior selection registrations:

```js
    registerCommand(LayersAgent, 'setRectangleSelection', commands.setRectangleSelection)
    registerCommand(LayersAgent, 'setOvalSelection', commands.setOvalSelection)
```

- [ ] **Step 6: Run tests to verify they pass**

```
npx playwright test tests/agent-selections.spec.js --reporter=line
```

Expected: 8/8 PASS (4 prior + 4 new).

- [ ] **Step 7: Commit**

```
git add public/js/agent/commands.js public/js/agent/schemas.js public/js/agent/index.js tests/agent-selections.spec.js
git commit -m "feat(agent): setRectangleSelection and setOvalSelection commands"
```

---

## Task 3: setPolygonSelection (covers lasso + polygon)

**Files:**
- Modify: `public/js/agent/commands.js`, `public/js/agent/schemas.js`, `public/js/agent/index.js`
- Test: extend `tests/agent-selections.spec.js`

A single command covers both `lasso` and `polygon` selection types because they have identical internal shape (both are `{ type, points: [{x, y}], ... }`); the agent picks via `kind: 'lasso' | 'polygon'`.

- [ ] **Step 1: Add failing tests**

Append to `tests/agent-selections.spec.js`:

```js
test.describe('setPolygonSelection', () => {
    test('sets a polygon selection from points', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() =>
            window.LayersAgent.setPolygonSelection({
                points: [[10, 10], [100, 10], [100, 100], [10, 100]]
            }))
        expect(env.ok).toBe(true)
        expect(env.state.selection.kind).toBe('polygon')
        expect(env.state.selection.polygonPoints).toEqual([[10, 10], [100, 10], [100, 100], [10, 100]])
        expect(env.state.selection.bounds).toEqual({ x: 10, y: 10, width: 90, height: 90 })
    })

    test('sets a lasso selection when kind=lasso', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() =>
            window.LayersAgent.setPolygonSelection({
                kind: 'lasso',
                points: [[0, 0], [50, 0], [50, 50]]
            }))
        expect(env.ok).toBe(true)
        expect(env.state.selection.kind).toBe('lasso')
    })

    test('rejects too few points', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() =>
            window.LayersAgent.setPolygonSelection({ points: [[0, 0], [50, 50]] }))
        expect(env.ok).toBe(false)
        expect(env.error.code).toBe('INVALID_ARGS_RANGE')
        expect(env.error.details.field).toBe('points')
    })

    test('rejects malformed points', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() =>
            window.LayersAgent.setPolygonSelection({ points: [[0, 0], [50, 'oops'], [100, 100]] }))
        expect(env.ok).toBe(false)
        expect(env.error.code).toBe('INVALID_ARGS_TYPE')
    })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```
npx playwright test tests/agent-selections.spec.js -g "setPolygonSelection" --reporter=line
```

Expected: FAIL.

- [ ] **Step 3: Add schema**

Modify `public/js/agent/schemas.js`. Append:

```js
    setPolygonSelection: {
        type: 'object',
        required: ['points'],
        properties: {
            kind: { type: 'string', enum: ['polygon', 'lasso'] },
            points: {
                type: 'array',
                items: {
                    type: 'array',
                    items: { type: 'number' }
                }
            }
        }
    },
```

- [ ] **Step 4: Add handler**

Modify `public/js/agent/commands.js`. Append:

```js
export async function setPolygonSelection({ kind, points }, app) {
    const sm = app?._selectionManager
    if (!sm) {
        throw commandError('INTERNAL_ERROR',
            'Selection manager not available', {})
    }
    if (!Array.isArray(points) || points.length < 3) {
        throw commandError('INVALID_ARGS_RANGE',
            `polygon/lasso selection requires at least 3 points, got ${points?.length ?? 0}`,
            { field: 'points', min: 3, value: points?.length ?? 0 })
    }
    const sanitized = []
    for (let i = 0; i < points.length; i++) {
        const p = points[i]
        if (!Array.isArray(p) || p.length < 2 ||
            typeof p[0] !== 'number' || typeof p[1] !== 'number') {
            throw commandError('INVALID_ARGS_TYPE',
                `points[${i}] must be a [number, number] tuple`,
                { field: `points[${i}]`, expected: '[number, number]' })
        }
        sanitized.push({ x: p[0], y: p[1] })
    }
    sm.setSelection({ type: kind || 'polygon', points: sanitized })
    return { result: { ok: true } }
}
```

- [ ] **Step 5: Register the command**

Modify `public/js/agent/index.js`. After the prior selection registrations:

```js
    registerCommand(LayersAgent, 'setPolygonSelection', commands.setPolygonSelection)
```

- [ ] **Step 6: Run tests to verify they pass**

```
npx playwright test tests/agent-selections.spec.js --reporter=line
```

Expected: 12/12 PASS (8 prior + 4 new).

- [ ] **Step 7: Commit**

```
git add public/js/agent/commands.js public/js/agent/schemas.js public/js/agent/index.js tests/agent-selections.spec.js
git commit -m "feat(agent): setPolygonSelection (covers polygon + lasso)"
```

---

## Task 4: setMagicWandSelection

**Files:**
- Modify: `public/js/agent/commands.js`, `public/js/agent/schemas.js`, `public/js/agent/index.js`
- Test: extend `tests/agent-selections.spec.js`

The magic wand selects pixels of similar color to a clicked pixel within a tolerance threshold. The selection-manager already has the `floodFill`-based logic but it's only invoked from mouse events. The agent command replicates the core: read canvas pixels, run flood fill at the requested point with the requested tolerance, set selection to `{ type: 'wand', mask }`.

- [ ] **Step 1: Add failing tests**

Append to `tests/agent-selections.spec.js`:

```js
test.describe('setMagicWandSelection', () => {
    test('selects a region of similar color', async ({ page }) => {
        await bootApp(page)
        // Default solid-color canvas; clicking anywhere should select most pixels.
        const env = await page.evaluate(() =>
            window.LayersAgent.setMagicWandSelection({ x: 100, y: 100, tolerance: 32 }))
        expect(env.ok).toBe(true)
        expect(env.state.selection).not.toBeNull()
        expect(env.state.selection.kind).toBe('wand')
        expect(env.state.selection.bounds.width).toBeGreaterThan(0)
    })

    test('rejects out-of-canvas coords', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() =>
            window.LayersAgent.setMagicWandSelection({ x: -1, y: 0, tolerance: 32 }))
        expect(env.ok).toBe(false)
        expect(env.error.code).toBe('INVALID_ARGS_RANGE')
    })

    test('rejects out-of-range tolerance', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() =>
            window.LayersAgent.setMagicWandSelection({ x: 0, y: 0, tolerance: 999 }))
        expect(env.ok).toBe(false)
        expect(env.error.code).toBe('INVALID_ARGS_RANGE')
    })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```
npx playwright test tests/agent-selections.spec.js -g "setMagicWandSelection" --reporter=line
```

Expected: FAIL.

- [ ] **Step 3: Add schema**

Modify `public/js/agent/schemas.js`. Append:

```js
    setMagicWandSelection: {
        type: 'object',
        required: ['x', 'y'],
        properties: {
            x: { type: 'integer', min: 0 },
            y: { type: 'integer', min: 0 },
            tolerance: { type: 'integer', min: 0, max: 255 }
        }
    },
```

- [ ] **Step 4: Add handler**

Modify `public/js/agent/commands.js`. Add the import at the top:

```js
import { floodFill } from '../selection/flood-fill.js'
```

Append:

```js
export async function setMagicWandSelection({ x, y, tolerance }, app) {
    const sm = app?._selectionManager
    if (!sm) {
        throw commandError('INTERNAL_ERROR',
            'Selection manager not available', {})
    }
    const canvas = app._canvas
    if (x >= canvas.width || y >= canvas.height) {
        throw commandError('INVALID_ARGS_RANGE',
            `Point (${x}, ${y}) is outside canvas (${canvas.width}x${canvas.height})`,
            { field: 'x|y', max: { x: canvas.width - 1, y: canvas.height - 1 } })
    }
    // Read current canvas pixels into an offscreen 2D context for flood fill.
    const tmp = document.createElement('canvas')
    tmp.width = canvas.width
    tmp.height = canvas.height
    tmp.getContext('2d').drawImage(canvas, 0, 0)
    const imageData = tmp.getContext('2d').getImageData(0, 0, canvas.width, canvas.height)
    const tol = tolerance ?? sm.wandTolerance ?? 32
    const mask = floodFill(imageData, x, y, tol)
    sm.setSelection({ type: 'wand', mask })
    return { result: { ok: true } }
}
```

- [ ] **Step 5: Register the command**

Modify `public/js/agent/index.js`. After the prior selection registrations:

```js
    registerCommand(LayersAgent, 'setMagicWandSelection', commands.setMagicWandSelection)
```

- [ ] **Step 6: Run tests to verify they pass**

```
npx playwright test tests/agent-selections.spec.js --reporter=line
```

Expected: 15/15 PASS (12 prior + 3 new).

- [ ] **Step 7: Commit**

```
git add public/js/agent/commands.js public/js/agent/schemas.js public/js/agent/index.js tests/agent-selections.spec.js
git commit -m "feat(agent): setMagicWandSelection command"
```

---

## Task 5: selectColorRange

**Files:**
- Modify: `public/js/agent/commands.js`, `public/js/agent/schemas.js`, `public/js/agent/index.js`
- Test: extend `tests/agent-selections.spec.js`

`selectColorRange` is similar to magic wand but selects ALL pixels matching a target color within a tolerance, not just the contiguous region. The existing app uses `colorRange` from `selection-modify.js` keyed by a sample point; the agent variant accepts a target color directly.

The existing `colorRange(imageData, x, y, tolerance)` takes a sample point. For the agent, we accept either:
- `{ x, y, tolerance }` — sample at point (existing form), OR
- `{ targetColor: '#rrggbb' | [r, g, b], tolerance }` — match by color

The handler converts a color-form call into x,y by finding the first matching pixel.

For Phase 4-selections the simpler form is sample-by-point. Color-form can land in a follow-up.

- [ ] **Step 1: Add failing tests**

Append to `tests/agent-selections.spec.js`:

```js
test.describe('selectColorRange', () => {
    test('samples color at given point and selects matching pixels', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() =>
            window.LayersAgent.selectColorRange({ x: 100, y: 100, tolerance: 50 }))
        expect(env.ok).toBe(true)
        expect(env.state.selection).not.toBeNull()
        expect(env.state.selection.kind).toBe('color-range')
        expect(env.state.selection.bounds.width).toBeGreaterThan(0)
    })

    test('rejects out-of-canvas coords', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() =>
            window.LayersAgent.selectColorRange({ x: 99999, y: 0, tolerance: 50 }))
        expect(env.ok).toBe(false)
        expect(env.error.code).toBe('INVALID_ARGS_RANGE')
    })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```
npx playwright test tests/agent-selections.spec.js -g "selectColorRange" --reporter=line
```

Expected: FAIL.

- [ ] **Step 3: Add schema**

Modify `public/js/agent/schemas.js`. Append:

```js
    selectColorRange: {
        type: 'object',
        required: ['x', 'y'],
        properties: {
            x: { type: 'integer', min: 0 },
            y: { type: 'integer', min: 0 },
            tolerance: { type: 'integer', min: 0, max: 255 }
        }
    },
```

- [ ] **Step 4: Add handler**

Modify `public/js/agent/commands.js`. Add the import alongside the existing selection-modify import:

```js
import { invertMask, colorRange } from '../selection/selection-modify.js'
```

(Adjust the existing import line to add `colorRange`.)

Append:

```js
export async function selectColorRange({ x, y, tolerance }, app) {
    const sm = app?._selectionManager
    if (!sm) {
        throw commandError('INTERNAL_ERROR',
            'Selection manager not available', {})
    }
    const canvas = app._canvas
    if (x >= canvas.width || y >= canvas.height) {
        throw commandError('INVALID_ARGS_RANGE',
            `Point (${x}, ${y}) is outside canvas (${canvas.width}x${canvas.height})`,
            { field: 'x|y', max: { x: canvas.width - 1, y: canvas.height - 1 } })
    }
    const tmp = document.createElement('canvas')
    tmp.width = canvas.width
    tmp.height = canvas.height
    tmp.getContext('2d').drawImage(canvas, 0, 0)
    const imageData = tmp.getContext('2d').getImageData(0, 0, canvas.width, canvas.height)
    const tol = tolerance ?? 32
    const mask = colorRange(imageData, x, y, tol)
    sm.setSelection({ type: 'mask', data: mask })
    return { result: { ok: true } }
}
```

- [ ] **Step 5: Register the command**

Modify `public/js/agent/index.js`. After the prior selection registrations:

```js
    registerCommand(LayersAgent, 'selectColorRange', commands.selectColorRange)
```

- [ ] **Step 6: Run tests to verify they pass**

```
npx playwright test tests/agent-selections.spec.js --reporter=line
```

Expected: 17/17 PASS (15 prior + 2 new).

- [ ] **Step 7: Commit**

```
git add public/js/agent/commands.js public/js/agent/schemas.js public/js/agent/index.js tests/agent-selections.spec.js
git commit -m "feat(agent): selectColorRange (sample-by-point) command"
```

---

## Task 6: expandSelection + contractSelection

**Files:**
- Modify: `public/js/agent/commands.js`, `public/js/agent/schemas.js`, `public/js/agent/index.js`
- Test: `tests/agent-selection-modify.spec.js`

The `selection-modify.js` module exports pure mask-transform functions: `expandMask(mask, pixels)` and `contractMask(mask, pixels)`. Both take an `ImageData` and return a new `ImageData`. The agent commands rasterize the current selection, apply the transform, and set the result as a `'mask'` type selection.

- [ ] **Step 1: Write the failing tests**

Create `tests/agent-selection-modify.spec.js`:

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

test.describe('expandSelection', () => {
    test('expands a rectangle selection by N pixels', async ({ page }) => {
        await bootApp(page)
        await page.evaluate(() =>
            window.LayersAgent.setRectangleSelection({ x: 100, y: 100, width: 100, height: 100 }))
        const env = await page.evaluate(() =>
            window.LayersAgent.expandSelection({ pixels: 10 }))
        expect(env.ok).toBe(true)
        expect(env.state.selection).not.toBeNull()
        // Result is a mask-type selection (color-range kind in the snapshot mapping).
        expect(env.state.selection.kind).toBe('color-range')
        // After 10-pixel expansion the bbox should grow on all sides.
        const b = env.state.selection.bounds
        expect(b.x).toBeLessThanOrEqual(100 - 10)
        expect(b.y).toBeLessThanOrEqual(100 - 10)
        expect(b.width).toBeGreaterThanOrEqual(120)
        expect(b.height).toBeGreaterThanOrEqual(120)
    })

    test('expandSelection rejects no active selection', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() =>
            window.LayersAgent.expandSelection({ pixels: 10 }))
        expect(env.ok).toBe(false)
        expect(env.error.code).toBe('CONFLICT_NO_SELECTION')
    })
})

test.describe('contractSelection', () => {
    test('contracts a rectangle selection by N pixels', async ({ page }) => {
        await bootApp(page)
        await page.evaluate(() =>
            window.LayersAgent.setRectangleSelection({ x: 100, y: 100, width: 200, height: 200 }))
        const env = await page.evaluate(() =>
            window.LayersAgent.contractSelection({ pixels: 10 }))
        expect(env.ok).toBe(true)
        const b = env.state.selection.bounds
        expect(b.width).toBeLessThanOrEqual(180)
        expect(b.height).toBeLessThanOrEqual(180)
    })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```
npx playwright test tests/agent-selection-modify.spec.js --reporter=line
```

Expected: FAIL.

- [ ] **Step 3: Add schemas**

Modify `public/js/agent/schemas.js`. Append:

```js
    expandSelection: {
        type: 'object',
        required: ['pixels'],
        properties: { pixels: { type: 'integer', min: 1, max: 1000 } }
    },
    contractSelection: {
        type: 'object',
        required: ['pixels'],
        properties: { pixels: { type: 'integer', min: 1, max: 1000 } }
    },
```

- [ ] **Step 4: Add handlers**

Modify `public/js/agent/commands.js`. Add to the existing selection-modify import:

```js
import { invertMask, colorRange, expandMask, contractMask } from '../selection/selection-modify.js'
```

Append (after `selectColorRange`):

```js
function applySelectionMaskTransform(app, fn) {
    const sm = requireSelection(app)
    const mask = sm.rasterizeSelection()
    if (!mask) {
        throw commandError('INTERNAL_ERROR',
            'Could not rasterize current selection',
            {})
    }
    sm.setSelection({ type: 'mask', data: fn(mask) })
}

export async function expandSelection({ pixels }, app) {
    applySelectionMaskTransform(app, (mask) => expandMask(mask, pixels))
    return { result: { ok: true, pixels } }
}

export async function contractSelection({ pixels }, app) {
    applySelectionMaskTransform(app, (mask) => contractMask(mask, pixels))
    return { result: { ok: true, pixels } }
}
```

- [ ] **Step 5: Register the commands**

Modify `public/js/agent/index.js`. After the prior selection registrations:

```js
    registerCommand(LayersAgent, 'expandSelection', commands.expandSelection)
    registerCommand(LayersAgent, 'contractSelection', commands.contractSelection)
```

- [ ] **Step 6: Run tests to verify they pass**

```
npx playwright test tests/agent-selection-modify.spec.js --reporter=line
```

Expected: 3/3 PASS.

- [ ] **Step 7: Commit**

```
git add public/js/agent/commands.js public/js/agent/schemas.js public/js/agent/index.js tests/agent-selection-modify.spec.js
git commit -m "feat(agent): expandSelection and contractSelection commands"
```

---

## Task 7: featherSelection + smoothSelection + borderSelection

**Files:**
- Modify: `public/js/agent/commands.js`, `public/js/agent/schemas.js`, `public/js/agent/index.js`
- Test: extend `tests/agent-selection-modify.spec.js`

Three more selection-modify wrappers, identical pattern to Task 6.

- [ ] **Step 1: Add failing tests**

Append to `tests/agent-selection-modify.spec.js`:

```js
test.describe('featherSelection / smoothSelection / borderSelection', () => {
    test('featherSelection produces a mask selection', async ({ page }) => {
        await bootApp(page)
        await page.evaluate(() =>
            window.LayersAgent.setRectangleSelection({ x: 100, y: 100, width: 200, height: 200 }))
        const env = await page.evaluate(() =>
            window.LayersAgent.featherSelection({ pixels: 5 }))
        expect(env.ok).toBe(true)
        expect(env.state.selection.kind).toBe('color-range')
    })

    test('smoothSelection produces a mask selection', async ({ page }) => {
        await bootApp(page)
        await page.evaluate(() =>
            window.LayersAgent.setRectangleSelection({ x: 100, y: 100, width: 200, height: 200 }))
        const env = await page.evaluate(() =>
            window.LayersAgent.smoothSelection({ pixels: 5 }))
        expect(env.ok).toBe(true)
        expect(env.state.selection.kind).toBe('color-range')
    })

    test('borderSelection produces a mask selection', async ({ page }) => {
        await bootApp(page)
        await page.evaluate(() =>
            window.LayersAgent.setRectangleSelection({ x: 100, y: 100, width: 200, height: 200 }))
        const env = await page.evaluate(() =>
            window.LayersAgent.borderSelection({ pixels: 5 }))
        expect(env.ok).toBe(true)
        expect(env.state.selection.kind).toBe('color-range')
    })

    test('featherSelection NO_SELECTION', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() =>
            window.LayersAgent.featherSelection({ pixels: 5 }))
        expect(env.ok).toBe(false)
        expect(env.error.code).toBe('CONFLICT_NO_SELECTION')
    })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```
npx playwright test tests/agent-selection-modify.spec.js -g "featherSelection|smoothSelection|borderSelection" --reporter=line
```

Expected: FAIL.

- [ ] **Step 3: Add schemas**

Modify `public/js/agent/schemas.js`. Append:

```js
    featherSelection: {
        type: 'object',
        required: ['pixels'],
        properties: { pixels: { type: 'integer', min: 1, max: 1000 } }
    },
    smoothSelection: {
        type: 'object',
        required: ['pixels'],
        properties: { pixels: { type: 'integer', min: 1, max: 1000 } }
    },
    borderSelection: {
        type: 'object',
        required: ['pixels'],
        properties: { pixels: { type: 'integer', min: 1, max: 1000 } }
    },
```

- [ ] **Step 4: Add handlers**

Modify `public/js/agent/commands.js`. Extend the selection-modify import:

```js
import {
    invertMask, colorRange,
    expandMask, contractMask,
    featherMask, smoothMask, borderMask
} from '../selection/selection-modify.js'
```

Append:

```js
export async function featherSelection({ pixels }, app) {
    applySelectionMaskTransform(app, (mask) => featherMask(mask, pixels))
    return { result: { ok: true, pixels } }
}

export async function smoothSelection({ pixels }, app) {
    applySelectionMaskTransform(app, (mask) => smoothMask(mask, pixels))
    return { result: { ok: true, pixels } }
}

export async function borderSelection({ pixels }, app) {
    applySelectionMaskTransform(app, (mask) => borderMask(mask, pixels))
    return { result: { ok: true, pixels } }
}
```

- [ ] **Step 5: Register the commands**

Modify `public/js/agent/index.js`. After the prior modify registrations:

```js
    registerCommand(LayersAgent, 'featherSelection', commands.featherSelection)
    registerCommand(LayersAgent, 'smoothSelection', commands.smoothSelection)
    registerCommand(LayersAgent, 'borderSelection', commands.borderSelection)
```

- [ ] **Step 6: Run tests to verify they pass**

```
npx playwright test tests/agent-selection-modify.spec.js --reporter=line
```

Expected: 7/7 PASS (3 prior + 4 new).

- [ ] **Step 7: Commit**

```
git add public/js/agent/commands.js public/js/agent/schemas.js public/js/agent/index.js tests/agent-selection-modify.spec.js
git commit -m "feat(agent): featherSelection, smoothSelection, borderSelection"
```

---

## Task 8: cropToSelection

**Files:**
- Modify: `public/js/agent/commands.js`, `public/js/agent/schemas.js`, `public/js/agent/index.js`
- Test: extend `tests/agent-selection-modify.spec.js`

Wraps the existing `app._cropToSelection()` method.

- [ ] **Step 1: Add failing tests**

Append to `tests/agent-selection-modify.spec.js`:

```js
test.describe('cropToSelection', () => {
    test('crops the canvas to the selection bbox', async ({ page }) => {
        await bootApp(page)
        await page.evaluate(() =>
            window.LayersAgent.setRectangleSelection({ x: 100, y: 200, width: 300, height: 150 }))
        const env = await page.evaluate(() => window.LayersAgent.cropToSelection())
        expect(env.ok).toBe(true)
        expect(env.state.canvas.width).toBe(300)
        expect(env.state.canvas.height).toBe(150)
    })

    test('cropToSelection rejects no active selection', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() => window.LayersAgent.cropToSelection())
        expect(env.ok).toBe(false)
        expect(env.error.code).toBe('CONFLICT_NO_SELECTION')
    })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```
npx playwright test tests/agent-selection-modify.spec.js -g "cropToSelection" --reporter=line
```

Expected: FAIL.

- [ ] **Step 3: Add schema**

Modify `public/js/agent/schemas.js`. Append:

```js
    cropToSelection: null,
```

- [ ] **Step 4: Add handler**

Modify `public/js/agent/commands.js`. Append:

```js
export async function cropToSelection(_args, app) {
    requireSelection(app)
    await app._cropToSelection()
    return { result: { ok: true } }
}
```

- [ ] **Step 5: Register the command**

Modify `public/js/agent/index.js`. After the prior modify registrations:

```js
    registerCommand(LayersAgent, 'cropToSelection', commands.cropToSelection)
```

- [ ] **Step 6: Run tests to verify they pass**

```
npx playwright test tests/agent-selection-modify.spec.js --reporter=line
```

Expected: 9/9 PASS (7 prior + 2 new).

- [ ] **Step 7: Commit**

```
git add public/js/agent/commands.js public/js/agent/schemas.js public/js/agent/index.js tests/agent-selection-modify.spec.js
git commit -m "feat(agent): cropToSelection command"
```

---

## Task 9: Phase 4-selections verification

**Files:** none — verification only.

- [ ] **Step 1: Run every agent spec**

```
npx playwright test tests/agent-*.spec.js --reporter=line
```

Expected: 110 (Phase 1+2+3) + 17 (selections) + 9 (selection-modify) = 136 tests pass.

- [ ] **Step 2: Run the full Layers suite**

```
npx playwright test --reporter=line
```

Expected: existing non-agent tests still pass. Same parallel-execution flakes (`clone-tool`, `move-tool`, `drag-reorder`) may appear; rerun in isolation to confirm.

- [ ] **Step 3: Refresh the snapshot golden if needed**

If shape didn't change, the golden test still passes. (Selection mutations don't pollute the buffer; `recentExports` is unaffected.)

- [ ] **Step 4: Manual smoke**

Boot the dev server:

```
npx http-server public -p 3002 -c-1
```

In a browser:
- App loads.
- Devtools console: `await window.LayersAgent.selectAll()` returns ok and a marquee appears in the canvas.
- `await window.LayersAgent.expandSelection({pixels: 20})` — selection grows visually.
- `await window.LayersAgent.cropToSelection()` — canvas resizes.
- Existing UI selection tools still work.

- [ ] **Step 5: Tag the milestone (optional)**

```
git tag agent-phase-4-selections
```

(Local only.)

---

## Out of scope for Phase 4-selections (deferred)

- **Selection mode (add/subtract/intersect)** — Phase 4-selections is replace-only. The schemas don't accept a `mode` arg, so the API can grow non-breakingly later. Mode support belongs in Phase 4-misc cleanup or a dedicated follow-up.
- **`selectColorRange` by target color** — currently sample-by-point only. Color-form (`{ targetColor: '#rgb' | [r,g,b], tolerance }`) belongs in a follow-up.
- **Mask CRUD** (`addLayerMask`, `addMaskFromSelection`, `deleteLayerMask`, `invertLayerMask`, `setMaskEnabled`, `featherMask`, `expandMask`, `contractMask`, `smoothMask`) — Plan 4-masks (next).
- **Drawing strokes** (`paintStroke`, `drawShape`, `fillRegion`) — Plan 4-drawing (after 4-masks).
- **Project CRUD, undo/redo, settings, view, image/canvas resize** — Phase 5.
- **Long-running ops + video export** — Phase 6.
- **MCP sidecar** — Phase 7.
- **Agent-driven evals** — Phase 8.
