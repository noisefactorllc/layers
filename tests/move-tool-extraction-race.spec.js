import { test, expect } from 'playwright/test'

// Regression test: if the user releases the mouse while an async selection
// extraction (or non-destructive duplicate) is still in flight, the move tool
// swallowed the mouseup and then unconditionally started a drag when the
// extraction resolved — leaving the layer "stuck" to the cursor with no button
// held. A pending-pointer-up flag must complete the gesture instead of dragging.

test('mouseup during extraction does not leave the layer following the cursor', async ({ page }) => {
    await page.goto('/', { waitUntil: 'networkidle' })
    await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })

    const result = await page.evaluate(async () => {
        const { MoveTool } = await import('/js/tools/move-tool.js')

        let resolveExtract
        const extractSelection = () => new Promise(r => { resolveExtract = r })
        let positionUpdates = 0

        const overlay = document.createElement('canvas')
        overlay.width = 200
        overlay.height = 200
        document.body.appendChild(overlay)

        const tool = new MoveTool({
            overlay,
            selectionManager: { hasSelection: () => true },
            getActiveLayer: () => ({ id: 'l1', offsetX: 0, offsetY: 0 }),
            getSelectedLayers: () => [{ id: 'l1' }],
            updateLayerPosition: () => { positionUpdates++ },
            getLayerPosition: () => ({ x: 0, y: 0 }),
            extractSelection,
            onComplete: () => {}
        })
        tool.activate()

        const fire = (type, x, y) => overlay.dispatchEvent(
            new MouseEvent(type, { clientX: x, clientY: y, bubbles: true, button: 0 }))

        fire('mousedown', 20, 20)          // -> EXTRACTING (extraction pending)
        const stateAfterDown = tool._state

        fire('mouseup', 20, 20)            // released BEFORE extraction resolves
        resolveExtract(true)               // extraction now completes
        await new Promise(r => setTimeout(r, 0)) // let the async chain settle

        const stateAfterResolve = tool._state

        fire('mousemove', 120, 120)        // cursor moves with no button held
        const updatesAfterMove = positionUpdates

        tool.deactivate()
        overlay.remove()
        return { stateAfterDown, stateAfterResolve, updatesAfterMove }
    })

    expect(result.stateAfterDown).toBe('extracting')
    expect(result.stateAfterResolve).not.toBe('dragging')
    expect(result.updatesAfterMove).toBe(0)
})
