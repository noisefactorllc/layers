/**
 * Selection Manager
 * Manages marquee selection state and rendering
 *
 * @module selection/selection-manager
 */

import { floodFill } from './flood-fill.js'

/**
 * @typedef {'rectangle' | 'oval' | 'lasso' | 'polygon' | 'wand'} SelectionTool
 */

/**
 * @typedef {Object} RectSelection
 * @property {'rect'} type
 * @property {number} x
 * @property {number} y
 * @property {number} width
 * @property {number} height
 */

/**
 * @typedef {Object} OvalSelection
 * @property {'oval'} type
 * @property {number} cx - Center X
 * @property {number} cy - Center Y
 * @property {number} rx - Radius X
 * @property {number} ry - Radius Y
 */

/**
 * @typedef {Object} LassoSelection
 * @property {'lasso'} type
 * @property {Array<{x: number, y: number}>} points
 */

/**
 * @typedef {Object} PolygonSelection
 * @property {'polygon'} type
 * @property {Array<{x: number, y: number}>} points
 */

/**
 * @typedef {Object} WandSelection
 * @property {'wand'} type
 * @property {ImageData} mask
 */

/**
 * @typedef {Object} MaskSelection
 * @property {'mask'} type
 * @property {ImageData} data
 */

/**
 * @typedef {'replace' | 'add' | 'subtract'} SelectionMode
 */

/**
 * @typedef {RectSelection | OvalSelection | LassoSelection | PolygonSelection | WandSelection | MaskSelection | null} SelectionPath
 */

class SelectionManager {
    constructor() {
        /** @type {SelectionTool} */
        this._currentTool = 'rectangle'

        /** @type {SelectionPath} */
        this._selectionPath = null

        /** @type {boolean} */
        this._isDrawing = false

        /** @type {{x: number, y: number} | null} */
        this._drawStart = null

        /** @type {HTMLCanvasElement | null} */
        this._overlay = null

        /** @type {CanvasRenderingContext2D | null} */
        this._ctx = null

        /** @type {number | null} */
        this._animationId = null

        /** @type {number} */
        this._dashOffset = 0

        // Cached Path2D for the selection outline. Rebuilt only when
        // _selectionPath changes (it is always reassigned, never mutated in
        // place), so the marching-ants loop reuses the geometry instead of
        // re-tracing it twice per frame — critical for wand/mask paths whose
        // outline is an O(width*height) boundary scan.
        /** @type {Path2D | null} */
        this._cachedStrokePath = null
        this._cachedStrokePathSource = null

        /** @type {{x: number, y: number} | null} */
        this._copyOrigin = null

        /** @type {SelectionMode} */
        this._selectionMode = 'replace'

        /** @type {Array<{x: number, y: number}>} */
        this._lassoPoints = []

        /** @type {Array<{x: number, y: number}>} */
        this._polygonPoints = []

        /** @type {boolean} */
        this._isPolygonDrawing = false

        /** @type {number} */
        this._wandTolerance = 32

        /** @type {HTMLCanvasElement | null} */
        this._sourceCanvas = null

        /** @type {SelectionPath} */
        this._previousSelection = null

        /** @type {boolean} */
        this._enabled = true

        /** @type {Function|null} */
        this.onSelectionChange = null
    }

    /**
     * Initialize the selection manager
     * @param {HTMLCanvasElement} overlay - The overlay canvas element
     */
    init(overlay) {
        this._overlay = overlay
        this._ctx = overlay.getContext('2d')
        this._setupEventListeners()
    }

    /**
     * Get current selection tool
     * @returns {SelectionTool}
     */
    get currentTool() {
        return this._currentTool
    }

    /**
     * Set current selection tool
     * @param {SelectionTool} tool
     */
    set currentTool(tool) {
        this._currentTool = tool
    }

    /**
     * Get magic wand tolerance
     * @returns {number}
     */
    get wandTolerance() {
        return this._wandTolerance
    }

    /**
     * Set magic wand tolerance
     * @param {number} value
     */
    set wandTolerance(value) {
        this._wandTolerance = Math.max(0, Math.min(255, value))
    }

    /**
     * Set source canvas for magic wand sampling
     * @param {HTMLCanvasElement} canvas
     */
    setSourceCanvas(canvas) {
        this._sourceCanvas = canvas
    }

