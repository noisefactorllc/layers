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
