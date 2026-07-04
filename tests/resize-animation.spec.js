import { test, expect } from 'playwright/test'

test.describe('Image menu - Resize preserves animation', () => {
    test('resizing animated video keeps canvas animated', async ({ page }) => {
        await page.goto('/', { waitUntil: 'networkidle' })
        await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })

        // Generate an animated (color-cycling) webm in-page so the test is
        // hermetic — it used to load a file from the user's ~/Downloads,
        // which broke whenever that file was cleaned up.
        await page.waitForSelector('.open-dialog-backdrop.visible')
        const videoB64 = await page.evaluate(async () => {
            const W = 128, H = 128
            const c = document.createElement('canvas')
            c.width = W
            c.height = H
            const ctx = c.getContext('2d')
            let hue = 0
            const paint = () => {
                hue = (hue + 15) % 360
                ctx.fillStyle = `hsl(${hue}, 100%, 50%)`
                ctx.fillRect(0, 0, W, H)
            }
            paint()
            const stream = c.captureStream(20)
            const rec = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8' })
            const chunks = []
            rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data) }
            const stopped = new Promise(r => { rec.onstop = r })
            rec.start()
            const iv = setInterval(paint, 30)
            await new Promise(r => setTimeout(r, 1200))
            clearInterval(iv)
            rec.stop()
            await stopped
            const blob = new Blob(chunks, { type: 'video/webm' })
            const buf = await blob.arrayBuffer()
            let bin = ''
            const bytes = new Uint8Array(buf)
            for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
            return btoa(bin)
        })

        // Load the video through the app's open-media file input, same as a
        // user opening a video file.
        const fileInput = await page.locator('.open-dialog-backdrop input[type="file"]')
        await fileInput.setInputFiles({
            name: 'animated.webm',
            mimeType: 'video/webm',
            buffer: Buffer.from(videoB64, 'base64')
        })
        await page.waitForSelector('.open-dialog-backdrop.visible', { state: 'hidden', timeout: 15000 })
        await page.waitForTimeout(1000)

        // Verify renderer is running before resize
        const runningBefore = await page.evaluate(() => window.layersApp._renderer.isRunning)
        expect(runningBefore).toBe(true)

        // Resize to 720x720
        await page.evaluate(async () => {
            await window.layersApp._resizeImage(720, 720)
        })
        await page.waitForTimeout(500)

        // Verify canvas dimensions
        const dims = await page.evaluate(() => ({
            w: window.layersApp._canvas.width,
            h: window.layersApp._canvas.height
        }))
        expect(dims.w).toBe(720)
        expect(dims.h).toBe(720)

        // Verify renderer is still running after resize
        const runningAfter = await page.evaluate(() => window.layersApp._renderer.isRunning)
        expect(runningAfter).toBe(true)

        // Verify animation: poll until a captured frame differs from the
        // first. Render synchronously and read in the same task (the export
        // pipeline's idiom) — preserveDrawingBuffer is false, so reading the
        // GL buffer between frames is undefined and flaked. Rendering at a
        // fixed normalizedTime pins any time-driven animation, so a diff can
        // only come from the per-frame video texture updates this test is
        // about. Polling (rather than two fixed samples) rides out the loop
        // wrap of the MediaRecorder-generated webm, which has no seek index
        // and can stall the displayed frame for a beat when it restarts; a
        // genuinely frozen canvas — the regression this guards — never
        // changes and still fails the deadline.
        const grabRow = () => page.evaluate(async () => {
            const { readRenderPixels } = await import('/js/utils/canvas-readback.js')
            const app = window.layersApp
            const canvas = app._canvas
            app._renderer.render(0)
            const row = readRenderPixels(canvas, 0, Math.floor(canvas.height / 2), canvas.width, 1)
            return Array.from(row)
        })

        const frame1 = await grabRow()
        let changed = false
        const deadline = Date.now() + 4000
        while (!changed && Date.now() < deadline) {
            await page.waitForTimeout(300)
            const next = await grabRow()
            changed = next.some((b, i) => b !== frame1[i])
        }
        expect(changed).toBe(true)
    })
})
