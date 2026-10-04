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

test.describe('deleteLayer', () => {
    test('removes a layer by id', async ({ page }) => {
        await bootApp(page)
        await page.evaluate(async () => {
            await window.LayersAgent.addLayer({ kind: 'effect', effectId: 'synth/gradient' })
        })
        const before = await page.evaluate(() => window.layersApp._layers.length)
        const targetId = await page.evaluate(() => window.layersApp._layers[1].id)
        const env = await page.evaluate((id) =>
            window.LayersAgent.deleteLayer({ layerId: id }), targetId)
        expect(env.ok).toBe(true)
        const after = await page.evaluate(() => window.layersApp._layers.length)
        expect(after).toBe(before - 1)
        expect(env.state.layers.find(l => l.id === targetId)).toBeUndefined()
    })

    test('deleting the selected layer leaves a valid active selection', async ({ page }) => {
        await bootApp(page)
        const added = await page.evaluate(() => window.LayersAgent.addLayer({
            kind: 'effect', effectId: 'synth/gradient',
        }))
        const env = await page.evaluate((layerId) =>
            window.LayersAgent.deleteLayer({ layerId }), added.result.layerId)

        expect(env.ok).toBe(true)
        expect(env.state.selectedLayerIds).toEqual([env.state.activeLayerId])
        expect(env.state.layers.some(layer => layer.id === env.state.activeLayerId)).toBe(true)
    })

    test('deleting one selected layer preserves other surviving selections', async ({ page }) => {
        await bootApp(page)
        const result = await page.evaluate(async () => {
            const first = await window.LayersAgent.addLayer({
                kind: 'effect', effectId: 'synth/gradient',
            })
            const second = await window.LayersAgent.addLayer({
                kind: 'effect', effectId: 'synth/solid',
            })
            await window.LayersAgent.selectLayers({
                layerIds: [first.result.layerId, second.result.layerId],
            })
            const deleted = await window.LayersAgent.deleteLayer({
                layerId: first.result.layerId,
            })
            return { deleted, survivorId: second.result.layerId }
        })

        expect(result.deleted.ok).toBe(true)
        expect(result.deleted.state.selectedLayerIds).toEqual([result.survivorId])
        expect(result.deleted.state.activeLayerId).toBe(result.survivorId)
    })

    test('deleting the selected child selects its parent', async ({ page }) => {
        await bootApp(page)
        const result = await page.evaluate(async () => {
            const app = window.layersApp
            const parent = app._layers[0]
            const added = await window.LayersAgent.addChildEffect({
                layerId: parent.id,
                effectId: 'filter/blur',
            })
            const removed = await window.LayersAgent.removeChildEffect({
                layerId: parent.id,
                childId: added.result.childId,
            })
            return { removed, parentId: parent.id }
        })

        expect(result.removed.ok).toBe(true)
        expect(result.removed.state.selectedLayerIds).toEqual([result.parentId])
        expect(result.removed.state.activeLayerId).toBe(result.parentId)
    })

    test('undo and redo of a selected addition keep selection inside the model', async ({ page }) => {
        await bootApp(page)
        const result = await page.evaluate(async () => {
            const added = await window.LayersAgent.addLayer({
                kind: 'effect', effectId: 'synth/gradient',
            })
            const undone = await window.LayersAgent.undo()
            const redone = await window.LayersAgent.redo()
            return { addedId: added.result.layerId, undone, redone }
        })

        expect(result.undone.ok).toBe(true)
        expect(result.undone.state.layers.some(layer =>
            layer.id === result.undone.state.activeLayerId)).toBe(true)
        expect(result.undone.state.selectedLayerIds).toEqual([
            result.undone.state.activeLayerId,
        ])
        expect(result.redone.ok).toBe(true)
        expect(result.redone.state.activeLayerId).toBe(result.addedId)
        expect(result.redone.state.selectedLayerIds).toEqual([result.addedId])
    })

    test('deleteLayer returns NOT_FOUND_LAYER for missing id', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() =>
            window.LayersAgent.deleteLayer({ layerId: 'layer-nope' }))
        expect(env.ok).toBe(false)
        expect(env.error.code).toBe('NOT_FOUND_LAYER')
    })

    test('texture disposal on layer delete frees WebGL textures from GPU memory', async ({ page }) => {
        await bootApp(page)
        const result = await page.evaluate(async () => {
            const app = window.layersApp
            const renderer = app._renderer
            const backend = renderer._renderer.pipeline?.backend
            const gl = backend?.gl

            // 1. Add an image media layer with a mask
            const canvas = document.createElement('canvas')
            canvas.width = 64
            canvas.height = 64
            const ctx = canvas.getContext('2d')
            ctx.fillStyle = '#ff0000'
            ctx.fillRect(0, 0, 64, 64)
            const base64Data = canvas.toDataURL('image/png').split(',')[1]

            const mediaAdded = await window.LayersAgent.addLayer({
                kind: 'media',
                mediaType: 'image',
                source: { kind: 'base64', data: base64Data, mimeType: 'image/png' },
            })
            if (!mediaAdded.ok) throw new Error(mediaAdded.error?.message || 'Failed to add media')
            const mediaLayerId = mediaAdded.result.layerId
            const mediaStepIndex = renderer._layerStepMap.get(mediaLayerId)
            const mediaTexId = `imageTex_step_${mediaStepIndex}`
            const mediaTexHandle = backend?.textures?.get(mediaTexId)?.handle

            const maskAdded = await window.LayersAgent.addLayerMask({ layerId: mediaLayerId })
            if (!maskAdded.ok) throw new Error(maskAdded.error?.message || 'Failed to add mask')
            const maskStepIndex = renderer._layerStepMap.get(`mask_${mediaLayerId}`)
            const maskTexId = `imageTex_step_${maskStepIndex}`
            const maskTexHandle = backend?.textures?.get(maskTexId)?.handle

            const beforeMediaValid = gl ? gl.isTexture(mediaTexHandle) : Boolean(mediaTexHandle)
            const beforeMaskValid = gl ? gl.isTexture(maskTexHandle) : Boolean(maskTexHandle)

            // Delete mask and verify mask texture is freed
            await window.LayersAgent.deleteLayerMask({ layerId: mediaLayerId })
            const afterMaskDeleted_isGlTexture = gl ? gl.isTexture(maskTexHandle) : false
            const afterMaskDeleted_inBackend = backend?.textures?.has(maskTexId) ?? false
            const afterMaskDeleted_inMaskTextures = renderer._maskTextures.has(mediaLayerId)

            // Delete media layer and verify media texture is freed
            await window.LayersAgent.deleteLayer({ layerId: mediaLayerId })
            const afterMediaDeleted_isGlTexture = gl ? gl.isTexture(mediaTexHandle) : false
            const afterMediaDeleted_inBackend = backend?.textures?.has(mediaTexId) ?? false
            const afterMediaDeleted_inMediaTextures = renderer._mediaTextures.has(mediaLayerId)

            // 2. Add a text layer
            const textAdded = await window.LayersAgent.addLayer({
                kind: 'text',
                text: 'Disposal Test',
            })
            if (!textAdded.ok) throw new Error(textAdded.error?.message || 'Failed to add text')
            const textLayerId = textAdded.result.layerId
            const textStepIndex = renderer._layerStepMap.get(textLayerId)
            const textTexId = `textTex_step_${textStepIndex}`
            const textTexHandle = backend?.textures?.get(textTexId)?.handle
            const beforeTextValid = gl ? gl.isTexture(textTexHandle) : Boolean(textTexHandle)

            // Delete text layer and verify text texture is freed
            await window.LayersAgent.deleteLayer({ layerId: textLayerId })
            const afterTextDeleted_isGlTexture = gl ? gl.isTexture(textTexHandle) : false
            const afterTextDeleted_inBackend = backend?.textures?.has(textTexId) ?? false
            const afterTextDeleted_inTextCanvases = renderer._textCanvases.has(textLayerId)

            // 3. Add a multi-pass filter effect layer (blur has intermediate node passes)
            const blurAdded = await window.LayersAgent.addLayer({
                kind: 'effect',
                effectId: 'filter/blur',
            })
            if (!blurAdded.ok) throw new Error(blurAdded.error?.message || 'Failed to add blur')
            const blurLayerId = blurAdded.result.layerId
            renderer.render(0)

            const blurPasses = renderer._renderer.pipeline?.graph?.passes || []
            const intermediateNodes = []
            for (const pass of blurPasses) {
                if (pass.outputs) {
                    for (const outId of Object.values(pass.outputs)) {
                        if (typeof outId === 'string' && outId.startsWith('node_') && outId !== 'node_0_out') {
                            intermediateNodes.push(outId)
                        }
                    }
                }
            }
            const beforeBlurNodesPresent = intermediateNodes.length > 0 &&
                intermediateNodes.every(id => backend?.textures?.has(id))

            // Delete blur layer and verify intermediate node textures are freed
            await window.LayersAgent.deleteLayer({ layerId: blurLayerId })
            const afterBlurDeleted_nodesRemaining = intermediateNodes.filter(id => backend?.textures?.has(id))

            const renderSucceeded = (() => {
                try {
                    renderer.render(0)
                    return true
                } catch (e) {
                    return false
                }
            })()

            return {
                beforeMediaValid,
                beforeMaskValid,
                afterMaskDeleted_isGlTexture,
                afterMaskDeleted_inBackend,
                afterMaskDeleted_inMaskTextures,
                afterMediaDeleted_isGlTexture,
                afterMediaDeleted_inBackend,
                afterMediaDeleted_inMediaTextures,
                beforeTextValid,
                afterTextDeleted_isGlTexture,
                afterTextDeleted_inBackend,
                afterTextDeleted_inTextCanvases,
                beforeBlurNodesPresent,
                intermediateNodes,
                afterBlurDeleted_nodesRemaining,
                renderSucceeded,
            }
        })

        expect(result.beforeMediaValid).toBe(true)
        expect(result.beforeMaskValid).toBe(true)
        expect(result.afterMaskDeleted_isGlTexture).toBe(false)
        expect(result.afterMaskDeleted_inBackend).toBe(false)
        expect(result.afterMaskDeleted_inMaskTextures).toBe(false)
        expect(result.afterMediaDeleted_isGlTexture).toBe(false)
        expect(result.afterMediaDeleted_inBackend).toBe(false)
        expect(result.afterMediaDeleted_inMediaTextures).toBe(false)

        expect(result.beforeTextValid).toBe(true)
        expect(result.afterTextDeleted_isGlTexture).toBe(false)
        expect(result.afterTextDeleted_inBackend).toBe(false)
        expect(result.afterTextDeleted_inTextCanvases).toBe(false)

        expect(result.beforeBlurNodesPresent).toBe(true)
        expect(result.afterBlurDeleted_nodesRemaining).toHaveLength(0)

        expect(result.renderSucceeded).toBe(true)
    })
})

