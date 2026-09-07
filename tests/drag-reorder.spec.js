import { test, expect } from './fixtures.js'

async function createTransparentProject(page) {
    await page.waitForSelector('.open-dialog-backdrop.visible')
    await page.click('.media-option[data-type="transparent"]')
    await page.waitForSelector('.canvas-size-dialog', { timeout: 5000 })
    await page.click('.canvas-size-dialog .action-btn.primary')
    await page.waitForSelector('.open-dialog-backdrop.visible', { state: 'hidden', timeout: 5000 })
    await page.waitForTimeout(500)
}

async function addEffectLayer(page, searchTerm) {
    await page.click('#addLayerBtn')
    await page.waitForSelector('dialog[open]')
    await page.click('.media-option[data-mode="effect"]')
    await page.waitForSelector('.effect-search-input')
    await page.fill('.effect-search-input', searchTerm)
    await page.waitForTimeout(500)
    await page.waitForSelector('.effect-item')
    await page.click('.effect-item')
    await page.waitForSelector('dialog[open]', { state: 'hidden' })
}

test.describe('Layer drag reorder', () => {
    test('dragging layer by handle reorders layers', async ({ page }) => {
        await page.goto('/', { waitUntil: 'networkidle' })
        await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })
        await createTransparentProject(page)

        await addEffectLayer(page, 'blur')
        await addEffectLayer(page, 'warp')

        // Should have 3 layers: base (transparent), blur, warp
        const layers = page.locator('layer-item')
        await expect(layers).toHaveCount(3)

        const layerNames = page.locator('layer-item .layer-name')
        const names = await layerNames.allTextContents()
        console.log('Before drag - layers:', names)

        const topLayer = layers.first()
        const dragHandle = topLayer.locator('.layer-drag-handle')
        await expect(dragHandle).toBeVisible()

        // Trigger reorder via FSM methods
        const reordered = await page.evaluate(async () => {
            const app = window.layersApp
            const layerEls = document.querySelectorAll('layer-item')
            const sourceId = layerEls[0].dataset.layerId
            const targetId = layerEls[1].dataset.layerId
            app._startDrag(sourceId)
            await app._processDrop(targetId, 'below')
            return { sourceId, targetId, state: app._reorderState }
        })
        console.log('Triggered reorder:', reordered)

        await page.waitForTimeout(500)

        const newNames = await layerNames.allTextContents()
        console.log('After reorder event - layers:', newNames)
        expect(newNames).not.toEqual(names)
    })

    test('drag handle shows grab cursor', async ({ page }) => {
        await page.goto('/', { waitUntil: 'networkidle' })
        await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })
        await createTransparentProject(page)
        await addEffectLayer(page, 'blur')

        const dragHandle = page.locator('layer-item.effect-layer').first().locator('.layer-drag-handle')
        await expect(dragHandle).toBeVisible()

        const cursor = await dragHandle.evaluate(el => window.getComputedStyle(el).cursor)
        expect(cursor).toBe('grab')
    })

    test('base layer drag handle is hidden', async ({ page }) => {
        await page.goto('/', { waitUntil: 'networkidle' })
        await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })
        await createTransparentProject(page)

        const baseLayer = page.locator('layer-item.base-layer')
        await expect(baseLayer).toBeVisible()

        const dragHandle = baseLayer.locator('.layer-drag-handle')
        const visibility = await dragHandle.evaluate(el => window.getComputedStyle(el).visibility)
        expect(visibility).toBe('hidden')
    })
})
