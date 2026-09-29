import { test, expect } from './fixtures.js'
import { appReady } from './waits.js'
import { reopenNewProjectDialog } from './helpers/new-project.js'

async function beginTinyZipExport(page) {
    await page.fill('#exportWidth', '64')
    await page.fill('#exportHeight', '64')
    await page.fill('#exportDuration', '1')
    await page.selectOption('#exportFramerate', '24')
    await page.selectOption('#exportFormat', 'zip')
    await page.click('#exportBeginBtn')
    await page.waitForFunction(() => window.layersApp._exportVideoDialog.state === 'exporting')
}

async function cancelExport(page) {
    await page.click('#exportProgressCancelBtn')
    await page.waitForFunction(() => window.layersApp._exportVideoDialog.state === 'idle')
    await expect(page.locator('#exportModal')).not.toBeVisible()
}

test.describe('Export Video Dialog', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('/', { waitUntil: 'networkidle' })
        await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })

        // Create a solid base layer
        await reopenNewProjectDialog(page)
        await page.click('.media-option[data-type="solid"]')
        await page.waitForSelector('.canvas-size-dialog', { timeout: 5000 })
        await page.click('.canvas-size-dialog .action-btn.primary')
        await page.waitForSelector('.open-dialog-backdrop.visible', { state: 'hidden', timeout: 5000 })
        await appReady(page)
    })

    test('opens via menu and shows current canvas dimensions', async ({ page }) => {
        await page.click('.hf-menubar-trigger:has-text("file")')
        await page.click('#exportVideoMenuItem')

        const dialog = page.locator('#exportModal')
        await expect(dialog).toBeVisible()

        const width = await page.locator('#exportWidth').inputValue()
        const height = await page.locator('#exportHeight').inputValue()
        expect(width).toBe('1024')
        expect(height).toBe('1024')
    })

    test('shows settings view initially, not progress', async ({ page }) => {
        await page.click('.hf-menubar-trigger:has-text("file")')
        await page.click('#exportVideoMenuItem')

        await expect(page.locator('#exportDialogView')).toBeVisible()
        await expect(page.locator('#exportProgressView')).not.toBeVisible()
    })

    test('updates total frames when settings change', async ({ page }) => {
        await page.click('.hf-menubar-trigger:has-text("file")')
        await page.click('#exportVideoMenuItem')

        // Default: 30fps * 15s * 1 loop = 450 frames
        await expect(page.locator('#exportTotalFrames')).toHaveText('450 frames')

        // Change duration to 10
        await page.fill('#exportDuration', '10')
        await expect(page.locator('#exportTotalFrames')).toHaveText('300 frames')

        // Change framerate to 60
        await page.selectOption('#exportFramerate', '60')
        await expect(page.locator('#exportTotalFrames')).toHaveText('600 frames')
    })

    test('invalid settings are rejected before acquiring a mutation lease', async ({ page }) => {
        await page.click('.hf-menubar-trigger:has-text("file")')
        await page.click('#exportVideoMenuItem')

        const result = await page.evaluate(async () => {
            const app = window.layersApp
            const dialog = app._exportVideoDialog
            let acquisitions = 0
            dialog.acquireMutation = () => {
                acquisitions += 1
                return null
            }
            const cases = [
                { width: '4097', height: '64', duration: '1', loops: '1', fps: '24' },
                { width: '64', height: '-1', duration: '1', loops: '1', fps: '24' },
                { width: '64.5', height: '64', duration: '1', loops: '1', fps: '24' },
                { width: '64', height: '64', duration: '300', loops: '10', fps: '60' },
            ]
            for (const values of cases) {
                dialog._elements.widthInput.value = values.width
                dialog._elements.heightInput.value = values.height
                dialog._elements.durationInput.value = values.duration
                dialog._elements.loopCountInput.value = values.loops
                dialog._elements.framerateSelect.value = values.fps
                await dialog.beginExport()
            }
            return {
                acquisitions,
                state: dialog.state,
                running: app._renderer.isRunning,
                lifecycleActive: app._projectLifecycleActive,
            }
        })

        expect(result).toEqual({
            acquisitions: 0,
            state: 'dialog',
            running: true,
            lifecycleActive: false,
        })
    })

    test('closes on cancel button', async ({ page }) => {
        await page.click('.hf-menubar-trigger:has-text("file")')
        await page.click('#exportVideoMenuItem')

        await expect(page.locator('#exportModal')).toBeVisible()

        await page.click('#exportCancelBtn')
        await expect(page.locator('#exportModal')).not.toBeVisible()
    })

    test('closes on Escape key', async ({ page }) => {
        await page.click('.hf-menubar-trigger:has-text("file")')
        await page.click('#exportVideoMenuItem')

        await expect(page.locator('#exportModal')).toBeVisible()

        await page.keyboard.press('Escape')
        await expect(page.locator('#exportModal')).not.toBeVisible()
    })

    test('keeps rendering during setup, then pauses and resumes around export', async ({ page }) => {
        const runningBefore = await page.evaluate(() => window.layersApp._renderer.isRunning)
        expect(runningBefore).toBe(true)

        await page.click('.hf-menubar-trigger:has-text("file")')
        await page.click('#exportVideoMenuItem')
        await expect(page.locator('#exportModal')).toBeVisible()
        expect(await page.evaluate(() => window.layersApp._renderer.isRunning)).toBe(true)

        await beginTinyZipExport(page)
        expect(await page.evaluate(() => ({
            running: window.layersApp._renderer.isRunning,
            lifecycleActive: window.layersApp._projectLifecycleActive,
        }))).toEqual({ running: false, lifecycleActive: true })

        await cancelExport(page)
        expect(await page.evaluate(() => ({
            running: window.layersApp._renderer.isRunning,
            lifecycleActive: window.layersApp._projectLifecycleActive,
        }))).toEqual({ running: true, lifecycleActive: false })
    })

    test('cancelled export leaves an initially paused renderer paused', async ({ page }) => {
        const before = await page.evaluate(() => {
            const app = window.layersApp
            const readCenterPixel = () => {
                const sample = new OffscreenCanvas(1, 1)
                const context = sample.getContext('2d')
                context.drawImage(
                    app._canvas, app._canvas.width / 2, app._canvas.height / 2,
                    1, 1, 0, 0, 1, 1)
                return [...context.getImageData(0, 0, 1, 1).data]
            }
            app._renderer.stop()
            app._renderer._pausedNormalizedTime = 0.6
            app._renderer.render(0.6)
            const render = app._renderer.render.bind(app._renderer)
            window.__pausedExportRenderTimes = []
            app._renderer.render = (normalizedTime) => {
                window.__pausedExportRenderTimes.push(normalizedTime)
                return render(normalizedTime)
            }
            return readCenterPixel()
        })
        await page.click('.hf-menubar-trigger:has-text("file")')
        await page.click('#exportVideoMenuItem')
        await beginTinyZipExport(page)

        expect(await page.evaluate(() => window.layersApp._renderer.isRunning)).toBe(false)
        await cancelExport(page)
        const after = await page.evaluate(() => {
            const app = window.layersApp
            const sample = new OffscreenCanvas(1, 1)
            const context = sample.getContext('2d')
            context.drawImage(
                app._canvas, app._canvas.width / 2, app._canvas.height / 2,
                1, 1, 0, 0, 1, 1)
            return {
                running: app._renderer.isRunning,
                lifecycleActive: app._projectLifecycleActive,
                pixel: [...context.getImageData(0, 0, 1, 1).data],
                restoredRenderTime: window.__pausedExportRenderTimes.at(-1),
            }
        })
        expect(after.running).toBe(false)
        expect(after.lifecycleActive).toBe(false)
        expect(after.pixel).toEqual(before)
        expect(after.restoredRenderTime).toBeCloseTo(0.6, 6)
    })

    test('job polling preserves document resolution and playback during detached capture', async ({ page }) => {
        await page.click('.hf-menubar-trigger:has-text("file")')
        await page.click('#exportVideoMenuItem')
        await page.fill('#exportWidth', '64')
        await page.fill('#exportHeight', '66')
        await page.fill('#exportDuration', '1')
        await page.selectOption('#exportFramerate', '24')
        await page.selectOption('#exportFormat', 'zip')

        const result = await page.evaluate(async () => {
            const app = window.layersApp
            const dialog = app._exportVideoDialog
            const original = {
                canvas: { width: app._canvas.width, height: app._canvas.height },
                isPlaying: app._renderer.isRunning,
            }
            const capture = app._renderer.createFullResolutionCapture.bind(app._renderer)
            let pollPromise = null
            app._renderer.createFullResolutionCapture = options => {
                if (!pollPromise) pollPromise = window.LayersAgent.getJob({
                    jobId: 'missing-video-export-observer',
                })
                return capture(options)
            }
            const exportPromise = dialog.beginExport()
            while (!pollPromise) await new Promise(resolve => setTimeout(resolve, 0))
            const polled = await pollPromise
            await dialog.cancel()
            await exportPromise
            return {
                original,
                polled: { canvas: polled.state.canvas, view: polled.state.view },
            }
        })

        expect(result.polled.canvas).toEqual(result.original.canvas)
        expect(result.polled.view.isPlaying).toBe(result.original.isPlaying)
    })

    test('setup failure restores rendering and releases the lifecycle lease', async ({ page }) => {
        await page.click('.hf-menubar-trigger:has-text("file")')
        await page.click('#exportVideoMenuItem')

        const result = await page.evaluate(async () => {
            const app = window.layersApp
            const dialog = app._exportVideoDialog
            dialog._gatherSettings = () => { throw new Error('video setup failed') }
            let error = null
            try {
                await dialog.beginExport()
            } catch (err) {
                error = err.message
            }
            return {
                error,
                running: app._renderer.isRunning,
                lifecycleActive: app._projectLifecycleActive,
            }
        })

        expect(result).toEqual({
            error: null,
            running: true,
            lifecycleActive: false,
        })
    })

    test('legacy resize setup failure restores the original canvas dimensions', async ({ page }) => {
        await page.click('.hf-menubar-trigger:has-text("file")')
        await page.click('#exportVideoMenuItem')
        await page.fill('#exportWidth', '64')
        await page.fill('#exportHeight', '66')

        const result = await page.evaluate(async () => {
            const app = window.layersApp
            const dialog = app._exportVideoDialog
            const original = { width: app._canvas.width, height: app._canvas.height }
            app._renderer.renderFullResolution = null
            const setResolution = dialog.setResolution
            dialog.setResolution = (width, height) => {
                setResolution(width, height)
                if (width === 64 && height === 66) {
                    throw new Error('video resize setup failed')
                }
            }
            await dialog.beginExport()
            return {
                original,
                canvas: { width: app._canvas.width, height: app._canvas.height },
                running: app._renderer.isRunning,
                lifecycleActive: app._projectLifecycleActive,
                snapshotOverride: app._projectSnapshotCanvasOverride,
            }
        })

        expect(result.canvas).toEqual(result.original)
        expect(result.running).toBe(true)
        expect(result.lifecycleActive).toBe(false)
        expect(result.snapshotOverride).toBeNull()
    })

    test('paused-time capture failure does not restore or restart a renderer that was never paused', async ({ page }) => {
        await page.click('.hf-menubar-trigger:has-text("file")')
        await page.click('#exportVideoMenuItem')

        const result = await page.evaluate(async () => {
            const app = window.layersApp
            const dialog = app._exportVideoDialog
            let stopCalls = 0
            let restoreCalls = 0
            let startCalls = 0
            let exportErrors = 0
            dialog.renderer.getPausedNormalizedTime = () => {
                throw new Error('paused time capture failed')
            }
            dialog.renderer.stop = () => { stopCalls += 1 }
            dialog.renderer.restoreLoopFromNormalizedTime = () => { restoreCalls += 1 }
            dialog.renderer.start = () => { startCalls += 1 }
            dialog._handleExportError = () => { exportErrors += 1 }

            await dialog.beginExport()
            return {
                stopCalls,
                restoreCalls,
                startCalls,
                exportErrors,
                running: app._renderer.isRunning,
                lifecycleActive: app._projectLifecycleActive,
            }
        })

        expect(result).toEqual({
            stopCalls: 0,
            restoreCalls: 0,
            startCalls: 0,
            exportErrors: 1,
            running: true,
            lifecycleActive: false,
        })
    })

    test('renderer restore failure still restarts and releases the lifecycle lease', async ({ page }) => {
        await page.click('.hf-menubar-trigger:has-text("file")')
        await page.click('#exportVideoMenuItem')
        await page.evaluate(() => {
            const app = window.layersApp
            const dialog = app._exportVideoDialog
            dialog.renderer.restoreLoopFromNormalizedTime = () => {
                throw new Error('video restore failed')
            }
            const beginExport = dialog.beginExport.bind(dialog)
            dialog.beginExport = () => {
                const promise = beginExport()
                window.__restoreFailureSettled = promise.then(
                    () => ({ error: null }),
                    err => ({ error: err.message }))
                return promise
            }
        })

        await beginTinyZipExport(page)
        await page.click('#exportProgressCancelBtn')
        const result = await page.evaluate(async () => {
            const outcome = await window.__restoreFailureSettled
            const app = window.layersApp
            return {
                ...outcome,
                running: app._renderer.isRunning,
                lifecycleActive: app._projectLifecycleActive,
            }
        })

        expect(result).toEqual({
            error: null,
            running: true,
            lifecycleActive: false,
        })
    })

    test('successful encoding is not reported complete when renderer restoration fails', async ({ page }) => {
        await page.click('.hf-menubar-trigger:has-text("file")')
        await page.click('#exportVideoMenuItem')

        const result = await page.evaluate(async () => {
            const app = window.layersApp
            const dialog = app._exportVideoDialog
            dialog._elements.widthInput.value = '64'
            dialog._elements.heightInput.value = '64'
            dialog._elements.durationInput.value = '1'
            dialog._elements.framerateSelect.value = '24'
            dialog._elements.formatSelect.value = 'zip'
            dialog.files.saveZip = () => {}
            dialog.files.addZipFrame = () => {}
            dialog.files.endRecordingZip = async () => null

            let allocations = 0
            const OriginalRenderer = app._renderer.constructor
            app._renderer.constructor = class extends OriginalRenderer {
                constructor(...args) { super(...args); allocations++ }
            }
            let completeCalls = 0
            let exportErrors = 0
            dialog.renderer.restoreLoopFromNormalizedTime = () => {
                throw new Error('video restore failed after encoding')
            }
            dialog.onComplete = () => { completeCalls += 1 }
            dialog._handleExportError = () => {
                exportErrors += 1
                dialog.state = 'dialog'
            }

            await dialog.beginExport()
            app._renderer.constructor = OriginalRenderer
            return {
                allocations,
                completeCalls,
                exportErrors,
                state: dialog.state,
                running: app._renderer.isRunning,
                lifecycleActive: app._projectLifecycleActive,
            }
        })

        expect(result).toEqual({
            allocations: 1,
            completeCalls: 0,
            exportErrors: 1,
            state: 'dialog',
            running: true,
            lifecycleActive: false,
        })
    })

    test('post-export UI callback failures do not report a completed export as failed', async ({ page }) => {
        await page.click('.hf-menubar-trigger:has-text("file")')
        await page.click('#exportVideoMenuItem')

        const result = await page.evaluate(async () => {
            const app = window.layersApp
            const dialog = app._exportVideoDialog
            dialog._elements.widthInput.value = '64'
            dialog._elements.heightInput.value = '64'
            dialog._elements.durationInput.value = '1'
            dialog._elements.framerateSelect.value = '24'
            dialog._elements.formatSelect.value = 'zip'
            dialog.files.saveZip = () => {}
            dialog.files.addZipFrame = () => {}
            dialog.files.endRecordingZip = async () => null

            let closeCalls = 0
            let completeCalls = 0
            let exportErrors = 0
            dialog.close = () => {
                closeCalls += 1
                throw new Error('video close failed')
            }
            dialog.onComplete = () => {
                completeCalls += 1
                throw new Error('video completion callback failed')
            }
            dialog._handleExportError = () => { exportErrors += 1 }

            let error = null
            try {
                await dialog.beginExport()
            } catch (err) {
                error = err.message
            }
            return {
                error,
                closeCalls,
                completeCalls,
                exportErrors,
                state: dialog.state,
                running: app._renderer.isRunning,
                lifecycleActive: app._projectLifecycleActive,
            }
        })

        expect(result).toEqual({
            error: null,
            closeCalls: 1,
            completeCalls: 1,
            exportErrors: 0,
            state: 'idle',
            running: true,
            lifecycleActive: false,
        })
    })

    test('a new export after a failed one resets the progress bar to the default gradient', async ({ page }) => {
        await page.click('.hf-menubar-trigger:has-text("file")')
        await page.click('#exportVideoMenuItem')
        // The error path schedules an 800 ms auto-close timer; swallow
        // exactly that timer so slow runs can't close the dialog mid-test.
        await page.evaluate(() => {
            const dialog = window.layersApp._exportVideoDialog
            const realSetTimeout = window.setTimeout
            window.setTimeout = (fn, ms, ...rest) =>
                ms === 800 ? 0 : realSetTimeout(fn, ms, ...rest)
            dialog._handleExportError(new Error('boom'))
            window.setTimeout = realSetTimeout
            // Swallowing the auto-close timer leaves the modal open; close it
            // like the timer would so the reopen below can click the menu.
            dialog.close()
        })

        // Reopen and start a fresh export.
        await page.click('.hf-menubar-trigger:has-text("file")')
        await page.click('#exportVideoMenuItem')
        await beginTinyZipExport(page)

        const after = await page.evaluate(() => {
            const bar = document.getElementById('exportProgressBar')
            const probe = document.createElement('div')
            probe.style.background = 'var(--hf-red)'
            document.body.appendChild(probe)
            const red = getComputedStyle(probe).backgroundColor
            probe.remove()
            return {
                inline: bar.style.background,
                computed: getComputedStyle(bar).backgroundColor,
                image: getComputedStyle(bar).backgroundImage,
                red,
            }
        })
        // The failed run's red inline background is gone: the bar renders its
        // default token gradient again.
        expect(after.inline).toBe('')
        expect(after.computed).not.toBe(after.red)
        expect(after.image).toContain('linear-gradient')

        await cancelExport(page)
    })

})

