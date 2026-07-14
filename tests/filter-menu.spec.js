import { test, expect } from 'playwright/test'

// Boots a blank solid project (mirrors tests/child-effects.spec.js). Under the
// Playwright webdriver flag the first-run welcome splash is suppressed, so the
// open dialog appears exactly as before.
async function bootBlank(page) {
    await page.goto('/', { waitUntil: 'networkidle' })
    await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })
    await page.waitForSelector('.open-dialog-backdrop.visible')
    await page.click('.media-option[data-type="solid"]')
    await page.waitForSelector('.canvas-size-dialog', { timeout: 5000 })
    await page.click('.canvas-size-dialog .action-btn.primary')
    await page.waitForSelector('.open-dialog-backdrop.visible', { state: 'hidden', timeout: 5000 })
    await page.waitForTimeout(500)
}

test.describe('Filter menu', () => {
    test('every menu data-effect resolves in the engine manifest', async ({ page }) => {
        await bootBlank(page)
        const res = await page.evaluate(() => {
            const manifest = window.layersApp._renderer.manifest || {}
            const ids = [...document.querySelectorAll('#imageMenu [data-effect], #filterMenu [data-effect]')]
                .map(el => el.dataset.effect)
            return { count: ids.length, missing: ids.filter(id => !(id in manifest)) }
        })
        expect(res.count).toBeGreaterThan(20)
        expect(res.missing).toEqual([])
    })

    test('filter menu exposes the promoted new effects', async ({ page }) => {
        await bootBlank(page)
        const ids = await page.evaluate(() =>
            [...document.querySelectorAll('#filterMenu [data-effect]')].map(el => el.dataset.effect))
        for (const id of [
            'filter/oilPaint', 'filter/watercolor', 'filter/halftone',
            'filter/spinBlur', 'filter/unsharpMask', 'filter/craquelure',
            'filter/chrome', 'filter/extrude', 'filter/patchwork',
        ]) {
            expect(ids).toContain(id)
        }
    })

    test('clicking a filter effect adds a layer with that effectId', async ({ page }) => {
        await bootBlank(page)
        const before = await page.evaluate(() => window.layersApp._layers.length)
        await page.evaluate(() => window.layersApp._handleAddEffectLayer('filter/oilPaint'))
        await page.waitForTimeout(400)
        const after = await page.evaluate(() => ({
            n: window.layersApp._layers.length,
            ids: window.layersApp._layers.map(l => l.effectId),
        }))
        expect(after.n).toBe(before + 1)
        expect(after.ids).toContain('filter/oilPaint')
    })

    test('curated groups mirror the filter menu and all resolve', async ({ page }) => {
        await bootBlank(page)
        const res = await page.evaluate(async () => {
            const env = await window.LayersAgent.listCuratedEffects()
            const manifest = window.layersApp._renderer.manifest || {}
            const curatedIds = env.result.groups.flatMap(g => g.effects.map(e => e.effectId))
            const menuIds = [...document.querySelectorAll('#filterMenu [data-effect]')]
                .map(el => el.dataset.effect)
            const curatedSet = new Set(curatedIds)
            return {
                unresolved: curatedIds.filter(id => !(id in manifest)),
                menuNotCurated: menuIds.filter(id => !curatedSet.has(id)),
            }
        })
        expect(res.unresolved).toEqual([])
        expect(res.menuNotCurated).toEqual([])
    })
})
