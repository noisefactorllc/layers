import { test, expect } from 'playwright/test'

test.describe('Layer masks', () => {
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

        // Add a second layer (gradient effect) so we can see masking
        await page.evaluate(async () => {
            await window.layersApp._handleAddEffectLayer('synth/gradient')
        })
        await page.waitForTimeout(500)
    })

    test('add layer mask creates white mask', async ({ page }) => {
        await page.evaluate(async () => {
            const topLayer = window.layersApp._layers[1]
            await window.layersApp._addLayerMask(topLayer.id)
        })

        const hasMask = await page.evaluate(() => {
            const topLayer = window.layersApp._layers[1]
            return topLayer.mask !== null && topLayer.maskEnabled === true
        })
        expect(hasMask).toBe(true)

        // Mask should be all white (255)
        const isAllWhite = await page.evaluate(() => {
            const mask = window.layersApp._layers[1].mask
            for (let i = 0; i < mask.data.length; i += 4) {
                if (mask.data[i] !== 255) return false
            }
            return true
        })
        expect(isAllWhite).toBe(true)
    })

    test('mask thumbnail appears in layer-item', async ({ page }) => {
        await page.evaluate(async () => {
            const topLayer = window.layersApp._layers[1]
            await window.layersApp._addLayerMask(topLayer.id)
        })
        await page.waitForTimeout(300)

        const maskThumb = page.locator('.layer-mask-thumbnail')
        await expect(maskThumb).toBeVisible()
    })

    test('invert mask changes white to black', async ({ page }) => {
        await page.evaluate(async () => {
            const topLayer = window.layersApp._layers[1]
            await window.layersApp._addLayerMask(topLayer.id)
            await window.layersApp._invertLayerMask(topLayer.id)
        })

        const isAllBlack = await page.evaluate(() => {
            const mask = window.layersApp._layers[1].mask
            for (let i = 0; i < mask.data.length; i += 4) {
                if (mask.data[i] !== 0) return false
            }
            return true
        })
        expect(isAllBlack).toBe(true)
    })

    test('invert refreshes the live overlay for the mask being edited', async ({ page }) => {
        const result = await page.evaluate(async () => {
            const app = window.layersApp
            const layer = app._layers[1]
            await app._addLayerMask(layer.id)
            const overlay = document.getElementById('maskOverlay')
            const context = overlay.getContext('2d')
            const beforeAlpha = context.getImageData(0, 0, 1, 1).data[3]

            await app._invertLayerMask(layer.id)

            return {
                beforeAlpha,
                afterAlpha: context.getImageData(0, 0, 1, 1).data[3],
                maskValue: layer.mask.data[0],
                editLayerId: app._maskEditLayerId,
                layerId: layer.id,
            }
        })

        expect(result.beforeAlpha).toBe(0)
        expect(result.maskValue).toBe(0)
        expect(result.afterAlpha).toBe(128)
        expect(result.editLayerId).toBe(result.layerId)
    })

    test('agent mask transform does not replace another layer live edit overlay', async ({ page }) => {
        const result = await page.evaluate(async () => {
            const app = window.layersApp
            const editedLayer = app._layers[0]
            const transformedLayer = app._layers[1]
            await window.LayersAgent.addLayerMask({ layerId: editedLayer.id })
            await window.LayersAgent.addLayerMask({ layerId: transformedLayer.id })
            await window.LayersAgent.invertLayerMask({ layerId: transformedLayer.id })
            app._enterMaskEditMode(editedLayer.id)

            const overlay = document.getElementById('maskOverlay')
            const context = overlay.getContext('2d')
            const beforeAlpha = context.getImageData(0, 0, 1, 1).data[3]
            const envelope = await window.LayersAgent.smoothMask({
                layerId: transformedLayer.id,
                radius: 3,
            })

            return {
                envelope,
                beforeAlpha,
                afterAlpha: context.getImageData(0, 0, 1, 1).data[3],
                editedMaskValue: editedLayer.mask.data[0],
                transformedMaskValue: transformedLayer.mask.data[0],
                editLayerId: app._maskEditLayerId,
                editedLayerId: editedLayer.id,
            }
        })

        expect(result.envelope.ok).toBe(true)
        expect(result.beforeAlpha).toBe(0)
        expect(result.editedMaskValue).toBe(255)
        expect(result.transformedMaskValue).toBe(0)
        expect(result.afterAlpha).toBe(0)
        expect(result.editLayerId).toBe(result.editedLayerId)
    })

    test('delete mask removes it', async ({ page }) => {
        await page.evaluate(async () => {
            const topLayer = window.layersApp._layers[1]
            await window.layersApp._addLayerMask(topLayer.id)
            await window.layersApp._deleteLayerMask(topLayer.id)
        })

        const hasMask = await page.evaluate(() => {
            return window.layersApp._layers[1].mask === null
        })
        expect(hasMask).toBe(true)
    })

    test('toggle mask enabled/disabled', async ({ page }) => {
        await page.evaluate(async () => {
            const topLayer = window.layersApp._layers[1]
            await window.layersApp._addLayerMask(topLayer.id)
            await window.layersApp._toggleMaskEnabled(topLayer.id)
        })

        const isDisabled = await page.evaluate(() => {
            return window.layersApp._layers[1].maskEnabled === false
        })
        expect(isDisabled).toBe(true)
    })

    test('undo restores mask state', async ({ page }) => {
        await page.evaluate(async () => {
            const topLayer = window.layersApp._layers[1]
            await window.layersApp._addLayerMask(topLayer.id)
        })

        // Mask exists
        let hasMask = await page.evaluate(() => window.layersApp._layers[1].mask !== null)
        expect(hasMask).toBe(true)

        // Undo should remove the mask
        await page.evaluate(async () => { await window.layersApp._undo() })
        await page.waitForTimeout(300)

        hasMask = await page.evaluate(() => window.layersApp._layers[1].mask !== null)
        expect(hasMask).toBe(false)
    })
})
