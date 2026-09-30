# Marquee Selection V2 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add lasso, polygon, and magic wand selection tools with add/subtract modifiers.

**Architecture:** Extend SelectionManager with new tool types and selection modes. Rasterize selections to ImageData masks for boolean operations. New flood-fill module for magic wand.

**Tech Stack:** Canvas 2D API, ImageData for pixel manipulation, queue-based flood fill algorithm.

---

### Task 1: Add Selection Mode Support

**Files:**
- Modify: `public/js/selection/selection-manager.js`

**Step 1: Add selection mode enum and state**

Add after line 28 (after OvalSelection typedef):

```javascript
/**
 * @typedef {'replace' | 'add' | 'subtract'} SelectionMode
 */
```

Add to constructor after `_copyOrigin`:

```javascript
/** @type {SelectionMode} */
this._selectionMode = 'replace'
```

**Step 2: Add method to detect mode from event**

Add method:

```javascript
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
```

**Step 3: Update _handleMouseDown to capture mode**

In `_handleMouseDown`, after `const coords = this._getCanvasCoords(e)` add:

```javascript
this._selectionMode = this._getModeFromEvent(e)
```

**Step 4: Commit**

```bash
git add public/js/selection/selection-manager.js
git commit -m "feat: add selection mode support (add/subtract)"
```

---

### Task 2: Add Lasso Tool Type

**Files:**
- Modify: `public/js/selection/selection-manager.js`

**Step 1: Add LassoSelection typedef**

Add after OvalSelection typedef:

```javascript
/**
 * @typedef {Object} LassoSelection
 * @property {'lasso'} type
 * @property {Array<{x: number, y: number}>} points
 */
```

Update SelectionPath typedef:

```javascript
/**
 * @typedef {RectSelection | OvalSelection | LassoSelection | null} SelectionPath
 */
```

**Step 2: Update SelectionTool typedef**

Change to:

```javascript
/**
 * @typedef {'rectangle' | 'oval' | 'lasso' | 'polygon' | 'wand'} SelectionTool
 */
```

**Step 3: Add points array to constructor**

Add after `_copyOrigin`:

```javascript
/** @type {Array<{x: number, y: number}>} */
this._lassoPoints = []
```

**Step 4: Add lasso handling in _handleMouseDown**

After the existing drawing setup, add:

```javascript
// Reset lasso points
this._lassoPoints = []
if (this._currentTool === 'lasso') {
    this._lassoPoints.push(coords)
}
```

**Step 5: Add lasso handling in _handleMouseMove**

Add before the existing `_updateSelectionPath` call:

```javascript
if (this._currentTool === 'lasso' && this._isDrawing) {
    this._lassoPoints.push(coords)
    this._selectionPath = {
        type: 'lasso',
        points: [...this._lassoPoints]
    }
    this._drawPreview()
    return
}
```

**Step 6: Commit**

```bash
git add public/js/selection/selection-manager.js
git commit -m "feat: add lasso selection tool type"
```

---

### Task 3: Render Lasso Selection

**Files:**
- Modify: `public/js/selection/selection-manager.js`

**Step 1: Update _strokePath for lasso**

Replace the `_strokePath` method:

```javascript
/**
 * Stroke the current selection path
 * @private
 */
_strokePath() {
    if (!this._selectionPath || !this._ctx) return

    const path = this._selectionPath
    this._ctx.beginPath()

    if (path.type === 'rect') {
        this._ctx.rect(path.x, path.y, path.width, path.height)
    } else if (path.type === 'oval') {
        this._ctx.ellipse(path.cx, path.cy, path.rx, path.ry, 0, 0, Math.PI * 2)
    } else if (path.type === 'lasso' || path.type === 'polygon') {
        if (path.points.length > 0) {
            this._ctx.moveTo(path.points[0].x, path.points[0].y)
            for (let i = 1; i < path.points.length; i++) {
                this._ctx.lineTo(path.points[i].x, path.points[i].y)
            }
            this._ctx.closePath()
        }
    }

    this._ctx.stroke()
}
```

