import { test, expect } from 'playwright/test'

async function bootApp(page) {
    await page.goto('/', { waitUntil: 'networkidle' })
    await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })
    await page.evaluate(async () => { await window.LayersAgent.ready })
    const visible = await page.evaluate(() => !!document.querySelector('.open-dialog-backdrop.visible'))
    if (visible) {
        await page.click('.media-option[data-type="solid"]')
        await page.waitForSelector('.canvas-size-dialog', { timeout: 5000 })
        await page.click('.canvas-size-dialog .action-btn.primary')
        await page.waitForSelector('.open-dialog-backdrop.visible', { state: 'hidden', timeout: 5000 })
    }
}

test.describe('auto-adjust commands', () => {
    test('autoLevels runs without error', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() => window.LayersAgent.autoLevels())
        expect(env.ok).toBe(true)
    })

    test('autoContrast runs without error', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() => window.LayersAgent.autoContrast())
        expect(env.ok).toBe(true)
    })

    test('autoWhiteBalance runs without error', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() => window.LayersAgent.autoWhiteBalance())
        expect(env.ok).toBe(true)
    })
})