    /**
     * Enable or disable the selection manager
     * @param {boolean} value
     */
    set enabled(value) {
        this._enabled = value
    }

    /**
     * Check if selection manager is enabled
     * @returns {boolean}
     */
    get enabled() {
        return this._enabled
    }

    /**
     * Get current selection path
     * @returns {SelectionPath}
     */
    get selectionPath() {
        return this._selectionPath
    }

    /**
     * Check if there's an active selection
     * @returns {boolean}
     */
    hasSelection() {
        return this._selectionPath !== null
    }

    /**
     * Clear the current selection
     */
    clearSelection() {
        this._selectionPath = null
        this._copyOrigin = null
        this._stopAnimation()
        this._clearOverlay()
        this.onSelectionChange?.()
    }

    /**
     * Set the selection programmatically.
     * @param {SelectionPath} path
     */
    setSelection(path) {
        if (!path) {
            this.clearSelection()
            return
        }
        this._selectionPath = path
        this._startAnimation()
        this.onSelectionChange?.()
    }

    /**
     * Set up mouse event listeners
     * @private
     */
    _setupEventListeners() {
        if (!this._overlay) return

        this._overlay.addEventListener('mousedown', (e) => this._handleMouseDown(e))
        this._overlay.addEventListener('mousemove', (e) => this._handleMouseMove(e))
        this._overlay.addEventListener('mouseup', (e) => this._handleMouseUp(e))
        this._overlay.addEventListener('mouseleave', (e) => this._handleMouseUp(e))
        this._overlay.addEventListener('dblclick', (e) => this._handleDoubleClick(e))
        document.addEventListener('keydown', (e) => this._handleKeyDown(e))
    }

    /**
     * Rasterize current selection to an ImageData mask.
     * @returns {ImageData | null}
     */
    rasterizeSelection() {
        if (!this._selectionPath || !this._overlay) return null

        const { width, height } = this._overlay
        const path = this._selectionPath

        if (path.type === 'wand') return path.mask
        if (path.type === 'mask') return path.data

        const offscreen = new OffscreenCanvas(width, height)
        const ctx = offscreen.getContext('2d')

        ctx.fillStyle = 'white'

        if (path.type === 'rect') {
            ctx.fillRect(path.x, path.y, path.width, path.height)
        } else if (path.type === 'oval') {
            ctx.beginPath()
            ctx.ellipse(path.cx, path.cy, path.rx, path.ry, 0, 0, Math.PI * 2)
            ctx.fill()
        } else if (path.type === 'lasso' || path.type === 'polygon') {
            if (path.points.length >= 3) {
                ctx.beginPath()
                ctx.moveTo(path.points[0].x, path.points[0].y)
                for (let i = 1; i < path.points.length; i++) {
                    ctx.lineTo(path.points[i].x, path.points[i].y)
                }
                ctx.closePath()
                ctx.fill()
            }
        }

        return ctx.getImageData(0, 0, width, height)
    }

    /**
     * Combine two masks with given operation
     * @param {ImageData} maskA
     * @param {ImageData} maskB
     * @param {'add' | 'subtract'} operation
     * @returns {ImageData}
     * @private
     */
    _combineMasks(maskA, maskB, operation) {
        const width = maskA.width
        const height = maskA.height
        const result = new Uint8ClampedArray(maskA.data.length)

        for (let i = 0; i < maskA.data.length; i += 4) {
            const a = maskA.data[i + 3] > 127
            const b = maskB.data[i + 3] > 127

            let selected
            if (operation === 'add') {
                selected = a || b
            } else {
                selected = a && !b
            }

            const val = selected ? 255 : 0
            result[i] = val
            result[i + 1] = val
            result[i + 2] = val
            result[i + 3] = val
        }

        return new ImageData(result, width, height)
    }

