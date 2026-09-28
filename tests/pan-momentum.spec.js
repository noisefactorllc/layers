import { test, expect } from './fixtures.js'
import { defaultProjectReady } from './waits.js'
import { pausePlayback } from './helpers/new-project.js'

/**
 * Momentum (inertia) pan glide. A fast pan drag that ends with pointer
 * velocity hands off to an exponentially decaying scroll glide; any new
 * interaction over the panel (pointerdown, wheel, pinch) stops it, and a
 * slow drag release never glides.
 *
 * The gesture is driven by explicit synthetic PointerEvents (dispatch from
 * page.evaluate): automation input does not carry usable pointer-event
 * payload in every engine (WebKit CI synthesized pointer moves without
 * usable event data, so the glide never saw a valid sample window), while
 * the dispatch path is engine-identical and exercises the same PanTool
 * handlers the real input path uses.
 */
test.describe('Pan Momentum Glide', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('/', { waitUntil: 'networkidle' })
        await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })
        await defaultProjectReady(page)
        await pausePlayback(page)

        // Zoom in so the canvas overflows the panel and can be panned.
        await page.evaluate(() => window.layersApp._setZoom('200'))
        await page.waitForTimeout(100)
    })

    const POINTER_ID = 7

    async function centerScroll(page) {
        return page.evaluate(() => {
            const panel = document.getElementById('canvas-panel')
            panel.scrollLeft = panel.scrollWidth / 2
            panel.scrollTop = panel.scrollHeight / 2
            return { left: panel.scrollLeft, top: panel.scrollTop }
        })
    }

    async function dispatchPointer(page, type, x, y) {
        await page.evaluate(({ type, x, y, pointerId }) => {
            const panel = document.getElementById('canvas-panel')
            const rect = panel.getBoundingClientRect()
            panel.dispatchEvent(new PointerEvent(type, {
                bubbles: true,
                composed: true,
                pointerId,
                pointerType: 'mouse',
                isPrimary: true,
                button: type === 'pointermove' ? -1 : 0,
                buttons: type === 'pointerup' ? 0 : 1,
                clientX: rect.left + x,
                clientY: rect.top + y,
            }))
        }, { type, x, y, pointerId: POINTER_ID })
    }

    async function flickPan(page, dx, dy) {
        const box = await page.locator('#canvas-panel').boundingBox()
        const startX = box.width / 2
        const startY = box.height / 2

        await dispatchPointer(page, 'pointerdown', startX, startY)
        // Fast flick: several quick moves with small real waits so the
        // velocity sample window spans > 8ms with high pointer speed.
        const steps = 6
        for (let i = 1; i <= steps; i++) {
            await dispatchPointer(page, 'pointermove', startX + (dx * i) / steps, startY + (dy * i) / steps)
            await page.waitForTimeout(10)
        }
        await dispatchPointer(page, 'pointerup', startX + dx, startY + dy)
    }

    test('a fast flick glide continues scrolling after pointer release and decays', async ({ page }) => {
        await page.evaluate(() => window.layersApp._setToolMode('pan'))
        const start = await centerScroll(page)

        // Flick right => scrollLeft decreases (panning inverts pointer motion).
        await flickPan(page, 140, 0)

        // Glide is running and the panel keeps scrolling after release.
        await expect.poll(async () => page.evaluate(() => window.layersApp._panTool.isGliding))
            .toBe(true)
        const s1 = await page.evaluate(() => document.getElementById('canvas-panel').scrollLeft)
        expect(s1).toBeLessThan(start.left)

        // It decays and settles on its own.
        await expect.poll(async () => page.evaluate(() => window.layersApp._panTool.isGliding), {
            timeout: 5000,
            intervals: [100],
        }).toBe(false)
        const s2 = await page.evaluate(() => document.getElementById('canvas-panel').scrollLeft)
        expect(s2).toBeLessThanOrEqual(s1)
    })

    test('a new pointerdown over the panel stops the glide', async ({ page }) => {
        await page.evaluate(() => window.layersApp._setToolMode('pan'))
        await centerScroll(page)
        await flickPan(page, 140, 0)
        await expect.poll(async () => page.evaluate(() => window.layersApp._panTool.isGliding))
            .toBe(true)

        const box = await page.locator('#canvas-panel').boundingBox()
        await dispatchPointer(page, 'pointerdown', box.width / 2, box.height / 2)
        await dispatchPointer(page, 'pointerup', box.width / 2, box.height / 2)

        expect(await page.evaluate(() => window.layersApp._panTool.isGliding)).toBe(false)
    })

    test('a wheel event over the panel stops the glide', async ({ page }) => {
        await page.evaluate(() => window.layersApp._setToolMode('pan'))
        await centerScroll(page)
        await flickPan(page, 140, 0)
        await expect.poll(async () => page.evaluate(() => window.layersApp._panTool.isGliding))
            .toBe(true)

        await page.locator('#canvas-panel').hover({ position: { x: 200, y: 200 } })
        await page.mouse.wheel(0, 60)

        expect(await page.evaluate(() => window.layersApp._panTool.isGliding)).toBe(false)
    })

    test('a slow drag release does not glide', async ({ page }) => {
        await page.evaluate(() => window.layersApp._setToolMode('pan'))
        await centerScroll(page)

        // Slow drag: small moves spaced by real waits so the pointer speed
        // stays ~0.1 px/ms, below the glide threshold.
        await dispatchPointer(page, 'pointerdown', 400, 300)
        for (let i = 1; i <= 3; i++) {
            await dispatchPointer(page, 'pointermove', 400 - 15 * i, 300)
            await page.waitForTimeout(150)
        }
        await dispatchPointer(page, 'pointerup', 355, 300)

        const s1 = await page.evaluate(() => document.getElementById('canvas-panel').scrollLeft)
        await page.waitForTimeout(150)
        expect(await page.evaluate(() => window.layersApp._panTool.isGliding)).toBe(false)
        const s2 = await page.evaluate(() => document.getElementById('canvas-panel').scrollLeft)
        expect(s2).toBe(s1)
    })

    test('the glide clamps at the scroll bound and survives a tool switch until an interaction', async ({ page }) => {
        await page.evaluate(() => window.layersApp._setToolMode('pan'))
        // Pin the panel at its left bound, then flick right: the glide runs
        // but scrollLeft stays clamped at 0.
        await page.evaluate(() => {
            const panel = document.getElementById('canvas-panel')
            panel.scrollLeft = 0
            panel.scrollTop = panel.scrollHeight / 2
        })
        await flickPan(page, 140, 0)

        const clamped = await page.evaluate(() => document.getElementById('canvas-panel').scrollLeft)
        expect(clamped).toBe(0)

        // A tool switch alone does not throw off the glide machinery;
        // inertia is killed by the next interaction, not by tool state.
        await page.keyboard.press('b')
        expect(await page.evaluate(() => window.layersApp._currentTool)).toBe('brush')
        await page.waitForTimeout(100)
        expect(await page.evaluate(() => document.getElementById('canvas-panel').scrollLeft)).toBe(0)
    })
})
