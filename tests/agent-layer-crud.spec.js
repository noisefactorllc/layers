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
})

test.describe('duplicateLayer', () => {
    test('clones a layer and selects the copy', async ({ page }) => {
        await bootApp(page)
        const targetId = await page.evaluate(() => window.layersApp._layers[0].id)
        const env = await page.evaluate((id) =>
            window.LayersAgent.duplicateLayer({ layerId: id }), targetId)
        expect(env.ok).toBe(true)
        expect(env.result.layerId).toMatch(/^layer-/)
        expect(env.result.layerId).not.toBe(targetId)
        const after = await page.evaluate(() => window.layersApp._layers.length)
        expect(after).toBe(2)
    })

    test('duplicateLayer returns NOT_FOUND_LAYER for missing id', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() =>
            window.LayersAgent.duplicateLayer({ layerId: 'layer-nope' }))
        expect(env.ok).toBe(false)
        expect(env.error.code).toBe('NOT_FOUND_LAYER')
    })

    test('duplicating a text layer keeps the copy an editable text layer', async ({ page }) => {
        await bootApp(page)
        const added = await page.evaluate(() =>
            window.LayersAgent.addLayer({ kind: 'text', text: 'Hello' }))
        expect(added.ok).toBe(true)

        const env = await page.evaluate((id) =>
            window.LayersAgent.duplicateLayer({ layerId: id }), added.result.layerId)
        expect(env.ok).toBe(true)
        expect(env.result.layerId).not.toBe(added.result.layerId)

        const copy = env.state.layers.find(l => l.id === env.result.layerId)
        expect(copy.sourceType).toBe('effect')
        expect(copy.effect.id).toBe('filter/text')
        expect(copy.effect.params.text).toBe('Hello')

        // The copy sits directly above the source layer
        const layerIds = env.state.layers.map(l => l.id)
        expect(layerIds.indexOf(env.result.layerId))
            .toBe(layerIds.indexOf(added.result.layerId) + 1)

        const edited = await page.evaluate((id) =>
            window.LayersAgent.setLayerEffectParams({
                layerId: id, params: { text: 'World' },
            }), env.result.layerId)
        expect(edited.ok).toBe(true)
        const editedCopy = edited.state.layers.find(l => l.id === env.result.layerId)
        expect(editedCopy.effect.params.text).toBe('World')

        const original = edited.state.layers.find(l => l.id === added.result.layerId)
        expect(original.effect.params.text).toBe('Hello')
    })

    test('duplicating a text layer works while a collab session is online', async ({ page }) => {
        await bootApp(page)
        const result = await page.evaluate(async () => {
            const added = await window.LayersAgent.addLayer({ kind: 'text', text: 'Hello' })
            window.layersApp._onlineAdapter = {
                isOnline: () => true,
                schedulePublish: () => {},
            }
            const env = await window.LayersAgent.duplicateLayer({
                layerId: added.result.layerId,
            })
            window.layersApp._onlineAdapter = null
            return { added, env }
        })
        expect(result.env.error ?? null).toBe(null)
        expect(result.env.ok).toBe(true)
        const copy = result.env.state.layers.find(l => l.id === result.env.result.layerId)
        expect(copy.effect.id).toBe('filter/text')
    })
})

