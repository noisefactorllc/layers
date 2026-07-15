/**
 * Transform Tool - Handles scale, rotate, flip via on-canvas bounding box handles
 *
 * FSM States: IDLE -> DRAGGING -> IDLE
 *
 * @module tools/transform-tool
 */

const State = {
    IDLE: 'idle',
    DRAGGING: 'dragging'
}

/** Handle identifiers */
const Handle = {
    NONE: 'none',
    MOVE: 'move',
    // Scale handles (corners)
    TOP_LEFT: 'top-left',
    TOP_RIGHT: 'top-right',
    BOTTOM_LEFT: 'bottom-left',
    BOTTOM_RIGHT: 'bottom-right',
    // Scale handles (edges)
    TOP: 'top',
    BOTTOM: 'bottom',
    LEFT: 'left',
    RIGHT: 'right',
    // Rotation zones (outside corners)
    ROTATE_TOP_LEFT: 'rotate-top-left',
    ROTATE_TOP_RIGHT: 'rotate-top-right',
    ROTATE_BOTTOM_LEFT: 'rotate-bottom-left',
    ROTATE_BOTTOM_RIGHT: 'rotate-bottom-right'
}

const MOUSE_EVENTS = ['mousedown', 'mousemove', 'mouseup', 'mouseleave']

/** Size of scale handle squares in canvas pixels */
const HANDLE_SIZE = 8

/** Distance outside corners to detect rotation grab */
const ROTATE_MARGIN = 16

/** Snap angle in degrees when shift is held */
const SNAP_ANGLE = 15

class TransformTool {
    constructor(options) {
        this._overlay = options.overlay
        this._getActiveLayer = options.getActiveLayer
        this._getLayerBounds = options.getLayerBounds
        this._applyTransform = options.applyTransform
        this._commitTransform = options.commitTransform
        this._cancelTransform = options.cancelTransform
        this._showNoLayerDialog = options.showNoLayerDialog
        this._selectTopmostLayer = options.selectTopmostLayer
        this._isLayerBlocked = options.isLayerBlocked
        this._acquireMutation = options.acquireMutation

        this._active = false
        this._state = State.IDLE
        this._activeHandle = Handle.NONE
        this._dragStart = null
        this._startBounds = null
        this._startTransform = null
        this._mutationToken = null

        this._onMouseDown = this._onMouseDown.bind(this)
        this._onMouseMove = this._onMouseMove.bind(this)
        this._onMouseUp = this._onMouseUp.bind(this)
        this._onKeyDown = this._onKeyDown.bind(this)
        this._onCancel = this._onCancel.bind(this)
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
        document.addEventListener('keydown', this._onKeyDown)
        this._overlay.addEventListener('pointercancel', this._onCancel)
        window.addEventListener('blur', this._onCancel)
        this._overlay.classList.add('transform-tool')
        this._drawOverlay()
    }

    deactivate() {
        if (!this._active) return
        this._active = false

        const handlers = [this._onMouseDown, this._onMouseMove, this._onMouseUp, this._onMouseUp]
        MOUSE_EVENTS.forEach((evt, i) => this._overlay.removeEventListener(evt, handlers[i]))
        document.removeEventListener('keydown', this._onKeyDown)
        this._overlay.removeEventListener('pointercancel', this._onCancel)
        window.removeEventListener('blur', this._onCancel)
        this._overlay.classList.remove('transform-tool')
        this._clearOverlay()
        this._reset()
    }

    get isActive() {
        return this._active
    }

    /** True while a handle drag gesture is between mousedown and mouseup. */
    get isDragging() {
        return this._state === State.DRAGGING
    }

    /** Redraw the overlay (e.g. after layer selection changes) */
    redraw() {
        if (this._active) this._drawOverlay()
    }

    _reset() {
        this._mutationToken?.release()
        this._mutationToken = null
        this._state = State.IDLE
        this._activeHandle = Handle.NONE
        this._dragStart = null
        this._startBounds = null
        this._startTransform = null
    }

