import { test, expect } from 'playwright/test'

// The eraser's class doc promises: "Drag across multiple strokes to delete
// them all in one undo step." But _tryDelete pushed an undo snapshot per
// deleted stroke, so a drag over N strokes created N undo steps. This test
// erases two strokes in one drag and asserts a single undo restores both.

async function bootTransparent(page) {
    await page.goto('/', { waitUntil: 'networkidle' })
    await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })
    await page.waitForSelector('.open-dialog-backdrop.visible')
    await page.click('.media-option[data-type="transparent"]')
    await page.waitForSelector('.canvas-size-dialog', { timeout: 5000 })
    await page.click('.canvas-size-dialog .action-btn.primary')
    await page.waitForSelector('.open-dialog-backdrop.visible', { state: 'hidden', timeout: 5000 })
    await page.waitForTimeout(500)
}

test('erasing multiple strokes in one drag is a single undo step', async ({ page }) => {
    await bootTransparent(page)

    // Two well-separated strokes on a selected drawing layer, with a baseline
    // undo snapshot representing the two-stroke state.
    await page.evaluate(async () => {
        const app = window.layersApp
        const { createDrawingLayer } = await import('/js/layers/layer-model.js')
        const { createPathStroke } = await import('/js/drawing/stroke-model.js')
        const layer = createDrawingLayer('Eraser Test')
        layer.strokes.push(createPathStroke({ color: '#ff0000', size: 20, points: [{ x: 100, y: 100 }, { x: 150, y: 150 }] }))
        layer.strokes.push(createPathStroke({ color: '#00ff00', size: 20, points: [{ x: 300, y: 300 }, { x: 350, y: 350 }] }))
        app._layers.push(layer)
        await app._rasterizeDrawingLayer(layer)
        await app._rebuild({ force: true })
        app._updateLayerStack()
        if (app._layerStack) app._layerStack.selectedLayerId = layer.id
        app._pushUndoState() // baseline: two strokes
    })
    await page.waitForTimeout(200)

    await page.click('#eraserToolBtn')

    // Drag across both strokes: down on stroke A, move onto stroke B, release.
    const afterErase = await page.evaluate(async () => {
        const app = window.layersApp
        const overlay = document.getElementById('selectionOverlay')
        const rect = overlay.getBoundingClientRect()
        const sx = rect.width / overlay.width
        const sy = rect.height / overlay.height
        const fire = (type, cx, cy) => overlay.dispatchEvent(new MouseEvent(type, {
            clientX: rect.left + cx * sx, clientY: rect.top + cy * sy, bubbles: true, button: 0
        }))
        fire('mousedown', 125, 125) // hits stroke A
        fire('mousemove', 325, 325) // hits stroke B
        fire('mouseup', 325, 325)
        await new Promise(r => setTimeout(r, 300))
        const layer = app._layers.find(l => l.sourceType === 'drawing')
        return layer ? layer.strokes.length : -1
    })
    expect(afterErase).toBe(0)

    // A single undo should bring back BOTH strokes (one coalesced step).
    const afterUndo = await page.evaluate(async () => {
        const app = window.layersApp
        await app._undo()
        await new Promise(r => setTimeout(r, 300))
        const layer = app._layers.find(l => l.sourceType === 'drawing')
        return layer ? layer.strokes.length : -1
    })
    expect(afterUndo).toBe(2)
})
