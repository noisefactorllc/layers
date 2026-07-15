import { test, expect } from 'playwright/test'

async function setupApp(page) {
    await page.goto('/', { waitUntil: 'networkidle' })
    await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })
    await page.waitForSelector('.open-dialog-backdrop.visible')
    await page.click('.media-option[data-type="solid"]')
    await page.waitForSelector('.canvas-size-dialog', { timeout: 5000 })
    await page.click('.canvas-size-dialog .action-btn.primary')
    await page.waitForSelector('.open-dialog-backdrop.visible', { state: 'hidden', timeout: 5000 })
    await page.waitForTimeout(500)
}

async function setRectSelection(page, x, y, w, h) {
    await page.evaluate(({ x, y, w, h }) => {
        window.layersApp._selectionManager.setSelection({
            type: 'rect', x, y, width: w, height: h
        })
    }, { x, y, w, h })
    await page.waitForTimeout(100)
}

async function openSelectMenu(page) {
    // The Select menu dropdown is hidden by default (.hide class).
    // We need to click its title to reveal the menu items.
    await page.evaluate(() => {
        const menus = document.querySelectorAll('.menu')
        for (const menu of menus) {
            const title = menu.querySelector('.menu-title')
            if (title && title.textContent.trim() === 'select') {
                menu.querySelector('.menu-items')?.classList.remove('hide')
                return
            }
        }
    })
    await page.waitForTimeout(50)
}

test.describe('Select Menu', () => {
    test('select all creates full-canvas selection', async ({ page }) => {
        await setupApp(page)
        await openSelectMenu(page)
        await page.click('#selectAllMenuItem')
        await page.waitForTimeout(100)

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
        await page.waitForTimeout(100)

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
        await page.waitForTimeout(100)

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
        await page.waitForTimeout(200)

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

    test('contract selection shrinks the mask', async ({ page }) => {
        await setupApp(page)
        await setRectSelection(page, 100, 100, 100, 100)

        await openSelectMenu(page)
        await page.click('#contractSelectionMenuItem')
        await page.waitForSelector('.selection-param-dialog[open]', { timeout: 2000 })
        await page.fill('#selection-param-input', '10')
        await page.click('#selection-param-ok')
        await page.waitForTimeout(200)

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
            return ids.every(id => document.getElementById(id)?.classList.contains('disabled'))
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
            return ids.every(id => !document.getElementById(id)?.classList.contains('disabled'))
        })
        expect(enabled).toBe(true)
    })

    test('Cmd+A selects all via keyboard', async ({ page }) => {
        await setupApp(page)
        await page.keyboard.press('Meta+a')
        await page.waitForTimeout(100)

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
})