    _getCanvasCoords(e) {
        const rect = this._overlay.getBoundingClientRect()
        return {
            x: (e.clientX - rect.left) * (this._overlay.width / rect.width),
            y: (e.clientY - rect.top) * (this._overlay.height / rect.height)
        }
    }

    // --- Hit testing ---

    /**
     * Returns the handle at the given canvas coords, or Handle.NONE.
     * Outside bounding box: rotation zones first, then edge handles.
     * Inside bounding box: scale handles first, then move.
     */
    _hitTest(coords) {
        const layer = this._getActiveLayer()
        if (!layer) return Handle.NONE

        const bounds = this._getLayerBounds(layer)
        if (!bounds) return Handle.NONE

        const { x, y, width, height, rotation } = bounds

        // Transform point into bounding-box local coords (unrotated)
        const cx = x + width / 2
        const cy = y + height / 2
        const local = this._rotatePoint(coords.x, coords.y, cx, cy, -rotation)
        const lx = local.x - x
        const ly = local.y - y

        const hs = HANDLE_SIZE
        const rm = ROTATE_MARGIN

        const outsideBox = lx < 0 || lx > width || ly < 0 || ly > height

        if (outsideBox) {
            // Outside bounding box: rotation zones take priority near corners
            if (lx >= -rm - hs && lx <= hs && ly >= -rm - hs && ly <= hs) return Handle.ROTATE_TOP_LEFT
            if (lx >= width - hs && lx <= width + rm + hs && ly >= -rm - hs && ly <= hs) return Handle.ROTATE_TOP_RIGHT
            if (lx >= -rm - hs && lx <= hs && ly >= height - hs && ly <= height + rm + hs) return Handle.ROTATE_BOTTOM_LEFT
            if (lx >= width - hs && lx <= width + rm + hs && ly >= height - hs && ly <= height + rm + hs) return Handle.ROTATE_BOTTOM_RIGHT

            // Edge midpoint handles extend slightly outside the box
            if (this._inHandle(lx, ly, width / 2, 0)) return Handle.TOP
            if (this._inHandle(lx, ly, width / 2, height)) return Handle.BOTTOM
            if (this._inHandle(lx, ly, 0, height / 2)) return Handle.LEFT
            if (this._inHandle(lx, ly, width, height / 2)) return Handle.RIGHT

            return Handle.NONE
        }

        // Inside bounding box: scale handles take priority
        if (this._inHandle(lx, ly, 0, 0)) return Handle.TOP_LEFT
        if (this._inHandle(lx, ly, width, 0)) return Handle.TOP_RIGHT
        if (this._inHandle(lx, ly, 0, height)) return Handle.BOTTOM_LEFT
        if (this._inHandle(lx, ly, width, height)) return Handle.BOTTOM_RIGHT
        if (this._inHandle(lx, ly, width / 2, 0)) return Handle.TOP
        if (this._inHandle(lx, ly, width / 2, height)) return Handle.BOTTOM
        if (this._inHandle(lx, ly, 0, height / 2)) return Handle.LEFT
        if (this._inHandle(lx, ly, width, height / 2)) return Handle.RIGHT

        return Handle.MOVE
    }

    _inHandle(lx, ly, hx, hy) {
        const hs = HANDLE_SIZE
        return Math.abs(lx - hx) <= hs && Math.abs(ly - hy) <= hs
    }

    _rotatePoint(px, py, cx, cy, angle) {
        const rad = angle * Math.PI / 180
        const cos = Math.cos(rad)
        const sin = Math.sin(rad)
        const dx = px - cx
        const dy = py - cy
        return {
            x: cx + dx * cos - dy * sin,
            y: cy + dx * sin + dy * cos
        }
    }

    // --- Mouse handlers ---

