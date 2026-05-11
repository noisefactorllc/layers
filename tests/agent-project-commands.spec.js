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

test.describe('LayersAgent project & settings inspection', () => {
    test('getProjectInfo returns id/name/dirty/undo state', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() => window.LayersAgent.getProjectInfo())
        expect(env.ok).toBe(true)
        expect(env.result).toMatchObject({
            id: null,
            isDirty: expect.any(Boolean),
            canUndo: expect.any(Boolean),
            canRedo: expect.any(Boolean),
            canSaveAs: true
        })
    })

    test('listProjects returns an array', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() => window.LayersAgent.listProjects())
        expect(env.ok).toBe(true)
        expect(Array.isArray(env.result.projects)).toBe(true)
    })

    test('getSettings returns an object with the theme', async ({ page }) => {
        await bootApp(page)
        // Set the theme via the same key the human UI uses, then verify the agent sees it.
        await page.evaluate(() => localStorage.setItem('layers-theme', 'gray'))
        const env = await page.evaluate(() => window.LayersAgent.getSettings())
        expect(env.ok).toBe(true)
        expect(typeof env.result).toBe('object')
        expect(env.result.theme).toBe('gray')
    })

    test('getForegroundColor returns a hex color', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() => window.LayersAgent.getForegroundColor())
        expect(env.ok).toBe(true)
        expect(env.result.color).toMatch(/^#[0-9a-fA-F]{6}$/)
    })
})
