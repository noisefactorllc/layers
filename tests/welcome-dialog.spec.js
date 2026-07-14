import { test, expect } from 'playwright/test'

// The first-run welcome splash is suppressed under the Playwright webdriver
// flag; `?welcome=1` opts it back in so these tests exercise the real
// first-run path.
async function boot(page, query = '') {
    await page.goto('/' + query, { waitUntil: 'networkidle' })
    await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })
}

test.describe('Welcome dialog', () => {
    test('auto-shows on first run (forced); open dialog suppressed', async ({ page }) => {
        await boot(page, '?welcome=1')
        await expect(page.locator('.welcome-dialog[open]')).toBeVisible()
        expect(await page.locator('.open-dialog-backdrop.visible').count()).toBe(0)
        await expect(page.locator('.welcome-tile[data-action="new"]')).toBeVisible()
        await expect(page.locator('.welcome-tile[data-action="open"]')).toBeVisible()
    })

    test('"don\'t show again" persists and skips welcome next load', async ({ page }) => {
        await boot(page, '?welcome=1')
        await page.locator('.welcome-dialog[open]').waitFor()
        await page.locator('#welcome-dontshow').check()
        await page.locator('.welcome-close').click()

        await boot(page, '?welcome=1')
        expect(await page.locator('.welcome-dialog[open]').count()).toBe(0)
        await expect(page.locator('.open-dialog-backdrop.visible')).toBeVisible()
    })

    test('closing without choosing falls through to the open dialog', async ({ page }) => {
        await boot(page, '?welcome=1')
        await page.locator('.welcome-dialog[open]').waitFor()
        await page.locator('.welcome-close').click()
        await expect(page.locator('.open-dialog-backdrop.visible')).toBeVisible()
    })

    test('re-opens from the logo menu', async ({ page }) => {
        await boot(page, '?welcome=1')
        await page.locator('.welcome-dialog[open]').waitFor()
        await page.locator('.welcome-close').click()
        await page.evaluate(() => document.getElementById('welcomeMenuItem').click())
        await expect(page.locator('.welcome-dialog[open]')).toBeVisible()
    })
})
