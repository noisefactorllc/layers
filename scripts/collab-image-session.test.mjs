import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { createLayersOnlineAdapter } from '../public/js/collab/onlineAdapter.js'
import { buildNodeModel } from '../public/js/collab/docModel.js'
import { createMediaLayer, createEffectLayer } from '../public/js/layers/layer-model.js'
import { toast } from '../public/js/ui/toast.js'
import { infoDialog } from '../public/js/ui/info-dialog.js'

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==', 'base64')
const file = suffix => new File([png, suffix || ''], 'original.png', { type: 'image/png' })
const hash = async blob => createHash('sha256').update(Buffer.from(await blob.arrayBuffer())).digest('hex')
async function waitFor(predicate) {
    const deadline = Date.now() + 2500
    while (!predicate()) {
        if (Date.now() > deadline) throw new Error('image collaboration did not settle')
        await delay(10)
    }
}

function setup(layers = [createEffectLayer('synth/gradient', 'Base')]) {
    let status = 'offline'
    let nodes = []
    let uploadGate = null
    let downloadGate = null
    let uploadError = null
    let creationErrors = []
    const handlers = new Map(), assets = new Map(), writes = [], uploads = [], disposed = []
    const creationSeeds = []
    const app = {
        _layers: layers, _canvas: { width: 128, height: 128 }, _replacementGeneration: 0,
        _renderer: {
            manifest: { 'synth/gradient': { starter: true } },
            getAllEffects: () => [{ effectId: 'synth/gradient' }], getLayerEffects: () => [],
            getEffectDefinition: async () => ({ globals: {} }), isRunning: true,
            getMediaInfo: () => null,
            prepareMediaResource: async source => ({ type: 'image', sourceFile: source, width: 1, height: 1 }),
            stageLayerSet: async candidate => ({ success: true,
                commit: () => { app._renderer._mediaTextures = candidate.mediaTextures; return { success: true } },
                rollback: async () => ({ success: true }) }),
            disposeMediaResources: resources => { disposed.push(...resources.values()); resources.clear() },
        },
        _acquireProjectLifecycle: async () => ({ release() {} }),
        _finalizePendingUndo() {}, _beginPublishTransaction: () => ({}), _endPublishTransaction() {},
        _captureProjectCommitState: () => ({ layers: app._layers, selectedLayerIds: [], selectionAnchor: null }),
        _restoreProjectCommitState: state => { app._layers = state.layers },
        _validSelectionForLayers: () => ({ selectedLayerIds: [], selectionAnchor: null }),
        _updateLayerStack() {}, _markDirty() {}, _pushUndoState() {},
    }
    async function prepareImage(blob) {
        if (blob.type !== 'image/png') throw new Error('Unsupported image type')
        const bytes = Buffer.from(await blob.arrayBuffer())
        return { id: await hash(blob), dataUrl: `data:image/png;base64,${bytes.toString('base64')}`,
            width: 1, height: 1, mimeType: 'image/png' }
    }
    const sdk = {
        on: (event, handler) => handlers.set(event, handler), getStatus: () => status,
        getSessionId: () => 'image1', getShareUrl: () => '', writeSessionToUrl: url => url,
        getNodes: () => nodes, getPendingNodeWrites: () => [],
        takeOnline: async seed => {
            creationSeeds.push(seed)
            if (creationErrors.length) throw creationErrors.shift()
            for (const asset of seed.images || []) assets.set(asset.id, new Blob([
                Buffer.from(asset.dataUrl.split(',')[1], 'base64')], { type: asset.mimeType }))
            nodes = seed.poly.nodes.map(node => ({ ...node, version: 1 })); status = 'online'
        },
        joinSession: async () => { status = 'online' },
        uploadImage: async blob => {
            uploads.push(blob)
            if (uploadGate) await uploadGate
            if (uploadError) throw uploadError
            const id = await hash(blob); assets.set(id, blob); return id
        },
        getImage: async id => {
            if (downloadGate) await downloadGate
            if (!assets.has(id)) throw new Error('Image unavailable')
            return assets.get(id)
        },
        upsertNode: (id, node) => {
            writes.push({ id, ...node })
            const existing = nodes.find(candidate => candidate.id === id)
            nodes = nodes.filter(candidate => candidate.id !== id)
            nodes.push({ id, ...node, version: (existing?.version || 0) + 1 })
        },
        deleteNode: id => { writes.push({ id, op: 'delete' }); nodes = nodes.filter(node => node.id !== id) },
        goOffline: () => { status = 'offline' },
    }
    const adapter = createLayersOnlineAdapter(app, {
        location: new URL('https://layers.test/'), history: { replaceState() {} }, dialog: null,
        importSdk: async () => ({ createOnlineDslLayer: () => sdk, prepareImage }),
    })
    app._onlineAdapter = adapter
    return { app, adapter, sdk, assets, writes, uploads, disposed, creationSeeds,
        peer(next) { nodes = next; handlers.get('remote-node')?.({}) },
        holdUpload() { uploadGate = new Promise(resolve => { this.releaseUpload = resolve }) },
        holdDownload() { downloadGate = new Promise(resolve => { this.releaseDownload = resolve }) },
        failUpload(error) { uploadError = error },
        failCreation(...errors) { creationErrors.push(...errors) },
    }
}

