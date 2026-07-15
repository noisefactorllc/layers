import { test, expect } from 'playwright/test'

async function bootSolid(page) {
    await page.goto('/', { waitUntil: 'networkidle' })
    await page.locator('#loading-screen').waitFor({ state: 'hidden' })
    const backdrop = page.locator('.open-dialog-backdrop.visible')
    await backdrop.waitFor()
    await page.locator('.media-option[data-type="solid"]').click()
    await page.locator('.canvas-size-dialog .action-btn.primary').click()
    await backdrop.waitFor({ state: 'hidden' })
}

test('remote apply waits until the project lifecycle lease is released', async ({ page }) => {
    await bootSolid(page)

    const result = await page.evaluate(async () => {
        const app = window.layersApp
        const { createLayersOnlineAdapter } = await import('/js/collab/onlineAdapter.js')
        const { buildNodeModel } = await import('/js/collab/docModel.js')
        const { createEffectLayer } = await import('/js/layers/layer-model.js')
        const handlers = new Map()
        let status = 'offline'
        let nodes = buildNodeModel(app._layers, {
            width: app._canvas.width, height: app._canvas.height,
        })
        const online = {
            on: (event, handler) => handlers.set(event, handler),
            getStatus: () => status,
            getSessionId: () => 'remote1',
            getShareUrl: () => 'https://layers.test/?seance=remote1',
            getNodes: () => nodes,
            joinSession: async () => { status = 'online' },
            goOffline: () => { status = 'offline' },
            writeSessionToUrl: (url) => url,
        }
        const adapter = createLayersOnlineAdapter(app, {
            location: new URL('https://layers.test/'),
            history: { replaceState() {} },
            dialog: null,
            importSdk: async () => ({ createOnlineDslLayer: () => online }),
        })
        await adapter.joinSession('remote1', { skipConfirm: true })

        const remoteLayer = createEffectLayer('synth/gradient', 'Remote')
        remoteLayer.id = 'layer-500'
        nodes = buildNodeModel([remoteLayer], { width: 275, height: 155 })
        const token = await app._acquireProjectLifecycle()
        handlers.get('remote-node')?.({})
        await new Promise(resolve => setTimeout(resolve, 300))
        const deferredIds = app._layers.map(layer => layer.id)
        const deferredSize = [app._canvas.width, app._canvas.height]
        token.release()
        const applyDeadline = performance.now() + 5000
        while ((app._layers.length !== 1 || app._layers[0].id !== 'layer-500')
            && performance.now() < applyDeadline) {
            await new Promise(resolve => setTimeout(resolve, 10))
        }
        return {
            deferredIds,
            deferredSize,
            finalIds: app._layers.map(layer => layer.id),
            finalSize: [app._canvas.width, app._canvas.height],
        }
    })

    expect(result.deferredIds).not.toEqual(['layer-500'])
    expect(result.deferredSize).not.toEqual([275, 155])
    expect(result.finalIds).toEqual(['layer-500'])
    expect(result.finalSize).toEqual([275, 155])
})

test('job polling snapshots hide a remote candidate canvas that later rolls back', async ({ page }) => {
    await bootSolid(page)

    const result = await page.evaluate(async () => {
        const app = window.layersApp
        const { createLayersOnlineAdapter } = await import('/js/collab/onlineAdapter.js')
        const { buildNodeModel } = await import('/js/collab/docModel.js')
        const { createEffectLayer } = await import('/js/layers/layer-model.js')
        const handlers = new Map()
        let status = 'offline'
        let nodes = buildNodeModel(app._layers, {
            width: app._canvas.width,
            height: app._canvas.height,
        })
        const online = {
            on: (event, handler) => handlers.set(event, handler),
            getStatus: () => status,
            getSessionId: () => 'snapshot-rollback',
            getShareUrl: () => 'https://layers.test/?seance=snapshot-rollback',
            getNodes: () => nodes,
            joinSession: async () => { status = 'online' },
            goOffline: () => { status = 'offline' },
            writeSessionToUrl: url => url,
        }
        const adapter = createLayersOnlineAdapter(app, {
            location: new URL('https://layers.test/'),
            history: { replaceState() {} },
            dialog: null,
            importSdk: async () => ({ createOnlineDslLayer: () => online }),
        })
        await adapter.joinSession('snapshot-rollback', { skipConfirm: true })

        const { readRenderPixels } = await import('/js/utils/canvas-readback.js')
        const readCenter = () => Array.from(readRenderPixels(
            app._canvas,
            Math.floor(app._canvas.width / 2),
            Math.floor(app._canvas.height / 2),
            1,
            1,
        ))
        app._renderer.stop()
        app._renderCurrentFrame()
        const original = {
            canvas: { width: app._canvas.width, height: app._canvas.height },
            layerIds: app._layers.map(layer => layer.id),
        }
        const beforePixel = readCenter()
        const remoteLayer = createEffectLayer('synth/gradient', 'Rolled back remote')
        remoteLayer.id = 'layer-700'
        nodes = buildNodeModel([remoteLayer], { width: 275, height: 155 })
        const stageLayerSet = app._renderer.stageLayerSet.bind(app._renderer)
        let enterStage
        let releaseStage
        const entered = new Promise(resolve => { enterStage = resolve })
        const release = new Promise(resolve => { releaseStage = resolve })
        app._renderer.stageLayerSet = async () => {
            enterStage()
            await release
            return {
                success: false,
                error: 'injected remote candidate failure',
                rollback: async () => ({ success: true }),
            }
        }

        handlers.get('remote-node')?.({})
        await entered
        const liveDuring = { width: app._canvas.width, height: app._canvas.height }
        const polled = await window.LayersAgent.getJob({ jobId: 'missing-job' })
        releaseStage()
        while (adapter.isApplyingRemote()) {
            await new Promise(resolve => setTimeout(resolve, 10))
        }
        app._renderer.stageLayerSet = stageLayerSet
        return {
            original,
            liveDuring,
            snapshot: {
                canvas: polled.state.canvas,
                layerIds: polled.state.layers.map(layer => layer.id),
            },
            final: {
                canvas: { width: app._canvas.width, height: app._canvas.height },
                layerIds: app._layers.map(layer => layer.id),
            },
            beforePixel,
            afterPixel: readCenter(),
            running: app._renderer.isRunning,
        }
    })

    expect(result.liveDuring).toEqual({ width: 275, height: 155 })
    expect(result.snapshot).toEqual(result.original)
    expect(result.final).toEqual(result.original)
    expect(result.afterPixel).toEqual(result.beforePixel)
    expect(result.running).toBe(false)
})

test('session cancellation after remote resize redraws the paused project', async ({ page }) => {
    await bootSolid(page)

    const result = await page.evaluate(async () => {
        const app = window.layersApp
        const { createLayersOnlineAdapter } = await import('/js/collab/onlineAdapter.js')
        const { buildNodeModel } = await import('/js/collab/docModel.js')
        const { createEffectLayer } = await import('/js/layers/layer-model.js')
        const { readRenderPixels } = await import('/js/utils/canvas-readback.js')
        const handlers = new Map()
        let status = 'offline'
        let nodes = buildNodeModel(app._layers, {
            width: app._canvas.width,
            height: app._canvas.height,
        })
        const online = {
            on: (event, handler) => handlers.set(event, handler),
            getStatus: () => status,
            getSessionId: () => 'paused-cancellation',
            getShareUrl: () => 'https://layers.test/?seance=paused-cancellation',
            getNodes: () => nodes,
            joinSession: async () => { status = 'online' },
            goOffline: () => { status = 'offline' },
            writeSessionToUrl: url => url,
        }
        const adapter = createLayersOnlineAdapter(app, {
            location: new URL('https://layers.test/'),
            history: { replaceState() {} },
            dialog: null,
            importSdk: async () => ({ createOnlineDslLayer: () => online }),
        })
        await adapter.joinSession('paused-cancellation', { skipConfirm: true })

        const readCenter = () => Array.from(readRenderPixels(
            app._canvas,
            Math.floor(app._canvas.width / 2),
            Math.floor(app._canvas.height / 2),
            1,
            1,
        ))
        app._renderer.stop()
        app._renderCurrentFrame()
        const before = {
            canvas: [app._canvas.width, app._canvas.height],
            layerIds: app._layers.map(layer => layer.id),
            pixel: readCenter(),
        }

        const remoteLayer = createEffectLayer('synth/gradient', 'Cancelled remote')
        remoteLayer.id = 'layer-705'
        nodes = buildNodeModel([remoteLayer], { width: 275, height: 155 })
        const resizeCanvas = app._resizeCanvas.bind(app)
        let cancelled = false
        let signalCancellation
        const cancellation = new Promise(resolve => { signalCancellation = resolve })
        app._resizeCanvas = (width, height) => {
            resizeCanvas(width, height)
            if (!cancelled && width === 275 && height === 155) {
                cancelled = true
                adapter.goOffline()
                signalCancellation()
            }
        }

        handlers.get('remote-node')?.({})
        await cancellation
        while (adapter.isApplyingRemote()) {
            await new Promise(resolve => setTimeout(resolve, 10))
        }
        return {
            cancelled,
            before,
            after: {
                canvas: [app._canvas.width, app._canvas.height],
                layerIds: app._layers.map(layer => layer.id),
                pixel: readCenter(),
            },
            running: app._renderer.isRunning,
        }
    })

    expect(result.cancelled).toBe(true)
    expect(result.after).toEqual(result.before)
    expect(result.running).toBe(false)
})

