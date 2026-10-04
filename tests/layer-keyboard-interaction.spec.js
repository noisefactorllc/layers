import { test, expect } from './fixtures.js'
import { appReady, appState, layerCount } from './waits.js'
import { reopenNewProjectDialog } from './helpers/new-project.js'

// GAP-005: layer rows were not focusable, selection was click-only, renaming
// double-click-only, and reordering drag-only, so a keyboard-only user could
// never select, rename or reorder a layer. These specs pin the keyboard
// paths: a real Tab walk reaches a layer row (roving tabindex, one Tab stop
// for the whole stack), Enter/Space selects the focused row and enables the
// selection-dependent Layer menu items, F2 enters and commits a rename, and
// Alt+ArrowUp/Down moves the layer in the stack through the same reorder FSM
// the drag gesture uses. The pointer paths keep working untouched.

async function bootTwoLayerProject(page) {
    await page.goto('/', { waitUntil: 'networkidle' })
    await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })

    await reopenNewProjectDialog(page)
    await page.click('.media-option[data-type="solid"]')
    await page.waitForSelector('.canvas-size-dialog', { timeout: 5000 })
    // 512 preset: quarters the composited frame cost on software-rendered CI
    // shards; this suite reads no absolute canvas coordinates.
    await page.click('.size-preset[data-width="512"]')
    await page.click('.canvas-size-dialog .action-btn.primary')
    await page.waitForSelector('.open-dialog-backdrop.visible', { state: 'hidden', timeout: 5000 })
    await appReady(page)

    // A second (effect) layer on top so the stack has two rows with distinct
    // ids and the Layer menu's selection-dependent items have real targets.
    await page.evaluate(async () => {
        await window.layersApp._handleAddEffectLayer('synth/gradient')
    })
    await layerCount(page, 2)
}

/** Model id of the layer at stack index `index` (0 = base). */
async function rowId(page, index) {
    return page.evaluate((i) => window.layersApp._layers[i].id, index)
}

/** Open the Layer menu and return when its items are rendered. */
async function openLayerMenu(page) {
    await page.locator('#menu .hf-menubar-trigger', { hasText: 'layer' }).click()
    await page.locator('#menu #duplicateLayerMenuItem').waitFor({ state: 'visible' })
}

