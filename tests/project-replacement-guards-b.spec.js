import { test, expect } from './fixtures.js'
import path from 'node:path'
import { IN_PAGE_UNTIL, defaultProjectReady } from './waits.js'
import { reopenNewProjectDialog } from './helpers/new-project.js'

// Parallel mode makes each case its own sharding unit: every case here boots
// its own app and shares no state with its siblings, so shards can split this
// file instead of pinning all of it to one runner.
test.describe.configure({ mode: 'parallel' })

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

})
