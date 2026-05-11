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
