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
        let nodes = []
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
        await new Promise(resolve => setTimeout(resolve, 350))
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
        let nodes = []
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
        let nodes = []
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

test('remote drawing apply owns lifecycle until post-swap rasterization finishes', async ({ page }) => {
    await bootSolid(page)

    const result = await page.evaluate(async () => {
        const app = window.layersApp
        const { createLayersOnlineAdapter } = await import('/js/collab/onlineAdapter.js')
        const { buildNodeModel } = await import('/js/collab/docModel.js')
        const { createDrawingLayer } = await import('/js/layers/layer-model.js')
        const handlers = new Map()
        let status = 'offline'
        let nodes = []
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

        const rasterizeDrawingLayer = app._rasterizeDrawingLayer.bind(app)
        let rasterizeStarted = false
        let releaseRasterize
        app._rasterizeDrawingLayer = async (...args) => {
            rasterizeStarted = true
            await new Promise(resolve => { releaseRasterize = resolve })
            return rasterizeDrawingLayer(...args)
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
        let nodes = []
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

        const rasterizeDrawingLayer = app._rasterizeDrawingLayer.bind(app)
        let rasterizeStarted = false
        let releaseRasterize
        app._rasterizeDrawingLayer = async (...args) => {
            rasterizeStarted = true
            await new Promise(resolve => { releaseRasterize = resolve })
            return rasterizeDrawingLayer(...args)
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
