import assert from 'node:assert/strict'
import test from 'node:test'
import { generateDuplicateLayerName, cloneLayer, createDrawingLayer } from '../public/js/layers/layer-model.js'

test('generateDuplicateLayerName creates "Layer copy" from "Layer"', () => {
    const name = generateDuplicateLayerName('Background', ['Background'])
    assert.equal(name, 'Background copy')
})

test('generateDuplicateLayerName creates "Layer copy 2" when "Layer copy" exists', () => {
    const name = generateDuplicateLayerName('Background', ['Background', 'Background copy'])
    assert.equal(name, 'Background copy 2')
})

test('generateDuplicateLayerName increments "Layer copy" to "Layer copy 2"', () => {
    const name = generateDuplicateLayerName('Background copy', ['Background', 'Background copy'])
    assert.equal(name, 'Background copy 2')
})

test('generateDuplicateLayerName increments "Layer copy 2" to "Layer copy 3"', () => {
    const name = generateDuplicateLayerName('Background copy 2', ['Background', 'Background copy', 'Background copy 2'])
    assert.equal(name, 'Background copy 3')
})

test('generateDuplicateLayerName fills numbering gaps when duplicating base layer', () => {
    const name = generateDuplicateLayerName('Layer 1', ['Layer 1', 'Layer 1 copy 2'])
    assert.equal(name, 'Layer 1 copy')
})

test('generateDuplicateLayerName fills numbering gaps when duplicating copy', () => {
    const name = generateDuplicateLayerName('Layer 1 copy', ['Layer 1', 'Layer 1 copy', 'Layer 1 copy 3'])
    assert.equal(name, 'Layer 1 copy 2')
})

test('generateDuplicateLayerName treats words containing "copy" as normal base names', () => {
    const name = generateDuplicateLayerName('photocopy', ['photocopy'])
    assert.equal(name, 'photocopy copy')
})

test('generateDuplicateLayerName handles empty or missing name', () => {
    assert.equal(generateDuplicateLayerName('', []), 'Layer copy')
    assert.equal(generateDuplicateLayerName('   ', []), 'Layer copy')
    assert.equal(generateDuplicateLayerName(undefined, []), 'Layer copy')
})

test('cloneLayer accepts custom name', () => {
    const layer = createDrawingLayer('Brush 1')
    const clone = cloneLayer(layer, 'Brush 1 copy 5')
    assert.equal(clone.name, 'Brush 1 copy 5')
})
