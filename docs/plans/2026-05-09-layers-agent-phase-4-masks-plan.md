# Layers Agent — Phase 4-masks (Layer Mask CRUD) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the agent's per-layer mask toolkit. Agents can attach a fully-white mask, build a mask from the current selection, delete a mask, invert it, enable/disable it, and apply the four mask-modify ops (feather/expand/contract/smooth) with explicit radius args.

**Architecture:** All commands live in `public/js/agent/commands.js` and delegate to existing app methods where they exist. The four mask-modify ops (feather/expand/contract/smooth) are problematic because their existing app methods (`_featherLayerMask`, etc.) open a UI dialog to ask for radius — the agent commands instead replicate the dialog-less core inline. `addLayerMask` similarly bypasses the existing app method's `_enterMaskEditMode` side effect (mask edit mode is a UI affordance for human paint refinement, not an agent operation), replicating the core white-mask-creation logic.

**Tech Stack:** Vanilla ES modules. Browser-native `ImageData`. No new runtime dependencies. Playwright for tests.

**Reference spec:** `docs/plans/2026-05-07-layers-agent-instrumentation-design.md`
**Reference Phase 4-selections plan:** `docs/plans/2026-05-09-layers-agent-phase-4-selections-plan.md`

---

## File structure

**Modify:**
- `public/js/agent/commands.js` — add ~9 mask-related handlers + a small `requireMaskedLayer` helper.
- `public/js/agent/schemas.js` — append schemas.
- `public/js/agent/index.js` — register each new command.

**Create (tests):**
- `tests/agent-masks.spec.js` — all mask CRUD + modify ops in one spec file (~5 describe blocks).

---

## Task 1: addLayerMask + deleteLayerMask

**Files:**
- Modify: `public/js/agent/commands.js`, `public/js/agent/schemas.js`, `public/js/agent/index.js`
- Test: `tests/agent-masks.spec.js`

`addLayerMask` creates a fully-white mask on a layer that doesn't already have one. The agent variant skips `_enterMaskEditMode` (UI affordance for human paint refinement). `deleteLayerMask` delegates to the existing app method.

- [ ] **Step 1: Write the failing tests**

Create `tests/agent-masks.spec.js`:

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

test.describe('addLayerMask / deleteLayerMask', () => {
    test('addLayerMask attaches a fully-white mask', async ({ page }) => {
        await bootApp(page)
        const id = await page.evaluate(() => window.layersApp._layers[0].id)
        const env = await page.evaluate((layerId) =>
            window.LayersAgent.addLayerMask({ layerId }), id)
        expect(env.ok).toBe(true)
        const layer = env.state.layers.find(l => l.id === id)
        expect(layer.mask).not.toBeNull()
        expect(layer.mask.enabled).toBe(true)
        expect(layer.mask.coverage).toBeCloseTo(1, 1) // fully white
    })

    test('addLayerMask does not enter mask edit mode', async ({ page }) => {
        await bootApp(page)
        const id = await page.evaluate(() => window.layersApp._layers[0].id)
        await page.evaluate((layerId) =>
            window.LayersAgent.addLayerMask({ layerId }), id)
        const editMode = await page.evaluate(() => window.layersApp._maskEditMode)
        expect(editMode).toBe(false)
    })

    test('addLayerMask returns CONFLICT when layer already has a mask', async ({ page }) => {
        await bootApp(page)
        const id = await page.evaluate(() => window.layersApp._layers[0].id)
        await page.evaluate((layerId) =>
            window.LayersAgent.addLayerMask({ layerId }), id)
        const env = await page.evaluate((layerId) =>
            window.LayersAgent.addLayerMask({ layerId }), id)
        expect(env.ok).toBe(false)
        expect(env.error.code).toBe('CONFLICT_LAYER_HAS_MASK')
    })

    test('addLayerMask NOT_FOUND_LAYER for missing id', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() =>
            window.LayersAgent.addLayerMask({ layerId: 'layer-nope' }))
        expect(env.ok).toBe(false)
        expect(env.error.code).toBe('NOT_FOUND_LAYER')
    })

    test('deleteLayerMask removes the mask', async ({ page }) => {
        await bootApp(page)
        const id = await page.evaluate(() => window.layersApp._layers[0].id)
        await page.evaluate((layerId) =>
            window.LayersAgent.addLayerMask({ layerId }), id)
        const env = await page.evaluate((layerId) =>
            window.LayersAgent.deleteLayerMask({ layerId }), id)
        expect(env.ok).toBe(true)
        const layer = env.state.layers.find(l => l.id === id)
        expect(layer.mask).toBeNull()
    })

    test('deleteLayerMask CONFLICT when no mask present', async ({ page }) => {
        await bootApp(page)
        const id = await page.evaluate(() => window.layersApp._layers[0].id)
        const env = await page.evaluate((layerId) =>
            window.LayersAgent.deleteLayerMask({ layerId }), id)
        expect(env.ok).toBe(false)
        expect(env.error.code).toBe('CONFLICT_NO_MASK')
    })
})
```

- [ ] **Step 2: Run test to verify it fails**

```
npx playwright test tests/agent-masks.spec.js --reporter=line
```

Expected: FAIL — commands not registered.

- [ ] **Step 3: Add schemas**

Modify `public/js/agent/schemas.js`. Append to `SCHEMAS`:

```js
    addLayerMask: {
        type: 'object',
        required: ['layerId'],
        properties: { layerId: { type: 'string' } }
    },
    deleteLayerMask: {
        type: 'object',
        required: ['layerId'],
        properties: { layerId: { type: 'string' } }
    },
