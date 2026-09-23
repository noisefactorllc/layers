import { test, expect } from './fixtures.js'
import { appReady, appState } from './waits.js'

async function setupApp(page) {
    await page.goto('/', { waitUntil: 'networkidle' })
    await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })
    await page.waitForSelector('.open-dialog-backdrop.visible')
    await page.click('.media-option[data-type="solid"]')
    await page.waitForSelector('.canvas-size-dialog', { timeout: 5000 })
    await page.click('.canvas-size-dialog .action-btn.primary')
    await page.waitForSelector('.open-dialog-backdrop.visible', { state: 'hidden', timeout: 5000 })
    await appReady(page)
}

async function setRectSelection(page, x, y, w, h) {
    await page.evaluate(({ x, y, w, h }) => {
        window.layersApp._selectionManager.setSelection({
            type: 'rect', x, y, width: w, height: h
        })
    }, { x, y, w, h })
    // No wait: setSelection calls onSelectionChange, which calls
    // menuBar.refresh(), which rewrites every item's aria-disabled inline.
    // The whole chain runs inside the evaluate above.
}

async function openSelectMenu(page) {
    // The Select menu dropdown is hidden by default (.hide class).
    // We need to click its title to reveal the menu items.
    await page.locator('#menu .hf-menubar-trigger', { hasText: 'select' }).click()
    // The panel is hidden until the trigger opens it, so its items are not
    // clickable before this.
    await page.locator('#selectAllMenuItem').waitFor({ state: 'visible' })
}