test('job polling hides a remote model while post-swap rollback is unsettled', async ({ page }) => {
    await bootSolid(page)

    const result = await page.evaluate(async () => {
        const app = window.layersApp
        const { createLayersOnlineAdapter } = await import('/js/collab/onlineAdapter.js')
        const { buildNodeModel } = await import('/js/collab/docModel.js')
        const { createEffectLayer } = await import('/js/layers/layer-model.js')
        const handlers = new Map()
        let status = 'offline'
        let nodes = buildNodeModel(app._layers, {
            width: app._canvas.width,
            height: app._canvas.height,
        })
        const online = {
            on: (event, handler) => handlers.set(event, handler),
            getStatus: () => status,
            getSessionId: () => 'post-swap-rollback',
            getShareUrl: () => 'https://layers.test/?seance=post-swap-rollback',
            getNodes: () => nodes,
            joinSession: async () => { status = 'online' },
            goOffline: () => { status = 'offline' },
            writeSessionToUrl: url => url,
        }
        const adapter = createLayersOnlineAdapter(app, {
            location: new URL('https://layers.test/'),
            history: { replaceState() {} },
            dialog: null,
            importSdk: async () => ({ createOnlineDslLayer: () => online }),
        })
        await adapter.joinSession('post-swap-rollback', { skipConfirm: true })
        app._selectionManager.setSelection({
            type: 'rect', x: 10, y: 20, width: 30, height: 40,
        })
        app._currentProjectId = 'local-project'
        app._currentProjectName = 'Local project'
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

        const remoteLayer = createEffectLayer('synth/gradient', 'Rejected remote')
        remoteLayer.id = 'layer-710'
        nodes = buildNodeModel([remoteLayer], { width: 275, height: 155 })
        const stageLayerSet = app._renderer.stageLayerSet.bind(app._renderer)
        let enteredRollback
        let releaseRollback
        const rollbackEntered = new Promise(resolve => { enteredRollback = resolve })
        const rollbackRelease = new Promise(resolve => { releaseRollback = resolve })
        app._renderer.stageLayerSet = async (candidate) => {
            const stage = await stageLayerSet(candidate)
            const rollback = stage.rollback.bind(stage)
            stage.rollback = async () => {
                enteredRollback()
                await rollbackRelease
                return rollback()
            }
            return stage
        }
        const updateLayerStack = app._updateLayerStack.bind(app)
        let rejectedCandidate = false
        app._updateLayerStack = () => {
            if (!rejectedCandidate
                && app._layers.some(layer => layer.id === remoteLayer.id)) {
                rejectedCandidate = true
                throw new Error('injected post-swap remote failure')
            }
            return updateLayerStack()
        }

        handlers.get('remote-node')?.({})
        await rollbackEntered
        const liveDuring = app._layers.map(layer => layer.id)
        const during = await readState()
        releaseRollback()
        while (adapter.isApplyingRemote()) {
            await new Promise(resolve => setTimeout(resolve, 10))
        }
        const after = await readState()
        return { before, liveDuring, during, after }
    })

    expect(result.liveDuring).toEqual(['layer-710'])
    expect(result.during).toEqual(result.before)
    expect(result.after).toEqual(result.before)
})

test('remote commit finalizes the last local debounced state before its undo entry', async ({ page }) => {
    await bootSolid(page)

    const result = await page.evaluate(async () => {
        const app = window.layersApp
        const { createLayersOnlineAdapter } = await import('/js/collab/onlineAdapter.js')
        const { buildNodeModel } = await import('/js/collab/docModel.js')
        const { createEffectLayer } = await import('/js/layers/layer-model.js')
        const handlers = new Map()
        let nodes = buildNodeModel(app._layers, {
            width: app._canvas.width,
            height: app._canvas.height,
        })
        const online = {
            on: (event, handler) => handlers.set(event, handler),
            getStatus: () => 'online',
            getSessionId: () => 'remote-undo',
            getShareUrl: () => 'https://layers.test/?seance=remote-undo',
            getNodes: () => nodes,
            joinSession: async () => {},
            goOffline: () => {},
            upsertNode: () => {},
            deleteNode: () => {},
            writeSessionToUrl: url => url,
        }
        const adapter = createLayersOnlineAdapter(app, {
            location: new URL('https://layers.test/'),
            history: { replaceState() {} },
            dialog: null,
            importSdk: async () => ({ createOnlineDslLayer: () => online }),
        })
        await adapter.joinSession('remote-undo', { skipConfirm: true })

        const localId = app._layers[0].id
        app._layers[0].opacity = 37
        app._markDirty()
        app._pushUndoStateDebounced()
        const remoteLayer = createEffectLayer('synth/gradient', 'Remote undo target')
        remoteLayer.id = 'layer-710'
        nodes = buildNodeModel([remoteLayer], { width: 275, height: 155 })
        handlers.get('remote-node')?.({})
        await new Promise(resolve => setTimeout(resolve, 400))
        while (adapter.isApplyingRemote()) {
            await new Promise(resolve => setTimeout(resolve, 10))
        }
        const remoteIds = app._layers.map(layer => layer.id)
        const undo = await window.LayersAgent.undo()
        return {
            remoteIds,
            undoOk: undo.ok,
            restoredId: app._layers[0]?.id,
            restoredOpacity: app._layers[0]?.opacity,
            restoredCanvas: { width: app._canvas.width, height: app._canvas.height },
        }
    })

    expect(result).toEqual({
        remoteIds: ['layer-710'],
        undoOk: true,
        restoredId: 'layer-0',
        restoredOpacity: 37,
        restoredCanvas: { width: 1024, height: 1024 },
    })
})

test('remote post-push failure restores exact finalized history without candidate redo', async ({ page }) => {
    await bootSolid(page)

    const result = await page.evaluate(async () => {
        const app = window.layersApp
        const { createLayersOnlineAdapter } = await import('/js/collab/onlineAdapter.js')
        const { buildNodeModel } = await import('/js/collab/docModel.js')
        const { createEffectLayer } = await import('/js/layers/layer-model.js')
        const handlers = new Map()
        let nodes = buildNodeModel(app._layers, {
            width: app._canvas.width,
            height: app._canvas.height,
        })
        const online = {
            on: (event, handler) => handlers.set(event, handler),
            getStatus: () => 'online',
            getSessionId: () => 'remote-history-failure',
            getShareUrl: () => 'https://layers.test/?seance=remote-history-failure',
            getNodes: () => nodes,
            joinSession: async () => {},
            goOffline: () => {},
            upsertNode: () => {},
            deleteNode: () => {},
            writeSessionToUrl: url => url,
        }
        const adapter = createLayersOnlineAdapter(app, {
            location: new URL('https://layers.test/'),
            history: { replaceState() {} },
            dialog: null,
            importSdk: async () => ({ createOnlineDslLayer: () => online }),
        })
        await adapter.joinSession('remote-history-failure', { skipConfirm: true })

        const localId = app._layers[0].id
        const undoStackIdentity = app._undoManager._stack
        app._layers[0].opacity = 37
        app._markDirty()
        app._pushUndoStateDebounced()
        const remoteLayer = createEffectLayer('synth/gradient', 'Rejected remote')
        remoteLayer.id = 'layer-720'
        nodes = buildNodeModel([remoteLayer], {
            width: app._canvas.width,
            height: app._canvas.height,
        })
        const pushUndoState = app._pushUndoState.bind(app)
        app._pushUndoState = () => {
            pushUndoState()
            if (app._layers[0]?.id === remoteLayer.id) {
                throw new Error('injected post-push remote failure')
            }
        }
        handlers.get('remote-node')?.({})
        await new Promise(resolve => setTimeout(resolve, 400))
        while (adapter.isApplyingRemote()) {
            await new Promise(resolve => setTimeout(resolve, 10))
        }
        app._pushUndoState = pushUndoState
        return {
            localId,
            layerId: app._layers[0]?.id,
            opacity: app._layers[0]?.opacity,
            sameUndoStack: app._undoManager._stack === undoStackIdentity,
            historyLayerIds: app._undoManager._stack.map(
                snapshot => snapshot.layers[0]?.id),
            historyOpacities: app._undoManager._stack.map(
                snapshot => snapshot.layers[0]?.opacity),
            undoIndex: app._undoManager._index,
            pendingUndo: Boolean(app._undoDebounceTimer),
            canRedo: app._undoManager.canRedo(),
        }
    })

    expect(result).toEqual({
        localId: 'layer-0',
        layerId: 'layer-0',
        opacity: 37,
        sameUndoStack: true,
        historyLayerIds: ['layer-0', 'layer-0'],
        historyOpacities: [100, 37],
        undoIndex: 1,
        pendingUndo: false,
        canRedo: false,
    })
})

test('remote apply preserves surviving layer selection and falls back after replacement', async ({ page }) => {
    await bootSolid(page)

    const result = await page.evaluate(async () => {
        const app = window.layersApp
        await app._handleAddEffectLayer('synth/gradient', { name: 'Selected survivor' })
        const selectedId = app._layers.at(-1).id
        app._layerStack.selectedLayerId = selectedId
        const { createLayersOnlineAdapter } = await import('/js/collab/onlineAdapter.js')
        const { buildNodeModel } = await import('/js/collab/docModel.js')
        const { createEffectLayer } = await import('/js/layers/layer-model.js')
        const handlers = new Map()
        let nodes = buildNodeModel(app._layers, {
            width: app._canvas.width,
            height: app._canvas.height,
        })
        const online = {
            on: (event, handler) => handlers.set(event, handler),
            getStatus: () => 'online',
            getSessionId: () => 'remote-selection',
            getShareUrl: () => 'https://layers.test/?seance=remote-selection',
            getNodes: () => nodes,
            joinSession: async () => {},
            goOffline: () => {},
            writeSessionToUrl: url => url,
        }
        const adapter = createLayersOnlineAdapter(app, {
            location: new URL('https://layers.test/'),
            history: { replaceState() {} },
            dialog: null,
            importSdk: async () => ({ createOnlineDslLayer: () => online }),
        })
        await adapter.joinSession('remote-selection', { skipConfirm: true })

        const survivingLayers = app._cloneLayers(app._layers)
        survivingLayers.at(-1).name = 'Still selected remotely'
        nodes = buildNodeModel(survivingLayers, {
            width: app._canvas.width,
            height: app._canvas.height,
        })
        handlers.get('remote-node')?.({})
        await new Promise(resolve => setTimeout(resolve, 350))
        while (adapter.isApplyingRemote()) {
            await new Promise(resolve => setTimeout(resolve, 10))
        }
        const surviving = {
            selectedLayerIds: app._layerStack.selectedLayerIds,
            activeLayerId: app._layerStack.selectedLayerId,
            undoSelection: app._undoManager._stack.at(-1).selectedLayerIds,
        }

        app._selectionManager.setSelection({
            type: 'rect', x: 1, y: 1, width: 10, height: 10,
        })
        const replacement = createEffectLayer('synth/solid', 'Remote replacement')
        replacement.id = 'layer-730'
        nodes = buildNodeModel([replacement], { width: 275, height: 155 })
        handlers.get('remote-node')?.({})
        await new Promise(resolve => setTimeout(resolve, 350))
        while (adapter.isApplyingRemote()) {
            await new Promise(resolve => setTimeout(resolve, 10))
        }
        return {
            selectedId,
            surviving,
            replaced: {
                selectedLayerIds: app._layerStack.selectedLayerIds,
                activeLayerId: app._layerStack.selectedLayerId,
                undoSelection: app._undoManager._stack.at(-1).selectedLayerIds,
                hasCanvasSelection: app._selectionManager.hasSelection(),
            },
        }
    })

    expect(result.surviving).toEqual({
        selectedLayerIds: [result.selectedId],
        activeLayerId: result.selectedId,
        undoSelection: [result.selectedId],
    })
    expect(result.replaced).toEqual({
        selectedLayerIds: ['layer-730'],
        activeLayerId: 'layer-730',
        undoSelection: ['layer-730'],
        hasCanvasSelection: false,
    })
})

