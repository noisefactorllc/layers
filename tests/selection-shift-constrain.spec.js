import { test, expect } from './fixtures.js'
import { appReady } from './waits.js'
import { reopenNewProjectDialog } from './helpers/new-project.js'

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

test.describe('Shift-Constrained Proportions & Axis Locking', () => {
    test('rectangular marquee drag with Shift creates exact 1:1 square', async ({ page }) => {
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

            // Drag down-right from (100, 100) to (260, 200) with Shift
            fire('mousedown', 100, 100, { shiftKey: true })
            fire('mousemove', 260, 200, { shiftKey: true })
            fire('mouseup', 260, 200, { shiftKey: true })

            const path = sm.selectionPath
            return {
                type: path?.type,
                x: path?.x,
                y: path?.y,
                width: path?.width,
                height: path?.height
            }
        })

        expect(result.type).toBe('rect')
        expect(result.width).toBeCloseTo(result.height, 4)
        expect(result.width).toBeGreaterThan(150)
        expect(Math.abs(result.x - 100)).toBeLessThan(5)
        expect(Math.abs(result.y - 100)).toBeLessThan(5)
    })

    test('oval marquee drag with Shift creates exact circle (rx === ry)', async ({ page }) => {
        await bootSolid(page)

        const result = await page.evaluate(() => {
            const app = window.layersApp
            const sm = app._selectionManager
            sm._enabled = true
            sm._currentTool = 'oval'

            const overlay = sm._overlay || document.getElementById('selectionOverlay')
            const rect = overlay.getBoundingClientRect()
            const sx = rect.width / overlay.width
            const sy = rect.height / overlay.height
            const fire = (type, cx, cy, mods = {}) => overlay.dispatchEvent(new MouseEvent(type, {
                clientX: rect.left + cx * sx,
                clientY: rect.top + cy * sy,
                bubbles: true, button: 0, ...mods
            }))

            fire('mousedown', 150, 150, { shiftKey: true })
            fire('mousemove', 270, 210, { shiftKey: true })
            fire('mouseup', 270, 210, { shiftKey: true })

            const path = sm.selectionPath
            return {
                type: path?.type,
                cx: path?.cx,
                cy: path?.cy,
                rx: path?.rx,
                ry: path?.ry
            }
        })

        expect(result.type).toBe('oval')
        expect(result.rx).toBeCloseTo(result.ry, 4)
        expect(result.rx).toBeGreaterThan(50)
    })

    test('mid-drag Shift keydown/keyup dynamically updates live preview and final selection', async ({ page }) => {
        await bootSolid(page)

        const sequence = await page.evaluate(() => {
            const app = window.layersApp
            const sm = app._selectionManager
            sm._enabled = true
            sm._currentTool = 'rectangle'

            const overlay = sm._overlay || document.getElementById('selectionOverlay')
            const rect = overlay.getBoundingClientRect()
            const sx = rect.width / overlay.width
            const sy = rect.height / overlay.height
            const fireMouse = (type, cx, cy, mods = {}) => overlay.dispatchEvent(new MouseEvent(type, {
                clientX: rect.left + cx * sx,
                clientY: rect.top + cy * sy,
                bubbles: true, button: 0, ...mods
            }))
            const fireKey = (type, key, mods = {}) => document.dispatchEvent(new KeyboardEvent(type, {
                key, bubbles: true, ...mods
            }))

            // 1. Start drag without shift
            fireMouse('mousedown', 100, 100)
            fireMouse('mousemove', 250, 180) // freeform rectangular aspect
            const step1Preview = { ...sm._selectionPath }

            // 2. Press Shift mid-drag
            fireKey('keydown', 'Shift', { shiftKey: true })
            const step2ShiftPressed = { ...sm._selectionPath }

            // 3. Release Shift mid-drag
            fireKey('keyup', 'Shift', { shiftKey: false })
            const step3ShiftReleased = { ...sm._selectionPath }

            // 4. Press Shift again and release mouse
            fireKey('keydown', 'Shift', { shiftKey: true })
            fireMouse('mouseup', 250, 180, { shiftKey: true })
            const finalSelection = sm.selectionPath

            return {
                step1Preview,
                step2ShiftPressed,
                step3ShiftReleased,
                finalSelection
            }
        })

        // Step 1: freeform rectangle (width != height)
        expect(sequence.step1Preview.width).not.toBeCloseTo(sequence.step1Preview.height, 1)

        // Step 2: Shift snaps to square
        expect(sequence.step2ShiftPressed.width).toBeCloseTo(sequence.step2ShiftPressed.height, 4)

        // Step 3: Shift release reverts to non-square
        expect(sequence.step3ShiftReleased.width).not.toBeCloseTo(sequence.step3ShiftReleased.height, 1)

        // Final: committed as 1:1 square
        expect(sequence.finalSelection.width).toBeCloseTo(sequence.finalSelection.height, 4)
    })

    test('Alt draws from center; Shift+Alt draws square from center', async ({ page }) => {
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

            // Alt only: start (200, 200), drag to (250, 230)
            fire('mousedown', 200, 200, { altKey: true })
            fire('mousemove', 250, 230, { altKey: true })
            fire('mouseup', 250, 230, { altKey: true })
            const altOnly = { ...sm.selectionPath }

            // Clear before the next gesture so it does not trigger intersect mode with prior selection
            sm.clearSelection()

            // Shift + Alt: start (200, 200), drag to (250, 230)
            fire('mousedown', 200, 200, { shiftKey: true, altKey: true })
            fire('mousemove', 250, 230, { shiftKey: true, altKey: true })
            fire('mouseup', 250, 230, { shiftKey: true, altKey: true })
            const shiftAlt = { ...sm.selectionPath }

            return { altOnly, shiftAlt }
        })

        // Alt only is centered at 200, 200 and not square
        expect(result.altOnly.width).not.toBeCloseTo(result.altOnly.height, 1)
        expect(Math.abs(result.altOnly.x + result.altOnly.width / 2 - 200)).toBeLessThan(5)
        expect(Math.abs(result.altOnly.y + result.altOnly.height / 2 - 200)).toBeLessThan(5)

        // Shift + Alt is centered at 200, 200 and exactly square
        expect(result.shiftAlt.width).toBeCloseTo(result.shiftAlt.height, 4)
        expect(Math.abs(result.shiftAlt.x + result.shiftAlt.width / 2 - 200)).toBeLessThan(5)
        expect(Math.abs(result.shiftAlt.y + result.shiftAlt.height / 2 - 200)).toBeLessThan(5)
    })

    test('MoveTool Shift-drag locks movement to dominant axis', async ({ page }) => {
        await bootSolid(page)

        const result = await page.evaluate(() => {
            const app = window.layersApp
            const moveTool = app._moveTool
            const layer = app._getActiveLayer()

            moveTool.activate()

            const overlay = moveTool._overlay
            const rect = overlay.getBoundingClientRect()
            const sx = rect.width / overlay.width
            const sy = rect.height / overlay.height
            const fire = (type, cx, cy, mods = {}) => overlay.dispatchEvent(new MouseEvent(type, {
                clientX: rect.left + cx * sx,
                clientY: rect.top + cy * sy,
                bubbles: true, button: 0, ...mods
            }))

            let recordedUpdates = []
            moveTool._updateLayerPosition = (x, y) => {
                recordedUpdates.push({ x, y })
            }

            // Start drag at (200, 200)
            moveTool._startDrag({ x: 200, y: 200 }, layer)
            // Horizontal dominant drag: client coords corresponding to (300, 230) -> dx = 100, dy = 30
            fire('mousemove', 300, 230, { shiftKey: true })
            const hResult = recordedUpdates[recordedUpdates.length - 1]

            // Reset and start vertical dominant drag: (200, 200) to (225, 290) -> dx = 25, dy = 90
            moveTool._reset()
            moveTool._startDrag({ x: 200, y: 200 }, layer)
            fire('mousemove', 225, 290, { shiftKey: true })
            const vResult = recordedUpdates[recordedUpdates.length - 1]

            moveTool.deactivate()

            return {
                layerStartX: moveTool._getLayerPosition(layer).x,
                layerStartY: moveTool._getLayerPosition(layer).y,
                hResult,
                vResult
            }
        })

        // In horizontal dominant drag (dx=100, dy=30 with shift), dy is locked to 0
        expect(Math.abs(result.hResult.y - result.layerStartY)).toBeLessThan(0.001)
        expect(result.hResult.x).toBeGreaterThan(result.layerStartX + 90)

        // In vertical dominant drag (dx=25, dy=90 with shift), dx is locked to 0
        expect(Math.abs(result.vResult.x - result.layerStartX)).toBeLessThan(0.001)
        expect(result.vResult.y).toBeGreaterThan(result.layerStartY + 80)
    })

    test('TransformTool Shift-scaling preserves layer aspect ratio on corner handle drag', async ({ page }) => {
        await bootSolid(page)

        const result = await page.evaluate(() => {
            const app = window.layersApp
            const tt = app._transformTool
            const layer = app._getActiveLayer()

            // Set up layer with non-1:1 aspect ratio: scaleX = 2, scaleY = 1
            layer.scaleX = 2
            layer.scaleY = 1
            layer.rotation = 0

            tt._active = true
            tt._state = 1 // State.DRAGGING
            tt._activeHandle = 'bottom-right'
            tt._dragStart = { x: 300, y: 200 }
            tt._startBounds = { x: 100, y: 100, width: 200, height: 100, rotation: 0 }
            tt._startTransform = { offsetX: 0, offsetY: 0, scaleX: 2, scaleY: 1, rotation: 0 }

            let applied = null
            tt._applyTransform = (t) => { applied = t }

            // Drag bottom-right corner with Shift held
            tt._handleScaleDrag({ x: 350, y: 225 }, { shiftKey: true })

            return {
                appliedScaleX: applied?.scaleX,
                appliedScaleY: applied?.scaleY,
                ratio: applied ? (applied.scaleX / applied.scaleY) : null
            }
        })

        // Original ratio was 2:1 (scaleX = 2, scaleY = 1)
        // With Shift-constrained proportions, scaleX / scaleY should remain exactly 2.0
        expect(result.ratio).toBeCloseTo(2.0, 4)
    })

    test('ShapeTool Shift-drag constrains rectangle to square and ellipse to circle', async ({ page }) => {
        await bootSolid(page)

        const result = await page.evaluate(() => {
            const app = window.layersApp
            const shapeTool = app._shapeTool

            shapeTool.activate()
            shapeTool.shapeType = 'rect'

            const overlay = shapeTool._overlay
            const rect = overlay.getBoundingClientRect()
            const sx = rect.width / overlay.width
            const sy = rect.height / overlay.height
            const fire = (type, cx, cy, mods = {}) => overlay.dispatchEvent(new MouseEvent(type, {
                clientX: rect.left + cx * sx,
                clientY: rect.top + cy * sy,
                bubbles: true, button: 0, ...mods
            }))

            fire('mousedown', 100, 100)
            fire('mousemove', 240, 170, { shiftKey: true })
            const constrainedRect = {
                w: Math.abs(shapeTool._currentPt.x - shapeTool._startPt.x),
                h: Math.abs(shapeTool._currentPt.y - shapeTool._startPt.y)
            }

            shapeTool.shapeType = 'ellipse'
            fire('mousemove', 200, 310, { shiftKey: true })
            const constrainedEllipse = {
                w: Math.abs(shapeTool._currentPt.x - shapeTool._startPt.x),
                h: Math.abs(shapeTool._currentPt.y - shapeTool._startPt.y)
            }

            shapeTool.deactivate()

            return {
                constrainedRect,
                constrainedEllipse
            }
        })

        expect(Math.abs(result.constrainedRect.w - result.constrainedRect.h)).toBeLessThan(0.001)
        expect(result.constrainedRect.w).toBeGreaterThan(130)
        expect(Math.abs(result.constrainedEllipse.w - result.constrainedEllipse.h)).toBeLessThan(0.001)
        expect(result.constrainedEllipse.w).toBeGreaterThan(200)
    })
})
