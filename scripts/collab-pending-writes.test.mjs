// online.getNodes() reports only server-acknowledged state, so a write still
// queued behind the SDK's send pacing is absent from it. Applying that set
// verbatim reverts the author's own in-flight edit and drops it from the next
// publish diff. See collab/docModel.js overlayPendingWrites.
import assert from 'node:assert/strict'
import test from 'node:test'

import { overlayPendingWrites } from '../public/js/collab/docModel.js'

const node = (id, text, parentId = null, kind = 'layers-layer', version = 1) =>
    ({ id, kind, text, parentId, version })

// A write sent against the version the node already carried: still in flight.
const inFlight = (write) => ({ baseVersion: 1, ...write })

const byId = (nodes) => new Map(nodes.map(n => [n.id, n]))

test('an empty pending map returns the server set untouched', () => {
    const nodes = [node('meta', '{}'), node('L1', 'a')]
    const result = overlayPendingWrites(nodes, new Map())

    assert.equal(result.nodes, nodes)
    assert.deepEqual(result.confirmed, [])
})

test('a queued edit wins over the server copy of the same node', () => {
    const pending = new Map([['L1', inFlight({ op: 'upsert', kind: 'layers-layer', text: 'mine', parentId: null })]])

    const { nodes, confirmed } = overlayPendingWrites([node('L1', 'theirs')], pending)

    assert.equal(byId(nodes).get('L1').text, 'mine')
    assert.deepEqual(confirmed, [])
})

test('an unrelated remote change is preserved while a local write is in flight', () => {
    const pending = new Map([['L1', inFlight({ op: 'upsert', kind: 'layers-layer', text: 'mine', parentId: null })]])

    const { nodes } = overlayPendingWrites([node('L1', 'theirs'), node('L2', 'peer edit')], pending)

    assert.equal(byId(nodes).get('L2').text, 'peer edit')
    assert.equal(nodes.length, 2)
})

test('a queued node the server has not seen yet is added', () => {
    const pending = new Map([
        ['L9', { op: 'upsert', kind: 'layers-layer', text: 'new layer', parentId: null, baseVersion: null }],
        ['L9.C1', { op: 'upsert', kind: 'layers-child', text: 'child', parentId: 'L9', baseVersion: null }]
    ])

    const { nodes } = overlayPendingWrites([node('meta', '{}')], pending)

    assert.equal(byId(nodes).get('L9').text, 'new layer')
    assert.equal(byId(nodes).get('L9.C1').parentId, 'L9')
})

test('a write the server already carries verbatim is reported confirmed', () => {
    const pending = new Map([
        ['L1', inFlight({ op: 'upsert', kind: 'layers-layer', text: 'same', parentId: null })],
        ['L2', inFlight({ op: 'upsert', kind: 'layers-layer', text: 'not yet', parentId: null })]
    ])

    const { nodes, confirmed } = overlayPendingWrites(
        [node('L1', 'same'), node('L2', 'old')], pending)

    assert.deepEqual(confirmed, ['L1'])
    assert.equal(byId(nodes).get('L2').text, 'not yet')
})

test('a differing parent or kind is not treated as confirmed', () => {
    const reparented = new Map([['L1.C1', inFlight({ op: 'upsert', kind: 'layers-child', text: 't', parentId: 'L2' })]])
    const rekinded = new Map([['L1', inFlight({ op: 'upsert', kind: 'layers-strokes', text: 't', parentId: null })]])

    assert.deepEqual(overlayPendingWrites([node('L1.C1', 't', 'L1', 'layers-child')], reparented).confirmed, [])
    assert.deepEqual(overlayPendingWrites([node('L1', 't')], rekinded).confirmed, [])
})

test('a pending delete hides the node and its dotted descendants', () => {
    const pending = new Map([['L1', inFlight({ op: 'delete' })]])
    const nodes = [
        node('meta', '{}'),
        node('L1', 'doomed'),
        node('L1.C1', 'child', 'L1', 'layers-child'),
        node('L1.S0', 'strokes', 'L1', 'layers-strokes'),
        node('L10', 'unrelated')
    ]

    const result = overlayPendingWrites(nodes, pending)

    assert.deepEqual(result.nodes.map(n => n.id), ['meta', 'L10'])
    assert.deepEqual(result.confirmed, [])
})

test('a delete the server has already applied is reported confirmed', () => {
    const pending = new Map([['L1', inFlight({ op: 'delete' })]])

    const { nodes, confirmed } = overlayPendingWrites([node('meta', '{}')], pending)

    assert.deepEqual(confirmed, ['L1'])
    assert.deepEqual(nodes.map(n => n.id), ['meta'])
})

