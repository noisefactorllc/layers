import { test } from 'node:test'
import assert from 'node:assert/strict'
import { UndoManager, snapshotsEqual, layersEqual } from '../public/js/utils/undo-manager.js'
import { createLayer, createEffectLayer } from '../public/js/layers/layer-model.js'

test('layersEqual accurately compares real layer models and catches transform/mask/param differences', () => {
    const baseLayer = createLayer({
        id: 'layer-1',
        name: 'Layer 1',
        sourceType: 'effect',
        effectId: 'synth/gradient',
        opacity: 80,
        blendMode: 'mix',
        offsetX: 10,
        offsetY: 20,
        scaleX: 1.5,
        scaleY: 1.5,
        rotation: 45,
        flipH: false,
        flipV: false,
        maskEnabled: true,
        maskVisible: false,
        effectParams: { type: 'radial', angle: 0 },
    })

    const identicalLayer = {
        ...baseLayer,
        effectParams: { ...baseLayer.effectParams },
    }

    assert.equal(layersEqual([baseLayer], [identicalLayer]), true)

    // Moving layer must not be equal
    assert.equal(layersEqual([baseLayer], [{ ...baseLayer, offsetX: 15 }]), false)
    assert.equal(layersEqual([baseLayer], [{ ...baseLayer, offsetY: 25 }]), false)

    // Scaling layer must not be equal
    assert.equal(layersEqual([baseLayer], [{ ...baseLayer, scaleX: 2.0 }]), false)
    assert.equal(layersEqual([baseLayer], [{ ...baseLayer, scaleY: 2.0 }]), false)

    // Rotating layer must not be equal
    assert.equal(layersEqual([baseLayer], [{ ...baseLayer, rotation: 90 }]), false)

    // Flipping layer must not be equal
    assert.equal(layersEqual([baseLayer], [{ ...baseLayer, flipH: true }]), false)
    assert.equal(layersEqual([baseLayer], [{ ...baseLayer, flipV: true }]), false)

    // Mask toggles must not be equal
    assert.equal(layersEqual([baseLayer], [{ ...baseLayer, maskEnabled: false }]), false)
    assert.equal(layersEqual([baseLayer], [{ ...baseLayer, maskVisible: true }]), false)

    // Opacity and blend mode must not be equal
    assert.equal(layersEqual([baseLayer], [{ ...baseLayer, opacity: 50 }]), false)
    assert.equal(layersEqual([baseLayer], [{ ...baseLayer, blendMode: 'multiply' }]), false)

    // Effect params change must not be equal
    assert.equal(layersEqual([baseLayer], [{ ...baseLayer, effectParams: { type: 'linear', angle: 0 } }]), false)

    // Array length mismatch
    assert.equal(layersEqual([baseLayer], []), false)
})

test('snapshotsEqual compares canvas size, mediaCanvases, and layer configurations', () => {
    const layer = createEffectLayer('synth/gradient', 'Gradient', { angle: 0 })
    const snapA = {
        canvasWidth: 800,
        canvasHeight: 600,
        layers: [layer]
    }
    const snapB = {
        canvasWidth: 800,
        canvasHeight: 600,
        layers: [{ ...layer, effectParams: { ...layer.effectParams } }]
    }
    const snapDiffSize = {
        canvasWidth: 1024,
        canvasHeight: 768,
        layers: [layer]
    }
    const snapDiffOpacity = {
        canvasWidth: 800,
        canvasHeight: 600,
        layers: [{ ...layer, opacity: 50 }]
    }

    assert.equal(snapshotsEqual(snapA, snapB), true)
    assert.equal(snapshotsEqual(snapA, snapDiffSize), false)
    assert.equal(snapshotsEqual(snapA, snapDiffOpacity), false)
})

test('UndoManager skips pushing identical snapshots to prevent no-op history bloat', () => {
    const undo = new UndoManager(10)
    const initialLayer = createLayer({ id: '1', sourceType: 'effect', opacity: 100 })
    const initial = {
        canvasWidth: 800,
        canvasHeight: 600,
        layers: [initialLayer]
    }
    const second = {
        canvasWidth: 800,
        canvasHeight: 600,
        layers: [{ ...initialLayer, opacity: 75 }]
    }
    const duplicateOfSecond = {
        canvasWidth: 800,
        canvasHeight: 600,
        layers: [{ ...initialLayer, opacity: 75 }]
    }

    assert.equal(undo.pushState(initial), true)
    assert.equal(undo.canUndo(), false) // Initial state is root, index = 0
    assert.equal(undo.pushState(second), true)
    assert.equal(undo.canUndo(), true)

    // Pushing identical state should be deduplicated
    assert.equal(undo.pushState(duplicateOfSecond), false)
    assert.equal(undo.canUndo(), true)

    // Undo should go straight back to initial state
    const restored = undo.undo()
    assert.equal(restored.layers[0].opacity, 100)
    assert.equal(undo.canUndo(), false)
    assert.equal(undo.canRedo(), true)

    // Redo should return to second state
    const redone = undo.redo()
    assert.equal(redone.layers[0].opacity, 75)
    assert.equal(undo.canRedo(), false)
})
