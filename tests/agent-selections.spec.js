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

test.describe('selectAll / selectNone / selectInverse', () => {
    test('selectAll covers the whole canvas', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() => window.LayersAgent.selectAll())
        expect(env.ok).toBe(true)
        expect(env.state.selection).not.toBeNull()
        expect(env.state.selection.kind).toBe('rectangle')
        expect(env.state.selection.bounds).toEqual({
            x: 0, y: 0,
            width: env.state.canvas.width,
            height: env.state.canvas.height
        })
    })

    test('selectNone clears the selection', async ({ page }) => {
        await bootApp(page)
        await page.evaluate(() => window.LayersAgent.selectAll())
        const env = await page.evaluate(() => window.LayersAgent.selectNone())
        expect(env.ok).toBe(true)
        expect(env.state.selection).toBeNull()
    })

    test('selectInverse on a rect produces a mask selection', async ({ page }) => {
        await bootApp(page)
        await page.evaluate(() => {
            window.layersApp._selectionManager._selectionPath = {
                type: 'rect', x: 100, y: 100, width: 200, height: 200
            }
            window.layersApp._selectionManager._drawMarchingAnts()
        })
        const env = await page.evaluate(() => window.LayersAgent.selectInverse())
        expect(env.ok).toBe(true)
        // After inversion the selection becomes a mask (color-range kind), since
        // SELECTION_KIND_MAP maps internal type 'mask' to public kind 'color-range'.
        expect(env.state.selection).not.toBeNull()
        expect(env.state.selection.kind).toBe('color-range')
    })

    test('selectInverse with no selection returns CONFLICT_NO_SELECTION', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() => window.LayersAgent.selectInverse())
        expect(env.ok).toBe(false)
        expect(env.error.code).toBe('CONFLICT_NO_SELECTION')
    })
})

test.describe('setRectangleSelection / setOvalSelection', () => {
    test('setRectangleSelection sets a rect selection at given coords', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() =>
            window.LayersAgent.setRectangleSelection({ x: 50, y: 60, width: 200, height: 100 }))
        expect(env.ok).toBe(true)
        expect(env.state.selection.kind).toBe('rectangle')
        expect(env.state.selection.bounds).toEqual({ x: 50, y: 60, width: 200, height: 100 })
    })

    test('setOvalSelection sets an oval selection', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() =>
            window.LayersAgent.setOvalSelection({ x: 100, y: 200, width: 80, height: 40 }))
        expect(env.ok).toBe(true)
        expect(env.state.selection.kind).toBe('oval')
        expect(env.state.selection.bounds).toEqual({ x: 100, y: 200, width: 80, height: 40 })
    })

    test('setRectangleSelection rejects negative width', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() =>
            window.LayersAgent.setRectangleSelection({ x: 0, y: 0, width: -1, height: 100 }))
        expect(env.ok).toBe(false)
        expect(env.error.code).toBe('INVALID_ARGS_RANGE')
    })

    test('setRectangleSelection rejects missing required field', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() =>
            window.LayersAgent.setRectangleSelection({ x: 0, y: 0, width: 100 }))
        expect(env.ok).toBe(false)
        expect(env.error.code).toBe('INVALID_ARGS_REQUIRED')
        expect(env.error.details.field).toBe('height')
    })
})

test.describe('setPolygonSelection', () => {
    test('sets a polygon selection from points', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() =>
            window.LayersAgent.setPolygonSelection({
                points: [[10, 10], [100, 10], [100, 100], [10, 100]]
            }))
        expect(env.ok).toBe(true)
        expect(env.state.selection.kind).toBe('polygon')
        expect(env.state.selection.polygonPoints).toEqual([[10, 10], [100, 10], [100, 100], [10, 100]])
        expect(env.state.selection.bounds).toEqual({ x: 10, y: 10, width: 90, height: 90 })
    })

    test('sets a lasso selection when kind=lasso', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() =>
            window.LayersAgent.setPolygonSelection({
                kind: 'lasso',
                points: [[0, 0], [50, 0], [50, 50]]
            }))
        expect(env.ok).toBe(true)
        expect(env.state.selection.kind).toBe('lasso')
    })

    test('rejects too few points', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() =>
            window.LayersAgent.setPolygonSelection({ points: [[0, 0], [50, 50]] }))
        expect(env.ok).toBe(false)
        expect(env.error.code).toBe('INVALID_ARGS_RANGE')
        expect(env.error.details.field).toBe('points')
    })

    test('rejects malformed points', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() =>
            window.LayersAgent.setPolygonSelection({ points: [[0, 0], [50, 'oops'], [100, 100]] }))
        expect(env.ok).toBe(false)
        expect(env.error.code).toBe('INVALID_ARGS_TYPE')
    })

    test('rejects non-finite points without changing selection', async ({ page }) => {
        await bootApp(page)
        const result = await page.evaluate(async () => {
            const app = window.layersApp
            app._selectionManager.clearSelection()
            const envelope = await window.LayersAgent.setPolygonSelection({
                points: [[0, 0], [Infinity, 50], [100, 100]],
            })
            return {
                envelope,
                hasSelection: app._selectionManager.hasSelection(),
            }
        })
        expect(result.envelope.ok).toBe(false)
        expect(result.envelope.error.code).toBe('INVALID_ARGS_TYPE')
        expect(result.hasSelection).toBe(false)
    })
})