    _onMouseDown(e) {
        if (this._state !== State.IDLE) return

        const layer = this._getActiveLayer()
        if (this._isLayerBlocked?.(layer)) return

        if (!layer) {
            this._showNoLayerDialog?.()
            return
        }

        const coords = this._getCanvasCoords(e)
        const handle = this._hitTest(coords)

        if (handle === Handle.NONE) return
        const token = this._acquireMutation
            ? this._acquireMutation()
            : { release() {} }
        if (!token) return
        this._mutationToken = token

        this._state = State.DRAGGING
        this._activeHandle = handle
        this._dragStart = coords
        this._startBounds = this._getLayerBounds(layer)
        this._startTransform = {
            offsetX: layer.offsetX || 0,
            offsetY: layer.offsetY || 0,
            scaleX: layer.scaleX ?? 1,
            scaleY: layer.scaleY ?? 1,
            rotation: layer.rotation ?? 0
        }
    }

    _onMouseMove(e) {
        const coords = this._getCanvasCoords(e)

        if (this._state === State.DRAGGING) {
            this._handleDrag(coords, e)
            return
        }

        // Hover cursor
        this._updateCursor(coords)
    }

    _onMouseUp() {
        if (this._state !== State.DRAGGING) return
        this._reset()
        this._drawOverlay()
    }

    _onCancel() {
        if (this._state !== State.DRAGGING) return
        this._reset()
        this._drawOverlay()
    }

    _onKeyDown(e) {
        if (!this._active) return

        if (e.key === 'Escape') {
            e.preventDefault()
            this._cancelTransform?.()
            return
        }

        if (e.key === 'Enter') {
            e.preventDefault()
            this._commitTransform?.()
            return
        }
    }

    // --- Drag logic ---

    _handleDrag(coords, e) {
        if (!this._startBounds || !this._startTransform || !this._dragStart) return

        const handle = this._activeHandle

        if (handle === Handle.MOVE) {
            this._handleMoveDrag(coords)
        } else if (this._isRotateHandle(handle)) {
            this._handleRotateDrag(coords, e)
        } else {
            this._handleScaleDrag(coords, e)
        }

        this._drawOverlay()
    }

    _handleMoveDrag(coords) {
        const dx = coords.x - this._dragStart.x
        const dy = coords.y - this._dragStart.y

        this._applyTransform({
            offsetX: this._startTransform.offsetX + dx,
            offsetY: this._startTransform.offsetY + dy
        })
    }

    _handleRotateDrag(coords, e) {
        const bounds = this._startBounds
        const cx = bounds.x + bounds.width / 2
        const cy = bounds.y + bounds.height / 2

        const startAngle = Math.atan2(this._dragStart.y - cy, this._dragStart.x - cx)
        const currentAngle = Math.atan2(coords.y - cy, coords.x - cx)
        let delta = (currentAngle - startAngle) * 180 / Math.PI

        if (e.shiftKey) {
            const totalRotation = this._startTransform.rotation + delta
            const snapped = Math.round(totalRotation / SNAP_ANGLE) * SNAP_ANGLE
            delta = snapped - this._startTransform.rotation
        }

        this._applyTransform({
            rotation: this._startTransform.rotation + delta
        })
    }

