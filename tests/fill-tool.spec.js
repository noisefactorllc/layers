// tests/fill-tool.spec.js
import { test, expect } from 'playwright/test'

test.describe('Fill tool', () => {
    test('clicking on canvas creates a filled raster layer', async ({ page }) => {
        await page.goto('/', { waitUntil: 'networkidle' })
        await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })

        // Create a solid color project
        await page.waitForSelector('.open-dialog-backdrop.visible')
        await page.click('.media-option[data-type="solid"]')
        await page.click('.action-btn.primary')
        await page.waitForSelector('.open-dialog-backdrop.visible', { state: 'hidden', timeout: 5000 })
        await page.waitForTimeout(500)

        const initialLayerCount = await page.evaluate(() =>
            window.layersApp._layers.length
        )

        // Activate fill tool
        await page.click('#fillToolBtn')

        // Click on the canvas
        const overlay = await page.$('#selectionOverlay')
        const box = await overlay.boundingBox()
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
        await page.waitForTimeout(500)

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

    test('blocked online fill leaves layers, dirty state, and undo history unchanged', async ({ page }) => {
        await page.goto('/', { waitUntil: 'networkidle' })
        await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })

        await page.waitForSelector('.open-dialog-backdrop.visible')
        await page.click('.media-option[data-type="solid"]')
        await page.click('.action-btn.primary')
        await page.waitForSelector('.open-dialog-backdrop.visible', { state: 'hidden', timeout: 5000 })

        const before = await page.evaluate(() => {
            const app = window.layersApp
            app._markClean()
            app._onlineAdapter = {
                isOnline: () => true,
                schedulePublish: () => {},
            }
            app._undoDebounceTimer = setTimeout(() => app._pushUndoState(), 60_000)
            return {
                layerIds: app._layers.map(layer => layer.id),
                dirty: app._isDirty,
                mutationRevision: app._projectMutationRevision,
                undoStackLength: app._undoManager._stack.length,
                undoIndex: app._undoManager._index,
                pendingUndo: Boolean(app._undoDebounceTimer),
            }
        })

        await page.click('#fillToolBtn')
        const overlay = await page.$('#selectionOverlay')
        const box = await overlay.boundingBox()
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
        await page.waitForTimeout(500)

        const after = await page.evaluate(() => {
            const app = window.layersApp
            return {
                layerIds: app._layers.map(layer => layer.id),
                dirty: app._isDirty,
                mutationRevision: app._projectMutationRevision,
                undoStackLength: app._undoManager._stack.length,
                undoIndex: app._undoManager._index,
                pendingUndo: Boolean(app._undoDebounceTimer),
            }
        })

        expect(before.dirty).toBe(false)
        expect(after).toEqual(before)
    })

    test('reports a failed fill-layer commit outcome', async ({ page }) => {
        await page.goto('/', { waitUntil: 'networkidle' })
        await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })
        await page.waitForSelector('.open-dialog-backdrop.visible')
        await page.click('.media-option[data-type="solid"]')
        await page.click('.action-btn.primary')
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
        await page.waitForTimeout(100)

        const errors = await page.evaluate(() => {
            console.error = window.__fillOriginalConsoleError
            return window.__fillCommitErrors
        })
        expect(errors.some(message => message.includes(
            '[FillTool] Failed to add fill layer: Error: injected fill commit failure')))
            .toBe(true)
    })
})
