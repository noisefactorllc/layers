import { test, expect } from './fixtures.js'
import { seedClipboardRead } from './helpers/clipboard.js'

test.describe('New from Clipboard', () => {
    test('clipboard button is available on media pane', async ({ page }) => {
        await page.goto('/', { waitUntil: 'networkidle' })
        await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })

        // Click Media to go to media pane
        await page.click('.media-option[data-type="media"]')

        const clipboardBtn = page.locator('#open-clipboard-btn')
        await expect(clipboardBtn).toBeVisible()
        await expect(clipboardBtn).toContainText('Paste from Clipboard')
    })

    test('clicking clipboard with no image shows error toast', async ({ page }) => {
        await page.goto('/', { waitUntil: 'networkidle' })
        await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })

        await seedClipboardRead(page)

        await page.click('.media-option[data-type="media"]')
        await page.click('#open-clipboard-btn')

        const toast = page.locator('.toast-message')
        await expect(toast).toBeVisible({ timeout: 5000 })
        await expect(toast).toContainText('No image found in clipboard')
    })

    test('clicking clipboard with image creates project at correct dimensions', async ({ page }) => {
        await page.goto('/', { waitUntil: 'networkidle' })
        await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })

        await seedClipboardRead(page, { width: 200, height: 100, color: 'red' })

        await page.click('.media-option[data-type="media"]')
        await page.click('#open-clipboard-btn')

        // Dialog should close
        const backdrop = page.locator('.open-dialog-backdrop.visible')
        await expect(backdrop).toBeHidden({ timeout: 10000 })

        // Canvas should match clipboard image dimensions
        const dims = await page.evaluate(() => {
            const c = document.getElementById('canvas')
            return { width: c.width, height: c.height }
        })
        expect(dims.width).toBe(200)
        expect(dims.height).toBe(100)
    })
})
