// tests/drawing-tool-buttons.spec.js
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

test.describe('Drawing tool buttons', () => {
    test('brush tool button exists and activates', async ({ page }) => {
        await page.goto('/', { waitUntil: 'networkidle' })
        await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })
        await createTransparentProject(page)

        const btn = await page.$('#brushToolBtn')
        expect(btn).not.toBeNull()

        await page.click('#brushToolBtn')
        const isActive = await page.evaluate(() =>
            document.getElementById('brushToolBtn').classList.contains('active')
        )
        expect(isActive).toBe(true)
    })

    test('eraser tool button exists and activates', async ({ page }) => {
        await page.goto('/', { waitUntil: 'networkidle' })
        await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })
        await createTransparentProject(page)

        await page.click('#eraserToolBtn')
        const isActive = await page.evaluate(() =>
            document.getElementById('eraserToolBtn').classList.contains('active')
        )
        expect(isActive).toBe(true)
    })

    test('shape tool button exists and activates', async ({ page }) => {
        await page.goto('/', { waitUntil: 'networkidle' })
        await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })
        await createTransparentProject(page)

        await page.click('#shapeToolBtn')
        const isActive = await page.evaluate(() =>
            document.getElementById('shapeToolBtn').classList.contains('active')
        )
        expect(isActive).toBe(true)
    })

    test('fill tool button exists and activates', async ({ page }) => {
        await page.goto('/', { waitUntil: 'networkidle' })
        await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })
        await createTransparentProject(page)

        await page.click('#fillToolBtn')
        const isActive = await page.evaluate(() =>
            document.getElementById('fillToolBtn').classList.contains('active')
        )
        expect(isActive).toBe(true)
    })

    test('switching tools deactivates previous tool', async ({ page }) => {
        await page.goto('/', { waitUntil: 'networkidle' })
        await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })
        await createTransparentProject(page)

        await page.click('#brushToolBtn')
        await page.click('#eraserToolBtn')

        const brushActive = await page.evaluate(() =>
            document.getElementById('brushToolBtn').classList.contains('active')
        )
        expect(brushActive).toBe(false)
    })

    test('_ensureDrawingLayer auto-creates drawing layer', async ({ page }) => {
        await page.goto('/', { waitUntil: 'networkidle' })
        await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })
        await createTransparentProject(page)

        const result = await page.evaluate(() => {
            const app = window.layersApp
            const layer = app._ensureDrawingLayer()
            return { sourceType: layer.sourceType, name: layer.name }
        })

        expect(result.sourceType).toBe('drawing')
    })
})
