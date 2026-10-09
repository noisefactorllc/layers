import { test, expect } from './fixtures.js'
import { appReady, layerCount } from './waits.js'
import { reopenNewProjectDialog } from './helpers/new-project.js'

// GAP-004: the mask operations were reachable only through the pointer-only
// context menus. These specs pin the keyboard path: ARIA menu semantics,
// keyboard open (Shift+F10 / ContextMenu key on a focused mask thumbnail),
// arrow navigation, Enter activation, Escape close, and the resulting mask
// state for invert, feather and selection-from-mask.

// Parallel mode makes each case its own sharding unit: every case here boots
// its own app and shares no state with its siblings, so shards can split this
// file instead of pinning all of it to one runner.
test.describe.configure({ mode: 'parallel' })

async function createProjectWithEffectLayer(page) {
    await page.goto('/', { waitUntil: 'networkidle' })
    await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })

    await reopenNewProjectDialog(page)
    await page.click('.media-option[data-type="solid"]')
    await page.waitForSelector('.canvas-size-dialog', { timeout: 5000 })
    await page.click('.size-preset[data-width="512"]')
    await page.click('.canvas-size-dialog .action-btn.primary')
    await page.waitForSelector('.open-dialog-backdrop.visible', { state: 'hidden', timeout: 5000 })
    await appReady(page)

    await page.evaluate(async () => {
        await window.layersApp._handleAddEffectLayer('synth/gradient')
    })
    await layerCount(page, 2)
}

async function addMaskToTopLayer(page) {
    await page.evaluate(async () => {
        const topLayer = window.layersApp._layers[1]
        await window.layersApp._addLayerMask(topLayer.id, { enterEditMode: false })
    })
    await expect(page.locator('.layer-mask-thumbnail')).toBeVisible()
}

/** Open the mask context menu from the keyboard: focus the thumbnail, press Shift+F10. */
async function openMaskMenuFromKeyboard(page) {
    await page.locator('.layer-mask-thumbnail').focus()
    await page.keyboard.press('Shift+F10')
    await expect(page.locator('#maskContextMenu')).toBeVisible()
}

async function activeElementText(page) {
    return page.evaluate(() => document.activeElement?.textContent ?? null)
}

