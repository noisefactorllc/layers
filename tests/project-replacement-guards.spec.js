import { test, expect } from './fixtures.js'
import path from 'node:path'
import { IN_PAGE_UNTIL, defaultProjectReady } from './waits.js'
import { reopenNewProjectDialog } from './helpers/new-project.js'

async function bootSolid(page) {
    await page.goto('/', { waitUntil: 'networkidle' })
    await page.locator('#loading-screen').waitFor({ state: 'hidden' })
    await reopenNewProjectDialog(page)
    const backdrop = page.locator('.open-dialog-backdrop.visible')
    await page.locator('.media-option[data-type="solid"]').click()
    await page.locator('.canvas-size-dialog .action-btn.primary').click()
    await backdrop.waitFor({ state: 'hidden' })
}

async function projectState(page) {
    return page.evaluate(() => {
        const app = window.layersApp
        return {
            layerIds: app._layers.map(layer => layer.id),
            selectedLayerId: app._layerStack.selectedLayerId,
            selectedLayerIds: app._layerStack.selectedLayerIds,
            selectionAnchor: app._layerStack._lastClickedLayerId,
            width: app._canvas.width,
            height: app._canvas.height,
            projectId: app._currentProjectId,
            projectName: app._currentProjectName,
            dirty: app._isDirty,
            mutationRevision: app._projectMutationRevision,
            canUndo: app._undoManager.canUndo(),
            hasSelection: app._selectionManager.hasSelection(),
            copyOrigin: app._copyOrigin,
        }
    })
}

async function putProject(page, { id, layers, width = 320, height = 180 }) {
    await page.evaluate(async ({ id, layers, width, height }) => {
        const database = await new Promise((resolve, reject) => {
            const request = indexedDB.open('layers-projects', 1)
            request.onsuccess = () => resolve(request.result)
            request.onerror = () => reject(request.error)
        })
        await new Promise((resolve, reject) => {
            const transaction = database.transaction('projects', 'readwrite')
            transaction.objectStore('projects').put({
                id,
                name: id,
                createdAt: Date.now(),
                modifiedAt: Date.now(),
                canvasWidth: width,
                canvasHeight: height,
                layers,
            })
            transaction.oncomplete = resolve
            transaction.onerror = () => reject(transaction.error)
        })
    }, { id, layers, width, height })
}

