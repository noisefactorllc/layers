import { test, expect } from 'playwright/test'

test.describe('headless video-exporter', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('/')
        await page.evaluate(() => window.LayersAgent.ready)
    })

    test('runVideoExport completes a tiny ZIP export', async ({ page }) => {
        // Pick ZIP to avoid touching the WebCodecs/MP4 path in test env;
        // ZIP path uses readPixels and a worker.
        const result = await page.evaluate(async () => {
            const { runVideoExport } = await import('/js/ui/video-exporter.js')
            const app = window.LayersAgent._app
            const settings = {
                width: 64, height: 64, framerate: 30, duration: 0.1,
                loopCount: 1, format: 'zip', quality: 'low', playFrom: 'beginning'
            }
            return await runVideoExport({
                settings,
                canvas: app._canvas,
                renderer: app._renderer,
                files: app._files,
                getResolution: () => ({ width: app._canvas.width, height: app._canvas.height }),
                setResolution: (w, h) => app._resizeCanvas(w, h),
                abortSignal: new AbortController().signal,
                onProgress: () => {}
            })
        })
        expect(result.format).toBe('zip')
        expect(result.totalFrames).toBeGreaterThan(0)
    })

    test('runVideoExport honors abort signal', async ({ page }) => {
        const result = await page.evaluate(async () => {
            const { runVideoExport } = await import('/js/ui/video-exporter.js')
            const app = window.LayersAgent._app
            const ac = new AbortController()
            setTimeout(() => ac.abort(), 20)
            const settings = {
                width: 64, height: 64, framerate: 30, duration: 5,
                loopCount: 1, format: 'zip', quality: 'low', playFrom: 'beginning'
            }
            try {
                await runVideoExport({
                    settings,
                    canvas: app._canvas,
                    renderer: app._renderer,
                    files: app._files,
                    getResolution: () => ({ width: app._canvas.width, height: app._canvas.height }),
                    setResolution: (w, h) => app._resizeCanvas(w, h),
                    abortSignal: ac.signal,
                    onProgress: () => {}
                })
                return { aborted: false }
            } catch (e) {
                return { aborted: true, code: e.code, message: e.message }
            }
        })
        expect(result.aborted).toBe(true)
        expect(result.code).toBe('JOB_CANCELLED')
    })
})