async function run(task) {
    const oldShow = infoDialog.show
    infoDialog.show = async () => {}
    try { await toast.suppress(task) } finally { infoDialog.show = oldShow }
}

test('taking an image online seeds original bytes outside the node doc', () => run(async () => {
    const original = file()
    const h = setup([createMediaLayer(original, 'image')])
    try {
        assert.equal(await h.adapter.takeOnline(), 'image1')
        assert.equal(h.creationSeeds.length, 1)
        assert.equal(h.creationSeeds[0].images, undefined)
        const layer = JSON.parse(h.sdk.getNodes().find(node => node.kind === 'layers-layer').text)
        assert.equal(layer.imageId, await hash(original))
        assert.equal(layer.imageWidth, 1)
        assert.deepEqual(new Uint8Array(await h.assets.get(layer.imageId).arrayBuffer()), new Uint8Array(await original.arrayBuffer()))
        assert.equal(h.app._layers[0].mediaFile, original)
        assert.ok(JSON.stringify(h.sdk.getNodes()).length < 1500)
    } finally { h.adapter.goOffline() }
}))

test('a seed upload failure takes the session offline without leaving assets', () => run(async () => {
    const original = file()
    const h = setup([createMediaLayer(original, 'image')])
    try {
        h.failUpload(new Error('seed upload failed'))
        await assert.rejects(h.adapter.takeOnline(), /seed upload failed/)
        assert.equal(h.sdk.getStatus(), 'offline')
        assert.equal(h.assets.size, 0)
        assert.equal(h.uploads.length, 1)
    } finally { h.adapter.goOffline() }
}))

test('joining an image session hydrates original files for rendering and offline save', () => run(async () => {
    const original = file(), id = await hash(original)
    const h = setup()
    h.assets.set(id, original)
    h.peer(buildNodeModel([{ ...createMediaLayer(null, 'image', 'Remote'),
        imageId: id, imageWidth: 1, imageHeight: 1 }], { width: 128, height: 128 }))
    try {
        assert.equal(await h.adapter.joinSession('image1', { skipConfirm: true }), 'image1')
        assert.equal(await hash(h.app._layers[0].mediaFile), id)
        assert.equal(h.app._renderer._mediaTextures.get(h.app._layers[0].id).sourceFile, h.app._layers[0].mediaFile)
    } finally { h.adapter.goOffline() }
}))

test('replacing image bytes uploads a new reference even when old metadata was copied', () => run(async () => {
    const original = file(), replacement = file('new source')
    const h = setup([createMediaLayer(original, 'image')])
    try {
        await h.adapter.takeOnline()
        h.app._layers[0] = { ...h.app._layers[0], mediaFile: replacement }
        h.adapter.schedulePublish()
        await waitFor(() => h.writes.length > 0)
        const changed = JSON.parse(h.writes.find(node => node.kind === 'layers-layer').text)
        assert.equal(changed.imageId, await hash(replacement))
        assert.equal(h.assets.get(changed.imageId), replacement)
        h.app._layers[0].opacity = 52
        h.adapter.schedulePublish()
        await waitFor(() => h.writes.length > 1)
        // One upload took the image online, the replacement is the second.
        assert.equal(h.uploads.length, 2)
    } finally { h.adapter.goOffline() }
}))

