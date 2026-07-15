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

test.describe('setLayerProps', () => {
    test('updates opacity', async ({ page }) => {
        await bootApp(page)
        const id = await page.evaluate(() => window.layersApp._layers[0].id)
        const env = await page.evaluate((layerId) =>
            window.LayersAgent.setLayerProps({ layerId, props: { opacity: 50 } }), id)
        expect(env.ok).toBe(true)
        const layer = env.state.layers.find(l => l.id === id)
        expect(layer.opacity).toBe(50)
    })

    test('updates visibility', async ({ page }) => {
        await bootApp(page)
        const id = await page.evaluate(() => window.layersApp._layers[0].id)
        const env = await page.evaluate((layerId) =>
            window.LayersAgent.setLayerProps({ layerId, props: { visible: false } }), id)
        expect(env.ok).toBe(true)
        const layer = env.state.layers.find(l => l.id === id)
        expect(layer.visible).toBe(false)
    })

    test('updates name and locked together', async ({ page }) => {
        await bootApp(page)
        const id = await page.evaluate(() => window.layersApp._layers[0].id)
        const env = await page.evaluate((layerId) =>
            window.LayersAgent.setLayerProps({ layerId, props: { name: 'Renamed', locked: true } }), id)
        expect(env.ok).toBe(true)
        const layer = env.state.layers.find(l => l.id === id)
        expect(layer.name).toBe('Renamed')
        expect(layer.locked).toBe(true)
    })

    test('rejects opacity out of range', async ({ page }) => {
        await bootApp(page)
        const id = await page.evaluate(() => window.layersApp._layers[0].id)
        const env = await page.evaluate((layerId) =>
            window.LayersAgent.setLayerProps({ layerId, props: { opacity: 250 } }), id)
        expect(env.ok).toBe(false)
        expect(env.error.code).toBe('INVALID_ARGS_RANGE')
    })

    test('returns NOT_FOUND_LAYER for missing id', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() =>
            window.LayersAgent.setLayerProps({ layerId: 'layer-nope', props: { opacity: 50 } }))
        expect(env.ok).toBe(false)
        expect(env.error.code).toBe('NOT_FOUND_LAYER')
    })

    test('job polling hides in-place layer props that fail to rebuild', async ({ page }) => {
        await bootApp(page)
        const result = await page.evaluate(async () => {
            const app = window.layersApp
            const layerId = app._layers[0].id
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
            const rebuild = app._rebuild.bind(app)
            let rebuildCount = 0
            let enteredRebuild
            let releaseRebuild
            const entered = new Promise(resolve => { enteredRebuild = resolve })
            const release = new Promise(resolve => { releaseRebuild = resolve })
            app._rebuild = async (...args) => {
                rebuildCount += 1
                if (rebuildCount !== 1) return rebuild(...args)
                enteredRebuild()
                await release
                return { success: false, error: 'injected props rebuild failure' }
            }

            const mutation = window.LayersAgent.setLayerProps({
                layerId,
                props: { opacity: 50 },
            })
            await entered
            const during = await readState()
            releaseRebuild()
            const envelope = await mutation
            const after = await readState()
            return { before, during, envelope, after }
        })

        expect(result.envelope.ok).toBe(false)
        expect(result.during).toEqual(result.before)
        expect(result.after).toEqual(result.before)
    })
})

