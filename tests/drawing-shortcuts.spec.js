// tests/drawing-shortcuts.spec.js
import { test, expect } from './fixtures.js'
import { appReady } from './waits.js'

async function createTransparentProject(page) {
    await page.waitForSelector('.open-dialog-backdrop.visible')
    await page.click('.media-option[data-type="transparent"]')
    await page.waitForSelector('.canvas-size-dialog', { timeout: 5000 })
    await page.click('.canvas-size-dialog .action-btn.primary')
    await page.waitForSelector('.open-dialog-backdrop.visible', { state: 'hidden', timeout: 5000 })
    await appReady(page)
}

test.describe('Drawing keyboard shortcuts', () => {
    test('B activates brush tool', async ({ page }) => {
        await page.goto('/', { waitUntil: 'networkidle' })
        await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })
        await createTransparentProject(page)

        await page.keyboard.press('b')
        const tool = await page.evaluate(() => window.layersApp._currentTool)
        expect(tool).toBe('brush')
    })

    test('E activates eraser tool', async ({ page }) => {
        await page.goto('/', { waitUntil: 'networkidle' })
        await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })
        await createTransparentProject(page)

        await page.keyboard.press('e')
        const tool = await page.evaluate(() => window.layersApp._currentTool)
        expect(tool).toBe('eraser')
    })

    test('U activates shape tool', async ({ page }) => {
        await page.goto('/', { waitUntil: 'networkidle' })
        await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })
        await createTransparentProject(page)

        await page.keyboard.press('u')
        const tool = await page.evaluate(() => window.layersApp._currentTool)
        expect(tool).toBe('shape')
    })

    test('G activates fill tool', async ({ page }) => {
        await page.goto('/', { waitUntil: 'networkidle' })
        await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })
        await createTransparentProject(page)

        await page.keyboard.press('g')
        const tool = await page.evaluate(() => window.layersApp._currentTool)
        expect(tool).toBe('fill')
    })

    test('V activates move tool', async ({ page }) => {
        await page.goto('/', { waitUntil: 'networkidle' })
        await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })
        await createTransparentProject(page)

        await page.keyboard.press('b')
        expect(await page.evaluate(() => window.layersApp._currentTool)).toBe('brush')

        await page.keyboard.press('v')
        const tool = await page.evaluate(() => window.layersApp._currentTool)
        expect(tool).toBe('move')
    })

    test('M activates marquee selection and Shift+M cycles rectangle and oval', async ({ page }) => {
        await page.goto('/', { waitUntil: 'networkidle' })
        await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })
        await createTransparentProject(page)

        await page.keyboard.press('b')
        expect(await page.evaluate(() => window.layersApp._currentTool)).toBe('brush')

        await page.keyboard.press('m')
        const tool = await page.evaluate(() => window.layersApp._currentTool)
        const selShape = await page.evaluate(() => window.layersApp._selectionManager.currentTool)
        expect(tool).toBe('selection')
        expect(selShape).toBe('rectangle')

        await page.keyboard.press('Shift+M')
        const cycledShape = await page.evaluate(() => window.layersApp._selectionManager.currentTool)
        expect(cycledShape).toBe('oval')

        await page.keyboard.press('Shift+M')
        const recShape = await page.evaluate(() => window.layersApp._selectionManager.currentTool)
        expect(recShape).toBe('rectangle')
    })

    test('L activates lasso selection and Shift+L cycles lasso and polygon', async ({ page }) => {
        await page.goto('/', { waitUntil: 'networkidle' })
        await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })
        await createTransparentProject(page)

        await page.keyboard.press('b')
        expect(await page.evaluate(() => window.layersApp._currentTool)).toBe('brush')

        await page.keyboard.press('l')
        const tool = await page.evaluate(() => window.layersApp._currentTool)
        const selShape = await page.evaluate(() => window.layersApp._selectionManager.currentTool)
        expect(tool).toBe('selection')
        expect(selShape).toBe('lasso')

        await page.keyboard.press('Shift+L')
        const cycledShape = await page.evaluate(() => window.layersApp._selectionManager.currentTool)
        expect(cycledShape).toBe('polygon')

        await page.keyboard.press('Shift+L')
        const recShape = await page.evaluate(() => window.layersApp._selectionManager.currentTool)
        expect(recShape).toBe('lasso')
    })

    test('W activates magic wand selection', async ({ page }) => {
        await page.goto('/', { waitUntil: 'networkidle' })
        await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })
        await createTransparentProject(page)

        await page.keyboard.press('b')
        expect(await page.evaluate(() => window.layersApp._currentTool)).toBe('brush')

        await page.keyboard.press('w')
        const tool = await page.evaluate(() => window.layersApp._currentTool)
        const selShape = await page.evaluate(() => window.layersApp._selectionManager.currentTool)
        expect(tool).toBe('selection')
        expect(selShape).toBe('wand')
    })

    test('S activates clone tool', async ({ page }) => {
        await page.goto('/', { waitUntil: 'networkidle' })
        await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })
        await createTransparentProject(page)

        await page.keyboard.press('b')
        expect(await page.evaluate(() => window.layersApp._currentTool)).toBe('brush')

        await page.keyboard.press('s')
        const tool = await page.evaluate(() => window.layersApp._currentTool)
        expect(tool).toBe('clone')
    })

    test('Z zooms in and Shift+Z zooms out', async ({ page }) => {
        await page.goto('/', { waitUntil: 'networkidle' })
        await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })
        await createTransparentProject(page)

        await page.evaluate(() => window.layersApp._setZoom('100'))
        await page.keyboard.press('z')
        expect(await page.evaluate(() => window.layersApp._zoomMode)).toBe('200')

        await page.keyboard.press('Shift+Z')
        expect(await page.evaluate(() => window.layersApp._zoomMode)).toBe('100')
    })

    test('Cmd+=, Cmd+-, Cmd+0, and Cmd+1 handle zoom shortcuts', async ({ page }) => {
        await page.goto('/', { waitUntil: 'networkidle' })
        await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })
        await createTransparentProject(page)

        await page.keyboard.press('Meta+1')
        expect(await page.evaluate(() => window.layersApp._zoomMode)).toBe('100')

        await page.keyboard.press('Meta+=')
        expect(await page.evaluate(() => window.layersApp._zoomMode)).toBe('200')

        await page.keyboard.press('Meta+-')
        expect(await page.evaluate(() => window.layersApp._zoomMode)).toBe('100')

        await page.keyboard.press('Meta+0')
        expect(await page.evaluate(() => window.layersApp._zoomMode)).toBe('fit')
    })

    test('Toolbar buttons have standardized shortcuts in tooltips and selection title updates', async ({ page }) => {
        await page.goto('/', { waitUntil: 'networkidle' })
        await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })
        await createTransparentProject(page)

        const moveTitle = await page.getAttribute('#moveToolBtn', 'title')
        expect(moveTitle).toContain('(V)')

        const cloneTitle = await page.getAttribute('#cloneToolBtn', 'title')
        expect(cloneTitle).toContain('(S)')

        const selTitleDefault = await page.getAttribute('#selectionToolBtn', 'title')
        expect(selTitleDefault).toContain('(M)')

        // Switch to lasso
        await page.keyboard.press('l')
        const selTitleLasso = await page.getAttribute('#selectionToolBtn', 'title')
        expect(selTitleLasso).toContain('(L)')

        // Switch to wand
        await page.keyboard.press('w')
        const selTitleWand = await page.getAttribute('#selectionToolBtn', 'title')
        expect(selTitleWand).toContain('(W)')
    })

    test('[ and ] change brush size', async ({ page }) => {
        await page.goto('/', { waitUntil: 'networkidle' })
        await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })
        await createTransparentProject(page)

        await page.keyboard.press('b')
        const initial = await page.evaluate(() => window.layersApp._brushTool.size)

        await page.keyboard.press(']')
        const increased = await page.evaluate(() => window.layersApp._brushTool.size)
        expect(increased).toBe(initial + 5)

        await page.keyboard.press('[')
        const decreased = await page.evaluate(() => window.layersApp._brushTool.size)
        expect(decreased).toBe(initial)
    })

    test('single-key tool shortcuts do not trigger when Control or Meta is pressed', async ({ page }) => {
        await page.goto('/', { waitUntil: 'networkidle' })
        await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })
        await createTransparentProject(page)

        // Set initial tool to brush
        await page.keyboard.press('b')
        expect(await page.evaluate(() => window.layersApp._currentTool)).toBe('brush')

        // Meta+m should not activate marquee tool
        await page.keyboard.press('Meta+m')
        expect(await page.evaluate(() => window.layersApp._currentTool)).toBe('brush')

        // Control+l should not activate lasso tool
        await page.keyboard.press('Control+l')
        expect(await page.evaluate(() => window.layersApp._currentTool)).toBe('brush')

        // Meta+t should not activate transform tool
        await page.keyboard.press('Meta+t')
        expect(await page.evaluate(() => window.layersApp._toolMode || window.layersApp._currentTool)).toBe('brush')
    })

    test('Shift+V toggles layer visibility', async ({ page }) => {
        await page.goto('/', { waitUntil: 'networkidle' })
        await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })
        await createTransparentProject(page)

        const visibleBefore = await page.evaluate(() => {
            const layer = window.layersApp._layerStack.getSelectedLayer()
            return layer.visible
        })
        expect(visibleBefore).toBe(true)

        await page.keyboard.press('Shift+V')
        const visibleAfterToggle = await page.evaluate(() => {
            const layer = window.layersApp._layerStack.getSelectedLayer()
            return layer.visible
        })
        expect(visibleAfterToggle).toBe(false)

        await page.keyboard.press('Shift+V')
        const visibleAfterSecondToggle = await page.evaluate(() => {
            const layer = window.layersApp._layerStack.getSelectedLayer()
            return layer.visible
        })
        expect(visibleAfterSecondToggle).toBe(true)
    })

    test('Alt+Z zooms out', async ({ page }) => {
        await page.goto('/', { waitUntil: 'networkidle' })
        await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })
        await createTransparentProject(page)

        await page.evaluate(() => window.layersApp._setZoom('200'))
        expect(await page.evaluate(() => window.layersApp._zoomMode)).toBe('200')

        await page.keyboard.press('Alt+z')
        expect(await page.evaluate(() => window.layersApp._zoomMode)).toBe('100')
    })

    test('Cmd+A in text input does not clear or hijack input text', async ({ page }) => {
        await page.goto('/', { waitUntil: 'networkidle' })
        await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })
        await createTransparentProject(page)

        // Activate brush to display drawing options bar containing #drawingSizeInput
        await page.keyboard.press('b')
        const input = page.locator('#drawingSizeInput')
        await input.waitFor({ state: 'visible' })
        await input.focus()
        await page.keyboard.press('Meta+a')

        // Selection manager should not have set a full canvas rect selection
        const hasSelection = await page.evaluate(() => window.layersApp._selectionManager?.hasSelection())
        expect(hasSelection).toBeFalsy()
    })
})