test('held image upload blocks peer overwrite and cannot publish after going offline', () => run(async () => {
    const h = setup()
    try {
        await h.adapter.takeOnline()
        const originalNodes = h.sdk.getNodes()
        h.holdUpload()
        const image = createMediaLayer(file(), 'image')
        h.app._layers.push(image)
        h.adapter.schedulePublish()
        await waitFor(() => h.uploads.length === 1)
        h.peer(originalNodes)
        await delay(300)
        assert.equal(h.app._layers.at(-1), image)
        assert.equal(h.writes.length, 0)
        h.adapter.goOffline()
        h.releaseUpload()
        await delay(200)
        assert.equal(h.writes.length, 0)
    } finally { h.adapter.goOffline(); h.releaseUpload?.() }
}))

test('failed image uploads preserve a local draft until a later successful retry', () => run(async () => {
    const h = setup()
    try {
        await h.adapter.takeOnline()
        const originalNodes = h.sdk.getNodes()
        const image = createMediaLayer(file(), 'image')
        h.app._layers.push(image)
        h.failUpload(new Error('upload failed'))
        h.adapter.schedulePublish()
        await waitFor(() => h.uploads.length === 1)
        h.peer(originalNodes)
        await delay(350)
        assert.equal(h.app._layers.at(-1), image)
        assert.equal(h.writes.length, 0)
        h.failUpload(null)
        h.adapter.schedulePublish()
        await waitFor(() => h.writes.some(node => node.id === `L${image.id}`))
        assert.equal(JSON.parse(h.writes.find(node => node.id === `L${image.id}`).text).imageId, await hash(image.mediaFile))
    } finally { h.adapter.goOffline() }
}))

test('a cancelled image download cannot replace the live project', () => run(async () => {
    const h = setup(), originalLayers = h.app._layers
    const original = file(), id = await hash(original)
    h.assets.set(id, original)
    h.peer(buildNodeModel([{ ...createMediaLayer(null, 'image', 'Remote'),
        imageId: id, imageWidth: 1, imageHeight: 1 }], { width: 128, height: 128 }))
    h.holdDownload()
    try {
        const pending = h.adapter.joinSession('image1', { skipConfirm: true })
        await waitFor(() => h.adapter.isApplyingRemote())
        h.adapter.goOffline()
        h.releaseDownload()
        assert.equal(await pending, null)
        assert.equal(h.app._layers, originalLayers)
        assert.equal(h.adapter.isOnline(), false)
    } finally { h.adapter.goOffline(); h.releaseDownload?.() }
}))

test('video sharing is rejected before session creation', () => run(async () => {
    const h = setup([createMediaLayer(new File(['video'], 'movie.mp4', { type: 'video/mp4' }), 'video')])
    try {
        assert.equal(await h.adapter.takeOnline(), null)
        assert.equal(h.adapter.isOnline(), false)
        assert.equal(h.assets.size, 0)
    } finally { h.adapter.goOffline() }
}))

test('image cache from a prior session cannot supply an unavailable image in a new session', () => run(async () => {
    const original = file(), id = await hash(original)
    const h = setup([createMediaLayer(original, 'image')])
    try {
        await h.adapter.takeOnline()
        h.adapter.goOffline()
        const before = h.app._layers
        h.assets.clear()
        h.sdk.getSessionId = () => 'other-session'
        h.peer(buildNodeModel([{ ...createMediaLayer(null, 'image', 'Unavailable'),
            imageId: id, imageWidth: 1, imageHeight: 1 }], { width: 128, height: 128 }))
        assert.equal(await h.adapter.joinSession('other-session', { skipConfirm: true }), null)
        assert.equal(h.app._layers, before)
    } finally { h.adapter.goOffline() }
}))

test('replacing an image during a held upload never publishes the stale source', () => run(async () => {
    const h = setup([createMediaLayer(file(), 'image')])
    try {
        await h.adapter.takeOnline()
        h.holdUpload()
        h.app._layers[0].mediaFile = file('first edit')
        h.adapter.schedulePublish()
        await waitFor(() => h.uploads.length === 1)
        const latest = file('second edit')
        h.app._layers[0].mediaFile = latest
        h.adapter.schedulePublish()
        h.releaseUpload()
        await waitFor(() => h.writes.length > 0)
        const references = h.writes.filter(node => node.kind === 'layers-layer')
            .map(node => JSON.parse(node.text).imageId)
        assert.deepEqual(references, [await hash(latest)])
    } finally { h.adapter.goOffline(); h.releaseUpload?.() }
}))

