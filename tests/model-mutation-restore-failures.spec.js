import { test, expect } from './fixtures.js'
import { reopenNewProjectDialog } from './helpers/new-project.js'

const TINY_PNG_B64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='

async function bootSolid(page) {
    await page.goto('/', { waitUntil: 'networkidle' })
    await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })
    await reopenNewProjectDialog(page)
    const backdrop = page.locator('.open-dialog-backdrop.visible')
    await page.locator('.media-option[data-type="solid"]').click()
            // 512 preset: quarters the composited frame cost on software-rendered CI
            // shards (same capacity trim as drawing-shortcuts); this suite reads no
    // absolute canvas coordinates.
    await page.locator('.size-preset[data-width="512"]').click()
    await page.locator('.canvas-size-dialog .action-btn.primary').click()
    await backdrop.waitFor({ state: 'hidden' })
}

test('agent flip restores the selected media transform when renderer update throws', async ({ page }) => {
    await bootSolid(page)

    const result = await page.evaluate(async (data) => {
        const app = window.layersApp
        const added = await window.LayersAgent.addLayer({
            kind: 'media',
            mediaType: 'image',
            source: { kind: 'base64', data, mimeType: 'image/png' },
        })
        const layer = app._layers.find(candidate => candidate.id === added.result.layerId)
        const priorLayer = app._layers.find(candidate => candidate.id !== layer.id)
        app._layerStack.selectedLayerId = priorLayer.id
        app._markClean()
        const before = {
            flipH: layer.flipH,
            selectedLayerIds: app._layerStack.selectedLayerIds,
            selectionAnchor: app._layerStack._lastClickedLayerId,
            dirty: app._isDirty,
            mutationRevision: app._projectMutationRevision,
            undoStackLength: app._undoManager._stack.length,
            undoIndex: app._undoManager._index,
            pendingUndo: Boolean(app._undoDebounceTimer),
        }
        const updateTransformRender = app._updateTransformRender.bind(app)
        let updateCalls = 0
        app._updateTransformRender = (candidate) => {
            updateCalls += 1
            if (updateCalls === 1) throw new Error('injected flip renderer failure')
            return updateTransformRender(candidate)
        }

        const envelope = await window.LayersAgent.flipLayer({
            layerId: layer.id,
            axis: 'h',
        })
        return {
            before,
            after: {
                flipH: layer.flipH,
                selectedLayerIds: app._layerStack.selectedLayerIds,
                selectionAnchor: app._layerStack._lastClickedLayerId,
                dirty: app._isDirty,
                mutationRevision: app._projectMutationRevision,
                undoStackLength: app._undoManager._stack.length,
                undoIndex: app._undoManager._index,
                pendingUndo: Boolean(app._undoDebounceTimer),
            },
            envelope,
            updateCalls,
        }
    }, TINY_PNG_B64)

    expect(result.envelope.ok).toBe(false)
    expect(result.envelope.error.code).toBe('INTERNAL_ERROR')
    expect(result.after).toEqual(result.before)
    expect(result.updateCalls).toBeGreaterThanOrEqual(2)
})

const reorderCases = [
    { name: 'human layer reorder', operation: 'human-layer', agent: false },
    { name: 'agent layer reorder', operation: 'agent-layer', agent: true },
    { name: 'agent child reorder', operation: 'agent-child', agent: true },
]

