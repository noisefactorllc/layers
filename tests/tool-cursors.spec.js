import { test, expect } from './fixtures.js'
import { appReady } from './waits.js'

// Cursor fidelity per active tool: the #selectionOverlay carries the active
// tool class and the cursor a painter sees over the canvas. Load-only — the
// default boot project is enough, no explicit project setup.
test.describe('Per-tool canvas cursor', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('/', { waitUntil: 'networkidle' })
        await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })
        await appReady(page)
    })

    test('each tool shows its Photoshop-parity cursor over the canvas', async ({ page }) => {
        const overlay = page.locator('#selectionOverlay')

        // tool key -> expected computed cursor on #selectionOverlay.
        const cases = [
            ['m', 'selection', 'crosshair'],
            ['v', 'move', 'move'],
            ['s', 'clone', 'copy'],
            ['b', 'brush', 'crosshair'],
            ['e', 'eraser', 'crosshair'],
            ['u', 'shape', 'crosshair'],
            ['g', 'fill', 'crosshair'],
            ['i', 'eyedropper', 'crosshair'],
            ['h', 'pan', 'grab'],
        ]

        for (const [key, tool, cursor] of cases) {
            await page.keyboard.press(key)
            expect(await page.evaluate(() => window.layersApp._currentTool), `key ${key}`).toBe(tool)
            expect(await overlay.evaluate(el => window.getComputedStyle(el).cursor),
                `tool ${tool}`).toBe(cursor)
        }
    })

    test('transform tool applies its cursor class over the canvas', async ({ page }) => {
        const overlay = page.locator('#selectionOverlay')

        // Transform needs a media or drawing layer (app.js warns and refuses
        // otherwise); the clean boot canvas has none, so add a drawing layer.
        await page.evaluate(() => window.LayersAgent.addLayer({ kind: 'drawing' }))
        await page.keyboard.press('t')
        expect(await page.evaluate(() => window.layersApp._currentTool)).toBe('transform')
        await expect(overlay).toHaveClass(/transform-tool/)
        // The class rule is the resting cursor; TransformTool only overrides
        // it with a dynamic style.cursor while the pointer moves over handles.
        expect(await overlay.evaluate(el => window.getComputedStyle(el).cursor)).toBe('default')
    })
})
