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
        // Wait for the video to exist and be playing, rather than sleeping. The
        // fixture is one second long, so a fixed sleep spends the clip: by the
        // time the observation below starts, playback has already reached the
        // end, and a browser that does not restart the loop leaves a frozen
        // frame that looks exactly like the regression this test hunts.
        await page.waitForFunction(() => {
            const media = [...(window.layersApp?._renderer?.getVideoMediaIterator?.() ?? [])]
            const video = media[0]?.videoElement
            return !!video && video.readyState >= 2
        }, null, { timeout: 15000 })

        // Verify renderer is running before resize
        const runningBefore = await page.evaluate(() => window.layersApp._renderer.isRunning)
        expect(runningBefore).toBe(true)

        // Resize to 720x720
        await page.evaluate(async () => {
            await window.layersApp._resizeImage(720, 720)
        })

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

        // Observe within the browser: round trips and whole-row readbacks
        // can repeatedly sample the same phase of this one-second clip.
        // Render and read in one task because preserveDrawingBuffer is false.
        // Fixed render time excludes shader animation; only live video texture
        // updates can change this uniform-color fixture's center pixel.
        // Start the clip from a known point and confirm it is advancing, so the
        // observation measures the texture path rather than whatever phase the
        // one-second fixture happened to be in. A stalled loop at the end of the
        // clip is a browser behaviour, not the resize regression under test.
        await page.evaluate(async () => {
            const video = [...window.layersApp._renderer.getVideoMediaIterator()][0]?.videoElement
            if (!video) return
            video.currentTime = 0
            await video.play().catch(() => {})
        })
        await page.waitForFunction(() => {
            const video = [...window.layersApp._renderer.getVideoMediaIterator()][0]?.videoElement
            return !!video && !video.paused && video.currentTime > 0
        }, null, { timeout: 10000 })

        const observation = await page.evaluate(async () => {
            const { readRenderPixels } = await import('/js/utils/canvas-readback.js')
            const app = window.layersApp
            const canvas = app._canvas
            const video = [...app._renderer.getVideoMediaIterator()][0]?.videoElement
            const started = performance.now()
            const samples = []
            return new Promise((resolve, reject) => {
                let raf = null
                let timer = null
                let settled = false
                let first = null
                let lastSample = -Infinity
                const cleanup = () => {
                    cancelAnimationFrame(raf)
                    clearTimeout(timer)
                }
                const finish = (changed) => {
                    if (settled) return
                    settled = true
                    cleanup()
                    resolve({
                        changed,
                        elapsedMs: Math.round(performance.now() - started),
                        samples,
                        video: video ? {
                            currentTime: video.currentTime,
                            duration: video.duration,
                            paused: video.paused,
                            ended: video.ended,
                            readyState: video.readyState,
                        } : null,
                    })
                }
                const sample = () => {
                    if (settled) return
                    const elapsedMs = performance.now() - started
                    if (elapsedMs >= 4000) return finish(false)
                    try {
                        if (elapsedMs - lastSample >= 100) {
                            app._renderer.render(0)
                            const rgba = Array.from(readRenderPixels(canvas,
                                Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1))
                            samples.push({ elapsedMs: Math.round(elapsedMs), rgba,
                                videoTime: video?.currentTime ?? null })
                            lastSample = elapsedMs
                            if (first && rgba.some((value, i) => value !== first[i])) return finish(true)
                            first = rgba
                        }
                        raf = requestAnimationFrame(sample)
                    } catch (error) {
                        settled = true
                        cleanup()
                        reject(error)
                    }
                }
                // RAF may stop in a stalled/hidden document; its absence must
                // still fail this observation at the same four-second deadline.
                timer = setTimeout(() => finish(false), 4000)
                raf = requestAnimationFrame(sample)
            })
        })
        expect(observation.changed, JSON.stringify(observation)).toBe(true)
    })
})
