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

    test('online fill creates an undoable image layer and schedules publication', async ({ page }) => {
        await page.goto('/', { waitUntil: 'networkidle' })
        await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })

        await reopenNewProjectDialog(page)
        await page.click('.media-option[data-type="solid"]')
        await page.click('.canvas-size-dialog .action-btn.primary')
        await page.waitForSelector('.open-dialog-backdrop.visible', { state: 'hidden', timeout: 5000 })
        await appReady(page)

        const before = await page.evaluate(() => {
            const app = window.layersApp
            app._markClean()
            window.__fillPublishes = 0
            app._onlineAdapter = {
                isOnline: () => true,
                schedulePublish: () => { window.__fillPublishes++ },
            }
            app._fillTool.color = '#e33b7a'
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
        await appState(page, initial => window.layersApp._layers.length === initial + 1
            && !window.layersApp._projectLifecycleOwner, before.layerIds.length)

        const after = await page.evaluate(() => {
            const app = window.layersApp
            const layer = app._layers.at(-1)
            const media = app._renderer.getMediaInfo(layer.id)
            return {
                layerIds: app._layers.map(layer => layer.id),
                dirty: app._isDirty,
                mutationRevision: app._projectMutationRevision,
                undoStackLength: app._undoManager._stack.length,
                undoIndex: app._undoManager._index,
                pendingUndo: Boolean(app._undoDebounceTimer),
                sourceType: layer.sourceType,
                mediaType: layer.mediaType,
                resourceType: media.type,
                hasResource: app._renderer._mediaTextures.has(layer.id),
                warningToast: Boolean(document.querySelector('.toast.toast-warning')),
                pixel: [...media.element.getContext('2d').getImageData(0, 0, 1, 1).data],
                publishes: window.__fillPublishes,
            }
        })

        expect(before.dirty).toBe(false)
        expect(before.pendingUndo).toBe(true)
        expect(after.layerIds.slice(0, -1)).toEqual(before.layerIds)
        expect(after.dirty).toBe(true)
        expect(after.mutationRevision).toBeGreaterThan(before.mutationRevision)
        expect(after.undoStackLength).toBe(before.undoStackLength + 1)
        expect(after.undoIndex).toBe(before.undoIndex + 1)
        expect(after.pendingUndo).toBe(false)
        expect(after.sourceType).toBe('media')
        expect(after.mediaType).toBe('image')
        expect(after.resourceType).toBe('image')
        expect(after.hasResource).toBe(true)
        expect(after.warningToast).toBe(false)
        expect(after.pixel).toEqual([227, 59, 122, 255])
        expect(after.publishes).toBeGreaterThan(0)

        const restored = await page.evaluate(async () => {
            const app = window.layersApp
            await app._undo()
            const undoLayerIds = app._layers.map(layer => layer.id)
            await app._redo()
            const media = app._renderer.getMediaInfo(app._layers.at(-1).id)
            return {
                undoLayerIds,
                redoLayerIds: app._layers.map(layer => layer.id),
                pixel: [...media.element.getContext('2d').getImageData(0, 0, 1, 1).data],
            }
        })
        expect(restored.undoLayerIds).toEqual(before.layerIds)
        expect(restored.redoLayerIds).toEqual(after.layerIds)
        expect(restored.pixel).toEqual(after.pixel)
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
