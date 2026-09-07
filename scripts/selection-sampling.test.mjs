import assert from 'node:assert/strict'
import test from 'node:test'
import { SelectionManager } from '../public/js/selection/selection-manager.js'

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
