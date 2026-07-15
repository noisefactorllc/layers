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

async function installRollbackHarness(page, { mask = false } = {}) {
    await page.evaluate(async ({ mask }) => {
        const app = window.layersApp
        const renderer = app._renderer
        const {
            createMediaLayer,
            createDrawingLayer,
        } = await import('/js/layers/layer-model.js')

        renderer.stop()
        app._resizeCanvas(64, 48)

        const imageCanvas = document.createElement('canvas')
        imageCanvas.width = 24
        imageCanvas.height = 18
        const imageContext = imageCanvas.getContext('2d')
        imageContext.fillStyle = '#d33'
        imageContext.fillRect(0, 0, imageCanvas.width, imageCanvas.height)

        const drawingCanvas = document.createElement('canvas')
        drawingCanvas.width = 64
        drawingCanvas.height = 48
        const drawingContext = drawingCanvas.getContext('2d')
        drawingContext.fillStyle = '#36c'
        drawingContext.fillRect(8, 8, 20, 14)

        const image = createMediaLayer(null, 'image', 'Atomic image')
        image.offsetX = 7
        image.offsetY = -5
        const video = createMediaLayer(null, 'video', 'Atomic video')
        video.offsetX = -9
        video.offsetY = 6
        const drawing = createDrawingLayer('Atomic drawing')
        drawing.offsetX = 4
        drawing.offsetY = 3
        drawing.drawingCanvas = drawingCanvas

        const base = app._layers[0]
        base.name = 'Atomic base'
        base.offsetX = 2
        base.offsetY = -1
        app._layers = [base, image, video, drawing]

        renderer.disposeMediaResources(renderer._mediaTextures)
        renderer._maskTextures.clear()
        const imageResource = renderer.prepareCanvasMediaResource(imageCanvas)
        const videoElement = document.createElement('video')
        videoElement.muted = true
        const videoResource = {
            type: 'video',
            element: videoElement,
            width: 30,
            height: 20,
        }
        const drawingResource = renderer.prepareCanvasMediaResource(drawingCanvas)
        renderer.setMediaResource(image.id, imageResource)
        renderer.setMediaResource(video.id, videoResource)
        renderer.setMediaResource(drawing.id, drawingResource)

        if (mask) {
            const imageMask = new ImageData(64, 48)
            for (let i = 0; i < imageMask.data.length; i += 4) {
                const value = (i / 4) % 7 === 0 ? 0 : 255
                imageMask.data[i] = value
                imageMask.data[i + 1] = value
                imageMask.data[i + 2] = value
                imageMask.data[i + 3] = 255
            }
            image.mask = imageMask
            image.maskEnabled = true
            renderer.uploadMaskTexture(image.id, imageMask)
        }

        renderer._layers = app._layers
        app._updateLayerStack()
        app._layerStack.selectedLayerIds = [image.id, video.id]
        app._layerStack._lastClickedLayerId = image.id
        app._selectionManager.setSelection({
            type: 'rect',
            x: 6,
            y: 5,
            width: 30,
            height: 22,
        })
        app._undoManager.clear()
        app._undoManager.pushState({
            layers: app._cloneLayers(app._layers),
            canvasWidth: app._canvas.width,
            canvasHeight: app._canvas.height,
        })
        app._isDirty = false
        app._projectMutationRevision = 37
        renderer.start()

        const state = () => ({
            model: app._layers.map(layer => ({
                id: layer.id,
                name: layer.name,
                sourceType: layer.sourceType,
                mediaType: layer.mediaType || null,
                offsetX: layer.offsetX || 0,
                offsetY: layer.offsetY || 0,
                visible: layer.visible,
                maskEnabled: layer.maskEnabled,
                maskSize: layer.mask
                    ? [layer.mask.width, layer.mask.height]
                    : null,
            })),
            rendererModel: renderer._layers.map(layer => ({
                id: layer.id,
                visible: layer.visible,
            })),
            mediaIds: [...renderer._mediaTextures.keys()].sort(),
            maskIds: [...renderer._maskTextures.keys()].sort(),
            selectedLayerIds: app._layerStack.selectedLayerIds,
            selectionAnchor: app._layerStack._lastClickedLayerId,
            selection: JSON.stringify(app._selectionManager.selectionPath),
            canvas: [app._canvas.width, app._canvas.height],
            dirty: app._isDirty,
            mutationRevision: app._projectMutationRevision,
            undoStackLength: app._undoManager._stack.length,
            undoIndex: app._undoManager._index,
            running: renderer.isRunning,
        })

        const harness = {
            app,
            renderer,
            ids: {
                base: base.id,
                image: image.id,
                video: video.id,
                drawing: drawing.id,
            },
            state,
            before: null,
            refs: null,
            candidateResources: [],
            disposedResources: new Set(),
            successToasts: 0,
            rebuildAttempts: 0,
            lastSuccessfulRendererModel: null,

            capture() {
                this.before = state()
                this.refs = {
                    layers: app._layers,
                    layerObjects: app._layers.slice(),
                    media: new Map(renderer._mediaTextures),
                    masks: new Map(renderer._maskTextures),
                    maskBytes: new Map(app._layers
                        .filter(layer => layer.mask)
                        .map(layer => [
                            layer.id,
                            new Uint8ClampedArray(layer.mask.data),
                        ])),
                    videoDimensions: [
                        renderer._mediaTextures.get(video.id)?.width,
                        renderer._mediaTextures.get(video.id)?.height,
                    ],
                }
            },

            compare() {
                const sameEntries = (expected, actual) =>
                    expected.size === actual.size
                    && [...expected].every(([id, value]) => actual.get(id) === value)
                const sameMaskBytes = [...this.refs.maskBytes].every(([id, bytes]) => {
                    const current = app._layers.find(layer => layer.id === id)?.mask?.data
                    return current?.length === bytes.length
                        && bytes.every((value, index) => current[index] === value)
                })
                return {
                    before: this.before,
                    after: state(),
                    sameLayersArray: app._layers === this.refs.layers,
                    sameLayerObjects: app._layers.length === this.refs.layerObjects.length
                        && this.refs.layerObjects.every(
                            (layer, index) => app._layers[index] === layer),
                    sameMediaResources: sameEntries(
                        this.refs.media, renderer._mediaTextures),
                    sameMaskTextures: sameEntries(
                        this.refs.masks, renderer._maskTextures),
                    sameMaskBytes,
                    sameVideoDimensions:
                        renderer._mediaTextures.get(video.id)?.width
                            === this.refs.videoDimensions[0]
                        && renderer._mediaTextures.get(video.id)?.height
                            === this.refs.videoDimensions[1],
                }
            },

            async trackSuccessToasts() {
                const { toast } = await import('/js/ui/toast.js')
                toast.success = () => { this.successToasts += 1 }
            },

            trackResources() {
                const prepareMediaResource =
                    renderer.prepareMediaResource.bind(renderer)
                renderer.prepareMediaResource = async (...args) => {
                    const resource = await prepareMediaResource(...args)
                    if (resource) this.candidateResources.push(resource)
                    return resource
                }
                const prepareCanvasMediaResource =
                    renderer.prepareCanvasMediaResource.bind(renderer)
                renderer.prepareCanvasMediaResource = (...args) => {
                    const resource = prepareCanvasMediaResource(...args)
                    this.candidateResources.push(resource)
                    return resource
                }
                const disposeMediaResource =
                    renderer.disposeMediaResource.bind(renderer)
                renderer.disposeMediaResource = (resource) => {
                    this.disposedResources.add(resource)
                    return disposeMediaResource(resource)
                }
            },

            injectRebuildFailure(failAt = 1, repeat = false) {
                const rebuild = app._rebuild.bind(app)
                const rebuildNow = renderer._rebuildNow.bind(renderer)
                let insideAppRebuild = false
                this.lastSuccessfulRendererModel = renderer._layers.map(layer => ({
                    id: layer.id,
                    visible: layer.visible,
                }))

                const runBoundary = async (delegate, args) => {
                    this.rebuildAttempts += 1
                    const attemptedModel = renderer._layers.map(layer => ({
                        id: layer.id,
                        visible: layer.visible,
                    }))
                    if (repeat
                        ? this.rebuildAttempts >= failAt
                        : this.rebuildAttempts === failAt) {
                        return {
                            success: false,
                            error: `injected rebuild failure ${failAt}`,
                        }
                    }
                    const result = await delegate(...args)
                    if (result?.success) {
                        this.lastSuccessfulRendererModel = attemptedModel
                    }
                    return result
                }

                app._rebuild = async (...args) => {
                    insideAppRebuild = true
                    try {
                        return await runBoundary(rebuild, args)
                    } finally {
                        insideAppRebuild = false
                    }
                }
                renderer._rebuildNow = (...args) => {
                    if (insideAppRebuild) return rebuildNow(...args)
                    return runBoundary(rebuildNow, args)
                }
            },

            resourceReport() {
                return {
                    candidateResourceCount: this.candidateResources.length,
                    allCandidatesDisposed: this.candidateResources.length > 0
                        && this.candidateResources.every(resource =>
                            this.disposedResources.has(resource)),
                    oldResourcesNotDisposed: [...this.refs.media.values()].every(
                        resource => !this.disposedResources.has(resource)),
                }
            },
        }

        window.__phase2Rollback = harness
    }, { mask })
}

