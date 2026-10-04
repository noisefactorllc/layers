import { test, expect } from './fixtures.js'
import { reopenNewProjectDialog } from './helpers/new-project.js'

async function bootApp(page) {
    await page.goto('/', { waitUntil: 'networkidle' })
    await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })
    await page.evaluate(async () => { await window.LayersAgent.ready })
    await reopenNewProjectDialog(page)
    await page.click('.media-option[data-type="solid"]')
    await page.waitForSelector('.canvas-size-dialog', { timeout: 5000 })
    await page.click('.canvas-size-dialog .action-btn.primary')
    await page.waitForSelector('.open-dialog-backdrop.visible', { state: 'hidden', timeout: 5000 })
}

async function prepareHiddenSplitDrawing(page) {
    return page.evaluate(async () => {
        const app = window.layersApp
        const width = app._canvas.width
        const height = app._canvas.height
        const added = await window.LayersAgent.addLayer({ kind: 'drawing' })
        const layerId = added.result.layerId
        await window.LayersAgent.drawShape({
            layerId,
            shape: 'rect',
            x: 0,
            y: 0,
            width: width / 2,
            height,
            color: '#ff0000',
            size: 1,
            filled: true,
        })
        await window.LayersAgent.drawShape({
            layerId,
            shape: 'rect',
            x: width / 2,
            y: 0,
            width: width / 2,
            height,
            color: '#0000ff',
            size: 1,
            filled: true,
        })
        await window.LayersAgent.setLayerProps({ layerId, props: { visible: false } })
        app._renderCurrentFrame()
        return { layerId, width, height }
    })
}

test.describe('drawShape', () => {
    test('draws an outlined rect onto a new drawing layer', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() =>
            window.LayersAgent.drawShape({
                shape: 'rect',
                x: 100, y: 100, width: 200, height: 100,
                color: '#0000ff',
                size: 3
            }))
        expect(env.ok).toBe(true)
        const layer = env.state.layers.find(l => l.id === env.result.layerId)
        expect(layer.sourceType).toBe('drawing')
        expect(layer.drawing.strokeCount).toBe(1)
    })

    test('draws a filled ellipse', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() =>
            window.LayersAgent.drawShape({
                shape: 'ellipse',
                x: 50, y: 50, width: 100, height: 80,
                color: '#00aa00',
                size: 1,
                filled: true
            }))
        expect(env.ok).toBe(true)
        const layer = env.state.layers.find(l => l.id === env.result.layerId)
        expect(layer.drawing.strokeCount).toBe(1)
    })

    test('drawShape rejects unknown shape', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() =>
            window.LayersAgent.drawShape({
                shape: 'star',
                x: 0, y: 0, width: 10, height: 10,
                color: '#000000', size: 1
            }))
        expect(env.ok).toBe(false)
        expect(env.error.code).toBe('INVALID_ARGS_ENUM')
    })

    test('drawShape rejects non-positive width', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() =>
            window.LayersAgent.drawShape({
                shape: 'rect',
                x: 0, y: 0, width: 0, height: 10,
                color: '#000000', size: 1
            }))
        expect(env.ok).toBe(false)
        expect(env.error.code).toBe('INVALID_ARGS_RANGE')
    })

    test('drawShape onto a non-drawing layer returns CONFLICT', async ({ page }) => {
        await bootApp(page)
        const id = await page.evaluate(() => window.layersApp._layers[0].id)
        const env = await page.evaluate((layerId) =>
            window.LayersAgent.drawShape({
                layerId,
                shape: 'rect',
                x: 0, y: 0, width: 10, height: 10,
                color: '#000000', size: 1
            }), id)
        expect(env.ok).toBe(false)
        expect(env.error.code).toBe('CONFLICT_NOT_DRAWING_LAYER')
    })
})