test.describe('setLayerTransform', () => {
    test('updates offset, scale, rotation, flip', async ({ page }) => {
        await bootApp(page)
        // Convert solid to media so transforms apply.
        const initialId = await page.evaluate(() => window.layersApp._layers[0].id)
        await page.evaluate((id) =>
            window.LayersAgent.rasterizeLayer({ layerId: id }), initialId)
        const id = await page.evaluate(() => window.layersApp._layers[0].id)
        const env = await page.evaluate((layerId) =>
            window.LayersAgent.setLayerTransform({
                layerId,
                transform: {
                    offsetX: 10, offsetY: 20,
                    scaleX: 1.5, scaleY: 2,
                    rotation: 30,
                    flipH: true, flipV: false
                }
            }), id)
        expect(env.ok).toBe(true)
        const layer = env.state.layers.find(l => l.id === id)
        expect(layer.transform).toMatchObject({
            offsetX: 10, offsetY: 20,
            scaleX: 1.5, scaleY: 2,
            rotation: 30,
            flipH: true, flipV: false
        })
    })

    test('partial transform updates leave unspecified fields alone', async ({ page }) => {
        await bootApp(page)
        const id = await page.evaluate(() => window.layersApp._layers[0].id)
        await page.evaluate((layerId) =>
            window.LayersAgent.rasterizeLayer({ layerId }), id)
        const mediaId = await page.evaluate(() => window.layersApp._layers[0].id)
        const env = await page.evaluate((layerId) =>
            window.LayersAgent.setLayerTransform({ layerId, transform: { offsetX: 5 } }), mediaId)
        expect(env.ok).toBe(true)
        const layer = env.state.layers.find(l => l.id === mediaId)
        expect(layer.transform.offsetX).toBe(5)
        expect(layer.transform.offsetY).toBe(0)
        expect(layer.transform.scaleX).toBe(1)
    })

    test('drawing layer transforms update the live raster immediately', async ({ page }) => {
        await bootApp(page)
        const result = await page.evaluate(async () => {
            const app = window.layersApp
            const painted = await window.LayersAgent.paintStroke({
                points: [[10, 10], [50, 50], [100, 100]],
                size: 5,
                color: '#ff0000',
            })
            const layerId = painted.result.layerId
            const media = app._renderer.getMediaInfo(layerId)
            let transformCalls = 0
            const updateLayerTransform = app._renderer.updateLayerTransform
                .bind(app._renderer)
            app._renderer.updateLayerTransform = (...args) => {
                transformCalls++
                return updateLayerTransform(...args)
            }

            const envelope = await window.LayersAgent.setLayerTransform({
                layerId,
                transform: { scaleX: 0.5, scaleY: 0.5, flipH: true },
            })
            return {
                ok: envelope.ok,
                transformCalls,
                sourceSize: [media.width, media.height],
                transformedSize: media.transformCanvas
                    ? [media.transformCanvas.width, media.transformCanvas.height]
                    : null,
            }
        })

        expect(result.ok).toBe(true)
        expect(result.transformCalls).toBe(1)
        expect(result.transformedSize).toEqual([
            Math.ceil(result.sourceSize[0] * 0.5),
            Math.ceil(result.sourceSize[1] * 0.5),
        ])
    })

    test('effect layer transforms are rejected without mutating the layer', async ({ page }) => {
        await bootApp(page)
        const result = await page.evaluate(async () => {
            const layer = window.layersApp._layers[0]
            const before = {
                offsetX: layer.offsetX,
                scaleX: layer.scaleX,
                rotation: layer.rotation,
            }
            const envelope = await window.LayersAgent.setLayerTransform({
                layerId: layer.id,
                transform: { offsetX: 25, scaleX: 2, rotation: 30 },
            })
            return {
                envelope,
                before,
                after: {
                    offsetX: layer.offsetX,
                    scaleX: layer.scaleX,
                    rotation: layer.rotation,
                },
            }
        })

        expect(result.envelope.ok).toBe(false)
        expect(result.envelope.error.code).toBe('CONFLICT_NOT_TRANSFORMABLE_LAYER')
        expect(result.after).toEqual(result.before)
    })

    test('non-finite transform values are rejected without mutation', async ({ page }) => {
        await bootApp(page)
        const id = await page.evaluate(() => window.layersApp._layers[0].id)
        await page.evaluate((layerId) =>
            window.LayersAgent.rasterizeLayer({ layerId }), id)
        const result = await page.evaluate(async (layerId) => {
            const layer = window.layersApp._layers.find(candidate =>
                candidate.id === layerId)
            const before = { offsetX: layer.offsetX, rotation: layer.rotation }
            const envelope = await window.LayersAgent.setLayerTransform({
                layerId,
                transform: { offsetX: Infinity, rotation: -Infinity },
            })
            return {
                envelope,
                before,
                after: { offsetX: layer.offsetX, rotation: layer.rotation },
            }
        }, id)

        expect(result.envelope.ok).toBe(false)
        expect(result.envelope.error.code).toBe('INVALID_ARGS_TYPE')
        expect(result.after).toEqual(result.before)
    })

    test('oversized transformed rasters are rejected before allocation or mutation', async ({ page }) => {
        await bootApp(page)
        const id = await page.evaluate(() => window.layersApp._layers[0].id)
        await page.evaluate((layerId) =>
            window.LayersAgent.rasterizeLayer({ layerId }), id)
        const result = await page.evaluate(async (layerId) => {
            const app = window.layersApp
            const layer = app._layers.find(candidate => candidate.id === layerId)
            const before = {
                scaleX: layer.scaleX,
                scaleY: layer.scaleY,
                undoLength: app._undoManager._stack.length,
                undoIndex: app._undoManager._index,
                dirty: app._isDirty,
            }
            let drawCalls = 0
            app._renderer._drawTransformedMediaFrame = () => {
                drawCalls++
                const canvas = document.createElement('canvas')
                canvas.width = 1
                canvas.height = 1
                return canvas
            }
            const envelope = await window.LayersAgent.setLayerTransform({
                layerId,
                transform: { scaleX: 100, scaleY: 100 },
            })
            return {
                envelope,
                drawCalls,
                before,
                after: {
                    scaleX: layer.scaleX,
                    scaleY: layer.scaleY,
                    undoLength: app._undoManager._stack.length,
                    undoIndex: app._undoManager._index,
                    dirty: app._isDirty,
                },
            }
        }, id)

        expect(result.envelope.ok).toBe(false)
        expect(result.envelope.error.code).toBe('INVALID_ARGS_RANGE')
        expect(result.drawCalls).toBe(0)
        expect(result.after).toEqual(result.before)
    })

    test('NOT_FOUND_LAYER for missing id', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() =>
            window.LayersAgent.setLayerTransform({ layerId: 'layer-nope', transform: { offsetX: 0 } }))
        expect(env.ok).toBe(false)
        expect(env.error.code).toBe('NOT_FOUND_LAYER')
    })
})
