import { test, expect } from 'playwright/test'

const EXPECTED_GROUPS = [
    {
        menuId: 'imageMenu',
        submenuId: 'tone',
        curatedId: 'tone',
        label: 'tone',
        effects: [
            ['filter/adjust', 'brightness/contrast'],
            ['filter/smoothstep', 'levels'],
            ['filter/posterize', 'posterize'],
            ['filter/threshold', 'threshold'],
        ],
    },
    {
        menuId: 'imageMenu',
        submenuId: 'color',
        curatedId: 'color',
        label: 'color',
        effects: [
            ['filter/adjust', 'hue/saturation'],
            ['filter/grade', 'color grading'],
            ['filter/tint', 'tint'],
            ['filter/colorReplace', 'color replace'],
            ['filter/invert', 'invert'],
            ['filter/tetraColorArray', 'gradient palette'],
        ],
    },
    {
        menuId: 'filterMenu',
        submenuId: 'blur',
        curatedId: 'blur',
        label: 'blur',
        effects: [
            ['filter/blur', 'blur'],
            ['filter/motionBlur', 'motion blur'],
            ['filter/zoomBlur', 'zoom blur'],
            ['filter/spinBlur', 'spin blur'],
        ],
    },
    {
        menuId: 'filterMenu',
        submenuId: 'sharpen',
        curatedId: 'sharpen',
        label: 'sharpen',
        effects: [
            ['filter/sharpen', 'sharpen'],
            ['filter/unsharpMask', 'unsharp mask'],
        ],
    },
    {
        menuId: 'filterMenu',
        submenuId: 'pixelate',
        curatedId: 'pixelate',
        label: 'pixelate',
        effects: [
            ['filter/halftone', 'halftone'],
            ['filter/dither', 'dither'],
        ],
    },
    {
        menuId: 'filterMenu',
        submenuId: 'stylize',
        curatedId: 'stylize',
        label: 'stylize',
        effects: [
            ['filter/bloom', 'bloom'],
            ['filter/vignette', 'vignette'],
            ['filter/edge', 'edge detect'],
            ['filter/emboss', 'emboss'],
            ['filter/extrude', 'extrude'],
            ['filter/oilPaint', 'oil paint'],
            ['filter/wind', 'wind'],
        ],
    },
    {
        menuId: 'filterMenu',
        submenuId: 'sketch',
        curatedId: 'sketch',
        label: 'sketch',
        effects: [
            ['filter/chrome', 'chrome'],
            ['filter/photocopy', 'photocopy'],
            ['filter/stamp', 'stamp'],
        ],
    },
    {
        menuId: 'filterMenu',
        submenuId: 'brush-strokes',
        curatedId: 'brushStrokes',
        label: 'brush strokes',
        effects: [
            ['filter/hatch', 'hatch'],
            ['filter/strokes', 'strokes'],
        ],
    },
    {
        menuId: 'filterMenu',
        submenuId: 'artistic',
        curatedId: 'artistic',
        label: 'artistic',
        effects: [
            ['filter/watercolor', 'watercolor'],
            ['filter/plasticWrap', 'plastic wrap'],
        ],
    },
    {
        menuId: 'filterMenu',
        submenuId: 'texture',
        curatedId: 'texture',
        label: 'texture',
        effects: [
            ['filter/grain', 'grain'],
            ['filter/craquelure', 'craquelure'],
            ['filter/mosaicTiles', 'mosaic tiles'],
            ['filter/patchwork', 'patchwork'],
        ],
    },
]

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

    test('filter menu exposes the exact ordered taxonomy', async ({ page }) => {
        await bootBlank(page)
        const actual = await page.evaluate(() => {
            const menu = document.getElementById('filterMenu')
            return [...menu.querySelectorAll(':scope > .menu-items > .has-submenu')].map(trigger => {
                const submenuId = trigger.dataset.submenu
                const submenu = menu.querySelector(`:scope > .submenu[data-submenu-id="${submenuId}"]`)
                return {
                    submenuId,
                    effectIds: [...submenu.querySelectorAll(':scope > [data-effect]')]
                        .map(item => item.dataset.effect),
                }
            })
        })

        expect(actual).toEqual(EXPECTED_GROUPS.slice(2).map(group => ({
            submenuId: group.submenuId,
            effectIds: group.effects.map(([effectId]) => effectId),
        })))
    })

    test('clicking filter > stylize > oil paint adds its effect layer', async ({ page }) => {
        await bootBlank(page)
        const before = await page.evaluate(() => window.layersApp._layers.length)
        await page.locator('#filterMenu > .menu-title').click()
        await page.locator('#filterMenu > .menu-items > [data-submenu="stylize"]').hover()
        const oilPaint = page.locator(
            '#filterMenu > .submenu[data-submenu-id="stylize"] > [data-effect="filter/oilPaint"]')
        await expect(oilPaint).toBeVisible()
        await oilPaint.click()
        await expect.poll(() => page.evaluate(() => window.layersApp._layers.length)).toBe(before + 1)
        const after = await page.evaluate(() => ({
            n: window.layersApp._layers.length,
            ids: window.layersApp._layers.map(l => l.effectId),
        }))
        expect(after.n).toBe(before + 1)
        expect(after.ids).toContain('filter/oilPaint')
    })

    test('curated groups exactly mirror the ordered image and filter taxonomy', async ({ page }) => {
        await bootBlank(page)
        const actual = await page.evaluate(async () => {
            const env = await window.LayersAgent.listCuratedEffects()
            const menuGroups = ['imageMenu', 'filterMenu'].flatMap(menuId => {
                const menu = document.getElementById(menuId)
                return [...menu.querySelectorAll(':scope > .menu-items > .has-submenu')].map(trigger => {
                    const submenuId = trigger.dataset.submenu
                    const submenu = menu.querySelector(
                        `:scope > .submenu[data-submenu-id="${submenuId}"]`)
                    return {
                        menuId,
                        submenuId,
                        label: trigger.textContent.trim(),
                        effects: [...submenu.querySelectorAll(':scope > [data-effect]')].map(item => ({
                            effectId: item.dataset.effect,
                            label: item.textContent.trim(),
                        })),
                    }
                })
            })
            return { curatedGroups: env.result.groups, menuGroups }
        })

        expect(actual.menuGroups).toEqual(EXPECTED_GROUPS.map(group => ({
            menuId: group.menuId,
            submenuId: group.submenuId,
            label: group.label,
            effects: group.effects.map(([effectId, label]) => ({ effectId, label })),
        })))
        expect(actual.curatedGroups).toEqual(EXPECTED_GROUPS.map(group => ({
            id: group.curatedId,
            label: group.label,
            effects: group.effects.map(([effectId, label]) => ({ effectId, label })),
        })))
    })
})
