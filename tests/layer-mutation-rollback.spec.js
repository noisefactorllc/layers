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

const cases = [
    { name: 'human media addition', operation: 'human-media', agent: false, resource: true },
    { name: 'human fill canvas addition', operation: 'human-fill', agent: false, resource: true },
    { name: 'human effect addition', operation: 'human-effect', agent: false, resource: false },
    { name: 'agent media addition', operation: 'agent-media', agent: true, resource: true },
    { name: 'agent effect addition', operation: 'agent-effect', agent: true, resource: false },
    { name: 'agent drawing addition', operation: 'agent-drawing', agent: true, resource: false },
    { name: 'agent fill canvas addition', operation: 'agent-fill', agent: true, resource: true },
    { name: 'human brush commit', operation: 'brush', agent: false, resource: true },
    { name: 'human shape commit', operation: 'shape', agent: false, resource: true },
]

for (const entry of cases) {
    test(`${entry.name} rolls back when renderer compilation fails`, async ({ page }) => {
        await bootSolid(page)

        const result = await page.evaluate(async ({ operation }) => {
            const app = window.layersApp
            const renderer = app._renderer

            const drawGesture = async (toolName, offset) => {
                app._setToolMode(toolName)
                const tool = app[`_${toolName}Tool`]
                const rect = app._selectionOverlay.getBoundingClientRect()
                const event = (type, x, y) => new MouseEvent(type, {
                    clientX: rect.left + x,
                    clientY: rect.top + y,
                    bubbles: true,
                    button: 0,
                })
                tool._onMouseDown(event('mousedown', offset, offset))
                tool._onMouseMove(event('mousemove', offset + 80, offset + 60))
                await tool._onMouseUp(event('mouseup', offset + 80, offset + 60))
            }

            // Brush rollback must restore an existing drawing texture, not only
            // remove a resource belonging to a newly-created drawing layer.
            if (operation === 'brush') await drawGesture('brush', 30)

            app._markClean()
            const state = () => ({
                layers: app._layers.map(layer => ({
                    id: layer.id,
                    sourceType: layer.sourceType,
                    strokeIds: (layer.strokes || []).map(stroke => stroke.id),
                })),
                rendererLayerIds: renderer.layers.map(layer => layer.id),
                resourceIds: [...renderer._mediaTextures.keys()].sort(),
                selectedLayerIds: app._layerStack.selectedLayerIds,
                selectionAnchor: app._layerStack._lastClickedLayerId,
                dirty: app._isDirty,
                mutationRevision: app._projectMutationRevision,
                drawingLayerCounter: app._drawingLayerCounter,
                undoStackLength: app._undoManager._stack.length,
                undoIndex: app._undoManager._index,
            })
            const before = state()
            const previousResources = new Map(renderer._mediaTextures)

            const { toast } = await import('/js/ui/toast.js')
            let successToasts = 0
            toast.success = () => { successToasts += 1 }

            const candidateResources = []
            const disposedResources = new Set()
            const prepareMediaResource = renderer.prepareMediaResource.bind(renderer)
            renderer.prepareMediaResource = async (...args) => {
                const resource = await prepareMediaResource(...args)
                candidateResources.push(resource)
                return resource
            }
            const prepareCanvasMediaResource = renderer.prepareCanvasMediaResource.bind(renderer)
            renderer.prepareCanvasMediaResource = (...args) => {
                const resource = prepareCanvasMediaResource(...args)
                candidateResources.push(resource)
                return resource
            }
            const disposeMediaResource = renderer.disposeMediaResource.bind(renderer)
            renderer.disposeMediaResource = (resource) => {
                disposedResources.add(resource)
                return disposeMediaResource(resource)
            }

            const rebuildNow = renderer._rebuildNow.bind(renderer)
            let injectedFailures = 0
            renderer._rebuildNow = async (...args) => {
                if (injectedFailures++ === 0) {
                    return { success: false, error: 'injected compile failure' }
                }
                return rebuildNow(...args)
            }

            let outcome = null
            let envelope = null
            if (operation === 'human-effect') {
                outcome = await app._handleAddEffectLayer('synth/gradient')
            } else if (operation === 'human-media') {
                const blob = await (await fetch('/img/og-image.png')).blob()
                const file = new File([blob], 'failed-human.png', { type: 'image/png' })
                outcome = await app._handleAddMediaLayer(file, 'image')
            } else if (operation === 'human-fill') {
                const canvas = document.createElement('canvas')
                canvas.width = 20
                canvas.height = 10
                outcome = await app._addMediaLayerFromCanvas(canvas, 'Failed fill')
            } else if (operation === 'agent-effect') {
                envelope = await window.LayersAgent.addLayer({
                    kind: 'effect', effectId: 'synth/gradient', name: 'Failed effect'
                })
            } else if (operation === 'agent-drawing') {
                envelope = await window.LayersAgent.addLayer({
                    kind: 'drawing', name: 'Failed drawing'
                })
            } else if (operation === 'agent-media') {
                envelope = await window.LayersAgent.addLayer({
                    kind: 'media',
                    mediaType: 'image',
                    name: 'failed-agent.png',
                    source: {
                        kind: 'base64',
                        data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
                        mimeType: 'image/png'
                    }
                })
            } else if (operation === 'agent-fill') {
                envelope = await window.LayersAgent.fillRegion({
                    x: 10, y: 10, color: '#ff0000', tolerance: 32
                })
            } else {
                await drawGesture(operation, 140)
            }

            const resourcesRestored = previousResources.size === renderer._mediaTextures.size
                && [...previousResources].every(([id, resource]) =>
                    renderer.getMediaInfo(id) === resource)
            return {
                before,
                after: state(),
                outcomeStatus: outcome?.status || null,
                envelope,
                successToasts,
                injectedFailures,
                resourcesRestored,
                candidateResourceCount: candidateResources.length,
                allCandidateResourcesDisposed: candidateResources.length > 0
                    && candidateResources.every(resource => disposedResources.has(resource)),
            }
        }, { operation: entry.operation })

        expect(result.injectedFailures).toBeGreaterThanOrEqual(1)
        expect(result.after).toEqual(result.before)
        expect(result.resourcesRestored).toBe(true)
        expect(result.successToasts).toBe(0)
        if (entry.resource) {
            expect(result.candidateResourceCount).toBeGreaterThan(0)
            expect(result.allCandidateResourcesDisposed).toBe(true)
        }
        if (entry.agent) {
            expect(result.envelope.ok).toBe(false)
            expect(result.envelope.error.code).toBe('INTERNAL_ERROR')
        } else if (entry.operation.startsWith('human-')) {
            expect(result.outcomeStatus).toBe('failed')
        }
    })
}