**Step 2: Update _isPointInSelection for lasso**

Add case in `_isPointInSelection`:

```javascript
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
}
```

**Step 3: Commit**

```bash
git add public/js/selection/selection-manager.js
git commit -m "feat: render lasso selection with marching ants"
```

---

### Task 4: Add Polygon Tool Type

**Files:**
- Modify: `public/js/selection/selection-manager.js`

**Step 1: Add PolygonSelection typedef**

Add after LassoSelection typedef:

```javascript
/**
 * @typedef {Object} PolygonSelection
 * @property {'polygon'} type
 * @property {Array<{x: number, y: number}>} points
 */
```

Update SelectionPath typedef:

```javascript
/**
 * @typedef {RectSelection | OvalSelection | LassoSelection | PolygonSelection | null} SelectionPath
 */
```

**Step 2: Add polygon state to constructor**

Add after `_lassoPoints`:

```javascript
/** @type {Array<{x: number, y: number}>} */
this._polygonPoints = []

/** @type {boolean} */
this._isPolygonDrawing = false
```

**Step 3: Add polygon click handler**

Add new method:

```javascript
/**
 * Handle polygon tool click
 * @param {{x: number, y: number}} coords
 * @param {MouseEvent} e
 * @private
 */
_handlePolygonClick(coords, e) {
    const CLOSE_THRESHOLD = 10

    // Check if clicking near start point to close
    if (this._polygonPoints.length >= 3) {
        const start = this._polygonPoints[0]
        const dist = Math.hypot(coords.x - start.x, coords.y - start.y)
        if (dist < CLOSE_THRESHOLD) {
            this._finishPolygon()
            return
        }
    }

    // Add point
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
        this._selectionPath = {
            type: 'polygon',
            points: [...this._polygonPoints]
        }
        this._startAnimation()
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

    this._ctx.setLineDash([5, 5])
    this._ctx.strokeStyle = '#000'
    this._ctx.lineWidth = 1

    // Draw placed points
    this._ctx.beginPath()
    this._ctx.moveTo(this._polygonPoints[0].x, this._polygonPoints[0].y)
    for (let i = 1; i < this._polygonPoints.length; i++) {
        this._ctx.lineTo(this._polygonPoints[i].x, this._polygonPoints[i].y)
    }
    // Line to cursor
    this._ctx.lineTo(cursor.x, cursor.y)
    this._ctx.stroke()

    // White offset stroke
    this._ctx.strokeStyle = '#fff'
    this._ctx.lineDashOffset = 5
    this._ctx.beginPath()
    this._ctx.moveTo(this._polygonPoints[0].x, this._polygonPoints[0].y)
    for (let i = 1; i < this._polygonPoints.length; i++) {
        this._ctx.lineTo(this._polygonPoints[i].x, this._polygonPoints[i].y)
    }
    this._ctx.lineTo(cursor.x, cursor.y)
    this._ctx.stroke()
    this._ctx.lineDashOffset = 0

    // Draw vertex dots
    this._ctx.fillStyle = '#fff'
    this._ctx.strokeStyle = '#000'
    this._ctx.setLineDash([])
    for (const pt of this._polygonPoints) {
        this._ctx.beginPath()
        this._ctx.arc(pt.x, pt.y, 4, 0, Math.PI * 2)
        this._ctx.fill()
        this._ctx.stroke()
    }
}
```

**Step 4: Update _handleMouseDown for polygon**

At the start of `_handleMouseDown`, add:

```javascript
if (this._currentTool === 'polygon') {
    const coords = this._getCanvasCoords(e)
    this._selectionMode = this._getModeFromEvent(e)
    this._handlePolygonClick(coords, e)
    return
}
```

**Step 5: Update _handleMouseMove for polygon**

At the start of `_handleMouseMove`, add:

