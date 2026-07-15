/**
 * Layers App
 * Main entry point
 *
 * @module app
 */

import { LayersRenderer } from './noisemaker/renderer.js'
import {
    createMediaLayer,
    createEffectLayer,
    createChildEffect,
    createDrawingLayer,
    decodeMasks,
    bumpLayerCounter,
} from './layers/layer-model.js'
import './layers/layer-stack.js'
import { EffectParams } from './layers/effect-params.js'
import { openDialog } from './ui/open-dialog.js'
import { addLayerDialog } from './ui/add-layer-dialog.js'
import { aboutDialog } from './ui/about-dialog.js'
import { settingsDialog } from './ui/settings-dialog.js'
import { welcomeDialog, isWelcomeDismissed } from './ui/welcome-dialog.js'
import { saveProjectDialog } from './ui/save-project-dialog.js'
import { projectManagerDialog } from './ui/project-manager-dialog.js'
import { confirmDialog } from './ui/confirm-dialog.js'
import { infoDialog } from './ui/info-dialog.js'
import { toast } from './ui/toast.js'
import { imageSizeDialog } from './ui/image-size-dialog.js'
import { canvasResizeDialog } from './ui/canvas-resize-dialog.js'
import { exportPng, exportJpg, getTimestampedFilename } from './utils/export.js'
import { saveProject, loadProject } from './utils/project-storage.js'
import { registerServiceWorker } from './sw-register.js'
import { SelectionManager } from './selection/selection-manager.js'
import { copySelection, pasteFromClipboard, copyCanvasToClipboard, getSelectionBounds } from './selection/clipboard-ops.js'
import { MoveTool } from './tools/move-tool.js'
import { TransformTool } from './tools/transform-tool.js'
import { BrushTool } from './tools/brush-tool.js'
import { EraserTool } from './tools/eraser-tool.js'
import { ShapeTool } from './tools/shape-tool.js'
import { FillTool } from './tools/fill-tool.js'
import { EyedropperTool } from './tools/eyedropper-tool.js'
import { UndoManager } from './utils/undo-manager.js'
import { invertMask, expandMask, contractMask, borderMask, featherMask, smoothMask, colorRange } from './selection/selection-modify.js'
import { selectionParamDialog } from './ui/selection-param-dialog.js'
import { Files } from './utils/files.js'
import { ExportImageDialog } from './ui/export-image-dialog.js'
import { ExportVideoDialog } from './ui/export-video-dialog.js'
import { getFontaineLoader, BASE_FONTS } from './layers/fontaine-loader.js'
import * as strokeModel from './drawing/stroke-model.js'
import { StrokeRenderer } from './drawing/stroke-renderer.js'
import { autoLevels, autoContrast, autoWhiteBalance } from './utils/auto-adjust.js'
import { bootstrapAgent } from './agent/index.js'
import { captureProjectSnapshotOverride } from './agent/snapshot.js'
import { SeanceDialog } from 'handfish'  // Register <seance-dialog> custom element
import { createLayersOnlineAdapter } from './collab/onlineAdapter.js'
import { assertRemoteNodeSemantics } from './collab/docModel.js'

const ONLINE_COLLABORATION_FEATURE = 'onlineCollaboration'
const MAX_CANVAS_DIMENSION = 8192

/**
 * Feature-flag check for online collaboration. Ships enabled by default;
 * the flag machinery stays as a code-level kill-switch (mirrors
 * polymorphic/noisedeck) — remove the DEFAULTS entry to re-gate it.
 * @param {string} name
 * @returns {boolean}
 */
function isFeatureEnabled(name) {
    const DEFAULTS = { onlineCollaboration: true }
    if (DEFAULTS[name]) return true
    const params = new URLSearchParams(window.location.search)
    const fromUrl = (params.get('features') || '').split(',').map(s => s.trim()).filter(Boolean)
    if (fromUrl.includes(name)) return true
    try {
        return localStorage.getItem(`feature.${name}`) === 'true'
    } catch {
        return false
    }
}

/**
 * Main application class
 */
class LayersApp {
    constructor() {
        this._renderer = null
        this._layerStack = null
        this._layers = []
        this._initialized = false
        this._currentProjectId = null
        this._currentProjectName = null
        this._isDirty = false
        this._zoomMode = 'fit' // 'fit', '50', '100', '200'
        this._selectionManager = null
        this._copyOrigin = null
        this._colorRangePicking = false
        this._colorRangePickCleanup = null
        this._moveTool = null
        this._currentTool = 'selection' // 'selection' | 'move' | 'clone' | 'transform' | 'brush' | 'eraser' | 'shape' | 'fill' | 'eyedropper'
        this._previousTool = 'selection'

        // Global foreground color
        this._foregroundColor = '#000000'

        // Drawing layer counter
        this._drawingLayerCounter = 0
        this._drawingMutationTail = Promise.resolve()

        // Layer reorder FSM state
        this._reorderState = 'IDLE'  // IDLE | DRAGGING | PROCESSING | ROLLING_BACK
        this._reorderSnapshot = null  // { layers, dsl }
        this._reorderSource = null    // { layerId, index }
        this._reorderMutationToken = null
        this._reorderGeneration = null

        // Undo/redo
        this._undoManager = new UndoManager(50)
        this._undoDebounceTimer = null
        this._restoring = false

        // Mask editing
        this._maskEditMode = false
        this._maskEditLayerId = null
        this._maskMutationTail = Promise.resolve()

        // Seance online collaboration adapter — created in init() when the
        // onlineCollaboration feature flag is enabled (default: on).
        this._onlineAdapter = null

        // Project replacements prepare outside the committed workspace. A
        // monotonic generation makes older candidates stale, while the tail
        // serializes the short renderer stage/commit section.
        this._replacementGeneration = 0
        this._projectMutationRevision = 0
        this._projectReplacementGuardTail = Promise.resolve()
        this._projectLifecycleTail = Promise.resolve()
        this._projectLifecycleOwner = null
        this._projectLifecycleWaiters = 0
        this._projectLifecycleActive = false
        this._projectReplacementGate = null
        this._projectReplacementActive = false
        this._projectInstallTail = Promise.resolve()
        this._projectSnapshotCanvasOverride = null
        this._publishTransactionDepth = 0
    }

    /**
     * Mark the project as having unsaved changes
     * @private
     */
    _markDirty() {
        this._projectMutationRevision += 1
        this._isDirty = true
    }

    /**
     * Mark the project as saved (no unsaved changes)
     * @private
     */
    _markClean() {
        this._projectMutationRevision += 1
        this._isDirty = false
    }

    /** @private */
    _captureProjectSnapshotOverride(options = {}) {
        return captureProjectSnapshotOverride(this, options)
    }

    /** @private */
    _beginPublishTransaction() {
        const previousOverride = this._projectSnapshotCanvasOverride
        const override = this._captureProjectSnapshotOverride()
        this._projectSnapshotCanvasOverride = override
        this._publishTransactionDepth += 1
        return { previousOverride, override, active: true }
    }

    /** @private */
    _endPublishTransaction(transaction) {
        if (!transaction?.active) return
        transaction.active = false
        this._publishTransactionDepth -= 1
        if (this._projectSnapshotCanvasOverride === transaction.override) {
            this._projectSnapshotCanvasOverride = transaction.previousOverride
        }
    }

    /**
     * Deep-clone the layer array for undo snapshots.
     * File objects are immutable so sharing references is fine.
     * @returns {Array} Cloned layer array
     * @private
     */
    _cloneLayers(layers) {
        return layers.map(l => {
            const clone = {
                ...l,
                effectParams: JSON.parse(JSON.stringify(l.effectParams)),
                children: (l.children || []).map(c => ({
                    ...c,
                    effectParams: JSON.parse(JSON.stringify(c.effectParams))
                }))
            }
            if (l.sourceType === 'drawing') {
                clone.strokes = JSON.parse(JSON.stringify(l.strokes || []))
                clone.drawingCanvas = null
            }
            if (l.mask) {
                clone.mask = new ImageData(
                    new Uint8ClampedArray(l.mask.data),
                    l.mask.width, l.mask.height
                )
            }
            return clone
        })
    }

    /** @private */
    _createUndoSnapshot(
        layers = this._layers,
        canvasWidth = this._canvas.width,
        canvasHeight = this._canvas.height,
        mediaTextures = this._renderer._mediaTextures
    ) {
        const mediaCanvases = new Map()
        for (const layer of layers) {
            if (layer.sourceType !== 'media' || layer.mediaFile) continue
            const resource = mediaTextures.get(layer.id)
            if (typeof resource?.element?.getContext !== 'function') continue
            mediaCanvases.set(layer.id, resource.element)
        }
        return {
            layers: this._cloneLayers(layers),
            canvasWidth,
            canvasHeight,
            mediaCanvases,
            selectedLayerIds: this._layerStack?.selectedLayerIds?.slice() || [],
            selectionAnchor: this._layerStack?._lastClickedLayerId ?? null,
        }
    }

    /** @private */
    _validSelectionForLayers(layers, selectedLayerIds, selectionAnchor) {
        const validIds = new Set()
        for (const layer of layers) {
            validIds.add(layer.id)
            for (const child of layer.children || []) validIds.add(child.id)
        }
        const requested = Array.isArray(selectedLayerIds) ? selectedLayerIds : []
        let selected = [...new Set(requested.filter(id => validIds.has(id)))]
        if (selected.length === 0 && requested.length > 0 && layers.length > 0) {
            selected = [layers.at(-1).id]
        }
        const anchor = validIds.has(selectionAnchor)
            ? selectionAnchor
            : (selected.at(-1) || null)
        return { selectedLayerIds: selected, selectionAnchor: anchor }
    }

    /**
     * Push current state onto the undo stack (call AFTER mutation).
     * Cancels any pending debounce timer.
     * @private
     */
    _pushUndoState() {
        if (this._undoDebounceTimer) {
            clearTimeout(this._undoDebounceTimer)
            this._undoDebounceTimer = null
        }
        this._undoManager.pushState(this._createUndoSnapshot())
        this._updateUndoMenuState()
        // Publish funnel, systemic form: every composition mutation path in
        // this app records undo (directly or via the debounced sibling
        // below), so hooking it here — rather than every tool call site —
        // covers transform/move/clone/flip and any future mutation for
        // free. schedulePublish() is a 150ms-debounced diff against the
        // last-published model; by flush time the mutation has landed, so
        // this is safe even when _pushUndoState() is called before the
        // caller's own mutation finishes. Redundant with the _rebuild()/
        // param-path hooks (schedulePublish() is idempotent while a publish
        // is already pending) but harmless.
        this._onlineAdapter?.schedulePublish()
    }

    /**
     * Push undo state after a delay, coalescing rapid changes (slider drags).
     * Each call resets the 500ms timer. When the timer fires, the final
     * state is committed as one undo step.
     * @private
     */
    _pushUndoStateDebounced() {
        if (this._undoDebounceTimer) {
            clearTimeout(this._undoDebounceTimer)
        }
        this._undoDebounceTimer = setTimeout(() => {
            this._undoDebounceTimer = null
            this._pushUndoState()
        }, 500)
        // Update menu immediately so undo shows as available
        this._updateUndoMenuState()
        // Also re-arm the (much shorter) publish debounce immediately rather
        // than waiting for the 500ms undo timer to settle — during a
        // continuous drag (transform/move) this call repeats on every
        // mousemove, so this keeps peers seeing progressive updates roughly
        // every 150ms instead of only once the drag stops.
        this._onlineAdapter?.schedulePublish()
    }

    /**
     * If a debounce timer is pending, finalize it immediately.
     * Call this before any non-debounced mutation so slider changes
     * get their own undo step.
     * @private
     */
    _finalizePendingUndo() {
        if (this._undoDebounceTimer) {
            clearTimeout(this._undoDebounceTimer)
            this._undoDebounceTimer = null
            this._pushUndoState()
        }
    }

    /** @private */
    _capturePointerGestureMutationState() {
        const activeLayer = this._getActiveLayer()
        const activeLayerPosition = activeLayer
            ? {
                layerId: activeLayer.id,
                effectParams: activeLayer.effectId === 'filter/text'
                    ? activeLayer.effectParams
                    : null,
                hadOffsetX: Object.hasOwn(activeLayer, 'offsetX'),
                hadOffsetY: Object.hasOwn(activeLayer, 'offsetY'),
                offsetX: activeLayer.offsetX,
                offsetY: activeLayer.offsetY,
            }
            : null
        return {
            dirty: this._isDirty,
            mutationRevision: this._projectMutationRevision,
            undoStackArray: this._undoManager._stack,
            undoStack: this._undoManager._stack.slice(),
            undoIndex: this._undoManager._index,
            undoWasPending: this._undoDebounceTimer !== null,
            activeLayerPosition,
        }
    }

    /** @private */
    _restorePointerGestureMutationState(previous) {
        if (!previous) return
        if (this._undoDebounceTimer) {
            clearTimeout(this._undoDebounceTimer)
            this._undoDebounceTimer = null
        }
        this._isDirty = previous.dirty
        this._projectMutationRevision = previous.mutationRevision
        previous.undoStackArray.splice(
            0, previous.undoStackArray.length, ...previous.undoStack)
        this._undoManager._stack = previous.undoStackArray
        this._undoManager._index = previous.undoIndex
        if (previous.undoWasPending) this._pushUndoStateDebounced()
        else this._updateUndoMenuState()
        this._onlineAdapter?.schedulePublish()
    }

    /** @private */
    _captureLayerMutationState() {
        return {
            layersArray: this._layers,
            layers: this._layers.slice(),
            selectedLayerIds: this._layerStack?.selectedLayerIds?.slice() || [],
            selectionAnchor: this._layerStack?._lastClickedLayerId ?? null,
            dirty: this._isDirty,
            mutationRevision: this._projectMutationRevision,
            drawingLayerCounter: this._drawingLayerCounter,
            undoStackArray: this._undoManager._stack,
            undoStack: this._undoManager._stack.slice(),
            undoIndex: this._undoManager._index,
            undoWasPending: this._undoDebounceTimer !== null,
        }
    }

    /** @private */
    _restoreLayerMutationState(previous) {
        if (this._undoDebounceTimer) {
            clearTimeout(this._undoDebounceTimer)
            this._undoDebounceTimer = null
        }
        previous.layersArray.splice(0, previous.layersArray.length, ...previous.layers)
        this._layers = previous.layersArray
        this._isDirty = previous.dirty
        this._projectMutationRevision = previous.mutationRevision
        this._drawingLayerCounter = previous.drawingLayerCounter
        previous.undoStackArray.splice(
            0, previous.undoStackArray.length, ...previous.undoStack)
        this._undoManager._stack = previous.undoStackArray
        this._undoManager._index = previous.undoIndex
        this._updateLayerStack()
        if (this._layerStack) {
            this._layerStack.selectedLayerIds = previous.selectedLayerIds
            this._layerStack._lastClickedLayerId = previous.selectionAnchor
        }
        if (previous.undoWasPending) this._pushUndoStateDebounced()
        else this._updateUndoMenuState()
    }

    /** @private */
    async _rollbackLayerMutation(previous, primaryError, restore = null) {
        const primary = primaryError instanceof Error
            ? primaryError
            : new Error(String(primaryError))
        const restoreErrors = []
        try {
            this._restoreLayerMutationState(previous)
        } catch (err) {
            restoreErrors.push(err instanceof Error ? err : new Error(String(err)))
        }
        if (restore) {
            try {
                await restore()
            } catch (err) {
                restoreErrors.push(err instanceof Error ? err : new Error(String(err)))
            }
        }
        let restoreError = null
        try {
            const result = await this._rebuild({ force: true })
            if (!result?.success) {
                restoreError = new Error(result?.error || 'Unknown renderer restoration failure')
            }
        } catch (err) {
            restoreError = err instanceof Error ? err : new Error(String(err))
        }
        const failures = restoreErrors.map(error => error.message)
        if (restoreError) failures.push(restoreError.message)
        if (failures.length > 0) {
            return {
                status: 'failed', error: new Error(
                    `${primary.message}; failed to restore previous state: ${failures.join('; ')}`)
            }
        }
        return { status: 'failed', error: primary }
    }

    /** @private */
    _captureModelMutationState() {
        const objects = []
        const arrays = [{ array: this._layers, values: this._layers.slice() }]
        const visit = (object) => {
            objects.push({
                object,
                fields: new Map(Object.keys(object).map(key => [key, object[key]])),
            })
            if (Array.isArray(object.children)) {
                arrays.push({ array: object.children, values: object.children.slice() })
                object.children.forEach(visit)
            }
        }
        this._layers.forEach(visit)
        return { objects, arrays }
    }

    /** @private */
    _restoreModelMutationState(previous) {
        for (const { object, fields } of previous.objects) {
            for (const key of Object.keys(object)) {
                if (!fields.has(key)) delete object[key]
            }
            for (const [key, value] of fields) object[key] = value
        }
        for (const { array, values } of previous.arrays) {
            array.splice(0, array.length, ...values)
        }
        this._layers = previous.arrays[0].array
    }

    /** @private */
    _captureMaskEditUiState() {
        const overlay = document.getElementById('maskOverlay')
        const pixels = overlay?.width && overlay?.height
            ? overlay.getContext('2d').getImageData(
                0, 0, overlay.width, overlay.height)
            : null
        const banner = document.getElementById('maskEditBanner')
        const brushBtn = document.getElementById('brushToolBtn')
        const eraserBtn = document.getElementById('eraserToolBtn')
        return {
            editMode: this._maskEditMode,
            editLayerId: this._maskEditLayerId,
            currentTool: this._currentTool,
            strokeHandler: this._brushTool?.onStrokeComplete || null,
            bannerClass: banner?.className ?? null,
            brushTitle: brushBtn?.getAttribute('title') ?? null,
            eraserTitle: eraserBtn?.getAttribute('title') ?? null,
            overlayClass: overlay?.className ?? null,
            overlayStyle: overlay?.style.cssText ?? null,
            overlayWidth: overlay?.width ?? 0,
            overlayHeight: overlay?.height ?? 0,
            pixels,
        }
    }

    /** @private */
    _restoreMaskEditUiState(previous) {
        this._maskEditMode = previous.editMode
        this._maskEditLayerId = previous.editLayerId
        this._currentTool = previous.currentTool
        if (this._brushTool) this._brushTool.onStrokeComplete = previous.strokeHandler

        const banner = document.getElementById('maskEditBanner')
        if (banner && previous.bannerClass !== null) banner.className = previous.bannerClass
        const restoreAttribute = (element, name, value) => {
            if (!element) return
            if (value === null) element.removeAttribute(name)
            else element.setAttribute(name, value)
        }
        restoreAttribute(document.getElementById('brushToolBtn'), 'title', previous.brushTitle)
        restoreAttribute(document.getElementById('eraserToolBtn'), 'title', previous.eraserTitle)

        const overlay = document.getElementById('maskOverlay')
        if (!overlay) return
        overlay.width = previous.overlayWidth
        overlay.height = previous.overlayHeight
        if (previous.overlayClass !== null) overlay.className = previous.overlayClass
        if (previous.overlayStyle !== null) overlay.style.cssText = previous.overlayStyle
        if (previous.pixels) overlay.getContext('2d').putImageData(previous.pixels, 0, 0)
    }

    /** @private */
    async _commitModelMutation(mutate, {
        rebuildOptions = {},
        updateLayerStack = false,
        updateLayerZIndex = false,
        markDirty = true,
        pushUndo = true,
        finalizePendingUndo = true,
        render = null,
        restore = null,
        selectedLayerIds = undefined,
        selectionAnchor = undefined,
    } = {}) {
        const previous = this._captureLayerMutationState()
        const previousModel = this._captureModelMutationState()
        const transaction = this._beginPublishTransaction()
        try {
            if (finalizePendingUndo) this._finalizePendingUndo()
            const value = await mutate()
            if (updateLayerStack) this._updateLayerStack()
            if (selectedLayerIds !== undefined && this._layerStack) {
                const nextSelection = this._validSelectionForLayers(
                    this._layers, selectedLayerIds, selectionAnchor)
                this._layerStack.selectedLayerIds = nextSelection.selectedLayerIds
                this._layerStack._lastClickedLayerId = nextSelection.selectionAnchor
            }
            const result = render
                ? await render()
                : await this._rebuild(rebuildOptions)
            if (!result?.success) {
                throw new Error(result?.error || 'Failed to render model mutation')
            }
            if (updateLayerZIndex) this._updateLayerZIndex()
            if (markDirty) this._markDirty()
            if (pushUndo === 'debounced') this._pushUndoStateDebounced()
            else if (pushUndo) this._pushUndoState()
            return { status: 'committed', value }
        } catch (err) {
            return await this._rollbackLayerMutation(previous, err, async () => {
                this._restoreModelMutationState(previousModel)
                this._updateLayerStack()
                if (this._layerStack) {
                    this._layerStack.selectedLayerIds = previous.selectedLayerIds
                    this._layerStack._lastClickedLayerId = previous.selectionAnchor
                }
                if (restore) await restore()
            })
        } finally {
            this._endPublishTransaction(transaction)
        }
    }

    /** @private */
    _commitMaskMutation(layer, mutate, options = {}) {
        const commit = () => {
            const previousMask = layer.mask
            const previousMaskBytes = previousMask
                ? new Uint8ClampedArray(previousMask.data)
                : null
            const textureHad = this._renderer._maskTextures.has(layer.id)
            const previousTexture = this._renderer._maskTextures.get(layer.id)
            const previousUi = this._captureMaskEditUiState()
            const externalRestore = options.restore
            return this._commitModelMutation(mutate, {
                ...options,
                restore: async () => {
                    if (previousMask && previousMaskBytes) {
                        previousMask.data.set(previousMaskBytes)
                        layer.mask = previousMask
                    }
                    if (textureHad) {
                        this._renderer._maskTextures.set(layer.id, previousTexture)
                    } else {
                        this._renderer._maskTextures.delete(layer.id)
                    }
                    this._restoreMaskEditUiState(previousUi)
                    if (externalRestore) await externalRestore()
                },
            })
        }
        const pending = this._maskMutationTail.then(commit, commit)
        this._maskMutationTail = pending.then(() => undefined, () => undefined)
        return pending
    }

    /** @private */
    _capturePreparedLayerMutationState() {
        return {
            layerState: this._captureLayerMutationState(),
            selectionPath: this._selectionManager?.selectionPath ?? null,
            canvasWidth: this._canvas.width,
            canvasHeight: this._canvas.height,
            rendererRunning: this._renderer.isRunning,
        }
    }

    /** @private */
    _disposeDetachedMediaTextures(mediaTextures, retainedTextures) {
        const retained = new Set(retainedTextures.values())
        const disposed = new Set()
        for (const resource of mediaTextures.values()) {
            if (retained.has(resource) || disposed.has(resource)) continue
            this._renderer.disposeMediaResource(resource)
            disposed.add(resource)
        }
        mediaTextures.clear()
    }

    /** @private */
    async _restoreRendererRunState(wasRunning) {
        if (!wasRunning) {
            if (this._renderer.isRunning) this._renderer.stop()
            this._renderCurrentFrame()
            return
        }
        if (this._renderer.isRunning) return
        await new Promise(resolve => requestAnimationFrame(resolve))
        this._renderer.start()
    }

    /**
     * Stage a complete detached layer/resource set, then commit app-owned
     * state only after the renderer proves the candidate compilable.
     * @private
     */
    async _commitPreparedLayerMutation(candidate, {
        previousState = null,
        selectedLayerIds = null,
        selectionAnchor = null,
        selectionPath,
        markDirty = true,
        pushUndo = true,
        finalizePendingUndo = true,
        beforeStage = null,
        restoreBeforeRollback = null,
        shouldCancel = null,
        value = null,
    } = {}) {
        const previous = previousState || this._capturePreparedLayerMutationState()
        const previousTextures = new Map(this._renderer._mediaTextures)
        let stage = null
        let candidateOwned = true

        const restoreAppState = async () => {
            const errors = []
            if (restoreBeforeRollback) {
                try {
                    await restoreBeforeRollback()
                } catch (err) {
                    errors.push(err instanceof Error ? err : new Error(String(err)))
                }
            }
            try {
                this._restoreLayerMutationState(previous.layerState)
                if (this._canvas.width !== previous.canvasWidth
                    || this._canvas.height !== previous.canvasHeight) {
                    this._resizeCanvas(previous.canvasWidth, previous.canvasHeight)
                }
                if (previous.selectionPath) {
                    this._selectionManager?.setSelection(previous.selectionPath)
                } else {
                    this._selectionManager?.clearSelection()
                }
            } catch (err) {
                errors.push(err instanceof Error ? err : new Error(String(err)))
            }
            return errors
        }

        const fail = async (primaryError) => {
            const primary = primaryError instanceof Error
                ? primaryError
                : new Error(String(primaryError))
            const stateRestoreErrors = await restoreAppState()
            let rendererRestoreErrors = []
            if (stage) {
                try {
                    const result = await stage.rollback()
                    stage = null
                    if (!result?.success) {
                        rendererRestoreErrors.push(new Error(
                            result?.error || 'Unknown renderer restoration failure'))
                    }
                } catch (err) {
                    stage = null
                    rendererRestoreErrors.push(
                        err instanceof Error ? err : new Error(String(err)))
                }
            } else if (candidateOwned) {
                try {
                    this._disposeDetachedMediaTextures(
                        candidate.mediaTextures, previousTextures)
                    candidate.maskTextures.clear()
                    candidateOwned = false
                } catch (err) {
                    rendererRestoreErrors.push(
                        err instanceof Error ? err : new Error(String(err)))
                }
            }
            if (rendererRestoreErrors.length > 0) {
                try {
                    const retry = await this._rebuild({ force: true })
                    if (retry?.success) rendererRestoreErrors = []
                    else rendererRestoreErrors.push(new Error(
                        retry?.error || 'Unknown renderer restoration retry failure'))
                } catch (err) {
                    rendererRestoreErrors.push(
                        err instanceof Error ? err : new Error(String(err)))
                }
            }
            try {
                await this._restoreRendererRunState(previous.rendererRunning)
            } catch (err) {
                rendererRestoreErrors.push(
                    err instanceof Error ? err : new Error(String(err)))
            }
            const restoreErrors = [...stateRestoreErrors, ...rendererRestoreErrors]
            return {
                status: 'failed',
                error: restoreErrors.length === 0
                    ? primary
                    : new Error(`${primary.message}; failed to restore previous state: ${restoreErrors.map(error => error.message).join('; ')}`),
            }
        }

        const transaction = this._beginPublishTransaction()
        try {
            if (shouldCancel?.()) return await fail(new Error('Mutation cancelled'))
            if (finalizePendingUndo) this._finalizePendingUndo()
            if (beforeStage) await beforeStage()
            if (candidate.width !== this._canvas.width
                || candidate.height !== this._canvas.height) {
                this._renderer.stop()
                this._resizeCanvas(candidate.width, candidate.height)
                await new Promise(resolve => queueMicrotask(resolve))
            }
            stage = await this._renderer.stageLayerSet(candidate)
            candidateOwned = false
            if (!stage.success) {
                return await fail(new Error(stage.error || 'Candidate render failed'))
            }
            if (shouldCancel?.()) return await fail(new Error('Mutation cancelled'))

            this._layers = candidate.layers
            this._updateLayerStack()
            const nextSelection = this._validSelectionForLayers(
                candidate.layers,
                selectedLayerIds ?? previous.layerState.selectedLayerIds,
                selectionAnchor ?? previous.layerState.selectionAnchor)
            if (this._layerStack) {
                this._layerStack.selectedLayerIds = nextSelection.selectedLayerIds
                this._layerStack._lastClickedLayerId = nextSelection.selectionAnchor
            }
            if (selectionPath !== undefined) {
                if (selectionPath) this._selectionManager?.setSelection(selectionPath)
                else this._selectionManager?.clearSelection()
            }
            if (markDirty) this._markDirty()
            if (pushUndo) this._pushUndoState()
            else this._updateUndoMenuState()

            await this._restoreRendererRunState(previous.rendererRunning)
            if (shouldCancel?.()) return await fail(new Error('Mutation cancelled'))
            const committedStage = stage
            stage = null
            try {
                const commitResult = committedStage.commit()
                if (commitResult?.success === false) {
                    console.error('[Layers] Failed to retire prepared mutation resources:',
                        commitResult.error || 'Unknown renderer cleanup failure')
                }
            } catch (err) {
                console.error('[Layers] Failed to retire prepared mutation resources:', err)
            }
            return { status: 'committed', value }
        } catch (err) {
            return await fail(err)
        } finally {
            this._endPublishTransaction(transaction)
        }
    }

    /** @private */
    async _prepareLayerSetCandidate(layers, width, height, {
        reuseMediaIds = new Set(),
        reuseMaskIds = new Set(),
        mediaOverrides = new Map(),
        maskOverrides = new Map(),
    } = {}) {
        // Calling this method transfers ownership of every detached media
        // override. The returned candidate owns them on success; this method
        // disposes them on preparation failure.
        const mediaTextures = new Map(
            [...mediaOverrides].filter(([, resource]) => Boolean(resource)))
        const maskTextures = new Map()
        try {
            for (const layer of layers) {
                if (mediaOverrides.has(layer.id)) {
                    const resource = mediaOverrides.get(layer.id)
                    if (resource) mediaTextures.set(layer.id, resource)
                } else if (reuseMediaIds.has(layer.id)) {
                    const resource = this._renderer._mediaTextures.get(layer.id)
                    if (resource) mediaTextures.set(layer.id, resource)
                } else if (layer.sourceType === 'media' && layer.mediaFile) {
                    const resource = await this._renderer.prepareMediaResource(
                        layer.mediaFile, layer.mediaType)
                    if (resource) mediaTextures.set(layer.id, resource)
                } else if (layer.sourceType === 'drawing') {
                    const canvas = await this._createDrawingLayerCanvas(layer, width, height)
                    if (canvas) {
                        mediaTextures.set(
                            layer.id, this._renderer.prepareCanvasMediaResource(canvas))
                    }
                }

                if (maskOverrides.has(layer.id)) {
                    const texture = maskOverrides.get(layer.id)
                    if (texture) maskTextures.set(layer.id, texture)
                } else if (reuseMaskIds.has(layer.id)) {
                    const texture = this._renderer._maskTextures.get(layer.id)
                    if (texture) maskTextures.set(layer.id, texture)
                } else if (layer.mask) {
                    maskTextures.set(layer.id, this._renderer.prepareMaskTexture(layer.mask))
                }
            }
            return { layers, width, height, mediaTextures, maskTextures }
        } catch (err) {
            this._disposeDetachedMediaTextures(
                mediaTextures, this._renderer._mediaTextures)
            maskTextures.clear()
            throw err
        }
    }

