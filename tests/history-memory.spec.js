import { test, expect } from './fixtures.js'
import { UndoManager } from '../public/js/utils/undo-manager.js'

test('history budgets unique retained buffers and evicts oldest states', () => {
    const history = new UndoManager(50, 4096)
    const shared = new Uint8Array(2048)
    for (let i = 0; i < 10; i++) history.pushState({ shared, value: i })
    expect(history.canUndo()).toBe(true)
    expect(history.retainedBytes).toBeLessThanOrEqual(4096)
    history.pushState({ data: new Uint8Array(3072) })
    expect(history.retainedBytes).toBeLessThanOrEqual(4096)
    expect(history.canUndo()).toBe(false)
    history.clear()
    expect(history.retainedBytes).toBe(0)
})

test('property history shares unchanged masks and strokes; mask edits preserve old pixels', async ({ page }) => {
    await page.goto('/', { waitUntil: 'networkidle' })
    await page.evaluate(async () => { await window.LayersAgent.ready })
    const result = await page.evaluate(async () => {
        const app = window.layersApp
        await window.LayersAgent.newProject({ width: 64, height: 64 })
        const { createDrawingLayer } = await import('/js/layers/layer-model.js')
        const drawing = createDrawingLayer('Drawing')
        drawing.strokes = [{ type: 'path', points: [{ x: 10, y: 10 }], color: '#ff0000', size: 4 }]
        drawing.mask = new ImageData(new Uint8ClampedArray(64 * 64 * 4).fill(255), 64, 64)
        app._layers.push(drawing)
        const states = []
        for (let i = 0; i < 50; i++) {
            drawing.opacity = i
            states.push(app._createUndoSnapshot())
        }
        const mask = states[0].layers[0].mask
        const stroke = states[0].layers[0].strokes[0]
        await app._invertLayerMask(drawing.id)
        return {
            masks: new Set(states.map(s => s.layers[0].mask)).size,
            strokes: new Set(states.map(s => s.layers[0].strokes[0])).size,
            oldPixel: mask.data[0], newPixel: drawing.mask.data[0],
            oldPoint: stroke.points[0].x,
        }
    })
    expect(result).toEqual({ masks: 1, strokes: 1, oldPixel: 255, newPixel: 0, oldPoint: 10 })
})