```javascript
if (this._currentTool === 'polygon' && this._isPolygonDrawing) {
    const coords = this._getCanvasCoords(e)
    this._updatePolygonPreview(coords)
    return
}
```

**Step 6: Add double-click and escape handlers**

Add to `_setupEventListeners`:

```javascript
this._overlay.addEventListener('dblclick', (e) => this._handleDoubleClick(e))
document.addEventListener('keydown', (e) => this._handleKeyDown(e))
```

Add methods:

```javascript
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
```

**Step 7: Commit**

```bash
git add public/js/selection/selection-manager.js
git commit -m "feat: add polygon selection tool"
```

---

### Task 5: Create Flood Fill Module

**Files:**
- Create: `public/js/selection/flood-fill.js`

**Step 1: Create flood fill module**

```javascript
/**
 * Flood Fill Algorithm
 * Queue-based flood fill for magic wand selection
 *
 * @module selection/flood-fill
 */

/**
 * Perform flood fill from a starting point
 * @param {ImageData} imageData - Source image data
 * @param {number} startX - Starting X coordinate
 * @param {number} startY - Starting Y coordinate
 * @param {number} tolerance - Color tolerance (0-255)
 * @returns {ImageData} - Mask where 255 = selected, 0 = not selected
 */
function floodFill(imageData, startX, startY, tolerance) {
    const { width, height, data } = imageData
    const mask = new Uint8ClampedArray(width * height)

    // Get target color at start point
    const startIdx = (startY * width + startX) * 4
    const targetR = data[startIdx]
    const targetG = data[startIdx + 1]
    const targetB = data[startIdx + 2]
    const targetA = data[startIdx + 3]

    // Tolerance threshold (sum of 4 channels)
    const threshold = tolerance * 4

    /**
     * Check if pixel matches target color within tolerance
     * @param {number} idx - Pixel index in data array
     * @returns {boolean}
     */
    function matches(idx) {
        const diff = Math.abs(data[idx] - targetR) +
                     Math.abs(data[idx + 1] - targetG) +
                     Math.abs(data[idx + 2] - targetB) +
                     Math.abs(data[idx + 3] - targetA)
        return diff <= threshold
    }

    // Queue-based flood fill
    const queue = [[startX, startY]]
    const visited = new Set()
    visited.add(startY * width + startX)

    while (queue.length > 0) {
        const [x, y] = queue.shift()
        const pixelIdx = y * width + x
        const dataIdx = pixelIdx * 4

        if (!matches(dataIdx)) continue

        // Mark as selected
        mask[pixelIdx] = 255

        // Check 4-connected neighbors
        const neighbors = [
            [x - 1, y],
            [x + 1, y],
            [x, y - 1],
            [x, y + 1]
        ]

        for (const [nx, ny] of neighbors) {
            if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue
            const nIdx = ny * width + nx
            if (visited.has(nIdx)) continue
            visited.add(nIdx)
            queue.push([nx, ny])
        }
    }

    // Convert to ImageData format (RGBA)
    const maskData = new Uint8ClampedArray(width * height * 4)
    for (let i = 0; i < mask.length; i++) {
        const idx = i * 4
        maskData[idx] = mask[i]     // R
        maskData[idx + 1] = mask[i] // G
        maskData[idx + 2] = mask[i] // B
        maskData[idx + 3] = mask[i] // A (255 = selected)
    }

    return new ImageData(maskData, width, height)
}

export { floodFill }
```

**Step 2: Commit**

```bash
git add public/js/selection/flood-fill.js
git commit -m "feat: add flood fill module for magic wand"
```

---

### Task 6: Add Magic Wand Tool

**Files:**
- Modify: `public/js/selection/selection-manager.js`

**Step 1: Add WandSelection and MaskSelection typedefs**

Add after PolygonSelection:

```javascript
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
```

Update SelectionPath:

```javascript
/**
 * @typedef {RectSelection | OvalSelection | LassoSelection | PolygonSelection | WandSelection | MaskSelection | null} SelectionPath
 */
```

