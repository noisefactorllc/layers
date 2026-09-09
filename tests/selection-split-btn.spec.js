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

test.describe('Selection tool split-button', () => {
    test('selection tool has split-button structure', async ({ page }) => {
        await page.goto('/', { waitUntil: 'networkidle' })
        await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })
        await createTransparentProject(page)

        const hasBtn = await page.$('#selectionToolBtn')
        expect(hasBtn).not.toBeNull()

        const hasCaret = await page.$('#selectionMenu .tool-caret')
        expect(hasCaret).not.toBeNull()
    })

    test('clicking caret opens dropdown with shape options', async ({ page }) => {
        await page.goto('/', { waitUntil: 'networkidle' })
        await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })
        await createTransparentProject(page)

        await page.click('#selectionMenu .tool-caret')
        const visible = await page.evaluate(() => {
            const items = document.querySelector('#selectionMenu .menu-items')
            return items && !items.classList.contains('hide')
        })
        expect(visible).toBe(true)
    })

    test('selecting oval updates main button icon', async ({ page }) => {
        await page.goto('/', { waitUntil: 'networkidle' })
        await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })
        await createTransparentProject(page)

        await page.click('#selectionMenu .tool-caret')
        await page.click('#selectionMenu [data-shape="oval"]')

        const hasEllipse = await page.evaluate(() => {
            const svg = document.getElementById('selectionToolIcon')
            return svg?.tagName === 'svg' && svg.querySelector('ellipse') !== null
        })
        expect(hasEllipse).toBe(true)
    })

    test('main button activates selection tool with last shape', async ({ page }) => {
        await page.goto('/', { waitUntil: 'networkidle' })
        await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })
        await createTransparentProject(page)

        // Switch to another tool first
        await page.click('#brushToolBtn')

        // Click main selection button
        await page.click('#selectionToolBtn')

        const tool = await page.evaluate(() => window.layersApp._currentTool)
        expect(tool).toBe('selection')
    })
})
