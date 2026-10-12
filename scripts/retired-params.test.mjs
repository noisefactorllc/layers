import { test } from 'node:test'
import assert from 'node:assert/strict'
import { RETIRED_PARAMS, migrateRetiredParams } from '../public/js/noisemaker/retired-params.js'
import { buildNodeModel, applyNodesToComposition, assertRemoteNodeSemantics } from '../public/js/collab/docModel.js'

test('renames a retired text matte name to its canonical name', () => {
    assert.deepEqual(
        migrateRetiredParams('filter/text', { text: 'hi', bgOpacity: 0.25, bgColor: '#ff0000' }),
        { text: 'hi', matteOpacity: 0.25, matteColor: '#ff0000' })
})

test('the canonical value wins when both names are present', () => {
    assert.deepEqual(
        migrateRetiredParams('filter/text', { bgOpacity: 0.25, matteOpacity: 0.5 }),
        { matteOpacity: 0.5 })
    assert.deepEqual(
        migrateRetiredParams('filter/text', { bgOpacity: 0.25, bgAlpha: 0.75 }),
        { matteOpacity: 0.25 })
})

test('renames follow the effect path, not the function name', () => {
    // xScale was an alias only in synth/noise; classicNoisedeck/noise declares it.
    assert.deepEqual(migrateRetiredParams('synth/noise', { xScale: 2, noiseType: 3 }), { scaleX: 2, type: 3 })
    assert.deepEqual(migrateRetiredParams('classicNoisedeck/noise', { xScale: 2, noiseType: 3 }), { xScale: 2, type: 3 })
})

test('returns the same object when nothing is retired', () => {
    const params = { mix: 10 }
    assert.equal(migrateRetiredParams('mixer/blendMode', params), params)
    assert.equal(migrateRetiredParams('filter/blur', params), params)
    assert.equal(migrateRetiredParams(null, params), params)
})

test('every retired name maps to a different canonical name', () => {
    for (const [path, names] of Object.entries(RETIRED_PARAMS)) {
        for (const [old, canonical] of Object.entries(names)) {
            assert.notEqual(old, canonical, `${path}.${old}`)
        }
    }
})

test('an online document with retired names loads them under canonical names', () => {
    const nodes = buildNodeModel([{
        id: 'words', name: 'Words', sourceType: 'effect', effectId: 'filter/text',
        effectParams: { text: 'hi', bgOpacity: 0.25 }, visible: true,
        children: [{ id: 'grain', name: 'Grain', effectId: 'filter/palette',
            effectParams: { paletteIndex: 3 }, visible: true }],
    }], { width: 128, height: 128 })
    const layer = applyNodesToComposition(nodes).layers[0]
    assert.deepEqual(layer.effectParams, { text: 'hi', matteOpacity: 0.25 })
    assert.deepEqual(layer.children[0].effectParams, { index: 3 })
})

test('remote validation accepts a retired name and still rejects an undeclared one', async () => {
    const textDefinition = { globals: {
        text: { type: 'string', default: '' },
        matteOpacity: { type: 'float', default: 0, min: 0, max: 1 },
    } }
    const options = {
        manifest: { 'filter/text': {} },
        getEffectDefinition: async () => textDefinition,
    }
    const layerWith = effectParams => buildNodeModel([{
        id: 'words', name: 'Words', sourceType: 'effect', effectId: 'filter/text',
        effectParams, visible: true, children: [],
    }], { width: 128, height: 128 })

    await assertRemoteNodeSemantics(layerWith({ text: 'hi', bgOpacity: 0.25 }), options)
    await assert.rejects(
        assertRemoteNodeSemantics(layerWith({ text: 'hi', bogus: 1 }), options),
        /parameter bogus is not declared/)
})