    /** @private */
    async _commitAddedLayer(layer, {
        resource = null,
        showSuccess = true,
    } = {}) {
        let candidate
        try {
            candidate = await this._prepareLayerSetCandidate(
                [...this._layers, layer], this._canvas.width, this._canvas.height, {
                    reuseMediaIds: new Set(this._renderer._mediaTextures.keys()),
                    reuseMaskIds: new Set(this._renderer._maskTextures.keys()),
                    mediaOverrides: resource
                        ? new Map([[layer.id, resource]])
                        : new Map(),
                })
        } catch (err) {
            return { status: 'failed', error: err }
        }
        const outcome = await this._commitPreparedLayerMutation(candidate, {
            selectedLayerIds: [layer.id],
            selectionAnchor: layer.id,
            value: layer.id,
        })
        if (outcome.status !== 'committed') {
            return outcome
        }
        if (showSuccess) {
            try {
                toast.success(`Added layer: ${layer.name}`)
            } catch (err) {
                console.error('[Layers] Failed to show layer confirmation:', err)
            }
        }
        return { status: 'added', layerId: layer.id }
    }

    /**
     * Restore a snapshot from the undo stack
     * @param {object} snapshot - { layers, canvasWidth, canvasHeight }
     * @private
     */
    async _restoreState(snapshot, previousState = null) {
        const previous = previousState || this._capturePreparedLayerMutationState()
        const selection = this._validSelectionForLayers(
            snapshot.layers,
            snapshot.selectedLayerIds ?? previous.layerState.selectedLayerIds,
            snapshot.selectionAnchor ?? previous.layerState.selectionAnchor)
        let candidate
        try {
            const mediaOverrides = new Map()
            for (const [layerId, canvas] of snapshot.mediaCanvases || []) {
                mediaOverrides.set(
                    layerId, this._renderer.prepareCanvasMediaResource(canvas))
            }
            candidate = await this._prepareLayerSetCandidate(
                this._cloneLayers(snapshot.layers),
                snapshot.canvasWidth, snapshot.canvasHeight, { mediaOverrides })
        } catch (err) {
            this._restoreLayerMutationState(previous.layerState)
            return { status: 'failed', error: err }
        }
        return this._commitPreparedLayerMutation(candidate, {
            previousState: previous,
            finalizePendingUndo: false,
            pushUndo: false,
            ...selection,
        })
    }

    /**
     * Undo the last action
     * @private
     */
    async _undo() {
        if (this._restoring) return { status: 'committed' }
        const transaction = this._beginPublishTransaction()
        try {
            const previous = this._capturePreparedLayerMutationState()
            this._finalizePendingUndo()
            const snapshot = this._undoManager.undo()
            if (snapshot) {
                this._restoring = true
                try { return await this._restoreState(snapshot, previous) }
                finally { this._restoring = false }
            }
            return { status: 'committed' }
        } finally {
            this._endPublishTransaction(transaction)
        }
    }

    /**
     * Redo the last undone action
     * @private
     */
    async _redo() {
        if (this._restoring) return { status: 'committed' }
        const transaction = this._beginPublishTransaction()
        try {
            const previous = this._capturePreparedLayerMutationState()
            this._finalizePendingUndo()
            const snapshot = this._undoManager.redo()
            if (snapshot) {
                this._restoring = true
                try { return await this._restoreState(snapshot, previous) }
                finally { this._restoring = false }
            }
            return { status: 'committed' }
        } finally {
            this._endPublishTransaction(transaction)
        }
    }

    /**
     * Update undo/redo menu item disabled states
     * @private
     */
    _updateUndoMenuState() {
        const undoItem = document.getElementById('undoMenuItem')
        const redoItem = document.getElementById('redoMenuItem')
        // Pending debounce timer means uncommitted changes exist that _undo() can finalize
        const canUndo = this._undoManager.canUndo() || this._undoDebounceTimer !== null
        if (undoItem) undoItem.classList.toggle('disabled', !canUndo)
        if (redoItem) redoItem.classList.toggle('disabled', !this._undoManager.canRedo())
    }

    /**
     * Check for unsaved changes and prompt user
     * @returns {Promise<boolean>} true if ok to proceed, false to cancel
     * @private
     */
    async _confirmUnsavedChanges() {
        if (!this._isDirty) {
            return true
        }

        return confirmDialog.show({
            message: 'You have unsaved changes. Discard them?',
            confirmText: 'Discard',
            cancelText: 'Cancel',
            danger: true
        })
    }

    /**
     * If a Seance session is online, confirm that the user is willing to
     * leave it. This guard is deliberately non-mutating: the session only
     * goes offline when a selected replacement successfully commits.
     * @returns {Promise<boolean>} true if ok to proceed, false to cancel
     * @private
     */
    async _confirmLeaveOnlineSession() {
        if (!this._onlineAdapter?.isOnline()) return true

        const ok = await confirmDialog.show({
            message: 'This will take your Layers session offline. Continue?',
            confirmText: 'Go Offline',
            cancelText: 'Cancel'
        })
        return ok
    }

    /**
     * Initialize the application
     */
    async init() {
        console.debug('[Layers] Initializing...')

        settingsDialog.initTheme()

        // Register service worker for PWA support (disabled)
        // registerServiceWorker()

        // Get DOM elements
        this._canvas = document.getElementById('canvas')
        this._layerStack = document.querySelector('layer-stack')

        // Get selection overlay
        this._selectionOverlay = document.getElementById('selectionOverlay')

        // Initialize selection manager
        this._selectionManager = new SelectionManager()
        if (this._selectionOverlay) {
            this._selectionManager.init(this._selectionOverlay)
        }

        // Set source canvas for magic wand
        this._selectionManager.setSourceCanvas(this._canvas)
        this._selectionManager.onSelectionChange = () => {
            this._updateImageMenu()
            this._updateSelectMenu()
        }

        const getLayerPosition = (layer) => {
            if (layer?.effectId === 'filter/text') {
                return {
                    x: (layer.effectParams?.posX ?? 0.5) * this._canvas.width,
                    y: (layer.effectParams?.posY ?? 0.5) * this._canvas.height
                }
            }
            return { x: layer?.offsetX || 0, y: layer?.offsetY || 0 }
        }

        // Initialize move tool (destructive - punches holes)
        this._moveTool = new MoveTool({
            overlay: this._selectionOverlay,
            selectionManager: this._selectionManager,
            getActiveLayer: () => this._getActiveLayer(),
            getSelectedLayers: () => this._layerStack?.selectedLayerIds || [],
            updateLayerPosition: (x, y) => this._updateActiveLayerPosition(x, y),
            restoreLayerPosition: (x, y, state) =>
                this._restoreActiveLayerPosition(x, y, state),
            captureMutationState: () => this._capturePointerGestureMutationState(),
            getLayerPosition,
            extractSelection: (destructive, shouldCancel) =>
                this._extractSelectionToLayer(destructive, shouldCancel),
            showNoLayerDialog: () => this._showNoLayerSelectedDialog(),
            selectTopmostLayer: () => this._selectTopmostLayer(),
            isLayerBlocked: (layer) => {
                if (layer?.mediaType === 'video') {
                    toast.warning('Move tool not available for video clip layers')
                    return true
                }
                return false
            },
            acquireMutation: (existingToken) =>
                this._tryAcquireProjectLifecycle(existingToken),
            destructive: true,
            toolClass: 'move-tool'
        })

        // Initialize clone tool (non-destructive - just clones)
        this._cloneTool = new MoveTool({
            overlay: this._selectionOverlay,
            selectionManager: this._selectionManager,
            getActiveLayer: () => this._getActiveLayer(),
            getSelectedLayers: () => this._layerStack?.selectedLayerIds || [],
            updateLayerPosition: (x, y) => this._updateActiveLayerPosition(x, y),
            restoreLayerPosition: (x, y, state) =>
                this._restoreActiveLayerPosition(x, y, state),
            captureMutationState: () => this._capturePointerGestureMutationState(),
            getLayerPosition,
            extractSelection: (destructive, shouldCancel) =>
                this._extractSelectionToLayer(destructive, shouldCancel),
            showNoLayerDialog: () => this._showNoLayerSelectedDialog(),
            selectTopmostLayer: () => this._selectTopmostLayer(),
            duplicateLayer: (shouldCancel) =>
                this._duplicateActiveLayer(null, shouldCancel),
            onComplete: () => this._onCloneComplete(),
            acquireMutation: (existingToken) =>
                this._tryAcquireProjectLifecycle(existingToken),
            destructive: false,
            toolClass: 'clone-tool'
        })

        // Initialize transform tool
        this._transformTool = new TransformTool({
            overlay: this._selectionOverlay,
            getActiveLayer: () => this._getActiveLayer(),
            getLayerBounds: (layer) => this._getLayerBounds(layer),
            applyTransform: (values) => this._applyLayerTransform(values),
            commitTransform: () => this._commitTransform(),
            cancelTransform: (start, state) => this._cancelTransform(start, state),
            captureMutationState: () => this._capturePointerGestureMutationState(),
            showNoLayerDialog: () => this._showNoLayerSelectedDialog(),
            selectTopmostLayer: () => this._selectTopmostLayer(),
            isLayerBlocked: (layer) => {
                if (layer?.mediaType === 'video') {
                    toast.warning('Transform tool not available for video clip layers')
                    return true
                }
                if (layer?.sourceType === 'effect') {
                    toast.warning('Transform tool not available for effect layers')
                    return true
                }
                return false
            },
            acquireMutation: (existingToken) =>
                this._tryAcquireProjectLifecycle(existingToken)
        })

        // Initialize brush tool
        this._brushTool = new BrushTool({
            overlay: this._selectionOverlay,
            commitStroke: (stroke) => this._commitDrawingStroke(stroke),
            acquireMutation: (existingToken) =>
                this._tryAcquireProjectLifecycle(existingToken)
        })

        // Initialize eraser tool
        this._eraserTool = new EraserTool({
            overlay: this._selectionOverlay,
            getActiveLayer: () => this._getActiveLayer(),
            commitStrokeDeletion: (layer, strokeId) =>
                this._commitDrawingLayerMutation(layer, (targetLayer) => {
                    targetLayer.strokes = targetLayer.strokes.filter(
                        stroke => stroke.id !== strokeId)
                }, { pushUndo: false }),
            pushUndoState: () => this._pushUndoState(),
            finalizePendingUndo: () => this._finalizePendingUndo(),
            acquireMutation: (existingToken) =>
                this._tryAcquireProjectLifecycle(existingToken)
        })

        // Initialize shape tool
        this._shapeTool = new ShapeTool({
            overlay: this._selectionOverlay,
            commitStroke: (stroke) => this._commitDrawingStroke(stroke),
            acquireMutation: (existingToken) =>
                this._tryAcquireProjectLifecycle(existingToken)
        })

        // Initialize fill tool
        this._fillTool = new FillTool({
            overlay: this._selectionOverlay,
            canvas: this._canvas,
            runMutation: (task) => this._runPointerMutation(task),
            addMediaLayerFromCanvas: (c, n) => this._addMediaLayerFromCanvas(c, n),
        })

        // Initialize eyedropper tool
        this._eyedropperTool = new EyedropperTool({
            overlay: this._selectionOverlay,
            canvas: this._canvas,
            setForegroundColor: (c) => this._setForegroundColor(c),
            restorePreviousTool: () => this._setToolMode(this._previousTool)
        })

        if (!this._canvas) {
            console.error('[Layers] Canvas not found')
            return
        }

        // Create renderer (let it create its own WebGL context)
        this._renderer = new LayersRenderer(this._canvas, {
            // Initial size - will be updated when media is loaded
            width: this._canvas.width || 1024,
            height: this._canvas.height || 1024,
            loopDuration: 10,
            onError: (err) => {
                console.error('[Layers] Render error:', err)
                toast.error('Render error: ' + err.message)
            }
        })

        // Initialize renderer
        try {
            await this._renderer.init()

            // Set up effect loader for effect-params components
            EffectParams.setEffectLoader((effectId) =>
                this._renderer.getEffectDefinition(effectId)
            )
        } catch (err) {
            console.error('[Layers] Failed to initialize renderer:', err)
            toast.error('Failed to initialize renderer')
            return
        }

        // Set up event listeners
        this._setupMenuHandlers()
        this._setupLayerStackHandlers()
        this._setupLayerMenuHandlers()
        this._setupKeyboardShortcuts()

        // Export system
        this._files = new Files()
        const acquireExportSnapshot = () => {
            const previousOverride = this._projectSnapshotCanvasOverride
            const override = this._captureProjectSnapshotOverride({ canvasOnly: true })
            this._projectSnapshotCanvasOverride = override
            let active = true
            return {
                release: () => {
                    if (!active) return
                    active = false
                    if (this._projectSnapshotCanvasOverride === override) {
                        this._projectSnapshotCanvasOverride = previousOverride
                    }
                },
            }
        }
        this._exportImageDialog = new ExportImageDialog({
            files: this._files,
            canvas: this._canvas,
            getResolution: () => ({ width: this._canvas.width, height: this._canvas.height }),
            setResolution: (w, h) => this._resizeCanvas(w, h),
            renderCurrentFrame: () => this._renderCurrentFrame(),
            acquireMutation: () => this._tryAcquireProjectLifecycle(),
            acquireSnapshotOverride: acquireExportSnapshot,
            getProjectGeneration: () => this._replacementGeneration,
            onComplete: (format) => toast.success(`Exported as ${format.toUpperCase()}`),
            onCancel: () => {}
        })
        this._exportVideoDialog = new ExportVideoDialog({
            files: this._files,
            renderer: this._renderer,
            canvas: this._canvas,
            getResolution: () => ({ width: this._canvas.width, height: this._canvas.height }),
            setResolution: (w, h) => this._resizeCanvas(w, h),
            acquireMutation: () => this._tryAcquireProjectLifecycle(),
            acquireSnapshotOverride: acquireExportSnapshot,
            getProjectGeneration: () => this._replacementGeneration,
            onComplete: (format) => toast.success(`Exported as ${format.toUpperCase()}`),
            onCancel: () => {}
        })

        // Set initial tool state
        this._setToolMode('selection')
        this._updateLayerMenu()

        // Recalculate fit on window resize
        window.addEventListener('resize', () => {
            if (this._zoomMode === 'fit') {
                this._applyZoom()
            }
        })

        // Apply default zoom mode
        this._applyZoom()

        // Seance online collaboration — wire the adapter + "go online..."
        // menu item (cheap, no network). A `?seance=` boot join (if present)
        // applies directly with no confirm, while the loading screen stays
        // up for it exactly as it would for any other boot path; on
        // success it replaces the initial open dialog, and any join failure
        // (dialect mismatch, network error, unknown session) falls back to
        // the normal open dialog exactly as if `?seance=` had never been
        // there.
        this._initOnlineCollaboration()
        const joinedFromUrl = this._onlineAdapter
            ? await this._onlineAdapter.joinFromUrl().catch((err) => {
                console.error('[Layers] Failed to join Seance session from URL:', err)
                return false
            })
            : false
        this._hideLoadingScreen()
        if (!joinedFromUrl) {
            if (this._shouldAutoShowWelcome()) {
                welcomeDialog.show({ fallThrough: true, entry: 'boot' })
            } else {
                this._showOpenDialog()
            }
        }

        // Expose drawing module for tests
        window._drawingTestExports = { ...strokeModel, StrokeRenderer, createDrawingLayer }

        this._initialized = true
        console.debug('[Layers] Ready')

        // Public agent API — purely additive, must never break the app for humans.
        try {
            bootstrapAgent(this)
        } catch (err) {
            console.error('[Layers] Failed to bootstrap agent API:', err)
        }
    }

    /**
     * Create the Seance online-collaboration adapter (when the feature flag
     * is enabled), wire the "go online..." File-menu item + its leading
     * separator, and wire the <seance-dialog>'s semantic events.
     *
     * Visibility uses style.display, not the `hidden` attribute — handfish
     * menu-item CSS cascades on `[hidden]` in a way that fights this menu's
     * own show/hide classes, so `hidden` silently fails to hide submenu rows.
     * @private
     */
    _initOnlineCollaboration() {
        const menuItem = document.getElementById('goOnlineMenuItem')
        const separator = document.getElementById('onlineCollabMenuSeparator')
        const enabled = isFeatureEnabled(ONLINE_COLLABORATION_FEATURE)

        for (const el of [menuItem, separator]) {
            if (el) el.style.display = enabled ? '' : 'none'
        }
        if (!enabled) return

        this._onlineAdapter = createLayersOnlineAdapter(this)
        this._onlineAdapter.wireUi()

        const dialog = document.getElementById('seanceDialog')
        menuItem?.addEventListener('click', () => dialog?.show?.())
    }

    /**
     * Hide the loading screen
     * @private
     */
    _hideLoadingScreen() {
        const loadingScreen = document.getElementById('loading-screen')
        if (loadingScreen) {
            loadingScreen.classList.add('fade-out')
            setTimeout(() => {
                loadingScreen.classList.add('hidden')
            }, 350)
        }
    }

    /**
     * Show the open dialog to select initial base layer
     * @private
     */
    _showOpenDialog({
        replaceProject = false,
        leaveOnline = false,
        replacementConsent = null,
    } = {}) {
        const continueReplacement = async (task) => {
            if (replacementConsent) {
                return this._continueProjectReplacement(replacementConsent, task)
            }
            await task({ leaveOnline })
            return true
        }
        openDialog.show({
            canClose: replaceProject,
            onOpen: async (file, mediaType) => {
                await continueReplacement(({
                    leaveOnline: confirmedLeaveOnline,
                    replacementConsent: confirmedConsent,
                }) =>
                    this._handleOpenMedia(file, mediaType, {
                        leaveOnline: confirmedLeaveOnline,
                        replacementConsent: confirmedConsent,
                    }))
            },
            onSolid: async (width, height) => {
                await continueReplacement(({
                    leaveOnline: confirmedLeaveOnline,
                    replacementConsent: confirmedConsent,
                }) =>
                    this._handleCreateSolidBase(width, height, {
                        leaveOnline: confirmedLeaveOnline,
                        replacementConsent: confirmedConsent,
                    }))
            },
            onGradient: async (width, height) => {
                await continueReplacement(({
                    leaveOnline: confirmedLeaveOnline,
                    replacementConsent: confirmedConsent,
                }) =>
                    this._handleCreateGradientBase(width, height, {
                        leaveOnline: confirmedLeaveOnline,
                        replacementConsent: confirmedConsent,
                    }))
            },
            onTransparent: async (width, height) => {
                await continueReplacement(({
                    leaveOnline: confirmedLeaveOnline,
                    replacementConsent: confirmedConsent,
                }) =>
                    this._handleCreateTransparentBase(width, height, {
                        leaveOnline: confirmedLeaveOnline,
                        replacementConsent: confirmedConsent,
                    }))
            },
            onClipboard: async () => {
                await continueReplacement(({
                    leaveOnline: confirmedLeaveOnline,
                    replacementConsent: confirmedConsent,
                }) => this._handleNewFromClipboard({
                    leaveOnline: confirmedLeaveOnline,
                    replacementConsent: confirmedConsent,
                }))
            },
            onLoadProject: () => {
                this._showLoadProjectDialog(true, { leaveOnline, replacementConsent })
            }
        })
    }

    /** @private */
    _captureProjectReplacementState() {
        return {
            mutationRevision: this._projectMutationRevision,
            online: Boolean(this._onlineAdapter?.isOnline()),
            onlineSessionIdentity: this._onlineAdapter?.getSessionIdentity?.() ?? null,
        }
    }

    /** @private */
    _projectReplacementStateMatches(state) {
        return state?.mutationRevision === this._projectMutationRevision
            && state.online === Boolean(this._onlineAdapter?.isOnline())
            && state.onlineSessionIdentity
                === (this._onlineAdapter?.getSessionIdentity?.() ?? null)
    }

    /**
     * Run the shared guards before starting any flow that can replace the
     * current project.
     * @param {Function} startFlow - replacement chooser/picker callback
     * @returns {Promise<boolean>} whether replacement was accepted
     * @private
     */
    async _startProjectReplacement(startFlow) {
        const waitForGuard = this._projectReplacementGuardTail
        let releaseGuard
        this._projectReplacementGuardTail = new Promise(resolve => { releaseGuard = resolve })
        await waitForGuard

        let replacementConsent
        try {
            while (true) {
                const confirmedState = this._captureProjectReplacementState()
                if (!await this._confirmLeaveOnlineSession()) return false
                if (!await this._confirmUnsavedChanges()) return false
                if (!this._projectReplacementStateMatches(confirmedState)) continue

                replacementConsent = {
                    ...confirmedState,
                    leaveOnline: confirmedState.online,
                }
                break
            }
        } finally {
            releaseGuard()
        }

        await startFlow({
            leaveOnline: replacementConsent.leaveOnline,
            replacementConsent,
        })
        return true
    }

    /**
     * Revalidate an earlier replacement confirmation after an asynchronous
     * chooser. If the project changed, run the guards again before continuing.
     * @private
     */
    async _continueProjectReplacement(replacementConsent, startFlow) {
        if (!this._projectReplacementStateMatches(replacementConsent)) {
            return this._startProjectReplacement(startFlow)
        }
        await startFlow({
            leaveOnline: replacementConsent.leaveOnline,
            replacementConsent,
        })
        return true
    }

    /**
     * First-run welcome splash gate. Suppressed under automation
     * (navigator.webdriver) so it never interferes with the test harness;
     * `?welcome=1` opts back in for the welcome spec.
     * @returns {boolean}
     * @private
     */
    _shouldAutoShowWelcome() {
        if (isWelcomeDismissed()) return false
        const forced = new URLSearchParams(window.location.search).has('welcome')
        if (window.navigator.webdriver && !forced) return false
        return true
    }

    /**
     * Open a native file picker for image/video and route into the open-media
     * flow. Backs the welcome dialog's "Open file" tile; falls through to the
     * full open dialog if the picker is dismissed without a file.
     * @private
     */
    _openMediaFilePicker({
        replaceProject = false,
        leaveOnline = false,
        replacementConsent = null,
    } = {}) {
        const input = document.createElement('input')
        input.type = 'file'
        input.accept = 'image/*,video/*'
        input.addEventListener('cancel', () => {
            this._showOpenDialog({ replaceProject, leaveOnline, replacementConsent })
        })
        input.addEventListener('change', async () => {
            const file = input.files?.[0]
            if (!file) {
                this._showOpenDialog({ replaceProject, leaveOnline, replacementConsent })
                return
            }
            const mediaType = file.type.startsWith('video') ? 'video' : 'image'
            let result = null
            const openFile = async ({
                leaveOnline: confirmedLeaveOnline,
                replacementConsent: confirmedConsent,
            }) => {
                result = await this._handleOpenMedia(file, mediaType, {
                    leaveOnline: confirmedLeaveOnline,
                    replacementConsent: confirmedConsent,
                })
            }
            const accepted = replacementConsent
                ? await this._continueProjectReplacement(replacementConsent, openFile)
                : (await openFile({ leaveOnline }), true)
            if (!accepted) return
            if (result === 'failed') {
                this._showOpenDialog({ replaceProject, leaveOnline, replacementConsent })
            }
        })
        input.click()
    }

    /**
     * Finish non-essential UI work after a project replacement is committed.
     * @param {string} successMessage - Toast message on success
     * @private
     */
    _completeProjectReplacementUi(successMessage) {
        try {
            openDialog.element.close()
        } catch (err) {
            console.error('[Layers] Failed to close project chooser after replacement:', err)
        }
        try {
            toast.success(successMessage)
        } catch (err) {
            console.error('[Layers] Failed to show project replacement confirmation:', err)
        }
    }

    /**
     * Create a base layer and initialize the project
     * @param {object} layer - Layer object to use as base
     * @param {number} width - Canvas width
     * @param {number} height - Canvas height
     * @param {string} successMessage - Toast message on success
     * @private
     */
    async _initializeBaseLayer(layer, width, height, successMessage,
        {
            leaveOnline = false,
            mutationToken = null,
            replacementConsent = null,
        } = {}) {
        const generation = ++this._replacementGeneration
        return this._runProjectReplacement(mutationToken, async (token, replacementGate) => {
            const outcome = await this._installPreparedProject({
                layers: [layer],
                width,
                height,
                projectId: null,
                projectName: null,
                dirty: true,
                selectedLayerId: layer.id,
                mediaTextures: new Map(),
                maskTextures: new Map()
            }, {
                generation,
                leaveOnline,
                replacementConsent,
                mutationToken: token,
                replacementGate,
            })

            if (outcome.status === 'opened') {
                this._completeProjectReplacementUi(successMessage)
            } else if (outcome.status === 'failed') {
                console.error('[Layers] Failed to create base layer:', outcome.error)
                toast.error('Failed to create project: ' + outcome.error.message)
            }
            return outcome.status
        })
    }

    /**
     * Acquire the shared project lifecycle mutex. Agent commands hold this
     * across their complete handler, including network/decode waits.
     * @returns {Promise<object>}
     * @private
     */
    async _acquireProjectLifecycle(replacementGate = null) {
        while (this._projectReplacementGate
            && this._projectReplacementGate !== replacementGate) {
            await this._projectReplacementGate.promise
        }
        const waitForTurn = this._projectLifecycleTail
        let releaseTurn
        const turn = new Promise(resolve => { releaseTurn = resolve })
        this._projectLifecycleTail = waitForTurn.then(() => turn)
        this._projectLifecycleWaiters += 1
        await waitForTurn
        this._projectLifecycleWaiters -= 1

        return this._createProjectLifecycleToken(releaseTurn)
    }

    /** @private */
    _createProjectLifecycleToken(releaseTurn) {
        const token = {
            app: this,
            released: false,
            references: 1,
            retain: () => {
                if (token.released || this._projectLifecycleOwner !== token) return false
                token.references += 1
                return true
            },
            release: () => {
                if (token.released) return
                token.references -= 1
                if (token.references > 0) return
                token.released = true
                if (this._projectLifecycleOwner === token) {
                    this._projectLifecycleOwner = null
                    this._projectLifecycleActive = false
                }
                releaseTurn()
            }
        }
        this._projectLifecycleOwner = token
        this._projectLifecycleActive = true
        return token
    }

    /**
     * Acquire a synchronous lease for a pointer gesture, or reject the
     * gesture when another lifecycle operation is active or queued.
     * @returns {object|null}
     * @private
     */
    _tryAcquireProjectLifecycle(existingToken = null) {
        if (existingToken?.app === this && this._projectLifecycleOwner === existingToken
            && !existingToken.released && !this._projectReplacementGate) {
            return existingToken.retain() ? existingToken : null
        }
        if (this._projectReplacementGate || this._projectLifecycleOwner
            || this._projectLifecycleWaiters > 0) {
            return null
        }
        let releaseTurn
        const turn = new Promise(resolve => { releaseTurn = resolve })
        this._projectLifecycleTail = turn
        return this._createProjectLifecycleToken(releaseTurn)
    }

    /**
     * Run a mutation or replacement under the shared lifecycle mutex.
     * A dispatcher-owned token makes nested app calls explicitly re-entrant.
     * @template T
     * @param {object|null} mutationToken
     * @param {(token:object) => Promise<T>} task
     * @returns {Promise<T>}
     * @private
     */
    async _runProjectLifecycle(mutationToken, task, { replacementGate = null } = {}) {
        if (mutationToken) {
            if (mutationToken.app === this && !mutationToken.released
                && this._projectLifecycleOwner === mutationToken) {
                return task(mutationToken)
            }
            throw new Error('Invalid or expired project lifecycle token')
        }
        const token = await this._acquireProjectLifecycle(replacementGate)
        try {
            return await task(token)
        } finally {
            token.release()
        }
    }

    /**
     * Mark a lifecycle operation as a whole-project replacement so pointer
     * mutations can be rejected instead of landing in the incoming project.
     * @template T
     * @param {object|null} mutationToken
     * @param {(mutationToken:object|null, replacementGate:object) => Promise<T>} task
     * @returns {Promise<T>}
     * @private
     */
    _runProjectReplacement(mutationToken, task) {
        this._cancelColorRangePick()
        let resolveGate
        const gate = {
            promise: new Promise(resolve => { resolveGate = resolve }),
            resolved: false,
            resolve: () => {
                if (gate.resolved) return
                gate.resolved = true
                resolveGate()
            }
        }
        this._projectReplacementGate?.resolve()
        this._projectReplacementGate = gate
        this._projectReplacementActive = true

        return Promise.resolve().then(() => task(mutationToken, gate)).finally(() => {
            gate.resolve()
            if (this._projectReplacementGate === gate) {
                this._projectReplacementGate = null
                this._projectReplacementActive = false
            }
        })
    }

    /**
     * Queue a pointer-originated mutation unless a project replacement owns
     * the lifecycle mutex. Agent mutations are queued rather than dropped.
     * @param {() => Promise<unknown>} task
     * @param {{generation?:number}} options
     * @private
     */
    _runPointerMutation(task, { generation = this._replacementGeneration } = {}) {
        if (this._projectReplacementActive || generation !== this._replacementGeneration) return
        return this._runProjectLifecycle(null, (token) => {
            if (generation !== this._replacementGeneration) return
            return task(token)
        })
    }

    /**
     * Serialize candidate renderer stages without serializing their slower
     * media/mask preparation.
     * @param {Function} task
     * @returns {Promise<object>}
     * @private
     */
    _queueProjectInstall(task) {
        const run = this._projectInstallTail.then(task, task)
        this._projectInstallTail = run.catch(() => {})
        return run
    }

    /**
     * Dispose a candidate that never became renderer-owned.
     * @param {object} candidate
     * @private
     */
    _disposePreparedProject(candidate) {
        this._renderer.disposeMediaResources(candidate.mediaTextures)
        candidate.maskTextures.clear()
    }

