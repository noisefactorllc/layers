import { test, expect } from './fixtures.js'
import { appReady } from './waits.js'
import { reopenNewProjectDialog } from './helpers/new-project.js'

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
            ['filter/directionalBlur', 'motion blur'],
            ['filter/zoomBlur', 'zoom blur'],
            ['filter/spinBlur', 'spin blur'],
            ['filter/median', 'median'],
            ['filter/vaseline', 'soft focus'],
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
            ['filter/highPass', 'high pass'],
        ],
    },
    {
        menuId: 'filterMenu',
        submenuId: 'pixelate',
        curatedId: 'pixelate',
        label: 'pixelate',
        effects: [
            ['filter/pixels', 'pixelate'],
            ['filter/halftone', 'halftone'],
            ['filter/dither', 'dither'],
            ['filter/lowPoly', 'low poly'],
            ['filter/glyphMap', 'glyph map'],
            ['filter/stipple', 'stipple'],
        ],
    },
    {
        menuId: 'filterMenu',
        submenuId: 'distort',
        curatedId: 'distort',
        label: 'distort',
        effects: [
            ['filter/warp', 'warp'],
            ['filter/bulge', 'bulge'],
            ['filter/pinch', 'pinch'],
            ['filter/skew', 'skew'],
            ['filter/waves', 'waves'],
            ['filter/pondRipples', 'ripples'],
            ['filter/spiral', 'twirl'],
            ['filter/polar', 'polar coordinates'],
            ['filter/tunnel', 'tunnel'],
            ['filter/wormhole', 'wormhole'],
        ],
    },
    {
        menuId: 'filterMenu',
        submenuId: 'glitch',
        curatedId: 'glitch',
        label: 'glitch',
        effects: [
            ['classicNoisedeck/glitch', 'glitch', { glitchiness: 50, aberration: 30 }],
            ['filter/corrupt', 'corrupt'],
            ['filter/pixelSort', 'pixel sort'],
            ['filter/scanlineError', 'scanline error'],
            ['filter/crt', 'crt'],
            ['filter/snow', 'tv snow'],
            ['filter/degauss', 'degauss'],
            ['filter/chromaticAberration', 'chromatic aberration'],
            ['filter/convolutionFeedback', 'feedback'],
            ['filter/reverb', 'echo trails'],
            ['filter/feedback', 'video feedback', { mix: 50, scaleAmt: 97, rotation: 2 }],
        ],
    },
    {
        menuId: 'filterMenu',
        submenuId: 'stylize',
        curatedId: 'stylize',
        label: 'stylize',
        effects: [
            ['filter/edge', 'edge detect'],
            ['filter/glowingEdge', 'glowing edge'],
            ['filter/emboss', 'emboss'],
            ['filter/extrude', 'extrude'],
            ['filter/celShading', 'cel shading'],
            ['filter/oilPaint', 'oil paint'],
            ['filter/wind', 'wind'],
            ['filter/scatter', 'scatter'],
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
            ['filter/relief', 'relief'],
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
            ['filter/spatter', 'spatter'],
            ['filter/outline', 'outline'],
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
            ['filter/historicPalette', 'historic palette'],
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
            ['filter/texture', 'texturizer'],
            ['filter/grime', 'grime'],
            ['filter/fibers', 'fibers'],
            ['filter/scratches', 'scratches'],
            ['filter/strayHair', 'stray hair'],
        ],
    },
    {
        menuId: 'filterMenu',
        submenuId: 'light-lens',
        curatedId: 'lightLens',
        label: 'light & lens',
        effects: [
            ['filter/bloom', 'bloom'],
            ['filter/vignette', 'vignette'],
            ['filter/lensFlare', 'lens flare'],
            ['filter/lightLeak', 'light leak'],
            ['filter/lighting', 'lighting'],
            ['filter/lens', 'lens distortion', { displacement: 0.3 }],
            ['filter/clouds', 'clouds'],
        ],
    },
    {
        menuId: 'filterMenu',
        submenuId: 'tile',
        curatedId: 'tile',
        label: 'tile',
        effects: [
            ['filter/tile', 'kaleidoscope'],
            ['filter/repeat', 'repeat'],
            ['filter/seamless', 'seamless'],
            ['filter/flipMirror', 'flip mirror'],
        ],
    },
]

