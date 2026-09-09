import { test, expect } from './fixtures.js'
import { IN_PAGE_UNTIL } from './waits.js'

async function bootSolid(page) {
    await page.goto('/', { waitUntil: 'networkidle' })
    await page.locator('#loading-screen').waitFor({ state: 'hidden' })
    const backdrop = page.locator('.open-dialog-backdrop.visible')
    await backdrop.waitFor()
    await page.locator('.media-option[data-type="solid"]').click()
    await page.locator('.canvas-size-dialog .action-btn.primary').click()
    await backdrop.waitFor({ state: 'hidden' })
}

test('rejected take-online preserves the active session', async ({ page }) => {
    await bootSolid(page)

    const result = await page.evaluate(async () => {
        const { createLayersOnlineAdapter } = await import('/js/collab/onlineAdapter.js')
        const { buildNodeModel } = await import('/js/collab/docModel.js')
        const app = window.layersApp
        const initialNodes = buildNodeModel(app._layers, {
            width: app._canvas.width, height: app._canvas.height,
        })
        const layers = []
        const createLayer = () => {
            let status = 'offline'
            let sessionId = null
            const layer = {
                goOfflineCalls: 0,
                on() {},
                getStatus: () => status,
                getSessionId: () => sessionId,
                getShareUrl: () => `https://layers.test/?seance=${sessionId || ''}`,
                getNodes: () => initialNodes,
                joinSession: async (id) => {
                    sessionId = id
                    status = 'online'
                },
                takeOnline: async () => {
                    throw new Error('take-online rejected')
                },
                goOffline: () => {
                    layer.goOfflineCalls += 1
                    status = 'offline'
                },
                writeSessionToUrl: (url) => url,
            }
            layers.push(layer)
            return layer
        }
        const adapter = createLayersOnlineAdapter(app, {
            location: new URL('https://layers.test/'),
            history: { replaceState() {} },
            dialog: null,
            importSdk: async () => ({ createOnlineDslLayer: createLayer }),
        })
        await adapter.joinSession('original', { skipConfirm: true })
        const original = adapter.online
        let error = null
        try {
            await adapter.takeOnline()
        } catch (err) {
            error = err.message
        }
        return {
            error,
            status: adapter.getStatus(),
            sessionId: adapter.online.getSessionId(),
            preservedConnection: adapter.online === original,
            originalDisconnects: original.goOfflineCalls,
            connectionCount: layers.length,
        }
    })

    expect(result).toEqual({
        error: 'take-online rejected',
        status: 'online',
        sessionId: 'original',
        preservedConnection: true,
        originalDisconnects: 0,
        connectionCount: 2,
    })
})

test('rejected join preserves the active session', async ({ page }) => {
    await bootSolid(page)

    const result = await page.evaluate(async () => {
        const { createLayersOnlineAdapter } = await import('/js/collab/onlineAdapter.js')
        const { buildNodeModel } = await import('/js/collab/docModel.js')
        const app = window.layersApp
        const initialNodes = buildNodeModel(app._layers, {
            width: app._canvas.width, height: app._canvas.height,
        })
        const layers = []
        const createLayer = () => {
            let status = 'offline'
            let sessionId = null
            const layer = {
                goOfflineCalls: 0,
                on() {},
                getStatus: () => status,
                getSessionId: () => sessionId,
                getShareUrl: () => `https://layers.test/?seance=${sessionId || ''}`,
                getNodes: () => initialNodes,
                joinSession: async (id) => {
                    if (id === 'replacement') throw new Error('join rejected')
                    sessionId = id
                    status = 'online'
                },
                takeOnline: async () => {},
                goOffline: () => {
                    layer.goOfflineCalls += 1
                    status = 'offline'
                },
                writeSessionToUrl: (url) => url,
            }
            layers.push(layer)
            return layer
        }
        const adapter = createLayersOnlineAdapter(app, {
            location: new URL('https://layers.test/'),
            history: { replaceState() {} },
            dialog: null,
            importSdk: async () => ({ createOnlineDslLayer: createLayer }),
        })
        await adapter.joinSession('original', { skipConfirm: true })
        const original = adapter.online
        const joined = await adapter.joinSession('replacement', { skipConfirm: true })
        return {
            joined,
            status: adapter.getStatus(),
            sessionId: adapter.online.getSessionId(),
            preservedConnection: adapter.online === original,
            originalDisconnects: original.goOfflineCalls,
            connectionCount: layers.length,
        }
    })

    expect(result).toEqual({
        joined: null,
        status: 'online',
        sessionId: 'original',
        preservedConnection: true,
        originalDisconnects: 0,
        connectionCount: 2,
    })
})

test('rejected take-online preserves an armed publish for the old session', async ({ page }) => {
    await bootSolid(page)

    const result = await page.evaluate(async (untilSrc) => {
        const until = eval(untilSrc)
        const { createLayersOnlineAdapter } = await import('/js/collab/onlineAdapter.js')
        const { buildNodeModel } = await import('/js/collab/docModel.js')
        const app = window.layersApp
        const initialNodes = buildNodeModel(app._layers, {
            width: app._canvas.width, height: app._canvas.height,
        })
        const connections = []
        const createLayer = () => {
            const handlers = new Map()
            let status = 'offline'
            let sessionId = null
            const index = connections.length
            const layer = {
                handlers,
                upserts: [],
                // The publish funnel reads the session's nodes on every run, so a
                // rise in nodeReads is the observable signal that a debounced
                // publish actually fired.
                nodeReads: 0,
                on: (event, handler) => handlers.set(event, handler),
                getStatus: () => status,
                getSessionId: () => sessionId,
                getShareUrl: () => `https://layers.test/?seance=${sessionId || ''}`,
                getNodes: () => { layer.nodeReads += 1; return initialNodes },
                joinSession: async (id) => { sessionId = id; status = 'online' },
                takeOnline: async () => { throw new Error('take-online rejected') },
                upsertNode: (id, node) => layer.upserts.push({ id, ...node }),
                deleteNode() {},
                goOffline: () => { status = 'offline' },
                writeSessionToUrl: (url) => url,
            }
            connections.push(layer)
            return layer
        }
        const expectedLayerNodeId = `L${app._layers[0].id}`
        const adapter = createLayersOnlineAdapter(app, {
            location: new URL('https://layers.test/'),
            history: { replaceState() {} },
            dialog: null,
            importSdk: async () => ({ createOnlineDslLayer: createLayer }),
        })
        await adapter.joinSession('original', { skipConfirm: true })
        const original = connections[0]
        const baselineReads = original.nodeReads
        adapter.schedulePublish()
        await until(() => original.nodeReads > baselineReads, 'the baseline publish flushed')
        original.upserts = []

        app._layers[0].name = 'Local edit waiting to publish'
        adapter.schedulePublish()
        let error = null
        try {
            await adapter.takeOnline()
        } catch (err) {
            error = err.message
        }
        await until(
            () => original.upserts.length > 0 || connections[1].upserts.length > 0,
            'the armed publish reached a session')

        return {
            error,
            activeSession: adapter.online.getSessionId(),
            expectedLayerNodeId,
            oldUpsertIds: original.upserts.map(node => node.id),
            candidateUpsertCount: connections[1].upserts.length,
        }
    }, IN_PAGE_UNTIL)

    expect(result.error).toBe('take-online rejected')
    expect(result.activeSession).toBe('original')
    expect(result.oldUpsertIds).toContain(result.expectedLayerNodeId)
    expect(result.candidateUpsertCount).toBe(0)
})

