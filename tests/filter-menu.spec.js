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

    test('keeps the complete menu bar inside a narrow viewport', async ({ page }) => {
        await page.setViewportSize({ width: 390, height: 320 })
        await bootBlank(page)

        const controls = await page.locator(
            '#menuLeft > .menu > .menu-title, #playPauseBtn').evaluateAll(elements =>
            elements.map(element => {
                const rect = element.getBoundingClientRect()
                return {
                    label: element.textContent.trim() || element.getAttribute('title'),
                    left: rect.left,
                    right: rect.right,
                    top: rect.top,
                    bottom: rect.bottom,
                }
            }))

        for (const control of controls) {
            expect(control.left, `${control.label} left edge`).toBeGreaterThanOrEqual(0)
            expect(control.right, `${control.label} right edge`).toBeLessThanOrEqual(390)
            expect(control.top, `${control.label} top edge`).toBeGreaterThanOrEqual(0)
            expect(control.bottom, `${control.label} bottom edge`).toBeLessThanOrEqual(320)
        }
    })

    for (const width of [390, 320]) {
        test(`keeps top-menu hit targets and toolbar controls usable at ${width}x320`, async ({ page }) => {
            await page.setViewportSize({ width, height: 320 })
            await bootBlank(page)

            const blockedControls = await page.locator(
                '#menuLeft > .menu > .menu-title, #playPauseBtn').evaluateAll(elements =>
                elements.flatMap(element => {
                    const rect = element.getBoundingClientRect()
                    const hit = document.elementFromPoint(
                        rect.left + rect.width / 2, rect.top + rect.height / 2)
                    return element.contains(hit)
                        ? []
                        : [element.textContent.trim() || element.getAttribute('title') || 'logo']
                }))
            expect(blockedControls).toEqual([])

            const fileTitle = page.locator('#menuLeft > .menu').nth(1).locator(':scope > .menu-title')
            await fileTitle.click()
            await expect(page.locator('#newMenuItem')).toBeVisible()

            const toolbar = page.locator('#toolbar')
            const toolbarRect = await toolbar.boundingBox()
            const titlebarBottom = await page.locator('#menu').evaluate(element =>
                element.getBoundingClientRect().bottom)
            expect(toolbarRect.y).toBeGreaterThanOrEqual(titlebarBottom)
            expect(toolbarRect.y + toolbarRect.height).toBeLessThanOrEqual(320)

            const toolbarControls = toolbar.locator('.menu-icon-btn, .tool-caret, #colorWell')
            for (let index = 0; index < await toolbarControls.count(); index += 1) {
                const control = toolbarControls.nth(index)
                await control.scrollIntoViewIfNeeded()
                const reachable = await control.evaluate(element => {
                    const rect = element.getBoundingClientRect()
                    const hit = document.elementFromPoint(
                        rect.left + rect.width / 2, rect.top + rect.height / 2)
                    const toolbarRect = element.closest('#toolbar').getBoundingClientRect()
                    return rect.top >= toolbarRect.top
                        && rect.bottom <= toolbarRect.bottom + 1
                        && element.contains(hit)
                })
                const label = await control.getAttribute('id') || await control.textContent()
                expect(reachable, label.trim()).toBe(true)
            }

            await page.locator('.toast-visible').waitFor({ state: 'hidden' })

            const chooseFlyoutOption = async (menuId, optionSelector) => {
                const menu = page.locator(`#${menuId}`)
                const caret = menu.locator(':scope > .tool-caret')
                await caret.scrollIntoViewIfNeeded()
                await caret.click()

                const flyout = menu.locator(':scope > .menu-items')
                await expect(flyout).toBeVisible()
                const flyoutRect = await flyout.boundingBox()
                expect(flyoutRect.x).toBeGreaterThanOrEqual(toolbarRect.x + toolbarRect.width)
                expect(flyoutRect.x + flyoutRect.width).toBeLessThanOrEqual(width)
                expect(flyoutRect.y).toBeGreaterThanOrEqual(8)
                expect(flyoutRect.y + flyoutRect.height).toBeLessThanOrEqual(312)

                const option = flyout.locator(optionSelector)
                const optionHit = await option.evaluate(element => {
                    const rect = element.getBoundingClientRect()
                    const hit = document.elementFromPoint(
                        rect.left + rect.width / 2, rect.top + rect.height / 2)
                    return element.contains(hit)
                })
                expect(optionHit).toBe(true)
                await option.click()
                await expect(option).toHaveClass(/checked/)
            }

            await chooseFlyoutOption('selectionMenu', '[data-shape="oval"]')
            await expect(page.locator('#selectionToolIcon ellipse')).toHaveCount(1)

            await chooseFlyoutOption(
                'shapeMenu', '[data-shape="ellipse"][data-filled="true"]')
            await expect(page.locator('#shapeToolBtn .icon-material')).toHaveText('lens')
            await expect.poll(() => page.evaluate(() => ({
                shapeType: window.layersApp._shapeTool.shapeType,
                filled: window.layersApp._shapeTool.filled,
            }))).toEqual({ shapeType: 'ellipse', filled: true })
        })
    }

    test('repositions an open toolbar flyout when the viewport shrinks', async ({ page }) => {
        await page.setViewportSize({ width: 390, height: 320 })
        await bootBlank(page)
        await page.locator('.toast-visible').waitFor({ state: 'hidden' })

        const shapeMenu = page.locator('#shapeMenu')
        const caret = shapeMenu.locator(':scope > .tool-caret')
        await caret.scrollIntoViewIfNeeded()
        await caret.click()
        const flyout = shapeMenu.locator(':scope > .menu-items')
        await expect(flyout).toBeVisible()

        await page.setViewportSize({ width: 390, height: 240 })
        await expect.poll(async () => {
            const rect = await flyout.boundingBox()
            return rect.y >= 8 && rect.y + rect.height <= 232
        }).toBe(true)
        const flyoutRect = await flyout.boundingBox()
        expect(flyoutRect.y).toBeGreaterThanOrEqual(8)
        expect(flyoutRect.y + flyoutRect.height).toBeLessThanOrEqual(232)

        const filledOval = flyout.locator('[data-shape="ellipse"][data-filled="true"]')
        await expect.poll(() => filledOval.evaluate(element => {
            const rect = element.getBoundingClientRect()
            const hit = document.elementFromPoint(
                rect.left + rect.width / 2, rect.top + rect.height / 2)
            return element.contains(hit)
        })).toBe(true)
        await filledOval.click()
        await expect(filledOval).toHaveClass(/checked/)
        await expect.poll(() => page.evaluate(() => ({
            shapeType: window.layersApp._shapeTool.shapeType,
            filled: window.layersApp._shapeTool.filled,
        }))).toEqual({ shapeType: 'ellipse', filled: true })
    })

    test('reclamps an open Filter dropdown when the viewport narrows', async ({ page }) => {
        await page.setViewportSize({ width: 390, height: 320 })
        await bootBlank(page)

        await page.getByRole('button', { name: 'filter', exact: true }).click()
        const dropdown = page.locator('#filterMenu > .menu-items')
        await expect(dropdown).toBeVisible()

        await page.setViewportSize({ width: 320, height: 320 })
        await expect.poll(async () => {
            const rect = await dropdown.boundingBox()
            return rect.x >= 0 && rect.x + rect.width <= 320
        }).toBe(true)
        await expect(page.getByRole('button', { name: 'filter', exact: true }))
            .toHaveAttribute('aria-expanded', 'true')
    })

    test('repositions an open Filter submenu when the viewport shortens', async ({ page }) => {
        await page.setViewportSize({ width: 390, height: 320 })
        await bootBlank(page)
        await page.locator('.toast-visible').waitFor({ state: 'hidden' })

        const title = page.getByRole('button', { name: 'filter', exact: true })
        await title.focus()
        await page.keyboard.press('ArrowDown')
        await page.keyboard.press('ArrowDown')
        await page.keyboard.press('ArrowDown')
        await page.keyboard.press('ArrowDown')
        const distort = page.locator(
            '#filterMenu > .menu-items > [data-submenu="distort"]')
        await expect(distort).toBeFocused()
        await page.keyboard.press('ArrowRight')

        const submenu = page.locator(
            '#filterMenu > .submenu[data-submenu-id="distort"]')
        const wormhole = submenu.getByRole('menuitem', { name: 'wormhole', exact: true })
        await expect(submenu).toBeVisible()
        await page.keyboard.press('ArrowUp')
        await expect(wormhole).toBeFocused()
        await expect(distort).toHaveAttribute('aria-expanded', 'true')

        await page.setViewportSize({ width: 390, height: 240 })
        await expect.poll(async () => {
            const rect = await submenu.boundingBox()
            return Boolean(rect && rect.y >= 8 && rect.y + rect.height <= 232)
        }).toBe(true)
        await expect(distort).toHaveAttribute('aria-expanded', 'true')
        await expect(wormhole).toBeFocused()

        const optionHit = await wormhole.evaluate(element => {
            const rect = element.getBoundingClientRect()
            const hit = document.elementFromPoint(
                rect.left + rect.width / 2, rect.top + rect.height / 2)
            return element.contains(hit)
        })
        expect(optionHit).toBe(true)
        const before = await page.evaluate(() => window.layersApp._layers.length)
        await wormhole.click()
        await expect.poll(() => page.evaluate(() => ({
            count: window.layersApp._layers.length,
            effectId: window.layersApp._layers.at(-1)?.effectId,
        }))).toEqual({ count: before + 1, effectId: 'filter/wormhole' })
    })

    test('clamps the filter dropdown and keeps every submenu effect reachable', async ({ page }) => {
        // Sweeps all 12 submenus (hover + geometry each); parallel-worker
        // contention can push it past the default 30s budget.
        test.slow()
        await page.setViewportSize({ width: 390, height: 320 })
        await bootBlank(page)

        await page.locator('#filterMenu > .menu-title').click()
        const dropdown = page.locator('#filterMenu > .menu-items')
        await expect(dropdown).toBeVisible()
        const dropdownRect = await dropdown.boundingBox()
        expect(dropdownRect.x).toBeGreaterThanOrEqual(0)
        expect(dropdownRect.x + dropdownRect.width).toBeLessThanOrEqual(390)
        const toolbarRight = await page.locator('#toolbar').evaluate(element =>
            element.getBoundingClientRect().right)

        for (const group of EXPECTED_GROUPS.slice(2)) {
            await page.locator(
                `#filterMenu > .menu-items > [data-submenu="${group.submenuId}"]`).hover()
            const submenu = page.locator(
                `#filterMenu > .submenu[data-submenu-id="${group.submenuId}"]`)
            await expect(submenu).toBeVisible()
            const geometry = await submenu.evaluate((element, effectIds) => {
                const submenuRect = element.getBoundingClientRect()
                const effects = effectIds.map(effectId => {
                    const effect = element.querySelector(`[data-effect="${effectId}"]`)
                    effect.scrollIntoView({ block: 'nearest' })
                    const rect = effect.getBoundingClientRect()
                    return { effectId, top: rect.top, bottom: rect.bottom }
                })
                return {
                    submenu: {
                        left: submenuRect.left,
                        right: submenuRect.right,
                        top: submenuRect.top,
                        bottom: submenuRect.bottom,
                    },
                    effects,
                }
            }, group.effects.map(([effectId]) => effectId))

            expect(geometry.submenu.left, `${group.label} left edge`)
                .toBeGreaterThanOrEqual(toolbarRight)
            expect(geometry.submenu.right, `${group.label} right edge`).toBeLessThanOrEqual(390)
            expect(geometry.submenu.top, `${group.label} top edge`).toBeGreaterThanOrEqual(0)
            expect(geometry.submenu.bottom, `${group.label} bottom edge`).toBeLessThanOrEqual(320)

            for (const effect of geometry.effects) {
                const label = group.effects.find(([effectId]) => effectId === effect.effectId)[1]
                expect(effect.top, `${label} top edge`).toBeGreaterThanOrEqual(geometry.submenu.top)
                expect(effect.bottom, `${label} bottom edge`).toBeLessThanOrEqual(geometry.submenu.bottom)
            }
        }
    })

    test('supports complete Filter keyboard and ARIA operation', async ({ page }) => {
        await bootBlank(page)

        const title = page.getByRole('button', { name: 'filter', exact: true })
        const dropdown = page.locator('#filterMenu > .menu-items')
        const blurGroup = dropdown.getByRole('menuitem', { name: 'blur', exact: true })
        const sharpenGroup = dropdown.getByRole('menuitem', { name: 'sharpen', exact: true })
        const blurSubmenu = page.locator('#filterMenu > .submenu[data-submenu-id="blur"]')
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
            const title = menu.querySelector(':scope > .menu-title')
            const dropdown = menu.querySelector(':scope > .menu-items')
            return {
                titleControlsDropdown: title.getAttribute('aria-controls') === dropdown.id,
                dropdownLabelledByTitle: dropdown.getAttribute('aria-labelledby') === title.id,
                submenuRelationships: [...dropdown.querySelectorAll(':scope > [data-submenu]')]
                    .every(trigger => {
                        const submenu = menu.querySelector(
                            `:scope > .submenu[data-submenu-id="${trigger.dataset.submenu}"]`)
                        return trigger.getAttribute('aria-controls') === submenu?.id
                            && submenu.getAttribute('aria-labelledby') === trigger.id
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
        await page.locator('#filterMenu > .menu-title').click()
        await page.locator('#filterMenu > .menu-items > [data-submenu="stylize"]').hover()
        const oilPaint = page.locator(
            '#filterMenu > .submenu[data-submenu-id="stylize"] > [data-effect="filter/oilPaint"]')
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
        await page.locator('#filterMenu > .menu-title').click()
        await page.locator('#filterMenu > .menu-items > [data-submenu="glitch"]').hover()
        const glitch = page.locator(
            '#filterMenu > .submenu[data-submenu-id="glitch"] > [data-effect="classicNoisedeck/glitch"]')
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
            const items = document.getElementById('filterMenuItems')
            const categories = [...items.querySelectorAll(':scope > .has-submenu')]
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
            divider: { tagName: 'HR', className: 'menu-seperator', role: null },
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
        const title = page.getByRole('button', { name: 'filter', exact: true })
        const dropdown = page.locator('#filterMenuItems')

        await title.click()
        await page.locator('#filterMoreMenuItem').click()

        await expect(page.locator('.add-layer-dialog')).toBeVisible()
        await expect(dropdown).toBeHidden()
        await expect(title).toHaveAttribute('aria-expanded', 'false')
        await expect(title).not.toBeFocused()
    })

    test('more participates in Filter keyboard navigation and activation', async ({ page }) => {
        await bootBlank(page)
        const title = page.getByRole('button', { name: 'filter', exact: true })
        const dropdown = page.locator('#filterMenuItems')
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

            await page.keyboard.press('ArrowRight')
            await expect(more).toBeFocused()
            await expect(dropdown).toBeVisible()
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
