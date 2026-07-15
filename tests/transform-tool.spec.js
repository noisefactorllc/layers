import { test, expect } from 'playwright/test'

async function createTransparentProject(page) {
    await page.waitForSelector('.open-dialog-backdrop.visible')
    await page.click('.media-option[data-type="transparent"]')
    await page.waitForSelector('.canvas-size-dialog', { timeout: 5000 })
    await page.click('.canvas-size-dialog .action-btn.primary')
    await page.waitForSelector('.open-dialog-backdrop.visible', { state: 'hidden', timeout: 5000 })
    await page.waitForTimeout(500)
}

async function addColorLayer(page, color, size = 100) {
    await page.evaluate(async ({ color, size }) => {
        const canvas = document.createElement('canvas')
        canvas.width = size
        canvas.height = size
        const ctx = canvas.getContext('2d')
        ctx.fillStyle = color
        ctx.fillRect(0, 0, size, size)
        const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'))
        const file = new File([blob], 'test.png', { type: 'image/png' })
        await window.layersApp._handleAddMediaLayer(file, 'image')
    }, { color, size })
    await page.waitForTimeout(500)
}

test.describe('Transform tool', () => {
    test('transform tool button exists and activates', async ({ page }) => {
        await page.goto('/', { waitUntil: 'networkidle' })
        await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })
        await createTransparentProject(page)
        await addColorLayer(page, 'red')

        const transformBtn = await page.$('#transformToolBtn')
        expect(transformBtn).not.toBeNull()

        await page.click('#transformToolBtn')

        const isActive = await page.evaluate(() => {
            return document.getElementById('transformToolBtn').classList.contains('active')
        })
        expect(isActive).toBe(true)
    })

    test('T key activates transform tool', async ({ page }) => {
        await page.goto('/', { waitUntil: 'networkidle' })
        await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })
        await createTransparentProject(page)
        await addColorLayer(page, 'red')

        await page.keyboard.press('t')

        const isActive = await page.evaluate(() => {
            return document.getElementById('transformToolBtn').classList.contains('active')
        })
        expect(isActive).toBe(true)
    })

    test('Escape returns to selection tool', async ({ page }) => {
        await page.goto('/', { waitUntil: 'networkidle' })
        await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })
        await createTransparentProject(page)
        await addColorLayer(page, 'red')

        // Activate transform tool
        await page.click('#transformToolBtn')
        await page.waitForTimeout(200)

        // Verify transform tool is active
        const isTransformActive = await page.evaluate(() => {
            return document.getElementById('transformToolBtn').classList.contains('active')
        })
        expect(isTransformActive).toBe(true)

        // Press Escape — should return to selection tool
        await page.keyboard.press('Escape')
        await page.waitForTimeout(200)

        const isSelectionActive = await page.evaluate(() => {
            return document.getElementById('selectionToolBtn').classList.contains('active')
        })
        expect(isSelectionActive).toBe(true)

        const isTransformDeactivated = await page.evaluate(() => {
            return !document.getElementById('transformToolBtn').classList.contains('active')
        })
        expect(isTransformDeactivated).toBe(true)
    })

    test('Escape during a drag restores the starting transform and history', async ({ page }) => {
        await page.goto('/', { waitUntil: 'networkidle' })
        await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })
        await createTransparentProject(page)
        await addColorLayer(page, 'red')

        const result = await page.evaluate(() => {
            const app = window.layersApp
            const layer = app._getActiveLayer()
            const state = () => ({
                offsetX: layer.offsetX,
                offsetY: layer.offsetY,
                scaleX: layer.scaleX,
                scaleY: layer.scaleY,
                rotation: layer.rotation,
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
            app._setToolMode('transform')
            const before = state()
            fireMouse('mousedown', 512, 512)
            fireMouse('mousemove', 562, 537)
            const during = state()
            document.dispatchEvent(new KeyboardEvent('keydown', {
                key: 'Escape', bubbles: true,
            }))
            return {
                before,
                during,
                after: state(),
                lifecycleReleased: !app._projectLifecycleActive,
                tool: app._currentTool,
            }
        })

        expect(result.during.offsetX).not.toBe(result.before.offsetX)
        expect(result.after).toEqual(result.before)
        expect(result.lifecycleReleased).toBe(true)
        expect(result.tool).toBe('selection')
    })

    test('effect layers cannot enter transform mode or record invisible transforms', async ({ page }) => {
        await page.goto('/', { waitUntil: 'networkidle' })
        await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })
        await createTransparentProject(page)

        const before = await page.evaluate(() => {
            const app = window.layersApp
            const layer = app._getActiveLayer()
            return {
                tool: app._currentTool,
                offsetX: layer.offsetX,
                scaleX: layer.scaleX,
                rotation: layer.rotation,
            }
        })
        await page.click('#transformToolBtn')
        const after = await page.evaluate(() => {
            const app = window.layersApp
            const layer = app._getActiveLayer()
            app._applyLayerTransform({ offsetX: 25, scaleX: 2, rotation: 30 })
            return {
                tool: app._currentTool,
                offsetX: layer.offsetX,
                scaleX: layer.scaleX,
                rotation: layer.rotation,
                transformActive: document.getElementById('transformToolBtn')
                    .classList.contains('active'),
            }
        })

        expect(after).toEqual({ ...before, transformActive: false })
    })

    test('drawing layers apply transform-tool changes to their live raster', async ({ page }) => {
        await page.goto('/', { waitUntil: 'networkidle' })
        await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })
        await createTransparentProject(page)
        const layerId = await page.evaluate(async () => {
            await window.LayersAgent.ready
            const painted = await window.LayersAgent.paintStroke({
                points: [[10, 10], [50, 50], [100, 100]],
                size: 5,
                color: '#ff0000',
            })
            return painted.result.layerId
        })
        await page.click('#transformToolBtn')

        const result = await page.evaluate((layerId) => {
            const app = window.layersApp
            const media = app._renderer.getMediaInfo(layerId)
            app._applyLayerTransform({ scaleX: 0.5, scaleY: 0.5 })
            return {
                tool: app._currentTool,
                sourceSize: [media.width, media.height],
                transformedSize: media.transformCanvas
                    ? [media.transformCanvas.width, media.transformCanvas.height]
                    : null,
            }
        }, layerId)

        expect(result.tool).toBe('transform')
        expect(result.transformedSize).toEqual([
            Math.ceil(result.sourceSize[0] * 0.5),
            Math.ceil(result.sourceSize[1] * 0.5),
        ])
    })

    test('transform tool rejects oversized rasters before allocation or history changes', async ({ page }) => {
        await page.goto('/', { waitUntil: 'networkidle' })
        await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })
        await createTransparentProject(page)
        await addColorLayer(page, 'red', 1024)

        const result = await page.evaluate(() => {
            const app = window.layersApp
            const layer = app._getActiveLayer()
            const before = {
                scaleX: layer.scaleX,
                scaleY: layer.scaleY,
                undoLength: app._undoManager._stack.length,
                undoIndex: app._undoManager._index,
                dirty: app._isDirty,
            }
            let drawCalls = 0
            app._renderer._drawTransformedMediaFrame = () => {
                drawCalls++
                const canvas = document.createElement('canvas')
                canvas.width = 1
                canvas.height = 1
                return canvas
            }
            app._applyLayerTransform({ scaleX: 100, scaleY: 100 })
            return {
                drawCalls,
                before,
                after: {
                    scaleX: layer.scaleX,
                    scaleY: layer.scaleY,
                    undoLength: app._undoManager._stack.length,
                    undoIndex: app._undoManager._index,
                    dirty: app._isDirty,
                },
            }
        })

        expect(result.drawCalls).toBe(0)
        expect(result.after).toEqual(result.before)
    })

    test('backward compatibility: layers without transform fields use defaults', async ({ page }) => {
        await page.goto('/', { waitUntil: 'networkidle' })
        await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })
        await createTransparentProject(page)
        await addColorLayer(page, 'red', 200)

        // Select the media layer
        await page.evaluate(() => {
            const layers = window.layersApp._layers
            const topLayer = layers[layers.length - 1]
            window.layersApp._layerStack.selectedLayerId = topLayer.id
        })
        await page.waitForTimeout(200)

        // Delete all transform fields to simulate an old project layer
        await page.evaluate(() => {
            const layer = window.layersApp._getActiveLayer()
            delete layer.scaleX
            delete layer.scaleY
            delete layer.rotation
            delete layer.flipH
            delete layer.flipV
        })

        // Verify the ?? defaults work — _getLayerBounds should still return valid bounds
        const bounds = await page.evaluate(() => {
            const layer = window.layersApp._getActiveLayer()
            return window.layersApp._getLayerBounds(layer)
        })

        expect(bounds).not.toBeNull()
        expect(bounds.width).toBeGreaterThan(0)
        expect(bounds.height).toBeGreaterThan(0)
        expect(bounds.rotation).toBe(0)

        // Verify _updateTransformRender works with missing fields (uses ?? defaults)
        const noError = await page.evaluate(() => {
            try {
                const layer = window.layersApp._getActiveLayer()
                window.layersApp._updateTransformRender(layer)
                return true
            } catch (e) {
                return false
            }
        })
        expect(noError).toBe(true)

        // Verify the layer fields are still absent (not auto-created)
        const fieldsAbsent = await page.evaluate(() => {
            const layer = window.layersApp._getActiveLayer()
            return {
                hasScaleX: 'scaleX' in layer,
                hasScaleY: 'scaleY' in layer,
                hasRotation: 'rotation' in layer,
                hasFlipH: 'flipH' in layer,
                hasFlipV: 'flipV' in layer,
            }
        })
        expect(fieldsAbsent.hasScaleX).toBe(false)
        expect(fieldsAbsent.hasScaleY).toBe(false)
        expect(fieldsAbsent.hasRotation).toBe(false)
        expect(fieldsAbsent.hasFlipH).toBe(false)
        expect(fieldsAbsent.hasFlipV).toBe(false)
    })

    test('undo reverses flip horizontal', async ({ page }) => {
        await page.goto('/', { waitUntil: 'networkidle' })
        await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })
        await createTransparentProject(page)
        await addColorLayer(page, 'green', 200)

        // Select the media layer
        await page.evaluate(() => {
            const layers = window.layersApp._layers
            const topLayer = layers[layers.length - 1]
            window.layersApp._layerStack.selectedLayerId = topLayer.id
        })
        await page.waitForTimeout(200)

        // Ensure starting state: flipH is false
        await page.evaluate(() => {
            const layer = window.layersApp._getActiveLayer()
            layer.flipH = false
        })

        // Flip horizontally via the app method
        await page.evaluate(() => window.layersApp._flipActiveLayer('horizontal'))
        await page.waitForTimeout(200)

        // Verify flipH is now true
        const flipHAfterFlip = await page.evaluate(() => {
            return window.layersApp._getActiveLayer().flipH
        })
        expect(flipHAfterFlip).toBe(true)

        // Undo with Cmd+Z
        await page.keyboard.press('Meta+z')
        await page.waitForTimeout(800) // wait for debounce + restore

        // Verify flipH is back to false
        const flipHAfterUndo = await page.evaluate(() => {
            return window.layersApp._getActiveLayer()?.flipH || false
        })
        expect(flipHAfterUndo).toBe(false)
    })

    test('dragging edge handle changes layer scale', async ({ page }) => {
        await page.goto('/', { waitUntil: 'networkidle' })
        await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })
        await createTransparentProject(page)
        await addColorLayer(page, 'blue', 200)

        // Select the media layer
        await page.evaluate(() => {
            const layers = window.layersApp._layers
            const topLayer = layers[layers.length - 1]
            window.layersApp._layerStack.selectedLayerId = topLayer.id
        })
        await page.waitForTimeout(200)

        // Activate transform tool
        await page.click('#transformToolBtn')
        await page.waitForTimeout(300)

        // Get initial scale values
        const initialScale = await page.evaluate(() => {
            const layer = window.layersApp._getActiveLayer()
            return { scaleX: layer.scaleX ?? 1, scaleY: layer.scaleY ?? 1 }
        })

        // Programmatically simulate a drag on the RIGHT edge handle.
        // We use the right-edge handle (at the midpoint of the right side)
        // because corner handles overlap with rotation zones in hit testing.
        const dragResult = await page.evaluate(() => {
            const overlay = document.getElementById('selectionOverlay')
            const rect = overlay.getBoundingClientRect()
            const tool = window.layersApp._transformTool
            const layer = window.layersApp._getActiveLayer()
            const bounds = window.layersApp._getLayerBounds(layer)

            // RIGHT edge handle in canvas coords: (bounds.x + width, bounds.y + height/2)
            const handleCanvasX = bounds.x + bounds.width
            const handleCanvasY = bounds.y + bounds.height / 2

            // Convert canvas coords to client coords
            const ratioX = rect.width / overlay.width
            const ratioY = rect.height / overlay.height
            const handleClientX = rect.left + handleCanvasX * ratioX
            const handleClientY = rect.top + handleCanvasY * ratioY

            // Verify hit test
            const hitResult = tool._hitTest({ x: handleCanvasX, y: handleCanvasY })

            // Drag rightward by 50 canvas pixels
            const dragDistCanvas = 50
            const dragDistClient = dragDistCanvas * ratioX

            overlay.dispatchEvent(new MouseEvent('mousedown', {
                clientX: handleClientX, clientY: handleClientY, bubbles: true
            }))

            const stateAfterDown = tool._state

            overlay.dispatchEvent(new MouseEvent('mousemove', {
                clientX: handleClientX + dragDistClient,
                clientY: handleClientY,
                bubbles: true
            }))
            overlay.dispatchEvent(new MouseEvent('mouseup', {
                clientX: handleClientX + dragDistClient,
                clientY: handleClientY,
                bubbles: true
            }))

            return {
                hitResult,
                toolActive: tool._active,
                stateAfterDown
            }
        })
        await page.waitForTimeout(300)

        // Verify tool was active and found the right edge handle
        expect(dragResult.toolActive).toBe(true)
        expect(dragResult.stateAfterDown).toBe('dragging')
        expect(dragResult.hitResult).toBe('right')

        // Check that scaleX changed (right edge drag only affects horizontal scale)
        const afterRightDrag = await page.evaluate(() => {
            const layer = window.layersApp._getActiveLayer()
            return { scaleX: layer.scaleX ?? 1, scaleY: layer.scaleY ?? 1 }
        })

        expect(afterRightDrag.scaleX).toBeGreaterThan(initialScale.scaleX)

        // Now drag the BOTTOM edge handle to test scaleY
        const dragResult2 = await page.evaluate(() => {
            const overlay = document.getElementById('selectionOverlay')
            const rect = overlay.getBoundingClientRect()
            const tool = window.layersApp._transformTool
            const layer = window.layersApp._getActiveLayer()
            const bounds = window.layersApp._getLayerBounds(layer)

            // BOTTOM edge handle: (bounds.x + width/2, bounds.y + height)
            const handleCanvasX = bounds.x + bounds.width / 2
            const handleCanvasY = bounds.y + bounds.height

            const ratioX = rect.width / overlay.width
            const ratioY = rect.height / overlay.height
            const handleClientX = rect.left + handleCanvasX * ratioX
            const handleClientY = rect.top + handleCanvasY * ratioY

            const hitResult = tool._hitTest({ x: handleCanvasX, y: handleCanvasY })

            const dragDistClient = 50 * ratioY

            overlay.dispatchEvent(new MouseEvent('mousedown', {
                clientX: handleClientX, clientY: handleClientY, bubbles: true
            }))
            overlay.dispatchEvent(new MouseEvent('mousemove', {
                clientX: handleClientX, clientY: handleClientY + dragDistClient, bubbles: true
            }))
            overlay.dispatchEvent(new MouseEvent('mouseup', {
                clientX: handleClientX, clientY: handleClientY + dragDistClient, bubbles: true
            }))

            return { hitResult, stateAfterDown: tool._state }
        })
        await page.waitForTimeout(300)

        expect(dragResult2.hitResult).toBe('bottom')

        const afterBottomDrag = await page.evaluate(() => {
            const layer = window.layersApp._getActiveLayer()
            return { scaleX: layer.scaleX ?? 1, scaleY: layer.scaleY ?? 1 }
        })

        expect(afterBottomDrag.scaleY).toBeGreaterThan(initialScale.scaleY)
    })
})