test.describe('Export Video Dialog error chrome (no project needed)', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('/', { waitUntil: 'networkidle' })
        await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })
        await appReady(page)
    })

    test('export error bar uses the design token, not a hardcoded color', async ({ page }) => {
        await page.click('.hf-menubar-trigger:has-text("file")')
        await page.click('#exportVideoMenuItem')
        await expect(page.locator('#exportModal')).toBeVisible()

        await page.evaluate(() =>
            window.layersApp._exportVideoDialog._handleExportError(new Error('boom')))

        const token = await page.evaluate(() => {
            const probe = document.createElement('div')
            probe.style.background = 'var(--hf-red)'
            document.body.appendChild(probe)
            const color = getComputedStyle(probe).backgroundColor
            probe.remove()
            return color
        })
        expect(token).not.toBe('none')
        // One-shot evaluate: read the bar's inline and computed colors plus a
        // fresh token probe in the same pass. WebKit's persistent test context
        // dies under Playwright's polling assertion machinery here (trace:
        // toHaveCSS completes, then the page dies before the next evaluate).
        const barColors = await page.evaluate(() => {
            const bar = document.getElementById('exportProgressBar')
            const probe = document.createElement('div')
            probe.style.background = 'var(--hf-red)'
            document.body.appendChild(probe)
            const probeColor = getComputedStyle(probe).backgroundColor
            probe.remove()
            return {
                inline: bar.style.background,
                computed: getComputedStyle(bar).backgroundColor,
                probeColor,
            }
        })
        expect(barColors.inline).toContain('var(--hf-red)')
        expect(barColors.computed).toBe(barColors.probeColor)
    })

    test('the error auto-close timer fires and closes the failed run dialog', async ({ page }) => {
        await page.click('.hf-menubar-trigger:has-text("file")')
        await page.click('#exportVideoMenuItem')
        await expect(page.locator('#exportModal')).toBeVisible()

        await page.evaluate(() => {
            const dialog = window.layersApp._exportVideoDialog
            // Mimic the failed-run state: the progress view is showing.
            dialog._elements.progressView.style.display = 'block'
            dialog._handleExportError(new Error('boom'))
        })

        await expect(page.locator('#exportModal')).not.toBeVisible({ timeout: 3000 })
    })

    test('the error auto-close timer cannot close a dialog that left the failed run', async ({ page }) => {
        await page.click('.hf-menubar-trigger:has-text("file")')
        await page.click('#exportVideoMenuItem')
        await expect(page.locator('#exportModal')).toBeVisible()

        await page.evaluate(() => {
            const dialog = window.layersApp._exportVideoDialog
            dialog._handleExportError(new Error('boom'))
            // Simulate the dialog having moved on to a new session while the
            // 800 ms auto-close timer from the failed run is still pending:
            // a reopened dialog hides the progress view.
            dialog._elements.progressView.style.display = 'none'
        })

        await page.waitForTimeout(1000)
        await expect(page.locator('#exportModal')).toBeVisible()
    })
})
