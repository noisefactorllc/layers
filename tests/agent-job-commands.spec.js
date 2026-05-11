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

test.describe('LayersAgent job stubs', () => {
    test('getJob returns NOT_FOUND_JOB', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() =>
            window.LayersAgent.getJob({ jobId: 'job-x' })
        )
        expect(env.ok).toBe(false)
        expect(env.error.code).toBe('NOT_FOUND_JOB')
    })

    test('waitForJob returns NOT_FOUND_JOB', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() =>
            window.LayersAgent.waitForJob({ jobId: 'job-x' })
        )
        expect(env.ok).toBe(false)
        expect(env.error.code).toBe('NOT_FOUND_JOB')
    })

    test('cancelJob returns NOT_FOUND_JOB', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() =>
            window.LayersAgent.cancelJob({ jobId: 'job-x' })
        )
        expect(env.ok).toBe(false)
        expect(env.error.code).toBe('NOT_FOUND_JOB')
    })
})
