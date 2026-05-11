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

test.describe('setForegroundColor', () => {
    test('updates the agent-visible color', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() =>
            window.LayersAgent.setForegroundColor({ color: '#abcdef' }))
        expect(env.ok).toBe(true)
        expect(env.state.foreground.color).toBe('#abcdef')
    })

    test('rejects malformed color', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() =>
            window.LayersAgent.setForegroundColor({ color: 'not-a-color' }))
        expect(env.ok).toBe(false)
        expect(env.error.code).toBe('INVALID_ARGS_TYPE')
    })
})

test.describe('setZoom', () => {
    test('sets zoom mode to 100', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() =>
            window.LayersAgent.setZoom({ mode: '100' }))
        expect(env.ok).toBe(true)
        expect(env.state.view.zoomMode).toBe('100')
    })

    test('rejects unknown mode', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() =>
            window.LayersAgent.setZoom({ mode: '300' }))
        expect(env.ok).toBe(false)
        expect(env.error.code).toBe('INVALID_ARGS_ENUM')
    })
})

test.describe('play / pause', () => {
    test('pause stops the renderer', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() => window.LayersAgent.pause())
        expect(env.ok).toBe(true)
        expect(env.state.view.isPlaying).toBe(false)
    })

    test('play restarts the renderer after pause', async ({ page }) => {
        await bootApp(page)
        await page.evaluate(() => window.LayersAgent.pause())
        const env = await page.evaluate(() => window.LayersAgent.play())
        expect(env.ok).toBe(true)
        expect(env.state.view.isPlaying).toBe(true)
    })
})

test.describe('setSettings', () => {
    test('persists theme', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() =>
            window.LayersAgent.setSettings({ theme: 'gray-dark' }))
        expect(env.ok).toBe(true)
        expect(env.state.settings.theme).toBe('gray-dark')
        const stored = await page.evaluate(() => localStorage.getItem('layers-theme'))
        expect(stored).toBe('gray-dark')
    })

    test('rejects unknown theme', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() =>
            window.LayersAgent.setSettings({ theme: 'totally-made-up' }))
        expect(env.ok).toBe(false)
        expect(env.error.code).toBe('INVALID_ARGS_ENUM')
    })

    test('warns on unknown setting key', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() =>
            window.LayersAgent.setSettings({ unknownKey: 'whatever' }))
        expect(env.ok).toBe(true)
        expect(env.warnings).toBeDefined()
        expect(env.warnings.some(w => w.includes('unknownKey'))).toBe(true)
    })
})