for (const failure of [
    { name: 'candidate', failAt: 1, expectedRenderCalls: 0 },
    { name: 'restoration', failAt: 2, expectedRenderCalls: 2 },
]) {
    test(`renderLayerComposite aborts on ${failure.name} rebuild failure`, async ({ page }) => {
        await bootSolid(page)
        await installRollbackHarness(page)

        const result = await page.evaluate(async ({ failAt }) => {
            const h = window.__phase2Rollback
            const { app, renderer } = h
            const base = app._layers.find(layer => layer.id === h.ids.base)
            const image = app._layers.find(layer => layer.id === h.ids.image)
            base.visible = false
            image.visible = true
            renderer._layers = app._layers
            h.capture()
            h.injectRebuildFailure(failAt)

            let renderCalls = 0
            const render = renderer.render.bind(renderer)
            renderer.render = (...args) => {
                renderCalls += 1
                return render(...args)
            }

            let returnedComposite = false
            let error = null
            try {
                returnedComposite = Boolean(
                    await app._renderLayerComposite([base.id]))
            } catch (err) {
                error = err.message
            }

            return {
                ...h.compare(),
                rebuildAttempts: h.rebuildAttempts,
                renderCalls,
                returnedComposite,
                error,
                rendererModelRestored: JSON.stringify(
                    h.lastSuccessfulRendererModel)
                    === JSON.stringify(h.before.rendererModel),
            }
        }, { failAt: failure.failAt })

        expect(result.after).toEqual(result.before)
        expect(result.sameLayersArray).toBe(true)
        expect(result.sameLayerObjects).toBe(true)
        expect(result.rendererModelRestored).toBe(true)
        expect(result.renderCalls).toBe(failure.expectedRenderCalls)
        expect(result.returnedComposite).toBe(false)
    })
}

