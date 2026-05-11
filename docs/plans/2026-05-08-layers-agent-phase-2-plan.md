# Layers Agent — Phase 2 (Core Composition) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the mutating commands an agent needs to compose a Layers project — adding layers (media/effect/drawing/text), deleting/duplicating/reordering/selecting/flattening/rasterizing/flipping them, setting layer props/transforms/effect params, and managing child effects.

**Architecture:** Each command lives in `public/js/agent/commands.js` (or a focused split if/when it grows beyond ~400 lines). Handlers wrap existing app methods (`_handleAddMediaLayer`, `_handleAddEffectLayer`, `_handleAddChildEffect`, `_handleDeleteLayer`, `_handleLayerChange`, `_flattenImage`, `_flattenLayers`, `_rasterizeLayer`, `_duplicateActiveLayer`, `_flipActiveLayer`) so mutations go through the same code paths the human UI uses — same undo/redo behavior, same renderer state, same dirty tracking. Where existing methods take "active layer" implicitly, the agent command sets the active layer first, calls the method, then leaves selection in the new state. New layer IDs are returned in `result.layerId` by sampling `app._layers` after each insert.

**Tech Stack:** Vanilla ES modules. No new runtime dependencies. Playwright for tests.

**Reference spec:** `docs/plans/2026-05-07-layers-agent-instrumentation-design.md`
**Reference Phase 1 plan:** `docs/plans/2026-05-07-layers-agent-phase-1-plan.md`

---

## File structure

**Modify:**
- `public/js/agent/commands.js` — add ~17 mutating handlers + a small set of helpers (`requireLayer`, `requireChildEffect`, `base64ToFile`).
- `public/js/agent/schemas.js` — append schemas for the new commands.
- `public/js/agent/index.js` — register each new command.

**Create (tests):**
- `tests/agent-add-layer.spec.js` — `addLayer` for all four kinds.
- `tests/agent-layer-crud.spec.js` — delete, duplicate, reorder, select, flatten, rasterize, flip.
- `tests/agent-layer-props.spec.js` — setLayerProps, setLayerTransform.
- `tests/agent-effect-params.spec.js` — setLayerEffectParams.
- `tests/agent-child-effects.spec.js` — addChildEffect, removeChildEffect, reorderChildEffect, setChildEffectProps, setChildEffectParams.

The existing `commands.js` keeps growing; if it exceeds ~400 lines, split into `commands/inspection.js` + `commands/composition.js` + `commands/children.js` after Phase 2 lands. Don't pre-split.

---

## Task 1: addLayer — effect kind

**Files:**
- Modify: `public/js/agent/commands.js`, `public/js/agent/schemas.js`, `public/js/agent/index.js`
- Test: `tests/agent-add-layer.spec.js`

- [ ] **Step 1: Write the failing test**

Create `tests/agent-add-layer.spec.js`:

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

test.describe('LayersAgent.addLayer — effect kind', () => {
    test('adds an effect layer and returns its id', async ({ page }) => {
        await bootApp(page)
        const before = await page.evaluate(() => window.layersApp._layers.length)
        const env = await page.evaluate(() =>
            window.LayersAgent.addLayer({ kind: 'effect', effectId: 'synth/gradient' })
        )
        expect(env.ok).toBe(true)
        expect(env.result.layerId).toMatch(/^layer-/)
        const after = await page.evaluate(() => window.layersApp._layers.length)
        expect(after).toBe(before + 1)
        const stateLast = env.state.layers[env.state.layers.length - 1]
        expect(stateLast.id).toBe(env.result.layerId)
        expect(stateLast.sourceType).toBe('effect')
        expect(stateLast.effect.id).toBe('synth/gradient')
    })

    test('addLayer returns NOT_FOUND_EFFECT for unknown effectId', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() =>
            window.LayersAgent.addLayer({ kind: 'effect', effectId: 'filter/totallyMadeUp' })
        )
        expect(env.ok).toBe(false)
        expect(env.error.code).toBe('NOT_FOUND_EFFECT')
    })

    test('addLayer effect with params applies them after creation', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() =>
            window.LayersAgent.addLayer({
                kind: 'effect',
                effectId: 'synth/solid',
                params: { color: [1, 0, 0] }
            })
        )
        expect(env.ok).toBe(true)
        const layer = env.state.layers.find(l => l.id === env.result.layerId)
        expect(layer.effect.params.color).toEqual([1, 0, 0])
    })

    test('addLayer rejects missing required kind', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() => window.LayersAgent.addLayer({}))
        expect(env.ok).toBe(false)
        expect(env.error.code).toBe('INVALID_ARGS_REQUIRED')
        expect(env.error.details.field).toBe('kind')
    })

    test('addLayer rejects unknown kind enum', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() => window.LayersAgent.addLayer({ kind: 'silly' }))
        expect(env.ok).toBe(false)
        expect(env.error.code).toBe('INVALID_ARGS_ENUM')
    })
})
```

- [ ] **Step 2: Run test to verify it fails**

```
npx playwright test tests/agent-add-layer.spec.js --reporter=line
```

Expected: FAIL — `addLayer` not registered.

- [ ] **Step 3: Add the schema**

Modify `public/js/agent/schemas.js`. Append to `SCHEMAS`:

```js
    addLayer: {
        type: 'object',
        required: ['kind'],
        properties: {
            kind: { type: 'string', enum: ['effect', 'drawing', 'media', 'text'] },
            effectId: { type: 'string' },
            params: { type: 'object' },
            name: { type: 'string' },
            text: { type: 'string' },
            mediaType: { type: 'string', enum: ['image', 'video'] },
            source: { type: 'object' }
        }
    },
```

(`source` is intentionally a permissive `object` here — Tasks 3 wires the per-source-kind validation inside the handler.)

- [ ] **Step 4: Add helpers + addLayer handler**

Modify `public/js/agent/commands.js`. Append (after the existing `getJob/waitForJob/cancelJob` exports):

```js
/**
 * Look up a layer by id; throw NOT_FOUND_LAYER if missing.
 * Used by every layerId-taking handler.
 */
function requireLayer(layerId, app) {
    const layer = (app?._layers || []).find(l => l.id === layerId)
    if (!layer) {
        throw commandError('NOT_FOUND_LAYER', `Layer not found: ${layerId}`, { layerId })
    }
    return layer
}

/**
 * Look up a child effect within a layer; throw NOT_FOUND_LAYER if either is missing.
 */
function requireChildEffect(layerId, childId, app) {
    const layer = requireLayer(layerId, app)
    const child = (layer.children || []).find(c => c.id === childId)
    if (!child) {
        throw commandError('NOT_FOUND_LAYER',
            `Child effect not found: ${childId} (in ${layerId})`,
            { layerId, childId })
    }
    return { layer, child }
}

/**
 * Convert a base64-encoded buffer to a File for use with _handleAddMediaLayer.
 */
function base64ToFile(data, mimeType, name) {
    const binary = atob(data)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    return new File([bytes], name || 'media', { type: mimeType || 'application/octet-stream' })
}

export async function addLayer(args, app) {
    const { kind } = args
    if (kind === 'effect') return addEffectLayer(args, app)
    if (kind === 'drawing') return addDrawingLayer(args, app)
    if (kind === 'media') return addMediaLayer(args, app)
    if (kind === 'text') return addTextLayer(args, app)
    // Schema enum guarantees one of the four; this is unreachable.
    throw commandError('INVALID_ARGS_ENUM', `Unknown kind: ${kind}`, { field: 'kind', got: kind })
}

async function addEffectLayer({ effectId, params, name }, app) {
    if (!effectId) {
        throw commandError('INVALID_ARGS_REQUIRED', 'effectId is required for kind=effect',
            { field: 'effectId' })
    }
    // Validate the effectId exists by looking at the manifest. Synth effects are
    // hidden from getAllEffects() but ARE valid for addLayer; check the renderer's
    // raw manifest instead.
    const manifest = app?._renderer?.manifest || {}
    if (!manifest[effectId]) {
        throw commandError('NOT_FOUND_EFFECT', `Effect not found: ${effectId}`, { effectId })
    }
    await app._handleAddEffectLayer(effectId)
    const layer = app._layers[app._layers.length - 1]
    if (name) layer.name = name
    if (params) {
        await app._handleLayerChange({
            layerId: layer.id,
            property: 'effectParams',
            value: { ...layer.effectParams, ...params }
        })
    }
    return { result: { layerId: layer.id } }
}