test.describe('paintStroke mode', () => {
    test('mode:"eraser" marks the stroke as eraser', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() =>
            window.LayersAgent.paintStroke({
                points: [[10, 10], [50, 50]],
                size: 8,
                color: '#000000',
                mode: 'eraser'
            }))
        expect(env.ok).toBe(true)
        const stroke = await page.evaluate((info) => {
            const layer = window.layersApp._layers.find(l => l.id === info.layerId)
            return layer.strokes.find(s => s.id === info.strokeId)
        }, env.result)
        expect(stroke.mode).toBe('eraser')
    })

    test('mode defaults to "brush" when omitted', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() =>
            window.LayersAgent.paintStroke({
                points: [[0, 0], [10, 10]],
                size: 5,
                color: '#ff0000'
            }))
        expect(env.ok).toBe(true)
        const stroke = await page.evaluate((info) => {
            const layer = window.layersApp._layers.find(l => l.id === info.layerId)
            return layer.strokes.find(s => s.id === info.strokeId)
        }, env.result)
        expect(stroke.mode).toBe('brush')
    })

    test('rejects unknown mode value', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() =>
            window.LayersAgent.paintStroke({
                points: [[0, 0], [10, 10]],
                size: 5,
                color: '#000000',
                mode: 'smudge'
            }))
        expect(env.ok).toBe(false)
        expect(env.error.code).toBe('INVALID_ARGS_ENUM')
    })
})

test.describe('clearDrawingLayer', () => {
    test('empties the strokes array and reports clearedCount', async ({ page }) => {
        await bootApp(page)
        const layerId = await page.evaluate(async () => {
            const a = await window.LayersAgent.paintStroke({
                points: [[0, 0], [10, 10]], size: 5, color: '#000'
            })
            await window.LayersAgent.paintStroke({
                layerId: a.result.layerId,
                points: [[20, 20], [30, 30]], size: 5, color: '#f00'
            })
            await window.LayersAgent.paintStroke({
                layerId: a.result.layerId,
                points: [[40, 40], [50, 50]], size: 5, color: '#0f0'
            })
            return a.result.layerId
        })

        const env = await page.evaluate((id) =>
            window.LayersAgent.clearDrawingLayer({ layerId: id }), layerId)
        expect(env.ok).toBe(true)
        expect(env.result.layerId).toBe(layerId)
        expect(env.result.clearedCount).toBe(3)

        const layerSnap = env.state.layers.find(l => l.id === layerId)
        expect(layerSnap.drawing.strokeCount).toBe(0)
        expect(await page.evaluate((id) =>
            window.layersApp._renderer.getMediaInfo(id), layerId)).toBeNull()
    })

    test('clearedCount is 0 when layer was already empty', async ({ page }) => {
        await bootApp(page)
        const layerId = await page.evaluate(async () => {
            const env = await window.LayersAgent.addLayer({ kind: 'drawing' })
            return env.result.layerId
        })
        const env = await page.evaluate((id) =>
            window.LayersAgent.clearDrawingLayer({ layerId: id }), layerId)
        expect(env.ok).toBe(true)
        expect(env.result.clearedCount).toBe(0)
    })

    test('NOT_FOUND_LAYER when layerId is unknown', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() =>
            window.LayersAgent.clearDrawingLayer({ layerId: 'layer-nope' }))
        expect(env.ok).toBe(false)
        expect(env.error.code).toBe('NOT_FOUND_LAYER')
    })

    test('CONFLICT_NOT_DRAWING_LAYER on non-drawing layer', async ({ page }) => {
        await bootApp(page)
        const id = await page.evaluate(() => window.layersApp._layers[0].id)
        const env = await page.evaluate((layerId) =>
            window.LayersAgent.clearDrawingLayer({ layerId }), id)
        expect(env.ok).toBe(false)
        expect(env.error.code).toBe('CONFLICT_NOT_DRAWING_LAYER')
    })
})