test('successful join discards an armed old-session publish instead of retargeting it', async ({ page }) => {
    await bootSolid(page)

    const result = await page.evaluate(async (untilSrc) => {
        const until = eval(untilSrc)
        const app = window.layersApp
        const { createLayersOnlineAdapter } = await import('/js/collab/onlineAdapter.js')
        const { buildNodeModel } = await import('/js/collab/docModel.js')
        const { createEffectLayer } = await import('/js/layers/layer-model.js')
        const remoteLayer = createEffectLayer('synth/gradient', 'New session layer')
        remoteLayer.id = 'layer-new-session'
        const remoteNodes = buildNodeModel([remoteLayer], {
            width: app._canvas.width, height: app._canvas.height,
        })
        const initialNodes = buildNodeModel(app._layers, {
            width: app._canvas.width, height: app._canvas.height,
        })
        const connections = []
        const createLayer = () => {
            const handlers = new Map()
            let status = 'offline'
            let sessionId = null
            const index = connections.length
            const layer = {
                handlers,
                upserts: [],
                // A rise in nodeReads means the publish funnel ran: it reads the
                // session's nodes on every publish.
                nodeReads: 0,
                on: (event, handler) => handlers.set(event, handler),
                getStatus: () => status,
                getSessionId: () => sessionId,
                getShareUrl: () => `https://layers.test/?seance=${sessionId || ''}`,
                getNodes: () => {
                    layer.nodeReads += 1
                    return index === 0 ? initialNodes : remoteNodes
                },
                joinSession: async (id) => {
                    if (index === 1) {
                        // Injected transport delay, part of the fixture: it holds the
                        // new session's join open past the adapter's 150ms publish
                        // debounce so the old session's armed publish fires
                        // mid-transition, which is the race under test.
                        await new Promise(resolve => setTimeout(resolve, 220))
                    }
                    sessionId = id
                    status = 'online'
                },
                upsertNode: (id, node) => layer.upserts.push({ id, ...node }),
                deleteNode() {},
                goOffline: () => { status = 'offline' },
                writeSessionToUrl: (url) => url,
            }
            connections.push(layer)
            return layer
        }
        const adapter = createLayersOnlineAdapter(app, {
            location: new URL('https://layers.test/'),
            history: { replaceState() {} },
            dialog: null,
            importSdk: async () => ({ createOnlineDslLayer: createLayer }),
        })
        await adapter.joinSession('old', { skipConfirm: true })
        const baselineReads = connections[0].nodeReads
        adapter.schedulePublish()
        await until(() => connections[0].nodeReads > baselineReads,
            'the baseline publish flushed')
        connections[0].upserts = []

        app._layers[0].name = 'Old-session pending edit'
        adapter.schedulePublish()
        await adapter.joinSession('new', { skipConfirm: true })
        // Barrier, not a sleep. This publish is armed after the transition, so it
        // is behind anything the old session left armed: once the funnel has read
        // the new session's nodes, a publish retargeted from the old session would
        // already have shown up in the upsert lists below. It carries no local
        // change of its own, so its own diff is empty.
        const readsAfterJoin = connections[1].nodeReads
        adapter.schedulePublish()
        await until(() => connections[1].nodeReads > readsAfterJoin,
            'a publish ran against the new session')
        await until(() => !adapter.isApplyingRemote(), 'no remote apply is in flight')

        return {
            oldUpsertCount: connections[0].upserts.length,
            newUpsertCount: connections[1].upserts.length,
            finalLayerIds: app._layers.map(layer => layer.id),
        }
    }, IN_PAGE_UNTIL)

    expect(result).toEqual({
        oldUpsertCount: 0,
        newUpsertCount: 0,
        finalLayerIds: ['layer-new-session'],
    })
})

test('successful join clears rejected hashes inherited from the old session', async ({ page }) => {
    await bootSolid(page)

    const result = await page.evaluate(async (untilSrc) => {
        const until = eval(untilSrc)
        const app = window.layersApp
        const { createLayersOnlineAdapter } = await import('/js/collab/onlineAdapter.js')
        const { buildNodeModel } = await import('/js/collab/docModel.js')
        const originalName = app._layers[0].name
        const layerNodeId = `L${app._layers[0].id}`
        const remoteLayer = { ...app._layers[0], name: 'Different remote name' }
        const remoteNodes = buildNodeModel([remoteLayer], {
            width: app._canvas.width, height: app._canvas.height,
        })
        const initialNodes = buildNodeModel(app._layers, {
            width: app._canvas.width, height: app._canvas.height,
        })
        const connections = []
        const createLayer = () => {
            const handlers = new Map()
            let status = 'offline'
            let sessionId = null
            const index = connections.length
            const layer = {
                handlers,
                upserts: [],
                // A rise in nodeReads means the publish funnel ran: it reads the
                // session's nodes on every publish.
                nodeReads: 0,
                on: (event, handler) => handlers.set(event, handler),
                getStatus: () => status,
                getSessionId: () => sessionId,
                getShareUrl: () => `https://layers.test/?seance=${sessionId || ''}`,
                getNodes: () => {
                    layer.nodeReads += 1
                    return index === 0 ? initialNodes : remoteNodes
                },
                joinSession: async (id) => { sessionId = id; status = 'online' },
                upsertNode: (id, node) => layer.upserts.push({ id, ...node }),
                deleteNode() {},
                goOffline: () => { status = 'offline' },
                writeSessionToUrl: (url) => url,
            }
            connections.push(layer)
            return layer
        }
        const adapter = createLayersOnlineAdapter(app, {
            location: new URL('https://layers.test/'),
            history: { replaceState() {} },
            dialog: null,
            importSdk: async () => ({ createOnlineDslLayer: createLayer }),
        })
        await adapter.joinSession('old', { skipConfirm: true })
        const baselineReads = connections[0].nodeReads
        adapter.schedulePublish()
        await until(() => connections[0].nodeReads > baselineReads,
            'the baseline publish flushed')
        connections[0].handlers.get('node-reject')?.({ id: layerNodeId })

        await adapter.joinSession('new', { skipConfirm: true })
        await until(
            () => !adapter.isApplyingRemote()
                && app._layers[0]?.name === 'Different remote name',
            'the joined session replaced the layer name')
        const readsBeforeRepublish = connections[1].nodeReads
        app._layers[0].name = originalName
        adapter.schedulePublish()
        await until(() => connections[1].nodeReads > readsBeforeRepublish,
            'the republish funnel ran against the new session')

        return {
            layerNodeId,
            upsertIds: connections[1].upserts.map(node => node.id),
        }
    }, IN_PAGE_UNTIL)

    expect(result.upsertIds).toContain(result.layerNodeId)
})

test('successful take-online cancels old publish work and rebases rejection state', async ({ page }) => {
    await bootSolid(page)

    const result = await page.evaluate(async (untilSrc) => {
        const until = eval(untilSrc)
        const app = window.layersApp
        const { createLayersOnlineAdapter } = await import('/js/collab/onlineAdapter.js')
        const { buildNodeModel } = await import('/js/collab/docModel.js')
        const originalName = app._layers[0].name
        const layerNodeId = `L${app._layers[0].id}`
        const remoteLayer = { ...app._layers[0], name: 'New session remote edit' }
        const remoteNodes = buildNodeModel([remoteLayer], {
            width: app._canvas.width, height: app._canvas.height,
        })
        const initialNodes = buildNodeModel(app._layers, {
            width: app._canvas.width, height: app._canvas.height,
        })
        const connections = []
        const createLayer = () => {
            const handlers = new Map()
            let status = 'offline'
            let sessionId = null
            const index = connections.length
            const layer = {
                handlers,
                upserts: [],
                seed: null,
                // A rise in nodeReads means the publish funnel ran: it reads the
                // session's nodes on every publish.
                nodeReads: 0,
                on: (event, handler) => handlers.set(event, handler),
                getStatus: () => status,
                getSessionId: () => sessionId,
                getShareUrl: () => `https://layers.test/?seance=${sessionId || ''}`,
                getNodes: () => {
                    layer.nodeReads += 1
                    return index === 0 ? initialNodes : remoteNodes
                },
                joinSession: async (id) => { sessionId = id; status = 'online' },
                takeOnline: async ({ poly }) => {
                    layer.seed = poly.nodes
                    sessionId = 'taken'
                    status = 'online'
                },
                upsertNode: (id, node) => layer.upserts.push({ id, ...node }),
                deleteNode() {},
                goOffline: () => { status = 'offline' },
                writeSessionToUrl: (url) => url,
            }
            connections.push(layer)
            return layer
        }
        const adapter = createLayersOnlineAdapter(app, {
            location: new URL('https://layers.test/'),
            history: { replaceState() {} }, dialog: null,
            importSdk: async () => ({ createOnlineDslLayer: createLayer }),
        })
        await adapter.joinSession('old', { skipConfirm: true })
        const baselineReads = connections[0].nodeReads
        adapter.schedulePublish()
        await until(() => connections[0].nodeReads > baselineReads,
            'the baseline publish flushed')
        connections[0].handlers.get('node-reject')?.({ id: layerNodeId })
        connections[0].upserts = []

        app._layers[0].name = 'Pending old-session edit'
        adapter.schedulePublish()
        await adapter.takeOnline()
        // Barrier, not a sleep. This publish is armed after the transition, so it
        // is behind anything the old session left armed: once the funnel has read
        // the taken session's nodes, a retargeted old publish would already have
        // shown up in its upserts. It carries no local change, so its diff is empty.
        const readsAfterTake = connections[1].nodeReads
        adapter.schedulePublish()
        await until(() => connections[1].nodeReads > readsAfterTake,
            'a publish ran against the taken session')
        const upsertsAfterTransition = connections[1].upserts.length

        connections[1].handlers.get('remote-node')?.({})
        await until(
            () => !adapter.isApplyingRemote()
                && app._layers[0]?.name === 'New session remote edit',
            'the remote apply landed on the taken session')
        const readsBeforeRepublish = connections[1].nodeReads
        app._layers[0].name = originalName
        adapter.schedulePublish()
        await until(() => connections[1].nodeReads > readsBeforeRepublish,
            'the republish funnel ran against the taken session')

        const seededLayer = connections[1].seed.find(node => node.id === layerNodeId)
        return {
            oldUpsertCount: connections[0].upserts.length,
            upsertsAfterTransition,
            seededPendingEdit: seededLayer.text.includes('Pending old-session edit'),
            newUpsertIds: connections[1].upserts.map(node => node.id),
            layerNodeId,
        }
    }, IN_PAGE_UNTIL)

    expect(result.oldUpsertCount).toBe(0)
    expect(result.upsertsAfterTransition).toBe(0)
    expect(result.seededPendingEdit).toBe(true)
    expect(result.newUpsertIds).toContain(result.layerNodeId)
})