async function addDrawingLayer(_args, _app) {
    // Implemented in Task 2.
    throw commandError('INTERNAL_ERROR', 'addLayer kind=drawing not yet implemented', {})
}

async function addMediaLayer(_args, _app) {
    // Implemented in Task 3.
    throw commandError('INTERNAL_ERROR', 'addLayer kind=media not yet implemented', {})
}

async function addTextLayer(_args, _app) {
    // Implemented in Task 4.
    throw commandError('INTERNAL_ERROR', 'addLayer kind=text not yet implemented', {})
}
```

- [ ] **Step 5: Register the command**

Modify `public/js/agent/index.js`. After the existing job-stub registrations in `bootstrapAgent`, append:

```js
    registerCommand(LayersAgent, 'addLayer', commands.addLayer)
```

- [ ] **Step 6: Run tests to verify they pass**

```
npx playwright test tests/agent-add-layer.spec.js --reporter=line
```

Expected: 5 tests PASS.

Smoke check the rest:

```
npx playwright test tests/agent-foundation.spec.js tests/agent-validation.spec.js tests/agent-snapshot.spec.js tests/agent-state-commands.spec.js tests/agent-project-commands.spec.js tests/agent-effect-commands.spec.js tests/agent-job-commands.spec.js tests/agent-concurrency.spec.js tests/agent-snapshot-golden.spec.js --reporter=line
```

Expected: 44/44 still pass.

- [ ] **Step 7: Commit**

```
git add public/js/agent/commands.js public/js/agent/schemas.js public/js/agent/index.js tests/agent-add-layer.spec.js
git commit -m "feat(agent): addLayer command with effect kind support"
```

---

## Task 2: addLayer — drawing kind

**Files:**
- Modify: `public/js/agent/commands.js`
- Test: extend `tests/agent-add-layer.spec.js`

- [ ] **Step 1: Add the failing test**

Append to `tests/agent-add-layer.spec.js`:

```js
test.describe('LayersAgent.addLayer — drawing kind', () => {
    test('adds an empty drawing layer', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() =>
            window.LayersAgent.addLayer({ kind: 'drawing' })
        )
        expect(env.ok).toBe(true)
        expect(env.result.layerId).toMatch(/^layer-/)
        const layer = env.state.layers.find(l => l.id === env.result.layerId)
        expect(layer.sourceType).toBe('drawing')
        expect(layer.drawing).toMatchObject({ strokeCount: 0 })
    })

    test('addLayer drawing accepts an optional name', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() =>
            window.LayersAgent.addLayer({ kind: 'drawing', name: 'Sketch 1' })
        )
        expect(env.ok).toBe(true)
        const layer = env.state.layers.find(l => l.id === env.result.layerId)
        expect(layer.name).toBe('Sketch 1')
    })
})
```

- [ ] **Step 2: Run test to verify it fails**

```
npx playwright test tests/agent-add-layer.spec.js -g "drawing kind" --reporter=line
```

Expected: FAIL — `addDrawingLayer` is the stub from Task 1.

- [ ] **Step 3: Implement addDrawingLayer**

Modify `public/js/agent/commands.js`. Add the import at the top of the file alongside the existing imports (e.g. above the existing `import { commandError } from './dispatcher.js'` line):

```js
import { createDrawingLayer } from '../layers/layer-model.js'
```

Replace the `addDrawingLayer` stub with:

```js
async function addDrawingLayer({ name }, app) {
    app._finalizePendingUndo?.()
    const layer = createDrawingLayer(name)
    app._layers.push(layer)
    if (app._layerStack) app._layerStack.selectedLayerId = layer.id
    app._updateLayerStack?.()
    await app._rebuild?.()
    app._markDirty?.()
    app._pushUndoState?.()
    return { result: { layerId: layer.id } }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```
npx playwright test tests/agent-add-layer.spec.js -g "drawing kind" --reporter=line
```

Expected: 2/2 PASS. Re-run the full add-layer spec to confirm Task 1 still passes:

```
npx playwright test tests/agent-add-layer.spec.js --reporter=line
```

Expected: 7/7 PASS.

- [ ] **Step 5: Commit**

```
git add public/js/agent/commands.js tests/agent-add-layer.spec.js
git commit -m "feat(agent): addLayer drawing kind"
```

---

## Task 3: addLayer — media kind

**Files:**
- Modify: `public/js/agent/commands.js`
- Test: extend `tests/agent-add-layer.spec.js`

- [ ] **Step 1: Add the failing tests**

Append to `tests/agent-add-layer.spec.js`:

```js
test.describe('LayersAgent.addLayer — media kind', () => {
    // 1x1 transparent PNG, base64 encoded
    const TINY_PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='

    test('adds a media layer from base64 source', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate((data) =>
            window.LayersAgent.addLayer({
                kind: 'media',
                mediaType: 'image',
                name: 'tiny.png',
                source: { kind: 'base64', data, mimeType: 'image/png' }
            }),
            TINY_PNG_B64
        )
        expect(env.ok).toBe(true)
        expect(env.result.layerId).toMatch(/^layer-/)
        const layer = env.state.layers.find(l => l.id === env.result.layerId)
        expect(layer.sourceType).toBe('media')
        expect(layer.media.type).toBe('image')
        expect(layer.media.filename).toBe('tiny.png')
    })

    test('addLayer media rejects missing source', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() =>
            window.LayersAgent.addLayer({ kind: 'media', mediaType: 'image' })
        )
        expect(env.ok).toBe(false)
        expect(env.error.code).toBe('INVALID_ARGS_REQUIRED')
        expect(env.error.details.field).toBe('source')
    })

    test('addLayer media rejects missing mediaType', async ({ page }, testInfo) => {
        await bootApp(page)
        const env = await page.evaluate((data) =>
            window.LayersAgent.addLayer({
                kind: 'media',
                source: { kind: 'base64', data, mimeType: 'image/png' }
            }),
            'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='
        )
        expect(env.ok).toBe(false)
        expect(env.error.code).toBe('INVALID_ARGS_REQUIRED')
        expect(env.error.details.field).toBe('mediaType')
    })

    test('addLayer media rejects unsupported source.kind', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() =>
            window.LayersAgent.addLayer({
                kind: 'media',
                mediaType: 'image',
                source: { kind: 'unsupported', value: 'whatever' }
            })
        )
        expect(env.ok).toBe(false)
        expect(env.error.code).toBe('INVALID_ARGS_ENUM')
        expect(env.error.details.field).toBe('source.kind')
    })
})
```

- [ ] **Step 2: Run test to verify they fail**

```
npx playwright test tests/agent-add-layer.spec.js -g "media kind" --reporter=line
```

Expected: FAIL — addMediaLayer is the stub.

- [ ] **Step 3: Implement addMediaLayer**

Modify `public/js/agent/commands.js`. Replace the `addMediaLayer` stub with:

```js
async function addMediaLayer({ source, mediaType, name }, app) {
    if (!source) {
        throw commandError('INVALID_ARGS_REQUIRED', 'source is required for kind=media',
            { field: 'source' })
    }
    if (!mediaType) {
        throw commandError('INVALID_ARGS_REQUIRED', 'mediaType is required for kind=media',
            { field: 'mediaType' })
    }
    const file = await sourceToFile(source, name || 'media')
    await app._handleAddMediaLayer(file, mediaType)
    const layer = app._layers[app._layers.length - 1]
    if (name) layer.name = name
    return { result: { layerId: layer.id } }
}

async function sourceToFile(source, defaultName) {
    if (!source || typeof source !== 'object') {
        throw commandError('INVALID_ARGS_TYPE', 'source must be an object',
            { field: 'source', expected: 'object' })
    }
    if (source.kind === 'base64') {
        if (typeof source.data !== 'string') {
            throw commandError('INVALID_ARGS_TYPE', 'source.data must be a base64 string',
                { field: 'source.data', expected: 'string' })
        }
        return base64ToFile(source.data, source.mimeType, defaultName)
    }
    if (source.kind === 'url') {
        if (typeof source.value !== 'string') {
            throw commandError('INVALID_ARGS_TYPE', 'source.value must be a URL string',
                { field: 'source.value', expected: 'string' })
        }
        let response
        try {
            response = await fetch(source.value)
        } catch (err) {
            throw commandError('RESOURCE_DECODE_FAILED',
                `Failed to fetch source URL: ${err.message || err}`,
                { url: source.value })
        }
        if (!response.ok) {
            throw commandError('RESOURCE_DECODE_FAILED',
                `Source URL returned HTTP ${response.status}`,
                { url: source.value, status: response.status })
        }
        const blob = await response.blob()
        return new File([blob], defaultName, { type: blob.type })
    }
    throw commandError('INVALID_ARGS_ENUM',
        `source.kind must be 'base64' or 'url', got '${source.kind}'`,
        { field: 'source.kind', allowed: ['base64', 'url'], got: source.kind })
}
```

- [ ] **Step 4: Run tests to verify they pass**

```
npx playwright test tests/agent-add-layer.spec.js --reporter=line
```

Expected: 11/11 PASS (5 effect + 2 drawing + 4 media).

- [ ] **Step 5: Commit**

```
git add public/js/agent/commands.js tests/agent-add-layer.spec.js
git commit -m "feat(agent): addLayer media kind (base64+url sources)"
```

---

## Task 4: addLayer — text kind

**Files:**
- Modify: `public/js/agent/commands.js`
- Test: extend `tests/agent-add-layer.spec.js`

`text` is sugar for `effect` with `effectId: 'filter/text'` and `text` baked into the params.

- [ ] **Step 1: Add the failing test**

Append to `tests/agent-add-layer.spec.js`:

```js
test.describe('LayersAgent.addLayer — text kind', () => {
    test('adds a text layer with text param set', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() =>
            window.LayersAgent.addLayer({ kind: 'text', text: 'Hello' })
        )
        expect(env.ok).toBe(true)
        const layer = env.state.layers.find(l => l.id === env.result.layerId)
        expect(layer.sourceType).toBe('effect')
        expect(layer.effect.id).toBe('filter/text')
        expect(layer.effect.params.text).toBe('Hello')
    })

    test('addLayer text rejects missing text field', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() =>
            window.LayersAgent.addLayer({ kind: 'text' })
        )
        expect(env.ok).toBe(false)
        expect(env.error.code).toBe('INVALID_ARGS_REQUIRED')
        expect(env.error.details.field).toBe('text')
    })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```
npx playwright test tests/agent-add-layer.spec.js -g "text kind" --reporter=line
```

Expected: FAIL.

- [ ] **Step 3: Implement addTextLayer**

Modify `public/js/agent/commands.js`. Replace the `addTextLayer` stub with:

```js
async function addTextLayer({ text, params, name }, app) {
    if (typeof text !== 'string') {
        throw commandError('INVALID_ARGS_REQUIRED', 'text is required for kind=text',
            { field: 'text' })
    }
    return addEffectLayer({
        effectId: 'filter/text',
        params: { text, ...(params || {}) },
        name
    }, app)
}
```

- [ ] **Step 4: Run tests to verify they pass**

```
npx playwright test tests/agent-add-layer.spec.js --reporter=line
```

Expected: 13/13 PASS.

- [ ] **Step 5: Commit**

```
git add public/js/agent/commands.js tests/agent-add-layer.spec.js
git commit -m "feat(agent): addLayer text kind (filter/text sugar)"
```

---

## Task 5: deleteLayer + duplicateLayer

**Files:**
- Modify: `public/js/agent/commands.js`, `public/js/agent/schemas.js`, `public/js/agent/index.js`
- Test: `tests/agent-layer-crud.spec.js`

- [ ] **Step 1: Write the failing tests**

Create `tests/agent-layer-crud.spec.js`:

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

test.describe('deleteLayer', () => {
    test('removes a layer by id', async ({ page }) => {
        await bootApp(page)
        await page.evaluate(async () => {
            await window.LayersAgent.addLayer({ kind: 'effect', effectId: 'synth/gradient' })
        })
        const before = await page.evaluate(() => window.layersApp._layers.length)
        const targetId = await page.evaluate(() => window.layersApp._layers[1].id)
        const env = await page.evaluate((id) =>
            window.LayersAgent.deleteLayer({ layerId: id }), targetId)
        expect(env.ok).toBe(true)
        const after = await page.evaluate(() => window.layersApp._layers.length)
        expect(after).toBe(before - 1)
        expect(env.state.layers.find(l => l.id === targetId)).toBeUndefined()
    })

    test('deleteLayer returns NOT_FOUND_LAYER for missing id', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() =>
            window.LayersAgent.deleteLayer({ layerId: 'layer-nope' }))
        expect(env.ok).toBe(false)
        expect(env.error.code).toBe('NOT_FOUND_LAYER')
    })
})

test.describe('duplicateLayer', () => {
    test('clones a layer and selects the copy', async ({ page }) => {
        await bootApp(page)
        const targetId = await page.evaluate(() => window.layersApp._layers[0].id)
        const env = await page.evaluate((id) =>
            window.LayersAgent.duplicateLayer({ layerId: id }), targetId)
        expect(env.ok).toBe(true)
        expect(env.result.layerId).toMatch(/^layer-/)
        expect(env.result.layerId).not.toBe(targetId)
        const after = await page.evaluate(() => window.layersApp._layers.length)
        expect(after).toBe(2)
    })

    test('duplicateLayer returns NOT_FOUND_LAYER for missing id', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() =>
            window.LayersAgent.duplicateLayer({ layerId: 'layer-nope' }))
        expect(env.ok).toBe(false)
        expect(env.error.code).toBe('NOT_FOUND_LAYER')
    })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```
npx playwright test tests/agent-layer-crud.spec.js --reporter=line
```

Expected: FAIL.

- [ ] **Step 3: Add schemas**

Modify `public/js/agent/schemas.js`. Append:

```js
    deleteLayer: {
        type: 'object',
        required: ['layerId'],
        properties: { layerId: { type: 'string' } }
    },
    duplicateLayer: {
        type: 'object',
        required: ['layerId'],
        properties: { layerId: { type: 'string' } }
    },
```

- [ ] **Step 4: Add handlers**

Modify `public/js/agent/commands.js`. Append:

```js
export async function deleteLayer({ layerId }, app) {
    requireLayer(layerId, app)
    await app._handleDeleteLayer(layerId)
    return { result: { layerId } }
}

export async function duplicateLayer({ layerId }, app) {
    requireLayer(layerId, app)
    const prevSelected = app._layerStack?.selectedLayerId
    if (app._layerStack) app._layerStack.selectedLayerId = layerId
    const ok = await app._duplicateActiveLayer()
    if (!ok) {
        if (app._layerStack && prevSelected) app._layerStack.selectedLayerId = prevSelected
        throw commandError('CONFLICT_DUPLICATE_FAILED',
            `Could not duplicate layer ${layerId}`, { layerId })
    }
    // _duplicateActiveLayer sets selectedLayerId to the new layer.
    const newId = app._layerStack?.selectedLayerId
    return { result: { layerId: newId } }
}
```

- [ ] **Step 5: Register the commands**

Modify `public/js/agent/index.js`. After `addLayer`:

```js
    registerCommand(LayersAgent, 'deleteLayer', commands.deleteLayer)
    registerCommand(LayersAgent, 'duplicateLayer', commands.duplicateLayer)
```

- [ ] **Step 6: Run tests to verify they pass**

```
npx playwright test tests/agent-layer-crud.spec.js --reporter=line
```

Expected: 4/4 PASS.

- [ ] **Step 7: Commit**

```
git add public/js/agent/commands.js public/js/agent/schemas.js public/js/agent/index.js tests/agent-layer-crud.spec.js
git commit -m "feat(agent): deleteLayer and duplicateLayer commands"
```

---

## Task 6: reorderLayer + selectLayer + selectLayers

**Files:**
- Modify: `public/js/agent/commands.js`, `public/js/agent/schemas.js`, `public/js/agent/index.js`
- Test: extend `tests/agent-layer-crud.spec.js`

- [ ] **Step 1: Add failing tests**

Append to `tests/agent-layer-crud.spec.js`:

```js
test.describe('reorderLayer', () => {
    test('moves a layer to a new index', async ({ page }) => {
        await bootApp(page)
        await page.evaluate(async () => {
            await window.LayersAgent.addLayer({ kind: 'effect', effectId: 'synth/gradient' })
            await window.LayersAgent.addLayer({ kind: 'effect', effectId: 'synth/gradient' })
        })
        const ids = await page.evaluate(() => window.layersApp._layers.map(l => l.id))
        // Move the bottom layer (index 0) to the top (index 2)
        const env = await page.evaluate((id) =>
            window.LayersAgent.reorderLayer({ layerId: id, toIndex: 2 }), ids[0])
        expect(env.ok).toBe(true)
        const after = await page.evaluate(() => window.layersApp._layers.map(l => l.id))
        expect(after).toEqual([ids[1], ids[2], ids[0]])
    })

    test('reorderLayer rejects out-of-range toIndex', async ({ page }) => {
        await bootApp(page)
        const id = await page.evaluate(() => window.layersApp._layers[0].id)
        const env = await page.evaluate((layerId) =>
            window.LayersAgent.reorderLayer({ layerId, toIndex: 99 }), id)
        expect(env.ok).toBe(false)
        expect(env.error.code).toBe('INVALID_ARGS_RANGE')
    })

    test('reorderLayer returns NOT_FOUND_LAYER for missing id', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() =>
            window.LayersAgent.reorderLayer({ layerId: 'layer-nope', toIndex: 0 }))
        expect(env.ok).toBe(false)
        expect(env.error.code).toBe('NOT_FOUND_LAYER')
    })
})

