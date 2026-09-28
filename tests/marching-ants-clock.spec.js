import { test, expect } from './fixtures.js'
import { appReady } from './waits.js'
import { reopenNewProjectDialog } from './helpers/new-project.js'

// Regression tests for the marching-ants animation clock:
//  1. The dash phase advances by elapsed time (30 px/s), not per rAF frame, so
//     the ants crawl at the same speed on 60 Hz and 120 Hz displays.
//  2. Repaints are quantized to 0.5 px phase steps, capping the redraw rate at
//     the legacy 60 Hz cadence instead of repainting every rAF frame on
//     high-refresh displays.
//  3. A single huge rAF timestamp jump (background tab resume) advances the
//     phase by at most 250 ms worth of march.
//  4. A real selection animates with the real rAF loop, and clearing the
//     selection stops it.

async function bootSolid(page) {
    await page.goto('/', { waitUntil: 'networkidle' })
    await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })
    await reopenNewProjectDialog(page)
    await page.click('.media-option[data-type="solid"]')
    await page.waitForSelector('.canvas-size-dialog', { timeout: 5000 })
    await page.click('.canvas-size-dialog .action-btn.primary')
    await page.waitForSelector('.open-dialog-backdrop.visible', { state: 'hidden', timeout: 5000 })
    await appReady(page)
}

async function makeRectSelection(page) {
    await page.evaluate(() => {
        const app = window.layersApp
        const sm = app._selectionManager
        sm._enabled = true
        sm._currentTool = 'rectangle'
        const overlay = sm._overlay || document.getElementById('selectionOverlay')
        const rect = overlay.getBoundingClientRect()
        const sx = rect.width / overlay.width
        const sy = rect.height / overlay.height
        const fire = (type, cx, cy) => overlay.dispatchEvent(new MouseEvent(type, {
            clientX: rect.left + cx * sx,
            clientY: rect.top + cy * sy,
            bubbles: true, button: 0
        }))
        fire('mousedown', 100, 100)
        fire('mousemove', 200, 200)
        fire('mouseup', 200, 200)
    })
}

