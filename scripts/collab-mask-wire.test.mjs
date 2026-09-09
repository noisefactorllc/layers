// PNG bytes are encoder-specific, so re-encoding a mask that arrived from a
// peer re-stamps maskMeta.hash with bytes this browser never sent. The hash
// then describes something other than the chunk nodes the server holds and
// every later joiner drops the mask. See collab/docModel.js rememberMaskWire.
import assert from 'node:assert/strict'
import test from 'node:test'

import {
    buildNodeModel,
    chunkBase64,
    fnv1a,
    rememberMaskWire
} from '../public/js/collab/docModel.js'

// A stand-in for a decoded mask. buildNodeModel only ever passes it to the
// wire cache, which is keyed by object identity, so no canvas is needed as
// long as the wire form was remembered first. Re-encoding would reach for
// document.createElement and throw here, which is exactly the regression.
const maskLike = () => ({ width: 4, height: 4 })

const layerWithMask = (mask) => ({
    id: 'a', name: 'Masked', sourceType: 'effect', effectId: 'filter/blur',
    visible: true, opacity: 100, blendMode: 'mix', children: [], mask
})

const canvas = { width: 64, height: 64 }
const nodeFor = (nodes, id) => nodes.find(n => n.id === id)

test('a remembered mask republishes the exact bytes it arrived as', () => {
    const wire = 'data:image/png;base64,PEER-ENCODER-BYTES'
    const mask = maskLike()
    rememberMaskWire(mask, wire)

    const nodes = buildNodeModel([layerWithMask(mask)], canvas)

    const chunks = nodes.filter(n => n.kind === 'layers-mask')
    assert.deepEqual(chunks.map(n => JSON.parse(n.text).data), chunkBase64(wire))
})

test('maskMeta.hash describes the chunks that are actually published', () => {
    const wire = 'data:image/png;base64,PEER-ENCODER-BYTES'
    const mask = maskLike()
    rememberMaskWire(mask, wire)

    const nodes = buildNodeModel([layerWithMask(mask)], canvas)

    const { maskMeta } = JSON.parse(nodeFor(nodes, 'La').text)
    const published = nodes
        .filter(n => n.kind === 'layers-mask')
        .sort((x, y) => JSON.parse(x.text).i - JSON.parse(y.text).i)
        .map(n => JSON.parse(n.text).data)
        .join('')
    assert.equal(maskMeta.hash, fnv1a(published))
    assert.equal(maskMeta.n, published.length ? chunkBase64(wire).length : 0)
})

test('an unrelated edit to a masked layer does not re-stamp the hash', () => {
    const wire = 'data:image/png;base64,PEER-ENCODER-BYTES'
    const mask = maskLike()
    rememberMaskWire(mask, wire)
    const before = JSON.parse(nodeFor(buildNodeModel([layerWithMask(mask)], canvas), 'La').text)

    const edited = layerWithMask(mask)
    edited.opacity = 42
    const after = JSON.parse(nodeFor(buildNodeModel([edited], canvas), 'La').text)

    assert.equal(after.opacity, 42)
    assert.deepEqual(after.maskMeta, before.maskMeta)
})

test('a repainted mask is a different object, so it is encoded afresh', () => {
    const mask = maskLike()
    rememberMaskWire(mask, 'data:image/png;base64,FIRST')
    const repainted = maskLike()

    // Every mask write path assigns a new ImageData rather than mutating one,
    // so the repainted mask misses the cache and would be re-encoded. Without
    // a canvas that surfaces as a throw, which proves the cache did not answer
    // for content it never saw.
    assert.throws(() => buildNodeModel([layerWithMask(repainted)], canvas))
    const nodes = buildNodeModel([layerWithMask(mask)], canvas)
    assert.equal(JSON.parse(nodeFor(nodes, 'La').text).maskMeta.hash,
        fnv1a('data:image/png;base64,FIRST'))
})

test('rememberMaskWire ignores a missing mask or empty payload', () => {
    assert.doesNotThrow(() => rememberMaskWire(null, 'data:image/png;base64,X'))
    assert.doesNotThrow(() => rememberMaskWire(maskLike(), ''))
    assert.doesNotThrow(() => rememberMaskWire(maskLike(), undefined))
})
