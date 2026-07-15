import { test, expect } from 'playwright/test'

test.describe('Layer menu - Flatten Image', () => {
    test('flatten image combines all visible layers into one', async ({ page }) => {
        await page.goto('/', { waitUntil: 'networkidle' })
        await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })

        // Create a solid base layer
        await page.waitForSelector('.open-dialog-backdrop.visible')
        await page.click('.media-option[data-type="solid"]')
        await page.waitForSelector('.canvas-size-dialog', { timeout: 5000 })
        await page.click('.canvas-size-dialog .action-btn.primary')
        await page.waitForSelector('.open-dialog-backdrop.visible', { state: 'hidden', timeout: 5000 })
        await page.waitForTimeout(500)

        // Add a second effect layer
        await page.evaluate(async () => {
            await window.layersApp._handleAddEffectLayer('synth/gradient')
        })
        await page.waitForTimeout(500)

        // Verify we have 2 layers
        const layerCountBefore = await page.evaluate(() => window.layersApp._layers.length)
        expect(layerCountBefore).toBe(2)

        // Clear selection (click on canvas area, not on layers)
        await page.evaluate(() => {
            window.layersApp._layerStack.selectedLayerId = null
            window.layersApp._updateLayerMenu()
        })
        await page.waitForTimeout(100)

        // Verify selection was cleared
        const selectedIdsAfterClear = await page.evaluate(() => window.layersApp._layerStack.selectedLayerIds)
        expect(selectedIdsAfterClear.length).toBe(0)

        // Verify menu shows "flatten image"
        const menuText = await page.locator('#layerActionMenuItem').textContent()
        expect(menuText).toBe('flatten image')

        // Trigger flatten image operation (simulates clicking "Flatten Image" menu item)
        // Using direct method call since the menu click handler is async and doesn't block
        await page.evaluate(async () => {
            await window.layersApp._flattenImage()
        })
        await page.waitForTimeout(500)

        // Verify we now have exactly 1 layer
        const layerCountAfter = await page.evaluate(() => window.layersApp._layers.length)
        expect(layerCountAfter).toBe(1)

        // Verify it's a media layer (rasterized)
        const layerType = await page.evaluate(() => window.layersApp._layers[0]?.sourceType)
        expect(layerType).toBe('media')
    })

    test('flatten captures an effect parameter update made in the same command turn', async ({ page }) => {
        await page.goto('/', { waitUntil: 'networkidle' })
        await page.locator('#loading-screen').waitFor({ state: 'hidden' })
        const backdrop = page.locator('.open-dialog-backdrop.visible')
        await backdrop.waitFor()
        await page.locator('.media-option[data-type="solid"]').click()
        await page.locator('.canvas-size-dialog .action-btn.primary').click()
        await backdrop.waitFor({ state: 'hidden' })

        const result = await page.evaluate(async () => {
            const app = window.layersApp
            const layer = app._layers[0]
            await window.LayersAgent.setLayerEffectParams({
                layerId: layer.id,
                params: { color: [1, 0, 0], alpha: 1 },
                replace: true,
            })
            const outcome = await app._flattenImage()
            const flattened = app._layers[0]
            const bitmap = await createImageBitmap(flattened.mediaFile)
            const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
            const context = canvas.getContext('2d')
            context.drawImage(bitmap, 0, 0)
            const pixel = [...context.getImageData(
                Math.floor(bitmap.width / 2), Math.floor(bitmap.height / 2), 1, 1).data]
            bitmap.close()
            return { status: outcome.status, pixel }
        })

        expect(result.status).toBe('committed')
        expect(result.pixel[0]).toBeGreaterThan(240)
        expect(result.pixel[1]).toBeLessThan(15)
        expect(result.pixel[2]).toBeLessThan(15)
        expect(result.pixel[3]).toBeGreaterThan(240)
    })

    test('readback renders the current animation phase instead of frame zero', async ({ page }) => {
        await page.goto('/', { waitUntil: 'networkidle' })
        await page.locator('#loading-screen').waitFor({ state: 'hidden' })

        const renderedPhase = await page.evaluate(() => {
            const renderer = window.layersApp._renderer
            renderer.getPausedNormalizedTime = () => 0.375
            renderer.render = (phase) => { window.__readbackPhase = phase }
            window.layersApp._renderCurrentFrame()
            return window.__readbackPhase
        })

        expect(renderedPhase).toBe(0.375)
    })

    test('readback preserves the displayed phase while animation is paused', async ({ page }) => {
        await page.goto('/', { waitUntil: 'networkidle' })
        await page.locator('#loading-screen').waitFor({ state: 'hidden' })

        const result = await page.evaluate(async () => {
            const app = window.layersApp
            const renderer = app._renderer
            renderer.stop()
            const stoppedPhase = renderer.getPausedNormalizedTime()
            await new Promise(resolve => setTimeout(resolve, 100))
            const laterPhase = renderer.getPausedNormalizedTime()
            const render = renderer.render.bind(renderer)
            let capturedPhase = null
            renderer.render = (phase) => {
                capturedPhase = phase
                return render(phase)
            }
            app._renderCurrentFrame()
            return { stoppedPhase, laterPhase, capturedPhase }
        })

        expect(result.laterPhase).toBe(result.stoppedPhase)
        expect(result.capturedPhase).toBe(result.stoppedPhase)
    })
})
