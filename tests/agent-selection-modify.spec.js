import { test, expect } from 'playwright/test'

async function bootApp(page) {
    await page.goto('/', { waitUntil: 'networkidle' })
    await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })
    await page.evaluate(async () => { await window.LayersAgent.ready })
    const visible = await page.evaluate(() => !!document.querySelector('.open-dialog-backdrop.visible'))
    if (visible) {
        await page.click('.media-option[data-type="solid"]')
        await page.waitForSelector('.canvas-size-dialog', { timeout: 5000 })
        await page.click('.canvas-size-dialog .action-btn.primary')
        await page.waitForSelector('.open-dialog-backdrop.visible', { state: 'hidden', timeout: 5000 })
    }
}

test.describe('expandSelection', () => {
    test('expands a rectangle selection by N pixels', async ({ page }) => {
        await bootApp(page)
        await page.evaluate(() =>
            window.LayersAgent.setRectangleSelection({ x: 100, y: 100, width: 100, height: 100 }))
        const env = await page.evaluate(() =>
            window.LayersAgent.expandSelection({ pixels: 10 }))
        expect(env.ok).toBe(true)
        expect(env.state.selection).not.toBeNull()
        expect(env.state.selection.kind).toBe('color-range')
        const b = env.state.selection.bounds
        expect(b.x).toBeLessThanOrEqual(100 - 10)
        expect(b.y).toBeLessThanOrEqual(100 - 10)
        expect(b.width).toBeGreaterThanOrEqual(120)
        expect(b.height).toBeGreaterThanOrEqual(120)
    })

    test('expandSelection rejects no active selection', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() =>
            window.LayersAgent.expandSelection({ pixels: 10 }))
        expect(env.ok).toBe(false)
        expect(env.error.code).toBe('CONFLICT_NO_SELECTION')
    })
})

test.describe('contractSelection', () => {
    test('contracts a rectangle selection by N pixels', async ({ page }) => {
        await bootApp(page)
        await page.evaluate(() =>
            window.LayersAgent.setRectangleSelection({ x: 100, y: 100, width: 200, height: 200 }))
        const env = await page.evaluate(() =>
            window.LayersAgent.contractSelection({ pixels: 10 }))
        expect(env.ok).toBe(true)
        const b = env.state.selection.bounds
        expect(b.width).toBeLessThanOrEqual(180)
        expect(b.height).toBeLessThanOrEqual(180)
    })
})

test.describe('featherSelection / smoothSelection / borderSelection', () => {
    test('featherSelection produces a mask selection', async ({ page }) => {
        await bootApp(page)
        await page.evaluate(() =>
            window.LayersAgent.setRectangleSelection({ x: 100, y: 100, width: 200, height: 200 }))
        const env = await page.evaluate(() =>
            window.LayersAgent.featherSelection({ pixels: 5 }))
        expect(env.ok).toBe(true)
        expect(env.state.selection.kind).toBe('color-range')
    })

    test('smoothSelection produces a mask selection', async ({ page }) => {
        await bootApp(page)
        await page.evaluate(() =>
            window.LayersAgent.setRectangleSelection({ x: 100, y: 100, width: 200, height: 200 }))
        const env = await page.evaluate(() =>
            window.LayersAgent.smoothSelection({ pixels: 5 }))
        expect(env.ok).toBe(true)
        expect(env.state.selection.kind).toBe('color-range')
    })

    test('borderSelection produces a mask selection', async ({ page }) => {
        await bootApp(page)
        await page.evaluate(() =>
            window.LayersAgent.setRectangleSelection({ x: 100, y: 100, width: 200, height: 200 }))
        const env = await page.evaluate(() =>
            window.LayersAgent.borderSelection({ pixels: 5 }))
        expect(env.ok).toBe(true)
        expect(env.state.selection.kind).toBe('color-range')
    })

    test('featherSelection NO_SELECTION', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() =>
            window.LayersAgent.featherSelection({ pixels: 5 }))
        expect(env.ok).toBe(false)
        expect(env.error.code).toBe('CONFLICT_NO_SELECTION')
    })
})

test.describe('cropToSelection', () => {
    test('crops the canvas to the selection bbox', async ({ page }) => {
        await bootApp(page)
        await page.evaluate(() =>
            window.LayersAgent.setRectangleSelection({ x: 100, y: 200, width: 300, height: 150 }))
        const env = await page.evaluate(() => window.LayersAgent.cropToSelection())
        expect(env.ok).toBe(true)
        expect(env.state.canvas.width).toBe(300)
        expect(env.state.canvas.height).toBe(150)
    })

    test('cropToSelection rejects no active selection', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() => window.LayersAgent.cropToSelection())
        expect(env.ok).toBe(false)
        expect(env.error.code).toBe('CONFLICT_NO_SELECTION')
    })
})