test.describe('selectLayer / selectLayers', () => {
    test('selectLayer sets the active layer', async ({ page }) => {
        await bootApp(page)
        await page.evaluate(async () => {
            await window.LayersAgent.addLayer({ kind: 'effect', effectId: 'synth/gradient' })
        })
        const targetId = await page.evaluate(() => window.layersApp._layers[0].id)
        const env = await page.evaluate((id) =>
            window.LayersAgent.selectLayer({ layerId: id }), targetId)
        expect(env.ok).toBe(true)
        expect(env.state.activeLayerId).toBe(targetId)
        expect(env.state.selectedLayerIds).toEqual([targetId])
    })

    test('selectLayers sets multiple selected', async ({ page }) => {
        await bootApp(page)
        await page.evaluate(async () => {
            await window.LayersAgent.addLayer({ kind: 'effect', effectId: 'synth/gradient' })
        })
        const ids = await page.evaluate(() => window.layersApp._layers.map(l => l.id))
        const env = await page.evaluate((layerIds) =>
            window.LayersAgent.selectLayers({ layerIds }), ids)
        expect(env.ok).toBe(true)
        expect(env.state.selectedLayerIds.sort()).toEqual([...ids].sort())
    })

    test('selectLayer returns NOT_FOUND_LAYER for missing id', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() =>
            window.LayersAgent.selectLayer({ layerId: 'layer-nope' }))
        expect(env.ok).toBe(false)
        expect(env.error.code).toBe('NOT_FOUND_LAYER')
    })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```
npx playwright test tests/agent-layer-crud.spec.js --reporter=line
```

