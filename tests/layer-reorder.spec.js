import { test, expect } from 'playwright/test'

async function addColorLayer(page, color, size = 100) {
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

test.describe('Layer reorder FSM', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('/', { waitUntil: 'networkidle' })
        await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })

        await page.waitForSelector('.open-dialog-backdrop.visible')
        await page.click('.media-option[data-type="solid"]')
        await page.waitForSelector('.canvas-size-dialog', { timeout: 5000 })
        await page.click('.canvas-size-dialog .action-btn.primary')
        await page.waitForSelector('.open-dialog-backdrop.visible', { state: 'hidden', timeout: 5000 })
        await page.waitForTimeout(500)
    })

    test('reordering layers updates render correctly', async ({ page }) => {
        await addColorLayer(page, 'red')
        await addColorLayer(page, 'blue')

        // Verify we have 3 layers (base + red + blue)
        const layerCount = await page.evaluate(() => window.layersApp._layers.length)
        expect(layerCount).toBe(3)

        // Get initial layer order
        const initialOrder = await page.evaluate(() =>
            window.layersApp._layers.map(l => l.name)
        )
        console.log('Initial order:', initialOrder)

        // Reorder via FSM methods directly (simpler than drag-drop)
        const reorderSuccess = await page.evaluate(async () => {
            const app = window.layersApp
            const layers = app._layers

            // Move top layer (blue, index 2) below red layer (index 1)
            const sourceId = layers[2].id
            const targetId = layers[1].id

            app._startDrag(sourceId)
            await app._processDrop(targetId, 'below')

            return app._reorderState === 'IDLE'
        })
        expect(reorderSuccess).toBe(true)

        // Verify order changed
        const newOrder = await page.evaluate(() =>
            window.layersApp._layers.map(l => l.name)
        )
        console.log('New order:', newOrder)

        // Blue should now be at index 1, red at index 2
        expect(newOrder[1]).toContain('blue')
        expect(newOrder[2]).toContain('red')
    })

    test('FSM cancels drag on ESC', async ({ page }) => {
        await addColorLayer(page, 'green')

        // Start drag
        await page.evaluate(() => {
            const app = window.layersApp
            const layerId = app._layers[1].id
            app._startDrag(layerId)
        })

        // Verify in DRAGGING state
        const draggingState = await page.evaluate(() => window.layersApp._reorderState)
        expect(draggingState).toBe('DRAGGING')

        // Press ESC
        await page.keyboard.press('Escape')

        // Verify the gesture state and its lifecycle lease were both released.
        const state = await page.evaluate(() => ({
            reorder: window.layersApp._reorderState,
            lifecycleActive: window.layersApp._projectLifecycleActive,
            tokenHeld: window.layersApp._reorderMutationToken !== null,
        }))
        expect(state).toEqual({
            reorder: 'IDLE',
            lifecycleActive: false,
            tokenHeld: false,
        })
    })

    test('FSM prevents dragging base layer', async ({ page }) => {
        const result = await page.evaluate(() => {
            const app = window.layersApp
            const baseLayerId = app._layers[0].id

            app._startDrag(baseLayerId)

            return {
                state: app._reorderState,
                hasSnapshot: app._reorderSnapshot !== null
            }
        })

        // Should remain in IDLE, no snapshot
        expect(result.state).toBe('IDLE')
        expect(result.hasSnapshot).toBe(false)
    })
})
