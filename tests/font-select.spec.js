import { test, expect } from './fixtures.js'

test.describe('Font Select', () => {
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

        // Add a text layer
        await page.evaluate(async () => {
            await window.layersApp._handleAddEffectLayer('filter/text')
        })
        await page.waitForTimeout(500)

        // Expand the text layer params
        const layerItem = page.locator('layer-item.effect-layer:not(.base-layer)')
        const toggleBtn = layerItem.locator('.layer-params-toggle')
        await toggleBtn.click()
        await expect(layerItem).toHaveClass(/params-expanded/)
        await page.waitForTimeout(300)
    })

    test('text layer shows font-select component', async ({ page }) => {
        const fontSelect = page.locator('font-select')
        await expect(fontSelect).toBeVisible()
    })

    test('font-select shows base fonts when opened', async ({ page }) => {
        const fontSelect = page.locator('font-select')
        await fontSelect.locator('.select-trigger').click()

        // Should see Nunito in the options
        const nunitoOption = page.locator('.option[data-value="Nunito"]')
        await expect(nunitoOption).toBeVisible()

        // Should see system fonts
        const serifOption = page.locator('.option[data-value="serif"]')
        await expect(serifOption).toBeVisible()
    })

    test('font-select changes font parameter', async ({ page }) => {
        const fontSelect = page.locator('font-select')
        await fontSelect.locator('.select-trigger').click()

        // Select serif
        await page.click('.option[data-value="serif"]')

        // Verify the trigger now shows serif
        await expect(fontSelect.locator('.trigger-text')).toHaveText('serif')

        // Verify the effectParams were updated
        const font = await page.evaluate(() => {
            const layer = window.layersApp._layers.find(l => l.effectId === 'filter/text')
            return layer?.effectParams?.font
        })
        expect(font).toBe('serif')
    })

    test('font-select shows install button when bundle not installed', async ({ page }) => {
        const fontSelect = page.locator('font-select')
        await fontSelect.locator('.select-trigger').click()

        // Wait for the async install prompt to appear
        const installBtn = page.locator('.font-install-btn')
        await expect(installBtn).toBeVisible({ timeout: 3000 })
    })

    test('font-select search filters options', async ({ page }) => {
        const fontSelect = page.locator('font-select')
        await fontSelect.locator('.select-trigger').click()

        // Type in search
        await page.fill('.search-input', 'mono')

        // Should show monospace, hide others
        const monoOption = page.locator('.option[data-value="monospace"]')
        await expect(monoOption).toBeVisible()

        const serifOption = page.locator('.option[data-value="serif"]')
        await expect(serifOption).not.toBeVisible()
    })
})