Expected: new tests FAIL.

- [ ] **Step 3: Add schemas**

Modify `public/js/agent/schemas.js`. Append:

```js
    reorderLayer: {
        type: 'object',
        required: ['layerId', 'toIndex'],
        properties: {
            layerId: { type: 'string' },
            toIndex: { type: 'integer', min: 0 }
        }
    },
    selectLayer: {
        type: 'object',
        required: ['layerId'],
        properties: { layerId: { type: 'string' } }
    },
    selectLayers: {
        type: 'object',
        required: ['layerIds'],
        properties: {
            layerIds: { type: 'array', items: { type: 'string' } }
        }
    },
```

- [ ] **Step 4: Add handlers**

Modify `public/js/agent/commands.js`. Append:

```js
export async function reorderLayer({ layerId, toIndex }, app) {
    requireLayer(layerId, app)
    const layers = app._layers
    if (toIndex < 0 || toIndex >= layers.length) {
        throw commandError('INVALID_ARGS_RANGE',
            `toIndex ${toIndex} is out of range (layers.length=${layers.length})`,
            { field: 'toIndex', value: toIndex, min: 0, max: layers.length - 1 })
    }
    app._finalizePendingUndo?.()
    const fromIndex = layers.findIndex(l => l.id === layerId)
    const [moved] = layers.splice(fromIndex, 1)
    layers.splice(toIndex, 0, moved)
    app._updateLayerStack?.()
    await app._rebuild?.()
    app._markDirty?.()
    app._pushUndoState?.()
    return { result: { layerId, toIndex } }
}

export async function selectLayer({ layerId }, app) {
    requireLayer(layerId, app)
    if (app._layerStack) {
        app._layerStack.selectedLayerId = layerId
    }
    return { result: { layerId } }
}

export async function selectLayers({ layerIds }, app) {
    for (const id of layerIds) requireLayer(id, app)
    if (app._layerStack) {
        app._layerStack.selectedLayerIds = [...layerIds]
        if (layerIds.length > 0) app._layerStack.selectedLayerId = layerIds[0]
    }
    return { result: { layerIds } }
}
```

- [ ] **Step 5: Register the commands**

Modify `public/js/agent/index.js`. After `duplicateLayer`:

```js
    registerCommand(LayersAgent, 'reorderLayer', commands.reorderLayer)
    registerCommand(LayersAgent, 'selectLayer', commands.selectLayer)
    registerCommand(LayersAgent, 'selectLayers', commands.selectLayers)
```

- [ ] **Step 6: Run tests to verify they pass**

```
npx playwright test tests/agent-layer-crud.spec.js --reporter=line
```

Expected: 10/10 PASS (4 prior + 6 new).

- [ ] **Step 7: Commit**

```
git add public/js/agent/commands.js public/js/agent/schemas.js public/js/agent/index.js tests/agent-layer-crud.spec.js
git commit -m "feat(agent): reorderLayer, selectLayer, selectLayers commands"
```

---

## Task 7: flattenImage + flattenLayers + rasterizeLayer + flipLayer

**Files:**
- Modify: `public/js/agent/commands.js`, `public/js/agent/schemas.js`, `public/js/agent/index.js`
- Test: extend `tests/agent-layer-crud.spec.js`

- [ ] **Step 1: Add failing tests**

Append to `tests/agent-layer-crud.spec.js`:

```js
test.describe('flatten/rasterize/flip', () => {
    test('flattenImage collapses to one media layer', async ({ page }) => {
        await bootApp(page)
        await page.evaluate(async () => {
            await window.LayersAgent.addLayer({ kind: 'effect', effectId: 'synth/gradient' })
        })
        const before = await page.evaluate(() => window.layersApp._layers.length)
        expect(before).toBe(2)
        const env = await page.evaluate(() => window.LayersAgent.flattenImage())
        expect(env.ok).toBe(true)
        const after = await page.evaluate(() => window.layersApp._layers.length)
        expect(after).toBe(1)
        expect(env.state.layers[0].sourceType).toBe('media')
    })

    test('flattenLayers collapses a subset', async ({ page }) => {
        await bootApp(page)
        await page.evaluate(async () => {
            await window.LayersAgent.addLayer({ kind: 'effect', effectId: 'synth/gradient' })
            await window.LayersAgent.addLayer({ kind: 'effect', effectId: 'synth/gradient' })
        })
        const ids = await page.evaluate(() => window.layersApp._layers.slice(1, 3).map(l => l.id))
        const env = await page.evaluate((layerIds) =>
            window.LayersAgent.flattenLayers({ layerIds }), ids)
        expect(env.ok).toBe(true)
        const after = await page.evaluate(() => window.layersApp._layers.length)
        expect(after).toBe(2)
    })

    test('rasterizeLayer converts effect to media', async ({ page }) => {
        await bootApp(page)
        const id = await page.evaluate(() => window.layersApp._layers[0].id)
        const env = await page.evaluate((layerId) =>
            window.LayersAgent.rasterizeLayer({ layerId }), id)
        expect(env.ok).toBe(true)
        const layer = env.state.layers.find(l => l.sourceType === 'media')
        expect(layer).toBeDefined()
    })

    test('flipLayer toggles flipH', async ({ page }) => {
        await bootApp(page)
        // Need a media layer; rasterize the default solid first.
        const id = await page.evaluate(() => window.layersApp._layers[0].id)
        await page.evaluate((layerId) =>
            window.LayersAgent.rasterizeLayer({ layerId }), id)
        const mediaId = await page.evaluate(() => window.layersApp._layers[0].id)
        const env = await page.evaluate((layerId) =>
            window.LayersAgent.flipLayer({ layerId, axis: 'h' }), mediaId)
        expect(env.ok).toBe(true)
        const layer = env.state.layers.find(l => l.id === mediaId)
        expect(layer.transform.flipH).toBe(true)
    })

    test('rasterizeLayer NOT_FOUND_LAYER for missing id', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() =>
            window.LayersAgent.rasterizeLayer({ layerId: 'layer-nope' }))
        expect(env.ok).toBe(false)
        expect(env.error.code).toBe('NOT_FOUND_LAYER')
    })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```
