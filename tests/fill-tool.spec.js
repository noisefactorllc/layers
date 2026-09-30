// tests/fill-tool.spec.js
import { test, expect } from './fixtures.js'
import { appReady, appState } from './waits.js'
import { reopenNewProjectDialog } from './helpers/new-project.js'

test.describe('Fill tool', () => {
    test('clicking on canvas creates a filled raster layer', async ({ page }) => {
        await page.goto('/', { waitUntil: 'networkidle' })
        await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })

        // Create a solid color project
        await reopenNewProjectDialog(page)
        await page.click('.media-option[data-type="solid"]')
        await page.click('.canvas-size-dialog .action-btn.primary')
        await page.waitForSelector('.open-dialog-backdrop.visible', { state: 'hidden', timeout: 5000 })
        await appReady(page)

        const initialLayerCount = await page.evaluate(() =>
            window.layersApp._layers.length
        )

        // Activate fill tool
        await page.click('#fillToolBtn')

        // Click on the canvas
        const overlay = await page.$('#selectionOverlay')
        const box = await overlay.boundingBox()
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
        await appState(page, (initial) => window.layersApp._layers.length > initial,
            initialLayerCount)

        const result = await page.evaluate((initial) => {
            const app = window.layersApp
            return {
                layerCount: app._layers.length,
                newLayerCreated: app._layers.length > initial,
                newLayerType: app._layers[app._layers.length - 1]?.sourceType
            }
        }, initialLayerCount)

        expect(result.newLayerCreated).toBe(true)
        expect(result.newLayerType).toBe('media')
    })

    test('an online fill commits a shareable image layer instead of being blocked', async ({ page }) => {
        await page.goto('/', { waitUntil: 'networkidle' })
        await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })

        await reopenNewProjectDialog(page)
        await page.click('.media-option[data-type="solid"]')
        await page.click('.canvas-size-dialog .action-btn.primary')
        await page.waitForSelector('.open-dialog-backdrop.visible', { state: 'hidden', timeout: 5000 })

        // Since images are preserved across Seance sessions, a fill while
        // online is a shareable image layer (like flatten/duplicate/rasterize
        // in agent-layer-crud), not a blocked mutation.
        await page.evaluate(() => {
            const app = window.layersApp
            app._markClean()
            window.__fillPublishCalls = []
            app._onlineAdapter = {
                isOnline: () => true,
                schedulePublish: () => window.__fillPublishCalls.push(1),
            }
        })

        const countBefore = await page.evaluate(() => window.layersApp._layers.length)

        await page.click('#fillToolBtn')
        const overlay = await page.$('#selectionOverlay')
        const box = await overlay.boundingBox()
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
        await appState(page, (initial) => window.layersApp._layers.length > initial, countBefore)

        const after = await page.evaluate(() => {
            const app = window.layersApp
            const added = app._layers[app._layers.length - 1]
            return {
                count: app._layers.length,
                sourceType: added?.sourceType,
                mediaType: added?.mediaType,
                hasResource: app._renderer._mediaTextures.has(added?.id),
                warningToast: Boolean(document.querySelector('.toast.toast-warning')),
                publishes: window.__fillPublishCalls.length,
            }
        })

        expect(after.count).toBeGreaterThan(1)
        expect(after.sourceType).toBe('media')
        expect(after.mediaType).toBe('image')
        expect(after.hasResource).toBe(true)
        expect(after.warningToast).toBe(false)
        expect(after.publishes).toBeGreaterThan(0)
    })

    test('reports a failed fill-layer commit outcome', async ({ page }) => {
        await page.goto('/', { waitUntil: 'networkidle' })
        await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })
        await reopenNewProjectDialog(page)
        await page.click('.media-option[data-type="solid"]')
        await page.click('.canvas-size-dialog .action-btn.primary')
        await page.waitForSelector(
            '.open-dialog-backdrop.visible', { state: 'hidden', timeout: 5000 })
        await page.click('#fillToolBtn')

        await page.evaluate(() => {
            const app = window.layersApp
            window.__fillCommitErrors = []
            window.__fillOriginalConsoleError = console.error
            console.error = (...args) => {
                window.__fillCommitErrors.push(args.map(String).join(' '))
            }
            app._fillTool._addMediaLayerFromCanvas = async () => ({
                status: 'failed',
                error: new Error('injected fill commit failure'),
            })
        })

        const overlay = await page.$('#selectionOverlay')
        const box = await overlay.boundingBox()
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
        await appState(page, () => window.__fillCommitErrors.length > 0)

        const errors = await page.evaluate(() => {
            console.error = window.__fillOriginalConsoleError
            return window.__fillCommitErrors
        })
        expect(errors.some(message => message.includes(
            '[FillTool] Failed to add fill layer: Error: injected fill commit failure')))
            .toBe(true)
    })
})
