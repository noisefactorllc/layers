import { test, expect } from 'playwright/test'

test.describe('Image menu - Crop to Selection', () => {
    test('crop to selection resizes canvas to selection bounds', async ({ page }) => {
        await page.goto('/', { waitUntil: 'networkidle' })
        await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })

        // Create a solid base layer (1024x1024)
        await page.waitForSelector('.open-dialog-backdrop.visible')
        await page.click('.media-option[data-type="solid"]')
        await page.waitForSelector('.canvas-size-dialog', { timeout: 5000 })
        await page.click('.canvas-size-dialog .action-btn.primary')
        await page.waitForSelector('.open-dialog-backdrop.visible', { state: 'hidden', timeout: 5000 })
        await page.waitForTimeout(500)

        // Programmatically set a rectangular selection (100,100 to 612,612 = 512x512)
        await page.evaluate(() => {
            window.layersApp._selectionManager._selectionPath = {
                type: 'rect', x: 100, y: 100, width: 512, height: 512
            }
            window.layersApp._selectionManager._drawMarchingAnts()
        })
        await page.waitForTimeout(200)

        // Crop to selection
        await page.evaluate(async () => {
            await window.layersApp._cropToSelection()
        })
        await page.waitForTimeout(500)

        // Verify canvas is now 512x512
        const dims = await page.evaluate(() => ({
            w: window.layersApp._canvas.width,
            h: window.layersApp._canvas.height
        }))
        expect(dims.w).toBe(512)
        expect(dims.h).toBe(512)

        // Verify selection was cleared
        const hasSelection = await page.evaluate(() =>
            window.layersApp._selectionManager.hasSelection()
        )
        expect(hasSelection).toBe(false)
    })

    test('crop preserves a media layer composite without applying its semantics twice', async ({ page }) => {
        await page.goto('/', { waitUntil: 'networkidle' })
        await page.locator('#loading-screen').waitFor({ state: 'hidden' })

        const result = await page.evaluate(async () => {
            const app = window.layersApp
            const source = document.createElement('canvas')
            source.width = 100
            source.height = 100
            const sourceContext = source.getContext('2d')
            sourceContext.fillStyle = '#ff0000'
            sourceContext.fillRect(0, 0, 100, 100)
            const blob = await new Promise(resolve => source.toBlob(resolve, 'image/png'))
            const file = new File([blob], 'crop-source.png', { type: 'image/png' })
            await app._handleOpenMedia(file, 'image')

            const layer = app._layers[0]
            const child = await window.LayersAgent.addChildEffect({
                layerId: layer.id,
                effectId: 'filter/blur',
            })
            if (!child.ok) throw new Error(child.error.message)
            layer.opacity = 50
            layer.scaleX = 0.8
            layer.scaleY = 0.8
            layer.offsetX = 4
            layer.offsetY = -3
            const mask = new ImageData(100, 100)
            for (let y = 0; y < 100; y++) {
                for (let x = 0; x < 65; x++) {
                    const offset = (y * 100 + x) * 4
                    mask.data[offset] = 255
                    mask.data[offset + 1] = 255
                    mask.data[offset + 2] = 255
                    mask.data[offset + 3] = 255
                }
            }
            layer.mask = mask
            layer.maskEnabled = true
            app._renderer.uploadMaskTexture(layer.id, mask)
            await app._rebuild({ force: true })
            app._renderCurrentFrame()

            const readSamples = (points) => {
                const canvas = new OffscreenCanvas(app._canvas.width, app._canvas.height)
                const context = canvas.getContext('2d')
                context.drawImage(app._canvas, 0, 0)
                return points.map(([x, y]) => [...context.getImageData(x, y, 1, 1).data])
            }
            const crop = { type: 'rect', x: 10, y: 10, width: 70, height: 70 }
            const points = [[15, 20], [40, 40], [60, 50]]
            const before = readSamples(points.map(([x, y]) => [x + crop.x, y + crop.y]))
            app._selectionManager.setSelection(crop)
            const outcome = await app._cropToSelection()
            app._renderCurrentFrame()
            const after = readSamples(points)
            const cropped = app._layers[0]
            return {
                status: outcome.status,
                before,
                after,
                opacity: cropped.opacity,
                blendMode: cropped.blendMode,
                scaleX: cropped.scaleX,
                scaleY: cropped.scaleY,
                offsetX: cropped.offsetX,
                offsetY: cropped.offsetY,
                childCount: cropped.children.length,
                hasMask: Boolean(cropped.mask),
            }
        })

        expect(result.status).toBe('committed')
        for (let sample = 0; sample < result.before.length; sample++) {
            for (let channel = 0; channel < 4; channel++) {
                expect(Math.abs(result.after[sample][channel] - result.before[sample][channel]))
                    .toBeLessThanOrEqual(3)
            }
        }
        expect(result).toMatchObject({
            opacity: 50,
            blendMode: 'mix',
            scaleX: 1,
            scaleY: 1,
            offsetX: 0,
            offsetY: 0,
            childCount: 0,
            hasMask: false,
        })
    })

    test('crop preserves the canvas position of an unbaked video layer', async ({ page }) => {
        await page.goto('/', { waitUntil: 'networkidle' })
        await page.locator('#loading-screen').waitFor({ state: 'hidden' })

        const result = await page.evaluate(async () => {
            const app = window.layersApp
            await app._handleCreateTransparentBase(100, 100)

            const source = document.createElement('canvas')
            source.width = 20
            source.height = 20
            const sourceContext = source.getContext('2d')
            sourceContext.fillStyle = '#ff0000'
            sourceContext.fillRect(0, 0, 20, 20)
            const added = await app._addMediaLayerFromCanvas(source, 'Video crop position')
            if (added.status === 'failed') throw added.error
            const layer = app._layers.find(candidate => candidate.id === added.layerId)
            layer.mediaType = 'video'
            layer.offsetX = 10
            layer.offsetY = 0
            await app._rebuild({ force: true })

            app._selectionManager.setSelection({
                type: 'rect', x: 25, y: 25, width: 50, height: 50,
            })
            const outcome = await app._cropToSelection()
            app._renderCurrentFrame()
            const croppedLayer = app._layers.find(candidate => candidate.id === layer.id)

            const sample = document.createElement('canvas')
            sample.width = 1
            sample.height = 1
            const context = sample.getContext('2d')
            context.drawImage(app._canvas, 30, 25, 1, 1, 0, 0, 1, 1)
            return {
                status: outcome.status,
                offsetX: croppedLayer.offsetX,
                offsetY: croppedLayer.offsetY,
                pixel: [...context.getImageData(0, 0, 1, 1).data],
            }
        })

        expect(result.status).toBe('committed')
        expect(result.offsetX).toBe(10)
        expect(result.offsetY).toBe(0)
        expect(result.pixel[0]).toBeGreaterThan(240)
        expect(result.pixel[3]).toBeGreaterThan(240)
    })

    test('crop bakes drawing pixels into stable media that survives reload', async ({ page }) => {
        await page.goto('/', { waitUntil: 'networkidle' })
        await page.locator('#loading-screen').waitFor({ state: 'hidden' })
        const backdrop = page.locator('.open-dialog-backdrop.visible')
        await backdrop.waitFor()

        const result = await page.evaluate(async () => {
            const app = window.layersApp
            await app._handleCreateTransparentBase(100, 100)
            const { createDrawingLayer } = await import('/js/layers/layer-model.js')
            const { createPathStroke } = await import('/js/drawing/stroke-model.js')
            const drawing = createDrawingLayer('Crop drawing')
            drawing.strokes.push(createPathStroke({
                color: '#ff0000',
                size: 10,
                points: [{ x: 45, y: 50 }, { x: 55, y: 50 }],
            }))
            app._layers.push(drawing)
            await app._rasterizeDrawingLayer(drawing)
            await app._rebuild({ force: true })
            app._updateLayerStack()
            app._layerStack.selectedLayerId = drawing.id
            app._selectionManager.setSelection({
                type: 'rect', x: 25, y: 25, width: 50, height: 50,
            })
            const outcome = await app._cropToSelection()
            app._renderCurrentFrame()

            const readPixel = () => {
                const sample = new OffscreenCanvas(1, 1)
                const context = sample.getContext('2d')
                context.drawImage(app._canvas, 25, 25, 1, 1, 0, 0, 1, 1)
                return [...context.getImageData(0, 0, 1, 1).data]
            }
            const afterCrop = readPixel()
            const baked = app._layers.find(layer => layer.id === drawing.id)
            const saved = await window.LayersAgent.saveProjectAs({ name: 'crop-drawing' })
            if (!saved.ok) throw new Error(saved.error.message)
            const opened = await window.LayersAgent.openProject({
                projectId: saved.result.projectId,
            })
            if (!opened.ok) throw new Error(opened.error.message)
            app._renderCurrentFrame()
            return {
                status: outcome.status,
                sourceType: baked.sourceType,
                hasStrokes: Object.hasOwn(baked, 'strokes'),
                resourceSize: [
                    app._renderer.getMediaInfo(drawing.id)?.width,
                    app._renderer.getMediaInfo(drawing.id)?.height,
                ],
                afterCrop,
                afterReload: readPixel(),
            }
        })

        expect(result.status).toBe('committed')
        expect(result.sourceType).toBe('media')
        expect(result.hasStrokes).toBe(false)
        expect(result.resourceSize).toEqual([50, 50])
        expect(result.afterCrop[0]).toBeGreaterThan(240)
        expect(result.afterCrop[3]).toBeGreaterThan(240)
        expect(result.afterReload[0]).toBeGreaterThan(240)
        expect(result.afterReload[3]).toBeGreaterThan(240)
    })
})