test('renderLayerComposite stops after repeated restoration rebuild failures', async ({ page }) => {
    await bootSolid(page)
    await installRollbackHarness(page)

    const result = await page.evaluate(async () => {
        const h = window.__phase2Rollback
        const { app, renderer } = h
        const base = app._layers.find(layer => layer.id === h.ids.base)
        const image = app._layers.find(layer => layer.id === h.ids.image)
        base.visible = false
        image.visible = true
        renderer._layers = app._layers
        h.capture()
        h.injectRebuildFailure(2, true)
        const composite = await app._renderLayerComposite([base.id])
        return {
            ...h.compare(),
            returnedComposite: Boolean(composite),
            rebuildAttempts: h.rebuildAttempts,
        }
    })

    expect(result.after).toEqual({ ...result.before, running: false })
    expect(result.sameLayersArray).toBe(true)
    expect(result.sameLayerObjects).toBe(true)
    expect(result.sameMediaResources).toBe(true)
    expect(result.sameMaskTextures).toBe(true)
    expect(result.returnedComposite).toBe(false)
    expect(result.rebuildAttempts).toBe(3)
})

for (const historyCase of [
    { name: 'human undo', direction: 'undo', agent: false },
    { name: 'agent redo', direction: 'redo', agent: true },
]) {
    test(`${historyCase.name} preserves exact current state when restore rebuild fails`, async ({ page }) => {
        await bootSolid(page)
        await installRollbackHarness(page, { mask: true })

        const result = await page.evaluate(async ({ direction, agent }) => {
            const h = window.__phase2Rollback
            const { app } = h
            const currentSnapshot = {
                layers: app._cloneLayers(app._layers),
                canvasWidth: app._canvas.width,
                canvasHeight: app._canvas.height,
            }
            const targetLayers = app._cloneLayers([app._layers[0]])
            targetLayers[0].name = 'Injected history target'
            const targetSnapshot = {
                layers: targetLayers,
                canvasWidth: app._canvas.width,
                canvasHeight: app._canvas.height,
            }
            app._undoManager._stack = direction === 'undo'
                ? [targetSnapshot, currentSnapshot]
                : [currentSnapshot, targetSnapshot]
            app._undoManager._index = direction === 'undo' ? 1 : 0

            h.capture()
            h.trackResources()
            await h.trackSuccessToasts()
            h.injectRebuildFailure(1)

            let outcome = null
            let error = null
            try {
                outcome = agent
                    ? await window.LayersAgent[direction]()
                    : await app[`_${direction}`]()
            } catch (err) {
                error = err.message
            }
            const comparison = h.compare()
            return {
                ...comparison,
                ...h.resourceReport(),
                outcome,
                error,
                reportedFailure: agent
                    ? outcome?.ok === false
                    : Boolean(error || outcome?.status === 'failed'),
                successToasts: h.successToasts,
                rebuildAttempts: h.rebuildAttempts,
            }
        }, { direction: historyCase.direction, agent: historyCase.agent })

        expect(result.after).toEqual(result.before)
        expect(result.sameLayersArray).toBe(true)
        expect(result.sameLayerObjects).toBe(true)
        expect(result.sameMediaResources).toBe(true)
        expect(result.sameMaskTextures).toBe(true)
        expect(result.sameMaskBytes).toBe(true)
        expect(result.sameVideoDimensions).toBe(true)
        expect(result.oldResourcesNotDisposed).toBe(true)
        expect(result.reportedFailure).toBe(true)
        expect(result.successToasts).toBe(0)
    })
}

