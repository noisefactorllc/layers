import { test, expect } from './fixtures.js'

test.describe('Move tool - effect base layer', () => {
    test('move selection works on transparent base layer (effect type)', async ({ page }) => {
        await page.goto('/', { waitUntil: 'networkidle' })
        await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })

        // Create a SOLID project (so we have visible pixels to extract)
        await page.waitForSelector('.open-dialog-backdrop.visible')
        await page.click('.media-option[data-type="solid"]')
        await page.waitForSelector('.canvas-size-dialog', { timeout: 5000 })
        await page.click('.canvas-size-dialog .action-btn.primary')
        await page.waitForSelector('.open-dialog-backdrop.visible', { state: 'hidden', timeout: 5000 })
        await page.waitForTimeout(500)

        // Verify we have exactly 1 layer and it's an effect layer
        const layerInfo = await page.evaluate(() => ({
            count: window.layersApp._layers.length,
            baseLayerType: window.layersApp._layers[0]?.sourceType,
            baseLayerName: window.layersApp._layers[0]?.name
        }))
        console.log('Layer info:', layerInfo)
        expect(layerInfo.count).toBe(1)
        expect(layerInfo.baseLayerType).toBe('effect')

        // Get canvas position for mouse events
        const overlay = await page.$('#selectionOverlay')
        const box = await overlay.boundingBox()

        // Draw a selection rectangle using real mouse events
        await page.mouse.move(box.x + 100, box.y + 100)
        await page.mouse.down()
        await page.mouse.move(box.x + 250, box.y + 250)
        await page.mouse.up()
        await page.waitForTimeout(500)

        // Verify selection exists
        const hasSelection = await page.evaluate(() => window.layersApp._selectionManager.hasSelection())
        expect(hasSelection).toBe(true)

        // Click move tool button
        await page.click('#moveToolBtn')
        await page.waitForTimeout(200)

        // Verify move tool is active
        const moveToolActive = await page.evaluate(() => window.layersApp._moveTool?.isActive)
        expect(moveToolActive).toBe(true)

        // Check state before drag
        const stateBeforeDrag = await page.evaluate(() => ({
            layerCount: window.layersApp._layers.length,
            hasSelection: window.layersApp._selectionManager.hasSelection()
        }))
        console.log('State before drag:', stateBeforeDrag)

        const layerCountBefore = stateBeforeDrag.layerCount

        // Drag inside the selection area to trigger extraction
        await page.mouse.move(box.x + 175, box.y + 175)
        await page.mouse.down()
        await page.waitForTimeout(100)
        await page.mouse.move(box.x + 300, box.y + 300)

        // Wait for extraction to complete (new layer should be created)
        try {
            await page.waitForFunction(
                (expected) => window.layersApp._layers.length === expected,
                layerCountBefore + 1,
                { timeout: 15000 }
            )
        } catch (e) {
            const finalState = await page.evaluate(() => ({
                layerCount: window.layersApp._layers.length,
                layers: window.layersApp._layers.map(l => ({ name: l.name, type: l.sourceType })),
                hasExtracted: window.layersApp._moveTool?._hasExtracted
            }))
            console.log('TIMEOUT - Final state:', finalState)
            throw e
        }

        await page.mouse.up()
        await page.waitForTimeout(500)

        // Verify new layer was created
        const layerCountAfter = await page.evaluate(() => window.layersApp._layers.length)
        expect(layerCountAfter).toBe(layerCountBefore + 1)

        // Verify the new layer is named "moved selection"
        const newLayerName = await page.evaluate(() => window.layersApp._getActiveLayer()?.name)
        expect(newLayerName).toBe('moved selection')

        // Verify the new layer is a media layer (extracted pixels)
        const newLayerType = await page.evaluate(() => window.layersApp._getActiveLayer()?.sourceType)
        expect(newLayerType).toBe('media')
    })
})
