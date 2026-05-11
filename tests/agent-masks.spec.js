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
        // 200*200 / 1024*1024 ~= 0.038. Tight bounds catch inversion or all-white bugs.
        expect(layer.mask.coverage).toBeGreaterThan(0.02)
        expect(layer.mask.coverage).toBeLessThan(0.06)
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
