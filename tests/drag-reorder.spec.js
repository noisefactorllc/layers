import { test, expect } from './fixtures.js'
import { appReady, appState } from './waits.js'
import { reopenNewProjectDialog } from './helpers/new-project.js'

async function createTransparentProject(page) {
    await reopenNewProjectDialog(page)
    await page.click('.media-option[data-type="transparent"]')
    await page.waitForSelector('.canvas-size-dialog', { timeout: 5000 })
    // Reorder geometry is independent of the rendered image size.
    await page.fill('#canvas-width', '128')
    await page.fill('#canvas-height', '128')
    await page.click('.canvas-size-dialog .action-btn.primary')
    await page.waitForSelector('.open-dialog-backdrop.visible', { state: 'hidden', timeout: 5000 })
    await appReady(page)
}

async function addEffectLayer(page, searchTerm) {
    // The agent path skips the add-layer dialog round-trip; reorder semantics
    // are structural and identical for any effect layer, and the dialog flow
    // is covered by other specs.
    await page.evaluate(async (term) => {
        const env = await window.LayersAgent.addLayer({ kind: 'effect', effectId: `filter/${term}` })
        if (!env.ok) throw new Error(`addLayer failed: ${JSON.stringify(env.error)}`)
    }, searchTerm)
    // The picker closes before shader compilation commits the new layer.
    await page.evaluate(async () => { await window.layersApp._projectLifecycleTail })
}

test.describe('Layer drag reorder', () => {
    test('dragging layer by handle reorders layers', async ({ page }) => {
        await page.goto('/', { waitUntil: 'networkidle' })
        await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })
        await createTransparentProject(page)

        await addEffectLayer(page, 'blur')
        await addEffectLayer(page, 'warp')

        // Should have 3 layers: base (transparent), blur, warp
        const layers = page.locator('layer-item')
        await expect(layers).toHaveCount(3)

        const layerNames = page.locator('layer-item .layer-name')
        const names = await layerNames.allTextContents()
        console.log('Before drag - layers:', names)

        const topLayer = layers.first()
        const dragHandle = topLayer.locator('.layer-drag-handle')
        await expect(dragHandle).toBeVisible()

        // Trigger reorder via FSM methods
        const reordered = await page.evaluate(async () => {
            const app = window.layersApp
            const layerEls = document.querySelectorAll('layer-item')
            const sourceId = layerEls[0].dataset.layerId
            const targetId = layerEls[1].dataset.layerId
            app._startDrag(sourceId)
            await app._processDrop(targetId, 'below')
            return { sourceId, targetId, state: app._reorderState }
        })
        console.log('Triggered reorder:', reordered)

        // _processDrop is awaited inside the evaluate, but the gesture keeps
        // its lifecycle lease until the FSM has returned to IDLE.
        await appState(page, () => window.layersApp._reorderState === 'IDLE'
            && !window.layersApp._projectLifecycleOwner)

        const newNames = await layerNames.allTextContents()
        console.log('After reorder event - layers:', newNames)
        expect(newNames).not.toEqual(names)
    })

    test('drag handle shows grab cursor', async ({ page }) => {
        await page.goto('/', { waitUntil: 'networkidle' })
        await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })
        await createTransparentProject(page)
        await addEffectLayer(page, 'blur')

        const dragHandle = page.locator('layer-item.effect-layer').first().locator('.layer-drag-handle')
        await expect(dragHandle).toBeVisible()

        const cursor = await dragHandle.evaluate(el => window.getComputedStyle(el).cursor)
        expect(cursor).toBe('grab')
    })

    test('base layer drag handle is hidden', async ({ page }) => {
        await page.goto('/', { waitUntil: 'networkidle' })
        await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })
        await createTransparentProject(page)

        const baseLayer = page.locator('layer-item.base-layer')
        await expect(baseLayer).toBeVisible()

        const dragHandle = baseLayer.locator('.layer-drag-handle')
        const visibility = await dragHandle.evaluate(el => window.getComputedStyle(el).visibility)
        expect(visibility).toBe('hidden')
    })
})

