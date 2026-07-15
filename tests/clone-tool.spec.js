import { test, expect } from 'playwright/test'

const FIXTURE_SIZE = 512

async function createTransparentProject(page) {
    await page.waitForSelector('.open-dialog-backdrop.visible')
    await page.click('.media-option[data-type="transparent"]')
    await page.waitForSelector('.canvas-size-dialog', { timeout: 5000 })
    await page.fill('#canvas-width', String(FIXTURE_SIZE))
    await page.fill('#canvas-height', String(FIXTURE_SIZE))
    await page.click('.canvas-size-dialog .action-btn.primary')
    await page.waitForSelector('.open-dialog-backdrop.visible', { state: 'hidden', timeout: 5000 })
    await page.waitForTimeout(500)
}

async function addColorLayer(page, color, size = FIXTURE_SIZE) {
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

/**
 * Read a pixel from the active layer's media file.
 * Defaults to the center of the image if no coordinates are given.
 */
async function getActiveLayerPixel(page, x, y) {
    return page.evaluate(async ({ x, y }) => {
        const app = window.layersApp
        const layer = app._getActiveLayer()
        if (!layer?.mediaFile) return null

        const img = await new Promise((resolve, reject) => {
            const i = new Image()
            i.onload = () => resolve(i)
            i.onerror = reject
            i.src = URL.createObjectURL(layer.mediaFile)
        })

        const canvas = new OffscreenCanvas(img.width, img.height)
        const ctx = canvas.getContext('2d')
        ctx.drawImage(img, 0, 0)
        const px = x ?? Math.floor(img.width / 2)
        const py = y ?? Math.floor(img.height / 2)
        const data = ctx.getImageData(px, py, 1, 1).data
        return { r: data[0], g: data[1], b: data[2], a: data[3] }
    }, { x, y })
}

/**
 * Activate clone tool, click-drag on canvas, wait for new layer
 */
async function cloneViaDrag(page, initialLayerCount, dragDistance = 100) {
    await page.click('#cloneToolBtn')
    await page.waitForTimeout(200)

    const canvas = await page.$('#selectionOverlay')
    const box = await canvas.boundingBox()
    await page.mouse.move(box.x + 200, box.y + 200)
    await page.mouse.down()

    // Wait for extraction to complete (new layer created, state transitions to DRAGGING)
    await page.waitForFunction(
        (expected) => window.layersApp._layers.length === expected,
        initialLayerCount + 1,
        { timeout: 5000 }
    )

    // Now drag AFTER extraction - this is when the layer actually moves
    await page.mouse.move(box.x + 200 + dragDistance, box.y + 200 + dragDistance)
    await page.waitForTimeout(100)

    await page.mouse.up()
    await page.waitForTimeout(300)
}

test.describe('Clone tool', () => {
    test('clone only includes pixels from the selected layer, not other layers', async ({ page }) => {
        await page.goto('/', { waitUntil: 'networkidle' })
        await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })
        await createTransparentProject(page)

        // Red layer (bottom), blue layer (top)
        await addColorLayer(page, '#ff0000')
        await addColorLayer(page, '#0000ff')

        const initialCount = await page.evaluate(() => window.layersApp._layers.length)

        // Select the BOTTOM (red) layer
        await page.evaluate(() => {
            const layers = window.layersApp._layers
            window.layersApp._layerStack.selectedLayerId = layers[1].id
        })

        await cloneViaDrag(page, initialCount)

        const pixel = await getActiveLayerPixel(page)
        expect(pixel).not.toBeNull()
        expect(pixel.r).toBeGreaterThan(200)
        expect(pixel.b).toBeLessThan(50)
        expect(pixel.a).toBeGreaterThan(200)
    })

    test('clone with selection preserves the original selection exactly', async ({ page }) => {
        await page.goto('/', { waitUntil: 'networkidle' })
        await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })
        await createTransparentProject(page)

        await addColorLayer(page, '#00ff00')

        const initialCount = await page.evaluate(() => window.layersApp._layers.length)

        // Select the layer
        await page.evaluate(() => {
            const layers = window.layersApp._layers
            window.layersApp._layerStack.selectedLayerId = layers[layers.length - 1].id
        })

        // Create a 200x200 selection at (100,100)
        await page.evaluate(() => {
            const sm = window.layersApp._selectionManager
            sm._selectionPath = { type: 'rect', x: 100, y: 100, width: 200, height: 200 }
            sm._startAnimation()
        })
        await page.waitForTimeout(200)

        await cloneViaDrag(page, initialCount)

        // Check the selection path after clone - should be unchanged
        const selectionAfter = await page.evaluate(() => {
            const sm = window.layersApp._selectionManager
            const path = sm._selectionPath
            return path ? { type: path.type, x: path.x, y: path.y, width: path.width, height: path.height } : null
        })

        expect(selectionAfter).toEqual({ type: 'rect', x: 100, y: 100, width: 200, height: 200 })
    })

    test('clone with selection only includes pixels from the selected layer', async ({ page }) => {
        await page.goto('/', { waitUntil: 'networkidle' })
        await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })
        await createTransparentProject(page)

        // Red layer (bottom), green layer (top)
        await addColorLayer(page, '#ff0000')
        await addColorLayer(page, '#00ff00')

        const initialCount = await page.evaluate(() => window.layersApp._layers.length)

        // Select the top (green) layer
        await page.evaluate(() => {
            const layers = window.layersApp._layers
            window.layersApp._layerStack.selectedLayerId = layers[layers.length - 1].id
        })

        // Create a selection marquee
        await page.evaluate(() => {
            const sm = window.layersApp._selectionManager
            sm._selectionPath = { type: 'rect', x: 100, y: 100, width: 200, height: 200 }
            sm._startAnimation()
        })
        await page.waitForTimeout(200)

        await cloneViaDrag(page, initialCount)

        const pixel = await getActiveLayerPixel(page, 200, 200)

        expect(pixel).not.toBeNull()
        expect(pixel.g).toBeGreaterThan(200)
        expect(pixel.r).toBeLessThan(50)
        expect(pixel.a).toBeGreaterThan(200)
    })
})
