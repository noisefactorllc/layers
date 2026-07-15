import { test, expect } from 'playwright/test'

async function bootApp(page) {
    await page.goto('/', { waitUntil: 'networkidle' })
    await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })
    await page.evaluate(async () => { await window.LayersAgent.ready })
    const visible = await page.evaluate(() => !!document.querySelector('.open-dialog-backdrop.visible'))
    if (visible) {
        await page.click('.media-option[data-type="solid"]')
        await page.waitForSelector('.canvas-size-dialog', { timeout: 5000 })
        await page.click('.canvas-size-dialog .action-btn.primary')
        await page.waitForSelector('.open-dialog-backdrop.visible', { state: 'hidden', timeout: 5000 })
    }
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

test.describe('paintStroke', () => {
    test('paints a stroke onto a new drawing layer (auto-created)', async ({ page }) => {
        await bootApp(page)
        const before = await page.evaluate(() => window.layersApp._layers.length)
        const env = await page.evaluate(() =>
            window.LayersAgent.paintStroke({
                points: [[10, 10], [50, 50], [100, 100]],
                size: 5,
                color: '#ff0000'
            }))
        expect(env.ok).toBe(true)
        expect(env.result.layerId).toMatch(/^layer-/)
        const after = await page.evaluate(() => window.layersApp._layers.length)
        expect(after).toBe(before + 1)
        const drawingLayer = env.state.layers.find(l => l.id === env.result.layerId)
        expect(drawingLayer.sourceType).toBe('drawing')
        expect(drawingLayer.drawing.strokeCount).toBe(1)
    })

    test('job polling hides a stroke that fails during rasterization', async ({ page }) => {
        await bootApp(page)
        const result = await page.evaluate(async () => {
            const app = window.layersApp
            const added = await window.LayersAgent.addLayer({ kind: 'drawing' })
            const layerId = added.result.layerId
            const readState = async () => {
                const { state } = await window.LayersAgent.getJob({ jobId: 'missing-job' })
                return {
                    project: state.project,
                    canvas: state.canvas,
                    selection: state.selection,
                    layers: state.layers,
                    selectedLayerIds: state.selectedLayerIds,
                    activeLayerId: state.activeLayerId,
                }
            }
            const before = await readState()
            let enteredRasterize
            let releaseRasterize
            const entered = new Promise(resolve => { enteredRasterize = resolve })
            const release = new Promise(resolve => { releaseRasterize = resolve })
            app._rasterizeDrawingLayer = async () => {
                enteredRasterize()
                await release
                throw new Error('injected drawing rasterization failure')
            }

            const mutation = window.LayersAgent.paintStroke({
                layerId,
                points: [[10, 10], [50, 50]],
                size: 5,
                color: '#ff0000',
            })
            await entered
            const during = await readState()
            releaseRasterize()
            const envelope = await mutation
            const after = await readState()
            return { before, during, envelope, after }
        })

        expect(result.envelope.ok).toBe(false)
        expect(result.during).toEqual(result.before)
        expect(result.after).toEqual(result.before)
    })

    test('one undo removes an auto-created drawing layer and its stroke', async ({ page }) => {
        await bootApp(page)
        const result = await page.evaluate(async () => {
            const app = window.layersApp
            const before = {
                layerIds: app._layers.map(layer => layer.id),
                undoLength: app._undoManager._stack.length,
                undoIndex: app._undoManager._index,
            }
            const painted = await window.LayersAgent.paintStroke({
                points: [[10, 10], [50, 50]],
                size: 5,
                color: '#ff0000',
            })
            const afterPaint = {
                undoLength: app._undoManager._stack.length,
                undoIndex: app._undoManager._index,
            }
            const undone = await window.LayersAgent.undo()
            return { before, afterPaint, painted, undone }
        })

        expect(result.painted.ok).toBe(true)
        expect(result.afterPaint.undoLength).toBe(result.before.undoLength + 1)
        expect(result.afterPaint.undoIndex).toBe(result.before.undoIndex + 1)
        expect(result.undone.ok).toBe(true)
        expect(result.undone.state.layers.map(layer => layer.id)).toEqual(
            result.before.layerIds)
    })

    test('paintStroke onto an existing drawing layer', async ({ page }) => {
        await bootApp(page)
        const id = await page.evaluate(async () => {
            const env = await window.LayersAgent.addLayer({ kind: 'drawing' })
            return env.result.layerId
        })
        const env = await page.evaluate((layerId) =>
            window.LayersAgent.paintStroke({
                layerId,
                points: [[0, 0], [10, 10]],
                size: 3,
                color: '#000000'
            }), id)
        expect(env.ok).toBe(true)
        expect(env.result.layerId).toBe(id)
        const layer = env.state.layers.find(l => l.id === id)
        expect(layer.drawing.strokeCount).toBe(1)
    })

    test('paintStroke accepts {x,y} object points as well as [x,y] tuples', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() =>
            window.LayersAgent.paintStroke({
                points: [{ x: 10, y: 10 }, { x: 20, y: 20 }],
                size: 5,
                color: '#00ff00'
            }))
        expect(env.ok).toBe(true)
        const layer = env.state.layers.find(l => l.id === env.result.layerId)
        expect(layer.drawing.strokeCount).toBe(1)
    })

    test('CONFLICT_NOT_DRAWING_LAYER when layerId is not a drawing layer', async ({ page }) => {
        await bootApp(page)
        const id = await page.evaluate(() => window.layersApp._layers[0].id)
        const env = await page.evaluate((layerId) =>
            window.LayersAgent.paintStroke({
                layerId,
                points: [[0, 0], [10, 10]],
                size: 5,
                color: '#000000'
            }), id)
        expect(env.ok).toBe(false)
        expect(env.error.code).toBe('CONFLICT_NOT_DRAWING_LAYER')
    })

    test('rejects too few points', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() =>
            window.LayersAgent.paintStroke({ points: [[0, 0]], size: 5, color: '#000000' }))
        expect(env.ok).toBe(false)
        expect(env.error.code).toBe('INVALID_ARGS_RANGE')
        expect(env.error.details.field).toBe('points')
    })

    test('rejects malformed point', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() =>
            window.LayersAgent.paintStroke({
                points: [[0, 0], [1, 'oops']], size: 5, color: '#000000'
            }))
        expect(env.ok).toBe(false)
        expect(env.error.code).toBe('INVALID_ARGS_TYPE')
    })

    test('rejects non-finite object points without creating a layer', async ({ page }) => {
        await bootApp(page)
        const before = await page.evaluate(() => window.layersApp._layers.length)
        const env = await page.evaluate(() =>
            window.LayersAgent.paintStroke({
                points: [{ x: 0, y: 0 }, { x: Infinity, y: 10 }],
                size: 5,
                color: '#000000',
            }))
        expect(env.ok).toBe(false)
        expect(env.error.code).toBe('INVALID_ARGS_TYPE')
        expect(await page.evaluate(() => window.layersApp._layers.length)).toBe(before)
    })

    test('NOT_FOUND_LAYER for missing id', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() =>
            window.LayersAgent.paintStroke({
                layerId: 'layer-nope',
                points: [[0, 0], [10, 10]],
                size: 5, color: '#000000'
            }))
        expect(env.ok).toBe(false)
        expect(env.error.code).toBe('NOT_FOUND_LAYER')
    })
})

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

