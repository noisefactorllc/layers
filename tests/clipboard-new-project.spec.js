import { test, expect } from 'playwright/test'

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

        await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])

        await page.click('.media-option[data-type="media"]')
        await page.click('#open-clipboard-btn')

        const toast = page.locator('.toast-message')
        await expect(toast).toBeVisible({ timeout: 5000 })
        await expect(toast).toContainText('No image found in clipboard')
    })

    test('clicking clipboard with image creates project at correct dimensions', async ({ page }) => {
        await page.goto('/', { waitUntil: 'networkidle' })
        await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })

        await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])

        // Write a 200x100 image to clipboard
        await page.evaluate(async () => {
            const canvas = document.createElement('canvas')
            canvas.width = 200
            canvas.height = 100
            const ctx = canvas.getContext('2d')
            ctx.fillStyle = 'red'
            ctx.fillRect(0, 0, 200, 100)
            const blob = await new Promise(r => canvas.toBlob(r, 'image/png'))
            await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
        })

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
