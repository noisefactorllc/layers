import { test, expect } from './fixtures.js'
import { reopenNewProjectDialog } from './helpers/new-project.js'

async function bootApp(page) {
    await page.goto('/', { waitUntil: 'networkidle' })
    await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })
    await page.evaluate(async () => { await window.LayersAgent.ready })
    await reopenNewProjectDialog(page)
    await page.click('.media-option[data-type="solid"]')
    await page.waitForSelector('.canvas-size-dialog', { timeout: 5000 })
    // 512 preset: quarters the composited frame cost on software-rendered CI
    // shards (same capacity trim as the other dialog-booting agent suites);
    // this suite reads no absolute canvas coordinates.
    await page.click('.size-preset[data-width="512"]')
    await page.click('.canvas-size-dialog .action-btn.primary')
    await page.waitForSelector('.open-dialog-backdrop.visible', { state: 'hidden', timeout: 5000 })
}

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

    test('duplicating layers assigns unique Photoshop-style copy names', async ({ page }) => {
        await bootApp(page)
        const baseLayer = await page.evaluate(() => window.layersApp._layers[0])
        const baseName = baseLayer.name

        // First duplicate of base layer -> "Base copy"
        const firstDup = await page.evaluate((id) =>
            window.LayersAgent.duplicateLayer({ layerId: id }), baseLayer.id)
        expect(firstDup.ok).toBe(true)
        const firstCopy = firstDup.state.layers.find(l => l.id === firstDup.result.layerId)
        expect(firstCopy.name).toBe(`${baseName} copy`)

        // Second duplicate of base layer -> "Base copy 2"
        const secondDup = await page.evaluate((id) =>
            window.LayersAgent.duplicateLayer({ layerId: id }), baseLayer.id)
        expect(secondDup.ok).toBe(true)
        const secondCopy = secondDup.state.layers.find(l => l.id === secondDup.result.layerId)
        expect(secondCopy.name).toBe(`${baseName} copy 2`)

        // Duplicate the first copy ("Base copy") -> "Base copy 3"
        const thirdDup = await page.evaluate((id) =>
            window.LayersAgent.duplicateLayer({ layerId: id }), firstCopy.id)
        expect(thirdDup.ok).toBe(true)
        const thirdCopy = thirdDup.state.layers.find(l => l.id === thirdDup.result.layerId)
        expect(thirdCopy.name).toBe(`${baseName} copy 3`)
    })

    test('Cmd+J keyboard shortcut duplicates active layer and selects the duplicate', async ({ page }) => {
        await bootApp(page)
        const initialCount = await page.evaluate(() => window.layersApp._layers.length)
        const baseLayer = await page.evaluate(() => window.layersApp._layers[0])

        // Ensure base layer is selected
        await page.evaluate((id) => {
            window.layersApp._layerStack.selectedLayerIds = [id]
            window.layersApp._layerStack.selectedLayerId = id
        }, baseLayer.id)

        // Press Meta+j (Mac) or Control+j
        await page.keyboard.press('Meta+j')
        await page.waitForFunction(
            (expected) => window.layersApp._layers.length === expected,
            initialCount + 1,
            { timeout: 5000 }
        )

        const layers = await page.evaluate(() => window.layersApp._layers)
        expect(layers.length).toBe(initialCount + 1)

        // The new layer should be selected
        const selectedId = await page.evaluate(() => window.layersApp._layerStack?.selectedLayerId)
        const newLayer = layers.find(l => l.id === selectedId)
        expect(newLayer).toBeTruthy()
        expect(newLayer.name).toBe(`${baseLayer.name} copy`)
    })

    test('Cmd+J does not duplicate layer when focused in input', async ({ page }) => {
        await bootApp(page)
        const initialCount = await page.evaluate(() => window.layersApp._layers.length)

        // Create and focus a temporary input
        await page.evaluate(() => {
            const input = document.createElement('input')
            input.id = 'test-temp-input'
            document.body.appendChild(input)
            input.focus()
        })

        await page.keyboard.press('Meta+j')
        // Give time for any unexpected event handling
        await page.waitForTimeout(300)

        const finalCount = await page.evaluate(() => {
            document.getElementById('test-temp-input')?.remove()
            return window.layersApp._layers.length
        })
        expect(finalCount).toBe(initialCount)
    })

    test('duplicateLayer menu item displays ⌘J shortcut accelerator', async ({ page }) => {
        await bootApp(page)
        const shortcut = await page.evaluate(() => {
            const menus = window.layersApp._menuBar?.config?.regions?.left || []
            for (const menu of menus) {
                const item = (menu.items || []).find(m => m.id === 'duplicateLayerMenuItem')
                if (item) return item.shortcut
            }
            return null
        })
        expect(shortcut).toBe('⌘J')
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
