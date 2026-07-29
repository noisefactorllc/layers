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
    await page.getByRole('menuitem', { name: 'Layers menu', exact: true }).click()
    await page.getByRole('menuitem', { name: 'welcome to Layers...', exact: true }).click()
    await page.locator('.welcome-dialog[open]').waitFor()
}

async function layerIds(page) {
    return page.evaluate(() => window.layersApp._layers.map(layer => layer.id))
}

async function installRejectedMediaLoad(page) {
    await page.evaluate(() => {
        const app = window.layersApp
        app._renderer.prepareMediaResource = async () => {
            throw new Error('undecodable test media')
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

async function openFileMenuItem(page, id) {
    await page.locator('#menu .hf-menubar-trigger', { hasText: 'file' }).click()
    await page.locator(`#menu #${id}`).click()
}

async function installOnlineSession(page) {
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
}

async function acceptOnlineGuard(page) {
    const confirm = page.locator('.confirm-dialog-backdrop.visible')
    await expect(confirm.locator('.confirm-message')).toHaveText(
        'This will take your Layers session offline. Continue?')
    await confirm.locator('#confirm-ok').click()
}

async function acceptUnsavedGuard(page) {
    const confirm = page.locator('.confirm-dialog-backdrop.visible')
    await expect(confirm.locator('.confirm-message')).toHaveText(
        'You have unsaved changes. Discard them?')
    await confirm.locator('#confirm-ok').click()
}

async function writeClipboardImage(page, width = 40, height = 30) {
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
    await page.evaluate(async ({ width, height }) => {
        const canvas = document.createElement('canvas')
        canvas.width = width
        canvas.height = height
        canvas.getContext('2d').fillRect(0, 0, width, height)
        const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'))
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
    }, { width, height })
}

async function currentProjectState(page) {
    return page.evaluate(() => {
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
            hasSelection: app._selectionManager.hasSelection(),
            copyOrigin: app._copyOrigin,
        }
    })
}

async function putBrokenStoredProject(page, kind) {
    return page.evaluate(async (projectKind) => {
        const app = window.layersApp
        const id = `broken-${projectKind.replaceAll(' ', '-')}`
        const layer = {
            ...app._layers[0],
            id: `broken-${projectKind}-layer`,
            effectParams: { ...(app._layers[0]?.effectParams || {}) },
            children: [],
            mask: null,
        }

        if (projectKind === 'invalid mask') {
            layer.mask = 'data:image/png;base64,not-a-valid-png'
        } else {
            Object.assign(layer, {
                sourceType: 'media',
                effectId: null,
                mediaType: 'image',
                mediaId: 'missing-media-blob',
                mediaFile: null,
            })
        }

        const database = await new Promise((resolve, reject) => {
            const request = indexedDB.open('layers-projects', 1)
            request.onsuccess = () => resolve(request.result)
            request.onerror = () => reject(request.error)
        })
        await new Promise((resolve, reject) => {
            const transaction = database.transaction('projects', 'readwrite')
            const request = transaction.objectStore('projects').put({
                id,
                name: `Broken ${projectKind}`,
                createdAt: Date.now(),
                modifiedAt: Date.now(),
                canvasWidth: 77,
                canvasHeight: 55,
                layers: [layer],
            })
            request.onsuccess = resolve
            request.onerror = () => reject(request.error)
        })
        return id
    }, kind)
}

async function putPartiallyCorruptMediaProject(page) {
    return page.evaluate(async () => {
        const app = window.layersApp
        const id = 'partially-corrupt-media-project'
        const base = app._layers[0]
        const mediaLayer = (layerId, mediaId, name) => ({
            ...base,
            id: layerId,
            name,
            sourceType: 'media',
            effectId: null,
            effectParams: {},
            mediaType: 'image',
            mediaId,
            mediaFile: null,
            children: [],
            mask: null,
        })
        const goodBlob = await (await fetch('/img/og-image.png')).blob()
        const database = await new Promise((resolve, reject) => {
            const request = indexedDB.open('layers-projects', 1)
            request.onsuccess = () => resolve(request.result)
            request.onerror = () => reject(request.error)
        })
        await new Promise((resolve, reject) => {
            const transaction = database.transaction(['media', 'projects'], 'readwrite')
            const media = transaction.objectStore('media')
            media.put({
                id: 'good-media-blob', blob: goodBlob, name: 'good.png',
                type: 'image/png', savedAt: Date.now(),
            })
            media.put({
                id: 'bad-media-blob', blob: new Blob(['not an image'], { type: 'image/png' }),
                name: 'bad.png', type: 'image/png', savedAt: Date.now(),
            })
            transaction.objectStore('projects').put({
                id,
                name: 'Partially corrupt media',
                createdAt: Date.now(),
                modifiedAt: Date.now(),
                canvasWidth: 320,
                canvasHeight: 180,
                layers: [
                    mediaLayer('good-media-layer', 'good-media-blob', 'Good media'),
                    mediaLayer('bad-media-layer', 'bad-media-blob', 'Bad media'),
                ],
            })
            transaction.oncomplete = resolve
            transaction.onerror = () => reject(transaction.error)
        })
        return id
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

    for (const action of ['new', 'open']) {
        test(`online empty composition commits offline after successful ${action}`, async ({ page }) => {
            await boot(page, '?welcome=1')
            await installOnlineSession(page)

            if (action === 'new') {
                await page.locator('.welcome-tile[data-action="new"]').click()
                await acceptOnlineGuard(page)
                await expect(page.locator('.open-dialog-backdrop.visible')).toBeVisible()
                await page.locator('.media-option[data-type="solid"]').click()
                await page.locator('.canvas-size-dialog .action-btn.primary').click()
                await expect(page.locator('.open-dialog-backdrop.visible')).toBeHidden()
            } else {
                const chooserPromise = page.waitForEvent('filechooser')
                await page.locator('.welcome-tile[data-action="open"]').click()
                await acceptOnlineGuard(page)
                await (await chooserPromise).setFiles(path.resolve('public/img/og-image.png'))
                await expect.poll(() => page.evaluate(() => window.layersApp._layers.length)).toBe(1)
            }

            expect(await page.evaluate(() => window.__welcomeWentOffline)).toBe(true)
        })
    }

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

    test('re-opens from the logo menu with keyboard-accessible controls', async ({ page }) => {
        await boot(page, '?welcome=1')
        await page.locator('.welcome-dialog[open]').waitFor()
        await page.locator('.welcome-close').click()

        const logoMenuButton = page.getByRole('menuitem', { name: 'Layers menu', exact: true })
        await logoMenuButton.focus()
        await page.keyboard.press('Enter')
        await expect(page.locator('#logoMenu .hf-menubar-panel')).toBeVisible()

        // The menu-bar component follows the ARIA menubar pattern: opening
        // with Enter focuses the first item directly.
        const welcomeButton = page.getByRole('menuitem', { name: 'welcome to Layers...', exact: true })
        await expect(welcomeButton).toBeFocused()
        await page.keyboard.press('Enter')
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

    test('native picker re-confirms after an intervening project mutation', async ({ page }) => {
        await boot(page, '?welcome=1')
        await createProjectFromWelcome(page)

        await reopenWelcome(page)
        const chooserPromise = page.waitForEvent('filechooser')
        await page.locator('.welcome-tile[data-action="open"]').click()
        await acceptUnsavedGuard(page)
        const chooser = await chooserPromise

        const interveningState = await page.evaluate(async () => {
            const envelope = await window.LayersAgent.addLayer({
                kind: 'effect', effectId: 'synth/gradient',
            })
            if (!envelope.ok) throw new Error(envelope.error.message)
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
                hasSelection: app._selectionManager.hasSelection(),
                copyOrigin: app._copyOrigin,
            }
        })
        await chooser.setFiles(path.resolve('public/img/og-image.png'))

        await expect(page.locator('.confirm-dialog-backdrop.visible .confirm-message')).toHaveText(
            'You have unsaved changes. Discard them?')
        await page.locator('.confirm-dialog-backdrop.visible #confirm-cancel').click()
        await expect.poll(() => currentProjectState(page)).toEqual(interveningState)
    })

    test('new-canvas chooser re-confirms after an intervening project mutation', async ({ page }) => {
        await boot(page, '?welcome=1')
        await createProjectFromWelcome(page)

        await reopenWelcome(page)
        await page.locator('.welcome-tile[data-action="new"]').click()
        await acceptUnsavedGuard(page)
        await expect(page.locator('.open-dialog-backdrop.visible')).toBeVisible()

        const interveningState = await page.evaluate(async () => {
            const envelope = await window.LayersAgent.addLayer({
                kind: 'effect', effectId: 'synth/gradient',
            })
            if (!envelope.ok) throw new Error(envelope.error.message)
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
                hasSelection: app._selectionManager.hasSelection(),
                copyOrigin: app._copyOrigin,
            }
        })
        await page.locator('.media-option[data-type="solid"]').click()
        await page.locator('.canvas-size-dialog .action-btn.primary').click()

        await expect(page.locator('.confirm-dialog-backdrop.visible .confirm-message')).toHaveText(
            'You have unsaved changes. Discard them?')
        await page.locator('.confirm-dialog-backdrop.visible #confirm-cancel').click()
        await expect.poll(() => currentProjectState(page)).toEqual(interveningState)
    })

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
    })

    test('superseded delayed media load cannot mutate a newer solid project', async ({ page }) => {
        await boot(page, '?welcome=1')
        await createProjectFromWelcome(page)
        await page.evaluate(() => {
            const app = window.layersApp
            window.__welcomeDeferredMediaDisposed = false
            const disposeMediaResource = app._renderer.disposeMediaResource.bind(app._renderer)
            app._renderer.disposeMediaResource = (resource) => {
                if (resource === window.__welcomeDeferredMediaResource) {
                    window.__welcomeDeferredMediaDisposed = true
                }
                return disposeMediaResource(resource)
            }
            app._renderer.prepareMediaResource = () => {
                return new Promise(resolve => {
                    window.__resolveWelcomeMedia = ({ width, height }) => {
                        const canvas = document.createElement('canvas')
                        canvas.width = width
                        canvas.height = height
                        window.__welcomeDeferredMediaResource = {
                            type: 'image', element: canvas, width, height,
                        }
                        resolve(window.__welcomeDeferredMediaResource)
                    }
                })
            }
        })

        await reopenWelcome(page)
        const chooserPromise = page.waitForEvent('filechooser')
        await page.locator('.welcome-tile[data-action="open"]').click()
        await page.locator('.confirm-dialog-backdrop.visible #confirm-ok').click()
        await (await chooserPromise).setFiles(path.resolve('public/img/og-image.png'))
        await expect.poll(() => page.evaluate(() => Boolean(window.__resolveWelcomeMedia))).toBe(true)

        await openFileMenuItem(page, 'newMenuItem')
        await acceptUnsavedGuard(page)
        await expect(page.locator('.open-dialog-backdrop.visible')).toBeVisible()
        await page.locator('.media-option[data-type="solid"]').click()
        await page.locator('.canvas-size-dialog input[type="number"]').nth(0).fill('333')
        await page.locator('.canvas-size-dialog input[type="number"]').nth(1).fill('222')
        await page.locator('.canvas-size-dialog .action-btn.primary').click()
        await expect(page.locator('.open-dialog-backdrop.visible')).toBeHidden()
        await expect.poll(() => page.evaluate(() => window.layersApp._canvas.width)).toBe(333)
        const newerProject = await page.evaluate(() => ({
            layerIds: window.layersApp._layers.map(layer => layer.id),
            width: window.layersApp._canvas.width,
            height: window.layersApp._canvas.height,
        }))
        await page.evaluate(() => window.__resolveWelcomeMedia({ width: 900, height: 700 }))
        await expect.poll(() => page.evaluate(() =>
            window.__welcomeDeferredMediaDisposed)).toBe(true)

        expect(await page.evaluate(() => ({
            layerIds: window.layersApp._layers.map(layer => layer.id),
            width: window.layersApp._canvas.width,
            height: window.layersApp._canvas.height,
        }))).toEqual(newerProject)
    })

    test('failed newer media candidate cannot strand an installing replacement', async ({ page }) => {
        await boot(page, '?welcome=1')
        await createProjectFromWelcome(page)
        const before = await page.evaluate(() => {
            const app = window.layersApp
            app._currentProjectId = 'old-project'
            app._currentProjectName = 'Old project'
            app._markClean()
            return {
                layerIds: app._layers.map(layer => layer.id),
                selectedLayerId: app._layerStack.selectedLayerId,
                width: app._canvas.width,
                height: app._canvas.height,
                projectId: app._currentProjectId,
                projectName: app._currentProjectName,
                dirty: app._isDirty,
                canUndo: app._undoManager.canUndo(),
                hasSelection: app._selectionManager.hasSelection(),
                copyOrigin: app._copyOrigin,
            }
        })
        await page.evaluate(() => {
            const app = window.layersApp
            const prepareMediaResource = app._renderer.prepareMediaResource.bind(app._renderer)
            const stageLayerSet = app._renderer.stageLayerSet.bind(app._renderer)
            let mediaLoads = 0
            app._renderer.prepareMediaResource = (...args) => {
                mediaLoads += 1
                if (mediaLoads === 2) return Promise.reject(new Error('newer candidate failed'))
                return prepareMediaResource(...args)
            }
            app._renderer.stageLayerSet = (candidate) => {
                if (!window.__welcomeHeldSetLayers) {
                    window.__welcomeHeldSetLayers = true
                    return new Promise((resolve, reject) => {
                        window.__releaseWelcomeSetLayers = () => {
                            const result = stageLayerSet(candidate)
                            result.finally(() => { window.__welcomeHeldSetLayersFinished = true })
                            result.then(resolve, reject)
                        }
                    })
                }
                return stageLayerSet(candidate)
            }
        })

        await reopenWelcome(page)
        let chooserPromise = page.waitForEvent('filechooser')
        await page.locator('.welcome-tile[data-action="open"]').click()
        await (await chooserPromise).setFiles(path.resolve('public/img/og-image.png'))
        await expect.poll(() => page.evaluate(() =>
            Boolean(window.__releaseWelcomeSetLayers))).toBe(true)

        await reopenWelcome(page)
        chooserPromise = page.waitForEvent('filechooser')
        await page.locator('.welcome-tile[data-action="open"]').click()
        await (await chooserPromise).setFiles(path.resolve('public/img/og-image.png'))
        await expect(page.locator('.open-dialog-backdrop.visible')).toBeVisible()

        await page.evaluate(() => window.__releaseWelcomeSetLayers())
        await expect.poll(() => page.evaluate(() =>
            Boolean(window.__welcomeHeldSetLayersFinished))).toBe(true)
        await expect.poll(() => currentProjectState(page)).toEqual(before)
    })

    test('failed base installation preserves the committed project and online session', async ({ page }) => {
        await boot(page, '?welcome=1')
        await createProjectFromWelcome(page)
        const before = await page.evaluate(() => {
            const app = window.layersApp
            app._currentProjectId = 'old-project'
            app._currentProjectName = 'Old project'
            app._markClean()
            return {
                layerIds: app._layers.map(layer => layer.id),
                selectedLayerId: app._layerStack.selectedLayerId,
                width: app._canvas.width,
                height: app._canvas.height,
                projectId: app._currentProjectId,
                projectName: app._currentProjectName,
                dirty: app._isDirty,
                canUndo: app._undoManager.canUndo(),
                hasSelection: app._selectionManager.hasSelection(),
                copyOrigin: app._copyOrigin,
            }
        })
        await installOnlineSession(page)
        await page.evaluate(() => {
            const app = window.layersApp
            const stageLayerSet = app._renderer.stageLayerSet.bind(app._renderer)
            app._renderer.stageLayerSet = (...args) => {
                if (!window.__welcomeRejectedSetLayers) {
                    window.__welcomeRejectedSetLayers = true
                    return Promise.reject(new Error('candidate rebuild failed'))
                }
                return stageLayerSet(...args)
            }
        })

        await openFileMenuItem(page, 'newMenuItem')
        await acceptOnlineGuard(page)
        await expect(page.locator('.open-dialog-backdrop.visible')).toBeVisible()
        await page.locator('.media-option[data-type="solid"]').click()
        await page.locator('.canvas-size-dialog .action-btn.primary').click()
        await expect.poll(() => page.evaluate(() =>
            Boolean(window.__welcomeRejectedSetLayers))).toBe(true)

        await expect.poll(() => currentProjectState(page)).toEqual(before)
        expect(await page.evaluate(() => window.__welcomeWentOffline)).toBe(false)
        await expect(page.locator('.open-dialog-backdrop.visible')).toBeVisible()
    })

    for (const corruption of ['invalid mask', 'missing media']) {
        test(`${corruption} project preserves the committed project and online session`, async ({ page }) => {
            await boot(page, '?welcome=1')
            await createProjectFromWelcome(page)
            const before = await page.evaluate(() => {
                const app = window.layersApp
                app._currentProjectId = 'old-project'
                app._currentProjectName = 'Old project'
                app._markClean()
                return {
                    layerIds: app._layers.map(layer => layer.id),
                    selectedLayerId: app._layerStack.selectedLayerId,
                    width: app._canvas.width,
                    height: app._canvas.height,
                    projectId: app._currentProjectId,
                    projectName: app._currentProjectName,
                    dirty: app._isDirty,
                    canUndo: app._undoManager.canUndo(),
                    hasSelection: app._selectionManager.hasSelection(),
                    copyOrigin: app._copyOrigin,
                }
            })
            const brokenProjectId = await putBrokenStoredProject(page, corruption)
            await installOnlineSession(page)

            await openFileMenuItem(page, 'loadProjectMenuItem')
            await acceptOnlineGuard(page)
            const manager = page.locator('.project-manager-dialog[open]')
            await expect(manager).toBeVisible()
            await manager.locator(`.project-item[data-id="${brokenProjectId}"]`).click()
            await manager.locator('.pm-open-btn').click()
            await expect(manager.locator('.pm-mode-list')).toBeVisible()

            expect(await currentProjectState(page)).toEqual(before)
            expect(await page.evaluate(() => window.__welcomeWentOffline)).toBe(false)
        })
    }

    test('partial saved-media preparation disposes candidates and preserves the project', async ({ page }) => {
        await boot(page, '?welcome=1')
        await createProjectFromWelcome(page)
        const before = await page.evaluate(() => {
            const app = window.layersApp
            app._currentProjectId = 'old-project'
            app._currentProjectName = 'Old project'
            app._markClean()
            return {
                layerIds: app._layers.map(layer => layer.id),
                selectedLayerId: app._layerStack.selectedLayerId,
                width: app._canvas.width,
                height: app._canvas.height,
                projectId: app._currentProjectId,
                projectName: app._currentProjectName,
                dirty: app._isDirty,
                canUndo: app._undoManager.canUndo(),
                hasSelection: app._selectionManager.hasSelection(),
                copyOrigin: app._copyOrigin,
            }
        })
        const projectId = await putPartiallyCorruptMediaProject(page)
        await installOnlineSession(page)
        await page.evaluate(() => {
            const renderer = window.layersApp._renderer
            const prepareMediaResource = renderer.prepareMediaResource.bind(renderer)
            const disposeMediaResource = renderer.disposeMediaResource.bind(renderer)
            let prepared = 0
            renderer.prepareMediaResource = async (...args) => {
                const resource = await prepareMediaResource(...args)
                prepared += 1
                if (prepared === 1) window.__welcomeFirstPreparedResource = resource
                return resource
            }
            renderer.disposeMediaResource = (resource) => {
                if (resource === window.__welcomeFirstPreparedResource) {
                    window.__welcomeFirstPreparedDisposed = true
                }
                return disposeMediaResource(resource)
            }
        })

        await openFileMenuItem(page, 'loadProjectMenuItem')
        await acceptOnlineGuard(page)
        const manager = page.locator('.project-manager-dialog[open]')
        await manager.locator(`.project-item[data-id="${projectId}"]`).click()
        await manager.locator('.pm-open-btn').click()
        await expect(manager.locator('.pm-mode-list')).toBeVisible()

        expect(await currentProjectState(page)).toEqual(before)
        expect(await page.evaluate(() => window.__welcomeFirstPreparedDisposed)).toBe(true)
        expect(await page.evaluate(() => window.__welcomeWentOffline)).toBe(false)
    })

    test('reopened Welcome treats an active empty project as replaceable on picker cancel', async ({ page }) => {
        await boot(page, '?welcome=1')
        await createProjectFromWelcome(page)
        await page.evaluate(async () => {
            await window.LayersAgent.newProject({ width: 210, height: 120, name: 'Empty' })
            const app = window.layersApp
            app._selectionManager.setSelection({ type: 'rect', x: 4, y: 5, width: 20, height: 30 })
            app._copyOrigin = { x: 7, y: 8 }
        })
        const before = await currentProjectState(page)

        await reopenWelcome(page)
        const chooserPromise = page.waitForEvent('filechooser')
        await page.locator('.welcome-tile[data-action="open"]').click()
        await (await chooserPromise).setFiles([])
        await expect(page.locator('.open-dialog-backdrop.visible')).toBeVisible()
        await page.keyboard.press('Escape')

        await expect(page.locator('.open-dialog-backdrop.visible')).toBeHidden()
        expect(await currentProjectState(page)).toEqual(before)
    })

    test('reopened Welcome resets active empty-project interaction state on success', async ({ page }) => {
        await boot(page, '?welcome=1')
        await createProjectFromWelcome(page)
        await page.evaluate(async () => {
            await window.LayersAgent.newProject({ width: 210, height: 120, name: 'Empty' })
            const app = window.layersApp
            app._selectionManager.setSelection({ type: 'rect', x: 4, y: 5, width: 20, height: 30 })
            app._copyOrigin = { x: 7, y: 8 }
        })

        await reopenWelcome(page)
        const chooserPromise = page.waitForEvent('filechooser')
        await page.locator('.welcome-tile[data-action="open"]').click()
        await (await chooserPromise).setFiles(path.resolve('public/img/og-image.png'))
        await expect.poll(() => page.evaluate(() => window.layersApp._isDirty)).toBe(true)

        expect(await page.evaluate(() => ({
            layerCount: window.layersApp._layers.length,
            hasSelection: window.layersApp._selectionManager.hasSelection(),
            copyOrigin: window.layersApp._copyOrigin,
        }))).toEqual({ layerCount: 1, hasSelection: false, copyOrigin: null })
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

    for (const hasImage of [true, false]) {
        test(`online clipboard ${hasImage ? 'success commits offline' : 'without an image stays online'}`, async ({ page }) => {
            await boot(page, '?welcome=1')
            await createProjectFromWelcome(page)
            if (hasImage) {
                await writeClipboardImage(page, 40, 30)
            } else {
                await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
                await page.evaluate(() => navigator.clipboard.writeText('no image'))
            }
            await installOnlineSession(page)

            await openFileMenuItem(page, 'newFromClipboardMenuItem')
            await acceptOnlineGuard(page)
            await acceptUnsavedGuard(page)

            if (hasImage) {
                await expect.poll(() => page.evaluate(() => window.layersApp._canvas.width)).toBe(40)
                await expect.poll(() => page.evaluate(() => window.__welcomeWentOffline)).toBe(true)
            } else {
                await expect(page.getByText('No image found in clipboard', { exact: true })).toBeVisible()
                expect(await page.evaluate(() => window.__welcomeWentOffline)).toBe(false)
            }
        })
    }

    test('cancelled project manager stays online', async ({ page }) => {
        await boot(page, '?welcome=1')
        await createProjectFromWelcome(page)
        await installOnlineSession(page)

        await openFileMenuItem(page, 'loadProjectMenuItem')
        await acceptOnlineGuard(page)
        await acceptUnsavedGuard(page)
        const manager = page.locator('.project-manager-dialog[open]')
        await expect(manager).toBeVisible()
        await manager.locator('.pm-cancel-btn').click()

        await expect(manager).toBeHidden()
        expect(await page.evaluate(() => window.__welcomeWentOffline)).toBe(false)
    })

    test('project manager re-confirms after an intervening project mutation', async ({ page }) => {
        await boot(page, '?welcome=1')
        await createProjectFromWelcome(page)
        const savedProjectId = await page.evaluate(async () => {
            const saved = await window.LayersAgent.saveProjectAs({ name: 'consent-target' })
            await window.LayersAgent.addLayer({
                kind: 'effect', effectId: 'synth/gradient',
            })
            return saved.result.projectId
        })

        await openFileMenuItem(page, 'loadProjectMenuItem')
        await acceptUnsavedGuard(page)
        const manager = page.locator('.project-manager-dialog[open]')
        await expect(manager).toBeVisible()

        const interveningState = await page.evaluate(async () => {
            const envelope = await window.LayersAgent.addLayer({
                kind: 'effect', effectId: 'synth/solid',
            })
            if (!envelope.ok) throw new Error(envelope.error.message)
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
                hasSelection: app._selectionManager.hasSelection(),
                copyOrigin: app._copyOrigin,
            }
        })
        await manager.locator(`.project-item[data-id="${savedProjectId}"]`).click()
        await manager.locator('.pm-open-btn').click()

        await expect(page.locator('.confirm-dialog-backdrop.visible .confirm-message')).toHaveText(
            'You have unsaved changes. Discard them?')
        await page.locator('.confirm-dialog-backdrop.visible #confirm-cancel').click()
        await expect(manager.locator('.pm-mode-list')).toBeVisible()
        await expect.poll(() => currentProjectState(page)).toEqual(interveningState)
    })

    test('successful online project load selects the saved topmost layer and commits offline', async ({ page }) => {
        await boot(page, '?welcome=1')
        await createProjectFromWelcome(page)
        const saved = await page.evaluate(async () => {
            await window.LayersAgent.addLayer({ kind: 'effect', effectId: 'synth/gradient' })
            const saved = await window.LayersAgent.saveProjectAs({ name: 'welcome-load-target' })
            const app = window.layersApp
            const topmostId = app._layers[app._layers.length - 1].id
            await window.LayersAgent.addLayer({ kind: 'effect', effectId: 'synth/solid' })
            return { projectId: saved.result.projectId, topmostId }
        })
        await installOnlineSession(page)

        await openFileMenuItem(page, 'loadProjectMenuItem')
        await acceptOnlineGuard(page)
        await acceptUnsavedGuard(page)
        const manager = page.locator('.project-manager-dialog[open]')
        await expect(manager).toBeVisible()
        await manager.locator(`.project-item[data-id="${saved.projectId}"]`).click()
        await manager.locator('.pm-open-btn').click()
        await expect(manager).toBeHidden({ timeout: 10000 })

        expect(await page.evaluate(() => ({
            wentOffline: window.__welcomeWentOffline,
            selectedLayerId: window.layersApp._layerStack.selectedLayerId,
        }))).toEqual({ wentOffline: true, selectedLayerId: saved.topmostId })
    })

    test('Open file replacement unloads the prior media resource', async ({ page }) => {
        await boot(page, '?welcome=1')
        const initialChooserPromise = page.waitForEvent('filechooser')
        await page.locator('.welcome-tile[data-action="open"]').click()
        let chooser = await initialChooserPromise
        await chooser.setFiles(path.resolve('public/img/og-image.png'))
        await expect.poll(() => page.evaluate(() => ({
            layerCount: window.layersApp._layers.length,
            dirty: window.layersApp._isDirty,
        }))).toEqual({ layerCount: 1, dirty: true })
        await page.evaluate(() => {
            const renderer = window.layersApp._renderer
            const oldResource = renderer.getMediaInfo(window.layersApp._layers[0].id)
            const disposeMediaResource = renderer.disposeMediaResource.bind(renderer)
            window.__welcomeDisposedOldMedia = false
            renderer.disposeMediaResource = (resource) => {
                if (resource === oldResource) window.__welcomeDisposedOldMedia = true
                return disposeMediaResource(resource)
            }
        })

        await reopenWelcome(page)
        const chooserPromise = page.waitForEvent('filechooser')
        await page.locator('.welcome-tile[data-action="open"]').click()
        const confirm = page.locator('.confirm-dialog-backdrop.visible')
        await confirm.locator('#confirm-ok').click()
        chooser = await chooserPromise
        await chooser.setFiles(path.resolve('public/img/og-image.png'))
        await expect.poll(() => page.evaluate(() => window.__welcomeDisposedOldMedia)).toBe(true)
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