test.describe('Atomic project replacement', () => {
    test('Select All cannot capture candidate dimensions during a failed stage', async ({ page }) => {
        await bootSolid(page)

        const result = await page.evaluate(async (untilSrc) => {
            const until = eval(untilSrc)
            const app = window.layersApp
            app._selectionManager.setSelection({
                type: 'rect', x: 4, y: 5, width: 20, height: 30,
            })
            const stageLayerSet = app._renderer.stageLayerSet.bind(app._renderer)
            app._renderer.stageLayerSet = async (candidate) => {
                const stage = await stageLayerSet(candidate)
                window.__selectStageReached = true
                await new Promise(resolve => { window.__releaseSelectStage = resolve })
                return { ...stage, success: false, error: 'forced candidate failure' }
            }

            const replacementPromise = app._handleCreateGradientBase(333, 222)
            await until(() => window.__selectStageReached, 'replacement stage live')
            document.getElementById('selectAllMenuItem').click()
            window.__releaseSelectStage()
            const status = await replacementPromise
            const selection = app._selectionManager.selectionPath
            return {
                status,
                canvas: { width: app._canvas.width, height: app._canvas.height },
                selection: selection && {
                    type: selection.type,
                    x: selection.x,
                    y: selection.y,
                    width: selection.width,
                    height: selection.height,
                },
            }
        }, IN_PAGE_UNTIL)

        expect(result).toEqual({
            status: 'failed',
            canvas: { width: 1024, height: 1024 },
            selection: { type: 'rect', x: 4, y: 5, width: 20, height: 30 },
        })
    })

    test('replacement cancels a pending Color Range pick and its stale click', async ({ page }) => {
        await bootSolid(page)

        const result = await page.evaluate(async () => {
            const app = window.layersApp
            document.getElementById('colorRangeMenuItem').click()
            await new Promise(resolve => setTimeout(resolve, 0))
            const pickingBefore = app._colorRangePicking
            const lifecycleBefore = app._projectLifecycleActive
            const status = await app._handleCreateGradientBase(333, 222)
            const rect = app._selectionOverlay.getBoundingClientRect()
            app._selectionOverlay.dispatchEvent(new MouseEvent('click', {
                clientX: rect.left + 20,
                clientY: rect.top + 20,
                bubbles: true,
                button: 0,
            }))
            return {
                pickingBefore,
                lifecycleBefore,
                status,
                pickingAfter: app._colorRangePicking,
                lifecycleAfter: app._projectLifecycleActive,
                hasSelection: app._selectionManager.hasSelection(),
            }
        })

        expect(result).toEqual({
            pickingBefore: true,
            lifecycleBefore: true,
            status: 'opened',
            pickingAfter: false,
            lifecycleAfter: false,
            hasSelection: false,
        })
    })

    test('failed staging restores the active mask-edit overlay bitmap', async ({ page }) => {
        await bootSolid(page)

        const result = await page.evaluate(async () => {
            const app = window.layersApp
            const layer = app._layers[0]
            await app._addLayerMask(layer.id)
            layer.mask.data[0] = 0
            layer.mask.data[1] = 0
            layer.mask.data[2] = 0
            layer.mask.data[3] = 255
            app._enterMaskEditMode(layer.id)
            const overlay = document.getElementById('maskOverlay')
            const alphaBefore = overlay.getContext('2d').getImageData(0, 0, 1, 1).data[3]
            const stageLayerSet = app._renderer.stageLayerSet.bind(app._renderer)
            app._renderer.stageLayerSet = async (candidate) => {
                const stage = await stageLayerSet(candidate)
                return { ...stage, success: false, error: 'forced candidate failure' }
            }

            const status = await app._handleCreateGradientBase(333, 222)
            const alphaAfter = overlay.getContext('2d').getImageData(0, 0, 1, 1).data[3]
            return {
                status,
                alphaBefore,
                alphaAfter,
                maskEditMode: app._maskEditMode,
                maskEditLayerId: app._maskEditLayerId,
                overlayHidden: overlay.classList.contains('hidden'),
            }
        })

        expect(result).toEqual({
            status: 'failed',
            alphaBefore: 128,
            alphaAfter: 128,
            maskEditMode: true,
            maskEditLayerId: expect.any(String),
            overlayHidden: false,
        })
    })

    test('post-exit replacement failure restores the mask-edit tool and UI', async ({ page }) => {
        await bootSolid(page)

        const result = await page.evaluate(async () => {
            const app = window.layersApp
            const layer = app._layers[0]
            await app._addLayerMask(layer.id)
            app._enterMaskEditMode(layer.id)
            app._setToolMode('eraser')
            const before = {
                currentTool: app._currentTool,
                maskEditMode: app._maskEditMode,
                maskEditLayerId: app._maskEditLayerId,
                hasStrokeHandler: Boolean(app._brushTool.onStrokeComplete),
                bannerHidden: document.getElementById('maskEditBanner')
                    .classList.contains('hidden'),
                brushTitle: document.getElementById('brushToolBtn').title,
                eraserTitle: document.getElementById('eraserToolBtn').title,
                overlayHidden: document.getElementById('maskOverlay')
                    .classList.contains('hidden'),
            }
            const exitMaskEditMode = app._exitMaskEditMode.bind(app)
            app._exitMaskEditMode = async (...args) => {
                await exitMaskEditMode(...args)
                throw new Error('injected post-exit failure')
            }

            const status = await app._handleCreateGradientBase(333, 222)
            return {
                status,
                before,
                after: {
                    currentTool: app._currentTool,
                    maskEditMode: app._maskEditMode,
                    maskEditLayerId: app._maskEditLayerId,
                    hasStrokeHandler: Boolean(app._brushTool.onStrokeComplete),
                    bannerHidden: document.getElementById('maskEditBanner')
                        .classList.contains('hidden'),
                    brushTitle: document.getElementById('brushToolBtn').title,
                    eraserTitle: document.getElementById('eraserToolBtn').title,
                    overlayHidden: document.getElementById('maskOverlay')
                        .classList.contains('hidden'),
                },
            }
        })

        expect(result.status).toBe('failed')
        expect(result.after).toEqual(result.before)
    })

    test('a pointer effect queued behind agent newProject is rejected', async ({ page }) => {
        await bootSolid(page)

        const result = await page.evaluate(async (untilSrc) => {
            const until = eval(untilSrc)
            const app = window.layersApp
            const rebuild = app._rebuild.bind(app)
            const stageLayerSet = app._renderer.stageLayerSet.bind(app._renderer)
            let blocked = false
            let release
            const hold = async () => {
                if (blocked) return
                blocked = true
                await new Promise(resolve => { release = resolve })
            }
            app._rebuild = async (...args) => {
                if (app._layers.length === 0) await hold()
                return rebuild(...args)
            }
            app._renderer.stageLayerSet = async (candidate) => {
                if (candidate.layers.length === 0) await hold()
                return stageLayerSet(candidate)
            }

            const agentPromise = window.LayersAgent.newProject({
                width: 210,
                height: 120,
                name: 'Replacement',
            })
            await until(() => blocked, 'agent newProject held at its first rebuild or stage')
            document.getElementById('textToolBtn').click()
            release()
            const envelope = await agentPromise
            // Observation window, not a readiness guess: the assertion is that the
            // pointer effect queued behind the agent did NOT land a layer.
            await new Promise(resolve => setTimeout(resolve, 50))
            return {
                agentOk: envelope.ok,
                width: app._canvas.width,
                height: app._canvas.height,
                layers: app._layers.map(layer => layer.effectId),
            }
        }, IN_PAGE_UNTIL)

        expect(result).toEqual({
            agentOk: true,
            width: 210,
            height: 120,
            layers: [],
        })
    })

    test('mask-edit exit cannot upload an old mask into a live replacement stage', async ({ page }) => {
        await bootSolid(page)

        const result = await page.evaluate(async (untilSrc) => {
            const until = eval(untilSrc)
            const app = window.layersApp
            const oldLayer = app._layers[0]
            await app._addLayerMask(oldLayer.id)
            app._enterMaskEditMode(oldLayer.id)

            const stageLayerSet = app._renderer.stageLayerSet.bind(app._renderer)
            const uploadMaskTexture = app._renderer.uploadMaskTexture.bind(app._renderer)
            let stageLive = false
            let uploadsDuringStage = 0
            let releaseStage
            app._renderer.uploadMaskTexture = (...args) => {
                if (stageLive) uploadsDuringStage += 1
                return uploadMaskTexture(...args)
            }
            app._renderer.stageLayerSet = async (candidate) => {
                const stage = await stageLayerSet(candidate)
                stageLive = true
                await new Promise(resolve => { releaseStage = resolve })
                return stage
            }

            const replacementPromise = app._handleCreateGradientBase(333, 222)
            await until(() => stageLive, 'replacement stage live')
            app._layerStack.selectedLayerId = null
            app._layerStack.dispatchEvent(new CustomEvent('selection-change'))
            // Observation window, not a readiness guess: the assertion is that no
            // mask upload arrived while the stage was live.
            await new Promise(resolve => setTimeout(resolve, 20))
            releaseStage()
            const status = await replacementPromise
            return { uploadsDuringStage, status, maskEditMode: app._maskEditMode }
        }, IN_PAGE_UNTIL)

        expect(result).toEqual({
            uploadsDuringStage: 0,
            status: 'opened',
            maskEditMode: false,
        })
    })

    test('a replacement cannot commit between layer-drag start and drop', async ({ page }) => {
        await bootSolid(page)

        const result = await page.evaluate(async () => {
            const app = window.layersApp
            await app._handleAddEffectLayer('filter/blur')
            await app._handleAddEffectLayer('filter/sharpen')
            const sourceId = app._layers[2].id
            const targetId = app._layers[1].id
            app._startDrag(sourceId)
            const dragOwnedLifecycle = app._projectLifecycleActive
            const replacementPromise = app._handleCreateGradientBase(333, 222)
            // Observation window, not a readiness guess: the assertion is that the
            // replacement did NOT commit while the drag held the lifecycle lease.
            await new Promise(resolve => setTimeout(resolve, 30))
            const replacementWaitedForDrag = app._projectReplacementActive
                && app._layers.length === 3
            await app._processDrop(targetId, 'below')
            const status = await replacementPromise
            return {
                dragOwnedLifecycle,
                replacementWaitedForDrag,
                status,
                finalEffects: app._layers.map(layer => layer.effectId),
                lifecycleActive: app._projectLifecycleActive,
                reorderState: app._reorderState,
            }
        })

        expect(result).toEqual({
            dragOwnedLifecycle: true,
            replacementWaitedForDrag: true,
            status: 'opened',
            finalEffects: ['synth/gradient'],
            lifecycleActive: false,
            reorderState: 'IDLE',
        })
    })

    test('copy completion cannot restore old-project origin after replacement', async ({ page }) => {
        await bootSolid(page)

        const result = await page.evaluate(async (untilSrc) => {
            const until = eval(untilSrc)
            const app = window.layersApp
            app._selectionManager.setSelection({
                type: 'rect', x: 5, y: 7, width: 20, height: 20,
            })
            let releaseClipboard
            let clipboardStarted = false
            const clipboard = navigator.clipboard
            const originalWrite = clipboard.write.bind(clipboard)
            clipboard.write = async () => {
                clipboardStarted = true
                await new Promise(resolve => { releaseClipboard = resolve })
            }
            document.dispatchEvent(new KeyboardEvent('keydown', {
                key: 'c', ctrlKey: true, bubbles: true,
            }))
            await until(() => clipboardStarted, 'clipboard write started')
            const replacementPromise = app._handleCreateGradientBase(333, 222)
            // Observation window, not a readiness guess: the assertion is that the
            // replacement did NOT commit while the copy was in flight.
            await new Promise(resolve => setTimeout(resolve, 30))
            const replacementWaitedForCopy = app._layers[0].effectId === 'synth/solid'
            releaseClipboard()
            const status = await replacementPromise
            clipboard.write = originalWrite
            return {
                replacementWaitedForCopy,
                status,
                copyOrigin: app._copyOrigin,
                finalEffects: app._layers.map(layer => layer.effectId),
            }
        }, IN_PAGE_UNTIL)

        expect(result).toEqual({
            replacementWaitedForCopy: true,
            status: 'opened',
            copyOrigin: null,
            finalEffects: ['synth/gradient'],
        })
    })

    test('an image-size dialog opened on the old project cannot resize its replacement', async ({ page }) => {
        await bootSolid(page)

        const result = await page.evaluate(async () => {
            const app = window.layersApp
            app._showImageSizeDialog()
            const dialog = document.querySelector('.image-size-dialog')
            dialog.querySelector('#image-size-constrain').checked = false
            dialog.querySelector('#image-size-constrain').dispatchEvent(new Event('change'))
            dialog.querySelector('#image-width').value = '300'
            dialog.querySelector('#image-height').value = '160'

            const envelope = await window.LayersAgent.newProject({
                width: 210,
                height: 120,
                name: 'Replacement',
            })
            dialog.querySelector('#image-size-ok').click()
            // Observation window, not a readiness guess: the assertion is that the
            // stale dialog's resize did NOT reach the replacement.
            await new Promise(resolve => setTimeout(resolve, 100))
            return {
                agentOk: envelope.ok,
                width: app._canvas.width,
                height: app._canvas.height,
                layers: app._layers.length,
            }
        })

        expect(result).toEqual({ agentOk: true, width: 210, height: 120, layers: 0 })
    })

    test('image-size dialog cannot open against old state during a live replacement', async ({ page }) => {
        await bootSolid(page)

        const result = await page.evaluate(async (untilSrc) => {
            const until = eval(untilSrc)
            const app = window.layersApp
            const stageLayerSet = app._renderer.stageLayerSet.bind(app._renderer)
            let stageLive = false
            let releaseStage
            app._renderer.stageLayerSet = async (candidate) => {
                const stage = await stageLayerSet(candidate)
                stageLive = true
                await new Promise(resolve => { releaseStage = resolve })
                return stage
            }
            const replacementPromise = app._handleCreateGradientBase(333, 222)
            await until(() => stageLive, 'replacement stage live')
            app._showImageSizeDialog()
            const dialog = document.querySelector('.image-size-dialog')
            const openedDuringStage = Boolean(dialog?.open)
            releaseStage()
            const status = await replacementPromise
            return {
                openedDuringStage,
                status,
                width: app._canvas.width,
                height: app._canvas.height,
            }
        }, IN_PAGE_UNTIL)

        expect(result).toEqual({
            openedDuringStage: false,
            status: 'opened',
            width: 333,
            height: 222,
        })
    })

    test('image-size dialog cannot open during an agent media resample', async ({ page }) => {
        await bootSolid(page)

        const result = await page.evaluate(async (untilSrc) => {
            const until = eval(untilSrc)
            const app = window.layersApp
            const blob = await (await fetch('/img/og-image.png')).blob()
            const file = new File([blob], 'resample-source.png', { type: 'image/png' })
            await app._handleOpenMedia(file, 'image')
            const prepareMediaResource = app._renderer.prepareMediaResource.bind(app._renderer)
            let resampleStarted = false
            let releaseResample
            app._renderer.prepareMediaResource = async (...args) => {
                resampleStarted = true
                await new Promise(resolve => { releaseResample = resolve })
                return prepareMediaResource(...args)
            }
            const resizePromise = window.LayersAgent.resizeImage({ width: 320, height: 180 })
            await until(() => resampleStarted, 'agent media resample started')
            document.getElementById('imageSizeMenuItem').click()
            const dialogOpened = Boolean(document.querySelector('.image-size-dialog')?.open)
            releaseResample()
            const envelope = await resizePromise
            return {
                dialogOpened,
                agentOk: envelope.ok,
                width: app._canvas.width,
                height: app._canvas.height,
            }
        }, IN_PAGE_UNTIL)

        expect(result).toEqual({
            dialogOpened: false,
            agentOk: true,
            width: 320,
            height: 180,
        })
    })

    test('a save dialog opened on the old project cannot overwrite it with replacement state', async ({ page }) => {
        await bootSolid(page)

        const result = await page.evaluate(async () => {
            const app = window.layersApp
            const { getProject } = await import('/js/utils/project-storage.js')
            const { saveProjectDialog } = await import('/js/ui/save-project-dialog.js')
            await app._saveProject(null, 'Original')
            const originalId = app._currentProjectId
            const originalLayerIds = app._layers.map(layer => layer.id)
            app._showSaveProjectDialog()
            const staleSave = saveProjectDialog._onSave
            const envelope = await window.LayersAgent.newProject({
                width: 210,
                height: 120,
                name: 'Replacement',
            })
            await staleSave(originalId, 'Original')
            const stored = await getProject(originalId)
            return {
                agentOk: envelope.ok,
                currentProjectId: app._currentProjectId,
                currentLayers: app._layers.length,
                storedLayerIds: stored.layers.map(layer => layer.id),
                originalLayerIds,
            }
        })

        expect(result.agentOk).toBe(true)
        expect(result.currentProjectId).toBeNull()
        expect(result.currentLayers).toBe(0)
        expect(result.storedLayerIds).toEqual(result.originalLayerIds)
    })

    test('image export holds the lifecycle lease through native capture and save', async ({ page }) => {
        await bootSolid(page)

        const result = await page.evaluate(async (untilSrc) => {
            const until = eval(untilSrc)
            const app = window.layersApp
            const dialog = app._exportImageDialog
            const original = [app._canvas.width, app._canvas.height]
            const captureCanvas = dialog.captureCanvas
            const saveImage = app._files.saveImage
            const stageLayerSet = app._renderer.stageLayerSet
            const resizeCanvas = app._resizeCanvas
            let releaseCapture
            const captureGate = new Promise(resolve => { releaseCapture = resolve })
            let signalCaptured
            const captured = new Promise(resolve => { signalCaptured = resolve })
            let replacementStageReached = false
            let dimensionsAtSave = null
            let dimensionsAtReplacement = null
            let savedResolution = null
            let leaseHeldAtSave = false
            let savedBeforeReplacement = false
            let exportPromise
            let replacementPromise
            try {
                dialog.captureCanvas = async options => {
                    const canvas = await captureCanvas(options)
                    signalCaptured()
                    await captureGate
                    return canvas
                }
                app._files.saveImage = canvas => {
                    savedResolution = [canvas.width, canvas.height]
                    dimensionsAtSave = [app._canvas.width, app._canvas.height]
                    leaseHeldAtSave = Boolean(app._projectLifecycleActive)
                }
                app._renderer.stageLayerSet = async candidate => {
                    replacementStageReached = true
                    return stageLayerSet.call(app._renderer, candidate)
                }
                app._resizeCanvas = (width, height, ...args) => {
                    if (width === 333 && height === 222) {
                        dimensionsAtReplacement = [app._canvas.width, app._canvas.height]
                        savedBeforeReplacement = savedResolution !== null
                    }
                    return resizeCanvas.call(app, width, height, ...args)
                }
                dialog.open()
                document.getElementById('exportImageWidth').value = '200'
                document.getElementById('exportImageHeight').value = '100'
                exportPromise = dialog._export()
                await Promise.race([
                    captured,
                    exportPromise.then(() => { throw new Error('Export finished before native capture was held') }),
                ])
                replacementPromise = app._handleCreateGradientBase(333, 222)
                await until(
                    () => app._projectLifecycleWaiters || replacementStageReached
                        || dimensionsAtReplacement,
                    'replacement queued behind the export lease, or started', 5000)
                const replacementWaited = !replacementStageReached && !dimensionsAtReplacement
                    && app._projectLifecycleWaiters > 0
                releaseCapture()
                await exportPromise
                const status = await replacementPromise
                return {
                    replacementWaited,
                    originalPreservedThroughSave: JSON.stringify(dimensionsAtSave) === JSON.stringify(original),
                    originalPreservedUntilReplacement: JSON.stringify(dimensionsAtReplacement) === JSON.stringify(original),
                    savedResolution,
                    leaseHeldAtSave,
                    savedBeforeReplacement,
                    status,
                    width: app._canvas.width,
                    height: app._canvas.height,
                }
            } finally {
                releaseCapture()
                await Promise.allSettled([exportPromise, replacementPromise])
                dialog.captureCanvas = captureCanvas
                app._files.saveImage = saveImage
                app._renderer.stageLayerSet = stageLayerSet
                app._resizeCanvas = resizeCanvas
            }
        }, IN_PAGE_UNTIL)

        expect(result).toEqual({
            replacementWaited: true,
            originalPreservedThroughSave: true,
            originalPreservedUntilReplacement: true,
            savedResolution: [200, 100],
            leaseHeldAtSave: true,
            savedBeforeReplacement: true,
            status: 'opened',
            width: 333,
            height: 222,
        })
    })

    test('a thrown lifecycle task releases the next replacement', async ({ page }) => {
        await bootSolid(page)

        const result = await page.evaluate(async () => {
            const app = window.layersApp
            let message = null
            try {
                await app._runProjectLifecycle(null, async () => {
                    throw new Error('mutation failed')
                })
            } catch (err) {
                message = err.message
            }
            const replacementStatus = await app._handleCreateGradientBase(333, 222)
            return {
                message,
                replacementStatus,
                lifecycleActive: app._projectLifecycleActive,
                sameArray: app._layers === app._renderer._layers,
            }
        })

        expect(result).toEqual({
            message: 'mutation failed',
            replacementStatus: 'opened',
            lifecycleActive: false,
            sameArray: true,
        })
    })

    test('post-commit dialog failure still reports the saved project as opened', async ({ page }) => {
        await bootSolid(page)

        const result = await page.evaluate(async () => {
            const app = window.layersApp
            const blob = await (await fetch('/img/og-image.png')).blob()
            const file = new File([blob], 'saved-owner.png', { type: 'image/png' })
            await app._handleOpenMedia(file, 'image')
            await app._saveProject(null, 'Owned media project')
            const projectId = app._currentProjectId
            const mediaLayerId = app._layers[0].id
            await app._handleCreateSolidBase(320, 180)

            const { openDialog } = await import('/js/ui/open-dialog.js')
            const classList = openDialog._backdrop.classList
            const remove = classList.remove.bind(classList)
            let threw = false
            classList.remove = (...tokens) => {
                if (!threw && tokens.includes('visible')) {
                    threw = true
                    throw new Error('post-commit close failed')
                }
                return remove(...tokens)
            }

            let error = null
            try {
                await app._loadProject(projectId)
            } catch (err) {
                error = err.message
            }
            return {
                error,
                expectedProjectId: projectId,
                expectedMediaLayerId: mediaLayerId,
                currentProjectId: app._currentProjectId,
                mediaLayerId: app._layers[0]?.id,
                resourceAlive: Boolean(app._renderer.getMediaInfo(mediaLayerId)),
            }
        })

        expect(result.error).toBeNull()
        expect(result.currentProjectId).toBe(result.expectedProjectId)
        expect(result.mediaLayerId).toBe(result.expectedMediaLayerId)
        expect(result.resourceAlive).toBe(true)
    })

    test('post-commit dialog failure still reports a new base as opened', async ({ page }) => {
        await bootSolid(page)

        const result = await page.evaluate(async () => {
            const app = window.layersApp
            const { openDialog } = await import('/js/ui/open-dialog.js')
            const classList = openDialog._backdrop.classList
            const remove = classList.remove.bind(classList)
            let threw = false
            classList.remove = (...tokens) => {
                if (!threw && tokens.includes('visible')) {
                    threw = true
                    throw new Error('post-commit close failed')
                }
                return remove(...tokens)
            }

            let status = null
            let error = null
            try {
                status = await app._handleCreateGradientBase(333, 222)
            } catch (err) {
                error = err.message
            }
            return {
                status,
                error,
                width: app._canvas.width,
                height: app._canvas.height,
                lifecycleActive: app._projectLifecycleActive,
                sameArray: app._layers === app._renderer._layers,
            }
        })

        expect(result).toEqual({
            status: 'opened',
            error: null,
            width: 333,
            height: 222,
            lifecycleActive: false,
            sameArray: true,
        })
    })

    test('post-commit toast failure still reports new media as opened', async ({ page }) => {
        await bootSolid(page)

        const result = await page.evaluate(async () => {
            const app = window.layersApp
            const { toast } = await import('/js/ui/toast.js')
            toast.success = () => { throw new Error('post-commit toast failed') }
            const blob = await (await fetch('/img/og-image.png')).blob()
            const file = new File([blob], 'post-commit.png', { type: 'image/png' })

            let status = null
            let error = null
            try {
                status = await app._handleOpenMedia(file, 'image')
            } catch (err) {
                error = err.message
            }
            return {
                status,
                error,
                layerName: app._layers[0]?.name,
                resourceAlive: Boolean(app._renderer.getMediaInfo(app._layers[0]?.id)),
                lifecycleActive: app._projectLifecycleActive,
            }
        })

        expect(result).toEqual({
            status: 'opened',
            error: null,
            layerName: 'post-commit',
            resourceAlive: true,
            lifecycleActive: false,
        })
    })

    test('offline cleanup failure after disconnect cannot roll back a replacement', async ({ page }) => {
        await bootSolid(page)

        const result = await page.evaluate(async () => {
            const app = window.layersApp
            const { createLayersOnlineAdapter } = await import('/js/collab/onlineAdapter.js')
            const { buildNodeModel } = await import('/js/collab/docModel.js')
            const { toast } = await import('/js/ui/toast.js')
            const nodes = buildNodeModel(app._layers, {
                width: app._canvas.width, height: app._canvas.height,
            })
            let status = 'offline'
            let throwCleanup = false
            const dialog = {
                set state(_value) {
                    if (throwCleanup) throw new Error('status cleanup failed')
                },
                set sessionId(_value) {}, set sessionUrl(_value) {},
            }
            const online = {
                on() {},
                getStatus: () => status,
                getSessionId: () => 'leave1',
                getShareUrl: () => 'https://layers.test/?seance=leave1',
                getNodes: () => nodes,
                joinSession: async () => { status = 'online' },
                goOffline: () => {
                    status = 'offline'
                    if (throwCleanup) throw new Error('disconnect callback failed')
                },
                writeSessionToUrl: (url) => url,
            }
            const adapter = createLayersOnlineAdapter(app, {
                location: new URL('https://layers.test/'),
                history: {
                    replaceState() {
                        if (throwCleanup) throw new Error('URL cleanup failed')
                    },
                },
                dialog,
                importSdk: async () => ({ createOnlineDslLayer: () => online }),
            })
            app._onlineAdapter = adapter
            await adapter.joinSession('leave1', { skipConfirm: true })
            throwCleanup = true
            toast.info = () => { throw new Error('offline toast failed') }

            let replacementStatus = null
            let error = null
            try {
                replacementStatus = await app._handleCreateGradientBase(333, 222, {
                    leaveOnline: true,
                })
            } catch (err) {
                error = err.message
            }
            return {
                replacementStatus,
                error,
                online: adapter.isOnline(),
                size: [app._canvas.width, app._canvas.height],
                layerNames: app._layers.map(layer => layer.name),
                sameRendererLayers: app._renderer._layers === app._layers,
            }
        })

        expect(result).toEqual({
            replacementStatus: 'opened',
            error: null,
            online: false,
            size: [333, 222],
            layerNames: ['Gradient'],
            sameRendererLayers: true,
        })
    })

    test('agent mutations wait for a live human replacement stage to settle', async ({ page }) => {
        await bootSolid(page)

        const result = await page.evaluate(async (untilSrc) => {
            const until = eval(untilSrc)
            const app = window.layersApp
            const stageLayerSet = app._renderer.stageLayerSet.bind(app._renderer)
            let heldFirstStage = false
            app._renderer.stageLayerSet = async (candidate) => {
                const stage = await stageLayerSet(candidate)
                if (heldFirstStage) return stage
                heldFirstStage = true
                window.__agentWaitStageReached = true
                await new Promise(resolve => { window.__releaseAgentWaitStage = resolve })
                return stage
            }

            const installPromise = app._handleCreateGradientBase(333, 222)
            await until(() => window.__agentWaitStageReached, 'human replacement stage live')
            let agentSettled = false
            const agentPromise = window.LayersAgent
                .newProject({ width: 210, height: 120, name: 'After replacement' })
                .then(result => { agentSettled = true; return result })
            // Observation window, not a readiness guess: the assertion is that the
            // agent mutation did NOT settle while the stage was held.
            await new Promise(resolve => setTimeout(resolve, 50))
            const deferredDuringStage = !agentSettled
            window.__releaseAgentWaitStage()
            const [installStatus, agentResult] = await Promise.all([installPromise, agentPromise])

            return {
                deferredDuringStage,
                installStatus,
                agentOk: agentResult.ok,
                appLayerCount: app._layers.length,
                rendererLayerCount: app._renderer._layers.length,
                sameArray: app._layers === app._renderer._layers,
            }
        }, IN_PAGE_UNTIL)

        expect(result).toEqual({
            deferredDuringStage: true,
            installStatus: 'opened',
            agentOk: true,
            appLayerCount: 0,
            rendererLayerCount: 0,
            sameArray: true,
        })
    })

    test('a replacement waits for an agent media mutation that is still fetching', async ({ page }) => {
        await bootSolid(page)

        const result = await page.evaluate(async (untilSrc) => {
            const until = eval(untilSrc)
            const app = window.layersApp
            const originalFetch = window.fetch.bind(window)
            const order = []
            let releaseFetch
            let fetchStarted = false
            window.fetch = async (input, options) => {
                if (input === 'https://layers.test/delayed.png') {
                    fetchStarted = true
                    await new Promise(resolve => { releaseFetch = resolve })
                    return originalFetch('/img/og-image.png')
                }
                return originalFetch(input, options)
            }

            const stageLayerSet = app._renderer.stageLayerSet.bind(app._renderer)
            app._renderer.stageLayerSet = async (candidate) => {
                const isAgentCandidate = candidate.layers.some(layer =>
                    layer.name === 'Delayed agent media')
                order.push(isAgentCandidate ? 'agent-stage' : 'replacement-stage')
                return stageLayerSet(candidate)
            }

            const agentPromise = window.LayersAgent.addLayer({
                kind: 'media',
                source: { kind: 'url', value: 'https://layers.test/delayed.png' },
                mediaType: 'image',
                name: 'Delayed agent media',
            }).then(envelope => {
                order.push('agent-settled')
                return envelope
            })
            await until(() => fetchStarted, 'agent media fetch started')

            const replacementPromise = app._handleCreateGradientBase(333, 222)
            // Observation window, not a readiness guess: the assertion is that the
            // replacement did NOT reach staging while the agent fetch was in flight.
            await new Promise(resolve => setTimeout(resolve, 50))
            const replacementDeferredDuringFetch = !order.includes('replacement-stage')
            releaseFetch()
            const [agentEnvelope, replacementStatus] = await Promise.all([
                agentPromise, replacementPromise,
            ])

            return {
                replacementDeferredDuringFetch,
                order,
                agentOk: agentEnvelope.ok,
                replacementStatus,
                finalLayerCount: app._layers.length,
                sameArray: app._layers === app._renderer._layers,
            }
        }, IN_PAGE_UNTIL)

        expect(result).toEqual({
            replacementDeferredDuringFetch: true,
            order: ['agent-stage', 'agent-settled', 'replacement-stage'],
            agentOk: true,
            replacementStatus: 'opened',
            finalLayerCount: 1,
            sameArray: true,
        })
    })

    test('confirmed replacement cancels when an earlier mutation lands before commit', async ({ page }) => {
        await bootSolid(page)

        await page.evaluate((untilSrc) => {
            const until = eval(untilSrc)
            const app = window.layersApp
            const originalFetch = window.fetch.bind(window)
            window.__consentRace = {}
            window.fetch = async (input, options) => {
                if (input === 'https://layers.test/consent-race.png') {
                    window.__consentRace.fetchStarted = true
                    await new Promise(resolve => {
                        window.__consentRace.releaseFetch = resolve
                    })
                    return originalFetch('/img/og-image.png')
                }
                return originalFetch(input, options)
            }
            window.__consentRace.completion = (async () => {
                const agentPromise = window.LayersAgent.addLayer({
                    kind: 'media',
                    source: { kind: 'url', value: 'https://layers.test/consent-race.png' },
                    mediaType: 'image',
                    name: 'Mutation confirmed before completion',
                })
                await until(() => window.__consentRace.fetchStarted, 'agent media fetch started')
                window.__consentRace.replacementStarted = true
                let replacementStatus = null
                const accepted = await app._startProjectReplacement(({
                    leaveOnline, replacementConsent,
                }) => app._handleCreateGradientBase(333, 222, {
                    leaveOnline,
                    replacementConsent,
                }).then(status => { replacementStatus = status }))
                const agentEnvelope = await agentPromise
                return {
                    accepted,
                    replacementStatus,
                    agentOk: agentEnvelope.ok,
                    layerNames: app._layers.map(layer => layer.name),
                    size: [app._canvas.width, app._canvas.height],
                    lifecycleActive: app._projectLifecycleActive,
                }
            })()
        }, IN_PAGE_UNTIL)

        await expect.poll(() => page.evaluate(
            () => Boolean(window.__consentRace?.replacementStarted))).toBe(true)
        await expect(page.locator('.confirm-dialog-backdrop.visible')).toBeVisible()
        await page.locator('#confirm-ok').click()
        await page.evaluate(() => window.__consentRace.releaseFetch())
        const result = await page.evaluate(() => window.__consentRace.completion)

        expect(result).toEqual({
            accepted: true,
            replacementStatus: 'cancelled',
            agentOk: true,
            layerNames: ['Solid', 'Mutation confirmed before completion'],
            size: [1024, 1024],
            lifecycleActive: false,
        })
    })

    test('concurrent project replacement guards resolve in request order', async ({ page }) => {
        await bootSolid(page)

        await page.evaluate(() => {
            const app = window.layersApp
            window.__replacementGuardRace = { started: [] }
            const first = app._startProjectReplacement(() => {
                window.__replacementGuardRace.started.push('first')
            })
            const second = app._startProjectReplacement(() => {
                window.__replacementGuardRace.started.push('second')
            })
            window.__replacementGuardRace.completion = Promise.all([first, second])
        })

        const confirmation = page.locator('.confirm-dialog-backdrop.visible')
        await expect(confirmation).toBeVisible()
        await page.locator('#confirm-ok').click()
        await expect(confirmation).toBeVisible()
        await page.locator('#confirm-cancel').click()

        const result = await page.evaluate(async () => ({
            accepted: await window.__replacementGuardRace.completion,
            started: window.__replacementGuardRace.started,
        }))
        expect(result).toEqual({ accepted: [true, false], started: ['first'] })
    })

    test('replacement consent for session A cannot disconnect session B', async ({ page }) => {
        await bootSolid(page)

        const result = await page.evaluate(async () => {
            const app = window.layersApp
            let online = true
            let sessionIdentity = 'session-A'
            const disconnectedSessions = []
            app._onlineAdapter = {
                isOnline: () => online,
                isApplyingRemote: () => false,
                getSessionIdentity: () => sessionIdentity,
                schedulePublish() {},
                goOffline: () => {
                    disconnectedSessions.push(sessionIdentity)
                    online = false
                },
            }
            app._confirmLeaveOnlineSession = async () => true
            app._confirmUnsavedChanges = async () => true
            const before = {
                layerIds: app._layers.map(layer => layer.id),
                size: [app._canvas.width, app._canvas.height],
            }
            let replacementStatus = null
            const accepted = await app._startProjectReplacement(async ({
                leaveOnline, replacementConsent,
            }) => {
                sessionIdentity = 'session-B'
                replacementStatus = await app._handleCreateGradientBase(333, 222, {
                    leaveOnline,
                    replacementConsent,
                })
            })
            return {
                accepted,
                replacementStatus,
                disconnectedSessions,
                online,
                sessionIdentity,
                layerIds: app._layers.map(layer => layer.id),
                size: [app._canvas.width, app._canvas.height],
                before,
            }
        })

        expect(result.accepted).toBe(true)
        expect(result.replacementStatus).toBe('cancelled')
        expect(result.disconnectedSessions).toEqual([])
        expect(result.online).toBe(true)
        expect(result.sessionIdentity).toBe('session-B')
        expect(result.layerIds).toEqual(result.before.layerIds)
        expect(result.size).toEqual(result.before.size)
    })

    test('replacement and join confirmations resolve FIFO without stealing each other', async ({ page }) => {
        await bootSolid(page)

        await page.evaluate(async () => {
            const app = window.layersApp
            const { createLayersOnlineAdapter } = await import('/js/collab/onlineAdapter.js')
            let status = 'offline'
            const online = {
                on() {},
                getStatus: () => status,
                getSessionId: () => 'join01',
                getShareUrl: () => 'https://layers.test/?seance=join01',
                getNodes: () => [],
                joinSession: async () => { status = 'online' },
                goOffline: () => { status = 'offline' },
                writeSessionToUrl: (url) => url,
            }
            const adapter = createLayersOnlineAdapter(app, {
                location: new URL('https://layers.test/'),
                history: { replaceState() {} }, dialog: null,
                importSdk: async () => ({ createOnlineDslLayer: () => online }),
            })
            app._onlineAdapter = adapter
            app._markDirty()
            window.__crossFlowConfirm = { started: [] }
            const replacement = app._startProjectReplacement(() => {
                window.__crossFlowConfirm.started.push('replacement')
            })
            await new Promise(resolve => setTimeout(resolve, 0))
            const join = adapter.joinSession('join01')
            window.__crossFlowConfirm.completion = Promise.all([replacement, join])
        })

        const confirmation = page.locator('.confirm-dialog-backdrop.visible')
        const message = confirmation.locator('.confirm-message')
        await expect(message).toHaveText('You have unsaved changes. Discard them?')
        await confirmation.locator('#confirm-ok').click()
        await expect(message).toHaveText('Joining replaces your current composition. Continue?')
        await confirmation.locator('#confirm-cancel').click()

        const result = await page.evaluate(async () => ({
            completion: await window.__crossFlowConfirm.completion,
            started: window.__crossFlowConfirm.started,
        }))
        expect(result).toEqual({ completion: [true, null], started: ['replacement'] })
    })

    test('a replacement waits for a human media mutation that is still decoding', async ({ page }) => {
        await bootSolid(page)

        const result = await page.evaluate(async (untilSrc) => {
            const until = eval(untilSrc)
            const app = window.layersApp
            const blob = await (await fetch('/img/og-image.png')).blob()
            const file = new File([blob], 'delayed-human.png', { type: 'image/png' })
            const prepareMediaResource = app._renderer.prepareMediaResource.bind(app._renderer)
            const order = []
            let decoding = false
            let releaseDecode
            app._renderer.prepareMediaResource = async (...args) => {
                decoding = true
                await new Promise(resolve => { releaseDecode = resolve })
                return prepareMediaResource(...args)
            }

            const stageLayerSet = app._renderer.stageLayerSet.bind(app._renderer)
            app._renderer.stageLayerSet = async (candidate) => {
                if (candidate.layers.length === 1
                    && candidate.layers[0].effectId === 'synth/gradient') {
                    order.push('replacement-stage')
                }
                return stageLayerSet(candidate)
            }

            const addPromise = app._handleAddMediaLayer(file, 'image').then(() => {
                order.push('human-media-settled')
            })
            await until(() => decoding, 'human media decode started')
            const replacementPromise = app._handleCreateGradientBase(333, 222)
            // Observation window, not a readiness guess: the assertion is that the
            // replacement did NOT reach staging while the media was still decoding.
            await new Promise(resolve => setTimeout(resolve, 50))
            const replacementDeferredDuringDecode = !order.includes('replacement-stage')
            releaseDecode()
            const [, replacementStatus] = await Promise.all([addPromise, replacementPromise])

            return {
                replacementDeferredDuringDecode,
                order,
                replacementStatus,
                finalLayerCount: app._layers.length,
                sameArray: app._layers === app._renderer._layers,
            }
        }, IN_PAGE_UNTIL)

        expect(result).toEqual({
            replacementDeferredDuringDecode: true,
            order: ['human-media-settled', 'replacement-stage'],
            replacementStatus: 'opened',
            finalLayerCount: 1,
            sameArray: true,
        })
    })

    test('pointer layer additions are ignored while a replacement stage is live', async ({ page }) => {
        await bootSolid(page)

        const result = await page.evaluate(async (untilSrc) => {
            const until = eval(untilSrc)
            const app = window.layersApp
            const stageLayerSet = app._renderer.stageLayerSet.bind(app._renderer)
            let stageReached = false
            let releaseStage
            app._renderer.stageLayerSet = async (candidate) => {
                const stage = await stageLayerSet(candidate)
                stageReached = true
                await new Promise(resolve => { releaseStage = resolve })
                return stage
            }

            const replacementPromise = app._handleCreateGradientBase(333, 222)
            await until(() => stageReached, 'replacement stage live')
            document.getElementById('textToolBtn').click()
            // Observation window, not a readiness guess: the assertion is that the
            // pointer add did NOT reach the model while the stage was held.
            await new Promise(resolve => setTimeout(resolve, 50))
            const unchangedDuringStage = app._layers.length === 1
            releaseStage()
            const replacementStatus = await replacementPromise

            return {
                unchangedDuringStage,
                replacementStatus,
                layerCount: app._layers.length,
                effectIds: app._layers.map(layer => layer.effectId),
                sameArray: app._layers === app._renderer._layers,
            }
        }, IN_PAGE_UNTIL)

        expect(result).toEqual({
            unchangedDuringStage: true,
            replacementStatus: 'opened',
            layerCount: 1,
            effectIds: ['synth/gradient'],
            sameArray: true,
        })
    })

})