test('publish waits for a failing local mutation to roll back', async ({ page }) => {
    await bootSolid(page)

    const result = await page.evaluate(async () => {
        const app = window.layersApp
        const { createLayersOnlineAdapter } = await import('/js/collab/onlineAdapter.js')
        const { buildNodeModel } = await import('/js/collab/docModel.js')
        const handlers = new Map()
        const publishedVisibility = []
        let status = 'offline'
        const nodes = buildNodeModel(app._layers, {
            width: app._canvas.width, height: app._canvas.height,
        })
        const online = {
            on: (event, handler) => handlers.set(event, handler),
            getStatus: () => status,
            getSessionId: () => 'publish-rollback',
            getShareUrl: () => 'https://layers.test/?seance=publish-rollback',
            getNodes: () => nodes,
            joinSession: async () => { status = 'online' },
            upsertNode: (_id, node) => {
                if (node.kind !== 'layers-layer') return
                publishedVisibility.push(JSON.parse(node.text).visible)
            },
            deleteNode() {},
            goOffline: () => { status = 'offline' },
            writeSessionToUrl: (url) => url,
        }
        const adapter = createLayersOnlineAdapter(app, {
            location: new URL('https://layers.test/'),
            history: { replaceState() {} },
            dialog: null,
            importSdk: async () => ({ createOnlineDslLayer: () => online }),
        })
        app._onlineAdapter = adapter
        await adapter.joinSession('publish-rollback', { skipConfirm: true })

        app._pushUndoStateDebounced()
        const rebuild = app._rebuild.bind(app)
        let rebuildCalls = 0
        app._rebuild = async (...args) => {
            rebuildCalls += 1
            if (rebuildCalls === 1) {
                await new Promise(resolve => setTimeout(resolve, 220))
                return { success: false, error: 'injected slow compile failure' }
            }
            return rebuild(...args)
        }
        const layerId = app._layers[0].id
        const envelope = await window.LayersAgent.setLayerProps({
            layerId,
            props: { visible: false },
        })
        await new Promise(resolve => setTimeout(resolve, 350))
        return {
            agentOk: envelope.ok,
            finalVisibility: app._layers[0].visible,
            publishedVisibility,
            lifecycleActive: app._projectLifecycleActive,
        }
    })

    expect(result).toEqual({
        agentOk: false,
        finalVisibility: true,
        publishedVisibility: [],
        lifecycleActive: false,
    })
})

test('stable gesture updates publish while the pointer lifecycle remains active', async ({ page }) => {
    await bootSolid(page)

    const result = await page.evaluate(async () => {
        const app = window.layersApp
        const { createLayersOnlineAdapter } = await import('/js/collab/onlineAdapter.js')
        const { buildNodeModel } = await import('/js/collab/docModel.js')
        const publishedOffsets = []
        let status = 'offline'
        const nodes = buildNodeModel(app._layers, {
            width: app._canvas.width, height: app._canvas.height,
        })
        const online = {
            on() {},
            getStatus: () => status,
            getSessionId: () => 'gesture-publish',
            getShareUrl: () => 'https://layers.test/?seance=gesture-publish',
            getNodes: () => nodes,
            joinSession: async () => { status = 'online' },
            upsertNode: (_id, node) => {
                if (node.kind === 'layers-layer') {
                    publishedOffsets.push(JSON.parse(node.text).offsetX)
                }
            },
            deleteNode() {},
            goOffline: () => { status = 'offline' },
            writeSessionToUrl: (url) => url,
        }
        const adapter = createLayersOnlineAdapter(app, {
            location: new URL('https://layers.test/'),
            history: { replaceState() {} },
            dialog: null,
            importSdk: async () => ({ createOnlineDslLayer: () => online }),
        })
        app._onlineAdapter = adapter
        await adapter.joinSession('gesture-publish', { skipConfirm: true })

        const token = app._tryAcquireProjectLifecycle()
        app._layers[0].offsetX = 42
        app._pushUndoStateDebounced()
        await new Promise(resolve => setTimeout(resolve, 220))
        const lifecycleDuringPublish = app._projectLifecycleActive
        token.release()
        if (app._undoDebounceTimer) {
            clearTimeout(app._undoDebounceTimer)
            app._undoDebounceTimer = null
        }
        return { publishedOffsets, lifecycleDuringPublish }
    })

    expect(result).toEqual({
        publishedOffsets: [42],
        lifecycleDuringPublish: true,
    })
})

for (const tool of ['move', 'transform']) {
    test(`${tool} cancellation republishes the restored position after a progressive update`, async ({ page }) => {
        await bootSolid(page)

        const result = await page.evaluate(async (toolName) => {
            const app = window.layersApp
            const added = await window.LayersAgent.addLayer({
                kind: 'drawing', name: 'Gesture layer',
            })
            const layerId = added.result.layerId
            await window.LayersAgent.paintStroke({
                layerId,
                points: [[10, 10], [30, 30]],
                size: 5,
                color: '#ff0000',
            })
            const { createLayersOnlineAdapter } = await import('/js/collab/onlineAdapter.js')
            const { buildNodeModel } = await import('/js/collab/docModel.js')
            const publishedOffsets = []
            let status = 'offline'
            const nodes = buildNodeModel(app._layers, {
                width: app._canvas.width, height: app._canvas.height,
            })
            const online = {
                on() {},
                getStatus: () => status,
                getSessionId: () => `${toolName}-cancel-publish`,
                getShareUrl: () => `https://layers.test/?seance=${toolName}-cancel-publish`,
                getNodes: () => nodes,
                joinSession: async () => { status = 'online' },
                upsertNode: (_id, node) => {
                    const parsed = node.kind === 'layers-layer'
                        ? JSON.parse(node.text)
                        : null
                    if (parsed?.name === 'Gesture layer') {
                        publishedOffsets.push(parsed.offsetX)
                    }
                },
                deleteNode() {},
                goOffline: () => { status = 'offline' },
                writeSessionToUrl: url => url,
            }
            const adapter = createLayersOnlineAdapter(app, {
                location: new URL('https://layers.test/'),
                history: { replaceState() {} },
                dialog: null,
                importSdk: async () => ({ createOnlineDslLayer: () => online }),
            })
            app._onlineAdapter = adapter
            await adapter.joinSession(`${toolName}-cancel-publish`, { skipConfirm: true })
            app._layerStack.selectedLayerId = layerId
            app._setToolMode(toolName)

            const overlay = app._selectionOverlay
            const fireMouse = (type, x, y) => {
                const rect = overlay.getBoundingClientRect()
                overlay.dispatchEvent(new MouseEvent(type, {
                    clientX: rect.left + x * rect.width / overlay.width,
                    clientY: rect.top + y * rect.height / overlay.height,
                    bubbles: true,
                    button: 0,
                }))
            }
            fireMouse('mousedown', 512, 512)
            fireMouse('mousemove', 560, 540)
            const firstDeadline = performance.now() + 1500
            while (publishedOffsets.length < 1 && performance.now() < firstDeadline) {
                await new Promise(resolve => setTimeout(resolve, 10))
            }
            const provisionalOffset = app._layers.find(layer => layer.id === layerId).offsetX
            overlay.dispatchEvent(new Event('pointercancel', { bubbles: true }))
            const secondDeadline = performance.now() + 5000
            while (publishedOffsets.at(-1) !== 0 && performance.now() < secondDeadline) {
                await new Promise(resolve => setTimeout(resolve, 10))
            }
            const restoredOffset = app._layers.find(layer => layer.id === layerId).offsetX
            return {
                provisionalOffset,
                restoredOffset,
                publishedOffsets,
                lifecycleReleased: !app._projectLifecycleActive,
            }
        }, tool)

        expect(result.provisionalOffset).not.toBe(0)
        expect(result.restoredOffset).toBe(0)
        expect(result.publishedOffsets.at(0)).toBe(result.provisionalOffset)
        expect(result.publishedOffsets.at(-1)).toBe(0)
        expect(result.publishedOffsets.length).toBeGreaterThanOrEqual(2)
        expect(result.lifecycleReleased).toBe(true)
    })
}

