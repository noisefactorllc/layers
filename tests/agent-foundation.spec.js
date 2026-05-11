import { test, expect } from 'playwright/test'

test.describe('LayersAgent foundation', () => {
    test('exposes version 1.0', async ({ page }) => {
        await page.goto('/', { waitUntil: 'networkidle' })
        await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })
        const version = await page.evaluate(() => window.LayersAgent?.version)
        expect(version).toBe('1.0')
    })

    test('ready promise resolves after init', async ({ page }) => {
        await page.goto('/', { waitUntil: 'networkidle' })
        await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })
        const ready = await page.evaluate(async () => {
            await window.LayersAgent.ready
            return true
        })
        expect(ready).toBe(true)
    })
})

test.describe('LayersAgent envelopes', () => {
    test('successful command returns ok envelope with apiVersion', async ({ page }) => {
        await page.goto('/', { waitUntil: 'networkidle' })
        await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })
        await page.evaluate(async () => { await window.LayersAgent.ready })
        const env = await page.evaluate(() => window.LayersAgent._ping())
        expect(env.ok).toBe(true)
        expect(env.command).toBe('_ping')
        expect(env.apiVersion).toBe('1.0')
        expect(env.result).toEqual({ pong: true })
    })

    test('serializes parallel calls in order', async ({ page }) => {
        await page.goto('/', { waitUntil: 'networkidle' })
        await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })
        await page.evaluate(async () => { await window.LayersAgent.ready })
        const order = await page.evaluate(async () => {
            const events = []
            window.__pingHook = (label) => events.push(label)
            await Promise.all([
                window.LayersAgent._ping().then(() => events.push('done-1')),
                window.LayersAgent._ping().then(() => events.push('done-2')),
                window.LayersAgent._ping().then(() => events.push('done-3'))
            ])
            return events
        })
        expect(order).toEqual(['done-1', 'done-2', 'done-3'])
    })
})