    /**
     * Apply new selection with current mode
     * @param {SelectionPath} newSelection
     * @private
     */
    _applySelectionWithMode(newSelection) {
        if (this._selectionMode === 'replace' || !this._previousSelection) {
            this._selectionPath = newSelection
            return
        }

        this._selectionPath = this._previousSelection
        const oldMask = this.rasterizeSelection()
        this._selectionPath = newSelection
        const newMask = this.rasterizeSelection()

        if (!oldMask || !newMask) {
            this._selectionPath = newSelection
            return
        }

        const combined = this._combineMasks(oldMask, newMask, this._selectionMode)

        let hasSelection = false
        for (let i = 3; i < combined.data.length; i += 4) {
            if (combined.data[i] > 127) {
                hasSelection = true
                break
            }
        }

        if (hasSelection) {
            this._selectionPath = {
                type: 'mask',
                data: combined
            }
        } else {
            this._selectionPath = null
        }
    }

    /**
     * Get selection mode from modifier keys
     * @param {MouseEvent|KeyboardEvent} e
     * @returns {SelectionMode}
     * @private
     */
    _getModeFromEvent(e) {
        if (e.shiftKey) return 'add'
        if (e.altKey) return 'subtract'
        return 'replace'
    }

    /**
     * Handle mouse down
     * @param {MouseEvent} e
     * @private
     */
    _handleMouseDown(e) {
        if (!this._enabled) return

        if (this._currentTool === 'polygon') {
            const coords = this._getCanvasCoords(e)
            this._selectionMode = this._getModeFromEvent(e)
            this._previousSelection = this._selectionPath
            this._handlePolygonClick(coords, e)
            return
        }

        if (this._currentTool === 'wand') {
            const coords = this._getCanvasCoords(e)
            this._selectionMode = this._getModeFromEvent(e)
            this._previousSelection = this._selectionPath

            if (this._selectionMode === 'replace' && this._selectionPath) {
                this.clearSelection()
            }

            this._handleWandClick(coords)
            return
        }

        const coords = this._getCanvasCoords(e)
        this._selectionMode = this._getModeFromEvent(e)
        this._previousSelection = this._selectionPath

        // Capture _previousSelection first, then only discard the prior selection
        // up front in replace mode — add/subtract must keep it so mouseup can
        // combine (matches the wand branch).
        if (this._selectionMode === 'replace' && this._selectionPath &&
            !this._isPointInSelection(coords.x, coords.y)) {
            this.clearSelection()
        }

        this._isDrawing = true
        this._drawStart = coords
        this._selectionPath = null
        this._stopAnimation()
        this._clearOverlay() // drop any stale marching-ants frame from the prior selection
        this._lassoPoints = []
        if (this._currentTool === 'lasso') {
            this._lassoPoints.push(coords)
        }
    }

    /**
     * Handle mouse move
     * @param {MouseEvent} e
     * @private
     */
    _handleMouseMove(e) {
        if (!this._enabled) return

        if (this._currentTool === 'polygon' && this._isPolygonDrawing) {
            const coords = this._getCanvasCoords(e)
            this._updatePolygonPreview(coords)
            return
        }

        if (!this._isDrawing || !this._drawStart) return

        const coords = this._getCanvasCoords(e)
        const constrain = e.shiftKey

        if (this._currentTool === 'lasso') {
            this._lassoPoints.push(coords)
            this._selectionPath = {
                type: 'lasso',
                points: [...this._lassoPoints]
            }
            this._drawPreview()
            return
        }

        this._updateSelectionPath(this._drawStart, coords, constrain)
        this._drawPreview()
    }

    /**
     * Handle mouse up
     * @param {MouseEvent} e
     * @private
     */
    _handleMouseUp(e) {
        if (!this._enabled) return
        if (!this._isDrawing) return

        this._isDrawing = false

        if (this._selectionPath) {
            const path = this._selectionPath
            let hasSize = true
            if (path.type === 'rect') {
                hasSize = path.width > 2 && path.height > 2
            } else if (path.type === 'oval') {
                hasSize = path.rx > 1 && path.ry > 1
            } else if (path.type === 'lasso' || path.type === 'polygon') {
                hasSize = path.points.length >= 3
            }

            if (hasSize) {
                if (this._selectionMode !== 'replace' && this._previousSelection) {
                    this._applySelectionWithMode(this._selectionPath)
                }
                this._startAnimation()
                this.onSelectionChange?.()
            } else {
                this.clearSelection()
            }
        }

        this._drawStart = null
    }

