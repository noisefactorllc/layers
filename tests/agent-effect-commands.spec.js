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

test.describe('LayersAgent effect catalog', () => {
    test('searchEffects with no query returns all effects', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() => window.LayersAgent.searchEffects({}))
        expect(env.ok).toBe(true)
        expect(Array.isArray(env.result.effects)).toBe(true)
        expect(env.result.effects.length).toBeGreaterThan(0)
        const sample = env.result.effects[0]
        expect(sample).toMatchObject({
            effectId: expect.stringMatching(/.+\/.+/),
            namespace: expect.any(String),
            name: expect.any(String)
        })
    })

    test('searchEffects with query filters by name/description', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() =>
            window.LayersAgent.searchEffects({ query: 'blur' })
        )
        expect(env.ok).toBe(true)
        expect(env.result.effects.length).toBeGreaterThan(0)
        for (const e of env.result.effects) {
            const hay = (e.effectId + ' ' + e.name + ' ' + (e.description || '') +
                ' ' + (e.tags || []).join(' ')).toLowerCase()
            expect(hay).toContain('blur')
        }
    })

    test('listEffectCategories returns namespaces and tags', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() => window.LayersAgent.listEffectCategories())
        expect(env.ok).toBe(true)
        expect(Array.isArray(env.result.namespaces)).toBe(true)
        expect(Array.isArray(env.result.tags)).toBe(true)
        expect(env.result.namespaces.length).toBeGreaterThan(0)
    })

    test('listCuratedEffects mirrors the human Image menu groups', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() => window.LayersAgent.listCuratedEffects())
        expect(env.ok).toBe(true)
        expect(Array.isArray(env.result.groups)).toBe(true)
        const groupNames = env.result.groups.map(g => g.id)
        expect(groupNames).toEqual(expect.arrayContaining(['tone', 'color', 'blur-sharpen', 'stylize']))
        const tone = env.result.groups.find(g => g.id === 'tone')
        expect(tone.effects.length).toBeGreaterThan(0)
        expect(tone.effects[0]).toMatchObject({
            effectId: expect.stringMatching(/.+\/.+/),
            label: expect.any(String)
        })
    })

    test('getEffectDefinition returns param schema for a known effect', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() =>
            window.LayersAgent.getEffectDefinition({ effectId: 'filter/blur' })
        )
        expect(env.ok).toBe(true)
        expect(env.result.effectId).toBe('filter/blur')
        expect(Array.isArray(env.result.params)).toBe(true)
    })

    test('getEffectDefinition returns NOT_FOUND_EFFECT for unknown id', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() =>
            window.LayersAgent.getEffectDefinition({ effectId: 'filter/totallyMadeUp' })
        )
        expect(env.ok).toBe(false)
        expect(env.error.code).toBe('NOT_FOUND_EFFECT')
    })
})
