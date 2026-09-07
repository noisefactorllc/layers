import { test, expect } from './fixtures.js'
import { fileURLToPath } from 'node:url'

test.describe('Image menu - Resize preserves animation', () => {
    test('resizing animated video keeps canvas animated', async ({ page }) => {
        await page.goto('/', { waitUntil: 'networkidle' })
        await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })

        // Use the same 30fps color-cycle fixture in every browser without
        // depending on browser-specific recording APIs.
        await page.waitForSelector('.open-dialog-backdrop.visible')

        // Load the video through the app's open-media file input, same as a
        // user opening a video file.
        const fileInput = await page.locator('.open-dialog-backdrop input[type="file"]')
        await fileInput.setInputFiles(fileURLToPath(new URL('./fixtures/resize-animation.webm', import.meta.url)))
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
        // about. Polling observes the fixture's red and blue frames across
        // playback and loop wraps. A frozen canvas never changes and still
        // fails the deadline.
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
