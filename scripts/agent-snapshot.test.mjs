import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildSnapshot } from '../public/js/agent/snapshot.js'

function mask(values, alpha = false) {
    const data = new Uint8ClampedArray(values.length * 4)
    values.forEach((value, i) => {
        data[i * 4] = alpha ? 0 : value
        data[i * 4 + 3] = alpha ? value : 255
    })
    return { width: 2, height: 2, data }
}

test('snapshot identifies editable strokes, child masks, and raster selection extent', () => {
    const app = {
        _canvas: { width: 2, height: 2 },
        _layers: [{
            id: 'drawing', sourceType: 'drawing', strokes: [{ id: 'stroke-1' }],
            children: [{ id: 'child', effectId: 'filter/blur', mask: mask([0, 255, 0, 0]) }],
            mask: mask([0, 255, 0, 0]),
        }],
        _selectionManager: {
            hasSelection: () => true,
            _selectionPath: { type: 'mask', data: mask([0, 255, 0, 0], true) },
        },
    }
    const snapshot = buildSnapshot(app)
    assert.deepEqual(snapshot.layers[0].drawing.strokeIds, ['stroke-1'])
    assert.deepEqual(snapshot.layers[0].children[0].mask.bounds,
        { x: 1, y: 0, width: 1, height: 1 })
    assert.deepEqual(snapshot.selection.bounds,
        { x: 1, y: 0, width: 1, height: 1 })
})

test('mask summaries are reused while each snapshot remains independent', () => {
    const pixels = mask([0, 255, 0, 0])
    let reads = 0
    Object.defineProperty(pixels, 'data', {
        get() { reads++; return this._data },
        set(value) { this._data = value },
    })
    pixels._data = mask([0, 255, 0, 0]).data
    const app = { _layers: [{ id: 'one', sourceType: 'media', mask: pixels }] }
    const first = buildSnapshot(app)
    first.layers[0].mask.bounds.x = 99
    const second = buildSnapshot(app)
    assert.equal(reads, 1)
    assert.equal(second.layers[0].mask.bounds.x, 1)
})

test('drawing snapshot bounds stroke ids and points to paginated reads', () => {
    const strokes = Array.from({ length: 35 }, (_, index) => ({ id: `stroke-${index}` }))
    const snapshot = buildSnapshot({ _layers: [{ id: 'drawing', sourceType: 'drawing', strokes }] })
    assert.equal(snapshot.layers[0].drawing.strokeCount, 35)
    assert.equal(snapshot.layers[0].drawing.strokeIds.length, 20)
    assert.equal(snapshot.layers[0].drawing.strokeIdsTruncated, true)
    assert.equal(snapshot.layers[0].drawing.strokeIds[19], 'stroke-19')
})