test.describe('setMagicWandSelection', () => {
    test('selects a region of similar color', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() =>
            window.LayersAgent.setMagicWandSelection({ x: 100, y: 100, tolerance: 32 }))
        expect(env.ok).toBe(true)
        expect(env.state.selection).not.toBeNull()
        expect(env.state.selection.kind).toBe('wand')
        expect(env.state.selection.bounds.width).toBeGreaterThan(0)
    })

    test('samples a split layer made visible by the immediately preceding command', async ({ page }) => {
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
            let wand
            try {
                wand = await window.LayersAgent.setMagicWandSelection({
                    x: Math.floor(width / 4),
                    y: Math.floor(height / 2),
                    tolerance: 0,
                })
            } finally {
                app._renderCurrentFrame = renderCurrentFrame
            }
            const mask = app._selectionManager.rasterizeSelection()
            const alphaAt = (x, y) => mask.data[(y * width + x) * 4 + 3]
            return {
                preceding,
                wand,
                freshFrameCalls,
                leftAlpha: alphaAt(Math.floor(width / 4), Math.floor(height / 2)),
                rightAlpha: alphaAt(Math.floor(3 * width / 4), Math.floor(height / 2)),
            }
        }, setup)

        expect(result.preceding.ok).toBe(true)
        expect(result.wand.ok).toBe(true)
        expect(result.freshFrameCalls).toBe(1)
        expect(result.wand.state.selection.bounds).toEqual({
            x: 0,
            y: 0,
            width: setup.width / 2,
            height: setup.height,
        })
        expect(result.leftAlpha).toBe(255)
        expect(result.rightAlpha).toBe(0)
    })

    test('rejects out-of-canvas coords', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() =>
            window.LayersAgent.setMagicWandSelection({ x: -1, y: 0, tolerance: 32 }))
        expect(env.ok).toBe(false)
        expect(env.error.code).toBe('INVALID_ARGS_RANGE')
    })

    test('rejects out-of-range tolerance', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() =>
            window.LayersAgent.setMagicWandSelection({ x: 0, y: 0, tolerance: 999 }))
        expect(env.ok).toBe(false)
        expect(env.error.code).toBe('INVALID_ARGS_RANGE')
    })
})

test.describe('selectColorRange', () => {
    test('samples color at given point and selects matching pixels', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() =>
            window.LayersAgent.selectColorRange({ x: 100, y: 100, tolerance: 50 }))
        expect(env.ok).toBe(true)
        expect(env.state.selection).not.toBeNull()
        expect(env.state.selection.kind).toBe('color-range')
        expect(env.state.selection.bounds.width).toBeGreaterThan(0)
    })

    test('samples a split layer made visible by the immediately preceding command', async ({ page }) => {
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
            let range
            try {
                range = await window.LayersAgent.selectColorRange({
                    x: Math.floor(width / 4),
                    y: Math.floor(height / 2),
                    tolerance: 0,
                })
            } finally {
                app._renderCurrentFrame = renderCurrentFrame
            }
            const mask = app._selectionManager.rasterizeSelection()
            const alphaAt = (x, y) => mask.data[(y * width + x) * 4 + 3]
            return {
                preceding,
                range,
                freshFrameCalls,
                leftAlpha: alphaAt(Math.floor(width / 4), Math.floor(height / 2)),
                rightAlpha: alphaAt(Math.floor(3 * width / 4), Math.floor(height / 2)),
            }
        }, setup)

        expect(result.preceding.ok).toBe(true)
        expect(result.range.ok).toBe(true)
        expect(result.freshFrameCalls).toBe(1)
        expect(result.range.state.selection.bounds).toEqual({
            x: 0,
            y: 0,
            width: setup.width / 2,
            height: setup.height,
        })
        expect(result.leftAlpha).toBe(255)
        expect(result.rightAlpha).toBe(0)
    })

    test('rejects out-of-canvas coords', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() =>
            window.LayersAgent.selectColorRange({ x: 99999, y: 0, tolerance: 50 }))
        expect(env.ok).toBe(false)
        expect(env.error.code).toBe('INVALID_ARGS_RANGE')
    })
})