    _handleScaleDrag(coords, e) {
        const bounds = this._startBounds
        const handle = this._activeHandle
        const st = this._startTransform

        // Work in local (unrotated) space
        const cx = bounds.x + bounds.width / 2
        const cy = bounds.y + bounds.height / 2

        const localStart = this._rotatePoint(this._dragStart.x, this._dragStart.y, cx, cy, -bounds.rotation)
        const localCurrent = this._rotatePoint(coords.x, coords.y, cx, cy, -bounds.rotation)

        const dx = localCurrent.x - localStart.x
        const dy = localCurrent.y - localStart.y

        let newScaleX = st.scaleX
        let newScaleY = st.scaleY
        let newOffsetX = st.offsetX
        let newOffsetY = st.offsetY

        const baseWidth = bounds.width / Math.abs(st.scaleX)
        const baseHeight = bounds.height / Math.abs(st.scaleY)

        // Determine scale deltas based on handle
        if (this._isCornerHandle(handle) || this._isHorizontalEdge(handle)) {
            const sign = (handle === Handle.LEFT || handle === Handle.TOP_LEFT || handle === Handle.BOTTOM_LEFT) ? -1 : 1
            if (this._isCornerHandle(handle) || this._isHorizontalEdge(handle)) {
                if (handle === Handle.LEFT || handle === Handle.TOP_LEFT || handle === Handle.BOTTOM_LEFT) {
                    newScaleX = st.scaleX - dx / baseWidth
                } else if (handle === Handle.RIGHT || handle === Handle.TOP_RIGHT || handle === Handle.BOTTOM_RIGHT) {
                    newScaleX = st.scaleX + dx / baseWidth
                }
            }
        }

        if (this._isCornerHandle(handle) || this._isVerticalEdge(handle)) {
            if (handle === Handle.TOP || handle === Handle.TOP_LEFT || handle === Handle.TOP_RIGHT) {
                newScaleY = st.scaleY - dy / baseHeight
            } else if (handle === Handle.BOTTOM || handle === Handle.BOTTOM_LEFT || handle === Handle.BOTTOM_RIGHT) {
                newScaleY = st.scaleY + dy / baseHeight
            }
        }

        // Shift = constrain aspect ratio
        if (e.shiftKey && this._isCornerHandle(handle)) {
            const avgScale = (Math.abs(newScaleX) + Math.abs(newScaleY)) / 2
            newScaleX = avgScale * Math.sign(newScaleX || 1)
            newScaleY = avgScale * Math.sign(newScaleY || 1)
        }

        // Alt = scale from center (no offset adjustment needed since offset is center-relative)
        if (!e.altKey) {
            // Anchor the opposite edge: adjust center-relative offset so opposite edge stays fixed
            const newW = baseWidth * Math.abs(newScaleX)
            const newH = baseHeight * Math.abs(newScaleY)
            const dw = newW - bounds.width
            const dh = newH - bounds.height

            const cos = Math.cos(bounds.rotation * Math.PI / 180)
            const sin = Math.sin(bounds.rotation * Math.PI / 180)

            // Center-relative offset: shifting by dw/2 keeps the opposite edge anchored
            let anchorDx = 0
            let anchorDy = 0

            if (handle === Handle.RIGHT || handle === Handle.TOP_RIGHT || handle === Handle.BOTTOM_RIGHT) {
                anchorDx = dw / 2
            } else if (handle === Handle.LEFT || handle === Handle.TOP_LEFT || handle === Handle.BOTTOM_LEFT) {
                anchorDx = -dw / 2
            }

            if (handle === Handle.BOTTOM || handle === Handle.BOTTOM_LEFT || handle === Handle.BOTTOM_RIGHT) {
                anchorDy = dh / 2
            } else if (handle === Handle.TOP || handle === Handle.TOP_LEFT || handle === Handle.TOP_RIGHT) {
                anchorDy = -dh / 2
            }

            // Rotate the anchor delta by the layer rotation
            newOffsetX = st.offsetX + anchorDx * cos - anchorDy * sin
            newOffsetY = st.offsetY + anchorDx * sin + anchorDy * cos
        }

        // Minimum scale clamp
        const minScale = 0.01
        if (Math.abs(newScaleX) < minScale) newScaleX = minScale * Math.sign(newScaleX || 1)
        if (Math.abs(newScaleY) < minScale) newScaleY = minScale * Math.sign(newScaleY || 1)

        this._applyTransform({
            scaleX: newScaleX,
            scaleY: newScaleY,
            offsetX: newOffsetX,
            offsetY: newOffsetY
        })
    }

