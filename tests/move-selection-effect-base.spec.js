import { test, expect } from './fixtures.js'
import { appReady, appState, layerCount } from './waits.js'

// A drag has to arrive as movement, not as a jump: a single mouse.move can
// deliver one pointermove, so a marquee sized from movement deltas commits
// with no size. Stepping emits the intermediate events a hand would.
async function drag(page, fromX, fromY, toX, toY) {
    await page.mouse.move(fromX, fromY)
    await page.mouse.down()
    await page.mouse.move(toX, toY, { steps: 12 })
    await page.mouse.up()
}

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
        // The dialog hides the moment it is dismissed; the project it asked for
        // is still being installed. Wait for the app and its base layer.
        await appReady(page)
        await layerCount(page, 1)

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
        await drag(page, box.x + 100, box.y + 100, box.x + 250, box.y + 250)
        await appState(page, () => window.layersApp._selectionManager.hasSelection())

        // Verify selection exists
        const hasSelection = await page.evaluate(() => window.layersApp._selectionManager.hasSelection())
        expect(hasSelection).toBe(true)

        // Click move tool button
        await page.click('#moveToolBtn')
        await appState(page, () => window.layersApp._moveTool?.isActive === true)

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
        // The press is accepted asynchronously: the tool leaves IDLE only once
        // it has taken the mutation token and begun extracting.
        await appState(page, () => window.layersApp._moveTool?.isDragging === true)
        await page.mouse.move(box.x + 300, box.y + 300, { steps: 12 })

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
        // The release ends the gesture; the tool returns to IDLE when it has.
        await appState(page, () => window.layersApp._moveTool?.isDragging === false)

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