**Step 2: Add import for flood fill**

At top of file:

```javascript
import { floodFill } from './flood-fill.js'
```

**Step 3: Add tolerance and source canvas to constructor**

Add after `_isPolygonDrawing`:

```javascript
/** @type {number} */
this._wandTolerance = 32

/** @type {HTMLCanvasElement | null} */
this._sourceCanvas = null
```

**Step 4: Add tolerance getter/setter and source canvas setter**

```javascript
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
```

**Step 5: Add magic wand handler**

```javascript
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

    // Get image data from source canvas
    const ctx = this._sourceCanvas.getContext('2d')
    const imageData = ctx.getImageData(0, 0, this._sourceCanvas.width, this._sourceCanvas.height)

    // Perform flood fill
    const mask = floodFill(imageData, x, y, this._wandTolerance)

    this._selectionPath = {
        type: 'wand',
        mask
    }

    this._startAnimation()
}
```

**Step 6: Update _handleMouseDown for wand**

Add at start of `_handleMouseDown`:

```javascript
if (this._currentTool === 'wand') {
    const coords = this._getCanvasCoords(e)
    this._selectionMode = this._getModeFromEvent(e)

    // Clear existing if replace mode
    if (this._selectionMode === 'replace' && this._selectionPath) {
        this.clearSelection()
    }

    this._handleWandClick(coords)
    return
}
```

**Step 7: Commit**

```bash
git add public/js/selection/selection-manager.js
git commit -m "feat: add magic wand selection tool"
```

---

### Task 7: Render Mask Selections

**Files:**
- Modify: `public/js/selection/selection-manager.js`

**Step 1: Add mask edge rendering method**

```javascript
/**
 * Draw marching ants for mask selection (edge detection)
 * @private
 */
_drawMaskAnts() {
    this._clearOverlay()
    const path = this._selectionPath
    if (!path || (path.type !== 'wand' && path.type !== 'mask')) return
    if (!this._ctx) return

    const mask = path.type === 'wand' ? path.mask : path.data
    const { width, height, data } = mask

    this._ctx.setLineDash([5, 5])
    this._ctx.lineWidth = 1

    // Find edges and draw
    const edges = []
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const idx = (y * width + x) * 4
            const selected = data[idx + 3] > 127

            if (!selected) continue

            // Check if this is an edge pixel
            const isEdge =
                x === 0 || x === width - 1 || y === 0 || y === height - 1 ||
                data[((y - 1) * width + x) * 4 + 3] <= 127 ||
                data[((y + 1) * width + x) * 4 + 3] <= 127 ||
                data[(y * width + x - 1) * 4 + 3] <= 127 ||
                data[(y * width + x + 1) * 4 + 3] <= 127

            if (isEdge) {
                edges.push({ x, y })
            }
        }
    }

    // Draw edge pixels as small rectangles
    this._ctx.strokeStyle = '#000'
    this._ctx.lineDashOffset = this._dashOffset
    for (const { x, y } of edges) {
        this._ctx.strokeRect(x, y, 1, 1)
    }

    this._ctx.strokeStyle = '#fff'
    this._ctx.lineDashOffset = this._dashOffset + 5
    for (const { x, y } of edges) {
        this._ctx.strokeRect(x, y, 1, 1)
    }
}
```

**Step 2: Update _drawMarchingAnts to handle masks**

Replace the `_drawMarchingAnts` method:

```javascript
/**
 * Draw marching ants (animated selection border)
 * @private
 */
_drawMarchingAnts() {
    if (!this._selectionPath) return

    if (this._selectionPath.type === 'wand' || this._selectionPath.type === 'mask') {
        this._drawMaskAnts()
    } else {
        this._clearOverlay()
        if (!this._ctx) return

        this._ctx.setLineDash([5, 5])
        this._ctx.lineWidth = 1

        // Black stroke
        this._ctx.strokeStyle = '#000'
        this._ctx.lineDashOffset = this._dashOffset
        this._strokePath()

        // White stroke offset
        this._ctx.strokeStyle = '#fff'
        this._ctx.lineDashOffset = this._dashOffset + 5
        this._strokePath()
    }
}
```

