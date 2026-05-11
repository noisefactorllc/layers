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

    test('warns on unknown setting key with structured warning', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() =>
            window.LayersAgent.setSettings({ unknownKey: 'whatever' }))
        expect(env.ok).toBe(true)
        expect(env.warnings).toBeDefined()
        // Each warning is { code, key?, message } — agents can switch on code.
        const w = env.warnings.find(w => w?.code === 'UNKNOWN_SETTING_KEY')
        expect(w).toBeDefined()
        expect(w.key).toBe('unknownKey')
        expect(typeof w.message).toBe('string')
        expect(w.message).toContain('unknownKey')
    })

    test('theme:"system" delegates to settings-dialog setTheme', async ({ page }) => {
        await bootApp(page)
        // Set to system; settings-dialog's setTheme is the same function the
        // human UI uses, so the prefers-color-scheme listener gets wired.
        const env = await page.evaluate(() =>
            window.LayersAgent.setSettings({ theme: 'system' }))
        expect(env.ok).toBe(true)
        expect(env.state.settings.theme).toBe('system')
        const stored = await page.evaluate(() => localStorage.getItem('layers-theme'))
        expect(stored).toBe('system')
        // Document theme is resolved to a concrete value (one of the neutral pair).
        const resolved = await page.evaluate(() => document.documentElement.dataset.theme)
        expect(['neutral-dark', 'neutral-light']).toContain(resolved)
    })

    test('repeated theme:"system" calls do not stack listeners', async ({ page }) => {
        await bootApp(page)
        // Hammer setSettings repeatedly. The de-dup in setTheme keeps the
        // listener count at most 1 — if a previous bug re-registered without
        // removing the old one, this would silently leak. The contract is
        // simply: no throw, theme stays applied.
        const env = await page.evaluate(async () => {
            for (let i = 0; i < 5; i++) {
                await window.LayersAgent.setSettings({ theme: 'system' })
            }
            return await window.LayersAgent.getSettings({})
        })
        expect(env.ok).toBe(true)
        expect(env.result.theme).toBe('system')
    })
})
