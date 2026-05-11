/**
 * Stroke renderer — rasterizes stroke objects to a Canvas 2D context.
 *
 * @module drawing/stroke-renderer
 */

export class StrokeRenderer {
    constructor() {
        this._canvas = null
        this._ctx = null
    }

    rasterize(strokes, width, height) {
        if (!this._canvas || this._canvas.width !== width || this._canvas.height !== height) {
            this._canvas = new OffscreenCanvas(width, height)
            this._ctx = this._canvas.getContext('2d')
        }

        this._ctx.clearRect(0, 0, width, height)

        for (const stroke of strokes) {
            this._ctx.save()
            this._ctx.globalAlpha = stroke.opacity ?? 1
            this._ctx.strokeStyle = stroke.color
            this._ctx.fillStyle = stroke.color
            this._ctx.lineWidth = stroke.size
            this._ctx.lineCap = 'round'
            this._ctx.lineJoin = 'round'
            // Eraser strokes punch holes in the previously-rasterized strokes via
            // `destination-out` compositing. Existing strokes without a `mode`
            // default to brush behavior (`source-over`).
            this._ctx.globalCompositeOperation = stroke.mode === 'eraser'
                ? 'destination-out'
                : 'source-over'

            switch (stroke.type) {
                case 'path': this._drawPath(stroke); break
                case 'rect': this._drawRect(stroke); break
                case 'ellipse': this._drawEllipse(stroke); break
                case 'line': this._drawLine(stroke); break
                case 'arrow': this._drawArrow(stroke); break
            }

            this._ctx.restore()
        }

        return this._canvas
    }

    _drawPath(stroke) {
        const pts = stroke.points
        if (pts.length < 2) {
            if (pts.length === 1) {
                this._ctx.beginPath()
                this._ctx.arc(pts[0].x, pts[0].y, stroke.size / 2, 0, Math.PI * 2)
                this._ctx.fill()
            }
            return
        }

        this._ctx.beginPath()
        this._ctx.moveTo(pts[0].x, pts[0].y)

        for (let i = 1; i < pts.length - 1; i++) {
            const mx = (pts[i].x + pts[i + 1].x) / 2
            const my = (pts[i].y + pts[i + 1].y) / 2
            this._ctx.quadraticCurveTo(pts[i].x, pts[i].y, mx, my)
        }

        const last = pts[pts.length - 1]
        this._ctx.lineTo(last.x, last.y)
        this._ctx.stroke()
    }

    _drawRect(stroke) {
        if (stroke.filled) {
            this._ctx.fillRect(stroke.x, stroke.y, stroke.width, stroke.height)
        } else {
            this._ctx.strokeRect(stroke.x, stroke.y, stroke.width, stroke.height)
        }
    }

    _drawEllipse(stroke) {
        const cx = stroke.x + stroke.width / 2
        const cy = stroke.y + stroke.height / 2
        const rx = Math.abs(stroke.width / 2)
        const ry = Math.abs(stroke.height / 2)

        this._ctx.beginPath()
        this._ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2)

        if (stroke.filled) {
            this._ctx.fill()
        } else {
            this._ctx.stroke()
        }
    }

    _drawLine(stroke) {
        if (stroke.points.length < 2) return
        this._ctx.beginPath()
        this._ctx.moveTo(stroke.points[0].x, stroke.points[0].y)
        this._ctx.lineTo(stroke.points[1].x, stroke.points[1].y)
        this._ctx.stroke()
    }

    _drawArrow(stroke) {
        if (stroke.points.length < 2) return
        const p0 = stroke.points[0]
        const p1 = stroke.points[1]

        // Shaft
        this._ctx.beginPath()
        this._ctx.moveTo(p0.x, p0.y)
        this._ctx.lineTo(p1.x, p1.y)
        this._ctx.stroke()

        // Arrowhead
        const angle = Math.atan2(p1.y - p0.y, p1.x - p0.x)
        const headLen = Math.max(stroke.size * 3, 10)
        const headAngle = Math.PI / 6

        this._ctx.beginPath()
        this._ctx.moveTo(p1.x, p1.y)
        this._ctx.lineTo(
            p1.x - headLen * Math.cos(angle - headAngle),
            p1.y - headLen * Math.sin(angle - headAngle)
        )
        this._ctx.moveTo(p1.x, p1.y)
        this._ctx.lineTo(
            p1.x - headLen * Math.cos(angle + headAngle),
            p1.y - headLen * Math.sin(angle + headAngle)
        )
        this._ctx.stroke()
    }
}