    /**
     * Normalize optional persisted fields, reject ambiguous IDs, and return
     * the first safe local layer-counter value.
     * @param {Array} layers
     * @returns {number|null}
     * @private
     */
    _validatePersistedLayers(layers) {
        if (!Array.isArray(layers)) {
            throw new Error('Saved project layers must be an array')
        }

        const seenIds = new Set()
        let maxLayerNumber = -1
        const registerId = (id) => {
            if (typeof id !== 'string' || id.length === 0) {
                throw new Error('Saved project contains a layer without an ID')
            }
            if (seenIds.has(id)) {
                throw new Error(`Saved project contains duplicate layer ID "${id}"`)
            }
            seenIds.add(id)
            const match = /^layer-(\d+)$/.exec(id)
            if (match) {
                const numericId = Number(match[1])
                if (!Number.isSafeInteger(numericId)
                    || !Number.isSafeInteger(numericId + 1)) {
                    throw new Error(`Saved project contains an unsafe layer ID "${id}"`)
                }
                maxLayerNumber = Math.max(maxLayerNumber, numericId)
            }
        }
        const normalizeParams = (owner) => {
            if (owner.effectParams == null) owner.effectParams = {}
            if (typeof owner.effectParams !== 'object' || Array.isArray(owner.effectParams)) {
                throw new Error(`Saved layer "${owner.id}" has invalid effect parameters`)
            }
        }

        for (const layer of layers) {
            if (!layer || typeof layer !== 'object' || Array.isArray(layer)) {
                throw new Error('Saved project contains an invalid layer')
            }
            registerId(layer.id)
            normalizeParams(layer)
            if (!Array.isArray(layer.children)) layer.children = []
            for (const child of layer.children) {
                if (!child || typeof child !== 'object' || Array.isArray(child)) {
                    throw new Error(`Saved layer "${layer.id}" has an invalid child effect`)
                }
                registerId(child.id)
                normalizeParams(child)
            }
            if (layer.sourceType === 'drawing' && !Array.isArray(layer.strokes)) {
                layer.strokes = []
            }
        }

        return maxLayerNumber >= 0 ? maxLayerNumber + 1 : null
    }

    /** @private */
    async _validatePersistedLayerSemantics(layers, width, height) {
        const numericFields = ['opacity', 'offsetX', 'offsetY', 'rotation']
        const nodes = []
        for (const layer of layers) {
            for (const field of numericFields) {
                if (layer[field] != null && !Number.isFinite(layer[field])) {
                    throw new Error(`Saved layer "${layer.id}" has invalid ${field}`)
                }
            }
            const scaleX = layer.scaleX ?? 1
            const scaleY = layer.scaleY ?? 1
            if (!Number.isFinite(scaleX) || scaleX === 0
                || !Number.isFinite(scaleY) || scaleY === 0) {
                throw new Error(`Saved layer "${layer.id}" has invalid scale`)
            }
            if (layer.sourceType === 'drawing' && layer.strokes.length > 0) {
                const transformedWidth = Math.ceil(width * Math.abs(scaleX))
                const transformedHeight = Math.ceil(height * Math.abs(scaleY))
                if (transformedWidth > MAX_CANVAS_DIMENSION
                    || transformedHeight > MAX_CANVAS_DIMENSION) {
                    throw new Error(`Saved layer "${layer.id}" transformed raster is too large`)
                }
            }
            nodes.push({
                kind: 'layers-layer',
                id: layer.id,
                text: JSON.stringify({
                    v: 1,
                    name: layer.name,
                    sourceType: layer.sourceType,
                    effectId: layer.effectId,
                    effectParams: layer.effectParams,
                    mediaType: layer.mediaType,
                    visible: layer.visible,
                    locked: layer.locked,
                    opacity: layer.opacity,
                    blendMode: layer.blendMode,
                    offsetX: layer.offsetX,
                    offsetY: layer.offsetY,
                    scaleX,
                    scaleY,
                    rotation: layer.rotation,
                    flipH: layer.flipH,
                    flipV: layer.flipV,
                    maskEnabled: layer.maskEnabled,
                    maskVisible: layer.maskVisible,
                }),
            })
            for (const child of layer.children || []) {
                nodes.push({
                    kind: 'layers-child',
                    id: child.id,
                    text: JSON.stringify({
                        v: 1,
                        name: child.name,
                        effectId: child.effectId,
                        effectParams: child.effectParams,
                        visible: child.visible,
                    }),
                })
            }
        }

        const manifest = this._renderer?.manifest || {}
        const layerEffectIds = new Set(
            this._renderer?.getAllEffects?.().map(effect => effect.effectId) || [])
        const excludedStarterNamespaces = new Set([
            'mixer', 'render', 'points', '3d', 'filter3d',
        ])
        for (const [effectId, entry] of Object.entries(manifest)) {
            const namespace = effectId.split('/')[0]
            if (entry?.starter && !entry.externalTexture
                && !excludedStarterNamespaces.has(namespace)) {
                layerEffectIds.add(effectId)
            }
        }
        const childEffectIds = new Set(
            this._renderer?.getLayerEffects?.().map(effect => effect.effectId) || [])
        await assertRemoteNodeSemantics(nodes, {
            manifest,
            getEffectDefinition: effectId =>
                this._renderer?.getEffectDefinition?.(effectId),
            getDeclaredDslIdentifierValues: spec =>
                this._renderer?.getDeclaredDslIdentifierValues?.(spec) || [],
            layerEffectIds,
            childEffectIds,
        })
    }

    /** @private */
    _validatePreparedMediaResource(layer, resource) {
        if (!resource
            || !Number.isSafeInteger(resource.width) || resource.width < 1
            || resource.width > MAX_CANVAS_DIMENSION
            || !Number.isSafeInteger(resource.height) || resource.height < 1
            || resource.height > MAX_CANVAS_DIMENSION) {
            throw new Error(`Saved media dimensions are invalid for layer "${layer.id}"`)
        }
        const width = Math.ceil(resource.width * Math.abs(layer.scaleX ?? 1))
        const height = Math.ceil(resource.height * Math.abs(layer.scaleY ?? 1))
        if (!Number.isSafeInteger(width) || width < 1 || width > MAX_CANVAS_DIMENSION
            || !Number.isSafeInteger(height) || height < 1
            || height > MAX_CANVAS_DIMENSION) {
            throw new Error(`Saved media dimensions are invalid for layer "${layer.id}"`)
        }
    }

    /**
     * Capture the app-owned portion of a project so a commit-side exception
     * can restore it before the renderer stage is rolled back.
     * @returns {object}
     * @private
     */
    _captureProjectCommitState() {
        return {
            layers: this._layers,
            selectedLayerIds: this._layerStack?.selectedLayerIds ?? [],
            selectionAnchor: this._layerStack?._lastClickedLayerId ?? null,
            selectionPath: this._selectionManager?.selectionPath ?? null,
            copyOrigin: this._copyOrigin,
            projectId: this._currentProjectId,
            projectName: this._currentProjectName,
            dirty: this._isDirty,
            mutationRevision: this._projectMutationRevision,
            undoStackArray: this._undoManager._stack,
            undoStack: this._undoManager._stack.slice(),
            undoIndex: this._undoManager._index,
            undoWasPending: this._undoDebounceTimer !== null,
            maskEditLayerId: this._maskEditLayerId,
            maskEditUi: this._maskEditMode ? this._captureMaskEditUiState() : null,
        }
    }

    /** @private */
    _restoreProjectCommitState(previous) {
        if (this._undoDebounceTimer) {
            clearTimeout(this._undoDebounceTimer)
            this._undoDebounceTimer = null
        }
        this._layers = previous.layers
        this._currentProjectId = previous.projectId
        this._currentProjectName = previous.projectName
        this._isDirty = previous.dirty
        this._projectMutationRevision = previous.mutationRevision
        this._copyOrigin = previous.copyOrigin
        previous.undoStackArray.splice(
            0, previous.undoStackArray.length, ...previous.undoStack)
        this._undoManager._stack = previous.undoStackArray
        this._undoManager._index = previous.undoIndex

        if (previous.selectionPath) {
            this._selectionManager?.setSelection(previous.selectionPath)
        } else {
            this._selectionManager?.clearSelection()
        }
        this._updateLayerStack()
        if (this._layerStack) {
            this._layerStack.selectedLayerIds = previous.selectedLayerIds
            this._layerStack._lastClickedLayerId = previous.selectionAnchor
        }
        this._updateUndoMenuState()

        if (previous.maskEditUi) {
            const maskLayer = this._layers.find(
                layer => layer.id === previous.maskEditLayerId)
            if (maskLayer) maskLayer.maskVisible = true
            this._restoreMaskEditUiState(previous.maskEditUi)
            this._updateLayerStack()
        }
        if (previous.undoWasPending) this._pushUndoStateDebounced()
        else this._updateUndoMenuState()
    }

    /** @private */
    _replacementFailure(primary, restoreError = null) {
        const error = primary instanceof Error ? primary : new Error(String(primary))
        if (!restoreError) return error
        return new Error(`${error.message}; failed to restore previous renderer: ${restoreError.message}`)
    }

    /**
     * Compile a detached project, then synchronously swap app state only if
     * it is still the newest replacement generation.
     * @param {object} candidate
     * @param {{generation:number,leaveOnline?:boolean,mutationToken?:object,
     *   replacementGate?:object,replacementConsent?:object}} options
     * @returns {Promise<{status:'opened'|'failed'|'cancelled',error?:Error}>}
     * @private
     */
    _installPreparedProject(candidate, {
        generation,
        leaveOnline = false,
        mutationToken = null,
        replacementGate = null,
        replacementConsent = null,
    }) {
        return this._runProjectLifecycle(mutationToken,
            () => this._queueProjectInstall(async () => {
            const previousSize = { width: this._canvas.width, height: this._canvas.height }
            const transaction = this._beginPublishTransaction()
            let candidateOwned = true
            let stage = null
            let previousAppState = null

            const restoreLiveCanvas = () => {
                this._resizeCanvas(previousSize.width, previousSize.height)
                if (!this._maskEditMode) return
                const maskLayer = this._layers.find(
                    layer => layer.id === this._maskEditLayerId)
                if (maskLayer) this._renderMaskOverlay(maskLayer)
            }

            const rollback = async () => {
                const errors = []
                try {
                    restoreLiveCanvas()
                } catch (err) {
                    errors.push(err instanceof Error ? err : new Error(String(err)))
                }
                if (stage) {
                    try {
                        const result = await stage.rollback()
                        if (!result?.success) {
                            this._renderer.stop()
                            errors.push(new Error(
                                result?.error || 'Unknown renderer restoration failure'))
                        }
                    } catch (err) {
                        this._renderer.stop()
                        errors.push(err instanceof Error ? err : new Error(String(err)))
                    } finally {
                        stage = null
                    }
                }
                if (errors.length === 0) return null
                if (errors.length === 1) return errors[0]
                return new Error(errors.map(error => error.message).join('; '))
            }

            try {
                if (generation !== this._replacementGeneration) {
                    this._disposePreparedProject(candidate)
                    candidateOwned = false
                    return { status: 'cancelled' }
                }
                if (replacementConsent
                    && !this._projectReplacementStateMatches(replacementConsent)) {
                    this._disposePreparedProject(candidate)
                    candidateOwned = false
                    return { status: 'cancelled' }
                }

                if (this._onlineAdapter?.isApplyingRemote?.()) {
                    this._disposePreparedProject(candidate)
                    candidateOwned = false
                    return {
                        status: 'failed',
                        error: new Error('A remote project update is still being applied')
                    }
                }
                if (this._onlineAdapter?.isOnline() && !leaveOnline) {
                    this._disposePreparedProject(candidate)
                    candidateOwned = false
                    return {
                        status: 'failed',
                        error: new Error('An online session started before replacement could commit')
                    }
                }

                this._resizeCanvas(candidate.width, candidate.height)
                await new Promise(resolve => queueMicrotask(resolve))

                try {
                    stage = await this._renderer.stageLayerSet(candidate)
                    candidateOwned = false
                } catch (err) {
                    restoreLiveCanvas()
                    this._disposePreparedProject(candidate)
                    candidateOwned = false
                    return { status: 'failed', error: err }
                }

                if (!stage.success) {
                    const primary = new Error(stage.error || 'Candidate render failed')
                    const restoreError = await rollback()
                    return {
                        status: 'failed',
                        error: this._replacementFailure(primary, restoreError)
                    }
                }

                await new Promise(resolve => requestAnimationFrame(resolve))
                if (generation !== this._replacementGeneration) {
                    const restoreError = await rollback()
                    if (restoreError) {
                        return {
                            status: 'failed',
                            error: this._replacementFailure(
                                new Error('Replacement was superseded'), restoreError)
                        }
                    }
                    return { status: 'cancelled' }
                }
                if (replacementConsent
                    && !this._projectReplacementStateMatches(replacementConsent)) {
                    const restoreError = await rollback()
                    if (restoreError) {
                        return {
                            status: 'failed',
                            error: this._replacementFailure(
                                new Error('Replacement confirmation became stale'),
                                restoreError)
                        }
                    }
                    return { status: 'cancelled' }
                }
                if (this._onlineAdapter?.isApplyingRemote?.()) {
                    const restoreError = await rollback()
                    return {
                        status: 'failed',
                        error: this._replacementFailure(
                            new Error('A remote project update is still being applied'),
                            restoreError)
                    }
                }
                if (this._onlineAdapter?.isOnline() && !leaveOnline) {
                    const restoreError = await rollback()
                    return {
                        status: 'failed',
                        error: this._replacementFailure(
                            new Error('An online session started before replacement could commit'),
                            restoreError)
                    }
                }

                // Build the new baseline before touching app state. Malformed
                // candidates fail here while the renderer can still roll back.
                const undoBaseline = this._createUndoSnapshot(
                    candidate.layers, candidate.width, candidate.height,
                    candidate.mediaTextures)
                undoBaseline.selectedLayerIds = candidate.selectedLayerId
                    ? [candidate.selectedLayerId]
                    : []
                undoBaseline.selectionAnchor = candidate.selectedLayerId || null
                previousAppState = this._captureProjectCommitState()

                try {
                    if (this._undoDebounceTimer) {
                        clearTimeout(this._undoDebounceTimer)
                        this._undoDebounceTimer = null
                    }

                    this._layers = candidate.layers
                    this._selectionManager?.clearSelection()
                    this._copyOrigin = null
                    this._currentProjectId = candidate.projectId
                    this._currentProjectName = candidate.projectName
                    this._updateLayerStack()
                    if (this._layerStack) {
                        this._layerStack.selectedLayerId = candidate.selectedLayerId
                    }
                    if (candidate.dirty) this._markDirty()
                    else this._markClean()
                    this._undoManager.clear()
                    this._undoManager.pushState(undoBaseline)
                    this._updateUndoMenuState()

                    if (this._maskEditMode) {
                        await this._exitMaskEditMode({ updateRenderer: false })
                    }
                    if (leaveOnline && this._onlineAdapter?.isOnline()) {
                        this._onlineAdapter.goOffline()
                    }

                    const committedStage = stage
                    stage = null
                    try {
                        const commitResult = committedStage.commit()
                        if (commitResult?.success === false) {
                            console.error('[Layers] Failed to retire replaced project resources:',
                                commitResult.error || 'Unknown renderer cleanup failure')
                        }
                    } catch (err) {
                        console.error('[Layers] Failed to retire replaced project resources:', err)
                    }
                    if (candidate.nextLayerId != null) {
                        bumpLayerCounter(candidate.nextLayerId)
                    }
                    try {
                        this._renderer.start()
                    } catch (err) {
                        console.error('[Layers] Failed to start renderer after replacement:', err)
                    }
                    return { status: 'opened' }
                } catch (err) {
                    const restoreError = await rollback()
                    this._restoreProjectCommitState(previousAppState)
                    return {
                        status: 'failed',
                        error: this._replacementFailure(err, restoreError)
                    }
                }
            } catch (err) {
                const restoreError = await rollback()
                if (previousAppState) this._restoreProjectCommitState(previousAppState)
                if (candidateOwned) this._disposePreparedProject(candidate)
                return {
                    status: 'failed',
                    error: this._replacementFailure(err, restoreError)
                }
            } finally {
                this._endPublishTransaction(transaction)
            }
            }), { replacementGate })
    }

    /**
     * Create a solid color base layer
     * @param {number} width - Canvas width
     * @param {number} height - Canvas height
     * @private
     */
    async _handleCreateSolidBase(width = 1024, height = 1024, options = {}) {
        const layer = createEffectLayer('synth/solid')
        layer.name = 'Solid'
        layer.effectParams = { color: [0.2, 0.2, 0.2], alpha: 1 }

        return this._initializeBaseLayer(layer, width, height, 'Created solid base layer', options)
    }

    /**
     * Create a gradient base layer
     * @param {number} width - Canvas width
     * @param {number} height - Canvas height
     * @private
     */
    async _handleCreateGradientBase(width = 1024, height = 1024, options = {}) {
        const layer = createEffectLayer('synth/gradient')
        layer.name = 'Gradient'

        return this._initializeBaseLayer(layer, width, height, 'Created gradient base layer', options)
    }

    /**
     * Create a transparent base layer
     * @param {number} width - Canvas width
     * @param {number} height - Canvas height
     * @private
     */
    async _handleCreateTransparentBase(width = 1024, height = 1024, options = {}) {
        const layer = createEffectLayer('synth/solid')
        layer.name = 'Transparent'
        layer.effectParams = { color: [0, 0, 0], alpha: 0 }

        return this._initializeBaseLayer(layer, width, height, 'Created transparent base layer', options)
    }

    /**
     * Handle opening a media file
     * @param {File} file - Media file
     * @param {string} mediaType - 'image' or 'video'
     * @param {{leaveOnline?:boolean, generation?:number, mutationToken?:object,
     *   replacementGate?:object}} options
     * @returns {Promise<'opened'|'failed'|'cancelled'>}
     * @private
     */
    async _handleOpenMedia(file, mediaType,
        {
            leaveOnline = false,
            generation = null,
            mutationToken = null,
            replacementGate = null,
            replacementConsent = null,
        } = {}) {
        const layer = createMediaLayer(file, mediaType)
        const candidateGeneration = generation ?? ++this._replacementGeneration
        const prepareAndInstall = async (token, activeReplacementGate) => {
            let resource
            try {
                resource = await this._renderer.prepareMediaResource(file, mediaType)
            } catch (err) {
                if (candidateGeneration !== this._replacementGeneration) return 'cancelled'
                console.error('[Layers] Failed to load media:', err)
                toast.error('Failed to load media: ' + err.message)
                return 'failed'
            }

            if (candidateGeneration !== this._replacementGeneration) {
                this._renderer.disposeMediaResource(resource)
                return 'cancelled'
            }
            if (!resource
                || !Number.isSafeInteger(resource.width) || resource.width < 1
                || resource.width > MAX_CANVAS_DIMENSION
                || !Number.isSafeInteger(resource.height) || resource.height < 1
                || resource.height > MAX_CANVAS_DIMENSION) {
                this._renderer.disposeMediaResource(resource)
                toast.error('Failed to load media: invalid dimensions')
                return 'failed'
            }

            const outcome = await this._installPreparedProject({
                layers: [layer],
                width: resource.width,
                height: resource.height,
                projectId: null,
                projectName: null,
                dirty: true,
                selectedLayerId: layer.id,
                mediaTextures: new Map([[layer.id, resource]]),
                maskTextures: new Map()
            }, {
                generation: candidateGeneration,
                leaveOnline,
                replacementConsent,
                mutationToken: token,
                replacementGate: activeReplacementGate,
            })

            if (outcome.status === 'opened') {
                this._completeProjectReplacementUi(`Opened ${file.name}`)
            } else if (outcome.status === 'failed') {
                console.error('[Layers] Failed to install media:', outcome.error)
                toast.error('Failed to open media: ' + outcome.error.message)
            }
            return outcome.status
        }
        if (replacementGate) {
            return prepareAndInstall(mutationToken, replacementGate)
        }
        return this._runProjectReplacement(mutationToken, prepareAndInstall)
    }

    /**
     * Handle new project from clipboard image
     * @private
     */
    async _handleNewFromClipboard({
        leaveOnline = false,
        mutationToken = null,
        replacementConsent = null,
    } = {}) {
        const generation = ++this._replacementGeneration
        return this._runProjectReplacement(mutationToken, async (token, replacementGate) => {
            const result = await pasteFromClipboard()
            if (!result) {
                toast.error('No image found in clipboard')
                return
            }

            const file = new File([result.blob], 'Clipboard Image.png', { type: 'image/png' })
            return this._handleOpenMedia(file, 'image', {
                leaveOnline,
                replacementConsent,
                generation,
                mutationToken: token,
                replacementGate,
            })
        })
    }

    /**
     * Copy composite canvas to clipboard
     * @private
     */
    async _handleCopyImage() {
        this._renderCurrentFrame()
        const ok = await copyCanvasToClipboard(this._canvas)
        if (ok) {
            toast.success('Copied image to clipboard')
        } else {
            toast.error('Failed to copy image')
        }
    }

    /**
     * Gate an operation that would create (or morph a layer into) a media
     * layer while a Seance session is online — media layers can't ride the
     * shared node doc (see collab/docModel.js §5 in the design doc: their
     * bytes only exist in local storage). Same toast wording family as the
     * pre-existing gates below and in _handlePaste()/agent addMediaLayer.
     * @param {string} what - gerund/noun phrase describing the blocked action
     * @returns {boolean} true if blocked (caller must bail without mutating)
     * @private
     */
    _blockedMediaOnline(what) {
        if (!this._onlineAdapter?.isOnline()) return false
        toast.warning(`${what} isn’t supported while a Layers session is online`)
        return true
    }

    /**
     * Handle adding a media layer
     * @param {File} file - Media file
     * @param {string} mediaType - 'image' or 'video'
     * @private
     */
    async _handleAddMediaLayer(file, mediaType, {
        mutationToken = null,
        name = null,
    } = {}) {
        return this._runProjectLifecycle(mutationToken, async () => {
            if (this._onlineAdapter?.isOnline()) {
                toast.warning('Media layers aren’t supported while a Layers session is online')
                return { status: 'blocked-online' }
            }

            const resource = await this._renderer.prepareMediaResource(file, mediaType)
            if (!resource) throw new Error('Unsupported media resource')
            if (this._onlineAdapter?.isOnline()) {
                this._renderer.disposeMediaResource(resource)
                toast.warning('Media layers aren’t supported while a Layers session is online')
                return { status: 'blocked-online' }
            }

            const layer = createMediaLayer(file, mediaType, name)
            return this._commitAddedLayer(layer, { resource })
        })
    }

    /**
     * Handle adding an effect layer
     * @param {string} effectId - Effect ID
     * @private
     */
    async _handleAddEffectLayer(effectId, { name = null, params = null } = {}) {
        const layer = createEffectLayer(effectId, name, params || {})
        return this._commitAddedLayer(layer)
    }

    /**
     * Handle adding an empty drawing layer.
     * @param {string} [name]
     * @returns {Promise<{status:'added',layerId:string}|{status:'failed',error:Error}>}
     * @private
     */
    async _handleAddDrawingLayer(name) {
        const layer = createDrawingLayer(name)
        return this._commitAddedLayer(layer)
    }

    async _handleAutoCorrection(correctionFn) {
        this._renderCurrentFrame()
        const result = correctionFn(this._canvas)
        if (!result) {
            toast.info('No correction needed')
            return null
        }
        const layer = createEffectLayer(
            result.effectId, result.name, result.effectParams)
        const outcome = await this._commitAddedLayer(layer, { showSuccess: false })
        if (outcome.status !== 'added') return outcome
        try {
            toast.success(`Applied: ${result.name}`)
        } catch (err) {
            console.error('[Layers] Failed to show auto-correction confirmation:', err)
        }
        // Return the newly-created adjustment layer so callers (e.g. the
        // agent's auto* commands) can report whether work was done.
        return layer
    }

    // ── Mask management ─────────────────────────────────────────────────

    /**
     * Add a fully white (revealed) mask to a layer.
     * @param {string} layerId
     */
    async _addLayerMask(layerId, { enterEditMode = true } = {}) {
        const layer = this._layers.find(l => l.id === layerId)
        if (!layer || layer.mask) return

        const w = this._canvas.width
        const h = this._canvas.height
        const mask = new ImageData(w, h)
        // Fill with white (fully visible)
        for (let i = 0; i < mask.data.length; i += 4) {
            mask.data[i] = 255     // R
            mask.data[i + 1] = 255 // G
            mask.data[i + 2] = 255 // B
            mask.data[i + 3] = 255 // A
        }
        const outcome = await this._commitMaskMutation(layer, () => {
            layer.mask = mask
            layer.maskEnabled = true
            this._renderer.uploadMaskTexture(layerId, mask)
        }, { updateLayerStack: true })
        if (outcome.status !== 'committed') return outcome
        if (enterEditMode) {
            this._enterMaskEditMode(layerId)
            toast.success('Layer mask added — paint to hide areas, Escape to exit')
        }
        return outcome
    }

    /**
     * Create a mask from the current selection.
     * @param {string} layerId
     */
    async _maskFromSelection(layerId) {
        const layer = this._layers.find(l => l.id === layerId)
        if (!layer) return

        const selMask = this._selectionManager.rasterizeSelection()
        if (!selMask) {
            toast.info('No selection active')
            return
        }

        const outcome = await this._commitMaskMutation(layer, () => {
            layer.mask = selMask
            layer.maskEnabled = true
            this._renderer.uploadMaskTexture(layerId, selMask)
        }, { updateLayerStack: true })
        if (outcome.status !== 'committed') return outcome
        toast.success('Mask created from selection')
        return outcome
    }

    /**
     * Delete a layer's mask.
     * @param {string} layerId
     */
    async _deleteLayerMask(layerId) {
        const layer = this._layers.find(l => l.id === layerId)
        if (!layer || !layer.mask) return

        const editing = this._maskEditMode && this._maskEditLayerId === layerId
        const outcome = await this._commitMaskMutation(layer, () => {
            layer.mask = null
            layer.maskEnabled = true
            layer.maskVisible = false
            if (editing) this._applyMaskEditModeExitUi(layer, { uploadTexture: false })
        }, { updateLayerStack: true })
        if (outcome.status !== 'committed') return outcome
        this._renderer.removeMaskTexture(layerId)
        toast.info('Layer mask deleted')
        return outcome
    }

    /**
     * Invert a layer's mask (swap black/white).
     * @param {string} layerId
     */
    async _invertLayerMask(layerId) {
        const layer = this._layers.find(l => l.id === layerId)
        if (!layer?.mask) return

        const outcome = await this._commitMaskMutation(layer, () => {
            const data = layer.mask.data
            for (let i = 0; i < data.length; i += 4) {
                data[i] = 255 - data[i]
                data[i + 1] = 255 - data[i + 1]
                data[i + 2] = 255 - data[i + 2]
            }
            this._renderer.uploadMaskTexture(layerId, layer.mask)
            if (this._maskEditMode && this._maskEditLayerId === layerId) {
                this._renderMaskOverlay(layer)
            }
        })
        if (outcome.status !== 'committed') return outcome
        toast.success('Mask inverted')
        return outcome
    }

    /** Convert mask format (RGB=val, A=255) to selection format (A=val) */
    _maskToSelectionFormat(mask) {
        const copy = new ImageData(new Uint8ClampedArray(mask.data), mask.width, mask.height)
        for (let i = 0; i < copy.data.length; i += 4) {
            copy.data[i + 3] = copy.data[i]  // Copy R to A
        }
        return copy
    }

    /** Convert selection format back to mask format (ensure A=255) */
    _selectionFormatToMask(mask) {
        const d = mask.data
        for (let i = 0; i < d.length; i += 4) {
            d[i + 3] = 255  // Force A=255, R/G/B already have mask value
        }
        return mask
    }

    /** @private */
    _applyLayerMaskTransform(layerId, transform) {
        const layer = this._layers.find(l => l.id === layerId)
        if (!layer?.mask) return
        return this._commitMaskMutation(layer, () => {
            const converted = this._maskToSelectionFormat(layer.mask)
            layer.mask = this._selectionFormatToMask(transform(converted))
            this._renderer.uploadMaskTexture(layerId, layer.mask)
            if (this._maskEditMode && this._maskEditLayerId === layerId) {
                this._renderMaskOverlay(layer)
            }
        })
    }

    async _featherLayerMask(layerId) {
        const layer = this._layers.find(l => l.id === layerId)
        if (!layer?.mask) return
        const radius = await selectionParamDialog.show({ title: 'Feather Mask', label: 'Radius', defaultValue: 5, min: 1, max: 100 })
        if (radius === null) return
        return this._applyLayerMaskTransform(
            layerId, converted => featherMask(converted, radius))
    }

    async _expandLayerMask(layerId) {
        const layer = this._layers.find(l => l.id === layerId)
        if (!layer?.mask) return
        const radius = await selectionParamDialog.show({ title: 'Expand Mask', label: 'Radius', defaultValue: 5, min: 1, max: 100 })
        if (radius === null) return
        return this._applyLayerMaskTransform(
            layerId, converted => expandMask(converted, radius))
    }

    async _contractLayerMask(layerId) {
        const layer = this._layers.find(l => l.id === layerId)
        if (!layer?.mask) return
        const radius = await selectionParamDialog.show({ title: 'Contract Mask', label: 'Radius', defaultValue: 5, min: 1, max: 100 })
        if (radius === null) return
        return this._applyLayerMaskTransform(
            layerId, converted => contractMask(converted, radius))
    }

    async _smoothLayerMask(layerId) {
        const layer = this._layers.find(l => l.id === layerId)
        if (!layer?.mask) return
        const radius = await selectionParamDialog.show({ title: 'Smooth Mask', label: 'Radius', defaultValue: 5, min: 1, max: 100 })
        if (radius === null) return
        return this._applyLayerMaskTransform(
            layerId, converted => smoothMask(converted, radius))
    }

    /**
     * Toggle mask enabled/disabled.
     * @param {string} layerId
     */
    async _toggleMaskEnabled(layerId) {
        const layer = this._layers.find(l => l.id === layerId)
        if (!layer?.mask) return
        return this._setMaskEnabled(layerId, !layer.maskEnabled)
    }

