import { test, expect } from './fixtures.js'

test.describe('Stroke renderer', () => {
    test('rasterizes a path stroke to canvas', async ({ page }) => {
        await page.goto('/', { waitUntil: 'networkidle' })
        await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })

        const hasPixels = await page.evaluate(() => {
            const { StrokeRenderer } = window._drawingTestExports
            const { createPathStroke } = window._drawingTestExports
            const renderer = new StrokeRenderer()
            const stroke = createPathStroke({
                color: '#ff0000',
                size: 10,
                points: [{ x: 50, y: 50 }, { x: 100, y: 100 }, { x: 150, y: 50 }]
            })
            const canvas = renderer.rasterize([stroke], 200, 200)
            const ctx = canvas.getContext('2d')
            const data = ctx.getImageData(75, 75, 1, 1).data
            // Red stroke should have non-zero red channel
            return data[0] > 0 && data[3] > 0
        })

        expect(hasPixels).toBe(true)
    })

    test('rasterizes a filled rect stroke', async ({ page }) => {
        await page.goto('/', { waitUntil: 'networkidle' })
        await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })

        const pixel = await page.evaluate(() => {
            const { StrokeRenderer, createShapeStroke } = window._drawingTestExports
            const renderer = new StrokeRenderer()
            const stroke = createShapeStroke({
                type: 'rect',
                color: '#00ff00',
                size: 2,
                x: 10, y: 10, width: 50, height: 50,
                filled: true
            })
            const canvas = renderer.rasterize([stroke], 100, 100)
            const ctx = canvas.getContext('2d')
            const data = ctx.getImageData(35, 35, 1, 1).data
            return { r: data[0], g: data[1], b: data[2], a: data[3] }
        })

        expect(pixel.g).toBe(255)
        expect(pixel.a).toBe(255)
    })

    test('returns empty canvas for no strokes', async ({ page }) => {
        await page.goto('/', { waitUntil: 'networkidle' })
        await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })

        const isEmpty = await page.evaluate(() => {
            const { StrokeRenderer } = window._drawingTestExports
            const renderer = new StrokeRenderer()
            const canvas = renderer.rasterize([], 100, 100)
            const ctx = canvas.getContext('2d')
            const data = ctx.getImageData(0, 0, 100, 100).data
            return data.every(v => v === 0)
        })

        expect(isEmpty).toBe(true)
    })
})
