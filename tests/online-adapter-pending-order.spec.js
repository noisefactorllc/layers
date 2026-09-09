import { test, expect } from './fixtures.js'

test('an SDK-pending parent delete and recreate does not resurrect its old child', async ({ page }) => {
    await page.goto('/', { waitUntil: 'networkidle' })
    await page.locator('#loading-screen').waitFor({ state: 'hidden' })
    const backdrop = page.locator('.open-dialog-backdrop.visible')
    await backdrop.waitFor()
    await page.locator('.media-option[data-type="solid"]').click()
    await page.locator('.canvas-size-dialog .action-btn.primary').click()
    await backdrop.waitFor({ state: 'hidden' })

    const result = await page.evaluate(async () => {
        const app = window.layersApp
        const { createLayersOnlineAdapter } = await import('/js/collab/onlineAdapter.js')
        const { buildNodeModel } = await import('/js/collab/docModel.js')
        const { createChildEffect } = await import('/js/layers/layer-model.js')
        app._layers[0].children.push(createChildEffect('filter/blur'))
        const canvas = { width: app._canvas.width, height: app._canvas.height }
        const nodes = buildNodeModel(app._layers, canvas).map(node => ({ ...node, version: 1 }))
        const handlers = new Map()
        let pending = []
        let reads = 0
        let status = 'offline'
        const layer = {
            on: (event, handler) => handlers.set(event, handler),
            getStatus: () => status, getSessionId: () => 'order1',
            getShareUrl: () => 'https://layers.test/?seance=order1',
            getNodes: () => nodes,
            getPendingNodeWrites: () => { reads++; return pending },
            joinSession: async () => { status = 'online' },
            goOffline: () => { status = 'offline' },
            upsertNode() {}, deleteNode() {}, writeSessionToUrl: url => url,
        }
        const adapter = createLayersOnlineAdapter(app, {
            location: new URL('https://layers.test/'), history: { replaceState() {} }, dialog: null,
            importSdk: async () => ({ createOnlineDslLayer: () => layer }),
        })
        await adapter.joinSession('order1', { skipConfirm: true })
        app._layers[0].children = []
        await app._rebuild({ force: true })
        const id = `L${app._layers[0].id}`
        const recreated = buildNodeModel(app._layers, canvas).find(node => node.id === id)
        pending = [{ id, op: 'delete' }, { ...recreated, op: 'upsert' }]
        const before = reads
        handlers.get('remote-node')?.({})
        const deadline = performance.now() + 10000
        while (reads <= before || adapter.isApplyingRemote()) {
            if (performance.now() > deadline) throw new Error('pending replay did not settle')
            await new Promise(resolve => setTimeout(resolve, 10))
        }
        const childCount = app._layers[0].children.length
        adapter.goOffline()
        return { childCount }
    })
    expect(result.childCount).toBe(0)
})

for (const change of ['acknowledgement', 'local edit', 'read-only moderation']) {
test(`a ${change} during semantic loading never restores the pre-edit model or history`, async ({ page }) => {
    await page.goto('/', { waitUntil: 'networkidle' })
    await page.locator('#loading-screen').waitFor({ state: 'hidden' })
    const backdrop = page.locator('.open-dialog-backdrop.visible')
    await backdrop.waitFor()
    await page.locator('.media-option[data-type="solid"]').click()
    await page.locator('.canvas-size-dialog .action-btn.primary').click()
    await backdrop.waitFor({ state: 'hidden' })

    const result = await page.evaluate(async change => {
        const app = window.layersApp
        const { createLayersOnlineAdapter } = await import('/js/collab/onlineAdapter.js')
        const { buildNodeModel } = await import('/js/collab/docModel.js')
        const canvas = { width: app._canvas.width, height: app._canvas.height }
        let nodes = buildNodeModel(app._layers, canvas).map(node => ({ ...node, version: 1 }))
        let revision = 1
        let pending = []
        let reads = 0
        let status = 'offline'
        const handlers = new Map()
        const layer = {
            on: (event, handler) => handlers.set(event, handler),
            getStatus: () => status, getSessionId: () => 'await1',
            getShareUrl: () => 'https://layers.test/?seance=await1',
            getNodes: () => nodes, getNodeRev: () => revision,
            getPendingNodeWrites: () => { reads++; return pending },
            joinSession: async () => { status = 'online' },
            goOffline: () => { status = 'offline' },
            upsertNode() {}, deleteNode() {}, writeSessionToUrl: url => url,
        }
        const adapter = createLayersOnlineAdapter(app, {
            location: new URL('https://layers.test/'), history: { replaceState() {} }, dialog: null,
            importSdk: async () => ({ createOnlineDslLayer: () => layer }),
        })
        await adapter.joinSession('await1', { skipConfirm: true })
        app._layers[0].opacity = 42
        await app._rebuild({ force: true })
        const id = `L${app._layers[0].id}`
        const desired = buildNodeModel(app._layers, canvas).find(node => node.id === id)
        pending = [{ ...desired, op: 'upsert' }]
        const getDefinition = app._renderer.getEffectDefinition.bind(app._renderer)
        let release
        let hold = true
        app._renderer.getEffectDefinition = async (...args) => {
            if (hold) {
                hold = false
                await new Promise(resolve => { release = resolve })
            }
            return getDefinition(...args)
        }
        const committed = []
        const pushUndo = app._pushUndoState.bind(app)
        app._pushUndoState = (...args) => {
            committed.push(app._layers[0].opacity)
            return pushUndo(...args)
        }
        const wait = async predicate => {
            const deadline = performance.now() + 10000
            while (!predicate()) {
                if (performance.now() > deadline) throw new Error('acknowledgement race did not settle')
                await new Promise(resolve => setTimeout(resolve, 10))
            }
        }
        const before = reads
        handlers.get('remote-node')?.({})
        await wait(() => Boolean(release))
        if (change === 'acknowledgement') {
            nodes = nodes.map(node => node.id === id ? { ...desired, version: 2 } : node)
            revision = 2
            pending = []
            handlers.get('node-ack')?.({ id, op: 'upsert' })
        } else if (change === 'read-only moderation') {
            pending = []
            status = 'readonly'
            handlers.get('node-reject')?.({ id, reason: 'readonly' })
            handlers.get('status')?.('readonly')
        } else {
            // A progressive gesture can update the live model and enqueue
            // its newer intent while the semantic loader awaits.
            app._layers[0].opacity = 67
            const latest = buildNodeModel(app._layers, canvas).find(node => node.id === id)
            pending = [{ ...latest, op: 'upsert' }]
        }
        release()
        await wait(() => reads >= before + 2 && !adapter.isApplyingRemote())
        const opacity = app._layers[0].opacity
        adapter.goOffline()
        return { opacity, committed }
    }, change)
    expect(result).toEqual({ opacity: change === 'local edit' ? 67 : 42, committed: [] })
})
}

