import { test, expect } from 'playwright/test'

test.describe('Child effects', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('/', { waitUntil: 'networkidle' })
        await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })

        // Create a solid color project
        await page.waitForSelector('.open-dialog-backdrop.visible')
        await page.click('.media-option[data-type="solid"]')
        await page.waitForSelector('.canvas-size-dialog', { timeout: 5000 })
        await page.click('.canvas-size-dialog .action-btn.primary')
        await page.waitForSelector('.open-dialog-backdrop.visible', { state: 'hidden', timeout: 5000 })
        await page.waitForTimeout(500)

        // Add an effect layer on top for testing
        await page.evaluate(async () => {
            await window.layersApp._handleAddEffectLayer('synth/gradient')
        })
        await page.waitForTimeout(500)
    })

    test('add child effect to a layer', async ({ page }) => {
        // Get the parent layer ID
        const parentId = await page.evaluate(() => window.layersApp._layers[1].id)

        // Verify no children initially
        const childrenBefore = await page.evaluate(() =>
            (window.layersApp._layers[1].children || []).length
        )
        expect(childrenBefore).toBe(0)

        // Add a child effect
        await page.evaluate(async (id) => {
            await window.layersApp._handleAddChildEffect(id, 'filter/blur')
        }, parentId)
        await page.waitForTimeout(500)

        // Verify child in children array
        const childrenAfter = await page.evaluate(() =>
            window.layersApp._layers[1].children.length
        )
        expect(childrenAfter).toBe(1)

        // Verify child has correct effect
        const childEffectId = await page.evaluate(() =>
            window.layersApp._layers[1].children[0].effectId
        )
        expect(childEffectId).toBe('filter/blur')

        // Verify child-layer element in DOM
        const childLayerCount = await page.locator('layer-item.child-layer').count()
        expect(childLayerCount).toBe(1)
    })

    test('child effect modifies DSL', async ({ page }) => {
        const parentId = await page.evaluate(() => window.layersApp._layers[1].id)

        // Capture DSL before adding child
        const dslBefore = await page.evaluate(() =>
            window.layersApp._renderer._currentDsl
        )

        // Add a blur child effect
        await page.evaluate(async (id) => {
            await window.layersApp._handleAddChildEffect(id, 'filter/blur')
        }, parentId)
        await page.waitForTimeout(500)

        // Capture DSL after adding child
        const dslAfter = await page.evaluate(() =>
            window.layersApp._renderer._currentDsl
        )

        // DSL should have changed
        expect(dslAfter).not.toBe(dslBefore)

        // DSL should contain the blur effect name
        expect(dslAfter).toContain('blur(')
    })

    test('child visibility toggle', async ({ page }) => {
        const parentId = await page.evaluate(() => window.layersApp._layers[1].id)

        // Add a blur child effect
        await page.evaluate(async (id) => {
            await window.layersApp._handleAddChildEffect(id, 'filter/blur')
        }, parentId)
        await page.waitForTimeout(500)

        // Verify DSL contains blur
        const dslWithChild = await page.evaluate(() =>
            window.layersApp._renderer._currentDsl
        )
        expect(dslWithChild).toContain('blur(')

        // Toggle child visibility off (mimicking what layer-item does:
        // it sets .visible directly, then emits a 'visibility' change event)
        const childId = await page.evaluate(() =>
            window.layersApp._layers[1].children[0].id
        )
        await page.evaluate(async ({ childId, parentId }) => {
            const parent = window.layersApp._layers.find(l => l.id === parentId)
            const child = parent.children.find(c => c.id === childId)
            child.visible = false
            await window.layersApp._handleLayerChange({
                layerId: childId,
                parentLayerId: parentId,
                property: 'visibility',
                value: false
            })
        }, { childId, parentId })
        await page.waitForTimeout(500)

        // DSL should no longer contain blur
        const dslHidden = await page.evaluate(() =>
            window.layersApp._renderer._currentDsl
        )
        expect(dslHidden).not.toContain('blur(')
    })

    test('delete child effect', async ({ page }) => {
        const parentId = await page.evaluate(() => window.layersApp._layers[1].id)

        // Add a blur child effect
        await page.evaluate(async (id) => {
            await window.layersApp._handleAddChildEffect(id, 'filter/blur')
        }, parentId)
        await page.waitForTimeout(500)

        // Verify child exists
        expect(await page.evaluate(() =>
            window.layersApp._layers[1].children.length
        )).toBe(1)
        expect(await page.locator('layer-item.child-layer').count()).toBe(1)

        // Delete the child effect
        const childId = await page.evaluate(() =>
            window.layersApp._layers[1].children[0].id
        )
        await page.evaluate(async ({ childId, parentId }) => {
            await window.layersApp._handleDeleteLayer(childId, parentId)
        }, { childId, parentId })
        await page.waitForTimeout(500)

        // Verify children array is empty
        const childrenAfter = await page.evaluate(() =>
            window.layersApp._layers[1].children.length
        )
        expect(childrenAfter).toBe(0)

        // Verify no child-layer in DOM
        const childLayerCount = await page.locator('layer-item.child-layer').count()
        expect(childLayerCount).toBe(0)
    })

    test('undo/redo with children', async ({ page }) => {
        const parentId = await page.evaluate(() => window.layersApp._layers[1].id)

        // Add a child effect
        await page.evaluate(async (id) => {
            await window.layersApp._handleAddChildEffect(id, 'filter/blur')
        }, parentId)
        await page.waitForTimeout(500)

        // Verify child exists
        expect(await page.evaluate(() =>
            window.layersApp._layers[1].children.length
        )).toBe(1)

        // Undo - child should be gone
        await page.evaluate(async () => {
            await window.layersApp._undo()
        })
        await page.waitForTimeout(500)

        expect(await page.evaluate(() =>
            (window.layersApp._layers[1].children || []).length
        )).toBe(0)
        expect(await page.locator('layer-item.child-layer').count()).toBe(0)

        // Redo - child should be back
        await page.evaluate(async () => {
            await window.layersApp._redo()
        })
        await page.waitForTimeout(500)

        expect(await page.evaluate(() =>
            window.layersApp._layers[1].children.length
        )).toBe(1)
        expect(await page.locator('layer-item.child-layer').count()).toBe(1)
    })

    test('multiple children chain in order', async ({ page }) => {
        const parentId = await page.evaluate(() => window.layersApp._layers[1].id)

        // Add blur first, then invert
        await page.evaluate(async (id) => {
            await window.layersApp._handleAddChildEffect(id, 'filter/blur')
        }, parentId)
        await page.waitForTimeout(500)

        await page.evaluate(async (id) => {
            await window.layersApp._handleAddChildEffect(id, 'filter/invert')
        }, parentId)
        await page.waitForTimeout(500)

        // Verify two children
        const childCount = await page.evaluate(() =>
            window.layersApp._layers[1].children.length
        )
        expect(childCount).toBe(2)

        // Get DSL and verify blur appears before invert
        const dsl = await page.evaluate(() =>
            window.layersApp._renderer._currentDsl
        )
        const blurIndex = dsl.indexOf('blur(')
        const invertIndex = dsl.indexOf('invert(')

        expect(blurIndex).toBeGreaterThan(-1)
        expect(invertIndex).toBeGreaterThan(-1)
        expect(blurIndex).toBeLessThan(invertIndex)
    })
})
