import { test, expect } from './fixtures.js'
import { appReady } from './waits.js'

test.describe('Image menu - Canvas Size', () => {
    test('canvas size changes dimensions with anchor offset', async ({ page }) => {
        await page.goto('/', { waitUntil: 'networkidle' })
        await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })

        // Create a solid base layer (1024x1024)
        await page.waitForSelector('.open-dialog-backdrop.visible')
        await page.click('.media-option[data-type="solid"]')
        await page.waitForSelector('.canvas-size-dialog', { timeout: 5000 })
        await page.click('.canvas-size-dialog .action-btn.primary')
        await page.waitForSelector('.open-dialog-backdrop.visible', { state: 'hidden', timeout: 5000 })
        await appReady(page)

        // Change canvas size to 2048x2048 with center anchor
        await page.evaluate(async () => {
            await window.layersApp._changeCanvasSize(2048, 2048, 'center')
        })

        // Verify canvas is 2048x2048
        const dims = await page.evaluate(() => ({
            w: window.layersApp._canvas.width,
            h: window.layersApp._canvas.height
        }))
        expect(dims.w).toBe(2048)
        expect(dims.h).toBe(2048)

        // Verify the media layer offset is (512, 512) — centered in the larger canvas
        const offset = await page.evaluate(() => ({
            x: window.layersApp._layers[0].offsetX,
            y: window.layersApp._layers[0].offsetY
        }))
        expect(offset.x).toBe(512)
        expect(offset.y).toBe(512)
    })
})