test.describe('eraseStroke', () => {
    test('removes a stroke by id', async ({ page }) => {
        await bootApp(page)
        const { layerId, strokeId } = await page.evaluate(async () => {
            const env = await window.LayersAgent.paintStroke({
                points: [[0, 0], [10, 10]], size: 5, color: '#000'
            })
            return env.result
        })
        const before = await page.evaluate((id) => {
            const layer = window.layersApp._layers.find(l => l.id === id)
            return layer.strokes.length
        }, layerId)
        expect(before).toBe(1)

        const env = await page.evaluate(({ layerId, strokeId }) =>
            window.LayersAgent.eraseStroke({ layerId, strokeId }), { layerId, strokeId })
        expect(env.ok).toBe(true)
        expect(env.result).toEqual({ layerId, strokeId })

        const layerSnap = env.state.layers.find(l => l.id === layerId)
        expect(layerSnap.drawing.strokeCount).toBe(0)
        expect(await page.evaluate((id) =>
            window.layersApp._renderer.getMediaInfo(id), layerId)).toBeNull()
    })

    test('reports strokeCount drop in snapshot', async ({ page }) => {
        await bootApp(page)
        const { layerId, ids } = await page.evaluate(async () => {
            const a = await window.LayersAgent.paintStroke({
                points: [[0, 0], [10, 10]], size: 5, color: '#000'
            })
            const b = await window.LayersAgent.paintStroke({
                layerId: a.result.layerId,
                points: [[20, 20], [30, 30]], size: 5, color: '#f00'
            })
            const c = await window.LayersAgent.paintStroke({
                layerId: a.result.layerId,
                points: [[40, 40], [50, 50]], size: 5, color: '#0f0'
            })
            return { layerId: a.result.layerId, ids: [a.result.strokeId, b.result.strokeId, c.result.strokeId] }
        })
        const startCount = (await page.evaluate((id) => {
            return window.LayersAgent.getLayer({ layerId: id })
        }, layerId)).result.drawing.strokeCount
        expect(startCount).toBe(3)

        const env = await page.evaluate(({ layerId, strokeId }) =>
            window.LayersAgent.eraseStroke({ layerId, strokeId }),
            { layerId, strokeId: ids[1] })
        expect(env.ok).toBe(true)
        const layerSnap = env.state.layers.find(l => l.id === layerId)
        expect(layerSnap.drawing.strokeCount).toBe(2)
    })

    test('NOT_FOUND_STROKE when strokeId is unknown', async ({ page }) => {
        await bootApp(page)
        const layerId = await page.evaluate(async () => {
            const env = await window.LayersAgent.addLayer({ kind: 'drawing' })
            return env.result.layerId
        })
        const env = await page.evaluate((id) =>
            window.LayersAgent.eraseStroke({ layerId: id, strokeId: 'stroke-nope' }), layerId)
        expect(env.ok).toBe(false)
        expect(env.error.code).toBe('NOT_FOUND_STROKE')
        expect(env.error.details.strokeId).toBe('stroke-nope')
        expect(env.error.details.layerId).toBe(layerId)
    })

    test('NOT_FOUND_LAYER when layerId is unknown', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() =>
            window.LayersAgent.eraseStroke({ layerId: 'layer-nope', strokeId: 'stroke-0' }))
        expect(env.ok).toBe(false)
        expect(env.error.code).toBe('NOT_FOUND_LAYER')
    })

    test('CONFLICT_NOT_DRAWING_LAYER on non-drawing layer', async ({ page }) => {
        await bootApp(page)
        const id = await page.evaluate(() => window.layersApp._layers[0].id)
        const env = await page.evaluate((layerId) =>
            window.LayersAgent.eraseStroke({ layerId, strokeId: 'stroke-0' }), id)
        expect(env.ok).toBe(false)
        expect(env.error.code).toBe('CONFLICT_NOT_DRAWING_LAYER')
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

    test('blocked online fill returns conflict without mutating layers, dirty state, or undo history', async ({ page }) => {
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

        expect(result.envelope.ok).toBe(false)
        expect(result.envelope.error.code).toBe('CONFLICT_MEDIA_BLOCKED_ONLINE')
        expect(result.before.dirty).toBe(false)
        expect(result.after).toEqual(result.before)
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
