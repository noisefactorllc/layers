import { test, expect } from 'playwright/test'

// Regression: brush/shape _onMouseUp cleared instance gesture state
// (_currentPoints / _startPt / _currentPt) AFTER awaiting the rasterize +
// rebuild. If a new gesture began during that await window, the resolving
// mouseup clobbered the new stroke's in-progress state, losing it and making
// the next mousemove dereference undefined (TypeError). The handler must
// capture its own state into locals and clear instance state before awaiting.

test('brush: a stroke started during the previous stroke\'s rebuild is not clobbered', async ({ page }) => {
    await page.goto('/', { waitUntil: 'networkidle' })
    await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })

    const result = await page.evaluate(async () => {
        const { BrushTool } = await import('/js/tools/brush-tool.js')

        let resolveRebuild
        const rebuild = () => new Promise(r => { resolveRebuild = r })
        const layer = { strokes: [] }
        let owner = null
        const acquireMutation = (existing) => {
            if (owner && existing === owner && !owner.released) {
                owner.references += 1
                return owner
            }
            if (owner && !owner.released) return null
            owner = {
                released: false,
                references: 1,
                release() {
                    this.references -= 1
                    if (this.references === 0) this.released = true
                }
            }
            return owner
        }

        const overlay = document.createElement('canvas')
        overlay.width = 200; overlay.height = 200
        document.body.appendChild(overlay)

        const tool = new BrushTool({
            overlay,
            ensureDrawingLayer: () => layer,
            rasterizeDrawingLayer: () => Promise.resolve(),
            rebuild,
            pushUndoState: () => {},
            finalizePendingUndo: () => {},
            markDirty: () => {},
            acquireMutation
        })
        tool.activate()
        const fire = (type, x, y) => overlay.dispatchEvent(
            new MouseEvent(type, { clientX: x, clientY: y, bubbles: true, button: 0 }))

        // Stroke 1 — mouseup suspends at the held rebuild await.
        fire('mousedown', 10, 10)
        fire('mousemove', 30, 30)
        fire('mouseup', 30, 30)
        await new Promise(r => setTimeout(r, 0))

        // Stroke 2 begins during stroke 1's rebuild window.
        fire('mousedown', 100, 100)
        const pointsAfterStroke2Down = tool._currentPoints.length

        // Stroke 1's rebuild resolves and its mouseup continuation runs.
        resolveRebuild()
        await new Promise(r => setTimeout(r, 0))

        const out = {
            pointsAfterStroke2Down,
            pointsAfterResolve: tool._currentPoints.length,
            stateAfterResolve: tool._state,
            stroke1Committed: layer.strokes.length
        }
        tool.deactivate()
        overlay.remove()
        return out
    })

    expect(result.pointsAfterStroke2Down).toBe(1)
    expect(result.stroke1Committed).toBe(1)           // stroke 1 still finishes
    expect(result.stateAfterResolve).toBe('drawing')  // stroke 2 still active
    expect(result.pointsAfterResolve).toBe(1)         // stroke 2 NOT clobbered
})

test('shape: a shape started during the previous shape\'s rebuild is not clobbered', async ({ page }) => {
    await page.goto('/', { waitUntil: 'networkidle' })
    await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })

    const result = await page.evaluate(async () => {
        const { ShapeTool } = await import('/js/tools/shape-tool.js')

        let resolveRebuild
        const rebuild = () => new Promise(r => { resolveRebuild = r })
        const layer = { strokes: [] }
        let owner = null
        const acquireMutation = (existing) => {
            if (owner && existing === owner && !owner.released) {
                owner.references += 1
                return owner
            }
            if (owner && !owner.released) return null
            owner = {
                released: false,
                references: 1,
                release() {
                    this.references -= 1
                    if (this.references === 0) this.released = true
                }
            }
            return owner
        }

        const overlay = document.createElement('canvas')
        overlay.width = 200; overlay.height = 200
        document.body.appendChild(overlay)

        const tool = new ShapeTool({
            overlay,
            ensureDrawingLayer: () => layer,
            rasterizeDrawingLayer: () => Promise.resolve(),
            rebuild,
            pushUndoState: () => {},
            finalizePendingUndo: () => {},
            markDirty: () => {},
            acquireMutation
        })
        tool.activate()
        const fire = (type, x, y) => overlay.dispatchEvent(
            new MouseEvent(type, { clientX: x, clientY: y, bubbles: true, button: 0 }))

        fire('mousedown', 10, 10)
        fire('mousemove', 40, 40)
        fire('mouseup', 40, 40)
        await new Promise(r => setTimeout(r, 0))

        fire('mousedown', 100, 100)
        const startPtSetForStroke2 = tool._startPt !== null

        resolveRebuild()
        await new Promise(r => setTimeout(r, 0))

        const out = {
            startPtSetForStroke2,
            startPtAfterResolve: tool._startPt !== null,
            stateAfterResolve: tool._state,
            stroke1Committed: layer.strokes.length
        }
        tool.deactivate()
        overlay.remove()
        return out
    })

    expect(result.startPtSetForStroke2).toBe(true)
    expect(result.stroke1Committed).toBe(1)
    expect(result.stateAfterResolve).toBe('drawing')
    expect(result.startPtAfterResolve).toBe(true)     // stroke 2 NOT clobbered
})
