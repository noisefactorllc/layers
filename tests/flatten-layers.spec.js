import { test, expect } from './fixtures.js'

test.describe('Layer menu - flatten layers', () => {
    test('flatten layers combines selected layers into one', async ({ page }) => {
        await page.goto('/', { waitUntil: 'networkidle' })
        await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })

        // Create a solid base layer
        await page.waitForSelector('.open-dialog-backdrop.visible')
        await page.click('.media-option[data-type="solid"]')
        await page.waitForSelector('.canvas-size-dialog', { timeout: 5000 })
        await page.click('.canvas-size-dialog .action-btn.primary')
        await page.waitForSelector('.open-dialog-backdrop.visible', { state: 'hidden', timeout: 5000 })
        await page.waitForTimeout(500)

        // Add two more effect layers
        await page.evaluate(async () => {
            await window.layersApp._handleAddEffectLayer('synth/gradient')
            await window.layersApp._handleAddEffectLayer('synth/solid')
        })
        await page.waitForTimeout(500)

        // Verify we have 3 layers
        const layerCountBefore = await page.evaluate(() => window.layersApp._layers.length)
        expect(layerCountBefore).toBe(3)

        // Select the top 2 layers (indices 1 and 2)
        await page.evaluate(() => {
            const layer1 = window.layersApp._layers[1]
            const layer2 = window.layersApp._layers[2]
            window.layersApp._layerStack.selectedLayerIds = [layer1.id, layer2.id]
            window.layersApp._layerStack.dispatchEvent(new CustomEvent('selection-change'))
        })
        await page.waitForTimeout(100)

        // Verify menu shows "flatten layers"
        const menuText = await page.locator('#layerActionMenuItem').textContent()
        expect(menuText).toBe('flatten layers')

        // Call flatten layers directly (avoiding async menu timing issues)
        await page.evaluate(async () => {
            const layer1 = window.layersApp._layers[1]
            const layer2 = window.layersApp._layers[2]
            await window.layersApp._flattenLayers([layer1.id, layer2.id])
        })
        await page.waitForTimeout(1000)

        // Verify we now have 2 layers (base + flattened)
        const layerCountAfter = await page.evaluate(() => window.layersApp._layers.length)
        expect(layerCountAfter).toBe(2)

        // Verify the new layer is named "flattened"
        const topLayerName = await page.evaluate(() => window.layersApp._layers[1]?.name)
        expect(topLayerName).toBe('flattened')

        // Verify it's a media layer
        const topLayerType = await page.evaluate(() => window.layersApp._layers[1]?.sourceType)
        expect(topLayerType).toBe('media')
    })
})
