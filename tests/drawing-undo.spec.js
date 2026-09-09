import { test, expect } from './fixtures.js'
import { appReady, appState, layerCount, strokeCount } from './waits.js'

async function createTransparentProject(page) {
    await page.waitForSelector('.open-dialog-backdrop.visible')
    await page.click('.media-option[data-type="transparent"]')
    await page.waitForSelector('.canvas-size-dialog', { timeout: 5000 })
    await page.click('.canvas-size-dialog .action-btn.primary')
    await page.waitForSelector('.open-dialog-backdrop.visible', { state: 'hidden', timeout: 5000 })
    // The dialog hides the moment it is dismissed; the project it asked for is
    // still being installed. Wait for the app and its base layer.
    await appReady(page)
    await layerCount(page, 1)
}

// A stroke has to arrive as movement, not as a jump: a single mouse.move can
// deliver one pointermove, and a stroke sized from deltas then commits with no
// size, or does not commit at all. Stepping emits the intermediate events a
// hand would.
async function drawStroke(page, fromX, fromY, toX, toY) {
    await page.mouse.move(fromX, fromY)
    await page.mouse.down()
    await page.mouse.move(toX, toY, { steps: 12 })
    await page.mouse.up()
}

// The stroke commits asynchronously and records its undo snapshot at the end of
// that same commit. Waiting only for the stroke to appear would let the next
// undo run against a snapshot that has not been pushed yet, so drain the
// mutation queue the commit is chained on.
async function strokeCommitted(page, count) {
    await strokeCount(page, count)
    await page.evaluate(() => window.layersApp._drawingMutationTail)
}

// _undo() returns immediately while a previous restore is still in flight, so a
// keypress sent too early is dropped outright rather than delayed. Wait for the
// restore to finish as well as for the reading below to reach its value. The
// predicate reads the count exactly as the assertion does, absent layer and
// all: the app records no snapshot for an empty drawing layer, so the second
// undo lands on the project baseline and the missing layer reads as zero.
function restoredStrokeCount(page, count) {
    return appState(page, (n) => {
        const app = window.layersApp
        if (app._restoring) return false
        const layer = app._layers.find(l => l.sourceType === 'drawing')
        return (layer?.strokes?.length ?? 0) === n
    }, count)
}

test.describe('Drawing undo', () => {
    test('undo removes the last stroke', async ({ page }) => {
        await page.goto('/', { waitUntil: 'networkidle' })
        await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })
        await createTransparentProject(page)

        // Switch to brush tool
        await page.click('#brushToolBtn')
        const overlay = await page.$('#selectionOverlay')
        const box = await overlay.boundingBox()

        // First stroke
        await drawStroke(page, box.x + 100, box.y + 100, box.x + 200, box.y + 200)
        await strokeCommitted(page, 1)

        // Second stroke
        await drawStroke(page, box.x + 300, box.y + 100, box.x + 400, box.y + 200)
        await strokeCommitted(page, 2)

        // Verify 2 strokes
        let strokes = await page.evaluate(() => {
            const layer = window.layersApp._layers.find(l => l.sourceType === 'drawing')
            return layer?.strokes?.length ?? 0
        })
        expect(strokes).toBe(2)

        // Undo — should go from 2 strokes to 1
        await page.keyboard.press('Meta+z')
        await restoredStrokeCount(page, 1)

        strokes = await page.evaluate(() => {
            const layer = window.layersApp._layers.find(l => l.sourceType === 'drawing')
            return layer?.strokes?.length ?? 0
        })
        expect(strokes).toBe(1)

        // Undo again — should go from 1 stroke to 0 strokes (layer created but empty)
        await page.keyboard.press('Meta+z')
        await restoredStrokeCount(page, 0)

        strokes = await page.evaluate(() => {
            const layer = window.layersApp._layers.find(l => l.sourceType === 'drawing')
            return layer?.strokes?.length ?? 0
        })
        expect(strokes).toBe(0)

        // Undo once more — removes the drawing layer entirely (back to before layer creation)
        await page.keyboard.press('Meta+z')
        await appState(page, () => {
            const app = window.layersApp
            return !app._restoring && !app._layers.some(l => l.sourceType === 'drawing')
        })

        const hasDrawingLayer = await page.evaluate(() =>
            window.layersApp._layers.some(l => l.sourceType === 'drawing')
        )
        expect(hasDrawingLayer).toBe(false)
    })
})