test('text move cancellation restores and republishes the exact original params', async ({ page }) => {
    await bootSolid(page)

    const result = await page.evaluate(async () => {
        const app = window.layersApp
        const added = await window.LayersAgent.addLayer({
            kind: 'text', text: 'Cancel me', name: 'Gesture text',
        })
        const layerId = added.result.layerId
        const { createLayersOnlineAdapter } = await import('/js/collab/onlineAdapter.js')
        const { buildNodeModel } = await import('/js/collab/docModel.js')
        const publishedParams = []
        let status = 'offline'
        const nodes = buildNodeModel(app._layers, {
            width: app._canvas.width, height: app._canvas.height,
        })
        const online = {
            on() {},
            getStatus: () => status,
            getSessionId: () => 'text-cancel-publish',
            getShareUrl: () => 'https://layers.test/?seance=text-cancel-publish',
            getNodes: () => nodes,
            joinSession: async () => { status = 'online' },
            upsertNode: (_id, node) => {
                const parsed = node.kind === 'layers-layer'
                    ? JSON.parse(node.text)
                    : null
                if (parsed?.name === 'Gesture text') {
                    publishedParams.push(parsed.effectParams)
                }
            },
            deleteNode() {},
            goOffline: () => { status = 'offline' },
            writeSessionToUrl: url => url,
        }
        const adapter = createLayersOnlineAdapter(app, {
            location: new URL('https://layers.test/'),
            history: { replaceState() {} },
            dialog: null,
            importSdk: async () => ({ createOnlineDslLayer: () => online }),
        })
        app._onlineAdapter = adapter
        await adapter.joinSession('text-cancel-publish', { skipConfirm: true })
        app._layerStack.selectedLayerId = layerId
        app._setToolMode('move')

        const overlay = app._selectionOverlay
        const fireMouse = (type, x, y) => {
            const rect = overlay.getBoundingClientRect()
            overlay.dispatchEvent(new MouseEvent(type, {
                clientX: rect.left + x * rect.width / overlay.width,
                clientY: rect.top + y * rect.height / overlay.height,
                bubbles: true,
                button: 0,
            }))
        }
        fireMouse('mousedown', 512, 512)
        fireMouse('mousemove', 560, 540)
        const firstDeadline = performance.now() + 1500
        while (publishedParams.length < 1 && performance.now() < firstDeadline) {
            await new Promise(resolve => setTimeout(resolve, 10))
        }
        const provisionalParams = { ...app._layers.find(layer => layer.id === layerId).effectParams }
        overlay.dispatchEvent(new Event('pointercancel', { bubbles: true }))
        const secondDeadline = performance.now() + 5000
        const hasExactRestoredPublish = () => {
            const latest = publishedParams.at(-1)
            return latest?.text === 'Cancel me'
                && Object.keys(latest).length === 1
        }
        while (!hasExactRestoredPublish() && performance.now() < secondDeadline) {
            await new Promise(resolve => setTimeout(resolve, 10))
        }
        return {
            provisionalParams,
            restoredParams: app._layers.find(layer => layer.id === layerId).effectParams,
            publishedParams,
            lifecycleReleased: !app._projectLifecycleActive,
        }
    })

    expect(result.provisionalParams).toMatchObject({ text: 'Cancel me' })
    expect(result.provisionalParams).toHaveProperty('posX')
    expect(result.provisionalParams).toHaveProperty('posY')
    expect(result.restoredParams).toEqual({ text: 'Cancel me' })
    expect(result.publishedParams.at(0)).toEqual(result.provisionalParams)
    expect(result.publishedParams.at(-1)).toEqual({ text: 'Cancel me' })
    expect(result.publishedParams.length).toBeGreaterThanOrEqual(2)
    expect(result.lifecycleReleased).toBe(true)
})

test('unsafe remote numeric layer ids are rejected before local state changes', async ({ page }) => {
    const pageErrors = []
    page.on('pageerror', error => pageErrors.push(error.message))
    await bootSolid(page)

    const result = await page.evaluate(async () => {
        const app = window.layersApp
        const { createLayersOnlineAdapter } = await import('/js/collab/onlineAdapter.js')
        const { buildNodeModel } = await import('/js/collab/docModel.js')
        const handlers = new Map()
        let status = 'offline'
        let nodes = buildNodeModel(app._layers, {
            width: app._canvas.width, height: app._canvas.height,
        })
        const online = {
            on: (event, handler) => handlers.set(event, handler),
            getStatus: () => status,
            getSessionId: () => 'remote2',
            getShareUrl: () => 'https://layers.test/?seance=remote2',
            getNodes: () => nodes,
            joinSession: async () => { status = 'online' },
            goOffline: () => { status = 'offline' },
            writeSessionToUrl: (url) => url,
        }
        const adapter = createLayersOnlineAdapter(app, {
            location: new URL('https://layers.test/'),
            history: { replaceState() {} },
            dialog: null,
            importSdk: async () => ({ createOnlineDslLayer: () => online }),
        })
        await adapter.joinSession('remote2', { skipConfirm: true })
        const before = {
            ids: app._layers.map(layer => layer.id),
            size: [app._canvas.width, app._canvas.height],
        }
        const invalid = structuredClone(app._layers[0])
        invalid.id = `layer-${Number.MAX_SAFE_INTEGER}`
        nodes = buildNodeModel([invalid], { width: 275, height: 155 })
        handlers.get('remote-node')?.({})
        await new Promise(resolve => setTimeout(resolve, 350))
        return {
            before,
            after: {
                ids: app._layers.map(layer => layer.id),
                size: [app._canvas.width, app._canvas.height],
            },
        }
    })

    expect(result.after).toEqual(result.before)
    expect(pageErrors).toEqual([])
})

test('remote replacement exits mask mode synchronously before a local mutation', async ({ page }) => {
    await bootSolid(page)

    const result = await page.evaluate(async () => {
        const app = window.layersApp
        const { createLayersOnlineAdapter } = await import('/js/collab/onlineAdapter.js')
        const { buildNodeModel } = await import('/js/collab/docModel.js')
        const { createEffectLayer } = await import('/js/layers/layer-model.js')
        await app._addLayerMask(app._layers[0].id)
        app._enterMaskEditMode(app._layers[0].id)

        const handlers = new Map()
        let status = 'offline'
        let nodes = buildNodeModel(app._layers, {
            width: app._canvas.width, height: app._canvas.height,
        })
        const online = {
            on: (event, handler) => handlers.set(event, handler),
            getStatus: () => status,
            getSessionId: () => 'remote3',
            getShareUrl: () => 'https://layers.test/?seance=remote3',
            getNodes: () => nodes,
            joinSession: async () => { status = 'online' },
            goOffline: () => { status = 'offline' },
            writeSessionToUrl: (url) => url,
        }
        const adapter = createLayersOnlineAdapter(app, {
            location: new URL('https://layers.test/'),
            history: { replaceState() {} },
            dialog: null,
            importSdk: async () => ({ createOnlineDslLayer: () => online }),
        })
        await adapter.joinSession('remote3', { skipConfirm: true })
        const remoteLayer = createEffectLayer('synth/gradient', 'Remote')
        remoteLayer.id = 'layer-600'
        nodes = buildNodeModel([remoteLayer], { width: 275, height: 155 })

        const exitMaskEditMode = app._exitMaskEditMode.bind(app)
        let exitCalled = false
        let usedDiscardExit = false
        let releaseUnsafeExit
        app._exitMaskEditMode = async (options = {}) => {
            exitCalled = true
            usedDiscardExit = options.updateRenderer === false
            if (!usedDiscardExit) {
                await new Promise(resolve => { releaseUnsafeExit = resolve })
            }
            return exitMaskEditMode(options)
        }
        handlers.get('remote-node')?.({})
        while (!exitCalled) await new Promise(resolve => setTimeout(resolve, 10))
        const addPromise = window.LayersAgent.addLayer({
            kind: 'effect', effectId: 'filter/blur', name: 'Local after remote',
        })
        releaseUnsafeExit?.()
        const envelope = await addPromise
        await new Promise(resolve => setTimeout(resolve, 250))
        return {
            usedDiscardExit,
            agentOk: envelope.ok,
            effects: app._layers.map(layer => layer.effectId),
            maskEditMode: app._maskEditMode,
        }
    })

    expect(result.usedDiscardExit).toBe(true)
    expect(result.agentOk).toBe(true)
    expect(result.effects).toEqual(['synth/gradient', 'filter/blur'])
    expect(result.maskEditMode).toBe(false)
})

test('remote drawing apply owns lifecycle until candidate rasterization finishes', async ({ page }) => {
    await bootSolid(page)

    const result = await page.evaluate(async () => {
        const app = window.layersApp
        const { createLayersOnlineAdapter } = await import('/js/collab/onlineAdapter.js')
        const { buildNodeModel } = await import('/js/collab/docModel.js')
        const { createDrawingLayer } = await import('/js/layers/layer-model.js')
        const handlers = new Map()
        let status = 'offline'
        let nodes = buildNodeModel(app._layers, {
            width: app._canvas.width, height: app._canvas.height,
        })
        const online = {
            on: (event, handler) => handlers.set(event, handler),
            getStatus: () => status,
            getSessionId: () => 'remote4',
            getShareUrl: () => 'https://layers.test/?seance=remote4',
            getNodes: () => nodes,
            joinSession: async () => { status = 'online' },
            goOffline: () => { status = 'offline' },
            writeSessionToUrl: (url) => url,
        }
        const adapter = createLayersOnlineAdapter(app, {
            location: new URL('https://layers.test/'),
            history: { replaceState() {} },
            dialog: null,
            importSdk: async () => ({ createOnlineDslLayer: () => online }),
        })
        await adapter.joinSession('remote4', { skipConfirm: true })
        const drawing = createDrawingLayer('Remote drawing')
        drawing.id = 'layer-700'
        drawing.strokes = [{
            id: 'stroke-remote',
            type: 'path',
            color: '#000000',
            size: 5,
            opacity: 1,
            points: [{ x: 1, y: 1 }, { x: 10, y: 10 }],
        }]
        nodes = buildNodeModel([drawing], { width: 275, height: 155 })

        const createDrawingLayerCanvas = app._createDrawingLayerCanvas.bind(app)
        let rasterizeStarted = false
        let releaseRasterize
        app._createDrawingLayerCanvas = async (...args) => {
            rasterizeStarted = true
            await new Promise(resolve => { releaseRasterize = resolve })
            return createDrawingLayerCanvas(...args)
        }
        let replacementStageReached = false
        const stageLayerSet = app._renderer.stageLayerSet.bind(app._renderer)
        app._renderer.stageLayerSet = async (candidate) => {
            replacementStageReached = true
            return stageLayerSet(candidate)
        }
        handlers.get('remote-node')?.({})
        while (!rasterizeStarted) await new Promise(resolve => setTimeout(resolve, 10))
        const replacementPromise = app._handleCreateGradientBase(333, 222)
        await new Promise(resolve => setTimeout(resolve, 40))
        const replacementWaited = !replacementStageReached
        releaseRasterize()
        const replacementStatus = await replacementPromise
        return {
            replacementWaited,
            replacementStatus,
            effects: app._layers.map(layer => layer.effectId),
            width: app._canvas.width,
            height: app._canvas.height,
            lifecycleActive: app._projectLifecycleActive,
        }
    })

    expect(result).toEqual({
        replacementWaited: true,
        replacementStatus: 'opened',
        effects: ['synth/gradient'],
        width: 333,
        height: 222,
        lifecycleActive: false,
    })
})

