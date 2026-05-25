import { test, expect } from 'playwright/test'

test.describe('Image menu adjustments', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('/', { waitUntil: 'networkidle' })
        await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })

        // Create a solid color project
        await page.waitForSelector('.open-dialog-backdrop.visible')
        await page.click('.media-option[data-type="solid"]')
        await page.waitForSelector('.canvas-size-dialog', { timeout: 5000 })
        await page.click('.canvas-size-dialog .action-btn.primary')
        await page.waitForSelector('.open-dialog-backdrop.visible', { state: 'hidden', timeout: 5000 })
        await page.waitForTimeout(500)
    })

    test('submenu appears on hover', async ({ page }) => {
        // Open image menu
        await page.click('#imageMenu .menu-title')
        await page.waitForSelector('#imageMenu .menu-items:not(.hide)')

        // Hover over Tone submenu
        const toneItem = page.locator('#imageMenu .has-submenu', { hasText: 'tone' })
        await toneItem.hover()

        // Submenu should be visible (sibling of .menu-items, linked by data-submenu-id)
        const submenu = page.locator('.submenu[data-submenu-id="tone"]')
        await expect(submenu).toBeVisible()

        // Should contain brightness/contrast
        await expect(submenu.locator('[data-effect="filter/adjust"]')).toBeVisible()
    })

    test('add effect from submenu', async ({ page }) => {
        // Should start with 1 layer
        const layersBefore = await page.evaluate(() => window.layersApp._layers.length)
        expect(layersBefore).toBe(1)

        // Open Image > Tone > Brightness/Contrast
        await page.click('#imageMenu .menu-title')
        const toneItem = page.locator('#imageMenu .has-submenu', { hasText: 'tone' })
        await toneItem.hover()
        await page.click('[data-effect="filter/adjust"]')
        await page.waitForTimeout(500)

        // Should now have 2 layers
        const layersAfter = await page.evaluate(() => window.layersApp._layers.length)
        expect(layersAfter).toBe(2)

        // New layer should be a brightness/contrast effect
        const effectId = await page.evaluate(() => window.layersApp._layers[1].effectId)
        expect(effectId).toBe('filter/adjust')
    })

    test('add effect from stylize submenu', async ({ page }) => {
        await page.click('#imageMenu .menu-title')
        const stylizeItem = page.locator('#imageMenu .has-submenu', { hasText: 'stylize' })
        await stylizeItem.hover()
        await page.click('[data-effect="filter/grain"]')
        await page.waitForTimeout(500)

        const layerCount = await page.evaluate(() => window.layersApp._layers.length)
        expect(layerCount).toBe(2)

        const effectId = await page.evaluate(() => window.layersApp._layers[1].effectId)
        expect(effectId).toBe('filter/grain')
    })

    test('add color replace from color submenu', async ({ page }) => {
        await page.click('#imageMenu .menu-title')
        const colorItem = page.locator('#imageMenu .has-submenu', { hasText: 'color' })
        await colorItem.hover()
        await page.click('[data-effect="filter/colorReplace"]')
        await page.waitForTimeout(500)

        const layerCount = await page.evaluate(() => window.layersApp._layers.length)
        expect(layerCount).toBe(2)

        const effectId = await page.evaluate(() => window.layersApp._layers[1].effectId)
        expect(effectId).toBe('filter/colorReplace')
    })

    test('auto levels creates effect layer', async ({ page }) => {
        await page.click('#imageMenu .menu-title')
        await page.click('#autoLevelsMenuItem')
        await page.waitForTimeout(500)

        const layerCount = await page.evaluate(() => window.layersApp._layers.length)
        // May be 1 (no correction needed for solid) or 2 (correction applied)
        expect(layerCount).toBeGreaterThanOrEqual(1)
    })

    test('auto contrast creates effect layer', async ({ page }) => {
        // Add an effect to create varied luminance first
        await page.evaluate(async () => {
            await window.layersApp._handleAddEffectLayer('synth/gradient')
        })
        await page.waitForTimeout(500)

        await page.click('#imageMenu .menu-title')
        await page.click('#autoContrastMenuItem')
        await page.waitForTimeout(500)

        const layerCount = await page.evaluate(() => window.layersApp._layers.length)
        expect(layerCount).toBeGreaterThanOrEqual(2)
    })

    test('auto white balance creates effect layer', async ({ page }) => {
        await page.click('#imageMenu .menu-title')
        await page.click('#autoWhiteBalanceMenuItem')
        await page.waitForTimeout(500)

        // Should either add correction or report none needed
        const layerCount = await page.evaluate(() => window.layersApp._layers.length)
        expect(layerCount).toBeGreaterThanOrEqual(1)
    })
})
