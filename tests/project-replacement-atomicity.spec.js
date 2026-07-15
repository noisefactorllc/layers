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
    test('post-settlement stage cleanup failure preserves the committed project and session', async ({ page }) => {
        await bootSolid(page)

        const result = await page.evaluate(async () => {
            const app = window.layersApp
            let online = true
            let wentOffline = false
            app._onlineAdapter = {
                isOnline: () => online,
                isApplyingRemote: () => false,
                goOffline: () => {
                    online = false
                    wentOffline = true
                },
                schedulePublish: () => {},
            }
            const stageLayerSet = app._renderer.stageLayerSet.bind(app._renderer)
            app._renderer.stageLayerSet = async (candidate) => {
                const stage = await stageLayerSet(candidate)
                const commit = stage.commit.bind(stage)
                stage.commit = () => {
                    commit()
                    throw new Error('injected settled-stage cleanup failure')
                }
                return stage
            }

            const status = await app._handleCreateGradientBase(333, 222, {
                leaveOnline: true,
            })
            return {
                status,
                online,
                wentOffline,
                effectId: app._layers[0]?.effectId,
                size: [app._canvas.width, app._canvas.height],
                sameLayers: app._renderer._layers === app._layers,
            }
        })

        expect(result).toEqual({
            status: 'opened',
            online: false,
            wentOffline: true,
            effectId: 'synth/gradient',
            size: [333, 222],
            sameLayers: true,
        })
    })

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

    test('agent envelopes never snapshot transient replacement canvas state', async ({ page }) => {
        await bootSolid(page)

        const result = await page.evaluate(async () => {
            const app = window.layersApp
            const before = {
                canvas: { width: app._canvas.width, height: app._canvas.height },
                layerIds: app._layers.map(layer => layer.id),
            }
            let enterStage
            let releaseStage
            const entered = new Promise(resolve => { enterStage = resolve })
            const release = new Promise(resolve => { releaseStage = resolve })
            app._renderer.stageLayerSet = async () => {
                enterStage()
                await release
                return { success: false, error: 'injected staged replacement failure' }
            }

            const replacement = app._handleCreateGradientBase(333, 222)
            await entered
            const jobEnvelope = await window.LayersAgent.getJob({ jobId: 'missing-job' })
            let invalidResolved = false
            const invalidPromise = window.LayersAgent.resizeImage({
                width: 'invalid', height: 100,
            }).then(envelope => {
                invalidResolved = true
                return envelope
            })
            await new Promise(resolve => setTimeout(resolve, 0))
            const resolvedBeforeRelease = invalidResolved
            releaseStage()
            const status = await replacement
            const invalidEnvelope = await invalidPromise
            return {
                before,
                status,
                resolvedBeforeRelease,
                jobState: jobEnvelope.state,
                invalidState: invalidEnvelope.state,
                after: {
                    canvas: { width: app._canvas.width, height: app._canvas.height },
                    layerIds: app._layers.map(layer => layer.id),
                },
            }
        })

        expect(result.status).toBe('failed')
        expect(result.resolvedBeforeRelease).toBe(false)
        expect(result.jobState.canvas).toEqual(result.before.canvas)
        expect(result.jobState.layers.map(layer => layer.id)).toEqual(result.before.layerIds)
        expect(result.invalidState.canvas).toEqual(result.before.canvas)
        expect(result.invalidState.layers.map(layer => layer.id)).toEqual(result.before.layerIds)
        expect(result.after).toEqual(result.before)
    })

    test('job polling hides a replacement model that fails after the app swap', async ({ page }) => {
        await bootSolid(page)

        const result = await page.evaluate(async () => {
            const app = window.layersApp
            app._selectionManager.setSelection({
                type: 'rect', x: 10, y: 20, width: 30, height: 40,
            })
            app._currentProjectId = 'original-project'
            app._currentProjectName = 'Original project'
            const readState = async () => {
                const { state } = await window.LayersAgent.getJob({ jobId: 'missing-job' })
                return {
                    project: state.project,
                    canvas: state.canvas,
                    selection: state.selection,
                    layers: state.layers,
                    selectedLayerIds: state.selectedLayerIds,
                    activeLayerId: state.activeLayerId,
                }
            }
            const before = await readState()
            let enteredExit
            let releaseExit
            const entered = new Promise(resolve => { enteredExit = resolve })
            const release = new Promise(resolve => { releaseExit = resolve })
            app._maskEditMode = true
            app._maskEditLayerId = 'missing-mask-layer'
            app._exitMaskEditMode = async () => {
                enteredExit()
                await release
                throw new Error('injected post-swap replacement failure')
            }

            const replacement = app._handleCreateGradientBase(333, 222)
            await entered
            const liveDuring = {
                canvas: { width: app._canvas.width, height: app._canvas.height },
                layerIds: app._layers.map(layer => layer.id),
            }
            const during = await readState()
            releaseExit()
            const status = await replacement
            const after = await readState()
            return { before, liveDuring, during, status, after }
        })

        expect(result.status).toBe('failed')
        expect(result.liveDuring.canvas).toEqual({ width: 333, height: 222 })
        expect(result.liveDuring.layerIds).not.toEqual(
            result.before.layers.map(layer => layer.id))
        expect(result.during).toEqual(result.before)
        expect(result.after).toEqual(result.before)
    })

    test('a commit-time exception restores app and renderer state and releases the stage', async ({ page }) => {
        await bootSolid(page)
        await page.evaluate(async () => {
            await window.LayersAgent.addLayer({
                kind: 'effect', effectId: 'filter/blur', name: 'Second layer',
            })
            const stack = window.layersApp._layerStack
            stack.selectedLayerIds = window.layersApp._layers.map(layer => layer.id)
            stack._lastClickedLayerId = window.layersApp._layers[0].id
        })
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

    test('canvas restore failure still releases a failed replacement stage', async ({ page }) => {
        await bootSolid(page)

        const result = await page.evaluate(async () => {
            const app = window.layersApp
            const previousSize = {
                width: app._canvas.width,
                height: app._canvas.height,
            }
            const resizeCanvas = app._resizeCanvas.bind(app)
            app._resizeCanvas = (width, height) => {
                resizeCanvas(width, height)
                if (width === previousSize.width && height === previousSize.height) {
                    throw new Error('live canvas restore failed')
                }
            }

            const stageLayerSet = app._renderer.stageLayerSet.bind(app._renderer)
            app._renderer.stageLayerSet = async (candidate) => ({
                ...await stageLayerSet(candidate),
                success: false,
                error: 'candidate compile failed',
            })

            let status = 'rejected'
            let message = null
            try {
                const outcome = await app._handleCreateGradientBase(333, 222)
                status = outcome
            } catch (err) {
                message = err.message
            }
            const stageGateResult = await Promise.race([
                app._renderer.setLayers(app._layers, { force: true })
                    .then(() => 'released'),
                new Promise(resolve => setTimeout(() => resolve('blocked'), 100)),
            ])
            return { status, message, stageGateResult }
        })

        expect(result).toEqual({
            status: 'failed',
            message: null,
            stageGateResult: 'released',
        })
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

    test('invalid persisted canvas dimensions are rejected before replacement', async ({ page }) => {
        await bootSolid(page)
        const before = await projectState(page)
        const cases = [
            { id: 'fractional-canvas-project', width: 320.5, height: 180 },
            { id: 'oversized-canvas-project', width: 8193, height: 180 },
        ]
        for (const candidate of cases) {
            await putProject(page, { ...candidate, layers: [] })
        }

        const results = await page.evaluate(async (ids) => {
            const app = window.layersApp
            const outcomes = []
            for (const id of ids) {
                try {
                    outcomes.push({ id, status: await app._loadProject(id), error: null })
                } catch (err) {
                    outcomes.push({ id, status: null, error: err.message })
                }
            }
            return outcomes
        }, cases.map(candidate => candidate.id))

        expect(results).toEqual(cases.map(candidate => ({
            id: candidate.id,
            status: null,
            error: 'Saved project has invalid canvas dimensions',
        })))
        expect(await projectState(page)).toEqual(before)
    })

    test('oversized persisted mask headers are rejected before image allocation', async ({ page }) => {
        await bootSolid(page)
        const before = await projectState(page)
        const layers = await page.evaluate(() => {
            const base = structuredClone(window.layersApp._layers[0])
            const bytes = [
                137, 80, 78, 71, 13, 10, 26, 10,
                0, 0, 0, 13, 73, 72, 68, 82,
                0, 0, 32, 1,
                0, 0, 0, 1,
            ]
            base.mask = `data:image/png;base64,${btoa(String.fromCharCode(...bytes))}`
            return [base]
        })
        await putProject(page, { id: 'oversized-mask-project', layers })

        const result = await page.evaluate(async () => {
            const app = window.layersApp
            let maskPreparations = 0
            app._renderer.prepareMaskTexture = () => {
                maskPreparations += 1
                throw new Error('oversized mask reached texture preparation')
            }
            let error = null
            try {
                await app._loadProject('oversized-mask-project')
            } catch (err) {
                error = err.message || String(err)
            }
            return { error, maskPreparations }
        })

        expect(result.error).toMatch(/mask dimensions/i)
        expect(result.maskPreparations).toBe(0)
        expect(await projectState(page)).toEqual(before)
    })

    test('persisted masks must match the project canvas dimensions', async ({ page }) => {
        await bootSolid(page)
        const before = await projectState(page)
        const layers = await page.evaluate(() => {
            const base = structuredClone(window.layersApp._layers[0])
            const canvas = document.createElement('canvas')
            canvas.width = 1
            canvas.height = 1
            canvas.getContext('2d').fillRect(0, 0, 1, 1)
            base.mask = canvas.toDataURL('image/png')
            return [base]
        })
        await putProject(page, { id: 'undersized-mask-project', layers })

        const error = await page.evaluate(async () => {
            try {
                await window.layersApp._loadProject('undersized-mask-project')
                return null
            } catch (err) {
                return err.message || String(err)
            }
        })

        expect(error).toMatch(/mask dimensions.*project canvas/i)
        expect(await projectState(page)).toEqual(before)
    })

    test('invalid persisted layer semantics are rejected before renderer staging', async ({ page }) => {
        await bootSolid(page)
        const before = await projectState(page)
        const cases = await page.evaluate(() => {
            const base = structuredClone(window.layersApp._layers[0])
            return [
                { id: 'invalid-blend-project', layer: { ...structuredClone(base), blendMode: 'bogus' } },
                { id: 'invalid-scale-project', layer: { ...structuredClone(base), scaleX: 0 } },
                {
                    id: 'invalid-param-project',
                    layer: {
                        ...structuredClone(base),
                        effectParams: { ...base.effectParams, undeclaredParameter: 1 },
                    },
                },
                {
                    id: 'invalid-rgba-project',
                    layer: {
                        ...structuredClone(base),
                        effectParams: { ...base.effectParams, color: [1, 0, 0, 0.5] },
                    },
                },
                {
                    id: 'invalid-member-project',
                    layer: {
                        ...structuredClone(base),
                        children: [{
                            id: 'invalid-member-child',
                            name: 'Invalid channel',
                            effectId: 'filter/channel',
                            effectParams: { channel: 'channel.notARealMember' },
                            visible: true,
                        }],
                    },
                },
                {
                    id: 'invalid-choice-project',
                    layer: {
                        ...structuredClone(base),
                        children: [{
                            id: 'invalid-choice-child',
                            name: 'Invalid text choice',
                            effectId: 'filter/text',
                            effectParams: { text: 'Choice', justify: 'diagonal' },
                            visible: true,
                        }],
                    },
                },
            ]
        })
        for (const candidate of cases) {
            await putProject(page, { id: candidate.id, layers: [candidate.layer] })
        }

        const result = await page.evaluate(async (ids) => {
            const app = window.layersApp
            let stages = 0
            app._renderer.stageLayerSet = async () => {
                stages += 1
                throw new Error('invalid persisted semantics reached renderer staging')
            }
            const errors = []
            for (const id of ids) {
                try {
                    await app._loadProject(id)
                    errors.push(null)
                } catch (err) {
                    errors.push(err.message || String(err))
                }
            }
            return { errors, stages }
        }, cases.map(candidate => candidate.id))

        expect(result.stages).toBe(0)
        expect(result.errors[0]).toMatch(/blendMode/i)
        expect(result.errors[1]).toMatch(/scale/i)
        expect(result.errors[2]).toMatch(/parameter/i)
        expect(result.errors[3]).toMatch(/RGB array/i)
        expect(result.errors[4]).toMatch(/declared enum member/i)
        expect(result.errors[5]).toMatch(/declared choice/i)
        expect(await projectState(page)).toEqual(before)
    })

    test('oversized saved media is disposed before renderer staging', async ({ page }) => {
        await bootSolid(page)
        const projectId = await page.evaluate(async () => {
            const app = window.layersApp
            const blob = await (await fetch('/img/og-image.png')).blob()
            const file = new File([blob], 'saved-media.png', { type: 'image/png' })
            const added = await app._handleAddMediaLayer(file, 'image')
            if (added.status !== 'added') throw added.error
            const saved = await window.LayersAgent.saveProjectAs({ name: 'saved-media-bounds' })
            if (!saved.ok) throw new Error(saved.error.message)
            return saved.result.projectId
        })
        const before = await projectState(page)

        const result = await page.evaluate(async (projectId) => {
            const app = window.layersApp
            const oversized = { width: 8193, height: 1, element: {} }
            let disposed = false
            let staged = false
            app._renderer.prepareMediaResource = async () => oversized
            app._renderer.disposeMediaResource = (resource) => {
                if (resource === oversized) disposed = true
            }
            app._renderer.stageLayerSet = async () => {
                staged = true
                throw new Error('oversized saved media reached staging')
            }
            let error = null
            try {
                await app._loadProject(projectId)
            } catch (err) {
                error = err.message || String(err)
            }
            return { error, disposed, staged }
        }, projectId)

        expect(result.error).toMatch(/media dimensions/i)
        expect(result.disposed).toBe(true)
        expect(result.staged).toBe(false)
        expect(await projectState(page)).toEqual(before)
    })

    test('oversized opened media is disposed before project staging', async ({ page }) => {
        await bootSolid(page)
        const before = await projectState(page)

        const result = await page.evaluate(async () => {
            const app = window.layersApp
            const resource = { width: 8193, height: 1, element: {} }
            let disposed = false
            let staged = false
            app._renderer.prepareMediaResource = async () => resource
            app._renderer.disposeMediaResource = (candidate) => {
                disposed = candidate === resource
            }
            app._renderer.stageLayerSet = async () => {
                staged = true
                throw new Error('oversized media reached project staging')
            }
            const file = new File(['oversized'], 'oversized.png', { type: 'image/png' })
            const status = await app._handleOpenMedia(file, 'image')
            return { status, disposed, staged }
        })

        expect(result).toEqual({ status: 'failed', disposed: true, staged: false })
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
            order: ['agent-stage', 'agent-settled', 'replacement-stage'],
            agentOk: true,
            replacementStatus: 'opened',
            finalLayerCount: 1,
            sameArray: true,
        })
    })

    test('confirmed replacement cancels when an earlier mutation lands before commit', async ({ page }) => {
        await bootSolid(page)

        await page.evaluate(() => {
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
                while (!window.__consentRace.fetchStarted) {
                    await new Promise(resolve => setTimeout(resolve, 0))
                }
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
        })

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
                if (candidate.layers.length === 1
                    && candidate.layers[0].effectId === 'synth/gradient') {
                    order.push('replacement-stage')
                }
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
            const prepareMediaResource = app._renderer.prepareMediaResource.bind(app._renderer)
            let resampleStarted = false
            let releaseResample
            app._renderer.prepareMediaResource = async (...args) => {
                resampleStarted = true
                await new Promise(resolve => { releaseResample = resolve })
                return prepareMediaResource(...args)
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
})
