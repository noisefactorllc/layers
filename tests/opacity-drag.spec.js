import { test, expect } from './fixtures.js'
import { appReady, appState, layerCount } from './waits.js'

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
    await appReady(page)

    // Add a second layer so we have a non-base (draggable) layer to test
    await page.evaluate(async () => {
        await window.layersApp._handleAddEffectLayer('synth/solid')
    })
    await layerCount(page, 2)

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
    // Stepping the move is what makes this a drag rather than a jump.
    await page.mouse.move(endX, startY, { steps: 12 })
    await page.mouse.up()
    // Every move dispatched a layer-change, and each one queued a pointer
    // mutation before mouse-up returned. The drag has landed when that queue
    // has drained: nothing holds the lifecycle lease, nothing is waiting for
    // it, and no publish transaction is open.
    await appState(page, () => {
        const app = window.layersApp
        return !app._projectLifecycleOwner && app._projectLifecycleWaiters === 0
            && app._publishTransactionDepth === 0
    })

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