```

- [ ] **Step 4: Add helpers + handlers**

Modify `public/js/agent/commands.js`. Append (after the existing `cropToSelection` handler):

```js
/**
 * Look up a layer that already has a mask; throw CONFLICT_NO_MASK if missing.
 */
function requireMaskedLayer(layerId, app) {
    const layer = requireLayer(layerId, app)
    if (!layer.mask) {
        throw commandError('CONFLICT_NO_MASK',
            `Layer ${layerId} has no mask. Call addLayerMask or addMaskFromSelection first.`,
            { layerId })
    }
    return layer
}

export async function addLayerMask({ layerId }, app) {
    const layer = requireLayer(layerId, app)
    if (layer.mask) {
        throw commandError('CONFLICT_LAYER_HAS_MASK',
            `Layer ${layerId} already has a mask. Call deleteLayerMask first.`,
            { layerId })
    }
    // Replicate the core of app._addLayerMask but skip _enterMaskEditMode.
    app._finalizePendingUndo?.()
    const w = app._canvas.width
    const h = app._canvas.height
    const mask = new ImageData(w, h)
    for (let i = 0; i < mask.data.length; i += 4) {
        mask.data[i] = 255
        mask.data[i + 1] = 255
        mask.data[i + 2] = 255
        mask.data[i + 3] = 255
    }
    layer.mask = mask
    layer.maskEnabled = true
    app._renderer?.uploadMaskTexture?.(layerId, mask)
    app._updateLayerStack?.()
    await app._rebuild?.()
    app._markDirty?.()
    app._pushUndoState?.()
    return { result: { layerId } }
}

export async function deleteLayerMask({ layerId }, app) {
    requireMaskedLayer(layerId, app)
    await app._deleteLayerMask(layerId)
    return { result: { layerId } }
}
```

- [ ] **Step 5: Register the commands**

Modify `public/js/agent/index.js`. After the existing `cropToSelection` registration, append:

```js
    registerCommand(LayersAgent, 'addLayerMask', commands.addLayerMask)
    registerCommand(LayersAgent, 'deleteLayerMask', commands.deleteLayerMask)