test.describe('reorderLayer', () => {
    test('moves a layer to a new index', async ({ page }) => {
        await bootApp(page)
        await page.evaluate(async () => {
            await window.LayersAgent.addLayer({ kind: 'effect', effectId: 'synth/gradient' })
            await window.LayersAgent.addLayer({ kind: 'effect', effectId: 'synth/gradient' })
        })
        const ids = await page.evaluate(() => window.layersApp._layers.map(l => l.id))
        // Move a non-base layer from index 1 to the top (index 2).
        const env = await page.evaluate((id) =>
            window.LayersAgent.reorderLayer({ layerId: id, toIndex: 2 }), ids[1])
        expect(env.ok).toBe(true)
        const after = await page.evaluate(() => window.layersApp._layers.map(l => l.id))
        expect(after).toEqual([ids[0], ids[2], ids[1]])
    })

    test('protects the original base layer from agent reorder and delete', async ({ page }) => {
        await bootApp(page)
        await page.evaluate(async () => {
            await window.LayersAgent.addLayer({ kind: 'effect', effectId: 'synth/gradient' })
            await window.LayersAgent.addLayer({ kind: 'effect', effectId: 'synth/gradient' })
        })
        const before = await page.evaluate(() => window.layersApp._layers.map(l => l.id))

        const reordered = await page.evaluate((layerId) =>
            window.LayersAgent.reorderLayer({ layerId, toIndex: 2 }), before[0])
        expect(reordered.ok).toBe(false)
        expect(reordered.error.code).toBe('CONFLICT_BASE_LAYER')
        expect(await page.evaluate(() => window.layersApp._layers.map(l => l.id))).toEqual(before)

        const deleted = await page.evaluate((layerId) =>
            window.LayersAgent.deleteLayer({ layerId }), before[0])
        expect(deleted.ok).toBe(false)
        expect(deleted.error.code).toBe('CONFLICT_BASE_LAYER')
        expect(await page.evaluate((layerId) =>
            window.layersApp._layers.some(layer => layer.id === layerId), before[0])).toBe(true)
    })

    test('rejects placing a non-base layer at index zero in command and app paths', async ({ page }) => {
        await bootApp(page)
        await page.evaluate(async () => {
            await window.LayersAgent.addLayer({ kind: 'effect', effectId: 'synth/gradient' })
        })
        const before = await page.evaluate(() => window.layersApp._layers.map(l => l.id))

        const command = await page.evaluate((layerId) =>
            window.LayersAgent.reorderLayer({ layerId, toIndex: 0 }), before[1])
        expect(command.ok).toBe(false)
        expect(command.error.code).toBe('CONFLICT_BASE_LAYER')
        expect(await page.evaluate(() => window.layersApp._layers.map(l => l.id))).toEqual(before)

        const direct = await page.evaluate(async (layerId) => {
            const app = window.layersApp
            const outcome = await app._reorderLayer(layerId, 0)
            return {
                outcomeStatus: outcome?.status || null,
                layerIds: app._layers.map(layer => layer.id),
            }
        }, before[1])
        expect(direct.outcomeStatus).toBeNull()
        expect(direct.layerIds).toEqual(before)
    })

    test('reorderLayer rejects out-of-range toIndex', async ({ page }) => {
        await bootApp(page)
        const id = await page.evaluate(() => window.layersApp._layers[0].id)
        const env = await page.evaluate((layerId) =>
            window.LayersAgent.reorderLayer({ layerId, toIndex: 99 }), id)
        expect(env.ok).toBe(false)
        expect(env.error.code).toBe('INVALID_ARGS_RANGE')
    })

    test('reorderLayer returns NOT_FOUND_LAYER for missing id', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() =>
            window.LayersAgent.reorderLayer({ layerId: 'layer-nope', toIndex: 0 }))
        expect(env.ok).toBe(false)
        expect(env.error.code).toBe('NOT_FOUND_LAYER')
    })
})

test.describe('selectLayer / selectLayers', () => {
    test('selectLayer sets the active layer', async ({ page }) => {
        await bootApp(page)
        await page.evaluate(async () => {
            await window.LayersAgent.addLayer({ kind: 'effect', effectId: 'synth/gradient' })
        })
        const targetId = await page.evaluate(() => window.layersApp._layers[0].id)
        const env = await page.evaluate((id) =>
            window.LayersAgent.selectLayer({ layerId: id }), targetId)
        expect(env.ok).toBe(true)
        expect(env.state.activeLayerId).toBe(targetId)
        expect(env.state.selectedLayerIds).toEqual([targetId])
    })

    test('selectLayers sets multiple selected', async ({ page }) => {
        await bootApp(page)
        await page.evaluate(async () => {
            await window.LayersAgent.addLayer({ kind: 'effect', effectId: 'synth/gradient' })
        })
        const ids = await page.evaluate(() => window.layersApp._layers.map(l => l.id))
        const env = await page.evaluate((layerIds) =>
            window.LayersAgent.selectLayers({ layerIds }), ids)
        expect(env.ok).toBe(true)
        expect(env.state.selectedLayerIds.sort()).toEqual([...ids].sort())
    })

    test('selectLayer returns NOT_FOUND_LAYER for missing id', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() =>
            window.LayersAgent.selectLayer({ layerId: 'layer-nope' }))
        expect(env.ok).toBe(false)
        expect(env.error.code).toBe('NOT_FOUND_LAYER')
    })
})

