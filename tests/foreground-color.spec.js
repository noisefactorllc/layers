import { test, expect } from './fixtures.js'

async function createTransparentProject(page) {
    await page.waitForSelector('.open-dialog-backdrop.visible')
    await page.click('.media-option[data-type="transparent"]')
    await page.waitForSelector('.canvas-size-dialog', { timeout: 5000 })
    await page.click('.canvas-size-dialog .action-btn.primary')
    await page.waitForSelector('.open-dialog-backdrop.visible', { state: 'hidden', timeout: 5000 })
    await page.waitForTimeout(500)
}

test.describe('Foreground color', () => {
    test('app has a foreground color property defaulting to black', async ({ page }) => {
        await page.goto('/', { waitUntil: 'networkidle' })
        await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })
        await createTransparentProject(page)

        const color = await page.evaluate(() => window.layersApp._foregroundColor)
        expect(color).toBe('#000000')
    })

    test('setForegroundColor updates all tools', async ({ page }) => {
        await page.goto('/', { waitUntil: 'networkidle' })
        await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })
        await createTransparentProject(page)

        await page.evaluate(() => {
            window.layersApp._setForegroundColor('#ff0000')
        })

        const colors = await page.evaluate(() => ({
            app: window.layersApp._foregroundColor,
            brush: window.layersApp._brushTool.color,
            shape: window.layersApp._shapeTool.color,
            fill: window.layersApp._fillTool.color
        }))

        expect(colors.app).toBe('#ff0000')
        expect(colors.brush).toBe('#ff0000')
        expect(colors.shape).toBe('#ff0000')
        expect(colors.fill).toBe('#ff0000')
    })

    test('brush tool uses foreground color for strokes', async ({ page }) => {
        await page.goto('/', { waitUntil: 'networkidle' })
        await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })
        await createTransparentProject(page)

        await page.evaluate(() => {
            window.layersApp._setForegroundColor('#00ff00')
        })

        await page.click('#brushToolBtn')
        const overlay = await page.$('#selectionOverlay')
        const box = await overlay.boundingBox()
        await page.mouse.move(box.x + 100, box.y + 100)
        await page.mouse.down()
        await page.mouse.move(box.x + 200, box.y + 200)
        await page.mouse.up()
        await page.waitForTimeout(300)

        const strokeColor = await page.evaluate(() => {
            const layer = window.layersApp._layers.find(l => l.sourceType === 'drawing')
            return layer?.strokes[0]?.color
        })
        expect(strokeColor).toBe('#00ff00')
    })
})
