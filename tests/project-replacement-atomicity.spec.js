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
            // One macrotask turn, and the turn is the measurement: the assertion is
            // that the invalid command did NOT resolve while the stage was held.
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
                // The timer is this race's failure bound, not a wait: it wins only if
                // the barrier never releases.
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
                // The timer is this race's failure bound, not a wait: it wins only if
                // the barrier never releases.
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

        expect(ids[0]).toBe('layer-0')
        expect(ids[1]).toMatch(/^layer-2-[a-f0-9]{32}$/)
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
        expect(result.finalId).toMatch(new RegExp(`^layer-${Number.MAX_SAFE_INTEGER}-[a-f0-9]{32}$`))
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
        await page.goto('/', { waitUntil: 'networkidle' })
        await page.locator('#loading-screen').waitFor({ state: 'hidden' })
        await defaultProjectReady(page)
        await page.getByRole('menuitem', { name: 'Layers menu', exact: true }).click()
        await page.getByRole('menuitem', { name: 'welcome to Layers...', exact: true }).click()
        await page.locator('.welcome-dialog[open]').waitFor()
        const chooserPromise = page.waitForEvent('filechooser')
        await page.locator('.welcome-tile[data-action="open"]').click()
        await (await chooserPromise).setFiles(path.resolve('public/img/og-image.png'))
        await expect.poll(() => page.evaluate(() => window.layersApp._isDirty)).toBe(true)
        await expect(page.locator('.welcome-dialog[open]')).toBeHidden()
        expect(pageErrors).toEqual([])
    })
})
