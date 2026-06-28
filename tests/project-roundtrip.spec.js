import { test, expect } from 'playwright/test'

// Round-trip regression tests for save -> reload page -> load.
// Reloading the page is the realistic round-trip: it gives a fresh renderer
// with empty texture maps, so the load path must rebuild GPU resources itself.
// Guards two bugs:
//  1. saveProject left a live drawingCanvas on drawing layers -> IndexedDB
//     structured clone threw DataCloneError, so saving any drawn layer failed.
//  2. _loadProject did not re-rasterize drawing strokes or re-upload mask
//     textures (unlike undo's _restoreState), so drawings/masks went blank
//     after a load on a fresh renderer.

async function waitReady(page) {
    await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })
    await page.evaluate(async () => { await window.LayersAgent.ready })
}

async function bootFromOpenDialog(page, type) {
    await page.goto('/', { waitUntil: 'networkidle' })
    await waitReady(page)
    await page.waitForSelector('.open-dialog-backdrop.visible')
    await page.click(`.media-option[data-type="${type}"]`)
    await page.waitForSelector('.canvas-size-dialog', { timeout: 5000 })
    await page.click('.canvas-size-dialog .action-btn.primary')
    await page.waitForSelector('.open-dialog-backdrop.visible', { state: 'hidden', timeout: 5000 })
    await page.waitForTimeout(500)
}

// Reload the page (fresh renderer) and open a saved project by id.
async function reloadAndOpen(page, projectId) {
    await page.goto('/', { waitUntil: 'networkidle' })
    await waitReady(page)
    const opened = await page.evaluate((id) =>
        window.LayersAgent.openProject({ projectId: id }), projectId)
    expect(opened.ok).toBe(true)
    return opened
}

test.describe('Project save/load round-trip', () => {
    test('drawing layer saves without DataCloneError and re-renders on load', async ({ page }) => {
        await bootFromOpenDialog(page, 'transparent')

        // Add a drawing layer with a red stroke and rasterize it.
        await page.evaluate(async () => {
            const app = window.layersApp
            const { createDrawingLayer } = await import('/js/layers/layer-model.js')
            const { createPathStroke } = await import('/js/drawing/stroke-model.js')
            const layer = createDrawingLayer('RoundTrip Drawing')
            layer.strokes.push(createPathStroke({
                color: '#ff0000',
                size: 20,
                points: [{ x: 100, y: 100 }, { x: 200, y: 200 }, { x: 300, y: 100 }]
            }))
            app._layers.push(layer)
            await app._rasterizeDrawingLayer(layer)
            await app._rebuild({ force: true })
            app._updateLayerStack()
        })

        // Save — pre-fix this rejected with DataCloneError (live drawingCanvas).
        const saved = await page.evaluate(() =>
            window.LayersAgent.saveProjectAs({ name: 'drawing-roundtrip' }))
        expect(saved.ok).toBe(true)
        const projectId = saved.result.projectId
        expect(projectId).toBeTruthy()

        // Fresh page (empty renderer texture maps), then reload the saved project.
        await reloadAndOpen(page, projectId)

        // Strokes must survive the round-trip and re-render from strokes on load.
        const result = await page.evaluate(async () => {
            const app = window.layersApp
            app._renderer.render(0)
            await new Promise(r => setTimeout(r, 200))
            const canvas = document.getElementById('canvas')
            const gl = canvas.getContext('webgl2') || canvas.getContext('webgl')
            const pixels = new Uint8Array(4)
            gl.readPixels(150, canvas.height - 150, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixels)
            const drawing = app._layers.find(l => l.sourceType === 'drawing')
            return {
                strokeCount: drawing ? drawing.strokes.length : -1,
                red: pixels[0],
                alpha: pixels[3]
            }
        })
        expect(result.strokeCount).toBe(1)
        expect(result.red).toBeGreaterThan(100)
        expect(result.alpha).toBeGreaterThan(0)
    })

    test('layer mask re-uploads its texture on load', async ({ page }) => {
        await bootFromOpenDialog(page, 'solid')

        // Attach a mask to the base layer.
        const baseId = await page.evaluate(() => window.layersApp._layers[0].id)
        const masked = await page.evaluate((id) =>
            window.LayersAgent.addLayerMask({ layerId: id }), baseId)
        expect(masked.ok).toBe(true)

        const saved = await page.evaluate(() =>
            window.LayersAgent.saveProjectAs({ name: 'mask-roundtrip' }))
        expect(saved.ok).toBe(true)
        const projectId = saved.result.projectId

        await reloadAndOpen(page, projectId)

        // The mask ImageData round-trips AND its GPU texture is re-registered.
        const state = await page.evaluate((id) => {
            const app = window.layersApp
            const layer = app._layers.find(l => l.id === id)
            return {
                hasMaskData: !!(layer && layer.mask),
                maskTextureUploaded: app._renderer._maskTextures.has(id)
            }
        }, baseId)
        expect(state.hasMaskData).toBe(true)
        expect(state.maskTextureUploaded).toBe(true)
    })
})

