/**
 * Brush Tool - Freehand drawing with path strokes
 *
 * FSM States: IDLE -> DRAWING -> IDLE
 *
 * @module tools/brush-tool
 */

import { createPathStroke } from '../drawing/stroke-model.js'

const State = { IDLE: 'idle', DRAWING: 'drawing' }
const MOUSE_EVENTS = ['mousedown', 'mousemove', 'mouseup', 'mouseleave']
const MIN_DISTANCE = 2  // minimum pixels between sampled points

export class BrushTool {
    constructor(options) {
        this._overlay = options.overlay
        this._ensureDrawingLayer = options.ensureDrawingLayer
        this._rasterizeDrawingLayer = options.rasterizeDrawingLayer
        this._rebuild = options.rebuild
        this._pushUndoState = options.pushUndoState
        this._finalizePendingUndo = options.finalizePendingUndo
        this._markDirty = options.markDirty
        this._acquireMutation = options.acquireMutation

        /** @type {((stroke: object) => void)|null} */
        this.onStrokeComplete = null

        this._color = '#000000'
        this._size = 5
        this._opacity = 1

        this._active = false
        this._state = State.IDLE
        this._currentPoints = []
        this._mutationToken = null
        this._sharedMutationToken = null

        this._onMouseDown = this._onMouseDown.bind(this)
        this._onMouseMove = this._onMouseMove.bind(this)
        this._onMouseUp = this._onMouseUp.bind(this)
        this._cancelGesture = this._cancelGesture.bind(this)
    }

    get color() { return this._color }
    set color(v) { this._color = v }

    get size() { return this._size }
    set size(v) { this._size = Math.max(1, Math.min(100, v)) }

    get opacity() { return this._opacity }
    set opacity(v) { this._opacity = Math.max(0, Math.min(1, v)) }

    /** True while a stroke gesture is between mousedown and mouseup. */
    get isDrawing() { return this._state === State.DRAWING }

    activate() {
        if (this._active) return
        this._active = true
        this._state = State.IDLE

        MOUSE_EVENTS.forEach((evt, i) => {
            const handler = [this._onMouseDown, this._onMouseMove, this._onMouseUp, this._onMouseUp][i]
            this._overlay.addEventListener(evt, handler)
        })
        this._overlay.addEventListener('pointercancel', this._cancelGesture)
        window.addEventListener('blur', this._cancelGesture)
    }

    deactivate() {
        if (!this._active) return
        this._active = false
        this._mutationToken?.release()
        this._mutationToken = null
        this._state = State.IDLE
        this._currentPoints = []
        this._clearPreview()

        MOUSE_EVENTS.forEach((evt, i) => {
            const handler = [this._onMouseDown, this._onMouseMove, this._onMouseUp, this._onMouseUp][i]
            this._overlay.removeEventListener(evt, handler)
        })
        this._overlay.removeEventListener('pointercancel', this._cancelGesture)
        window.removeEventListener('blur', this._cancelGesture)
    }

    _getCanvasCoords(e) {
        const rect = this._overlay.getBoundingClientRect()
        return {
            x: (e.clientX - rect.left) * (this._overlay.width / rect.width),
            y: (e.clientY - rect.top) * (this._overlay.height / rect.height)
        }
    }

    _onMouseDown(e) {
        if (e.button !== 0) return
        const token = this._acquireMutation
            ? this._acquireMutation(this._sharedMutationToken)
            : { release() {} }
        if (!token) return
        this._sharedMutationToken = token
        this._mutationToken = token
        this._state = State.DRAWING

        const pt = this._getCanvasCoords(e)
        this._currentPoints = [pt]
        this._drawPreview()
    }

    _onMouseMove(e) {
        if (this._state !== State.DRAWING) return
        const pt = this._getCanvasCoords(e)

        // Distance-based sampling
        const last = this._currentPoints[this._currentPoints.length - 1]
        const dx = pt.x - last.x
        const dy = pt.y - last.y
        if (dx * dx + dy * dy >= MIN_DISTANCE * MIN_DISTANCE) {
            this._currentPoints.push(pt)
            this._drawPreview()
        }
    }

    _cancelGesture() {
        if (this._state !== State.DRAWING) return
        const token = this._mutationToken
        this._state = State.IDLE
        this._currentPoints = []
        this._mutationToken = null
        token?.release()
        if (this._sharedMutationToken?.released) this._sharedMutationToken = null
        this._clearPreview()
    }

    async _onMouseUp(e) {
        if (this._state !== State.DRAWING) return
        this._state = State.IDLE

        // Capture this gesture's state and clear instance state BEFORE awaiting,
        // so a new stroke begun during the rebuild isn't clobbered on resume.
        const points = this._currentPoints
        const mutationToken = this._mutationToken
        this._currentPoints = []
        this._mutationToken = null

        try {
            if (points.length > 0) {
                const stroke = createPathStroke({
                    color: this._color,
                    size: this._size,
                    opacity: this._opacity,
                    points
                })

                // If an external handler is set (e.g. mask edit mode), route the stroke there
                if (this.onStrokeComplete) {
                    await this.onStrokeComplete(stroke)
                } else {
                    const targetLayer = this._ensureDrawingLayer()
                    this._finalizePendingUndo()
                    targetLayer.strokes.push(stroke)
                    await this._rasterizeDrawingLayer(targetLayer)
                    await this._rebuild({ force: true })
                    this._markDirty()
                    this._pushUndoState()
                }
            }
        } finally {
            mutationToken?.release()
            if (this._sharedMutationToken?.released) {
                this._sharedMutationToken = null
            }
            // Only clear the preview if no new stroke began during the awaits above.
            if (this._state === State.IDLE) this._clearPreview()
        }
    }

    _drawPreview() {
        const ctx = this._overlay.getContext('2d')
        ctx.clearRect(0, 0, this._overlay.width, this._overlay.height)

        if (this._currentPoints.length < 1) return

        ctx.save()
        ctx.strokeStyle = this._color
        ctx.lineWidth = this._size
        ctx.lineCap = 'round'
        ctx.lineJoin = 'round'
        ctx.globalAlpha = this._opacity

        const pts = this._currentPoints
        ctx.beginPath()
        ctx.moveTo(pts[0].x, pts[0].y)

        for (let i = 1; i < pts.length - 1; i++) {
            const mx = (pts[i].x + pts[i + 1].x) / 2
            const my = (pts[i].y + pts[i + 1].y) / 2
            ctx.quadraticCurveTo(pts[i].x, pts[i].y, mx, my)
        }

        if (pts.length > 1) {
            const last = pts[pts.length - 1]
            ctx.lineTo(last.x, last.y)
        }

        ctx.stroke()
        ctx.restore()
    }

    _clearPreview() {
        const ctx = this._overlay.getContext('2d')
        ctx.clearRect(0, 0, this._overlay.width, this._overlay.height)
    }
}
