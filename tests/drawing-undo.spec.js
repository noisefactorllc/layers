import { test, expect } from './fixtures.js'

async function createTransparentProject(page) {
    await page.waitForSelector('.open-dialog-backdrop.visible')
    await page.click('.media-option[data-type="transparent"]')
    await page.waitForSelector('.canvas-size-dialog', { timeout: 5000 })
    await page.click('.canvas-size-dialog .action-btn.primary')
    await page.waitForSelector('.open-dialog-backdrop.visible', { state: 'hidden', timeout: 5000 })
    await page.waitForTimeout(500)
}

test.describe('Drawing undo', () => {
    test('undo removes the last stroke', async ({ page }) => {
        await page.goto('/', { waitUntil: 'networkidle' })
        await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })
        await createTransparentProject(page)

        // Switch to brush tool
        await page.click('#brushToolBtn')
        const overlay = await page.$('#selectionOverlay')
        const box = await overlay.boundingBox()

        // First stroke
        await page.mouse.move(box.x + 100, box.y + 100)
        await page.mouse.down()
        await page.mouse.move(box.x + 200, box.y + 200)
        await page.mouse.up()
        await page.waitForTimeout(300)

        // Second stroke
        await page.mouse.move(box.x + 300, box.y + 100)
        await page.mouse.down()
        await page.mouse.move(box.x + 400, box.y + 200)
        await page.mouse.up()
        await page.waitForTimeout(300)

        // Verify 2 strokes
        let strokeCount = await page.evaluate(() => {
            const layer = window.layersApp._layers.find(l => l.sourceType === 'drawing')
            return layer?.strokes?.length ?? 0
        })
        expect(strokeCount).toBe(2)

        // Undo — should go from 2 strokes to 1
        await page.keyboard.press('Meta+z')
        await page.waitForTimeout(300)

        strokeCount = await page.evaluate(() => {
            const layer = window.layersApp._layers.find(l => l.sourceType === 'drawing')
            return layer?.strokes?.length ?? 0
        })
        expect(strokeCount).toBe(1)

        // Undo again — should go from 1 stroke to 0 strokes (layer created but empty)
        await page.keyboard.press('Meta+z')
        await page.waitForTimeout(300)

        strokeCount = await page.evaluate(() => {
            const layer = window.layersApp._layers.find(l => l.sourceType === 'drawing')
            return layer?.strokes?.length ?? 0
        })
        expect(strokeCount).toBe(0)

        // Undo once more — removes the drawing layer entirely (back to before layer creation)
        await page.keyboard.press('Meta+z')
        await page.waitForTimeout(300)

        const hasDrawingLayer = await page.evaluate(() =>
            window.layersApp._layers.some(l => l.sourceType === 'drawing')
        )
        expect(hasDrawingLayer).toBe(false)
    })
})