**Step 3: Update _isPointInSelection for masks**

Add case:

```javascript
} else if (path.type === 'wand' || path.type === 'mask') {
    const mask = path.type === 'wand' ? path.mask : path.data
    const px = Math.round(x)
    const py = Math.round(y)
    if (px < 0 || px >= mask.width || py < 0 || py >= mask.height) return false
    const idx = (py * mask.width + px) * 4 + 3
    return mask.data[idx] > 127
}
```

**Step 4: Commit**

```bash
git add public/js/selection/selection-manager.js
git commit -m "feat: render mask selections with marching ants"
```

---

### Task 8: Add Selection Combining (Add/Subtract)

**Files:**
- Modify: `public/js/selection/selection-manager.js`

**Step 1: Add rasterize method**

```javascript
/**
 * Rasterize current selection to mask
 * @returns {ImageData | null}
 * @private
 */
_rasterizeSelection() {
    if (!this._selectionPath || !this._overlay) return null

    const { width, height } = this._overlay
    const path = this._selectionPath

    // Already a mask
    if (path.type === 'wand') return path.mask
    if (path.type === 'mask') return path.data

    // Rasterize vector path
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
```

**Step 2: Add combine method**

```javascript
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
```

**Step 3: Add method to apply new selection with mode**

```javascript
/**
 * Apply new selection with current mode
 * @param {SelectionPath} newSelection
 * @private
 */
_applySelectionWithMode(newSelection) {
    if (this._selectionMode === 'replace' || !this._selectionPath) {
        this._selectionPath = newSelection
        return
    }

    // Need to combine - rasterize both
    const oldMask = this._rasterizeSelection()
    const tempPath = this._selectionPath
    this._selectionPath = newSelection
    const newMask = this._rasterizeSelection()
    this._selectionPath = tempPath

    if (!oldMask || !newMask) {
        this._selectionPath = newSelection
        return
    }

    const combined = this._combineMasks(oldMask, newMask, this._selectionMode)

    // Check if anything is selected
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
```

**Step 4: Update tool handlers to use _applySelectionWithMode**

Update `_handleMouseUp` - replace the selection finalization:

```javascript
if (this._selectionPath) {
    const path = this._selectionPath
    const hasSize = path.type === 'rect'
        ? (path.width > 2 && path.height > 2)
        : path.type === 'oval'
            ? (path.rx > 1 && path.ry > 1)
            : path.type === 'lasso' || path.type === 'polygon'
                ? path.points.length >= 3
                : true

    if (hasSize) {
        if (this._selectionMode !== 'replace') {
            // Store current path temporarily
            const newPath = this._selectionPath
            this._selectionPath = this._previousSelection
            this._applySelectionWithMode(newPath)
        }
        this._startAnimation()
    } else {
        this.clearSelection()
    }
}
```

Add `_previousSelection` tracking in `_handleMouseDown`:

```javascript
// Store previous selection for combining
this._previousSelection = this._selectionPath
```

And add to constructor:

```javascript
/** @type {SelectionPath} */
this._previousSelection = null
```

**Step 5: Update polygon and wand handlers similarly**

In `_finishPolygon`, replace setting `_selectionPath`:

```javascript
_finishPolygon() {
    if (this._polygonPoints.length >= 3) {
        const newSelection = {
            type: 'polygon',
            points: [...this._polygonPoints]
        }
        this._applySelectionWithMode(newSelection)
        this._startAnimation()
    }
    this._polygonPoints = []
    this._isPolygonDrawing = false
}
```

In `_handleWandClick`, replace setting `_selectionPath`:

```javascript
const newSelection = {
    type: 'wand',
    mask
}
this._applySelectionWithMode(newSelection)
```

**Step 6: Commit**

