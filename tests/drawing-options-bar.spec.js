// tests/drawing-options-bar.spec.js
import { test, expect } from './fixtures.js'

async function createTransparentProject(page) {
    await page.waitForSelector('.open-dialog-backdrop.visible')
    await page.click('.media-option[data-type="transparent"]')
    await page.waitForSelector('.canvas-size-dialog', { timeout: 5000 })
    await page.click('.canvas-size-dialog .action-btn.primary')
    await page.waitForSelector('.open-dialog-backdrop.visible', { state: 'hidden', timeout: 5000 })
    await page.waitForTimeout(500)
}

test.describe('Drawing options bar', () => {
    test('options bar appears when brush tool is active', async ({ page }) => {
        await page.goto('/', { waitUntil: 'networkidle' })
        await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })
        await createTransparentProject(page)

        await page.click('#brushToolBtn')

        const visible = await page.evaluate(() => {
            const bar = document.getElementById('drawingOptionsBar')
            return bar && !bar.classList.contains('hidden')
        })
        expect(visible).toBe(true)
    })

    test('options bar hides when non-drawing tool is active', async ({ page }) => {
        await page.goto('/', { waitUntil: 'networkidle' })
        await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })
        await createTransparentProject(page)

        await page.click('#brushToolBtn')
        await page.click('#moveToolBtn')

        const hidden = await page.evaluate(() => {
            const bar = document.getElementById('drawingOptionsBar')
            return bar && bar.classList.contains('hidden')
        })
        expect(hidden).toBe(true)
    })

    test('changing brush size updates brush tool', async ({ page }) => {
        await page.goto('/', { waitUntil: 'networkidle' })
        await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })
        await createTransparentProject(page)

        await page.click('#brushToolBtn')
        await page.fill('#drawingSizeInput', '25')
        await page.dispatchEvent('#drawingSizeInput', 'change')

        const size = await page.evaluate(() =>
            window.layersApp._brushTool.size
        )
        expect(size).toBe(25)
    })
})
