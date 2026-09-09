import assert from 'node:assert/strict'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { createLayersOnlineAdapter } from '../public/js/collab/onlineAdapter.js'
import { createEffectLayer } from '../public/js/layers/layer-model.js'
import { toast } from '../public/js/ui/toast.js'

async function waitFor(predicate) {
    const deadline = Date.now() + 2000
    while (!predicate()) {
        if (Date.now() > deadline) throw new Error('adapter did not settle')
        await delay(10)
    }
}

function setup() {
    let status = 'offline'
    let nodes = []
    let reads = 0
    const handlers = new Map()
    const writes = []
    const stages = []
    const local = createEffectLayer('synth/gradient', 'Base')
    local.effectParams = {}
    const app = {
        _layers: [local], _canvas: { width: 128, height: 128 }, _replacementGeneration: 0,
        _renderer: {
            manifest: { 'synth/gradient': { starter: true } },
            getAllEffects: () => [{ effectId: 'synth/gradient' }], getLayerEffects: () => [],
            getEffectDefinition: async () => ({ globals: {} }), isRunning: true,
            stageLayerSet: async candidate => {
                stages.push(candidate.layers.map(layer => layer.opacity))
                return { success: true, commit: () => ({ success: true }), rollback: async () => ({ success: true }) }
            },
            disposeMediaResources() {},
        },
        _acquireProjectLifecycle: async () => ({ release() {} }),
        _finalizePendingUndo() {}, _beginPublishTransaction: () => ({}), _endPublishTransaction() {},
        _captureProjectCommitState: () => ({ layers: app._layers, selectedLayerIds: [], selectionAnchor: null }),
        _restoreProjectCommitState: state => { app._layers = state.layers },
        _validSelectionForLayers: () => ({ selectedLayerIds: [], selectionAnchor: null }),
        _updateLayerStack() {}, _markDirty() {}, _pushUndoState() {},
    }
    const sdk = {
        on: (event, handler) => handlers.set(event, handler), getStatus: () => status,
        getSessionId: () => 'local1', getShareUrl: () => '', writeSessionToUrl: url => url,
        getNodes: () => { reads++; return nodes }, getPendingNodeWrites: () => [],
        takeOnline: async seed => { nodes = seed.poly.nodes.map(node => ({ ...node, version: 1 })); status = 'online' },
        upsertNode: (id, node) => writes.push({ id, ...node }), deleteNode: id => writes.push({ id, op: 'delete' }),
        goOffline: () => { status = 'offline' },
    }
    const adapter = createLayersOnlineAdapter(app, {
        location: new URL('https://layers.test/'), history: { replaceState() {} }, dialog: null,
        importSdk: async () => ({ createOnlineDslLayer: () => sdk }),
    })
    return {
        app, adapter, writes, stages, handlers,
        setStatus(value) { status = value; handlers.get('status')?.(value) },
        async peerOpacity(value) {
            const id = `L${app._layers[0].id}`
            nodes = nodes.map(node => node.id === id
                ? { ...node, text: JSON.stringify({ ...JSON.parse(node.text), opacity: value }), version: node.version + 1 } : node)
            const before = reads
            handlers.get('remote-node')?.({ id })
            await delay(250)
            // A held draft can defer before reading SDK state at all.
            if (reads > before) await waitFor(() => !adapter.isApplyingRemote())
        },
    }
}

test('peer updates cannot overwrite a local read-only draft', async () => {
    await toast.suppress(async () => {
        const h = setup()
        try {
            await h.adapter.takeOnline()
            h.setStatus('readonly')
            h.app._layers[0].opacity = 42
            h.adapter.schedulePublish()
            await delay(200)
            await h.peerOpacity(75)
            assert.equal(h.app._layers[0].opacity, 42)
            assert.deepEqual(h.stages, [])
            assert.deepEqual(h.writes, [])
        } finally { h.adapter.goOffline() }
    })
})

test('a write dropped by read-only moderation is retried unchanged after write access returns', async () => {
    await toast.suppress(async () => {
        const h = setup()
        try {
            await h.adapter.takeOnline()
            h.app._layers[0].opacity = 42
            h.adapter.schedulePublish()
            await waitFor(() => h.writes.length === 1)
            h.setStatus('readonly')
            h.handlers.get('node-reject')?.({ id: h.writes[0].id, reason: 'readonly' })
            h.setStatus('online')
            await delay(400)
            assert.equal(h.writes.length, 2)
            assert.equal(JSON.parse(h.writes[1].text).opacity, 42)
        } finally { h.adapter.goOffline() }
    })
})
