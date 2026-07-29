import { test, expect } from 'playwright/test'

test.describe('Export Image Dialog', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('/', { waitUntil: 'networkidle' })
        await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })

        // Create a solid base layer
        await page.waitForSelector('.open-dialog-backdrop.visible')
        await page.click('.media-option[data-type="solid"]')
        await page.waitForSelector('.canvas-size-dialog', { timeout: 5000 })
        await page.click('.canvas-size-dialog .action-btn.primary')
        await page.waitForSelector('.open-dialog-backdrop.visible', { state: 'hidden', timeout: 5000 })
        await page.waitForTimeout(500)
    })

    test('opens via menu and shows current canvas dimensions', async ({ page }) => {
        // Open File menu
        await page.click('.hf-menubar-trigger:has-text("file")')
        await page.click('#exportImageMenuItem')

        // Dialog should be visible
        const dialog = page.locator('#exportImageModal')
        await expect(dialog).toBeVisible()

        // Width/height should match canvas (1024x1024 default)
        const width = await page.locator('#exportImageWidth').inputValue()
        const height = await page.locator('#exportImageHeight').inputValue()
        expect(width).toBe('1024')
        expect(height).toBe('1024')
    })

    test('closes on cancel button', async ({ page }) => {
        await page.click('.hf-menubar-trigger:has-text("file")')
        await page.click('#exportImageMenuItem')

        await expect(page.locator('#exportImageModal')).toBeVisible()

        await page.click('#exportImageCancelBtn')
        await expect(page.locator('#exportImageModal')).not.toBeVisible()
    })

    test('closes on Escape key', async ({ page }) => {
        await page.click('.hf-menubar-trigger:has-text("file")')
        await page.click('#exportImageMenuItem')

        await expect(page.locator('#exportImageModal')).toBeVisible()

        await page.keyboard.press('Escape')
        await expect(page.locator('#exportImageModal')).not.toBeVisible()
    })

    test('hides quality for PNG, shows for JPEG', async ({ page }) => {
        await page.click('.hf-menubar-trigger:has-text("file")')
        await page.click('#exportImageMenuItem')

        // PNG is default — quality should be hidden
        const qualityGroup = page.locator('#exportImageQualityGroup')
        await expect(qualityGroup).toBeHidden()

        // Switch to JPEG
        await page.selectOption('#exportImageFormat', 'jpg')
        await expect(qualityGroup).toBeVisible()

        // Switch back to PNG
        await page.selectOption('#exportImageFormat', 'png')
        await expect(qualityGroup).toBeHidden()
    })

    test('invalid dimensions are rejected before acquiring a mutation lease', async ({ page }) => {
        await page.click('.hf-menubar-trigger:has-text("file")')
        await page.click('#exportImageMenuItem')

        const result = await page.evaluate(async () => {
            const app = window.layersApp
            const dialog = app._exportImageDialog
            let acquisitions = 0
            dialog.acquireMutation = () => {
                acquisitions += 1
                return null
            }
            const cases = [
                { width: '8193', height: '64' },
                { width: '-1', height: '64' },
                { width: '64.5', height: '64' },
            ]
            for (const values of cases) {
                dialog._elements.widthInput.value = values.width
                dialog._elements.heightInput.value = values.height
                await dialog._export()
            }
            return {
                acquisitions,
                state: dialog.state,
                size: [app._canvas.width, app._canvas.height],
                lifecycleActive: app._projectLifecycleActive,
            }
        })

        expect(result).toEqual({
            acquisitions: 0,
            state: 'dialog',
            size: [1024, 1024],
            lifecycleActive: false,
        })
    })

    test('setup failure releases the project lifecycle lease', async ({ page }) => {
        await page.click('.hf-menubar-trigger:has-text("file")')
        await page.click('#exportImageMenuItem')

        const result = await page.evaluate(async () => {
            const app = window.layersApp
            const dialog = app._exportImageDialog
            dialog._gatherSettings = () => { throw new Error('image setup failed') }
            let error = null
            try {
                await dialog._export()
            } catch (err) {
                error = err.message
            }
            return {
                error,
                state: dialog.state,
                lifecycleActive: app._projectLifecycleActive,
            }
        })

        expect(result).toEqual({
            error: null,
            state: 'dialog',
            lifecycleActive: false,
        })
    })

    test('resolution restore failure releases the project lifecycle lease', async ({ page }) => {
        await page.click('.hf-menubar-trigger:has-text("file")')
        await page.click('#exportImageMenuItem')
        await page.fill('#exportImageWidth', '64')
        await page.fill('#exportImageHeight', '64')

        const result = await page.evaluate(async () => {
            const app = window.layersApp
            const dialog = app._exportImageDialog
            const original = { ...dialog.originalResolution }
            const setResolution = dialog.setResolution
            let resized = false
            dialog.files.saveImage = () => {}
            dialog.setResolution = (width, height) => {
                setResolution(width, height)
                if (resized && width === original.width && height === original.height) {
                    throw new Error('image restore failed')
                }
                resized = true
            }
            let error = null
            try {
                await dialog._export()
            } catch (err) {
                error = err.message
            }
            return {
                error,
                state: dialog.state,
                width: app._canvas.width,
                height: app._canvas.height,
                lifecycleActive: app._projectLifecycleActive,
            }
        })

        expect(result).toEqual({
            error: null,
            state: 'dialog',
            width: 1024,
            height: 1024,
            lifecycleActive: false,
        })
    })

    test('exports the requested size after the canvas changes while the dialog is open', async ({ page }) => {
        await page.click('.hf-menubar-trigger:has-text("file")')
        await page.click('#exportImageMenuItem')

        const result = await page.evaluate(async () => {
            const app = window.layersApp
            const dialog = app._exportImageDialog
            app._resizeCanvas(800, 600)
            let savedSize = null
            dialog.files.saveImage = canvas => {
                savedSize = [canvas.width, canvas.height]
            }
            await dialog._export()
            return {
                savedSize,
                finalSize: [app._canvas.width, app._canvas.height],
                lifecycleActive: app._projectLifecycleActive,
            }
        })

        expect(result).toEqual({
            savedSize: [1024, 1024],
            finalSize: [800, 600],
            lifecycleActive: false,
        })
    })

    test('temporary export resize restores the begin-time canvas size', async ({ page }) => {
        await page.click('.hf-menubar-trigger:has-text("file")')
        await page.click('#exportImageMenuItem')
        await page.fill('#exportImageWidth', '64')
        await page.fill('#exportImageHeight', '64')

        const result = await page.evaluate(async () => {
            const app = window.layersApp
            const dialog = app._exportImageDialog
            app._resizeCanvas(800, 600)
            let savedSize = null
            dialog.files.saveImage = canvas => {
                savedSize = [canvas.width, canvas.height]
            }
            await dialog._export()
            return {
                savedSize,
                finalSize: [app._canvas.width, app._canvas.height],
                lifecycleActive: app._projectLifecycleActive,
            }
        })

        expect(result).toEqual({
            savedSize: [64, 64],
            finalSize: [800, 600],
            lifecycleActive: false,
        })
    })

    test('temporary export resize rerenders the restored canvas while paused', async ({ page }) => {
        await page.click('.hf-menubar-trigger:has-text("file")')
        await page.click('#exportImageMenuItem')
        await page.fill('#exportImageWidth', '64')
        await page.fill('#exportImageHeight', '64')

        const result = await page.evaluate(async () => {
            const app = window.layersApp
            const dialog = app._exportImageDialog
            const readPixel = (canvas) => {
                const sample = new OffscreenCanvas(1, 1)
                const context = sample.getContext('2d')
                context.drawImage(
                    canvas, canvas.width / 2, canvas.height / 2, 1, 1,
                    0, 0, 1, 1)
                return [...context.getImageData(0, 0, 1, 1).data]
            }
            app._renderer.stop()
            app._renderCurrentFrame()
            const before = readPixel(app._canvas)
            let exported = null
            dialog.files.saveImage = canvas => { exported = readPixel(canvas) }
            await dialog._export()
            return {
                before,
                exported,
                after: readPixel(app._canvas),
                rendererRunning: app._renderer.isRunning,
            }
        })

        expect(result.exported).toEqual(result.before)
        expect(result.after).toEqual(result.before)
        expect(result.rendererRunning).toBe(false)
    })

    test('job polling hides the temporary image export resolution', async ({ page }) => {
        await page.click('.hf-menubar-trigger:has-text("file")')
        await page.click('#exportImageMenuItem')
        await page.fill('#exportImageWidth', '64')
        await page.fill('#exportImageHeight', '66')

        const result = await page.evaluate(async () => {
            const app = window.layersApp
            const dialog = app._exportImageDialog
            const original = {
                canvas: { width: app._canvas.width, height: app._canvas.height },
                isPlaying: app._renderer.isRunning,
            }
            const setResolution = dialog.setResolution
            let pollPromise = null
            dialog.setResolution = (width, height) => {
                setResolution(width, height)
                if (width === 64 && height === 66) {
                    pollPromise = window.LayersAgent.getJob({
                        jobId: 'missing-image-export-observer',
                    })
                }
            }
            dialog.files.saveImage = () => {}
            await dialog._export()
            const polled = await pollPromise
            return {
                original,
                polled: { canvas: polled.state.canvas, view: polled.state.view },
            }
        })

        expect(result.polled.canvas).toEqual(result.original.canvas)
        expect(result.polled.view.isPlaying).toBe(result.original.isPlaying)
    })

    test('preserves accepted odd image dimensions exactly', async ({ page }) => {
        await page.click('.hf-menubar-trigger:has-text("file")')
        await page.click('#exportImageMenuItem')
        await page.fill('#exportImageWidth', '65')
        await page.fill('#exportImageHeight', '67')

        const result = await page.evaluate(async () => {
            const app = window.layersApp
            const dialog = app._exportImageDialog
            let savedSize = null
            dialog.files.saveImage = canvas => {
                savedSize = [canvas.width, canvas.height]
            }
            await dialog._export()
            return {
                savedSize,
                finalSize: [app._canvas.width, app._canvas.height],
                lifecycleActive: app._projectLifecycleActive,
            }
        })

        expect(result).toEqual({
            savedSize: [65, 67],
            finalSize: [1024, 1024],
            lifecycleActive: false,
        })
    })

    test('post-save UI callback failures do not report a completed export as failed', async ({ page }) => {
        await page.click('.hf-menubar-trigger:has-text("file")')
        await page.click('#exportImageMenuItem')

        const result = await page.evaluate(async () => {
            const app = window.layersApp
            const dialog = app._exportImageDialog
            let saved = 0
            let closeCalls = 0
            let completeCalls = 0
            dialog.files.saveImage = () => { saved += 1 }
            dialog.close = () => {
                closeCalls += 1
                throw new Error('image close failed')
            }
            dialog.onComplete = () => {
                completeCalls += 1
                throw new Error('image completion callback failed')
            }

            let error = null
            try {
                await dialog._export()
            } catch (err) {
                error = err.message
            }
            return {
                error,
                saved,
                closeCalls,
                completeCalls,
                state: dialog.state,
                lifecycleActive: app._projectLifecycleActive,
            }
        })

        expect(result).toEqual({
            error: null,
            saved: 1,
            closeCalls: 1,
            completeCalls: 1,
            state: 'idle',
            lifecycleActive: false,
        })
    })
})
