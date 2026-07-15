import { test, expect } from 'playwright/test'

test.describe('Image menu - Image Size', () => {
    test('resize image scales canvas and layers', async ({ page }) => {
        await page.goto('/', { waitUntil: 'networkidle' })
        await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })

        // Create a solid base layer (1024x1024)
        await page.waitForSelector('.open-dialog-backdrop.visible')
        await page.click('.media-option[data-type="solid"]')
        await page.waitForSelector('.canvas-size-dialog', { timeout: 5000 })
        await page.click('.canvas-size-dialog .action-btn.primary')
        await page.waitForSelector('.open-dialog-backdrop.visible', { state: 'hidden', timeout: 5000 })
        await page.waitForTimeout(500)

        // Resize to 512x512 via direct method
        await page.evaluate(async () => {
            await window.layersApp._resizeImage(512, 512)
        })
        await page.waitForTimeout(500)

        // Verify canvas is 512x512
        const dims = await page.evaluate(() => ({
            w: window.layersApp._canvas.width,
            h: window.layersApp._canvas.height
        }))
        expect(dims.w).toBe(512)
        expect(dims.h).toBe(512)
    })

    test('resize scales drawing geometry and keeps later rerasterization and reload stable', async ({ page }) => {
        await page.goto('/', { waitUntil: 'networkidle' })
        await page.locator('#loading-screen').waitFor({ state: 'hidden' })
        const backdrop = page.locator('.open-dialog-backdrop.visible')
        await backdrop.waitFor()
        await page.locator('.media-option[data-type="transparent"]').click()
        await page.locator('.canvas-size-dialog .action-btn.primary').click()
        await backdrop.waitFor({ state: 'hidden' })

        const result = await page.evaluate(async () => {
            const app = window.layersApp
            const { createDrawingLayer } = await import('/js/layers/layer-model.js')
            const { createPathStroke } = await import('/js/drawing/stroke-model.js')
            const drawing = createDrawingLayer('Scaled drawing')
            drawing.strokes.push(createPathStroke({
                color: '#ff0000',
                size: 40,
                points: [{ x: 200, y: 200 }, { x: 400, y: 200 }],
            }))
            app._layers.push(drawing)
            await app._rasterizeDrawingLayer(drawing)
            await app._rebuild({ force: true })
            app._updateLayerStack()

            const originalResource = app._renderer.getMediaInfo(drawing.id)
            await app._resizeImage(512, 512)
            const resized = app._layers.find(layer => layer.id === drawing.id)
            const resizedResource = app._renderer.getMediaInfo(drawing.id)
            resized.strokes.push(createPathStroke({
                color: '#0000ff',
                size: 10,
                points: [{ x: 450, y: 450 }, { x: 500, y: 500 }],
            }))
            await app._rasterizeDrawingLayer(resized)
            await app._rebuild({ force: true })
            app._renderCurrentFrame()

            const readPixel = (x, y) => {
                const canvas = new OffscreenCanvas(app._canvas.width, app._canvas.height)
                const context = canvas.getContext('2d')
                context.drawImage(app._canvas, 0, 0)
                return [...context.getImageData(x, y, 1, 1).data]
            }
            const afterMutation = readPixel(150, 100)
            const saved = await window.LayersAgent.saveProjectAs({ name: 'scaled-drawing' })
            if (!saved.ok) throw new Error(saved.error.message)
            const opened = await window.LayersAgent.openProject({
                projectId: saved.result.projectId,
            })
            if (!opened.ok) throw new Error(opened.error.message)
            app._renderCurrentFrame()
            const loaded = app._layers.find(layer => layer.id === drawing.id)
            return {
                stroke: loaded.strokes[0],
                resourceReplaced: resizedResource !== originalResource,
                resourceSize: [resizedResource.width, resizedResource.height],
                afterMutation,
                afterReload: readPixel(150, 100),
            }
        })

        expect(result.stroke).toMatchObject({
            size: 20,
            points: [{ x: 100, y: 100 }, { x: 200, y: 100 }],
        })
        expect(result.resourceReplaced).toBe(true)
        expect(result.resourceSize).toEqual([512, 512])
        expect(result.afterMutation[0]).toBeGreaterThan(200)
        expect(result.afterMutation[3]).toBeGreaterThan(200)
        expect(result.afterReload[0]).toBeGreaterThan(200)
        expect(result.afterReload[3]).toBeGreaterThan(200)
    })

    test('resize clamps a nonempty tiny media layer to one pixel', async ({ page }) => {
        await page.goto('/', { waitUntil: 'networkidle' })
        await page.locator('#loading-screen').waitFor({ state: 'hidden' })

        const result = await page.evaluate(async () => {
            const app = window.layersApp
            await app._handleCreateTransparentBase(100, 100)
            const source = document.createElement('canvas')
            source.width = 1
            source.height = 1
            source.getContext('2d').fillRect(0, 0, 1, 1)
            const blob = await new Promise(resolve => source.toBlob(resolve, 'image/png'))
            const file = new File([blob], 'one-pixel.png', { type: 'image/png' })
            const added = await app._handleAddMediaLayer(file, 'image')
            const outcome = await app._resizeImage(1, 1)
            const resource = app._renderer.getMediaInfo(added.layerId)
            return {
                status: outcome.status,
                canvas: [app._canvas.width, app._canvas.height],
                resource: resource ? [resource.width, resource.height] : null,
            }
        })

        expect(result).toEqual({
            status: 'committed',
            canvas: [1, 1],
            resource: [1, 1],
        })
    })
})