```bash
git add public/js/selection/selection-manager.js
git commit -m "feat: add selection combining (add/subtract modes)"
```

---

### Task 9: Update Clipboard Operations

**Files:**
- Modify: `public/js/selection/clipboard-ops.js`

**Step 1: Add polygon mask function**

Add after `applyOvalMask`:

```javascript
/**
 * Apply polygon mask to canvas context
 * @param {CanvasRenderingContext2D} ctx
 * @param {Array<{x: number, y: number}>} points
 * @param {{x: number, y: number, width: number, height: number}} bounds
 */
function applyPolygonMask(ctx, points, bounds) {
    if (points.length < 3) return

    ctx.globalCompositeOperation = 'destination-in'
    ctx.beginPath()
    ctx.moveTo(points[0].x - bounds.x, points[0].y - bounds.y)
    for (let i = 1; i < points.length; i++) {
        ctx.lineTo(points[i].x - bounds.x, points[i].y - bounds.y)
    }
    ctx.closePath()
    ctx.fill()
    ctx.globalCompositeOperation = 'source-over'
}
```

**Step 2: Add image mask function**

```javascript
/**
 * Apply image mask to canvas context
 * @param {CanvasRenderingContext2D} ctx
 * @param {ImageData} mask
 * @param {{x: number, y: number, width: number, height: number}} bounds
 */
function applyImageMask(ctx, mask, bounds) {
    // Get current image data
    const imageData = ctx.getImageData(0, 0, bounds.width, bounds.height)

    // Apply mask alpha
    for (let y = 0; y < bounds.height; y++) {
        for (let x = 0; x < bounds.width; x++) {
            const srcX = bounds.x + x
            const srcY = bounds.y + y

            if (srcX < 0 || srcX >= mask.width || srcY < 0 || srcY >= mask.height) {
                // Outside mask bounds - clear pixel
                const idx = (y * bounds.width + x) * 4
                imageData.data[idx + 3] = 0
            } else {
                const maskIdx = (srcY * mask.width + srcX) * 4 + 3
                const maskAlpha = mask.data[maskIdx]

                if (maskAlpha <= 127) {
                    // Not selected - clear pixel
                    const idx = (y * bounds.width + x) * 4
                    imageData.data[idx + 3] = 0
                }
            }
        }
    }

    ctx.putImageData(imageData, 0, 0)
}
```

**Step 3: Update getSelectionBounds for new types**

Replace `getSelectionBounds`:

```javascript
/**
 * Get bounding box of selection
 * @param {object} selectionPath
 * @returns {{x: number, y: number, width: number, height: number}}
 */
function getSelectionBounds(selectionPath) {
    if (selectionPath.type === 'rect') {
        return {
            x: Math.round(selectionPath.x),
            y: Math.round(selectionPath.y),
            width: Math.round(selectionPath.width),
            height: Math.round(selectionPath.height)
        }
    } else if (selectionPath.type === 'oval') {
        return {
            x: Math.round(selectionPath.cx - selectionPath.rx),
            y: Math.round(selectionPath.cy - selectionPath.ry),
            width: Math.round(selectionPath.rx * 2),
            height: Math.round(selectionPath.ry * 2)
        }
    } else if (selectionPath.type === 'lasso' || selectionPath.type === 'polygon') {
        const points = selectionPath.points
        if (points.length === 0) return { x: 0, y: 0, width: 0, height: 0 }

        let minX = points[0].x, maxX = points[0].x
        let minY = points[0].y, maxY = points[0].y

        for (const pt of points) {
            minX = Math.min(minX, pt.x)
            maxX = Math.max(maxX, pt.x)
            minY = Math.min(minY, pt.y)
            maxY = Math.max(maxY, pt.y)
        }

        return {
            x: Math.round(minX),
            y: Math.round(minY),
            width: Math.round(maxX - minX),
            height: Math.round(maxY - minY)
        }
    } else if (selectionPath.type === 'wand' || selectionPath.type === 'mask') {
        const mask = selectionPath.type === 'wand' ? selectionPath.mask : selectionPath.data
        let minX = mask.width, maxX = 0
        let minY = mask.height, maxY = 0

        for (let y = 0; y < mask.height; y++) {
            for (let x = 0; x < mask.width; x++) {
                const idx = (y * mask.width + x) * 4 + 3
                if (mask.data[idx] > 127) {
                    minX = Math.min(minX, x)
                    maxX = Math.max(maxX, x)
                    minY = Math.min(minY, y)
                    maxY = Math.max(maxY, y)
                }
            }
        }

        if (minX > maxX) return { x: 0, y: 0, width: 0, height: 0 }

        return {
            x: minX,
            y: minY,
            width: maxX - minX + 1,
            height: maxY - minY + 1
        }
    }

    return { x: 0, y: 0, width: 0, height: 0 }
}
```

