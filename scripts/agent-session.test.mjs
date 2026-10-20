import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { COMMAND_GROUPS, LOCAL_ONLY } from '../public/js/agent/descriptions.js'
import {
    REMOTE, SESSION_LAYER_KEYS, SESSION_MEDIA_KEYS, SESSION_STATE_KEYS,
    catalog, checkSessionRequest, jsonSchema, sessionEnvelope, sessionLayer, sessionState
} from '../public/js/agent/session.js'
import { buildSnapshot } from '../public/js/agent/snapshot.js'
import { registerCommand, runCommand } from '../public/js/agent/dispatcher.js'

// Every app that answers agents in a Seance session runs this relay, byte for
// byte. Change it in all of them together, then update this digest.
const RELAY_SHA256 = 'fe245367d3432f8ee4481d6dd820ecb3700d1b765fcbe43bfed90039600c2828'

const described = COMMAND_GROUPS.flatMap(group => Object.keys(group.commands))

test('the agent relay is the shared relay, byte for byte', async () => {
    const source = await readFile(new URL('../public/js/agent/relay.js', import.meta.url))
    assert.equal(createHash('sha256').update(source).digest('hex'), RELAY_SHA256)
})

test('the dispatcher gives the relay its API version and envelopes', async () => {
    const dispatcher = await import('../public/js/agent/dispatcher.js')
    assert.equal(dispatcher.API_VERSION, '1.0')
    assert.equal(typeof dispatcher.makeFailure, 'function')
    assert.equal(typeof dispatcher.makeSuccess, 'function')
    assert.equal(typeof dispatcher.runCommand, 'function')
})

test('a session runs every described command except the local-only ones', () => {
    assert.deepEqual(LOCAL_ONLY.filter(name => !described.includes(name)), [])
    assert.deepEqual(new Set(LOCAL_ONLY).size, LOCAL_ONLY.length)
    assert.deepEqual([...REMOTE].sort(), described.filter(name => !LOCAL_ONLY.includes(name)).sort())
    // Stored projects, preferences, fonts, downloads and their jobs.
    for (const name of ['listProjects', 'openProject', 'saveProject', 'deleteProject', 'getSettings',
        'setForegroundColor', 'installFontBundle', 'exportImage', 'exportVideo', 'getJob',
        'listRecoveryCopies', 'restoreRecoveryCopy', 'discardRecoveryCopy', 'takeOnline', 'joinSession', 'goOffline', 'getRasterRegion']) {
        assert.ok(!REMOTE.has(name), name)
    }
    for (const name of ['getThumbnail', 'addLayer', 'undo', 'paintStroke']) assert.ok(REMOTE.has(name), name)
})

test('the session command list marks remote and read-only commands', () => {
    const list = catalog()
    assert.deepEqual(list.map(item => item.name), described)
    const byName = Object.fromEntries(list.map(item => [item.name, item]))
    assert.equal(byName.exportImage.remote, false)
    assert.equal(byName.getThumbnail.remote, true)
    assert.equal(byName.getThumbnail.readOnly, true)
    assert.equal(byName.getDrawingStrokes.readOnly, true)
    assert.equal(byName.getRasterRegion.remote, false)
    assert.equal(byName.addLayer.readOnly, false)
    assert.equal(byName.addLayer.group, 'Layers')
    assert.deepEqual(byName.getState.args, { type: 'object', properties: {} })
    assert.deepEqual(byName.reorderLayer.args.required, ['layerId', 'toIndex'])
    assert.deepEqual(byName.reorderLayer.args.properties.toIndex, { type: 'integer', minimum: 0 })
})

test('argument schemas become JSON Schema without cached patterns', () => {
    const schema = { type: 'string', pattern: '^#[0-9a-f]{6}$', _patternRe: /x/ }
    assert.deepEqual(jsonSchema({ type: 'object', properties: { color: schema, points: { type: 'array', items: { type: 'number', min: 0, max: 1 } } } }), {
        type: 'object',
        properties: {
            color: { type: 'string', pattern: '^#[0-9a-f]{6}$' },
            points: { type: 'array', items: { type: 'number', minimum: 0, maximum: 1 } },
        },
    })
})

test('a session request cannot reach local commands or bring media as text or by a link', () => {
    const code = (command, args = {}) => checkSessionRequest(command, args)?.error.code ?? null
    assert.equal(code('listProjects'), 'REMOTE_UNAVAILABLE')
    for (const command of ['listRecoveryCopies', 'restoreRecoveryCopy', 'discardRecoveryCopy',
        'takeOnline', 'joinSession', 'goOffline', 'getRasterRegion']) {
        assert.equal(code(command), 'REMOTE_UNAVAILABLE', command)
    }
    assert.equal(code('_ping'), 'NOT_FOUND_COMMAND')
    assert.equal(code('setProgram', { dsl: '' }), 'NOT_FOUND_COMMAND')
    assert.equal(code('getState', []), 'INVALID_ARGS_TYPE')
    assert.equal(code('getState', null), 'INVALID_ARGS_TYPE')
    assert.equal(code('pasteImageFromBytes', { source: { kind: 'base64', data: 'iVBORw0KGgo=' } }), 'IMAGE_AS_TEXT')
    for (const value of ['https://example.invalid/a.png', '//example.invalid/a.png', 'blob:x', '/img/icon-192.svg', 'image:abc']) {
        assert.equal(code('addLayer', { kind: 'media', mediaType: 'image', source: { kind: 'url', value } }), 'OUTSIDE_LINK', value)
    }
    const image = `image:${'a'.repeat(64)}`
    assert.equal(code('pasteImageFromBytes', { source: { kind: 'url', value: image } }), null)
    assert.equal(code('addLayer', { kind: 'effect', effectId: 'synth/gradient' }), null)
    assert.equal(code('getState'), null)
})