test('queued remote rerun yields to an agent replacement and stays discarded after offline commit', async ({ page }) => {
    await bootSolid(page)

    const result = await page.evaluate(async () => {
        const app = window.layersApp
        const { createLayersOnlineAdapter } = await import('/js/collab/onlineAdapter.js')
        const { buildNodeModel } = await import('/js/collab/docModel.js')
        const { createDrawingLayer, createEffectLayer } = await import('/js/layers/layer-model.js')
        const handlers = new Map()
        let status = 'offline'
        let nodes = buildNodeModel(app._layers, {
            width: app._canvas.width, height: app._canvas.height,
        })
        let disconnects = 0
        const online = {
            on: (event, handler) => handlers.set(event, handler),
            getStatus: () => status,
            getSessionId: () => 'remote5',
            getShareUrl: () => 'https://layers.test/?seance=remote5',
            getNodes: () => nodes,
            joinSession: async () => { status = 'online' },
            goOffline: () => { status = 'offline'; disconnects += 1 },
            writeSessionToUrl: (url) => url,
        }
        const adapter = createLayersOnlineAdapter(app, {
            location: new URL('https://layers.test/'),
            history: { replaceState() {} },
            dialog: null,
            importSdk: async () => ({ createOnlineDslLayer: () => online }),
        })
        app._onlineAdapter = adapter
        adapter.schedulePublish = () => {}
        await adapter.joinSession('remote5', { skipConfirm: true })

        const drawing = createDrawingLayer('Slow remote drawing')
        drawing.id = 'layer-800'
        drawing.strokes = [{
            id: 'stroke-slow',
            type: 'path',
            color: '#000000',
            size: 5,
            opacity: 1,
            points: [{ x: 1, y: 1 }, { x: 10, y: 10 }],
        }]
        nodes = buildNodeModel([drawing], { width: 275, height: 155 })

        const createDrawingLayerCanvas = app._createDrawingLayerCanvas.bind(app)
        let rasterizeStarted = false
        let releaseRasterize
        app._createDrawingLayerCanvas = async (...args) => {
            rasterizeStarted = true
            await new Promise(resolve => { releaseRasterize = resolve })
            return createDrawingLayerCanvas(...args)
        }

        handlers.get('remote-node')?.({})
        while (!rasterizeStarted) await new Promise(resolve => setTimeout(resolve, 10))

        const replacementPromise = window.LayersAgent.newProject({
            width: 320,
            height: 180,
            name: 'Agent replacement',
        })

        const rerunLayer = createEffectLayer('synth/gradient', 'Stale rerun')
        rerunLayer.id = 'layer-900'
        nodes = buildNodeModel([rerunLayer], { width: 555, height: 444 })
        handlers.get('remote-node')?.({})
        await new Promise(resolve => setTimeout(resolve, 180))
        releaseRasterize()

        const replacement = await replacementPromise
        await new Promise(resolve => setTimeout(resolve, 400))
        return {
            replacementOk: replacement.ok,
            replacementError: replacement.error?.code || null,
            status,
            disconnects,
            effects: app._layers.map(layer => layer.effectId),
            size: [app._canvas.width, app._canvas.height],
            projectName: app._currentProjectName,
            applyingRemote: adapter.isApplyingRemote(),
            lifecycleActive: app._projectLifecycleActive,
        }
    })

    expect(result).toEqual({
        replacementOk: true,
        replacementError: null,
        status: 'offline',
        disconnects: 1,
        effects: [],
        size: [320, 180],
        projectName: 'Agent replacement',
        applyingRemote: false,
        lifecycleActive: false,
    })
})

test('remote drawing rasterization failure preserves the live project and generation', async ({ page }) => {
    await bootSolid(page)

    const result = await page.evaluate(async () => {
        const app = window.layersApp
        const { createLayersOnlineAdapter } = await import('/js/collab/onlineAdapter.js')
        const { buildNodeModel } = await import('/js/collab/docModel.js')
        const { createDrawingLayer } = await import('/js/layers/layer-model.js')

        const oldDrawing = createDrawingLayer('Local drawing')
        oldDrawing.strokes = [{
            id: 'stroke-local',
            type: 'path',
            color: '#000000',
            size: 5,
            opacity: 1,
            points: [{ x: 1, y: 1 }, { x: 10, y: 10 }],
        }]
        app._layers = [oldDrawing]
        await app._rasterizeDrawingLayer(oldDrawing)
        app._updateLayerStack()
        await app._rebuild({ force: true })

        const oldLayers = app._layers
        const oldResource = app._renderer.getMediaInfo(oldDrawing.id)
        const oldSize = [app._canvas.width, app._canvas.height]
        const generation = app._replacementGeneration

        const handlers = new Map()
        let status = 'offline'
        let nodes = buildNodeModel(app._layers, {
            width: app._canvas.width, height: app._canvas.height,
        })
        const online = {
            on: (event, handler) => handlers.set(event, handler),
            getStatus: () => status,
            getSessionId: () => 'failr1',
            getShareUrl: () => 'https://layers.test/?seance=failr1',
            getNodes: () => nodes,
            joinSession: async () => { status = 'online' },
            goOffline: () => { status = 'offline' },
            writeSessionToUrl: (url) => url,
        }
        const adapter = createLayersOnlineAdapter(app, {
            location: new URL('https://layers.test/'),
            history: { replaceState() {} },
            dialog: null,
            importSdk: async () => ({ createOnlineDslLayer: () => online }),
        })
        await adapter.joinSession('failr1', { skipConfirm: true })

        const remoteDrawing = createDrawingLayer('Remote drawing')
        remoteDrawing.id = 'layer-remote-raster-failure'
        remoteDrawing.strokes = [{
            id: 'stroke-remote',
            type: 'path',
            color: '#000000',
            size: 5,
            opacity: 1,
            points: [{ x: 2, y: 2 }, { x: 20, y: 20 }],
        }]
        nodes = buildNodeModel([remoteDrawing], { width: 275, height: 155 })

        const createDrawingLayerCanvas = app._createDrawingLayerCanvas.bind(app)
        let failureReached = false
        app._createDrawingLayerCanvas = async (layer, ...args) => {
            if (layer.id === remoteDrawing.id) {
                failureReached = true
                throw new Error('candidate rasterization failed')
            }
            return createDrawingLayerCanvas(layer, ...args)
        }

        handlers.get('remote-node')?.({})
        while (!failureReached) await new Promise(resolve => setTimeout(resolve, 10))
        while (adapter.isApplyingRemote()) await new Promise(resolve => setTimeout(resolve, 10))

        return {
            layerIds: app._layers.map(layer => layer.id),
            sameAppLayers: app._layers === oldLayers,
            sameRendererLayers: app._renderer._layers === oldLayers,
            oldResourceStillRegistered:
                app._renderer.getMediaInfo(oldDrawing.id) === oldResource,
            size: [app._canvas.width, app._canvas.height],
            oldSize,
            generation: app._replacementGeneration,
            initialGeneration: generation,
        }
    })

    expect(result.layerIds).toHaveLength(1)
    expect(result.sameAppLayers).toBe(true)
    expect(result.sameRendererLayers).toBe(true)
    expect(result.oldResourceStillRegistered).toBe(true)
    expect(result.size).toEqual(result.oldSize)
    expect(result.generation).toBe(result.initialGeneration)
})

