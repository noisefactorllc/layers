import { test, expect } from './fixtures.js'
import { defaultProjectReady } from './waits.js'
import { pausePlayback } from './helpers/new-project.js'

test.describe('Ctrl/Cmd+Wheel Pointer-Anchored Zoom', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('/', { waitUntil: 'networkidle' })
        await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })
        await defaultProjectReady(page)
        await pausePlayback(page)
    })

    // A point on the canvas that is actually visible in the viewport: the
    // intersection of the canvas rect and the panel rect. Returns the client
    // point plus the fraction of the canvas it lies on.
    async function visibleCanvasPoint(page, fxVisible = 0.6, fyVisible = 0.4) {
        return page.evaluate(({ fxVisible, fyVisible }) => {
            const canvas = document.getElementById('canvas')
            const panel = document.getElementById('canvas-panel')
            const c = canvas.getBoundingClientRect()
            const p = panel.getBoundingClientRect()
            const left = Math.max(c.left, p.left, 0)
            const top = Math.max(c.top, p.top, 0)
            const right = Math.min(c.right, p.right, window.innerWidth)
            const bottom = Math.min(c.bottom, p.bottom, window.innerHeight)
            const x = left + (right - left) * fxVisible
            const y = top + (bottom - top) * fyVisible
            return {
                x, y,
                fx: (x - c.left) / c.width,
                fy: (y - c.top) / c.height,
            }
        }, { fxVisible, fyVisible })
    }

    async function canvasFractionAt(page, point) {
        return page.evaluate(({ x, y }) => {
            const c = document.getElementById('canvas').getBoundingClientRect()
            return { fx: (x - c.left) / c.width, fy: (y - c.top) / c.height }
        }, point)
    }

    async function ctrlWheel(page, deltaY) {
        await page.keyboard.down('Control')
        await page.mouse.wheel(0, deltaY)
        await page.keyboard.up('Control')
        await page.waitForTimeout(100)
    }

    test('ctrl+wheel over the canvas zooms in one discrete step from fit', async ({ page }) => {
        expect(await page.evaluate(() => window.layersApp._zoomMode)).toBe('fit')

        const point = await visibleCanvasPoint(page)
        await page.mouse.move(point.x, point.y)
        await ctrlWheel(page, -120)

        expect(await page.evaluate(() => window.layersApp._zoomMode)).toBe('100')
        const size = await page.evaluate(() => document.getElementById('canvas').getBoundingClientRect().width)
        expect(size).toBeGreaterThan(0)
    })

    test('ctrl+wheel zoom keeps the canvas point under the cursor stationary', async ({ page }) => {
        // Zoom IN from 100% to 200%: the content grows under the cursor and
        // the panel scrolls to compensate. (Zooming out to a mode where the
        // whole canvas fits cannot hold the anchor: the required scroll is
        // negative, so it clamps to 0.)
        await page.evaluate(() => window.layersApp._setZoom('100'))
        await page.waitForTimeout(100)

        // Anchor point right/bottom of the panel center (covered by the
        // canvas at 100%, which overflows the panel): zooming in grows the
        // content and the compensating scroll direction is achievable there.
        const point = await page.evaluate(() => {
            const canvas = document.getElementById('canvas')
            const panel = document.getElementById('canvas-panel')
            const c = canvas.getBoundingClientRect()
            const p = panel.getBoundingClientRect()
            const x = p.left + p.width * 0.8
            const y = p.top + p.height * 0.7
            return { x, y, fx: (x - c.left) / c.width, fy: (y - c.top) / c.height }
        })
        await page.mouse.move(point.x, point.y)
        const before = await canvasFractionAt(page, point)

        await ctrlWheel(page, -120)

        expect(await page.evaluate(() => window.layersApp._zoomMode)).toBe('200')

        const after = await canvasFractionAt(page, point)
        expect(Math.abs(after.fx - before.fx)).toBeLessThan(0.02)
        expect(Math.abs(after.fy - before.fy)).toBeLessThan(0.02)
    })

    test('multiple small pinch deltas accumulate into a single zoom step', async ({ page }) => {
        expect(await page.evaluate(() => window.layersApp._zoomMode)).toBe('fit')

        const point = await visibleCanvasPoint(page)
        await page.mouse.move(point.x, point.y)

        await page.keyboard.down('Control')
        for (let i = 0; i < 5; i++) {
            await page.mouse.wheel(0, -5)
        }
        await page.keyboard.up('Control')
        await page.waitForTimeout(100)

        // Total delta -25 is below the 30 threshold: no step yet.
        expect(await page.evaluate(() => window.layersApp._zoomMode)).toBe('fit')

        // One more small event crosses the threshold: exactly one step.
        await page.keyboard.down('Control')
        await page.mouse.wheel(0, -10)
        await page.keyboard.up('Control')
        await page.waitForTimeout(100)

        expect(await page.evaluate(() => window.layersApp._zoomMode)).toBe('100')
    })

    test('plain wheel does not change zoom and still scrolls the panel', async ({ page }) => {
        await page.evaluate(() => window.layersApp._setZoom('200'))
        await page.waitForTimeout(100)

        const before = await page.evaluate(() => {
            const panel = document.getElementById('canvas-panel')
            return { left: panel.scrollLeft, top: panel.scrollTop, mode: window.layersApp._zoomMode }
        })

        const point = await visibleCanvasPoint(page, 0.5, 0.3)
        await page.mouse.move(point.x, point.y)
        await page.mouse.wheel(0, 200)
        await page.waitForTimeout(100)

        const after = await page.evaluate(() => {
            const panel = document.getElementById('canvas-panel')
            return { left: panel.scrollLeft, top: panel.scrollTop, mode: window.layersApp._zoomMode }
        })

        expect(after.mode).toBe('200')
        expect(after.top).toBeGreaterThan(before.top)
    })

    test('ctrl+wheel zoom out at fit stays at fit', async ({ page }) => {
        const point = await visibleCanvasPoint(page)
        await page.mouse.move(point.x, point.y)
        await ctrlWheel(page, 120)
        expect(await page.evaluate(() => window.layersApp._zoomMode)).toBe('fit')
        // A later unrelated _applyZoom (resize path) must not resurrect the
        // discarded anchor and re-scroll the panel.
        await page.evaluate(() => window.dispatchEvent(new Event('resize')))
        await page.waitForTimeout(50)
        expect(await page.evaluate(() => window.layersApp._pendingZoomAnchor)).toBeNull()
    })

    test('browser zoom is prevented while pinch-zooming the canvas', async ({ page }) => {
        const widthBefore = await page.evaluate(() => window.innerWidth)
        const point = await visibleCanvasPoint(page)
        await page.mouse.move(point.x, point.y)
        await ctrlWheel(page, -120)
        const widthAfter = await page.evaluate(() => window.innerWidth)
        expect(widthAfter).toBe(widthBefore)
        expect(await page.evaluate(() => window.layersApp._zoomMode)).toBe('100')
    })
})