npx playwright test tests/agent-layer-crud.spec.js -g "flatten/rasterize/flip" --reporter=line
```

Expected: FAIL.

- [ ] **Step 3: Add schemas**

Modify `public/js/agent/schemas.js`. Append:

```js
    flattenImage: null,
    flattenLayers: {
        type: 'object',
        required: ['layerIds'],
        properties: {
            layerIds: { type: 'array', items: { type: 'string' } }
        }
    },
    rasterizeLayer: {
        type: 'object',
        required: ['layerId'],
        properties: { layerId: { type: 'string' } }
    },
    flipLayer: {
        type: 'object',
        required: ['layerId', 'axis'],
        properties: {
            layerId: { type: 'string' },
            axis: { type: 'string', enum: ['h', 'v'] }
        }
    },
```

- [ ] **Step 4: Add handlers**

Modify `public/js/agent/commands.js`. Append:

```js
export async function flattenImage(_args, app) {
    await app._flattenImage()
    return { result: { ok: true } }
}

export async function flattenLayers({ layerIds }, app) {
    for (const id of layerIds) requireLayer(id, app)
    if (layerIds.length < 2) {
        throw commandError('INVALID_ARGS_RANGE',
            'flattenLayers requires at least 2 layerIds',
            { field: 'layerIds', value: layerIds.length, min: 2 })
    }
    await app._flattenLayers(layerIds)
    return { result: { ok: true } }
}

export async function rasterizeLayer({ layerId }, app) {
    requireLayer(layerId, app)
    await app._rasterizeLayer(layerId)
    return { result: { layerId } }
}

export async function flipLayer({ layerId, axis }, app) {
    const layer = requireLayer(layerId, app)
    if (layer.sourceType !== 'media') {
        throw commandError('CONFLICT_TOOL_BLOCKED_FOR_TYPE',
            'flipLayer only supports media layers',
            { layerId, sourceType: layer.sourceType })
    }
    if (app._layerStack) app._layerStack.selectedLayerId = layerId
    app._flipActiveLayer(axis === 'h' ? 'horizontal' : 'vertical')
    return { result: { layerId, axis } }
}
```

- [ ] **Step 5: Register the commands**

Modify `public/js/agent/index.js`. After `selectLayers`:

```js
    registerCommand(LayersAgent, 'flattenImage', commands.flattenImage)
    registerCommand(LayersAgent, 'flattenLayers', commands.flattenLayers)
    registerCommand(LayersAgent, 'rasterizeLayer', commands.rasterizeLayer)
    registerCommand(LayersAgent, 'flipLayer', commands.flipLayer)
```

- [ ] **Step 6: Run tests to verify they pass**

```
npx playwright test tests/agent-layer-crud.spec.js --reporter=line
```

Expected: 15/15 PASS.

- [ ] **Step 7: Commit**

```
git add public/js/agent/commands.js public/js/agent/schemas.js public/js/agent/index.js tests/agent-layer-crud.spec.js
git commit -m "feat(agent): flattenImage, flattenLayers, rasterizeLayer, flipLayer"
```

---

## Task 8: setLayerProps

**Files:**
- Modify: `public/js/agent/commands.js`, `public/js/agent/schemas.js`, `public/js/agent/index.js`
- Test: `tests/agent-layer-props.spec.js`

- [ ] **Step 1: Write the failing tests**

Create `tests/agent-layer-props.spec.js`:

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

test.describe('setLayerProps', () => {
    test('updates opacity', async ({ page }) => {
        await bootApp(page)
        const id = await page.evaluate(() => window.layersApp._layers[0].id)
        const env = await page.evaluate((layerId) =>
            window.LayersAgent.setLayerProps({ layerId, props: { opacity: 50 } }), id)
        expect(env.ok).toBe(true)
        const layer = env.state.layers.find(l => l.id === id)
        expect(layer.opacity).toBe(50)
    })

    test('updates visibility', async ({ page }) => {
        await bootApp(page)
        const id = await page.evaluate(() => window.layersApp._layers[0].id)
        const env = await page.evaluate((layerId) =>
            window.LayersAgent.setLayerProps({ layerId, props: { visible: false } }), id)
        expect(env.ok).toBe(true)
        const layer = env.state.layers.find(l => l.id === id)
        expect(layer.visible).toBe(false)
    })

    test('updates name and locked together', async ({ page }) => {
        await bootApp(page)
        const id = await page.evaluate(() => window.layersApp._layers[0].id)
        const env = await page.evaluate((layerId) =>
            window.LayersAgent.setLayerProps({ layerId, props: { name: 'Renamed', locked: true } }), id)
        expect(env.ok).toBe(true)
        const layer = env.state.layers.find(l => l.id === id)
        expect(layer.name).toBe('Renamed')
        expect(layer.locked).toBe(true)
    })

    test('rejects opacity out of range', async ({ page }) => {
        await bootApp(page)
        const id = await page.evaluate(() => window.layersApp._layers[0].id)
        const env = await page.evaluate((layerId) =>
            window.LayersAgent.setLayerProps({ layerId, props: { opacity: 250 } }), id)
        expect(env.ok).toBe(false)
        expect(env.error.code).toBe('INVALID_ARGS_RANGE')
    })

    test('returns NOT_FOUND_LAYER for missing id', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() =>
            window.LayersAgent.setLayerProps({ layerId: 'layer-nope', props: { opacity: 50 } }))
        expect(env.ok).toBe(false)
        expect(env.error.code).toBe('NOT_FOUND_LAYER')
    })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```
npx playwright test tests/agent-layer-props.spec.js --reporter=line
```

Expected: FAIL.

- [ ] **Step 3: Add schema**

Modify `public/js/agent/schemas.js`. Append:

```js
    setLayerProps: {
        type: 'object',
        required: ['layerId', 'props'],
        properties: {
            layerId: { type: 'string' },
            props: {
                type: 'object',
                properties: {
                    name: { type: 'string' },
                    visible: { type: 'boolean' },
                    opacity: { type: 'number', min: 0, max: 100 },
                    blendMode: { type: 'string' },
                    locked: { type: 'boolean' }
                }
            }
        }
    },
```

- [ ] **Step 4: Add handler**

Modify `public/js/agent/commands.js`. Append:

```js
const SET_LAYER_PROPS_FIELDS = ['name', 'visible', 'opacity', 'blendMode', 'locked']

export async function setLayerProps({ layerId, props }, app) {
    const layer = requireLayer(layerId, app)
    for (const field of SET_LAYER_PROPS_FIELDS) {
        if (props[field] === undefined) continue
        if (field === 'visible') {
            // The UI emits 'visibility' as the property name on layer-change
            // events but the actual layer field is `visible`. _handleLayerChange's
            // unconditional layer[property] = value assignment would write to a
            // dead `layer.visibility` field, so we mutate `visible` ourselves
            // first, then call through for the side effects (rebuild, undo push).
            layer.visible = props[field]
            await app._handleLayerChange({
                layerId,
                property: 'visibility',
                value: props[field]
            })
        } else {
            await app._handleLayerChange({
                layerId,
                property: field,
                value: props[field]
            })
        }
    }
    if (app._updateLayerStack) app._updateLayerStack()
    return { result: { layerId } }
}
```

- [ ] **Step 5: Register the command**

Modify `public/js/agent/index.js`. After `flipLayer`:

```js
    registerCommand(LayersAgent, 'setLayerProps', commands.setLayerProps)