test.describe('Layer drag no-op drop', () => {
    test('dropping a layer back into its current slot is a state no-op', async ({ page }) => {
        await page.goto('/', { waitUntil: 'networkidle' })
        await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })
        await createTransparentProject(page)
        await addEffectLayer(page, 'blur')
        await addEffectLayer(page, 'warp')

        const readState = () => page.evaluate(() => {
            const app = window.layersApp
            return {
                order: app._layers.map(l => l.id),
                revision: app._projectMutationRevision,
                dirty: app._isDirty,
                undoStackLength: app._undoManager._stack.length,
                undoIndex: app._undoManager._index,
            }
        })
        const before = await readState()

        // Dropping blur (index 1) 'below' warp (index 2) removes blur and
        // re-inserts it at its own index — the exact same order. This is the
        // real-user gesture of releasing a small drag over the slot the
        // layer already occupies.
        const drop = await page.evaluate(async () => {
            const app = window.layersApp
            const sourceId = app._layers[1].id
            const targetId = app._layers[2].id
            app._startDrag(sourceId)
            const outcome = await app._processDrop(targetId, 'below')
            return { outcome, state: app._reorderState }
        })
        expect(drop.outcome?.status).toBe('committed')
        expect(drop.state).toBe('IDLE')

        const after = await readState()
        expect(after.order).toEqual(before.order)
        expect(after.revision).toBe(before.revision)
        expect(after.dirty).toBe(before.dirty)
        expect(after.undoStackLength).toBe(before.undoStackLength)
        expect(after.undoIndex).toBe(before.undoIndex)
    })

    test('a real reorder after a no-op drop still commits state', async ({ page }) => {
        await page.goto('/', { waitUntil: 'networkidle' })
        await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })
        await createTransparentProject(page)
        await addEffectLayer(page, 'blur')
        await addEffectLayer(page, 'warp')

        const result = await page.evaluate(async () => {
            const app = window.layersApp
            const revisionAt = () => app._projectMutationRevision
            const order = () => app._layers.map(l => l.id)
            const beforeOrder = order()
            const beforeRevision = revisionAt()

            // No-op drop first (blur 'below' warp reproduces the order).
            app._startDrag(app._layers[1].id)
            await app._processDrop(app._layers[2].id, 'below')
            const afterNoOpRevision = revisionAt()
            const afterNoOpOrder = order()

            // Then a real reorder: dropping blur 'above' warp swaps them.
            app._startDrag(app._layers[1].id)
            await app._processDrop(app._layers[2].id, 'above')
            const afterRealRevision = revisionAt()
            const afterRealOrder = order()
            return {
                beforeOrder, beforeRevision,
                afterNoOpRevision, afterNoOpOrder,
                afterRealRevision, afterRealOrder,
                state: app._reorderState,
            }
        })
        expect(result.afterNoOpRevision).toBe(result.beforeRevision)
        expect(result.afterNoOpOrder).toEqual(result.beforeOrder)
        expect(result.afterRealRevision).toBeGreaterThan(result.afterNoOpRevision)
        expect(result.afterRealOrder).toEqual([
            result.beforeOrder[0], result.beforeOrder[2], result.beforeOrder[1],
        ])
        expect(result.state).toBe('IDLE')
    })

    test('agent reorderLayer to its own index is a state no-op', async ({ page }) => {
        await page.goto('/', { waitUntil: 'networkidle' })
        await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })
        await createTransparentProject(page)
        await addEffectLayer(page, 'blur')
        await addEffectLayer(page, 'warp')

        const readState = () => page.evaluate(() => {
            const app = window.layersApp
            return {
                order: app._layers.map(l => l.id),
                revision: app._projectMutationRevision,
                dirty: app._isDirty,
                undoStackLength: app._undoManager._stack.length,
            }
        })
        const before = await readState()

        const env = await page.evaluate((id) =>
            window.LayersAgent.reorderLayer({ layerId: id, toIndex: 1 }), before.order[1])
        expect(env.ok).toBe(true)

        const after = await readState()
        expect(after.order).toEqual(before.order)
        expect(after.revision).toBe(before.revision)
        expect(after.dirty).toBe(before.dirty)
        expect(after.undoStackLength).toBe(before.undoStackLength)
    })
})
