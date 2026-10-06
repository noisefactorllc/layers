// Layer masks travel through the Seance session image store as PNG images,
// never as text in the node document. The layer node refers to the image by
// its id (SHA-256 of the PNG bytes). Masks that a build from before the image
// store sent as base64 chunk nodes are still read, but never written. See
// collab/docModel.js rememberMaskWire and onlineAdapter.js
// hydrateSessionMasks.
import assert from 'node:assert/strict'
import test from 'node:test'

import {
    applyNodesToComposition,
    assertRemoteNodeModelWithinBounds,
    buildNodeModel,
    fnv1a,
    maskWireOf,
    rememberMaskWire
} from '../public/js/collab/docModel.js'

// A stand-in for a decoded mask. buildNodeModel only reads its dimensions and
// looks it up in the wire cache, which is keyed by object identity.
const maskLike = (width = 4, height = 4) => ({ width, height })
const imageId = (digit) => digit.repeat(64)

const layerWithMask = (mask) => ({
    id: 'a', name: 'Masked', sourceType: 'effect', effectId: 'filter/blur',
    visible: true, opacity: 100, blendMode: 'mix', children: [], mask
})

const canvas = { width: 64, height: 64 }
const nodeFor = (nodes, id) => nodes.find(n => n.id === id)
const layerJson = (nodes) => JSON.parse(nodeFor(nodes, 'La').text)

test('a remembered mask is published as an image reference, with no text', () => {
    const mask = maskLike()
    rememberMaskWire(mask, { imageId: imageId('a'), width: 4, height: 4 })

    const nodes = buildNodeModel([layerWithMask(mask)], canvas)

    const layer = layerJson(nodes)
    assert.deepEqual(layer.maskImage, { id: imageId('a'), width: 4, height: 4 })
    assert.equal(layer.maskMeta, null)
    assert.equal(nodes.filter(n => n.kind === 'layers-mask').length, 0)
    assert.ok(!JSON.stringify(nodes).includes('data:image'))
    assert.doesNotThrow(() => assertRemoteNodeModelWithinBounds(nodes))
})

test('an unrelated edit to a masked layer keeps its image reference', () => {
    const mask = maskLike()
    rememberMaskWire(mask, { imageId: imageId('b'), width: 4, height: 4 })
    const before = layerJson(buildNodeModel([layerWithMask(mask)], canvas))

    const edited = layerWithMask(mask)
    edited.opacity = 42
    const after = layerJson(buildNodeModel([edited], canvas))

    assert.equal(after.opacity, 42)
    assert.deepEqual(after.maskImage, before.maskImage)
})

test('a repainted mask has no image yet, so its model cannot be published', () => {
    const mask = maskLike()
    rememberMaskWire(mask, { imageId: imageId('c'), width: 4, height: 4 })
    const repainted = maskLike()

    // Every mask write path assigns a new ImageData rather than mutating one,
    // so the repainted mask misses the cache. Its reference has no id, and
    // bounds validation (which the publish funnel runs) refuses it.
    const nodes = buildNodeModel([layerWithMask(repainted)], canvas)
    assert.deepEqual(layerJson(nodes).maskImage, { id: null, width: 4, height: 4 })
    assert.throws(() => assertRemoteNodeModelWithinBounds(nodes), /mask image reference is invalid/)
    assert.equal(layerJson(buildNodeModel([layerWithMask(mask)], canvas)).maskImage.id, imageId('c'))
})

test('a layer without a mask keeps the text older builds wrote', () => {
    const layer = layerJson(buildNodeModel([layerWithMask(null)], canvas))
    assert.equal(layer.maskMeta, null)
    assert.ok(!('maskImage' in layer))
})

test('rememberMaskWire ignores a missing mask, text, and invalid references', () => {
    assert.doesNotThrow(() => rememberMaskWire(null, { imageId: imageId('d'), width: 1, height: 1 }))
    const mask = maskLike()
    rememberMaskWire(mask, 'data:image/png;base64,X')
    rememberMaskWire(mask, { imageId: 'not-an-id', width: 4, height: 4 })
    rememberMaskWire(mask, { imageId: imageId('d'), width: 0, height: 4 })
    rememberMaskWire(mask, undefined)
    assert.equal(maskWireOf(mask), null)
})

