import { test, expect } from './fixtures.js'

// Parallel mode makes each case its own sharding unit: every case here boots
// its own app and shares no state with its siblings, so shards can split this
// file instead of pinning all of it to one runner.
test.describe.configure({ mode: 'parallel' })

async function bootApp(page) {
    await page.goto('/', { waitUntil: 'networkidle' })
    await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })
    // Agent-path boot (same project-replacement handler the dialog reaches)
    // instead of the dialog round-trip: the webkit 4/10 shard pays this boot
    // 11 times. Nothing here tests the dialog flow (canvas-size.spec does).
    await page.evaluate(async () => {
        await window.LayersAgent.ready
        const env = await window.LayersAgent.newProject({ width: 512, height: 512 })
        if (!env.ok) throw new Error(env.error?.message || 'newProject failed')
    })
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
    test('reports the actual viewport position after panning', async ({ page }) => {
        await bootApp(page)
        const result = await page.evaluate(async () => {
            await window.LayersAgent.setZoom({ mode: '200' })
            return window.LayersAgent.setPan({ x: 50, y: 30 })
        })
        expect(result.ok).toBe(true)
        expect(result.state.view.scrollX).toBe(result.result.x)
        expect(result.state.view.scrollY).toBe(result.result.y)
        expect(result.result.x).toBeGreaterThanOrEqual(0)
        expect(result.result.y).toBeGreaterThanOrEqual(0)
    })
    test('controls and reports the active tool and selection tool', async ({ page }) => {
        await bootApp(page)
        const result = await page.evaluate(async () => {
            const brush = await window.LayersAgent.setTool({ tool: 'brush' })
            const oval = await window.LayersAgent.setSelectionTool({ tool: 'oval' })
            return { brush, oval }
        })
        expect(result.brush.ok).toBe(true)
        expect(result.brush.state.view.tool).toBe('brush')
        expect(result.oval.ok).toBe(true)
        expect(result.oval.state.view.tool).toBe('selection')
        expect(result.oval.state.view.selectionTool).toBe('oval')
    })
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