```

- [ ] **Step 6: Run tests to verify they pass**

```
npx playwright test tests/agent-layer-props.spec.js --reporter=line
```

Expected: 5/5 PASS.

- [ ] **Step 7: Commit**

```
git add public/js/agent/commands.js public/js/agent/schemas.js public/js/agent/index.js tests/agent-layer-props.spec.js
git commit -m "feat(agent): setLayerProps command"
```

---

## Task 9: setLayerTransform

**Files:**
- Modify: `public/js/agent/commands.js`, `public/js/agent/schemas.js`, `public/js/agent/index.js`
- Test: extend `tests/agent-layer-props.spec.js`

- [ ] **Step 1: Add failing tests**

Append to `tests/agent-layer-props.spec.js`:

```js
test.describe('setLayerTransform', () => {
    test('updates offset, scale, rotation, flip', async ({ page }) => {
        await bootApp(page)
        // Convert solid to media so transforms apply.
        const initialId = await page.evaluate(() => window.layersApp._layers[0].id)
        await page.evaluate((id) =>
            window.LayersAgent.rasterizeLayer({ layerId: id }), initialId)
        const id = await page.evaluate(() => window.layersApp._layers[0].id)
        const env = await page.evaluate((layerId) =>
            window.LayersAgent.setLayerTransform({
                layerId,
                transform: {
                    offsetX: 10, offsetY: 20,
                    scaleX: 1.5, scaleY: 2,
                    rotation: 30,
                    flipH: true, flipV: false
                }
            }), id)
        expect(env.ok).toBe(true)
        const layer = env.state.layers.find(l => l.id === id)
        expect(layer.transform).toMatchObject({
            offsetX: 10, offsetY: 20,
            scaleX: 1.5, scaleY: 2,
            rotation: 30,
            flipH: true, flipV: false
        })
    })

    test('partial transform updates leave unspecified fields alone', async ({ page }) => {
        await bootApp(page)
        const id = await page.evaluate(() => window.layersApp._layers[0].id)
        await page.evaluate((layerId) =>
            window.LayersAgent.rasterizeLayer({ layerId }), id)
        const mediaId = await page.evaluate(() => window.layersApp._layers[0].id)
        const env = await page.evaluate((layerId) =>
            window.LayersAgent.setLayerTransform({ layerId, transform: { offsetX: 5 } }), mediaId)
        expect(env.ok).toBe(true)
        const layer = env.state.layers.find(l => l.id === mediaId)
        expect(layer.transform.offsetX).toBe(5)
        expect(layer.transform.offsetY).toBe(0)
        expect(layer.transform.scaleX).toBe(1)
    })

    test('NOT_FOUND_LAYER for missing id', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() =>
            window.LayersAgent.setLayerTransform({ layerId: 'layer-nope', transform: { offsetX: 0 } }))
        expect(env.ok).toBe(false)
        expect(env.error.code).toBe('NOT_FOUND_LAYER')
    })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```
npx playwright test tests/agent-layer-props.spec.js -g "setLayerTransform" --reporter=line
```

Expected: FAIL.

- [ ] **Step 3: Add schema**

Modify `public/js/agent/schemas.js`. Append:

```js
    setLayerTransform: {
        type: 'object',
        required: ['layerId', 'transform'],
        properties: {
            layerId: { type: 'string' },
            transform: {
                type: 'object',
                properties: {
                    offsetX: { type: 'number' },
                    offsetY: { type: 'number' },
                    scaleX: { type: 'number', min: 0.01, max: 100 },
                    scaleY: { type: 'number', min: 0.01, max: 100 },
                    rotation: { type: 'number' },
                    flipH: { type: 'boolean' },
                    flipV: { type: 'boolean' }
                }
            }
        }
    },
```

- [ ] **Step 4: Add handler**

Modify `public/js/agent/commands.js`. Append:

```js
const TRANSFORM_FIELDS = ['offsetX', 'offsetY', 'scaleX', 'scaleY', 'rotation', 'flipH', 'flipV']

export async function setLayerTransform({ layerId, transform }, app) {
    const layer = requireLayer(layerId, app)
    let touched = false
    for (const field of TRANSFORM_FIELDS) {
        if (transform[field] === undefined) continue
        layer[field] = transform[field]
        touched = true
    }
    if (touched) {
        if (app._updateTransformRender) {
            app._updateTransformRender(layer)
        } else {
            await app._rebuild?.()
        }
        app._markDirty?.()
        app._pushUndoStateDebounced?.()
    }
    return { result: { layerId } }
}
```

- [ ] **Step 5: Register the command**

Modify `public/js/agent/index.js`. After `setLayerProps`:

```js
    registerCommand(LayersAgent, 'setLayerTransform', commands.setLayerTransform)
```

- [ ] **Step 6: Run tests to verify they pass**

```
npx playwright test tests/agent-layer-props.spec.js --reporter=line
```

Expected: 8/8 PASS (5 prior + 3 new).

- [ ] **Step 7: Commit**

```
git add public/js/agent/commands.js public/js/agent/schemas.js public/js/agent/index.js tests/agent-layer-props.spec.js
git commit -m "feat(agent): setLayerTransform command"
```

---

## Task 10: setLayerEffectParams

**Files:**
- Modify: `public/js/agent/commands.js`, `public/js/agent/schemas.js`, `public/js/agent/index.js`
- Test: `tests/agent-effect-params.spec.js`

- [ ] **Step 1: Write the failing tests**

Create `tests/agent-effect-params.spec.js`:

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

test.describe('setLayerEffectParams', () => {
    test('merges new params with existing ones by default', async ({ page }) => {
        await bootApp(page)
        const id = await page.evaluate(() => window.layersApp._layers[0].id)
        // Default solid layer has effectParams.color
        const env = await page.evaluate((layerId) =>
            window.LayersAgent.setLayerEffectParams({
                layerId,
                params: { color: [1, 0, 0] }
            }), id)
        expect(env.ok).toBe(true)
        const layer = env.state.layers.find(l => l.id === id)
        expect(layer.effect.params.color).toEqual([1, 0, 0])
    })

    test('replace mode discards prior params', async ({ page }) => {
        await bootApp(page)
        const id = await page.evaluate(() => window.layersApp._layers[0].id)
        // First set extra param
        await page.evaluate((layerId) =>
            window.LayersAgent.setLayerEffectParams({
                layerId,
                params: { color: [0, 1, 0], extra: 'kept' }
            }), id)
        // Now replace with a single color
        const env = await page.evaluate((layerId) =>
            window.LayersAgent.setLayerEffectParams({
                layerId,
                params: { color: [0, 0, 1] },
                replace: true
            }), id)
        expect(env.ok).toBe(true)
        const layer = env.state.layers.find(l => l.id === id)
        expect(layer.effect.params).toEqual({ color: [0, 0, 1] })
    })

    test('CONFLICT for non-effect layer', async ({ page }) => {
        await bootApp(page)
        // Create a drawing layer; it's not an effect layer.
        const drawingId = await page.evaluate(async () => {
            const env = await window.LayersAgent.addLayer({ kind: 'drawing' })
            return env.result.layerId
        })
        const env = await page.evaluate((layerId) =>
            window.LayersAgent.setLayerEffectParams({ layerId, params: { foo: 1 } }), drawingId)
        expect(env.ok).toBe(false)
        expect(env.error.code).toBe('CONFLICT_NOT_EFFECT_LAYER')
    })

    test('NOT_FOUND_LAYER for missing id', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() =>
            window.LayersAgent.setLayerEffectParams({ layerId: 'layer-nope', params: {} }))
        expect(env.ok).toBe(false)
        expect(env.error.code).toBe('NOT_FOUND_LAYER')
    })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```
npx playwright test tests/agent-effect-params.spec.js --reporter=line
```

Expected: FAIL.

- [ ] **Step 3: Add schema**

Modify `public/js/agent/schemas.js`. Append:

