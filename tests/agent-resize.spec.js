import { test, expect } from 'playwright/test'

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

test.describe('resizeImage', () => {
    test('changes canvas dimensions', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() =>
            window.LayersAgent.resizeImage({ width: 512, height: 384 }))
        expect(env.ok).toBe(true)
        expect(env.state.canvas).toEqual({ width: 512, height: 384 })
    })

    test('rejects oversized', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() =>
            window.LayersAgent.resizeImage({ width: 9999, height: 9999 }))
        expect(env.ok).toBe(false)
        expect(env.error.code).toBe('INVALID_ARGS_RANGE')
    })

    test('job polling hides a resized candidate that fails during renderer restart', async ({ page }) => {
        await bootApp(page)
        const result = await page.evaluate(async () => {
            const app = window.layersApp
            const readState = async () => {
                const { state } = await window.LayersAgent.getJob({ jobId: 'missing-job' })
                return {
                    project: state.project,
                    canvas: state.canvas,
                    selection: state.selection,
                    layers: state.layers,
                    selectedLayerIds: state.selectedLayerIds,
                    activeLayerId: state.activeLayerId,
                }
            }
            const before = await readState()
            let enteredRestart
            let releaseRestart
            const entered = new Promise(resolve => { enteredRestart = resolve })
            const release = new Promise(resolve => { releaseRestart = resolve })
            app._restoreRendererRunState = async () => {
                enteredRestart()
                await release
                throw new Error('injected renderer restart failure')
            }

            const resize = window.LayersAgent.resizeImage({ width: 512, height: 384 })
            await entered
            const during = await readState()
            releaseRestart()
            const envelope = await resize
            const after = await readState()
            return { before, during, envelope, after }
        })

        expect(result.envelope.ok).toBe(false)
        expect(result.during).toEqual(result.before)
        expect(result.after).toEqual(result.before)
    })

    test('paused resize draws the committed composition without starting playback', async ({ page }) => {
        await bootApp(page)
        const result = await page.evaluate(async () => {
            const { readRenderPixels } = await import('/js/utils/canvas-readback.js')
            const app = window.layersApp
            const readCenter = () => Array.from(readRenderPixels(
                app._canvas,
                Math.floor(app._canvas.width / 2),
                Math.floor(app._canvas.height / 2),
                1,
                1,
            ))
            app._renderer.stop()
            app._renderCurrentFrame()
            const before = readCenter()
            const outcome = await app._resizeImage(512, 384)
            return {
                status: outcome.status,
                before,
                after: readCenter(),
                running: app._renderer.isRunning,
            }
        })

        expect(result.status).toBe('committed')
        expect(result.running).toBe(false)
        expect(result.after).toEqual(result.before)
        expect(result.after[3]).toBe(255)
    })

    test('paused failed resize redraws the restored composition', async ({ page }) => {
        await bootApp(page)
        const result = await page.evaluate(async () => {
            const { readRenderPixels } = await import('/js/utils/canvas-readback.js')
            const app = window.layersApp
            const readCenter = () => Array.from(readRenderPixels(
                app._canvas,
                Math.floor(app._canvas.width / 2),
                Math.floor(app._canvas.height / 2),
                1,
                1,
            ))
            app._renderer.stop()
            app._renderCurrentFrame()
            const before = readCenter()
            app._renderer.stageLayerSet = async () => ({
                success: false,
                error: 'injected paused resize failure',
                rollback: async () => ({ success: true }),
            })
            const outcome = await app._resizeImage(512, 384)
            return {
                status: outcome.status,
                before,
                after: readCenter(),
                canvas: [app._canvas.width, app._canvas.height],
                running: app._renderer.isRunning,
            }
        })

        expect(result.status).toBe('failed')
        expect(result.canvas).toEqual([1024, 1024])
        expect(result.running).toBe(false)
        expect(result.after).toEqual(result.before)
        expect(result.after[3]).toBe(255)
    })
})

test.describe('resizeCanvas', () => {
    test('changes canvas dimensions with default anchor', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() =>
            window.LayersAgent.resizeCanvas({ width: 1500, height: 1500 }))
        expect(env.ok).toBe(true)
        expect(env.state.canvas).toEqual({ width: 1500, height: 1500 })
    })

    test('honors anchor', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() =>
            window.LayersAgent.resizeCanvas({ width: 800, height: 600, anchor: 'top-left' }))
        expect(env.ok).toBe(true)
        expect(env.state.canvas).toEqual({ width: 800, height: 600 })
    })

    test('rejects unknown anchor', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() =>
            window.LayersAgent.resizeCanvas({ width: 800, height: 600, anchor: 'middle' }))
        expect(env.ok).toBe(false)
        expect(env.error.code).toBe('INVALID_ARGS_ENUM')
    })
})
