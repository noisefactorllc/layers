import { test, expect } from './fixtures.js'
import { appReady, appState, layerCount } from './waits.js'

test.describe('Move tool - real user flow', () => {
    test('draw selection then drag with move tool extracts to new layer', async ({ page }) => {
        // The move drag extracts a full 1024 square selection into a new layer
        // and rebuilds the renderer, which means a shader compile. On a CI
        // runner with no GPU that compile is the single most expensive thing
        // this suite asks for, and it lands inside one `mouse.move`, which
        // cannot return until the page has processed the events. Three
        // minutes is a bound on that work, not a multiplier on the default.
        test.setTimeout(180000)
        await page.goto('/', { waitUntil: 'networkidle' })
        await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })

        // Create a transparent project via UI
        await page.waitForSelector('.open-dialog-backdrop.visible')
        await page.click('.media-option[data-type="transparent"]')
        await page.waitForSelector('.canvas-size-dialog', { timeout: 5000 })
        await page.click('.canvas-size-dialog .action-btn.primary')
        await page.waitForSelector('.open-dialog-backdrop.visible', { state: 'hidden', timeout: 5000 })
        await appReady(page)

        // Add image layer (this part uses evaluate, but everything else is real mouse events)
        // Use full canvas size (1024x1024) to ensure selection overlaps with pixels
        await page.evaluate(async () => {
            const canvas = document.createElement('canvas')
            canvas.width = 1024
            canvas.height = 1024
            const ctx = canvas.getContext('2d')
            ctx.fillStyle = 'blue'
            ctx.fillRect(0, 0, 1024, 1024)
            const blob = await new Promise(r => canvas.toBlob(r, 'image/png'))
            const file = new File([blob], 'test.png', { type: 'image/png' })
            await window.layersApp._handleAddMediaLayer(file, 'image')
        })
        await layerCount(page, 2)

        // Verify layer was added
        const layerCountAfterAdd = await page.evaluate(() => window.layersApp._layers.length)
        expect(layerCountAfterAdd).toBe(2)

        // Click on the media layer in the layer stack to select it
        // Layer stack renders in reverse order: first-child = top layer (media), last-child = base layer
        const mediaLayerId = await page.evaluate(() => window.layersApp._layers[1].id)
        await page.click('layer-stack .layer-item:first-child')
        await appState(
            page,
            (id) => !!window.layersApp._layerStack?.selectedLayerIds?.includes(id),
            mediaLayerId,
        )

        // Verify layer is selected
        const activeLayerName = await page.evaluate(() => window.layersApp._getActiveLayer()?.name)
        expect(activeLayerName).toBeTruthy()

        // Get canvas position for mouse events
        const overlay = await page.$('#selectionOverlay')
        const box = await overlay.boundingBox()

        // Draw a selection rectangle using real mouse events
        // Selection tool should be active by default.
        // The marquee is sized in the mousemove handler (mousedown clears the
        // path), so the drag has to be stepped: a single move can deliver one
        // coalesced pointermove, and a marquee that never moved has no size.
        await page.mouse.move(box.x + 100, box.y + 100)
        await page.mouse.down()
        await page.mouse.move(box.x + 250, box.y + 250, { steps: 12 })
        await page.mouse.up()
        await appState(page, () => window.layersApp._selectionManager.hasSelection())

        // Verify selection exists
        const hasSelection = await page.evaluate(() => window.layersApp._selectionManager.hasSelection())
        expect(hasSelection).toBe(true)

        // Click move tool button
        await page.click('#moveToolBtn')
        await appState(page, () => window.layersApp._moveTool?.isActive === true)

        // Verify move tool is active
        const moveToolActive = await page.evaluate(() => window.layersApp._moveTool?.isActive)
        console.log('Move tool active:', moveToolActive)
        expect(moveToolActive).toBe(true)

        // Check state before drag
        const stateBeforeDrag = await page.evaluate(() => ({
            layerCount: window.layersApp._layers.length,
            activeLayer: window.layersApp._getActiveLayer()?.name,
            activeLayerType: window.layersApp._getActiveLayer()?.sourceType,
            hasSelection: window.layersApp._selectionManager.hasSelection(),
            selectionPath: window.layersApp._selectionManager.selectionPath
        }))
        console.log('State before drag:', stateBeforeDrag)

        // Record layer count before drag
        const layerCountBefore = stateBeforeDrag.layerCount

        // Drag inside the selection area to trigger extraction
        console.log('Starting drag at', box.x + 175, box.y + 175)
        await page.mouse.move(box.x + 175, box.y + 175)
        await page.mouse.down()
        // The gesture was accepted: the tool left IDLE for EXTRACTING.
        await appState(page, () => window.layersApp._moveTool?.isDragging === true)

        // Check state after mousedown
        const stateAfterDown = await page.evaluate(() => ({
            isDragging: window.layersApp._moveTool?._isDragging,
            hasExtracted: window.layersApp._moveTool?._hasExtracted
        }))
        console.log('State after mousedown:', stateAfterDown)

        await page.mouse.move(box.x + 300, box.y + 300, { steps: 12 })

        // Check state after mousemove
        const stateAfterMove = await page.evaluate(() => ({
            layerCount: window.layersApp._layers.length,
            hasExtracted: window.layersApp._moveTool?._hasExtracted
        }))
        console.log('State after mousemove:', stateAfterMove)

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
        // The gesture is finished only when the tool is back in IDLE: a mouseup
        // during EXTRACTING is deferred until the async extraction resolves.
        await appState(page, () => window.layersApp._moveTool?.isDragging === false)

        // Verify new layer was created
        const layerCountAfter = await page.evaluate(() => window.layersApp._layers.length)
        expect(layerCountAfter).toBe(layerCountBefore + 1)

        // Verify the new layer is named "moved selection"
        const newLayerName = await page.evaluate(() => window.layersApp._getActiveLayer()?.name)
        expect(newLayerName).toBe('moved selection')
    })
})
