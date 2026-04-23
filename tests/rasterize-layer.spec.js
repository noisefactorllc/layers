import { test, expect } from 'playwright/test'

test.describe('Layer menu - rasterize layer', () => {
    test('rasterize converts effect layer to media layer', async ({ page }) => {
        await page.goto('/', { waitUntil: 'networkidle' })
        await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })

        // Create a solid base layer
        await page.waitForSelector('.open-dialog-backdrop.visible')
        await page.click('.media-option[data-type="solid"]')
        await page.waitForSelector('.canvas-size-dialog', { timeout: 5000 })
        await page.click('.canvas-size-dialog .action-btn.primary')
        await page.waitForSelector('.open-dialog-backdrop.visible', { state: 'hidden', timeout: 5000 })
        await page.waitForTimeout(500)

        // Verify it's an effect layer
        const layerTypeBefore = await page.evaluate(() => window.layersApp._layers[0]?.sourceType)
        expect(layerTypeBefore).toBe('effect')

        const layerNameBefore = await page.evaluate(() => window.layersApp._layers[0]?.name)

        // Select the layer (should already be selected, but ensure it)
        await page.evaluate(() => {
            const layerId = window.layersApp._layers[0].id
            window.layersApp._layerStack.selectedLayerId = layerId
        })
        await page.waitForTimeout(100)

        // Verify menu shows "rasterize layer" and is enabled
        const menuText = await page.locator('#layerActionMenuItem').textContent()
        expect(menuText).toBe('rasterize layer')
        const isDisabled = await page.locator('#layerActionMenuItem').evaluate(el => el.classList.contains('disabled'))
        expect(isDisabled).toBe(false)

        // Trigger rasterize layer operation (simulates clicking "rasterize layer" menu item)
        // Using direct method call since the menu click handler is async and doesn't block
        await page.evaluate(async () => {
            const layerId = window.layersApp._layers[0].id
            await window.layersApp._rasterizeLayer(layerId)
        })
        await page.waitForTimeout(500)

        // Verify layer is now media type
        const layerTypeAfter = await page.evaluate(() => window.layersApp._layers[0]?.sourceType)
        expect(layerTypeAfter).toBe('media')

        // Verify name has "(rasterized)" suffix
        const layerNameAfter = await page.evaluate(() => window.layersApp._layers[0]?.name)
        expect(layerNameAfter).toBe(`${layerNameBefore} (rasterized)`)

        // Verify still exactly 1 layer
        const layerCount = await page.evaluate(() => window.layersApp._layers.length)
        expect(layerCount).toBe(1)
    })

    test('rasterize text layer captures only the text, not the base layer', async ({ page }) => {
        await page.goto('/', { waitUntil: 'networkidle' })
        await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })

        // Create a RED solid base layer
        await page.waitForSelector('.open-dialog-backdrop.visible')
        await page.click('.media-option[data-type="solid"]')
        await page.waitForSelector('.canvas-size-dialog', { timeout: 5000 })
        await page.click('.canvas-size-dialog .action-btn.primary')
        await page.waitForSelector('.open-dialog-backdrop.visible', { state: 'hidden', timeout: 5000 })
        await page.waitForTimeout(500)

        await page.evaluate(() => {
            window.layersApp._layers[0].effectParams = { color: [1, 0, 0] }
            window.layersApp._renderer.setLayers(window.layersApp._layers)
        })
        await page.waitForTimeout(300)

        // Add a text layer on top
        await page.evaluate(async () => {
            await window.layersApp._handleAddEffectLayer('filter/text')
        })
        await page.waitForTimeout(1000)

        const textLayerId = await page.evaluate(() => window.layersApp._layers[1].id)

        // Rasterize the text layer (must not throw, must not include base)
        await page.evaluate(async (id) => {
            await window.layersApp._rasterizeLayer(id)
        }, textLayerId)
        await page.waitForTimeout(500)

        // The rasterized layer must be a media layer
        const rasterized = await page.evaluate(() => {
            const l = window.layersApp._layers[1]
            return { sourceType: l.sourceType, hasFile: !!l.mediaFile }
        })
        expect(rasterized.sourceType).toBe('media')
        expect(rasterized.hasFile).toBe(true)

        // Read pixels from the rasterized media file. Corners MUST be transparent
        // (rasterize isolates this layer — must not include the red base).
        const pixels = await page.evaluate(async () => {
            const layer = window.layersApp._layers[1]
            const img = await new Promise((resolve, reject) => {
                const i = new Image()
                i.onload = () => resolve(i)
                i.onerror = reject
                i.src = URL.createObjectURL(layer.mediaFile)
            })
            const canvas = new OffscreenCanvas(img.width, img.height)
            const ctx = canvas.getContext('2d')
            ctx.drawImage(img, 0, 0)
            return {
                width: img.width,
                height: img.height,
                tl: [...ctx.getImageData(5, 5, 1, 1).data],
                br: [...ctx.getImageData(img.width - 5, img.height - 5, 1, 1).data]
            }
        })

        // Corners should NOT be red (would indicate base leaked into rasterize)
        expect(pixels.tl[0]).toBeLessThan(50)
        expect(pixels.br[0]).toBeLessThan(50)
        // And should be transparent
        expect(pixels.tl[3]).toBe(0)
        expect(pixels.br[3]).toBe(0)
    })

    test('rasterize is disabled for media layers', async ({ page }) => {
        await page.goto('/', { waitUntil: 'networkidle' })
        await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })

        // Create a media base layer via test image
        await page.waitForSelector('.open-dialog-backdrop.visible')
        await page.evaluate(async () => {
            const canvas = document.createElement('canvas')
            canvas.width = 100
            canvas.height = 100
            const ctx = canvas.getContext('2d')
            ctx.fillStyle = 'blue'
            ctx.fillRect(0, 0, 100, 100)
            const blob = await new Promise(r => canvas.toBlob(r, 'image/png'))
            const file = new File([blob], 'test.png', { type: 'image/png' })
            await window.layersApp._handleOpenMedia(file, 'image')
        })
        await page.waitForTimeout(500)

        // Verify it's a media layer
        const layerType = await page.evaluate(() => window.layersApp._layers[0]?.sourceType)
        expect(layerType).toBe('media')

        // Select the layer
        await page.evaluate(() => {
            const layerId = window.layersApp._layers[0].id
            window.layersApp._layerStack.selectedLayerId = layerId
        })
        await page.waitForTimeout(100)

        // Verify menu shows "rasterize layer" but is disabled
        const menuText = await page.locator('#layerActionMenuItem').textContent()
        expect(menuText).toBe('rasterize layer')
        const isDisabled = await page.locator('#layerActionMenuItem').evaluate(el => el.classList.contains('disabled'))
        expect(isDisabled).toBe(true)
    })
})