test('agent duplicate disposes its candidate and reports failure without changing state', async ({ page }) => {
    await bootSolid(page)
    await installRollbackHarness(page)

    const result = await page.evaluate(async () => {
        const h = window.__phase2Rollback
        const { app } = h
        app._layerStack.selectedLayerIds = [h.ids.base, h.ids.drawing]
        app._layerStack._lastClickedLayerId = h.ids.drawing
        app._renderLayerComposite = async () => app._canvas
        h.capture()
        h.trackResources()
        await h.trackSuccessToasts()
        h.injectRebuildFailure(1)

        const envelope = await window.LayersAgent.duplicateLayer({
            layerId: h.ids.image,
        })
        return {
            ...h.compare(),
            ...h.resourceReport(),
            envelope,
            successToasts: h.successToasts,
        }
    })

    expect(result.after).toEqual(result.before)
    expect(result.sameLayersArray).toBe(true)
    expect(result.sameLayerObjects).toBe(true)
    expect(result.sameMediaResources).toBe(true)
    expect(result.candidateResourceCount).toBeGreaterThan(0)
    expect(result.allCandidatesDisposed).toBe(true)
    expect(result.oldResourcesNotDisposed).toBe(true)
    expect(result.envelope.ok).toBe(false)
    expect(result.successToasts).toBe(0)
})