    /**
     * Update selection path based on drag
     * @param {{x: number, y: number}} start
     * @param {{x: number, y: number}} end
     * @param {boolean} constrain - Constrain to square/circle
     * @private
     */
    _updateSelectionPath(start, end, constrain) {
        let width = end.x - start.x
        let height = end.y - start.y

        if (constrain) {
            const size = Math.max(Math.abs(width), Math.abs(height))
            width = Math.sign(width) * size || size
            height = Math.sign(height) * size || size
        }

        const x = width < 0 ? start.x + width : start.x
        const y = height < 0 ? start.y + height : start.y
        const w = Math.abs(width)
        const h = Math.abs(height)

        if (this._currentTool === 'rectangle') {
            this._selectionPath = { type: 'rect', x, y, width: w, height: h }
        } else {
            this._selectionPath = {
                type: 'oval',
                cx: x + w / 2,
                cy: y + h / 2,
                rx: w / 2,
                ry: h / 2
            }
        }
    }

    /**
     * Get canvas coordinates from mouse event
     * @param {MouseEvent} e
     * @returns {{x: number, y: number}}
     * @private
     */
    _getCanvasCoords(e) {
        const rect = this._overlay.getBoundingClientRect()
        const scaleX = this._overlay.width / rect.width
        const scaleY = this._overlay.height / rect.height
        return {
            x: (e.clientX - rect.left) * scaleX,
            y: (e.clientY - rect.top) * scaleY
        }
    }

    /**
     * Check if a point is inside the current selection
     * @param {number} x
     * @param {number} y
     * @returns {boolean}
     * @private
     */
    _isPointInSelection(x, y) {
        if (!this._selectionPath) return false

        const path = this._selectionPath
        if (path.type === 'rect') {
            return x >= path.x && x <= path.x + path.width &&
                   y >= path.y && y <= path.y + path.height
        } else if (path.type === 'oval') {
            // Ellipse equation: ((x-cx)/rx)^2 + ((y-cy)/ry)^2 <= 1
            const dx = (x - path.cx) / path.rx
            const dy = (y - path.cy) / path.ry
            return dx * dx + dy * dy <= 1
        } else if (path.type === 'lasso' || path.type === 'polygon') {
            // Use canvas isPointInPath
            if (!this._ctx || path.points.length < 3) return false
            this._ctx.beginPath()
            this._ctx.moveTo(path.points[0].x, path.points[0].y)
            for (let i = 1; i < path.points.length; i++) {
                this._ctx.lineTo(path.points[i].x, path.points[i].y)
            }
            this._ctx.closePath()
            return this._ctx.isPointInPath(x, y)
        } else if (path.type === 'wand' || path.type === 'mask') {
            const mask = path.type === 'wand' ? path.mask : path.data
            const px = Math.round(x)
            const py = Math.round(y)
            if (px < 0 || px >= mask.width || py < 0 || py >= mask.height) return false
            const idx = (py * mask.width + px) * 4 + 3
            return mask.data[idx] > 127
        }
        return false
    }

    /**
     * Handle polygon tool click
     * @param {{x: number, y: number}} coords
     * @param {MouseEvent} e
     * @private
     */
    _handlePolygonClick(coords, e) {
        const CLOSE_THRESHOLD = 10

        if (this._polygonPoints.length >= 3) {
            const start = this._polygonPoints[0]
            const dist = Math.hypot(coords.x - start.x, coords.y - start.y)
            if (dist < CLOSE_THRESHOLD) {
                this._finishPolygon()
                return
            }
        }

        this._polygonPoints.push(coords)
        this._isPolygonDrawing = true
        this._updatePolygonPreview(coords)
    }

    /**
     * Finish polygon selection
     * @private
     */
    _finishPolygon() {
        if (this._polygonPoints.length >= 3) {
            const newSelection = {
                type: 'polygon',
                points: [...this._polygonPoints]
            }
            this._applySelectionWithMode(newSelection)
            this._startAnimation()
            this.onSelectionChange?.()
        }
        this._polygonPoints = []
        this._isPolygonDrawing = false
    }

