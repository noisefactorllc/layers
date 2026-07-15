// tests/shape-tool.spec.js
import { test, expect } from 'playwright/test'

async function createTransparentProject(page) {
    await page.waitForSelector('.open-dialog-backdrop.visible')
    await page.click('.media-option[data-type="transparent"]')
    await page.waitForSelector('.canvas-size-dialog', { timeout: 5000 })
    await page.click('.canvas-size-dialog .action-btn.primary')
    await page.waitForSelector('.open-dialog-backdrop.visible', { state: 'hidden', timeout: 5000 })
    await page.waitForTimeout(500)
}

test.describe('Shape tool', () => {
    test('drawing a rectangle creates a rect stroke', async ({ page }) => {
        await page.goto('/', { waitUntil: 'networkidle' })
        await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })
        await createTransparentProject(page)

        await page.click('#shapeToolBtn')
        await page.evaluate(() => {
            window.layersApp._shapeTool.shapeType = 'rect'
        })

        const overlay = await page.$('#selectionOverlay')
        const box = await overlay.boundingBox()

        const startX = box.x + box.width * 0.2
        const startY = box.y + box.height * 0.2
        const endX = box.x + box.width * 0.6
        const endY = box.y + box.height * 0.5

        await page.mouse.move(startX, startY)
        await page.mouse.down()
        await page.mouse.move(endX, endY)
        await page.mouse.up()
        await page.waitForTimeout(300)

        const result = await page.evaluate(() => {
            const app = window.layersApp
            const layer = app._layers.find(l => l.sourceType === 'drawing')
            if (!layer) return { found: false }
            return {
                found: true,
                strokeType: layer.strokes[0]?.type,
                hasSize: layer.strokes[0]?.width > 0 && layer.strokes[0]?.height > 0
            }
        })

        expect(result.found).toBe(true)
        expect(result.strokeType).toBe('rect')
        expect(result.hasSize).toBe(true)
    })

    test('drawing an ellipse creates an ellipse stroke', async ({ page }) => {
        await page.goto('/', { waitUntil: 'networkidle' })
        await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })
        await createTransparentProject(page)

        await page.click('#shapeToolBtn')
        await page.evaluate(() => {
            window.layersApp._shapeTool.shapeType = 'ellipse'
        })

        const overlay = await page.$('#selectionOverlay')
        const box = await overlay.boundingBox()

        await page.mouse.move(box.x + 100, box.y + 100)
        await page.mouse.down()
        await page.mouse.move(box.x + 300, box.y + 250)
        await page.mouse.up()
        await page.waitForTimeout(300)

        const type = await page.evaluate(() => {
            const app = window.layersApp
            const layer = app._layers.find(l => l.sourceType === 'drawing')
            return layer?.strokes[0]?.type
        })

        expect(type).toBe('ellipse')
    })

    test('reports a failed stroke commit outcome', async ({ page }) => {
        await page.goto('/', { waitUntil: 'networkidle' })
        await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })
        await createTransparentProject(page)
        await page.click('#shapeToolBtn')

        await page.evaluate(() => {
            const app = window.layersApp
            window.__shapeCommitErrors = []
            window.__shapeOriginalConsoleError = console.error
            console.error = (...args) => {
                window.__shapeCommitErrors.push(args.map(String).join(' '))
            }
            app._shapeTool._commitStroke = async () => ({
                status: 'failed',
                error: new Error('injected shape commit failure'),
            })
        })

        const overlay = await page.$('#selectionOverlay')
        const box = await overlay.boundingBox()
        await page.mouse.move(box.x + 100, box.y + 100)
        await page.mouse.down()
        await page.mouse.move(box.x + 220, box.y + 180)
        await page.mouse.up()
        await page.waitForTimeout(100)

        const errors = await page.evaluate(() => {
            console.error = window.__shapeOriginalConsoleError
            return window.__shapeCommitErrors
        })
        expect(errors.some(message => message.includes(
            '[ShapeTool] Failed to commit stroke: Error: injected shape commit failure')))
            .toBe(true)
    })
})
