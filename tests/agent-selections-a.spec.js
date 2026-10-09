import { test, expect } from './fixtures.js'
import { reopenNewProjectDialog } from './helpers/new-project.js'

// Parallel mode makes each case its own sharding unit: every case here boots
// its own app and shares no state with its siblings, so shards can split this
// file instead of pinning all of it to one runner.
test.describe.configure({ mode: 'parallel' })

async function bootApp(page) {
    await page.goto('/', { waitUntil: 'networkidle' })
    await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })
    await page.evaluate(async () => { await window.LayersAgent.ready })
    await reopenNewProjectDialog(page)
    await page.click('.media-option[data-type="solid"]')
    await page.waitForSelector('.canvas-size-dialog', { timeout: 5000 })
    // 512 preset: quarters the composited frame cost on software-rendered CI
    // shards (same capacity trim as drawing-shortcuts); this suite reads no
    // absolute canvas coordinates.
    await page.click('.size-preset[data-width="512"]')
    await page.click('.canvas-size-dialog .action-btn.primary')
    await page.waitForSelector('.open-dialog-backdrop.visible', { state: 'hidden', timeout: 5000 })
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
})
