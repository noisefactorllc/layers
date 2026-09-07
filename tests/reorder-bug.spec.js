import { test, expect } from './fixtures.js'

async function addColorLayer(page, color, size = 512) {
    await page.evaluate(async ({ color, size }) => {
        const canvas = document.createElement('canvas')
        canvas.width = size
        canvas.height = size
        const ctx = canvas.getContext('2d')
        ctx.fillStyle = color
        ctx.fillRect(0, 0, size, size)
        const blob = await new Promise(r => canvas.toBlob(r, 'image/png'))
        const file = new File([blob], `${color}.png`, { type: 'image/png' })
        await window.layersApp._handleAddMediaLayer(file, 'image')
    }, { color, size })
    await page.waitForTimeout(500)
}

test.describe('Layer reorder texture mapping', () => {
    test('reordering layers updates texture mapping correctly', async ({ page }) => {
        // Regression: layer reorder didn't update texture mapping when DSL was
        // string-identical after reorder (e.g., multiple media() layers)

        await page.goto('/', { waitUntil: 'networkidle' })
        await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })

        await page.waitForSelector('.open-dialog-backdrop.visible')
        await page.click('.media-option[data-type="solid"]')
        await page.waitForSelector('.canvas-size-dialog', { timeout: 5000 })
        await page.click('.canvas-size-dialog .action-btn.primary')
        await page.waitForSelector('.open-dialog-backdrop.visible', { state: 'hidden', timeout: 5000 })
        await page.waitForTimeout(500)

        await addColorLayer(page, 'red')
        await addColorLayer(page, 'blue')

        // Get layer order and step mappings before reorder
        const beforeState = await page.evaluate(() => {
            const app = window.layersApp
            return {
                layerOrder: app._layers.map(l => ({ id: l.id, name: l.name })),
                stepMap: Object.fromEntries(app._renderer._layerStepMap.entries())
            }
        })

        // Verify initial state: [Solid, red, blue]
        expect(beforeState.layerOrder.map(l => l.name)).toEqual(['Solid', 'red', 'blue'])

        // Get step indices for red and blue before reorder
        const redIdBefore = beforeState.layerOrder.find(l => l.name === 'red').id
        const blueIdBefore = beforeState.layerOrder.find(l => l.name === 'blue').id
        const redStepBefore = beforeState.stepMap[redIdBefore]
        const blueStepBefore = beforeState.stepMap[blueIdBefore]

        // Reorder: move blue (index 2) below red (index 1)
        await page.evaluate(async () => {
            const app = window.layersApp
            const sourceId = app._layers[2].id  // blue
            const targetId = app._layers[1].id  // red
            app._startDrag(sourceId)
            await app._processDrop(targetId, 'below')
        })
        await page.waitForTimeout(500)

        // Get state after reorder
        const afterState = await page.evaluate(() => {
            const app = window.layersApp
            return {
                layerOrder: app._layers.map(l => ({ id: l.id, name: l.name })),
                stepMap: Object.fromEntries(app._renderer._layerStepMap.entries())
            }
        })

        // Verify new order: [Solid, blue, red]
        expect(afterState.layerOrder.map(l => l.name)).toEqual(['Solid', 'blue', 'red'])

        // Get step indices after reorder
        const redStepAfter = afterState.stepMap[redIdBefore]
        const blueStepAfter = afterState.stepMap[blueIdBefore]

        // Verify step mapping was updated correctly:
        // - blue moved from position 2 to position 1, should get red's old step
        // - red moved from position 1 to position 2, should get blue's old step
        expect(blueStepAfter).toBe(redStepBefore)
        expect(redStepAfter).toBe(blueStepBefore)
    })
})