for (const replacement of [
    { name: 'flatten', agent: true },
    { name: 'extract', agent: false },
    { name: 'crop', agent: true },
]) {
    test(`${replacement.name} failure preserves old image/video/drawing resources`, async ({ page }) => {
        await bootSolid(page)
        await installRollbackHarness(page)

        const result = await page.evaluate(async ({ operation, agent }) => {
            const h = window.__phase2Rollback
            const { app } = h
            if (operation === 'extract' || operation === 'crop') {
                const composite = new OffscreenCanvas(
                    app._canvas.width, app._canvas.height)
                const context = composite.getContext('2d')
                context.fillStyle = '#8ad'
                context.fillRect(0, 0, composite.width, composite.height)
                app._renderLayerComposite = async () => composite
            }
            h.capture()
            h.trackResources()
            await h.trackSuccessToasts()
            h.injectRebuildFailure(1)

            let outcome = null
            let error = null
            try {
                if (operation === 'flatten') {
                    outcome = await window.LayersAgent.flattenImage()
                } else if (operation === 'extract') {
                    outcome = await app._extractFromMultipleLayers([
                        h.ids.image,
                        h.ids.drawing,
                    ], true)
                } else {
                    outcome = await window.LayersAgent.cropToSelection()
                }
            } catch (err) {
                error = err.message
            }

            return {
                ...h.compare(),
                ...h.resourceReport(),
                outcome,
                error,
                reportedFailure: agent
                    ? outcome?.ok === false
                    : Boolean(error || outcome === false
                        || outcome?.status === 'failed'),
                successToasts: h.successToasts,
            }
        }, { operation: replacement.name, agent: replacement.agent })

        expect(result.after).toEqual(result.before)
        expect(result.sameLayersArray).toBe(true)
        expect(result.sameLayerObjects).toBe(true)
        expect(result.sameMediaResources).toBe(true)
        expect(result.candidateResourceCount).toBeGreaterThan(0)
        expect(result.allCandidatesDisposed).toBe(true)
        expect(result.oldResourcesNotDisposed).toBe(true)
        expect(result.reportedFailure).toBe(true)
        expect(result.successToasts).toBe(0)
    })
}

for (const resizeCase of [
    { name: 'agent image resize', operation: 'image', agent: true },
    { name: 'human canvas resize', operation: 'canvas', agent: false },
]) {
    test(`${resizeCase.name} restores canvas, masks, resources, and history on rebuild failure`, async ({ page }) => {
        await bootSolid(page)
        await installRollbackHarness(page, { mask: true })

        const result = await page.evaluate(async ({ operation, agent }) => {
            const h = window.__phase2Rollback
            const { app } = h
            h.capture()
            h.trackResources()
            await h.trackSuccessToasts()
            h.injectRebuildFailure(1)

            let outcome = null
            let error = null
            try {
                outcome = agent
                    ? await window.LayersAgent.resizeImage({ width: 80, height: 60 })
                    : await app._changeCanvasSize(80, 60, 'center')
            } catch (err) {
                error = err.message
            }

            return {
                ...h.compare(),
                ...h.resourceReport(),
                outcome,
                error,
                reportedFailure: agent
                    ? outcome?.ok === false
                    : Boolean(error || outcome?.status === 'failed'),
                successToasts: h.successToasts,
                operation,
            }
        }, { operation: resizeCase.operation, agent: resizeCase.agent })

        expect(result.after).toEqual(result.before)
        expect(result.sameLayersArray).toBe(true)
        expect(result.sameLayerObjects).toBe(true)
        expect(result.sameMediaResources).toBe(true)
        expect(result.sameMaskTextures).toBe(true)
        expect(result.sameMaskBytes).toBe(true)
        expect(result.sameVideoDimensions).toBe(true)
        expect(result.oldResourcesNotDisposed).toBe(true)
        if (resizeCase.operation === 'image') {
            expect(result.candidateResourceCount).toBeGreaterThan(0)
            expect(result.allCandidatesDisposed).toBe(true)
        }
        expect(result.reportedFailure).toBe(true)
        expect(result.successToasts).toBe(0)
    })
}

