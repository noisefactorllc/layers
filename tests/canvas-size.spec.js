import { test, expect } from './fixtures.js'
import { appState, defaultProjectReady } from './waits.js'
import { pausePlayback } from './helpers/new-project.js'

// Parallel mode makes each case its own sharding unit: every case here boots
// its own app and shares no state with its siblings, so shards can split this
// file instead of pinning all of it to one runner.
test.describe.configure({ mode: 'parallel' })

// An asymmetric source: each quadrant has its own colour, so a measured
// position also shows which part of the image the canvas kept.
const SOURCE = { width: 128, height: 96 }
const QUADRANT = { width: 64, height: 48 }
const QUADRANTS = {
    red: { x: 0, y: 0, fill: '#ff0000' },
    green: { x: 64, y: 0, fill: '#00ff00' },
    blue: { x: 0, y: 48, fill: '#0000ff' },
    yellow: { x: 64, y: 48, fill: '#ffff00' },
}

// The part of the size change that each anchor puts before the content,
// horizontally and vertically. The dialog and the agent name the edge anchors
// differently.
const AGENT_ANCHORS = {
    'top-left': [0, 0], top: [0.5, 0], 'top-right': [1, 0],
    left: [0, 0.5], center: [0.5, 0.5], right: [1, 0.5],
    'bottom-left': [0, 1], bottom: [0.5, 1], 'bottom-right': [1, 1],
}
const DIALOG_ANCHORS = {
    'top-left': [0, 0], 'top-center': [0.5, 0], 'top-right': [1, 0],
    'middle-left': [0, 0.5], center: [0.5, 0.5], 'middle-right': [1, 0.5],
    'bottom-left': [0, 1], 'bottom-center': [0.5, 1], 'bottom-right': [1, 1],
}

// Even size changes keep every anchor on whole pixels. The shrunken size
// stays within the dialog's minimum.
const SIZES = {
    growth: { width: 256, height: 192 },
    shrinkage: { width: 80, height: 64 },
}

function clip(rect, size) {
    const x0 = Math.max(0, rect.x)
    const y0 = Math.max(0, rect.y)
    const x1 = Math.min(size.width, rect.x + rect.width)
    const y1 = Math.min(size.height, rect.y + rect.height)
    return x1 > x0 && y1 > y0 ? { x: x0, y: y0, width: x1 - x0, height: y1 - y0 } : null
}

function expectedImage(size, [fx, fy]) {
    const x = fx * (size.width - SOURCE.width)
    const y = fy * (size.height - SOURCE.height)
    const image = { size, opaque: clip({ x, y, ...SOURCE }, size), other: null }
    for (const [color, quadrant] of Object.entries(QUADRANTS)) {
        image[color] = clip({ x: x + quadrant.x, y: y + quadrant.y, ...QUADRANT }, size)
    }
    return image
}

async function quadrantProject(page) {
    await page.goto('/', { waitUntil: 'domcontentloaded' })
    await defaultProjectReady(page)
    await pausePlayback(page)
    const outcome = await page.evaluate(async ({ source, quadrant, quadrants }) => {
        const agent = window.LayersAgent
        await agent.ready
        const project = await agent.newProject(source)
        if (!project.ok) return project
        const canvas = document.createElement('canvas')
        canvas.width = source.width
        canvas.height = source.height
        const ctx = canvas.getContext('2d')
        for (const { x, y, fill } of Object.values(quadrants)) {
            ctx.fillStyle = fill
            ctx.fillRect(x, y, quadrant.width, quadrant.height)
        }
        const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'))
        const url = URL.createObjectURL(blob)
        try {
            return await agent.pasteImageFromBytes({ source: { kind: 'url', value: url } })
        } finally {
            URL.revokeObjectURL(url)
        }
    }, { source: SOURCE, quadrant: QUADRANT, quadrants: QUADRANTS })
    expect(outcome.ok, JSON.stringify(outcome.error)).toBe(true)
    await pausePlayback(page)
}