test('joining a room that changes during initial apply catches up without rejecting the join', async ({ page }) => {
    await page.goto('/', { waitUntil: 'networkidle' })
    await page.locator('#loading-screen').waitFor({ state: 'hidden' })
    const backdrop = page.locator('.open-dialog-backdrop.visible')
    await backdrop.waitFor()
    await page.locator('.media-option[data-type="solid"]').click()
    await page.locator('.canvas-size-dialog .action-btn.primary').click()
    await backdrop.waitFor({ state: 'hidden' })

    const result = await page.evaluate(async () => {
        const app = window.layersApp
        const { createLayersOnlineAdapter } = await import('/js/collab/onlineAdapter.js')
        const { buildNodeModel } = await import('/js/collab/docModel.js')
        const canvas = { width: app._canvas.width, height: app._canvas.height }
        const id = `L${app._layers[0].id}`
        let nodes = buildNodeModel(app._layers, canvas).map(node => ({ ...node, version: 1 }))
        const changeOpacity = opacity => {
            nodes = nodes.map(node => node.id === id
                ? { ...node, text: JSON.stringify({ ...JSON.parse(node.text), opacity }) } : node)
        }
        changeOpacity(60)
        let revision = 1
        let status = 'offline'
        const handlers = new Map()
        const layer = {
            on: (event, handler) => handlers.set(event, handler),
            getStatus: () => status, getSessionId: () => 'busy12',
            getShareUrl: () => 'https://layers.test/?seance=busy12',
            getNodes: () => nodes, getNodeRev: () => revision, getPendingNodeWrites: () => [],
            joinSession: async () => { status = 'online' },
            goOffline: () => { status = 'offline' },
            upsertNode() {}, deleteNode() {}, writeSessionToUrl: url => url,
        }
        const adapter = createLayersOnlineAdapter(app, {
            location: new URL('https://layers.test/'), history: { replaceState() {} }, dialog: null,
            importSdk: async () => ({ createOnlineDslLayer: () => layer }),
        })
        const getDefinition = app._renderer.getEffectDefinition.bind(app._renderer)
        let calls = 0
        let release
        app._renderer.getEffectDefinition = async (...args) => {
            // Join preflight validates first; the second validation is inside
            // the initial lifecycle-owned remote apply.
            if (++calls === 2) await new Promise(resolve => { release = resolve })
            return getDefinition(...args)
        }
        const joining = adapter.joinSession('busy12', { skipConfirm: true })
        const wait = async predicate => {
            const deadline = performance.now() + 10000
            while (!predicate()) {
                if (performance.now() > deadline) throw new Error('busy room join did not settle')
                await new Promise(resolve => setTimeout(resolve, 10))
            }
        }
        await wait(() => Boolean(release))
        changeOpacity(75)
        revision++
        handlers.get('remote-node')?.({ id, op: 'upsert' })
        // Let the event's apply timer observe the still-held initial apply.
        await new Promise(resolve => setTimeout(resolve, 180))
        release()
        const sessionId = await joining
        await wait(() => app._layers[0].opacity === 75 && !adapter.isApplyingRemote())
        const result = { sessionId, status: adapter.getStatus(), opacity: app._layers[0].opacity }
        adapter.goOffline()
        return result
    })
    expect(result).toEqual({ sessionId: 'busy12', status: 'online', opacity: 75 })
})