**Step 4: Update copySelection to use new mask functions**

Replace the mask application section:

```javascript
// Apply selection mask for non-rectangular selections
if (selectionPath.type === 'oval') {
    applyOvalMask(ctx, selectionPath, bounds)
} else if (selectionPath.type === 'lasso' || selectionPath.type === 'polygon') {
    applyPolygonMask(ctx, selectionPath.points, bounds)
} else if (selectionPath.type === 'wand' || selectionPath.type === 'mask') {
    const mask = selectionPath.type === 'wand' ? selectionPath.mask : selectionPath.data
    applyImageMask(ctx, mask, bounds)
}
```

**Step 5: Update exports**

```javascript
export { copySelection, pasteFromClipboard, getSelectionBounds, applyPolygonMask, applyImageMask }
```

**Step 6: Commit**

```bash
git add public/js/selection/clipboard-ops.js
git commit -m "feat: update clipboard ops for new selection types"
```

---

### Task 10: Update UI - Menu Items

**Files:**
- Modify: `public/index.html`

**Step 1: Add new menu items to selection menu**

Replace the selection menu items section (inside `#selectionMenu .menu-items`):

```html
<div class="menu-items hide">
    <div id="selectRectMenuItem" class="checked">
        <span class="icon-material">square</span>
        Rectangle
    </div>
    <div id="selectOvalMenuItem">
        <span class="icon-material">lens</span>
        Oval
    </div>
    <div id="selectLassoMenuItem">
        <span class="icon-material">gesture</span>
        Lasso
    </div>
    <div id="selectPolygonMenuItem">
        <span class="icon-material">pentagon</span>
        Polygon
    </div>
    <div id="selectWandMenuItem">
        <span class="icon-material">auto_fix_high</span>
        Magic Wand
    </div>
    <hr class="menu-seperator">
    <div id="wandToleranceRow" class="menu-slider-row hide">
        <label>Tolerance</label>
        <input type="range" id="wandTolerance" min="0" max="255" value="32">
        <span id="wandToleranceValue">32</span>
    </div>
</div>
```

**Step 2: Commit**

```bash
git add public/index.html
git commit -m "feat: add lasso, polygon, wand menu items"
```

---

### Task 11: Style Tolerance Slider

**Files:**
- Modify: `public/css/menu.css`

**Step 1: Add slider row styles**

Add at end of file:

```css
/* Tolerance slider in selection menu */
.menu-slider-row {
    display: flex;
    align-items: center;
    gap: 0.5em;
    padding: 8px 16px;
    font-size: 0.875rem;
}

.menu-slider-row label {
    flex-shrink: 0;
    color: var(--accent3);
}

.menu-slider-row input[type="range"] {
    flex: 1;
    height: 4px;
    -webkit-appearance: none;
    appearance: none;
    background: var(--accent3);
    border-radius: 2px;
    cursor: pointer;
}

.menu-slider-row input[type="range"]::-webkit-slider-thumb {
    -webkit-appearance: none;
    appearance: none;
    width: 12px;
    height: 12px;
    background: var(--accent4);
    border-radius: 50%;
    cursor: pointer;
}

.menu-slider-row span {
    flex-shrink: 0;
    min-width: 2em;
    text-align: right;
    color: var(--accent3);
}
```

