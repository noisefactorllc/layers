import { test, expect } from './fixtures.js'
import { seedClipboardRead } from './helpers/clipboard.js'
import { defaultProjectReady } from './waits.js'
import { pausePlayback } from './helpers/new-project.js'
import path from 'node:path'

// Boot's default canvas is clean, so tile clicks skip the discard guard; guard tests below use a real dirty project.
async function boot(page) {
    await page.goto('/', { waitUntil: 'networkidle' })
    await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })
    await defaultProjectReady(page)
    await pausePlayback(page)
    await reopenWelcome(page)
}

async function createProjectFromWelcome(page, type = 'solid', size) {
    await page.locator('.welcome-tile[data-action="new"]').click()
    await page.locator('.open-dialog-backdrop.visible').waitFor()
    await page.locator(`.media-option[data-type="${type}"]`).click()
    // 512 preset: quarters the composited frame cost on software-rendered CI
    // shards (same capacity trim as the other dialog-booting suites). Used only
    // when the test gives no explicit size: nothing below asserts a canvas
    // dimension, and the two asserted widths (333 and 40) come from tests that
    // type or derive their own sizes.
    if (!size) {
        await page.locator('.size-preset[data-width="512"]').click()
    } else {
        await page.locator('#canvas-width').fill(String(size))
        await page.locator('#canvas-height').fill(String(size))
    }
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
    await seedClipboardRead(page, { width, height })
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
    test('opens from the menu with the open dialog not shown underneath', async ({ page }) => {
        await boot(page)
        await expect(page.locator('.welcome-dialog[open]')).toBeVisible()
        expect(await page.locator('.open-dialog-backdrop.visible').count()).toBe(0)
        await expect(page.locator('.welcome-tile[data-action="new"]')).toBeVisible()
        await expect(page.locator('.welcome-tile[data-action="open"]')).toBeVisible()
    })

    test('quick-start controls have exact accessible names', async ({ page }) => {
        await boot(page)
        await expect(page.getByRole('button', { name: 'New canvas', exact: true })).toBeVisible()
        await expect(page.getByRole('button', { name: 'Open file', exact: true })).toBeVisible()
        await expect(page.getByRole('button', { name: 'Close', exact: true })).toBeVisible()
    })

    for (const action of ['new', 'open']) {
        test(`online empty composition commits offline after successful ${action}`, async ({ page }) => {
            await boot(page)
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

    test('native picker re-confirms after an intervening project mutation', async ({ page }) => {
        await boot(page)
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

    test('accepted online prompt followed by cancelled unsaved prompt stays online', async ({ page }) => {
        await boot(page)
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

    test('corrupt replacement preserves the current project and falls through', async ({ page }) => {
        await boot(page)
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
        await boot(page)
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
        await boot(page)
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

    test('partial saved-media preparation disposes candidates and preserves the project', async ({ page }) => {
        await boot(page)
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

    test('replacement clears selection and copy positioning state', async ({ page }) => {
        await boot(page)
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
            await boot(page)
            // This checks replacement and online state, independently of the
            // old document's resolution. Keep software GPU allocations small.
            await createProjectFromWelcome(page, 'solid', 128)
            if (hasImage) {
                await writeClipboardImage(page, 40, 30)
            } else {
                await seedClipboardRead(page)
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

    test('project manager re-confirms after an intervening project mutation', async ({ page }) => {
        await boot(page)
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

    test('Open file replacement unloads the prior media resource', async ({ page }) => {
        await boot(page)
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
        await boot(page)
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
        await boot(page)
        const close = page.locator('.welcome-close')
        await expect(close.locator('.icon-material')).toHaveText('close')
        await expect(close).toContainText('Close')
    })
})
