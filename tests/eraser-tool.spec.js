// tests/eraser-tool.spec.js
import { test, expect } from 'playwright/test'

async function createTransparentProject(page) {
    await page.waitForSelector('.open-dialog-backdrop.visible')
    await page.click('.media-option[data-type="transparent"]')
    await page.waitForSelector('.canvas-size-dialog', { timeout: 5000 })
    await page.click('.canvas-size-dialog .action-btn.primary')
    await page.waitForSelector('.open-dialog-backdrop.visible', { state: 'hidden', timeout: 5000 })
    await page.waitForTimeout(500)
}

test.describe('Eraser tool', () => {
    test('clicking on a stroke deletes it', async ({ page }) => {
        await page.goto('/', { waitUntil: 'networkidle' })
        await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })
        await createTransparentProject(page)

        // Create a drawing layer with a known stroke via JS
        await page.evaluate(async () => {
            const app = window.layersApp
            const { createDrawingLayer } = await import('/js/layers/layer-model.js')
            const { createPathStroke } = await import('/js/drawing/stroke-model.js')

            const layer = createDrawingLayer('Test')
            layer.strokes.push(createPathStroke({
                color: '#ff0000',
                size: 20,
                points: [{ x: 200, y: 200 }, { x: 300, y: 300 }]
            }))
            app._layers.push(layer)
            await app._rasterizeDrawingLayer(layer)
            await app._rebuild({ force: true })
            app._updateLayerStack()
            if (app._layerStack) {
                app._layerStack.selectedLayerId = layer.id
            }
        })
        await page.waitForTimeout(300)

        // Switch to eraser tool
        await page.click('#eraserToolBtn')

        // Click on the stroke (near the midpoint 250, 250)
        const overlay = await page.$('#selectionOverlay')
        const box = await overlay.boundingBox()
        const scaleX = box.width / 1024
        const scaleY = box.height / 1024
        await page.mouse.click(box.x + 250 * scaleX, box.y + 250 * scaleY)
        await page.waitForTimeout(300)

        const state = await page.evaluate(() => {
            const app = window.layersApp
            const layer = app._layers.find(l => l.sourceType === 'drawing')
            return {
                strokeCount: layer?.strokes?.length ?? -1,
                resourcePresent: layer
                    ? Boolean(app._renderer.getMediaInfo(layer.id))
                    : false,
            }
        })

        expect(state.strokeCount).toBe(0)
        expect(state.resourcePresent).toBe(false)
    })
})
