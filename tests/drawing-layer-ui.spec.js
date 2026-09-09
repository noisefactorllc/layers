import { test, expect } from './fixtures.js'
import { appReady } from './waits.js'

async function createTransparentProject(page) {
    await page.waitForSelector('.open-dialog-backdrop.visible')
    await page.click('.media-option[data-type="transparent"]')
    await page.waitForSelector('.canvas-size-dialog', { timeout: 5000 })
    await page.click('.canvas-size-dialog .action-btn.primary')
    await page.waitForSelector('.open-dialog-backdrop.visible', { state: 'hidden', timeout: 5000 })
    await appReady(page)
}

test.describe('Drawing layer UI', () => {
    test('drawing layer shows draw icon in layer stack', async ({ page }) => {
        await page.goto('/', { waitUntil: 'networkidle' })
        await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })
        await createTransparentProject(page)

        // Create a drawing layer via the app's internal API
        await page.evaluate(async () => {
            const { createDrawingLayer } = await import('/js/layers/layer-model.js')
            const layer = createDrawingLayer('Test Drawing')
            window.layersApp._layers.push(layer)
            window.layersApp._updateLayerStack()
        })
        await expect(page.locator('layer-item')).toHaveCount(2)

        // Check for the draw icon in layer-item elements (no shadow DOM — uses innerHTML)
        const hasIcon = await page.evaluate(() => {
            const items = document.querySelectorAll('layer-item')
            for (const item of items) {
                const icons = item.querySelectorAll('.icon-material')
                for (const icon of icons) {
                    if (icon.textContent.trim() === 'draw') return true
                }
            }
            return false
        })

        expect(hasIcon).toBe(true)
    })

    test('drawing layer shows Drawing type label', async ({ page }) => {
        await page.goto('/', { waitUntil: 'networkidle' })
        await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })
        await createTransparentProject(page)

        // Create a drawing layer
        await page.evaluate(async () => {
            const { createDrawingLayer } = await import('/js/layers/layer-model.js')
            const layer = createDrawingLayer('Test Drawing')
            window.layersApp._layers.push(layer)
            window.layersApp._updateLayerStack()
        })
        await expect(page.locator('layer-item')).toHaveCount(2)

        // Check for 'Drawing' type label
        const hasLabel = await page.evaluate(() => {
            const items = document.querySelectorAll('layer-item')
            for (const item of items) {
                const typeEl = item.querySelector('.layer-type')
                if (typeEl && typeEl.textContent.trim() === 'Drawing') return true
            }
            return false
        })

        expect(hasLabel).toBe(true)
    })
})