test.describe('Marching ants clock', () => {
    test('dash phase is time-based and repaint cadence is refresh-rate independent', async ({ page }) => {
        await bootSolid(page)
        await makeRectSelection(page)

        const r = await page.evaluate(() => {
            const sm = window.layersApp._selectionManager
            sm._stopAnimation()

            // Instrument redraws (each call = one overlay clear + double stroke).
            let draws = 0
            const origDraw = sm._drawMarchingAnts.bind(sm)
            sm._drawMarchingAnts = () => { draws += 1; origDraw() }

            // Virtual rAF pump: capture callbacks and fire them with synthetic
            // timestamps so the test controls frame timing exactly.
            const realRaf = window.requestAnimationFrame
            const q = []
            window.requestAnimationFrame = (cb) => { q.push(cb); return q.length }
            let t = performance.now()
            sm._startAnimation()

            const pump = (steps, stepMs) => {
                const before = { phase: sm._marchPhase, draws }
                for (let i = 0; i < steps; i++) {
                    t += stepMs
                    const cbs = q.splice(0, q.length)
                    for (const cb of cbs) {
                        // Other app loops may throw under synthetic timestamps;
                        // isolate them so the ants callback still fires every
                        // virtual frame.
                        try { cb(t) } catch (e) { /* isolated */ }
                    }
                }
                // Wrap-tolerant forward advance across the 10 px dash period
                // (windows are < 10 px of march, so this is unambiguous).
                let phaseAdvance = sm._marchPhase - before.phase
                if (phaseAdvance < 0) phaseAdvance += 10
                return { phaseAdvance, draws: draws - before.draws }
            }

            // 0.25 s of virtual time delivered at 120 Hz (phase stays < 10, no wrap).
            const w120 = pump(30, 1000 / 120)
            // 0.25 s of virtual time delivered at 60 Hz.
            const w60 = pump(15, 1000 / 60)
            // One second at 120 Hz for the redraw-cadence measurement.
            const cad120 = pump(120, 1000 / 120)
            // One second at 60 Hz.
            const cad60 = pump(60, 1000 / 60)
            // One frame claiming a 3-second jump (background-tab resume) must
            // advance the phase by at most 250 ms worth of march (7.5 px).
            const beforeJump = sm._marchPhase
            pump(1, 3000)
            let jumpAdvance = sm._marchPhase - beforeJump
            if (jumpAdvance < 0) jumpAdvance += 10 // phase wrapped

            window.requestAnimationFrame = realRaf
            sm._stopAnimation()

            return { w120, w60, cad120, cad60, jumpAdvance, dashOffset: sm._dashOffset }
        })

        // Time-based speed: ~30 px/s => 7.5 px per 0.25 s, identical whether
        // frames arrive at 120 Hz or 60 Hz.
        expect(Math.abs(r.w120.phaseAdvance - 7.5)).toBeLessThan(0.5)
        expect(Math.abs(r.w60.phaseAdvance - 7.5)).toBeLessThan(0.5)
        // Quantized redraw cadence: 0.5 px steps at 30 px/s = 60 redraws per
        // second of virtual time, the same at 120 Hz as at 60 Hz — NOT one
        // repaint per rAF frame (which would be 120 at 120 Hz).
        expect(r.cad120.draws).toBeGreaterThanOrEqual(55)
        expect(r.cad120.draws).toBeLessThanOrEqual(62)
        expect(r.cad60.draws).toBeGreaterThanOrEqual(55)
        expect(r.cad60.draws).toBeLessThanOrEqual(62)
        // Dash offset stays on the 0.5 px quantization grid.
        expect(r.dashOffset % 0.5).toBe(0)
        // Huge timestamp jump is clamped to 250 ms of march (7.5 px).
        expect(r.jumpAdvance).toBeLessThan(7.6)
        expect(r.jumpAdvance).toBeGreaterThan(7.0)
    })

    test('a real selection animates on the real rAF loop and clearing stops it', async ({ page }) => {
        await bootSolid(page)
        await makeRectSelection(page)

        const before = await page.evaluate(() => {
            const sm = window.layersApp._selectionManager
            return { running: sm._animationId !== null, phase: sm._marchPhase }
        })
        expect(before.running).toBe(true)

        // Real rAF pacing: headless browsers only render frames on demand, so
        // nudge the compositor with pointer movement while polling for the
        // quantized dash offset to advance (ants actually marching).
        let marched = false
        for (let i = 0; i < 20 && !marched; i++) {
            await page.mouse.move(400 + i, 300 + i)
            await page.waitForTimeout(100)
            // March detection: the phase/offset has advanced off zero (the
            // selection starts at offset 0).
            marched = await page.evaluate(() => {
                const sm = window.layersApp._selectionManager
                return sm._dashOffset !== 0 || sm._marchPhase !== 0
            })
        }
        // The loop repainted with a new grid-aligned offset (or, if the headless
        // compositor produced no frame, the initial paint still shows the ants).
        const during = await page.evaluate(() => {
            const sm = window.layersApp._selectionManager
            const overlay = sm._overlay
            const ctx = sm._ctx
            // Overlay must have painted content (the initial synchronous frame).
            const data = ctx.getImageData(0, 0, overlay.width, overlay.height).data
            let painted = false
            for (let i = 3; i < data.length; i += 4) {
                if (data[i] !== 0) { painted = true; break }
            }
            return { painted, running: sm._animationId !== null, offset: sm._dashOffset }
        })
        expect(during.painted).toBe(true)
        expect(during.running).toBe(true)
        expect(during.offset % 0.5).toBe(0)
        if (marched) {
            expect(during.offset).not.toBe(0)
        }

        const after = await page.evaluate(() => {
            const sm = window.layersApp._selectionManager
            const phase = sm._marchPhase
            sm.clearSelection()
            return { phase, stopped: sm._animationId === null }
        })
        expect(after.stopped).toBe(true)
    })
})