test.describe('Project media cleanup', () => {
    test('deleting one project keeps another project\'s media blobs', async ({ page }) => {
        await page.goto('/', { waitUntil: 'networkidle' })
        await waitReady(page)

        const result = await page.evaluate(async () => {
            const ps = await import('/js/utils/project-storage.js')

            async function mediaFile(color, name) {
                const c = document.createElement('canvas')
                c.width = 2; c.height = 2
                const ctx = c.getContext('2d')
                ctx.fillStyle = color
                ctx.fillRect(0, 0, 2, 2)
                const blob = await new Promise(r => c.toBlob(r, 'image/png'))
                return new File([blob], name, { type: 'image/png' })
            }

            // Two projects, each with a distinct media blob (different content hash).
            const idA = await ps.saveProject({
                name: 'cleanup-A', canvasWidth: 2, canvasHeight: 2,
                layers: [{ id: 'la', sourceType: 'media', mediaFile: await mediaFile('#ff0000', 'a.png'), mediaType: 'image' }]
            })
            const idB = await ps.saveProject({
                name: 'cleanup-B', canvasWidth: 2, canvasHeight: 2,
                layers: [{ id: 'lb', sourceType: 'media', mediaFile: await mediaFile('#00ff00', 'b.png'), mediaType: 'image' }]
            })

            // Deleting A must not purge B's media (the cross-project wipe bug).
            await ps.deleteProject(idA)

            const loadedB = await ps.loadProject(idB)
            return { mediaCountB: loadedB ? loadedB.mediaFiles.size : -1 }
        })

        expect(result.mediaCountB).toBe(1)
    })
})

test.describe('Drawing texture cleanup', () => {
    test('deleting a drawing layer frees its renderer texture entry', async ({ page }) => {
        await bootFromOpenDialog(page, 'transparent')

        const result = await page.evaluate(async () => {
            const app = window.layersApp
            const { createDrawingLayer } = await import('/js/layers/layer-model.js')
            const { createPathStroke } = await import('/js/drawing/stroke-model.js')
            const layer = createDrawingLayer('Temp Drawing')
            layer.strokes.push(createPathStroke({
                color: '#ff0000', size: 10,
                points: [{ x: 10, y: 10 }, { x: 50, y: 50 }]
            }))
            app._layers.push(layer)
            await app._rasterizeDrawingLayer(layer)
            await app._rebuild({ force: true })
            app._updateLayerStack()

            const hadTexture = app._renderer._mediaTextures.has(layer.id)
            await app._handleDeleteLayer(layer.id)
            const stillHasTexture = app._renderer._mediaTextures.has(layer.id)
            return { hadTexture, stillHasTexture }
        })

        expect(result.hadTexture).toBe(true)
        expect(result.stillHasTexture).toBe(false)
    })
})