for (const entry of reorderCases) {
    test(`${entry.name} restores exact order when final rebuild fails`, async ({ page }) => {
        await bootSolid(page)

        const result = await page.evaluate(async ({ operation }) => {
            const app = window.layersApp
            const first = await app._handleAddEffectLayer('synth/gradient')
            const second = await app._handleAddEffectLayer('synth/gradient')
            const firstLayer = app._layers.find(layer => layer.id === first.layerId)
            if (operation === 'agent-child') {
                await app._handleAddChildEffect(firstLayer.id, 'filter/blur')
                await app._handleAddChildEffect(firstLayer.id, 'filter/invert')
            }
            app._markClean()

            const layersArray = app._layers
            const layerObjects = app._layers.slice()
            const childrenArray = firstLayer.children
            const childObjects = firstLayer.children.slice()
            const state = () => ({
                layerIds: app._layers.map(layer => layer.id),
                childIds: firstLayer.children.map(child => child.id),
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
                        error: 'injected reorder final rebuild failure',
                    })
                }
                return rebuild(...args)
            }

            let envelope = null
            if (operation === 'human-layer') {
                app._startDrag(second.layerId)
                await app._processDrop(first.layerId, 'below')
            } else if (operation === 'agent-layer') {
                envelope = await window.LayersAgent.reorderLayer({
                    layerId: second.layerId,
                    toIndex: 1,
                })
            } else {
                envelope = await window.LayersAgent.reorderChildEffect({
                    layerId: firstLayer.id,
                    childId: firstLayer.children[1].id,
                    toIndex: 0,
                })
            }

            return {
                before,
                after: state(),
                envelope,
                rebuildCalls,
                sameLayersArray: app._layers === layersArray,
                sameLayerObjects: layerObjects.every(
                    (layer, index) => app._layers[index] === layer),
                sameChildrenArray: firstLayer.children === childrenArray,
                sameChildObjects: childObjects.every(
                    (child, index) => firstLayer.children[index] === child),
                reorderIdle: app._reorderState === 'IDLE',
                lifecycleReleased: !app._projectLifecycleActive,
            }
        }, { operation: entry.operation })

        expect(result.rebuildCalls).toBeGreaterThanOrEqual(2)
        expect(result.after).toEqual(result.before)
        expect(result.sameLayersArray).toBe(true)
        expect(result.sameLayerObjects).toBe(true)
        expect(result.sameChildrenArray).toBe(true)
        expect(result.sameChildObjects).toBe(true)
        expect(result.reorderIdle).toBe(true)
        expect(result.lifecycleReleased).toBe(true)
        if (entry.agent) {
            expect(result.envelope.ok).toBe(false)
            expect(result.envelope.error.code).toBe('INTERNAL_ERROR')
        }
    })
}

test('human reorder reports restoration rebuild failure without claiming changes reverted', async ({ page }) => {
    await bootSolid(page)

    const result = await page.evaluate(async () => {
        const app = window.layersApp
        const first = await app._handleAddEffectLayer('synth/gradient')
        const second = await app._handleAddEffectLayer('synth/gradient')
        const layersArray = app._layers
        const layerObjects = app._layers.slice()
        const beforeIds = app._layers.map(layer => layer.id)
        let rebuildCalls = 0
        app._renderer.tryCompile = () => Promise.resolve({
            success: false,
            error: 'injected reorder candidate validation failure',
        })
        app._rebuild = () => {
            rebuildCalls += 1
            return Promise.resolve({
                success: false,
                error: 'injected reorder restoration rebuild failure',
            })
        }

        app._startDrag(second.layerId)
        await app._processDrop(first.layerId, 'below')
        const errors = Array.from(document.querySelectorAll(
            '#toast-container .toast-error .toast-message'))
            .map(element => element.textContent)

        return {
            beforeIds,
            afterIds: app._layers.map(layer => layer.id),
            sameLayersArray: app._layers === layersArray,
            sameLayerObjects: layerObjects.every(
                (layer, index) => app._layers[index] === layer),
            rebuildCalls,
            lastError: errors.at(-1),
            reorderIdle: app._reorderState === 'IDLE',
            lifecycleReleased: !app._projectLifecycleActive,
        }
    })

    expect(result.afterIds).toEqual(result.beforeIds)
    expect(result.sameLayersArray).toBe(true)
    expect(result.sameLayerObjects).toBe(true)
    expect(result.rebuildCalls).toBe(1)
    expect(result.lastError).toContain('injected reorder candidate validation failure')
    expect(result.lastError).toContain('injected reorder restoration rebuild failure')
    expect(result.lastError).not.toContain('Changes reverted')
    expect(result.reorderIdle).toBe(true)
    expect(result.lifecycleReleased).toBe(true)
})

const maskCases = [
    'add',
    'from-selection',
    'delete',
    'invert',
    'feather',
    'expand',
    'contract',
    'smooth',
    'enable',
    'exit-edit',
]

