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

test.describe('LayersAgent.getState', () => {
    test('returns ok envelope with full snapshot', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() => window.LayersAgent.getState())
        expect(env.ok).toBe(true)
        expect(env.command).toBe('getState')
        expect(env.apiVersion).toBe('1.0')
        expect(env.state).toMatchObject({
            apiVersion: '1.0',
            schemaVersion: '1.0',
            project: expect.any(Object),
            canvas: expect.any(Object),
            view: expect.any(Object),
            layers: expect.any(Array)
        })
        // result is the same snapshot for getState specifically
        expect(env.result).toEqual(env.state)
    })

    test('every command response includes a state snapshot', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() => window.LayersAgent._ping())
        expect(env.state).not.toBeNull()
        expect(env.state.apiVersion).toBe('1.0')
    })
})

test.describe('LayersAgent inspection commands', () => {
    test('getLayer returns a single layer descriptor', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() => {
            const id = window.layersApp._layers[0].id
            return window.LayersAgent.getLayer({ layerId: id })
        })
        expect(env.ok).toBe(true)
        expect(env.result).toMatchObject({
            id: expect.stringMatching(/^layer-/),
            sourceType: expect.any(String)
        })
    })

    test('getLayer returns NOT_FOUND_LAYER for missing layer', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() =>
            window.LayersAgent.getLayer({ layerId: 'layer-nope' })
        )
        expect(env.ok).toBe(false)
        expect(env.error.code).toBe('NOT_FOUND_LAYER')
        // Task 7 contract: envelopes from structured commandErrors must carry state.
        expect(env.state).not.toBeNull()
        expect(env.state.apiVersion).toBe('1.0')
    })

    test('getCanvasSize returns width and height', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() => window.LayersAgent.getCanvasSize())
        expect(env.ok).toBe(true)
        expect(env.result.width).toBeGreaterThan(0)
        expect(env.result.height).toBeGreaterThan(0)
    })

    test('getSelection returns null when no selection', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() => window.LayersAgent.getSelection())
        expect(env.ok).toBe(true)
        expect(env.result).toBeNull()
    })

    test('getSelection returns descriptor when selection exists', async ({ page }) => {
        await bootApp(page)
        await page.evaluate(() => {
            window.layersApp._selectionManager._selectionPath = {
                type: 'rect', x: 1, y: 2, width: 30, height: 40
            }
            window.layersApp._selectionManager._drawMarchingAnts()
        })
        const env = await page.evaluate(() => window.LayersAgent.getSelection())
        expect(env.ok).toBe(true)
        expect(env.result.kind).toBe('rectangle')
        expect(env.result.bounds).toEqual({ x: 1, y: 2, width: 30, height: 40 })
    })

    test('validation-failure envelopes also carry a state snapshot', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() =>
            window.LayersAgent._echoNumber({ value: 999 })
        )
        expect(env.ok).toBe(false)
        expect(env.error.code).toBe('INVALID_ARGS_RANGE')
        expect(env.state).not.toBeNull()
        expect(env.state.apiVersion).toBe('1.0')
    })
})
