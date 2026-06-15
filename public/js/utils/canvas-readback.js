/**
 * Backend-agnostic canvas pixel readback.
 *
 * Mirrors `gl.readPixels(x, y, w, h, RGBA, UNSIGNED_BYTE, ...)`: returns a
 * BOTTOM-UP (WebGL-origin) Uint8Array of length w*h*4, so callers that already
 * handle readPixels' bottom-up row order need no changes.
 *
 * On a WebGL2/WebGL canvas this performs the identical `gl.readPixels` call —
 * byte-for-byte the same as reading the context directly. On a WebGPU (or any
 * non-WebGL) canvas it snapshots through a 2D context and flips rows to match
 * readPixels' orientation, giving the pixel-readback features (auto-adjust,
 * paint bucket, eyedropper, zip frame export) WebGL2<->WebGPU parity.
 *
 * @module utils/canvas-readback
 */

// Reused 2D scratch canvas for the non-WebGL fallback. Safe to share because
// every call uses it synchronously (drawImage -> getImageData) on the main
// thread with no re-entry; a worker or async caller would need its own.
let _scratch = null
let _scratchCtx = null

/**
 * Read a w*h block of RGBA pixels whose bottom-left corner is (x, y), measured
 * from the bottom of the canvas (WebGL convention).
 *
 * @param {HTMLCanvasElement|OffscreenCanvas} canvas
 * @param {number} x - bottom-up origin x
 * @param {number} y - bottom-up origin y
 * @param {number} w - block width
 * @param {number} h - block height
 * @returns {Uint8Array} bottom-up RGBA, length w*h*4
 */
export function readRenderPixels(canvas, x, y, w, h) {
    const out = new Uint8Array(w * h * 4)

    const gl = canvas.getContext('webgl2') || canvas.getContext('webgl')
    if (gl) {
        gl.readPixels(x, y, w, h, gl.RGBA, gl.UNSIGNED_BYTE, out)
        return out
    }

    // No WebGL context (e.g. a WebGPU-backed canvas). drawImage accepts any
    // canvas regardless of its backing context, so snapshot through a 2D
    // context. readPixels rows [y, y+h) counted from the BOTTOM map to top-down
    // rows [ch - y - h, ch - y); extract that band, then flip to bottom-up.
    if (!_scratch) {
        _scratch = new OffscreenCanvas(w, h)
        _scratchCtx = _scratch.getContext('2d', { willReadFrequently: true })
    } else if (_scratch.width !== w || _scratch.height !== h) {
        _scratch.width = w
        _scratch.height = h
    }

    const ch = canvas.height
    _scratchCtx.clearRect(0, 0, w, h)
    _scratchCtx.drawImage(canvas, x, ch - y - h, w, h, 0, 0, w, h)
    const top = _scratchCtx.getImageData(0, 0, w, h).data

    const rowBytes = w * 4
    for (let row = 0; row < h; row++) {
        const src = row * rowBytes
        out.set(top.subarray(src, src + rowBytes), (h - 1 - row) * rowBytes)
    }
    return out
}
