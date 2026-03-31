/**
 * Clipboard Operations
 * Handles copy/paste with selections
 *
 * @module selection/clipboard-ops
 */

/**
 * Copy selected region from layers to clipboard
 * @param {object} options
 * @param {object} selectionPath - Selection path (rect or oval)
 * @param {object[]} layers - Array of layer objects (visible, selected)
 * @param {HTMLCanvasElement} sourceCanvas - Main render canvas
 * @returns {Promise<{x: number, y: number} | null>} Copy origin for paste-in-place, or null if failed
 */
async function copySelection({ selectionPath, layers, sourceCanvas }) {
    if (!selectionPath || layers.length === 0) return null

    const bounds = getSelectionBounds(selectionPath)
    if (bounds.width <= 0 || bounds.height <= 0) return null

    const offscreen = new OffscreenCanvas(bounds.width, bounds.height)
    const ctx = offscreen.getContext('2d')

    ctx.drawImage(
        sourceCanvas,
        bounds.x, bounds.y, bounds.width, bounds.height,
        0, 0, bounds.width, bounds.height
    )

    if (selectionPath.type === 'oval') {
        applyOvalMask(ctx, selectionPath, bounds)
    } else if (selectionPath.type === 'lasso' || selectionPath.type === 'polygon') {
        applyPolygonMask(ctx, selectionPath.points, bounds)
    } else if (selectionPath.type === 'wand' || selectionPath.type === 'mask') {
        const mask = selectionPath.type === 'wand' ? selectionPath.mask : selectionPath.data
        applyImageMask(ctx, mask, bounds)
    }

    try {
        const blob = await offscreen.convertToBlob({ type: 'image/png' })
        await navigator.clipboard.write([
            new ClipboardItem({ 'image/png': blob })
        ])

        return { x: bounds.x, y: bounds.y }
    } catch (err) {
        console.error('[Clipboard] Failed to copy:', err)
        return null
    }
}

/**
 * Paste from clipboard
 * @returns {Promise<{blob: Blob, origin: {x: number, y: number} | null} | null>}
 */
async function pasteFromClipboard() {
    try {
        const items = await navigator.clipboard.read()

        for (const item of items) {
            if (item.types.includes('image/png')) {
                const blob = await item.getType('image/png')
                return { blob, origin: null }
            }
            if (item.types.includes('image/jpeg')) {
                const blob = await item.getType('image/jpeg')
                return { blob, origin: null }
            }
        }

        return null
    } catch (err) {
        console.error('[Clipboard] Failed to paste:', err)
        return null
    }
}

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

/**
 * Apply oval mask to canvas context
 * @param {CanvasRenderingContext2D} ctx
 * @param {object} selectionPath
 * @param {{x: number, y: number, width: number, height: number}} bounds
 */
function applyOvalMask(ctx, selectionPath, bounds) {
    ctx.globalCompositeOperation = 'destination-in'
    ctx.beginPath()
    ctx.ellipse(
        selectionPath.cx - bounds.x,
        selectionPath.cy - bounds.y,
        selectionPath.rx,
        selectionPath.ry,
        0, 0, Math.PI * 2
    )
    ctx.fill()
    ctx.globalCompositeOperation = 'source-over'
}

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

/**
 * Apply image mask to canvas context
 * @param {CanvasRenderingContext2D} ctx
 * @param {ImageData} mask
 * @param {{x: number, y: number, width: number, height: number}} bounds
 */
function applyImageMask(ctx, mask, bounds) {
    const imageData = ctx.getImageData(0, 0, bounds.width, bounds.height)

    for (let y = 0; y < bounds.height; y++) {
        for (let x = 0; x < bounds.width; x++) {
            const srcX = bounds.x + x
            const srcY = bounds.y + y

            const outOfBounds = srcX < 0 || srcX >= mask.width || srcY < 0 || srcY >= mask.height
            const maskAlpha = outOfBounds
                ? 0
                : mask.data[(srcY * mask.width + srcX) * 4 + 3]

            if (maskAlpha <= 127) {
                imageData.data[(y * bounds.width + x) * 4 + 3] = 0
            }
        }
    }

    ctx.putImageData(imageData, 0, 0)
}

/**
 * Check if clipboard contains image data
 * @returns {Promise<boolean>}
 */
async function clipboardHasImage() {
    try {
        const items = await navigator.clipboard.read()
        for (const item of items) {
            if (item.types.includes('image/png') || item.types.includes('image/jpeg')) {
                return true
            }
        }
        return false
    } catch {
        return false
    }
}

/**
 * Copy a canvas to clipboard as PNG
 * @param {HTMLCanvasElement} canvas
 * @returns {Promise<boolean>}
 */
async function copyCanvasToClipboard(canvas) {
    try {
        const blob = await new Promise((resolve, reject) => {
            canvas.toBlob(b => b ? resolve(b) : reject(new Error('toBlob returned null')), 'image/png')
        })
        await navigator.clipboard.write([
            new ClipboardItem({ 'image/png': blob })
        ])
        return true
    } catch (err) {
        console.error('[Clipboard] Failed to copy canvas:', err)
        return false
    }
}

export { copySelection, pasteFromClipboard, clipboardHasImage, copyCanvasToClipboard, getSelectionBounds, applyPolygonMask, applyImageMask }
