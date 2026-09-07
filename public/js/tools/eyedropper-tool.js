/**
 * Eyedropper Tool - Sample a pixel color from the render canvas
 *
 * Reads a pixel at the click position, sets the foreground color,
 * and auto-returns to the previous tool.
 *
 * @module tools/eyedropper-tool
 */

import { readRenderPixels } from '../utils/canvas-readback.js'

export class EyedropperTool {
    constructor(options) {
        this._overlay = options.overlay
        this._canvas = options.canvas
        this._captureCanvas = options.captureCanvas
        this._runMutation = options.runMutation
        this._setForegroundColor = options.setForegroundColor
        this._restorePreviousTool = options.restorePreviousTool

        this._active = false
        this._activationGeneration = 0
        this._onClick = this._onClick.bind(this)
    }

    activate() {
        if (this._active) return
        this._active = true
        this._activationGeneration++
        this._overlay.addEventListener('click', this._onClick)
    }

    deactivate() {
        if (!this._active) return
        this._active = false
        this._activationGeneration++
        this._overlay.removeEventListener('click', this._onClick)
    }

    _getCanvasCoords(e) {
        const rect = this._overlay.getBoundingClientRect()
        return {
            x: Math.floor((e.clientX - rect.left) * (this._overlay.width / rect.width)),
            y: Math.floor((e.clientY - rect.top) * (this._overlay.height / rect.height))
        }
    }

    _onClick(e) {
        const generation = this._activationGeneration
        return this._runMutation ? this._runMutation(() => this._sample(e, generation)) : this._sample(e, generation)
    }

    async _sample(e, generation = this._activationGeneration) {
        if (!this._active || generation !== this._activationGeneration) return
        const pt = this._getCanvasCoords(e)
        // Bottom-up 1px read at the click point, backend-agnostic (WebGL2/WebGPU).
        // Top-origin row pt.y maps to bottom-up row height-1-pt.y (matches fill-tool).
        const source = this._captureCanvas ? await this._captureCanvas() : this._canvas
        if (!this._active || generation !== this._activationGeneration) return
        const pixels = readRenderPixels(source, pt.x, this._canvas.height - 1 - pt.y, 1, 1)

        const hex = '#' + [pixels[0], pixels[1], pixels[2]]
            .map(v => v.toString(16).padStart(2, '0')).join('')

        this._setForegroundColor(hex)
        this._restorePreviousTool()
    }
}