for (const operation of ['crop', 'image resize']) {
    test(`${operation} disposes prepared media when later candidate work fails`, async ({ page }) => {
        await bootSolid(page)
        await installRollbackHarness(page, { mask: true })

        const result = await page.evaluate(async (operation) => {
            const h = window.__phase2Rollback
            const { app } = h
            if (operation === 'crop') {
                const composite = document.createElement('canvas')
                composite.width = app._canvas.width
                composite.height = app._canvas.height
                composite.getContext('2d').fillRect(
                    0, 0, composite.width, composite.height)
                app._renderLayerComposite = async () => composite
            }
            h.capture()
            h.trackResources()

            let injected = false
            let restoreFailureHook
            if (operation === 'crop') {
                const stageLayerSet = h.renderer.stageLayerSet.bind(h.renderer)
                h.renderer.stageLayerSet = async (...args) => {
                    injected = true
                    throw new Error('injected late candidate failure')
                }
                restoreFailureHook = () => {
                    h.renderer.stageLayerSet = stageLayerSet
                }
            } else {
                const getImageData = CanvasRenderingContext2D.prototype.getImageData
                CanvasRenderingContext2D.prototype.getImageData = function (...args) {
                    if (!injected) {
                        injected = true
                        throw new Error('injected late candidate failure')
                    }
                    return getImageData.apply(this, args)
                }
                restoreFailureHook = () => {
                    CanvasRenderingContext2D.prototype.getImageData = getImageData
                }
            }
            let outcome = null
            let error = null
            try {
                outcome = operation === 'crop'
                    ? await app._cropToSelection()
                    : await app._resizeImage(80, 60)
            } catch (err) {
                error = err.message
            } finally {
                restoreFailureHook()
            }

            return {
                ...h.compare(),
                ...h.resourceReport(),
                injected,
                outcome,
                error,
            }
        }, operation)

        expect(result.injected).toBe(true)
        expect(result.outcome?.status === 'failed'
            || result.error?.includes('injected late candidate failure')).toBe(true)
        expect(result.after).toEqual(result.before)
        expect(result.sameLayersArray).toBe(true)
        expect(result.sameLayerObjects).toBe(true)
        expect(result.sameMediaResources).toBe(true)
        expect(result.candidateResourceCount).toBeGreaterThan(0)
        expect(result.allCandidatesDisposed).toBe(true)
        expect(result.oldResourcesNotDisposed).toBe(true)
    })
}

for (const mediaCase of ['fill canvas', 'remote placeholder']) {
    test(`${mediaCase} survives a successful undo and redo with restored pixels`, async ({ page }) => {
        await bootSolid(page)

        const result = await page.evaluate(async ({ mediaCase }) => {
            const app = window.layersApp
            const renderer = app._renderer
            const source = document.createElement('canvas')
            source.width = mediaCase === 'fill canvas' ? 12 : 1
            source.height = mediaCase === 'fill canvas' ? 10 : 1
            const sourceContext = source.getContext('2d')
            sourceContext.fillStyle = mediaCase === 'fill canvas'
                ? 'rgba(214, 37, 91, 1)'
                : 'rgba(0, 0, 0, 0)'
            sourceContext.fillRect(0, 0, source.width, source.height)

            let layerId
            let mutation
            if (mediaCase === 'fill canvas') {
                mutation = await app._addMediaLayerFromCanvas(source, 'History fill')
                layerId = mutation.layerId
            } else {
                const { createMediaLayer } = await import('/js/layers/layer-model.js')
                const layer = createMediaLayer(null, 'image', 'Remote placeholder')
                layer.remoteMediaPlaceholder = true
                const resource = renderer.prepareCanvasMediaResource(source)
                const candidate = await app._prepareLayerSetCandidate(
                    [...app._layers, layer], app._canvas.width, app._canvas.height, {
                        reuseMediaIds: new Set(renderer._mediaTextures.keys()),
                        reuseMaskIds: new Set(renderer._maskTextures.keys()),
                        mediaOverrides: new Map([[layer.id, resource]]),
                    })
                mutation = await app._commitPreparedLayerMutation(candidate, {
                    selectedLayerIds: [layer.id],
                    selectionAnchor: layer.id,
                })
                layerId = layer.id
            }

            const firstResource = renderer._mediaTextures.get(layerId)
            const firstPixel = [...firstResource.element
                .getContext('2d').getImageData(0, 0, 1, 1).data]
            const undo = await app._undo()
            const absentAfterUndo = !app._layers.some(layer => layer.id === layerId)
                && !renderer._mediaTextures.has(layerId)
            const redo = await app._redo()
            const restoredLayer = app._layers.find(layer => layer.id === layerId)
            const restoredResource = renderer._mediaTextures.get(layerId)
            return {
                mutationStatus: mutation.status,
                undoStatus: undo.status,
                redoStatus: redo.status,
                absentAfterUndo,
                restoredLayer: Boolean(restoredLayer),
                restoredPlaceholder: Boolean(restoredLayer?.remoteMediaPlaceholder),
                restoredResource: Boolean(restoredResource),
                newResourceIdentity: restoredResource !== firstResource,
                firstPixel,
                restoredPixel: restoredResource
                    ? [...restoredResource.element
                        .getContext('2d').getImageData(0, 0, 1, 1).data]
                    : null,
            }
        }, { mediaCase })

        expect(result.mutationStatus).toMatch(/added|committed/)
        expect(result.undoStatus).toBe('committed')
        expect(result.redoStatus).toBe('committed')
        expect(result.absentAfterUndo).toBe(true)
        expect(result.restoredLayer).toBe(true)
        expect(result.restoredPlaceholder).toBe(mediaCase === 'remote placeholder')
        expect(result.restoredResource).toBe(true)
        expect(result.newResourceIdentity).toBe(true)
        expect(result.restoredPixel).toEqual(result.firstPixel)
    })
}

