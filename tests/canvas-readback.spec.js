import { test, expect } from 'playwright/test'

// Guards utils/canvas-readback.js readRenderPixels():
//  - WebGL branch is byte-identical to a direct gl.readPixels (the active path);
//  - the 2D-snapshot fallback (used for WebGPU-backed canvases) returns
//    byte-identical bottom-up output for the same visual content (parity),
//    with correct orientation and sub-rect handling.
// The fallback branch is otherwise dead while the app pins preferWebGPU:false,
// so this is its only coverage.
test('readRenderPixels: WebGL identity + fallback parity + orientation', async ({ page }) => {
    await page.goto('/')
    const result = await page.evaluate(async () => {
        const { readRenderPixels } = await import('/js/utils/canvas-readback.js')
        const W = 64, H = 48, half = H / 2

        // WebGL2 canvas: top-down top half red, bottom half blue.
        const glC = document.createElement('canvas'); glC.width = W; glC.height = H
        const gl = glC.getContext('webgl2', { preserveDrawingBuffer: true })
        gl.enable(gl.SCISSOR_TEST)
        gl.scissor(0, half, W, half); gl.clearColor(1, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT) // red = top-down top
        gl.scissor(0, 0, W, half); gl.clearColor(0, 0, 1, 1); gl.clear(gl.COLOR_BUFFER_BIT)    // blue = top-down bottom
        gl.disable(gl.SCISSOR_TEST)

        const ref = new Uint8Array(W * H * 4)
        gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, ref)
        const viaGL = readRenderPixels(glC, 0, 0, W, H)

        // 2D canvas with the SAME visual pattern -> exercises the fallback path
        // (a 2d-context canvas returns null for getContext('webgl2')).
        const c2 = document.createElement('canvas'); c2.width = W; c2.height = H
        const ctx = c2.getContext('2d')
        ctx.fillStyle = '#ff0000'; ctx.fillRect(0, 0, W, half)
        ctx.fillStyle = '#0000ff'; ctx.fillRect(0, half, W, half)
        const via2D = readRenderPixels(c2, 0, 0, W, H)

        const eq = (a, b) => { if (a.length !== b.length) return `len ${a.length} vs ${b.length}`; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return `byte ${i}: ${a[i]} vs ${b[i]}`; return null }
        const px = (buf, row) => [buf[row * W * 4], buf[row * W * 4 + 1], buf[row * W * 4 + 2], buf[row * W * 4 + 3]]

        const sub2D = readRenderPixels(c2, 3, 5, 1, 1) // bottom-up (3,5)
        const fullIdx = (5 * W + 3) * 4

        return {
            glIdentity: eq(ref, viaGL),
            parity: eq(viaGL, via2D),
            bottomRow: px(via2D, 0),     // bottom-up row 0 == image bottom == blue
            topRow: px(via2D, H - 1),    // row H-1 == image top == red
            subMatches: sub2D[0] === via2D[fullIdx] && sub2D[1] === via2D[fullIdx + 1] && sub2D[2] === via2D[fullIdx + 2],
        }
    })
    expect(result.glIdentity, `WebGL identity: ${result.glIdentity}`).toBeNull()
    expect(result.parity, `fallback parity: ${result.parity}`).toBeNull()
    expect(result.bottomRow).toEqual([0, 0, 255, 255])
    expect(result.topRow).toEqual([255, 0, 0, 255])
    expect(result.subMatches).toBe(true)
})