    /** @private */
    _setMaskEnabled(layerId, enabled) {
        const layer = this._layers.find(l => l.id === layerId)
        if (!layer?.mask) return
        if (layer.maskEnabled === enabled) {
            return Promise.resolve({ status: 'committed', noop: true })
        }
        return this._commitMaskMutation(layer, () => {
            layer.maskEnabled = enabled
        }, { updateLayerStack: true })
    }

    /**
     * Create a selection from a layer's mask.
     * @param {string} layerId
     */
    _selectionFromMask(layerId) {
        const layer = this._layers.find(l => l.id === layerId)
        if (!layer?.mask) return

        this._selectionManager.setSelection({
            type: 'mask',
            data: new ImageData(
                new Uint8ClampedArray(layer.mask.data),
                layer.mask.width, layer.mask.height
            )
        })
        toast.success('Selection created from mask')
    }

    _closeContextMenus() {
        for (const id of ['maskContextMenu', 'layerContextMenu']) {
            document.getElementById(id)?.classList.add('hidden')
        }
        if (this._contextMenuCloseHandler) {
            document.removeEventListener('mousedown', this._contextMenuCloseHandler)
            this._contextMenuCloseHandler = null
        }
    }

    _showMaskContextMenu(layerId, x, y) {
        if (this._projectLifecycleActive || this._projectReplacementActive
            || this._projectLifecycleWaiters > 0) return
        const generation = this._replacementGeneration
        const menu = document.getElementById('maskContextMenu')
        if (!menu) return

        const layer = this._layers.find(l => l.id === layerId)
        if (!layer) return

        this._closeContextMenus()

        // Update disable/enable text
        const disableItem = menu.querySelector('[data-action="disable"]')
        if (disableItem) {
            disableItem.textContent = layer.maskEnabled ? 'Disable Mask' : 'Enable Mask'
        }

        menu.style.left = `${x}px`
        menu.style.top = `${y}px`
        menu.classList.remove('hidden')

        // Close on click outside
        this._contextMenuCloseHandler = (e) => {
            if (!menu.contains(e.target)) {
                this._closeContextMenus()
            }
        }
        setTimeout(() => document.addEventListener('mousedown', this._contextMenuCloseHandler), 0)

        // Handle menu item clicks
        menu.onclick = async (e) => {
            const action = e.target.closest('[data-action]')?.dataset.action
            if (!action) return
            this._closeContextMenus()

            await this._runPointerMutation(async () => {
                switch (action) {
                    case 'invert': await this._invertLayerMask(layerId); break
                    case 'feather': await this._featherLayerMask(layerId); break
                    case 'expand': await this._expandLayerMask(layerId); break
                    case 'contract': await this._contractLayerMask(layerId); break
                    case 'smooth': await this._smoothLayerMask(layerId); break
                    case 'disable': await this._toggleMaskEnabled(layerId); break
                    case 'selection-from-mask': this._selectionFromMask(layerId); break
                    case 'delete': await this._deleteLayerMask(layerId); break
                }
            }, { generation })
        }
    }

    _showLayerContextMenu(layerId, hasMask, x, y) {
        if (this._projectLifecycleActive || this._projectReplacementActive
            || this._projectLifecycleWaiters > 0) return
        const generation = this._replacementGeneration
        const menu = document.getElementById('layerContextMenu')
        if (!menu) return

        // Show/hide items based on mask state
        const addMaskItem = menu.querySelector('[data-action="add-mask"]')
        const maskFromSelItem = menu.querySelector('[data-action="mask-from-selection"]')
        if (addMaskItem) addMaskItem.classList.toggle('hide', hasMask)
        if (maskFromSelItem) maskFromSelItem.classList.toggle('hide', hasMask)

        // Don't show if all items are hidden
        if (hasMask) return

        this._closeContextMenus()

        menu.style.left = `${x}px`
        menu.style.top = `${y}px`
        menu.classList.remove('hidden')

        this._contextMenuCloseHandler = (e) => {
            if (!menu.contains(e.target)) {
                this._closeContextMenus()
            }
        }
        setTimeout(() => document.addEventListener('mousedown', this._contextMenuCloseHandler), 0)

        menu.onclick = async (e) => {
            const action = e.target.closest('[data-action]')?.dataset.action
            if (!action) return
            this._closeContextMenus()

            await this._runPointerMutation(async () => {
                switch (action) {
                    case 'add-mask': await this._addLayerMask(layerId); break
                    case 'mask-from-selection': await this._maskFromSelection(layerId); break
                }
            }, { generation })
        }
    }

    /**
     * Enter mask editing mode for a layer.
     * Shows rubylith overlay and switches tools to paint on mask.
     * @param {string} layerId
     */
    _enterMaskEditMode(layerId) {
        const layer = this._layers.find(l => l.id === layerId)
        if (!layer?.mask) return

        this._maskEditMode = true
        this._maskEditLayerId = layerId
        layer.maskVisible = true

        // Switch to brush tool for mask painting
        this._setToolMode('brush')

        // Route brush strokes to mask painting
        if (this._brushTool) {
            this._brushTool.onStrokeComplete = (stroke) => {
                const isEraser = this._currentTool === 'eraser'
                return this._handleMaskStroke(stroke, isEraser)
            }
        }

        // Show mask edit banner
        document.getElementById('maskEditBanner')?.classList.remove('hidden')
        const brushBtn = document.getElementById('brushToolBtn')
        const eraserBtn = document.getElementById('eraserToolBtn')
        if (brushBtn) brushBtn.title = 'Reveal (B) — paints white on mask'
        if (eraserBtn) eraserBtn.title = 'Hide (E) — paints black on mask'

        this._renderMaskOverlay(layer)
        this._updateLayerStack()
    }

    /**
     * Exit mask editing mode.
     */
    async _exitMaskEditMode({ updateRenderer = true } = {}) {
        if (!this._maskEditMode) return
        const layer = updateRenderer
            ? this._layers.find(l => l.id === this._maskEditLayerId)
            : null
        if (!updateRenderer) {
            this._applyMaskEditModeExitUi(null, { uploadTexture: false })
            return { status: 'committed' }
        }
        if (!layer) return
        return this._commitMaskMutation(layer, () => {
            this._applyMaskEditModeExitUi(layer)
        }, {
            rebuildOptions: { force: true },
            updateLayerStack: true,
            markDirty: false,
            pushUndo: false,
            finalizePendingUndo: false,
        })
    }

    /** @private */
    _applyMaskEditModeExitUi(layer, { uploadTexture = true } = {}) {
        this._closeContextMenus()
        if (layer) {
            layer.maskVisible = false
            if (uploadTexture && layer.mask) {
                this._renderer.uploadMaskTexture(layer.id, layer.mask)
            }
        }

        this._maskEditMode = false
        this._maskEditLayerId = null

        // Clear brush stroke interception
        if (this._brushTool) {
            this._brushTool.onStrokeComplete = null
        }

        // Hide mask edit banner and restore tool titles
        document.getElementById('maskEditBanner')?.classList.add('hidden')
        const brushBtn = document.getElementById('brushToolBtn')
        const eraserBtn = document.getElementById('eraserToolBtn')
        if (brushBtn) brushBtn.title = 'Brush Tool (B)'
        if (eraserBtn) eraserBtn.title = 'Eraser Tool (E)'

        const overlay = document.getElementById('maskOverlay')
        if (overlay) {
            overlay.classList.add('hidden')
        }
    }

    /**
     * Render the rubylith overlay for a mask.
     * Red = hidden areas, transparent = visible areas.
     * @param {object} layer
     */
    _renderMaskOverlay(layer) {
        const overlay = document.getElementById('maskOverlay')
        if (!overlay || !layer.mask) return

        overlay.width = layer.mask.width
        overlay.height = layer.mask.height
        // Match CSS size to selection overlay so they align exactly
        const selOverlay = this._selectionOverlay
        if (selOverlay) {
            overlay.style.width = selOverlay.clientWidth + 'px'
            overlay.style.height = selOverlay.clientHeight + 'px'
        }
        overlay.classList.remove('hidden')

        const ctx = overlay.getContext('2d')
        ctx.clearRect(0, 0, overlay.width, overlay.height)

        // Create rubylith: red where mask is dark (hidden)
        const maskData = layer.mask
        const overlayData = ctx.createImageData(overlay.width, overlay.height)
        for (let i = 0; i < maskData.data.length; i += 4) {
            const maskVal = maskData.data[i] // Red channel = mask value
            const hiddenAmount = 1 - maskVal / 255
            overlayData.data[i] = 255       // R
            overlayData.data[i + 1] = 0     // G
            overlayData.data[i + 2] = 0     // B
            overlayData.data[i + 3] = Math.round(hiddenAmount * 128) // A (semi-transparent)
        }
        ctx.putImageData(overlayData, 0, 0)
    }

    /**
     * Handle a completed stroke in mask edit mode.
     * Composites the stroke onto the mask ImageData.
     * @param {object} stroke - Stroke object from drawing tools
     * @param {boolean} isEraser - True if erasing (paint black/hide)
     */
    async _handleMaskStroke(stroke, isEraser) {
        const layer = this._layers.find(l => l.id === this._maskEditLayerId)
        if (!layer?.mask) return
        return this._commitMaskMutation(layer, () => {
            // Rasterize the stroke to a temporary canvas
            if (!this._strokeRenderer) {
                this._strokeRenderer = new StrokeRenderer()
            }

            // Scale stroke from overlay coordinates to mask coordinates
            const scaleX = layer.mask.width / this._selectionOverlay.width
            const scaleY = layer.mask.height / this._selectionOverlay.height
            const maskStroke = {
                ...stroke,
                color: isEraser ? '#000000' : '#ffffff',
                size: stroke.size * Math.max(scaleX, scaleY),
                points: stroke.points.map(p => ({ x: p.x * scaleX, y: p.y * scaleY }))
            }
            const strokeCanvas = this._strokeRenderer.rasterize(
                [maskStroke], layer.mask.width, layer.mask.height
            )

            // Composite onto the mask
            const maskCanvas = document.createElement('canvas')
            maskCanvas.width = layer.mask.width
            maskCanvas.height = layer.mask.height
            const ctx = maskCanvas.getContext('2d')
            ctx.putImageData(layer.mask, 0, 0)
            ctx.drawImage(strokeCanvas, 0, 0)

            // Read back the composited result
            layer.mask = ctx.getImageData(0, 0, maskCanvas.width, maskCanvas.height)

            // Update texture and overlay
            this._renderer.uploadMaskTexture(layer.id, layer.mask)
            this._renderMaskOverlay(layer)
        }, { pushUndo: 'debounced' })
    }

    // ── End mask management ─────────────────────────────────────────────

    /**
     * Add a child effect to a parent layer
     * @param {string} parentLayerId - Parent layer ID
     * @param {string} effectId - Effect ID to add
     * @private
     */
    async _handleAddChildEffect(parentLayerId, effectId, {
        name = null,
        params = null,
    } = {}) {
        const parent = this._layers.find(l => l.id === parentLayerId)
        if (!parent) return
        const child = createChildEffect(effectId, name, params || {})
        const outcome = await this._commitModelMutation(() => {
            if (!parent.children) parent.children = []
            parent.children.push(child)
        }, {
            updateLayerStack: true,
            selectedLayerIds: [child.id],
            selectionAnchor: child.id,
        })
        if (outcome.status !== 'committed') return outcome

        try {
            toast.success(`Added effect: ${child.name}`)
        } catch (err) {
            console.error('[Layers] Failed to show child-effect confirmation:', err)
        }
        return { ...outcome, childId: child.id }
    }

    /**
     * Handle deleting a layer
     * @param {string} layerId - Layer ID to delete
     * @param {string} [parentLayerId] - Parent layer ID if deleting a child effect
     * @private
     */
    async _handleDeleteLayer(layerId, parentLayerId) {
        if (parentLayerId) {
            // Deleting a child effect
            const parent = this._layers.find(l => l.id === parentLayerId)
            if (!parent || !parent.children) return

            const childIndex = parent.children.findIndex(c => c.id === layerId)
            if (childIndex < 0) return

            const child = parent.children[childIndex]
            const selectedIds = this._layerStack?.selectedLayerIds || []
            const survivingSelectedIds = selectedIds.filter(id => id !== child.id)
            const nextSelectedIds = selectedIds.includes(child.id)
                ? (survivingSelectedIds.length > 0
                    ? survivingSelectedIds
                    : [parent.id])
                : selectedIds
            const outcome = await this._commitModelMutation(() => {
                parent.children.splice(childIndex, 1)
            }, {
                updateLayerStack: true,
                selectedLayerIds: nextSelectedIds,
                selectionAnchor: nextSelectedIds.at(-1) || null,
            })
            if (outcome.status !== 'committed') return outcome
            try {
                toast.info(`Deleted effect: ${child.name}`)
            } catch (err) {
                console.error('[Layers] Failed to show child-effect deletion:', err)
            }
            return outcome
        }

        // Existing top-level layer delete logic
        const index = this._layers.findIndex(l => l.id === layerId)
        if (index <= 0) return // Can't delete base layer

        const layer = this._layers[index]
        const selectedIds = this._layerStack?.selectedLayerIds || []
        const survivingSelectedIds = selectedIds.filter(id => id !== layer.id)
        const nextSelectedIds = selectedIds.includes(layer.id)
            ? (survivingSelectedIds.length > 0
                ? survivingSelectedIds
                : [this._layers[index - 1].id])
            : selectedIds
        const editing = this._maskEditMode && this._maskEditLayerId === layer.id
        const previousUi = editing ? this._captureMaskEditUiState() : null
        const outcome = await this._commitModelMutation(() => {
            if (editing) {
                this._applyMaskEditModeExitUi(layer, { uploadTexture: false })
            }
            this._layers.splice(index, 1)
        }, {
            updateLayerStack: true,
            selectedLayerIds: nextSelectedIds,
            selectionAnchor: nextSelectedIds.at(-1) || null,
            restore: () => {
                if (previousUi) this._restoreMaskEditUiState(previousUi)
            },
        })
        if (outcome.status !== 'committed') return outcome
        if (layer.sourceType === 'media' || layer.sourceType === 'drawing') {
            this._renderer.unloadMedia(layerId)
        }
        if (layer.mask) this._renderer.removeMaskTexture(layer.id)
        try {
            toast.info(`Deleted layer: ${layer.name}`)
        } catch (err) {
            console.error('[Layers] Failed to show layer deletion:', err)
        }
        return outcome
    }

    /**
     * Handle layer changes (visibility, blend mode, opacity, effectParams)
     * @param {object} detail - Change detail
     * @private
     */
    async _handleLayerChange(detail) {
        // Find the target — either a child or a top-level layer
        let layer
        if (detail.parentLayerId) {
            const parent = this._layers.find(l => l.id === detail.parentLayerId)
            layer = parent?.children?.find(c => c.id === detail.layerId)
        } else {
            layer = this._layers.find(l => l.id === detail.layerId)
        }
        if (!layer) return

        // Handle child-specific property changes
        if (detail.property === 'effectParams') {
            const previousParams = layer.effectParams
            const outcome = await this._commitModelMutation(() => {
                layer.effectParams = detail.value
            }, {
                pushUndo: 'debounced',
                finalizePendingUndo: false,
                render: () => {
                    this._renderer.updateLayerParams(detail.layerId, detail.value)
                    this._renderer.syncDsl()
                    return { success: true }
                },
                restore: () => {
                    this._renderer.updateLayerParams(detail.layerId, previousParams)
                    this._renderer.syncDsl()
                },
            })
            if (outcome.status === 'committed') {
                this._onlineAdapter?.schedulePublish()
            }
            return outcome
        }

        const field = detail.property === 'visibility'
            ? 'visible'
            : detail.property
        const isDebounced = detail.property === 'opacity'
        return this._commitModelMutation(() => {
            layer[field] = detail.value
        }, {
            updateLayerStack: detail.updateLayerStack === true
                || detail.property === 'visibility',
            pushUndo: isDebounced ? 'debounced' : true,
            finalizePendingUndo: !isDebounced,
        })
    }

    /** @private */
    _reorderLayer(layerId, toIndex) {
        const fromIndex = this._layers.findIndex(layer => layer.id === layerId)
        if (fromIndex <= 0 || toIndex <= 0) return
        return this._commitModelMutation(() => {
            const [moved] = this._layers.splice(fromIndex, 1)
            this._layers.splice(toIndex, 0, moved)
        }, { updateLayerStack: true, updateLayerZIndex: true })
    }

    /** @private */
    _reorderChildEffect(parentLayerId, childId, toIndex) {
        const parent = this._layers.find(layer => layer.id === parentLayerId)
        const fromIndex = parent?.children?.findIndex(child => child.id === childId) ?? -1
        if (fromIndex < 0) return
        return this._commitModelMutation(() => {
            const [moved] = parent.children.splice(fromIndex, 1)
            parent.children.splice(toIndex, 0, moved)
        }, { updateLayerStack: true })
    }

    /**
     * FSM: Start drag operation (IDLE → DRAGGING)
     * @param {string} layerId - Layer being dragged
     * @private
     */
    _startDrag(layerId) {
        if (this._reorderState !== 'IDLE') {
            console.warn('[Layers] Cannot start drag - not in IDLE state')
            return
        }

        const sourceIndex = this._layers.findIndex(l => l.id === layerId)
        if (sourceIndex === -1 || sourceIndex === 0) {
            console.warn('[Layers] Cannot drag base layer or unknown layer')
            return
        }

        // Capture snapshot
        const snapshot = {
            layersArray: this._layers,
            layers: this._layers.slice(),
            dsl: this._renderer._currentDsl
        }
        const mutationToken = this._tryAcquireProjectLifecycle()
        if (!mutationToken) return
        this._reorderSnapshot = snapshot
        this._reorderSource = { layerId, index: sourceIndex }
        this._reorderMutationToken = mutationToken
        this._reorderGeneration = this._replacementGeneration
        this._reorderState = 'DRAGGING'

        // Update z-index on all layer items
        this._updateLayerZIndex()

        console.debug('[Layers] FSM: IDLE → DRAGGING', { layerId, sourceIndex })
    }

    /**
     * FSM: Cancel drag operation (DRAGGING → IDLE)
     * @private
     */
    _cancelDrag() {
        if (this._reorderState !== 'DRAGGING') return

        this._reorderSnapshot = null
        this._reorderSource = null
        this._reorderState = 'IDLE'
        this._releaseReorderMutation()

        // Clear any drag-over indicators
        this._clearDragIndicators()

        console.debug('[Layers] FSM: DRAGGING → IDLE (cancelled)')
    }

    _releaseReorderMutation() {
        this._reorderMutationToken?.release()
        this._reorderMutationToken = null
        this._reorderGeneration = null
    }

    /**
     * Update z-index on layer items based on stack position
     * @private
     */
    _updateLayerZIndex() {
        const items = this._layerStack?.querySelectorAll('layer-item')
        if (!items) return

        const count = items.length
        items.forEach((item, domIndex) => {
            // DOM order is top-to-bottom, so first item = highest z-index
            item.style.zIndex = count - domIndex
        })
    }

    /**
     * Clear all drag indicator classes from layer items
     * @private
     */
    _clearDragIndicators() {
        const items = this._layerStack?.querySelectorAll('layer-item')
        if (!items) return

        items.forEach(item => {
            item.classList.remove('drag-over', 'drag-over-above', 'drag-over-below', 'dragging')
        })
    }

    /**
     * Calculate new layer order based on drop position
     * @param {string} sourceId - ID of layer being moved
     * @param {string} targetId - ID of drop target layer
     * @param {string} dropPosition - 'above' or 'below'
     * @returns {Array|null} New layer order, or null if invalid
     * @private
     */
    _calculateNewOrder(sourceId, targetId, dropPosition) {
        const layers = [...this._layers]

        const sourceIdx = layers.findIndex(l => l.id === sourceId)
        const targetIdx = layers.findIndex(l => l.id === targetId)

        // Validate
        if (sourceIdx === -1 || targetIdx === -1) return null
        if (sourceIdx === 0) return null  // can't move base layer
        if (sourceIdx === targetIdx) return null  // dropping on self

        // Remove source
        const [sourceLayer] = layers.splice(sourceIdx, 1)

        // Calculate insert position on the MODIFIED array
        let insertIdx = targetIdx
        if (sourceIdx < targetIdx) {
            // Source was above target, target shifted up by 1
            insertIdx = targetIdx - 1
        }

        // Adjust for drop position
        // In our UI: higher index = visually higher (top of stack)
        // dropPosition 'above' means visually above = higher index
        // dropPosition 'below' means visually below = same or lower index
        if (dropPosition === 'above') {
            insertIdx = insertIdx + 1
        }
        // Ensure we never place at or below base layer (index 0)
        insertIdx = Math.max(1, insertIdx)

        layers.splice(insertIdx, 0, sourceLayer)
        return layers
    }

    /**
     * FSM: Process drop operation (DRAGGING → PROCESSING → IDLE or ROLLING_BACK)
     * @param {string} targetId - ID of drop target layer
     * @param {string} dropPosition - 'above' or 'below'
     * @private
     */
    async _processDrop(targetId, dropPosition) {
        if (this._reorderState !== 'DRAGGING') {
            console.warn('[Layers] Cannot process drop - not in DRAGGING state')
            return
        }
        if (!this._reorderMutationToken
            || this._reorderGeneration !== this._replacementGeneration) {
            this._cancelDrag()
            return
        }

        const sourceId = this._reorderSource?.layerId
        if (!sourceId) {
            this._cancelDrag()
            return
        }

        this._reorderState = 'PROCESSING'
        console.debug('[Layers] FSM: DRAGGING → PROCESSING', { sourceId, targetId, dropPosition })

        // Clear visual indicators
        this._clearDragIndicators()

        try {
            // Calculate new order
            const newLayers = this._calculateNewOrder(sourceId, targetId, dropPosition)
            if (!newLayers) {
                console.debug('[Layers] Invalid reorder - returning to IDLE')
                this._reorderState = 'IDLE'
                this._reorderSnapshot = null
                this._reorderSource = null
                return
            }

            // Generate and validate new DSL
            const newDsl = this._renderer.buildDslFromLayers(newLayers)
            const result = await this._renderer.tryCompile(newDsl)

            if (result.success) {
                const outcome = await this._commitModelMutation(() => {
                    this._layers.splice(0, this._layers.length, ...newLayers)
                }, {
                    rebuildOptions: { force: true },
                    updateLayerStack: true,
                    updateLayerZIndex: true,
                })
                if (outcome.status !== 'committed') {
                    toast.error(`Layer reorder failed: ${outcome.error.message}. Changes reverted.`)
                }

                this._reorderState = 'IDLE'
                this._reorderSnapshot = null
                this._reorderSource = null

                console.debug(`[Layers] FSM: PROCESSING → IDLE (${outcome.status})`)
                return outcome
            } else {
                // Validation failed - rollback
                await this._rollback(result.error || 'DSL validation failed')
            }
        } catch (err) {
            await this._rollback(err.message || String(err))
        } finally {
            this._releaseReorderMutation()
        }
    }

    /**
     * FSM: Rollback failed reorder (PROCESSING → ROLLING_BACK → IDLE)
     * @param {string} error - Error message
     * @private
     */
    async _rollback(error) {
        this._reorderState = 'ROLLING_BACK'
        console.debug('[Layers] FSM: PROCESSING → ROLLING_BACK', { error })

        const primary = error instanceof Error ? error : new Error(String(error))
        const restorationErrors = []
        if (this._reorderSnapshot) {
            try {
                this._reorderSnapshot.layersArray.splice(
                    0, this._reorderSnapshot.layersArray.length,
                    ...this._reorderSnapshot.layers)
                this._layers = this._reorderSnapshot.layersArray
            } catch (err) {
                restorationErrors.push(err instanceof Error ? err : new Error(String(err)))
            }
            try {
                const result = await this._rebuild({ force: true })
                if (!result?.success) {
                    restorationErrors.push(new Error(
                        result?.error || 'Unknown renderer restoration failure'))
                }
            } catch (err) {
                restorationErrors.push(err instanceof Error ? err : new Error(String(err)))
            }
            try {
                this._updateLayerStack()
            } catch (err) {
                restorationErrors.push(err instanceof Error ? err : new Error(String(err)))
            }
        } else {
            restorationErrors.push(new Error('Reorder snapshot unavailable'))
        }

        this._reorderState = 'IDLE'
        this._reorderSnapshot = null
        this._reorderSource = null

        let outcome
        if (restorationErrors.length > 0) {
            const combined = new Error(
                `${primary.message}; failed to restore previous state: ${restorationErrors
                    .map(failure => failure.message).join('; ')}`)
            toast.error(`Layer reorder failed: ${combined.message}`)
            outcome = { status: 'failed', error: combined }
        } else {
            toast.error(`Layer reorder failed: ${primary.message}. Changes reverted.`)
            outcome = { status: 'failed', error: primary }
        }

        console.debug('[Layers] FSM: ROLLING_BACK → IDLE')
        return outcome
    }

    /**
     * Update the layer stack component
     * @private
     */
    _updateLayerStack() {
        // Re-query in case the element wasn't ready before
        if (!this._layerStack) {
            this._layerStack = document.querySelector('layer-stack')
        }

        if (this._layerStack) {
            this._layerStack.layers = this._layers
        } else {
            console.error('[Layers] layer-stack element not found!')
        }

        this._updateLayerMenu()
    }

    /**
     * Rebuild and render
     * @param {object} [options={}] - Options passed to renderer
     * @param {boolean} [options.force=false] - Force rebuild even if DSL unchanged
     * @private
     */
    async _rebuild(options = {}) {
        const layers = this._layers
        const result = await this._renderer.setLayers(layers, {
            ...options,
            isCurrent: () => this._layers === layers,
        })
        if (result.stale) return result
        if (!result.success) {
            console.error('[Layers] Rebuild failed:', result.error)
            toast.error('Failed to render: ' + result.error)
        }
        // Publish funnel: nearly every structural mutation (add/delete
        // layer, mask ops, brush/eraser strokes, reorder, undo/redo,
        // project load, resize...) already routes through _rebuild(), so
        // hooking it here covers them all with one debounced call. The
        // cheap updateLayerParams() path bypasses _rebuild() and schedules
        // its own publish (see _handleLayerChange()).
        this._onlineAdapter?.schedulePublish()
        return result
    }

    /** Render all pending uniform updates before reading the visible canvas. @private */
    _renderCurrentFrame() {
        this._renderer.render(this._renderer.getPausedNormalizedTime())
    }

    /**
     * Rasterize a drawing layer's strokes to a canvas and register the texture.
     * @param {object} layer - Drawing layer with strokes array
     * @private
     */
    async _rasterizeDrawingLayer(layer) {
        const canvas = await this._createDrawingLayerCanvas(
            layer, this._canvas.width, this._canvas.height)
        if (!canvas) {
            this._renderer.unloadMedia(layer.id)
            return
        }
        this._renderer.setMediaResource(
            layer.id, this._renderer.prepareCanvasMediaResource(canvas))
    }

    /**
     * Rasterize drawing strokes without registering a live renderer resource.
     * @param {object} layer
     * @param {number} width
     * @param {number} height
     * @returns {Promise<HTMLCanvasElement|null>}
     * @private
     */
    async _createDrawingLayerCanvas(layer, width, height) {
        if (layer.sourceType !== 'drawing') return null
        if (!layer.strokes || layer.strokes.length === 0) {
            layer.drawingCanvas = null
            return null
        }
        if (!this._strokeRenderer) {
            const { StrokeRenderer } = await import('./drawing/stroke-renderer.js')
            this._strokeRenderer = new StrokeRenderer()
        }
        const offscreen = this._strokeRenderer.rasterize(
            layer.strokes, width, height
        )

        // Convert OffscreenCanvas to HTMLCanvasElement for WebGL texture compatibility
        const canvas = document.createElement('canvas')
        canvas.width = width
        canvas.height = height
        const ctx = canvas.getContext('2d')
        ctx.drawImage(offscreen, 0, 0)

        layer.drawingCanvas = canvas
        return canvas
    }

    /**
     * Create a media layer from an HTML canvas element.
     * Used by fill tool and other tools that generate raster content.
     * @param {HTMLCanvasElement} canvas - Source canvas with content
     * @param {string} [name] - Layer name
     * @returns {Promise<{status: 'added', layerId: string}|{status: 'blocked-online'}|{status:'failed',error:Error}>}
     * @private
     */
    async _addMediaLayerFromCanvas(canvas, name) {
        if (this._blockedMediaOnline('Adding this layer')) {
            return { status: 'blocked-online' }
        }
        const layer = createMediaLayer(null, 'image', name || 'Fill')
        layer.mediaFile = null
        const resource = this._renderer.prepareCanvasMediaResource(canvas)
        return this._commitAddedLayer(layer, {
            resource,
            showSuccess: false,
        })
    }

    /**
     * Resize canvas to match media dimensions
     * @param {number} width - New width
     * @param {number} height - New height
     * @private
     */
    _resizeCanvas(width, height) {
        // Update canvas element
        this._canvas.width = width
        this._canvas.height = height
        
        // Update renderer
        this._renderer.resize(width, height)

        // Update selection overlay size
        if (this._selectionOverlay) {
            this._selectionOverlay.width = width
            this._selectionOverlay.height = height
        }
        if (this._selectionManager) {
            this._selectionManager.resize(width, height)
        }

        // Update mask overlay size
        const maskOverlay = document.getElementById('maskOverlay')
        if (maskOverlay) {
            maskOverlay.width = width
            maskOverlay.height = height
        }

        // Re-apply current zoom mode
        this._applyZoom()
    }

