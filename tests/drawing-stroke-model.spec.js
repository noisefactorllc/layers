import { test, expect } from './fixtures.js'

test.describe('Stroke model', () => {
    test('createPathStroke creates a valid path stroke', async ({ page }) => {
        await page.goto('/', { waitUntil: 'networkidle' })
        await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })

        const stroke = await page.evaluate(() => {
            const { createPathStroke } = window._drawingTestExports
            return createPathStroke({
                color: '#ff0000',
                size: 5,
                opacity: 0.8,
                points: [{ x: 10, y: 20 }, { x: 30, y: 40 }]
            })
        })

        expect(stroke.type).toBe('path')
        expect(stroke.id).toBeTruthy()
        expect(stroke.color).toBe('#ff0000')
        expect(stroke.size).toBe(5)
        expect(stroke.opacity).toBe(0.8)
        expect(stroke.points).toHaveLength(2)
    })

    test('createShapeStroke creates valid shape strokes', async ({ page }) => {
        await page.goto('/', { waitUntil: 'networkidle' })
        await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })

        const rect = await page.evaluate(() => {
            const { createShapeStroke } = window._drawingTestExports
            return createShapeStroke({
                type: 'rect',
                color: '#00ff00',
                size: 2,
                x: 10, y: 20, width: 100, height: 50,
                filled: true
            })
        })

        expect(rect.type).toBe('rect')
        expect(rect.id).toBeTruthy()
        expect(rect.filled).toBe(true)
        expect(rect.x).toBe(10)
    })

    test('stroke IDs are unique', async ({ page }) => {
        await page.goto('/', { waitUntil: 'networkidle' })
        await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })

        const ids = await page.evaluate(() => {
            const { createPathStroke } = window._drawingTestExports
            const a = createPathStroke({ color: '#000', size: 1, points: [] })
            const b = createPathStroke({ color: '#000', size: 1, points: [] })
            return [a.id, b.id]
        })

        expect(ids[0]).not.toBe(ids[1])
    })
})