test('queued apply from an old session is not retargeted after take-online succeeds', async ({ page }) => {
    await bootSolid(page)

    const result = await page.evaluate(async (untilSrc) => {
        const until = eval(untilSrc)
        const app = window.layersApp
        const { createLayersOnlineAdapter } = await import('/js/collab/onlineAdapter.js')
        const { buildNodeModel } = await import('/js/collab/docModel.js')
        const { createEffectLayer } = await import('/js/layers/layer-model.js')
        const retargetLayer = createEffectLayer('synth/gradient', 'Must not apply')
        retargetLayer.id = 'layer-retargeted-apply'
        const retargetNodes = buildNodeModel([retargetLayer], {
            width: app._canvas.width, height: app._canvas.height,
        })
        const initialNodes = buildNodeModel(app._layers, {
            width: app._canvas.width, height: app._canvas.height,
        })
        const connections = []
        const createLayer = () => {
            const handlers = new Map()
            let status = 'offline'
            let sessionId = null
            const layer = {
                handlers,
                on: (event, handler) => handlers.set(event, handler),
                getStatus: () => status,
                getSessionId: () => sessionId,
                getShareUrl: () => `https://layers.test/?seance=${sessionId || ''}`,
                getNodes: () => index === 0 ? initialNodes : retargetNodes,
                joinSession: async (id) => { sessionId = id; status = 'online' },
                takeOnline: async ({ poly }) => {
                    layer.seed = poly.nodes
                    sessionId = 'taken'
                    status = 'online'
                },
                upsertNode() {},
                deleteNode() {},
                goOffline: () => { status = 'offline' },
                writeSessionToUrl: (url) => url,
            }
            connections.push(layer)
            return layer
        }
        const adapter = createLayersOnlineAdapter(app, {
            location: new URL('https://layers.test/'),
            history: { replaceState() {} },
            dialog: null,
            importSdk: async () => ({ createOnlineDslLayer: createLayer }),
        })
        await adapter.joinSession('old', { skipConfirm: true })
        const originalLayerIds = app._layers.map(layer => layer.id)
        connections[0].handlers.get('remote-node')?.({})
        await adapter.takeOnline()
        // Observation window, not a readiness guess: the assertion is that the
        // apply queued against the old session never lands, and the adapter
        // coalesces remote-node events for 120ms before it would run one. There is
        // nothing to wait for here, only a stretch of time in which nothing may
        // happen.
        await new Promise(resolve => setTimeout(resolve, 350))
        await until(() => !adapter.isApplyingRemote(), 'no remote apply is in flight')

        return {
            originalLayerIds,
            finalLayerIds: app._layers.map(layer => layer.id),
            activeSession: adapter.online.getSessionId(),
        }
    }, IN_PAGE_UNTIL)

    expect(result.finalLayerIds).toEqual(result.originalLayerIds)
    expect(result.activeSession).toBe('taken')
})

test('in-flight apply from an old session cannot commit after joining a new session', async ({ page }) => {
    await bootSolid(page)

    const result = await page.evaluate(async (untilSrc) => {
        const until = eval(untilSrc)
        const app = window.layersApp
        const { createLayersOnlineAdapter } = await import('/js/collab/onlineAdapter.js')
        const { buildNodeModel } = await import('/js/collab/docModel.js')
        const { createEffectLayer } = await import('/js/layers/layer-model.js')
        const oldRemote = createEffectLayer('synth/gradient', 'Old remote')
        oldRemote.id = 'layer-old-remote'
        const newRemote = createEffectLayer('synth/solid', 'New remote')
        newRemote.id = 'layer-new-remote'
        const dims = { width: app._canvas.width, height: app._canvas.height }
        const nodeSets = [buildNodeModel([oldRemote], dims), buildNodeModel([newRemote], dims)]
        const connections = []
        const createLayer = () => {
            const handlers = new Map()
            let status = 'offline'
            let sessionId = null
            const layer = {
                handlers,
                on: (event, handler) => handlers.set(event, handler),
                getStatus: () => status,
                getSessionId: () => sessionId,
                getShareUrl: () => `https://layers.test/?seance=${sessionId || ''}`,
                getNodes: () => sessionId === 'new' ? nodeSets[1] : nodeSets[0],
                joinSession: async (id) => { sessionId = id; status = 'online' },
                upsertNode() {}, deleteNode() {},
                goOffline: () => { status = 'offline' },
                writeSessionToUrl: (url) => url,
            }
            connections.push(layer)
            return layer
        }
        const adapter = createLayersOnlineAdapter(app, {
            location: new URL('https://layers.test/'),
            history: { replaceState() {} }, dialog: null,
            importSdk: async () => ({ createOnlineDslLayer: createLayer }),
        })
        await adapter.joinSession('old', { skipConfirm: true })

        const stageLayerSet = app._renderer.stageLayerSet.bind(app._renderer)
        let releaseOldStage
        let oldStageStarted = false
        const committedLayerIds = []
        // Every staged candidate ends in exactly one of commit or rollback, so
        // recording both gives the wait below an exact signal for "that apply has
        // decided" instead of a guessed duration.
        const rolledBackLayerIds = []
        app._renderer.stageLayerSet = async (candidate) => {
            const ids = candidate.layers.map(layer => layer.id)
            if (ids.includes('layer-old-remote')) {
                oldStageStarted = true
                await new Promise(resolve => { releaseOldStage = resolve })
            }
            const stage = await stageLayerSet(candidate)
            const commit = stage.commit.bind(stage)
            stage.commit = () => {
                committedLayerIds.push(ids)
                return commit()
            }
            const rollback = stage.rollback.bind(stage)
            stage.rollback = () => {
                rolledBackLayerIds.push(ids)
                return rollback()
            }
            return stage
        }

        connections[0].handlers.get('remote-node')?.({})
        await until(() => oldStageStarted, 'the old-session apply reached the renderer stage')
        adapter.goOffline()
        const joinPromise = adapter.joinSession('new', { skipConfirm: true })
        releaseOldStage()
        await joinPromise
        // The released old-session apply must resolve one way or the other: roll
        // its staged candidate back (the behaviour under test) or commit it (the
        // regression). Either outcome ends the wait, so the assertion below reads
        // a settled result rather than whatever had happened by a fixed deadline.
        await until(
            () => rolledBackLayerIds.some(ids => ids.includes('layer-old-remote'))
                || committedLayerIds.some(ids => ids.includes('layer-old-remote')),
            'the old-session apply resolved')
        await until(() => !adapter.isApplyingRemote(), 'no remote apply is in flight')
        app._renderer.stageLayerSet = stageLayerSet

        return {
            committedLayerIds,
            finalLayerIds: app._layers.map(layer => layer.id),
        }
    }, IN_PAGE_UNTIL)

    expect(result.committedLayerIds).not.toContainEqual(['layer-old-remote'])
    expect(result.finalLayerIds).toEqual(['layer-new-remote'])
})

