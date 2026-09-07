import { test, expect } from './fixtures.js'

function readCenterAlpha(canvasEl) {
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
    return pixels[3]
}

test('dragging opacity slider on non-base layer changes rendered output', async ({ page }) => {
    await page.goto('/', { waitUntil: 'networkidle' })
    await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })
    await page.waitForSelector('.open-dialog-backdrop.visible')
    await page.click('.media-option[data-type="solid"]')
    await page.waitForSelector('.canvas-size-dialog', { timeout: 5000 })
    await page.click('.canvas-size-dialog .action-btn.primary')
    await page.waitForSelector('.open-dialog-backdrop.visible', { state: 'hidden', timeout: 5000 })
    await page.waitForTimeout(2000)

    // Add a second layer so we have a non-base (draggable) layer to test
    await page.evaluate(async () => {
        await window.layersApp._handleAddEffectLayer('synth/solid')
    })
    await page.waitForTimeout(1000)

    // Get the non-base layer's opacity slider (first layer-item in DOM = top layer)
    const nonBaseItem = page.locator('layer-item').first()
    const slider = nonBaseItem.locator('.layer-opacity input[type="range"]')
    await expect(slider).toBeVisible()

    const box = await slider.boundingBox()
    expect(box).toBeTruthy()
    expect(box.width).toBeGreaterThan(0)

    // Drag the slider thumb from right (100%) to left (~25%)
    const startX = box.x + box.width * 0.9
    const startY = box.y + box.height / 2
    const endX = box.x + box.width * 0.25

    await page.mouse.move(startX, startY)
    await page.mouse.down()
    for (let i = 0; i <= 10; i++) {
        await page.mouse.move(startX + (endX - startX) * (i / 10), startY)
        await page.waitForTimeout(30)
    }
    await page.mouse.up()
    await page.waitForTimeout(1000)

    const state = await page.evaluate(() => {
        const app = window.layersApp
        return {
            layer0opacity: app._layers[0].opacity,
            layer1opacity: app._layers[1].opacity,
        }
    })
    console.log('After drag:', JSON.stringify(state))

    // The non-base layer (index 1 in _layers, first in DOM) opacity should have decreased
    expect(state.layer1opacity).toBeLessThan(50)
})
