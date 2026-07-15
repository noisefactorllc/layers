/**
 * Eraser Tool - Delete whole strokes from drawing layers
 *
 * Click near a stroke to delete it. Drag across multiple strokes to
 * delete them all in one undo step.
 *
 * FSM States: IDLE -> ERASING -> IDLE
 *
 * @module tools/eraser-tool
 */

const MOUSE_EVENTS = ['mousedown', 'mousemove', 'mouseup', 'mouseleave']
const HIT_TOLERANCE = 8

export class EraserTool {
    constructor(options) {
        this._overlay = options.overlay
        this._getActiveLayer = options.getActiveLayer
        this._rasterizeDrawingLayer = options.rasterizeDrawingLayer
        this._rebuild = options.rebuild
        this._pushUndoState = options.pushUndoState
        this._finalizePendingUndo = options.finalizePendingUndo
        this._markDirty = options.markDirty
        this._acquireMutation = options.acquireMutation

        this._active = false
        this._dragging = false
        this._deletedInDrag = new Set()
        this._hoveredStrokeId = null
        this._mutationToken = null
        this._deleteTail = Promise.resolve()

        this._onMouseDown = this._onMouseDown.bind(this)
        this._onMouseMove = this._onMouseMove.bind(this)
        this._onMouseUp = this._onMouseUp.bind(this)
        this._onCancel = this._onCancel.bind(this)
    }

    /** True while an erase drag gesture is between mousedown and mouseup. */
    get isErasing() { return this._dragging }

    activate() {
        if (this._active) return
        this._active = true
        MOUSE_EVENTS.forEach((evt, i) => {
            const handler = [this._onMouseDown, this._onMouseMove, this._onMouseUp, this._onMouseUp][i]
            this._overlay.addEventListener(evt, handler)
        })
        this._overlay.addEventListener('pointercancel', this._onCancel)
        window.addEventListener('blur', this._onCancel)
    }

    deactivate() {
        if (!this._active) return
        this._active = false
        if (this._dragging) void this._finishGesture()
        this._clearOverlay()
        MOUSE_EVENTS.forEach((evt, i) => {
            const handler = [this._onMouseDown, this._onMouseMove, this._onMouseUp, this._onMouseUp][i]
            this._overlay.removeEventListener(evt, handler)
        })
        this._overlay.removeEventListener('pointercancel', this._onCancel)
        window.removeEventListener('blur', this._onCancel)
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
            ? this._acquireMutation()
            : { release() {} }
        if (!token) return
        this._mutationToken = token
        this._dragging = true
        this._deletedInDrag = new Set()
        this._deleteTail = Promise.resolve()
        this._finalizePendingUndo() // flush any pending debounce once, before the gesture
        this._queueDelete(e)
    }

    _onMouseMove(e) {
        if (this._dragging) {
            this._queueDelete(e)
        } else {
            this._updateHover(e)
        }
    }

    _onMouseUp() {
        if (!this._dragging) return
        void this._finishGesture()
    }

    _onCancel() {
        if (this._dragging) void this._finishGesture()
    }

    async _finishGesture() {
        this._dragging = false
        const mutationToken = this._mutationToken
        this._mutationToken = null
        try {
            await this._deleteTail
            // One undo step for the whole erase gesture (see class doc). Pushing per
            // delete also raced the async rasterize, snapshotting the wrong state.
            if (this._deletedInDrag.size > 0) {
                this._pushUndoState()
            }
        } catch (err) {
            console.error('[EraserTool] Failed to erase stroke:', err)
        } finally {
            this._deletedInDrag.clear()
            mutationToken?.release()
        }
    }

    _queueDelete(e) {
        this._deleteTail = this._deleteTail.then(() => this._tryDelete(e))
    }

