import assert from 'node:assert/strict'
import test from 'node:test'
import { buildNodeModel, applyNodesToComposition, assertRemoteNodeModelWithinBounds } from '../public/js/collab/docModel.js'

const imageId = 'a'.repeat(64)
function imageLayer(overrides = {}) {
    return { id: 'photo', name: 'Photo', sourceType: 'media', mediaType: 'image',
        visible: true, scaleX: 1, scaleY: 1, imageId, imageWidth: 6000, imageHeight: 4000,
        children: [], ...overrides }
}
const nodesFor = layer => buildNodeModel([layer], { width: 6000, height: 4000 })

test('image source references and native dimensions survive a node round trip without bytes', () => {
    const nodes = nodesFor(imageLayer())
    const decoded = applyNodesToComposition(nodes).layers[0]
    assert.equal(decoded.imageId, imageId)
    assert.equal(decoded.imageWidth, 6000)
    assert.equal(decoded.imageHeight, 4000)
    assert.equal(decoded.mediaType, 'image')
    assert.equal(decoded.remoteMediaPlaceholder, undefined)
    assert.ok(JSON.stringify(nodes).length < 1500)
})

test('image nodes require an image-capable reader while ordinary nodes retain version one', () => {
    const nodes = buildNodeModel([imageLayer(), { id: 'effect', sourceType: 'effect',
        effectId: 'synth/gradient', effectParams: {}, children: [] }], { width: 128, height: 128 })
    assert.equal(JSON.parse(nodes.find(node => node.id === 'Lphoto').text).v, 2)
    assert.equal(JSON.parse(nodes.find(node => node.id === 'Leffect').text).v, 1)
    assert.equal(JSON.parse(nodes.find(node => node.id === 'meta').text).v, 1)
    assert.doesNotThrow(() => assertRemoteNodeModelWithinBounds(nodes))
    const effect = nodes.find(node => node.id === 'Leffect')
    effect.text = JSON.stringify({ ...JSON.parse(effect.text), v: 2 })
    assert.throws(() => assertRemoteNodeModelWithinBounds(nodes), /layer node/)
})

test('remote image allocation includes native dimensions and transformed copies', () => {
    assert.doesNotThrow(() => assertRemoteNodeModelWithinBounds(nodesFor(imageLayer())))
    assert.throws(() => assertRemoteNodeModelWithinBounds(nodesFor(imageLayer({
        imageWidth: 8000, imageHeight: 8000, scaleX: 0.5, scaleY: 0.5,
    }))), /raster pixels/)
    assert.throws(() => assertRemoteNodeModelWithinBounds(nodesFor(imageLayer({
        imageWidth: 5000, imageHeight: 4000, scaleX: 2,
    }))), /transformed raster/)
})

test('remote images reject missing or malformed references and video before decoding', () => {
    for (const overrides of [
        { imageId: null }, { imageId: 'https://arbitrary.test/image.png' },
        { imageId: 'A'.repeat(64) }, { imageWidth: 0 }, { imageHeight: 16385 },
        { imageWidth: 1.5 }, { imageWidth: 16384, imageHeight: 16384 },
        { mediaType: 'video' },
    ]) {
        assert.throws(() => assertRemoteNodeModelWithinBounds(nodesFor(imageLayer(overrides))),
            /image|video|raster/, JSON.stringify(overrides))
    }
})
