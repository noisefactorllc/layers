import { test, expect } from 'playwright/test'
import path from 'node:path'

// The first-run welcome splash is suppressed under the Playwright webdriver
// flag; `?welcome=1` opts it back in so these tests exercise the real
// first-run path.
async function boot(page, query = '') {
    await page.goto('/' + query, { waitUntil: 'networkidle' })
    await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })
}

async function createProjectFromWelcome(page, type = 'solid') {
    await page.locator('.welcome-tile[data-action="new"]').click()
    await page.locator('.open-dialog-backdrop.visible').waitFor()
    await page.locator(`.media-option[data-type="${type}"]`).click()
    await page.locator('.canvas-size-dialog .action-btn.primary').click()
    await page.locator('.open-dialog-backdrop.visible').waitFor({ state: 'hidden' })
}

async function reopenWelcome(page) {
    await page.evaluate(() => document.getElementById('welcomeMenuItem').click())
    await page.locator('.welcome-dialog[open]').waitFor()
}

async function layerIds(page) {
    return page.evaluate(() => window.layersApp._layers.map(layer => layer.id))
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

    for (const action of ['new', 'open']) {
        test(`${action} tile cancellation preserves a dirty project and stops replacement`, async ({ page }) => {
            await boot(page, '?welcome=1')
            await createProjectFromWelcome(page)
            const before = await layerIds(page)
            let fileChooserOpened = false
            page.on('filechooser', () => { fileChooserOpened = true })

            await reopenWelcome(page)
            await page.locator(`.welcome-tile[data-action="${action}"]`).click()
            const confirm = page.locator('.confirm-dialog-backdrop.visible')
            await expect(confirm.locator('.confirm-message')).toHaveText(
                'You have unsaved changes. Discard them?')
            await confirm.locator('#confirm-cancel').click()

            expect(await layerIds(page)).toEqual(before)
            await expect(page.locator('.open-dialog-backdrop.visible')).toHaveCount(0)
            expect(fileChooserOpened).toBe(false)
        })
    }

    test('accepted Welcome replacement takes an online project offline first', async ({ page }) => {
        await boot(page, '?welcome=1')
        await createProjectFromWelcome(page)
        await page.evaluate(() => {
            window.__welcomeWentOffline = false
            window.layersApp._onlineAdapter = {
                isOnline: () => true,
                goOffline: () => { window.__welcomeWentOffline = true },
            }
        })

        await reopenWelcome(page)
        await page.locator('.welcome-tile[data-action="new"]').click()
        const confirm = page.locator('.confirm-dialog-backdrop.visible')
        await expect(confirm.locator('.confirm-message')).toHaveText(
            'This will take your Layers session offline. Continue?')
        await confirm.locator('#confirm-ok').click()
        await expect(confirm.locator('.confirm-message')).toHaveText(
            'You have unsaved changes. Discard them?')
        await confirm.locator('#confirm-ok').click()

        expect(await page.evaluate(() => window.__welcomeWentOffline)).toBe(true)
        await expect(page.locator('.open-dialog-backdrop.visible')).toBeVisible()
    })

    test('Open file replacement unloads the prior media resource', async ({ page }) => {
        await boot(page, '?welcome=1')
        const initialChooserPromise = page.waitForEvent('filechooser')
        await page.locator('.welcome-tile[data-action="open"]').click()
        let chooser = await initialChooserPromise
        await chooser.setFiles(path.resolve('public/img/og-image.png'))
        await expect.poll(() => page.evaluate(() => window.layersApp._layers.length)).toBe(1)
        const oldId = (await layerIds(page))[0]
        await page.evaluate(() => {
            window.__welcomeUnloadedMedia = []
            const unloadMedia = window.layersApp._renderer.unloadMedia.bind(window.layersApp._renderer)
            window.layersApp._renderer.unloadMedia = (id) => {
                window.__welcomeUnloadedMedia.push(id)
                return unloadMedia(id)
            }
        })

        await reopenWelcome(page)
        const chooserPromise = page.waitForEvent('filechooser')
        await page.locator('.welcome-tile[data-action="open"]').click()
        const confirm = page.locator('.confirm-dialog-backdrop.visible')
        await confirm.locator('#confirm-ok').click()
        chooser = await chooserPromise
        await chooser.setFiles(path.resolve('public/img/og-image.png'))
        await expect.poll(() => page.evaluate(() => window.__welcomeUnloadedMedia)).toContain(oldId)
    })

    test('short viewport keeps both tiles and Close reachable', async ({ page }) => {
        await page.setViewportSize({ width: 390, height: 320 })
        await boot(page, '?welcome=1')
        const dialog = page.locator('.welcome-dialog[open]')
        expect(await dialog.evaluate(el => getComputedStyle(el).overflowY)).toBe('auto')

        for (const control of [
            page.locator('.welcome-tile[data-action="new"]'),
            page.locator('.welcome-tile[data-action="open"]'),
            page.locator('.welcome-close'),
        ]) {
            await control.scrollIntoViewIfNeeded()
            await expect(control).toBeVisible()
            await expect(control).toBeInViewport()
        }
    })

    test('Close button includes its Material Symbol and visible label', async ({ page }) => {
        await boot(page, '?welcome=1')
        const close = page.locator('.welcome-close')
        await expect(close.locator('.icon-material')).toHaveText('close')
        await expect(close).toContainText('Close')
    })
})
