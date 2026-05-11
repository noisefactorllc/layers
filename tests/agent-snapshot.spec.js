import { test, expect } from 'playwright/test'

async function bootApp(page) {
    await page.goto('/', { waitUntil: 'networkidle' })
    await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })
    await page.evaluate(async () => { await window.LayersAgent.ready })
}

async function dismissOpenDialog(page) {
    const visible = await page.evaluate(() => !!document.querySelector('.open-dialog-backdrop.visible'))
    if (visible) {
        await page.click('.media-option[data-type="solid"]')
        await page.waitForSelector('.canvas-size-dialog', { timeout: 5000 })
        await page.click('.canvas-size-dialog .action-btn.primary')
        await page.waitForSelector('.open-dialog-backdrop.visible', { state: 'hidden', timeout: 5000 })
    }
}

test.describe('snapshot scaffolding', () => {
    test('contains project, canvas, view, foreground', async ({ page }) => {
        await bootApp(page)
        await dismissOpenDialog(page)
        const snap = await page.evaluate(() => {
            return window.__buildSnapshot(window.layersApp)
        })
        expect(snap.apiVersion).toBe('1.0')
        expect(snap.schemaVersion).toBe('1.0')
        expect(snap.project).toMatchObject({
            id: null,
            isDirty: expect.any(Boolean),
            canUndo: expect.any(Boolean),
            canRedo: expect.any(Boolean),
            canSaveAs: true
        })
        expect(snap.canvas).toMatchObject({
            width: expect.any(Number),
            height: expect.any(Number)
        })
        expect(snap.canvas.width).toBeGreaterThan(0)
        expect(snap.canvas.height).toBeGreaterThan(0)
        expect(snap.view).toMatchObject({
            zoomMode: expect.anything(),
            isPlaying: expect.any(Boolean),
            loopDuration: expect.any(Number)
        })
        expect(snap.foreground).toMatchObject({
            color: expect.stringMatching(/^#[0-9a-fA-F]{6}$/)
        })
    })
})

test.describe('snapshot layers', () => {
    test('serializes a solid-color effect layer with params', async ({ page }) => {
        await bootApp(page)
        await dismissOpenDialog(page)
        // First layer is the synth/solid created by the open dialog default path.
        const snap = await page.evaluate(() => window.__buildSnapshot(window.layersApp))
        expect(Array.isArray(snap.layers)).toBe(true)
        expect(snap.layers.length).toBeGreaterThanOrEqual(1)
        const base = snap.layers[0]
        expect(base).toMatchObject({
            id: expect.stringMatching(/^layer-/),
            name: expect.any(String),
            sourceType: 'effect',
            visible: true,
            opacity: expect.any(Number),
            blendMode: expect.any(String),
            locked: false,
            transform: {
                offsetX: 0, offsetY: 0,
                scaleX: 1, scaleY: 1,
                rotation: 0,
                flipH: false, flipV: false
            },
            effect: { id: expect.any(String), name: expect.any(String), params: expect.any(Object) },
            media: null,
            drawing: null,
            children: [],
            mask: null
        })
    })

    test('serializes child effects on a layer', async ({ page }) => {
        await bootApp(page)
        await dismissOpenDialog(page)
        await page.evaluate(async () => {
            const layerId = window.layersApp._layers[0].id
            await window.layersApp._handleAddChildEffect(layerId, 'filter/blur')
        })
        await page.waitForTimeout(200)
        const snap = await page.evaluate(() => window.__buildSnapshot(window.layersApp))
        const layer = snap.layers[0]
        expect(layer.children.length).toBe(1)
        expect(layer.children[0]).toMatchObject({
            id: expect.stringMatching(/^layer-/),
            effectId: 'filter/blur',
            visible: true,
            params: expect.any(Object)
        })
    })

    test('layers array order is bottom-to-top', async ({ page }) => {
        await bootApp(page)
        await dismissOpenDialog(page)
        await page.evaluate(async () => {
            await window.layersApp._handleAddEffectLayer('synth/gradient')
        })
        await page.waitForTimeout(200)
        const ids = await page.evaluate(() => window.__buildSnapshot(window.layersApp).layers.map(l => l.id))
        const internal = await page.evaluate(() => window.layersApp._layers.map(l => l.id))
        expect(ids).toEqual(internal)
    })
})

test.describe('snapshot masks and selection', () => {
    test('serializes a layer mask with bounds and coverage', async ({ page }) => {
        await bootApp(page)
        await dismissOpenDialog(page)
        await page.evaluate(async () => {
            const layerId = window.layersApp._layers[0].id
            await window.layersApp._addLayerMask(layerId)
        })
        await page.waitForTimeout(200)
        const snap = await page.evaluate(() => window.__buildSnapshot(window.layersApp))
        const layer = snap.layers[0]
        expect(layer.mask).toMatchObject({
            enabled: true,
            visible: expect.any(Boolean),
            width: expect.any(Number),
            height: expect.any(Number),
            coverage: expect.any(Number),
            bounds: expect.objectContaining({
                x: expect.any(Number),
                y: expect.any(Number),
                width: expect.any(Number),
                height: expect.any(Number)
            })
        })
        // A fresh mask is fully white => coverage = 1
        expect(layer.mask.coverage).toBeCloseTo(1, 1)
    })

    test('serializes a rectangle selection', async ({ page }) => {
        await bootApp(page)
        await dismissOpenDialog(page)
        await page.evaluate(() => {
            window.layersApp._selectionManager._selectionPath = {
                type: 'rect', x: 10, y: 20, width: 100, height: 200
            }
            window.layersApp._selectionManager._drawMarchingAnts()
        })
        const snap = await page.evaluate(() => window.__buildSnapshot(window.layersApp))
        expect(snap.selection).toMatchObject({
            kind: 'rectangle',
            bounds: { x: 10, y: 20, width: 100, height: 200 },
            isEmpty: false
        })
    })

    test('snapshot.selection is null when no selection', async ({ page }) => {
        await bootApp(page)
        await dismissOpenDialog(page)
        const snap = await page.evaluate(() => window.__buildSnapshot(window.layersApp))
        expect(snap.selection).toBeNull()
    })

    test('serializes a wand selection with computed bounds', async ({ page }) => {
        await bootApp(page)
        await dismissOpenDialog(page)
        await page.evaluate(() => {
            // Build a small ImageData with a 2x2 white blob at (3,4) on a 16x16 canvas
            const img = new ImageData(16, 16)
            for (let y = 4; y < 6; y++) {
                for (let x = 3; x < 5; x++) {
                    const idx = (y * 16 + x) * 4
                    img.data[idx] = 255
                    img.data[idx + 1] = 255
                    img.data[idx + 2] = 255
                    img.data[idx + 3] = 255
                }
            }
            window.layersApp._selectionManager._selectionPath = { type: 'wand', mask: img }
        })
        const snap = await page.evaluate(() => window.__buildSnapshot(window.layersApp))
        expect(snap.selection).not.toBeNull()
        expect(snap.selection.kind).toBe('wand')
        expect(snap.selection.bounds).toEqual({ x: 3, y: 4, width: 2, height: 2 })
    })

    test('serializes a mask (color-range) selection with computed bounds', async ({ page }) => {
        await bootApp(page)
        await dismissOpenDialog(page)
        await page.evaluate(() => {
            const img = new ImageData(8, 8)
            for (let y = 1; y < 4; y++) {
                for (let x = 2; x < 7; x++) {
                    const idx = (y * 8 + x) * 4
                    img.data[idx] = 255
                    img.data[idx + 1] = 255
                    img.data[idx + 2] = 255
                    img.data[idx + 3] = 255
                }
            }
            window.layersApp._selectionManager._selectionPath = { type: 'mask', data: img }
        })
        const snap = await page.evaluate(() => window.__buildSnapshot(window.layersApp))
        expect(snap.selection).not.toBeNull()
        expect(snap.selection.kind).toBe('color-range')
        expect(snap.selection.bounds).toEqual({ x: 2, y: 1, width: 5, height: 3 })
    })
})