// Menu geometry, input, and model checks retain real rendering on a small
// document. Native image dimensions have dedicated full-resolution tests.
async function bootBlank(page) {
    await page.goto('/', { waitUntil: 'networkidle' })
    await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })
    await reopenNewProjectDialog(page)
    await page.click('.media-option[data-type="solid"]')
    await page.waitForSelector('.canvas-size-dialog', { timeout: 5000 })
    await page.locator('#canvas-width').fill('128')
    await page.locator('#canvas-height').fill('128')
    await page.click('.canvas-size-dialog .action-btn.primary')
    await page.waitForSelector('.open-dialog-backdrop.visible', { state: 'hidden', timeout: 5000 })
    await appReady(page)
    // The confirm click leaves the pointer where the Filter panel's lower rows
    // open on small viewports. WebKit reports a panel appearing under a still
    // pointer as a hover, which opens that row's submenu mid keyboard walk.
    // Menus drop from the top and submenus stop at the toolbar inset, so the
    // bottom-left corner stays clear of both.
    const { height } = page.viewportSize()
    await page.mouse.move(2, height - 2)
}

test.describe('Filter menu', () => {

    test('supports complete Filter keyboard and ARIA operation', async ({ page }) => {
        await bootBlank(page)

        const title = page.getByRole('menuitem', { name: 'filter', exact: true })
        const dropdown = page.locator('#filterMenu .hf-menubar-panel')
        const blurGroup = dropdown.getByRole('menuitem', { name: 'blur', exact: true })
        const sharpenGroup = dropdown.getByRole('menuitem', { name: 'sharpen', exact: true })
        const blurSubmenu = page.locator('#filterMenu .hf-menubar-subpanel', {
            has: page.locator('[data-effect="filter/blur"]'),
        })
        const blurEffect = blurSubmenu.getByRole('menuitem', { name: 'blur', exact: true })
        const motionBlurEffect = blurSubmenu.getByRole('menuitem', { name: 'motion blur', exact: true })

        await expect(title).toHaveAttribute('aria-haspopup', 'menu')
        await expect(title).toHaveAttribute('aria-expanded', 'false')
        await expect(dropdown).toHaveAttribute('role', 'menu')
        await expect(page.getByRole('menu', {
            name: 'filter', exact: true, includeHidden: true,
        })).toHaveCount(1)
        await expect(page.getByRole('menu', {
            name: 'blur', exact: true, includeHidden: true,
        })).toHaveCount(1)
        expect(await page.evaluate(() => {
            const menu = document.getElementById('filterMenu')
            const title = menu.querySelector('.hf-menubar-trigger')
            const dropdown = menu.querySelector('.hf-menubar-panel')
            return {
                titleControlsDropdown: title.getAttribute('aria-controls') === dropdown.id,
                dropdownLabelledByTitle: dropdown.getAttribute('aria-labelledby') === title.id,
                submenuRelationships: [...dropdown.querySelectorAll('[data-submenu]')]
                    .every(trigger => {
                        const submenu = document.getElementById(trigger.getAttribute('aria-controls'))
                        return !!submenu && submenu.getAttribute('aria-labelledby') === trigger.id
                    }),
            }
        })).toEqual({
            titleControlsDropdown: true,
            dropdownLabelledByTitle: true,
            submenuRelationships: true,
        })

        await title.focus()
        await page.keyboard.press('Enter')
        await expect(dropdown).toBeVisible()
        await expect(title).toHaveAttribute('aria-expanded', 'true')
        await expect(blurGroup).toBeFocused()
        await page.keyboard.press('Escape')
        await expect(dropdown).toBeHidden()
        await expect(title).toBeFocused()

        await page.keyboard.press('Space')
        await expect(dropdown).toBeVisible()
        await expect(blurGroup).toBeFocused()
        await page.keyboard.press('Escape')
        await expect(title).toBeFocused()

        await page.keyboard.press('Enter')
        await expect(blurGroup).toBeFocused()
        await page.keyboard.press('Tab')
        await expect(dropdown).toBeHidden()
        await expect(title).toHaveAttribute('aria-expanded', 'false')
        await expect(title).not.toBeFocused()

        await title.focus()
        await page.keyboard.press('Enter')
        await expect(blurGroup).toBeFocused()
        await page.keyboard.press('Shift+Tab')
        await expect(dropdown).toBeHidden()
        await expect(title).toHaveAttribute('aria-expanded', 'false')

        await page.keyboard.press('ArrowDown')
        await expect(dropdown).toBeVisible()
        await expect(blurGroup).toBeFocused()
        await expect(blurGroup).toHaveAttribute('aria-haspopup', 'menu')
        await expect(blurGroup).toHaveAttribute('aria-expanded', 'false')

        await page.keyboard.press('ArrowDown')
        await expect(sharpenGroup).toBeFocused()
        await page.keyboard.press('ArrowUp')
        await expect(blurGroup).toBeFocused()

        await page.keyboard.press('ArrowRight')
        await expect(blurSubmenu).toBeVisible()
        await expect(blurGroup).toHaveAttribute('aria-expanded', 'true')
        await expect(blurEffect).toBeFocused()
        await page.keyboard.press('ArrowDown')
        await expect(motionBlurEffect).toBeFocused()
        await page.keyboard.press('ArrowUp')
        await expect(blurEffect).toBeFocused()

        await page.keyboard.press('ArrowLeft')
        await expect(blurSubmenu).toBeHidden()
        await expect(blurGroup).toHaveAttribute('aria-expanded', 'false')
        await expect(blurGroup).toBeFocused()

        await page.keyboard.press('Enter')
        await expect(blurSubmenu).toBeVisible()
        await expect(blurEffect).toBeFocused()
        await page.keyboard.press('Escape')
        await expect(blurSubmenu).toBeHidden()
        await expect(blurGroup).toBeFocused()
        await page.keyboard.press('Escape')
        await expect(dropdown).toBeHidden()
        await expect(title).toHaveAttribute('aria-expanded', 'false')
        await expect(title).toBeFocused()

        for (const activationKey of ['Enter', 'Space']) {
            const before = await page.evaluate(() => window.layersApp._layers.length)
            await page.keyboard.press(activationKey)
            await expect(blurGroup).toBeFocused()
            await page.keyboard.press('ArrowRight')
            await expect(blurEffect).toBeFocused()
            await page.keyboard.press(activationKey)
            await expect.poll(() => page.evaluate(() => ({
                count: window.layersApp._layers.length,
                effectId: window.layersApp._layers.at(-1)?.effectId,
            })), { timeout: 10000 }).toEqual({ count: before + 1, effectId: 'filter/blur' })
            await expect(dropdown).toBeHidden()
            await expect(title).toHaveAttribute('aria-expanded', 'false')
            await expect(title).toBeFocused()
        }
    })

    test('clicking filter > stylize > oil paint adds its effect layer', async ({ page }) => {
        await bootBlank(page)
        const before = await page.evaluate(() => window.layersApp._layers.length)
        await page.locator('#filterMenu .hf-menubar-trigger').click()
        await page.locator('#filterMenu [data-submenu="stylize"]').hover()
        const oilPaint = page.locator('#filterMenu [data-effect="filter/oilPaint"]')
        await expect(oilPaint).toBeVisible()
        await oilPaint.click()
        await expect.poll(() => page.evaluate(() => ({
            count: window.layersApp._layers.length,
            effectId: window.layersApp._layers.at(-1)?.effectId,
        })), { timeout: 10000 }).toEqual({ count: before + 1, effectId: 'filter/oilPaint' })
    })

    test('clicking a data-params entry applies its params and menu-label name', async ({ page }) => {
        await bootBlank(page)
        const before = await page.evaluate(() => window.layersApp._layers.length)
        await page.locator('#filterMenu .hf-menubar-trigger').click()
        await page.locator('#filterMenu [data-submenu="glitch"]').hover()
        const glitch = page.locator('#filterMenu [data-effect="classicNoisedeck/glitch"]')
        await expect(glitch).toBeVisible()
        await glitch.click()
        await expect.poll(() => page.evaluate(() => {
            const layer = window.layersApp._layers.at(-1)
            return {
                count: window.layersApp._layers.length,
                effectId: layer?.effectId,
                name: layer?.name,
                glitchiness: layer?.effectParams?.glitchiness,
                aberration: layer?.effectParams?.aberration,
            }
        }), { timeout: 10000 }).toEqual({
            count: before + 1,
            effectId: 'classicNoisedeck/glitch',
            name: 'glitch',
            glitchiness: 50,
            aberration: 30,
        })
    })

    test('curated initial params satisfy the agent validation contract', async ({ page }) => {
        // Guard: a curated `params` value outside the effect definition's
        // declared range would brick saved-project reload and collab join
        // (both run assertRemoteParamRange). Replaying each tuned entry
        // through the agent's addLayer exercises that same range validation.
        await bootBlank(page)
        const tuned = EXPECTED_GROUPS.flatMap(group =>
            group.effects
                .filter(([, , params]) => params)
                .map(([effectId, label, params]) => ({ effectId, label, params })))
        expect(tuned.length).toBeGreaterThan(0)
        for (const entry of tuned) {
            const env = await page.evaluate(({ effectId, params }) =>
                window.LayersAgent.addLayer({ kind: 'effect', effectId, params }),
            entry)
            expect(env.ok,
                `${entry.label} (${entry.effectId}) params rejected: ${JSON.stringify(env.error || env)}`
            ).toBe(true)
        }
    })

    test('curated groups exactly mirror the ordered image and filter taxonomy', async ({ page }) => {
        await bootBlank(page)
        const actual = await page.evaluate(async () => {
            const env = await window.LayersAgent.listCuratedEffects()
            const menuGroups = ['imageMenu', 'filterMenu'].flatMap(menuId => {
                const menu = document.getElementById(menuId)
                return [...menu.querySelectorAll('.hf-menubar-panel .hf-menubar-has-submenu')].map(trigger => {
                    const submenuId = trigger.dataset.submenu
                    const submenu = document.getElementById(trigger.getAttribute('aria-controls'))
                    return {
                        menuId,
                        submenuId,
                        label: trigger.textContent.trim(),
                        effects: [...submenu.querySelectorAll('[data-effect]')].map(item => ({
                            effectId: item.dataset.effect,
                            label: item.textContent.trim(),
                            // Initial params for effects whose spec defaults are a
                            // visual no-op; must mirror between DOM and agent list.
                            ...(item.dataset.params
                                ? { params: JSON.parse(item.dataset.params) }
                                : {}),
                        })),
                    }
                })
            })
            return { curatedGroups: env.result.groups, menuGroups }
        })

        const expectedEffect = ([effectId, label, params]) =>
            (params ? { effectId, label, params } : { effectId, label })
        expect(actual.menuGroups).toEqual(EXPECTED_GROUPS.map(group => ({
            menuId: group.menuId,
            submenuId: group.submenuId,
            label: group.label,
            effects: group.effects.map(expectedEffect),
        })))
        expect(actual.curatedGroups).toEqual(EXPECTED_GROUPS.map(group => ({
            id: group.curatedId,
            label: group.label,
            effects: group.effects.map(expectedEffect),
        })))
    })

    test('ends with the conventional divider and more menuitem', async ({ page }) => {
        await bootBlank(page)
        const actual = await page.evaluate(() => {
            const items = document.querySelector('#filterMenu .hf-menubar-panel')
            const categories = [...items.querySelectorAll(':scope > .hf-menubar-submenu-holder')]
            const divider = categories.at(-1).nextElementSibling
            const more = divider?.nextElementSibling
            return {
                divider: {
                    tagName: divider?.tagName,
                    className: divider?.className,
                    role: divider?.getAttribute('role'),
                },
                more: {
                    tagName: more?.tagName,
                    id: more?.id,
                    text: more?.textContent.trim(),
                    role: more?.getAttribute('role'),
                    tabIndex: more?.getAttribute('tabindex'),
                    isLast: more === items.lastElementChild,
                },
            }
        })

        expect(actual).toEqual({
            divider: { tagName: 'HR', className: 'hf-menu-separator', role: null },
            more: {
                tagName: 'BUTTON',
                id: 'filterMoreMenuItem',
                text: 'more...',
                role: 'menuitem',
                tabIndex: '-1',
                isLast: true,
            },
        })
    })

    test('clicking more closes Filter and opens the add-layer dialog', async ({ page }) => {
        await bootBlank(page)
        const title = page.getByRole('menuitem', { name: 'filter', exact: true })
        const dropdown = page.locator('#filterMenu .hf-menubar-panel')

        await title.click()
        await page.locator('#filterMoreMenuItem').click()

        await expect(page.locator('.add-layer-dialog')).toBeVisible()
        await expect(dropdown).toBeHidden()
        await expect(title).toHaveAttribute('aria-expanded', 'false')
        await expect(title).not.toBeFocused()
    })

    test('more participates in Filter keyboard navigation and activation', async ({ page }) => {
        await bootBlank(page)
        const title = page.getByRole('menuitem', { name: 'filter', exact: true })
        const dropdown = page.locator('#filterMenu .hf-menubar-panel')
        const tile = dropdown.getByRole('menuitem', { name: 'tile', exact: true })
        const more = dropdown.getByRole('menuitem', { name: 'more...', exact: true })

        for (const activationKey of ['Enter', 'Space']) {
            await title.focus()
            await page.keyboard.press('ArrowUp')
            await expect(more).toBeFocused()
            await page.keyboard.press('ArrowUp')
            await expect(tile).toBeFocused()
            await page.keyboard.press('ArrowDown')
            await expect(more).toBeFocused()

            // ArrowRight on a non-submenu item follows the ARIA menubar
            // pattern: the next top-level menu opens; ArrowLeft steps back.
            await page.keyboard.press('ArrowRight')
            await expect(dropdown).toBeHidden()
            await page.keyboard.press('ArrowLeft')
            await expect(dropdown).toBeVisible()
            await page.keyboard.press('ArrowUp')
            await expect(more).toBeFocused()
            await expect(page.locator('.add-layer-dialog')).not.toBeVisible()

            await page.keyboard.press(activationKey)
            const dialog = page.locator('.add-layer-dialog')
            await expect(dialog).toBeVisible()
            await expect(dropdown).toBeHidden()
            await expect(title).not.toBeFocused()
            await dialog.getByRole('button', { name: 'Close' }).click()
            await expect(dialog).toBeHidden()
        }
    })
})
