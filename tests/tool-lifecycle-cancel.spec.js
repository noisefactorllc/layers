import { test, expect } from 'playwright/test'

async function bootSolid(page) {
    await page.goto('/', { waitUntil: 'networkidle' })
    await page.locator('#loading-screen').waitFor({ state: 'hidden' })
    const backdrop = page.locator('.open-dialog-backdrop.visible')
    await backdrop.waitFor()
    await page.locator('.media-option[data-type="solid"]').click()
    await page.locator('.canvas-size-dialog .action-btn.primary').click()
    await backdrop.waitFor({ state: 'hidden' })
}

async function drawingGestureState(page) {
    return page.evaluate(() => {
        const app = window.layersApp
        return {
            layerIds: app._layers.map(layer => layer.id),
            selectedLayerId: app._layerStack.selectedLayerId,
            dirty: app._isDirty,
            undoStackLength: app._undoManager._stack.length,
            undoIndex: app._undoManager._index,
        }
    })
}

test('window blur releases every active pointer-tool lifecycle lease', async ({ page }) => {
    await page.goto('/', { waitUntil: 'networkidle' })
    await page.locator('#loading-screen').waitFor({ state: 'hidden' })

    const result = await page.evaluate(async () => {
        const app = window.layersApp
        const { BrushTool } = await import('/js/tools/brush-tool.js')
        const { ShapeTool } = await import('/js/tools/shape-tool.js')
        const { EraserTool } = await import('/js/tools/eraser-tool.js')
        const { MoveTool } = await import('/js/tools/move-tool.js')
        const { TransformTool } = await import('/js/tools/transform-tool.js')
        const overlay = document.createElement('canvas')
        overlay.width = 200
        overlay.height = 200
        overlay.style.width = '200px'
        overlay.style.height = '200px'
        document.body.appendChild(overlay)
        const fireDown = () => {
            const rect = overlay.getBoundingClientRect()
            overlay.dispatchEvent(new MouseEvent('mousedown', {
                clientX: rect.left + 50,
                clientY: rect.top + 50,
                bubbles: true,
                button: 0,
            }))
        }
        const acquireMutation = (existing) => app._tryAcquireProjectLifecycle(existing)
        const drawingLayer = { sourceType: 'drawing', strokes: [] }
        const mediaLayer = { sourceType: 'media', offsetX: 0, offsetY: 0 }
        const tools = [
            new BrushTool({
                overlay,
                commitStroke: async () => {},
                acquireMutation,
            }),
            new ShapeTool({
                overlay,
                commitStroke: async () => {},
                acquireMutation,
            }),
            new EraserTool({
                overlay,
                getActiveLayer: () => drawingLayer,
                rasterizeDrawingLayer: async () => {},
                rebuild: async () => {},
                pushUndoState() {}, finalizePendingUndo() {}, markDirty() {},
                acquireMutation,
            }),
            new MoveTool({
                overlay,
                selectionManager: { hasSelection: () => false },
                getActiveLayer: () => mediaLayer,
                getSelectedLayers: () => ['media'],
                updateLayerPosition() {},
                getLayerPosition: () => ({ x: 0, y: 0 }),
                acquireMutation,
            }),
            new TransformTool({
                overlay,
                getActiveLayer: () => mediaLayer,
                getLayerBounds: () => ({ x: 25, y: 25, width: 100, height: 100, rotation: 0 }),
                applyTransform() {},
                acquireMutation,
            }),
        ]
        const outcomes = []
        for (const tool of tools) {
            tool.activate()
            fireDown()
            const acquired = app._projectLifecycleActive
            window.dispatchEvent(new Event('blur'))
            await new Promise(resolve => setTimeout(resolve, 0))
            outcomes.push({ acquired, released: !app._projectLifecycleActive })
            tool.deactivate()
        }
        overlay.remove()
        return outcomes
    })

    expect(result).toEqual(Array.from({ length: 5 }, () => ({
        acquired: true,
        released: true,
    })))
})

test('move pointer cancellation restores the starting position and history', async ({ page }) => {
    await bootSolid(page)

    const result = await page.evaluate(() => {
        const app = window.layersApp
        const layer = app._getActiveLayer()
        const state = () => ({
            offsetX: layer.offsetX,
            offsetY: layer.offsetY,
            dirty: app._isDirty,
            mutationRevision: app._projectMutationRevision,
            undoStackLength: app._undoManager._stack.length,
            undoIndex: app._undoManager._index,
            pendingUndo: Boolean(app._undoDebounceTimer),
        })
        const fireMouse = (type, x, y) => {
            const overlay = app._selectionOverlay
            const rect = overlay.getBoundingClientRect()
            overlay.dispatchEvent(new MouseEvent(type, {
                clientX: rect.left + x * rect.width / overlay.width,
                clientY: rect.top + y * rect.height / overlay.height,
                bubbles: true,
                button: 0,
            }))
        }
        app._setToolMode('move')
        const before = state()
        fireMouse('mousedown', 100, 100)
        fireMouse('mousemove', 160, 140)
        const during = state()
        app._selectionOverlay.dispatchEvent(new Event('pointercancel', { bubbles: true }))
        return {
            before,
            during,
            after: state(),
            lifecycleReleased: !app._projectLifecycleActive,
        }
    })

    expect(result.during.offsetX).not.toBe(result.before.offsetX)
    expect(result.after).toEqual(result.before)
    expect(result.lifecycleReleased).toBe(true)
})