for (const operation of ['take-online', 'join']) {
    test(`post-commit ${operation} cleanup failures preserve the new active session`, async ({ page }) => {
        await bootSolid(page)

        const result = await page.evaluate(async ({ operation }) => {
            const app = window.layersApp
            const { createLayersOnlineAdapter } = await import('/js/collab/onlineAdapter.js')
            const { buildNodeModel } = await import('/js/collab/docModel.js')
            const { toast } = await import('/js/ui/toast.js')
            const nodes = buildNodeModel(app._layers, {
                width: app._canvas.width, height: app._canvas.height,
            })
            let throwUi = false
            const dialog = {
                set state(_value) {
                    if (throwUi) throw new Error('status refresh failed')
                },
                set sessionId(_value) {}, set sessionUrl(_value) {},
            }
            const connections = []
            const createLayer = () => {
                let status = 'offline'
                let sessionId = null
                const index = connections.length
                const layer = {
                    goOfflineCalls: 0,
                    on() {},
                    getStatus: () => status,
                    getSessionId: () => sessionId,
                    getShareUrl: () => `https://layers.test/?seance=${sessionId || ''}`,
                    getNodes: () => nodes,
                    joinSession: async (id) => { sessionId = id; status = 'online' },
                    takeOnline: async () => { sessionId = 'taken'; status = 'online' },
                    upsertNode() {}, deleteNode() {},
                    goOffline: () => {
                        layer.goOfflineCalls++
                        status = 'offline'
                        if (index === 0 && throwUi) throw new Error('old disconnect failed')
                    },
                    writeSessionToUrl: (url) => url,
                }
                connections.push(layer)
                return layer
            }
            const adapter = createLayersOnlineAdapter(app, {
                location: new URL('https://layers.test/'),
                history: { replaceState() { if (throwUi) throw new Error('url failed') } },
                dialog,
                importSdk: async () => ({ createOnlineDslLayer: createLayer }),
            })
            await adapter.joinSession('old', { skipConfirm: true })
            throwUi = true
            toast.success = () => { throw new Error('success toast failed') }
            let value = null
            let error = null
            try {
                value = operation === 'take-online'
                    ? await adapter.takeOnline()
                    : await adapter.joinSession('new', { skipConfirm: true })
            } catch (err) {
                error = err.message
            }
            return {
                value,
                error,
                activeSession: adapter.online.getSessionId(),
                activeIsCandidate: adapter.online === connections[1],
                oldDisconnects: connections[0].goOfflineCalls,
            }
        }, { operation })

        expect(result).toEqual({
            value: operation === 'take-online' ? 'taken' : 'new',
            error: null,
            activeSession: operation === 'take-online' ? 'taken' : 'new',
            activeIsCandidate: true,
            oldDisconnects: 1,
        })
    })
}

test('an accepted deletion expires from the rejection retry window', async ({ page }) => {
    await bootSolid(page)

    const result = await page.evaluate(async (untilSrc) => {
        const until = eval(untilSrc)
        const app = window.layersApp
        const { createLayersOnlineAdapter } = await import('/js/collab/onlineAdapter.js')
        const { buildNodeModel } = await import('/js/collab/docModel.js')
        const nodes = buildNodeModel(app._layers, {
            width: app._canvas.width, height: app._canvas.height,
        })
        const deletedId = nodes.find(node => node.kind === 'layers-layer').id
        const handlers = new Map()
        const deletes = []
        let resolveFirstDelete
        const firstDelete = new Promise(resolve => { resolveFirstDelete = resolve })
        let status = 'offline'
        const online = {
            on: (event, handler) => handlers.set(event, handler),
            getStatus: () => status,
            getSessionId: () => 'delete-expiry',
            getShareUrl: () => '',
            // A rise in nodeReads means the publish funnel ran: it reads the
            // session's nodes on every publish.
            nodeReads: 0,
            getNodes: () => { online.nodeReads += 1; return nodes },
            joinSession: async () => { status = 'online' },
            upsertNode() {},
            deleteNode: id => {
                deletes.push(id)
                resolveFirstDelete()
            },
            goOffline: () => { status = 'offline' },
            writeSessionToUrl: url => url,
        }
        const adapter = createLayersOnlineAdapter(app, {
            location: new URL('https://layers.test/'),
            history: { replaceState() {} }, dialog: null,
            importSdk: async () => ({ createOnlineDslLayer: () => online }),
        })
        await adapter.joinSession('delete-expiry', { skipConfirm: true })
        app._layers.splice(0, 1)
        adapter.schedulePublish()
        await firstDelete
        // Not a readiness guess: the adapter keeps a deleted node's rejection
        // window open for 2s, and the behaviour under test is what happens once
        // that window has genuinely elapsed. The duration is the measurement.
        await new Promise(resolve => setTimeout(resolve, 2200))
        handlers.get('node-reject')?.({ id: deletedId })
        const readsBeforeRetry = online.nodeReads
        adapter.schedulePublish()
        await until(() => online.nodeReads > readsBeforeRetry,
            'the publish funnel ran after the expired rejection')
        return deletes
    }, IN_PAGE_UNTIL)

    expect(result).toHaveLength(1)
})

test('pending deletion retries are globally capped', async ({ page }) => {
    await bootSolid(page)

    const result = await page.evaluate(async (untilSrc) => {
        const until = eval(untilSrc)
        const app = window.layersApp
        const { createLayersOnlineAdapter } = await import('/js/collab/onlineAdapter.js')
        const { buildNodeModel } = await import('/js/collab/docModel.js')
        const { createEffectLayer } = await import('/js/layers/layer-model.js')
        app._layers = Array.from({ length: 257 }, (_, index) => {
            const layer = createEffectLayer('synth/solid', `Layer ${index}`)
            layer.id = `bounded-delete-${index}`
            return layer
        })
        const nodes = buildNodeModel(app._layers, {
            width: app._canvas.width, height: app._canvas.height,
        })
        const layerNodeIds = nodes
            .filter(node => node.kind === 'layers-layer')
            .map(node => node.id)
        const handlers = new Map()
        const deletes = []
        let status = 'offline'
        const online = {
            on: (event, handler) => handlers.set(event, handler),
            getStatus: () => status,
            getSessionId: () => 'delete-cap',
            getShareUrl: () => '',
            // A rise in nodeReads means the publish funnel ran: it reads the
            // session's nodes on every publish.
            nodeReads: 0,
            getNodes: () => { online.nodeReads += 1; return nodes },
            joinSession: async () => { status = 'online' },
            upsertNode() {}, deleteNode: id => deletes.push(id),
            goOffline: () => { status = 'offline' },
            writeSessionToUrl: url => url,
        }
        const adapter = createLayersOnlineAdapter(app, {
            location: new URL('https://layers.test/'),
            history: { replaceState() {} }, dialog: null,
            importSdk: async () => ({ createOnlineDslLayer: () => online }),
        })
        await adapter.joinSession('delete-cap', { skipConfirm: true })
        app._layers = []
        adapter.schedulePublish()
        await until(() => deletes.length > 0, 'the first publish issued its deletes')
        handlers.get('node-reject')?.({ id: layerNodeIds[0] })
        handlers.get('node-reject')?.({ id: layerNodeIds.at(-1) })
        const readsBeforeRetry = online.nodeReads
        adapter.schedulePublish()
        await until(() => online.nodeReads > readsBeforeRetry,
            'the retry publish funnel ran')
        return {
            first: deletes.filter(id => id === layerNodeIds[0]).length,
            last: deletes.filter(id => id === layerNodeIds.at(-1)).length,
        }
    }, IN_PAGE_UNTIL)

    expect(result).toEqual({ first: 1, last: 2 })
})

