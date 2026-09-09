// tests/eraser-tool.spec.js
import { test, expect } from './fixtures.js'
import { appReady, appState, framePainted, layerCount } from './waits.js'

async function createTransparentProject(page) {
    await page.waitForSelector('.open-dialog-backdrop.visible')
    await page.click('.media-option[data-type="transparent"]')
    await page.waitForSelector('.canvas-size-dialog', { timeout: 5000 })
    await page.click('.canvas-size-dialog .action-btn.primary')
    await page.waitForSelector('.open-dialog-backdrop.visible', { state: 'hidden', timeout: 5000 })
    // The dialog hides the moment it is dismissed; the project it asked for is
    // still being installed. Wait for the app and its base layer.
    await appReady(page)
    await layerCount(page, 1)
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
        // The evaluate already awaited the rasterize and the rebuild. What is
        // left is a frame, and the next lines measure the overlay's box.
        await framePainted(page)

        // Switch to eraser tool
        await page.click('#eraserToolBtn')

        // Click on the stroke (near the midpoint 250, 250)
        const overlay = await page.$('#selectionOverlay')
        const box = await overlay.boundingBox()
        const scaleX = box.width / 1024
        const scaleY = box.height / 1024
        await page.mouse.click(box.x + 250 * scaleX, box.y + 250 * scaleY)
        // The deletion drops the stroke from the model first and unloads the
        // layer's media resource at the end of the same commit. Wait for the
        // stroke to go, then drain the mutation queue that carries it, so both
        // reads below see one settled state instead of a half-applied one.
        await appState(page, () => {
            const layer = window.layersApp._layers.find(l => l.sourceType === 'drawing')
            return layer?.strokes?.length === 0
        })
        await page.evaluate(() => window.layersApp._drawingMutationTail)

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
