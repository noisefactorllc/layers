/**
 * Layers App
 * Main entry point
 *
 * @module app
 */

import { LayersRenderer } from './noisemaker/renderer.js'
import { createMediaLayer, createEffectLayer, createChildEffect, createDrawingLayer, decodeMasks } from './layers/layer-model.js'
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
import { SeanceDialog } from 'handfish'  // Register <seance-dialog> custom element
import { createLayersOnlineAdapter } from './collab/onlineAdapter.js'

const ONLINE_COLLABORATION_FEATURE = 'onlineCollaboration'

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
        this._moveTool = null
        this._currentTool = 'selection' // 'selection' | 'move' | 'clone' | 'transform' | 'brush' | 'eraser' | 'shape' | 'fill' | 'eyedropper'
        this._previousTool = 'selection'

        // Global foreground color
        this._foregroundColor = '#000000'

        // Drawing layer counter
        this._drawingLayerCounter = 0

        // Layer reorder FSM state
        this._reorderState = 'IDLE'  // IDLE | DRAGGING | PROCESSING | ROLLING_BACK
        this._reorderSnapshot = null  // { layers, dsl }
        this._reorderSource = null    // { layerId, index }

        // Undo/redo
        this._undoManager = new UndoManager(50)
        this._undoDebounceTimer = null
        this._restoring = false

        // Mask editing
        this._maskEditMode = false
        this._maskEditLayerId = null

        // Seance online collaboration adapter — created in init() when the
        // onlineCollaboration feature flag is enabled (default: on).
        this._onlineAdapter = null

        // The sole media candidate currently being decoded. Keeping the
        // candidate outside `_layers` makes replacement transactional until
        // the renderer has validated it.
        this._pendingMediaLoad = null
    }

    /**
     * Mark the project as having unsaved changes
     * @private
     */
    _markDirty() {
        this._isDirty = true
    }

    /**
     * Mark the project as saved (no unsaved changes)
     * @private
     */
    _markClean() {
        this._isDirty = false
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
        this._undoManager.pushState({
            layers: this._cloneLayers(this._layers),
            canvasWidth: this._canvas.width,
            canvasHeight: this._canvas.height
        })
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

    /**
     * Restore a snapshot from the undo stack
     * @param {object} snapshot - { layers, canvasWidth, canvasHeight }
     * @private
     */
    async _restoreState(snapshot) {
        // Unload all current media and drawing textures (drawing layers are
        // registered in _mediaTextures too; re-rasterized below if they survive)
        for (const layer of this._layers) {
            if (layer.sourceType === 'media' || layer.sourceType === 'drawing') {
                this._renderer.unloadMedia(layer.id)
            }
        }

        // Restore layers (deep clone to avoid aliasing with the stack)
        this._layers = this._cloneLayers(snapshot.layers)

        // Resize canvas if dimensions changed
        if (snapshot.canvasWidth !== this._canvas.width ||
            snapshot.canvasHeight !== this._canvas.height) {
            this._renderer.stop()
            this._resizeCanvas(snapshot.canvasWidth, snapshot.canvasHeight)
        }

        // Reload media for any media layers
        for (const layer of this._layers) {
            if (layer.sourceType === 'media' && layer.mediaFile) {
                await this._renderer.loadMedia(layer.id, layer.mediaFile, layer.mediaType)
            }
        }

        // Re-rasterize drawing layers after undo restore
        for (const layer of this._layers) {
            if (layer.sourceType === 'drawing' && layer.strokes?.length > 0) {
                await this._rasterizeDrawingLayer(layer)
            }
        }

        // Re-upload mask textures after undo restore
        for (const layer of this._layers) {
            if (layer.mask) {
                this._renderer.uploadMaskTexture(layer.id, layer.mask)
            } else {
                this._renderer.removeMaskTexture(layer.id)
            }
        }

        this._updateLayerStack()
        await this._rebuild({ force: true })

        // Restart renderer if it was stopped
        if (!this._renderer.isRunning) {
            await new Promise(resolve => requestAnimationFrame(resolve))
            this._renderer.start()
        }

        this._updateUndoMenuState()
        this._markDirty()
    }

    /**
     * Undo the last action
     * @private
     */
    async _undo() {
        if (this._restoring) return
        this._finalizePendingUndo()
        const snapshot = this._undoManager.undo()
        if (snapshot) {
            this._restoring = true
            try { await this._restoreState(snapshot) }
            finally { this._restoring = false }
        }
    }

    /**
     * Redo the last undone action
     * @private
     */
    async _redo() {
        if (this._restoring) return
        this._finalizePendingUndo()
        const snapshot = this._undoManager.redo()
        if (snapshot) {
            this._restoring = true
            try { await this._restoreState(snapshot) }
            finally { this._restoring = false }
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
            getLayerPosition,
            extractSelection: (destructive) => this._extractSelectionToLayer(destructive),
            showNoLayerDialog: () => this._showNoLayerSelectedDialog(),
            selectTopmostLayer: () => this._selectTopmostLayer(),
            isLayerBlocked: (layer) => {
                if (layer?.mediaType === 'video') {
                    toast.warning('Move tool not available for video clip layers')
                    return true
                }
                return false
            },
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
            getLayerPosition,
            extractSelection: (destructive) => this._extractSelectionToLayer(destructive),
            showNoLayerDialog: () => this._showNoLayerSelectedDialog(),
            selectTopmostLayer: () => this._selectTopmostLayer(),
            duplicateLayer: () => this._duplicateActiveLayer(),
            onComplete: () => this._onCloneComplete(),
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
            cancelTransform: () => this._cancelTransform(),
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
            }
        })

        // Initialize brush tool
        this._brushTool = new BrushTool({
            overlay: this._selectionOverlay,
            ensureDrawingLayer: () => this._ensureDrawingLayer(),
            rasterizeDrawingLayer: (layer) => this._rasterizeDrawingLayer(layer),
            rebuild: (opts) => this._rebuild(opts),
            pushUndoState: () => this._pushUndoState(),
            finalizePendingUndo: () => this._finalizePendingUndo(),
            markDirty: () => this._markDirty()
        })

        // Initialize eraser tool
        this._eraserTool = new EraserTool({
            overlay: this._selectionOverlay,
            getActiveLayer: () => this._getActiveLayer(),
            rasterizeDrawingLayer: (layer) => this._rasterizeDrawingLayer(layer),
            rebuild: (opts) => this._rebuild(opts),
            pushUndoState: () => this._pushUndoState(),
            finalizePendingUndo: () => this._finalizePendingUndo(),
            markDirty: () => this._markDirty()
        })

        // Initialize shape tool
        this._shapeTool = new ShapeTool({
            overlay: this._selectionOverlay,
            ensureDrawingLayer: () => this._ensureDrawingLayer(),
            rasterizeDrawingLayer: (layer) => this._rasterizeDrawingLayer(layer),
            rebuild: (opts) => this._rebuild(opts),
            pushUndoState: () => this._pushUndoState(),
            finalizePendingUndo: () => this._finalizePendingUndo(),
            markDirty: () => this._markDirty()
        })

        // Initialize fill tool
        this._fillTool = new FillTool({
            overlay: this._selectionOverlay,
            canvas: this._canvas,
            addMediaLayerFromCanvas: (c, n) => this._addMediaLayerFromCanvas(c, n),
            pushUndoState: () => this._pushUndoState(),
            finalizePendingUndo: () => this._finalizePendingUndo(),
            markDirty: () => this._markDirty()
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
        this._exportImageDialog = new ExportImageDialog({
            files: this._files,
            canvas: this._canvas,
            getResolution: () => ({ width: this._canvas.width, height: this._canvas.height }),
            setResolution: (w, h) => this._resizeCanvas(w, h),
            onComplete: (format) => toast.success(`Exported as ${format.toUpperCase()}`),
            onCancel: () => {}
        })
        this._exportVideoDialog = new ExportVideoDialog({
            files: this._files,
            renderer: this._renderer,
            canvas: this._canvas,
            getResolution: () => ({ width: this._canvas.width, height: this._canvas.height }),
            setResolution: (w, h) => this._resizeCanvas(w, h),
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
                welcomeDialog.show({ fallThrough: true })
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
    _showOpenDialog({ replaceProject = false, leaveOnline = false } = {}) {
        openDialog.show({
            canClose: replaceProject,
            onOpen: async (file, mediaType) => {
                await this._handleOpenMedia(file, mediaType, { replaceProject, leaveOnline })
            },
            onSolid: async (width, height) => {
                if (replaceProject) this._commitProjectReplacement({ leaveOnline })
                await this._handleCreateSolidBase(width, height)
            },
            onGradient: async (width, height) => {
                if (replaceProject) this._commitProjectReplacement({ leaveOnline })
                await this._handleCreateGradientBase(width, height)
            },
            onTransparent: async (width, height) => {
                if (replaceProject) this._commitProjectReplacement({ leaveOnline })
                await this._handleCreateTransparentBase(width, height)
            },
            onClipboard: async () => {
                await this._handleNewFromClipboard({ replaceProject, leaveOnline })
            },
            onLoadProject: () => {
                this._showLoadProjectDialog(true, { replaceProject, leaveOnline })
            }
        })
    }

    /**
     * Run the shared guards before starting any flow that can replace the
     * current project.
     * @param {Function} startFlow - replacement chooser/picker callback
     * @returns {Promise<boolean>} whether replacement was accepted
     * @private
     */
    async _startProjectReplacement(startFlow) {
        const leaveOnline = Boolean(this._onlineAdapter?.isOnline())
        if (!await this._confirmLeaveOnlineSession()) return false
        if (!await this._confirmUnsavedChanges()) return false
        await startFlow({ leaveOnline })
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
    _openMediaFilePicker({ replaceProject = false, leaveOnline = false } = {}) {
        const input = document.createElement('input')
        input.type = 'file'
        input.accept = 'image/*,video/*'
        input.addEventListener('cancel', () => {
            this._showOpenDialog({ replaceProject, leaveOnline })
        })
        input.addEventListener('change', async () => {
            const file = input.files?.[0]
            if (!file) {
                this._showOpenDialog({ replaceProject, leaveOnline })
                return
            }
            const mediaType = file.type.startsWith('video') ? 'video' : 'image'
            const result = await this._handleOpenMedia(file, mediaType, { replaceProject, leaveOnline })
            if (result === 'failed') {
                this._showOpenDialog({ replaceProject, leaveOnline })
            }
        })
        input.click()
    }

    /**
     * Create a base layer and initialize the project
     * @param {object} layer - Layer object to use as base
     * @param {number} width - Canvas width
     * @param {number} height - Canvas height
     * @param {string} successMessage - Toast message on success
     * @private
     */
    async _initializeBaseLayer(layer, width, height, successMessage) {
        this._cancelPendingMediaLoad()
        this._layers = [layer]
        this._updateLayerStack()

        // Select the layer
        if (this._layerStack) {
            this._layerStack.selectedLayerId = layer.id
        }

        // Set canvas dimensions first
        this._resizeCanvas(width, height)
        // Wait for any pending microtasks (canvas observer uses queueMicrotask)
        await new Promise(resolve => queueMicrotask(resolve))
        // Compile pipeline at correct dimensions
        await this._rebuild()
        // Wait for next frame to ensure WebGL state is stable
        await new Promise(resolve => requestAnimationFrame(resolve))
        this._renderer.start()

        this._currentProjectId = null
        this._currentProjectName = null
        this._markDirty()

        this._undoManager.clear()
        this._pushUndoState()

        openDialog.element.close()
        toast.success(successMessage)
    }

    /**
     * Mark any in-flight media candidate as superseded. Its own continuation
     * performs cleanup after the renderer's load promise settles.
     * @param {object|null} preserve - operation allowed to keep committing
     * @private
     */
    _cancelPendingMediaLoad(preserve = null) {
        if (this._pendingMediaLoad && this._pendingMediaLoad !== preserve) {
            this._pendingMediaLoad.cancelled = true
            this._pendingMediaLoad = null
        }
    }

    /**
     * Commit the destructive portion of a project replacement.
     * @private
     */
    _commitProjectReplacement({ leaveOnline = false, preserveMediaLoad = null } = {}) {
        if (leaveOnline && this._onlineAdapter?.isOnline()) {
            this._onlineAdapter.goOffline()
        }
        this._resetLayers({ preserveMediaLoad })
    }

    /**
     * Create a solid color base layer
     * @param {number} width - Canvas width
     * @param {number} height - Canvas height
     * @private
     */
    async _handleCreateSolidBase(width = 1024, height = 1024) {
        const layer = createEffectLayer('synth/solid')
        layer.name = 'Solid'
        layer.effectParams = { color: [0.2, 0.2, 0.2], alpha: 1 }

        await this._initializeBaseLayer(layer, width, height, 'Created solid base layer')
    }

    /**
     * Create a gradient base layer
     * @param {number} width - Canvas width
     * @param {number} height - Canvas height
     * @private
     */
    async _handleCreateGradientBase(width = 1024, height = 1024) {
        const layer = createEffectLayer('synth/gradient')
        layer.name = 'Gradient'

        await this._initializeBaseLayer(layer, width, height, 'Created gradient base layer')
    }

    /**
     * Create a transparent base layer
     * @param {number} width - Canvas width
     * @param {number} height - Canvas height
     * @private
     */
    async _handleCreateTransparentBase(width = 1024, height = 1024) {
        const layer = createEffectLayer('synth/solid')
        layer.name = 'Transparent'
        layer.effectParams = { color: [0, 0, 0], alpha: 0 }

        await this._initializeBaseLayer(layer, width, height, 'Created transparent base layer')
    }

    /**
     * Handle opening a media file
     * @param {File} file - Media file
     * @param {string} mediaType - 'image' or 'video'
     * @param {{replaceProject?:boolean, leaveOnline?:boolean}} options
     * @returns {Promise<'opened'|'failed'|'cancelled'>}
     * @private
     */
    async _handleOpenMedia(file, mediaType, { replaceProject = false, leaveOnline = false } = {}) {
        const layer = createMediaLayer(file, mediaType)
        this._cancelPendingMediaLoad()
        const operation = { cancelled: false, committed: false }
        this._pendingMediaLoad = operation

        const isCurrent = () => !operation.cancelled && this._pendingMediaLoad === operation
        const abandon = () => {
            if (!operation.committed) this._renderer.unloadMedia(layer.id)
            if (this._pendingMediaLoad === operation) this._pendingMediaLoad = null
        }

        // Load media into renderer
        let dimensions = { width: 0, height: 0 }
        try {
            dimensions = await this._renderer.loadMedia(layer.id, file, mediaType)
        } catch (err) {
            const current = isCurrent()
            abandon()
            if (!current) return 'cancelled'
            console.error('[Layers] Failed to load media:', err)
            toast.error('Failed to load media: ' + err.message)
            return 'failed'
        }

        if (!isCurrent()) {
            abandon()
            return 'cancelled'
        }

        if (replaceProject) {
            this._commitProjectReplacement({ leaveOnline, preserveMediaLoad: operation })
        }
        this._layers = [layer]
        operation.committed = true
        this._updateLayerStack()

        // Select the layer
        if (this._layerStack) {
            this._layerStack.selectedLayerId = layer.id
        }

        // Resize canvas to match base layer media dimensions
        if (dimensions.width > 0 && dimensions.height > 0) {
            this._resizeCanvas(dimensions.width, dimensions.height)
        }

        // Wait for any pending microtasks (canvas observer uses queueMicrotask)
        await new Promise(resolve => queueMicrotask(resolve))
        if (!isCurrent()) return 'cancelled'
        // Compile pipeline at correct dimensions
        await this._rebuild()
        if (!isCurrent()) return 'cancelled'

        // Wait for next frame to ensure WebGL state is stable
        await new Promise(resolve => requestAnimationFrame(resolve))
        if (!isCurrent()) return 'cancelled'
        this._renderer.start()

        // Reset project state and update filename
        this._currentProjectId = null
        this._currentProjectName = null
        this._markDirty()

        this._undoManager.clear()
        this._pushUndoState()

        // Close the open dialog
        openDialog.element.close()
        toast.success(`Opened ${file.name}`)
        if (this._pendingMediaLoad === operation) this._pendingMediaLoad = null
        return 'opened'
    }

    /**
     * Handle new project from clipboard image
     * @private
     */
    async _handleNewFromClipboard({ replaceProject = false, leaveOnline = false } = {}) {
        const result = await pasteFromClipboard()
        if (!result) {
            toast.error('No image found in clipboard')
            return
        }

        const file = new File([result.blob], 'Clipboard Image.png', { type: 'image/png' })
        await this._handleOpenMedia(file, 'image', { replaceProject, leaveOnline })
    }

    /**
     * Copy composite canvas to clipboard
     * @private
     */
    async _handleCopyImage() {
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
    async _handleAddMediaLayer(file, mediaType) {
        if (this._onlineAdapter?.isOnline()) {
            toast.warning('Media layers aren’t supported while a Layers session is online')
            return
        }
        this._finalizePendingUndo()
        const layer = createMediaLayer(file, mediaType)
        this._layers.push(layer)

        // Load media
        await this._renderer.loadMedia(layer.id, file, mediaType)

        // Update and rebuild
        this._updateLayerStack()
        await this._rebuild()
        this._markDirty()
        this._pushUndoState()

        // Select the new layer
        if (this._layerStack) {
            this._layerStack.selectedLayerId = layer.id
        }

        toast.success(`Added layer: ${layer.name}`)
    }

    /**
     * Handle adding an effect layer
     * @param {string} effectId - Effect ID
     * @private
     */
    async _handleAddEffectLayer(effectId) {
        this._finalizePendingUndo()
        const layer = createEffectLayer(effectId)
        this._layers.push(layer)

        // Update and rebuild
        this._updateLayerStack()
        await this._rebuild()
        this._markDirty()
        this._pushUndoState()

        // Select the new layer
        if (this._layerStack) {
            this._layerStack.selectedLayerId = layer.id
        }

        toast.success(`Added layer: ${layer.name}`)
    }

    async _handleAutoCorrection(correctionFn) {
        const result = correctionFn(this._canvas)
        if (!result) {
            toast.info('No correction needed')
            return null
        }
        this._finalizePendingUndo()
        const layer = createEffectLayer(result.effectId)
        layer.name = result.name
        Object.assign(layer.effectParams, result.effectParams)
        this._layers.push(layer)

        this._updateLayerStack()
        await this._rebuild()
        this._markDirty()
        this._pushUndoState()

        if (this._layerStack) {
            this._layerStack.selectedLayerId = layer.id
        }
        toast.success(`Applied: ${result.name}`)
        // Return the newly-created adjustment layer so callers (e.g. the
        // agent's auto* commands) can report whether work was done.
        return layer
    }

    // ── Mask management ─────────────────────────────────────────────────

    /**
     * Add a fully white (revealed) mask to a layer.
     * @param {string} layerId
     */
    async _addLayerMask(layerId) {
        const layer = this._layers.find(l => l.id === layerId)
        if (!layer || layer.mask) return

        this._finalizePendingUndo()

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
        layer.mask = mask
        layer.maskEnabled = true

        this._renderer.uploadMaskTexture(layerId, mask)
        this._updateLayerStack()
        await this._rebuild()
        this._markDirty()
        this._pushUndoState()
        this._enterMaskEditMode(layerId)
        toast.success('Layer mask added — paint to hide areas, Escape to exit')
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

        this._finalizePendingUndo()
        layer.mask = selMask
        layer.maskEnabled = true

        this._renderer.uploadMaskTexture(layerId, selMask)
        this._updateLayerStack()
        await this._rebuild()
        this._markDirty()
        this._pushUndoState()
        toast.success('Mask created from selection')
    }

    /**
     * Delete a layer's mask.
     * @param {string} layerId
     */
    async _deleteLayerMask(layerId) {
        const layer = this._layers.find(l => l.id === layerId)
        if (!layer || !layer.mask) return

        this._finalizePendingUndo()
        layer.mask = null
        layer.maskEnabled = true
        layer.maskVisible = false

        if (this._maskEditMode && this._maskEditLayerId === layerId) {
            this._exitMaskEditMode()
        }

        this._renderer.removeMaskTexture(layerId)
        this._updateLayerStack()
        await this._rebuild()
        this._markDirty()
        this._pushUndoState()
        toast.info('Layer mask deleted')
    }

    /**
     * Invert a layer's mask (swap black/white).
     * @param {string} layerId
     */
    async _invertLayerMask(layerId) {
        const layer = this._layers.find(l => l.id === layerId)
        if (!layer?.mask) return

        this._finalizePendingUndo()
        const data = layer.mask.data
        for (let i = 0; i < data.length; i += 4) {
            data[i] = 255 - data[i]         // R
            data[i + 1] = 255 - data[i + 1] // G
            data[i + 2] = 255 - data[i + 2] // B
            // A stays 255
        }

        this._renderer.uploadMaskTexture(layerId, layer.mask)
        await this._rebuild()
        this._markDirty()
        this._pushUndoState()
        toast.success('Mask inverted')
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

    async _featherLayerMask(layerId) {
        const layer = this._layers.find(l => l.id === layerId)
        if (!layer?.mask) return
        const radius = await selectionParamDialog.show({ title: 'Feather Mask', label: 'Radius', defaultValue: 5, min: 1, max: 100 })
        if (radius === null) return
        this._finalizePendingUndo()
        const converted = this._maskToSelectionFormat(layer.mask)
        layer.mask = this._selectionFormatToMask(featherMask(converted, radius))
        this._renderer.uploadMaskTexture(layerId, layer.mask)
        if (this._maskEditMode) this._renderMaskOverlay(layer)
        await this._rebuild()
        this._markDirty()
        this._pushUndoState()
    }

    async _expandLayerMask(layerId) {
        const layer = this._layers.find(l => l.id === layerId)
        if (!layer?.mask) return
        const radius = await selectionParamDialog.show({ title: 'Expand Mask', label: 'Radius', defaultValue: 5, min: 1, max: 100 })
        if (radius === null) return
        this._finalizePendingUndo()
        const converted = this._maskToSelectionFormat(layer.mask)
        layer.mask = this._selectionFormatToMask(expandMask(converted, radius))
        this._renderer.uploadMaskTexture(layerId, layer.mask)
        if (this._maskEditMode) this._renderMaskOverlay(layer)
        await this._rebuild()
        this._markDirty()
        this._pushUndoState()
    }

    async _contractLayerMask(layerId) {
        const layer = this._layers.find(l => l.id === layerId)
        if (!layer?.mask) return
        const radius = await selectionParamDialog.show({ title: 'Contract Mask', label: 'Radius', defaultValue: 5, min: 1, max: 100 })
        if (radius === null) return
        this._finalizePendingUndo()
        const converted = this._maskToSelectionFormat(layer.mask)
        layer.mask = this._selectionFormatToMask(contractMask(converted, radius))
        this._renderer.uploadMaskTexture(layerId, layer.mask)
        if (this._maskEditMode) this._renderMaskOverlay(layer)
        await this._rebuild()
        this._markDirty()
        this._pushUndoState()
    }

    async _smoothLayerMask(layerId) {
        const layer = this._layers.find(l => l.id === layerId)
        if (!layer?.mask) return
        const radius = await selectionParamDialog.show({ title: 'Smooth Mask', label: 'Radius', defaultValue: 5, min: 1, max: 100 })
        if (radius === null) return
        this._finalizePendingUndo()
        const converted = this._maskToSelectionFormat(layer.mask)
        layer.mask = this._selectionFormatToMask(smoothMask(converted, radius))
        this._renderer.uploadMaskTexture(layerId, layer.mask)
        if (this._maskEditMode) this._renderMaskOverlay(layer)
        await this._rebuild()
        this._markDirty()
        this._pushUndoState()
    }

    /**
     * Toggle mask enabled/disabled.
     * @param {string} layerId
     */
    async _toggleMaskEnabled(layerId) {
        const layer = this._layers.find(l => l.id === layerId)
        if (!layer?.mask) return

        this._finalizePendingUndo()
        layer.maskEnabled = !layer.maskEnabled
        this._updateLayerStack()
        await this._rebuild()
        this._markDirty()
        this._pushUndoState()
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
        }
    }

    _showLayerContextMenu(layerId, hasMask, x, y) {
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

            switch (action) {
                case 'add-mask': await this._addLayerMask(layerId); break
                case 'mask-from-selection': await this._maskFromSelection(layerId); break
            }
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
                this._handleMaskStroke(stroke, isEraser)
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
    _exitMaskEditMode() {
        if (!this._maskEditMode) return

        this._closeContextMenus()

        const layer = this._layers.find(l => l.id === this._maskEditLayerId)
        if (layer) {
            layer.maskVisible = false
            // Apply mask: re-upload latest mask data so renderer composites with it
            if (layer.mask) {
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
        this._updateLayerStack()
        this._rebuild({ force: true })
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

        this._finalizePendingUndo()

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
        await this._rebuild()
        this._markDirty()
        this._pushUndoStateDebounced()
    }

    // ── End mask management ─────────────────────────────────────────────

    /**
     * Add a child effect to a parent layer
     * @param {string} parentLayerId - Parent layer ID
     * @param {string} effectId - Effect ID to add
     * @private
     */
    async _handleAddChildEffect(parentLayerId, effectId) {
        const parent = this._layers.find(l => l.id === parentLayerId)
        if (!parent) return

        this._finalizePendingUndo()

        const child = createChildEffect(effectId)
        if (!parent.children) parent.children = []
        parent.children.push(child)

        this._updateLayerStack()
        await this._rebuild()
        this._markDirty()
        this._pushUndoState()

        // Select the new child
        if (this._layerStack) {
            this._layerStack.selectedLayerId = child.id
        }

        toast.success(`Added effect: ${child.name}`)
    }

    /**
     * Reset all layers (for new project)
     * @private
     */
    _resetLayers({ preserveMediaLoad = null } = {}) {
        this._cancelPendingMediaLoad(preserveMediaLoad)
        if (this._undoDebounceTimer) {
            clearTimeout(this._undoDebounceTimer)
            this._undoDebounceTimer = null
        }
        this._layers.forEach(l => {
            if (l.sourceType === 'media' || l.sourceType === 'drawing') {
                this._renderer.unloadMedia(l.id)
            }
        })
        // Clean up mask textures
        for (const layer of this._layers) {
            if (layer.mask) {
                this._renderer.removeMaskTexture(layer.id)
            }
        }
        if (this._maskEditMode) {
            this._exitMaskEditMode()
        }
        this._selectionManager?.clearSelection()
        this._copyOrigin = null
        if (this._layerStack) this._layerStack.selectedLayerId = null
        this._layers = []
        this._undoManager.clear()
        this._updateUndoMenuState()
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

            this._finalizePendingUndo()
            const child = parent.children[childIndex]
            parent.children.splice(childIndex, 1)

            this._updateLayerStack()
            await this._rebuild()
            this._markDirty()
            this._pushUndoState()

            toast.info(`Deleted effect: ${child.name}`)
            return
        }

        // Existing top-level layer delete logic
        const index = this._layers.findIndex(l => l.id === layerId)
        if (index <= 0) return // Can't delete base layer

        this._finalizePendingUndo()
        const layer = this._layers[index]

        // Unload media/drawing texture if needed
        if (layer.sourceType === 'media' || layer.sourceType === 'drawing') {
            this._renderer.unloadMedia(layerId)
        }

        // Clean up mask texture if present
        if (layer.mask) {
            this._renderer.removeMaskTexture(layer.id)
        }
        if (this._maskEditMode && this._maskEditLayerId === layer.id) {
            this._exitMaskEditMode()
        }

        // Remove layer
        this._layers.splice(index, 1)

        // Update and rebuild
        this._updateLayerStack()
        await this._rebuild()
        this._markDirty()
        this._pushUndoState()

        toast.info(`Deleted layer: ${layer.name}`)
    }

    /**
     * Handle layer changes (visibility, blend mode, opacity, effectParams)
     * @param {object} detail - Change detail
     * @private
     */
    async _handleLayerChange(detail) {
        const isDebounced = detail.property === 'effectParams' || detail.property === 'opacity'
        if (!isDebounced) {
            this._finalizePendingUndo()
        }

        // Find the target — either a child or a top-level layer
        let layer
        if (detail.parentLayerId) {
            const parent = this._layers.find(l => l.id === detail.parentLayerId)
            layer = parent?.children?.find(c => c.id === detail.layerId)
        } else {
            layer = this._layers.find(l => l.id === detail.layerId)
        }

        if (layer) {
            layer[detail.property] = detail.value
        }

        this._markDirty()

        // Handle child-specific property changes
        if (detail.parentLayerId) {
            if (detail.property === 'effectParams') {
                this._renderer.updateLayerParams(detail.layerId, detail.value)
                this._renderer.syncDsl()
                this._pushUndoStateDebounced()
                this._onlineAdapter?.schedulePublish()
            } else {
                await this._rebuild()
                this._pushUndoState()
            }
            return
        }

        // Determine if this requires a full rebuild or just a parameter update
        switch (detail.property) {
            case 'effectParams':
                // Update parameters directly without recompiling
                this._renderer.updateLayerParams(detail.layerId, detail.value)
                // Keep DSL in sync to prevent spurious rebuild on next structural change
                this._renderer.syncDsl()
                this._pushUndoStateDebounced()
                this._onlineAdapter?.schedulePublish()
                break

            case 'opacity':
                // Rebuild DSL with new opacity baked into blendMode mixAmt
                await this._rebuild()
                this._pushUndoStateDebounced()
                break

            case 'visibility':
            case 'blendMode':
                // Structural changes require full rebuild
                await this._rebuild()
                this._pushUndoState()
                break

            default:
                // Unknown property - rebuild to be safe
                await this._rebuild()
                this._pushUndoState()
        }
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
        this._reorderSnapshot = {
            layers: JSON.parse(JSON.stringify(this._layers)),
            dsl: this._renderer._currentDsl
        }
        this._reorderSource = { layerId, index: sourceIndex }
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

        // Clear any drag-over indicators
        this._clearDragIndicators()

        console.debug('[Layers] FSM: DRAGGING → IDLE (cancelled)')
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

        const sourceId = this._reorderSource?.layerId
        if (!sourceId) {
            this._cancelDrag()
            return
        }

        this._reorderState = 'PROCESSING'
        console.debug('[Layers] FSM: DRAGGING → PROCESSING', { sourceId, targetId, dropPosition })

        // Clear visual indicators
        this._clearDragIndicators()

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
        try {
            const newDsl = this._renderer.buildDslFromLayers(newLayers)
            const result = await this._renderer.tryCompile(newDsl)

            if (result.success) {
                this._finalizePendingUndo()

                // Commit the change
                this._layers = newLayers
                // Force rebuild to update layer-step mapping even if DSL is unchanged
                // (DSL may be string-identical after reorder when layers have same effects)
                await this._rebuild({ force: true })
                this._updateLayerStack()
                this._updateLayerZIndex()
                this._markDirty()
                this._pushUndoState()

                this._reorderState = 'IDLE'
                this._reorderSnapshot = null
                this._reorderSource = null

                console.debug('[Layers] FSM: PROCESSING → IDLE (success)')
            } else {
                // Validation failed - rollback
                await this._rollback(result.error || 'DSL validation failed')
            }
        } catch (err) {
            await this._rollback(err.message || String(err))
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

        // Restore snapshot
        if (this._reorderSnapshot) {
            this._layers = this._reorderSnapshot.layers
            await this._rebuild()
            this._updateLayerStack()
        }

        // Show error to user
        toast.error(`Layer reorder failed: ${error}. Changes reverted.`)

        this._reorderState = 'IDLE'
        this._reorderSnapshot = null
        this._reorderSource = null

        console.debug('[Layers] FSM: ROLLING_BACK → IDLE')
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
     * Save visibility state of all layers
     * @returns {Map<string, boolean>}
     * @private
     */
    _saveVisibility() {
        return new Map(this._layers.map(l => [l.id, l.visible]))
    }

    /**
     * Restore previously saved visibility state
     * @param {Map<string, boolean>} snapshot
     * @private
     */
    _restoreVisibility(snapshot) {
        for (const l of this._layers) {
            if (snapshot.has(l.id)) l.visible = snapshot.get(l.id)
        }
    }

    /**
     * Rebuild and render
     * @param {object} [options={}] - Options passed to renderer
     * @param {boolean} [options.force=false] - Force rebuild even if DSL unchanged
     * @private
     */
    async _rebuild(options = {}) {
        const result = await this._renderer.setLayers(this._layers, options)
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
    }

    /**
     * Rasterize a drawing layer's strokes to a canvas and register the texture.
     * @param {object} layer - Drawing layer with strokes array
     * @private
     */
    async _rasterizeDrawingLayer(layer) {
        if (layer.sourceType !== 'drawing') return
        if (!layer.strokes || layer.strokes.length === 0) {
            layer.drawingCanvas = null
            return
        }
        if (!this._strokeRenderer) {
            const { StrokeRenderer } = await import('./drawing/stroke-renderer.js')
            this._strokeRenderer = new StrokeRenderer()
        }
        const offscreen = this._strokeRenderer.rasterize(
            layer.strokes, this._canvas.width, this._canvas.height
        )

        // Convert OffscreenCanvas to HTMLCanvasElement for WebGL texture compatibility
        const w = this._canvas.width
        const h = this._canvas.height
        const canvas = document.createElement('canvas')
        canvas.width = w
        canvas.height = h
        const ctx = canvas.getContext('2d')
        ctx.drawImage(offscreen, 0, 0)

        layer.drawingCanvas = canvas

        // Register as texture in the renderer
        this._renderer._mediaTextures.set(layer.id, {
            type: 'image',
            element: canvas,
            width: w,
            height: h
        })
    }

    /**
     * Create a media layer from an HTML canvas element.
     * Used by fill tool and other tools that generate raster content.
     * @param {HTMLCanvasElement} canvas - Source canvas with content
     * @param {string} [name] - Layer name
     * @private
     */
    async _addMediaLayerFromCanvas(canvas, name) {
        if (this._blockedMediaOnline('Adding this layer')) return
        const layer = createMediaLayer(null, 'image', name || 'Fill')
        layer.mediaFile = null
        this._layers.push(layer)

        this._renderer._mediaTextures.set(layer.id, {
            type: 'image',
            element: canvas,
            width: canvas.width,
            height: canvas.height
        })

        this._updateLayerStack()
        await this._rebuild({ force: true })

        if (this._layerStack) {
            this._layerStack.selectedLayerId = layer.id
        }
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
        const showSubmenu = (trigger, submenu, { focusFirst = false } = {}) => {
            hideSubmenu()
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
            submenu.classList.remove('hide')

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

            activeSubmenu = submenu
            activeSubmenuTrigger = trigger
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
                    if (shouldOpen) clampFilterDropdown(menu, items)
                })
            }
        })
        document.querySelectorAll('.has-submenu[data-submenu]').forEach(trigger => {
            const submenuId = trigger.dataset.submenu
            const menu = trigger.closest('.menu')
            const submenu = menu?.querySelector(`:scope > .submenu[data-submenu-id="${submenuId}"]`)
            if (!submenu) return

            trigger.addEventListener('mouseenter', () => {
                showSubmenu(trigger, submenu)
            })

            if (menu.id === 'filterMenu') {
                trigger.addEventListener('click', (e) => {
                    e.stopPropagation()
                    showSubmenu(trigger, submenu, { focusFirst: e.detail === 0 })
                })
            }

            trigger.addEventListener('mouseleave', (e) => {
                if (e.relatedTarget && submenu.contains(e.relatedTarget)) return
                hideSubmenu()
            })

            submenu.addEventListener('mouseleave', (e) => {
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

        filterTitle?.addEventListener('keydown', (e) => {
            if (e.key === ' ' || e.key === 'Enter') {
                e.stopPropagation()
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
                    e.stopPropagation()
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
                        e.stopPropagation()
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
            onNewCanvas: () => this._startProjectReplacement(({ leaveOnline }) =>
                this._showOpenDialog({ replaceProject: this._layers.length > 0 || leaveOnline, leaveOnline })),
            onOpenFile: () => this._startProjectReplacement(({ leaveOnline }) =>
                this._openMediaFilePicker({ replaceProject: this._layers.length > 0 || leaveOnline, leaveOnline })),
            onDismiss: () => this._showOpenDialog(),
        })
        document.getElementById('welcomeMenuItem')?.addEventListener('click', () => {
            welcomeDialog.show()
        })

        // File menu - New / Open (both show the same open dialog with reset)
        for (const id of ['newMenuItem', 'openMenuItem']) {
            document.getElementById(id)?.addEventListener('click', () =>
                this._startProjectReplacement(({ leaveOnline }) =>
                    this._showOpenDialog({ replaceProject: true, leaveOnline })))
        }

        // File menu - New from Clipboard
        document.getElementById('newFromClipboardMenuItem')?.addEventListener('click', () =>
            this._startProjectReplacement(({ leaveOnline }) =>
                this._handleNewFromClipboard({ replaceProject: true, leaveOnline })))

        // File menu - Save Project (uses Save As if no project ID)
        document.getElementById('saveProjectMenuItem')?.addEventListener('click', () => {
            if (this._currentProjectId) {
                this._quickSaveProject()
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
            this._startProjectReplacement(({ leaveOnline }) =>
                this._showLoadProjectDialog(false, { replaceProject: true, leaveOnline })))

        document.getElementById('savePngMenuItem')?.addEventListener('click', () => {
            this._quickSavePng()
        })

        document.getElementById('saveJpgMenuItem')?.addEventListener('click', () => {
            this._quickSaveJpg()
        })

        // File menu - Export Image
        document.getElementById('exportImageMenuItem')?.addEventListener('click', () => {
            this._exportImageDialog.open()
        })

        // File menu - Export Video
        document.getElementById('exportVideoMenuItem')?.addEventListener('click', () => {
            this._exportVideoDialog.open()
        })

        // Edit menu - Undo
        document.getElementById('undoMenuItem')?.addEventListener('click', () => {
            this._undo()
        })

        // Edit menu - Redo
        document.getElementById('redoMenuItem')?.addEventListener('click', () => {
            this._redo()
        })

        // Edit menu - Copy Image
        document.getElementById('copyImageMenuItem')?.addEventListener('click', async () => {
            await this._handleCopyImage()
        })

        // Edit menu - Paste Image
        document.getElementById('pasteImageMenuItem')?.addEventListener('click', () => {
            this._handlePaste()
        })

        // Image menu - Crop to selection
        document.getElementById('cropToSelectionMenuItem')?.addEventListener('click', async () => {
            await this._cropToSelection()
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
                this._handleAddEffectLayer(effectItem.dataset.effect)
            })
        }

        // Auto correction handlers
        document.getElementById('autoLevelsMenuItem')?.addEventListener('click', () => {
            if (this._layers.length === 0) return
            this._handleAutoCorrection(autoLevels)
        })
        document.getElementById('autoContrastMenuItem')?.addEventListener('click', () => {
            if (this._layers.length === 0) return
            this._handleAutoCorrection(autoContrast)
        })
        document.getElementById('autoWhiteBalanceMenuItem')?.addEventListener('click', () => {
            if (this._layers.length === 0) return
            this._handleAutoCorrection(autoWhiteBalance)
        })

        // Select menu - Select All
        document.getElementById('selectAllMenuItem')?.addEventListener('click', () => {
            const { width, height } = this._canvas
            this._selectionManager.setSelection({
                type: 'rect', x: 0, y: 0, width, height
            })
        })

        // Select menu - Select None
        document.getElementById('selectNoneMenuItem')?.addEventListener('click', () => {
            this._selectionManager.clearSelection()
        })

        // Select menu - Select Inverse
        document.getElementById('selectInverseMenuItem')?.addEventListener('click', () => {
            const mask = this._selectionManager.rasterizeSelection()
            if (!mask) return
            const inverted = invertMask(mask)
            this._selectionManager.setSelection({ type: 'mask', data: inverted })
        })

        // Select menu - Color Range
        document.getElementById('colorRangeMenuItem')?.addEventListener('click', () => {
            this._startColorRangePick()
        })

        // Select menu - Modify operations
        document.getElementById('borderSelectionMenuItem')?.addEventListener('click', () => {
            this._modifySelection({ title: 'Border Selection', label: 'Width', defaultValue: 1 }, borderMask)
        })
        document.getElementById('smoothSelectionMenuItem')?.addEventListener('click', () => {
            this._modifySelection({ title: 'Smooth Selection', label: 'Radius', defaultValue: 2 }, smoothMask)
        })
        document.getElementById('expandSelectionMenuItem')?.addEventListener('click', () => {
            this._modifySelection({ title: 'Expand Selection', label: 'Radius', defaultValue: 1 }, expandMask)
        })
        document.getElementById('contractSelectionMenuItem')?.addEventListener('click', () => {
            this._modifySelection({ title: 'Contract Selection', label: 'Radius', defaultValue: 1 }, contractMask)
        })
        document.getElementById('featherSelectionMenuItem')?.addEventListener('click', () => {
            this._modifySelection({ title: 'Feather Selection', label: 'Radius', defaultValue: 2 }, featherMask)
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
            this._handleAddEffectLayer('filter/text')
        })

        // Add layer button
        document.getElementById('addLayerBtn')?.addEventListener('click', () => {
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
            this._togglePlayPause()
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
                this._flattenImage()
            } else if (selectedIds.length === 1) {
                const layer = this._layers.find(l => l.id === selectedIds[0])
                if (layer && layer.sourceType !== 'media') {
                    this._rasterizeLayer(selectedIds[0])
                }
            } else {
                this._flattenLayers(selectedIds)
            }
        })

        document.getElementById('duplicateLayerMenuItem')?.addEventListener('click', () => {
            this._duplicateActiveLayer()
        })

        document.getElementById('deleteLayerMenuItem')?.addEventListener('click', () => {
            const selected = this._layerStack?.getSelectedLayer()
            if (selected && this._layers.indexOf(selected) > 0) {
                this._handleDeleteLayer(selected.id)
            }
        })

        document.getElementById('deselectAllLayersMenuItem')?.addEventListener('click', () => {
            this._deselectAllLayers()
        })

        document.getElementById('flipHMenuItem')?.addEventListener('click', () => {
            this._flipActiveLayer('horizontal')
        })

        document.getElementById('flipVMenuItem')?.addEventListener('click', () => {
            this._flipActiveLayer('vertical')
        })

        document.getElementById('addLayerMaskMenuItem')?.addEventListener('click', () => {
            const layer = this._getActiveLayer()
            if (layer && !layer.mask) this._addLayerMask(layer.id)
        })

        document.getElementById('deleteLayerMaskMenuItem')?.addEventListener('click', () => {
            const layer = this._getActiveLayer()
            if (layer?.mask) this._deleteLayerMask(layer.id)
        })
    }

    /**
     * Set up layer stack event handlers
     * @private
     */
    _setupLayerStackHandlers() {
        if (!this._layerStack) return

        this._layerStack.addEventListener('layer-change', (e) => {
            this._handleLayerChange(e.detail)
        })

        this._layerStack.addEventListener('layer-delete', (e) => {
            this._handleDeleteLayer(e.detail.layerId, e.detail.parentLayerId)
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
            this._processDrop(e.detail.targetId, e.detail.dropPosition)
        })

        this._layerStack.addEventListener('selection-change', () => {
            // When selecting a different layer, exit mask edit mode
            if (this._maskEditMode && this._getActiveLayer()?.id !== this._maskEditLayerId) {
                this._exitMaskEditMode()
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
            if (this._maskEditMode && this._maskEditLayerId === layerId) {
                this._exitMaskEditMode()
            } else {
                if (this._maskEditMode) this._exitMaskEditMode()
                this._enterMaskEditMode(layerId)
            }
        })

        this._layerStack?.addEventListener('mask-toggle-visible', (e) => {
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
        if (this._blockedMediaOnline('Flattening')) return
        if (this._layers.length === 0) return

        this._finalizePendingUndo()

        // Capture current canvas (all visible layers composited)
        const offscreen = new OffscreenCanvas(this._canvas.width, this._canvas.height)
        const ctx = offscreen.getContext('2d')
        ctx.drawImage(this._canvas, 0, 0)

        // Convert to blob and create media layer
        const blob = await offscreen.convertToBlob({ type: 'image/png' })
        const file = new File([blob], 'flattened-image.png', { type: 'image/png' })

        const newLayer = createMediaLayer(file, 'image', this._currentProjectName || 'flattened image')

        // Unload all existing media
        for (const layer of this._layers) {
            if (layer.sourceType === 'media') {
                this._renderer.unloadMedia(layer.id)
            }
        }

        // Replace entire layer stack
        this._layers = [newLayer]
        await this._renderer.loadMedia(newLayer.id, file, 'image')

        // Update UI
        this._updateLayerStack()
        if (this._layerStack) {
            this._layerStack.selectedLayerId = newLayer.id
        }
        await this._rebuild()
        this._markDirty()
        this._pushUndoState()

        toast.success('Image flattened')
    }

    /**
     * Rasterize a single effect layer to media (user-facing with undo and toast)
     * @param {string} layerId
     * @private
     */
    async _rasterizeLayer(layerId) {
        if (this._blockedMediaOnline('Rasterizing')) return
        const layer = this._layers.find(l => l.id === layerId)
        if (!layer || layer.sourceType === 'media') return

        this._finalizePendingUndo()

        const newId = await this._rasterizeLayerInPlace(layerId)
        if (!newId) return

        // Rename with "(rasterized)" suffix
        const newLayer = this._layers.find(l => l.id === newId)
        if (newLayer) newLayer.name = `${layer.name} (rasterized)`

        this._updateLayerStack()
        await this._rebuild()
        this._markDirty()
        this._pushUndoState()

        toast.success('Layer rasterized')
    }

    /**
     * Flatten multiple selected layers into one
     * @param {Array<string>} layerIds
     * @private
     */
    async _flattenLayers(layerIds) {
        if (this._blockedMediaOnline('Flattening')) return
        if (layerIds.length < 2) return

        this._finalizePendingUndo()

        // Find the layers and their indices
        const selectedLayers = layerIds
            .map(id => ({ layer: this._layers.find(l => l.id === id), index: this._layers.findIndex(l => l.id === id) }))
            .filter(item => item.layer && item.index !== -1)
            .sort((a, b) => a.index - b.index)

        if (selectedLayers.length < 2) return

        // Find topmost selected layer index (highest index = top of stack)
        const topmostIndex = Math.max(...selectedLayers.map(item => item.index))

        const savedVisibility = this._saveVisibility()

        // Hide all layers except selected visible ones
        for (const l of this._layers) {
            if (!layerIds.includes(l.id)) l.visible = false
        }

        // Rebuild to render only selected visible layers
        await this._rebuild()

        // Capture the rendered result
        const offscreen = new OffscreenCanvas(this._canvas.width, this._canvas.height)
        const ctx = offscreen.getContext('2d')
        ctx.drawImage(this._canvas, 0, 0)

        this._restoreVisibility(savedVisibility)

        const blob = await offscreen.convertToBlob({ type: 'image/png' })
        const file = new File([blob], 'flattened.png', { type: 'image/png' })

        const newLayer = createMediaLayer(file, 'image', 'flattened')

        // Load media
        await this._renderer.loadMedia(newLayer.id, file, 'image')

        // Unload media for selected layers that are media type
        for (const item of selectedLayers) {
            if (item.layer.sourceType === 'media') {
                this._renderer.unloadMedia(item.layer.id)
            }
        }

        // Remove selected layers from stack (in reverse order to preserve indices)
        const indicesToRemove = selectedLayers.map(item => item.index).sort((a, b) => b - a)
        for (const idx of indicesToRemove) {
            this._layers.splice(idx, 1)
        }

        // Insert new layer at topmost position (adjusted for removed layers above it)
        const removedAboveTopmost = indicesToRemove.filter(idx => idx < topmostIndex).length
        const insertIndex = topmostIndex - removedAboveTopmost
        this._layers.splice(insertIndex, 0, newLayer)

        // Update UI
        this._updateLayerStack()
        if (this._layerStack) {
            this._layerStack.selectedLayerId = newLayer.id
        }
        await this._rebuild()
        this._markDirty()
        this._pushUndoState()

        toast.success('Layers flattened')
    }

    /**
     * Set up keyboard shortcuts
     * @private
     */
    _setupKeyboardShortcuts() {
        document.addEventListener('keydown', (e) => {
            // ESC - close context menus
            if (e.key === 'Escape' && this._contextMenuCloseHandler) {
                this._closeContextMenus()
                return
            }

            // ESC - exit mask edit mode
            if (e.key === 'Escape' && this._maskEditMode) {
                this._exitMaskEditMode()
                return
            }

            // ESC - cancel drag operation
            if (e.key === 'Escape' && this._reorderState === 'DRAGGING') {
                e.preventDefault()
                this._cancelDrag()
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
                this._redo()
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
                this._undo()
                return
            }

            // Cmd+C - copy selection
            if ((e.ctrlKey || e.metaKey) && e.key === 'c') {
                if (this._selectionManager?.hasSelection()) {
                    e.preventDefault()
                    this._handleCopy()
                    return
                }
            }

            // Cmd+V - paste
            if ((e.ctrlKey || e.metaKey) && e.key === 'v') {
                e.preventDefault()
                this._handlePaste()
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
                    this._handleDeleteLayer(selected.id)
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
                    this._finalizePendingUndo()
                    selected.visible = !selected.visible
                    this._updateLayerStack()
                    this._rebuild().then(() => {
                        this._markDirty()
                        this._pushUndoState()
                    })
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
        addLayerDialog.show({
            effects: this._renderer.getLayerEffects(),
            onAddMedia: async (file, mediaType) => {
                await this._handleAddMediaLayer(file, mediaType)
            },
            onAddEffect: async (effectId) => {
                await this._handleAddEffectLayer(effectId)
            }
        })
    }

    /**
     * Show effect picker for adding a child effect to a layer
     * @param {string} parentLayerId - Parent layer ID
     * @private
     */
    _showAddChildEffectDialog(parentLayerId) {
        addLayerDialog.showEffectOnly({
            effects: this._renderer.getLayerEffects(),
            onAddEffect: async (effectId) => {
                await this._handleAddChildEffect(parentLayerId, effectId)
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
    async _duplicateActiveLayer() {
        // Gated unconditionally (not just for an already-media active layer):
        // this always rasterizes the active layer's composite into a NEW
        // media layer below, regardless of the source layer's own
        // sourceType — an effect or drawing layer duplicate is media too.
        if (this._blockedMediaOnline('Duplicating')) return false
        this._finalizePendingUndo()
        const layer = this._getActiveLayer()
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

        // Insert after source layer
        const layerIndex = this._layers.findIndex(l => l.id === layer.id)
        this._layers.splice(layerIndex + 1, 0, newLayer)

        await this._renderer.loadMedia(newLayer.id, file, 'image')
        this._layerStack.selectedLayerId = newLayer.id

        this._updateLayerStack()
        await this._rebuild()
        this._markDirty()
        this._pushUndoState()
        return true
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
            const posX = Math.max(0, Math.min(1, x / this._canvas.width))
            const posY = Math.max(0, Math.min(1, y / this._canvas.height))
            layer.effectParams = { ...layer.effectParams, posX, posY }
            this._renderer.updateTextParams(layer.id, layer.effectParams)
        } else {
            layer.offsetX = Math.round(x)
            layer.offsetY = Math.round(y)
            this._renderer.updateLayerOffset(layer.id, layer.offsetX, layer.offsetY)
        }

        this._markDirty()
        this._pushUndoStateDebounced()
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

    /**
     * Apply transform values to the active layer during drag (debounced undo)
     * @param {object} values - Transform values to apply
     * @private
     */
    _applyLayerTransform(values) {
        const layer = this._getActiveLayer()
        if (!layer) return

        if (values.offsetX !== undefined) layer.offsetX = Math.round(values.offsetX)
        if (values.offsetY !== undefined) layer.offsetY = Math.round(values.offsetY)
        if (values.scaleX !== undefined) layer.scaleX = values.scaleX
        if (values.scaleY !== undefined) layer.scaleY = values.scaleY
        if (values.rotation !== undefined) layer.rotation = values.rotation

        this._updateTransformRender(layer)
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
    _cancelTransform() {
        this._setToolMode('selection')
    }

    /**
     * Update renderer for transform changes via CPU-side offscreen canvas
     * @param {object} layer
     * @private
     */
    _updateTransformRender(layer) {
        if (layer.sourceType !== 'media') return
        const transform = {
            scaleX: layer.scaleX ?? 1,
            scaleY: layer.scaleY ?? 1,
            rotation: layer.rotation ?? 0,
            flipH: layer.flipH || false,
            flipV: layer.flipV || false
        }
        this._renderer?.updateLayerTransform(layer.id, transform, layer.offsetX || 0, layer.offsetY || 0)
    }

    /**
     * Flip the active layer horizontally or vertically
     * @param {'horizontal'|'vertical'} direction
     * @private
     */
    _flipActiveLayer(direction) {
        const layer = this._getActiveLayer()
        if (!layer || layer.sourceType !== 'media') {
            toast.warning('Select a media layer to flip')
            return
        }

        this._finalizePendingUndo()

        if (direction === 'horizontal') {
            layer.flipH = !layer.flipH
        } else {
            layer.flipV = !layer.flipV
        }

        this._updateTransformRender(layer)
        this._markDirty()
        this._pushUndoState()
    }

    /**
     * Rasterize a layer in place without UI updates or toast
     * Used internally before extraction
     * @param {string} layerId
     * @returns {Promise<string|null>} The new layer id, or null if already media
     * @private
     */
    async _rasterizeLayerInPlace(layerId) {
        // _rasterizeLayer() already gates before calling this today, but this
        // is gated too since it mutates _layers directly and its own doc
        // comment invites other internal callers ("used internally before
        // extraction") that might not go through _rasterizeLayer() first.
        if (this._blockedMediaOnline('Rasterizing')) return null
        const layerIndex = this._layers.findIndex(l => l.id === layerId)
        if (layerIndex === -1) return null

        const layer = this._layers[layerIndex]
        if (layer.sourceType === 'media') return layer.id

        const savedVisibility = this._saveVisibility()
        for (const l of this._layers) {
            if (l.id !== layerId) l.visible = false
        }
        await this._rebuild()
        // Wait for the renderer to paint the new DSL before snapshotting.
        // Without this the canvas still shows the previous composite.
        await new Promise(resolve => requestAnimationFrame(resolve))

        const offscreen = new OffscreenCanvas(this._canvas.width, this._canvas.height)
        const ctx = offscreen.getContext('2d')
        ctx.drawImage(this._canvas, 0, 0)

        this._restoreVisibility(savedVisibility)

        // Convert to media layer
        const blob = await offscreen.convertToBlob({ type: 'image/png' })
        const file = new File([blob], 'rasterized.png', { type: 'image/png' })

        const newLayer = createMediaLayer(file, 'image', layer.name)
        newLayer.visible = layer.visible
        newLayer.opacity = layer.opacity
        newLayer.blendMode = layer.blendMode
        newLayer.offsetX = 0
        newLayer.offsetY = 0
        newLayer.scaleX = 1
        newLayer.scaleY = 1
        newLayer.rotation = 0
        newLayer.flipH = false
        newLayer.flipV = false

        await this._renderer.loadMedia(newLayer.id, file, 'image')
        this._layers[layerIndex] = newLayer

        if (this._layerStack) {
            this._layerStack.selectedLayerId = newLayer.id
        }

        return newLayer.id
    }

    /**
     * Extract current selection to a new layer
     * @param {boolean} destructive - If true, modify originals (punch holes/flatten). If false, just clone.
     * @private
     */
    async _extractSelectionToLayer(destructive = true) {
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
            return this._extractFromSingleLayer(selectedLayers[0], destructive)
        }
        return this._extractFromMultipleLayers(selectedIds, destructive)
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
    async _extractFromSingleLayer(layer, punchHole) {
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

            // Replace layer content with punched image (converts effect layers to media)
            this._renderer.unloadMedia(layer.id)
            layer.sourceType = 'media'
            layer.mediaFile = punchedFile
            layer.mediaType = 'image'
            layer.effectId = null
            layer.effectParams = {}
            layer.offsetX = 0
            layer.offsetY = 0
            await this._renderer.loadMedia(layer.id, punchedFile, 'image')
        }

        // Create new layer with extracted pixels
        const extractedBlob = await extractedCanvas.convertToBlob({ type: 'image/png' })
        const extractedFile = new File([extractedBlob], 'moved-selection.png', { type: 'image/png' })

        const newLayer = createMediaLayer(extractedFile, 'image', 'moved selection')

        // Insert after source layer
        const layerIndex = this._layers.findIndex(l => l.id === layer.id)
        this._layers.splice(layerIndex + 1, 0, newLayer)

        await this._renderer.loadMedia(newLayer.id, extractedFile, 'image')
        this._layerStack.selectedLayerId = newLayer.id

        if (punchHole) {
            this._selectionManager.clearSelection()
        }
        this._updateLayerStack()
        await this._rebuild()
        this._markDirty()
        this._pushUndoState()
        return true
    }

    /**
     * Extract selection from multiple layers
     * @param {string[]} layerIds - The layer IDs to extract from
     * @param {boolean} punchHole - Whether to flatten and punch (true) or just clone (false)
     * @private
     */
    async _extractFromMultipleLayers(layerIds, punchHole) {
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

        // Find topmost layer index for insertion
        const topmostIndex = Math.max(...layerIds.map(id => this._layers.findIndex(l => l.id === id)))

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

            // Remove old layers
            const selectedLayers = layerIds.map(id => this._layers.find(l => l.id === id)).filter(Boolean)
            for (const layer of selectedLayers) {
                if (layer.sourceType === 'media') {
                    this._renderer.unloadMedia(layer.id)
                }
            }
            const indicesToRemove = layerIds
                .map(id => this._layers.findIndex(l => l.id === id))
                .filter(i => i !== -1)
                .sort((a, b) => b - a)
            for (const idx of indicesToRemove) {
                this._layers.splice(idx, 1)
            }

            // Insert flattened layer
            const removedAboveTopmost = indicesToRemove.filter(idx => idx < topmostIndex).length
            const insertIndex = topmostIndex - removedAboveTopmost
            this._layers.splice(insertIndex, 0, flattenedLayer)
            await this._renderer.loadMedia(flattenedLayer.id, flattenedFile, 'image')
        }

        // Create new layer with extracted pixels
        const extractedBlob = await extractedCanvas.convertToBlob({ type: 'image/png' })
        const extractedFile = new File([extractedBlob], 'moved-selection.png', { type: 'image/png' })

        const newLayer = createMediaLayer(extractedFile, 'image', 'moved selection')

        // Insert at top
        this._layers.push(newLayer)
        await this._renderer.loadMedia(newLayer.id, extractedFile, 'image')
        this._layerStack.selectedLayerId = newLayer.id

        if (punchHole) {
            this._selectionManager.clearSelection()
        }
        this._updateLayerStack()
        await this._rebuild()
        this._markDirty()
        this._pushUndoState()
        return true
    }

    /**
     * Load an Image element from a Blob
     * @param {Blob} blob
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
    async _renderLayerComposite(layerIds) {
        const savedVisibility = this._saveVisibility()

        for (const l of this._layers) {
            l.visible = layerIds.includes(l.id)
        }

        await this._rebuild()
        this._renderer.render(0)

        const offscreen = new OffscreenCanvas(this._canvas.width, this._canvas.height)
        const ctx = offscreen.getContext('2d')
        ctx.drawImage(this._canvas, 0, 0)

        this._restoreVisibility(savedVisibility)
        await this._rebuild()

        const blob = await offscreen.convertToBlob({ type: 'image/png' })
        return this._loadImageFromBlob(blob)
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

    /**
     * Ensure a drawing layer exists and is active. If the active layer is already
     * a drawing layer, return it. Otherwise, create a new drawing layer above the
     * current layer and select it.
     * @returns {Object} The drawing layer
     * @private
     */
    _ensureDrawingLayer() {
        const active = this._getActiveLayer()
        if (active?.sourceType === 'drawing') return active

        this._finalizePendingUndo()
        const layer = createDrawingLayer(`Drawing ${++this._drawingLayerCounter}`)

        // Insert above current layer
        const activeIdx = active ? this._layers.indexOf(active) : this._layers.length - 1
        this._layers.splice(activeIdx + 1, 0, layer)

        this._updateLayerStack()
        if (this._layerStack) {
            this._layerStack.selectedLayerId = layer.id
        }

        this._markDirty()
        this._pushUndoState()
        return layer
    }

    /**
     * Handle copy command
     * @private
     */
    async _handleCopy() {
        if (!this._selectionManager?.hasSelection()) return

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
            return
        }
        const result = await pasteFromClipboard()
        if (!result) {
            return // No image in clipboard, silent fail
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
                this._selectionManager.clearSelection()
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

        // Create properly-sized layer with offset positioning
        this._finalizePendingUndo()
        const layer = createMediaLayer(file, 'image')
        layer.offsetX = offsetX
        layer.offsetY = offsetY
        this._layers.push(layer)

        await this._renderer.loadMedia(layer.id, file, 'image')

        this._updateLayerStack()
        await this._rebuild()
        this._markDirty()
        this._pushUndoState()

        if (this._layerStack) {
            this._layerStack.selectedLayerId = layer.id
        }

        toast.success(`Added layer: ${layer.name}`)
    }

    /**
     * Show the save project dialog
     * @private
     */
    _showSaveProjectDialog() {
        saveProjectDialog.show({
            projectId: this._currentProjectId,
            projectName: this._currentProjectName || 'untitled',
            onSave: async (projectId, projectName) => {
                await this._saveProject(projectId, projectName)
            }
        })
    }

    /**
     * Show save project as dialog (always prompts for name)
     * @private
     */
    _showSaveProjectAsDialog() {
        saveProjectDialog.show({
            projectId: null,
            projectName: this._currentProjectName || 'untitled',
            onSave: async (projectId, projectName) => {
                await this._saveProject(projectId, projectName)
            }
        })
    }

    /**
     * Quick save project without dialog (for existing projects)
     * @private
     */
    async _quickSaveProject() {
        try {
            await this._saveProject(this._currentProjectId, this._currentProjectName)
        } catch (err) {
            // Error already shown in _saveProject
        }
    }

    /**
     * Show the load project dialog
     * @param {boolean} isRequired - If true, dialog cannot be closed without selection
     * @private
     */
    _showLoadProjectDialog(isRequired = false, { replaceProject = false, leaveOnline = false } = {}) {
        projectManagerDialog.show({
            isRequired,
            onLoad: async (projectId) => {
                await this._loadProject(projectId, { replaceProject, leaveOnline })
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
    async _saveProject(projectId, projectName) {
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

            toast.success('Project saved')
        } catch (err) {
            console.error('[Layers] Failed to save project:', err)
            toast.error('Failed to save project')
            throw err
        }
    }

    /**
     * Load a project
     * @param {string} projectId - Project ID
     * @private
     */
    async _loadProject(projectId, { replaceProject = true, leaveOnline = false } = {}) {
        try {
            const result = await loadProject(projectId)
            if (!result) {
                toast.error('Project not found')
                return
            }

            const { project, mediaFiles } = result

            // The dialog selection is the load operation's commit point.
            if (replaceProject) this._commitProjectReplacement({ leaveOnline })
            else this._resetLayers()

            // Resize canvas
            if (project.canvasWidth && project.canvasHeight) {
                this._resizeCanvas(project.canvasWidth, project.canvasHeight)
            }

            // Restore layers
            this._layers = project.layers

            // Decode serialized masks back to ImageData
            await decodeMasks(this._layers)

            // Load media for each media layer
            for (const layer of this._layers) {
                if (layer.sourceType === 'media') {
                    const file = mediaFiles.get(layer.id)
                    if (file) {
                        layer.mediaFile = file
                        await this._renderer.loadMedia(layer.id, file, layer.mediaType)
                    }
                }
            }

            // Re-rasterize drawing layers from persisted strokes (their canvas
            // is not serialized, so the GPU texture must be rebuilt on load)
            for (const layer of this._layers) {
                if (layer.sourceType === 'drawing' && layer.strokes?.length > 0) {
                    await this._rasterizeDrawingLayer(layer)
                }
            }

            // Re-upload mask textures (the renderer starts with empty texture
            // maps, so masks decoded above must be re-registered to render)
            for (const layer of this._layers) {
                if (layer.mask) {
                    this._renderer.uploadMaskTexture(layer.id, layer.mask)
                }
            }

            // Update state
            this._currentProjectId = project.id
            this._currentProjectName = project.name
            // Update UI and rebuild
            this._updateLayerStack()
            this._selectTopmostLayer()
            // Wait for any pending microtasks (canvas observer uses queueMicrotask)
            await new Promise(resolve => queueMicrotask(resolve))
            await this._rebuild()
            // Wait for next frame to ensure WebGL state is stable
            await new Promise(resolve => requestAnimationFrame(resolve))
            this._renderer.start()
            this._markClean()

            this._undoManager.clear()
            this._pushUndoState()

            // Close the open dialog (in case we came from there)
            openDialog.element.close()
            toast.success(`Loaded "${project.name}"`)
        } catch (err) {
            console.error('[Layers] Failed to load project:', err)
            toast.error('Failed to load project')
            throw err
        }
    }

    /**
     * Quick save as PNG
     * @private
     */
    _quickSavePng() {
        const filename = getTimestampedFilename('layers')
        exportPng(this._canvas, filename)
        toast.success('Saved as PNG')
    }

    /**
     * Quick save as JPG
     * @private
     */
    _quickSaveJpg() {
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
        const r = await selectionParamDialog.show(dialogOptions)
        if (r === null) return
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

    _startColorRangePick() {
        if (!this._canvas) return
        this._colorRangePicking = true
        this._selectionOverlay.style.cursor = 'crosshair'

        const handler = (e) => {
            this._selectionOverlay.removeEventListener('click', handler)
            this._colorRangePicking = false
            this._selectionOverlay.style.cursor = ''
            this._handleColorRangePick(e)
        }

        this._selectionManager.enabled = false

        this._selectionOverlay.addEventListener('click', handler)

        const cancelHandler = (e) => {
            if (e.key === 'Escape') {
                this._selectionOverlay.removeEventListener('click', handler)
                document.removeEventListener('keydown', cancelHandler)
                this._colorRangePicking = false
                this._selectionOverlay.style.cursor = ''
                this._selectionManager.enabled = true
            }
        }
        document.addEventListener('keydown', cancelHandler)

        this._selectionOverlay.addEventListener('click', () => {
            document.removeEventListener('keydown', cancelHandler)
            this._selectionManager.enabled = true
        }, { once: true })
    }

    _handleColorRangePick(e) {
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
        if (!this._selectionManager?.hasSelection()) return

        this._finalizePendingUndo()

        const selectionPath = this._selectionManager.selectionPath
        const bounds = getSelectionBounds(selectionPath)
        if (bounds.width <= 0 || bounds.height <= 0) return

        for (const layer of this._layers) {
            if (layer.sourceType === 'media' && layer.mediaType !== 'video') {
                await this._cropMediaLayer(layer, bounds)
            } else {
                // Video and effect layers: shift offsets (video can't be rasterized)
                layer.offsetX = (layer.offsetX || 0) - bounds.x
                layer.offsetY = (layer.offsetY || 0) - bounds.y
            }
        }

        // Crop masks to match new canvas bounds
        for (const layer of this._layers) {
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
                this._renderer.uploadMaskTexture(layer.id, layer.mask)
            }
        }

        // Stop renderer before resizing (resize invalidates WebGL state)
        this._renderer.stop()
        this._resizeCanvas(bounds.width, bounds.height)
        this._selectionManager.clearSelection()

        // Recompile pipeline at new dimensions and restart
        await this._rebuild()
        await new Promise(resolve => requestAnimationFrame(resolve))
        this._renderer.start()
        this._markDirty()
        this._pushUndoState()

        toast.success('Cropped to selection')
    }

    async _cropMediaLayer(layer, bounds) {
        // Render through the shader to capture what the user sees
        const compositeImg = await this._renderLayerComposite([layer.id])
        if (!compositeImg) return

        const offscreen = new OffscreenCanvas(bounds.width, bounds.height)
        const ctx = offscreen.getContext('2d')
        ctx.drawImage(
            compositeImg,
            bounds.x, bounds.y, bounds.width, bounds.height,
            0, 0, bounds.width, bounds.height
        )

        const blob = await offscreen.convertToBlob({ type: 'image/png' })
        const file = new File([blob], 'cropped.png', { type: 'image/png' })

        // Replace layer with rasterized crop (transforms are baked into the output)
        this._renderer.unloadMedia(layer.id)
        layer.mediaFile = file
        layer.mediaType = 'image'
        layer.offsetX = 0
        layer.offsetY = 0
        layer.effectParams = {}
        await this._renderer.loadMedia(layer.id, file, 'image')
    }

    _showImageSizeDialog() {
        imageSizeDialog.show({
            width: this._canvas.width,
            height: this._canvas.height,
            onConfirm: async (width, height) => {
                await this._resizeImage(width, height)
            }
        })
    }

    async _resizeImage(newWidth, newHeight) {
        const oldWidth = this._canvas.width
        const oldHeight = this._canvas.height
        if (newWidth === oldWidth && newHeight === oldHeight) return

        this._finalizePendingUndo()

        const scaleX = newWidth / oldWidth
        const scaleY = newHeight / oldHeight

        // Resize each layer
        for (const layer of this._layers) {
            if (layer.sourceType === 'media') {
                await this._resampleMediaLayer(layer, scaleX, scaleY)
            } else {
                // Effect layers: scale offsets only
                layer.offsetX = Math.round((layer.offsetX || 0) * scaleX)
                layer.offsetY = Math.round((layer.offsetY || 0) * scaleY)
            }
        }

        // Resize masks to match new canvas dimensions
        for (const layer of this._layers) {
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
                this._renderer.uploadMaskTexture(layer.id, layer.mask)
            }
        }

        // Stop renderer before resizing (resize invalidates WebGL state)
        this._renderer.stop()

        this._resizeCanvas(newWidth, newHeight)
        await this._rebuild()
        await new Promise(resolve => requestAnimationFrame(resolve))
        this._renderer.start()
        this._markDirty()
        this._pushUndoState()

        toast.success(`Resized to ${newWidth} x ${newHeight}`)
    }

    async _resampleMediaLayer(layer, scaleX, scaleY) {
        const media = this._renderer._mediaTextures.get(layer.id)
        if (!media || !media.element) return

        const srcW = media.width
        const srcH = media.height
        const dstW = Math.round(srcW * scaleX)
        const dstH = Math.round(srcH * scaleY)

        if (layer.mediaType === 'video') {
            // Video: update stored dimensions so imageSize uniform reflects scale.
            // Video element stays alive — animation continues.
            media.width = dstW
            media.height = dstH
        } else {
            // Image: create resampled pixels
            const offscreen = new OffscreenCanvas(dstW, dstH)
            const ctx = offscreen.getContext('2d')
            ctx.drawImage(media.element, 0, 0, srcW, srcH, 0, 0, dstW, dstH)

            const blob = await offscreen.convertToBlob({ type: 'image/png' })
            const file = new File([blob], 'resized.png', { type: 'image/png' })

            this._renderer.unloadMedia(layer.id)
            await this._renderer.loadMedia(layer.id, file, 'image')

            layer.mediaFile = file
        }

        layer.offsetX = Math.round((layer.offsetX || 0) * scaleX)
        layer.offsetY = Math.round((layer.offsetY || 0) * scaleY)
    }

    _showCanvasSizeDialog() {
        canvasResizeDialog.show({
            width: this._canvas.width,
            height: this._canvas.height,
            onConfirm: async (width, height, anchor) => {
                await this._changeCanvasSize(width, height, anchor)
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
        if (newWidth === oldWidth && newHeight === oldHeight) return

        this._finalizePendingUndo()

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

        // Adjust all layer offsets
        for (const layer of this._layers) {
            layer.offsetX = (layer.offsetX || 0) + shiftX
            layer.offsetY = (layer.offsetY || 0) + shiftY
        }

        // Reposition masks onto new canvas dimensions
        for (const layer of this._layers) {
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
                this._renderer.uploadMaskTexture(layer.id, layer.mask)
            }
        }

        // Stop renderer before resizing (resize invalidates WebGL state)
        this._renderer.stop()

        this._resizeCanvas(newWidth, newHeight)
        await this._rebuild()
        await new Promise(resolve => requestAnimationFrame(resolve))
        this._renderer.start()
        this._markDirty()
        this._pushUndoState()

        toast.success(`Canvas resized to ${newWidth} x ${newHeight}`)
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