test('successful effect addition survives a success-toast exception', async ({ page }) => {
    await bootSolid(page)

    const result = await page.evaluate(async () => {
        const app = window.layersApp
        app._markClean()
        const before = {
            layerCount: app._layers.length,
            undoStackLength: app._undoManager._stack.length,
            undoIndex: app._undoManager._index,
        }
        const { toast } = await import('/js/ui/toast.js')
        toast.success = () => { throw new Error('injected success toast failure') }

        const outcome = await app._handleAddEffectLayer('synth/gradient')
        return {
            before,
            outcome: { status: outcome.status, layerId: outcome.layerId || null },
            layerIds: app._layers.map(layer => layer.id),
            rendererLayerIds: app._renderer.layers.map(layer => layer.id),
            selectedLayerId: app._layerStack.selectedLayerId,
            dirty: app._isDirty,
            undoStackLength: app._undoManager._stack.length,
            undoIndex: app._undoManager._index,
        }
    })

    expect(result.outcome.status).toBe('added')
    expect(result.layerIds).toHaveLength(result.before.layerCount + 1)
    expect(result.rendererLayerIds).toEqual(result.layerIds)
    expect(result.outcome.layerId).toBe(result.layerIds[result.layerIds.length - 1])
    expect(result.selectedLayerId).toBe(result.outcome.layerId)
    expect(result.dirty).toBe(true)
    expect(result.undoStackLength).toBe(result.before.undoStackLength + 1)
    expect(result.undoIndex).toBe(result.before.undoIndex + 1)
})

