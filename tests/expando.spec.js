import { test, expect } from './fixtures.js'
import { appReady } from './waits.js'

async function createTransparentProject(page) {
    await page.waitForSelector('.open-dialog-backdrop.visible')
    await page.click('.media-option[data-type="transparent"]')
    await page.waitForSelector('.canvas-size-dialog', { timeout: 5000 })
    await page.click('.canvas-size-dialog .action-btn.primary')
    await page.waitForSelector('.open-dialog-backdrop.visible', { state: 'hidden', timeout: 5000 })
    await appReady(page)
}

async function addEffectLayer(page, searchTerm) {
    await page.click('#addLayerBtn')
    await page.waitForSelector('dialog[open]')
    await page.click('.media-option[data-mode="effect"]')
    await page.waitForSelector('.effect-search-input')
    await page.fill('.effect-search-input', searchTerm)
    // The picker filters and re-renders on the input event itself, and the
    // unfiltered view renders no .effect-item at all, so the first one to
    // appear belongs to this search. The selector wait below is the condition.
    await page.waitForSelector('.effect-item')
    await page.click('.effect-item')
    await page.waitForSelector('dialog[open]', { state: 'hidden' })
}

test.describe('Layer params expando', () => {
    test('expando toggle toggles expanded state on layer item', async ({ page }) => {
        await page.goto('/', { waitUntil: 'networkidle' })
        await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })
        await createTransparentProject(page)
        await addEffectLayer(page, 'blur')

        const layerItem = page.locator('layer-item.effect-layer:not(.base-layer)')
        await expect(layerItem).toBeVisible()

        const toggleBtn = layerItem.locator('.layer-params-toggle')
        await expect(toggleBtn).toBeVisible()

        // Initially collapsed
        await expect(layerItem).not.toHaveClass(/params-expanded/)
        await expect(toggleBtn).not.toHaveClass(/expanded/)

        const effectParams = layerItem.locator('effect-params')
        await expect(effectParams).toBeAttached()

        // Expand
        await toggleBtn.click()
        await expect(layerItem).toHaveClass(/params-expanded/)
        await expect(toggleBtn).toHaveClass(/expanded/)

        // Collapse
        await toggleBtn.click()
        await expect(layerItem).not.toHaveClass(/params-expanded/)
        await expect(toggleBtn).not.toHaveClass(/expanded/)
    })

    test('effect-params shows actual parameters when expanded', async ({ page }) => {
        await page.goto('/', { waitUntil: 'networkidle' })
        await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })
        await createTransparentProject(page)
        await addEffectLayer(page, 'warp')

        const layerItem = page.locator('layer-item.effect-layer:not(.base-layer)')
        await expect(layerItem).toBeVisible()

        const toggleBtn = layerItem.locator('.layer-params-toggle')
        await expect(toggleBtn).toBeVisible()

        await toggleBtn.click()
        await expect(layerItem).toHaveClass(/params-expanded/)

        const effectParams = layerItem.locator('effect-params')
        // setEffect() fetches the effect definition asynchronously and paints a
        // "Loading parameters..." placeholder first. That placeholder carries no
        // `empty` class either, so the class assertion below would read the
        // loading state as a finished render. Wait for the controls themselves.
        await effectParams.locator('.effect-params-controls').waitFor({ state: 'attached' })

        await expect(effectParams).toBeVisible()
        await expect(effectParams).not.toHaveClass(/empty/)

        await expect(effectParams.locator('.control-group').first()).toBeVisible()
        expect(await effectParams.locator('.control-label').count()).toBeGreaterThan(0)
        expect(await effectParams.locator('slider-value').count()).toBeGreaterThan(0)

        // Collapse and verify hidden
        await toggleBtn.click()
        await expect(layerItem).not.toHaveClass(/params-expanded/)
        await expect(effectParams).not.toBeVisible()
    })
})
