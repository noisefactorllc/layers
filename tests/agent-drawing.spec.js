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

test.describe('paintStroke', () => {
    test('paints a stroke onto a new drawing layer (auto-created)', async ({ page }) => {
        await bootApp(page)
        const before = await page.evaluate(() => window.layersApp._layers.length)
        const env = await page.evaluate(() =>
            window.LayersAgent.paintStroke({
                points: [[10, 10], [50, 50], [100, 100]],
                size: 5,
                color: '#ff0000'
            }))
        expect(env.ok).toBe(true)
        expect(env.result.layerId).toMatch(/^layer-/)
        const after = await page.evaluate(() => window.layersApp._layers.length)
        expect(after).toBe(before + 1)
        const drawingLayer = env.state.layers.find(l => l.id === env.result.layerId)
        expect(drawingLayer.sourceType).toBe('drawing')
        expect(drawingLayer.drawing.strokeCount).toBe(1)
    })

    test('paintStroke onto an existing drawing layer', async ({ page }) => {
        await bootApp(page)
        const id = await page.evaluate(async () => {
            const env = await window.LayersAgent.addLayer({ kind: 'drawing' })
            return env.result.layerId
        })
        const env = await page.evaluate((layerId) =>
            window.LayersAgent.paintStroke({
                layerId,
                points: [[0, 0], [10, 10]],
                size: 3,
                color: '#000000'
            }), id)
        expect(env.ok).toBe(true)
        expect(env.result.layerId).toBe(id)
        const layer = env.state.layers.find(l => l.id === id)
        expect(layer.drawing.strokeCount).toBe(1)
    })

    test('paintStroke accepts {x,y} object points as well as [x,y] tuples', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() =>
            window.LayersAgent.paintStroke({
                points: [{ x: 10, y: 10 }, { x: 20, y: 20 }],
                size: 5,
                color: '#00ff00'
            }))
        expect(env.ok).toBe(true)
        const layer = env.state.layers.find(l => l.id === env.result.layerId)
        expect(layer.drawing.strokeCount).toBe(1)
    })

    test('CONFLICT_NOT_DRAWING_LAYER when layerId is not a drawing layer', async ({ page }) => {
        await bootApp(page)
        const id = await page.evaluate(() => window.layersApp._layers[0].id)
        const env = await page.evaluate((layerId) =>
            window.LayersAgent.paintStroke({
                layerId,
                points: [[0, 0], [10, 10]],
                size: 5,
                color: '#000000'
            }), id)
        expect(env.ok).toBe(false)
        expect(env.error.code).toBe('CONFLICT_NOT_DRAWING_LAYER')
    })

    test('rejects too few points', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() =>
            window.LayersAgent.paintStroke({ points: [[0, 0]], size: 5, color: '#000000' }))
        expect(env.ok).toBe(false)
        expect(env.error.code).toBe('INVALID_ARGS_RANGE')
        expect(env.error.details.field).toBe('points')
    })

    test('rejects malformed point', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() =>
            window.LayersAgent.paintStroke({
                points: [[0, 0], [1, 'oops']], size: 5, color: '#000000'
            }))
        expect(env.ok).toBe(false)
        expect(env.error.code).toBe('INVALID_ARGS_TYPE')
    })

    test('NOT_FOUND_LAYER for missing id', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() =>
            window.LayersAgent.paintStroke({
                layerId: 'layer-nope',
                points: [[0, 0], [10, 10]],
                size: 5, color: '#000000'
            }))
        expect(env.ok).toBe(false)
        expect(env.error.code).toBe('NOT_FOUND_LAYER')
    })
})

test.describe('drawShape', () => {
    test('draws an outlined rect onto a new drawing layer', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() =>
            window.LayersAgent.drawShape({
                shape: 'rect',
                x: 100, y: 100, width: 200, height: 100,
                color: '#0000ff',
                size: 3
            }))
        expect(env.ok).toBe(true)
        const layer = env.state.layers.find(l => l.id === env.result.layerId)
        expect(layer.sourceType).toBe('drawing')
        expect(layer.drawing.strokeCount).toBe(1)
    })

    test('draws a filled ellipse', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() =>
            window.LayersAgent.drawShape({
                shape: 'ellipse',
                x: 50, y: 50, width: 100, height: 80,
                color: '#00aa00',
                size: 1,
                filled: true
            }))
        expect(env.ok).toBe(true)
        const layer = env.state.layers.find(l => l.id === env.result.layerId)
        expect(layer.drawing.strokeCount).toBe(1)
    })

    test('drawShape rejects unknown shape', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() =>
            window.LayersAgent.drawShape({
                shape: 'star',
                x: 0, y: 0, width: 10, height: 10,
                color: '#000000', size: 1
            }))
        expect(env.ok).toBe(false)
        expect(env.error.code).toBe('INVALID_ARGS_ENUM')
    })

    test('drawShape rejects non-positive width', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() =>
            window.LayersAgent.drawShape({
                shape: 'rect',
                x: 0, y: 0, width: 0, height: 10,
                color: '#000000', size: 1
            }))
        expect(env.ok).toBe(false)
        expect(env.error.code).toBe('INVALID_ARGS_RANGE')
    })

    test('drawShape onto a non-drawing layer returns CONFLICT', async ({ page }) => {
        await bootApp(page)
        const id = await page.evaluate(() => window.layersApp._layers[0].id)
        const env = await page.evaluate((layerId) =>
            window.LayersAgent.drawShape({
                layerId,
                shape: 'rect',
                x: 0, y: 0, width: 10, height: 10,
                color: '#000000', size: 1
            }), id)
        expect(env.ok).toBe(false)
        expect(env.error.code).toBe('CONFLICT_NOT_DRAWING_LAYER')
    })
})

test.describe('fillRegion', () => {
    test('creates a new media layer with the filled region', async ({ page }) => {
        await bootApp(page)
        const before = await page.evaluate(() => window.layersApp._layers.length)
        const env = await page.evaluate(() =>
            window.LayersAgent.fillRegion({
                x: 100, y: 100,
                color: '#ff0000',
                tolerance: 32
            }))
        expect(env.ok).toBe(true)
        expect(env.result.layerId).toMatch(/^layer-/)
        const after = await page.evaluate(() => window.layersApp._layers.length)
        expect(after).toBe(before + 1)
        const layer = env.state.layers.find(l => l.id === env.result.layerId)
        expect(layer.sourceType).toBe('media')
    })

    test('rejects out-of-canvas point', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() =>
            window.LayersAgent.fillRegion({
                x: 99999, y: 0,
                color: '#000000', tolerance: 32
            }))
        expect(env.ok).toBe(false)
        expect(env.error.code).toBe('INVALID_ARGS_RANGE')
    })

    test('rejects out-of-range tolerance', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() =>
            window.LayersAgent.fillRegion({
                x: 0, y: 0,
                color: '#000000', tolerance: 999
            }))
        expect(env.ok).toBe(false)
        expect(env.error.code).toBe('INVALID_ARGS_RANGE')
    })
})