**Step 2: Commit**

```bash
git add public/css/menu.css
git commit -m "feat: style tolerance slider"
```

---

### Task 12: Wire Up App Integration

**Files:**
- Modify: `public/js/app.js`

**Step 1: Remove M key handler**

Find and remove the M key cycling code in `_setupKeyboardShortcuts`:

```javascript
// Remove this block:
// M - cycle selection tools
if (e.key === 'm' || e.key === 'M') {
    const current = this._selectionManager?.currentTool
    this._setSelectionTool(current === 'rectangle' ? 'oval' : 'rectangle')
}
```

**Step 2: Update _setSelectionTool for all tools**

Replace `_setSelectionTool`:

```javascript
/**
 * Set the current selection tool
 * @param {'rectangle' | 'oval' | 'lasso' | 'polygon' | 'wand'} tool
 * @private
 */
_setSelectionTool(tool) {
    if (!this._selectionManager) return

    this._selectionManager.currentTool = tool

    // Update menu checkmarks
    const items = ['Rect', 'Oval', 'Lasso', 'Polygon', 'Wand']
    const tools = ['rectangle', 'oval', 'lasso', 'polygon', 'wand']
    items.forEach((item, i) => {
        const el = document.getElementById(`select${item}MenuItem`)
        if (el) el.classList.toggle('checked', tools[i] === tool)
    })

    // Update icon
    const icon = document.getElementById('selectionToolIcon')
    const icons = {
        rectangle: 'square',
        oval: 'lens',
        lasso: 'gesture',
        polygon: 'pentagon',
        wand: 'auto_fix_high'
    }
    if (icon) icon.textContent = icons[tool] || 'square'

    // Show/hide tolerance slider
    const toleranceRow = document.getElementById('wandToleranceRow')
    if (toleranceRow) {
        toleranceRow.classList.toggle('hide', tool !== 'wand')
    }
}
```

**Step 3: Add new menu item handlers in _setupMenuHandlers**

Add after existing selection menu handlers:

```javascript
document.getElementById('selectLassoMenuItem')?.addEventListener('click', () => {
    this._setSelectionTool('lasso')
})

document.getElementById('selectPolygonMenuItem')?.addEventListener('click', () => {
    this._setSelectionTool('polygon')
})

document.getElementById('selectWandMenuItem')?.addEventListener('click', () => {
    this._setSelectionTool('wand')
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
```

**Step 4: Set source canvas on init**

In `init()`, after creating the SelectionManager, add:

```javascript
// Set source canvas for magic wand
if (this._selectionManager) {
    this._selectionManager.setSourceCanvas(this._canvas)
}
```

**Step 5: Commit**

```bash
git add public/js/app.js
git commit -m "feat: wire up new selection tools in app"
```

---

### Task 13: Final Integration Test

**Files:**
- No files modified, manual testing

**Step 1: Start dev server**

```bash
cd .worktrees/marquee-selection
npx http-server public -p 3002
```

**Step 2: Test each tool**

1. Rectangle: Draw selection, verify marching ants
2. Oval: Draw selection, verify marching ants
3. Lasso: Freehand draw, release to close, verify marching ants
4. Polygon: Click 3+ points, double-click to close, verify marching ants
5. Magic Wand: Click on solid color area, verify flood selection

**Step 3: Test modifiers**

1. Make a rectangle selection
2. Hold Shift, make another - verify they combine (add)
3. Hold Alt/Option, make another - verify subtraction
4. Verify combined selections show marching ants

**Step 4: Test copy/paste**

1. Make a lasso selection
2. Cmd+C to copy
3. Cmd+V to paste
4. Verify pasted layer has correct mask shape

**Step 5: Commit any fixes if needed**

```bash
git add -A
git commit -m "fix: integration fixes from testing"
```
