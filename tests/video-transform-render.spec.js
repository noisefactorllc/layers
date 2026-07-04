import { test, expect } from 'playwright/test'

// Differential render tests for CPU-side media transforms (scale/flip).
//
// Two stacked defects kept flips from ever displaying:
//  - updateLayerTransform drew the transform into an OffscreenCanvas, but
//    the engine's updateTextureFromSource silently ignores OffscreenCanvas
//    sources (no throw, no update) — so image flips never displayed either;
//    scale only LOOKED right because the imageSize uniform stretches the
//    raw texture.
//  - for VIDEOS, _updateVideoTextures re-uploaded the raw element every
//    animation frame, clobbering whatever transform upload did land.
// Both paths now draw into a shared per-media DOM canvas helper.
// (Rotation is a shader uniform and unaffected throughout.)
//
// The video fixture is a MediaRecorder-captured webm whose every frame is
// the same left-red / right-blue pattern, so pixel expectations are stable
// regardless of playback position or looping.

async function bootApp(page) {
    await page.goto('/', { waitUntil: 'networkidle' })
    await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })
    await page.evaluate(async () => { await window.LayersAgent.ready })
    const visible = await page.evaluate(() => !!document.querySelector('.open-dialog-backdrop.visible'))
    if (visible) {
        await page.click('.media-option[data-type="solid"]')
        await page.waitForSelector('.canvas-size-dialog', { timeout: 5000 })
        await page.click('.canvas-size-dialog .action-btn.primary')
        await page.waitForSelector('.open-dialog-backdrop.visible', { state: 'hidden', timeout: 5000 })
    }
}

/** Record a 64x64 left-red/right-blue webm and add it as a video layer. */
async function addStripeVideoLayer(page) {
    const setup = await page.evaluate(async () => {
        const W = 64, H = 64
        const c = document.createElement('canvas')
        c.width = W
        c.height = H
        const ctx = c.getContext('2d')
        const paint = () => {
            ctx.fillStyle = '#ff0000'
            ctx.fillRect(0, 0, W / 2, H)
            ctx.fillStyle = '#0000ff'
            ctx.fillRect(W / 2, 0, W / 2, H)
        }
        paint()
        const stream = c.captureStream(20)
        const rec = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8' })
        const chunks = []
        rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data) }
        const stopped = new Promise(r => { rec.onstop = r })
        rec.start()
        // Repaint on an interval so the captured stream keeps emitting frames.
        const iv = setInterval(paint, 40)
        await new Promise(r => setTimeout(r, 800))
        clearInterval(iv)
        rec.stop()
        await stopped

        const blob = new Blob(chunks, { type: 'video/webm' })
        if (!blob.size) return { error: 'empty recording' }
        const file = new File([blob], 'stripe.webm', { type: 'video/webm' })
        await window.layersApp._handleAddMediaLayer(file, 'video')
        const layer = window.layersApp._layers[window.layersApp._layers.length - 1]
        const media = window.layersApp._renderer.getMediaInfo(layer.id)
        return { layerId: layer.id, mediaW: media?.width, mediaH: media?.height }
    })
    expect(setup.error).toBeUndefined()
    expect(setup.mediaW).toBe(64)
    expect(setup.mediaH).toBe(64)
    return setup.layerId
}

/**
 * Sample the composited canvas inside the left and right halves of the
 * centered 64px video after letting several per-frame uploads land.
 */
async function sampleMediaHalves(page) {
    return page.evaluate(async () => {
        const { readRenderPixels } = await import('/js/utils/canvas-readback.js')
        await new Promise(r => setTimeout(r, 300))
        const app = window.layersApp
        const canvas = app._canvas
        // Render synchronously and read in the same task —
        // preserveDrawingBuffer is false, so reads between frames are
        // undefined. Fixed time is fine: the fixture's frames all show the
        // same left-red/right-blue pattern.
        app._renderer.render(0)
        const midY = Math.floor(canvas.height / 2)
        const leftX = Math.floor(canvas.width / 2) - 24
        const rightX = Math.floor(canvas.width / 2) + 24
        const l = readRenderPixels(canvas, leftX, midY, 1, 1)
        const r = readRenderPixels(canvas, rightX, midY, 1, 1)
        return { left: [l[0], l[1], l[2]], right: [r[0], r[1], r[2]] }
    })
}

