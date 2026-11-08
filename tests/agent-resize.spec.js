import { test, expect } from './fixtures.js'
import { reopenNewProjectDialog } from './helpers/new-project.js'

// Parallel mode makes each case its own sharding unit: every case here boots
// its own app and shares no state with its siblings, so shards can split this
// file instead of pinning all of it to one runner.
test.describe.configure({ mode: 'parallel' })

async function bootApp(page) {
    await page.goto('/', { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })
    await page.evaluate(async () => { await window.LayersAgent.ready })
    await reopenNewProjectDialog(page)
    await page.click('.media-option[data-type="solid"]')
    await page.waitForSelector('.canvas-size-dialog', { timeout: 5000 })
    await page.click('.canvas-size-dialog .action-btn.primary')
    await page.waitForSelector('.open-dialog-backdrop.visible', { state: 'hidden', timeout: 5000 })
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

// Measures the rendered canvas: its size, and the bounds and pixel count of
// the cyan that an invert child effect makes of a red base.
async function measureInvertedArea(page) {
    return page.evaluate(async () => {
        const encoded = await window.LayersAgent.getCanvasImageBytes({ format: 'png' })
        if (!encoded.ok) throw new Error(encoded.error?.message || 'capture failed')
        const bytes = Uint8Array.from(atob(encoded.result.bytes), character => character.charCodeAt(0))
        const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }))
        const { width, height } = bitmap
        const canvas = new OffscreenCanvas(width, height)
        const ctx = canvas.getContext('2d')
        ctx.drawImage(bitmap, 0, 0)
        bitmap.close()
        const { data } = ctx.getImageData(0, 0, width, height)
        let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1, cyan = 0, red = 0
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const i = (y * width + x) * 4
                if (data[i + 3] <= 240) continue
                if (data[i] < 10 && data[i + 1] > 240 && data[i + 2] > 240) {
                    cyan++
                    x0 = Math.min(x0, x); y0 = Math.min(y0, y)
                    x1 = Math.max(x1, x); y1 = Math.max(y1, y)
                } else if (data[i] > 240 && data[i + 1] < 10 && data[i + 2] < 10) {
                    red++
                }
            }
        }
        return {
            size: { width, height },
            bounds: cyan ? { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 } : null,
            cyan,
            red,
        }
    })
}

function invertedArea(width, height, bounds) {
    const cyan = bounds.width * bounds.height
    return { size: { width, height }, bounds, cyan, red: width * height - cyan }
}

test.describe('resizeImage with a masked child effect', () => {
    test('resamples the child effect mask with the image', async ({ page }) => {
        await page.goto('/', { waitUntil: 'domcontentloaded' })
        await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })
        const setup = await page.evaluate(async () => {
            const agent = window.LayersAgent
            await agent.ready
            const steps = []
            steps.push(await agent.newProject({ width: 64, height: 48 }))
            const base = await agent.addLayer({
                kind: 'effect', effectId: 'synth/solid',
                params: { color: [1, 0, 0], alpha: 1 },
            })
            steps.push(base)
            steps.push(await agent.setRectangleSelection({ x: 0, y: 0, width: 32, height: 24 }))
            steps.push(await agent.addChildEffect({ layerId: base.result.layerId, effectId: 'filter/invert' }))
            steps.push(await agent.selectNone({}))
            return steps.filter(step => !step.ok).map(step => step.error)
        })
        expect(setup).toEqual([])
        const original = invertedArea(64, 48, { x: 0, y: 0, width: 32, height: 24 })
        const resized = invertedArea(128, 96, { x: 0, y: 0, width: 64, height: 48 })
        expect(await measureInvertedArea(page)).toEqual(original)

        const resize = () => page.evaluate(() =>
            window.LayersAgent.resizeImage({ width: 128, height: 96 }))
        expect((await resize()).ok).toBe(true)
        expect(await measureInvertedArea(page), 'after resize').toEqual(resized)

        expect((await page.evaluate(() => window.LayersAgent.undo())).ok).toBe(true)
        expect(await measureInvertedArea(page), 'after undo').toEqual(original)

        expect((await resize()).ok).toBe(true)
        const saved = await page.evaluate(() =>
            window.LayersAgent.saveProjectAs({ name: 'resized child mask' }))
        expect(saved.ok, JSON.stringify(saved.error)).toBe(true)
        const reopened = await page.evaluate(async (projectId) => {
            const agent = window.LayersAgent
            const replaced = await agent.newProject({ width: 16, height: 16 })
            if (!replaced.ok) return replaced
            return agent.openProject({ projectId })
        }, saved.result.projectId)
        expect(reopened.ok, JSON.stringify(reopened.error)).toBe(true)
        expect(await measureInvertedArea(page), 'after reopening the saved project').toEqual(resized)
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