test('go-offline cancels take-online while the SDK layer is still importing', async ({ page }) => {
    await bootSolid(page)

    const result = await page.evaluate(async (untilSrc) => {
        const until = eval(untilSrc)
        const app = window.layersApp
        const { createLayersOnlineAdapter } = await import('/js/collab/onlineAdapter.js')
        let importStarted = false
        let releaseImport
        let takeCalls = 0
        let disconnects = 0
        let status = 'offline'
        const online = {
            on() {}, getStatus: () => status,
            getSessionId: () => 'late-import', getShareUrl: () => '',
            takeOnline: async () => { takeCalls++; status = 'online' },
            goOffline: () => { disconnects++; status = 'offline' },
            writeSessionToUrl: url => url,
        }
        const adapter = createLayersOnlineAdapter(app, {
            location: new URL('https://layers.test/'),
            history: { replaceState() {} }, dialog: null,
            importSdk: async () => {
                importStarted = true
                await new Promise(resolve => { releaseImport = resolve })
                return { createOnlineDslLayer: () => online }
            },
        })
        const transition = adapter.takeOnline()
        await until(() => importStarted, 'take-online started the SDK import')
        adapter.goOffline()
        const lifecycleToken = app._tryAcquireProjectLifecycle()
        const lifecycleAvailable = Boolean(lifecycleToken)
        lifecycleToken?.release()
        const stayedUninitializedWhileHeld = adapter.online === null
        releaseImport()
        const sessionId = await transition
        return {
            sessionId,
            takeCalls,
            disconnects,
            status: adapter.getStatus(),
            lifecycleAvailable,
            stayedUninitializedWhileHeld,
            stayedUninitializedAfterCompletion: adapter.online === null,
        }
    }, IN_PAGE_UNTIL)

    expect(result).toEqual({
        sessionId: null,
        takeCalls: 0,
        disconnects: 1,
        status: 'offline',
        lifecycleAvailable: true,
        stayedUninitializedWhileHeld: true,
        stayedUninitializedAfterCompletion: true,
    })
})

for (const activeSession of [false, true]) {
    test(`go-offline cancels a held case-probe join with${activeSession ? '' : 'out'} an active session`, async ({ page }) => {
        await bootSolid(page)

        const result = await page.evaluate(async ({ activeSession, untilSrc }) => {
            const until = eval(untilSrc)
            const app = window.layersApp
            const { createLayersOnlineAdapter } = await import('/js/collab/onlineAdapter.js')
            const { buildNodeModel } = await import('/js/collab/docModel.js')
            localStorage.removeItem('layers.seance.sessionIdCaseMap')
            const originalFetch = globalThis.fetch
            const nodes = buildNodeModel(app._layers, {
                width: app._canvas.width, height: app._canvas.height,
            })
            const connections = []
            const createLayer = () => {
                let status = 'offline'
                let sessionId = null
                const layer = {
                    joinCalls: 0,
                    disconnects: 0,
                    on() {},
                    getStatus: () => status,
                    getSessionId: () => sessionId,
                    getShareUrl: () => '',
                    getNodes: () => nodes,
                    joinSession: async id => {
                        layer.joinCalls++
                        sessionId = id
                        status = 'online'
                    },
                    goOffline: () => {
                        layer.disconnects++
                        status = 'offline'
                    },
                    writeSessionToUrl: url => url,
                }
                connections.push(layer)
                return layer
            }
            const adapter = createLayersOnlineAdapter(app, {
                location: new URL('https://layers.test/'),
                history: { replaceState() {} }, dialog: null,
                importSdk: async () => ({ createOnlineDslLayer: createLayer }),
            })
            if (activeSession) {
                await adapter.joinSession('session-A', { skipConfirm: true })
            }

            let probeStarted = false
            let releaseProbe
            globalThis.fetch = async () => {
                probeStarted = true
                await new Promise(resolve => { releaseProbe = resolve })
                return { ok: true }
            }
            const transition = adapter.joinSession('ABCDEF', { skipConfirm: true })
            await until(() => probeStarted, 'the uppercase case probe started')
            adapter.goOffline()
            const lifecycleToken = app._tryAcquireProjectLifecycle()
            const lifecycleAvailable = Boolean(lifecycleToken)
            lifecycleToken?.release()
            releaseProbe()
            const joined = await transition
            globalThis.fetch = originalFetch
            return {
                joined,
                lifecycleAvailable,
                status: adapter.getStatus(),
                connectionCount: connections.length,
                joinCalls: connections.reduce((sum, layer) => sum + layer.joinCalls, 0),
                disconnects: connections.reduce((sum, layer) => sum + layer.disconnects, 0),
            }
        }, { activeSession, untilSrc: IN_PAGE_UNTIL })

        expect(result.joined).toBeNull()
        expect(result.lifecycleAvailable).toBe(true)
        expect(result.status).toBe('offline')
        expect(result.connectionCount).toBe(activeSession ? 1 : 0)
        expect(result.joinCalls).toBe(activeSession ? 1 : 0)
        expect(result.disconnects).toBe(activeSession ? 1 : 0)
    })
}

test('go-offline cancels join while the SDK layer is still importing without holding lifecycle', async ({ page }) => {
    await bootSolid(page)

    const result = await page.evaluate(async (untilSrc) => {
        const until = eval(untilSrc)
        const app = window.layersApp
        const { createLayersOnlineAdapter } = await import('/js/collab/onlineAdapter.js')
        let importStarted = false
        let releaseImport
        let joinCalls = 0
        let disconnects = 0
        let status = 'offline'
        const online = {
            on() {}, getStatus: () => status,
            getSessionId: () => 'late-join', getShareUrl: () => '',
            getNodes: () => [],
            joinSession: async () => { joinCalls++; status = 'online' },
            goOffline: () => { disconnects++; status = 'offline' },
            writeSessionToUrl: url => url,
        }
        const adapter = createLayersOnlineAdapter(app, {
            location: new URL('https://layers.test/'),
            history: { replaceState() {} }, dialog: null,
            importSdk: async () => {
                importStarted = true
                await new Promise(resolve => { releaseImport = resolve })
                return { createOnlineDslLayer: () => online }
            },
        })
        const transition = adapter.joinSession('late-join', { skipConfirm: true })
        await until(() => importStarted, 'the join started the SDK import')
        adapter.goOffline()
        const lifecycleToken = app._tryAcquireProjectLifecycle()
        const lifecycleAvailable = Boolean(lifecycleToken)
        lifecycleToken?.release()
        releaseImport()
        const joined = await transition
        return {
            joined,
            lifecycleAvailable,
            joinCalls,
            disconnects,
            status: adapter.getStatus(),
            stayedUninitializedAfterCompletion: adapter.online === null,
        }
    }, IN_PAGE_UNTIL)

    expect(result).toEqual({
        joined: null,
        lifecycleAvailable: true,
        joinCalls: 0,
        disconnects: 1,
        status: 'offline',
        stayedUninitializedAfterCompletion: true,
    })
})

test('join asks for replacement consent before starting an uppercase session probe', async ({ page }) => {
    await bootSolid(page)

    await page.evaluate(async () => {
        const app = window.layersApp
        const { createLayersOnlineAdapter } = await import('/js/collab/onlineAdapter.js')
        localStorage.removeItem('layers.seance.sessionIdCaseMap')
        const originalFetch = globalThis.fetch
        let probeCalls = 0
        globalThis.fetch = async () => {
            probeCalls++
            return { ok: false }
        }
        const adapter = createLayersOnlineAdapter(app, {
            location: new URL('https://layers.test/'),
            history: { replaceState() {} }, dialog: null,
            importSdk: async () => ({ createOnlineDslLayer: () => ({
                on() {}, getStatus: () => 'offline', getSessionId: () => '',
                getShareUrl: () => '', getNodes: () => [],
                joinSession() {}, goOffline() {}, writeSessionToUrl: url => url,
            }) }),
        })
        const transition = adapter.joinSession('ABCDEF')
        window.__uppercaseConsentProbe = {
            probeCalls: () => probeCalls,
            finish: async () => {
                const joined = await transition
                globalThis.fetch = originalFetch
                return joined
            },
        }
    })

    const confirmation = page.locator('.confirm-dialog-backdrop.visible')
    await confirmation.waitFor()
    expect(await page.evaluate(() => window.__uppercaseConsentProbe.probeCalls())).toBe(0)
    await confirmation.locator('#confirm-cancel').click()
    expect(await page.evaluate(() => window.__uppercaseConsentProbe.finish())).toBeNull()
})

test('go-offline cancels a lifecycle-queued URL join after SDK bootstrap', async ({ page }) => {
    await bootSolid(page)

    const result = await page.evaluate(async () => {
        const app = window.layersApp
        const { createLayersOnlineAdapter } = await import('/js/collab/onlineAdapter.js')
        let importCalls = 0
        let joinCalls = 0
        const online = {
            on() {}, getStatus: () => 'offline', getSessionId: () => '',
            getShareUrl: () => '', getNodes: () => [],
            joinSession: async () => { joinCalls++ }, goOffline() {},
            writeSessionToUrl: url => url,
        }
        const adapter = createLayersOnlineAdapter(app, {
            location: new URL('https://layers.test/?seance=queued-url'),
            history: { replaceState() {} }, dialog: null,
            importSdk: async () => {
                importCalls++
                return { createOnlineDslLayer: () => online }
            },
        })
        const blocker = await app._acquireProjectLifecycle()
        const transition = adapter.joinFromUrl()
        await new Promise(resolve => setTimeout(resolve, 0))
        adapter.goOffline()
        blocker.release()
        return { joined: await transition, importCalls, joinCalls }
    })

    expect(result).toEqual({ joined: false, importCalls: 1, joinCalls: 0 })
})