test.describe('flatten/rasterize/flip', () => {
    test('online raster-producing commands report the media collaboration conflict', async ({ page }) => {
        await bootApp(page)
        const result = await page.evaluate(async () => {
            const app = window.layersApp
            await window.LayersAgent.addLayer({
                kind: 'effect', effectId: 'synth/gradient', name: 'Second',
            })
            const ids = app._layers.map(layer => layer.id)
            const before = JSON.stringify(app._layers)
            const dslBefore = app._renderer.currentDsl
            const resourcesBefore = [...app._renderer._mediaTextures.keys()]
            app._onlineAdapter = { isOnline: () => true }
            const envelopes = await Promise.all([
                window.LayersAgent.duplicateLayer({ layerId: ids[1] }),
                window.LayersAgent.flattenImage({}),
                window.LayersAgent.flattenLayers({ layerIds: ids }),
                window.LayersAgent.rasterizeLayer({ layerId: ids[0] }),
            ])
            return {
                codes: envelopes.map(envelope => envelope.error?.code),
                before,
                after: JSON.stringify(app._layers),
                dslBefore,
                dslAfter: app._renderer.currentDsl,
                resourcesBefore,
                resourcesAfter: [...app._renderer._mediaTextures.keys()],
            }
        })

        expect(result.codes).toEqual(Array(4).fill('CONFLICT_MEDIA_BLOCKED_ONLINE'))
        expect(result.after).toBe(result.before)
        expect(result.dslAfter).toBe(result.dslBefore)
        expect(result.resourcesAfter).toEqual(result.resourcesBefore)
    })

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

for (const operation of ['add child', 'remove child', 'delete layer']) {
    test(`${operation} stays successful when its post-commit toast throws`, async ({ page }) => {
        await bootApp(page)
        const result = await page.evaluate(async (operation) => {
            const app = window.layersApp
            const { toast } = await import('/js/ui/toast.js')
            const parent = app._layers[0]

            if (operation === 'add child') {
                toast.success = () => { throw new Error('injected child-add toast failure') }
                const envelope = await window.LayersAgent.addChildEffect({
                    layerId: parent.id,
                    effectId: 'filter/blur',
                })
                return {
                    envelope,
                    childPresent: parent.children.some(child =>
                        child.id === envelope.result?.childId),
                    sameRendererModel: app._renderer.layers === app._layers,
                }
            }

            const added = await window.LayersAgent.addChildEffect({
                layerId: parent.id,
                effectId: 'filter/blur',
            })
            if (operation === 'remove child') {
                toast.info = () => { throw new Error('injected child-delete toast failure') }
                const envelope = await window.LayersAgent.removeChildEffect({
                    layerId: parent.id,
                    childId: added.result.childId,
                })
                return {
                    envelope,
                    childPresent: parent.children.some(child =>
                        child.id === added.result.childId),
                    sameRendererModel: app._renderer.layers === app._layers,
                }
            }

            const top = await window.LayersAgent.addLayer({
                kind: 'effect', effectId: 'synth/gradient', name: 'Delete me',
            })
            const rasterized = await window.LayersAgent.rasterizeLayer({
                layerId: top.result.layerId,
            })
            const layerId = rasterized.result.layerId
            const resourceBefore = app._renderer.getMediaInfo(layerId)
            toast.info = () => { throw new Error('injected layer-delete toast failure') }
            const envelope = await window.LayersAgent.deleteLayer({ layerId })
            return {
                envelope,
                layerPresent: app._layers.some(layer => layer.id === layerId),
                resourceBefore: Boolean(resourceBefore),
                resourcePresent: Boolean(app._renderer.getMediaInfo(layerId)),
                sameRendererModel: app._renderer.layers === app._layers,
            }
        }, operation)

        expect(result.envelope.ok).toBe(true)
        expect(result.sameRendererModel).toBe(true)
        if (operation === 'add child') expect(result.childPresent).toBe(true)
        if (operation === 'remove child') expect(result.childPresent).toBe(false)
        if (operation === 'delete layer') {
            expect(result.layerPresent).toBe(false)
            expect(result.resourceBefore).toBe(true)
            expect(result.resourcePresent).toBe(false)
        }
    })
}