test('successful auto correction survives a success-toast exception', async ({ page }) => {
    await bootSolid(page)

    const result = await page.evaluate(async () => {
        const app = window.layersApp
        const beforeLayerCount = app._layers.length
        const handleAutoCorrection = app._handleAutoCorrection.bind(app)
        app._handleAutoCorrection = () => handleAutoCorrection(() => ({
            effectId: 'filter/adjust',
            name: 'Deterministic correction',
            effectParams: { brightness: 0.1 },
        }))
        const { toast } = await import('/js/ui/toast.js')
        toast.success = () => { throw new Error('injected correction toast failure') }

        const envelope = await window.LayersAgent.autoLevels()
        return {
            envelope,
            beforeLayerCount,
            layerIds: app._layers.map(layer => layer.id),
            rendererLayerIds: app._renderer.layers.map(layer => layer.id),
            correction: app._layers.at(-1)?.name,
        }
    })

    expect(result.envelope.ok).toBe(true)
    expect(result.envelope.result.applied).toBe(true)
    expect(result.layerIds).toHaveLength(result.beforeLayerCount + 1)
    expect(result.rendererLayerIds).toEqual(result.layerIds)
    expect(result.correction).toBe('Deterministic correction')
})

const drawingMutationFailures = [
    { name: 'agent paintStroke', operation: 'agent-paint', agent: true },
    { name: 'agent drawShape with an auto-created layer', operation: 'agent-shape', agent: true },
    { name: 'agent eraseStroke', operation: 'agent-erase', agent: true },
    { name: 'agent clearDrawingLayer', operation: 'agent-clear', agent: true },
    { name: 'human eraser', operation: 'human-eraser', agent: false },
]