test('a downloaded image whose bytes disagree with its reference preserves the live project', () => run(async () => {
    const h = setup(), before = h.app._layers, id = await hash(file())
    h.assets.set(id, file('corrupt response'))
    h.peer(buildNodeModel([{ ...createMediaLayer(null, 'image', 'Wrong bytes'),
        imageId: id, imageWidth: 1, imageHeight: 1 }], { width: 128, height: 128 }))
    try {
        assert.equal(await h.adapter.joinSession('image1', { skipConfirm: true }), null)
        assert.equal(h.app._layers, before)
    } finally { h.adapter.goOffline() }
}))

for (const [name, source] of [
    ['missing image source', null],
    ['unsupported image source', new File(['<svg/>'], 'vector.svg', { type: 'image/svg+xml' })],
]) {
    test(`${name} is rejected before session creation`, () => run(async () => {
        const h = setup([createMediaLayer(source, 'image', 'Invalid source')])
        try {
            await assert.rejects(h.adapter.takeOnline(), /Image source is missing|Unsupported image type/)
            assert.equal(h.adapter.isOnline(), false)
            assert.equal(h.assets.size, 0)
            assert.equal(h.app._layers[0].mediaFile, source)
        } finally { h.adapter.goOffline() }
    }))
}

test('image seed limits count unique originals and reject excessive attachment bytes', () => run(async () => {
    const tooMany = setup(Array.from({ length: 33 }, (_, i) => createMediaLayer(file(String(i)), 'image')))
    const tooLarge = setup(Array.from({ length: 5 }, (_, i) => createMediaLayer(
        new File([png, new Uint8Array(7 * 1024 * 1024), String(i)], 'large.png', { type: 'image/png' }), 'image')))
    const sharedFile = file()
    const repeated = setup(Array.from({ length: 33 }, () => createMediaLayer(sharedFile, 'image')))
    try {
        await assert.rejects(tooMany.adapter.takeOnline(), /32 image or 32 MiB/)
        await assert.rejects(tooLarge.adapter.takeOnline(), /32 image or 32 MiB/)
        assert.equal(tooMany.assets.size, 0)
        assert.equal(tooLarge.assets.size, 0)
        assert.equal(await repeated.adapter.takeOnline(), 'image1')
        assert.equal(repeated.assets.size, 1)
    } finally {
        tooMany.adapter.goOffline(); tooLarge.adapter.goOffline(); repeated.adapter.goOffline()
    }
}))

test('forged image dimensions reject before decoding or replacing the live project', () => run(async () => {
    const h = setup(), before = h.app._layers, original = file(), id = await hash(original)
    let decoded = false
    h.app._renderer.prepareMediaResource = async () => { decoded = true; return null }
    h.assets.set(id, original)
    h.peer(buildNodeModel([{ ...createMediaLayer(null, 'image', 'Wrong dimensions'),
        imageId: id, imageWidth: 2, imageHeight: 1 }], { width: 128, height: 128 }))
    try {
        assert.equal(await h.adapter.joinSession('image1', { skipConfirm: true }), null)
        assert.equal(h.app._layers, before)
        assert.equal(decoded, false)
    } finally { h.adapter.goOffline() }
}))

test('a cancelled image decode disposes its candidate resource without replacing the project', () => run(async () => {
    const h = setup(), before = h.app._layers, original = file(), id = await hash(original)
    let releaseDecode, decoding = false
    const resource = { type: 'image', sourceFile: original, width: 1, height: 1 }
    h.app._renderer.prepareMediaResource = () => new Promise(resolve => {
        decoding = true; releaseDecode = () => resolve(resource)
    })
    h.assets.set(id, original)
    h.peer(buildNodeModel([{ ...createMediaLayer(null, 'image', 'Late decode'),
        imageId: id, imageWidth: 1, imageHeight: 1 }], { width: 128, height: 128 }))
    try {
        const pending = h.adapter.joinSession('image1', { skipConfirm: true })
        await waitFor(() => decoding)
        h.adapter.goOffline()
        releaseDecode()
        assert.equal(await pending, null)
        assert.equal(h.app._layers, before)
        assert.ok(h.disposed.includes(resource))
    } finally { h.adapter.goOffline(); releaseDecode?.() }
}))