test.describe('flatten/rasterize/flip', () => {
    for (const command of ['duplicateLayer', 'flattenImage', 'flattenLayers', 'rasterizeLayer']) {
        test(`online ${command} produces a shareable image`, async ({ page }) => {
            await bootApp(page)
            const result = await page.evaluate(async command => {
                const app = window.layersApp
                await window.LayersAgent.addLayer({
                    kind: 'effect', effectId: 'synth/gradient', name: 'Second',
                })
                const ids = app._layers.map(layer => layer.id)
                app._onlineAdapter = { isOnline: () => true, schedulePublish() {} }
                const envelope = await window.LayersAgent[command]({ layerId: ids[1], layerIds: ids })
                const selected = app._layers.find(layer => layer.id === app._layerStack.selectedLayerId)
                return {
                    envelope,
                    mediaType: selected?.mediaType,
                    hasOriginal: selected?.mediaFile instanceof File,
                    hasResource: app._renderer._mediaTextures.has(selected?.id),
                }
            }, command)

            expect(result.envelope.ok).toBe(true)
            expect(result.mediaType).toBe('image')
            expect(result.hasOriginal).toBe(true)
            expect(result.hasResource).toBe(true)
        })
    }

    test('flattenImage collapses to one media layer', async ({ page }) => {
        await bootApp(page)
        await page.evaluate(async () => {
            await window.LayersAgent.addLayer({ kind: 'effect', effectId: 'synth/gradient' })
        })
        const before = await page.evaluate(() => window.layersApp._layers.length)
        expect(before).toBe(2)
        const env = await page.evaluate(() => window.LayersAgent.flattenImage())
        expect(env.ok).toBe(true)
        const after = await page.evaluate(() => window.layersApp._layers.length)
        expect(after).toBe(1)
        expect(env.state.layers[0].sourceType).toBe('media')
    })

    test('flattenLayers collapses a subset', async ({ page }) => {
        await bootApp(page)
        await page.evaluate(async () => {
            await window.LayersAgent.addLayer({ kind: 'effect', effectId: 'synth/gradient' })
            await window.LayersAgent.addLayer({ kind: 'effect', effectId: 'synth/gradient' })
        })
        const ids = await page.evaluate(() => window.layersApp._layers.slice(1, 3).map(l => l.id))
        const env = await page.evaluate((layerIds) =>
            window.LayersAgent.flattenLayers({ layerIds }), ids)
        expect(env.ok).toBe(true)
        const after = await page.evaluate(() => window.layersApp._layers.length)
        expect(after).toBe(2)
    })

    test('flattenLayers includes selected hidden layers instead of deleting their pixels', async ({ page }) => {
        await bootApp(page)
        const result = await page.evaluate(async () => {
            const app = window.layersApp
            const base = app._layers[0]
            await window.LayersAgent.setLayerEffectParams({
                layerId: base.id,
                params: { color: [0, 0, 0], alpha: 0 },
                replace: true,
            })
            const red = await window.LayersAgent.addLayer({
                kind: 'effect', effectId: 'synth/solid',
                params: { color: [1, 0, 0], alpha: 1 },
            })
            const green = await window.LayersAgent.addLayer({
                kind: 'effect', effectId: 'synth/solid',
                params: { color: [0, 1, 0], alpha: 1 },
            })
            for (const layerId of [red.result.layerId, green.result.layerId]) {
                await window.LayersAgent.setLayerProps({
                    layerId,
                    props: { visible: false },
                })
            }
            const flattened = await window.LayersAgent.flattenLayers({
                layerIds: [red.result.layerId, green.result.layerId],
            })
            app._renderCurrentFrame()
            const sample = new OffscreenCanvas(1, 1)
            const context = sample.getContext('2d')
            const x = Math.floor(app._canvas.width / 2)
            const y = Math.floor(app._canvas.height / 2)
            context.drawImage(app._canvas, x, y, 1, 1, 0, 0, 1, 1)
            return {
                flattened,
                pixel: [...context.getImageData(0, 0, 1, 1).data],
                names: app._layers.map(layer => layer.name),
            }
        })

        expect(result.flattened.ok).toBe(true)
        expect(result.pixel[0]).toBeLessThan(15)
        expect(result.pixel[1]).toBeGreaterThan(240)
        expect(result.pixel[2]).toBeLessThan(15)
        expect(result.pixel[3]).toBeGreaterThan(240)
        expect(result.names).not.toContain('solid')
    })

    test('flattenLayers rejects duplicate ids without changing layers or resources', async ({ page }) => {
        await bootApp(page)
        const result = await page.evaluate(async () => {
            const app = window.layersApp
            await window.LayersAgent.addLayer({
                kind: 'effect', effectId: 'synth/gradient', name: 'Second',
            })
            await window.LayersAgent.addLayer({
                kind: 'effect', effectId: 'synth/gradient', name: 'Third',
            })
            const duplicateId = app._layers[1].id
            const beforeLayers = app._layers
            const beforeLayerObjects = app._layers.slice()
            const beforeMedia = new Map(app._renderer._mediaTextures)
            const envelope = await window.LayersAgent.flattenLayers({
                layerIds: [duplicateId, duplicateId],
            })
            return {
                envelope,
                sameLayersArray: app._layers === beforeLayers,
                sameLayerObjects: app._layers.length === beforeLayerObjects.length
                    && beforeLayerObjects.every((layer, index) => app._layers[index] === layer),
                sameMediaResources: beforeMedia.size === app._renderer._mediaTextures.size
                    && [...beforeMedia].every(([id, resource]) =>
                        app._renderer._mediaTextures.get(id) === resource),
            }
        })

        expect(result.envelope.ok).toBe(false)
        expect(result.envelope.error.code).toBe('INVALID_ARGS_RANGE')
        expect(result.sameLayersArray).toBe(true)
        expect(result.sameLayerObjects).toBe(true)
        expect(result.sameMediaResources).toBe(true)
    })

    test('rasterizeLayer converts effect to media', async ({ page }) => {
        await bootApp(page)
        const id = await page.evaluate(() => window.layersApp._layers[0].id)
        const env = await page.evaluate((layerId) =>
            window.LayersAgent.rasterizeLayer({ layerId }), id)
        expect(env.ok).toBe(true)
        expect(env.result.layerId).toBe(id)
        const layer = env.state.layers.find(l => l.id === id)
        expect(layer).toBeDefined()
        expect(layer.sourceType).toBe('media')
    })

    test('flipLayer toggles flipH', async ({ page }) => {
        await bootApp(page)
        // Need a media layer; rasterize the default solid first.
        const id = await page.evaluate(() => window.layersApp._layers[0].id)
        await page.evaluate((layerId) =>
            window.LayersAgent.rasterizeLayer({ layerId }), id)
        const mediaId = await page.evaluate(() => window.layersApp._layers[0].id)
        const env = await page.evaluate((layerId) =>
            window.LayersAgent.flipLayer({ layerId, axis: 'h' }), mediaId)
        expect(env.ok).toBe(true)
        const layer = env.state.layers.find(l => l.id === mediaId)
        expect(layer.transform.flipH).toBe(true)
    })

    test('rasterizeLayer NOT_FOUND_LAYER for missing id', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() =>
            window.LayersAgent.rasterizeLayer({ layerId: 'layer-nope' }))
        expect(env.ok).toBe(false)
        expect(env.error.code).toBe('NOT_FOUND_LAYER')
    })
})
