import assert from 'node:assert/strict'
import test from 'node:test'

test('independent peers allocate distinct layer, child, clone, and stroke IDs', async () => {
    // Independent module instances model the per-page factories used by two
    // peers before either receives the other's new objects.
    const [a, b, strokesA, strokesB] = await Promise.all([
        import('../public/js/layers/layer-model.js?peer=a'),
        import('../public/js/layers/layer-model.js?peer=b'),
        import('../public/js/drawing/stroke-model.js?peer=a'),
        import('../public/js/drawing/stroke-model.js?peer=b'),
    ])
    const generated = []
    for (const [layers, strokes] of [[a, strokesA], [b, strokesB]]) {
        const layer = layers.createDrawingLayer()
        const child = layers.createChildEffect('filter/blur')
        layer.children.push(child)
        const clone = layers.cloneLayer(layer)
        generated.push(layer.id, child.id, clone.id, clone.children[0].id)
        generated.push(strokes.createPathStroke({ color: '#000000', size: 1 }).id)
        generated.push(strokes.createShapeStroke({ type: 'rect', color: '#000000', size: 1 }).id)
        generated.push(strokes.createLineStroke({ color: '#000000', size: 1 }).id)
    }
    assert.equal(new Set(generated).size, generated.length)
})
