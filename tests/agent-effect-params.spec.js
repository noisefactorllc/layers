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
        // First set a second declared param.
        await page.evaluate((layerId) =>
            window.LayersAgent.setLayerEffectParams({
                layerId,
                params: { color: [0, 1, 0], alpha: 0.5 }
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