test.describe('fillRegion', () => {
    test('creates a new media layer with the filled region', async ({ page }) => {
        await bootApp(page)
        const before = await page.evaluate(() => window.layersApp._layers.length)
        const env = await page.evaluate(() =>
            window.LayersAgent.fillRegion({
                x: 100, y: 100,
                color: '#ff0000',
                tolerance: 32
            }))
        expect(env.ok).toBe(true)
        expect(env.result.layerId).toMatch(/^layer-/)
        const after = await page.evaluate(() => window.layersApp._layers.length)
        expect(after).toBe(before + 1)
        const layer = env.state.layers.find(l => l.id === env.result.layerId)
        expect(layer.sourceType).toBe('media')
    })

    test('fills a split layer made visible by the immediately preceding command', async ({ page }) => {
        await bootApp(page)
        const setup = await prepareHiddenSplitDrawing(page)
        const result = await page.evaluate(async ({ layerId, width, height }) => {
            const app = window.layersApp
            const preceding = await window.LayersAgent.setLayerProps({
                layerId,
                props: { visible: true },
            })
            const renderCurrentFrame = app._renderCurrentFrame
            let freshFrameCalls = 0
            app._renderCurrentFrame = (...args) => {
                freshFrameCalls += 1
                return renderCurrentFrame.apply(app, args)
            }
            let fill
            try {
                fill = await window.LayersAgent.fillRegion({
                    x: Math.floor(width / 4),
                    y: Math.floor(height / 2),
                    color: '#00ff00',
                    tolerance: 0,
                })
            } finally {
                app._renderCurrentFrame = renderCurrentFrame
            }
            const media = app._renderer.getMediaInfo(fill.result.layerId)
            const sample = document.createElement('canvas')
            sample.width = width
            sample.height = height
            const ctx = sample.getContext('2d')
            ctx.drawImage(media.element, 0, 0)
            const pixelAt = (x, y) =>
                [...ctx.getImageData(x, y, 1, 1).data]
            return {
                preceding,
                fill,
                freshFrameCalls,
                leftPixel: pixelAt(Math.floor(width / 4), Math.floor(height / 2)),
                rightPixel: pixelAt(Math.floor(3 * width / 4), Math.floor(height / 2)),
            }
        }, setup)

        expect(result.preceding.ok).toBe(true)
        expect(result.fill.ok).toBe(true)
        expect(result.freshFrameCalls).toBe(1)
        expect(result.leftPixel).toEqual([0, 255, 0, 255])
        expect(result.rightPixel).toEqual([0, 0, 0, 0])
    })

    test('online fill creates an image layer with dirty state and undo history', async ({ page }) => {
        await bootApp(page)
        const result = await page.evaluate(async () => {
            const app = window.layersApp
            app._markClean()
            app._onlineAdapter = {
                isOnline: () => true,
                schedulePublish: () => {},
            }
            app._undoDebounceTimer = setTimeout(() => app._pushUndoState(), 60_000)
            const state = () => ({
                layerIds: app._layers.map(layer => layer.id),
                dirty: app._isDirty,
                mutationRevision: app._projectMutationRevision,
                undoStackLength: app._undoManager._stack.length,
                undoIndex: app._undoManager._index,
                pendingUndo: Boolean(app._undoDebounceTimer),
            })
            const before = state()
            const envelope = await window.LayersAgent.fillRegion({
                x: 100, y: 100,
                color: '#ff0000',
                tolerance: 32
            })
            return { before, after: state(), envelope }
        })

        expect(result.envelope.ok).toBe(true)
        expect(result.before.dirty).toBe(false)
        expect(result.after.dirty).toBe(true)
        expect(result.after.layerIds).toEqual([...result.before.layerIds, result.envelope.result.layerId])
        expect(result.after.undoStackLength).toBeGreaterThan(result.before.undoStackLength)
    })

    test('rejects out-of-canvas point', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() =>
            window.LayersAgent.fillRegion({
                x: 99999, y: 0,
                color: '#000000', tolerance: 32
            }))
        expect(env.ok).toBe(false)
        expect(env.error.code).toBe('INVALID_ARGS_RANGE')
    })

    test('rejects out-of-range tolerance', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() =>
            window.LayersAgent.fillRegion({
                x: 0, y: 0,
                color: '#000000', tolerance: 999
            }))
        expect(env.ok).toBe(false)
        expect(env.error.code).toBe('INVALID_ARGS_RANGE')
    })
})
