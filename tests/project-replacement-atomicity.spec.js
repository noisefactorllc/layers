import { test, expect } from 'playwright/test'
import path from 'node:path'

async function bootSolid(page) {
    await page.goto('/', { waitUntil: 'networkidle' })
    await page.locator('#loading-screen').waitFor({ state: 'hidden' })
    const backdrop = page.locator('.open-dialog-backdrop.visible')
    await backdrop.waitFor()
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
    test('a rebuild queued inside a live stage cannot replay old layers after commit', async ({ page }) => {
        await bootSolid(page)

        const result = await page.evaluate(async () => {
            const app = window.layersApp
            const oldLayers = app._layers
            const stageLayerSet = app._renderer.stageLayerSet.bind(app._renderer)
            app._renderer.stageLayerSet = async (candidate) => {
                const stage = await stageLayerSet(candidate)
                window.__queuedOldProjectRebuild = app._rebuild({ force: true })
                return stage
            }

            const status = await app._handleCreateGradientBase(333, 222)
            const staleResult = await window.__queuedOldProjectRebuild
            return {
                status,
                staleResult,
                oldLayerIds: oldLayers.map(layer => layer.id),
                appLayerIds: app._layers.map(layer => layer.id),
                rendererLayerIds: app._renderer._layers.map(layer => layer.id),
                sameArray: app._renderer._layers === app._layers,
            }
        })

        expect(result.status).toBe('opened')
        expect(result.staleResult.stale).toBe(true)
        expect(result.sameArray).toBe(true)
        expect(result.rendererLayerIds).toEqual(result.appLayerIds)
        expect(result.appLayerIds).not.toEqual(result.oldLayerIds)
    })

    test('a commit-time exception restores app and renderer state and releases the stage', async ({ page }) => {
        await bootSolid(page)
        const before = await projectState(page)

        const result = await page.evaluate(async () => {
            const app = window.layersApp
            const undo = app._undoManager
            const pushState = undo.pushState.bind(undo)
            let throwOnce = true
            undo.pushState = (snapshot) => {
                if (throwOnce) {
                    throwOnce = false
                    throw new Error('commit undo failed')
                }
                return pushState(snapshot)
            }

            let status = 'rejected'
            let error = null
            try {
                status = await app._handleCreateGradientBase(444, 222)
            } catch (err) {
                error = err.message
            }
            const barrierReleased = await Promise.race([
                app._renderer.setLayers(app._layers, { force: true }).then(() => true),
                new Promise(resolve => setTimeout(() => resolve(false), 500)),
            ])
            return { status, error, barrierReleased }
        })

        expect(result).toEqual({ status: 'failed', error: null, barrierReleased: true })
        expect(await projectState(page)).toEqual(before)
    })

    test('a failed renderer restoration is surfaced in the replacement error', async ({ page }) => {
        await bootSolid(page)

        const result = await page.evaluate(async () => {
            const app = window.layersApp
            app._renderer.stageLayerSet = async () => ({
                success: false,
                error: 'candidate compile failed',
                commit: () => {},
                rollback: async () => ({ success: false, error: 'old restore failed' }),
            })
            const generation = ++app._replacementGeneration
            const outcome = await app._installPreparedProject({
                layers: structuredClone(app._layers),
                width: 320,
                height: 180,
                projectId: null,
                projectName: null,
                dirty: true,
                selectedLayerId: app._layers[0].id,
                mediaTextures: new Map(),
                maskTextures: new Map(),
            }, { generation })
            return {
                message: outcome.error?.message,
                rendererRunning: app._renderer.isRunning,
            }
        })

        expect(result.message).toContain('old restore failed')
        expect(result.rendererRunning).toBe(false)
    })

    test('duplicate persisted layer IDs are rejected before replacing the project', async ({ page }) => {
        await bootSolid(page)
        const before = await projectState(page)
        const layers = await page.evaluate(() => {
            const base = structuredClone(window.layersApp._layers[0])
            base.id = 'duplicate-layer'
            base.mediaFile = null
            return [base, { ...structuredClone(base), name: 'Duplicate' }]
        })
        await putProject(page, { id: 'duplicate-id-project', layers })

        const error = await page.evaluate(async () => {
            try {
                await window.layersApp._loadProject('duplicate-id-project')
                return null
            } catch (err) {
                return err.message
            }
        })

        expect(error).toContain('duplicate')
        expect(await projectState(page)).toEqual(before)
    })

    test('loaded top-level and child IDs advance the local layer generator', async ({ page }) => {
        await bootSolid(page)
        const layers = await page.evaluate(() => {
            const base = structuredClone(window.layersApp._layers[0])
            base.id = 'layer-0'
            base.mediaFile = null
            base.children = [{
                id: 'layer-1',
                name: 'Loaded child',
                effectId: 'filter/blur',
                effectParams: {},
                visible: true,
            }]
            return [base]
        })
        await putProject(page, { id: 'counter-project', layers })

        const ids = await page.evaluate(async () => {
            const { resetLayerCounter } = await import('/js/layers/layer-model.js')
            resetLayerCounter()
            await window.layersApp._loadProject('counter-project')
            await window.layersApp._handleAddEffectLayer('filter/sharpen')
            return window.layersApp._layers.map(layer => layer.id)
        })

        expect(ids).toEqual(['layer-0', 'layer-2'])
    })

    test('a persisted ID whose successor is unsafe is rejected', async ({ page }) => {
        await bootSolid(page)
        const before = await projectState(page)
        const layers = await page.evaluate(() => {
            const base = structuredClone(window.layersApp._layers[0])
            base.id = `layer-${Number.MAX_SAFE_INTEGER}`
            base.mediaFile = null
            return [base]
        })
        await putProject(page, { id: 'unsafe-successor-project', layers })

        const error = await page.evaluate(async () => {
            try {
                await window.layersApp._loadProject('unsafe-successor-project')
                return null
            } catch (err) {
                return err.message
            }
        })

        expect(error).toContain('unsafe')
        expect(await projectState(page)).toEqual(before)
    })

    test('clone allocation fails atomically at the safe-integer boundary', async ({ page }) => {
        await bootSolid(page)

        const result = await page.evaluate(async () => {
            const {
                bumpLayerCounter,
                cloneLayer,
                createChildEffect,
                resetLayerCounter,
            } = await import('/js/layers/layer-model.js')
            resetLayerCounter()
            bumpLayerCounter(Number.MAX_SAFE_INTEGER)
            const source = {
                id: 'source',
                name: 'Source',
                effectParams: {},
                children: [{ id: 'child', effectParams: {} }],
            }
            let cloneError = null
            try {
                cloneLayer(source)
            } catch (err) {
                cloneError = err.message
            }
            const finalId = createChildEffect('filter/blur').id
            let exhaustedError = null
            try {
                createChildEffect('filter/blur')
            } catch (err) {
                exhaustedError = err.message
            }
            return { cloneError, finalId, exhaustedError }
        })

        expect(result.cloneError).toContain('safe integer')
        expect(result.finalId).toBe(`layer-${Number.MAX_SAFE_INTEGER}`)
        expect(result.exhaustedError).toContain('safe integer')
    })

    test('loading an empty project compiles and installs a transparent pipeline', async ({ page }) => {
        await bootSolid(page)
        await putProject(page, { id: 'empty-project', layers: [], width: 210, height: 120 })

        const result = await page.evaluate(async () => {
            const app = window.layersApp
            const loadAndCompile = app._renderer._loadAndCompile.bind(app._renderer)
            const compiled = []
            app._renderer._loadAndCompile = async (dsl) => {
                compiled.push(dsl)
                return loadAndCompile(dsl)
            }
            const status = await app._loadProject('empty-project')
            return {
                status,
                layers: app._layers.length,
                currentDsl: app._renderer.currentDsl,
                compiled,
            }
        })

        expect(result.status).toBe('opened')
        expect(result.layers).toBe(0)
        expect(result.currentDsl).toContain('alpha: 0')
        expect(result.compiled.at(-1)).toContain('alpha: 0')
    })

    test('loading a saved empty drawing layer does not create a null canvas resource', async ({ page }) => {
        await bootSolid(page)
        const layers = await page.evaluate(async () => {
            const { createDrawingLayer } = await import('/js/layers/layer-model.js')
            return [structuredClone(createDrawingLayer('Empty Drawing'))]
        })
        await putProject(page, { id: 'empty-drawing-project', layers })

        const result = await page.evaluate(async () => {
            const app = window.layersApp
            const status = await app._loadProject('empty-drawing-project')
            return {
                status,
                sourceType: app._layers[0]?.sourceType,
                strokes: app._layers[0]?.strokes,
                hasMediaResource: Boolean(app._renderer.getMediaInfo(app._layers[0]?.id)),
            }
        })

        expect(result).toEqual({
            status: 'opened',
            sourceType: 'drawing',
            strokes: [],
            hasMediaResource: false,
        })
    })

    test('joining an online session during staging rolls the unapproved replacement back', async ({ page }) => {
        await bootSolid(page)
        const before = await projectState(page)

        const result = await page.evaluate(async () => {
            const app = window.layersApp
            const stageLayerSet = app._renderer.stageLayerSet.bind(app._renderer)
            let online = false
            let wentOffline = false
            app._onlineAdapter = {
                isOnline: () => online,
                goOffline: () => { online = false; wentOffline = true },
                schedulePublish: () => {},
            }
            app._renderer.stageLayerSet = async (candidate) => {
                const stage = await stageLayerSet(candidate)
                online = true
                return stage
            }
            const status = await app._handleCreateGradientBase(333, 222)
            return { status, online, wentOffline }
        })

        expect(result).toEqual({ status: 'failed', online: true, wentOffline: false })
        expect(await projectState(page)).toEqual(before)
    })

    test('an in-flight remote apply blocks replacement staging', async ({ page }) => {
        await bootSolid(page)
        const before = await projectState(page)

        const status = await page.evaluate(async () => {
            const app = window.layersApp
            app._onlineAdapter = {
                isOnline: () => false,
                isApplyingRemote: () => true,
                schedulePublish: () => {},
            }
            return app._handleCreateGradientBase(333, 222)
        })

        expect(status).toBe('failed')
        expect(await projectState(page)).toEqual(before)
    })

    test('candidate media texture upload failure rolls back the replacement', async ({ page }) => {
        await bootSolid(page)
        const before = await projectState(page)

        const result = await page.evaluate(async () => {
            const app = window.layersApp
            const engine = app._renderer._renderer
            const updateTexture = engine.updateTextureFromSource.bind(engine)
            const stageLayerSet = app._renderer.stageLayerSet.bind(app._renderer)
            let rejectedCandidate = false
            let candidateUploads = 0
            app._renderer.stageLayerSet = (candidate) => {
                candidate.layers[0].scaleX = 1.25
                return stageLayerSet(candidate)
            }
            engine.updateTextureFromSource = (...args) => {
                if (app._renderer._layers[0]?.sourceType === 'media') {
                    candidateUploads += 1
                }
                if (!rejectedCandidate && candidateUploads === 2) {
                    rejectedCandidate = true
                    throw new Error('candidate transformed texture upload failed')
                }
                return updateTexture(...args)
            }
            const blob = await (await fetch('/img/og-image.png')).blob()
            const file = new File([blob], 'candidate.png', { type: 'image/png' })
            const status = await app._handleOpenMedia(file, 'image')
            return { status, rejectedCandidate }
        })

        expect(result).toEqual({ status: 'failed', rejectedCandidate: true })
        expect(await projectState(page)).toEqual(before)
    })

    test('strict text staging rejects a candidate when the compiled pipeline is missing', async ({ page }) => {
        await bootSolid(page)
        const before = await projectState(page)

        const result = await page.evaluate(async () => {
            const app = window.layersApp
            const { createEffectLayer } = await import('/js/layers/layer-model.js')
            const textLayer = createEffectLayer('filter/text')
            const loadAndCompile = app._renderer._loadAndCompile.bind(app._renderer)
            let sabotaged = false
            app._renderer._loadAndCompile = async (dsl) => {
                await loadAndCompile(dsl)
                if (!sabotaged && app._renderer._layers === candidate.layers) {
                    sabotaged = true
                    app._renderer._renderer.pipeline.graph = null
                }
            }
            const candidate = {
                layers: [textLayer],
                width: 320,
                height: 180,
                projectId: null,
                projectName: null,
                dirty: true,
                selectedLayerId: textLayer.id,
                mediaTextures: new Map(),
                maskTextures: new Map(),
            }
            const generation = ++app._replacementGeneration
            const outcome = await app._installPreparedProject(candidate, { generation })
            return { status: outcome.status, error: outcome.error?.message, sabotaged }
        })

        expect(result.sabotaged).toBe(true)
        expect(result.status).toBe('failed')
        expect(result.error).toContain('text texture')
        expect(await projectState(page)).toEqual(before)
    })

    test('direct Welcome media completion does not require an Open dialog backdrop', async ({ page }) => {
        const pageErrors = []
        page.on('pageerror', error => pageErrors.push(error.message))
        await page.goto('/?welcome=1', { waitUntil: 'networkidle' })
        await page.locator('#loading-screen').waitFor({ state: 'hidden' })
        const chooserPromise = page.waitForEvent('filechooser')
        await page.locator('.welcome-tile[data-action="open"]').click()
        await (await chooserPromise).setFiles(path.resolve('public/img/og-image.png'))
        await expect.poll(() => page.evaluate(() => window.layersApp._isDirty)).toBe(true)
        await expect(page.locator('.welcome-dialog[open]')).toBeHidden()
        expect(pageErrors).toEqual([])
    })

    test('agent mutations wait for a live human replacement stage to settle', async ({ page }) => {
        await bootSolid(page)

        const result = await page.evaluate(async () => {
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
            while (!window.__agentWaitStageReached) {
                await new Promise(resolve => setTimeout(resolve, 0))
            }
            let agentSettled = false
            const agentPromise = window.LayersAgent
                .newProject({ width: 210, height: 120, name: 'After replacement' })
                .then(result => { agentSettled = true; return result })
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
        })

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

        const result = await page.evaluate(async () => {
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
                order.push('replacement-stage')
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
            while (!fetchStarted) await new Promise(resolve => setTimeout(resolve, 0))

            const replacementPromise = app._handleCreateGradientBase(333, 222)
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
        })

        expect(result).toEqual({
            replacementDeferredDuringFetch: true,
            order: ['agent-settled', 'replacement-stage'],
            agentOk: true,
            replacementStatus: 'opened',
            finalLayerCount: 1,
            sameArray: true,
        })
    })

    test('a replacement waits for a human media mutation that is still decoding', async ({ page }) => {
        await bootSolid(page)

        const result = await page.evaluate(async () => {
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
                order.push('replacement-stage')
                return stageLayerSet(candidate)
            }

            const addPromise = app._handleAddMediaLayer(file, 'image').then(() => {
                order.push('human-media-settled')
            })
            while (!decoding) await new Promise(resolve => setTimeout(resolve, 0))
            const replacementPromise = app._handleCreateGradientBase(333, 222)
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
        })

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

        const result = await page.evaluate(async () => {
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
            while (!stageReached) await new Promise(resolve => setTimeout(resolve, 0))
            document.getElementById('textToolBtn').click()
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
        })

        expect(result).toEqual({
            unchangedDuringStage: true,
            replacementStatus: 'opened',
            layerCount: 1,
            effectIds: ['synth/gradient'],
            sameArray: true,
        })
    })

    test('Select All cannot capture candidate dimensions during a failed stage', async ({ page }) => {
        await bootSolid(page)

        const result = await page.evaluate(async () => {
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
            while (!window.__selectStageReached) {
                await new Promise(resolve => setTimeout(resolve, 0))
            }
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
        })

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

    test('a pointer effect queued behind agent newProject is rejected', async ({ page }) => {
        await bootSolid(page)

        const result = await page.evaluate(async () => {
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
            while (!blocked) await new Promise(resolve => setTimeout(resolve, 0))
            document.getElementById('textToolBtn').click()
            release()
            const envelope = await agentPromise
            await new Promise(resolve => setTimeout(resolve, 50))
            return {
                agentOk: envelope.ok,
                width: app._canvas.width,
                height: app._canvas.height,
                layers: app._layers.map(layer => layer.effectId),
            }
        })

        expect(result).toEqual({
            agentOk: true,
            width: 210,
            height: 120,
            layers: [],
        })
    })

    test('mask-edit exit cannot upload an old mask into a live replacement stage', async ({ page }) => {
        await bootSolid(page)

        const result = await page.evaluate(async () => {
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
            while (!stageLive) await new Promise(resolve => setTimeout(resolve, 0))
            app._layerStack.selectedLayerId = null
            app._layerStack.dispatchEvent(new CustomEvent('selection-change'))
            await new Promise(resolve => setTimeout(resolve, 20))
            releaseStage()
            const status = await replacementPromise
            return { uploadsDuringStage, status, maskEditMode: app._maskEditMode }
        })

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

        const result = await page.evaluate(async () => {
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
            while (!clipboardStarted) await new Promise(resolve => setTimeout(resolve, 0))
            const replacementPromise = app._handleCreateGradientBase(333, 222)
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
        })

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

        const result = await page.evaluate(async () => {
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
            while (!stageLive) await new Promise(resolve => setTimeout(resolve, 0))
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
        })

        expect(result).toEqual({
            openedDuringStage: false,
            status: 'opened',
            width: 333,
            height: 222,
        })
    })

    test('image-size dialog cannot open during an agent media resample', async ({ page }) => {
        await bootSolid(page)

        const result = await page.evaluate(async () => {
            const app = window.layersApp
            const blob = await (await fetch('/img/og-image.png')).blob()
            const file = new File([blob], 'resample-source.png', { type: 'image/png' })
            await app._handleOpenMedia(file, 'image')
            const resampleMediaLayer = app._resampleMediaLayer.bind(app)
            let resampleStarted = false
            let releaseResample
            app._resampleMediaLayer = async (...args) => {
                resampleStarted = true
                await new Promise(resolve => { releaseResample = resolve })
                return resampleMediaLayer(...args)
            }
            const resizePromise = window.LayersAgent.resizeImage({ width: 320, height: 180 })
            while (!resampleStarted) await new Promise(resolve => setTimeout(resolve, 0))
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
        })

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

    test('image export holds the lifecycle lease until its resolution is restored', async ({ page }) => {
        await bootSolid(page)

        const result = await page.evaluate(async () => {
            const app = window.layersApp
            const original = { width: app._canvas.width, height: app._canvas.height }
            const originalRaf = window.requestAnimationFrame.bind(window)
            let releaseExportFrame
            let held = false
            window.requestAnimationFrame = (callback) => {
                if (!held) {
                    held = true
                    releaseExportFrame = () => originalRaf(callback)
                    return 1
                }
                return originalRaf(callback)
            }
            app._files.saveImage = () => {}
            app._exportImageDialog.open()
            document.getElementById('exportImageWidth').value = '200'
            document.getElementById('exportImageHeight').value = '100'
            const exportPromise = app._exportImageDialog._export()
            while (!held) await new Promise(resolve => setTimeout(resolve, 0))

            let replacementStageReached = false
            const stageLayerSet = app._renderer.stageLayerSet.bind(app._renderer)
            app._renderer.stageLayerSet = async (candidate) => {
                replacementStageReached = true
                return stageLayerSet(candidate)
            }
            const replacementPromise = app._handleCreateGradientBase(333, 222)
            await new Promise(resolve => setTimeout(resolve, 30))
            const replacementWaited = !replacementStageReached
            releaseExportFrame()
            await exportPromise
            const restoredBeforeReplacement = app._canvas.width === original.width
                && app._canvas.height === original.height
            const status = await replacementPromise
            window.requestAnimationFrame = originalRaf
            return {
                replacementWaited,
                restoredBeforeReplacement,
                status,
                width: app._canvas.width,
                height: app._canvas.height,
            }
        })

        expect(result).toEqual({
            replacementWaited: true,
            restoredBeforeReplacement: true,
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

    test('post-commit dialog failure cannot dispose renderer-owned saved media', async ({ page }) => {
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

        expect(result.error).toBe('post-commit close failed')
        expect(result.currentProjectId).toBe(result.expectedProjectId)
        expect(result.mediaLayerId).toBe(result.expectedMediaLayerId)
        expect(result.resourceAlive).toBe(true)
    })
})