for (const entry of drawingMutationFailures) {
    test(`${entry.name} restores exact drawing state when rebuild fails`, async ({ page }) => {
        await bootSolid(page)

        const result = await page.evaluate(async ({ operation }) => {
            const app = window.layersApp
            const renderer = app._renderer
            const baseline = await window.LayersAgent.paintStroke({
                points: [[40, 40], [120, 80]],
                size: 12,
                color: '#ff0000',
            })
            const layerId = baseline.result.layerId
            const strokeId = baseline.result.strokeId
            const layer = app._layers.find(candidate => candidate.id === layerId)

            if (operation === 'agent-shape') {
                const effectLayer = app._layers.find(candidate =>
                    candidate.sourceType === 'effect')
                app._layerStack.selectedLayerId = effectLayer.id
            } else {
                app._layerStack.selectedLayerId = layerId
            }
            if (operation === 'human-eraser') app._setToolMode('eraser')
            app._markClean()

            const layersArray = app._layers
            const layerObject = layer
            const strokesArray = layer.strokes
            const drawingCanvas = layer.drawingCanvas
            const resource = renderer.getMediaInfo(layerId)
            const serializableModel = () => JSON.stringify(app._layers, (key, value) => {
                if (key === 'drawingCanvas' || key === 'mediaFile' || key === 'mask') {
                    return undefined
                }
                return value
            })
            const state = () => ({
                model: serializableModel(),
                rendererLayerIds: renderer.layers.map(candidate => candidate.id),
                resourceIds: [...renderer._mediaTextures.keys()].sort(),
                selectedLayerIds: app._layerStack.selectedLayerIds,
                selectionAnchor: app._layerStack._lastClickedLayerId,
                dirty: app._isDirty,
                mutationRevision: app._projectMutationRevision,
                drawingLayerCounter: app._drawingLayerCounter,
                undoStackLength: app._undoManager._stack.length,
                undoIndex: app._undoManager._index,
                pendingUndo: Boolean(app._undoDebounceTimer),
            })
            const before = state()

            const candidateResources = []
            const disposedResources = new Set()
            const prepareCanvasMediaResource =
                renderer.prepareCanvasMediaResource.bind(renderer)
            renderer.prepareCanvasMediaResource = (...args) => {
                const candidate = prepareCanvasMediaResource(...args)
                candidateResources.push(candidate)
                return candidate
            }
            const disposeMediaResource = renderer.disposeMediaResource.bind(renderer)
            renderer.disposeMediaResource = (candidate) => {
                disposedResources.add(candidate)
                return disposeMediaResource(candidate)
            }

            const rebuild = app._rebuild.bind(app)
            let rebuildCalls = 0
            app._rebuild = (...args) => {
                if (rebuildCalls++ === 0) {
                    return Promise.resolve({
                        success: false,
                        error: 'injected drawing rebuild failure',
                    })
                }
                return rebuild(...args)
            }

            let envelope = null
            if (operation === 'agent-paint') {
                envelope = await window.LayersAgent.paintStroke({
                    layerId,
                    points: [[160, 100], [220, 140]],
                    size: 8,
                    color: '#00ff00',
                })
            } else if (operation === 'agent-shape') {
                envelope = await window.LayersAgent.drawShape({
                    shape: 'rect',
                    x: 180,
                    y: 120,
                    width: 60,
                    height: 40,
                    size: 4,
                    color: '#0000ff',
                })
            } else if (operation === 'agent-erase') {
                envelope = await window.LayersAgent.eraseStroke({ layerId, strokeId })
            } else if (operation === 'agent-clear') {
                envelope = await window.LayersAgent.clearDrawingLayer({ layerId })
            } else {
                const tool = app._eraserTool
                const overlay = app._selectionOverlay
                const rect = overlay.getBoundingClientRect()
                const event = (type, x, y) => new MouseEvent(type, {
                    clientX: rect.left + x * rect.width / overlay.width,
                    clientY: rect.top + y * rect.height / overlay.height,
                    bubbles: true,
                    button: 0,
                })
                tool._onMouseDown(event('mousedown', 60, 50))
                tool._onMouseUp(event('mouseup', 60, 50))
                while (app._projectLifecycleActive) {
                    await new Promise(resolve => setTimeout(resolve, 10))
                }
            }

            const currentLayer = app._layers.find(candidate => candidate.id === layerId)
            return {
                before,
                after: state(),
                envelope,
                rebuildCalls,
                lifecycleReleased: !app._projectLifecycleActive,
                sameLayersArray: app._layers === layersArray,
                sameLayerObject: currentLayer === layerObject,
                sameStrokesArray: currentLayer?.strokes === strokesArray,
                sameDrawingCanvas: currentLayer?.drawingCanvas === drawingCanvas,
                sameResource: renderer.getMediaInfo(layerId) === resource,
                candidateResourceCount: candidateResources.length,
                allCandidateResourcesDisposed: candidateResources.every(candidate =>
                    disposedResources.has(candidate)),
            }
        }, { operation: entry.operation })

        expect(result.rebuildCalls).toBeGreaterThanOrEqual(2)
        expect(result.after).toEqual(result.before)
        expect(result.lifecycleReleased).toBe(true)
        expect(result.sameLayersArray).toBe(true)
        expect(result.sameLayerObject).toBe(true)
        expect(result.sameStrokesArray).toBe(true)
        expect(result.sameDrawingCanvas).toBe(true)
        expect(result.sameResource).toBe(true)
        expect(result.allCandidateResourcesDisposed).toBe(true)
        if (entry.agent) {
            expect(result.envelope.ok).toBe(false)
            expect(result.envelope.error.code).toBe('INTERNAL_ERROR')
        }
    })
}