test('applying an image reference returns it for fetching, or reuses the decoded mask', () => {
    const mask = maskLike()
    rememberMaskWire(mask, { imageId: imageId('e'), width: 4, height: 4 })
    const nodes = buildNodeModel([layerWithMask(mask)], canvas)

    const fresh = applyNodesToComposition(nodes, []).layers[0]
    assert.equal(fresh.mask, null)
    assert.deepEqual(fresh.maskImage, { id: imageId('e'), width: 4, height: 4 })

    const reused = applyNodesToComposition(nodes, [{ id: 'a', mask }]).layers[0]
    assert.equal(reused.mask, mask)
    assert.ok(!('maskImage' in reused))

    const other = maskLike()
    rememberMaskWire(other, { imageId: imageId('f'), width: 4, height: 4 })
    const replaced = applyNodesToComposition(nodes, [{ id: 'a', mask: other }]).layers[0]
    assert.equal(replaced.mask, null)
    assert.equal(replaced.maskImage.id, imageId('e'))
})

// The form a build from before the image store wrote: base64 PNG slices in
// layers-mask chunk nodes, guarded by an FNV-1a hash of the whole string.
function legacyNodes(dataUrl, { width = 64, height = 64 } = {}) {
    const slices = [dataUrl.slice(0, 58), dataUrl.slice(58)]
    return [
        { id: 'meta', kind: 'layers-meta', parentId: null,
            text: JSON.stringify({ v: 1, canvas: { w: width, h: height }, order: ['La'] }) },
        { id: 'La', kind: 'layers-layer', parentId: null,
            text: JSON.stringify({ v: 1, name: 'Masked', sourceType: 'effect', effectId: 'filter/blur',
                childOrder: [], strokesMeta: null, maskMeta: { n: 2, hash: fnv1a(dataUrl) } }) },
        ...slices.map((data, i) => ({ id: `La.M${i}`, kind: 'layers-mask', parentId: 'La',
            text: JSON.stringify({ v: 1, i, data }) })),
    ]
}

// An 8x8 PNG header, enough for bounds validation to read dimensions.
const pngHeaderDataUrl = (width, height) => {
    const bytes = Buffer.from([
        137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82,
        0, 0, 0, width, 0, 0, 0, height, 8, 6, 0, 0, 0,
    ])
    return `data:image/png;base64,${bytes.toString('base64')}`
}

test('a legacy text mask from an older peer is still read for decoding', () => {
    const dataUrl = pngHeaderDataUrl(8, 8)
    const nodes = legacyNodes(dataUrl)
    assert.doesNotThrow(() => assertRemoteNodeModelWithinBounds(nodes))
    const layer = applyNodesToComposition(nodes, []).layers[0]
    assert.equal(layer.mask, dataUrl)
    assert.ok(!('maskImage' in layer))
})

test('an image reference supersedes legacy chunk metadata on the same layer', () => {
    const nodes = legacyNodes(pngHeaderDataUrl(8, 8))
    const layer = nodes.find(n => n.id === 'La')
    layer.text = JSON.stringify({ ...JSON.parse(layer.text),
        maskImage: { id: imageId('9'), width: 8, height: 8 } })
    const applied = applyNodesToComposition(nodes, []).layers[0]
    assert.equal(applied.mask, null)
    assert.equal(applied.maskImage.id, imageId('9'))
})

test('remote bounds validate mask image references and count their pixels', () => {
    const nodesWith = (maskImage, { width = 64, height = 64 } = {}) => [
        { id: 'meta', kind: 'layers-meta', parentId: null,
            text: JSON.stringify({ v: 1, canvas: { w: width, h: height }, order: ['La'] }) },
        { id: 'La', kind: 'layers-layer', parentId: null,
            text: JSON.stringify({ v: 1, sourceType: 'effect', childOrder: [], maskMeta: null, maskImage }) },
    ]
    const rejection = (nodes) => {
        try {
            assertRemoteNodeModelWithinBounds(nodes)
            return null
        } catch (err) {
            return err.message
        }
    }
    assert.equal(rejection(nodesWith({ id: imageId('1'), width: 64, height: 64 })), null)
    assert.match(rejection(nodesWith({ id: 'data:image/png;base64,AAAA', width: 4, height: 4 })),
        /mask image reference is invalid/)
    assert.match(rejection(nodesWith({ id: imageId('1'), width: 4.5, height: 4 })),
        /mask image reference is invalid/)
    assert.match(rejection(nodesWith('data:image/png;base64,AAAA')),
        /mask image reference is invalid/)
    assert.match(rejection(nodesWith({ id: imageId('1'), width: 65, height: 4 })),
        /canvas dimensions/)
    assert.match(rejection(nodesWith({ id: imageId('1'), width: 8193, height: 1 },
        { width: 8192, height: 8192 })), /mask dimensions/)
})
