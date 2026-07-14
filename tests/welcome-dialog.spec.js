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

async function installRejectedMediaLoad(page) {
    await page.evaluate(() => {
        window.__welcomeUnloadedMedia = []
        const app = window.layersApp
        const unloadMedia = app._renderer.unloadMedia.bind(app._renderer)
        app._renderer.loadMedia = async () => { throw new Error('undecodable test media') }
        app._renderer.unloadMedia = (id) => {
            window.__welcomeUnloadedMedia.push(id)
            return unloadMedia(id)
        }
    })
}

async function chooseBrokenPng(chooser) {
    await chooser.setFiles({
        name: 'broken.png',
        mimeType: 'image/png',
        buffer: Buffer.from('not a png'),
    })
}

test.describe('Welcome dialog', () => {
    test('auto-shows on first run (forced); open dialog suppressed', async ({ page }) => {
        await boot(page, '?welcome=1')
        await expect(page.locator('.welcome-dialog[open]')).toBeVisible()
        expect(await page.locator('.open-dialog-backdrop.visible').count()).toBe(0)
        await expect(page.locator('.welcome-tile[data-action="new"]')).toBeVisible()
        await expect(page.locator('.welcome-tile[data-action="open"]')).toBeVisible()
    })

    test('quick-start controls have exact accessible names', async ({ page }) => {
        await boot(page, '?welcome=1')
        await expect(page.getByRole('button', { name: 'New canvas', exact: true })).toBeVisible()
        await expect(page.getByRole('button', { name: 'Open file', exact: true })).toBeVisible()
        await expect(page.getByRole('button', { name: 'Close', exact: true })).toBeVisible()
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

    for (const dismissal of ['close', 'escape', 'backdrop']) {
        test(`${dismissal} dismissal falls through once and inside clicks do not dismiss`, async ({ page }) => {
            await boot(page, '?welcome=1')
            await page.evaluate(() => {
                window.__welcomeDismissCount = 0
                const app = window.layersApp
                const showOpenDialog = app._showOpenDialog.bind(app)
                app._showOpenDialog = (...args) => {
                    window.__welcomeDismissCount += 1
                    return showOpenDialog(...args)
                }
            })

            const dialog = page.locator('.welcome-dialog[open]')
            await dialog.locator('.welcome-hero').click()
            await expect(dialog).toBeVisible()
            expect(await page.evaluate(() => window.__welcomeDismissCount)).toBe(0)

            if (dismissal === 'close') await dialog.locator('.welcome-close').click()
            if (dismissal === 'escape') await page.keyboard.press('Escape')
            if (dismissal === 'backdrop') await dialog.click({ position: { x: 1, y: 1 } })

            await expect(dialog).toBeHidden()
            await expect(page.locator('.open-dialog-backdrop.visible')).toBeVisible()
            expect(await page.evaluate(() => window.__welcomeDismissCount)).toBe(1)
        })
    }

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

    test('accepted online prompt followed by cancelled unsaved prompt stays online', async ({ page }) => {
        await boot(page, '?welcome=1')
        await createProjectFromWelcome(page)
        await page.evaluate(() => {
            window.__welcomeWentOffline = false
            let online = true
            window.layersApp._onlineAdapter = {
                isOnline: () => online,
                goOffline: () => {
                    online = false
                    window.__welcomeWentOffline = true
                },
                schedulePublish: () => {},
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
        await confirm.locator('#confirm-cancel').click()

        expect(await page.evaluate(() => window.__welcomeWentOffline)).toBe(false)
        await expect(page.locator('.open-dialog-backdrop.visible')).toHaveCount(0)
    })

    test('cancelled picker and replacement dialog keep an accepted online session online', async ({ page }) => {
        await boot(page, '?welcome=1')
        await createProjectFromWelcome(page)
        await page.evaluate(() => {
            window.__welcomeWentOffline = false
            window.layersApp._onlineAdapter = {
                isOnline: () => true,
                goOffline: () => { window.__welcomeWentOffline = true },
            }
            window.layersApp._isDirty = false
        })

        await reopenWelcome(page)
        const chooserPromise = page.waitForEvent('filechooser')
        await page.locator('.welcome-tile[data-action="open"]').click()
        await page.locator('.confirm-dialog-backdrop.visible #confirm-ok').click()
        await (await chooserPromise).setFiles([])

        await expect(page.locator('.open-dialog-backdrop.visible')).toBeVisible()
        expect(await page.evaluate(() => window.__welcomeWentOffline)).toBe(false)
        await page.keyboard.press('Escape')
        await expect(page.locator('.open-dialog-backdrop.visible')).toBeHidden()
        expect(await page.evaluate(() => window.__welcomeWentOffline)).toBe(false)
    })

    test('successful replacement commits an accepted online session offline', async ({ page }) => {
        await boot(page, '?welcome=1')
        await createProjectFromWelcome(page)
        await page.evaluate(() => {
            window.__welcomeWentOffline = false
            let online = true
            window.layersApp._onlineAdapter = {
                isOnline: () => online,
                goOffline: () => {
                    online = false
                    window.__welcomeWentOffline = true
                },
                schedulePublish: () => {},
            }
        })

        await reopenWelcome(page)
        await page.locator('.welcome-tile[data-action="new"]').click()
        const confirm = page.locator('.confirm-dialog-backdrop.visible')
        await confirm.locator('#confirm-ok').click()
        await confirm.locator('#confirm-ok').click()
        await expect(page.locator('.open-dialog-backdrop.visible')).toBeVisible()
        expect(await page.evaluate(() => window.__welcomeWentOffline)).toBe(false)

        await page.locator('.media-option[data-type="solid"]').click()
        await page.locator('.canvas-size-dialog .action-btn.primary').click()
        await expect(page.locator('.open-dialog-backdrop.visible')).toBeHidden()
        expect(await page.evaluate(() => window.__welcomeWentOffline)).toBe(true)
    })

    test('corrupt first-run media falls through without installing a layer', async ({ page }) => {
        await boot(page, '?welcome=1')
        await installRejectedMediaLoad(page)

        const chooserPromise = page.waitForEvent('filechooser')
        await page.locator('.welcome-tile[data-action="open"]').click()
        await chooseBrokenPng(await chooserPromise)

        await expect(page.locator('.open-dialog-backdrop.visible')).toBeVisible()
        expect(await layerIds(page)).toEqual([])
        await expect.poll(() => page.evaluate(() => window.__welcomeUnloadedMedia.length)).toBe(1)
    })

    test('corrupt replacement preserves the current project and falls through', async ({ page }) => {
        await boot(page, '?welcome=1')
        await createProjectFromWelcome(page)
        const before = await page.evaluate(() => {
            const app = window.layersApp
            app._currentProjectId = 'preserved-project'
            app._currentProjectName = 'Preserved'
            return {
                layerIds: app._layers.map(layer => layer.id),
                selectedLayerId: app._layerStack.selectedLayerId,
                width: app._canvas.width,
                height: app._canvas.height,
                projectId: app._currentProjectId,
                projectName: app._currentProjectName,
                dirty: app._isDirty,
                canUndo: app._undoManager.canUndo(),
            }
        })
        await installRejectedMediaLoad(page)

        await reopenWelcome(page)
        const chooserPromise = page.waitForEvent('filechooser')
        await page.locator('.welcome-tile[data-action="open"]').click()
        await page.locator('.confirm-dialog-backdrop.visible #confirm-ok').click()
        await chooseBrokenPng(await chooserPromise)

        await expect(page.locator('.open-dialog-backdrop.visible')).toBeVisible()
        expect(await page.evaluate(() => {
            const app = window.layersApp
            return {
                layerIds: app._layers.map(layer => layer.id),
                selectedLayerId: app._layerStack.selectedLayerId,
                width: app._canvas.width,
                height: app._canvas.height,
                projectId: app._currentProjectId,
                projectName: app._currentProjectName,
                dirty: app._isDirty,
                canUndo: app._undoManager.canUndo(),
            }
        })).toEqual(before)
        await expect.poll(() => page.evaluate(() => window.__welcomeUnloadedMedia.length)).toBe(1)
    })

    test('superseded delayed media load cannot mutate a newer solid project', async ({ page }) => {
        await boot(page, '?welcome=1')
        await createProjectFromWelcome(page)
        await page.evaluate(() => {
            const app = window.layersApp
            window.__welcomeUnloadedMedia = []
            const unloadMedia = app._renderer.unloadMedia.bind(app._renderer)
            app._renderer.unloadMedia = (id) => {
                window.__welcomeUnloadedMedia.push(id)
                return unloadMedia(id)
            }
            app._renderer.loadMedia = (id) => {
                window.__welcomeDeferredMediaId = id
                return new Promise(resolve => { window.__resolveWelcomeMedia = resolve })
            }
        })

        await reopenWelcome(page)
        const chooserPromise = page.waitForEvent('filechooser')
        await page.locator('.welcome-tile[data-action="open"]').click()
        await page.locator('.confirm-dialog-backdrop.visible #confirm-ok').click()
        await (await chooserPromise).setFiles(path.resolve('public/img/og-image.png'))
        await expect.poll(() => page.evaluate(() => Boolean(window.__resolveWelcomeMedia))).toBe(true)

        await page.evaluate(() => window.layersApp._handleCreateSolidBase(333, 222))
        await expect.poll(() => page.evaluate(() => window.layersApp._canvas.width)).toBe(333)
        const newerProject = await page.evaluate(() => ({
            layerIds: window.layersApp._layers.map(layer => layer.id),
            width: window.layersApp._canvas.width,
            height: window.layersApp._canvas.height,
        }))
        await page.evaluate(() => window.__resolveWelcomeMedia({ width: 900, height: 700 }))
        await expect.poll(() => page.evaluate(() => window.__welcomeUnloadedMedia)).toContain(
            await page.evaluate(() => window.__welcomeDeferredMediaId))

        expect(await page.evaluate(() => ({
            layerIds: window.layersApp._layers.map(layer => layer.id),
            width: window.layersApp._canvas.width,
            height: window.layersApp._canvas.height,
        }))).toEqual(newerProject)
    })

    test('replacement clears selection and copy positioning state', async ({ page }) => {
        await boot(page, '?welcome=1')
        await createProjectFromWelcome(page)
        await page.evaluate(() => {
            const app = window.layersApp
            app._selectionManager.setSelection({ type: 'rect', x: 4, y: 5, width: 20, height: 30 })
            app._copyOrigin = { x: 9, y: 11 }
        })

        await reopenWelcome(page)
        await page.locator('.welcome-tile[data-action="new"]').click()
        await page.locator('.confirm-dialog-backdrop.visible #confirm-ok').click()
        await page.locator('.media-option[data-type="solid"]').click()
        await page.locator('.canvas-size-dialog .action-btn.primary').click()
        await expect(page.locator('.open-dialog-backdrop.visible')).toBeHidden()

        expect(await page.evaluate(() => ({
            hasSelection: window.layersApp._selectionManager.hasSelection(),
            copyOrigin: window.layersApp._copyOrigin,
        }))).toEqual({ hasSelection: false, copyOrigin: null })
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
