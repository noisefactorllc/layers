import { test, expect } from './fixtures.js'
import { reopenNewProjectDialog } from './helpers/new-project.js'

async function bootApp(page) {
    await page.goto('/', { waitUntil: 'networkidle' })
    await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })
    await page.evaluate(async () => { await window.LayersAgent.ready })
    await reopenNewProjectDialog(page)
    await page.click('.media-option[data-type="solid"]')
    await page.waitForSelector('.canvas-size-dialog', { timeout: 5000 })
    await page.click('.canvas-size-dialog .action-btn.primary')
    await page.waitForSelector('.open-dialog-backdrop.visible', { state: 'hidden', timeout: 5000 })
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

    test('featherSelection produces symmetric falloff and softens at r=1', async ({ page }) => {
        await bootApp(page)

        // 1. Verify r=1 boundary softening on live canvas
        await page.evaluate(() =>
            window.LayersAgent.setRectangleSelection({ x: 100, y: 100, width: 200, height: 200 }))
        const env1 = await page.evaluate(() =>
            window.LayersAgent.featherSelection({ pixels: 1 }))
        expect(env1.ok).toBe(true)

        const samples1 = await page.evaluate(() => {
            const sm = window.layersApp._selectionManager
            const mask = sm._selectionPath?.data
            if (!mask) return null
            const y = 200
            return {
                inside: mask.data[(y * mask.width + 299) * 4 + 3],
                outside: mask.data[(y * mask.width + 300) * 4 + 3]
            }
        })
        expect(samples1).not.toBeNull()
        expect(samples1.inside).toBe(191)
        expect(samples1.outside).toBe(64)
        expect(samples1.inside + samples1.outside).toBe(255)

        // 2. Verify r=2 symmetric falloff across the 4-pixel span
        await page.evaluate(() =>
            window.LayersAgent.setRectangleSelection({ x: 100, y: 100, width: 200, height: 200 }))
        const env2 = await page.evaluate(() =>
            window.LayersAgent.featherSelection({ pixels: 2 }))
        expect(env2.ok).toBe(true)

        const samples2 = await page.evaluate(() => {
            const sm = window.layersApp._selectionManager
            const mask = sm._selectionPath?.data
            if (!mask) return null
            const y = 200
            const res = []
            for (let x = 298; x <= 301; x++) {
                res.push({ x, a: mask.data[(y * mask.width + x) * 4 + 3] })
            }
            return res
        })
        expect(samples2).not.toBeNull()
        const p298 = samples2.find(s => s.x === 298).a
        const p299 = samples2.find(s => s.x === 299).a
        const p300 = samples2.find(s => s.x === 300).a
        const p301 = samples2.find(s => s.x === 301).a
        expect(p299).toBeGreaterThan(128)
        expect(p300).toBeLessThan(128)
        expect(p299 + p300).toBe(255)
        expect(p298 + p301).toBe(255)
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
