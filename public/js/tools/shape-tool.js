/**
 * Shape Tool - Draw rectangles and ellipses by click-dragging
 *
 * FSM States: IDLE -> DRAWING -> IDLE
 *
 * @module tools/shape-tool
 */

import { createShapeStroke } from '../drawing/stroke-model.js'

const State = { IDLE: 'idle', DRAWING: 'drawing' }
const MOUSE_EVENTS = ['mousedown', 'mousemove', 'mouseup', 'mouseleave']

export class ShapeTool {
    constructor(options) {
        this._overlay = options.overlay
        this._ensureDrawingLayer = options.ensureDrawingLayer
        this._rasterizeDrawingLayer = options.rasterizeDrawingLayer
        this._rebuild = options.rebuild
        this._pushUndoState = options.pushUndoState
        this._finalizePendingUndo = options.finalizePendingUndo
        this._markDirty = options.markDirty

        this._color = '#000000'
        this._size = 2
        this._opacity = 1
        this._filled = false
        this._shapeType = 'rect'  // 'rect' | 'ellipse'

        this._active = false
        this._state = State.IDLE
        this._startPt = null
        this._currentPt = null
        this._targetLayer = null

        this._onMouseDown = this._onMouseDown.bind(this)
        this._onMouseMove = this._onMouseMove.bind(this)
        this._onMouseUp = this._onMouseUp.bind(this)
    }

    get shapeType() { return this._shapeType }
    set shapeType(v) { this._shapeType = v }
    get color() { return this._color }
    set color(v) { this._color = v }
    get size() { return this._size }
    set size(v) { this._size = Math.max(1, Math.min(100, v)) }
    get opacity() { return this._opacity }
    set opacity(v) { this._opacity = Math.max(0, Math.min(1, v)) }
    get filled() { return this._filled }
    set filled(v) { this._filled = v }

    activate() {
        if (this._active) return
        this._active = true
        this._state = State.IDLE

        MOUSE_EVENTS.forEach((evt, i) => {
            const handler = [this._onMouseDown, this._onMouseMove, this._onMouseUp, this._onMouseUp][i]
            this._overlay.addEventListener(evt, handler)
        })
    }

    deactivate() {
        if (!this._active) return
        this._active = false
        this._clearPreview()

        MOUSE_EVENTS.forEach((evt, i) => {
            const handler = [this._onMouseDown, this._onMouseMove, this._onMouseUp, this._onMouseUp][i]
            this._overlay.removeEventListener(evt, handler)
        })
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
        this._state = State.DRAWING
        this._targetLayer = this._ensureDrawingLayer()
        this._startPt = this._getCanvasCoords(e)
        this._currentPt = { ...this._startPt }
    }

    _onMouseMove(e) {
        if (this._state !== State.DRAWING) return
        this._currentPt = this._getCanvasCoords(e)

        // Shift = constrain to square/circle
        if (e.shiftKey && (this._shapeType === 'rect' || this._shapeType === 'ellipse')) {
            const dx = this._currentPt.x - this._startPt.x
            const dy = this._currentPt.y - this._startPt.y
            const size = Math.max(Math.abs(dx), Math.abs(dy))
            this._currentPt.x = this._startPt.x + size * Math.sign(dx)
            this._currentPt.y = this._startPt.y + size * Math.sign(dy)
        }

        this._drawPreview()
    }

    async _onMouseUp(e) {
        if (this._state !== State.DRAWING) return
        this._state = State.IDLE

        // Capture this gesture's state and clear instance state BEFORE awaiting,
        // so a new shape begun during the rebuild isn't clobbered on resume.
        const startPt = this._startPt
        const currentPt = this._currentPt
        const targetLayer = this._targetLayer
        this._startPt = null
        this._currentPt = null
        this._targetLayer = null

        if (startPt && currentPt && targetLayer) {
            this._finalizePendingUndo()

            const x = Math.min(startPt.x, currentPt.x)
            const y = Math.min(startPt.y, currentPt.y)
            const width = Math.abs(currentPt.x - startPt.x)
            const height = Math.abs(currentPt.y - startPt.y)

            const stroke = createShapeStroke({
                type: this._shapeType,
                color: this._color,
                size: this._size,
                opacity: this._opacity,
                x, y, width, height,
                filled: this._filled
            })

            targetLayer.strokes.push(stroke)
            await this._rasterizeDrawingLayer(targetLayer)
            await this._rebuild({ force: true })
            this._markDirty()
            this._pushUndoState()
        }

        // Only clear the preview if no new shape began during the awaits above.
        if (this._state === State.IDLE) this._clearPreview()
    }

    _drawPreview() {
        const ctx = this._overlay.getContext('2d')
        ctx.clearRect(0, 0, this._overlay.width, this._overlay.height)
        if (!this._startPt || !this._currentPt) return

        ctx.save()
        ctx.strokeStyle = this._color
        ctx.fillStyle = this._color
        ctx.lineWidth = this._size
        ctx.setLineDash([5, 5])
        ctx.globalAlpha = this._opacity * 0.6

        const x = Math.min(this._startPt.x, this._currentPt.x)
        const y = Math.min(this._startPt.y, this._currentPt.y)
        const w = Math.abs(this._currentPt.x - this._startPt.x)
        const h = Math.abs(this._currentPt.y - this._startPt.y)

        if (this._shapeType === 'rect') {
            ctx.strokeRect(x, y, w, h)
        } else if (this._shapeType === 'ellipse') {
            ctx.beginPath()
            ctx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2)
            ctx.stroke()
        }

        ctx.restore()
    }

    _clearPreview() {
        const ctx = this._overlay.getContext('2d')
        ctx.clearRect(0, 0, this._overlay.width, this._overlay.height)
    }
}
