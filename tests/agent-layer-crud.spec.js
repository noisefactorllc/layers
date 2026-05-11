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