test.describe('Select Menu', () => {
    test('select all creates full-canvas selection', async ({ page }) => {
        await setupApp(page)
        await openSelectMenu(page)
        await page.click('#selectAllMenuItem')
        await appState(page, () => window.layersApp._selectionManager.hasSelection())

        const result = await page.evaluate(() => {
            const sel = window.layersApp._selectionManager.selectionPath
            return { type: sel?.type, x: sel?.x, y: sel?.y, w: sel?.width, h: sel?.height }
        })
        expect(result.type).toBe('rect')
        expect(result.w).toBe(1024)
        expect(result.h).toBe(1024)
    })

    test('select none clears selection', async ({ page }) => {
        await setupApp(page)
        await setRectSelection(page, 10, 10, 100, 100)
        await openSelectMenu(page)
        await page.click('#selectNoneMenuItem')
        await appState(page, () => !window.layersApp._selectionManager.hasSelection())

        const hasSelection = await page.evaluate(() =>
            window.layersApp._selectionManager.hasSelection()
        )
        expect(hasSelection).toBe(false)
    })

    test('select inverse inverts selection mask', async ({ page }) => {
        await setupApp(page)
        await setRectSelection(page, 0, 0, 512, 512)
        await openSelectMenu(page)
        await page.click('#selectInverseMenuItem')
        await appState(page,
            () => window.layersApp._selectionManager.selectionPath?.type === 'mask')

        const result = await page.evaluate(() => {
            const sel = window.layersApp._selectionManager.selectionPath
            if (sel?.type !== 'mask') return { type: sel?.type }
            const insideIdx = (256 * sel.data.width + 256) * 4 + 3
            const outsideIdx = (768 * sel.data.width + 768) * 4 + 3
            return {
                type: sel.type,
                insideAlpha: sel.data.data[insideIdx],
                outsideAlpha: sel.data.data[outsideIdx]
            }
        })
        expect(result.type).toBe('mask')
        expect(result.insideAlpha).toBe(0)
        expect(result.outsideAlpha).toBe(255)
    })

    test('expand selection grows the mask', async ({ page }) => {
        await setupApp(page)
        await setRectSelection(page, 100, 100, 100, 100)

        await openSelectMenu(page)
        await page.click('#expandSelectionMenuItem')
        await page.waitForSelector('.selection-param-dialog[open]', { timeout: 2000 })
        await page.fill('#selection-param-input', '10')
        await page.click('#selection-param-ok')
        // Confirming replaces the rect with the expanded mask the pixel read
        // below indexes into.
        await appState(page,
            () => window.layersApp._selectionManager.selectionPath?.type === 'mask')

        const selected = await page.evaluate(() => {
            const sel = window.layersApp._selectionManager.selectionPath
            if (sel?.type !== 'mask') return false
            // Check a pixel just outside the original rect (x=95, y=150)
            // which should now be selected after expanding by 10px
            const idx = (150 * sel.data.width + 95) * 4 + 3
            return sel.data.data[idx] > 127
        })
        expect(selected).toBe(true)
    })

    test('selection modification dialog holds the mutation lease until confirmation', async ({ page }) => {
        await setupApp(page)
        await setRectSelection(page, 100, 100, 100, 100)

        await openSelectMenu(page)
        await page.click('#expandSelectionMenuItem')
        await page.waitForSelector('.selection-param-dialog[open]', { timeout: 2000 })
        await page.evaluate(() => {
            window.__selectionRaceSettled = false
            window.__selectionRacePromise = window.LayersAgent.setRectangleSelection({
                x: 400, y: 400, width: 50, height: 50,
            }).then(envelope => {
                window.__selectionRaceSettled = true
                return envelope
            })
        })
        // The agent command takes the lifecycle lease before its handler runs,
        // so it is provably queued behind the open dialog once it registers as
        // a waiter. Sleeping instead only made "not settled yet" likely.
        await appState(page, () => window.layersApp._projectLifecycleWaiters > 0)

        const whileOpen = await page.evaluate(() => ({
            settled: window.__selectionRaceSettled,
            selection: window.layersApp._selectionManager.selectionPath,
        }))
        expect(whileOpen.settled).toBe(false)
        expect(whileOpen.selection).toMatchObject({
            type: 'rect', x: 100, y: 100, width: 100, height: 100,
        })

        await page.fill('#selection-param-input', '10')
        await page.click('#selection-param-ok')
        const agent = await page.evaluate(() => window.__selectionRacePromise)
        expect(agent.ok).toBe(true)
        const finalSelection = await page.evaluate(() =>
            window.layersApp._selectionManager.selectionPath)
        expect(finalSelection).toMatchObject({
            type: 'rect', x: 400, y: 400, width: 50, height: 50,
        })
    })

    test('contract selection shrinks the mask', async ({ page }) => {
        await setupApp(page)
        await setRectSelection(page, 100, 100, 100, 100)

        await openSelectMenu(page)
        await page.click('#contractSelectionMenuItem')
        await page.waitForSelector('.selection-param-dialog[open]', { timeout: 2000 })
        await page.fill('#selection-param-input', '10')
        await page.click('#selection-param-ok')
        // Confirming replaces the rect with the contracted mask the pixel read
        // below indexes into.
        await appState(page,
            () => window.layersApp._selectionManager.selectionPath?.type === 'mask')

        const selected = await page.evaluate(() => {
            const sel = window.layersApp._selectionManager.selectionPath
            if (sel?.type !== 'mask') return true
            // Check a pixel just inside the original rect edge (x=105, y=150)
            // which should now be deselected after contracting by 10px
            const idx = (150 * sel.data.width + 105) * 4 + 3
            return sel.data.data[idx] > 127
        })
        expect(selected).toBe(false)
    })

    test('menu items are disabled when no selection', async ({ page }) => {
        await setupApp(page)

        const disabled = await page.evaluate(() => {
            const ids = [
                'selectNoneMenuItem', 'selectInverseMenuItem',
                'borderSelectionMenuItem', 'smoothSelectionMenuItem',
                'expandSelectionMenuItem', 'contractSelectionMenuItem',
                'featherSelectionMenuItem'
            ]
            return ids.every(id => document.getElementById(id)?.getAttribute('aria-disabled') === 'true')
        })
        expect(disabled).toBe(true)
    })

    test('menu items are enabled when selection exists', async ({ page }) => {
        await setupApp(page)
        await setRectSelection(page, 10, 10, 100, 100)

        const enabled = await page.evaluate(() => {
            const ids = [
                'selectNoneMenuItem', 'selectInverseMenuItem',
                'borderSelectionMenuItem', 'smoothSelectionMenuItem',
                'expandSelectionMenuItem', 'contractSelectionMenuItem',
                'featherSelectionMenuItem'
            ]
            return ids.every(id => document.getElementById(id)?.getAttribute('aria-disabled') !== 'true')
        })
        expect(enabled).toBe(true)
    })

    test('Cmd+A selects all via keyboard', async ({ page }) => {
        await setupApp(page)
        await page.keyboard.press('Meta+a')
        await appState(page, () => window.layersApp._selectionManager.hasSelection())

        const hasSelection = await page.evaluate(() =>
            window.layersApp._selectionManager.hasSelection()
        )
        expect(hasSelection).toBe(true)
    })

    test('Color Range click completes under and releases the lifecycle lease', async ({ page }) => {
        await setupApp(page)
        await openSelectMenu(page)
        await page.click('#colorRangeMenuItem')
        await expect.poll(() => page.evaluate(() => ({
            picking: window.layersApp._colorRangePicking,
            lifecycle: window.layersApp._projectLifecycleActive,
        }))).toEqual({ picking: true, lifecycle: true })

        await page.locator('#selectionOverlay').click({ position: { x: 20, y: 20 } })

        await expect.poll(() => page.evaluate(() => ({
            picking: window.layersApp._colorRangePicking,
            lifecycle: window.layersApp._projectLifecycleActive,
            hasSelection: window.layersApp._selectionManager.hasSelection(),
        }))).toEqual({ picking: false, lifecycle: false, hasSelection: true })
    })

    test('Color Range Escape cancels and releases the lifecycle lease', async ({ page }) => {
        await setupApp(page)
        await openSelectMenu(page)
        await page.click('#colorRangeMenuItem')
        await expect.poll(() => page.evaluate(() =>
            window.layersApp._projectLifecycleActive)).toBe(true)

        await page.keyboard.press('Escape')

        await expect.poll(() => page.evaluate(() => ({
            picking: window.layersApp._colorRangePicking,
            lifecycle: window.layersApp._projectLifecycleActive,
        }))).toEqual({ picking: false, lifecycle: false })
    })

    test('Color Range window blur cancels and releases the lifecycle lease', async ({ page }) => {
        await setupApp(page)
        await openSelectMenu(page)
        await page.click('#colorRangeMenuItem')
        await expect.poll(() => page.evaluate(() =>
            window.layersApp._projectLifecycleActive)).toBe(true)

        await page.evaluate(() => window.dispatchEvent(new Event('blur')))

        await expect.poll(() => page.evaluate(() => ({
            picking: window.layersApp._colorRangePicking,
            lifecycle: window.layersApp._projectLifecycleActive,
        }))).toEqual({ picking: false, lifecycle: false })
    })

    test('switching tools cancels Color Range without re-enabling selection', async ({ page }) => {
        await setupApp(page)
        await openSelectMenu(page)
        await page.click('#colorRangeMenuItem')
        await expect.poll(() => page.evaluate(() =>
            window.layersApp._projectLifecycleActive)).toBe(true)

        await page.click('#brushToolBtn')

        await expect.poll(() => page.evaluate(() => ({
            tool: window.layersApp._currentTool,
            picking: window.layersApp._colorRangePicking,
            lifecycle: window.layersApp._projectLifecycleActive,
            selectionEnabled: window.layersApp._selectionManager.enabled,
        }))).toEqual({
            tool: 'brush',
            picking: false,
            lifecycle: false,
            selectionEnabled: false,
        })
    })

    test('Cmd+D and Ctrl+D deselect active selection via keyboard', async ({ page }) => {
        await setupApp(page)
        await setRectSelection(page, 50, 50, 200, 200)
        expect(await page.evaluate(() => window.layersApp._selectionManager.hasSelection())).toBe(true)

        await page.keyboard.press('Meta+d')
        await appState(page, () => !window.layersApp._selectionManager.hasSelection())
        expect(await page.evaluate(() => window.layersApp._selectionManager.hasSelection())).toBe(false)

        await setRectSelection(page, 50, 50, 200, 200)
        expect(await page.evaluate(() => window.layersApp._selectionManager.hasSelection())).toBe(true)

        await page.keyboard.press('Control+d')
        await appState(page, () => !window.layersApp._selectionManager.hasSelection())
        expect(await page.evaluate(() => window.layersApp._selectionManager.hasSelection())).toBe(false)
    })

    test('Cmd+D and Ctrl+D suppress default browser bookmarking even with no active selection', async ({ page }) => {
        await setupApp(page)
        expect(await page.evaluate(() => window.layersApp._selectionManager.hasSelection())).toBe(false)

        const results = await page.evaluate(() => {
            const metaEvent = new KeyboardEvent('keydown', {
                key: 'd',
                code: 'KeyD',
                metaKey: true,
                bubbles: true,
                cancelable: true,
            })
            document.dispatchEvent(metaEvent)

            const ctrlEvent = new KeyboardEvent('keydown', {
                key: 'd',
                code: 'KeyD',
                ctrlKey: true,
                bubbles: true,
                cancelable: true,
            })
            document.dispatchEvent(ctrlEvent)

            return {
                metaPrevented: metaEvent.defaultPrevented,
                ctrlPrevented: ctrlEvent.defaultPrevented,
            }
        })
        expect(results.metaPrevented).toBe(true)
        expect(results.ctrlPrevented).toBe(true)
    })

    test('Cmd+Shift+I and Ctrl+Shift+I invert selection via keyboard', async ({ page }) => {
        await setupApp(page)
        await setRectSelection(page, 0, 0, 512, 512)

        await page.keyboard.press('Meta+Shift+i')
        await appState(page, () => window.layersApp._selectionManager.selectionPath?.type === 'mask')

        let maskCheck = await page.evaluate(() => {
            const sel = window.layersApp._selectionManager.selectionPath
            if (sel?.type !== 'mask') return null
            const insideIdx = (256 * sel.data.width + 256) * 4 + 3
            const outsideIdx = (768 * sel.data.width + 768) * 4 + 3
            return {
                insideAlpha: sel.data.data[insideIdx],
                outsideAlpha: sel.data.data[outsideIdx],
            }
        })
        expect(maskCheck).toEqual({ insideAlpha: 0, outsideAlpha: 255 })

        // Invert back with Ctrl+Shift+I
        await page.keyboard.press('Control+Shift+i')
        await appState(page, () => {
            const sel = window.layersApp._selectionManager.selectionPath
            if (sel?.type !== 'mask') return false
            const insideIdx = (256 * sel.data.width + 256) * 4 + 3
            return sel.data.data[insideIdx] === 255
        })

        maskCheck = await page.evaluate(() => {
            const sel = window.layersApp._selectionManager.selectionPath
            const insideIdx = (256 * sel.data.width + 256) * 4 + 3
            const outsideIdx = (768 * sel.data.width + 768) * 4 + 3
            return {
                insideAlpha: sel.data.data[insideIdx],
                outsideAlpha: sel.data.data[outsideIdx],
            }
        })
        expect(maskCheck).toEqual({ insideAlpha: 255, outsideAlpha: 0 })
    })

    test('Cmd+Shift+I on full canvas selection cleanly deselects', async ({ page }) => {
        await setupApp(page)
        await page.keyboard.press('Meta+a')
        await appState(page, () => window.layersApp._selectionManager.hasSelection())

        await page.keyboard.press('Meta+Shift+i')
        await appState(page, () => !window.layersApp._selectionManager.hasSelection())

        const state = await page.evaluate(() => ({
            hasSelection: window.layersApp._selectionManager.hasSelection(),
            selectionPath: window.layersApp._selectionManager.selectionPath,
            selectNoneDisabled: document.getElementById('selectNoneMenuItem')?.getAttribute('aria-disabled'),
            selectInverseDisabled: document.getElementById('selectInverseMenuItem')?.getAttribute('aria-disabled'),
        }))
        expect(state.hasSelection).toBe(false)
        expect(state.selectionPath).toBeNull()
        expect(state.selectNoneDisabled).toBe('true')
        expect(state.selectInverseDisabled).toBe('true')
    })

    test('Cmd+D and Cmd+Shift+I work with drawing layer active', async ({ page }) => {
        await setupApp(page)
        await page.evaluate(async () => {
            await window.layersApp._handleAddDrawingLayer('Drawing Layer')
        })
        await setRectSelection(page, 0, 0, 512, 512)
        await page.keyboard.press('Meta+Shift+i')
        await appState(page, () => window.layersApp._selectionManager.selectionPath?.type === 'mask')
        expect(await page.evaluate(() => window.layersApp._selectionManager.hasSelection())).toBe(true)
        await page.keyboard.press('Meta+d')
        await appState(page, () => !window.layersApp._selectionManager.hasSelection())
        expect(await page.evaluate(() => window.layersApp._selectionManager.hasSelection())).toBe(false)
    })

    test('Cmd+D and Cmd+Shift+I work with text layer active', async ({ page }) => {
        await setupApp(page)
        await page.evaluate(async () => {
            await window.layersApp._handleAddEffectLayer('filter/text')
        })
        await setRectSelection(page, 0, 0, 512, 512)
        await page.keyboard.press('Meta+Shift+i')
        await appState(page, () => window.layersApp._selectionManager.selectionPath?.type === 'mask')
        expect(await page.evaluate(() => window.layersApp._selectionManager.hasSelection())).toBe(true)
        await page.keyboard.press('Meta+d')
        await appState(page, () => !window.layersApp._selectionManager.hasSelection())
        expect(await page.evaluate(() => window.layersApp._selectionManager.hasSelection())).toBe(false)
    })

    test('Cmd+D and Cmd+Shift+I work with effect layer active', async ({ page }) => {
        await setupApp(page)
        await page.evaluate(async () => {
            await window.layersApp._handleAddEffectLayer('filter/blur')
        })
        await setRectSelection(page, 0, 0, 512, 512)
        await page.keyboard.press('Meta+Shift+i')
        await appState(page, () => window.layersApp._selectionManager.selectionPath?.type === 'mask')
        expect(await page.evaluate(() => window.layersApp._selectionManager.hasSelection())).toBe(true)
        await page.keyboard.press('Meta+d')
        await appState(page, () => !window.layersApp._selectionManager.hasSelection())
        expect(await page.evaluate(() => window.layersApp._selectionManager.hasSelection())).toBe(false)
    })

    test('Cmd+D and Cmd+Shift+I work with no layer selected', async ({ page }) => {
        await setupApp(page)
        await page.evaluate(() => {
            window.layersApp._deselectAllLayers()
        })
        expect(await page.evaluate(() => window.layersApp._layerStack?.selectedLayerIds.length)).toBe(0)
        await setRectSelection(page, 0, 0, 512, 512)
        await page.keyboard.press('Meta+Shift+i')
        await appState(page, () => window.layersApp._selectionManager.selectionPath?.type === 'mask')
        expect(await page.evaluate(() => window.layersApp._selectionManager.hasSelection())).toBe(true)
        await page.keyboard.press('Meta+d')
        await appState(page, () => !window.layersApp._selectionManager.hasSelection())
        expect(await page.evaluate(() => window.layersApp._selectionManager.hasSelection())).toBe(false)
    })

    test('Cmd+D and Cmd+Shift+I inside an input do not alter canvas selection', async ({ page }) => {
        await setupApp(page)
        await setRectSelection(page, 100, 100, 200, 200)
        expect(await page.evaluate(() => window.layersApp._selectionManager.hasSelection())).toBe(true)

        // Activate brush to display drawing options bar containing #drawingSizeInput
        await page.keyboard.press('b')
        const input = page.locator('#drawingSizeInput')
        await input.waitFor({ state: 'visible' })
        await input.focus()

        // Press Cmd+D and Cmd+Shift+I while typing/focused in input
        await page.keyboard.press('Meta+d')
        // Canvas selection must remain intact
        expect(await page.evaluate(() => window.layersApp._selectionManager.hasSelection())).toBe(true)
        expect(await page.evaluate(() => window.layersApp._selectionManager.selectionPath?.type)).toBe('rect')

        await page.keyboard.press('Meta+Shift+i')
        // Canvas selection must not be inverted
        expect(await page.evaluate(() => window.layersApp._selectionManager.selectionPath?.type)).toBe('rect')
    })

    test('setSelection with non-positive or malformed bounds safely clears selection', async ({ page }) => {
        await setupApp(page)
        await setRectSelection(page, 10, 10, 100, 100)
        expect(await page.evaluate(() => window.layersApp._selectionManager.hasSelection())).toBe(true)

        // Rect with zero/negative or NaN width/height
        await page.evaluate(() => window.layersApp._selectionManager.setSelection({ type: 'rect', x: 0, y: 0, width: 0, height: 100 }))
        expect(await page.evaluate(() => window.layersApp._selectionManager.hasSelection())).toBe(false)

        await setRectSelection(page, 10, 10, 100, 100)
        await page.evaluate(() => window.layersApp._selectionManager.setSelection({ type: 'rect', x: 0, y: 0, width: NaN, height: 100 }))
        expect(await page.evaluate(() => window.layersApp._selectionManager.hasSelection())).toBe(false)

        // Oval with non-positive or non-finite radius
        await setRectSelection(page, 10, 10, 100, 100)
        await page.evaluate(() => window.layersApp._selectionManager.setSelection({ type: 'oval', cx: 50, cy: 50, rx: 0, ry: 50 }))
        expect(await page.evaluate(() => window.layersApp._selectionManager.hasSelection())).toBe(false)

        // Polygon with < 3 points
        await setRectSelection(page, 10, 10, 100, 100)
        await page.evaluate(() => window.layersApp._selectionManager.setSelection({ type: 'polygon', points: [{ x: 10, y: 10 }] }))
        expect(await page.evaluate(() => window.layersApp._selectionManager.hasSelection())).toBe(false)

        // Unknown type
        await setRectSelection(page, 10, 10, 100, 100)
        await page.evaluate(() => window.layersApp._selectionManager.setSelection({ type: 'unknown_type' }))
        expect(await page.evaluate(() => window.layersApp._selectionManager.hasSelection())).toBe(false)
    })
})
