import { test, expect } from './fixtures.js'
import { defaultProjectReady } from './waits.js'
import { pausePlayback } from './helpers/new-project.js'

test.describe('Safari trackpad pinch zoom (gesture events)', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('/', { waitUntil: 'networkidle' })
        await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })
        await defaultProjectReady(page)
        await pausePlayback(page)
    })

    // Dispatch a synthetic Safari GestureEvent on the canvas panel. GestureEvent
    // has no cross-browser constructor, so build a cancelable Event and attach
    // the fields the handler reads — mirroring the real WebKit payload.
    async function gesture(page, type, { scale = 1, x, y }) {
        await page.evaluate(({ type, scale, x, y }) => {
            const e = new Event(type, { bubbles: true, cancelable: true })
            e.scale = scale
            e.clientX = x
            e.clientY = y
            document.getElementById('canvas-panel').dispatchEvent(e)
        }, { type, scale, x, y })
        await page.waitForTimeout(100)
    }

    async function gesturePinch(page, x, y, scales) {
        await gesture(page, 'gesturestart', { scale: 1, x, y })
        for (const s of scales) {
            await gesture(page, 'gesturechange', { scale: s, x, y })
        }
        await gesture(page, 'gestureend', { scale: scales.at(-1) ?? 1, x, y })
    }

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

    test('a pinch-out over the canvas zooms in one discrete step from fit', async ({ page }) => {
        expect(await page.evaluate(() => window.layersApp._zoomMode)).toBe('fit')

        const point = await visibleCanvasPoint(page)
        await gesturePinch(page, point.x, point.y, [1.2])

        expect(await page.evaluate(() => window.layersApp._zoomMode)).toBe('100')
        // Gesture state is reset after the pinch ends.
        expect(await page.evaluate(() => window.layersApp._gesturePinchActive)).toBe(false)
        expect(await page.evaluate(() => window.layersApp._gesturePinchBase)).toBe(1)
    })

    test('sub-threshold pinch deltas accumulate without stepping', async ({ page }) => {
        expect(await page.evaluate(() => window.layersApp._zoomMode)).toBe('fit')

        const point = await visibleCanvasPoint(page)
        await gesturePinch(page, point.x, point.y, [1.05, 1.08])

        // Total scale 1.08 < 1.1 threshold: no zoom step yet, but the base
        // tracks the last seen scale mid-gesture.
        expect(await page.evaluate(() => window.layersApp._zoomMode)).toBe('fit')
    })

    test('a continuous pinch crossing the threshold twice steps twice', async ({ page }) => {
        await page.evaluate(() => window.layersApp._setZoom('50'))
        await page.waitForTimeout(100)

        const point = await visibleCanvasPoint(page)
        await gesturePinch(page, point.x, point.y, [1.15, 1.3])

        expect(await page.evaluate(() => window.layersApp._zoomMode)).toBe('200')
    })

    test('pinch zoom keeps the canvas point under the pointer stationary', async ({ page }) => {
        await page.evaluate(() => window.layersApp._setZoom('100'))
        await page.waitForTimeout(100)

        const point = await page.evaluate(() => {
            const canvas = document.getElementById('canvas')
            const panel = document.getElementById('canvas-panel')
            const c = canvas.getBoundingClientRect()
            const p = panel.getBoundingClientRect()
            const x = p.left + p.width * 0.8
            const y = p.top + p.height * 0.7
            return { x, y, fx: (x - c.left) / c.width, fy: (y - c.top) / c.height }
        })
        const before = await canvasFractionAt(page, point)

        await gesturePinch(page, point.x, point.y, [1.2])

        expect(await page.evaluate(() => window.layersApp._zoomMode)).toBe('200')
        const after = await canvasFractionAt(page, point)
        expect(Math.abs(after.fx - before.fx)).toBeLessThan(0.02)
        expect(Math.abs(after.fy - before.fy)).toBeLessThan(0.02)
    })

    test('pinch in at fit stays at fit', async ({ page }) => {
        const point = await visibleCanvasPoint(page)
        await gesturePinch(page, point.x, point.y, [0.8])

        expect(await page.evaluate(() => window.layersApp._zoomMode)).toBe('fit')
        // A later unrelated _applyZoom must not resurrect the discarded anchor.
        await page.evaluate(() => window.dispatchEvent(new Event('resize')))
        await page.waitForTimeout(50)
        expect(await page.evaluate(() => window.layersApp._pendingZoomAnchor)).toBeNull()
    })

    test('pinch during an active pointer mutation does not zoom', async ({ page }) => {
        // BrushTool.isDrawing is a getter-backed state, so swap in a stub tool
        // to simulate an active stroke.
        await page.evaluate(() => {
            window.layersApp._brushToolOrig = window.layersApp._brushTool
            window.layersApp._brushTool = { isDrawing: true }
        })
        try {
            const point = await visibleCanvasPoint(page)
            await gesturePinch(page, point.x, point.y, [1.3])
            expect(await page.evaluate(() => window.layersApp._zoomMode)).toBe('fit')
        } finally {
            await page.evaluate(() => {
                window.layersApp._brushTool = window.layersApp._brushToolOrig
                delete window.layersApp._brushToolOrig
            })
        }
    })

    test('gesture events without a prior gesturestart are ignored', async ({ page }) => {
        expect(await page.evaluate(() => window.layersApp._zoomMode)).toBe('fit')

        const point = await visibleCanvasPoint(page)
        await gesture(page, 'gesturechange', { scale: 2.5, x: point.x, y: point.y })

        expect(await page.evaluate(() => window.layersApp._zoomMode)).toBe('fit')
    })
})
