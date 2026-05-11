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

test.describe('resizeImage', () => {
    test('changes canvas dimensions', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() =>
            window.LayersAgent.resizeImage({ width: 512, height: 384 }))
        expect(env.ok).toBe(true)
        expect(env.state.canvas).toEqual({ width: 512, height: 384 })
    })

    test('rejects oversized', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() =>
            window.LayersAgent.resizeImage({ width: 9999, height: 9999 }))
        expect(env.ok).toBe(false)
        expect(env.error.code).toBe('INVALID_ARGS_RANGE')
    })
})

test.describe('resizeCanvas', () => {
    test('changes canvas dimensions with default anchor', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() =>
            window.LayersAgent.resizeCanvas({ width: 1500, height: 1500 }))
        expect(env.ok).toBe(true)
        expect(env.state.canvas).toEqual({ width: 1500, height: 1500 })
    })

    test('honors anchor', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() =>
            window.LayersAgent.resizeCanvas({ width: 800, height: 600, anchor: 'top-left' }))
        expect(env.ok).toBe(true)
        expect(env.state.canvas).toEqual({ width: 800, height: 600 })
    })

    test('rejects unknown anchor', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() =>
            window.LayersAgent.resizeCanvas({ width: 800, height: 600, anchor: 'middle' }))
        expect(env.ok).toBe(false)
        expect(env.error.code).toBe('INVALID_ARGS_ENUM')
    })
})
