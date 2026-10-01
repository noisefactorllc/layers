import { test, expect } from './fixtures.js'
import { appReady } from './waits.js'
import { reopenNewProjectDialog } from './helpers/new-project.js'

// Regression tests for two selection-manager defects:
//  1. rect/oval/lasso mousedown cleared the existing selection BEFORE capturing
//     _previousSelection, so shift-add / alt-subtract starting outside the
//     current selection silently downgraded to replace (prior selection lost).
//  2. an emptied subtract nulled _selectionPath but still started the
//     marching-ants rAF loop, leaving a permanent 60fps no-op.

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

test.describe('Selection add/subtract', () => {
    test('shift-drag adds to the existing selection instead of replacing it', async ({ page }) => {
        await bootSolid(page)

        const result = await page.evaluate(() => {
            const app = window.layersApp
            const sm = app._selectionManager
            sm._enabled = true
            sm._currentTool = 'rectangle'

            const overlay = sm._overlay || document.getElementById('selectionOverlay')
            const rect = overlay.getBoundingClientRect()
            const sx = rect.width / overlay.width
            const sy = rect.height / overlay.height
            const fire = (type, cx, cy, mods = {}) => overlay.dispatchEvent(new MouseEvent(type, {
                clientX: rect.left + cx * sx,
                clientY: rect.top + cy * sy,
                bubbles: true, button: 0, ...mods
            }))

            // First selection: rect (100,100)-(200,200), no modifier.
            fire('mousedown', 100, 100)
            fire('mousemove', 200, 200)
            fire('mouseup', 200, 200)
            const firstHas = sm.hasSelection()

            // Second selection with SHIFT (add): disjoint rect (300,300)-(400,400).
            fire('mousedown', 300, 300, { shiftKey: true })
            fire('mousemove', 400, 400, { shiftKey: true })
            fire('mouseup', 400, 400, { shiftKey: true })

            return {
                firstHas,
                coversFirst: sm._isPointInSelection(150, 150),  // original region retained?
                coversSecond: sm._isPointInSelection(350, 350)  // newly added region
            }
        })

        expect(result.firstHas).toBe(true)
        expect(result.coversFirst).toBe(true)
        expect(result.coversSecond).toBe(true)
    })

    test('sub-minimum drag in add mode keeps the prior selection', async ({ page }) => {
        await bootSolid(page)

        const result = await page.evaluate(() => {
            const app = window.layersApp
            const sm = app._selectionManager
            sm._enabled = true
            sm._currentTool = 'rectangle'

            const overlay = sm._overlay || document.getElementById('selectionOverlay')
            const rect = overlay.getBoundingClientRect()
            const sx = rect.width / overlay.width
            const sy = rect.height / overlay.height
            const fire = (type, cx, cy, mods = {}) => overlay.dispatchEvent(new MouseEvent(type, {
                clientX: rect.left + cx * sx,
                clientY: rect.top + cy * sy,
                bubbles: true, button: 0, ...mods
            }))

            // Existing selection: rect (100,100)-(200,200), no modifier.
            fire('mousedown', 100, 100)
            fire('mousemove', 200, 200)
            fire('mouseup', 200, 200)
            const firstHas = sm.hasSelection()

            // Sub-minimum drag (2x2 px) with SHIFT (add): must add nothing but
            // keep the prior selection, not wipe it.
            fire('mousedown', 300, 300, { shiftKey: true })
            fire('mousemove', 302, 302, { shiftKey: true })
            fire('mouseup', 302, 302, { shiftKey: true })

            return {
                firstHas,
                keptAfterTinyAdd: sm.hasSelection() && sm._isPointInSelection(150, 150),
                antsRunning: sm._animationId !== null
            }
        })

        expect(result.firstHas).toBe(true)
        expect(result.keptAfterTinyAdd).toBe(true)
        expect(result.antsRunning).toBe(true)
    })

    test('sub-minimum drag in subtract mode keeps the prior selection', async ({ page }) => {
        await bootSolid(page)

        const result = await page.evaluate(() => {
            const app = window.layersApp
            const sm = app._selectionManager
            sm._enabled = true
            sm._currentTool = 'rectangle'

            const overlay = sm._overlay || document.getElementById('selectionOverlay')
            const rect = overlay.getBoundingClientRect()
            const sx = rect.width / overlay.width
            const sy = rect.height / overlay.height
            const fire = (type, cx, cy, mods = {}) => overlay.dispatchEvent(new MouseEvent(type, {
                clientX: rect.left + cx * sx,
                clientY: rect.top + cy * sy,
                bubbles: true, button: 0, ...mods
            }))

            fire('mousedown', 100, 100)
            fire('mousemove', 200, 200)
            fire('mouseup', 200, 200)

            // Sub-minimum drag with ALT (subtract): removes nothing, keeps prior.
            fire('mousedown', 120, 120, { altKey: true })
            fire('mousemove', 120.5, 120.5, { altKey: true })
            fire('mouseup', 120.5, 120.5, { altKey: true })

            return {
                keptAfterTinySubtract: sm.hasSelection() && sm._isPointInSelection(150, 150),
                antsRunning: sm._animationId !== null
            }
        })

        expect(result.keptAfterTinySubtract).toBe(true)
        expect(result.antsRunning).toBe(true)
    })

    test('sub-minimum drag in replace mode still clears the selection', async ({ page }) => {
        await bootSolid(page)

        const result = await page.evaluate(() => {
            const app = window.layersApp
            const sm = app._selectionManager
            sm._enabled = true
            sm._currentTool = 'rectangle'

            const overlay = sm._overlay || document.getElementById('selectionOverlay')
            const rect = overlay.getBoundingClientRect()
            const sx = rect.width / overlay.width
            const sy = rect.height / overlay.height
            const fire = (type, cx, cy, mods = {}) => overlay.dispatchEvent(new MouseEvent(type, {
                clientX: rect.left + cx * sx,
                clientY: rect.top + cy * sy,
                bubbles: true, button: 0, ...mods
            }))

            fire('mousedown', 100, 100)
            fire('mousemove', 200, 200)
            fire('mouseup', 200, 200)
            const firstHas = sm.hasSelection()

            // Replace-mode click on empty canvas deselects (unchanged behavior).
            fire('mousedown', 300, 300)
            fire('mousemove', 302, 302)
            fire('mouseup', 302, 302)

            return {
                firstHas,
                clearedAfterTinyReplace: !sm.hasSelection(),
                antsStopped: sm._animationId === null
            }
        })

        expect(result.firstHas).toBe(true)
        expect(result.clearedAfterTinyReplace).toBe(true)
        expect(result.antsStopped).toBe(true)
    })

    test('zero-movement lasso click in add mode keeps the prior selection', async ({ page }) => {
        await bootSolid(page)

        const result = await page.evaluate(() => {
            const app = window.layersApp
            const sm = app._selectionManager
            sm._enabled = true
            sm._currentTool = 'rectangle'

            const overlay = sm._overlay || document.getElementById('selectionOverlay')
            const rect = overlay.getBoundingClientRect()
            const sx = rect.width / overlay.width
            const sy = rect.height / overlay.height
            const fire = (type, cx, cy, mods = {}) => overlay.dispatchEvent(new MouseEvent(type, {
                clientX: rect.left + cx * sx,
                clientY: rect.top + cy * sy,
                bubbles: true, button: 0, ...mods
            }))

            fire('mousedown', 100, 100)
            fire('mousemove', 200, 200)
            fire('mouseup', 200, 200)
            const firstHas = sm.hasSelection()

            // Zero-movement lasso click in add mode: no path is ever drawn, so
            // nothing is added — the prior selection must survive with ants running.
            sm._currentTool = 'lasso'
            fire('mousedown', 150, 150, { shiftKey: true })
            fire('mouseup', 150, 150, { shiftKey: true })

            return {
                firstHas,
                keptAfterLassoClick: sm.hasSelection() && sm._isPointInSelection(150, 150),
                antsRunning: sm._animationId !== null
            }
        })

        expect(result.firstHas).toBe(true)
        expect(result.keptAfterLassoClick).toBe(true)
        expect(result.antsRunning).toBe(true)
    })

    test('emptying a selection via subtract does not leave a running animation', async ({ page }) => {
        await bootSolid(page)

        const animationId = await page.evaluate(() => {
            const app = window.layersApp
            const sm = app._selectionManager
            // Directly exercise the guard: starting the marching-ants loop with no
            // selection path must be a no-op, not a perpetual rAF.
            sm._selectionPath = null
            sm._startAnimation()
            const id = sm._animationId
            sm._stopAnimation() // clean up if the loop did start (buggy path)
            return id
        })

        expect(animationId).toBe(null)
    })
})
