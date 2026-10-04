import { test, expect } from './fixtures.js'
import { appReady, defaultProjectReady } from './waits.js'

const COLOR_STORAGE_KEY = 'layers-foreground-color'

// Plain boot on the default canvas: no project setup is needed to exercise
// the color well, and the reload must be an ordinary reload, not one that
// replaces project state.
async function boot(page) {
    await page.goto('/', { waitUntil: 'networkidle' })
    await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })
    await appReady(page)
    await defaultProjectReady(page)
}

async function readForeground(page) {
    return page.evaluate(() => ({
        app: window.layersApp._foregroundColor,
        well: document.getElementById('colorWell').style.backgroundColor,
        input: document.getElementById('colorWellInput').value,
    }))
}

// Set the color through the real input-event path (same as the color well's
// own listener wiring), not by calling the private setter directly.
async function pickColor(page, color) {
    await page.evaluate((value) => {
        const input = document.getElementById('colorWellInput')
        input.value = value
        input.dispatchEvent(new Event('input'))
    }, color)
}

test.describe('Foreground color persistence', () => {
    test('a picked foreground color survives a reload', async ({ page }) => {
        await boot(page)
        await pickColor(page, '#3366cc')

        expect(await page.evaluate(() => window.layersApp._foregroundColor))
            .toBe('#3366cc')
        expect(await page.evaluate(
            (key) => localStorage.getItem(key), COLOR_STORAGE_KEY))
            .toBe('#3366cc')

        await page.reload()
        await boot(page)

        const restored = await readForeground(page)
        expect(restored.app).toBe('#3366cc')
        expect(restored.input).toBe('#3366cc')
        expect(restored.well).toMatch(/#3366cc|rgb\(51, 102, 204\)/i)
    })

    test('a persisted color is read at startup without any interaction', async ({ page }) => {
        // Seed the key the color well writes, then boot. The restore must
        // come from storage alone: nothing sets the color in this session.
        await page.addInitScript((key) => {
            localStorage.setItem(key, '#204080')
        }, COLOR_STORAGE_KEY)
        await boot(page)

        const restored = await readForeground(page)
        expect(restored.app).toBe('#204080')
        expect(restored.input).toBe('#204080')
        expect(restored.well).toMatch(/#204080|rgb\(32, 64, 128\)/i)
    })

    test('a corrupt stored value keeps the black default', async ({ page }) => {
        await page.addInitScript((key) => {
            localStorage.setItem(key, 'not-a-color')
        }, COLOR_STORAGE_KEY)
        await boot(page)

        const restored = await readForeground(page)
        expect(restored.app).toBe('#000000')
        expect(restored.input).toBe('#000000')
    })

    test('theme persistence keeps working and stays independent of the color', async ({ page }) => {
        await boot(page)

        // Both through real app paths: setSettings delegates to
        // settings-dialog's setTheme; the well goes through its input event.
        await page.evaluate(() =>
            window.LayersAgent.setSettings({ theme: 'gray-dark' }))
        await pickColor(page, '#ff8800')

        await page.reload()
        await boot(page)

        const theme = await page.evaluate(() => ({
            stored: localStorage.getItem('layers-theme'),
            applied: document.documentElement.dataset.theme,
        }))
        expect(theme.stored).toBe('gray-dark')
        expect(theme.applied).toBe('gray-dark')

        const restored = await readForeground(page)
        expect(restored.app).toBe('#ff8800')
        expect(restored.input).toBe('#ff8800')
    })
})
