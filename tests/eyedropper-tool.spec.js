import { test, expect } from 'playwright/test'

test.describe('Eyedropper tool', () => {
    test('eyedropper button exists', async ({ page }) => {
        await page.goto('/', { waitUntil: 'networkidle' })
        await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })

        await page.waitForSelector('.open-dialog-backdrop.visible')
        await page.click('.media-option[data-type="solid"]')
        await page.click('.action-btn.primary')
        await page.waitForSelector('.open-dialog-backdrop.visible', { state: 'hidden', timeout: 5000 })
        await page.waitForTimeout(500)

        const btn = await page.$('#eyedropperToolBtn')
        expect(btn).not.toBeNull()
    })

    test('I key activates eyedropper', async ({ page }) => {
        await page.goto('/', { waitUntil: 'networkidle' })
        await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })

        await page.waitForSelector('.open-dialog-backdrop.visible')
        await page.click('.media-option[data-type="solid"]')
        await page.click('.action-btn.primary')
        await page.waitForSelector('.open-dialog-backdrop.visible', { state: 'hidden', timeout: 5000 })
        await page.waitForTimeout(500)

        await page.keyboard.press('i')
        const tool = await page.evaluate(() => window.layersApp._currentTool)
        expect(tool).toBe('eyedropper')
    })

    test('clicking canvas samples color and returns to previous tool', async ({ page }) => {
        await page.goto('/', { waitUntil: 'networkidle' })
        await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })

        await page.waitForSelector('.open-dialog-backdrop.visible')
        await page.click('.media-option[data-type="solid"]')
        await page.click('.action-btn.primary')
        await page.waitForSelector('.open-dialog-backdrop.visible', { state: 'hidden', timeout: 5000 })
        await page.waitForTimeout(500)

        // Start with brush tool
        await page.click('#brushToolBtn')
        const prevTool = await page.evaluate(() => window.layersApp._currentTool)
        expect(prevTool).toBe('brush')

        // Switch to eyedropper and click canvas
        await page.click('#eyedropperToolBtn')
        const overlay = await page.$('#selectionOverlay')
        const box = await overlay.boundingBox()
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
        await page.waitForTimeout(300)

        // Should have returned to brush and sampled a non-black color
        const result = await page.evaluate(() => ({
            tool: window.layersApp._currentTool,
            color: window.layersApp._foregroundColor
        }))
        expect(result.tool).toBe('brush')
        expect(result.color).not.toBe('#000000')
    })

    test('sampling the top row reads the canvas, not out-of-bounds black', async ({ page }) => {
        await page.goto('/', { waitUntil: 'networkidle' })
        await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })

        await page.waitForSelector('.open-dialog-backdrop.visible')
        await page.click('.media-option[data-type="solid"]')
        await page.click('.action-btn.primary')
        await page.waitForSelector('.open-dialog-backdrop.visible', { state: 'hidden', timeout: 5000 })
        await page.waitForTimeout(500)

        await page.click('#eyedropperToolBtn')

        // Dispatch a click mapped exactly to canvas pixel row y=0 (the top row).
        // Pre-fix this read bottom-up row `height` (out of bounds) -> black.
        const color = await page.evaluate(async () => {
            const app = window.layersApp
            const overlay = document.getElementById('selectionOverlay')
            const rect = overlay.getBoundingClientRect()
            const scaleX = rect.width / overlay.width
            const scaleY = rect.height / overlay.height
            const clientX = rect.left + (overlay.width / 2) * scaleX
            const clientY = rect.top + 0.5 * scaleY // floor(0.5) -> row 0
            overlay.dispatchEvent(new MouseEvent('click', { clientX, clientY, bubbles: true }))
            await new Promise(r => setTimeout(r, 150))
            return app._foregroundColor
        })

        expect(color).not.toBe('#000000')
    })
})
