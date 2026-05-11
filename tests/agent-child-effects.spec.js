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

    test('setChildEffectProps NOT_FOUND_LAYER for unknown parent layer', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() =>
            window.LayersAgent.setChildEffectProps({
                layerId: 'layer-nope', childId: 'layer-also-nope', props: { visible: false }
            }))
        expect(env.ok).toBe(false)
        expect(env.error.code).toBe('NOT_FOUND_LAYER')
    })

    test('setChildEffectProps NOT_FOUND_LAYER for unknown child id', async ({ page }) => {
        await bootApp(page)
        const id = await page.evaluate(() => window.layersApp._layers[0].id)
        const env = await page.evaluate((layerId) =>
            window.LayersAgent.setChildEffectProps({
                layerId, childId: 'layer-nope', props: { visible: false }
            }), id)
        expect(env.ok).toBe(false)
        expect(env.error.code).toBe('NOT_FOUND_LAYER')
    })

    test('setChildEffectProps on layer without children still surfaces NOT_FOUND_LAYER', async ({ page }) => {
        // The default boot layer is a solid media layer with no child effects.
        // The handler doesn't gate on sourceType — it just fails at the child lookup.
        await bootApp(page)
        const id = await page.evaluate(() => window.layersApp._layers[0].id)
        const env = await page.evaluate((layerId) =>
            window.LayersAgent.setChildEffectProps({
                layerId, childId: 'layer-anything', props: { visible: false }
            }), id)
        expect(env.ok).toBe(false)
        expect(env.error.code).toBe('NOT_FOUND_LAYER')
    })

    test('setChildEffectParams NOT_FOUND_LAYER for unknown parent layer', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() =>
            window.LayersAgent.setChildEffectParams({
                layerId: 'layer-nope', childId: 'layer-also-nope', params: { radiusX: 5 }
            }))
        expect(env.ok).toBe(false)
        expect(env.error.code).toBe('NOT_FOUND_LAYER')
    })

    test('setChildEffectParams NOT_FOUND_LAYER for unknown child id', async ({ page }) => {
        await bootApp(page)
        const id = await page.evaluate(() => window.layersApp._layers[0].id)
        const env = await page.evaluate((layerId) =>
            window.LayersAgent.setChildEffectParams({
                layerId, childId: 'layer-nope', params: { radiusX: 5 }
            }), id)
        expect(env.ok).toBe(false)
        expect(env.error.code).toBe('NOT_FOUND_LAYER')
    })

    test('setChildEffectParams replace:true clears existing params instead of merging', async ({ page }) => {
        await bootApp(page)
        const setup = await page.evaluate(async () => {
            const layerId = window.layersApp._layers[0].id
            const c = await window.LayersAgent.addChildEffect({ layerId, effectId: 'filter/blur' })
            // Seed both radiusX and radiusY so we can tell merge vs. replace apart.
            await window.LayersAgent.setChildEffectParams({
                layerId, childId: c.result.childId, params: { radiusX: 10, radiusY: 20 }
            })
            return { layerId, childId: c.result.childId }
        })

        // Replace with only radiusX — radiusY should drop out.
        const env = await page.evaluate((s) =>
            window.LayersAgent.setChildEffectParams({
                layerId: s.layerId, childId: s.childId,
                params: { radiusX: 3 }, replace: true
            }), setup)
        expect(env.ok).toBe(true)
        const layer = env.state.layers.find(l => l.id === setup.layerId)
        const child = layer.children.find(c => c.id === setup.childId)
        expect(child.params.radiusX).toBe(3)
        expect(child.params.radiusY).toBeUndefined()
    })

    test('setChildEffectParams default merge preserves untouched keys', async ({ page }) => {
        await bootApp(page)
        const setup = await page.evaluate(async () => {
            const layerId = window.layersApp._layers[0].id
            const c = await window.LayersAgent.addChildEffect({ layerId, effectId: 'filter/blur' })
            await window.LayersAgent.setChildEffectParams({
                layerId, childId: c.result.childId, params: { radiusX: 10, radiusY: 20 }
            })
            return { layerId, childId: c.result.childId }
        })

        // Default (no replace flag) — only radiusX changes, radiusY survives.
        const env = await page.evaluate((s) =>
            window.LayersAgent.setChildEffectParams({
                layerId: s.layerId, childId: s.childId, params: { radiusX: 7 }
            }), setup)
        expect(env.ok).toBe(true)
        const layer = env.state.layers.find(l => l.id === setup.layerId)
        const child = layer.children.find(c => c.id === setup.childId)
        expect(child.params.radiusX).toBe(7)
        expect(child.params.radiusY).toBe(20)
    })
})
