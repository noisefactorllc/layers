import { test, expect } from './fixtures.js'
import { defaultProjectReady } from './waits.js'
import { pausePlayback } from './helpers/new-project.js'

test.describe('Spacebar Pan Toggle and Hand Tool', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('/', { waitUntil: 'networkidle' })
        await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })
        await defaultProjectReady(page)
        await pausePlayback(page)
    })

    test('toolbar button #handToolBtn exists and activates pan tool on click', async ({ page }) => {
        const handBtn = page.locator('#handToolBtn')
        await expect(handBtn).toBeVisible()
        await expect(handBtn).toHaveAttribute('title', /Hand Tool \(H\)/)

        await handBtn.click()
        const tool = await page.evaluate(() => window.layersApp._currentTool)
        expect(tool).toBe('pan')
        await expect(handBtn).toHaveClass(/active/)
        await expect(page.locator('#selectionOverlay')).toHaveClass(/pan-tool/)
    })

    test('H key activates pan tool and toggles back to previous tool', async ({ page }) => {
        // Start in brush tool
        await page.keyboard.press('b')
        expect(await page.evaluate(() => window.layersApp._currentTool)).toBe('brush')

        // Press H -> switches to pan
        await page.keyboard.press('h')
        expect(await page.evaluate(() => window.layersApp._currentTool)).toBe('pan')
        await expect(page.locator('#handToolBtn')).toHaveClass(/active/)

        // Press H again -> toggles back to brush
        await page.keyboard.press('h')
        expect(await page.evaluate(() => window.layersApp._currentTool)).toBe('brush')
        await expect(page.locator('#brushToolBtn')).toHaveClass(/active/)
        await expect(page.locator('#handToolBtn')).not.toHaveClass(/active/)
    })

    test('holding Spacebar temporarily activates Pan tool and reverts on keyup', async ({ page }) => {
        // Start in brush tool
        await page.keyboard.press('b')
        expect(await page.evaluate(() => window.layersApp._currentTool)).toBe('brush')

        // Hold Space down
        await page.keyboard.down('Space')
        await page.waitForTimeout(50)
        expect(await page.evaluate(() => window.layersApp._currentTool)).toBe('pan')
        await expect(page.locator('#handToolBtn')).toHaveClass(/active/)
        await expect(page.locator('#selectionOverlay')).toHaveClass(/pan-tool/)

        // Hold for >= 450ms
        await page.waitForTimeout(500)

        // Release Space
        await page.keyboard.up('Space')
        await page.waitForTimeout(50)

        // Should return to brush tool
        expect(await page.evaluate(() => window.layersApp._currentTool)).toBe('brush')
        await expect(page.locator('#brushToolBtn')).toHaveClass(/active/)
        await expect(page.locator('#handToolBtn')).not.toHaveClass(/active/)
    })

    test('dragging with Spacebar held pans the viewport', async ({ page }) => {
        // Set zoom to 200% so the canvas overflows the panel
        await page.evaluate(() => window.layersApp._setZoom('200'))
        await page.waitForTimeout(100)

        const panel = page.locator('#canvas-panel')
        const initialScroll = await panel.evaluate(el => ({ left: el.scrollLeft, top: el.scrollTop }))

        // Hold Spacebar down
        await page.keyboard.down('Space')
        await page.waitForTimeout(50)
        expect(await page.evaluate(() => window.layersApp._currentTool)).toBe('pan')

        const box = await panel.boundingBox()
        const startX = box.x + box.width / 2
        const startY = box.y + box.height / 2

        // Drag mouse left and up
        await page.mouse.move(startX, startY)
        await page.mouse.down()
        await page.mouse.move(startX - 100, startY - 100, { steps: 5 })
        await page.mouse.up()

        // Panel should have scrolled right and down
        const afterScroll = await panel.evaluate(el => ({ left: el.scrollLeft, top: el.scrollTop }))
        expect(afterScroll.left).toBeGreaterThan(initialScroll.left)
        expect(afterScroll.top).toBeGreaterThan(initialScroll.top)

        // Release Spacebar
        await page.keyboard.up('Space')
        await page.waitForTimeout(50)

        // Tool should restore to selection (or previous tool)
        expect(await page.evaluate(() => window.layersApp._currentTool)).toBe('selection')
    })

    test('quick-tap Space (<450ms without drag) toggles Pan tool on, and tapping again toggles back', async ({ page }) => {
        // Start in brush tool
        await page.keyboard.press('b')
        expect(await page.evaluate(() => window.layersApp._currentTool)).toBe('brush')

        // Quick tap Space (<300ms)
        await page.keyboard.press('Space')
        await page.waitForTimeout(50)

        // Should remain in Pan tool (toggled)
        expect(await page.evaluate(() => window.layersApp._currentTool)).toBe('pan')
        await expect(page.locator('#handToolBtn')).toHaveClass(/active/)

        // Tap Space again to toggle back
        await page.keyboard.press('Space')
        await page.waitForTimeout(50)

        // Should return to brush tool
        expect(await page.evaluate(() => window.layersApp._currentTool)).toBe('brush')
        await expect(page.locator('#brushToolBtn')).toHaveClass(/active/)
        await expect(page.locator('#handToolBtn')).not.toHaveClass(/active/)
    })

    test('releasing Spacebar mid-drag completes pan and restores tool upon pointerup', async ({ page }) => {
        await page.evaluate(() => window.layersApp._setZoom('200'))
        await page.keyboard.press('b')
        expect(await page.evaluate(() => window.layersApp._currentTool)).toBe('brush')

        const panel = page.locator('#canvas-panel')
        const box = await panel.boundingBox()
        const startX = box.x + box.width / 2
        const startY = box.y + box.height / 2

        // Hold Space
        await page.keyboard.down('Space')
        await page.waitForTimeout(50)
        expect(await page.evaluate(() => window.layersApp._currentTool)).toBe('pan')

        // Mouse down and drag
        await page.mouse.move(startX, startY)
        await page.mouse.down()
        await page.mouse.move(startX - 50, startY - 50, { steps: 3 })

        // Release Space while mouse is STILL down
        await page.keyboard.up('Space')
        await page.waitForTimeout(50)

        // Tool should STILL be pan during active drag
        expect(await page.evaluate(() => window.layersApp._currentTool)).toBe('pan')

        // Continue drag
        await page.mouse.move(startX - 100, startY - 100, { steps: 3 })

        // Mouse up -> drag finishes
        await page.mouse.up()
        await page.waitForTimeout(50)

        // Now previous tool ('brush') should be restored
        expect(await page.evaluate(() => window.layersApp._currentTool)).toBe('brush')
        await expect(page.locator('#brushToolBtn')).toHaveClass(/active/)
    })

    test('typing Space in an input field does not activate Pan tool', async ({ page }) => {
        await page.keyboard.press('b')
        expect(await page.evaluate(() => window.layersApp._currentTool)).toBe('brush')

        const sizeInput = page.locator('#drawingSizeInput')
        await sizeInput.focus()

        // Press Space inside input
        await page.keyboard.press('Space')
        await page.waitForTimeout(50)

        // Current tool should still be brush
        expect(await page.evaluate(() => window.layersApp._currentTool)).toBe('brush')
        await expect(page.locator('#handToolBtn')).not.toHaveClass(/active/)
    })

    test('window blur while space-pan is active cleanly exits and restores tool', async ({ page }) => {
        await page.keyboard.press('b')
        expect(await page.evaluate(() => window.layersApp._currentTool)).toBe('brush')

        // Hold Space
        await page.keyboard.down('Space')
        await page.waitForTimeout(50)
        expect(await page.evaluate(() => window.layersApp._currentTool)).toBe('pan')

        // Trigger window blur
        await page.evaluate(() => window.dispatchEvent(new Event('blur')))
        await page.keyboard.up('Space')
        await page.waitForTimeout(50)

        // Should cleanly restore brush tool
        expect(await page.evaluate(() => window.layersApp._currentTool)).toBe('brush')
        await expect(page.locator('#brushToolBtn')).toHaveClass(/active/)
    })

    test('Escape cancels quick-toggled pan and restores previous tool', async ({ page }) => {
        await page.keyboard.press('b')
        expect(await page.evaluate(() => window.layersApp._currentTool)).toBe('brush')

        // Quick tap Space into Pan mode
        await page.keyboard.press('Space')
        await page.waitForTimeout(50)
        expect(await page.evaluate(() => window.layersApp._currentTool)).toBe('pan')

        // Press Escape
        await page.keyboard.press('Escape')
        await page.waitForTimeout(50)

        // Brush should be restored
        expect(await page.evaluate(() => window.layersApp._currentTool)).toBe('brush')
        await expect(page.locator('#brushToolBtn')).toHaveClass(/active/)
    })

    test('Pan tool displays grab cursor when idle and grabbing cursor while dragging', async ({ page }) => {
        // Activate pan tool via H
        await page.keyboard.press('h')
        expect(await page.evaluate(() => window.layersApp._currentTool)).toBe('pan')

        const overlay = page.locator('#selectionOverlay')
        const idleCursor = await overlay.evaluate(el => window.getComputedStyle(el).cursor)
        expect(idleCursor).toBe('grab')

        // Start mouse drag
        const panel = page.locator('#canvas-panel')
        const box = await panel.boundingBox()
        const startX = box.x + box.width / 2
        const startY = box.y + box.height / 2

        await page.mouse.move(startX, startY)
        await page.mouse.down()
        await page.mouse.move(startX - 20, startY - 20)

        // Check dragging cursor on panel
        const activeCursor = await panel.evaluate(el => window.getComputedStyle(el).cursor)
        expect(activeCursor).toBe('grabbing')

        await page.mouse.up()
    })

    test('Spacebar does not trigger Pan tool when a modal dialog is open', async ({ page }) => {
        // Start in brush
        await page.keyboard.press('b')
        expect(await page.evaluate(() => window.layersApp._currentTool)).toBe('brush')

        // Open About dialog via window.layersApp
        await page.evaluate(() => {
            // Trigger an open dialog
            const dialog = document.createElement('dialog')
            dialog.id = 'test-modal-dialog'
            document.body.appendChild(dialog)
            dialog.showModal()
        })

        // Press Space
        await page.keyboard.press('Space')
        await page.waitForTimeout(50)

        // Tool should remain brush, not pan
        expect(await page.evaluate(() => window.layersApp._currentTool)).toBe('brush')

        // Clean up test dialog
        await page.evaluate(() => {
            const dialog = document.getElementById('test-modal-dialog')
            dialog?.close()
            dialog?.remove()
        })
    })

    test('toolbar button click clears quick-toggle so subsequent Space starts fresh', async ({ page }) => {
        await page.keyboard.press('b')
        expect(await page.evaluate(() => window.layersApp._currentTool)).toBe('brush')

        // Quick tap Space into pan mode
        await page.keyboard.press('Space')
        await page.waitForTimeout(50)
        expect(await page.evaluate(() => window.layersApp._currentTool)).toBe('pan')

        // Explicitly click Hand tool button in toolbar to establish persistent mode
        await page.click('#handToolBtn')
        expect(await page.evaluate(() => window.layersApp._currentTool)).toBe('pan')
        expect(await page.evaluate(() => window.layersApp._spacePanToggled)).toBe(false)

        // Pressing Space should now start a new pan gesture rather than toggling back to brush
        await page.keyboard.down('Space')
        await page.waitForTimeout(50)
        expect(await page.evaluate(() => window.layersApp._currentTool)).toBe('pan')
        await page.keyboard.up('Space')
    })

    test('Spacebar is ignored while an active gesture is in-flight', async ({ page }) => {
        await page.keyboard.press('b')
        expect(await page.evaluate(() => window.layersApp._currentTool)).toBe('brush')

        // Simulate active brush drawing
        await page.evaluate(() => {
            if (window.layersApp._brushTool) {
                window.layersApp._brushTool._state = 'drawing'
            }
        })

        // Press Space - should be ignored
        await page.keyboard.press('Space')
        await page.waitForTimeout(50)
        expect(await page.evaluate(() => window.layersApp._currentTool)).toBe('brush')

        // Clean up mock
        await page.evaluate(() => {
            if (window.layersApp._brushTool) {
                window.layersApp._brushTool._state = 'idle'
            }
        })
    })
})