```

- [ ] **Step 6: Run tests to verify they pass**

```
npx playwright test tests/agent-masks.spec.js --reporter=line
```

Expected: 6/6 PASS.

- [ ] **Step 7: Commit**

```
git add public/js/agent/commands.js public/js/agent/schemas.js public/js/agent/index.js tests/agent-masks.spec.js
git commit -m "feat(agent): addLayerMask and deleteLayerMask commands"
```

---

## Task 2: addMaskFromSelection

**Files:**
- Modify: `public/js/agent/commands.js`, `public/js/agent/schemas.js`, `public/js/agent/index.js`
- Test: extend `tests/agent-masks.spec.js`

Wraps the existing `app._maskFromSelection(layerId)` method, which rasterizes the current selection and uses it as the layer's mask. Requires both an active selection and a layer that doesn't already have a mask.

- [ ] **Step 1: Add failing tests**

Append to `tests/agent-masks.spec.js`:

```js
test.describe('addMaskFromSelection', () => {
    test('uses current selection as the mask', async ({ page }) => {
        await bootApp(page)
        const id = await page.evaluate(() => window.layersApp._layers[0].id)
        await page.evaluate(() =>
            window.LayersAgent.setRectangleSelection({ x: 100, y: 100, width: 200, height: 200 }))
        const env = await page.evaluate((layerId) =>
            window.LayersAgent.addMaskFromSelection({ layerId }), id)
        expect(env.ok).toBe(true)
        const layer = env.state.layers.find(l => l.id === id)
        expect(layer.mask).not.toBeNull()
        // Mask coverage should be roughly the selection rectangle area / canvas area.
        // 200*200 / 1024*1024 ~= 0.038
        expect(layer.mask.coverage).toBeGreaterThan(0)
        expect(layer.mask.coverage).toBeLessThan(0.5)
    })

    test('NO_SELECTION when no selection active', async ({ page }) => {
        await bootApp(page)
        const id = await page.evaluate(() => window.layersApp._layers[0].id)
        const env = await page.evaluate((layerId) =>
            window.LayersAgent.addMaskFromSelection({ layerId }), id)
        expect(env.ok).toBe(false)
        expect(env.error.code).toBe('CONFLICT_NO_SELECTION')
    })

    test('CONFLICT when layer already has a mask', async ({ page }) => {
        await bootApp(page)
        const id = await page.evaluate(() => window.layersApp._layers[0].id)
        await page.evaluate((layerId) =>
            window.LayersAgent.addLayerMask({ layerId }), id)
        await page.evaluate(() =>
            window.LayersAgent.setRectangleSelection({ x: 0, y: 0, width: 10, height: 10 }))
        const env = await page.evaluate((layerId) =>
            window.LayersAgent.addMaskFromSelection({ layerId }), id)
        expect(env.ok).toBe(false)
        expect(env.error.code).toBe('CONFLICT_LAYER_HAS_MASK')
    })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```
npx playwright test tests/agent-masks.spec.js -g "addMaskFromSelection" --reporter=line
```

Expected: FAIL.

- [ ] **Step 3: Add schema**

Modify `public/js/agent/schemas.js`. Append:

```js
    addMaskFromSelection: {
        type: 'object',
        required: ['layerId'],
        properties: { layerId: { type: 'string' } }
    },
```

- [ ] **Step 4: Add handler**

Modify `public/js/agent/commands.js`. Append (after `deleteLayerMask`):

```js
export async function addMaskFromSelection({ layerId }, app) {
    const layer = requireLayer(layerId, app)
    if (layer.mask) {
        throw commandError('CONFLICT_LAYER_HAS_MASK',
            `Layer ${layerId} already has a mask. Call deleteLayerMask first.`,
            { layerId })
    }
    requireSelection(app)   // throws CONFLICT_NO_SELECTION if missing
    await app._maskFromSelection(layerId)
    return { result: { layerId } }
}
```

- [ ] **Step 5: Register the command**

Modify `public/js/agent/index.js`. After `deleteLayerMask`:

```js
    registerCommand(LayersAgent, 'addMaskFromSelection', commands.addMaskFromSelection)
```

- [ ] **Step 6: Run tests to verify they pass**

```
npx playwright test tests/agent-masks.spec.js --reporter=line
```

Expected: 9/9 PASS (6 prior + 3 new).

- [ ] **Step 7: Commit**

```
git add public/js/agent/commands.js public/js/agent/schemas.js public/js/agent/index.js tests/agent-masks.spec.js
git commit -m "feat(agent): addMaskFromSelection command"
```

---

## Task 3: invertLayerMask + setMaskEnabled

**Files:**
- Modify: `public/js/agent/commands.js`, `public/js/agent/schemas.js`, `public/js/agent/index.js`
- Test: extend `tests/agent-masks.spec.js`

`invertLayerMask` delegates to the existing app method. `setMaskEnabled` takes an explicit `enabled` boolean rather than the existing `_toggleMaskEnabled`'s toggle behavior — agents need predictable state-setting, not toggling.

- [ ] **Step 1: Add failing tests**

Append to `tests/agent-masks.spec.js`:

```js
test.describe('invertLayerMask / setMaskEnabled', () => {
    test('invertLayerMask flips mask coverage', async ({ page }) => {
        await bootApp(page)
        const id = await page.evaluate(() => window.layersApp._layers[0].id)
        await page.evaluate((layerId) =>
            window.LayersAgent.addLayerMask({ layerId }), id)  // fully white = coverage 1
        const env = await page.evaluate((layerId) =>
            window.LayersAgent.invertLayerMask({ layerId }), id)
        expect(env.ok).toBe(true)
        const layer = env.state.layers.find(l => l.id === id)
        expect(layer.mask.coverage).toBeCloseTo(0, 1)  // now fully black
    })

    test('invertLayerMask CONFLICT when no mask', async ({ page }) => {
        await bootApp(page)
        const id = await page.evaluate(() => window.layersApp._layers[0].id)
        const env = await page.evaluate((layerId) =>
            window.LayersAgent.invertLayerMask({ layerId }), id)
        expect(env.ok).toBe(false)
        expect(env.error.code).toBe('CONFLICT_NO_MASK')
    })

    test('setMaskEnabled disables and re-enables a mask', async ({ page }) => {
        await bootApp(page)
        const id = await page.evaluate(() => window.layersApp._layers[0].id)
        await page.evaluate((layerId) =>
            window.LayersAgent.addLayerMask({ layerId }), id)

        const off = await page.evaluate((layerId) =>
            window.LayersAgent.setMaskEnabled({ layerId, enabled: false }), id)
        expect(off.ok).toBe(true)
        expect(off.state.layers.find(l => l.id === id).mask.enabled).toBe(false)

        const on = await page.evaluate((layerId) =>
            window.LayersAgent.setMaskEnabled({ layerId, enabled: true }), id)
        expect(on.ok).toBe(true)
        expect(on.state.layers.find(l => l.id === id).mask.enabled).toBe(true)
    })

    test('setMaskEnabled CONFLICT when no mask', async ({ page }) => {
        await bootApp(page)
        const id = await page.evaluate(() => window.layersApp._layers[0].id)
        const env = await page.evaluate((layerId) =>
            window.LayersAgent.setMaskEnabled({ layerId, enabled: false }), id)
        expect(env.ok).toBe(false)
        expect(env.error.code).toBe('CONFLICT_NO_MASK')
    })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```
npx playwright test tests/agent-masks.spec.js -g "invertLayerMask|setMaskEnabled" --reporter=line
```

Expected: FAIL.

- [ ] **Step 3: Add schemas**

Modify `public/js/agent/schemas.js`. Append:

```js
    invertLayerMask: {
        type: 'object',
        required: ['layerId'],
        properties: { layerId: { type: 'string' } }
    },
    setMaskEnabled: {
        type: 'object',
        required: ['layerId', 'enabled'],
        properties: {
            layerId: { type: 'string' },
            enabled: { type: 'boolean' }
        }
    },
```

- [ ] **Step 4: Add handlers**

Modify `public/js/agent/commands.js`. Append:

```js
export async function invertLayerMask({ layerId }, app) {
    requireMaskedLayer(layerId, app)
    await app._invertLayerMask(layerId)
    return { result: { layerId } }
}

export async function setMaskEnabled({ layerId, enabled }, app) {
    const layer = requireMaskedLayer(layerId, app)
    if (layer.maskEnabled === enabled) {
        // No-op: already in requested state.
        return { result: { layerId, enabled } }
    }
    app._finalizePendingUndo?.()
    layer.maskEnabled = enabled
    app._updateLayerStack?.()
    await app._rebuild?.()
    app._markDirty?.()
    app._pushUndoState?.()
    return { result: { layerId, enabled } }
}
```

- [ ] **Step 5: Register the commands**

Modify `public/js/agent/index.js`. After `addMaskFromSelection`:

```js
    registerCommand(LayersAgent, 'invertLayerMask', commands.invertLayerMask)
    registerCommand(LayersAgent, 'setMaskEnabled', commands.setMaskEnabled)
```

- [ ] **Step 6: Run tests to verify they pass**

```
npx playwright test tests/agent-masks.spec.js --reporter=line
```

Expected: 13/13 PASS (9 prior + 4 new).

- [ ] **Step 7: Commit**

```
git add public/js/agent/commands.js public/js/agent/schemas.js public/js/agent/index.js tests/agent-masks.spec.js
git commit -m "feat(agent): invertLayerMask and setMaskEnabled commands"
```

---

## Task 4: featherMask + expandMask + contractMask + smoothMask

**Files:**
- Modify: `public/js/agent/commands.js`, `public/js/agent/schemas.js`, `public/js/agent/index.js`
- Test: extend `tests/agent-masks.spec.js`

The four mask-modify ops. The existing `app._featherLayerMask`/etc. methods open a UI dialog asking for radius — the agent commands replicate the dialog-less core inline, taking `radius` as an arg. The pattern is:
1. Convert mask from RGB-encoded format to selection-format (A=val) via `app._maskToSelectionFormat(mask)`.
2. Apply the selection-modify transform.
3. Convert back to RGB-encoded format via `app._selectionFormatToMask(transformed)`.
4. Upload the new mask texture, rebuild, mark dirty, push undo.

A shared `applyMaskTransform(app, layerId, fn)` helper captures this.

- [ ] **Step 1: Add failing tests**

Append to `tests/agent-masks.spec.js`:

```js
test.describe('mask modify ops', () => {
    test('featherMask runs without error', async ({ page }) => {
        await bootApp(page)
        const id = await page.evaluate(() => window.layersApp._layers[0].id)
        await page.evaluate((layerId) =>
            window.LayersAgent.addLayerMask({ layerId }), id)
        const env = await page.evaluate((layerId) =>
            window.LayersAgent.featherMask({ layerId, radius: 10 }), id)
        expect(env.ok).toBe(true)
        const layer = env.state.layers.find(l => l.id === id)
        expect(layer.mask).not.toBeNull()
    })

    test('expandMask runs without error', async ({ page }) => {
        await bootApp(page)
        const id = await page.evaluate(() => window.layersApp._layers[0].id)
        await page.evaluate((layerId) =>
            window.LayersAgent.addLayerMask({ layerId }), id)
        const env = await page.evaluate((layerId) =>
            window.LayersAgent.expandMask({ layerId, radius: 5 }), id)
        expect(env.ok).toBe(true)
    })

    test('contractMask runs without error', async ({ page }) => {
        await bootApp(page)
        const id = await page.evaluate(() => window.layersApp._layers[0].id)
        await page.evaluate((layerId) =>
            window.LayersAgent.addLayerMask({ layerId }), id)
        const env = await page.evaluate((layerId) =>
            window.LayersAgent.contractMask({ layerId, radius: 5 }), id)
        expect(env.ok).toBe(true)
    })

    test('smoothMask runs without error', async ({ page }) => {
        await bootApp(page)
        const id = await page.evaluate(() => window.layersApp._layers[0].id)
        await page.evaluate((layerId) =>
            window.LayersAgent.addLayerMask({ layerId }), id)
        const env = await page.evaluate((layerId) =>
            window.LayersAgent.smoothMask({ layerId, radius: 5 }), id)
        expect(env.ok).toBe(true)
    })

    test('featherMask CONFLICT_NO_MASK when no mask', async ({ page }) => {
        await bootApp(page)
        const id = await page.evaluate(() => window.layersApp._layers[0].id)
        const env = await page.evaluate((layerId) =>
            window.LayersAgent.featherMask({ layerId, radius: 5 }), id)
        expect(env.ok).toBe(false)
        expect(env.error.code).toBe('CONFLICT_NO_MASK')
    })

    test('expandMask rejects radius out of range', async ({ page }) => {
        await bootApp(page)
        const id = await page.evaluate(() => window.layersApp._layers[0].id)
        await page.evaluate((layerId) =>
            window.LayersAgent.addLayerMask({ layerId }), id)
        const env = await page.evaluate((layerId) =>
            window.LayersAgent.expandMask({ layerId, radius: 0 }), id)
        expect(env.ok).toBe(false)
        expect(env.error.code).toBe('INVALID_ARGS_RANGE')
    })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```
npx playwright test tests/agent-masks.spec.js -g "mask modify ops" --reporter=line
```

Expected: FAIL.

- [ ] **Step 3: Add schemas**

Modify `public/js/agent/schemas.js`. Append:

```js
    featherMask: {
        type: 'object',
        required: ['layerId', 'radius'],
        properties: {
            layerId: { type: 'string' },
            radius: { type: 'integer', min: 1, max: 100 }
        }
    },
    expandMask: {
        type: 'object',
        required: ['layerId', 'radius'],
        properties: {
            layerId: { type: 'string' },
            radius: { type: 'integer', min: 1, max: 100 }
        }
    },
    contractMask: {
        type: 'object',
        required: ['layerId', 'radius'],
        properties: {
            layerId: { type: 'string' },
            radius: { type: 'integer', min: 1, max: 100 }
        }
    },
    smoothMask: {
        type: 'object',
        required: ['layerId', 'radius'],
        properties: {
            layerId: { type: 'string' },
            radius: { type: 'integer', min: 1, max: 100 }
        }
    },
```

- [ ] **Step 4: Add helper + handlers**

Modify `public/js/agent/commands.js`. Append:

```js
/**
 * Apply a selection-modify transform to a layer's mask.
 *
 * Mask storage uses RGB=val/A=255; selection-modify ops expect A=val.
 * The transform helper converts in/out via app._maskToSelectionFormat
 * and app._selectionFormatToMask.
 */
async function applyMaskTransform(app, layerId, fn) {
    const layer = requireMaskedLayer(layerId, app)
    app._finalizePendingUndo?.()
    const converted = app._maskToSelectionFormat(layer.mask)
    layer.mask = app._selectionFormatToMask(fn(converted))
    app._renderer?.uploadMaskTexture?.(layerId, layer.mask)
    if (app._maskEditMode) app._renderMaskOverlay?.(layer)
    await app._rebuild?.()
    app._markDirty?.()
    app._pushUndoState?.()
}

export async function featherMask({ layerId, radius }, app) {
    await applyMaskTransform(app, layerId, (mask) => featherMask_fn(mask, radius))
    return { result: { layerId, radius } }
}

export async function expandMask({ layerId, radius }, app) {
    await applyMaskTransform(app, layerId, (mask) => expandMask_fn(mask, radius))
    return { result: { layerId, radius } }
}

export async function contractMask({ layerId, radius }, app) {
    await applyMaskTransform(app, layerId, (mask) => contractMask_fn(mask, radius))
    return { result: { layerId, radius } }
}

export async function smoothMask({ layerId, radius }, app) {
    await applyMaskTransform(app, layerId, (mask) => smoothMask_fn(mask, radius))
    return { result: { layerId, radius } }
}
```

The `_fn` suffix avoids name collisions with the agent commands. Update the existing selection-modify import to alias the imports:

```js
import {
    invertMask, colorRange,
    expandMask as expandMask_fn,
    contractMask as contractMask_fn,
    featherMask as featherMask_fn,
    smoothMask as smoothMask_fn,
    borderMask
} from '../selection/selection-modify.js'
```

(Replace the existing import line that imports these without aliases. Selection-modify ops in commands.js — `expandSelection`/`contractSelection`/`featherSelection`/`smoothSelection` — also need their references updated to the aliased names.)

- [ ] **Step 5: Update existing selection-modify command references**

In `commands.js`, find the existing handlers and update each to call the aliased name:

- `expandSelection` calls `(mask) => expandMask(mask, pixels)` → change to `(mask) => expandMask_fn(mask, pixels)`
- `contractSelection` calls `(mask) => contractMask(mask, pixels)` → `(mask) => contractMask_fn(mask, pixels)`
- `featherSelection` calls `(mask) => featherMask(mask, pixels)` → `(mask) => featherMask_fn(mask, pixels)`
- `smoothSelection` calls `(mask) => smoothMask(mask, pixels)` → `(mask) => smoothMask_fn(mask, pixels)`
- `borderSelection` keeps `borderMask(mask, pixels)` (no agent command shadowing it)

- [ ] **Step 6: Register the commands**

Modify `public/js/agent/index.js`. After `setMaskEnabled`:

```js
    registerCommand(LayersAgent, 'featherMask', commands.featherMask)
    registerCommand(LayersAgent, 'expandMask', commands.expandMask)
    registerCommand(LayersAgent, 'contractMask', commands.contractMask)
    registerCommand(LayersAgent, 'smoothMask', commands.smoothMask)
```

- [ ] **Step 7: Run tests to verify they pass**

```
npx playwright test tests/agent-masks.spec.js --reporter=line
```

Expected: 19/19 PASS (13 prior + 6 new).

Smoke check selection-modify suite (renamed imports might have broken something):

```
npx playwright test tests/agent-selection-modify.spec.js --reporter=line
```

Expected: 9/9 still pass.

- [ ] **Step 8: Commit**

```
git add public/js/agent/commands.js public/js/agent/schemas.js public/js/agent/index.js tests/agent-masks.spec.js
git commit -m "feat(agent): featherMask, expandMask, contractMask, smoothMask"
```

---

## Task 5: Phase 4-masks verification

**Files:** none — verification only.

- [ ] **Step 1: Run every agent spec**

```
npx playwright test tests/agent-*.spec.js --reporter=line
```

Expected: 136 (Phase 1+2+3+4-selections) + 19 (masks) = 155 tests pass.

- [ ] **Step 2: Run the full Layers suite**

```
npx playwright test --reporter=line
```

Expected: existing non-agent tests still pass (Phase 4-selections shipped a clean run; this should too).

- [ ] **Step 3: Manual smoke**

Boot the dev server:

```
npx http-server public -p 3002 -c-1
```

In a browser:
- App loads.
- Devtools console:
  ```js
  const id = window.layersApp._layers[0].id
  await window.LayersAgent.addLayerMask({ layerId: id })
  await window.LayersAgent.featherMask({ layerId: id, radius: 20 })
  ```
- Layer's mask thumbnail appears in the layer panel; visual change reflects the soft edge.
- `await window.LayersAgent.setMaskEnabled({ layerId: id, enabled: false })` — visible change.
- Existing UI mask context menu still works.

- [ ] **Step 4: Tag the milestone (optional)**

```
git tag agent-phase-4-masks
```

(Local only.)

---

## Out of scope for Phase 4-masks (deferred)

- **Mask edit mode** (`enterMaskEditMode` / `exitMaskEditMode`) — the agent doesn't need it for this phase. Drawing strokes will land in Plan 4-drawing where it makes sense.
- **`borderMask`** — not in the existing app's mask context menu, and arguably not useful per-layer (it's a selection op). If Phase 4-drawing needs it for stroke shapes, it'll surface there.
- **`setMaskVisible`** (toggle mask thumbnail visibility in layer panel) — not core. Defer.
- **Drawing strokes on masks** — Plan 4-drawing.
- **Project CRUD, undo/redo, settings, view, image/canvas resize** — Phase 5.