    /**
     * Apply the current zoom mode to the canvas
     * @private
     */
    _applyZoom() {
        const canvas = this._canvas
        if (!canvas) return

        // Update menu checkmarks
        const zoomMenuIds = {
            fit: 'fitInWindowMenuItem',
            50: 'zoom50MenuItem',
            100: 'zoom100MenuItem',
            200: 'zoom200MenuItem'
        }
        for (const [mode, id] of Object.entries(zoomMenuIds)) {
            document.getElementById(id)?.classList.toggle('checked', mode === this._zoomMode)
        }

        let displayWidth, displayHeight

        if (this._zoomMode === 'fit') {
            const container = canvas.parentElement
            const containerWidth = container.clientWidth
            const containerHeight = container.clientHeight
            const canvasAspect = canvas.width / canvas.height
            const containerAspect = containerWidth / containerHeight

            if (canvasAspect > containerAspect) {
                displayWidth = containerWidth
                displayHeight = containerWidth / canvasAspect
            } else {
                displayHeight = containerHeight
                displayWidth = containerHeight * canvasAspect
            }
        } else {
            const percent = parseInt(this._zoomMode) / 100
            displayWidth = canvas.width * percent
            displayHeight = canvas.height * percent
        }

        const widthPx = displayWidth + 'px'
        const heightPx = displayHeight + 'px'

        for (const el of [canvas, this._selectionOverlay]) {
            if (!el) continue
            el.style.maxWidth = 'none'
            el.style.maxHeight = 'none'
            el.style.width = widthPx
            el.style.height = heightPx
        }
    }

    /**
     * Set zoom mode
     * @param {string} mode - 'fit', '50', '100', or '200'
     * @private
     */
    _setZoom(mode) {
        this._zoomMode = mode
        this._applyZoom()
    }

    /**
     * Zoom in one step
     * @private
     */
    _zoomIn() {
        const steps = ['fit', '50', '100', '200']
        const currentIndex = steps.indexOf(this._zoomMode)
        // If at fit or not found, go to 100%. Otherwise go to next step.
        if (this._zoomMode === 'fit') {
            this._setZoom('100')
        } else if (currentIndex < steps.length - 1) {
            this._setZoom(steps[currentIndex + 1])
        }
    }

    /**
     * Zoom out one step
     * @private
     */
    _zoomOut() {
        const steps = ['fit', '50', '100', '200']
        const currentIndex = steps.indexOf(this._zoomMode)
        // If at fit, stay at fit. Otherwise go to previous step.
        if (currentIndex > 0) {
            this._setZoom(steps[currentIndex - 1])
        }
    }

    /**
     * Set up menu handlers
     * @private
     */
    _setupMenuHandlers() {
        // Submenu state — hoisted so menu title handlers can access it
        let activeSubmenu = null
        let activeSubmenuTrigger = null
        let activeSubmenuKeyboardControlled = false
        const setTitleExpanded = (title, expanded) => {
            if (title?.hasAttribute('aria-expanded')) {
                title.setAttribute('aria-expanded', String(expanded))
            }
        }
        const hideSubmenu = ({ restoreFocus = false } = {}) => {
            if (activeSubmenu) {
                activeSubmenu.classList.add('hide')
                if (activeSubmenuTrigger?.hasAttribute('aria-expanded')) {
                    activeSubmenuTrigger.setAttribute('aria-expanded', 'false')
                }
                const triggerToRestore = activeSubmenuTrigger
                activeSubmenu = null
                activeSubmenuTrigger = null
                activeSubmenuKeyboardControlled = false
                if (restoreFocus) triggerToRestore?.focus()
            }
        }
        const closeDropdowns = (except = null) => {
            document.querySelectorAll('.menu-items').forEach(items => {
                if (items === except) return
                items.classList.add('hide')
                setTitleExpanded(items.closest('.menu')?.querySelector('.menu-title'), false)
            })
        }
        const clampFilterDropdown = (menu, items) => {
            if (menu.id !== 'filterMenu') return
            const viewportInset = 8
            items.style.left = ''
            const rect = items.getBoundingClientRect()
            let left = Number.parseFloat(getComputedStyle(items).left) || 0
            let adjustedLeft = rect.left
            if (rect.right > window.innerWidth - viewportInset) {
                const overflow = rect.right - (window.innerWidth - viewportInset)
                left -= overflow
                adjustedLeft -= overflow
            }
            if (adjustedLeft < viewportInset) {
                left += viewportInset - adjustedLeft
            }
            items.style.left = `${left}px`
        }
        const positionToolbarFlyout = (menu, title, items) => {
            if (!menu.closest('#toolbar')
                || !window.matchMedia('(max-height: 520px)').matches) return

            const viewportInset = 8
            const toolbarRect = document.getElementById('toolbar').getBoundingClientRect()
            const titleRect = title.getBoundingClientRect()
            items.style.setProperty('--toolbar-flyout-left', `${toolbarRect.right + 4}px`)
            items.style.setProperty('--toolbar-flyout-top', `${viewportInset}px`)

            const flyoutHeight = items.getBoundingClientRect().height
            const maxTop = Math.max(
                viewportInset, window.innerHeight - viewportInset - flyoutHeight)
            const top = Math.min(Math.max(titleRect.top, viewportInset), maxTop)
            items.style.setProperty('--toolbar-flyout-top', `${top}px`)
        }
        const positionSubmenu = (trigger, submenu) => {
            const menuEl = trigger.closest('.menu')
            const menuRect = menuEl.getBoundingClientRect()
            const triggerRect = trigger.getBoundingClientRect()
            const menuItemsRect = trigger.closest('.menu-items').getBoundingClientRect()
            const viewportInset = 8
            const toolbarRight = document.getElementById('toolbar')?.getBoundingClientRect().right || 0
            const leftInset = menuEl.id === 'filterMenu'
                ? Math.max(viewportInset, toolbarRight + viewportInset)
                : viewportInset

            // Position relative to .menu (position: relative).
            submenu.style.top = `${triggerRect.top - menuRect.top}px`
            submenu.style.left = `${menuItemsRect.right - menuRect.left}px`

            let submenuRect = submenu.getBoundingClientRect()
            if (submenuRect.right > window.innerWidth - viewportInset) {
                submenu.style.left = `${menuItemsRect.left - menuRect.left - submenuRect.width}px`
                submenuRect = submenu.getBoundingClientRect()
            }
            if (submenuRect.left < leftInset) {
                submenu.style.left = `${leftInset - menuRect.left}px`
                submenuRect = submenu.getBoundingClientRect()
            }

            let top = Number.parseFloat(submenu.style.top) || 0
            let adjustedTop = submenuRect.top
            if (submenuRect.bottom > window.innerHeight - viewportInset) {
                const overflow = submenuRect.bottom - (window.innerHeight - viewportInset)
                top -= overflow
                adjustedTop -= overflow
            }
            if (adjustedTop < viewportInset) {
                top += viewportInset - adjustedTop
            }
            submenu.style.top = `${top}px`
        }

        const showSubmenu = (trigger, submenu, { focusFirst = false } = {}) => {
            hideSubmenu()
            submenu.classList.remove('hide')
            positionSubmenu(trigger, submenu)

            activeSubmenu = submenu
            activeSubmenuTrigger = trigger
            activeSubmenuKeyboardControlled = focusFirst
            if (trigger.hasAttribute('aria-expanded')) {
                trigger.setAttribute('aria-expanded', 'true')
            }
            if (focusFirst) {
                submenu.querySelector('[role="menuitem"]')?.focus()
            }
        }

        // Menu dropdowns
        const menus = document.querySelectorAll('.menu')
        menus.forEach(menu => {
            const title = menu.querySelector('.menu-title')
            const items = menu.querySelector('.menu-items')

            if (title && items) {
                title.addEventListener('click', (e) => {
                    e.stopPropagation()
                    hideSubmenu()
                    const shouldOpen = items.classList.contains('hide')
                    closeDropdowns(items)
                    items.classList.toggle('hide', !shouldOpen)
                    setTitleExpanded(title, shouldOpen)
                    if (shouldOpen) {
                        clampFilterDropdown(menu, items)
                        positionToolbarFlyout(menu, title, items)
                    }
                })
            }
        })
        const repositionOpenMenus = () => {
            document.querySelectorAll('#toolbar .menu-items:not(.hide)').forEach(items => {
                const menu = items.closest('.menu')
                const title = menu?.querySelector(':scope > .menu-title')
                if (menu && title) positionToolbarFlyout(menu, title, items)
            })

            const currentFilterMenu = document.getElementById('filterMenu')
            const currentFilterItems = currentFilterMenu?.querySelector(':scope > .menu-items')
            if (currentFilterItems && !currentFilterItems.classList.contains('hide')) {
                clampFilterDropdown(currentFilterMenu, currentFilterItems)
            }
            if (activeSubmenu?.closest('#filterMenu') && activeSubmenuTrigger) {
                positionSubmenu(activeSubmenuTrigger, activeSubmenu)
            }
        }
        window.addEventListener('resize', repositionOpenMenus)

        document.querySelectorAll('.has-submenu[data-submenu]').forEach(trigger => {
            const submenuId = trigger.dataset.submenu
            const menu = trigger.closest('.menu')
            const submenu = menu?.querySelector(`:scope > .submenu[data-submenu-id="${submenuId}"]`)
            if (!submenu) return

            trigger.addEventListener('mouseenter', () => {
                if (activeSubmenu === submenu && activeSubmenuKeyboardControlled) return
                showSubmenu(trigger, submenu)
            })

            if (menu.id === 'filterMenu') {
                trigger.addEventListener('click', (e) => {
                    e.stopPropagation()
                    showSubmenu(trigger, submenu, { focusFirst: e.detail === 0 })
                })
            }

            trigger.addEventListener('mouseleave', (e) => {
                if (activeSubmenuKeyboardControlled) return
                if (e.relatedTarget && submenu.contains(e.relatedTarget)) return
                hideSubmenu()
            })

            submenu.addEventListener('mouseleave', (e) => {
                if (activeSubmenuKeyboardControlled) return
                if (e.relatedTarget && trigger.contains(e.relatedTarget)) return
                hideSubmenu()
            })

            submenu.addEventListener('click', () => hideSubmenu())
        })

        const filterMenu = document.getElementById('filterMenu')
        const filterTitle = filterMenu?.querySelector(':scope > .menu-title')
        const filterItems = filterMenu?.querySelector(':scope > .menu-items')
        const filterTriggers = filterItems
            ? [...filterItems.querySelectorAll(':scope > [role="menuitem"]')]
            : []
        const openFilterMenu = (focusIndex) => {
            hideSubmenu()
            closeDropdowns(filterItems)
            filterItems.classList.remove('hide')
            setTitleExpanded(filterTitle, true)
            clampFilterDropdown(filterMenu, filterItems)
            filterTriggers.at(focusIndex)?.focus()
        }
        const closeFilterMenu = ({ restoreFocus = false } = {}) => {
            hideSubmenu()
            filterItems?.classList.add('hide')
            setTitleExpanded(filterTitle, false)
            if (restoreFocus) filterTitle?.focus()
        }

        // Let Tab/Shift+Tab move normally, then close once focus is no longer
        // inside the active dropdown/submenu popup. Moving back to the title
        // also closes because the title is the control, not part of the popup.
        filterMenu?.addEventListener('focusout', () => {
            setTimeout(() => {
                const focused = document.activeElement
                const inDropdown = Boolean(focused && filterItems?.contains(focused))
                const inSubmenu = Boolean(focused?.closest?.('#filterMenu > .submenu'))
                if (!inDropdown && !inSubmenu) closeFilterMenu()
            }, 0)
        })

        filterTitle?.addEventListener('keydown', (e) => {
            if (e.key === ' ' || e.key === 'Enter') {
                e.preventDefault()
                e.stopPropagation()
                openFilterMenu(0)
                return
            }
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault()
                e.stopPropagation()
                openFilterMenu(e.key === 'ArrowDown' ? 0 : -1)
            } else if (e.key === 'Escape') {
                e.preventDefault()
                e.stopPropagation()
                closeFilterMenu({ restoreFocus: true })
            }
        })