// Measures the rendered canvas image: the bounds of all opaque pixels and of
// each quadrant colour.
async function measureImage(page) {
    return page.evaluate(async () => {
        const encoded = await window.LayersAgent.getCanvasImageBytes({ format: 'png' })
        if (!encoded.ok) throw new Error(encoded.error?.message || 'capture failed')
        const binary = atob(encoded.result.bytes)
        const bytes = Uint8Array.from(binary, character => character.charCodeAt(0))
        const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }))
        const { width, height } = bitmap
        const canvas = new OffscreenCanvas(width, height)
        const ctx = canvas.getContext('2d')
        ctx.drawImage(bitmap, 0, 0)
        bitmap.close()
        const { data } = ctx.getImageData(0, 0, width, height)
        const boxes = {}
        const include = (name, x, y) => {
            const box = boxes[name] ??= { x0: x, y0: y, x1: x, y1: y }
            box.x0 = Math.min(box.x0, x)
            box.y0 = Math.min(box.y0, y)
            box.x1 = Math.max(box.x1, x)
            box.y1 = Math.max(box.y1, y)
        }
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const i = (y * width + x) * 4
                if (data[i + 3] <= 127) continue
                include('opaque', x, y)
                const r = data[i] > 127, g = data[i + 1] > 127, b = data[i + 2] > 127
                const color = r && !g && !b ? 'red'
                    : !r && g && !b ? 'green'
                        : !r && !g && b ? 'blue'
                            : r && g && !b ? 'yellow'
                                : 'other'
                include(color, x, y)
            }
        }
        const image = { size: { width, height } }
        for (const name of ['opaque', 'red', 'green', 'blue', 'yellow', 'other']) {
            const box = boxes[name]
            image[name] = box
                ? { x: box.x0, y: box.y0, width: box.x1 - box.x0 + 1, height: box.y1 - box.y0 + 1 }
                : null
        }
        return image
    })
}

async function undoIndex(page) {
    return page.evaluate(() => window.layersApp._undoManager._index)
}

async function undoAndCheck(page, anchor) {
    const undone = await page.evaluate(() => window.LayersAgent.undo())
    expect(undone.ok, JSON.stringify(undone.error)).toBe(true)
    expect(await measureImage(page), `${anchor} after undo`)
        .toEqual(expectedImage(SOURCE, [0, 0]))
}

test.describe('Image menu - Canvas Size', () => {
    for (const [change, size] of Object.entries(SIZES)) {
        test(`agent resizeCanvas places the image by each anchor during ${change}`, async ({ page }) => {
            await quadrantProject(page)
            expect(await measureImage(page)).toEqual(expectedImage(SOURCE, [0, 0]))

            for (const [anchor, fractions] of Object.entries(AGENT_ANCHORS)) {
                const resized = await page.evaluate(
                    args => window.LayersAgent.resizeCanvas(args), { ...size, anchor })
                expect(resized.ok, JSON.stringify(resized.error)).toBe(true)
                expect(await measureImage(page), anchor).toEqual(expectedImage(size, fractions))
                await undoAndCheck(page, anchor)
            }
        })

        test(`Canvas Size dialog places the image by each anchor during ${change}`, async ({ page }) => {
            await quadrantProject(page)

            for (const [anchor, fractions] of Object.entries(DIALOG_ANCHORS)) {
                const before = await undoIndex(page)
                await page.locator('#menu .hf-menubar-trigger', { hasText: 'image' }).click()
                await page.locator('#canvasSizeMenuItem').click()
                const dialog = page.locator('.canvas-resize-dialog')
                await expect(dialog).toBeVisible()
                await dialog.locator('#canvas-resize-width').fill(String(size.width))
                await dialog.locator('#canvas-resize-height').fill(String(size.height))
                await dialog.locator(`[data-anchor="${anchor}"]`).click()
                await dialog.locator('#canvas-resize-ok').click()
                await appState(page, ({ index, width, height }) => {
                    const app = window.layersApp
                    return app._undoManager._index === index
                        && app._canvas.width === width && app._canvas.height === height
                }, { index: before + 1, ...size })
                expect(await measureImage(page), anchor).toEqual(expectedImage(size, fractions))
                await undoAndCheck(page, anchor)
            }
        })
    }
})