test.describe('Mask context menu keyboard access', () => {
    test.beforeEach(async ({ page }) => {
        await createProjectWithEffectLayer(page)
        await addMaskToTopLayer(page)
    })

    test('context menus expose ARIA menu semantics', async ({ page }) => {
        const menus = await page.evaluate(() => {
            const describe = (id) => {
                const menu = document.getElementById(id)
                const items = [...menu.querySelectorAll('[data-action]')]
                return {
                    role: menu.getAttribute('role'),
                    label: menu.getAttribute('aria-label'),
                    itemRoles: items.map(i => i.getAttribute('role')),
                    itemTabindexes: items.map(i => i.getAttribute('tabindex')),
                    separatorRoles: [...menu.querySelectorAll('.menu-seperator')]
                        .map(s => s.getAttribute('role')),
                }
            }
            return {
                mask: describe('maskContextMenu'),
                layer: describe('layerContextMenu'),
            }
        })

        expect(menus.mask.role).toBe('menu')
        expect(menus.mask.itemRoles).toEqual(new Array(8).fill('menuitem'))
        expect(menus.mask.itemTabindexes).toEqual(new Array(8).fill('-1'))
        expect(menus.mask.separatorRoles).toEqual(['separator'])
        expect(menus.layer.role).toBe('menu')
        expect(menus.layer.itemRoles).toEqual(new Array(2).fill('menuitem'))
        expect(menus.layer.itemTabindexes).toEqual(new Array(2).fill('-1'))
    })

    test('mask thumbnail is keyboard focusable with button semantics', async ({ page }) => {
        const thumb = page.locator('.layer-mask-thumbnail')
        await expect(thumb).toHaveAttribute('role', 'button')
        await expect(thumb).toHaveAttribute('tabindex', '0')
        const label = await thumb.getAttribute('aria-label')
        expect(label).toContain('mask')

        await thumb.focus()
        await expect.poll(() => page.evaluate(() =>
            document.activeElement?.classList.contains('layer-mask-thumbnail'))).toBe(true)
    })

    test('Shift+F10 opens the mask menu, arrows navigate, Escape closes', async ({ page }) => {
        await openMaskMenuFromKeyboard(page)

        // Focus lands on the first item when the menu opens.
        await expect.poll(() => activeElementText(page)).toBe('Invert Mask')

        await page.keyboard.press('ArrowDown')
        await expect.poll(() => activeElementText(page)).toBe('Feather Mask…')
        await page.keyboard.press('ArrowUp')
        await expect.poll(() => activeElementText(page)).toBe('Invert Mask')

        // Escape keeps closing the menu, and focus returns to the trigger.
        await page.keyboard.press('Escape')
        await expect(page.locator('#maskContextMenu')).toBeHidden()
        await expect.poll(() => page.evaluate(() =>
            document.activeElement?.classList.contains('layer-mask-thumbnail'))).toBe(true)
    })

    test('the ContextMenu key also opens the mask menu', async ({ page }) => {
        await page.locator('.layer-mask-thumbnail').focus()
        await page.keyboard.press('ContextMenu')
        await expect(page.locator('#maskContextMenu')).toBeVisible()
        await expect.poll(() => activeElementText(page)).toBe('Invert Mask')
    })

    test('Enter activates Invert Mask and flips the mask', async ({ page }) => {
        await openMaskMenuFromKeyboard(page)
        await page.keyboard.press('Enter')

        await expect(page.locator('#maskContextMenu')).toBeHidden()
        await expect.poll(async () => page.evaluate(() => {
            const mask = window.layersApp._layers[1].mask
            for (let i = 0; i < mask.data.length; i += 4) {
                if (mask.data[i] !== 0) return false
            }
            return true
        })).toBe(true)
    })

    test('Enter applies the Feather radius through the keyboard path', async ({ page }) => {
        // A mask with a real boundary: left half selected, right half not.
        // (Feathering an all-white mask is a boundary-ramp no-op.) The canvas
        // center sits exactly on the contour, radius 5 deep in both halves.
        await page.evaluate(() => {
            const layer = window.layersApp._layers[1]
            const data = layer.mask.data
            for (let i = 0; i < data.length; i += 4) {
                const selected = ((i / 4) % 512) < 256
                const v = selected ? 255 : 0
                data[i] = data[i + 1] = data[i + 2] = data[i + 3] = v
            }
        })

        await openMaskMenuFromKeyboard(page)
        await page.keyboard.press('ArrowDown')
        await expect.poll(() => activeElementText(page)).toBe('Feather Mask…')
        await page.keyboard.press('Enter')

        // The dialog opens with the radius input focused; Enter on it confirms.
        const dialog = page.locator('.selection-param-dialog')
        await expect(dialog).toBeVisible()
        await expect(dialog.locator('.dialog-header h2')).toHaveText('Feather Mask')
        await page.keyboard.press('Enter')
        await expect(dialog).toBeHidden()

        // The contour pixel flips from unselected (0) to the ramp midpoint
        // (~128); the deep-interior and deep-outside values are preserved.
        await expect.poll(async () => page.evaluate(() => {
            const data = window.layersApp._layers[1].mask.data
            const px = (x, y) => data[(y * 512 + x) * 4]
            return {
                contour: px(256, 256),
                inside: px(128, 256),
                outside: px(384, 256),
            }
        })).toEqual({
            contour: expect.any(Number),
            inside: 255,
            outside: 0,
        })
        await expect.poll(async () => page.evaluate(() => {
            const v = window.layersApp._layers[1].mask.data[(256 * 512 + 256) * 4]
            return v >= 100 && v <= 160
        })).toBe(true)
    })

    test('Enter on Selection from Mask creates a mask selection', async ({ page }) => {
        await openMaskMenuFromKeyboard(page)
        // Selection from Mask is the seventh item; walk down to it.
        for (let i = 0; i < 6; i++) {
            await page.keyboard.press('ArrowDown')
        }
        await expect.poll(() => activeElementText(page)).toBe('Selection from Mask')
        await page.keyboard.press('Enter')

        await expect(page.locator('#maskContextMenu')).toBeHidden()
        await expect.poll(async () => page.evaluate(() =>
            window.layersApp._selectionManager?.selectionPath?.type ?? null)).toBe('mask')
    })

    test('the layer context menu opens from the keyboard and adds a mask', async ({ page }) => {
        // Fresh project state: no mask yet on either layer, so the layer
        // context menu (Add Layer Mask / Mask from Selection) applies.
        await page.evaluate(async () => {
            const topLayer = window.layersApp._layers[1]
            await window.layersApp._deleteLayerMask(topLayer.id)
        })

        // Focus a control on the layer row, then press the context-menu key.
        const item = page.locator('.layer-item').nth(1)
        const layerId = await item.getAttribute('data-layer-id')
        await item.locator('.layer-visibility').focus()
        await page.keyboard.press('Shift+F10')

        const menu = page.locator('#layerContextMenu')
        await expect(menu).toBeVisible()
        await expect.poll(() => activeElementText(page)).toBe('Add Layer Mask')
        await page.keyboard.press('ArrowDown')
        await expect.poll(() => activeElementText(page)).toBe('Mask from Selection')
        await page.keyboard.press('ArrowUp')
        await page.keyboard.press('Enter')

        await expect(menu).toBeHidden()
        await expect.poll(async () => page.evaluate((id) => {
            const layer = window.layersApp._layers.find(l => l.id === id)
            return layer ? !!layer.mask : null
        }, layerId)).toBe(true)
    })
})