test('retrying a canvas image after an upload failure captures its current pixels', () => run(async () => {
    const h = setup()
    let pixels = file('before')
    const canvas = { toBlob(callback) { callback(pixels) } }
    h.app._renderer.getMediaInfo = () => ({ element: canvas })
    try {
        await h.adapter.takeOnline()
        const image = createMediaLayer(null, 'image', 'Canvas image')
        h.app._layers.push(image)
        h.failUpload(new Error('upload failed'))
        h.adapter.schedulePublish()
        await waitFor(() => h.uploads.length === 1)
        pixels = file('after')
        h.failUpload(null)
        h.adapter.schedulePublish()
        await waitFor(() => h.writes.some(node => node.id === `L${image.id}`))
        assert.equal(JSON.parse(h.writes.find(node => node.id === `L${image.id}`).text).imageId, await hash(pixels))
    } finally { h.adapter.goOffline() }
}))

test('restoring an image the server freed uploads its bytes again before referring to it', () => run(async () => {
    const original = file(), replacement = file('new source')
    const originalId = await hash(original)
    const h = setup([createMediaLayer(original, 'image')])
    try {
        await h.adapter.takeOnline()
        const restorable = h.app._layers[0]
        h.app._layers[0] = { ...restorable, mediaFile: replacement }
        h.adapter.schedulePublish()
        await waitFor(() => h.writes.length > 0)
        // One seed upload took the image online; the replacement is the second.
        assert.equal(h.uploads.length, 2)

        // Nothing refers to the original any more, so a full budget frees it.
        h.assets.delete(originalId)
        h.app._layers[0] = restorable
        h.adapter.schedulePublish()
        await waitFor(() => h.writes.some(node =>
            node.kind === 'layers-layer' && JSON.parse(node.text).imageId === originalId))
        assert.equal(h.uploads.length, 3)
        assert.equal(await hash(h.uploads[2]), originalId)
        assert.ok(h.assets.has(originalId))

        // An edit that keeps the reference the session already holds sends no bytes.
        const writes = h.writes.length
        h.app._layers[0].opacity = 40
        h.adapter.schedulePublish()
        await waitFor(() => h.writes.length > writes)
        assert.equal(h.uploads.length, 3)
    } finally { h.adapter.goOffline() }
}))

// WebKit intermittently sends the session-creation multipart POST with empty
// part bodies (nothing in this client produces an empty part; the identical
// request succeeds on a later attempt), so the server answers 400 and the SDK
// surfaces "failed to create seance session (400)". Take online creates the
// session without image bytes and uploads them after, so the creation POST is
// plain JSON, but the adapter still retries that one class of creation failure
// once.
test('a rejected session creation is retried once and goes online', () => run(async () => {
    const h = setup([createMediaLayer(file(), 'image')])
    try {
        h.failCreation(new Error('failed to create seance session (400)'))
        assert.equal(await h.adapter.takeOnline(), 'image1')
        assert.equal(h.adapter.isOnline(), true)
        assert.ok(h.assets.size > 0)
    } finally { h.adapter.goOffline() }
}))

test('a creation failure that survives its one retry still surfaces', () => run(async () => {
    const h = setup([createMediaLayer(file(), 'image')])
    try {
        h.failCreation(new Error('failed to create seance session (400)'),
            new Error('failed to create seance session (400)'))
        await assert.rejects(h.adapter.takeOnline(), /failed to create seance session \(400\)/)
        assert.equal(h.adapter.isOnline(), false)
        // A later attempt with the same fault succeeds on its own retry.
        h.failCreation(new Error('failed to create seance session (400)'))
        assert.equal(await h.adapter.takeOnline(), 'image1')
    } finally { h.adapter.goOffline() }
}))

test('a non-creation take-online failure is rethrown without a retry', () => run(async () => {
    const h = setup([createMediaLayer(file(), 'image')])
    try {
        h.failCreation(new Error('session write access denied'))
        await assert.rejects(h.adapter.takeOnline(), /session write access denied/)
        assert.equal(h.adapter.isOnline(), false)
        assert.equal(h.sdk.getStatus(), 'offline')
    } finally { h.adapter.goOffline() }
}))