    /**
     * Update polygon preview with cursor position
     * @param {{x: number, y: number}} cursor
     * @private
     */
    _updatePolygonPreview(cursor) {
        this._clearOverlay()
        if (!this._ctx || this._polygonPoints.length === 0) return

        const ctx = this._ctx
        const pts = this._polygonPoints

        const tracePolygonPath = () => {
            ctx.beginPath()
            ctx.moveTo(pts[0].x, pts[0].y)
            for (let i = 1; i < pts.length; i++) {
                ctx.lineTo(pts[i].x, pts[i].y)
            }
            ctx.lineTo(cursor.x, cursor.y)
            ctx.stroke()
        }

        ctx.setLineDash([5, 5])
        ctx.lineWidth = 1

        ctx.strokeStyle = '#000'
        tracePolygonPath()

        ctx.strokeStyle = '#fff'
        ctx.lineDashOffset = 5
        tracePolygonPath()
        ctx.lineDashOffset = 0

        ctx.fillStyle = '#fff'
        ctx.strokeStyle = '#000'
        ctx.setLineDash([])
        for (const pt of pts) {
            ctx.beginPath()
            ctx.arc(pt.x, pt.y, 4, 0, Math.PI * 2)
            ctx.fill()
            ctx.stroke()
        }
    }

    /**
     * Handle double click (finish polygon)
     * @param {MouseEvent} e
     * @private
     */
    _handleDoubleClick(e) {
        if (this._currentTool === 'polygon' && this._isPolygonDrawing) {
            this._finishPolygon()
        }
    }

    /**
     * Handle keydown (escape cancels polygon)
     * @param {KeyboardEvent} e
     * @private
     */
    _handleKeyDown(e) {
        if (e.key === 'Escape' && this._isPolygonDrawing) {
            this._polygonPoints = []
            this._isPolygonDrawing = false
            this._clearOverlay()
        }
    }

    /**
     * Handle magic wand click
     * @param {{x: number, y: number}} coords
     * @private
     */
    _handleWandClick(coords) {
        if (!this._sourceCanvas) {
            console.warn('[SelectionManager] No source canvas for magic wand')
            return
        }

        const x = Math.round(coords.x)
        const y = Math.round(coords.y)

        // Use temp 2D canvas since source may be WebGL
        const tempCanvas = document.createElement('canvas')
        tempCanvas.width = this._sourceCanvas.width
        tempCanvas.height = this._sourceCanvas.height
        const tempCtx = tempCanvas.getContext('2d')
        tempCtx.drawImage(this._sourceCanvas, 0, 0)
        const imageData = tempCtx.getImageData(0, 0, tempCanvas.width, tempCanvas.height)

        const mask = floodFill(imageData, x, y, this._wandTolerance)

        const newSelection = {
            type: 'wand',
            mask
        }
        this._applySelectionWithMode(newSelection)
        this._startAnimation()
        this.onSelectionChange?.()
    }

    /**
     * Clear the overlay canvas
     * @private
     */
    _clearOverlay() {
        if (!this._ctx || !this._overlay) return
        this._ctx.clearRect(0, 0, this._overlay.width, this._overlay.height)
    }

    /**
     * Draw preview while dragging (dashed line, not animated)
     * @private
     */
    _drawPreview() {
        this._clearOverlay()
        if (!this._selectionPath || !this._ctx) return

        this._ctx.setLineDash([5, 5])
        this._ctx.strokeStyle = '#000'
        this._ctx.lineWidth = 1

        this._strokePath()

        this._ctx.strokeStyle = '#fff'
        this._ctx.lineDashOffset = 5
        this._strokePath()

        this._ctx.lineDashOffset = 0
    }

    /**
     * Stroke the current selection path
     * @private
     */
    _strokePath() {
        if (!this._selectionPath || !this._ctx) return

        // Reuse the cached geometry unless the selection itself changed. The
        // marching-ants loop calls this twice per frame with only lineDashOffset
        // differing; without the cache, wand/mask paths would re-run their
        // O(width*height) boundary scan on every stroke.
        if (this._cachedStrokePathSource !== this._selectionPath) {
            this._cachedStrokePath = this._buildStrokePath(this._selectionPath)
            this._cachedStrokePathSource = this._selectionPath
        }

        if (this._cachedStrokePath) {
            this._ctx.stroke(this._cachedStrokePath)
        }
    }