test('overlapping successful mask strokes settle without a stale snapshot override', async ({ page }) => {
    await bootSolid(page)

    const result = await page.evaluate(async () => {
        const app = window.layersApp
        const { createPathStroke } = await import('/js/drawing/stroke-model.js')
        await app._handleCreateSolidBase(64, 64)
        const added = await app._handleAddEffectLayer('synth/gradient')
        const layer = app._layers.find(candidate => candidate.id === added.layerId)
        await app._addLayerMask(layer.id, { enterEditMode: false })
        app._enterMaskEditMode(layer.id)
        const stroke = x => createPathStroke({
            color: '#000000',
            size: 10,
            opacity: 1,
            points: [{ x, y: 16 }, { x: x + 8, y: 16 }],
        })

        let rebuildCalls = 0
        let enterFirst
        let releaseFirst
        let rebuildTail = Promise.resolve()
        const firstEntered = new Promise(resolve => { enterFirst = resolve })
        const firstRelease = new Promise(resolve => { releaseFirst = resolve })
        app._rebuild = () => {
            const call = ++rebuildCalls
            const run = rebuildTail.then(async () => {
                if (call === 1) {
                    enterFirst()
                    await firstRelease
                }
                return { success: true }
            })
            rebuildTail = run.catch(() => {})
            return run
        }

        const older = app._handleMaskStroke(stroke(8), true)
        await firstEntered
        const newer = app._handleMaskStroke(stroke(40), true)
        releaseFirst()
        const [olderOutcome, newerOutcome] = await Promise.all([older, newer])
        const snapshot = (await window.LayersAgent.getState()).state
        const snapshotLayer = snapshot.layers.find(candidate => candidate.id === layer.id)
        const maskValue = (x, y) => layer.mask.data[(y * layer.mask.width + x) * 4]
        return {
            olderStatus: olderOutcome.status,
            newerStatus: newerOutcome.status,
            rebuildCalls,
            transactionDepth: app._publishTransactionDepth,
            snapshotOverrideCleared: app._projectSnapshotCanvasOverride === null,
            firstPixel: maskValue(12, 16),
            secondPixel: maskValue(44, 16),
            snapshotCoverage: snapshotLayer.mask.coverage,
        }
    })

    expect(result).toMatchObject({
        olderStatus: 'committed',
        newerStatus: 'committed',
        rebuildCalls: 2,
        transactionDepth: 0,
        snapshotOverrideCleared: true,
        firstPixel: 0,
        secondPixel: 0,
    })
    expect(result.snapshotCoverage).toBeLessThan(1)
})

test('a failed older mask stroke cannot roll back a newer successful stroke', async ({ page }) => {
    await bootSolid(page)

    const result = await page.evaluate(async () => {
        const app = window.layersApp
        const { createPathStroke } = await import('/js/drawing/stroke-model.js')
        await app._handleCreateSolidBase(64, 64)
        const added = await app._handleAddEffectLayer('synth/gradient')
        const layer = app._layers.find(candidate => candidate.id === added.layerId)
        await app._addLayerMask(layer.id, { enterEditMode: false })
        app._enterMaskEditMode(layer.id)
        const stroke = x => createPathStroke({
            color: '#000000',
            size: 10,
            opacity: 1,
            points: [{ x, y: 16 }, { x: x + 8, y: 16 }],
        })

        let rebuildCalls = 0
        let enterFirst
        let releaseFirst
        let rebuildTail = Promise.resolve()
        const firstEntered = new Promise(resolve => { enterFirst = resolve })
        const firstRelease = new Promise(resolve => { releaseFirst = resolve })
        app._rebuild = () => {
            const call = ++rebuildCalls
            const run = rebuildTail.then(async () => {
                if (call === 1) {
                    enterFirst()
                    await firstRelease
                    return {
                        success: false,
                        error: 'injected older mask failure',
                    }
                }
                return { success: true }
            })
            rebuildTail = run.catch(() => {})
            return run
        }

        const older = app._handleMaskStroke(stroke(8), true)
        await firstEntered
        const newer = app._handleMaskStroke(stroke(40), true)
        releaseFirst()
        const [olderOutcome, newerOutcome] = await Promise.all([older, newer])
        const maskValue = (x, y) => layer.mask.data[(y * layer.mask.width + x) * 4]
        return {
            olderStatus: olderOutcome.status,
            newerStatus: newerOutcome.status,
            rebuildCalls,
            transactionDepth: app._publishTransactionDepth,
            snapshotOverrideCleared: app._projectSnapshotCanvasOverride === null,
            firstPixel: maskValue(12, 16),
            secondPixel: maskValue(44, 16),
        }
    })

    expect(result).toEqual({
        olderStatus: 'failed',
        newerStatus: 'committed',
        rebuildCalls: 3,
        transactionDepth: 0,
        snapshotOverrideCleared: true,
        firstPixel: 255,
        secondPixel: 0,
    })
})