test('drawing rollback re-arms a pending undo and later records only its preexisting change', async ({ page }) => {
    await bootSolid(page)

    const result = await page.evaluate(async () => {
        const app = window.layersApp
        const baseline = await window.LayersAgent.paintStroke({
            points: [[30, 30], [90, 90]],
            size: 10,
            color: '#ff0000',
        })
        const layerId = baseline.result.layerId
        const layer = app._layers.find(candidate => candidate.id === layerId)
        const baselineStrokeIds = layer.strokes.map(stroke => stroke.id)

        app._markClean()
        layer.opacity = 73
        app._markDirty()
        app._pushUndoStateDebounced()
        const before = {
            model: JSON.stringify(layer.strokes),
            opacity: layer.opacity,
            dirty: app._isDirty,
            mutationRevision: app._projectMutationRevision,
            undoStackLength: app._undoManager._stack.length,
            undoIndex: app._undoManager._index,
            pendingUndo: Boolean(app._undoDebounceTimer),
        }

        const rebuild = app._rebuild.bind(app)
        let rebuildCalls = 0
        app._rebuild = (...args) => {
            if (rebuildCalls++ === 0) {
                return Promise.resolve({
                    success: false,
                    error: 'injected drawing rebuild failure',
                })
            }
            return rebuild(...args)
        }
        const envelope = await window.LayersAgent.paintStroke({
            layerId,
            points: [[140, 140], [200, 200]],
            size: 6,
            color: '#00ff00',
        })
        const immediate = {
            model: JSON.stringify(layer.strokes),
            opacity: layer.opacity,
            dirty: app._isDirty,
            mutationRevision: app._projectMutationRevision,
            undoStackLength: app._undoManager._stack.length,
            undoIndex: app._undoManager._index,
            pendingUndo: Boolean(app._undoDebounceTimer),
        }

        await new Promise(resolve => setTimeout(resolve, 650))
        const committed = app._undoManager._stack.at(-1)
        const committedLayer = committed.layers.find(candidate => candidate.id === layerId)
        return {
            before,
            immediate,
            envelope,
            rebuildCalls,
            pendingAfterDelay: Boolean(app._undoDebounceTimer),
            finalUndoStackLength: app._undoManager._stack.length,
            finalUndoIndex: app._undoManager._index,
            committedOpacity: committedLayer.opacity,
            committedStrokeIds: committedLayer.strokes.map(stroke => stroke.id),
            baselineStrokeIds,
        }
    })

    expect(result.envelope.ok).toBe(false)
    expect(result.envelope.error.code).toBe('INTERNAL_ERROR')
    expect(result.rebuildCalls).toBeGreaterThanOrEqual(2)
    expect(result.before.pendingUndo).toBe(true)
    expect(result.immediate).toEqual(result.before)
    expect(result.pendingAfterDelay).toBe(false)
    expect(result.finalUndoStackLength).toBe(result.before.undoStackLength + 1)
    expect(result.finalUndoIndex).toBe(result.before.undoIndex + 1)
    expect(result.committedOpacity).toBe(73)
    expect(result.committedStrokeIds).toEqual(result.baselineStrokeIds)
})

