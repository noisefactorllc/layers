import { test, expect } from './fixtures.js'

async function createTransparentProject(page) {
    await page.waitForSelector('.open-dialog-backdrop.visible')
    await page.click('.media-option[data-type="transparent"]')
    await page.waitForSelector('.canvas-size-dialog', { timeout: 5000 })
    await page.click('.canvas-size-dialog .action-btn.primary')
    await page.waitForSelector('.open-dialog-backdrop.visible', { state: 'hidden', timeout: 5000 })
    await page.waitForTimeout(500)
}

test.describe('Shape tool split-button', () => {
    test('shape tool has split-button with caret', async ({ page }) => {
        await page.goto('/', { waitUntil: 'networkidle' })
        await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })
        await createTransparentProject(page)

        const hasBtn = await page.$('#shapeToolBtn')
        expect(hasBtn).not.toBeNull()

        const hasCaret = await page.$('#shapeMenu .tool-caret')
        expect(hasCaret).not.toBeNull()
    })

    test('dropdown shows box and oval options', async ({ page }) => {
        await page.goto('/', { waitUntil: 'networkidle' })
        await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })
        await createTransparentProject(page)

        await page.click('#shapeMenu .tool-caret')

        const items = await page.evaluate(() => {
            const els = document.querySelectorAll('#shapeMenu .tool-menu-item')
            return [...els].map(el => `${el.dataset.shape}-${el.dataset.filled}`)
        })
        expect(items).toEqual(['rect-false', 'rect-true', 'ellipse-false', 'ellipse-true'])
    })

    test('selecting oval updates icon and shape tool type', async ({ page }) => {
        await page.goto('/', { waitUntil: 'networkidle' })
        await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })
        await createTransparentProject(page)

        await page.click('#shapeMenu .tool-caret')
        await page.click('#shapeMenu [data-shape="ellipse"]')

        const result = await page.evaluate(() => ({
            icon: document.querySelector('#shapeToolBtn .icon-material')?.textContent?.trim(),
            shapeType: window.layersApp._shapeTool.shapeType
        }))

        expect(result.icon).toBe('circle')
        expect(result.shapeType).toBe('ellipse')
    })
})
