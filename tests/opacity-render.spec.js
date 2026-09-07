import { test, expect } from './fixtures.js'

function readCenterPixel(canvasEl) {
    const ctx = canvasEl.getContext('webgl2') || canvasEl.getContext('webgl')
    if (!ctx) return null
    ctx.bindFramebuffer(ctx.FRAMEBUFFER, null)
    const pixels = new Uint8Array(4)
    ctx.readPixels(
        Math.floor(canvasEl.width / 2),
        Math.floor(canvasEl.height / 2),
        1, 1,
        ctx.RGBA, ctx.UNSIGNED_BYTE, pixels
    )
    return Array.from(pixels)
}

test('changing non-base layer opacity changes canvas pixels', async ({ page }) => {
    await page.goto('/', { waitUntil: 'networkidle' })
    await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })
    await page.waitForSelector('.open-dialog-backdrop.visible')
    await page.click('.media-option[data-type="solid"]')
    await page.waitForSelector('.canvas-size-dialog', { timeout: 5000 })
    await page.click('.canvas-size-dialog .action-btn.primary')
    await page.waitForSelector('.open-dialog-backdrop.visible', { state: 'hidden', timeout: 5000 })
    await page.waitForTimeout(2000)

    // Change base layer to black
    await page.evaluate(async () => {
        const app = window.layersApp
        app._layers[0].effectParams = { color: [0, 0, 0], alpha: 1 }
        await app._rebuild()
    })
    await page.waitForTimeout(500)

    // Add a white solid layer on top
    await page.evaluate(async () => {
        const app = window.layersApp
        await app._handleAddEffectLayer('synth/solid')
        app._layers[1].effectParams = { color: [1, 1, 1], alpha: 1 }
        await app._rebuild()
    })
    await page.waitForTimeout(1000)

    const canvas = page.locator('#canvas')

    // At 100% opacity, top white layer should dominate
    const fullPixel = await canvas.evaluate(readCenterPixel)
    console.log('Full opacity pixel:', JSON.stringify(fullPixel))

    // Change opacity to 10 via the same path the slider uses
    await page.evaluate(async () => {
        const app = window.layersApp
        const layer = app._layers[1]
        await app._handleLayerChange({
            layerId: layer.id,
            property: 'opacity',
            value: 10,
            layer
        })
    })
    await page.waitForTimeout(1000)

    const reducedPixel = await canvas.evaluate(readCenterPixel)
    console.log('Reduced opacity pixel:', JSON.stringify(reducedPixel))

    // White over black at 10% opacity should be much darker than at 100%
    expect(reducedPixel[0]).toBeLessThan(fullPixel[0])
    expect(reducedPixel[1]).toBeLessThan(fullPixel[1])
    expect(reducedPixel[2]).toBeLessThan(fullPixel[2])
})