test('restart failure rolls back before commit and preserves core restore errors', async ({ page }) => {
    await bootSolid(page)
    await installRollbackHarness(page)

    const result = await page.evaluate(async () => {
        const h = window.__phase2Rollback
        const { app, renderer } = h
        h.capture()
        h.trackResources()
        h.injectRebuildFailure(2)

        const start = renderer.start.bind(renderer)
        let startCalls = 0
        renderer.start = (...args) => {
            startCalls++
            if (startCalls === 1) throw new Error('injected restart failure')
            return start(...args)
        }

        const candidate = await app._prepareLayerSetCandidate(
            [app._cloneLayers([app._layers[0]])[0]], 80, 60)
        const outcome = await app._commitPreparedLayerMutation(candidate, {
            restoreBeforeRollback: () => {
                throw new Error('injected state hook failure')
            },
        })
        return {
            ...h.compare(),
            ...h.resourceReport(),
            status: outcome.status,
            error: outcome.error?.message,
            startCalls,
            rebuildAttempts: h.rebuildAttempts,
        }
    })

    expect(result.after).toEqual(result.before)
    expect(result.sameLayersArray).toBe(true)
    expect(result.sameLayerObjects).toBe(true)
    expect(result.sameMediaResources).toBe(true)
    expect(result.oldResourcesNotDisposed).toBe(true)
    expect(result.status).toBe('failed')
    expect(result.error).toContain('injected restart failure')
    expect(result.error).toContain('injected state hook failure')
    expect(result.startCalls).toBe(2)
    expect(result.rebuildAttempts).toBe(3)
})

test('candidate preparation owns and disposes an override exactly once on failure', async ({ page }) => {
    await bootSolid(page)
    await installRollbackHarness(page, { mask: true })

    const result = await page.evaluate(async () => {
        const h = window.__phase2Rollback
        const { app, renderer } = h
        const canvas = document.createElement('canvas')
        canvas.width = 4
        canvas.height = 4
        const resource = renderer.prepareCanvasMediaResource(canvas)
        const dispose = renderer.disposeMediaResource.bind(renderer)
        let disposals = 0
        renderer.disposeMediaResource = candidate => {
            if (candidate === resource) disposals++
            return dispose(candidate)
        }
        renderer.prepareMaskTexture = () => {
            throw new Error('injected mask preparation failure')
        }

        const { createMediaLayer } = await import('/js/layers/layer-model.js')
        const layer = createMediaLayer(null, 'image', 'Owned candidate')
        layer.mask = new ImageData(4, 4)
        const outcome = await app._commitAddedLayer(layer, { resource })
        return {
            status: outcome.status,
            error: outcome.error?.message,
            disposals,
            layerPresent: app._layers.some(candidate => candidate.id === layer.id),
        }
    })

    expect(result.status).toBe('failed')
    expect(result.error).toContain('injected mask preparation failure')
    expect(result.disposals).toBe(1)
    expect(result.layerPresent).toBe(false)
})
