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

test.describe('Color well', () => {
    test('color well exists in toolbar', async ({ page }) => {
        await page.goto('/', { waitUntil: 'networkidle' })
        await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })
        await createTransparentProject(page)

        const well = await page.$('#colorWell')
        expect(well).not.toBeNull()

        const input = await page.$('#colorWellInput')
        expect(input).not.toBeNull()
    })

    test('changing color well updates foreground color', async ({ page }) => {
        await page.goto('/', { waitUntil: 'networkidle' })
        await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })
        await createTransparentProject(page)

        await page.evaluate(() => {
            const input = document.getElementById('colorWellInput')
            input.value = '#ff5500'
            input.dispatchEvent(new Event('input'))
        })

        const color = await page.evaluate(() => window.layersApp._foregroundColor)
        expect(color).toBe('#ff5500')
    })

    test('color well background reflects foreground color', async ({ page }) => {
        await page.goto('/', { waitUntil: 'networkidle' })
        await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })
        await createTransparentProject(page)

        await page.evaluate(() => {
            window.layersApp._setForegroundColor('#0000ff')
        })

        const bg = await page.evaluate(() =>
            document.getElementById('colorWell').style.backgroundColor
        )
        expect(bg).toMatch(/blue|rgb\(0,\s*0,\s*255\)|#0000ff/i)
    })
})