for (const tool of ['brush', 'shape']) {
    test(`${tool} blur before commit leaves the project unchanged`, async ({ page }) => {
        await bootSolid(page)
        const before = await drawingGestureState(page)

        const lifecycle = await page.evaluate((toolName) => {
            const app = window.layersApp
            app._setToolMode(toolName)
            const overlay = app._selectionOverlay
            const rect = overlay.getBoundingClientRect()
            overlay.dispatchEvent(new MouseEvent('mousedown', {
                clientX: rect.left + 50,
                clientY: rect.top + 50,
                bubbles: true,
                button: 0,
            }))
            const acquired = app._projectLifecycleActive
            window.dispatchEvent(new Event('blur'))
            return { acquired, released: !app._projectLifecycleActive }
        }, tool)

        expect(lifecycle).toEqual({ acquired: true, released: true })
        expect(await drawingGestureState(page)).toEqual(before)
    })

    test(`${tool} ignores a duplicate down and releases lifecycle on up and cancel`, async ({ page }) => {
        await bootSolid(page)

        await page.evaluate((toolName) => {
            const app = window.layersApp
            app._setToolMode(toolName)
            const overlay = app._selectionOverlay
            const fireMouse = (type, x, y) => {
                const rect = overlay.getBoundingClientRect()
                overlay.dispatchEvent(new MouseEvent(type, {
                    clientX: rect.left + x * rect.width / overlay.width,
                    clientY: rect.top + y * rect.height / overlay.height,
                    bubbles: true,
                    button: 0,
                }))
            }
            fireMouse('mousedown', 50, 50)
            fireMouse('mousemove', 80, 80)
            fireMouse('mousedown', 120, 120)
            fireMouse('mousemove', 170, 150)
            fireMouse('mouseup', 170, 150)
        }, tool)

        await page.waitForFunction(() => {
            const app = window.layersApp
            const strokeCount = app._layers
                .filter(layer => layer.sourceType === 'drawing')
                .reduce((count, layer) => count + layer.strokes.length, 0)
            return strokeCount === 1 && !app._projectLifecycleActive
        })

        const afterUp = await page.evaluate((toolName) => {
            const app = window.layersApp
            const instance = toolName === 'brush' ? app._brushTool : app._shapeTool
            return {
                strokeCount: app._layers
                    .filter(layer => layer.sourceType === 'drawing')
                    .reduce((count, layer) => count + layer.strokes.length, 0),
                lifecycleReleased: !app._projectLifecycleActive,
                isDrawing: instance.isDrawing ?? instance._state === 'drawing',
            }
        }, tool)

        const afterCancel = await page.evaluate(async (toolName) => {
            const app = window.layersApp
            const overlay = app._selectionOverlay
            const instance = toolName === 'brush' ? app._brushTool : app._shapeTool
            const fireMouse = (type, x, y) => {
                const rect = overlay.getBoundingClientRect()
                overlay.dispatchEvent(new MouseEvent(type, {
                    clientX: rect.left + x * rect.width / overlay.width,
                    clientY: rect.top + y * rect.height / overlay.height,
                    bubbles: true,
                    button: 0,
                }))
            }
            fireMouse('mousedown', 30, 30)
            fireMouse('mousemove', 60, 60)
            fireMouse('mousedown', 100, 100)
            overlay.dispatchEvent(new Event('pointercancel', { bubbles: true }))
            await new Promise(resolve => setTimeout(resolve, 0))
            return {
                strokeCount: app._layers
                    .filter(layer => layer.sourceType === 'drawing')
                    .reduce((count, layer) => count + layer.strokes.length, 0),
                lifecycleReleased: !app._projectLifecycleActive,
                isDrawing: instance.isDrawing ?? instance._state === 'drawing',
            }
        }, tool)

        const afterDeactivate = await page.evaluate((toolName) => {
            const app = window.layersApp
            const overlay = app._selectionOverlay
            const instance = toolName === 'brush' ? app._brushTool : app._shapeTool
            const fireMouse = (type, x, y) => {
                const rect = overlay.getBoundingClientRect()
                overlay.dispatchEvent(new MouseEvent(type, {
                    clientX: rect.left + x * rect.width / overlay.width,
                    clientY: rect.top + y * rect.height / overlay.height,
                    bubbles: true,
                    button: 0,
                }))
            }
            fireMouse('mousedown', 40, 40)
            fireMouse('mousemove', 70, 70)
            fireMouse('mousedown', 110, 110)
            app._setToolMode('selection')
            return {
                strokeCount: app._layers
                    .filter(layer => layer.sourceType === 'drawing')
                    .reduce((count, layer) => count + layer.strokes.length, 0),
                lifecycleReleased: !app._projectLifecycleActive,
                isDrawing: instance.isDrawing ?? instance._state === 'drawing',
            }
        }, tool)

        expect(afterUp).toEqual({
            strokeCount: 1,
            lifecycleReleased: true,
            isDrawing: false,
        })
        expect(afterCancel).toEqual({
            strokeCount: 1,
            lifecycleReleased: true,
            isDrawing: false,
        })
        expect(afterDeactivate).toEqual({
            strokeCount: 1,
            lifecycleReleased: true,
            isDrawing: false,
        })
    })
}
