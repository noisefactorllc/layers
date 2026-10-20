import { test, expect } from './fixtures.js'
import { reopenNewProjectDialog } from './helpers/new-project.js'

// Parallel mode makes each case its own sharding unit: every case here boots
// its own app and shares no state with its siblings, so shards can split this
// file instead of pinning all of it to one runner.
test.describe.configure({ mode: 'parallel' })

async function bootApp(page) {
    await page.goto('/', { waitUntil: 'networkidle' })
    await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })
    await page.evaluate(async () => { await window.LayersAgent.ready })
    await reopenNewProjectDialog(page)
    await page.click('.media-option[data-type="solid"]')
    await page.waitForSelector('.canvas-size-dialog', { timeout: 5000 })
    await page.click('.canvas-size-dialog .action-btn.primary')
    await page.waitForSelector('.open-dialog-backdrop.visible', { state: 'hidden', timeout: 5000 })
}

test.describe('invertLayerMask / setMaskEnabled', () => {
    test('sets layer mask overlay visibility', async ({ page }) => {
        await bootApp(page)
        const layerId = await page.evaluate(() => window.layersApp._layers[0].id)
        await page.evaluate(id => window.LayersAgent.addLayerMask({ layerId: id }), layerId)
        const shown = await page.evaluate(id =>
            window.LayersAgent.setMaskVisible({ layerId: id, visible: true }), layerId)
        expect(shown.ok).toBe(true)
        expect(shown.state.layers.find(layer => layer.id === layerId).mask.visible).toBe(true)
        const hidden = await page.evaluate(id =>
            window.LayersAgent.setMaskVisible({ layerId: id, visible: false }), layerId)
        expect(hidden.ok).toBe(true)
        expect(hidden.state.layers.find(layer => layer.id === layerId).mask.visible).toBe(false)
    })
    test('enters and exits the existing mask brush mode', async ({ page }) => {
        await bootApp(page)
        const layerId = await page.evaluate(() => window.layersApp._layers[0].id)
        await page.evaluate(id => window.LayersAgent.addLayerMask({ layerId: id }), layerId)
        const entered = await page.evaluate(id =>
            window.LayersAgent.setMaskEditMode({ enabled: true, layerId: id }), layerId)
        expect(entered.ok).toBe(true)
        expect(entered.state.view.maskEditLayerId).toBe(layerId)
        expect(entered.state.view.tool).toBe('brush')
        expect(entered.state.layers.find(layer => layer.id === layerId).mask.visible).toBe(true)
        const exited = await page.evaluate(() => window.LayersAgent.setMaskEditMode({ enabled: false }))
        expect(exited.ok).toBe(true)
        expect(exited.state.view.maskEditLayerId).toBeNull()
        expect(exited.state.layers.find(layer => layer.id === layerId).mask.visible).toBe(false)
    })
    test('showing one mask selects its overlay after another mask was visible', async ({ page }) => {
        await bootApp(page)
        const result = await page.evaluate(async () => {
            const firstId = window.layersApp._layers[0].id
            const secondId = (await window.LayersAgent.addLayer({ kind: 'drawing' })).result.layerId
            await window.LayersAgent.addLayerMask({ layerId: firstId })
            await window.LayersAgent.addLayerMask({ layerId: secondId })
            await window.LayersAgent.setMaskEditMode({ enabled: true, layerId: firstId })
            await window.LayersAgent.setMaskVisible({ layerId: secondId, visible: true })
            await window.LayersAgent.setMaskVisible({ layerId: secondId, visible: false })
            const final = await window.LayersAgent.setMaskVisible({ layerId: firstId, visible: true })
            // UI paths can redraw the overlay after its per-layer flag changed.
            window.layersApp._layers.find(layer => layer.id === firstId).maskVisible = false
            const hidden = await window.LayersAgent.setMaskVisible({
                layerId: firstId, visible: false,
            })
            return { firstId, secondId, final,
                hidden, overlayHidden: document.getElementById('maskOverlay').classList.contains('hidden') }
        })
        expect(result.final.ok).toBe(true)
        expect(result.final.state.layers.find(layer => layer.id === result.firstId).mask.visible).toBe(true)
        expect(result.final.state.layers.find(layer => layer.id === result.secondId).mask.visible).toBe(false)
        expect(result.final.state.view.maskEditLayerId).toBeNull()
        expect(result.final.state.view.maskOverlayLayerId).toBe(result.firstId)
        expect(result.hidden.state.view.maskOverlayLayerId).toBeNull()
        expect(result.overlayHidden).toBe(true)
    })
    test('paints a layer mask and reads exact raster values in a bounded region', async ({ page }) => {
        await bootApp(page)
        const result = await page.evaluate(async () => {
            const layerId = window.layersApp._layers[0].id
            await window.LayersAgent.addLayerMask({ layerId })
            const painted = await window.LayersAgent.paintLayerMask({
                layerId, mode: 'hide', points: [[10, 10], [20, 20]], size: 8,
            })
            const region = await window.LayersAgent.getRasterRegion({
                source: 'layer-mask', layerId, x: 0, y: 0, width: 32, height: 32,
            })
            return { painted, region }
        })
        expect(result.painted.ok).toBe(true)
        expect(result.region.ok).toBe(true)
        expect(result.region.result.values[0]).toBe(255)
        expect(result.region.result.values[15 * 32 + 15]).toBe(0)
    })
    test('selects the visible part of a layer mask', async ({ page }) => {
        await bootApp(page)
        const result = await page.evaluate(async () => {
            const layerId = window.layersApp._layers[0].id
            await window.LayersAgent.setRectangleSelection({ x: 2, y: 3, width: 8, height: 9 })
            await window.LayersAgent.addMaskFromSelection({ layerId })
            await window.LayersAgent.selectNone()
            return window.LayersAgent.selectFromLayerMask({ layerId })
        })
        expect(result.ok).toBe(true)
        expect(result.state.selection.bounds).toEqual({ x: 2, y: 3, width: 8, height: 9 })
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

    test('setMaskEnabled is a no-op when already in requested state', async ({ page }) => {
        await bootApp(page)
        const id = await page.evaluate(() => window.layersApp._layers[0].id)
        await page.evaluate((layerId) =>
            window.LayersAgent.addLayerMask({ layerId }), id)
        // Mask starts enabled. Calling setMaskEnabled({ enabled: true }) should
        // be a fast-path no-op — same state, no work, no error.
        const env = await page.evaluate((layerId) =>
            window.LayersAgent.setMaskEnabled({ layerId, enabled: true }), id)
        expect(env.ok).toBe(true)
        expect(env.state.layers.find(l => l.id === id).mask.enabled).toBe(true)
    })
})

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