const isRed = (p) => p[0] > 150 && p[2] < 100
const isBlue = (p) => p[2] > 150 && p[0] < 100

test.describe('video layer CPU transforms vs per-frame uploads', () => {
    test('flipH on a video layer survives per-frame texture updates', async ({ page }) => {
        await bootApp(page)
        const layerId = await addStripeVideoLayer(page)

        // Control: untransformed orientation (also guards the fix against
        // changing the no-transform upload path).
        const before = await sampleMediaHalves(page)
        expect(isRed(before.left)).toBe(true)
        expect(isBlue(before.right)).toBe(true)

        const env = await page.evaluate((id) =>
            window.LayersAgent.setLayerTransform({ layerId: id, transform: { flipH: true } }), layerId)
        expect(env.ok).toBe(true)

        // With per-frame uploads clobbering the CPU flip, left snapped back
        // to red after one animation frame.
        const flipped = await sampleMediaHalves(page)
        expect(isBlue(flipped.left)).toBe(true)
        expect(isRed(flipped.right)).toBe(true)

        // Back to identity restores the raw orientation.
        const env2 = await page.evaluate((id) =>
            window.LayersAgent.setLayerTransform({ layerId: id, transform: { flipH: false } }), layerId)
        expect(env2.ok).toBe(true)
        const restored = await sampleMediaHalves(page)
        expect(isRed(restored.left)).toBe(true)
        expect(isBlue(restored.right)).toBe(true)
    })

    test('flipH on an image layer actually flips displayed pixels', async ({ page }) => {
        await bootApp(page)
        const layerId = await page.evaluate(async () => {
            const c = document.createElement('canvas')
            c.width = 64
            c.height = 64
            const ctx = c.getContext('2d')
            ctx.fillStyle = '#ff0000'
            ctx.fillRect(0, 0, 32, 64)
            ctx.fillStyle = '#0000ff'
            ctx.fillRect(32, 0, 32, 64)
            const blob = await new Promise(r => c.toBlob(r, 'image/png'))
            const file = new File([blob], 'stripe.png', { type: 'image/png' })
            await window.layersApp._handleAddMediaLayer(file, 'image')
            return window.layersApp._layers[window.layersApp._layers.length - 1].id
        })

        const before = await sampleMediaHalves(page)
        expect(isRed(before.left)).toBe(true)
        expect(isBlue(before.right)).toBe(true)

        const env = await page.evaluate((id) =>
            window.LayersAgent.setLayerTransform({ layerId: id, transform: { flipH: true } }), layerId)
        expect(env.ok).toBe(true)

        // Pre-fix, the OffscreenCanvas upload was silently ignored and the
        // image stayed unflipped.
        const flipped = await sampleMediaHalves(page)
        expect(isBlue(flipped.left)).toBe(true)
        expect(isRed(flipped.right)).toBe(true)
    })

    test('scaled video keeps its scale across per-frame updates', async ({ page }) => {
        await bootApp(page)
        const layerId = await addStripeVideoLayer(page)

        // Scale 2x: the video now spans center±64, so a point at center+48
        // (outside the unscaled 64px footprint, inside the scaled one) must
        // show the video's blue right half rather than the backdrop.
        const env = await page.evaluate((id) =>
            window.LayersAgent.setLayerTransform({ layerId: id, transform: { scaleX: 2, scaleY: 2 } }), layerId)
        expect(env.ok).toBe(true)

        const out = await page.evaluate(async () => {
            const { readRenderPixels } = await import('/js/utils/canvas-readback.js')
            await new Promise(r => setTimeout(r, 300))
            const app = window.layersApp
            const canvas = app._canvas
            app._renderer.render(0) // defined readback: render + read same task
            const midY = Math.floor(canvas.height / 2)
            const x = Math.floor(canvas.width / 2) + 48
            const p = readRenderPixels(canvas, x, midY, 1, 1)
            return [p[0], p[1], p[2]]
        })
        expect(isBlue(out)).toBe(true)
    })
})