    /**
     * Build a Path2D outlining the given selection path. For wand/mask paths
     * this traces the mask boundary (an O(width*height) scan), so callers cache
     * the result rather than rebuilding it per animation frame.
     * @param {object} path - Selection path
     * @returns {Path2D}
     * @private
     */
    _buildStrokePath(path) {
        const p = new Path2D()

        if (path.type === 'rect') {
            p.rect(path.x, path.y, path.width, path.height)
        } else if (path.type === 'oval') {
            p.ellipse(path.cx, path.cy, path.rx, path.ry, 0, 0, Math.PI * 2)
        } else if (path.type === 'lasso' || path.type === 'polygon') {
            if (path.points.length > 0) {
                p.moveTo(path.points[0].x, path.points[0].y)
                for (let i = 1; i < path.points.length; i++) {
                    p.lineTo(path.points[i].x, path.points[i].y)
                }
                p.closePath()
            }
        } else if (path.type === 'wand' || path.type === 'mask') {
            const mask = path.type === 'wand' ? path.mask : path.data
            const { width, height, data } = mask

            const isSelected = (x, y) => {
                if (x < 0 || x >= width || y < 0 || y >= height) return false
                return data[(y * width + x) * 4 + 3] > 127
            }

            // Horizontal edge segments
            for (let y = 0; y <= height; y++) {
                let inEdge = false
                let startX = 0
                for (let x = 0; x < width; x++) {
                    const above = isSelected(x, y - 1)
                    const below = isSelected(x, y)
                    const isEdgeHere = above !== below

                    if (isEdgeHere && !inEdge) {
                        startX = x
                        inEdge = true
                    } else if (!isEdgeHere && inEdge) {
                        p.moveTo(startX, y)
                        p.lineTo(x, y)
                        inEdge = false
                    }
                }
                if (inEdge) {
                    p.moveTo(startX, y)
                    p.lineTo(width, y)
                }
            }

            // Vertical edge segments
            for (let x = 0; x <= width; x++) {
                let inEdge = false
                let startY = 0
                for (let y = 0; y < height; y++) {
                    const left = isSelected(x - 1, y)
                    const right = isSelected(x, y)
                    const isEdgeHere = left !== right

                    if (isEdgeHere && !inEdge) {
                        startY = y
                        inEdge = true
                    } else if (!isEdgeHere && inEdge) {
                        p.moveTo(x, startY)
                        p.lineTo(x, y)
                        inEdge = false
                    }
                }
                if (inEdge) {
                    p.moveTo(x, startY)
                    p.lineTo(x, height)
                }
            }
        }

        return p
    }

    /**
     * Start marching ants animation
     * @private
     */
    _startAnimation() {
        if (!this._selectionPath) {
            // Nothing to animate (e.g. a subtract emptied the selection) — make
            // sure any prior loop is stopped and the overlay cleared, rather
            // than spinning a permanent no-op rAF.
            this._stopAnimation()
            this._clearOverlay()
            return
        }
        if (this._animationId) return

        const animate = () => {
            this._dashOffset = (this._dashOffset + 0.5) % 10
            this._drawMarchingAnts()
            this._animationId = requestAnimationFrame(animate)
        }

        this._animationId = requestAnimationFrame(animate)
    }

    /**
     * Stop marching ants animation
     * @private
     */
    _stopAnimation() {
        if (this._animationId) {
            cancelAnimationFrame(this._animationId)
            this._animationId = null
        }
    }

    /**
     * Draw marching ants (animated selection border)
     * @private
     */
    _drawMarchingAnts() {
        if (!this._selectionPath) return

        this._clearOverlay()
        if (!this._ctx) return

        this._ctx.setLineDash([5, 5])
        this._ctx.lineWidth = 1

        this._ctx.strokeStyle = '#000'
        this._ctx.lineDashOffset = this._dashOffset
        this._strokePath()

        this._ctx.strokeStyle = '#fff'
        this._ctx.lineDashOffset = this._dashOffset + 5
        this._strokePath()
    }

    /**
     * Resize overlay to match main canvas
     * @param {number} width
     * @param {number} height
     */
    resize(width, height) {
        if (!this._overlay) return
        this._overlay.width = width
        this._overlay.height = height

        if (this._selectionPath) {
            this._drawMarchingAnts()
        }
    }

    /**
     * Destroy the selection manager
     */
    destroy() {
        this._stopAnimation()
        this._clearOverlay()
    }
}

export { SelectionManager }