    _isCornerHandle(handle) {
        return handle === Handle.TOP_LEFT || handle === Handle.TOP_RIGHT ||
               handle === Handle.BOTTOM_LEFT || handle === Handle.BOTTOM_RIGHT
    }

    _isHorizontalEdge(handle) {
        return handle === Handle.LEFT || handle === Handle.RIGHT
    }

    _isVerticalEdge(handle) {
        return handle === Handle.TOP || handle === Handle.BOTTOM
    }

    _isRotateHandle(handle) {
        return handle === Handle.ROTATE_TOP_LEFT || handle === Handle.ROTATE_TOP_RIGHT ||
               handle === Handle.ROTATE_BOTTOM_LEFT || handle === Handle.ROTATE_BOTTOM_RIGHT
    }

    // --- Cursor ---

    _updateCursor(coords) {
        const handle = this._hitTest(coords)
        let cursor = 'default'

        if (handle === Handle.MOVE) {
            cursor = 'move'
        } else if (this._isRotateHandle(handle)) {
            cursor = 'crosshair'
        } else if (handle === Handle.TOP || handle === Handle.BOTTOM) {
            cursor = 'ns-resize'
        } else if (handle === Handle.LEFT || handle === Handle.RIGHT) {
            cursor = 'ew-resize'
        } else if (handle === Handle.TOP_LEFT || handle === Handle.BOTTOM_RIGHT) {
            cursor = 'nwse-resize'
        } else if (handle === Handle.TOP_RIGHT || handle === Handle.BOTTOM_LEFT) {
            cursor = 'nesw-resize'
        }

        this._overlay.style.cursor = cursor
    }

    // --- Overlay drawing ---

    _drawOverlay() {
        const ctx = this._overlay.getContext('2d')
        ctx.clearRect(0, 0, this._overlay.width, this._overlay.height)

        const layer = this._getActiveLayer()
        if (!layer) return

        const bounds = this._getLayerBounds(layer)
        if (!bounds) return

        const { x, y, width, height, rotation } = bounds
        const cx = x + width / 2
        const cy = y + height / 2

        ctx.save()
        ctx.translate(cx, cy)
        ctx.rotate(rotation * Math.PI / 180)
        ctx.translate(-width / 2, -height / 2)

        // Bounding box
        ctx.strokeStyle = '#00aaff'
        ctx.lineWidth = 1.5
        ctx.setLineDash([])
        ctx.strokeRect(0, 0, width, height)

        // Scale handles
        const hs = HANDLE_SIZE
        const handlePositions = [
            [0, 0], [width, 0], [0, height], [width, height],           // corners
            [width / 2, 0], [width / 2, height], [0, height / 2], [width, height / 2]  // edges
        ]

        ctx.fillStyle = '#ffffff'
        ctx.strokeStyle = '#00aaff'
        ctx.lineWidth = 1

        for (const [hx, hy] of handlePositions) {
            ctx.fillRect(hx - hs / 2, hy - hs / 2, hs, hs)
            ctx.strokeRect(hx - hs / 2, hy - hs / 2, hs, hs)
        }

        // Rotation indicator — small arc outside each corner
        ctx.strokeStyle = 'rgba(0, 170, 255, 0.4)'
        ctx.lineWidth = 1
        const arcR = ROTATE_MARGIN
        const cornerAngles = [
            [0, 0, Math.PI, Math.PI * 1.5],
            [width, 0, Math.PI * 1.5, Math.PI * 2],
            [0, height, Math.PI * 0.5, Math.PI],
            [width, height, 0, Math.PI * 0.5]
        ]
        for (const [ax, ay, startA, endA] of cornerAngles) {
            ctx.beginPath()
            ctx.arc(ax, ay, arcR, startA, endA)
            ctx.stroke()
        }

        ctx.restore()
    }

    _clearOverlay() {
        const ctx = this._overlay.getContext('2d')
        ctx.clearRect(0, 0, this._overlay.width, this._overlay.height)
    }
}

export { TransformTool }
