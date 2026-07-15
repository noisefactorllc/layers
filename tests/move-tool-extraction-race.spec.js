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

test('pointer cancellation during extraction leaves the project unchanged', async ({ page }) => {
    await page.goto('/', { waitUntil: 'networkidle' })
    await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })
    await page.click('.media-option[data-type="solid"]')
    await page.waitForSelector('.canvas-size-dialog', { timeout: 5000 })
    await page.click('.canvas-size-dialog .action-btn.primary')
    await page.waitForSelector('.open-dialog-backdrop.visible', {
        state: 'hidden', timeout: 5000,
    })

    const result = await page.evaluate(async () => {
        const app = window.layersApp
        app._selectionManager.setSelection({
            type: 'rect', x: 100, y: 100, width: 100, height: 100,
        })
        app._setToolMode('move')
        const before = JSON.stringify(app._layers)
        const beforeResources = [...app._renderer._mediaTextures.keys()]
        const prepareMediaResource = app._renderer.prepareMediaResource.bind(app._renderer)
        let prepareStarted = false
        let releasePrepare
        app._renderer.prepareMediaResource = async (...args) => {
            if (!prepareStarted) {
                prepareStarted = true
                await new Promise(resolve => { releasePrepare = resolve })
            }
            return prepareMediaResource(...args)
        }

        const overlay = app._selectionOverlay
        const rect = overlay.getBoundingClientRect()
        overlay.dispatchEvent(new MouseEvent('mousedown', {
            clientX: rect.left + 150 * rect.width / overlay.width,
            clientY: rect.top + 150 * rect.height / overlay.height,
            bubbles: true,
            button: 0,
        }))
        while (!prepareStarted) await new Promise(resolve => setTimeout(resolve, 0))
        overlay.dispatchEvent(new Event('pointercancel', { bubbles: true }))
        releasePrepare()
        while (app._projectLifecycleActive) {
            await new Promise(resolve => setTimeout(resolve, 0))
        }
        return {
            before,
            after: JSON.stringify(app._layers),
            beforeResources,
            afterResources: [...app._renderer._mediaTextures.keys()],
            toolState: app._moveTool._state,
        }
    })

    expect(result.after).toBe(result.before)
    expect(result.afterResources).toEqual(result.beforeResources)
    expect(result.toolState).toBe('idle')
})

test('pointer cancellation during an in-flight whole-layer clone leaves the project unchanged', async ({ page }) => {
    await page.goto('/', { waitUntil: 'networkidle' })
    await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })
    await page.click('.media-option[data-type="solid"]')
    await page.waitForSelector('.canvas-size-dialog', { timeout: 5000 })
    await page.click('.canvas-size-dialog .action-btn.primary')
    await page.waitForSelector('.open-dialog-backdrop.visible', {
        state: 'hidden', timeout: 5000,
    })

    const result = await page.evaluate(async () => {
        const app = window.layersApp
        app._selectionManager.clearSelection()
        app._setToolMode('clone')
        const before = JSON.stringify(app._layers)
        const beforeResources = [...app._renderer._mediaTextures.keys()]
        const beforeUndoLength = app._undoManager._stack.length
        const beforeUndoIndex = app._undoManager._index
        const prepareMediaResource = app._renderer.prepareMediaResource.bind(app._renderer)
        let prepareStarted = false
        let releasePrepare
        app._renderer.prepareMediaResource = async (...args) => {
            if (!prepareStarted) {
                prepareStarted = true
                await new Promise(resolve => { releasePrepare = resolve })
            }
            return prepareMediaResource(...args)
        }

        const overlay = app._selectionOverlay
        const rect = overlay.getBoundingClientRect()
        overlay.dispatchEvent(new MouseEvent('mousedown', {
            clientX: rect.left + rect.width / 2,
            clientY: rect.top + rect.height / 2,
            bubbles: true,
            button: 0,
        }))
        while (!prepareStarted) await new Promise(resolve => setTimeout(resolve, 0))
        overlay.dispatchEvent(new Event('pointercancel', { bubbles: true }))
        releasePrepare()
        while (app._projectLifecycleActive) {
            await new Promise(resolve => setTimeout(resolve, 0))
        }
        return {
            before,
            after: JSON.stringify(app._layers),
            beforeResources,
            afterResources: [...app._renderer._mediaTextures.keys()],
            beforeUndoLength,
            afterUndoLength: app._undoManager._stack.length,
            beforeUndoIndex,
            afterUndoIndex: app._undoManager._index,
            toolState: app._cloneTool._state,
        }
    })

    expect(result.after).toBe(result.before)
    expect(result.afterResources).toEqual(result.beforeResources)
    expect(result.afterUndoLength).toBe(result.beforeUndoLength)
    expect(result.afterUndoIndex).toBe(result.beforeUndoIndex)
    expect(result.toolState).toBe('idle')
})