test('the server version rides along so a later publish resolves base_rev', () => {
    const pending = new Map([['L1', inFlight({ op: 'upsert', kind: 'layers-layer', text: 'mine', parentId: null })]])

    const { nodes } = overlayPendingWrites([node('L1', 'theirs')], pending)

    assert.equal(byId(nodes).get('L1').version, 1)
})

test('writes are applied in send order, so a later write wins', () => {
    const pending = new Map([['L1', inFlight({ op: 'delete' })]])
    pending.set('L1', inFlight({ op: 'upsert', kind: 'layers-layer', text: 'recreated', parentId: null }))

    const { nodes } = overlayPendingWrites([node('L1', 'theirs')], pending)

    assert.equal(byId(nodes).get('L1').text, 'recreated')
})

test('a published write stops being asserted once a peer changes that node', () => {
    // The regression this guards: a client never applies its own writes, so
    // nothing retired the entry, and the next genuine remote change to the
    // node was overwritten by a value that had already been published.
    const pending = new Map([['L1', inFlight({ op: 'upsert', kind: 'layers-layer', text: 'mine', parentId: null })]])

    const { nodes, confirmed } = overlayPendingWrites(
        [node('L1', 'peer changed it after mine landed', null, 'layers-layer', 7)], pending)

    assert.deepEqual(confirmed, ['L1'])
    assert.equal(byId(nodes).get('L1').text, 'peer changed it after mine landed')
})

test('a delete stops being asserted once the node is written again', () => {
    const pending = new Map([['L1', inFlight({ op: 'delete' })]])

    const { nodes, confirmed } = overlayPendingWrites(
        [node('L1', 'recreated by a peer', null, 'layers-layer', 9)], pending)

    assert.deepEqual(confirmed, ['L1'])
    assert.deepEqual(nodes.map(n => n.id), ['L1'])
})

test('a write is still asserted while its node sits at the version it was sent against', () => {
    const pending = new Map([['L1', inFlight({ op: 'upsert', kind: 'layers-layer', text: 'mine', parentId: null })]])

    const { nodes, confirmed } = overlayPendingWrites(
        [node('L1', 'stale server copy', null, 'layers-layer', 1)], pending)

    assert.deepEqual(confirmed, [])
    assert.equal(byId(nodes).get('L1').text, 'mine')
})

test('a create whose id a peer already claimed yields to the peer', () => {
    const pending = new Map([['L1', { op: 'upsert', kind: 'layers-layer', text: 'mine', parentId: null, baseVersion: null }]])

    const { nodes, confirmed } = overlayPendingWrites(
        [node('L1', 'peer got there first', null, 'layers-layer', 3)], pending)

    assert.deepEqual(confirmed, ['L1'])
    assert.equal(byId(nodes).get('L1').text, 'peer got there first')
})

test('an authoritative SDK pending write survives a peer advancing its node version', () => {
    const pending = new Map([['L1', { op: 'upsert', kind: 'layers-layer', text: 'mine', parentId: null }]])
    const { nodes, confirmed } = overlayPendingWrites(
        [node('L1', 'peer wrote first', null, 'layers-layer', 7)], pending,
        { authoritative: true })
    assert.equal(byId(nodes).get('L1').text, 'mine')
    assert.deepEqual(confirmed, [])
})

test('an authoritative FIFO queue preserves a parent deletion after child creation', () => {
    const pending = [
        { id: 'L1', op: 'upsert', kind: 'layers-layer', text: 'parent', parentId: null },
        { id: 'L1.C1', op: 'upsert', kind: 'layers-child', text: 'child', parentId: 'L1' },
        { id: 'L1', op: 'delete' },
    ]
    const result = overlayPendingWrites([node('meta', '{}')], pending, { authoritative: true })
    assert.deepEqual(result.nodes.map(node => node.id), ['meta'])
})

test('delete then recreate in the authoritative queue does not restore old children', () => {
    const pending = [
        { id: 'L1', op: 'delete' },
        { id: 'L1', op: 'upsert', kind: 'layers-layer', text: 'new parent', parentId: null },
    ]
    const result = overlayPendingWrites([
        node('L1', 'old parent'), node('L1.C1', 'old child', 'L1', 'layers-child'),
    ], pending, { authoritative: true })
    assert.deepEqual(result.nodes.map(node => [node.id, node.text]), [['L1', 'new parent']])
})

test('an authoritative pending delete removes descendants even when its root is absent', () => {
    const pending = new Map([['L1', { id: 'L1', op: 'delete' }]])
    const result = overlayPendingWrites([
        node('L1.C1', 'child', 'L1', 'layers-child'), node('L10', 'unrelated'),
    ], pending, { authoritative: true })
    assert.deepEqual(result.nodes.map(node => node.id), ['L10'])
})