test('remote candidate rebuild failure preserves the live project and generation', async ({ page }) => {
    await bootSolid(page)

    const result = await page.evaluate(async () => {
        const app = window.layersApp
        const { createLayersOnlineAdapter } = await import('/js/collab/onlineAdapter.js')
        const { buildNodeModel } = await import('/js/collab/docModel.js')
        const { createDrawingLayer, createEffectLayer } =
            await import('/js/layers/layer-model.js')

        const oldDrawing = createDrawingLayer('Local drawing')
        oldDrawing.strokes = [{
            id: 'stroke-local',
            type: 'path',
            color: '#000000',
            size: 5,
            opacity: 1,
            points: [{ x: 1, y: 1 }, { x: 10, y: 10 }],
        }]
        app._layers = [oldDrawing]
        await app._rasterizeDrawingLayer(oldDrawing)
        app._updateLayerStack()
        await app._rebuild({ force: true })

        const oldLayers = app._layers
        const oldResource = app._renderer.getMediaInfo(oldDrawing.id)
        const oldSize = [app._canvas.width, app._canvas.height]
        const generation = app._replacementGeneration

        const handlers = new Map()
        let status = 'offline'
        let nodes = buildNodeModel(app._layers, {
            width: app._canvas.width, height: app._canvas.height,
        })
        const online = {
            on: (event, handler) => handlers.set(event, handler),
            getStatus: () => status,
            getSessionId: () => 'failb1',
            getShareUrl: () => 'https://layers.test/?seance=failb1',
            getNodes: () => nodes,
            joinSession: async () => { status = 'online' },
            goOffline: () => { status = 'offline' },
            writeSessionToUrl: (url) => url,
        }
        const adapter = createLayersOnlineAdapter(app, {
            location: new URL('https://layers.test/'),
            history: { replaceState() {} },
            dialog: null,
            importSdk: async () => ({ createOnlineDslLayer: () => online }),
        })
        await adapter.joinSession('failb1', { skipConfirm: true })

        const remoteLayer = createEffectLayer('synth/gradient', 'Remote')
        remoteLayer.id = 'layer-remote-rebuild-failure'
        nodes = buildNodeModel([remoteLayer], { width: 275, height: 155 })

        const rebuildNow = app._renderer._rebuildNow.bind(app._renderer)
        let failureReached = false
        app._renderer._rebuildNow = async (...args) => {
            if (!failureReached
                && app._renderer._layers.some(layer => layer.id === remoteLayer.id)) {
                failureReached = true
                return { success: false, error: 'candidate rebuild failed' }
            }
            return rebuildNow(...args)
        }

        handlers.get('remote-node')?.({})
        while (!failureReached) await new Promise(resolve => setTimeout(resolve, 10))
        while (adapter.isApplyingRemote()) await new Promise(resolve => setTimeout(resolve, 10))

        return {
            layerIds: app._layers.map(layer => layer.id),
            sameAppLayers: app._layers === oldLayers,
            sameRendererLayers: app._renderer._layers === oldLayers,
            oldResourceStillRegistered:
                app._renderer.getMediaInfo(oldDrawing.id) === oldResource,
            size: [app._canvas.width, app._canvas.height],
            oldSize,
            generation: app._replacementGeneration,
            initialGeneration: generation,
        }
    })

    expect(result.layerIds).toHaveLength(1)
    expect(result.sameAppLayers).toBe(true)
    expect(result.sameRendererLayers).toBe(true)
    expect(result.oldResourceStillRegistered).toBe(true)
    expect(result.size).toEqual(result.oldSize)
    expect(result.generation).toBe(result.initialGeneration)
})

test('post-settlement remote cleanup failure preserves the committed remote project', async ({ page }) => {
    await bootSolid(page)

    const result = await page.evaluate(async () => {
        const app = window.layersApp
        const { createLayersOnlineAdapter } = await import('/js/collab/onlineAdapter.js')
        const { buildNodeModel } = await import('/js/collab/docModel.js')
        const { createEffectLayer } = await import('/js/layers/layer-model.js')
        const handlers = new Map()
        let nodes = buildNodeModel(app._layers, {
            width: app._canvas.width,
            height: app._canvas.height,
        })
        const online = {
            on: (event, handler) => handlers.set(event, handler),
            getStatus: () => 'online',
            getSessionId: () => 'cleanup1',
            getShareUrl: () => 'https://layers.test/?seance=cleanup1',
            getNodes: () => nodes,
            joinSession: async () => {},
            goOffline: () => {},
            writeSessionToUrl: url => url,
        }
        const adapter = createLayersOnlineAdapter(app, {
            location: new URL('https://layers.test/'),
            history: { replaceState() {} },
            dialog: null,
            importSdk: async () => ({ createOnlineDslLayer: () => online }),
        })
        await adapter.joinSession('cleanup1', { skipConfirm: true })

        const remoteLayer = createEffectLayer('synth/gradient', 'Remote committed')
        nodes = buildNodeModel([remoteLayer], {
            width: app._canvas.width,
            height: app._canvas.height,
        })
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

        handlers.get('remote-node')?.({})
        await new Promise(resolve => setTimeout(resolve, 450))
        while (adapter.isApplyingRemote()) {
            await new Promise(resolve => setTimeout(resolve, 10))
        }
        return {
            layerName: app._layers[0]?.name,
            sameLayers: app._renderer._layers === app._layers,
            online: adapter.isOnline(),
        }
    })

    expect(result).toEqual({
        layerName: 'Remote committed',
        sameLayers: true,
        online: true,
    })
})

test('remote rollback releases the renderer stage when live canvas restoration throws', async ({ page }) => {
    await bootSolid(page)

    const result = await page.evaluate(async () => {
        const app = window.layersApp
        const { createLayersOnlineAdapter } = await import('/js/collab/onlineAdapter.js')
        const { buildNodeModel } = await import('/js/collab/docModel.js')
        const { createEffectLayer } = await import('/js/layers/layer-model.js')

        const oldLayers = app._layers
        const oldSize = [app._canvas.width, app._canvas.height]
        const handlers = new Map()
        let status = 'offline'
        let nodes = buildNodeModel(oldLayers, {
            width: oldSize[0], height: oldSize[1],
        })
        const online = {
            on: (event, handler) => handlers.set(event, handler),
            getStatus: () => status,
            getSessionId: () => 'gate01',
            getShareUrl: () => 'https://layers.test/?seance=gate01',
            getNodes: () => nodes,
            joinSession: async () => { status = 'online' },
            goOffline: () => { status = 'offline' },
            writeSessionToUrl: (url) => url,
        }
        const adapter = createLayersOnlineAdapter(app, {
            location: new URL('https://layers.test/'),
            history: { replaceState() {} },
            dialog: null,
            importSdk: async () => ({ createOnlineDslLayer: () => online }),
        })
        await adapter.joinSession('gate01', { skipConfirm: true })

        const remoteLayer = createEffectLayer('synth/gradient', 'Remote')
        remoteLayer.id = 'layer-remote-stage-gate'
        nodes = buildNodeModel([remoteLayer], { width: 275, height: 155 })

        const resizeCanvas = app._resizeCanvas.bind(app)
        const updateLayerStack = app._updateLayerStack.bind(app)
        const restoreProjectCommitState = app._restoreProjectCommitState.bind(app)
        const consoleError = console.error.bind(console)
        const loggedErrors = []
        let failRestore = false
        let rollbackCalls = 0
        app._resizeCanvas = (width, height) => {
            const result = resizeCanvas(width, height)
            if (failRestore && width === oldSize[0] && height === oldSize[1]) {
                failRestore = false
                throw new Error('live canvas restoration failed')
            }
            return result
        }
        app._updateLayerStack = (...args) => {
            if (app._layers.some(layer => layer.id === remoteLayer.id)) {
                failRestore = true
                throw new Error('post-stage app commit failed')
            }
            return updateLayerStack(...args)
        }
        app._restoreProjectCommitState = (...args) => {
            restoreProjectCommitState(...args)
            throw new Error('app state restoration failed')
        }
        console.error = (...args) => {
            loggedErrors.push(args.map(value => value instanceof Error
                ? value.message
                : String(value)).join(' '))
            consoleError(...args)
        }
        const stageLayerSet = app._renderer.stageLayerSet.bind(app._renderer)
        app._renderer.stageLayerSet = async (...args) => {
            const stage = await stageLayerSet(...args)
            const rollback = stage.rollback.bind(stage)
            stage.rollback = async () => {
                rollbackCalls++
                return rollback()
            }
            return stage
        }

        handlers.get('remote-node')?.({})
        await new Promise(resolve => setTimeout(resolve, 180))
        while (adapter.isApplyingRemote()) {
            await new Promise(resolve => setTimeout(resolve, 10))
        }
        console.error = consoleError

        const stageGateResult = await Promise.race([
            app._renderer.setLayers(oldLayers, { force: true }).then(() => 'released'),
            new Promise(resolve => setTimeout(() => resolve('blocked'), 100)),
        ])
        return {
            rollbackCalls,
            stageGateResult,
            sameAppLayers: app._layers === oldLayers,
            sameRendererLayers: app._renderer._layers === oldLayers,
            size: [app._canvas.width, app._canvas.height],
            oldSize,
            loggedErrors,
        }
    })

    expect(result.rollbackCalls).toBe(1)
    expect(result.stageGateResult).toBe('released')
    expect(result.sameAppLayers).toBe(true)
    expect(result.sameRendererLayers).toBe(true)
    expect(result.size).toEqual(result.oldSize)
    expect(result.loggedErrors.some(message =>
        message.includes('post-stage app commit failed')
        && message.includes('live canvas restoration failed')
        && message.includes('app state restoration failed'))).toBe(true)
})

test('successful remote whole-composition apply advances replacement generation once', async ({ page }) => {
    await bootSolid(page)

    const result = await page.evaluate(async () => {
        const app = window.layersApp
        const { createLayersOnlineAdapter } = await import('/js/collab/onlineAdapter.js')
        const { buildNodeModel } = await import('/js/collab/docModel.js')
        const { createEffectLayer } = await import('/js/layers/layer-model.js')
        const handlers = new Map()
        let status = 'offline'
        let nodes = buildNodeModel(app._layers, {
            width: app._canvas.width, height: app._canvas.height,
        })
        const online = {
            on: (event, handler) => handlers.set(event, handler),
            getStatus: () => status,
            getSessionId: () => 'gens01',
            getShareUrl: () => 'https://layers.test/?seance=gens01',
            getNodes: () => nodes,
            joinSession: async () => { status = 'online' },
            goOffline: () => { status = 'offline' },
            writeSessionToUrl: (url) => url,
        }
        const adapter = createLayersOnlineAdapter(app, {
            location: new URL('https://layers.test/'),
            history: { replaceState() {} },
            dialog: null,
            importSdk: async () => ({ createOnlineDslLayer: () => online }),
        })
        await adapter.joinSession('gens01', { skipConfirm: true })

        const initialGeneration = app._replacementGeneration
        const remoteLayer = createEffectLayer('synth/gradient', 'Remote')
        remoteLayer.id = 'layer-remote-generation'
        nodes = buildNodeModel([remoteLayer], { width: 275, height: 155 })
        handlers.get('remote-node')?.({})
        while (app._layers[0]?.id !== remoteLayer.id) {
            await new Promise(resolve => setTimeout(resolve, 10))
        }
        while (adapter.isApplyingRemote()) await new Promise(resolve => setTimeout(resolve, 10))

        return {
            initialGeneration,
            generation: app._replacementGeneration,
            layerIds: app._layers.map(layer => layer.id),
            sameRendererLayers: app._renderer._layers === app._layers,
        }
    })

    expect(result.layerIds).toEqual(['layer-remote-generation'])
    expect(result.sameRendererLayers).toBe(true)
    expect(result.generation).toBe(result.initialGeneration + 1)
})

