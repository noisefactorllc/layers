// tests/drawing-shortcuts.spec.js
import { test, expect } from './fixtures.js'

async function createTransparentProject(page) {
    await page.waitForSelector('.open-dialog-backdrop.visible')
    await page.click('.media-option[data-type="transparent"]')
    await page.waitForSelector('.canvas-size-dialog', { timeout: 5000 })
    await page.click('.canvas-size-dialog .action-btn.primary')
    await page.waitForSelector('.open-dialog-backdrop.visible', { state: 'hidden', timeout: 5000 })
    await page.waitForTimeout(500)
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
})