for (const activeSession of [false, true]) {
    for (const seedTiming of ['before-resolution', 'after-resolution']) {
        test(`take-online consumes its ${seedTiming} seed snapshot with${activeSession ? '' : 'out'} an active session`, async ({ page }) => {
            await bootSolid(page)

            const result = await page.evaluate(async ({ activeSession, seedTiming, untilSrc }) => {
                const until = eval(untilSrc)
                const app = window.layersApp
                const { createLayersOnlineAdapter } = await import('/js/collab/onlineAdapter.js')
                const { buildNodeModel } = await import('/js/collab/docModel.js')
                const { createEffectLayer } = await import('/js/layers/layer-model.js')
                const dims = { width: app._canvas.width, height: app._canvas.height }
                const initialNodes = buildNodeModel(app._layers, dims)
                const remote = createEffectLayer('synth/gradient', 'First real snapshot')
                remote.id = 'first-real-snapshot'
                const remoteNodes = buildNodeModel([remote], dims)
                const connections = []
                let releaseTake
                let takeStarted = false
                const createLayer = () => {
                    const handlers = new Map()
                    let nodes = initialNodes
                    let status = 'offline'
                    let sessionId = null
                    const layer = {
                        handlers,
                        setNodes(value) { nodes = value },
                        on: (event, handler) => handlers.set(event, handler),
                        getStatus: () => status,
                        getSessionId: () => sessionId,
                        getShareUrl: () => '', getNodes: () => nodes,
                        joinSession: async id => { sessionId = id; status = 'online' },
                        takeOnline: async ({ poly }) => {
                            sessionId = 'taken-seed'
                            nodes = poly.nodes
                            status = 'connecting'
                            takeStarted = true
                            if (seedTiming === 'before-resolution') {
                                handlers.get('node-snapshot')?.({})
                            }
                            await new Promise(resolve => { releaseTake = resolve })
                            status = 'online'
                        },
                        upsertNode() {}, deleteNode() {},
                        goOffline: () => { status = 'offline' },
                        writeSessionToUrl: url => url,
                    }
                    connections.push(layer)
                    return layer
                }
                const adapter = createLayersOnlineAdapter(app, {
                    location: new URL('https://layers.test/'),
                    history: { replaceState() {} }, dialog: null,
                    importSdk: async () => ({ createOnlineDslLayer: createLayer }),
                })
                if (activeSession) {
                    await adapter.joinSession('session-A', { skipConfirm: true })
                }
                const generationBefore = app._replacementGeneration
                const transition = adapter.takeOnline()
                await until(() => takeStarted, 'take-online reached the SDK layer')
                releaseTake()
                await transition
                const taken = adapter.online
                if (seedTiming === 'after-resolution') {
                    taken.handlers.get('node-snapshot')?.({})
                    // Observation window, not a readiness guess: the assertion is
                    // that the seed echo is consumed and applies nothing. A missed
                    // seed would schedule an apply, which the adapter coalesces for
                    // 120ms before running, so this window is the measurement.
                    await new Promise(resolve => setTimeout(resolve, 350))
                }
                const generationAfterSeed = app._replacementGeneration
                taken.setNodes(remoteNodes)
                taken.handlers.get('node-snapshot')?.({})
                await until(() => app._layers[0]?.id === remote.id,
                    'the first real snapshot replaced the composition', 3000)
                return {
                    generationBefore,
                    generationAfterSeed,
                    layerIds: app._layers.map(layer => layer.id),
                }
            }, { activeSession, seedTiming, untilSrc: IN_PAGE_UNTIL })

            expect(result.generationAfterSeed).toBe(result.generationBefore)
            expect(result.layerIds).toEqual(['first-real-snapshot'])
        })
    }
}

test('initial join-from-URL applies remote state before a queued local mutation runs', async ({ page }) => {
    await bootSolid(page)

    const result = await page.evaluate(async (untilSrc) => {
        const until = eval(untilSrc)
        const app = window.layersApp
        const { createLayersOnlineAdapter } = await import('/js/collab/onlineAdapter.js')
        const { buildNodeModel } = await import('/js/collab/docModel.js')
        const { createEffectLayer } = await import('/js/layers/layer-model.js')
        const remoteLayer = createEffectLayer('synth/gradient', 'Joined remote')
        remoteLayer.id = 'layer-joined-remote'
        const remoteNodes = buildNodeModel([remoteLayer], {
            width: app._canvas.width, height: app._canvas.height,
        })
        const handlers = new Map()
        let status = 'offline'
        let joinStarted = false
        let releaseJoin
        const upserts = []
        const online = {
            on: (event, handler) => handlers.set(event, handler),
            getStatus: () => status,
            getSessionId: () => 'join01',
            getShareUrl: () => 'https://layers.test/?seance=join01',
            getNodes: () => remoteNodes,
            joinSession: async () => {
                joinStarted = true
                await new Promise(resolve => { releaseJoin = resolve })
                status = 'online'
            },
            upsertNode: (id, node) => upserts.push({ id, ...node }),
            deleteNode() {},
            goOffline: () => { status = 'offline' },
            writeSessionToUrl: (url) => url,
        }
        const adapter = createLayersOnlineAdapter(app, {
            location: new URL('https://layers.test/?seance=join01'),
            history: { replaceState() {} }, dialog: null,
            importSdk: async () => ({ createOnlineDslLayer: () => online }),
        })
        app._onlineAdapter = adapter
        const joinPromise = adapter.joinFromUrl()
        await until(() => joinStarted, 'the URL join reached the SDK layer')

        let mutationSettled = false
        const mutationPromise = window.LayersAgent.addLayer({
            kind: 'effect', effectId: 'filter/blur', name: 'Queued local edit',
        }).then(value => { mutationSettled = true; return value })
        // A barrier rather than a window: the mutation queues behind the join's
        // lifecycle lease, so being counted as a lifecycle waiter proves it reached
        // the queue and parked there. Settling ends the wait too, so a mutation that
        // wrongly ran early is still reported by the assertion instead of hanging.
        await until(() => mutationSettled || app._projectLifecycleWaiters > 0,
            'the local mutation reached the lifecycle queue')
        const mutationSettledBeforeRelease = mutationSettled
        releaseJoin()
        const joined = await joinPromise
        const mutation = await mutationPromise
        await until(() => upserts.length > 0, 'the queued mutation published')

        return {
            joined,
            mutationOk: mutation.ok,
            mutationSettledBeforeRelease,
            layerNames: app._layers.map(layer => layer.name),
            upsertIds: upserts.map(node => node.id),
            mutationLayerId: mutation.result?.layerId,
        }
    }, IN_PAGE_UNTIL)

    expect(result.joined).toBe(true)
    expect(result.mutationOk).toBe(true)
    expect(result.mutationSettledBeforeRelease).toBe(false)
    expect(result.layerNames).toEqual(['Joined remote', 'Queued local edit'])
    expect(result.upsertIds).toContain(`L${result.mutationLayerId}`)
})