test('invalid remote bounds preserve live layers, resources, canvas, and generation before decode or stage', async ({ page }) => {
    await bootSolid(page)

    const result = await page.evaluate(async () => {
        const app = window.layersApp
        const { createLayersOnlineAdapter } = await import('/js/collab/onlineAdapter.js')
        const { buildNodeModel, fnv1a } = await import('/js/collab/docModel.js')
        const { createDrawingLayer, createEffectLayer } =
            await import('/js/layers/layer-model.js')

        const oldDrawing = createDrawingLayer('Local drawing')
        oldDrawing.strokes = [{
            id: 'stroke-local',
            type: 'path',
            color: '#000000',
            size: 5,
            opacity: 1,
            points: [{ x: 1, y: 1 }, { x: 10, y: 10 }],
        }]
        app._layers = [oldDrawing]
        await app._rasterizeDrawingLayer(oldDrawing)
        app._updateLayerStack()
        await app._rebuild({ force: true })

        const oldLayers = app._layers
        const oldResource = app._renderer.getMediaInfo(oldDrawing.id)
        const oldSize = [app._canvas.width, app._canvas.height]
        const oldGeneration = app._replacementGeneration

        const handlers = new Map()
        let status = 'offline'
        let nodes = buildNodeModel(app._layers, {
            width: app._canvas.width, height: app._canvas.height,
        })
        const online = {
            on: (event, handler) => handlers.set(event, handler),
            getStatus: () => status,
            getSessionId: () => 'bound1',
            getShareUrl: () => 'https://layers.test/?seance=bound1',
            getNodes: () => nodes,
            joinSession: async () => { status = 'online' },
            goOffline: () => { status = 'offline' },
            writeSessionToUrl: (url) => url,
        }
        const adapter = createLayersOnlineAdapter(app, {
            location: new URL('https://layers.test/'),
            history: { replaceState() {} },
            dialog: null,
            importSdk: async () => ({ createOnlineDslLayer: () => online }),
        })
        await adapter.joinSession('bound1', { skipConfirm: true })

        const stageLayerSet = app._renderer.stageLayerSet.bind(app._renderer)
        let stageCalls = 0
        app._renderer.stageLayerSet = (...args) => {
            stageCalls++
            return stageLayerSet(...args)
        }
        const waitForApply = async () => {
            await new Promise(resolve => setTimeout(resolve, 180))
            while (adapter.isApplyingRemote()) {
                await new Promise(resolve => setTimeout(resolve, 10))
            }
        }

        const invalidCanvasLayer = createEffectLayer('synth/gradient', 'Invalid canvas')
        invalidCanvasLayer.id = 'layer-invalid-canvas'
        nodes = buildNodeModel([invalidCanvasLayer], { width: 100, height: 100 })
        const canvasMeta = nodes.find(node => node.id === 'meta')
        const canvasJson = JSON.parse(canvasMeta.text)
        canvasJson.canvas.w = 10.5
        canvasMeta.text = JSON.stringify(canvasJson)
        handlers.get('remote-node')?.({})
        await waitForApply()

        const pngHeader = (width, height) => {
            const bytes = new Uint8Array([
                137, 80, 78, 71, 13, 10, 26, 10,
                0, 0, 0, 13, 73, 72, 68, 82,
                (width >>> 24) & 255, (width >>> 16) & 255,
                (width >>> 8) & 255, width & 255,
                (height >>> 24) & 255, (height >>> 16) & 255,
                (height >>> 8) & 255, height & 255,
            ])
            return `data:image/png;base64,${btoa(String.fromCharCode(...bytes))}`
        }
        const invalidMaskLayer = createEffectLayer('synth/solid', 'Invalid mask')
        invalidMaskLayer.id = 'layer-invalid-mask'
        invalidMaskLayer.mask = new ImageData(1, 1)
        nodes = buildNodeModel(
            [invalidMaskLayer], { width: 8192, height: 8192 })
        const maskNode = nodes.find(node => node.kind === 'layers-mask')
        const maskJson = JSON.parse(maskNode.text)
        maskJson.data = pngHeader(8193, 1)
        maskNode.text = JSON.stringify(maskJson)
        const layerNode = nodes.find(node => node.id === 'Llayer-invalid-mask')
        const layerJson = JSON.parse(layerNode.text)
        layerJson.maskMeta.hash = fnv1a(maskJson.data)
        layerNode.text = JSON.stringify(layerJson)

        const NativeImage = window.Image
        let imageAllocations = 0
        window.Image = class {
            constructor() {
                imageAllocations++
            }
            set src(_value) {
                queueMicrotask(() => this.onerror?.(new Error('decode attempted')))
            }
        }
        handlers.get('remote-node')?.({})
        await waitForApply()
        window.Image = NativeImage
        app._renderer.stageLayerSet = stageLayerSet

        return {
            sameAppLayers: app._layers === oldLayers,
            sameRendererLayers: app._renderer._layers === oldLayers,
            oldResourceStillRegistered:
                app._renderer.getMediaInfo(oldDrawing.id) === oldResource,
            size: [app._canvas.width, app._canvas.height],
            oldSize,
            generation: app._replacementGeneration,
            oldGeneration,
            stageCalls,
            imageAllocations,
        }
    })

    expect(result.sameAppLayers).toBe(true)
    expect(result.sameRendererLayers).toBe(true)
    expect(result.oldResourceStillRegistered).toBe(true)
    expect(result.size).toEqual(result.oldSize)
    expect(result.generation).toBe(result.oldGeneration)
    expect(result.stageCalls).toBe(0)
    expect(result.imageAllocations).toBe(0)
})

test('malicious remote renderer fields are rejected before resource preparation, stage, or compile', async ({ page }) => {
    await bootSolid(page)

    const result = await page.evaluate(async () => {
        const app = window.layersApp
        const { createLayersOnlineAdapter } = await import('/js/collab/onlineAdapter.js')
        const { buildNodeModel } = await import('/js/collab/docModel.js')
        const oldLayers = app._layers
        const oldSize = [app._canvas.width, app._canvas.height]
        const handlers = new Map()
        let status = 'offline'
        let nodes = buildNodeModel(oldLayers, {
            width: oldSize[0], height: oldSize[1],
        })
        const online = {
            on: (event, handler) => handlers.set(event, handler),
            getStatus: () => status,
            getSessionId: () => 'safe01',
            getShareUrl: () => '',
            getNodes: () => nodes,
            joinSession: async () => { status = 'online' },
            goOffline: () => { status = 'offline' },
            writeSessionToUrl: url => url,
        }
        const adapter = createLayersOnlineAdapter(app, {
            location: new URL('https://layers.test/'),
            history: { replaceState() {} }, dialog: null,
            importSdk: async () => ({ createOnlineDslLayer: () => online }),
        })
        await adapter.joinSession('safe01', { skipConfirm: true })

        let stageCalls = 0
        let compileCalls = 0
        let canvasResourcePrepares = 0
        let drawingRasterizations = 0
        const stageLayerSet = app._renderer.stageLayerSet.bind(app._renderer)
        const rebuildNow = app._renderer._rebuildNow.bind(app._renderer)
        const prepareCanvas = app._renderer.prepareCanvasMediaResource.bind(app._renderer)
        const createDrawingCanvas = app._createDrawingLayerCanvas.bind(app)
        app._renderer.stageLayerSet = (...args) => {
            stageCalls++
            return stageLayerSet(...args)
        }
        app._renderer._rebuildNow = (...args) => {
            compileCalls++
            return rebuildNow(...args)
        }
        app._renderer.prepareCanvasMediaResource = (...args) => {
            canvasResourcePrepares++
            return prepareCanvas(...args)
        }
        app._createDrawingLayerCanvas = (...args) => {
            drawingRasterizations++
            return createDrawingCanvas(...args)
        }

        const effectLayer = (overrides = {}) => ({
            ...structuredClone(oldLayers[0]),
            id: 'layer-security-effect',
            children: [],
            ...overrides,
        })
        const attacks = [
            buildNodeModel([effectLayer({
                effectId: 'synth/solid).write(o9)', effectParams: {},
            })], { width: oldSize[0], height: oldSize[1] }),
            buildNodeModel([effectLayer({
                effectParams: { 'alpha).write(o9)': 1 },
            })], { width: oldSize[0], height: oldSize[1] }),
            buildNodeModel([effectLayer({
                effectParams: { color: '#fff).write(o9)', alpha: 1 },
            })], { width: oldSize[0], height: oldSize[1] }),
            buildNodeModel([effectLayer({
                effectId: 'filter/text',
                effectParams: { text: 'safe""".write(o9)', color: '#ffffff' },
            })], { width: oldSize[0], height: oldSize[1] }),
            buildNodeModel([effectLayer({
                children: [{
                    id: 'child-security', name: 'Unsafe child', visible: true,
                    effectId: 'synth/gradient', effectParams: { type: 0 },
                }],
            })], { width: oldSize[0], height: oldSize[1] }),
            buildNodeModel([{
                id: 'layer-security-media', name: 'Huge placeholder',
                visible: true, opacity: 100, blendMode: 'mix', locked: false,
                offsetX: 0, offsetY: 0, scaleX: 9000, scaleY: 1,
                rotation: 0, flipH: false, flipV: false,
                sourceType: 'media', mediaType: 'image', effectId: null,
                effectParams: {}, children: [], mask: null,
                maskEnabled: true, maskVisible: false,
            }], { width: oldSize[0], height: oldSize[1] }),
        ]

        for (const attack of attacks) {
            nodes = attack
            handlers.get('remote-node')?.({})
            await new Promise(resolve => setTimeout(resolve, 180))
            while (adapter.isApplyingRemote()) {
                await new Promise(resolve => setTimeout(resolve, 10))
            }
        }

        return {
            stageCalls,
            compileCalls,
            canvasResourcePrepares,
            drawingRasterizations,
            sameLayers: app._layers === oldLayers,
            sameRendererLayers: app._renderer._layers === oldLayers,
            size: [app._canvas.width, app._canvas.height],
            oldSize,
        }
    })

    expect(result.stageCalls).toBe(0)
    expect(result.compileCalls).toBe(0)
    expect(result.canvasResourcePrepares).toBe(0)
    expect(result.drawingRasterizations).toBe(0)
    expect(result.sameLayers).toBe(true)
    expect(result.sameRendererLayers).toBe(true)
    expect(result.size).toEqual(result.oldSize)
})

