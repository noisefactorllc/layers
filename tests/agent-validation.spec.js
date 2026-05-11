import { test, expect } from 'playwright/test'

async function bootApp(page) {
    await page.goto('/', { waitUntil: 'networkidle' })
    await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })
    await page.evaluate(async () => { await window.LayersAgent.ready })
}

test.describe('LayersAgent schema validation', () => {
    test('returns INVALID_ARGS_TYPE for wrong field type', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() =>
            window.LayersAgent._echoNumber({ value: 'not a number' })
        )
        expect(env.ok).toBe(false)
        expect(env.error.code).toBe('INVALID_ARGS_TYPE')
        expect(env.error.details.field).toBe('value')
    })

    test('returns INVALID_ARGS_REQUIRED when required field missing', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() => window.LayersAgent._echoNumber({}))
        expect(env.ok).toBe(false)
        expect(env.error.code).toBe('INVALID_ARGS_REQUIRED')
        expect(env.error.details.field).toBe('value')
    })

    test('returns INVALID_ARGS_RANGE for out-of-range number', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() =>
            window.LayersAgent._echoNumber({ value: 999 })
        )
        expect(env.ok).toBe(false)
        expect(env.error.code).toBe('INVALID_ARGS_RANGE')
        expect(env.error.details).toMatchObject({ field: 'value', min: 0, max: 100 })
    })

    test('returns INVALID_ARGS_ENUM for unknown enum value', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() =>
            window.LayersAgent._echoEnum({ choice: 'nope' })
        )
        expect(env.ok).toBe(false)
        expect(env.error.code).toBe('INVALID_ARGS_ENUM')
        expect(env.error.details.field).toBe('choice')
    })

    test('passes valid args to handler', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() =>
            window.LayersAgent._echoNumber({ value: 50 })
        )
        expect(env.ok).toBe(true)
        expect(env.result.value).toBe(50)
    })

    test('nested INVALID_ARGS_REQUIRED includes full dotted path in details.field', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() =>
            window.LayersAgent._echoNested({ outer: {} })
        )
        expect(env.ok).toBe(false)
        expect(env.error.code).toBe('INVALID_ARGS_REQUIRED')
        expect(env.error.details.field).toBe('outer.inner')
        expect(env.error.message).toContain('outer.inner')
    })

    test('minLength rejects empty string in name field', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() => window.LayersAgent.saveProject({ name: '' }))
        expect(env.ok).toBe(false)
        expect(env.error.code).toMatch(/INVALID_ARGS_(RANGE|REQUIRED)/)
    })

    test('pattern rejects non-hex foreground color', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() =>
            window.LayersAgent.setForegroundColor({ color: 'not-a-color' })
        )
        expect(env.ok).toBe(false)
        expect(env.error.code).toBe('INVALID_ARGS_TYPE')
    })

    test('additionalProperties:false rejects unknown field in installFontBundle', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() =>
            window.LayersAgent.installFontBundle({ thisFieldDoesNotExist: 'foo' })
        )
        expect(env.ok).toBe(false)
        expect(['INVALID_ARGS_TYPE', 'INVALID_ARGS_UNKNOWN']).toContain(env.error.code)
    })
})