test.describe('Layer keyboard interaction', () => {
    test.beforeEach(async ({ page }) => {
        await bootTwoLayerProject(page)
    })

    test('a real Tab walk lands on a layer row', async ({ page }) => {
        // A full forward Tab walk from the menu bar: the panel's inner
        // controls (eye, delete, blend, opacity…) are all tabbable, but the
        // roving tabindex must give the row itself a stop too.
        await page.locator('#menu .hf-menubar-trigger', { hasText: 'file' }).focus()
        const stops = []
        for (let i = 0; i < 60; i++) {
            await page.keyboard.press('Tab')
            const stop = await page.evaluate(() => {
                const el = document.activeElement
                return {
                    row: el instanceof Element && el.matches('layer-item'),
                    rowId: el instanceof Element && el.matches('layer-item')
                        ? el.dataset.layerId : null,
                    cls: el instanceof Element ? el.className.toString().split(' ')[0] : '',
                }
            })
            stops.push(stop)
            if (stop.row) break
        }
        const hit = stops.find(s => s.row)
        expect(hit, `no Tab stop on a layer-item within ${stops.length} stops`).toBeTruthy()
    })

    test('exactly one row is the stack Tab stop, and it follows the selection', async ({ page }) => {
        const bottomId = await rowId(page, 0)
        const topId = await rowId(page, 1)

        // Select the top layer through its row (pointer path) — the roving
        // tabindex must move with the selection.
        await page.click(`layer-item[data-layer-id="${topId}"] .layer-name`)
        await appState(page,
            (id) => window.layersApp._layerStack.selectedLayerIds[0] === id, topId)

        let stops = await page.evaluate(() =>
            [...document.querySelectorAll('layer-item')]
                .filter(item => item.getAttribute('tabindex') === '0')
                .map(item => item.dataset.layerId))
        expect(stops).toEqual([topId])

        // Select the bottom layer; the single Tab stop follows it.
        await page.evaluate((id) => {
            window.layersApp._layerStack.selectedLayerId = id
        }, bottomId)
        stops = await page.evaluate(() =>
            [...document.querySelectorAll('layer-item')]
                .filter(item => item.getAttribute('tabindex') === '0')
                .map(item => item.dataset.layerId))
        expect(stops).toEqual([bottomId])
    })

    test('Enter on the focused row selects it and enables the Layer menu items', async ({ page }) => {
        const topId = await rowId(page, 1)

        // Deselect everything first so the menu starts pinned to nothing.
        await page.evaluate(() => {
            window.layersApp._layerStack.selectedLayerIds = []
        })
        await openLayerMenu(page)
        await expect(page.locator('#menu #duplicateLayerMenuItem'))
            .toHaveAttribute('aria-disabled', 'true')
        await page.keyboard.press('Escape')

        // Focus the top row and press Enter.
        await page.locator(`layer-item[data-layer-id="${topId}"]`).focus()
        await page.keyboard.press('Enter')

        await appState(page,
            (id) => window.layersApp._layerStack.selectedLayerIds[0] === id, topId)

        await openLayerMenu(page)
        // aria-disabled is only written when the item is disabled; an enabled
        // item carries no attribute at all.
        await expect(page.locator('#menu #duplicateLayerMenuItem'))
            .not.toHaveAttribute('aria-disabled', 'true')
        await expect(page.locator('#menu #deleteLayerMenuItem'))
            .not.toHaveAttribute('aria-disabled', 'true')
        await expect(page.locator('#menu #addLayerMaskMenuItem'))
            .not.toHaveAttribute('aria-disabled', 'true')
        await page.keyboard.press('Escape')
    })

    test('Enter on the focused row keeps focus on that row after selecting it', async ({ page }) => {
        const topId = await rowId(page, 1)
        await page.evaluate(() => {
            window.layersApp._layerStack.selectedLayerIds = []
        })

        await page.locator(`layer-item[data-layer-id="${topId}"]`).focus()
        await page.keyboard.press('Enter')
        await appState(page,
            (id) => window.layersApp._layerStack.selectedLayerIds[0] === id, topId)

        // Selecting re-anchors the roving tabindex; that must not strip the
        // focused row's own tabindex, which would drop focus to BODY and
        // strand a keyboard user at the top of the document.
        const state = await page.evaluate(() => {
            const el = document.activeElement
            return {
                row: el instanceof Element && el.matches('layer-item'),
                rowId: el instanceof Element && el.matches('layer-item')
                    ? el.dataset.layerId : null,
                tabindex: el instanceof Element ? el.getAttribute('tabindex') : null,
            }
        })
        expect(state).toEqual({ row: true, rowId: topId, tabindex: '0' })
    })

    /** Hold Space for the 500ms pan gesture; expect Pan while held, brush after. */
    async function expectSpaceHoldPans(page) {
        await page.keyboard.down('Space')
        await page.waitForTimeout(50)
        expect(await page.evaluate(() => window.layersApp._currentTool)).toBe('pan')
        await page.waitForTimeout(500)
        await page.keyboard.up('Space')
        await page.waitForTimeout(50)
        expect(await page.evaluate(() => window.layersApp._currentTool)).toBe('brush')
    }

    test('clicking an already keyboard-focused row hands Space back to space-to-pan', async ({ page }) => {
        const topId = await rowId(page, 1)
        const row = page.locator(`layer-item[data-layer-id="${topId}"]`)
        await page.keyboard.press('b')
        expect(await page.evaluate(() => window.layersApp._currentTool)).toBe('brush')

        // Keyboard focus first; the click then fires no new focus event, so
        // the most recent interaction (the pointer) has to be what counts.
        await row.focus()
        await page.keyboard.press('ArrowDown')
        await page.keyboard.press('ArrowUp')
        await expect(row).toBeFocused()
        await row.locator('.layer-name').click()
        await expect(row).toBeFocused()
        await expectSpaceHoldPans(page)
    })

    test('keyboard navigation after a click makes Space select again', async ({ page }) => {
        const bottomId = await rowId(page, 0)
        const topId = await rowId(page, 1)
        const topRow = page.locator(`layer-item[data-layer-id="${topId}"]`)
        const bottomRow = page.locator(`layer-item[data-layer-id="${bottomId}"]`)
        await page.keyboard.press('b')

        // Pointer-focus the top row, then arrow down to the bottom row and
        // press Space: that is keyboard focus again, so Space selects.
        await topRow.locator('.layer-name').click()
        await expect(topRow).toBeFocused()
        await page.keyboard.press('ArrowDown')
        await expect(bottomRow).toBeFocused()
        await page.keyboard.press('Space')
        await appState(page,
            (id) => window.layersApp._layerStack.selectedLayerIds[0] === id, bottomId)
        expect(await page.evaluate(() => window.layersApp._currentTool)).toBe('brush')
    })

    test('an arrow press that cannot move a clicked row still counts as keyboard use', async ({ page }) => {
        const topId = await rowId(page, 1)
        const topRow = page.locator(`layer-item[data-layer-id="${topId}"]`)
        await page.keyboard.press('b')

        // Top row, nothing above it: ArrowUp moves no focus, but it is still
        // keyboard use of a pointer-focused row. Space is the row's again, so
        // it must not start a pan hold.
        await topRow.locator('.layer-name').click()
        await expect(topRow).toBeFocused()
        await page.keyboard.press('ArrowUp')
        await expect(topRow).toBeFocused()
        await page.keyboard.down('Space')
        await page.waitForTimeout(100)
        expect(await page.evaluate(() => window.layersApp._currentTool)).toBe('brush')
        await page.keyboard.up('Space')
    })

    test('a native drag that never reports pointerup does not leave a row pointer-focused', async ({ page }) => {
        const topId = await rowId(page, 1)
        const topRow = page.locator(`layer-item[data-layer-id="${topId}"]`)
        await page.evaluate(() => {
            window.layersApp._layerStack.selectedLayerIds = []
        })

        // A drag takes over the gesture: pointerdown, then dragstart, and the
        // browser may never deliver pointerup, pointercancel or dragend.
        await page.evaluate((id) => {
            const row = document.querySelector(`layer-item[data-layer-id="${id}"]`)
            row.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 41, pointerType: 'mouse' }))
            row.dispatchEvent(new Event('dragstart', { bubbles: true, cancelable: true }))
        }, topId)

        // Keyboard focus straight afterwards is keyboard focus: Space selects.
        await topRow.focus()
        await expect(topRow).toBeFocused()
        await page.keyboard.press('Space')
        await appState(page,
            (id) => window.layersApp._layerStack.selectedLayerIds[0] === id, topId)
    })

    test('F2 on the focused row renames it, and Enter commits back to the row', async ({ page }) => {
        const topId = await rowId(page, 1)
        const row = page.locator(`layer-item[data-layer-id="${topId}"]`)

        await row.focus()
        await page.keyboard.press('F2')

        // The name element is now a focused contenteditable with its text selected.
        const nameEl = row.locator('.layer-name')
        await expect(nameEl).toHaveAttribute('contenteditable', 'true')
        await expect(nameEl).toBeFocused()

        await page.keyboard.insertText('Renamed by keyboard')
        await page.keyboard.press('Enter')

        await appState(page,
            (id) => window.layersApp._layers.find(l => l.id === id).name
                === 'Renamed by keyboard', topId)
        await expect(nameEl).toHaveText('Renamed by keyboard')
        // Committing returns focus to the row so the keyboard user keeps
        // their place in the stack.
        await expect(row).toBeFocused()
        await expect(nameEl).toHaveAttribute('contenteditable', 'false')
    })

    test('Alt+ArrowUp moves the focused layer toward the top of the stack', async ({ page }) => {
        const bottomId = await rowId(page, 0)
        const topId = await rowId(page, 1)

        // The bottom row renders last in the panel; select it (giving it the
        // roving Tab stop) and focus it, then move it up.
        const bottomRow = page.locator(`layer-item[data-layer-id="${bottomId}"]`)
        await page.evaluate((id) => {
            window.layersApp._layerStack.selectedLayerId = id
        }, bottomId)
        await bottomRow.focus()
        await page.keyboard.press('Alt+ArrowUp')

        // The base layer cannot move (it anchors the stack): order unchanged.
        const order = await page.evaluate(() => window.layersApp._layers.map(l => l.id))
        expect(order).toEqual([bottomId, topId])
        await expect(bottomRow).toBeFocused()
    })

    test('Alt+ArrowDown then Alt+ArrowUp reorder a non-base layer', async ({ page }) => {
        await page.evaluate(async () => {
            await window.layersApp._handleAddEffectLayer('filter/blur')
        })
        await layerCount(page, 3)
        // Model order is base, gradient, blur. The middle layer is the one a
        // keyboard move can actually relocate.
        const middleId = await rowId(page, 1)
        const baseId = await rowId(page, 0)

        const middleRow = page.locator(`layer-item[data-layer-id="${middleId}"]`)
        await page.evaluate((id) => {
            window.layersApp._layerStack.selectedLayerId = id
        }, middleId)
        await middleRow.focus()
        await page.keyboard.press('Alt+ArrowUp')

        // Moves above the top layer: model order becomes base, blur, gradient
        // (higher index = visually higher, so the moved layer sits at index 2).
        await appState(page,
            (id) => window.layersApp._reorderState === 'IDLE'
                && window.layersApp._layers[2].id === id,
            middleId)
        await expect(middleRow).toBeFocused()

        // And back down to its original slot (index 1).
        await page.keyboard.press('Alt+ArrowDown')
        await appState(page,
            (id) => window.layersApp._reorderState === 'IDLE'
                && window.layersApp._layers[1].id === id,
            middleId)
        await expect(middleRow).toBeFocused()

        // The rendered row order follows the model (top layer first).
        const renderedIds = await page.evaluate(() =>
            [...document.querySelectorAll('layer-item')]
                .filter(item => !item.isChild)
                .map(item => item.dataset.layerId))
        const top = await rowId(page, 2)
        expect(renderedIds).toEqual([top, middleId, baseId])
    })

    test('plain arrows move row focus without changing the stack or selection', async ({ page }) => {
        const bottomId = await rowId(page, 0)
        const topId = await rowId(page, 1)

        const bottomRow = page.locator(`layer-item[data-layer-id="${bottomId}"]`)
        const topRow = page.locator(`layer-item[data-layer-id="${topId}"]`)

        // The top row renders first in the panel; select it (roving Tab stop)
        // and focus it, then ArrowDown moves row focus one row down.
        await page.evaluate((id) => {
            window.layersApp._layerStack.selectedLayerId = id
        }, topId)
        await topRow.focus()
        await page.keyboard.press('ArrowDown')

        await expect(bottomRow).toBeFocused()
        // The single roving Tab stop followed the focus.
        const stops = await page.evaluate(() =>
            [...document.querySelectorAll('layer-item')]
                .filter(item => item.getAttribute('tabindex') === '0')
                .map(item => item.dataset.layerId))
        expect(stops).toEqual([bottomId])
        // Selection unchanged by pure focus movement.
        const selected = await page.evaluate(() =>
            window.layersApp._layerStack.selectedLayerIds)
        expect(selected).toEqual([topId])
        const order = await page.evaluate(() => window.layersApp._layers.map(l => l.id))
        expect(order).toEqual([bottomId, topId])
    })

    test('pointer selection keeps working alongside the keyboard paths', async ({ page }) => {
        const bottomId = await rowId(page, 0)
        const topId = await rowId(page, 1)

        // Row click (on the name, not a control) still selects.
        await page.click(`layer-item[data-layer-id="${bottomId}"] .layer-name`)
        await appState(page,
            (id) => window.layersApp._layerStack.selectedLayerIds[0] === id, bottomId)

        // Double-click still enters rename.
        const nameEl = page.locator(`layer-item[data-layer-id="${bottomId}"] .layer-name`)
        await nameEl.dblclick()
        await expect(nameEl).toHaveAttribute('contenteditable', 'true')
        await page.keyboard.insertText('Pointer renamed')
        await page.keyboard.press('Enter')
        await appState(page,
            (id) => window.layersApp._layers.find(l => l.id === id).name
                === 'Pointer renamed', bottomId)
    })
})
