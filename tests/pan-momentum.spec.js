import { test, expect } from './fixtures.js'
import { defaultProjectReady } from './waits.js'
import { pausePlayback } from './helpers/new-project.js'

// Parallel mode makes each case its own sharding unit: every case here boots
// its own app and shares no state with its siblings, so shards can split this
// file instead of pinning all of it to one runner.
test.describe.configure({ mode: 'parallel' })

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

    // Dispatch an entire gesture inside a single page.evaluate, pacing the
    // moves with in-page timer awaits: the pointer-move spacing is then
    // page-clock based and immune to automation roundtrip latency (WebKit
    // evaluate roundtrips on CI are slow enough to dilute the measured
    // release speed below the glide threshold when each dispatch is its
    // own roundtrip).
    async function runGesture(page, moves, moveGapMs) {
        await page.evaluate(async ({ pointerId, moves, moveGapMs }) => {
            const panel = document.getElementById('canvas-panel')
            const rect = panel.getBoundingClientRect()
            const dispatch = (type, x, y, button, buttons) => {
                panel.dispatchEvent(new PointerEvent(type, {
                    bubbles: true,
                    composed: true,
                    pointerId,
                    pointerType: 'mouse',
                    isPrimary: true,
                    button,
                    buttons,
                    clientX: rect.left + x,
                    clientY: rect.top + y,
                }))
            }
            const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
            const [x0, y0] = moves[0]
            dispatch('pointerdown', x0, y0, 0, 1)
            for (let i = 1; i < moves.length; i++) {
                await wait(moveGapMs)
                dispatch('pointermove', moves[i][0], moves[i][1], -1, 1)
            }
            const [lx, ly] = moves[moves.length - 1]
            dispatch('pointerup', lx, ly, 0, 0)
        }, { pointerId: POINTER_ID, moves, moveGapMs })
    }

    async function flickPan(page, dx, dy) {
        const box = await page.locator('#canvas-panel').boundingBox()
        const startX = box.width / 2
        const startY = box.height / 2
        // Fast flick: 6 quick moves spaced 12ms in-page, high pointer speed.
        const moves = [[startX, startY]]
        const steps = 6
        for (let i = 1; i <= steps; i++) {
            moves.push([startX + (dx * i) / steps, startY + (dy * i) / steps])
        }
        await runGesture(page, moves, 12)
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
        const cx = box.width / 2
        const cy = box.height / 2
        await runGesture(page, [[cx, cy], [cx, cy]], 0)

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

        // Slow drag: small moves spaced 150ms in-page so the pointer speed
        // stays ~0.1 px/ms, below the glide threshold.
        await runGesture(page, [[400, 300], [385, 300], [370, 300], [355, 300]], 150)

        const s1 = await page.evaluate(() => document.getElementById('canvas-panel').scrollLeft)
        await page.waitForTimeout(150)
        expect(await page.evaluate(() => window.layersApp._panTool.isGliding)).toBe(false)
        const s2 = await page.evaluate(() => document.getElementById('canvas-panel').scrollLeft)
        expect(s2).toBe(s1)
    })

    test('the glide clamps at the scroll bound and survives a tool switch until an interaction', async ({ page }) => {
        await page.evaluate(() => window.layersApp._setToolMode('pan'))
        // Pin the panel at its left bound, then flick right: the glide runs
        // but scrollLeft stays clamped at 0. Pump two animation frames
        // first so any pending app-side zoom re-scroll lands before the
        // bound is pinned.
        await page.evaluate(() => {
            const panel = document.getElementById('canvas-panel')
            panel.scrollLeft = panel.scrollWidth / 2
            panel.scrollTop = panel.scrollHeight / 2
            return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
        })
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