test('take-online holds the lifecycle so a concurrent local mutation publishes afterward', async ({ page }) => {
    await bootSolid(page)

    const result = await page.evaluate(async (untilSrc) => {
        const until = eval(untilSrc)
        const app = window.layersApp
        const { createLayersOnlineAdapter } = await import('/js/collab/onlineAdapter.js')
        let status = 'offline'
        let takeStarted = false
        let releaseTake
        let seed = null
        const upserts = []
        const online = {
            on() {},
            getStatus: () => status,
            getSessionId: () => 'taken1',
            getShareUrl: () => 'https://layers.test/?seance=taken1',
            getNodes: () => seed || [],
            takeOnline: async ({ poly }) => {
                seed = poly.nodes
                takeStarted = true
                await new Promise(resolve => { releaseTake = resolve })
                status = 'online'
            },
            upsertNode: (id, node) => upserts.push({ id, ...node }),
            deleteNode() {},
            goOffline: () => { status = 'offline' },
            writeSessionToUrl: (url) => url,
        }
        const adapter = createLayersOnlineAdapter(app, {
            location: new URL('https://layers.test/'),
            history: { replaceState() {} }, dialog: null,
            importSdk: async () => ({ createOnlineDslLayer: () => online }),
        })
        app._onlineAdapter = adapter
        const takePromise = adapter.takeOnline()
        await until(() => takeStarted, 'take-online reached the SDK layer')
        const transitionHeldLifecycle = app._projectLifecycleActive

        let mutationSettled = false
        const mutationPromise = window.LayersAgent.addLayer({
            kind: 'effect', effectId: 'filter/blur', name: 'Mutation after seed',
        }).then(value => { mutationSettled = true; return value })
        // A barrier rather than a window: the mutation queues behind the lifecycle
        // lease the transition holds, so being counted as a lifecycle waiter proves
        // it reached the queue and parked. Settling ends the wait too, so a mutation
        // that wrongly ran early is reported by the assertion instead of hanging.
        await until(() => mutationSettled || app._projectLifecycleWaiters > 0,
            'the local mutation reached the lifecycle queue')
        const mutationSettledBeforeRelease = mutationSettled
        releaseTake()
        const sessionId = await takePromise
        const mutation = await mutationPromise
        await until(() => upserts.length > 0, 'the mutation published after the transition')

        return {
            sessionId,
            mutationOk: mutation.ok,
            transitionHeldLifecycle,
            mutationSettledBeforeRelease,
            seededMutation: seed.some(node => node.id === `L${mutation.result?.layerId}`),
            upsertIds: upserts.map(node => node.id),
            mutationLayerId: mutation.result?.layerId,
        }
    }, IN_PAGE_UNTIL)

    expect(result.sessionId).toBe('taken1')
    expect(result.mutationOk).toBe(true)
    expect(result.transitionHeldLifecycle).toBe(true)
    expect(result.mutationSettledBeforeRelease).toBe(false)
    expect(result.seededMutation).toBe(false)
    expect(result.upsertIds).toContain(`L${result.mutationLayerId}`)
})

test('invalid target session nodes preserve the active session before transition commit', async ({ page }) => {
    await bootSolid(page)

    const result = await page.evaluate(async () => {
        const app = window.layersApp
        const { createLayersOnlineAdapter } = await import('/js/collab/onlineAdapter.js')
        const { buildNodeModel } = await import('/js/collab/docModel.js')
        const connections = []
        const validNodes = buildNodeModel(app._layers, {
            width: app._canvas.width, height: app._canvas.height,
        })
        const invalidNodes = [...validNodes, structuredClone(validNodes[0])]
        const maliciousNodes = structuredClone(validNodes)
        const maliciousLayerNode = maliciousNodes.find(node => node.kind === 'layers-layer')
        const maliciousLayer = JSON.parse(maliciousLayerNode.text)
        maliciousLayer.effectId = 'synth/solid).write(o9)'
        maliciousLayerNode.text = JSON.stringify(maliciousLayer)
        const createLayer = () => {
            const index = connections.length
            let status = 'offline'
            let sessionId = null
            const layer = {
                goOfflineCalls: 0,
                on() {},
                getStatus: () => status,
                getSessionId: () => sessionId,
                getShareUrl: () => `https://layers.test/?seance=${sessionId || ''}`,
                getNodes: () => index === 0
                    ? validNodes
                    : (index === 1 ? invalidNodes : maliciousNodes),
                joinSession: async (id) => { sessionId = id; status = 'online' },
                goOffline: () => {
                    layer.goOfflineCalls++
                    status = 'offline'
                },
                writeSessionToUrl: (url) => url,
            }
            connections.push(layer)
            return layer
        }
        const adapter = createLayersOnlineAdapter(app, {
            location: new URL('https://layers.test/'),
            history: { replaceState() {} }, dialog: null,
            importSdk: async () => ({ createOnlineDslLayer: createLayer }),
        })
        await adapter.joinSession('session-A', { skipConfirm: true })
        const original = adapter.online
        const joinedBounds = await adapter.joinSession('session-B', { skipConfirm: true })
        const joinedSemantics = await adapter.joinSession('session-C', { skipConfirm: true })
        return {
            joinedBounds,
            joinedSemantics,
            activeIsOriginal: adapter.online === original,
            activeSession: adapter.online.getSessionId(),
            activeStatus: adapter.getStatus(),
            originalDisconnects: connections[0].goOfflineCalls,
            candidateDisconnects: connections.slice(1).map(layer => layer.goOfflineCalls),
        }
    })

    expect(result).toEqual({
        joinedBounds: null,
        joinedSemantics: null,
        activeIsOriginal: true,
        activeSession: 'session-A',
        activeStatus: 'online',
        originalDisconnects: 0,
        candidateDisconnects: [1, 1],
    })
})

test('join reconfirms when a local mutation commits after the original consent', async ({ page }) => {
    await bootSolid(page)

    await page.evaluate(async () => {
        const app = window.layersApp
        const { createLayersOnlineAdapter } = await import('/js/collab/onlineAdapter.js')
        const { buildNodeModel } = await import('/js/collab/docModel.js')
        const { createEffectLayer } = await import('/js/layers/layer-model.js')
        const remote = createEffectLayer('synth/gradient', 'Candidate session')
        remote.id = 'layer-candidate-session'
        const remoteNodes = buildNodeModel([remote], {
            width: app._canvas.width, height: app._canvas.height,
        })
        let status = 'offline'
        let joinCalls = 0
        const online = {
            on() {},
            getStatus: () => status,
            getSessionId: () => 'candidate-session',
            getShareUrl: () => 'https://layers.test/?seance=candidate-session',
            getNodes: () => remoteNodes,
            joinSession: async () => { joinCalls++; status = 'online' },
            goOffline: () => { status = 'offline' },
            writeSessionToUrl: (url) => url,
        }
        const adapter = createLayersOnlineAdapter(app, {
            location: new URL('https://layers.test/'),
            history: { replaceState() {} }, dialog: null,
            importSdk: async () => ({ createOnlineDslLayer: () => online }),
        })
        const blocker = await app._acquireProjectLifecycle()
        const originalName = app._layers[0].name
        const joinPromise = adapter.joinSession('candidate-session')
        window.__joinConsentRace = {
            finishMutation() {
                app._layers[0].name = 'Committed after consent'
                app._markDirty()
                blocker.release()
            },
            async result() {
                const joined = await joinPromise
                return {
                    joined,
                    joinCalls,
                    layerName: app._layers[0].name,
                    originalName,
                    status: adapter.getStatus(),
                }
            },
        }
    })

    const confirmation = page.locator('.confirm-dialog-backdrop.visible')
    const message = confirmation.locator('.confirm-message')
    await expect(message).toHaveText('Joining replaces your current composition. Continue?')
    await confirmation.locator('#confirm-ok').click()
    await page.evaluate(() => window.__joinConsentRace.finishMutation())
    await expect(message).toHaveText('Joining replaces your current composition. Continue?')
    await confirmation.locator('#confirm-cancel').click()

    const result = await page.evaluate(() => window.__joinConsentRace.result())
    expect(result).toEqual({
        joined: null,
        joinCalls: 0,
        layerName: 'Committed after consent',
        originalName: 'Solid',
        status: 'offline',
    })
})

