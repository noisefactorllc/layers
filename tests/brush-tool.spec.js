// tests/brush-tool.spec.js
import { test, expect } from 'playwright/test'

async function createTransparentProject(page) {
    await page.waitForSelector('.open-dialog-backdrop.visible')
    await page.click('.media-option[data-type="transparent"]')
    await page.waitForSelector('.canvas-size-dialog', { timeout: 5000 })
    await page.click('.canvas-size-dialog .action-btn.primary')
    await page.waitForSelector('.open-dialog-backdrop.visible', { state: 'hidden', timeout: 5000 })
    await page.waitForTimeout(500)
}

test.describe('Brush tool', () => {
    test('drawing a stroke creates a drawing layer with a path stroke', async ({ page }) => {
        await page.goto('/', { waitUntil: 'networkidle' })
        await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })
        await createTransparentProject(page)

        await page.click('#brushToolBtn')

        const overlay = await page.$('#selectionOverlay')
        const box = await overlay.boundingBox()
        const startX = box.x + box.width * 0.3
        const startY = box.y + box.height * 0.3
        const endX = box.x + box.width * 0.6
        const endY = box.y + box.height * 0.6

        await page.mouse.move(startX, startY)
        await page.mouse.down()
        for (let i = 1; i <= 5; i++) {
            const t = i / 5
            await page.mouse.move(
                startX + (endX - startX) * t,
                startY + (endY - startY) * t
            )
        }
        await page.mouse.up()
        await page.waitForTimeout(300)

        const result = await page.evaluate(() => {
            const app = window.layersApp
            const drawingLayers = app._layers.filter(l => l.sourceType === 'drawing')
            if (drawingLayers.length === 0) return { found: false }
            const layer = drawingLayers[0]
            return {
                found: true,
                strokeCount: layer.strokes.length,
                strokeType: layer.strokes[0]?.type,
                hasPoints: layer.strokes[0]?.points?.length > 0
            }
        })

        expect(result.found).toBe(true)
        expect(result.strokeCount).toBe(1)
        expect(result.strokeType).toBe('path')
        expect(result.hasPoints).toBe(true)
    })

    test('second stroke adds to existing drawing layer', async ({ page }) => {
        await page.goto('/', { waitUntil: 'networkidle' })
        await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })
        await createTransparentProject(page)

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

        const result = await page.evaluate(() => {
            const app = window.layersApp
            const drawingLayers = app._layers.filter(l => l.sourceType === 'drawing')
            return {
                layerCount: drawingLayers.length,
                strokeCount: drawingLayers[0]?.strokes?.length || 0
            }
        })

        expect(result.layerCount).toBe(1)
        expect(result.strokeCount).toBe(2)
    })

    test('reports a failed stroke commit outcome', async ({ page }) => {
        await page.goto('/', { waitUntil: 'networkidle' })
        await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })
        await createTransparentProject(page)
        await page.click('#brushToolBtn')

        await page.evaluate(() => {
            const app = window.layersApp
            window.__brushCommitErrors = []
            window.__brushOriginalConsoleError = console.error
            console.error = (...args) => {
                window.__brushCommitErrors.push(args.map(String).join(' '))
            }
            app._brushTool._commitStroke = async () => ({
                status: 'failed',
                error: new Error('injected brush commit failure'),
            })
        })

        const overlay = await page.$('#selectionOverlay')
        const box = await overlay.boundingBox()
        await page.mouse.move(box.x + 100, box.y + 100)
        await page.mouse.down()
        await page.mouse.move(box.x + 180, box.y + 180)
        await page.mouse.up()
        await page.waitForTimeout(100)

        const errors = await page.evaluate(() => {
            console.error = window.__brushOriginalConsoleError
            return window.__brushCommitErrors
        })
        expect(errors.some(message => message.includes(
            '[BrushTool] Failed to commit stroke: Error: injected brush commit failure')))
            .toBe(true)
    })
})