for (const actor of ['human', 'agent']) {
    for (const operation of maskCases) {
        if (actor === 'agent' && operation === 'exit-edit') continue
        test(`${actor} mask ${operation} restores bytes, texture, edit UI, and history`, async ({ page }) => {
            await bootSolid(page)

            const result = await page.evaluate(async ({ actor, operation }) => {
                const app = window.layersApp
                const renderer = app._renderer
                const layer = app._layers[0]
                const startsUnmasked = operation === 'add' || operation === 'from-selection'
                if (!startsUnmasked) {
                    const added = await window.LayersAgent.addLayerMask({ layerId: layer.id })
                    if (!added.ok) throw new Error(added.error.message)
                }
                if (operation === 'from-selection') {
                    const selected = await window.LayersAgent.setRectangleSelection({
                        x: 20, y: 20, width: 80, height: 60,
                    })
                    if (!selected.ok) throw new Error(selected.error.message)
                }
                const needsEditUi = !startsUnmasked
                if (needsEditUi) app._enterMaskEditMode(layer.id)
                app._markClean()

                const layersArray = app._layers
                const originalMask = layer.mask
                const originalMaskBytes = originalMask
                    ? new Uint8ClampedArray(originalMask.data)
                    : null
                const textureHad = renderer._maskTextures.has(layer.id)
                const originalTexture = renderer._maskTextures.get(layer.id)
                const overlay = document.getElementById('maskOverlay')
                const overlayContext = overlay.getContext('2d')
                const overlayPixels = overlay.width && overlay.height
                    ? overlayContext.getImageData(0, 0, overlay.width, overlay.height)
                    : null
                const banner = document.getElementById('maskEditBanner')
                const brushBtn = document.getElementById('brushToolBtn')
                const eraserBtn = document.getElementById('eraserToolBtn')
                const uiBefore = {
                    editMode: app._maskEditMode,
                    editLayerId: app._maskEditLayerId,
                    currentTool: app._currentTool,
                    strokeHandler: app._brushTool?.onStrokeComplete || null,
                    bannerClass: banner?.className || null,
                    brushTitle: brushBtn?.getAttribute('title') ?? null,
                    eraserTitle: eraserBtn?.getAttribute('title') ?? null,
                    overlayClass: overlay.className,
                    overlayStyle: overlay.style.cssText,
                    overlayWidth: overlay.width,
                    overlayHeight: overlay.height,
                }
                const state = () => ({
                    maskEnabled: layer.maskEnabled,
                    maskVisible: layer.maskVisible,
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
                            error: 'injected mask operation rebuild failure',
                        })
                    }
                    return rebuild(...args)
                }
                const { selectionParamDialog } = await import(
                    '/js/ui/selection-param-dialog.js')
                selectionParamDialog.show = async () => 3

                let outcome = null
                let envelope = null
                if (actor === 'agent') {
                    const command = {
                        add: ['addLayerMask', { layerId: layer.id }],
                        'from-selection': ['addMaskFromSelection', { layerId: layer.id }],
                        delete: ['deleteLayerMask', { layerId: layer.id }],
                        invert: ['invertLayerMask', { layerId: layer.id }],
                        feather: ['featherMask', { layerId: layer.id, radius: 3 }],
                        expand: ['expandMask', { layerId: layer.id, radius: 3 }],
                        contract: ['contractMask', { layerId: layer.id, radius: 3 }],
                        smooth: ['smoothMask', { layerId: layer.id, radius: 3 }],
                        enable: ['setMaskEnabled', { layerId: layer.id, enabled: false }],
                    }[operation]
                    envelope = await window.LayersAgent[command[0]](command[1])
                } else if (operation === 'add') {
                    outcome = await app._addLayerMask(layer.id)
                } else if (operation === 'from-selection') {
                    outcome = await app._maskFromSelection(layer.id)
                } else if (operation === 'delete') {
                    outcome = await app._deleteLayerMask(layer.id)
                } else if (operation === 'invert') {
                    outcome = await app._invertLayerMask(layer.id)
                } else if (operation === 'feather') {
                    outcome = await app._featherLayerMask(layer.id)
                } else if (operation === 'expand') {
                    outcome = await app._expandLayerMask(layer.id)
                } else if (operation === 'contract') {
                    outcome = await app._contractLayerMask(layer.id)
                } else if (operation === 'smooth') {
                    outcome = await app._smoothLayerMask(layer.id)
                } else if (operation === 'enable') {
                    outcome = await app._toggleMaskEnabled(layer.id)
                } else {
                    outcome = await app._exitMaskEditMode()
                }

                const overlayAfter = overlay.width && overlay.height
                    ? overlayContext.getImageData(0, 0, overlay.width, overlay.height)
                    : null
                const uiAfter = {
                    editMode: app._maskEditMode,
                    editLayerId: app._maskEditLayerId,
                    currentTool: app._currentTool,
                    strokeHandler: app._brushTool?.onStrokeComplete || null,
                    bannerClass: banner?.className || null,
                    brushTitle: brushBtn?.getAttribute('title') ?? null,
                    eraserTitle: eraserBtn?.getAttribute('title') ?? null,
                    overlayClass: overlay.className,
                    overlayStyle: overlay.style.cssText,
                    overlayWidth: overlay.width,
                    overlayHeight: overlay.height,
                }
                return {
                    before,
                    after: state(),
                    outcomeStatus: outcome?.status || null,
                    envelope,
                    rebuildCalls,
                    sameLayersArray: app._layers === layersArray,
                    sameLayerObject: app._layers.includes(layer),
                    sameMask: layer.mask === originalMask,
                    sameMaskBytes: !originalMaskBytes || originalMaskBytes.every(
                        (value, index) => layer.mask?.data[index] === value),
                    sameTexturePresence:
                        renderer._maskTextures.has(layer.id) === textureHad,
                    sameTexture:
                        renderer._maskTextures.get(layer.id) === originalTexture,
                    sameUi: uiAfter.editMode === uiBefore.editMode
                        && uiAfter.editLayerId === uiBefore.editLayerId
                        && uiAfter.currentTool === uiBefore.currentTool
                        && uiAfter.strokeHandler === uiBefore.strokeHandler
                        && uiAfter.bannerClass === uiBefore.bannerClass
                        && uiAfter.brushTitle === uiBefore.brushTitle
                        && uiAfter.eraserTitle === uiBefore.eraserTitle
                        && uiAfter.overlayClass === uiBefore.overlayClass
                        && uiAfter.overlayStyle === uiBefore.overlayStyle
                        && uiAfter.overlayWidth === uiBefore.overlayWidth
                        && uiAfter.overlayHeight === uiBefore.overlayHeight,
                    sameOverlayPixels: !overlayPixels || (
                        overlayAfter?.data.length === overlayPixels.data.length
                        && overlayPixels.data.every(
                            (value, index) => overlayAfter.data[index] === value)),
                }
            }, { actor, operation })

            expect(result.rebuildCalls).toBeGreaterThanOrEqual(2)
            expect(result.after).toEqual(result.before)
            expect(result.sameLayersArray).toBe(true)
            expect(result.sameLayerObject).toBe(true)
            expect(result.sameMask).toBe(true)
            expect(result.sameMaskBytes).toBe(true)
            expect(result.sameTexturePresence).toBe(true)
            expect(result.sameTexture).toBe(true)
            expect(result.sameUi).toBe(true)
            expect(result.sameOverlayPixels).toBe(true)
            if (actor === 'agent') {
                expect(result.envelope.ok).toBe(false)
                expect(result.envelope.error.code).toBe('INTERNAL_ERROR')
            } else {
                expect(result.outcomeStatus).toBe('failed')
            }
        })
    }
}

