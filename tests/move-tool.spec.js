import { test, expect } from './fixtures.js'

async function createTransparentProject(page, size = 1024) {
    await page.waitForSelector('.open-dialog-backdrop.visible')
    await page.click('.media-option[data-type="transparent"]')
    await page.waitForSelector('.canvas-size-dialog', { timeout: 5000 })
    await page.fill('#canvas-width', String(size))
    await page.fill('#canvas-height', String(size))
    await page.click('.canvas-size-dialog .action-btn.primary')
    await page.waitForSelector('.open-dialog-backdrop.visible', { state: 'hidden', timeout: 5000 })
    await page.waitForTimeout(500)
}

async function addColorLayer(page, color, size = 100) {
    await page.evaluate(async ({ color, size }) => {
        const canvas = document.createElement('canvas')
        canvas.width = size
        canvas.height = size
        const ctx = canvas.getContext('2d')
        ctx.fillStyle = color
        ctx.fillRect(0, 0, size, size)
        const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'))
        const file = new File([blob], 'test.png', { type: 'image/png' })
        await window.layersApp._handleAddMediaLayer(file, 'image')
    }, { color, size })
    await page.waitForTimeout(500)
}

test.describe('Move tool', () => {
    test('move tool button exists and can be clicked', async ({ page }) => {
        await page.goto('/', { waitUntil: 'networkidle' })
        await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })
        await createTransparentProject(page)

        const moveBtn = await page.$('#moveToolBtn')
        expect(moveBtn).not.toBeNull()

        await page.click('#moveToolBtn')

        const isActive = await page.evaluate(() => {
            return document.getElementById('moveToolBtn').classList.contains('active')
        })
        expect(isActive).toBe(true)
    })

    test('dragging with move tool updates layer position', async ({ page }) => {
        await page.goto('/', { waitUntil: 'networkidle' })
        await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })
        await createTransparentProject(page)
        await addColorLayer(page, 'red')

        // Select the new layer
        await page.evaluate(() => {
            const layers = window.layersApp._layers
            const topLayer = layers[layers.length - 1]
            window.layersApp._layerStack.selectedLayerId = topLayer.id
        })

        // Activate move tool
        await page.click('#moveToolBtn')

        // Get initial position
        const initialPos = await page.evaluate(() => {
            const layer = window.layersApp._getActiveLayer()
            return { x: layer?.offsetX || 0, y: layer?.offsetY || 0 }
        })

        // Drag on canvas
        const canvas = await page.$('#selectionOverlay')
        const box = await canvas.boundingBox()

        await page.mouse.move(box.x + 200, box.y + 200)
        await page.mouse.down()
        await page.mouse.move(box.x + 250, box.y + 280)
        await page.mouse.up()

        // Check position changed
        const finalPos = await page.evaluate(() => {
            const layer = window.layersApp._getActiveLayer()
            return { x: layer?.offsetX || 0, y: layer?.offsetY || 0 }
        })

        expect(finalPos.x).not.toBe(initialPos.x)
        expect(finalPos.y).not.toBe(initialPos.y)
    })

    test('moving selection extracts pixels to new layer', async ({ page }) => {
        await page.goto('/', { waitUntil: 'networkidle' })
        await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })
        // Keep the complete selection and native pointer path inside the image.
        await createTransparentProject(page, 256)
        await addColorLayer(page, 'blue', 256)

        const initialLayerCount = await page.evaluate(() => window.layersApp._layers.length)

        // Select the layer
        await page.evaluate(() => {
            const layers = window.layersApp._layers
            const topLayer = layers[layers.length - 1]
            window.layersApp._layerStack.selectedLayerId = topLayer.id
        })

        // Create a selection
        await page.evaluate(() => {
            const sm = window.layersApp._selectionManager
            sm._selectionPath = { type: 'rect', x: 50, y: 50, width: 100, height: 100 }
            sm._startAnimation()
        })
        await page.waitForTimeout(200)

        // Activate move tool
        await page.click('#moveToolBtn')

        // Drag to trigger extraction
        const canvas = await page.$('#selectionOverlay')
        const box = await canvas.boundingBox()

        await page.mouse.move(box.x + 100, box.y + 100)
        await page.mouse.down()
        await page.mouse.move(box.x + 150, box.y + 150)

        // Wait for extraction to complete by polling for the new layer
        await page.waitForFunction(
            (expectedCount) => window.layersApp._layers.length === expectedCount,
            initialLayerCount + 1,
            { timeout: 5000 }
        )

        await page.mouse.up()
        await page.waitForTimeout(200)

        // Verify new layer was created
        const finalLayerCount = await page.evaluate(() => window.layersApp._layers.length)
        expect(finalLayerCount).toBe(initialLayerCount + 1)

        // Verify the new layer is selected
        const selectedLayerName = await page.evaluate(() => {
            const layer = window.layersApp._getActiveLayer()
            return layer?.name
        })
        expect(selectedLayerName).toBe('moved selection')
    })
})