```js
    setLayerEffectParams: {
        type: 'object',
        required: ['layerId', 'params'],
        properties: {
            layerId: { type: 'string' },
            params: { type: 'object' },
            replace: { type: 'boolean' }
        }
    },
```

- [ ] **Step 4: Add handler**

Modify `public/js/agent/commands.js`. Append:

```js
export async function setLayerEffectParams({ layerId, params, replace }, app) {
    const layer = requireLayer(layerId, app)
    if (layer.sourceType !== 'effect') {
        throw commandError('CONFLICT_NOT_EFFECT_LAYER',
            `Layer ${layerId} is not an effect layer (sourceType=${layer.sourceType})`,
            { layerId, sourceType: layer.sourceType })
    }
    const next = replace ? { ...params } : { ...layer.effectParams, ...params }
    await app._handleLayerChange({
        layerId,
        property: 'effectParams',
        value: next
    })
    return { result: { layerId, params: next } }
}
```

- [ ] **Step 5: Register the command**

Modify `public/js/agent/index.js`. After `setLayerTransform`:

```js
    registerCommand(LayersAgent, 'setLayerEffectParams', commands.setLayerEffectParams)
```

- [ ] **Step 6: Run tests to verify they pass**

```
npx playwright test tests/agent-effect-params.spec.js --reporter=line
```

Expected: 4/4 PASS.

- [ ] **Step 7: Commit**

```
git add public/js/agent/commands.js public/js/agent/schemas.js public/js/agent/index.js tests/agent-effect-params.spec.js
git commit -m "feat(agent): setLayerEffectParams command"
```

---

## Task 11: addChildEffect + removeChildEffect

**Files:**
- Modify: `public/js/agent/commands.js`, `public/js/agent/schemas.js`, `public/js/agent/index.js`
- Test: `tests/agent-child-effects.spec.js`

- [ ] **Step 1: Write the failing tests**

Create `tests/agent-child-effects.spec.js`:

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