test('duplicate remote node ids are rejected before last-value reconstruction can bypass bounds', async ({ page }) => {
    await bootSolid(page)

    const result = await page.evaluate(async () => {
        const app = window.layersApp
        const { createLayersOnlineAdapter } = await import('/js/collab/onlineAdapter.js')
        const { buildNodeModel } = await import('/js/collab/docModel.js')
        const { createEffectLayer } = await import('/js/layers/layer-model.js')
        const oldLayers = app._layers
        const oldSize = [app._canvas.width, app._canvas.height]
        const oldGeneration = app._replacementGeneration

        const remoteLayer = createEffectLayer('synth/gradient', 'Duplicate meta attack')
        remoteLayer.id = 'layer-duplicate-meta'
        const invalidNodes = buildNodeModel([remoteLayer], { width: 100, height: 100 })
        const validMeta = invalidNodes.find(node => node.id === 'meta')
        const oversizedMeta = structuredClone(validMeta)
        const parsed = JSON.parse(oversizedMeta.text)
        parsed.canvas = { w: 8193, h: 1 }
        oversizedMeta.text = JSON.stringify(parsed)
        invalidNodes.push(oversizedMeta)

        const handlers = new Map()
        let status = 'offline'
        let nodes = buildNodeModel(app._layers, {
            width: app._canvas.width, height: app._canvas.height,
        })
        const online = {
            on: (event, handler) => handlers.set(event, handler),
            getStatus: () => status,
            getSessionId: () => 'dupe01',
            getShareUrl: () => 'https://layers.test/?seance=dupe01',
            getNodes: () => nodes,
            joinSession: async () => { status = 'online' },
            goOffline: () => { status = 'offline' },
            writeSessionToUrl: (url) => url,
        }
        const adapter = createLayersOnlineAdapter(app, {
            location: new URL('https://layers.test/'),
            history: { replaceState() {} }, dialog: null,
            importSdk: async () => ({ createOnlineDslLayer: () => online }),
        })
        await adapter.joinSession('dupe01', { skipConfirm: true })

        const stageLayerSet = app._renderer.stageLayerSet.bind(app._renderer)
        let stageCalls = 0
        app._renderer.stageLayerSet = (...args) => {
            stageCalls++
            return stageLayerSet(...args)
        }
        nodes = invalidNodes
        handlers.get('remote-node')?.({})
        await new Promise(resolve => setTimeout(resolve, 250))
        while (adapter.isApplyingRemote()) await new Promise(resolve => setTimeout(resolve, 10))
        app._renderer.stageLayerSet = stageLayerSet

        return {
            sameLayers: app._layers === oldLayers,
            size: [app._canvas.width, app._canvas.height],
            oldSize,
            generation: app._replacementGeneration,
            oldGeneration,
            stageCalls,
        }
    })

    expect(result.sameLayers).toBe(true)
    expect(result.size).toEqual(result.oldSize)
    expect(result.generation).toBe(result.oldGeneration)
    expect(result.stageCalls).toBe(0)
})

test('candidate baseline encoding failure occurs before remote app or renderer commit', async ({ page }) => {
    await bootSolid(page)

    const result = await page.evaluate(async () => {
        const app = window.layersApp
        const { createLayersOnlineAdapter } = await import('/js/collab/onlineAdapter.js')
        const { buildNodeModel } = await import('/js/collab/docModel.js')
        const { createEffectLayer } = await import('/js/layers/layer-model.js')
        const oldLayers = app._layers
        const oldRendererLayers = app._renderer._layers
        const oldGeneration = app._replacementGeneration
        const oldUndoLength = app._undoManager._stack.length

        const remoteLayer = createEffectLayer('synth/gradient', 'Masked remote')
        remoteLayer.id = 'layer-masked-remote'
        remoteLayer.mask = new ImageData(4, 4)
        const failureNodes = buildNodeModel([remoteLayer], {
            width: app._canvas.width, height: app._canvas.height,
        })

        const handlers = new Map()
        let status = 'offline'
        let nodes = buildNodeModel(app._layers, {
            width: app._canvas.width, height: app._canvas.height,
        })
        const online = {
            on: (event, handler) => handlers.set(event, handler),
            getStatus: () => status,
            getSessionId: () => 'base01',
            getShareUrl: () => 'https://layers.test/?seance=base01',
            getNodes: () => nodes,
            joinSession: async () => { status = 'online' },
            goOffline: () => { status = 'offline' },
            writeSessionToUrl: (url) => url,
        }
        const adapter = createLayersOnlineAdapter(app, {
            location: new URL('https://layers.test/'),
            history: { replaceState() {} }, dialog: null,
            importSdk: async () => ({ createOnlineDslLayer: () => online }),
        })
        await adapter.joinSession('base01', { skipConfirm: true })

        const stageLayerSet = app._renderer.stageLayerSet.bind(app._renderer)
        let commitCalls = 0
        app._renderer.stageLayerSet = async (...args) => {
            const stage = await stageLayerSet(...args)
            const commit = stage.commit.bind(stage)
            stage.commit = () => { commitCalls++; return commit() }
            return stage
        }
        const toDataURL = HTMLCanvasElement.prototype.toDataURL
        HTMLCanvasElement.prototype.toDataURL = () => {
            throw new Error('injected candidate baseline failure')
        }
        nodes = failureNodes
        handlers.get('remote-node')?.({})
        await new Promise(resolve => setTimeout(resolve, 250))
        while (adapter.isApplyingRemote()) await new Promise(resolve => setTimeout(resolve, 10))
        HTMLCanvasElement.prototype.toDataURL = toDataURL
        app._renderer.stageLayerSet = stageLayerSet

        return {
            sameLayers: app._layers === oldLayers,
            sameRendererLayers: app._renderer._layers === oldRendererLayers,
            generation: app._replacementGeneration,
            oldGeneration,
            undoLength: app._undoManager._stack.length,
            oldUndoLength,
            commitCalls,
        }
    })

    expect(result.sameLayers).toBe(true)
    expect(result.sameRendererLayers).toBe(true)
    expect(result.generation).toBe(result.oldGeneration)
    expect(result.undoLength).toBe(result.oldUndoLength)
    expect(result.commitCalls).toBe(0)
})

test('post-commit renderer restart and media warning failures do not reject the committed remote project', async ({ page }) => {
    const pageErrors = []
    page.on('pageerror', error => pageErrors.push(error.message))
    await bootSolid(page)

    const result = await page.evaluate(async () => {
        const app = window.layersApp
        const { createLayersOnlineAdapter } = await import('/js/collab/onlineAdapter.js')
        const { buildNodeModel } = await import('/js/collab/docModel.js')
        const { toast } = await import('/js/ui/toast.js')
        const handlers = new Map()
        let status = 'offline'
        let nodes = buildNodeModel(app._layers, {
            width: app._canvas.width, height: app._canvas.height,
        })
        const online = {
            on: (event, handler) => handlers.set(event, handler),
            getStatus: () => status,
            getSessionId: () => 'tail01',
            getShareUrl: () => 'https://layers.test/?seance=tail01',
            getNodes: () => nodes,
            joinSession: async () => { status = 'online' },
            goOffline: () => { status = 'offline' },
            writeSessionToUrl: (url) => url,
        }
        const adapter = createLayersOnlineAdapter(app, {
            location: new URL('https://layers.test/'),
            history: { replaceState() {} },
            dialog: null,
            importSdk: async () => ({ createOnlineDslLayer: () => online }),
        })
        await adapter.joinSession('tail01', { skipConfirm: true })

        const remoteMedia = {
            id: 'layer-remote-media',
            name: 'Remote media',
            visible: true,
            opacity: 100,
            blendMode: 'mix',
            locked: false,
            offsetX: 0,
            offsetY: 0,
            scaleX: 1,
            scaleY: 1,
            rotation: 0,
            flipH: false,
            flipV: false,
            sourceType: 'media',
            mediaFile: null,
            mediaType: 'image',
            effectId: null,
            effectParams: {},
            children: [],
            mask: null,
            maskEnabled: true,
            maskVisible: false,
        }
        nodes = buildNodeModel([remoteMedia], { width: 275, height: 155 })
        const initialGeneration = app._replacementGeneration

        app._renderer.stop()
        const rendererStart = app._renderer.start.bind(app._renderer)
        const toastWarning = toast.warning.bind(toast)
        let startAttempts = 0
        const warningMessages = []
        app._renderer.start = () => {
            startAttempts++
            throw new Error('restart side effect failed')
        }
        toast.warning = (message) => {
            warningMessages.push(message)
            throw new Error('toast side effect failed')
        }

        handlers.get('remote-node')?.({})
        await new Promise(resolve => setTimeout(resolve, 180))
        while (adapter.isApplyingRemote()) {
            await new Promise(resolve => setTimeout(resolve, 10))
        }

        app._renderer.start = rendererStart
        toast.warning = toastWarning
        return {
            layerIds: app._layers.map(layer => layer.id),
            sameRendererLayers: app._renderer._layers === app._layers,
            generation: app._replacementGeneration,
            initialGeneration,
            applyingRemote: adapter.isApplyingRemote(),
            startAttempts,
            warningMessages,
        }
    })

    expect(result.layerIds).toEqual(['layer-remote-media'])
    expect(result.sameRendererLayers).toBe(true)
    expect(result.generation).toBe(result.initialGeneration + 1)
    expect(result.applyingRemote).toBe(false)
    expect(result.startAttempts).toBe(1)
    expect(result.warningMessages).toEqual([
        'This session includes a media layer, which can’t be shown here yet.',
    ])
    expect(pageErrors).toEqual([])
})