    async _tryDelete(e) {
        const layer = this._getActiveLayer()
        if (!layer || layer.sourceType !== 'drawing') return

        const pt = this._getCanvasCoords(e)
        const hit = this._hitTest(layer.strokes, pt)

        if (hit && !this._deletedInDrag.has(hit.id)) {
            this._deletedInDrag.add(hit.id)
            layer.strokes = layer.strokes.filter(s => s.id !== hit.id)
            await this._rasterizeDrawingLayer(layer)
            await this._rebuild({ force: true })
            this._markDirty()
        }
    }

    _updateHover(e) {
        const layer = this._getActiveLayer()
        if (!layer || layer.sourceType !== 'drawing') {
            if (this._hoveredStrokeId) {
                this._hoveredStrokeId = null
                this._clearOverlay()
            }
            return
        }
        const pt = this._getCanvasCoords(e)
        const hit = this._hitTest(layer.strokes, pt)
        const newId = hit?.id || null
        if (newId !== this._hoveredStrokeId) {
            this._hoveredStrokeId = newId
            this._drawHoverHighlight(layer.strokes, newId)
        }
    }

    _hitTest(strokes, pt) {
        for (let i = strokes.length - 1; i >= 0; i--) {
            const s = strokes[i]
            if (this._strokeContainsPoint(s, pt)) return s
        }
        return null
    }

    _strokeContainsPoint(stroke, pt) {
        const tolerance = (stroke.size / 2) + HIT_TOLERANCE
        if (stroke.type === 'path') {
            for (let i = 0; i < stroke.points.length - 1; i++) {
                if (this._distToSegment(pt, stroke.points[i], stroke.points[i + 1]) <= tolerance) return true
            }
            if (stroke.points.length === 1) {
                const dx = pt.x - stroke.points[0].x
                const dy = pt.y - stroke.points[0].y
                return Math.sqrt(dx * dx + dy * dy) <= tolerance
            }
            return false
        }
        if (stroke.type === 'rect' || stroke.type === 'ellipse') {
            return pt.x >= stroke.x - tolerance && pt.x <= stroke.x + stroke.width + tolerance &&
                   pt.y >= stroke.y - tolerance && pt.y <= stroke.y + stroke.height + tolerance
        }
        if (stroke.type === 'line' || stroke.type === 'arrow') {
            if (stroke.points.length >= 2) return this._distToSegment(pt, stroke.points[0], stroke.points[1]) <= tolerance
            return false
        }
        return false
    }

    _distToSegment(p, a, b) {
        const dx = b.x - a.x, dy = b.y - a.y
        const lenSq = dx * dx + dy * dy
        if (lenSq === 0) {
            const ex = p.x - a.x, ey = p.y - a.y
            return Math.sqrt(ex * ex + ey * ey)
        }
        let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq
        t = Math.max(0, Math.min(1, t))
        const projX = a.x + t * dx, projY = a.y + t * dy
        const ex = p.x - projX, ey = p.y - projY
        return Math.sqrt(ex * ex + ey * ey)
    }

    _drawHoverHighlight(strokes, strokeId) {
        const ctx = this._overlay.getContext('2d')
        ctx.clearRect(0, 0, this._overlay.width, this._overlay.height)
        if (!strokeId) return
        const stroke = strokes.find(s => s.id === strokeId)
        if (!stroke) return
        ctx.save()
        ctx.strokeStyle = '#ff4444'
        ctx.lineWidth = stroke.size + 4
        ctx.lineCap = 'round'
        ctx.lineJoin = 'round'
        ctx.globalAlpha = 0.5
        if (stroke.type === 'path' && stroke.points.length >= 2) {
            ctx.beginPath()
            ctx.moveTo(stroke.points[0].x, stroke.points[0].y)
            for (let i = 1; i < stroke.points.length; i++) ctx.lineTo(stroke.points[i].x, stroke.points[i].y)
            ctx.stroke()
        } else if (stroke.type === 'rect') {
            ctx.strokeRect(stroke.x, stroke.y, stroke.width, stroke.height)
        }
        ctx.restore()
    }

    _clearOverlay() {
        const ctx = this._overlay.getContext('2d')
        ctx.clearRect(0, 0, this._overlay.width, this._overlay.height)
    }
}