test('candidate render failure preserves the active session despite cleanup failures', async ({ page }) => {
    await bootSolid(page)

    const result = await page.evaluate(async () => {
        const app = window.layersApp
        const { createLayersOnlineAdapter } = await import('/js/collab/onlineAdapter.js')
        const { buildNodeModel } = await import('/js/collab/docModel.js')
        const { createEffectLayer } = await import('/js/layers/layer-model.js')
        const { toast } = await import('/js/ui/toast.js')
        const dims = { width: app._canvas.width, height: app._canvas.height }
        const activeNodes = buildNodeModel(app._layers, dims)
        const candidate = createEffectLayer('synth/gradient', 'Candidate session')
        candidate.id = 'layer-render-failure'
        const candidateNodes = buildNodeModel([candidate], dims)
        const connections = []
        let throwCleanup = false
        const createLayer = () => {
            const index = connections.length
            let status = 'offline'
            let sessionId = null
            const layer = {
                goOfflineCalls: 0,
                on() {},
                getStatus: () => status,
                getSessionId: () => sessionId,
                getShareUrl: () => `https://layers.test/?seance=${sessionId || ''}`,
                getNodes: () => index === 0 ? activeNodes : candidateNodes,
                joinSession: async (id) => { sessionId = id; status = 'online' },
                goOffline: () => {
                    layer.goOfflineCalls++
                    status = 'offline'
                    if (throwCleanup) throw new Error('candidate cleanup failed')
                },
                writeSessionToUrl: (url) => url,
            }
            connections.push(layer)
            return layer
        }
        const dialog = {
            addEventListener() {}, hide() {},
            set state(value) {
                this._state = value
                if (throwCleanup) throw new Error('status refresh failed')
            },
            get state() { return this._state },
            set sessionId(value) { this._sessionId = value },
            set sessionUrl(value) { this._sessionUrl = value },
        }
        const adapter = createLayersOnlineAdapter(app, {
            location: new URL('https://layers.test/'),
            history: { replaceState() {} }, dialog,
            importSdk: async () => ({ createOnlineDslLayer: createLayer }),
        })
        await adapter.joinSession('session-A', { skipConfirm: true })
        const original = adapter.online
        const originalLayerIds = app._layers.map(layer => layer.id)
        const stageLayerSet = app._renderer.stageLayerSet.bind(app._renderer)
        app._renderer.stageLayerSet = async (renderCandidate) => {
            const stage = await stageLayerSet(renderCandidate)
            if (renderCandidate.layers.some(layer => layer.id === 'layer-render-failure')) {
                stage.success = false
                stage.error = 'injected candidate render failure'
            }
            return stage
        }
        throwCleanup = true
        const originalToastError = toast.error
        toast.error = () => { throw new Error('join toast failed') }
        let escapedError = null
        let joined = null
        try {
            joined = await adapter.joinSession('session-B', { skipConfirm: true })
        } catch (err) {
            escapedError = err.message
        }
        toast.error = originalToastError
        app._renderer.stageLayerSet = stageLayerSet
        return {
            joined,
            escapedError,
            activeIsOriginal: adapter.online === original,
            activeSession: adapter.online.getSessionId(),
            activeStatus: adapter.getStatus(),
            originalDisconnects: connections[0].goOfflineCalls,
            candidateDisconnects: connections[1].goOfflineCalls,
            layerIds: app._layers.map(layer => layer.id),
            originalLayerIds,
        }
    })

    expect(result).toEqual({
        joined: null,
        escapedError: null,
        activeIsOriginal: true,
        activeSession: 'session-A',
        activeStatus: 'online',
        originalDisconnects: 0,
        candidateDisconnects: 1,
        layerIds: result.originalLayerIds,
        originalLayerIds: result.originalLayerIds,
    })
})

test('take-online rechecks the media gate after acquiring the lifecycle lease', async ({ page }) => {
    await bootSolid(page)

    const result = await page.evaluate(async () => {
        const app = window.layersApp
        const { createLayersOnlineAdapter } = await import('/js/collab/onlineAdapter.js')
        const { createMediaLayer } = await import('/js/layers/layer-model.js')
        const { infoDialog } = await import('/js/ui/info-dialog.js')
        let status = 'offline'
        let takeCalls = 0
        let refusalCalls = 0
        const online = {
            on() {},
            getStatus: () => status,
            getSessionId: () => 'media-session',
            getShareUrl: () => 'https://layers.test/?seance=media-session',
            takeOnline: async () => { takeCalls++; status = 'online' },
            goOffline: () => { status = 'offline' },
            writeSessionToUrl: (url) => url,
        }
        const adapter = createLayersOnlineAdapter(app, {
            location: new URL('https://layers.test/'),
            history: { replaceState() {} }, dialog: null,
            importSdk: async () => ({ createOnlineDslLayer: () => online }),
        })
        const originalShow = infoDialog.show
        infoDialog.show = async () => { refusalCalls++ }
        const blocker = await app._acquireProjectLifecycle()
        const takePromise = adapter.takeOnline()
        await new Promise(resolve => setTimeout(resolve, 0))
        app._layers.push(createMediaLayer(null, 'image', 'Queued media'))
        app._markDirty()
        blocker.release()
        let escapedError = null
        let sessionId = null
        try {
            sessionId = await takePromise
        } catch (err) {
            escapedError = err.message
        }
        infoDialog.show = originalShow
        return {
            sessionId,
            escapedError,
            takeCalls,
            refusalCalls,
            status: adapter.getStatus(),
        }
    })

    expect(result).toEqual({
        sessionId: null,
        escapedError: null,
        takeCalls: 0,
        refusalCalls: 1,
        status: 'offline',
    })
})

test('a rejected node deletion is retried on the next publish', async ({ page }) => {
    await bootSolid(page)

    const result = await page.evaluate(async (untilSrc) => {
        const until = eval(untilSrc)
        const app = window.layersApp
        const { createLayersOnlineAdapter } = await import('/js/collab/onlineAdapter.js')
        const { buildNodeModel } = await import('/js/collab/docModel.js')
        const dims = { width: app._canvas.width, height: app._canvas.height }
        const initialNodes = buildNodeModel(app._layers, dims)
        const deletedId = initialNodes.find(node => node.kind === 'layers-layer').id
        const handlers = new Map()
        const deletes = []
        let status = 'offline'
        const online = {
            on: (event, handler) => handlers.set(event, handler),
            getStatus: () => status,
            getSessionId: () => 'delete-retry',
            getShareUrl: () => 'https://layers.test/?seance=delete-retry',
            getNodes: () => initialNodes,
            joinSession: async () => { status = 'online' },
            upsertNode() {},
            deleteNode: (id) => deletes.push(id),
            goOffline: () => { status = 'offline' },
            writeSessionToUrl: (url) => url,
        }
        const adapter = createLayersOnlineAdapter(app, {
            location: new URL('https://layers.test/'),
            history: { replaceState() {} }, dialog: null,
            importSdk: async () => ({ createOnlineDslLayer: () => online }),
        })
        await adapter.joinSession('delete-retry', { skipConfirm: true })
        app._layers.splice(0, 1)
        adapter.schedulePublish()
        await until(() => deletes.length > 0, 'the deletion published')
        handlers.get('node-reject')?.({ id: deletedId })
        adapter.schedulePublish()
        await until(() => deletes.length > 1, 'the rejected deletion was retried')
        return { deletedId, deletes }
    }, IN_PAGE_UNTIL)

    expect(result.deletes).toEqual([result.deletedId, result.deletedId])
})

for (const operation of ['take-online', 'join']) {
    test(`go-offline invalidates a late ${operation} completion`, async ({ page }) => {
        await bootSolid(page)

        const result = await page.evaluate(async ({ operation, untilSrc }) => {
            const until = eval(untilSrc)
            const app = window.layersApp
            const { createLayersOnlineAdapter } = await import('/js/collab/onlineAdapter.js')
            const { buildNodeModel } = await import('/js/collab/docModel.js')
            const nodes = buildNodeModel(app._layers, {
                width: app._canvas.width, height: app._canvas.height,
            })
            let status = 'offline'
            let started = false
            let release
            let disconnects = 0
            const online = {
                on() {},
                getStatus: () => status,
                getSessionId: () => 'late-session',
                getShareUrl: () => 'https://layers.test/?seance=late-session',
                getNodes: () => nodes,
                takeOnline: async () => {
                    status = 'connecting'
                    started = true
                    await new Promise(resolve => { release = resolve })
                    status = 'online'
                },
                joinSession: async () => {
                    status = 'connecting'
                    started = true
                    await new Promise(resolve => { release = resolve })
                    status = 'online'
                },
                upsertNode() {}, deleteNode() {},
                goOffline: () => { disconnects++; status = 'offline' },
                writeSessionToUrl: (url) => url,
            }
            const adapter = createLayersOnlineAdapter(app, {
                location: new URL('https://layers.test/'),
                history: { replaceState() {} }, dialog: null,
                importSdk: async () => ({ createOnlineDslLayer: () => online }),
            })
            const transition = operation === 'take-online'
                ? adapter.takeOnline()
                : adapter.joinSession('late-session', { skipConfirm: true })
            await until(() => started, `${operation} reached the SDK layer`)
            adapter.goOffline()
            release()
            const sessionId = await transition
            return {
                sessionId,
                status: adapter.getStatus(),
                isOnline: adapter.isOnline(),
                disconnects,
                layerIds: app._layers.map(layer => layer.id),
            }
        }, { operation, untilSrc: IN_PAGE_UNTIL })

        expect(result.sessionId).toBeNull()
        expect(result.status).toBe('offline')
        expect(result.isOnline).toBe(false)
        expect(result.disconnects).toBe(2)
        expect(result.layerIds).toEqual([expect.stringMatching(/^layer-0-[a-f0-9]{32}$/)])
    })
}