        filterTriggers.forEach((trigger, index) => {
            trigger.addEventListener('keydown', (e) => {
                if (e.key === ' ' || e.key === 'Enter') {
                    e.preventDefault()
                    e.stopPropagation()
                    const submenu = filterMenu.querySelector(
                        `:scope > .submenu[data-submenu-id="${trigger.dataset.submenu}"]`)
                    if (submenu) showSubmenu(trigger, submenu, { focusFirst: true })
                    else trigger.click()
                    return
                }
                if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                    e.preventDefault()
                    e.stopPropagation()
                    hideSubmenu()
                    const offset = e.key === 'ArrowDown' ? 1 : -1
                    filterTriggers[(index + offset + filterTriggers.length) % filterTriggers.length].focus()
                } else if (e.key === 'ArrowRight') {
                    e.preventDefault()
                    e.stopPropagation()
                    const submenu = filterMenu.querySelector(
                        `:scope > .submenu[data-submenu-id="${trigger.dataset.submenu}"]`)
                    if (submenu) showSubmenu(trigger, submenu, { focusFirst: true })
                } else if (e.key === 'Escape') {
                    e.preventDefault()
                    e.stopPropagation()
                    if (activeSubmenu) hideSubmenu({ restoreFocus: true })
                    else closeFilterMenu({ restoreFocus: true })
                }
            })
        })

        filterMenu?.querySelectorAll(':scope > .submenu').forEach(submenu => {
            const effects = [...submenu.querySelectorAll(':scope > [role="menuitem"]')]
            effects.forEach((effect, index) => {
                effect.addEventListener('keydown', (e) => {
                    if (e.key === ' ' || e.key === 'Enter') {
                        e.preventDefault()
                        e.stopPropagation()
                        effect.click()
                        closeFilterMenu({ restoreFocus: true })
                        return
                    }
                    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                        e.preventDefault()
                        e.stopPropagation()
                        const offset = e.key === 'ArrowDown' ? 1 : -1
                        effects[(index + offset + effects.length) % effects.length].focus()
                    } else if (e.key === 'ArrowLeft' || e.key === 'Escape') {
                        e.preventDefault()
                        e.stopPropagation()
                        hideSubmenu({ restoreFocus: true })
                    }
                })
            })
        })

        // Close menus on outside click
        document.addEventListener('click', () => {
            closeDropdowns()
            hideSubmenu()
        })

        // Logo menu - Settings
        document.getElementById('settingsMenuItem')?.addEventListener('click', () => {
            settingsDialog.show()
        })

        // Logo menu - About
        document.getElementById('aboutMenuItem')?.addEventListener('click', () => {
            aboutDialog.show()
        })

        // Welcome dialog — re-openable from the logo menu. Tiles route into the
        // existing new-canvas / open-media flows; closing without a choice falls
        // through to the open dialog so the user is never stranded.
        welcomeDialog.init({
            onNewCanvas: ({ entry }) => this._startProjectReplacement(({
                leaveOnline, replacementConsent,
            }) => this._showOpenDialog({
                replaceProject: entry === 'menu' || leaveOnline,
                leaveOnline,
                replacementConsent,
            })),
            onOpenFile: ({ entry }) => this._startProjectReplacement(({
                leaveOnline, replacementConsent,
            }) => this._openMediaFilePicker({
                replaceProject: entry === 'menu' || leaveOnline,
                leaveOnline,
                replacementConsent,
            })),
            onDismiss: () => this._showOpenDialog(),
        })
        document.getElementById('welcomeMenuItem')?.addEventListener('click', () => {
            welcomeDialog.show()
        })

        // File menu - New / Open (both show the same open dialog with reset)
        for (const id of ['newMenuItem', 'openMenuItem']) {
            document.getElementById(id)?.addEventListener('click', () =>
                this._startProjectReplacement(({ leaveOnline, replacementConsent }) =>
                    this._showOpenDialog({
                        replaceProject: true,
                        leaveOnline,
                        replacementConsent,
                    })))
        }

        // File menu - New from Clipboard
        document.getElementById('newFromClipboardMenuItem')?.addEventListener('click', () =>
            this._startProjectReplacement(({ leaveOnline, replacementConsent }) =>
                this._handleNewFromClipboard({ leaveOnline, replacementConsent })))

        // File menu - Save Project (uses Save As if no project ID)
        document.getElementById('saveProjectMenuItem')?.addEventListener('click', () => {
            if (this._currentProjectId) {
                this._runPointerMutation(
                    (mutationToken) => this._quickSaveProject(mutationToken))
            } else {
                this._showSaveProjectDialog()
            }
        })

        // File menu - Save Project As
        document.getElementById('saveProjectAsMenuItem')?.addEventListener('click', () => {
            this._showSaveProjectAsDialog()
        })

        // File menu - Load Project
        document.getElementById('loadProjectMenuItem')?.addEventListener('click', () =>
            this._startProjectReplacement(({ leaveOnline, replacementConsent }) =>
                this._showLoadProjectDialog(false, { leaveOnline, replacementConsent })))

        document.getElementById('savePngMenuItem')?.addEventListener('click', () => {
            this._runPointerMutation(() => this._quickSavePng())
        })

        document.getElementById('saveJpgMenuItem')?.addEventListener('click', () => {
            this._runPointerMutation(() => this._quickSaveJpg())
        })

        // File menu - Export Image
        document.getElementById('exportImageMenuItem')?.addEventListener('click', () => {
            this._runPointerMutation(() => this._exportImageDialog.open())
        })

        // File menu - Export Video
        document.getElementById('exportVideoMenuItem')?.addEventListener('click', () => {
            this._runPointerMutation(async () => this._exportVideoDialog.open())
        })

        // Edit menu - Undo
        document.getElementById('undoMenuItem')?.addEventListener('click', () => {
            this._runPointerMutation(() => this._undo())
        })

        // Edit menu - Redo
        document.getElementById('redoMenuItem')?.addEventListener('click', () => {
            this._runPointerMutation(() => this._redo())
        })

        // Edit menu - Copy Image
        document.getElementById('copyImageMenuItem')?.addEventListener('click', async () => {
            await this._runPointerMutation(() => this._handleCopyImage())
        })

        // Edit menu - Paste Image
        document.getElementById('pasteImageMenuItem')?.addEventListener('click', () => {
            this._runPointerMutation(() => this._handlePaste())
        })

        // Image menu - Crop to selection
        document.getElementById('cropToSelectionMenuItem')?.addEventListener('click', async () => {
            await this._runPointerMutation(() => this._cropToSelection())
        })

        // Image menu - Image size
        document.getElementById('imageSizeMenuItem')?.addEventListener('click', () => {
            this._showImageSizeDialog()
        })

        // Image menu - Canvas size
        document.getElementById('canvasSizeMenuItem')?.addEventListener('click', () => {
            this._showCanvasSizeDialog()
        })

        // Image + Filter menus - Effect items (data-driven)
        for (const menuId of ['imageMenu', 'filterMenu']) {
            document.getElementById(menuId)?.addEventListener('click', (e) => {
                const effectItem = e.target.closest('[data-effect]')
                if (!effectItem) return
                if (this._layers.length === 0) return
                this._runPointerMutation(() =>
                    this._handleAddEffectLayer(effectItem.dataset.effect))
            })
        }

        // Auto correction handlers
        document.getElementById('autoLevelsMenuItem')?.addEventListener('click', () => {
            if (this._layers.length === 0) return
            this._runPointerMutation(() => this._handleAutoCorrection(autoLevels))
        })
        document.getElementById('autoContrastMenuItem')?.addEventListener('click', () => {
            if (this._layers.length === 0) return
            this._runPointerMutation(() => this._handleAutoCorrection(autoContrast))
        })
        document.getElementById('autoWhiteBalanceMenuItem')?.addEventListener('click', () => {
            if (this._layers.length === 0) return
            this._runPointerMutation(() => this._handleAutoCorrection(autoWhiteBalance))
        })

        // Select menu - Select All
        document.getElementById('selectAllMenuItem')?.addEventListener('click', () => {
            this._runPointerMutation(() => {
                const { width, height } = this._canvas
                this._selectionManager.setSelection({
                    type: 'rect', x: 0, y: 0, width, height
                })
            })
        })

        // Select menu - Select None
        document.getElementById('selectNoneMenuItem')?.addEventListener('click', () => {
            this._runPointerMutation(() => this._selectionManager.clearSelection())
        })

        // Select menu - Select Inverse
        document.getElementById('selectInverseMenuItem')?.addEventListener('click', () => {
            this._runPointerMutation(() => {
                const mask = this._selectionManager.rasterizeSelection()
                if (!mask) return
                const inverted = invertMask(mask)
                this._selectionManager.setSelection({ type: 'mask', data: inverted })
            })
        })

        // Select menu - Color Range
        document.getElementById('colorRangeMenuItem')?.addEventListener('click', () => {
            this._runPointerMutation((mutationToken) =>
                this._startColorRangePick(mutationToken))
        })

        // Select menu - Modify operations
        document.getElementById('borderSelectionMenuItem')?.addEventListener('click', () => {
            this._runPointerMutation(() => this._modifySelection(
                { title: 'Border Selection', label: 'Width', defaultValue: 1 }, borderMask))
        })
        document.getElementById('smoothSelectionMenuItem')?.addEventListener('click', () => {
            this._runPointerMutation(() => this._modifySelection(
                { title: 'Smooth Selection', label: 'Radius', defaultValue: 2 }, smoothMask))
        })
        document.getElementById('expandSelectionMenuItem')?.addEventListener('click', () => {
            this._runPointerMutation(() => this._modifySelection(
                { title: 'Expand Selection', label: 'Radius', defaultValue: 1 }, expandMask))
        })
        document.getElementById('contractSelectionMenuItem')?.addEventListener('click', () => {
            this._runPointerMutation(() => this._modifySelection(
                { title: 'Contract Selection', label: 'Radius', defaultValue: 1 }, contractMask))
        })
        document.getElementById('featherSelectionMenuItem')?.addEventListener('click', () => {
            this._runPointerMutation(() => this._modifySelection(
                { title: 'Feather Selection', label: 'Radius', defaultValue: 2 }, featherMask))
        })

        // View menu - Zoom
        document.getElementById('zoomInMenuItem')?.addEventListener('click', () => {
            this._zoomIn()
        })

        document.getElementById('zoomOutMenuItem')?.addEventListener('click', () => {
            this._zoomOut()
        })

        document.getElementById('fitInWindowMenuItem')?.addEventListener('click', () => {
            this._setZoom('fit')
        })

        document.getElementById('zoom50MenuItem')?.addEventListener('click', () => {
            this._setZoom('50')
        })

        document.getElementById('zoom100MenuItem')?.addEventListener('click', () => {
            this._setZoom('100')
        })

        document.getElementById('zoom200MenuItem')?.addEventListener('click', () => {
            this._setZoom('200')
        })

        // Text tool button (toolbar)
        document.getElementById('textToolBtn')?.addEventListener('click', () => {
            if (this._layers.length === 0) return
            this._runPointerMutation(() => this._handleAddEffectLayer('filter/text'))
        })

        // Add layer button
        document.getElementById('addLayerBtn')?.addEventListener('click', () => {
            this._showAddLayerDialog()
        })
        document.getElementById('filterMoreMenuItem')?.addEventListener('click', () => {
            this._showAddLayerDialog()
        })

        // Selection tool split-button
        document.getElementById('selectionToolBtn')?.addEventListener('click', (e) => {
            e.stopPropagation()
            this._setToolMode('selection')
        })

        document.querySelectorAll('#selectionMenu .tool-menu-item[data-shape]').forEach(item => {
            item.addEventListener('click', () => {
                const shape = item.dataset.shape
                this._setSelectionTool(shape)
            })
        })

        // Tolerance slider
        document.getElementById('wandTolerance')?.addEventListener('input', (e) => {
            const value = parseInt(e.target.value, 10)
            if (this._selectionManager) {
                this._selectionManager.wandTolerance = value
            }
            const display = document.getElementById('wandToleranceValue')
            if (display) display.textContent = value
        })

        // Clone tool button
        document.getElementById('cloneToolBtn')?.addEventListener('click', () => {
            this._setToolMode('clone')
        })

        // Move tool button
        document.getElementById('moveToolBtn')?.addEventListener('click', () => {
            this._setToolMode('move')
        })

        // Transform tool button
        document.getElementById('transformToolBtn')?.addEventListener('click', () => {
            this._setToolMode('transform')
        })

        // Drawing tool buttons
        document.getElementById('brushToolBtn')?.addEventListener('click', () => this._setToolMode('brush'))
        document.getElementById('eraserToolBtn')?.addEventListener('click', () => this._setToolMode('eraser'))
        // Shape tool split-button
        document.getElementById('shapeToolBtn')?.addEventListener('click', (e) => {
            e.stopPropagation()
            this._setToolMode('shape')
        })

        document.querySelectorAll('#shapeMenu .tool-menu-item').forEach(item => {
            item.addEventListener('click', (e) => {
                e.stopPropagation()
                const shape = item.dataset.shape
                const filled = item.dataset.filled === 'true'
                if (this._shapeTool) {
                    this._shapeTool.shapeType = shape
                    this._shapeTool.filled = filled
                }
                const btn = document.querySelector('#shapeToolBtn .icon-material')
                if (btn) btn.textContent = item.querySelector('.icon-material')?.textContent || 'crop_square'
                document.querySelectorAll('#shapeMenu .tool-menu-item').forEach(el => {
                    el.classList.toggle('checked', el === item)
                })
                const filledCheckbox = document.getElementById('drawingFilledInput')
                if (filledCheckbox) filledCheckbox.checked = filled
                item.closest('.menu')?.querySelector('.menu-items')?.classList.add('hide')
                this._setToolMode('shape')
            })
        })
        document.getElementById('fillToolBtn')?.addEventListener('click', () => this._setToolMode('fill'))
        document.getElementById('eyedropperToolBtn')?.addEventListener('click', () => this._setToolMode('eyedropper'))

        // Color well input
        document.getElementById('colorWellInput')?.addEventListener('input', (e) => {
            this._setForegroundColor(e.target.value)
        })

        // Drawing options bar inputs
        document.getElementById('drawingSizeInput')?.addEventListener('change', (e) => {
            const size = parseInt(e.target.value, 10)
            if (this._brushTool) this._brushTool.size = size
            if (this._shapeTool) this._shapeTool.size = size
        })

        document.getElementById('drawingOpacityInput')?.addEventListener('input', (e) => {
            const opacity = parseInt(e.target.value, 10) / 100
            if (this._brushTool) this._brushTool.opacity = opacity
            if (this._shapeTool) this._shapeTool.opacity = opacity
            document.getElementById('drawingOpacityValue').textContent = `${e.target.value}%`
        })

        document.getElementById('drawingFilledInput')?.addEventListener('change', (e) => {
            if (this._shapeTool) this._shapeTool.filled = e.target.checked
        })

        document.getElementById('drawingToleranceInput')?.addEventListener('input', (e) => {
            if (this._fillTool) this._fillTool.tolerance = parseInt(e.target.value, 10)
        })

        // Drawing options bar close button
        document.getElementById('drawingOptionsClose')?.addEventListener('click', () => {
            this._setToolMode('selection')
        })

        // Play/pause button
        document.getElementById('playPauseBtn')?.addEventListener('click', () => {
            const mutationToken = this._tryAcquireProjectLifecycle()
            if (!mutationToken) return
            try {
                this._togglePlayPause()
            } finally {
                mutationToken.release()
            }
        })

        // Font install dialog trigger
        document.addEventListener('font-install-request', () => {
            this._showFontInstallDialog()
        })

        // Font bundle changed (e.g., uninstall)
        document.addEventListener('font-bundle-changed', () => {
            this._refreshFontSelects()
        })
    }

    /**
     * Set up Layer menu handlers
     * @private
     */
    _setupLayerMenuHandlers() {
        document.getElementById('layerActionMenuItem')?.addEventListener('click', () => {
            const selectedIds = this._layerStack?.selectedLayerIds || []

            if (selectedIds.length === 0) {
                this._runPointerMutation(() => this._flattenImage())
            } else if (selectedIds.length === 1) {
                const layer = this._layers.find(l => l.id === selectedIds[0])
                if (layer && layer.sourceType !== 'media') {
                    this._runPointerMutation(() => this._rasterizeLayer(selectedIds[0]))
                }
            } else {
                this._runPointerMutation(() => this._flattenLayers(selectedIds))
            }
        })

        document.getElementById('duplicateLayerMenuItem')?.addEventListener('click', () => {
            this._runPointerMutation(() => this._duplicateActiveLayer())
        })

        document.getElementById('deleteLayerMenuItem')?.addEventListener('click', () => {
            const selected = this._layerStack?.getSelectedLayer()
            if (selected && this._layers.indexOf(selected) > 0) {
                this._runPointerMutation(() => this._handleDeleteLayer(selected.id))
            }
        })

        document.getElementById('deselectAllLayersMenuItem')?.addEventListener('click', () => {
            this._deselectAllLayers()
        })

        document.getElementById('flipHMenuItem')?.addEventListener('click', () => {
            this._runPointerMutation(() => this._flipActiveLayer('horizontal'))
        })

        document.getElementById('flipVMenuItem')?.addEventListener('click', () => {
            this._runPointerMutation(() => this._flipActiveLayer('vertical'))
        })

        document.getElementById('addLayerMaskMenuItem')?.addEventListener('click', () => {
            const layer = this._getActiveLayer()
            if (layer && !layer.mask) {
                this._runPointerMutation(() => this._addLayerMask(layer.id))
            }
        })

        document.getElementById('deleteLayerMaskMenuItem')?.addEventListener('click', () => {
            const layer = this._getActiveLayer()
            if (layer?.mask) {
                this._runPointerMutation(() => this._deleteLayerMask(layer.id))
            }
        })
    }

    /**
     * Set up layer stack event handlers
     * @private
     */
    _setupLayerStackHandlers() {
        if (!this._layerStack) return

        this._layerStack.addEventListener('layer-change', (e) => {
            const mutation = this._runPointerMutation(
                () => this._handleLayerChange(e.detail))
            if (!mutation) {
                this._updateLayerStack()
                return
            }
            void mutation.then(
                outcome => {
                    if (outcome === undefined) this._updateLayerStack()
                },
                error => {
                    console.error('[Layers] Layer change failed:', error)
                    this._updateLayerStack()
                })
        })

        this._layerStack.addEventListener('layer-delete', (e) => {
            this._runPointerMutation(() =>
                this._handleDeleteLayer(e.detail.layerId, e.detail.parentLayerId))
        })

        // Layer reorder FSM events
        this._layerStack.addEventListener('layer-drag-start', (e) => {
            this._startDrag(e.detail.layerId)
        })

        this._layerStack.addEventListener('layer-drag-end', (e) => {
            // If we're still in DRAGGING state, this means drop didn't happen
            if (this._reorderState === 'DRAGGING') {
                this._cancelDrag()
            }
        })

        this._layerStack.addEventListener('layer-drop', (e) => {
            void this._processDrop(e.detail.targetId, e.detail.dropPosition)
        })

        this._layerStack.addEventListener('selection-change', () => {
            // When selecting a different layer, exit mask edit mode
            if (this._maskEditMode && this._getActiveLayer()?.id !== this._maskEditLayerId) {
                this._runPointerMutation(() => this._exitMaskEditMode())
            }

            this._updateLayerMenu()
            this._updateToolButtons()
            this._transformTool?.redraw()
            // Switch off move tool if video layer selected
            if (this._currentTool === 'move' && this._getActiveLayer()?.mediaType === 'video') {
                this._setToolMode('selection')
            }
        })

        this._layerStack.addEventListener('child-add', (e) => {
            this._showAddChildEffectDialog(e.detail.layerId)
        })

        // Mask events from layer-item
        this._layerStack?.addEventListener('mask-edit', (e) => {
            const { layerId } = e.detail
            this._runPointerMutation(async () => {
                if (this._maskEditMode && this._maskEditLayerId === layerId) {
                    await this._exitMaskEditMode()
                } else {
                    if (this._maskEditMode) await this._exitMaskEditMode()
                    this._enterMaskEditMode(layerId)
                }
            })
        })

        this._layerStack?.addEventListener('mask-toggle-visible', (e) => {
            this._runPointerMutation(() => {
                const layer = this._layers.find(l => l.id === e.detail.layerId)
                if (!layer?.mask) return
                layer.maskVisible = !layer.maskVisible
                if (layer.maskVisible) {
                    this._renderMaskOverlay(layer)
                } else {
                    document.getElementById('maskOverlay')?.classList.add('hidden')
                }
                this._updateLayerStack()
            })
        })

        this._layerStack?.addEventListener('mask-context-menu', (e) => {
            const { layerId, x, y } = e.detail
            this._showMaskContextMenu(layerId, x, y)
        })

        this._layerStack?.addEventListener('layer-context-menu', (e) => {
            const { layerId, hasMask, x, y } = e.detail
            this._showLayerContextMenu(layerId, hasMask, x, y)
        })
    }

    /**
     * Update the Layer menu item based on current selection
     * @private
     */
    _updateLayerMenu() {
        const menuItem = document.getElementById('layerActionMenuItem')
        if (!menuItem) return

        const selectedIds = this._layerStack?.selectedLayerIds || []

        // Duplicate layer: enabled when exactly one layer selected
        const dupItem = document.getElementById('duplicateLayerMenuItem')
        if (dupItem) {
            dupItem.classList.toggle('disabled', selectedIds.length !== 1)
        }

        // Delete layer: enabled when exactly one non-base layer selected
        const delItem = document.getElementById('deleteLayerMenuItem')
        if (delItem) {
            const canDelete = selectedIds.length === 1 &&
                this._layers.findIndex(l => l.id === selectedIds[0]) > 0
            delItem.classList.toggle('disabled', !canDelete)
        }

        // Flip items: enabled when exactly one media layer selected
        const selectedLayers = selectedIds.map(id => this._layers.find(l => l.id === id)).filter(Boolean)
        const canFlip = selectedIds.length === 1 && selectedLayers[0]?.sourceType === 'media'
        document.getElementById('flipHMenuItem')?.classList.toggle('disabled', !canFlip)
        document.getElementById('flipVMenuItem')?.classList.toggle('disabled', !canFlip)

        // Mask items: enabled based on active layer mask state
        const activeLayer = selectedIds.length === 1 ? selectedLayers[0] : null
        const addMaskItem = document.getElementById('addLayerMaskMenuItem')
        const deleteMaskItem = document.getElementById('deleteLayerMaskMenuItem')
        if (addMaskItem) addMaskItem.classList.toggle('disabled', !activeLayer || !!activeLayer.mask)
        if (deleteMaskItem) deleteMaskItem.classList.toggle('disabled', !activeLayer?.mask)

        if (selectedIds.length === 0) {
            // No selection: flatten image
            menuItem.textContent = 'flatten image'
            menuItem.classList.remove('disabled')
        } else if (selectedIds.length === 1) {
            // Single layer selected
            const layer = selectedLayers[0]
            menuItem.textContent = 'rasterize layer'
            if (layer?.sourceType === 'media') {
                menuItem.classList.add('disabled')
            } else {
                menuItem.classList.remove('disabled')
            }
        } else {
            // Multiple layers selected
            menuItem.textContent = 'flatten layers'
            menuItem.classList.remove('disabled')
        }
    }

    /**
     * Flatten entire image to a single layer
     * Renders all visible layers, discards hidden layers
     * @private
     */
    async _flattenImage() {
        if (this._blockedMediaOnline('Flattening')) return { status: 'failed' }
        if (this._layers.length === 0) return { status: 'committed' }

        // Capture current canvas (all visible layers composited)
        this._renderCurrentFrame()
        const offscreen = new OffscreenCanvas(this._canvas.width, this._canvas.height)
        const ctx = offscreen.getContext('2d')
        ctx.drawImage(this._canvas, 0, 0)

        // Convert to blob and create media layer
        const blob = await offscreen.convertToBlob({ type: 'image/png' })
        const file = new File([blob], 'flattened-image.png', { type: 'image/png' })

        const newLayer = createMediaLayer(file, 'image', this._currentProjectName || 'flattened image')
        let resource
        try {
            resource = await this._renderer.prepareMediaResource(file, 'image')
            const candidate = await this._prepareLayerSetCandidate(
                [newLayer], this._canvas.width, this._canvas.height, {
                    mediaOverrides: new Map([[newLayer.id, resource]]),
                })
            const outcome = await this._commitPreparedLayerMutation(candidate, {
                selectedLayerIds: [newLayer.id],
                selectionAnchor: newLayer.id,
            })
            if (outcome.status !== 'committed') return outcome
        } catch (err) {
            return { status: 'failed', error: err }
        }
        try {
            toast.success('Image flattened')
        } catch (err) {
            console.error('[Layers] Failed to show flatten confirmation:', err)
        }
        return { status: 'committed' }
    }

    /**
     * Rasterize a single effect layer to media (user-facing with undo and toast)
     * @param {string} layerId
     * @private
     */
    async _rasterizeLayer(layerId) {
        if (this._blockedMediaOnline('Rasterizing')) return { status: 'failed' }
        const layer = this._layers.find(l => l.id === layerId)
        if (!layer || layer.sourceType === 'media') return { status: 'committed' }
        const composite = await this._renderLayerComposite([layerId], {
            selectedLayerOverrides: {
                visible: true,
                opacity: 100,
                blendMode: 'mix',
            },
        })
        if (!composite) return { status: 'failed' }
        const offscreen = new OffscreenCanvas(this._canvas.width, this._canvas.height)
        offscreen.getContext('2d').drawImage(composite, 0, 0)
        const blob = await offscreen.convertToBlob({ type: 'image/png' })
        const file = new File([blob], 'rasterized.png', { type: 'image/png' })
        const newLayer = createMediaLayer(file, 'image', `${layer.name} (rasterized)`)
        newLayer.id = layer.id
        newLayer.visible = layer.visible
        newLayer.opacity = layer.opacity
        newLayer.blendMode = layer.blendMode
        const layers = [...this._layers]
        layers[layers.indexOf(layer)] = newLayer
        let resource
        try {
            resource = await this._renderer.prepareMediaResource(file, 'image')
            const candidate = await this._prepareLayerSetCandidate(
                layers, this._canvas.width, this._canvas.height, {
                    reuseMediaIds: new Set(this._renderer._mediaTextures.keys()),
                    reuseMaskIds: new Set(this._renderer._maskTextures.keys()),
                    mediaOverrides: new Map([[newLayer.id, resource]]),
                })
            const outcome = await this._commitPreparedLayerMutation(candidate, {
                selectedLayerIds: [newLayer.id],
                selectionAnchor: newLayer.id,
            })
            if (outcome.status !== 'committed') return outcome
        } catch (err) {
            return { status: 'failed', error: err }
        }
        try {
            toast.success('Layer rasterized')
        } catch (err) {
            console.error('[Layers] Failed to show rasterize confirmation:', err)
        }
        return { status: 'committed' }
    }

    /**
     * Flatten multiple selected layers into one
     * @param {Array<string>} layerIds
     * @private
     */
    async _flattenLayers(layerIds) {
        if (this._blockedMediaOnline('Flattening')) return { status: 'failed' }
        if (layerIds.length < 2) return { status: 'committed' }

        // Find the layers and their indices
        const selectedLayers = layerIds
            .map(id => ({ layer: this._layers.find(l => l.id === id), index: this._layers.findIndex(l => l.id === id) }))
            .filter(item => item.layer && item.index !== -1)
            .sort((a, b) => a.index - b.index)

        if (selectedLayers.length < 2) return { status: 'committed' }

        // Find topmost selected layer index (highest index = top of stack)
        const topmostIndex = Math.max(...selectedLayers.map(item => item.index))

        const composite = await this._renderLayerComposite(layerIds)
        if (!composite) return { status: 'failed' }
        const offscreen = new OffscreenCanvas(this._canvas.width, this._canvas.height)
        const ctx = offscreen.getContext('2d')
        ctx.drawImage(composite, 0, 0)

        const blob = await offscreen.convertToBlob({ type: 'image/png' })
        const file = new File([blob], 'flattened.png', { type: 'image/png' })

        const newLayer = createMediaLayer(file, 'image', 'flattened')

        const layers = [...this._layers]
        const indicesToRemove = selectedLayers.map(item => item.index).sort((a, b) => b - a)
        for (const idx of indicesToRemove) {
            layers.splice(idx, 1)
        }

        // Insert new layer at topmost position (adjusted for removed layers above it)
        const removedAboveTopmost = indicesToRemove.filter(idx => idx < topmostIndex).length
        const insertIndex = topmostIndex - removedAboveTopmost
        layers.splice(insertIndex, 0, newLayer)
        let resource
        try {
            resource = await this._renderer.prepareMediaResource(file, 'image')
            const candidate = await this._prepareLayerSetCandidate(
                layers, this._canvas.width, this._canvas.height, {
                    reuseMediaIds: new Set(this._renderer._mediaTextures.keys()),
                    reuseMaskIds: new Set(this._renderer._maskTextures.keys()),
                    mediaOverrides: new Map([[newLayer.id, resource]]),
                })
            const outcome = await this._commitPreparedLayerMutation(candidate, {
                selectedLayerIds: [newLayer.id],
                selectionAnchor: newLayer.id,
            })
            if (outcome.status !== 'committed') return outcome
        } catch (err) {
            return { status: 'failed', error: err }
        }
        try {
            toast.success('Layers flattened')
        } catch (err) {
            console.error('[Layers] Failed to show flatten confirmation:', err)
        }
        return { status: 'committed' }
    }

    /**
     * Set up keyboard shortcuts
     * @private
     */
    _setupKeyboardShortcuts() {
        document.addEventListener('keydown', (e) => {
            // A reorder drag owns the lifecycle lease it must release, so its
            // cancellation shortcut has to run before the general mutation
            // guard below.
            if (e.key === 'Escape' && this._reorderState === 'DRAGGING') {
                e.preventDefault()
                this._cancelDrag()
                return
            }

            if (this._projectLifecycleActive || this._projectReplacementActive) return

            // ESC - close context menus
            if (e.key === 'Escape' && this._contextMenuCloseHandler) {
                this._closeContextMenus()
                return
            }

            // ESC - exit mask edit mode
            if (e.key === 'Escape' && this._maskEditMode) {
                this._runPointerMutation(() => this._exitMaskEditMode())
                return
            }

            // Ctrl/Cmd+S - save project (allow in inputs)
            if ((e.ctrlKey || e.metaKey) && e.key === 's') {
                e.preventDefault()
                this._showSaveProjectDialog()
                return
            }

            // Cmd/Ctrl+Shift+Z - redo (check before undo since Shift+Z matches both)
            if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'z') {
                e.preventDefault()
                this._runPointerMutation(() => this._redo())
                return
            }

            // Cmd/Ctrl+Shift+I - inverse selection
            if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'i' || e.key === 'I')) {
                e.preventDefault()
                if (this._selectionManager?.hasSelection()) {
                    const mask = this._selectionManager.rasterizeSelection()
                    if (mask) {
                        this._selectionManager.setSelection({ type: 'mask', data: invertMask(mask) })
                    }
                }
                return
            }

            // Cmd/Ctrl+A - select all
            if ((e.ctrlKey || e.metaKey) && !e.shiftKey && (e.key === 'a' || e.key === 'A')) {
                e.preventDefault()
                const { width, height } = this._canvas
                this._selectionManager.setSelection({
                    type: 'rect', x: 0, y: 0, width, height
                })
                return
            }

            // Cmd/Ctrl+Z - undo
            if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key === 'z') {
                e.preventDefault()
                this._runPointerMutation(() => this._undo())
                return
            }

            // Cmd+C - copy selection
            if ((e.ctrlKey || e.metaKey) && e.key === 'c') {
                if (this._selectionManager?.hasSelection()) {
                    e.preventDefault()
                    this._runPointerMutation(() => this._handleCopy())
                    return
                }
            }

            // Cmd+V - paste
            if ((e.ctrlKey || e.metaKey) && e.key === 'v') {
                e.preventDefault()
                this._runPointerMutation(() => this._handlePaste())
                return
            }

            // Don't handle other shortcuts if in input
            if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.contentEditable === 'true') {
                return
            }

            // Delete key - delete selected layer
            if (e.key === 'Delete' || e.key === 'Backspace') {
                const selected = this._layerStack?.getSelectedLayer()
                if (selected && this._layers.indexOf(selected) > 0) {
                    e.preventDefault()
                    this._runPointerMutation(() => this._handleDeleteLayer(selected.id))
                }
            }

            // Space - toggle play/pause
            if (e.key === ' ') {
                e.preventDefault()
                this._togglePlayPause()
            }

            // T - transform tool
            if (e.key === 't' || e.key === 'T') {
                this._setToolMode('transform')
            }

            // Drawing tool shortcuts
            if (e.key === 'b' || e.key === 'B') {
                this._setToolMode('brush')
            }
            if (e.key === 'e' || e.key === 'E') {
                this._setToolMode('eraser')
            }
            if (e.key === 'u' || e.key === 'U') {
                this._setToolMode('shape')
            }
            if (e.key === 'g' || e.key === 'G') {
                this._setToolMode('fill')
            }
            if (e.key === 'i' || e.key === 'I') {
                this._setToolMode('eyedropper')
            }

            // Brush size shortcuts
            if (e.key === '[') {
                if (this._brushTool) {
                    this._brushTool.size -= 5
                    const input = document.getElementById('drawingSizeInput')
                    if (input) input.value = this._brushTool.size
                }
                if (this._shapeTool) this._shapeTool.size -= 5
            }
            if (e.key === ']') {
                if (this._brushTool) {
                    this._brushTool.size += 5
                    const input = document.getElementById('drawingSizeInput')
                    if (input) input.value = this._brushTool.size
                }
                if (this._shapeTool) this._shapeTool.size += 5
            }

            // V - toggle visibility of selected layer
            if (e.key === 'v' || e.key === 'V') {
                const selected = this._layerStack?.getSelectedLayer()
                if (selected) {
                    this._runPointerMutation(() => this._handleLayerChange({
                        layerId: selected.id,
                        property: 'visibility',
                        value: !selected.visible,
                        updateLayerStack: true,
                    }))
                }
            }

            // Escape - clear selection
            if (e.key === 'Escape') {
                if (this._selectionManager?.hasSelection()) {
                    e.preventDefault()
                    this._selectionManager.clearSelection()
                }
            }

            // Cmd/Ctrl+D - deselect
            if ((e.ctrlKey || e.metaKey) && e.key === 'd') {
                if (this._selectionManager?.hasSelection()) {
                    e.preventDefault()
                    this._selectionManager.clearSelection()
                }
            }
        })
    }

    /**
     * Show the add layer dialog
     * @private
     */
    _showAddLayerDialog() {
        if (this._projectLifecycleActive || this._projectReplacementActive
            || this._projectLifecycleWaiters > 0) return
        const generation = this._replacementGeneration
        addLayerDialog.show({
            effects: this._renderer.getLayerEffects(),
            onAddMedia: async (file, mediaType) => {
                await this._runPointerMutation((mutationToken) =>
                    this._handleAddMediaLayer(file, mediaType, { mutationToken }), { generation })
            },
            onAddEffect: async (effectId) => {
                await this._runPointerMutation(
                    () => this._handleAddEffectLayer(effectId), { generation })
            }
        })
    }

    /**
     * Show effect picker for adding a child effect to a layer
     * @param {string} parentLayerId - Parent layer ID
     * @private
     */
    _showAddChildEffectDialog(parentLayerId) {
        if (this._projectLifecycleActive || this._projectReplacementActive
            || this._projectLifecycleWaiters > 0) return
        const generation = this._replacementGeneration
        addLayerDialog.showEffectOnly({
            effects: this._renderer.getLayerEffects(),
            onAddEffect: async (effectId) => {
                await this._runPointerMutation(() =>
                    this._handleAddChildEffect(parentLayerId, effectId), { generation })
            }
        })
    }

    /**
     * Toggle play/pause
     * @private
     */
    _togglePlayPause() {
        const icon = document.querySelector('#playPauseBtn .icon-material')
        if (this._renderer.isRunning) {
            this._renderer.stop()
            if (icon) icon.textContent = 'play_arrow'
        } else {
            this._renderer.start()
            if (icon) icon.textContent = 'pause'
        }
    }

    /**
     * Set the current selection tool
     * @param {'rectangle' | 'oval' | 'lasso' | 'polygon' | 'wand'} tool
     * @private
     */
    _setSelectionTool(tool) {
        // Deactivate move tool when selecting a selection tool
        this._setToolMode('selection')

        if (!this._selectionManager) return

        this._selectionManager.currentTool = tool

        // Update menu checkmarks via data-shape attributes
        document.querySelectorAll('#selectionMenu .tool-menu-item[data-shape]').forEach(el => {
            el.classList.toggle('checked', el.dataset.shape === tool)
        })

        // Update toolbar icon — swap SVG content based on tool
        const iconContainer = document.getElementById('selectionToolIcon')
        if (iconContainer) {
            const svgAttrs = 'class="selection-icon" width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1" stroke-dasharray="1 2" stroke-linecap="round"'
            const icons = {
                rectangle: `<svg ${svgAttrs}><rect x="2" y="4" width="16" height="12"/></svg>`,
                oval: `<svg ${svgAttrs}><ellipse cx="10" cy="10" rx="8" ry="6"/></svg>`,
                lasso: `<svg class="selection-icon" width="20" height="20" viewBox="0 0 1280 1280" fill="none" stroke="currentColor" stroke-width="64" stroke-dasharray="64 128" stroke-linecap="round"><path transform="translate(0,1280) scale(1,-1)" d="M854 1221 c-21 -15 -48 -38 -58 -50 -24 -26 -51 -27 -107 -1 -62 28 -120 26 -148 -4 -21 -22 -22 -30 -16 -102 6 -73 5 -82 -17 -114 -30 -44 -68 -50 -134 -20 -72 33 -104 35 -137 10 -87 -69 -65 -144 60 -201 100 -45 115 -92 52 -163 -24 -27 -40 -36 -77 -41 -67 -9 -100 -24 -122 -55 -44 -62 -30 -134 37 -189 42 -35 75 -39 139 -17 47 17 201 31 237 22 13 -3 36 -23 51 -44 22 -32 26 -49 26 -104 0 -51 5 -71 21 -92 57 -73 267 13 330 135 30 59 26 140 -11 218 l-31 64 23 25 c20 21 29 23 71 18 42 -4 51 -2 79 23 26 23 32 36 35 82 5 63 -18 117 -57 136 -14 7 -48 13 -77 13 -43 0 -55 4 -71 25 -33 42 -10 90 61 126 55 29 63 53 48 151 -7 45 -19 94 -27 109 -37 73 -113 90 -180 40z"/></svg>`,
                polygon: `<svg ${svgAttrs}><polygon points="10,2 18,8 15,18 5,18 2,8"/></svg>`,
                wand: '<span class="icon-material">auto_fix_high</span>'
            }
            const newIcon = icons[tool] || icons.rectangle
            iconContainer.outerHTML = newIcon.replace(/^<(svg|span) /, `<$1 id="selectionToolIcon" `)
        }

        // Show/hide tolerance slider
        const toleranceRow = document.getElementById('wandToleranceRow')
        if (toleranceRow) {
            toleranceRow.classList.toggle('hide', tool !== 'wand')
        }
    }

    /**
     * Get the currently active (selected) layer
     * @returns {object|null}
     * @private
     */
    _getActiveLayer() {
        const selectedIds = this._layerStack?.selectedLayerIds || []
        if (selectedIds.length !== 1) return null
        return this._layers.find(l => l.id === selectedIds[0]) || null
    }

    /**
     * Select the topmost layer
     * @private
     */
    _selectTopmostLayer() {
        if (this._layers.length > 0 && this._layerStack) {
            const topLayer = this._layers[this._layers.length - 1]
            this._layerStack.selectedLayerId = topLayer.id
        }
    }

    /**
     * Show dialog when no layer is selected
     * @private
     */
    _showNoLayerSelectedDialog() {
        infoDialog.show({ message: 'No layers are currently selected.' })
    }

    /**
     * Deselect all layers
     * @private
     */
    _deselectAllLayers() {
        if (this._layerStack) {
            this._layerStack.selectedLayerIds = []
        }
    }

    /**
     * Duplicate the active layer
     * @returns {Promise<boolean>} True if successful
     * @private
     */
    async _duplicateActiveLayer(layer = null, shouldCancel = null) {
        // Gated unconditionally (not just for an already-media active layer):
        // this always rasterizes the active layer's composite into a NEW
        // media layer below, regardless of the source layer's own
        // sourceType — an effect or drawing layer duplicate is media too.
        if (this._blockedMediaOnline('Duplicating')) return false
        layer ||= this._getActiveLayer()
        if (!layer) return false

        const canvasWidth = this._canvas.width
        const canvasHeight = this._canvas.height

        // Render the layer to get its pixels
        const compositeImg = await this._renderLayerComposite([layer.id])
        if (!compositeImg) return false

        // Create new layer with the pixels
        const offscreen = new OffscreenCanvas(canvasWidth, canvasHeight)
        const ctx = offscreen.getContext('2d')
        ctx.drawImage(compositeImg, 0, 0)

        const blob = await offscreen.convertToBlob({ type: 'image/png' })
        const file = new File([blob], 'duplicated.png', { type: 'image/png' })

        const newLayer = createMediaLayer(file, 'image', `${layer.name} copy`)
        const layerIndex = this._layers.findIndex(l => l.id === layer.id)
        const layers = [...this._layers]
        layers.splice(layerIndex + 1, 0, newLayer)
        let resource
        try {
            resource = await this._renderer.prepareMediaResource(file, 'image')
            const candidate = await this._prepareLayerSetCandidate(
                layers, canvasWidth, canvasHeight, {
                    reuseMediaIds: new Set(this._renderer._mediaTextures.keys()),
                    reuseMaskIds: new Set(this._renderer._maskTextures.keys()),
                    mediaOverrides: new Map([[newLayer.id, resource]]),
                })
            const outcome = await this._commitPreparedLayerMutation(candidate, {
                selectedLayerIds: [newLayer.id],
                selectionAnchor: newLayer.id,
                shouldCancel,
                value: newLayer.id,
            })
            return outcome.status === 'committed'
        } catch (err) {
            return false
        }
    }

    /**
     * Called after clone tool completes - switch to selection and create marquee
     * @private
     */
    _onCloneComplete() {
        this._updateImageMenu()
        this._updateSelectMenu()

        // Switch to selection tool — leave the selection untouched
        this._setToolMode('selection')
    }

    /**
     * Update active layer's position.
     * Text layers use normalized 0-1 coords (posX/posY in effectParams).
     * Media layers use pixel offsets (offsetX/offsetY).
     * @param {number} x - position in canvas pixels
     * @param {number} y - position in canvas pixels
     * @private
     */
    _updateActiveLayerPosition(x, y) {
        const layer = this._getActiveLayer()
        if (!layer) return

        if (layer.effectId === 'filter/text') {
            const previousParams = layer.effectParams
            const posX = Math.max(0, Math.min(1, x / this._canvas.width))
            const posY = Math.max(0, Math.min(1, y / this._canvas.height))
            layer.effectParams = { ...layer.effectParams, posX, posY }
            try {
                this._renderer.updateTextParams(layer.id, layer.effectParams)
            } catch (err) {
                layer.effectParams = previousParams
                try {
                    this._renderer.updateTextParams(layer.id, previousParams)
                } catch (restoreError) {
                    throw new Error(
                        `${err.message}; failed to restore text position: ${restoreError.message}`)
                }
                throw err
            }
        } else {
            const hadOffsetX = Object.hasOwn(layer, 'offsetX')
            const hadOffsetY = Object.hasOwn(layer, 'offsetY')
            const previousOffsetX = layer.offsetX
            const previousOffsetY = layer.offsetY
            layer.offsetX = Math.round(x)
            layer.offsetY = Math.round(y)
            try {
                this._renderer.updateLayerOffset(layer.id, layer.offsetX, layer.offsetY)
            } catch (err) {
                if (hadOffsetX) layer.offsetX = previousOffsetX
                else delete layer.offsetX
                if (hadOffsetY) layer.offsetY = previousOffsetY
                else delete layer.offsetY
                try {
                    this._renderer.updateLayerOffset(
                        layer.id, previousOffsetX || 0, previousOffsetY || 0)
                } catch (restoreError) {
                    throw new Error(
                        `${err.message}; failed to restore layer position: ${restoreError.message}`)
                }
                throw err
            }
        }

        this._markDirty()
        this._pushUndoStateDebounced()
    }

    /** @private */
    _restoreActiveLayerPosition(x, y, mutationState) {
        const layer = this._getActiveLayer()
        if (!layer) return
        const exactPosition = mutationState?.activeLayerPosition?.layerId === layer.id
            ? mutationState.activeLayerPosition
            : null
        try {
            if (layer.effectId === 'filter/text') {
                layer.effectParams = exactPosition
                    ? exactPosition.effectParams
                    : {
                        ...layer.effectParams,
                        posX: Math.max(0, Math.min(1, x / this._canvas.width)),
                        posY: Math.max(0, Math.min(1, y / this._canvas.height)),
                    }
                this._renderer.updateTextParams(layer.id, layer.effectParams)
            } else {
                if (exactPosition) {
                    if (exactPosition.hadOffsetX) layer.offsetX = exactPosition.offsetX
                    else delete layer.offsetX
                    if (exactPosition.hadOffsetY) layer.offsetY = exactPosition.offsetY
                    else delete layer.offsetY
                } else {
                    layer.offsetX = Math.round(x)
                    layer.offsetY = Math.round(y)
                }
                this._renderer.updateLayerOffset(
                    layer.id, layer.offsetX || 0, layer.offsetY || 0)
            }
        } finally {
            this._restorePointerGestureMutationState(mutationState)
        }
    }

    /**
     * Get bounding box for a layer in canvas coordinates
     * @param {object} layer - Layer object
     * @returns {{x: number, y: number, width: number, height: number, rotation: number}|null}
     * @private
     */
    _getLayerBounds(layer) {
        if (!layer) return null

        const mediaInfo = this._renderer?.getMediaInfo(layer.id)
        const sourceWidth = mediaInfo?.width || this._canvas.width
        const sourceHeight = mediaInfo?.height || this._canvas.height

        const scaleX = layer.scaleX ?? 1
        const scaleY = layer.scaleY ?? 1
        const rotation = layer.rotation ?? 0
        const offsetX = layer.offsetX || 0
        const offsetY = layer.offsetY || 0

        const w = sourceWidth * Math.abs(scaleX)
        const h = sourceHeight * Math.abs(scaleY)

        // Offset is center-relative: (0,0) = centered on canvas
        const x = this._canvas.width / 2 + offsetX - w / 2
        const y = this._canvas.height / 2 + offsetY - h / 2

        return { x, y, width: w, height: h, rotation }
    }

    /** @private */
    _validateLayerTransformAllocation(layer, values = {}) {
        if (!layer || (layer.sourceType !== 'media' && layer.sourceType !== 'drawing')) {
            return { valid: false, error: 'Layer has no transformable raster source' }
        }
        const media = this._renderer?.getMediaInfo(layer.id)
        const sourceWidth = media?.width
            ?? (layer.sourceType === 'drawing' ? this._canvas.width : 0)
        const sourceHeight = media?.height
            ?? (layer.sourceType === 'drawing' ? this._canvas.height : 0)
        const scaleX = values.scaleX ?? layer.scaleX ?? 1
        const scaleY = values.scaleY ?? layer.scaleY ?? 1
        if (!Number.isFinite(scaleX) || scaleX === 0
            || !Number.isFinite(scaleY) || scaleY === 0
            || !Number.isSafeInteger(sourceWidth) || sourceWidth < 1
            || !Number.isSafeInteger(sourceHeight) || sourceHeight < 1) {
            return { valid: false, error: 'Transform dimensions are invalid' }
        }
        const width = Math.ceil(sourceWidth * Math.abs(scaleX))
        const height = Math.ceil(sourceHeight * Math.abs(scaleY))
        const maxPixels = MAX_CANVAS_DIMENSION * MAX_CANVAS_DIMENSION
        if (!Number.isSafeInteger(width) || width < 1 || width > MAX_CANVAS_DIMENSION
            || !Number.isSafeInteger(height) || height < 1
            || height > MAX_CANVAS_DIMENSION
            || width * height > maxPixels) {
            return {
                valid: false,
                error: `Transformed raster must fit within ${MAX_CANVAS_DIMENSION} x ${MAX_CANVAS_DIMENSION}`,
            }
        }
        return { valid: true, width, height }
    }

    /**
     * Apply transform values to the active layer during drag (debounced undo)
     * @param {object} values - Transform values to apply
     * @private
     */
    _applyLayerTransform(values) {
        const layer = this._getActiveLayer()
        if (!layer || (layer.sourceType !== 'media' && layer.sourceType !== 'drawing')) return
        const allocation = this._validateLayerTransformAllocation(layer, values)
        if (!allocation.valid) {
            toast.warning(allocation.error)
            return
        }

        const keys = ['offsetX', 'offsetY', 'scaleX', 'scaleY', 'rotation']
        const previous = Object.fromEntries(keys.map(key => [key, {
            had: Object.hasOwn(layer, key),
            value: layer[key],
        }]))
        if (values.offsetX !== undefined) layer.offsetX = Math.round(values.offsetX)
        if (values.offsetY !== undefined) layer.offsetY = Math.round(values.offsetY)
        if (values.scaleX !== undefined) layer.scaleX = values.scaleX
        if (values.scaleY !== undefined) layer.scaleY = values.scaleY
        if (values.rotation !== undefined) layer.rotation = values.rotation

        try {
            this._updateTransformRender(layer)
        } catch (err) {
            for (const key of keys) {
                if (previous[key].had) layer[key] = previous[key].value
                else delete layer[key]
            }
            try {
                this._updateTransformRender(layer, { strict: true })
            } catch (restoreError) {
                throw new Error(
                    `${err.message}; failed to restore layer transform: ${restoreError.message}`)
            }
            throw err
        }
        this._markDirty()
        this._pushUndoStateDebounced()
    }

    /**
     * Commit current transform and switch to selection tool
     * @private
     */
    _commitTransform() {
        this._finalizePendingUndo()
        this._setToolMode('selection')
    }

    /**
     * Cancel transform and switch to selection tool
     * @private
     */
    _cancelTransform(startTransform = null, mutationState = null) {
        const layer = this._getActiveLayer()
        try {
            if (layer && startTransform) {
                Object.assign(layer, startTransform)
                this._updateTransformRender(layer, { strict: true })
            }
        } finally {
            this._restorePointerGestureMutationState(mutationState)
            this._setToolMode('selection')
        }
    }

    /**
     * Update renderer for transform changes via CPU-side offscreen canvas
     * @param {object} layer
     * @param {{strict?: boolean}} options
     * @private
     */
    _updateTransformRender(layer, { strict = false } = {}) {
        if (layer.sourceType !== 'media' && layer.sourceType !== 'drawing') return
        const transform = {
            scaleX: layer.scaleX ?? 1,
            scaleY: layer.scaleY ?? 1,
            rotation: layer.rotation ?? 0,
            flipH: layer.flipH || false,
            flipV: layer.flipV || false
        }
        this._renderer?.updateLayerTransform(
            layer.id, transform, layer.offsetX || 0, layer.offsetY || 0, { strict })
    }

    /**
     * Flip the active layer horizontally or vertically
     * @param {'horizontal'|'vertical'} direction
     * @private
     */
    async _flipActiveLayer(direction, layer = this._getActiveLayer()) {
        if (!layer || layer.sourceType !== 'media') {
            toast.warning('Select a media layer to flip')
            return
        }

        return this._commitModelMutation(() => {
            if (direction === 'horizontal') {
                layer.flipH = !layer.flipH
            } else {
                layer.flipV = !layer.flipV
            }
        }, {
            render: () => {
                this._updateTransformRender(layer, { strict: true })
                return { success: true }
            },
            restore: () => this._updateTransformRender(layer),
        })
    }

    /**
     * Extract current selection to a new layer
     * @param {boolean} destructive - If true, modify originals (punch holes/flatten). If false, just clone.
     * @private
     */
    async _extractSelectionToLayer(destructive = true, shouldCancel = null) {
        if (!this._selectionManager?.hasSelection()) {
            console.warn('[Extract] No selection')
            return false
        }

        const selectedIds = this._layerStack?.selectedLayerIds || []
        if (selectedIds.length === 0) {
            console.warn('[Extract] No layers selected')
            return false
        }

        this._finalizePendingUndo()

        const selectedLayers = selectedIds
            .map(id => this._layers.find(l => l.id === id))
            .filter(Boolean)

        if (selectedLayers.length === 1) {
            return this._extractFromSingleLayer(
                selectedLayers[0], destructive, shouldCancel)
        }
        return this._extractFromMultipleLayers(
            selectedIds, destructive, shouldCancel)
    }

    /**
     * Clamp selection bounds to canvas dimensions
     * @returns {object|null} Clamped bounds, or null if empty
     * @private
     */
    _clampBounds(bounds) {
        if (bounds.width <= 0 || bounds.height <= 0) return null

        const clamped = {
            x: Math.max(0, Math.floor(bounds.x)),
            y: Math.max(0, Math.floor(bounds.y)),
            width: Math.ceil(bounds.width),
            height: Math.ceil(bounds.height)
        }
        clamped.width = Math.min(clamped.width, this._canvas.width - clamped.x)
        clamped.height = Math.min(clamped.height, this._canvas.height - clamped.y)
        if (clamped.width <= 0 || clamped.height <= 0) return null

        return clamped
    }

    /**
     * Check whether an image region contains any non-transparent pixels
     * @private
     */
    _hasVisiblePixels(ctx, bounds) {
        const data = ctx.getImageData(bounds.x, bounds.y, bounds.width, bounds.height).data
        for (let i = 3; i < data.length; i += 4) {
            if (data[i] > 0) return true
        }
        return false
    }

    /**
     * Extract selection from a single layer
     * @param {object} layer - The layer to extract from
     * @param {boolean} punchHole - Whether to punch hole in original
     * @private
     */
    async _extractFromSingleLayer(layer, punchHole, shouldCancel = null) {
        if (this._blockedMediaOnline('Extracting the selection')) return false
        const selectionPath = this._selectionManager.selectionPath
        const canvasWidth = this._canvas.width
        const canvasHeight = this._canvas.height

        const extractBounds = this._clampBounds(getSelectionBounds(selectionPath))
        if (!extractBounds) return false

        // Create selection mask
        const maskCanvas = new OffscreenCanvas(canvasWidth, canvasHeight)
        const maskCtx = maskCanvas.getContext('2d')
        this._drawSelectionMask(maskCtx, selectionPath)

        // Render the layer through the shader to capture what the user sees,
        // correctly handling media scaling, positioning, rotation, etc.
        const sourceImg = await this._renderLayerComposite([layer.id])
        if (!sourceImg) return false

        // Create extracted pixels canvas
        const extractedCanvas = new OffscreenCanvas(canvasWidth, canvasHeight)
        const extractedCtx = extractedCanvas.getContext('2d')
        extractedCtx.drawImage(sourceImg, 0, 0)
        extractedCtx.globalCompositeOperation = 'destination-in'
        extractedCtx.drawImage(maskCanvas, 0, 0)
        extractedCtx.globalCompositeOperation = 'source-over'

        if (!this._hasVisiblePixels(extractedCtx, extractBounds)) {
            toast.warning('no pixels selected')
            return false
        }

        const layers = [...this._layers]
        const layerIndex = layers.findIndex(candidate => candidate.id === layer.id)
        const mediaOverrides = new Map()
        const preparedResources = []

        // Punch hole in source if requested
        if (punchHole) {
            const punchedCanvas = new OffscreenCanvas(canvasWidth, canvasHeight)
            const punchedCtx = punchedCanvas.getContext('2d')
            punchedCtx.drawImage(sourceImg, 0, 0)
            punchedCtx.globalCompositeOperation = 'destination-out'
            punchedCtx.drawImage(maskCanvas, 0, 0)
            punchedCtx.globalCompositeOperation = 'source-over'

            const punchedBlob = await punchedCanvas.convertToBlob({ type: 'image/png' })
            const punchedFile = new File([punchedBlob], layer.mediaFile?.name || 'layer.png', { type: 'image/png' })

            const punchedLayer = {
                ...layer,
                sourceType: 'media',
                mediaFile: punchedFile,
                mediaType: 'image',
                effectId: null,
                effectParams: {},
                offsetX: 0,
                offsetY: 0,
            }
            layers[layerIndex] = punchedLayer
            try {
                const resource = await this._renderer.prepareMediaResource(
                    punchedFile, 'image')
                preparedResources.push(resource)
                mediaOverrides.set(punchedLayer.id, resource)
            } catch (err) {
                return false
            }
        }

        // Create new layer with extracted pixels
        let newLayer
        try {
            const extractedBlob = await extractedCanvas.convertToBlob({ type: 'image/png' })
            const extractedFile = new File(
                [extractedBlob], 'moved-selection.png', { type: 'image/png' })
            newLayer = createMediaLayer(extractedFile, 'image', 'moved selection')
            layers.splice(layerIndex + 1, 0, newLayer)
            const resource = await this._renderer.prepareMediaResource(
                extractedFile, 'image')
            preparedResources.push(resource)
            mediaOverrides.set(newLayer.id, resource)
        } catch (err) {
            for (const resource of preparedResources) {
                this._renderer.disposeMediaResource(resource)
            }
            return false
        }
        try {
            const candidate = await this._prepareLayerSetCandidate(
                layers, canvasWidth, canvasHeight, {
                    reuseMediaIds: new Set(this._renderer._mediaTextures.keys()),
                    reuseMaskIds: new Set(this._renderer._maskTextures.keys()),
                    mediaOverrides,
                })
            const outcome = await this._commitPreparedLayerMutation(candidate, {
                selectedLayerIds: [newLayer.id],
                selectionAnchor: newLayer.id,
                selectionPath: punchHole ? null : selectionPath,
                shouldCancel,
            })
            return outcome.status === 'committed'
        } catch (err) {
            return false
        }
    }

    /**
     * Extract selection from multiple layers
     * @param {string[]} layerIds - The layer IDs to extract from
     * @param {boolean} punchHole - Whether to flatten and punch (true) or just clone (false)
     * @private
     */
    async _extractFromMultipleLayers(layerIds, punchHole, shouldCancel = null) {
        if (this._blockedMediaOnline('Extracting the selection')) return false
        const selectionPath = this._selectionManager.selectionPath
        const canvasWidth = this._canvas.width
        const canvasHeight = this._canvas.height

        const extractBounds = this._clampBounds(getSelectionBounds(selectionPath))
        if (!extractBounds) return false

        // Create selection mask
        const maskCanvas = new OffscreenCanvas(canvasWidth, canvasHeight)
        const maskCtx = maskCanvas.getContext('2d')
        this._drawSelectionMask(maskCtx, selectionPath)

        // Render composite of selected layers
        const compositeImg = await this._renderLayerComposite(layerIds)
        if (!compositeImg) return false

        // Create extracted pixels canvas
        const extractedCanvas = new OffscreenCanvas(canvasWidth, canvasHeight)
        const extractedCtx = extractedCanvas.getContext('2d')
        extractedCtx.drawImage(compositeImg, 0, 0)
        extractedCtx.globalCompositeOperation = 'destination-in'
        extractedCtx.drawImage(maskCanvas, 0, 0)
        extractedCtx.globalCompositeOperation = 'source-over'

        if (!this._hasVisiblePixels(extractedCtx, extractBounds)) {
            toast.warning('no pixels selected')
            return false
        }

        const topmostIndex = Math.max(...layerIds.map(
            id => this._layers.findIndex(layer => layer.id === id)))
        const layers = [...this._layers]
        const mediaOverrides = new Map()
        const preparedResources = []
        if (punchHole) {
            // Flatten layers, then punch hole
            // First flatten (similar to _flattenLayers but we keep the result for punching)
            const flattenedCanvas = new OffscreenCanvas(canvasWidth, canvasHeight)
            const flattenedCtx = flattenedCanvas.getContext('2d')
            flattenedCtx.drawImage(compositeImg, 0, 0)

            // Punch hole
            flattenedCtx.globalCompositeOperation = 'destination-out'
            flattenedCtx.drawImage(maskCanvas, 0, 0)
            flattenedCtx.globalCompositeOperation = 'source-over'

            // Create flattened layer with hole
            const flattenedBlob = await flattenedCanvas.convertToBlob({ type: 'image/png' })
            const flattenedFile = new File([flattenedBlob], 'flattened.png', { type: 'image/png' })

            const flattenedLayer = createMediaLayer(flattenedFile, 'image', 'flattened')
            const indicesToRemove = layerIds
                .map(id => layers.findIndex(layer => layer.id === id))
                .filter(i => i !== -1)
                .sort((a, b) => b - a)
            for (const idx of indicesToRemove) {
                layers.splice(idx, 1)
            }
            const removedAboveTopmost = indicesToRemove.filter(idx => idx < topmostIndex).length
            const insertIndex = topmostIndex - removedAboveTopmost
            layers.splice(insertIndex, 0, flattenedLayer)
            try {
                const resource = await this._renderer.prepareMediaResource(
                    flattenedFile, 'image')
                preparedResources.push(resource)
                mediaOverrides.set(flattenedLayer.id, resource)
            } catch (err) {
                for (const resource of preparedResources) {
                    this._renderer.disposeMediaResource(resource)
                }
                return false
            }
        }

        // Create new layer with extracted pixels
        let newLayer
        try {
            const extractedBlob = await extractedCanvas.convertToBlob({ type: 'image/png' })
            const extractedFile = new File(
                [extractedBlob], 'moved-selection.png', { type: 'image/png' })
            newLayer = createMediaLayer(extractedFile, 'image', 'moved selection')
            layers.push(newLayer)
            const resource = await this._renderer.prepareMediaResource(
                extractedFile, 'image')
            preparedResources.push(resource)
            mediaOverrides.set(newLayer.id, resource)
        } catch (err) {
            for (const resource of preparedResources) {
                this._renderer.disposeMediaResource(resource)
            }
            return false
        }
        try {
            const candidate = await this._prepareLayerSetCandidate(
                layers, canvasWidth, canvasHeight, {
                    reuseMediaIds: new Set(this._renderer._mediaTextures.keys()),
                    reuseMaskIds: new Set(this._renderer._maskTextures.keys()),
                    mediaOverrides,
                })
            const outcome = await this._commitPreparedLayerMutation(candidate, {
                selectedLayerIds: [newLayer.id],
                selectionAnchor: newLayer.id,
                selectionPath: punchHole ? null : selectionPath,
                shouldCancel,
            })
            return outcome.status === 'committed'
        } catch (err) {
            return false
        }
    }

    /**
     * Load an Image element from a Blob
     * @param {Blob} blob
     * @param {object} [options]
     * @param {boolean} [options.preserveSelectedVisibility=false]
     * @returns {Promise<HTMLImageElement|null>}
     * @private
     */
    _loadImageFromBlob(blob) {
        return new Promise((resolve) => {
            const img = new Image()
            const url = URL.createObjectURL(blob)
            img.onload = () => {
                URL.revokeObjectURL(url)
                resolve(img)
            }
            img.onerror = () => {
                URL.revokeObjectURL(url)
                resolve(null)
            }
            img.src = url
        })
    }

    /**
     * Render a composite image of specified layers
     * @param {string[]} layerIds - Layer IDs to render
     * @returns {Promise<HTMLImageElement|null>}
     * @private
     */
    async _renderLayerComposite(layerIds, {
        preserveSelectedVisibility = false,
        selectedLayerOverrides = null,
    } = {}) {
        const candidate = {
            layers: this._layers.map(layer => {
                const selected = layerIds.includes(layer.id)
                const candidateLayer = {
                    ...layer,
                    ...(selected && selectedLayerOverrides
                        ? selectedLayerOverrides
                        : {}),
                }
                candidateLayer.visible = selected
                    && (!preserveSelectedVisibility || candidateLayer.visible)
                return candidateLayer
            }),
            mediaTextures: new Map(this._renderer._mediaTextures),
            maskTextures: new Map(this._renderer._maskTextures),
        }
        let stage = null
        let drewCandidate = false
        const restoreNormalizedTime = this._renderer.getPausedNormalizedTime()
        const redrawRestoredComposition = () => {
            if (!drewCandidate) return true
            try {
                this._renderer.render(restoreNormalizedTime)
                return true
            } catch (err) {
                console.error('[Layers] Failed to redraw restored composite:', err)
                return false
            }
        }
        const rollback = async () => {
            if (!stage) return true
            let restored = false
            try {
                const result = await stage.rollback()
                restored = Boolean(result?.success)
            } catch (err) {
                console.error('[Layers] Failed to restore composite renderer:', err)
            } finally {
                stage = null
            }
            if (restored) return redrawRestoredComposition()
            try {
                const retry = await this._rebuild({ force: true })
                if (!retry?.success) {
                    console.error('[Layers] Composite renderer restoration retry failed:',
                        retry?.error || 'Unknown renderer restoration failure')
                    this._renderer.stop()
                } else {
                    redrawRestoredComposition()
                }
            } catch (err) {
                console.error('[Layers] Failed to retry composite restoration:', err)
                this._renderer.stop()
            }
            return false
        }

        try {
            stage = await this._renderer.stageLayerSet(candidate)
            if (!stage.success) {
                await rollback()
                return null
            }
            drewCandidate = true
            this._renderer.render(0)
            const offscreen = new OffscreenCanvas(this._canvas.width, this._canvas.height)
            offscreen.getContext('2d').drawImage(this._canvas, 0, 0)
            if (!await rollback()) return null
            const blob = await offscreen.convertToBlob({ type: 'image/png' })
            return this._loadImageFromBlob(blob)
        } catch (err) {
            console.error('[Layers] Failed to render layer composite:', err)
            await rollback()
            return null
        }
    }

    /**
     * Get image element for a layer
     * @param {object} layer
     * @returns {Promise<HTMLImageElement|null>}
     * @private
     */
    _getLayerImage(layer) {
        if (!layer.mediaFile) return null
        return this._loadImageFromBlob(layer.mediaFile)
    }

    /**
     * Capture current video frame as an image at native dimensions
     * @param {string} layerId
     * @returns {Promise<HTMLImageElement|null>}
     * @private
     */
    async _captureVideoFrame(layerId) {
        const media = this._renderer.getMediaInfo(layerId)
        if (!media || media.type !== 'video') return null
        const offscreen = new OffscreenCanvas(media.width, media.height)
        const ctx = offscreen.getContext('2d')
        ctx.drawImage(media.element, 0, 0)
        const blob = await offscreen.convertToBlob({ type: 'image/png' })
        return this._loadImageFromBlob(blob)
    }

    /**
     * Draw selection mask to canvas context
     * @param {CanvasRenderingContext2D} ctx
     * @param {object} selectionPath
     * @param {number} [offsetX=0]
     * @param {number} [offsetY=0]
     * @private
     */
    _drawSelectionMask(ctx, selectionPath, offsetX = 0, offsetY = 0) {
        ctx.imageSmoothingEnabled = false
        ctx.fillStyle = 'white'

        if (selectionPath.type === 'rect') {
            // Use integer coords to avoid anti-aliasing artifacts
            const x = Math.round(selectionPath.x + offsetX)
            const y = Math.round(selectionPath.y + offsetY)
            const w = Math.round(selectionPath.width)
            const h = Math.round(selectionPath.height)
            ctx.fillRect(x, y, w, h)
        } else if (selectionPath.type === 'oval') {
            ctx.beginPath()
            ctx.ellipse(selectionPath.cx + offsetX, selectionPath.cy + offsetY, selectionPath.rx, selectionPath.ry, 0, 0, Math.PI * 2)
            ctx.fill()
        } else if (selectionPath.type === 'lasso' || selectionPath.type === 'polygon') {
            if (selectionPath.points.length >= 3) {
                ctx.beginPath()
                ctx.moveTo(selectionPath.points[0].x + offsetX, selectionPath.points[0].y + offsetY)
                for (let i = 1; i < selectionPath.points.length; i++) {
                    ctx.lineTo(selectionPath.points[i].x + offsetX, selectionPath.points[i].y + offsetY)
                }
                ctx.closePath()
                ctx.fill()
            }
        } else if (selectionPath.type === 'wand' || selectionPath.type === 'mask') {
            const mask = selectionPath.type === 'wand' ? selectionPath.mask : selectionPath.data
            // For mask-based selections, we need to translate the putImageData
            ctx.putImageData(mask, offsetX, offsetY)
        }
    }

    /**
     * Set the global foreground color and sync to all drawing tools
     * @param {string} color - CSS hex color (e.g. '#ff0000')
     * @private
     */
    _setForegroundColor(color) {
        this._foregroundColor = color
        if (this._brushTool) this._brushTool.color = color
        if (this._shapeTool) this._shapeTool.color = color
        if (this._fillTool) this._fillTool.color = color
        const well = document.getElementById('colorWell')
        if (well) well.style.backgroundColor = color
        const input = document.getElementById('colorWellInput')
        if (input) input.value = color
    }

    /**
     * Set current tool mode
     * @param {'selection' | 'move' | 'clone' | 'transform' | 'brush' | 'eraser' | 'shape' | 'fill' | 'eyedropper'} tool
     * @private
     */
    _setToolMode(tool) {
        if (tool === 'transform') {
            const layer = this._getActiveLayer()
            if (!layer || (layer.sourceType !== 'media' && layer.sourceType !== 'drawing')) {
                toast.warning('Select a media or drawing layer to transform')
                return
            }
        }
        this._cancelColorRangePick()
        if (tool === 'eyedropper') this._previousTool = this._currentTool
        this._currentTool = tool

        // Deactivate all tools
        this._moveTool?.deactivate()
        this._cloneTool?.deactivate()
        this._transformTool?.deactivate()
        this._brushTool?.deactivate()
        this._eraserTool?.deactivate()
        this._shapeTool?.deactivate()
        this._fillTool?.deactivate()
        this._eyedropperTool?.deactivate()

        // Update button states
        document.getElementById('moveToolBtn')?.classList.toggle('active', tool === 'move')
        document.getElementById('cloneToolBtn')?.classList.toggle('active', tool === 'clone')
        document.getElementById('selectionToolBtn')?.classList.toggle('active', tool === 'selection')
        document.getElementById('transformToolBtn')?.classList.toggle('active', tool === 'transform')
        document.getElementById('brushToolBtn')?.classList.toggle('active', tool === 'brush')
        document.getElementById('eraserToolBtn')?.classList.toggle('active', tool === 'eraser')
        document.getElementById('shapeToolBtn')?.classList.toggle('active', tool === 'shape')
        document.getElementById('fillToolBtn')?.classList.toggle('active', tool === 'fill')
        document.getElementById('eyedropperToolBtn')?.classList.toggle('active', tool === 'eyedropper')

        // Clear selection tool checkmarks when not in selection mode
        if (tool !== 'selection') {
            document.querySelectorAll('#selectionMenu .tool-menu-item[data-shape]').forEach(el => {
                el.classList.remove('checked')
            })
        }

        // Activate selected tool
        if (tool === 'move') this._moveTool?.activate()
        else if (tool === 'clone') this._cloneTool?.activate()
        else if (tool === 'transform') this._transformTool?.activate()
        else if (tool === 'brush') this._brushTool?.activate()
        else if (tool === 'eraser') this._eraserTool?.activate()
        else if (tool === 'shape') this._shapeTool?.activate()
        else if (tool === 'fill') this._fillTool?.activate()
        else if (tool === 'eyedropper') this._eyedropperTool?.activate()

        // Show/hide drawing options bar
        const drawingTools = ['brush', 'eraser', 'shape', 'fill']
        const showOptions = drawingTools.includes(tool)
        const optionsBar = document.getElementById('drawingOptionsBar')
        if (optionsBar) {
            optionsBar.classList.toggle('hidden', !showOptions)
        }
        document.getElementById('menu')?.classList.toggle('has-options-bar', showOptions)
        document.getElementById('drawingFilledLabel')?.classList.toggle('hidden', tool !== 'shape')
        document.getElementById('drawingToleranceLabel')?.classList.toggle('hidden', tool !== 'fill')

        // In mask edit mode, keep brush tool active for painting
        if (this._maskEditMode && (tool === 'brush' || tool === 'eraser')) {
            this._eraserTool?.deactivate()
            this._brushTool?.activate()
        }

        this._selectionManager.enabled = (tool === 'selection')
        this._selectionOverlay?.classList.toggle('move-tool', tool === 'move')
        this._selectionOverlay?.classList.toggle('clone-tool', tool === 'clone')
        this._selectionOverlay?.classList.toggle('transform-tool', tool === 'transform')
        this._selectionOverlay?.classList.toggle('brush-tool', tool === 'brush')
        this._selectionOverlay?.classList.toggle('eraser-tool', tool === 'eraser')
        this._selectionOverlay?.classList.toggle('shape-tool', tool === 'shape')
        this._selectionOverlay?.classList.toggle('fill-tool', tool === 'fill')
        this._selectionOverlay?.classList.toggle('eyedropper-tool', tool === 'eyedropper')
    }

    _updateToolButtons() {
        const isVideo = this._getActiveLayer()?.mediaType === 'video'
        document.getElementById('moveToolBtn')?.classList.toggle('disabled', isVideo)
    }

    /** @private */
    async _commitDrawingLayerMutation(layer, mutate, { pushUndo = true } = {}) {
        const commit = async () => {
            const previous = this._captureLayerMutationState()
            let targetLayer = layer
            let previousStrokeArray = null
            let previousStrokes = null
            let previousDrawingCanvas = null
            let previousResource = null
            const transaction = this._beginPublishTransaction()
            try {
                targetLayer ||= this._ensureDrawingLayer({ recordMutation: false })
                previousStrokeArray = targetLayer.strokes
                previousStrokes = previousStrokeArray.slice()
                previousDrawingCanvas = targetLayer.drawingCanvas
                previousResource = this._renderer.getMediaInfo(targetLayer.id)
                this._finalizePendingUndo()
                mutate(targetLayer)
                await this._rasterizeDrawingLayer(targetLayer)
                const result = await this._rebuild({ force: true })
                if (!result?.success) {
                    throw new Error(result?.error || 'Failed to render drawing mutation')
                }
                this._markDirty()
                if (pushUndo) this._pushUndoState()
                return {
                    status: 'committed',
                    layerId: targetLayer.id,
                }
            } catch (err) {
                if (targetLayer && previousStrokeArray && previousStrokes) {
                    previousStrokeArray.splice(
                        0, previousStrokeArray.length, ...previousStrokes)
                    targetLayer.strokes = previousStrokeArray
                    targetLayer.drawingCanvas = previousDrawingCanvas
                    const currentResource = this._renderer.getMediaInfo(targetLayer.id)
                    if (previousResource) {
                        if (currentResource !== previousResource) {
                            this._renderer.setMediaResource(targetLayer.id, previousResource)
                        }
                    } else if (currentResource) {
                        this._renderer.unloadMedia(targetLayer.id)
                    }
                }
                return await this._rollbackLayerMutation(previous, err)
            } finally {
                this._endPublishTransaction(transaction)
            }
        }
        const pending = this._drawingMutationTail.then(commit, commit)
        this._drawingMutationTail = pending.then(() => undefined, () => undefined)
        return pending
    }

    /**
     * Commit a human or agent brush/shape stroke only if the resulting layer
     * stack compiles.
     * @param {object} stroke
     * @param {object|null} layer
     * @returns {Promise<{status:'committed',layerId:string,strokeId:string}|{status:'failed',error:Error}>}
     * @private
     */
    async _commitDrawingStroke(stroke, layer = null) {
        const result = await this._commitDrawingLayerMutation(
            layer, targetLayer => targetLayer.strokes.push(stroke))
        if (result.status !== 'committed') return result
        return { ...result, strokeId: stroke.id }
    }

    /**
     * Ensure a drawing layer exists and is active. If the active layer is already
     * a drawing layer, return it. Otherwise, create a new drawing layer above the
     * current layer and select it.
     * @returns {Object} The drawing layer
     * @private
     */
    _ensureDrawingLayer({ recordMutation = true } = {}) {
        const active = this._getActiveLayer()
        if (active?.sourceType === 'drawing') return active

        if (recordMutation) this._finalizePendingUndo()
        const layer = createDrawingLayer(`Drawing ${++this._drawingLayerCounter}`)

        // Insert above current layer
        const activeIdx = active ? this._layers.indexOf(active) : this._layers.length - 1
        this._layers.splice(activeIdx + 1, 0, layer)

        this._updateLayerStack()
        if (this._layerStack) {
            this._layerStack.selectedLayerId = layer.id
        }

        if (recordMutation) {
            this._markDirty()
            this._pushUndoState()
        }
        return layer
    }

    /**
     * Handle copy command
     * @private
     */
    async _handleCopy() {
        if (!this._selectionManager?.hasSelection()) return

        this._renderCurrentFrame()

        const selectionPath = this._selectionManager.selectionPath
        const selectedLayers = this._layerStack?.selectedLayers || []

        // Filter to visible layers only
        const visibleLayers = selectedLayers.filter(l => l.visible)

        // If no layers selected in panel, use all visible layers
        const layersToCopy = visibleLayers.length > 0
            ? visibleLayers
            : this._layers.filter(l => l.visible)

        const origin = await copySelection({
            selectionPath,
            layers: layersToCopy,
            sourceCanvas: this._canvas
        })

        if (origin) {
            this._copyOrigin = origin
            toast.success('Copied to clipboard')
        } else {
            toast.error('Failed to copy')
        }
    }

    /**
     * Handle paste command
     * @private
     */
    async _handlePaste() {
        if (this._onlineAdapter?.isOnline()) {
            toast.warning('Media layers aren’t supported while a Layers session is online')
            return { status: 'failed' }
        }
        const result = await pasteFromClipboard()
        if (!result) {
            return { status: 'failed' } // No image in clipboard, silent fail
        }

        const { blob } = result

        // Load pasted image to get dimensions
        const img = new Image()
        const url = URL.createObjectURL(blob)
        await new Promise((resolve, reject) => {
            img.onload = resolve
            img.onerror = reject
            img.src = url
        })
        URL.revokeObjectURL(url)

        const canvasWidth = this._canvas.width
        const canvasHeight = this._canvas.height
        let file, offsetX = 0, offsetY = 0
        let clearSelection = false

        // If there's an active selection, scale image to fit selection bounds
        if (this._selectionManager?.hasSelection()) {
            const bounds = getSelectionBounds(this._selectionManager.selectionPath)
            if (bounds.width > 0 && bounds.height > 0) {
                const offscreen = new OffscreenCanvas(bounds.width, bounds.height)
                const ctx = offscreen.getContext('2d')
                ctx.drawImage(img, 0, 0, bounds.width, bounds.height)
                const scaledBlob = await offscreen.convertToBlob({ type: 'image/png' })
                file = new File([scaledBlob], 'pasted-image.png', { type: 'image/png' })
                // Offset is center-relative: image center minus canvas center
                offsetX = Math.round(bounds.x + bounds.width / 2 - canvasWidth / 2)
                offsetY = Math.round(bounds.y + bounds.height / 2 - canvasHeight / 2)
                clearSelection = true
            }
        }

        if (!file) {
            // No selection: use clipboard image directly, position via offset
            file = new File([blob], 'pasted-image.png', { type: 'image/png' })
            if (this._copyOrigin) {
                // Offset is center-relative: image center minus canvas center
                offsetX = Math.round(this._copyOrigin.x + img.width / 2 - canvasWidth / 2)
                offsetY = Math.round(this._copyOrigin.y + img.height / 2 - canvasHeight / 2)
            }
            // else offsetX=0, offsetY=0 (centered)
        }

        const layer = createMediaLayer(file, 'image')
        layer.offsetX = offsetX
        layer.offsetY = offsetY
        let resource
        try {
            resource = await this._renderer.prepareMediaResource(file, 'image')
            const candidate = await this._prepareLayerSetCandidate(
                [...this._layers, layer], canvasWidth, canvasHeight, {
                    reuseMediaIds: new Set(this._renderer._mediaTextures.keys()),
                    reuseMaskIds: new Set(this._renderer._maskTextures.keys()),
                    mediaOverrides: new Map([[layer.id, resource]]),
                })
            const outcome = await this._commitPreparedLayerMutation(candidate, {
                selectedLayerIds: [layer.id],
                selectionAnchor: layer.id,
                selectionPath: clearSelection
                    ? null
                    : this._selectionManager?.selectionPath,
            })
            if (outcome.status !== 'committed') return outcome
        } catch (err) {
            return { status: 'failed', error: err }
        }
        try {
            toast.success(`Added layer: ${layer.name}`)
        } catch (err) {
            console.error('[Layers] Failed to show paste confirmation:', err)
        }
        return { status: 'committed' }
    }

    /**
     * Show the save project dialog
     * @private
     */
    _showSaveProjectDialog() {
        if (this._projectLifecycleActive || this._projectReplacementActive
            || this._projectLifecycleWaiters > 0) return
        const generation = this._replacementGeneration
        saveProjectDialog.show({
            projectId: this._currentProjectId,
            projectName: this._currentProjectName || 'untitled',
            onSave: async (projectId, projectName) => {
                await this._runPointerMutation(
                    (mutationToken) => this._saveProject(
                        projectId, projectName, { mutationToken }),
                    { generation })
            }
        })
    }

    /**
     * Show save project as dialog (always prompts for name)
     * @private
     */
    _showSaveProjectAsDialog() {
        if (this._projectLifecycleActive || this._projectReplacementActive
            || this._projectLifecycleWaiters > 0) return
        const generation = this._replacementGeneration
        saveProjectDialog.show({
            projectId: null,
            projectName: this._currentProjectName || 'untitled',
            onSave: async (projectId, projectName) => {
                await this._runPointerMutation(
                    (mutationToken) => this._saveProject(
                        projectId, projectName, { mutationToken }),
                    { generation })
            }
        })
    }

    /**
     * Quick save project without dialog (for existing projects)
     * @private
     */
    async _quickSaveProject(mutationToken = null) {
        try {
            await this._saveProject(
                this._currentProjectId, this._currentProjectName, { mutationToken })
        } catch (err) {
            // Error already shown in _saveProject
        }
    }

    /**
     * Show the load project dialog
     * @param {boolean} isRequired - If true, dialog cannot be closed without selection
     * @private
     */
    _showLoadProjectDialog(isRequired = false, {
        leaveOnline = false,
        replacementConsent = null,
    } = {}) {
        projectManagerDialog.show({
            isRequired,
            onLoad: async (projectId) => {
                let status = null
                const loadSelectedProject = async ({
                    leaveOnline: confirmedLeaveOnline,
                    replacementConsent: confirmedConsent,
                }) => {
                    status = await this._loadProject(projectId, {
                        leaveOnline: confirmedLeaveOnline,
                        replacementConsent: confirmedConsent,
                    })
                }
                if (replacementConsent
                    && !this._projectReplacementStateMatches(replacementConsent)) {
                    projectManagerDialog.suspendForConfirmation()
                }
                const accepted = replacementConsent
                    ? await this._continueProjectReplacement(
                        replacementConsent, loadSelectedProject)
                    : (await loadSelectedProject({ leaveOnline }), true)
                if (!accepted) {
                    throw new Error('Project load was cancelled')
                }
                if (status === 'not-found') {
                    throw new Error('Project not found')
                }
                if (status !== 'opened') {
                    throw new Error('Project load was cancelled by a newer replacement')
                }
            },
            onCancel: isRequired ? () => {
                // Open dialog is still visible behind, nothing to do
            } : undefined
        })
    }

    /**
     * Save the current project
     * @param {string|null} projectId - Existing project ID (for update)
     * @param {string} projectName - Project name
     * @private
     */
    async _saveProject(projectId, projectName, { mutationToken = null } = {}) {
        return this._runProjectLifecycle(mutationToken, async () => {
            try {
                const savedId = await saveProject({
                    name: projectName,
                    canvasWidth: this._canvas.width,
                    canvasHeight: this._canvas.height,
                    layers: this._layers
                }, projectId)

                this._currentProjectId = savedId
                this._currentProjectName = projectName
                this._markClean()
            } catch (err) {
                console.error('[Layers] Failed to save project:', err)
                try {
                    toast.error('Failed to save project')
                } catch (toastError) {
                    console.error('[Layers] Failed to show save error:', toastError)
                }
                throw err
            }
            try {
                toast.success('Project saved')
            } catch (err) {
                console.error('[Layers] Failed to show save confirmation:', err)
            }
        })
    }

    /**
     * Load a project
     * @param {string} projectId - Project ID
     * @private
     */
    async _loadProject(projectId, {
        leaveOnline = false,
        mutationToken = null,
        replacementConsent = null,
    } = {}) {
        const generation = ++this._replacementGeneration
        return this._runProjectReplacement(mutationToken, async (token, replacementGate) => {
            let candidate = null
            try {
                const result = await loadProject(projectId)
            if (!result) {
                toast.error('Project not found')
                return 'not-found'
            }
            if (generation !== this._replacementGeneration) return 'cancelled'

            const { project, mediaFiles } = result
            const width = Number(project.canvasWidth)
            const height = Number(project.canvasHeight)
            if (!Number.isSafeInteger(width) || width < 1 || width > MAX_CANVAS_DIMENSION
                || !Number.isSafeInteger(height) || height < 1
                || height > MAX_CANVAS_DIMENSION) {
                throw new Error('Saved project has invalid canvas dimensions')
            }

            const layers = structuredClone(project.layers || [])
            const nextLayerId = this._validatePersistedLayers(layers)
            await this._validatePersistedLayerSemantics(layers, width, height)
            await decodeMasks(layers, {
                maxWidth: width,
                maxHeight: height,
                maxPixels: width * height,
                expectedWidth: width,
                expectedHeight: height,
            })
            if (generation !== this._replacementGeneration) return 'cancelled'

            candidate = {
                layers,
                width,
                height,
                projectId: project.id,
                projectName: project.name,
                dirty: false,
                selectedLayerId: layers.at(-1)?.id || null,
                nextLayerId,
                mediaTextures: new Map(),
                maskTextures: new Map()
            }

            // Prepare every fallible resource outside the committed renderer.
            for (const layer of layers) {
                if (layer.sourceType === 'media') {
                    const file = mediaFiles.get(layer.id)
                    if (!file) {
                        throw new Error(`Saved media is missing for layer "${layer.name || layer.id}"`)
                    }
                    layer.mediaFile = file
                    const resource = await this._renderer.prepareMediaResource(file, layer.mediaType)
                    try {
                        this._validatePreparedMediaResource(layer, resource)
                    } catch (err) {
                        if (resource) this._renderer.disposeMediaResource(resource)
                        throw err
                    }
                    candidate.mediaTextures.set(layer.id, resource)
                    if (generation !== this._replacementGeneration) {
                        this._disposePreparedProject(candidate)
                        candidate = null
                        return 'cancelled'
                    }
                }
                if (layer.sourceType === 'drawing') {
                    const canvas = await this._createDrawingLayerCanvas(layer, width, height)
                    if (canvas) {
                        candidate.mediaTextures.set(
                            layer.id, this._renderer.prepareCanvasMediaResource(canvas))
                    }
                    if (generation !== this._replacementGeneration) {
                        this._disposePreparedProject(candidate)
                        candidate = null
                        return 'cancelled'
                    }
                }
                if (layer.mask) {
                    candidate.maskTextures.set(
                        layer.id, this._renderer.prepareMaskTexture(layer.mask))
                }
            }

            const outcome = await this._installPreparedProject(
                candidate, {
                    generation,
                    leaveOnline,
                    replacementConsent,
                    mutationToken: token,
                    replacementGate,
                })
            candidate = null
            if (outcome.status === 'failed') throw outcome.error
            if (outcome.status === 'cancelled') return 'cancelled'

            this._completeProjectReplacementUi(`Loaded "${project.name}"`)
            return 'opened'
            } catch (err) {
                if (candidate) this._disposePreparedProject(candidate)
                console.error('[Layers] Failed to load project:', err)
                toast.error('Failed to load project')
                throw err
            }
        })
    }

    /**
     * Quick save as PNG
     * @private
     */
    _quickSavePng() {
        this._renderCurrentFrame()
        const filename = getTimestampedFilename('layers')
        exportPng(this._canvas, filename)
        toast.success('Saved as PNG')
    }

    /**
     * Quick save as JPG
     * @private
     */
    _quickSaveJpg() {
        this._renderCurrentFrame()
        const filename = getTimestampedFilename('layers')
        exportJpg(this._canvas, filename)
        toast.success('Saved as JPG')
    }

    /**
     * Prompt for a radius parameter, rasterize the current selection, and apply a mask operation.
     * @param {Object} dialogOptions - Options for selectionParamDialog.show()
     * @param {function(ImageData, number): ImageData} maskFn - Mask transform function
     * @private
     */
    async _modifySelection(dialogOptions, maskFn) {
        const generation = this._replacementGeneration
        const r = await selectionParamDialog.show(dialogOptions)
        if (r === null || generation !== this._replacementGeneration) return
        const mask = this._selectionManager.rasterizeSelection()
        if (!mask) return
        this._selectionManager.setSelection({ type: 'mask', data: maskFn(mask, r) })
    }

    _updateSelectMenu() {
        const hasSelection = this._selectionManager?.hasSelection()
        const selectionItems = [
            'selectNoneMenuItem',
            'selectInverseMenuItem',
            'borderSelectionMenuItem',
            'smoothSelectionMenuItem',
            'expandSelectionMenuItem',
            'contractSelectionMenuItem',
            'featherSelectionMenuItem'
        ]
        for (const id of selectionItems) {
            document.getElementById(id)?.classList.toggle('disabled', !hasSelection)
        }
    }

    _startColorRangePick(mutationToken = null) {
        if (!this._canvas || this._colorRangePicking) return false
        const pickToken = this._tryAcquireProjectLifecycle(mutationToken)
        if (!pickToken) return false

        const generation = this._replacementGeneration
        const selectionWasEnabled = this._selectionManager.enabled
        this._colorRangePicking = true
        this._selectionOverlay.style.cursor = 'crosshair'
        this._selectionManager.enabled = false

        const cleanup = () => {
            if (this._colorRangePickCleanup !== cleanup) return
            this._selectionOverlay.removeEventListener('click', handler)
            document.removeEventListener('keydown', cancelHandler)
            window.removeEventListener('blur', blurHandler)
            document.removeEventListener('visibilitychange', visibilityHandler)
            this._colorRangePicking = false
            this._selectionOverlay.style.cursor = ''
            this._selectionManager.enabled = selectionWasEnabled
            this._colorRangePickCleanup = null
            pickToken.release()
        }

        const handler = (e) => {
            try {
                if (generation === this._replacementGeneration) {
                    this._handleColorRangePick(e)
                }
            } finally {
                cleanup()
            }
        }

        const cancelHandler = (e) => {
            if (e.key === 'Escape') cleanup()
        }
        const blurHandler = () => cleanup()
        const visibilityHandler = () => {
            if (document.hidden) cleanup()
        }

        this._colorRangePickCleanup = cleanup
        this._selectionOverlay.addEventListener('click', handler)
        document.addEventListener('keydown', cancelHandler)
        window.addEventListener('blur', blurHandler)
        document.addEventListener('visibilitychange', visibilityHandler)
        return true
    }

    _cancelColorRangePick() {
        this._colorRangePickCleanup?.()
    }

    _handleColorRangePick(e) {
        this._renderCurrentFrame()
        const rect = this._selectionOverlay.getBoundingClientRect()
        const scaleX = this._canvas.width / rect.width
        const scaleY = this._canvas.height / rect.height
        const x = Math.round((e.clientX - rect.left) * scaleX)
        const y = Math.round((e.clientY - rect.top) * scaleY)

        const tempCanvas = document.createElement('canvas')
        tempCanvas.width = this._canvas.width
        tempCanvas.height = this._canvas.height
        const tempCtx = tempCanvas.getContext('2d')
        tempCtx.drawImage(this._canvas, 0, 0)
        const imageData = tempCtx.getImageData(0, 0, tempCanvas.width, tempCanvas.height)

        const tolerance = this._selectionManager.wandTolerance
        const mask = colorRange(imageData, x, y, tolerance)

        let hasPixels = false
        for (let i = 3; i < mask.data.length; i += 4) {
            if (mask.data[i] > 127) { hasPixels = true; break }
        }

        if (hasPixels) {
            this._selectionManager.setSelection({ type: 'mask', data: mask })
        }
    }

    _updateImageMenu() {
        const cropItem = document.getElementById('cropToSelectionMenuItem')
        if (!cropItem) return
        const hasSelection = this._selectionManager?.hasSelection()
        cropItem.classList.toggle('disabled', !hasSelection)
    }

    async _cropToSelection() {
        if (!this._selectionManager?.hasSelection()) return { status: 'committed' }

        const selectionPath = this._selectionManager.selectionPath
        const bounds = getSelectionBounds(selectionPath)
        if (bounds.width <= 0 || bounds.height <= 0) return { status: 'committed' }

        const layers = this._cloneLayers(this._layers)
        const mediaOverrides = new Map()
        const preparedResources = []
        let mediaOwnershipTransferred = false
        const disposePreparedResources = () => {
            const disposed = new Set()
            for (const resource of preparedResources) {
                if (!resource || disposed.has(resource)) continue
                this._renderer.disposeMediaResource(resource)
                disposed.add(resource)
            }
            preparedResources.length = 0
        }
        try {
            for (const layer of layers) {
                const bakeRaster = layer.sourceType === 'drawing'
                    || (layer.sourceType === 'media' && layer.mediaType !== 'video')
                if (bakeRaster) {
                    const compositeImg = await this._renderLayerComposite([layer.id], {
                        selectedLayerOverrides: {
                            visible: true,
                            opacity: 100,
                            blendMode: 'mix',
                        },
                    })
                    if (!compositeImg) {
                        return {
                            status: 'failed',
                            error: new Error('Failed to render crop source'),
                        }
                    }
                    const offscreen = new OffscreenCanvas(bounds.width, bounds.height)
                    offscreen.getContext('2d').drawImage(
                        compositeImg,
                        bounds.x, bounds.y, bounds.width, bounds.height,
                        0, 0, bounds.width, bounds.height)
                    const blob = await offscreen.convertToBlob({ type: 'image/png' })
                    const file = new File([blob], 'cropped.png', { type: 'image/png' })
                    const resource = await this._renderer.prepareMediaResource(file, 'image')
                    preparedResources.push(resource)
                    mediaOverrides.set(layer.id, resource)
                    layer.sourceType = 'media'
                    layer.mediaFile = file
                    layer.mediaType = 'image'
                    delete layer.strokes
                    delete layer.drawingCanvas
                    layer.offsetX = 0
                    layer.offsetY = 0
                    layer.scaleX = 1
                    layer.scaleY = 1
                    layer.rotation = 0
                    layer.flipH = false
                    layer.flipV = false
                    layer.effectParams = {}
                    layer.children = []
                    layer.mask = null
                    layer.maskEnabled = true
                    layer.maskVisible = false
                } else {
                    // Video and effect layers retain their canvas position without
                    // rasterization. Offsets are relative to the canvas center.
                    layer.offsetX = (layer.offsetX || 0)
                        + (this._canvas.width - bounds.width) / 2 - bounds.x
                    layer.offsetY = (layer.offsetY || 0)
                        + (this._canvas.height - bounds.height) / 2 - bounds.y
                }
            }

            // Crop masks to match new canvas bounds
            for (const layer of layers) {
                if (layer.mask) {
                    const tempCanvas = document.createElement('canvas')
                    tempCanvas.width = layer.mask.width
                    tempCanvas.height = layer.mask.height
                    tempCanvas.getContext('2d').putImageData(layer.mask, 0, 0)

                    const croppedCanvas = document.createElement('canvas')
                    croppedCanvas.width = bounds.width
                    croppedCanvas.height = bounds.height
                    const ctx = croppedCanvas.getContext('2d')
                    ctx.drawImage(
                        tempCanvas,
                        bounds.x, bounds.y, bounds.width, bounds.height,
                        0, 0, bounds.width, bounds.height
                    )
                    layer.mask = ctx.getImageData(0, 0, bounds.width, bounds.height)
                }
            }

            // Calling _prepareLayerSetCandidate transfers detached override ownership,
            // including when candidate preparation rejects.
            mediaOwnershipTransferred = true
            const candidate = await this._prepareLayerSetCandidate(
                layers, bounds.width, bounds.height, {
                    reuseMediaIds: new Set(this._renderer._mediaTextures.keys()),
                    mediaOverrides,
                })
            const outcome = await this._commitPreparedLayerMutation(candidate, {
                selectionPath: null,
            })
            if (outcome.status !== 'committed') return outcome
        } catch (err) {
            return { status: 'failed', error: err }
        } finally {
            if (!mediaOwnershipTransferred) disposePreparedResources()
        }
        try {
            toast.success('Cropped to selection')
        } catch (err) {
            console.error('[Layers] Failed to show crop confirmation:', err)
        }
        return { status: 'committed' }
    }

    _showImageSizeDialog() {
        if (this._projectLifecycleActive || this._projectReplacementActive
            || this._projectLifecycleWaiters > 0) return
        const generation = this._replacementGeneration
        imageSizeDialog.show({
            width: this._canvas.width,
            height: this._canvas.height,
            onConfirm: async (width, height) => {
                await this._runPointerMutation(
                    () => this._resizeImage(width, height), { generation })
            }
        })
    }

    /** @private */
    _scaleDrawingStrokes(strokes, scaleX, scaleY) {
        const sizeScale = Math.max(Math.abs(scaleX), Math.abs(scaleY))
        return (strokes || []).map(stroke => {
            const scaled = { ...stroke }
            if (Array.isArray(stroke.points)) {
                scaled.points = stroke.points.map(point => ({
                    x: point.x * scaleX,
                    y: point.y * scaleY,
                }))
            }
            if (Number.isFinite(stroke.x)) scaled.x = stroke.x * scaleX
            if (Number.isFinite(stroke.y)) scaled.y = stroke.y * scaleY
            if (Number.isFinite(stroke.width)) scaled.width = stroke.width * scaleX
            if (Number.isFinite(stroke.height)) scaled.height = stroke.height * scaleY
            if (Number.isFinite(stroke.size)) scaled.size = stroke.size * sizeScale
            return scaled
        })
    }

    async _resizeImage(newWidth, newHeight) {
        if (!Number.isSafeInteger(newWidth) || newWidth < 1
            || newWidth > MAX_CANVAS_DIMENSION
            || !Number.isSafeInteger(newHeight) || newHeight < 1
            || newHeight > MAX_CANVAS_DIMENSION) {
            return {
                status: 'failed',
                error: new Error('Image dimensions are invalid'),
            }
        }
        const oldWidth = this._canvas.width
        const oldHeight = this._canvas.height
        if (newWidth === oldWidth && newHeight === oldHeight) {
            return { status: 'committed' }
        }

        const scaleX = newWidth / oldWidth
        const scaleY = newHeight / oldHeight

        const layers = this._cloneLayers(this._layers)
        const mediaOverrides = new Map()
        const preparedResources = []
        const videoDimensions = []
        let mediaOwnershipTransferred = false
        const disposePreparedResources = () => {
            const disposed = new Set()
            for (const resource of preparedResources) {
                if (!resource || disposed.has(resource)) continue
                this._renderer.disposeMediaResource(resource)
                disposed.add(resource)
            }
            preparedResources.length = 0
        }
        try {
            for (const layer of layers) {
                if (layer.sourceType === 'media') {
                    const media = this._renderer._mediaTextures.get(layer.id)
                    if (media?.element) {
                        const rawWidth = Math.round(media.width * scaleX)
                        const rawHeight = Math.round(media.height * scaleY)
                        if (rawWidth > MAX_CANVAS_DIMENSION
                            || rawHeight > MAX_CANVAS_DIMENSION) {
                            throw new Error('Resized media dimensions are too large')
                        }
                        const dstW = Math.max(1, rawWidth)
                        const dstH = Math.max(1, rawHeight)
                        if (layer.mediaType === 'video') {
                            videoDimensions.push({
                                media,
                                width: media.width,
                                height: media.height,
                                nextWidth: dstW,
                                nextHeight: dstH,
                            })
                        } else {
                            const offscreen = new OffscreenCanvas(dstW, dstH)
                            offscreen.getContext('2d').drawImage(
                                media.element, 0, 0, media.width, media.height,
                                0, 0, dstW, dstH)
                            const blob = await offscreen.convertToBlob({ type: 'image/png' })
                            const file = new File([blob], 'resized.png', { type: 'image/png' })
                            const resource = await this._renderer.prepareMediaResource(
                                file, 'image')
                            preparedResources.push(resource)
                            mediaOverrides.set(layer.id, resource)
                            layer.mediaFile = file
                        }
                    }
                    layer.offsetX = Math.round((layer.offsetX || 0) * scaleX)
                    layer.offsetY = Math.round((layer.offsetY || 0) * scaleY)
                } else if (layer.sourceType === 'drawing') {
                    layer.strokes = this._scaleDrawingStrokes(
                        layer.strokes, scaleX, scaleY)
                    layer.offsetX = Math.round((layer.offsetX || 0) * scaleX)
                    layer.offsetY = Math.round((layer.offsetY || 0) * scaleY)
                } else {
                    // Effect layers: scale offsets only
                    layer.offsetX = Math.round((layer.offsetX || 0) * scaleX)
                    layer.offsetY = Math.round((layer.offsetY || 0) * scaleY)
                }
            }

            // Resize masks to match new canvas dimensions
            for (const layer of layers) {
                if (layer.mask) {
                    const tempCanvas = document.createElement('canvas')
                    tempCanvas.width = layer.mask.width
                    tempCanvas.height = layer.mask.height
                    tempCanvas.getContext('2d').putImageData(layer.mask, 0, 0)

                    const resizedCanvas = document.createElement('canvas')
                    resizedCanvas.width = newWidth
                    resizedCanvas.height = newHeight
                    const ctx = resizedCanvas.getContext('2d')
                    ctx.drawImage(tempCanvas, 0, 0, newWidth, newHeight)
                    layer.mask = ctx.getImageData(0, 0, newWidth, newHeight)
                }
            }

            // Calling _prepareLayerSetCandidate transfers detached override ownership,
            // including when candidate preparation rejects.
            mediaOwnershipTransferred = true
            const reuseMediaIds = new Set(this._renderer._mediaTextures.keys())
            for (const layer of layers) {
                if (layer.sourceType === 'drawing') reuseMediaIds.delete(layer.id)
            }
            const candidate = await this._prepareLayerSetCandidate(
                layers, newWidth, newHeight, {
                    reuseMediaIds,
                    mediaOverrides,
                })
            const outcome = await this._commitPreparedLayerMutation(candidate, {
                beforeStage: () => {
                    for (const entry of videoDimensions) {
                        entry.media.width = entry.nextWidth
                        entry.media.height = entry.nextHeight
                    }
                },
                restoreBeforeRollback: () => {
                    for (const entry of videoDimensions) {
                        entry.media.width = entry.width
                        entry.media.height = entry.height
                    }
                },
            })
            if (outcome.status !== 'committed') return outcome
        } catch (err) {
            return { status: 'failed', error: err }
        } finally {
            if (!mediaOwnershipTransferred) disposePreparedResources()
        }
        try {
            toast.success(`Resized to ${newWidth} x ${newHeight}`)
        } catch (err) {
            console.error('[Layers] Failed to show resize confirmation:', err)
        }
        return { status: 'committed' }
    }

    _showCanvasSizeDialog() {
        if (this._projectLifecycleActive || this._projectReplacementActive
            || this._projectLifecycleWaiters > 0) return
        const generation = this._replacementGeneration
        canvasResizeDialog.show({
            width: this._canvas.width,
            height: this._canvas.height,
            onConfirm: async (width, height, anchor) => {
                await this._runPointerMutation(() =>
                    this._changeCanvasSize(width, height, anchor), { generation })
            }
        })
    }

    /**
     * Show the font bundle install dialog
     */
    _showFontInstallDialog() {
        const modal = document.getElementById('fontInstallModal')
        const contentView = document.getElementById('fontInstallContentView')
        const progressView = document.getElementById('fontInstallProgressView')
        const progressBar = document.getElementById('fontInstallProgressBar')
        const progressText = document.getElementById('fontInstallProgressText')
        const beginBtn = document.getElementById('fontInstallBeginBtn')
        const cancelBtn = document.getElementById('fontInstallCancelBtn')
        const closeBtn = document.getElementById('fontInstallCloseBtn')

        // Reset to content view
        contentView.style.display = ''
        progressView.style.display = 'none'

        modal.showModal()

        const close = () => modal.close()

        closeBtn.onclick = close
        modal.onclick = (e) => { if (e.target === modal) close() }
        modal.addEventListener('cancel', (e) => { e.preventDefault(); close() }, { once: true })

        beginBtn.onclick = async () => {
            contentView.style.display = 'none'
            progressView.style.display = ''

            const loader = getFontaineLoader()

            try {
                await loader.install({
                    onProgress: (percent, message) => {
                        progressBar.style.width = `${Math.min(percent, 100)}%`
                        progressText.textContent = message
                    }
                })

                progressText.textContent = 'Done! Refreshing font list...'

                // Refresh any open font-select elements
                this._refreshFontSelects()

                setTimeout(close, 1000)
            } catch (err) {
                progressText.textContent = `Error: ${err.message}`
                console.error('[FontInstall] Failed:', err)
            }
        }

        cancelBtn.onclick = close
    }

    /**
     * Refresh all font-select elements with current font options
     */
    async _refreshFontSelects() {
        const fontSelects = document.querySelectorAll('font-select')
        if (fontSelects.length === 0) return

        const loader = getFontaineLoader()
        const installed = await loader.isInstalled()

        let options = BASE_FONTS
        if (installed) {
            await loader.loadFromCache()
            options = loader.getAllFonts().map(f => ({
                value: f.name,
                text: f.name,
                category: f.category || 'other',
                tags: f.tags || []
            }))
            loader.registerAllFonts()
        }

        fontSelects.forEach(fs => {
            const currentValue = fs.value
            fs.setOptions(options)
            fs.value = currentValue
        })
    }

    async _changeCanvasSize(newWidth, newHeight, anchor = 'center') {
        const oldWidth = this._canvas.width
        const oldHeight = this._canvas.height
        if (newWidth === oldWidth && newHeight === oldHeight) {
            return { status: 'committed' }
        }

        const deltaW = newWidth - oldWidth
        const deltaH = newHeight - oldHeight

        // Calculate offset based on anchor
        let shiftX = 0, shiftY = 0

        // Horizontal positioning
        if (anchor.includes('center') && !anchor.includes('left') && !anchor.includes('right')) {
            shiftX = Math.round(deltaW / 2)
        } else if (anchor.includes('right')) {
            shiftX = deltaW
        }
        // else left: shiftX = 0

        // Vertical positioning
        if (anchor === 'center' || anchor.includes('middle')) {
            shiftY = Math.round(deltaH / 2)
        } else if (anchor.includes('bottom')) {
            shiftY = deltaH
        }
        // else top: shiftY = 0

        const layers = this._cloneLayers(this._layers)

        // Adjust all layer offsets
        for (const layer of layers) {
            layer.offsetX = (layer.offsetX || 0) + shiftX
            layer.offsetY = (layer.offsetY || 0) + shiftY
        }

        // Reposition masks onto new canvas dimensions
        for (const layer of layers) {
            if (layer.mask) {
                const tempCanvas = document.createElement('canvas')
                tempCanvas.width = layer.mask.width
                tempCanvas.height = layer.mask.height
                tempCanvas.getContext('2d').putImageData(layer.mask, 0, 0)

                const resizedCanvas = document.createElement('canvas')
                resizedCanvas.width = newWidth
                resizedCanvas.height = newHeight
                const ctx = resizedCanvas.getContext('2d')
                ctx.drawImage(tempCanvas, shiftX, shiftY)
                layer.mask = ctx.getImageData(0, 0, newWidth, newHeight)
            }
        }

        let candidate
        try {
            candidate = await this._prepareLayerSetCandidate(
                layers, newWidth, newHeight, {
                    reuseMediaIds: new Set(this._renderer._mediaTextures.keys()),
                })
        } catch (err) {
            return { status: 'failed', error: err }
        }
        const outcome = await this._commitPreparedLayerMutation(candidate)
        if (outcome.status !== 'committed') return outcome

        try {
            toast.success(`Canvas resized to ${newWidth} x ${newHeight}`)
        } catch (err) {
            console.error('[Layers] Failed to show canvas resize confirmation:', err)
        }
        return { status: 'committed' }
    }

}

// Initialize app when DOM is ready
const app = new LayersApp()

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => app.init())
} else {
    app.init()
}

// Export for debugging
window.layersApp = app