test('every snapshot field is either shown to a session or kept in this tab', () => {
    // A field added to the snapshot stays out of sessions until it is listed here.
    const kept = ['foreground', 'jobs', 'recentExports', 'settings', 'collaboration']
    const snapshot = buildSnapshot({
        _layers: [{ id: 'layer-1', name: 'photo', sourceType: 'media', mediaType: 'image', mediaFile: { name: 'IMG_0001.jpg' } }],
    })
    assert.deepEqual(Object.keys(snapshot).sort(), [...SESSION_STATE_KEYS, ...kept].sort())
    assert.deepEqual(Object.keys(snapshot.layers[0]).sort(), [...SESSION_LAYER_KEYS].sort())
    assert.deepEqual(Object.keys(snapshot.layers[0].media).sort(), [...SESSION_MEDIA_KEYS, 'filename'].sort())
    assert.deepEqual(Object.keys(snapshot.project).sort(),
        ['canRedo', 'canSaveAs', 'canUndo', 'id', 'isDirty', 'name'])
    const seen = sessionState({ ...snapshot, addedLater: 'private' })
    assert.deepEqual(Object.keys(seen), SESSION_STATE_KEYS)
    assert.deepEqual(Object.keys(seen.project), ['canUndo', 'canRedo'])
    assert.equal(sessionLayer({ ...snapshot.layers[0], addedLater: 1 }).addedLater, undefined)
})

test('a command whose session ended before its turn does not run', async () => {
    let ran = 0
    const agent = { _app: { _acquireProjectLifecycle: async () => ({ release() {} }) } }
    registerCommand(agent, 'sessionProbe', async () => { ran += 1; return { result: { ran } } })
    const ended = await runCommand('sessionProbe', {}, { session: true, isCurrent: () => false })
    assert.equal(ended.envelope.error.code, 'CONFLICT_SESSION_ENDED')
    assert.equal(ran, 0)
    const current = await runCommand('sessionProbe', {}, { session: true, isCurrent: () => true })
    assert.equal(current.envelope.ok, true)
    assert.equal(ran, 1)
})

test('the in-page method answers with an envelope when an image cannot be encoded', async () => {
    const original = globalThis.FileReader
    globalThis.FileReader = class {
        readAsDataURL() { queueMicrotask(() => { this.error = new Error('too large'); this.onerror() }) }
    }
    try {
        const agent = { _app: { _acquireProjectLifecycle: async () => ({ release() {} }) } }
        registerCommand(agent, 'imageProbe', async () => ({ result: { width: 1 }, image: new Blob(['x']) }))
        const envelope = await agent.imageProbe()
        assert.equal(envelope.ok, false)
        assert.equal(envelope.error.code, 'INTERNAL_ERROR')
        assert.equal(envelope.error.message, 'too large')
    } finally {
        globalThis.FileReader = original
    }
})

test('the session state leaves out what the person keeps in this browser', () => {
    const state = {
        apiVersion: '1.0',
        project: { id: 'p1', name: 'Holiday', isDirty: true, canUndo: true, canRedo: false, canSaveAs: true },
        canvas: { width: 8, height: 8 },
        foreground: { color: '#123456' },
        layers: [{ id: 'layer-1', name: 'photo', media: { type: 'image', filename: 'IMG_0001.jpg', width: 8, height: 8 } }],
        jobs: [{ id: 'job-1' }],
        recentExports: [{ filename: 'layers.png' }],
        settings: { theme: 'dark' },
    }
    const history = { canUndoBack: false }
    const app = { _onlineAdapter: { reachesBeforeSession: step => step < 0 && !history.canUndoBack } }
    const seen = sessionState(state, app)
    assert.deepEqual(Object.keys(seen), ['apiVersion', 'project', 'canvas', 'layers'])
    assert.deepEqual(seen.project, { canUndo: false, canRedo: false })
    assert.deepEqual(seen.layers[0].media, { type: 'image', width: 8, height: 8 })
    history.canUndoBack = true
    assert.deepEqual(sessionState(state, app).project, { canUndo: true, canRedo: false })
    assert.equal(state.layers[0].media.filename, 'IMG_0001.jpg', 'the snapshot itself is unchanged')
    assert.deepEqual(sessionLayer({ id: 'x', media: null }), { id: 'x', media: null })

    const envelope = sessionEnvelope('getState', { ok: true, command: 'getState', result: state, state }, app)
    assert.equal(envelope.result.settings, undefined)
    assert.equal(envelope.state.project.id, undefined)
    const layer = sessionEnvelope('getLayer', { ok: true, command: 'getLayer', result: state.layers[0], state }, app)
    assert.equal(layer.result.media.filename, undefined)
})
