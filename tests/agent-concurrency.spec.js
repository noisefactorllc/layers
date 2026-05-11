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

test.describe('LayersAgent concurrency', () => {
    test('5 parallel calls all succeed and return in input order', async ({ page }) => {
        await bootApp(page)
        const results = await page.evaluate(async () => {
            const out = await Promise.all([
                window.LayersAgent.getState(),
                window.LayersAgent.getCanvasSize(),
                window.LayersAgent.getProjectInfo(),
                window.LayersAgent.getForegroundColor(),
                window.LayersAgent.getState()
            ])
            return out.map(e => ({ ok: e.ok, command: e.command }))
        })
        expect(results.every(r => r.ok)).toBe(true)
        expect(results.map(r => r.command)).toEqual([
            'getState', 'getCanvasSize', 'getProjectInfo',
            'getForegroundColor', 'getState'
        ])
    })

    test('failure in one command does not block subsequent commands', async ({ page }) => {
        await bootApp(page)
        const results = await page.evaluate(async () => {
            const out = await Promise.all([
                window.LayersAgent.getLayer({ layerId: 'layer-nope' }),
                window.LayersAgent.getCanvasSize()
            ])
            return out.map(e => ({ ok: e.ok, command: e.command, code: e.error?.code }))
        })
        expect(results[0].ok).toBe(false)
        expect(results[0].code).toBe('NOT_FOUND_LAYER')
        expect(results[1].ok).toBe(true)
    })

    test('serialization holds: slow call resolves before fast call when queued in parallel', async ({ page }) => {
        await bootApp(page)
        const order = await page.evaluate(async () => {
            const events = []
            // Issue slow first, then fast. With serialization, slow finishes
            // (~100ms) BEFORE fast starts. Without serialization, fast (1ms)
            // resolves first.
            const slowP = window.LayersAgent._sleep({ delayMs: 100 }).then(() => events.push('slow-done'))
            const fastP = window.LayersAgent._sleep({ delayMs: 1 }).then(() => events.push('fast-done'))
            await Promise.all([slowP, fastP])
            return events
        })
        expect(order).toEqual(['slow-done', 'fast-done'])
    })
})
