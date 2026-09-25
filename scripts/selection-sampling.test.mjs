import assert from 'node:assert/strict'
import test from 'node:test'
import { SelectionManager } from '../public/js/selection/selection-manager.js'
import { featherMask } from '../public/js/selection/selection-modify.js'

test('a dropped pixel mutation does not block the next wand click', async () => {
    const manager = new SelectionManager()
    const source = { width: 32, height: 32 }
    let captured = 0
    const selections = []
    manager.captureCanvas = async () => { captured++; return source }
    manager._applyWandClick = (coords, canvas) => selections.push({ coords, canvas })
    manager.runPixelMutation = () => undefined // A project replacement owns the mutation lease.
    await manager._handleWandClick({ x: 1, y: 2 })
    assert.equal(captured, 0)
    assert.deepEqual(selections, [])
    manager.runPixelMutation = task => task()
    await manager._handleWandClick({ x: 3, y: 4 })
    assert.equal(captured, 1)
    assert.deepEqual(selections, [{ coords: { x: 3, y: 4 }, canvas: source }])
})

test('a failed capture preserves the selection and releases the next click', async () => {
    const manager = new SelectionManager()
    const previous = { type: 'rect', x: 1, y: 2, width: 3, height: 4 }
    manager._selectionPath = previous
    manager.runPixelMutation = task => task()
    manager.captureCanvas = async () => { throw new Error('Capture unavailable') }
    await assert.rejects(manager._handleWandClick({ x: 1, y: 2 }), /Capture unavailable/)
    assert.equal(manager.selectionPath, previous)
    let applied = false
    manager.captureCanvas = async () => ({ width: 32, height: 32 })
    manager._applyWandClick = () => { applied = true }
    await manager._handleWandClick({ x: 3, y: 4 })
    assert.equal(applied, true)
})

test('featherMask: non-positive radius returns binary mask', () => {
    const data = new Uint8ClampedArray(4 * 4)
    data[3] = 255; data[7] = 255; data[11] = 0; data[15] = 0
    const mask = { data, width: 4, height: 1 }
    const res0 = featherMask(mask, 0)
    assert.deepEqual(Array.from(res0.data), [255, 255, 255, 255, 255, 255, 255, 255, 0, 0, 0, 0, 0, 0, 0, 0])
    const resNeg = featherMask(mask, -5)
    assert.deepEqual(Array.from(resNeg.data), [255, 255, 255, 255, 255, 255, 255, 255, 0, 0, 0, 0, 0, 0, 0, 0])
})

test('featherMask: r=1 softens the boundary edge instead of clipping', () => {
    // 6-pixel wide 1D mask: [0, 0, 0, 255, 255, 255]
    // Boundary contour is exactly at x=2.5 (between x=2 and x=3).
    const width = 6
    const data = new Uint8ClampedArray(width * 4)
    for (let x = 0; x < width; x++) {
        data[x * 4 + 3] = x >= 3 ? 255 : 0
    }
    const mask = { data, width, height: 1 }
    const res = featherMask(mask, 1)
    const alphas = []
    for (let x = 0; x < width; x++) alphas.push(res.data[x * 4 + 3])

    // x=2 (d_contour=0.5 outside) -> 64
    // x=3 (d_contour=0.5 inside) -> 191
    assert.equal(alphas[2], 64)
    assert.equal(alphas[3], 191)
    assert.equal(alphas[1], 0)
    assert.equal(alphas[4], 255)
    assert.equal(alphas[2] + alphas[3], 255)
})

test('featherMask: falloff is centered symmetrically without directional bias', () => {
    // 20-pixel wide 1D mask: pixels 0..9 unselected (0), pixels 10..19 selected (255)
    // Boundary contour is exactly at x=9.5.
    const width = 20
    const data = new Uint8ClampedArray(width * 4)
    for (let x = 0; x < width; x++) {
        data[x * 4 + 3] = x >= 10 ? 255 : 0
    }
    const mask = { data, width, height: 1 }

    for (const r of [2, 3, 5]) {
        const res = featherMask(mask, r)
        const alphas = []
        for (let x = 0; x < width; x++) alphas.push(res.data[x * 4 + 3])

        // Monotonicity check
        for (let x = 1; x < width; x++) {
            assert.ok(alphas[x] >= alphas[x - 1], `monotone failure at x=${x} for r=${r}: ${alphas}`)
        }

        // Exact symmetry around contour x=9.5:
        // pixel 9-k (outside) and pixel 10+k (inside) must sum to 255
        for (let k = 0; k < 10; k++) {
            const outVal = alphas[9 - k]
            const inVal = alphas[10 + k]
            assert.equal(outVal + inVal, 255, `asymmetry at k=${k} for r=${r}: ${outVal} + ${inVal} !== 255`)
        }

        // Boundary average is exactly 127.5 (~128, 50%)
        const boundaryAvg = (alphas[9] + alphas[10]) / 2
        assert.equal(boundaryAvg, 127.5)
    }
})
