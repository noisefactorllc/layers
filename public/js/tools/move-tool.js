/**
 * Move Tool - Handles moving layers and extracting selections
 *
 * FSM States: IDLE -> EXTRACTING (async) -> DRAGGING -> IDLE
 *
 * @module tools/move-tool
 */

const State = {
    IDLE: 'idle',
    EXTRACTING: 'extracting',
    DRAGGING: 'dragging'
}

const MOUSE_EVENTS = ['mousedown', 'mousemove', 'mouseup', 'mouseleave']

class MoveTool {
    constructor(options) {
        this._overlay = options.overlay
        this._selectionManager = options.selectionManager
        this._getActiveLayer = options.getActiveLayer
        this._getSelectedLayers = options.getSelectedLayers
        this._updateLayerPosition = options.updateLayerPosition
        this._getLayerPosition = options.getLayerPosition || ((layer) => ({
            x: layer?.offsetX || 0,
            y: layer?.offsetY || 0
        }))
        this._extractSelection = options.extractSelection
        this._showNoLayerDialog = options.showNoLayerDialog
        this._selectTopmostLayer = options.selectTopmostLayer
        this._duplicateLayer = options.duplicateLayer
        this._onComplete = options.onComplete
        this._isLayerBlocked = options.isLayerBlocked
        this._destructive = options.destructive !== false
        this._toolClass = options.toolClass || 'move-tool'

        this._active = false
        this._state = State.IDLE
        this._dragStart = null
        this._layerStartPos = null
        this._didCloneOperation = false
        this._pointerUpPending = false

        this._onMouseDown = this._onMouseDown.bind(this)
        this._onMouseMove = this._onMouseMove.bind(this)
        this._onMouseUp = this._onMouseUp.bind(this)
    }

    activate() {
        if (this._active) return
        this._active = true
        this._state = State.IDLE

        if (!this._getActiveLayer() && this._selectTopmostLayer) {
            this._selectTopmostLayer()
        }

        const handlers = [this._onMouseDown, this._onMouseMove, this._onMouseUp, this._onMouseUp]
        MOUSE_EVENTS.forEach((evt, i) => this._overlay.addEventListener(evt, handlers[i]))
        this._overlay.classList.add(this._toolClass)
    }

    deactivate() {
        if (!this._active) return
        this._active = false

        const handlers = [this._onMouseDown, this._onMouseMove, this._onMouseUp, this._onMouseUp]
        MOUSE_EVENTS.forEach((evt, i) => this._overlay.removeEventListener(evt, handlers[i]))
        this._overlay.classList.remove(this._toolClass)
        this._reset()
    }

    get isActive() {
        return this._active
    }

    /**
     * True while a move/clone gesture is in flight: dragging a layer, or
     * awaiting the async extraction/duplication that precedes a clone drag
     * (EXTRACTING also mutates `_layers`, so it's just as unsafe to clobber
     * as an active drag).
     */
    get isDragging() {
        return this._state !== State.IDLE
    }

    _reset() {
        this._state = State.IDLE
        this._dragStart = null
        this._layerStartPos = null
        this._didCloneOperation = false
        this._pointerUpPending = false
    }

    _getCanvasCoords(e) {
        const rect = this._overlay.getBoundingClientRect()
        return {
            x: (e.clientX - rect.left) * (this._overlay.width / rect.width),
            y: (e.clientY - rect.top) * (this._overlay.height / rect.height)
        }
    }

    _onMouseDown(e) {
        if (this._state !== State.IDLE) return

        const layer = this._getActiveLayer()
        if (this._isLayerBlocked?.(layer)) return

        const hasSelection = this._selectionManager.hasSelection()

        if (hasSelection) {
            if (this._getSelectedLayers().length === 0) {
                this._showNoLayerDialog?.()
                return
            }
            this._state = State.EXTRACTING
            this._doAsyncThenDrag(
                () => this._extractSelection(this._destructive),
                this._getCanvasCoords(e),
                'Extraction'
            )
            return
        }

        if (!layer) {
            this._showNoLayerDialog?.()
            return
        }

        const coords = this._getCanvasCoords(e)

        if (!this._destructive && this._duplicateLayer) {
            this._state = State.EXTRACTING
            this._doAsyncThenDrag(
                () => this._duplicateLayer(),
                coords,
                'Duplication'
            )
            return
        }

        this._startDrag(coords, layer)
    }

    async _doAsyncThenDrag(asyncFn, startCoords, label) {
        try {
            const success = await asyncFn()
            if (success) {
                this._didCloneOperation = true
                if (this._pointerUpPending) {
                    // Released during the async work — finish the gesture in place
                    // instead of dragging a layer with no button held.
                    this._reset()
                    this._onComplete?.()
                } else {
                    this._startDrag(startCoords, this._getActiveLayer())
                }
            } else {
                this._reset()
            }
        } catch (err) {
            console.error(`[MoveTool] ${label} error:`, err)
            this._reset()
        }
    }

    _startDrag(coords, layer) {
        this._state = State.DRAGGING
        this._dragStart = coords
        this._layerStartPos = this._getLayerPosition(layer)
    }

    _onMouseMove(e) {
        if (this._state !== State.DRAGGING) return
        if (!this._dragStart || !this._layerStartPos) return

        const coords = this._getCanvasCoords(e)
        this._updateLayerPosition(
            this._layerStartPos.x + coords.x - this._dragStart.x,
            this._layerStartPos.y + coords.y - this._dragStart.y
        )
    }

    _onMouseUp() {
        if (this._state === State.EXTRACTING) {
            // Extraction still running — remember the release so _doAsyncThenDrag
            // completes the gesture instead of starting a drag.
            this._pointerUpPending = true
            return
        }

        const didClone = this._didCloneOperation
        this._reset()

        if (didClone) {
            this._onComplete?.()
        }
    }
}

export { MoveTool }