test.describe('addChildEffect / removeChildEffect', () => {
    test('addChildEffect attaches an effect under a layer', async ({ page }) => {
        await bootApp(page)
        const id = await page.evaluate(() => window.layersApp._layers[0].id)
        const env = await page.evaluate((layerId) =>
            window.LayersAgent.addChildEffect({ layerId, effectId: 'filter/blur' }), id)
        expect(env.ok).toBe(true)
        expect(env.result.childId).toMatch(/^layer-/)
        const layer = env.state.layers.find(l => l.id === id)
        expect(layer.children.length).toBe(1)
        expect(layer.children[0].effectId).toBe('filter/blur')
    })

    test('addChildEffect rejects unknown effectId', async ({ page }) => {
        await bootApp(page)
        const id = await page.evaluate(() => window.layersApp._layers[0].id)
        const env = await page.evaluate((layerId) =>
            window.LayersAgent.addChildEffect({ layerId, effectId: 'filter/totallyMadeUp' }), id)
        expect(env.ok).toBe(false)
        expect(env.error.code).toBe('NOT_FOUND_EFFECT')
    })

    test('removeChildEffect detaches a child', async ({ page }) => {
        await bootApp(page)
        const setup = await page.evaluate(async () => {
            const layerId = window.layersApp._layers[0].id
            const env = await window.LayersAgent.addChildEffect({ layerId, effectId: 'filter/blur' })
            return { layerId, childId: env.result.childId }
        })
        const env = await page.evaluate((s) =>
            window.LayersAgent.removeChildEffect({ layerId: s.layerId, childId: s.childId }), setup)
        expect(env.ok).toBe(true)
        const layer = env.state.layers.find(l => l.id === setup.layerId)
        expect(layer.children.length).toBe(0)
    })

    test('removeChildEffect NOT_FOUND for missing child', async ({ page }) => {
        await bootApp(page)
        const id = await page.evaluate(() => window.layersApp._layers[0].id)
        const env = await page.evaluate((layerId) =>
            window.LayersAgent.removeChildEffect({ layerId, childId: 'layer-nope' }), id)
        expect(env.ok).toBe(false)
        expect(env.error.code).toBe('NOT_FOUND_LAYER')
    })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```
npx playwright test tests/agent-child-effects.spec.js --reporter=line
```

Expected: FAIL.

- [ ] **Step 3: Add schemas**

Modify `public/js/agent/schemas.js`. Append:

```js
    addChildEffect: {
        type: 'object',
        required: ['layerId', 'effectId'],
        properties: {
            layerId: { type: 'string' },
            effectId: { type: 'string' },
            params: { type: 'object' }
        }
    },
    removeChildEffect: {
        type: 'object',
        required: ['layerId', 'childId'],
        properties: {
            layerId: { type: 'string' },
            childId: { type: 'string' }
        }
    },
```

- [ ] **Step 4: Add handlers**

Modify `public/js/agent/commands.js`. Append:

```js
export async function addChildEffect({ layerId, effectId, params }, app) {
    const layer = requireLayer(layerId, app)
    const manifest = app?._renderer?.manifest || {}
    if (!manifest[effectId]) {
        throw commandError('NOT_FOUND_EFFECT', `Effect not found: ${effectId}`, { effectId })
    }
    await app._handleAddChildEffect(layerId, effectId)
    const newChild = layer.children[layer.children.length - 1]
    if (params) {
        await app._handleLayerChange({
            layerId: newChild.id,
            parentLayerId: layerId,
            property: 'effectParams',
            value: { ...newChild.effectParams, ...params }
        })
    }
    return { result: { childId: newChild.id } }
}

export async function removeChildEffect({ layerId, childId }, app) {
    const { layer } = requireChildEffect(layerId, childId, app)
    await app._handleDeleteLayer(childId, layerId)
    return { result: { childId } }
}
```

- [ ] **Step 5: Register the commands**

Modify `public/js/agent/index.js`. After `setLayerEffectParams`:

```js
    registerCommand(LayersAgent, 'addChildEffect', commands.addChildEffect)
    registerCommand(LayersAgent, 'removeChildEffect', commands.removeChildEffect)
```

- [ ] **Step 6: Run tests to verify they pass**

```
npx playwright test tests/agent-child-effects.spec.js --reporter=line
```

Expected: 4/4 PASS.

- [ ] **Step 7: Commit**

```
git add public/js/agent/commands.js public/js/agent/schemas.js public/js/agent/index.js tests/agent-child-effects.spec.js
git commit -m "feat(agent): addChildEffect, removeChildEffect commands"
```

---

## Task 12: reorderChildEffect + setChildEffectProps + setChildEffectParams

**Files:**
- Modify: `public/js/agent/commands.js`, `public/js/agent/schemas.js`, `public/js/agent/index.js`
- Test: extend `tests/agent-child-effects.spec.js`

- [ ] **Step 1: Add failing tests**

Append to `tests/agent-child-effects.spec.js`:

```js
test.describe('reorderChildEffect / setChildEffectProps / setChildEffectParams', () => {
    test('reorderChildEffect moves child to new index', async ({ page }) => {
        await bootApp(page)
        const setup = await page.evaluate(async () => {
            const layerId = window.layersApp._layers[0].id
            const c1 = await window.LayersAgent.addChildEffect({ layerId, effectId: 'filter/blur' })
            const c2 = await window.LayersAgent.addChildEffect({ layerId, effectId: 'filter/grain' })
            return { layerId, first: c1.result.childId, second: c2.result.childId }
        })
        const env = await page.evaluate((s) =>
            window.LayersAgent.reorderChildEffect({
                layerId: s.layerId, childId: s.second, toIndex: 0
            }), setup)
        expect(env.ok).toBe(true)
        const layer = env.state.layers.find(l => l.id === setup.layerId)
        expect(layer.children[0].id).toBe(setup.second)
        expect(layer.children[1].id).toBe(setup.first)
    })

    test('setChildEffectProps toggles visibility', async ({ page }) => {
        await bootApp(page)
        const setup = await page.evaluate(async () => {
            const layerId = window.layersApp._layers[0].id
            const c = await window.LayersAgent.addChildEffect({ layerId, effectId: 'filter/blur' })
            return { layerId, childId: c.result.childId }
        })
        const env = await page.evaluate((s) =>
            window.LayersAgent.setChildEffectProps({
                layerId: s.layerId, childId: s.childId, props: { visible: false, name: 'Renamed' }
            }), setup)
        expect(env.ok).toBe(true)
        const layer = env.state.layers.find(l => l.id === setup.layerId)
        const child = layer.children.find(c => c.id === setup.childId)
        expect(child.visible).toBe(false)
        expect(child.name).toBe('Renamed')
    })

    test('setChildEffectParams merges by default', async ({ page }) => {
        await bootApp(page)
        const setup = await page.evaluate(async () => {
            const layerId = window.layersApp._layers[0].id
            const c = await window.LayersAgent.addChildEffect({ layerId, effectId: 'filter/blur' })
            return { layerId, childId: c.result.childId }
        })
        const env = await page.evaluate((s) =>
            window.LayersAgent.setChildEffectParams({
                layerId: s.layerId, childId: s.childId, params: { radiusX: 10 }
            }), setup)
        expect(env.ok).toBe(true)
        const layer = env.state.layers.find(l => l.id === setup.layerId)
        const child = layer.children.find(c => c.id === setup.childId)
        expect(child.params.radiusX).toBe(10)
    })

    test('reorderChildEffect rejects out-of-range toIndex', async ({ page }) => {
        await bootApp(page)
        const setup = await page.evaluate(async () => {
            const layerId = window.layersApp._layers[0].id
            const c = await window.LayersAgent.addChildEffect({ layerId, effectId: 'filter/blur' })
            return { layerId, childId: c.result.childId }
        })
        const env = await page.evaluate((s) =>
            window.LayersAgent.reorderChildEffect({
                layerId: s.layerId, childId: s.childId, toIndex: 99
            }), setup)
        expect(env.ok).toBe(false)
        expect(env.error.code).toBe('INVALID_ARGS_RANGE')
    })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```
npx playwright test tests/agent-child-effects.spec.js -g "reorderChildEffect" --reporter=line
```

Expected: FAIL.

- [ ] **Step 3: Add schemas**

Modify `public/js/agent/schemas.js`. Append:

```js
    reorderChildEffect: {
        type: 'object',
        required: ['layerId', 'childId', 'toIndex'],
        properties: {
            layerId: { type: 'string' },
            childId: { type: 'string' },
            toIndex: { type: 'integer', min: 0 }
        }
    },
    setChildEffectProps: {
        type: 'object',
        required: ['layerId', 'childId', 'props'],
        properties: {
            layerId: { type: 'string' },
            childId: { type: 'string' },
            props: {
                type: 'object',
                properties: {
                    visible: { type: 'boolean' },
                    name: { type: 'string' }
                }
            }
        }
    },
    setChildEffectParams: {
        type: 'object',
        required: ['layerId', 'childId', 'params'],
        properties: {
            layerId: { type: 'string' },
            childId: { type: 'string' },
            params: { type: 'object' },
            replace: { type: 'boolean' }
        }
    },
```

- [ ] **Step 4: Add handlers**

Modify `public/js/agent/commands.js`. Append:

```js
export async function reorderChildEffect({ layerId, childId, toIndex }, app) {
    const { layer } = requireChildEffect(layerId, childId, app)
    const children = layer.children
    if (toIndex < 0 || toIndex >= children.length) {
        throw commandError('INVALID_ARGS_RANGE',
            `toIndex ${toIndex} is out of range (children.length=${children.length})`,
            { field: 'toIndex', value: toIndex, min: 0, max: children.length - 1 })
    }
    app._finalizePendingUndo?.()
    const fromIndex = children.findIndex(c => c.id === childId)
    const [moved] = children.splice(fromIndex, 1)
    children.splice(toIndex, 0, moved)
    app._updateLayerStack?.()
    await app._rebuild?.()
    app._markDirty?.()
    app._pushUndoState?.()
    return { result: { layerId, childId, toIndex } }
}

export async function setChildEffectProps({ layerId, childId, props }, app) {
    const { child } = requireChildEffect(layerId, childId, app)
    if (props.visible !== undefined) {
        // Same `visibility`-vs-`visible` rename issue as setLayerProps:
        // mutate the actual field, then call through for rebuild/undo.
        child.visible = props.visible
        await app._handleLayerChange({
            layerId: childId,
            parentLayerId: layerId,
            property: 'visibility',
            value: props.visible
        })
    }
    if (props.name !== undefined) {
        child.name = props.name
        app._updateLayerStack?.()
        app._markDirty?.()
    }
    return { result: { layerId, childId } }
}

export async function setChildEffectParams({ layerId, childId, params, replace }, app) {
    const { child } = requireChildEffect(layerId, childId, app)
    const next = replace ? { ...params } : { ...child.effectParams, ...params }
    await app._handleLayerChange({
        layerId: childId,
        parentLayerId: layerId,
        property: 'effectParams',
        value: next
    })
    return { result: { layerId, childId, params: next } }
}
```

- [ ] **Step 5: Register the commands**

Modify `public/js/agent/index.js`. After `removeChildEffect`:

```js
    registerCommand(LayersAgent, 'reorderChildEffect', commands.reorderChildEffect)
    registerCommand(LayersAgent, 'setChildEffectProps', commands.setChildEffectProps)
    registerCommand(LayersAgent, 'setChildEffectParams', commands.setChildEffectParams)
```

- [ ] **Step 6: Run tests to verify they pass**

```
npx playwright test tests/agent-child-effects.spec.js --reporter=line
```

Expected: 8/8 PASS (4 prior + 4 new).

- [ ] **Step 7: Commit**

```
git add public/js/agent/commands.js public/js/agent/schemas.js public/js/agent/index.js tests/agent-child-effects.spec.js
git commit -m "feat(agent): reorderChildEffect, setChildEffectProps, setChildEffectParams"
```

---

## Task 13: Phase 2 verification — full suite + golden refresh

**Files:** none — verification only, plus a golden file refresh if expected.

- [ ] **Step 1: Run every agent spec**

```
npx playwright test tests/agent-*.spec.js --reporter=line
```

Expected: every test PASSES. New count: 44 (Phase 1) + 5 (T1) + 2 (T2) + 4 (T3) + 2 (T4) + 4 (T5) + 6 (T6) + 5 (T7) + 5 (T8) + 3 (T9) + 4 (T10) + 4 (T11) + 4 (T12) = 92. If counts diverge, investigate.

- [ ] **Step 2: Run the full Layers suite to verify no regressions**

```
npx playwright test --reporter=line
```

Expected: all existing non-agent tests still pass. There are known parallel-execution flakes (`clone-tool.spec.js`, `drag-reorder.spec.js`) that pass in isolation; if those are the only failures, run them in isolation to confirm and proceed. Any other failure must be root-caused before Phase 2 ships.

- [ ] **Step 3: Refresh the snapshot golden if Phase 2 changed the snapshot shape**

Phase 2 doesn't add fields to the snapshot, but if the verification reveals a regression here:

```
UPDATE_GOLDEN=1 npx playwright test tests/agent-snapshot-golden.spec.js --reporter=line
```

Inspect the diff before committing; only commit if the change is intentional.

- [ ] **Step 4: Manual smoke**

Boot the dev server and confirm Layers behaves identically to before:

```
npx http-server public -p 3002 -c-1
```

In a browser:
- App loads and renders normally.
- Add/delete/reorder/duplicate via UI works as before.
- In devtools console, `await window.LayersAgent.addLayer({ kind: 'effect', effectId: 'synth/gradient' })` returns an `ok` envelope and the new layer appears in the layer panel.
- Undo (Cmd+Z) reverses the agent-added layer.

- [ ] **Step 5: Tag the milestone (optional)**

```
git tag agent-phase-2
```

(Tag stays local; do not push without explicit approval.)

---

## Out of scope for Phase 2 (deferred to later plans)

- Image export / `getCanvasImageBytes` / thumbnails / `pasteImageFromBytes` — Phase 3.
- Selection set/modify, drawing strokes, masks-CRUD — Phase 4.
- Project CRUD (`newProject`, `openProject`, `saveProject`, `deleteProject`), undo/redo control, settings mutation, view controls — Phase 5.
- Long-running ops + video export — Phase 6.
- The `layers-mcp` sidecar — Phase 7.
- Agent-driven evals — Phase 8.
