/**
 * Fill Tool - Flood fill from click point, creating a new media layer
 *
 * Reads composited pixels from the render canvas, performs flood fill
 * using the existing flood-fill algorithm, and creates a new media layer
 * with the filled region.
 *
 * @module tools/fill-tool
 */

import { floodFill } from '../selection/flood-fill.js'
import { readRenderPixels } from '../utils/canvas-readback.js'

export class FillTool {
    constructor(options) {
        this._overlay = options.overlay
        this._canvas = options.canvas
        this._runMutation = options.runMutation
        this._addMediaLayerFromCanvas = options.addMediaLayerFromCanvas
        this._pushUndoState = options.pushUndoState
        this._finalizePendingUndo = options.finalizePendingUndo
        this._markDirty = options.markDirty

        this._color = '#000000'
        this._tolerance = 32
        this._active = false

        this._onClick = this._onClick.bind(this)
    }

    get color() { return this._color }
    set color(v) { this._color = v }
    get tolerance() { return this._tolerance }
    set tolerance(v) { this._tolerance = Math.max(0, Math.min(255, v)) }

    activate() {
        if (this._active) return
        this._active = true
        this._overlay.addEventListener('click', this._onClick)
    }

    deactivate() {
        if (!this._active) return
        this._active = false
        this._overlay.removeEventListener('click', this._onClick)
    }

    _getCanvasCoords(e) {
        const rect = this._overlay.getBoundingClientRect()
        return {
            x: Math.floor((e.clientX - rect.left) * (this._overlay.width / rect.width)),
            y: Math.floor((e.clientY - rect.top) * (this._overlay.height / rect.height))
        }
    }

    async _onClick(e) {
        if (this._runMutation) {
            return this._runMutation(() => this._fill(e))
        }
        return this._fill(e)
    }

    async _fill(e) {
        const pt = this._getCanvasCoords(e)
        const width = this._canvas.width
        const height = this._canvas.height

        // Read composited pixels (bottom-up), backend-agnostic (WebGL2/WebGPU).
        const pixels = readRenderPixels(this._canvas, 0, 0, width, height)

        // readPixels order is bottom-up, flip vertically
        const flipped = new Uint8ClampedArray(width * height * 4)
        for (let y = 0; y < height; y++) {
            const srcRow = (height - 1 - y) * width * 4
            const dstRow = y * width * 4
            flipped.set(pixels.subarray(srcRow, srcRow + width * 4), dstRow)
        }

        const imageData = new ImageData(flipped, width, height)

        // Flood fill from click point
        const mask = floodFill(imageData, pt.x, pt.y, this._tolerance)

        // Create filled canvas with the selected color
        const fillCanvas = document.createElement('canvas')
        fillCanvas.width = width
        fillCanvas.height = height
        const ctx = fillCanvas.getContext('2d')

        // Parse color and fill
        ctx.fillStyle = this._color
        ctx.fillRect(0, 0, width, height)

        // Apply mask — only keep pixels where mask is set
        const fillData = ctx.getImageData(0, 0, width, height)
        for (let i = 0; i < mask.data.length; i += 4) {
            if (mask.data[i + 3] === 0) {
                fillData.data[i + 3] = 0
            }
        }
        ctx.putImageData(fillData, 0, 0)

        // Create a media layer from the fill canvas
        this._finalizePendingUndo()
        await this._addMediaLayerFromCanvas(fillCanvas, 'Fill')
        this._markDirty()
        this._pushUndoState()
    }
}