for (const sourceType of ['image', 'video', 'drawing']) {
    test(`${sourceType} delete preserves resource on failure and disposes only after success`, async ({ page }) => {
        await bootSolid(page)

        const result = await page.evaluate(async ({ sourceType, data }) => {
            const app = window.layersApp
            const renderer = app._renderer
            let layerId
            if (sourceType === 'image') {
                const added = await window.LayersAgent.addLayer({
                    kind: 'media',
                    mediaType: 'image',
                    name: 'Atomic image.png',
                    source: { kind: 'base64', data, mimeType: 'image/png' },
                })
                layerId = added.result.layerId
            } else if (sourceType === 'drawing') {
                const added = await window.LayersAgent.paintStroke({
                    points: [[20, 20], [100, 100]],
                    color: '#ff0000',
                    size: 8,
                })
                layerId = added.result.layerId
            } else {
                const { createMediaLayer } = await import('/js/layers/layer-model.js')
                const file = new File([new Uint8Array([0])], 'Atomic video.mp4', {
                    type: 'video/mp4',
                })
                const layer = createMediaLayer(file, 'video', 'Atomic video')
                const resource = {
                    type: 'video',
                    element: document.createElement('video'),
                    width: 16,
                    height: 16,
                    url: null,
                }
                const outcome = await app._commitAddedLayer(layer, {
                    resource,
                    showSuccess: false,
                })
                if (outcome.status !== 'added') throw outcome.error
                layerId = layer.id
            }
            const layer = app._layers.find(candidate => candidate.id === layerId)
            app._layerStack.selectedLayerId = layerId
            app._markClean()
            const layersArray = app._layers
            const resource = renderer.getMediaInfo(layerId)
            const before = {
                layerIds: app._layers.map(candidate => candidate.id),
                selectedLayerIds: app._layerStack.selectedLayerIds,
                selectionAnchor: app._layerStack._lastClickedLayerId,
                dirty: app._isDirty,
                mutationRevision: app._projectMutationRevision,
                undoStackLength: app._undoManager._stack.length,
                undoIndex: app._undoManager._index,
                pendingUndo: Boolean(app._undoDebounceTimer),
            }

            const rebuild = app._rebuild.bind(app)
            let rebuildCalls = 0
            app._rebuild = (...args) => {
                rebuildCalls += 1
                if (rebuildCalls === 1) {
                    return Promise.resolve({
                        success: false,
                        error: 'injected delete rebuild failure',
                    })
                }
                return rebuild(...args)
            }
            const disposeMediaResource = renderer.disposeMediaResource.bind(renderer)
            const disposeAtRebuildCall = []
            renderer.disposeMediaResource = (candidate) => {
                disposeAtRebuildCall.push(rebuildCalls)
                return disposeMediaResource(candidate)
            }

            const failed = await app._handleDeleteLayer(layerId)
            const afterFailure = {
                layerIds: app._layers.map(candidate => candidate.id),
                selectedLayerIds: app._layerStack.selectedLayerIds,
                selectionAnchor: app._layerStack._lastClickedLayerId,
                dirty: app._isDirty,
                mutationRevision: app._projectMutationRevision,
                undoStackLength: app._undoManager._stack.length,
                undoIndex: app._undoManager._index,
                pendingUndo: Boolean(app._undoDebounceTimer),
            }
            const failureRestored = afterFailure.layerIds.includes(layerId)
                && renderer.getMediaInfo(layerId) === resource
                && disposeAtRebuildCall.length === 0
            const sameLayerAfterFailure = app._layers.includes(layer)

            let committed = null
            if (failureRestored) {
                committed = await app._handleDeleteLayer(layerId)
            }
            return {
                before,
                afterFailure,
                failedStatus: failed?.status || null,
                failureRestored,
                sameLayersArray: app._layers === layersArray,
                sameLayerAfterFailure,
                committedStatus: committed?.status || null,
                removedAfterSuccess: committed
                    ? !app._layers.some(candidate => candidate.id === layerId)
                    : false,
                resourceRemovedAfterSuccess: committed
                    ? renderer.getMediaInfo(layerId) === null
                    : false,
                disposedAfterSuccessfulRebuild: disposeAtRebuildCall.length > 0
                    && disposeAtRebuildCall.every(call => call >= 3),
                rebuildCalls,
            }
        }, { sourceType, data: TINY_PNG_B64 })

        expect(result.failedStatus).toBe('failed')
        expect(result.afterFailure).toEqual(result.before)
        expect(result.failureRestored).toBe(true)
        expect(result.sameLayersArray).toBe(true)
        expect(result.sameLayerAfterFailure).toBe(true)
        expect(result.committedStatus).toBe('committed')
        expect(result.removedAfterSuccess).toBe(true)
        expect(result.resourceRemovedAfterSuccess).toBe(true)
        expect(result.disposedAfterSuccessfulRebuild).toBe(true)
        expect(result.rebuildCalls).toBe(3)
    })
}
