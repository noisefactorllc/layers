import { test, expect } from './fixtures.js'
import { appReady, framePainted } from './waits.js'

async function createTransparentProject(page) {
    await page.waitForSelector('.open-dialog-backdrop.visible')
    await page.click('.media-option[data-type="transparent"]')
    await page.waitForSelector('.canvas-size-dialog', { timeout: 5000 })
    await page.click('.canvas-size-dialog .action-btn.primary')
    await page.waitForSelector('.open-dialog-backdrop.visible', { state: 'hidden', timeout: 5000 })
    await appReady(page)
}

test.describe('Drawing layer rendering', () => {
    test('drawing layer with strokes renders visible pixels', async ({ page }) => {
        await page.goto('/', { waitUntil: 'networkidle' })
        await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })
        await createTransparentProject(page)

        await page.evaluate(async () => {
            const app = window.layersApp
            const { createDrawingLayer } = await import('/js/layers/layer-model.js')
            const { createPathStroke } = await import('/js/drawing/stroke-model.js')

            const layer = createDrawingLayer('Test Drawing')
            layer.strokes.push(createPathStroke({
                color: '#ff0000',
                size: 20,
                points: [
                    { x: 100, y: 100 },
                    { x: 200, y: 200 },
                    { x: 300, y: 100 }
                ]
            }))

            app._layers.push(layer)
            await app._rasterizeDrawingLayer(layer)
            await app._rebuild({ force: true })
            app._updateLayerStack()

            app._renderer.render(0)
        })

        // The next step reads pixels, so wait on real frames rather than on a
        // guessed duration: it costs nothing on a fast machine, still waits on
        // a slow one, and says so if frames stop coming.
        await framePainted(page)

        const hasColor = await page.evaluate(() => {
            // Read pixels from the WebGL canvas
            const canvas = document.getElementById('canvas')
            const gl = canvas.getContext('webgl2') || canvas.getContext('webgl')
            const pixels = new Uint8Array(4)
            gl.readPixels(150, canvas.height - 150, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixels)

            return pixels[0] > 100 && pixels[3] > 0
        })

        expect(hasColor).toBe(true)
    })
})