test('agent effect params compile inside layer-add rollback without leaving a ghost layer', async ({ page }) => {
    await bootSolid(page)

    const result = await page.evaluate(async () => {
        const app = window.layersApp
        const renderer = app._renderer
        app._markClean()
        const state = () => ({
            layerIds: app._layers.map(layer => layer.id),
            rendererLayerIds: renderer.layers.map(layer => layer.id),
            resourceIds: [...renderer._mediaTextures.keys()].sort(),
            selectedLayerIds: app._layerStack.selectedLayerIds,
            selectionAnchor: app._layerStack._lastClickedLayerId,
            dirty: app._isDirty,
            mutationRevision: app._projectMutationRevision,
            undoStackLength: app._undoManager._stack.length,
            undoIndex: app._undoManager._index,
            pendingUndo: Boolean(app._undoDebounceTimer),
        })
        const before = state()

        const rebuildNow = renderer._rebuildNow.bind(renderer)
        let rejectedCandidate = false
        renderer._rebuildNow = (...args) => {
            const candidate = renderer._layers.find(layer =>
                layer.name === 'Atomic Agent Effect')
            if (candidate?.effectParams?.type === 3 && !rejectedCandidate) {
                rejectedCandidate = true
                return Promise.resolve({
                    success: false,
                    error: 'injected effect param compile failure',
                })
            }
            return rebuildNow(...args)
        }
        const envelope = await window.LayersAgent.addLayer({
            kind: 'effect',
            effectId: 'synth/gradient',
            name: 'Atomic Agent Effect',
            params: { type: 3 },
        })
        return {
            before,
            after: state(),
            envelope,
            rejectedCandidate,
        }
    })

    expect(result.envelope.ok).toBe(false)
    expect(result.envelope.error.code).toBe('INTERNAL_ERROR')
    expect(result.rejectedCandidate).toBe(true)
    expect(result.after).toEqual(result.before)
})

test('mask stroke restores ImageData, texture, overlay, and history when rebuild fails', async ({ page }) => {
    await bootSolid(page)

    const result = await page.evaluate(async () => {
        const app = window.layersApp
        const renderer = app._renderer
        const { createPathStroke } = await import('/js/drawing/stroke-model.js')
        const layer = app._layers[0]
        await app._addLayerMask(layer.id)
        app._markClean()

        const originalMask = layer.mask
        const originalMaskBytes = new Uint8ClampedArray(originalMask.data)
        const originalTexture = renderer._maskTextures.get(layer.id)
        const overlay = document.getElementById('maskOverlay')
        const overlayContext = overlay.getContext('2d')
        const originalOverlay = overlayContext.getImageData(
            0, 0, overlay.width, overlay.height)
        const originalOverlayClass = overlay.className
        const state = () => ({
            selectedLayerIds: app._layerStack.selectedLayerIds,
            selectionAnchor: app._layerStack._lastClickedLayerId,
            dirty: app._isDirty,
            mutationRevision: app._projectMutationRevision,
            undoStackLength: app._undoManager._stack.length,
            undoIndex: app._undoManager._index,
            pendingUndo: Boolean(app._undoDebounceTimer),
        })
        const before = state()

        const rebuild = app._rebuild.bind(app)
        let rebuildCalls = 0
        app._rebuild = (...args) => {
            if (rebuildCalls++ === 0) {
                return Promise.resolve({
                    success: false,
                    error: 'injected mask rebuild failure',
                })
            }
            return rebuild(...args)
        }
        const outcome = await app._handleMaskStroke(createPathStroke({
            color: '#000000',
            size: 24,
            points: [{ x: 40, y: 40 }, { x: 180, y: 180 }],
        }), true)

        const restoredOverlay = overlayContext.getImageData(
            0, 0, overlay.width, overlay.height)
        return {
            before,
            after: state(),
            outcomeStatus: outcome?.status || null,
            rebuildCalls,
            sameMask: layer.mask === originalMask,
            sameMaskBytes: originalMaskBytes.every(
                (value, index) => layer.mask.data[index] === value),
            sameTexture: renderer._maskTextures.get(layer.id) === originalTexture,
            sameOverlay: originalOverlay.data.every(
                (value, index) => restoredOverlay.data[index] === value),
            sameOverlayClass: overlay.className === originalOverlayClass,
        }
    })

    expect(result.outcomeStatus).toBe('failed')
    expect(result.rebuildCalls).toBeGreaterThanOrEqual(2)
    expect(result.after).toEqual(result.before)
    expect(result.sameMask).toBe(true)
    expect(result.sameMaskBytes).toBe(true)
    expect(result.sameTexture).toBe(true)
    expect(result.sameOverlay).toBe(true)
    expect(result.sameOverlayClass).toBe(true)
})
