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

    test('a second concurrent runVideoExport is rejected, and a later one runs', async ({ page }) => {
        // runVideoExport is the shared chokepoint for the export dialog AND
        // the agent command; the agent-side job guard can't see a dialog
        // export, so the exporter itself must refuse overlap. Two concurrent
        // runs would fight over the shared canvas resolution and the
        // renderer's pause/restart.
        const out = await page.evaluate(async () => {
            const { runVideoExport } = await import('/js/ui/video-exporter.js')
            const app = window.LayersAgent._app
            const mk = (duration, ac) => ({
                settings: {
                    width: 64, height: 64, framerate: 30, duration,
                    loopCount: 1, format: 'zip', quality: 'low', playFrom: 'beginning'
                },
                canvas: app._canvas,
                renderer: app._renderer,
                files: app._files,
                getResolution: () => ({ width: app._canvas.width, height: app._canvas.height }),
                setResolution: (w, h) => app._resizeCanvas(w, h),
                abortSignal: ac.signal,
                onProgress: () => {}
            })

            const ac1 = new AbortController()
            const p1 = runVideoExport(mk(5, ac1))
            p1.catch(() => {}) // aborted below; keep the rejection handled

            // Let the first export get past startup.
            await new Promise(r => setTimeout(r, 30))

            let second
            try {
                await runVideoExport(mk(0.1, new AbortController()))
                second = { threw: false }
            } catch (err) {
                second = { threw: true, code: err.code || null }
            }

            ac1.abort()
            const first = await p1.then(() => 'completed', (e) => e.code || 'error')

            // Once the in-flight export settles, a fresh one must be allowed.
            let third
            try {
                const r = await runVideoExport(mk(0.1, new AbortController()))
                third = { ok: true, totalFrames: r.totalFrames }
            } catch (err) {
                third = { ok: false, code: err.code || null }
            }

            return { second, first, third }
        })

        expect(out.second.threw).toBe(true)
        expect(out.second.code).toBe('CONFLICT_EXPORT_IN_PROGRESS')
        expect(out.first).toBe('JOB_CANCELLED')
        expect(out.third.ok).toBe(true)
    })
})
