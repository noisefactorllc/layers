import { test, expect } from './fixtures.js'
import { reopenNewProjectDialog } from './helpers/new-project.js'

async function bootApp(page) {
    await page.goto('/')
    await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 30000 })
    await page.evaluate(async () => { await window.LayersAgent.ready })
    await reopenNewProjectDialog(page)
    await page.click('.media-option[data-type="solid"]')
    await page.waitForSelector('.canvas-size-dialog', { timeout: 15000 })
    await page.click('.canvas-size-dialog .action-btn.primary')
    await page.waitForSelector('.open-dialog-backdrop.visible', { state: 'hidden', timeout: 15000 })
}

test.describe('Slider Undo/Redo Debounce Hygiene', () => {
    test('debounces rapid drags, suppresses mid-drag timer splits, deduplicates no-op drags, and commits discrete changes', async ({ page }) => {
        test.slow()

        await bootApp(page)

        // Add a test layer for slider interaction
        await page.evaluate(() =>
            window.LayersAgent.addLayer({ kind: 'effect', effectId: 'synth/gradient' }))

        // -------------------------------------------------------------
        // Scenario 1: Rapid scrubbing commits a single undo entry on pointer release
        // -------------------------------------------------------------
        const initialStackLen = await page.evaluate(() => window.layersApp._undoManager._stack.length)
        const initialOpacity = await page.evaluate(() => window.layersApp._getActiveLayer().opacity)
        expect(initialOpacity).toBe(100)

        await page.evaluate(async () => {
            const layerItem = document.querySelector('layer-item:not(.base-layer)')
            const slider = layerItem?.querySelector('.layer-opacity')
            const nativeInput = slider?.shadowRoot?.querySelector('input[type="range"]') || slider?.querySelector('input[type="range"]') || slider

            // Pointerdown to start gesture
            nativeInput.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, composed: true }))

            // Scrub across multiple values rapidly
            for (const val of [75, 40]) {
                slider.value = val
                slider.dispatchEvent(new Event('input', { bubbles: true, composed: true }))
            }

            // Pointerup to finish gesture
            window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, composed: true }))
        })

        await page.waitForFunction(() => window.layersApp._undoPending === false)

        expect(await page.evaluate(() => window.layersApp._getActiveLayer().opacity)).toBe(40)
        expect(await page.evaluate(() => window.layersApp._undoManager._stack.length)).toBe(initialStackLen + 1)

        // Undo returns to 100
        await page.evaluate(() => window.LayersAgent.undo())
        expect(await page.evaluate(() => window.layersApp._getActiveLayer().opacity)).toBe(100)

        // Redo returns to 40
        await page.evaluate(() => window.LayersAgent.redo())
        expect(await page.evaluate(() => window.layersApp._getActiveLayer().opacity)).toBe(40)

        // -------------------------------------------------------------
        // Scenario 2: Pausing mid-drag (beyond 500ms debounce) does NOT split gesture
        // -------------------------------------------------------------
        const stackLenBeforePause = await page.evaluate(() => window.layersApp._undoManager._stack.length)

        await page.evaluate(async () => {
            const layerItem = document.querySelector('layer-item:not(.base-layer)')
            const slider = layerItem?.querySelector('.layer-opacity')
            const nativeInput = slider?.shadowRoot?.querySelector('input[type="range"]') || slider?.querySelector('input[type="range"]') || slider

            nativeInput.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, composed: true }))

            slider.value = 60
            slider.dispatchEvent(new Event('input', { bubbles: true, composed: true }))

            // Pause for 600ms while pointer is still held down
            await new Promise(r => setTimeout(r, 600))

            slider.value = 80
            slider.dispatchEvent(new Event('input', { bubbles: true, composed: true }))

            window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, composed: true }))
        })

        await page.waitForFunction(() => window.layersApp._undoPending === false)

        expect(await page.evaluate(() => window.layersApp._getActiveLayer().opacity)).toBe(80)
        // Must be exactly one additional undo snapshot, not split into multiple
        expect(await page.evaluate(() => window.layersApp._undoManager._stack.length)).toBe(stackLenBeforePause + 1)

        // Undo returns to 40 (the state before this drag started)
        await page.evaluate(() => window.LayersAgent.undo())
        expect(await page.evaluate(() => window.layersApp._getActiveLayer().opacity)).toBe(40)

        // Redo back to 80
        await page.evaluate(() => window.LayersAgent.redo())
        expect(await page.evaluate(() => window.layersApp._getActiveLayer().opacity)).toBe(80)

        // -------------------------------------------------------------
        // Scenario 3: No-op drag (scrubbing away and back to original value)
        //             produces zero redundant undo entries
        // -------------------------------------------------------------
        const stackLenBeforeNoOp = await page.evaluate(() => window.layersApp._undoManager._stack.length)

        await page.evaluate(async () => {
            const layerItem = document.querySelector('layer-item:not(.base-layer)')
            const slider = layerItem?.querySelector('.layer-opacity')
            const nativeInput = slider?.shadowRoot?.querySelector('input[type="range"]') || slider?.querySelector('input[type="range"]') || slider

            nativeInput.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, composed: true }))

            slider.value = 50
            slider.dispatchEvent(new Event('input', { bubbles: true, composed: true }))

            slider.value = 80
            slider.dispatchEvent(new Event('input', { bubbles: true, composed: true }))

            window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, composed: true }))
        })

        await page.waitForFunction(() => window.layersApp._undoPending === false)

        expect(await page.evaluate(() => window.layersApp._getActiveLayer().opacity)).toBe(80)
        // Snapshot deduplication prevents duplicate entry
        expect(await page.evaluate(() => window.layersApp._undoManager._stack.length)).toBe(stackLenBeforeNoOp)

        // -------------------------------------------------------------
        // Scenario 4: Discrete change event (e.g. keyboard navigation) commits immediately
        // -------------------------------------------------------------
        const stackLenBeforeDiscrete = await page.evaluate(() => window.layersApp._undoManager._stack.length)

        await page.evaluate(() => {
            const layerItem = document.querySelector('layer-item:not(.base-layer)')
            const slider = layerItem?.querySelector('.layer-opacity')

            slider.value = 50
            slider.dispatchEvent(new Event('input', { bubbles: true, composed: true }))
            slider.dispatchEvent(new Event('change', { bubbles: true, composed: true }))
        })

        await page.waitForFunction(() => window.layersApp._undoPending === false)

        expect(await page.evaluate(() => window.layersApp._getActiveLayer().opacity)).toBe(50)
        expect(await page.evaluate(() => window.layersApp._undoManager._stack.length)).toBe(stackLenBeforeDiscrete + 1)

        // Undo returns to 80
        await page.evaluate(() => window.LayersAgent.undo())
        expect(await page.evaluate(() => window.layersApp._getActiveLayer().opacity)).toBe(80)
    })
})
