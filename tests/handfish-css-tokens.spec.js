import { test, expect } from './fixtures.js'
import { appReady, defaultProjectReady } from './waits.js'
import { reopenNewProjectDialog } from './helpers/new-project.js'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

test.describe('Handfish Design System CSS Token Compliance', () => {
    test('every Layers scroll region uses the Handfish scrollbar treatment', async ({ page, browserName }) => {
        await page.goto('/', { waitUntil: 'networkidle' })
        await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })

        const { core, styles } = await page.evaluate(() => {
            const core = ['#canvas-panel', '.layers-list'].map(selector => !!document.querySelector(selector))
            const styles = [...document.querySelectorAll('body *')]
                .filter(element => {
                    const style = getComputedStyle(element)
                    return element.getClientRects().length > 0
                        && (['auto', 'scroll'].includes(style.overflowX)
                            || ['auto', 'scroll'].includes(style.overflowY))
                })
                .map(element => {
                    const style = getComputedStyle(element)
                    return {
                        selector: element.id || element.className || element.tagName,
                        width: style.scrollbarWidth,
                        color: style.scrollbarColor
                    }
                })
            return { core, styles }
        })

        expect(core).toEqual([true, true])
        expect(styles.length).toBeGreaterThan(1)
        for (const { selector, width, color } of styles) {
            // Headless Firefox can force hidden native bars even over inline CSS.
            if (browserName !== 'firefox') expect(width, `${selector} scrollbar width`).toBe('thin')
            expect(color, `${selector} scrollbar color`).not.toBe('auto')
        }
    })

    test('public/css stylesheets contain zero hardcoded colors and zero !important declarations', () => {
        const cssDir = path.resolve(__dirname, '../public/css')
        const files = fs.readdirSync(cssDir).filter(f => f.endsWith('.css'))

        expect(files.length).toBeGreaterThan(0)

        const violations = []

        for (const file of files) {
            const content = fs.readFileSync(path.join(cssDir, file), 'utf8')
            // Strip CSS comments and inline SVG data URIs
            const stripped = content
                .replace(/\/\*[\s\S]*?\*\//g, '')
                .replace(/url\([^)]*data:image\/svg\+xml[^)]*\)/gi, '')

            const hexMatches = stripped.match(/#[0-9a-fA-F]{3,8}\b/g)
            if (hexMatches) {
                violations.push(`${file} contains hardcoded hex colors: ${hexMatches.join(', ')}`)
            }

            const rgbMatches = stripped.match(/\b(rgba?|hsla?|oklch|oklab|lab|lch)\([^)]+\)/g)
            if (rgbMatches) {
                violations.push(`${file} contains hardcoded color function calls: ${rgbMatches.join(', ')}`)
            }

            // Check for standalone named colors in color-bearing declarations (e.g., "color: white;")
            const namedColorMatches = stripped.match(/(?:color|background|background-color|border-color|outline-color)\s*:\s*([^;]+);/g)
            if (namedColorMatches) {
                for (const decl of namedColorMatches) {
                    const val = decl.split(':')[1].trim()
                    if (/\b(white|black|red|green|blue|yellow|orange|purple|gray|grey)\b/i.test(val) && !/var\(|color-mix\(/i.test(val)) {
                        violations.push(`${file} contains hardcoded named color in declaration: "${decl.trim()}"`)
                    }
                }
            }

            const importantMatches = stripped.match(/!important/g)
            if (importantMatches) {
                violations.push(`${file} contains ${importantMatches.length} !important declarations`)
            }

            const transitionAllMatches = content.match(/transition\s*:\s*all\b/g)
            if (transitionAllMatches) {
                violations.push(`${file} contains ${transitionAllMatches.length} bare "transition: all" declarations`)
            }
        }

        expect(violations).toEqual([])
    })

    test('JS-injected UI stylesheets contain zero hardcoded colors and transition: all', () => {
        // UI chrome styled from JS-injected <style> blocks (light-DOM handfish surfaces).
        // Functional canvas/DSL color literals elsewhere in public/js are intentionally out of scope.
        const styledFiles = [
            path.resolve(__dirname, '../public/js/ui/effect-picker.js'),
            path.resolve(__dirname, '../public/js/layers/font-select.js'),
        ]

        const violations = []

        for (const file of styledFiles) {
            const content = fs.readFileSync(file, 'utf8')
            const rel = path.relative(path.resolve(__dirname, '..'), file)

            const colorMatches = content.match(/#[0-9a-fA-F]{3,8}\b|\b(rgba?|hsla?|oklch|oklab|lab|lch)\([^)]+\)|\b(white|black|red|green|blue|yellow|orange|purple|gray|grey)\b(?![\w-])/g)
            if (colorMatches) {
                violations.push(`${rel} contains hardcoded color literals: ${colorMatches.join(', ')}`)
            }

            const transitionAllMatches = content.match(/transition\s*:\s*all\b/g)
            if (transitionAllMatches) {
                violations.push(`${rel} contains ${transitionAllMatches.length} bare "transition: all" declarations`)
            }
        }

        expect(violations).toEqual([])
    })

    test('computed styles use theme tokens and update dynamically on theme switch', async ({ page }) => {
        await page.goto('/', { waitUntil: 'networkidle' })
        await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })
        await reopenNewProjectDialog(page)

        // Check dialog backdrop computed style
        const backdropBg = await page.evaluate(() => {
            const backdrop = document.querySelector('.open-dialog-backdrop')
            return window.getComputedStyle(backdrop).backgroundColor
        })
        expect(backdropBg).toBeTruthy()
        expect(backdropBg).not.toBe('rgba(0, 0, 0, 0)')

        // Verify live DOM element using theme tokens updates dynamically on theme switch
        const initialLabelColor = await page.evaluate(() => {
            const label = document.querySelector('.drawing-options-bar label')
            return window.getComputedStyle(label).color
        })
        expect(initialLabelColor).toBeTruthy()

        const initialAccent = await page.evaluate(() => {
            return window.getComputedStyle(document.documentElement).getPropertyValue('--hf-accent-3').trim()
        })

        await page.evaluate(() => {
            document.documentElement.setAttribute('data-theme', 'cyberpunk')
        })

        const cyberpunkAccent = await page.evaluate(() => {
            return window.getComputedStyle(document.documentElement).getPropertyValue('--hf-accent-3').trim()
        })

        const cyberpunkLabelColor = await page.evaluate(() => {
            const label = document.querySelector('.drawing-options-bar label')
            return window.getComputedStyle(label).color
        })

        // Accent token and element computed color must distinctly change between default and cyberpunk
        expect(cyberpunkAccent).toBeTruthy()
        expect(cyberpunkAccent).not.toBe(initialAccent)
        expect(cyberpunkLabelColor).not.toBe(initialLabelColor)

        // Reset theme back to default
        await page.evaluate(() => {
            document.documentElement.removeAttribute('data-theme')
        })
    })

    test('.hidden and .hide utilities reliably force display: none on any element', async ({ page }) => {
        await page.goto('/', { waitUntil: 'networkidle' })
        await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })

        const hiddenResults = await page.evaluate(() => {
            // Test hidden on a label, button, and slider row
            const label = document.getElementById('drawingFilledLabel')
            const closeBtn = document.querySelector('.open-dialog .dialog-close')
            const wandRow = document.getElementById('wandToleranceRow')

            return {
                labelDisplay: label ? window.getComputedStyle(label).display : null,
                labelHasHidden: label ? label.classList.contains('hidden') : null,
                wandRowDisplay: wandRow ? window.getComputedStyle(wandRow).display : null,
                wandRowHasHide: wandRow ? wandRow.classList.contains('hide') : null
            }
        })

        if (hiddenResults.labelHasHidden) {
            expect(hiddenResults.labelDisplay).toBe('none')
        }
        if (hiddenResults.wandRowHasHide) {
            expect(hiddenResults.wandRowDisplay).toBe('none')
        }
    })

    test('theme switching preserves accessible contrast on UI controls across light and dark themes', async ({ page }) => {
        await page.goto('/', { waitUntil: 'networkidle' })
        await defaultProjectReady(page)
        await page.locator('.layer-item').first().waitFor({ state: 'visible', timeout: 10000 })

        const contrastResults = await page.evaluate(async () => {
            function getRgb(colorStr, bgStr = '#ffffff') {
                const canvas = document.createElement('canvas')
                canvas.width = 1
                canvas.height = 1
                const ctx = canvas.getContext('2d', { willReadFrequently: true })
                ctx.fillStyle = bgStr
                ctx.fillRect(0, 0, 1, 1)
                ctx.fillStyle = colorStr
                ctx.fillRect(0, 0, 1, 1)
                const data = ctx.getImageData(0, 0, 1, 1).data
                return [data[0] / 255, data[1] / 255, data[2] / 255]
            }

            function luminance([r, g, b]) {
                const a = [r, g, b].map(v => v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4))
                return a[0] * 0.2126 + a[1] * 0.7152 + a[2] * 0.0722
            }

            function contrastRatio(c1, c2, baseBg = '#000000') {
                const l1 = luminance(getRgb(c1, baseBg))
                const l2 = luminance(getRgb(c2, baseBg))
                const lighter = Math.max(l1, l2)
                const darker = Math.min(l1, l2)
                return (lighter + 0.05) / (darker + 0.05)
            }

            const testContainer = document.createElement('div')
            testContainer.id = 'theme-contrast-test-fixture'
            testContainer.innerHTML = `
                <button class="action-btn">Secondary</button>
                <button class="action-btn primary">Primary</button>
                <button class="action-btn danger">Danger</button>
            `
            document.body.appendChild(testContainer)

            const themes = ['dark', 'light', 'neutral-dark', 'neutral-light', 'cyberpunk', 'corporate']
            const report = {}

            for (const theme of themes) {
                document.documentElement.dataset.theme = theme
                // Settle render pipeline cleanly across frames
                await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))

                const item = document.querySelector('.layer-item')
                if (!item) throw new Error(`Missing .layer-item for theme ${theme}`)
                const name = item.querySelector('.layer-name')
                if (!name) throw new Error(`Missing .layer-name for theme ${theme}`)
                const opacityDisplay = item.querySelector('.layer-opacity .value-display')
                if (!opacityDisplay) throw new Error(`Missing .layer-opacity .value-display for theme ${theme}`)
                const itemBg = window.getComputedStyle(item).backgroundColor

                const btnDefault = testContainer.querySelector('.action-btn')
                const btnPrimary = testContainer.querySelector('.action-btn.primary')
                const btnDanger = testContainer.querySelector('.action-btn.danger')

                const primaryBg = window.getComputedStyle(document.documentElement).getPropertyValue('--hf-accent-3').trim()
                const dangerBg = window.getComputedStyle(document.documentElement).getPropertyValue('--hf-red').trim()

                report[theme] = {
                    nameContrast: contrastRatio(window.getComputedStyle(name).color, itemBg),
                    opacityContrast: contrastRatio(window.getComputedStyle(opacityDisplay).color, itemBg),
                    btnDefaultContrast: contrastRatio(window.getComputedStyle(btnDefault).color, window.getComputedStyle(btnDefault).backgroundColor),
                    primaryBtnContrast: contrastRatio(window.getComputedStyle(btnPrimary).color, primaryBg),
                    dangerBtnContrast: contrastRatio(window.getComputedStyle(btnDanger).color, dangerBg)
                }
            }

            testContainer.remove()
            document.documentElement.removeAttribute('data-theme')
            return report
        })

        for (const [theme, metrics] of Object.entries(contrastResults)) {
            // WCAG AA requirement for normal text is 4.5:1
            expect(metrics.nameContrast, `${theme} layer name contrast`).toBeGreaterThanOrEqual(4.5)
            expect(metrics.opacityContrast, `${theme} opacity display contrast`).toBeGreaterThanOrEqual(4.5)
            expect(metrics.btnDefaultContrast, `${theme} default button contrast`).toBeGreaterThanOrEqual(4.5)
            expect(metrics.primaryBtnContrast, `${theme} primary button contrast`).toBeGreaterThanOrEqual(4.5)
            expect(metrics.dangerBtnContrast, `${theme} danger button contrast`).toBeGreaterThanOrEqual(4.5)
        }
    })

    test('mask-edit banner text meets WCAG AA contrast on its red surface across all themes', async ({ page }) => {
        await page.goto('/', { waitUntil: 'networkidle' })
        await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })

        const results = await page.evaluate(async () => {
            function toSrgb(colorStr) {
                const canvas = document.createElement('canvas')
                canvas.width = 1
                canvas.height = 1
                const ctx = canvas.getContext('2d', { willReadFrequently: true })
                ctx.clearRect(0, 0, 1, 1)
                ctx.fillStyle = '#000000'
                ctx.fillStyle = colorStr
                ctx.fillRect(0, 0, 1, 1)
                const data = ctx.getImageData(0, 0, 1, 1).data
                return [data[0] / 255, data[1] / 255, data[2] / 255]
            }

            function luminance([r, g, b]) {
                const a = [r, g, b].map(v => v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4))
                return a[0] * 0.2126 + a[1] * 0.7152 + a[2] * 0.0722
            }

            function contrastRatio(fg, bg) {
                const l1 = luminance(fg)
                const l2 = luminance(bg)
                return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)
            }

            const banner = document.getElementById('maskEditBanner')
            if (!banner) throw new Error('Missing #maskEditBanner')
            banner.classList.remove('hidden')

            const themes = ['dark', 'light', 'gray-dark', 'gray-light', 'neutral-dark', 'neutral-light',
                'corporate', 'cyberpunk', 'earthy', 'organic', 'terminal']
            const report = {}

            for (const theme of themes) {
                document.documentElement.dataset.theme = theme
                await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))
                const cs = window.getComputedStyle(banner)
                const fg = toSrgb(cs.color)
                const bg = toSrgb(cs.backgroundColor)
                report[theme] = {
                    contrast: contrastRatio(fg, bg),
                    fg: cs.color,
                    bg: cs.backgroundColor
                }
            }

            banner.classList.add('hidden')
            document.documentElement.removeAttribute('data-theme')
            return report
        })

        for (const [theme, metrics] of Object.entries(results)) {
            expect(metrics.contrast, `${theme} mask-edit banner contrast (fg ${metrics.fg} on bg ${metrics.bg})`).toBeGreaterThanOrEqual(4.5)
        }
    })

    test('loading screen text meets WCAG AA contrast on its surface across all themes', async ({ page }) => {
        await page.goto('/', { waitUntil: 'networkidle' })
        // The boot sequence fades the screen out (0.35s) and then marks it
        // .hidden; the element stays in the DOM, so unhide it in place to
        // measure its production styles. Wait for the fade transition to
        // finish before re-showing so the measured opacity is 1.
        await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })

        const results = await page.evaluate(async () => {
            function toSrgb(colorStr) {
                const canvas = document.createElement('canvas')
                canvas.width = 1
                canvas.height = 1
                const ctx = canvas.getContext('2d', { willReadFrequently: true })
                ctx.clearRect(0, 0, 1, 1)
                ctx.fillStyle = '#000000'
                ctx.fillStyle = colorStr
                ctx.fillRect(0, 0, 1, 1)
                const data = ctx.getImageData(0, 0, 1, 1).data
                // getImageData() returns unpremultiplied sRGB components plus
                // the color's own alpha (color(srgb … / a), rgba(), etc.);
                // callers must weight rgb by alpha when compositing.
                return { rgb: [data[0] / 255, data[1] / 255, data[2] / 255], alpha: data[3] / 255 }
            }

            function luminance([r, g, b]) {
                const a = [r, g, b].map(v => v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4))
                return a[0] * 0.2126 + a[1] * 0.7152 + a[2] * 0.0722
            }

            function contrastRatio(fg, bg) {
                const l1 = luminance(fg)
                const l2 = luminance(bg)
                return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)
            }

            const screen = document.getElementById('loading-screen')
            if (!screen) throw new Error('Missing #loading-screen')
            screen.classList.remove('hidden')
            screen.classList.remove('fade-out')
            // The screen itself fades in over 0.35s from the just-ended
            // fade-out; wait for its opacity transition to settle so the
            // measured stack matches the fully-rendered screen.
            for (let i = 0; i < 60; i++) {
                if (parseFloat(window.getComputedStyle(screen).opacity) === 1) break
                await new Promise(r => requestAnimationFrame(r))
            }

            const modal = screen.querySelector('.loading-modal')
            if (!modal) throw new Error('Missing .loading-modal')

            const themes = ['dark', 'light', 'gray-dark', 'gray-light', 'neutral-dark', 'neutral-light',
                'corporate', 'cyberpunk', 'earthy', 'organic', 'terminal']
            const report = {}
            const targets = [
                ['tagline', screen.querySelector('.loading-tagline')],
                ['status', screen.querySelector('.loading-status')]
            ]

            for (const theme of themes) {
                document.documentElement.dataset.theme = theme
                await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))
                // The text sits on .loading-modal, an alpha-composited panel
                // over #loading-screen's opaque --hf-color-2 backdrop.
                // Composite the same stack the browser does per theme: the
                // modal color weighted by its own alpha over the screen color.
                const screenBg = toSrgb(window.getComputedStyle(screen).backgroundColor)
                const modalSample = toSrgb(window.getComputedStyle(modal).backgroundColor)
                const panelBg = modalSample.rgb.map((c, i) => c * modalSample.alpha + screenBg.rgb[i] * (1 - modalSample.alpha))
                report[theme] = {}
                for (const [name, el] of targets) {
                    if (!el) throw new Error(`Missing loading screen element: ${name}`)
                    const cs = window.getComputedStyle(el)
                    // Composite the text over the panel: effective text alpha
                    // is the color's own alpha times the element's opacity
                    // (the screen's fade is settled to 1 above); the remainder
                    // shows the panel, it does not fade toward black.
                    const fgSample = toSrgb(cs.color)
                    const ownOpacity = Number.isNaN(parseFloat(cs.opacity)) ? 1 : parseFloat(cs.opacity)
                    const eo = fgSample.alpha * ownOpacity
                    const fg = fgSample.rgb.map((c, i) => c * eo + panelBg[i] * (1 - eo))
                    report[theme][name] = {
                        contrast: contrastRatio(fg, panelBg),
                        fg: cs.color,
                        opacity: cs.opacity
                    }
                }
            }

            screen.classList.add('hidden')
            document.documentElement.removeAttribute('data-theme')
            return report
        })

        for (const [theme, metrics] of Object.entries(results)) {
            for (const [name, m] of Object.entries(metrics)) {
                expect(m.contrast, `${theme} loading ${name} contrast (fg ${m.fg} opacity ${m.opacity})`).toBeGreaterThanOrEqual(4.5)
            }
        }

        // The THEMES list also offers System, which resolves through
        // prefers-color-scheme to neutral-dark / neutral-light. Check it under
        // both color schemes through the production setSettings path, stepping
        // out to an explicit theme first so the resolution back to System is
        // observed, not inherited from boot.
        const resolvedSystem = {}
        for (const scheme of ['dark', 'light']) {
            await page.emulateMedia({ colorScheme: scheme })
            resolvedSystem[scheme] = await page.evaluate(async (expected) => {
                function toSrgb(colorStr) {
                    const canvas = document.createElement('canvas')
                    canvas.width = 1
                    canvas.height = 1
                    const ctx = canvas.getContext('2d', { willReadFrequently: true })
                    ctx.clearRect(0, 0, 1, 1)
                    ctx.fillStyle = '#000000'
                    ctx.fillStyle = colorStr
                    ctx.fillRect(0, 0, 1, 1)
                    const data = ctx.getImageData(0, 0, 1, 1).data
                    // getImageData() returns unpremultiplied sRGB components
                    // plus the color's own alpha (color(srgb … / a), rgba(),
                    // etc.); callers must weight rgb by alpha when compositing.
                    return { rgb: [data[0] / 255, data[1] / 255, data[2] / 255], alpha: data[3] / 255 }
                }

                function luminance([r, g, b]) {
                    const a = [r, g, b].map(v => v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4))
                    return a[0] * 0.2126 + a[1] * 0.7152 + a[2] * 0.0722
                }

                function contrastRatio(fg, bg) {
                    const l1 = luminance(fg)
                    const l2 = luminance(bg)
                    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)
                }

                await window.LayersAgent.setSettings({ theme: 'dark' })
                await window.LayersAgent.setSettings({ theme: 'system' })
                const resolved = document.documentElement.dataset.theme

                const screen = document.getElementById('loading-screen')
                if (!screen) throw new Error('Missing #loading-screen')
                screen.classList.remove('hidden')
                screen.classList.remove('fade-out')
                for (let i = 0; i < 60; i++) {
                    if (parseFloat(window.getComputedStyle(screen).opacity) === 1) break
                    await new Promise(r => requestAnimationFrame(r))
                }
                const modal = screen.querySelector('.loading-modal')
                if (!modal) throw new Error('Missing .loading-modal')

                const screenBg = toSrgb(window.getComputedStyle(screen).backgroundColor)
                const modalSample = toSrgb(window.getComputedStyle(modal).backgroundColor)
                const panelBg = modalSample.rgb.map((c, i) => c * modalSample.alpha + screenBg.rgb[i] * (1 - modalSample.alpha))

                const metrics = {}
                const targets = [
                    ['tagline', screen.querySelector('.loading-tagline')],
                    ['status', screen.querySelector('.loading-status')]
                ]
                for (const [name, el] of targets) {
                    if (!el) throw new Error(`Missing loading screen element: ${name}`)
                    const cs = window.getComputedStyle(el)
                    // Composite the text over the panel: effective text alpha
                    // is the color's own alpha times the element's opacity;
                    // the remainder shows the panel, not black.
                    const fgSample = toSrgb(cs.color)
                    const ownOpacity = Number.isNaN(parseFloat(cs.opacity)) ? 1 : parseFloat(cs.opacity)
                    const eo = fgSample.alpha * ownOpacity
                    const fg = fgSample.rgb.map((c, i) => c * eo + panelBg[i] * (1 - eo))
                    metrics[name] = {
                        contrast: contrastRatio(fg, panelBg),
                        fg: cs.color,
                        opacity: cs.opacity
                    }
                }

                screen.classList.add('hidden')
                return { resolved, expected, metrics }
            }, scheme === 'dark' ? 'neutral-dark' : 'neutral-light')

            expect(resolvedSystem[scheme].resolved, `System under ${scheme} color scheme resolves its palette`)
                .toBe(resolvedSystem[scheme].expected)
            for (const [name, m] of Object.entries(resolvedSystem[scheme].metrics)) {
                expect(m.contrast, `System (${scheme}) loading ${name} contrast (fg ${m.fg} opacity ${m.opacity})`).toBeGreaterThanOrEqual(4.5)
            }
        }
        await page.emulateMedia({ colorScheme: null })
    })

    test('layer panel icon controls carry Handfish tooltips, including the drag handle', async ({ page }) => {
        await page.goto('/', { waitUntil: 'networkidle' })
        await defaultProjectReady(page)
        // The base layer's drag handle is intentionally hidden (the base
        // cannot be reordered); add a reorderable layer to measure it.
        await page.evaluate(async () => {
            await window.LayersAgent.addLayer({ kind: 'effect', effectId: 'filter/blur' })
        })

        const controls = await page.evaluate(() => {
            const first = document.querySelector('layer-item:not(.base-layer):not(.child-layer)')
            if (!first) throw new Error('No layer-item rendered')
            const selectors = ['.layer-drag-handle', '.layer-visibility', '.layer-add-child', '.layer-delete', '.layer-params-toggle']
            return selectors.map(sel => {
                const el = first.querySelector(sel)
                if (!el) return { sel, missing: true }
                return {
                    sel,
                    hasTooltip: el.classList.contains('tooltip'),
                    dataTitle: el.getAttribute('data-title'),
                    title: el.getAttribute('title'),
                    ariaLabel: el.getAttribute('aria-label')
                }
            })
        })

        for (const c of controls) {
            expect(c.missing, `${c.sel} present`).toBeFalsy()
            expect(c.hasTooltip, `${c.sel} tooltip class`).toBe(true)
            expect(c.dataTitle, `${c.sel} data-title matches title`).toBe(c.title)
            expect(c.ariaLabel, `${c.sel} has aria-label`).toBeTruthy()
        }

        // The drag handle is the only non-button control in the row; hovering
        // it must raise the shared handfish tooltip layer like its siblings.
        const handle = page.locator('layer-item:not(.base-layer):not(.child-layer) .layer-drag-handle').first()
        await handle.hover()
        const tooltipLayer = page.locator('#hf-tooltip-layer')
        await expect(tooltipLayer).toBeVisible({ timeout: 2000 })
        expect(await tooltipLayer.textContent()).toContain('Drag to reorder')
        await page.mouse.move(0, 0)
        await expect(tooltipLayer).toBeHidden({ timeout: 2000 })
    })

    test('browser theme-color meta follows the active theme', async ({ page }) => {
        await page.goto('/', { waitUntil: 'networkidle' })
        await defaultProjectReady(page)

        const read = () => page.evaluate(() => ({
            meta: document.querySelector('meta[name="theme-color"]')?.content,
            body: getComputedStyle(document.body).backgroundColor
        }))

        // Boot applies the saved theme through initTheme/applyTheme; the meta
        // must carry the computed body background, not the removed hardcoded
        // #333333.
        const booted = await read()
        expect(booted.meta).toBe(booted.body)
        expect(booted.meta).not.toBe('#333333')

        // Theme switches (agent path, same applyTheme choke point as the
        // Settings dialog) update the meta in lockstep.
        await page.evaluate(() => window.LayersAgent.setSettings({ theme: 'light' }))
        const light = await read()
        expect(light.meta).toBe(light.body)
        expect(light.meta).not.toBe(booted.meta)

        await page.evaluate(() => window.LayersAgent.setSettings({ theme: 'system' }))
        const restored = await read()
        expect(restored.meta).toBe(restored.body)
    })

    test('toolbar icon buttons have consistent 32x32 sizing, states, and Handfish tooltips', async ({ page }) => {
        await page.goto('/', { waitUntil: 'networkidle' })
        await defaultProjectReady(page)

        // 1. Sizing consistency across toolbar buttons
        const buttonInfo = await page.evaluate(() => {
            const buttons = Array.from(document.querySelectorAll('#toolbar .menu-icon-btn'))
            return buttons.map(btn => {
                const rect = btn.getBoundingClientRect()
                return {
                    id: btn.id,
                    width: Math.round(rect.width),
                    height: Math.round(rect.height),
                    hasTooltip: btn.classList.contains('tooltip'),
                    dataTitle: btn.getAttribute('data-title'),
                    title: btn.getAttribute('title')
                }
            })
        })

        expect(buttonInfo.length).toBeGreaterThan(5)
        for (const btn of buttonInfo) {
            expect(btn.width, `${btn.id} width`).toBe(32)
            expect(btn.height, `${btn.id} height`).toBe(32)
            expect(btn.hasTooltip, `${btn.id} should have tooltip class`).toBe(true)
            expect(btn.dataTitle, `${btn.id} data-title should match title`).toBe(btn.title)
        }

        // 2. Handfish tooltip layer activates on hover
        const brushBtn = page.locator('#brushToolBtn')
        await brushBtn.hover()
        const tooltipLayer = page.locator('#hf-tooltip-layer')
        await expect(tooltipLayer).toBeVisible({ timeout: 2000 })
        const text = await tooltipLayer.textContent()
        expect(text).toContain('Brush Tool')

        // Moving mouse away hides the tooltip
        await page.mouse.move(0, 0)
        await expect(tooltipLayer).toBeHidden({ timeout: 2000 })

        // 3. Dual-ring focus-visible styling on toolbar button. The ring
        // animates in over a 0.15s box-shadow transition (var(--hf-transition)
        // from the Handfish token sheet), so a synchronous read right after
        // focus() captures the transition's start state — transparent,
        // 0-spread shadows — in every engine. Poll until the transition lands.
        await page.evaluate(() => document.getElementById('brushToolBtn').focus())
        let focusRing = { boxShadow: '', outlineStyle: '' }
        await expect.poll(async () => {
            focusRing = await page.evaluate(() => {
                const btn = document.getElementById('brushToolBtn')
                const style = window.getComputedStyle(btn)
                return {
                    boxShadow: style.boxShadow,
                    outlineStyle: style.outlineStyle
                }
            })
            return focusRing.boxShadow
        }, { timeout: 5000 }).toContain('0px 0px 0px 2px')
        expect(focusRing.boxShadow).toContain('0px 0px 0px 4px')

        // 4. Toolbar caret ARIA and keyboard navigation
        const caret = page.locator('#selectionMenu .tool-caret')
        await expect(caret).toHaveAttribute('aria-expanded', 'false')
        await caret.focus()
        await page.keyboard.press('Enter')
        await expect(caret).toHaveAttribute('aria-expanded', 'true')
        const selectionFlyout = page.locator('#selectionMenu .menu-items')
        await expect(selectionFlyout).not.toHaveClass(/hide/)

        // First item is focused
        const activeShape = await page.evaluate(() => document.activeElement?.getAttribute('data-shape'))
        expect(activeShape).toBe('rectangle')

        // ArrowDown navigates to next item
        await page.keyboard.press('ArrowDown')
        const nextShape = await page.evaluate(() => document.activeElement?.getAttribute('data-shape'))
        expect(nextShape).toBe('oval')

        // Escape closes flyout and restores focus to caret
        await page.keyboard.press('Escape')
        await expect(selectionFlyout).toHaveClass(/hide/)
        await expect(caret).toHaveAttribute('aria-expanded', 'false')

        // 5. Mask edit mode synchronizes data-title and aria-label in lockstep.
        // Masks are ImageData-shaped (width/height plus RGBA-stride data) and
        // are created by the app itself; a fully revealed mask is all 255s.
        await page.evaluate(async () => {
            const app = window.layersApp
            const layer = app._layers[0]
            if (layer && !layer.mask) {
                await app._addLayerMask(layer.id)
                layer.mask.data.fill(255)
            }
            app._enterMaskEditMode(layer.id)
        })

        const maskBrushTitle = await brushBtn.getAttribute('data-title')
        const maskBrushAria = await brushBtn.getAttribute('aria-label')
        expect(maskBrushTitle).toBe('Reveal (B) — paints white on mask')
        expect(maskBrushAria).toBe('Reveal (B) — paints white on mask')

        // Exit mask edit mode restores original tool labels
        await page.evaluate(() => window.layersApp._exitMaskEditMode())
        const restoredBrushTitle = await brushBtn.getAttribute('data-title')
        const restoredBrushAria = await brushBtn.getAttribute('aria-label')
        expect(restoredBrushTitle).toBe('Brush Tool (B)')
        expect(restoredBrushAria).toBe('Brush Tool (B)')
    })

    test('canvas clears the fixed toolbar and menu bar dropdowns stack above it', async ({ page }) => {
        await page.goto('/', { waitUntil: 'networkidle' })
        await defaultProjectReady(page)

        // Fit mode fills the panel's content box; the panel must reserve the
        // toolbar's width so the canvas never slides underneath it.
        const clearance = await page.evaluate(() => {
            const toolbar = document.getElementById('toolbar').getBoundingClientRect()
            const canvas = document.getElementById('canvas').getBoundingClientRect()
            return canvas.left - toolbar.right
        })
        expect(clearance).toBeGreaterThanOrEqual(16)

        // The file dropdown opens over the toolbar; it must paint on top.
        await page.locator('#menu .hf-menubar-trigger', { hasText: 'file' }).click()
        const fileNew = page.locator('#menu #newMenuItem')
        await fileNew.waitFor({ state: 'visible' })
        const dropdownWins = await page.evaluate(() => {
            const toolbar = document.getElementById('toolbar').getBoundingClientRect()
            const dropdown = document.getElementById('newMenuItem').closest('[role="menu"]').getBoundingClientRect()
            const x = (dropdown.left + toolbar.right) / 2
            const y = (Math.max(dropdown.top, toolbar.top) + Math.min(dropdown.bottom, toolbar.bottom)) / 2
            const overlaps = dropdown.left < toolbar.right && dropdown.top < toolbar.bottom && dropdown.bottom > toolbar.top
            const hit = document.elementFromPoint(x, y)
            return { overlaps, onTop: !!hit && !hit.closest('#toolbar') && !!hit.closest('#menu') }
        })
        expect(dropdownWins.overlaps).toBe(true)
        expect(dropdownWins.onTop).toBe(true)
        await page.keyboard.press('Escape')
        await expect(fileNew).toBeHidden()

        // An open toolbar flyout still sits above the menu bar.
        await page.locator('#selectionMenu .tool-caret').click()
        const flyout = page.locator('#selectionMenu .menu-items')
        await expect(flyout).not.toHaveClass(/hide/)
        const flyoutWins = await page.evaluate(() => {
            const items = document.querySelector('#selectionMenu .menu-items')
            const box = items.getBoundingClientRect()
            return items.contains(document.elementFromPoint(box.left + box.width / 2, box.top + 8))
        })
        expect(flyoutWins).toBe(true)
    })

    test('modal dialog chrome resolves from --hf-* tokens and re-themes on theme switch', async ({ page }) => {
        await page.goto('/', { waitUntil: 'networkidle' })
        await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })

        // Open the New Project dialog, then the Canvas Size dialog (New Canvas path)
        await reopenNewProjectDialog(page)
        await page.click('.media-option[data-type="solid"]')
        const dialog = page.locator('.canvas-size-dialog')
        await dialog.waitFor({ state: 'visible', timeout: 5000 })

        const metrics = await page.evaluate(() => {
            const dialogEl = document.querySelector('.canvas-size-dialog')
            const cs = el => window.getComputedStyle(el)
            const root = document.documentElement
            const token = name => cs(root).getPropertyValue(name).trim()
            const header = dialogEl.querySelector('.dialog-header')
            return {
                tokens: {
                    space4: token('--hf-space-4'),
                    space5: token('--hf-space-5'),
                    space6: token('--hf-space-6'),
                    sizeXl: token('--hf-size-xl'),
                    sizeXs: token('--hf-size-xs'),
                    space3: token('--hf-space-3'),
                    space2: token('--hf-space-2'),
                    bgSurface: token('--hf-bg-surface'),
                    borderHover: token('--hf-border-hover')
                },
                headerPaddingTop: cs(header).paddingTop,
                headerPaddingLeft: cs(header).paddingLeft,
                h2FontSize: cs(dialogEl.querySelector('.dialog-header h2')).fontSize,
                bodyPaddingTop: cs(dialogEl.querySelector('.dialog-body')).paddingTop,
                bodyScrollbarColor: cs(dialogEl.querySelector('.dialog-body')).scrollbarColor,
                actionsPaddingTop: cs(dialogEl.querySelector('.dialog-actions')).paddingTop,
                presetPaddingTop: cs(dialogEl.querySelector('.size-preset')).paddingTop,
                presetLabelFontSize: cs(dialogEl.querySelector('.preset-label')).fontSize,
                inputUnitPaddingTop: cs(dialogEl.querySelector('.input-unit')).paddingTop,
                remProbe: (() => {
                    const probe = document.createElement('div')
                    probe.style.position = 'absolute'
                    probe.style.height = '1rem'
                    document.body.appendChild(probe)
                    const h = parseFloat(window.getComputedStyle(probe).height)
                    probe.remove()
                    return h
                })()
            }
        })

        const px = v => {
            const n = parseFloat(v)
            return v.endsWith('rem') ? `${n * metrics.remProbe}px` : `${n}px`
        }
        expect(metrics.headerPaddingTop).toBe(px(metrics.tokens.space4))
        expect(metrics.headerPaddingLeft).toBe(px(metrics.tokens.space5))
        expect(metrics.h2FontSize).toBe(px(metrics.tokens.sizeXl))
        expect(metrics.bodyPaddingTop).toBe(px(metrics.tokens.space6))
        expect(metrics.actionsPaddingTop).toBe(px(metrics.tokens.space4))
        expect(metrics.presetPaddingTop).toBe(px(metrics.tokens.space3))
        expect(metrics.presetLabelFontSize).toBe(px(metrics.tokens.sizeXs))
        expect(metrics.inputUnitPaddingTop).toBe(px(metrics.tokens.space2))
        // Scroll region is themed, not an OS-default island (scrollbar-color: auto
        // means browser default); exact color equality is covered by the
        // theme-switch assertions below because computed color formats differ.
        expect(metrics.bodyScrollbarColor).not.toBe('auto')

        // Theme switch re-resolves the themed scrollbar and paddings
        const before = await page.evaluate(() => ({
            scrollbar: window.getComputedStyle(document.querySelector('.canvas-size-dialog .dialog-body')).scrollbarColor,
            bgSurface: window.getComputedStyle(document.documentElement).getPropertyValue('--hf-bg-surface').trim()
        }))
        await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'cyberpunk'))
        const after = await page.evaluate(() => ({
            scrollbar: window.getComputedStyle(document.querySelector('.canvas-size-dialog .dialog-body')).scrollbarColor,
            bgSurface: window.getComputedStyle(document.documentElement).getPropertyValue('--hf-bg-surface').trim()
        }))
        expect(after.bgSurface).not.toBe(before.bgSurface)
        // scrollbar-color re-resolves from the theme's tokens (format-normalized
        // comparison, since engines serialize colors differently)
        const norm = s => s.replace(/\s+/g, '').toLowerCase()
        expect(norm(after.scrollbar)).not.toBe(norm(before.scrollbar))

        await page.evaluate(() => document.documentElement.removeAttribute('data-theme'))
    })

    test('persistent small-text surfaces meet WCAG AA contrast across all themes', async ({ page }) => {
        await page.goto('/', { waitUntil: 'networkidle' })
        await defaultProjectReady(page)
        await page.locator('.layer-item').first().waitFor({ state: 'visible', timeout: 10000 })

        // Open the real settings dialog so the .dialog-close measurement uses
        // the production dialog-panel surface instead of a synthetic one.
        await page.evaluate(() => window.LayersAgent.ready)
        await page.locator('#menu #logoMenu').click()
        await page.locator('#menu #settingsMenuItem').waitFor({ state: 'visible' })
        await page.locator('#menu #settingsMenuItem').click()
        const dialogCloseLoc = page.locator('.settings-dialog .dialog-close').locator('visible=true')
        await dialogCloseLoc.waitFor({ state: 'visible', timeout: 5000 })

        const results = await page.evaluate(async () => {
            function toSrgb(colorStr) {
                const canvas = document.createElement('canvas')
                canvas.width = 1
                canvas.height = 1
                const ctx = canvas.getContext('2d', { willReadFrequently: true })
                ctx.fillStyle = '#000000'
                ctx.fillStyle = colorStr
                ctx.fillRect(0, 0, 1, 1)
                const data = ctx.getImageData(0, 0, 1, 1).data
                return [data[0] / 255, data[1] / 255, data[2] / 255]
            }

            function luminance([r, g, b]) {
                const a = [r, g, b].map(v => v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4))
                return a[0] * 0.2126 + a[1] * 0.7152 + a[2] * 0.0722
            }

            function contrastRatio(fg, bg) {
                const l1 = luminance(toSrgb(fg))
                const l2 = luminance(toSrgb(bg))
                return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)
            }

            function alphaOf(bg) {
                const slash = bg.match(/\/\s*([\d.]+)\s*\)/)
                if (slash) return parseFloat(slash[1])
                const m = bg.match(/rgba?\(([^)]+)\)/)
                if (m && m[1].split(',').length === 4) return parseFloat(m[1].split(',')[3])
                return 1
            }

            function effectiveBg(el) {
                // Compositing walk: blend each translucent layer over the next
                // background down the ancestor chain (dialogs use 0.92-alpha
                // panels over the themed body), then over the body background.
                let composite = null
                for (let node = el; node; node = node.parentElement) {
                    const bg = window.getComputedStyle(node).backgroundColor
                    if (!bg || bg === 'rgba(0, 0, 0, 0)' || bg === 'transparent') continue
                    const rgb = toSrgb(bg)
                    const alpha = alphaOf(bg)
                    composite = composite === null
                        ? { rgb, alpha }
                        : { rgb: rgb.map((v, i) => v * alpha + composite.rgb[i] * (1 - alpha)), alpha }
                    if (composite.alpha >= 0.999) {
                        return `rgb(${composite.rgb.map(v => Math.round(v * 255)).join(',')})`
                    }
                }
                const bodyBg = toSrgb(window.getComputedStyle(document.body).backgroundColor)
                if (composite === null) return window.getComputedStyle(document.body).backgroundColor
                const fin = composite.rgb.map((v, i) => v * composite.alpha + bodyBg[i] * (1 - composite.alpha))
                return `rgb(${fin.map(v => Math.round(v * 255)).join(',')})`
            }

            const fixture = document.createElement('div')
            fixture.innerHTML = `
                <div class="layer-item"><div class="layer-type effect">Effect</div></div>
                <div class="effect-params"><span class="effect-params-title">Parameters</span></div>
            `
            document.body.appendChild(fixture)
            const layerType = fixture.querySelector('.layer-type')
            const paramsTitle = fixture.querySelector('.effect-params-title')
            const dialogCloses = [...document.querySelectorAll('.settings-dialog .dialog-close')]
            const dialogClose = (dialogCloses.find(el => el.offsetParent !== null) || dialogCloses[0])
                // the visible glyph is the icon span; measure the painted color
                const dialogCloseGlyph = dialogClose.querySelector('.icon-material') || dialogClose

            const themes = ['dark', 'light', 'gray-dark', 'gray-light', 'neutral-dark', 'neutral-light',
                'corporate', 'cyberpunk', 'earthy', 'organic', 'terminal']
            // .dialog-close carries a color transition; a fixed sleep measured
            // mid-transition colors under two-worker load (1.17:1 on an
            // in-flight color, failing all retries). Settle deterministically
            // instead: resolve on the element's own color transitionend, or
            // once the computed color has held identical across three rAF
            // samples after the transition's span, bounded at 3s.
            const settleColor = (el) => new Promise((resolve) => {
                const startedAt = performance.now()
                let settled = false
                const finish = () => {
                    if (settled) return
                    settled = true
                    el.removeEventListener('transitionend', onEnd)
                    resolve()
                }
                const onEnd = (e) => {
                    if (e.target === el && e.propertyName === 'color') finish()
                }
                el.addEventListener('transitionend', onEnd)
                let prev = null
                let same = 0
                const poll = () => {
                    if (settled) return
                    const c = window.getComputedStyle(el).color
                    same = c === prev ? same + 1 : 0
                    prev = c
                    if (same >= 3 && performance.now() - startedAt > 300) finish()
                    else requestAnimationFrame(poll)
                }
                requestAnimationFrame(poll)
                setTimeout(finish, 3000)
            })
            const report = {}
            for (const theme of themes) {
                document.documentElement.dataset.theme = theme
                await settleColor(dialogCloseGlyph)
                report[theme] = {
                    dialogClose: contrastRatio(window.getComputedStyle(dialogCloseGlyph).color, effectiveBg(dialogClose)),
                    layerType: contrastRatio(window.getComputedStyle(layerType).color, effectiveBg(layerType)),
                    paramsTitle: contrastRatio(window.getComputedStyle(paramsTitle).color, effectiveBg(paramsTitle))
                }
            }
            fixture.remove()
            document.documentElement.removeAttribute('data-theme')
            return report
        })

        for (const [theme, m] of Object.entries(results)) {
            expect(m.dialogClose, `${theme} dialog-close contrast ${JSON.stringify(m)}`).toBeGreaterThanOrEqual(4.5)
            expect(m.layerType, `${theme} layer-type contrast ${JSON.stringify(m)}`).toBeGreaterThanOrEqual(4.5)
            expect(m.paramsTitle, `${theme} effect-params-title contrast ${JSON.stringify(m)}`).toBeGreaterThanOrEqual(4.5)
        }
    })

    test('the foreground color input announces the accessible name "Foreground Color"', async ({ page, browserName }) => {
        await page.goto('/', { waitUntil: 'networkidle' })
        await defaultProjectReady(page)

        // The visible, named element is the wrapper div (.color-well carries
        // the tooltip and the :focus-within ring), but the wrapper is not
        // interactive: the widget that takes focus and is exposed to
        // accessibility tools is the opacity-0 color input inside it. That
        // input must carry its own accessible name, consistent with the
        // wrapper's tooltip text. The DOM assertion runs on every engine;
        // the engines' accessibility snapshots are not portable, so the
        // Chromium tree itself is read further down.
        const inputName = await page.evaluate(() => {
            const input = document.getElementById('colorWellInput')
            if (!input) throw new Error('Missing #colorWellInput')
            const aria = (input.getAttribute('aria-label') || '').trim()
            if (aria) return aria
            const labelFor = input.id ? document.querySelector(`label[for="${CSS.escape(input.id)}"]`) : null
            if (labelFor) {
                const text = (labelFor.textContent || '').trim()
                if (text) return text
            }
            return ((input.closest('label') || {}).textContent || '').trim()
        })
        expect(inputName).toContain('Foreground Color')

        // The layer opacity slider is handfish's <slider-value>, which renders
        // its own <input type="range"> and does not forward the host's title
        // to it; Layers names that inner input. Playwright computes the
        // accessible name itself, so this runs on every engine. Soft, so a
        // failure here still lets the Chromium tree sweep below report too.
        const opacityHosts = await page.locator('layer-item slider-value.layer-opacity').count()
        expect(opacityHosts).toBeGreaterThanOrEqual(1)
        await expect.soft(page.getByRole('slider', { name: 'Opacity', exact: true })).toHaveCount(opacityHosts)

        if (browserName !== 'chromium') return

        // In the engine's accessibility tree the input is the ColorWell
        // node that screen readers announce (the wrapper is a generic that
        // cannot lend its name to the focusable child), and it must carry
        // the name above.
        const cdp = await page.context().newCDPSession(page)
        await cdp.send('DOM.enable')
        const { root } = await cdp.send('DOM.getDocument', { depth: -1 })
        const domIds = new Map()
        const domClasses = new Map()
        const walk = node => {
            if (node.backendNodeId) {
                const i = node.attributes?.indexOf('id')
                if (i >= 0) domIds.set(node.backendNodeId, node.attributes[i + 1])
                const c = node.attributes?.indexOf('class')
                if (c >= 0) domClasses.set(node.backendNodeId, node.attributes[c + 1])
            }
            for (const child of node.children || []) walk(child)
            if (node.shadowRoots) for (const shadow of node.shadowRoots) walk(shadow)
            if (node.templateContent) walk(node.templateContent)
            if (node.contentDocument) walk(node.contentDocument)
        }
        walk(root)
        await cdp.send('Accessibility.enable')
        const { nodes } = await cdp.send('Accessibility.getFullAXTree')
        const described = node => {
            const id = domIds.get(node.backendDOMNodeId)
            const cls = domClasses.get(node.backendDOMNodeId)
            return `${node.role?.value ?? '?'}${id ? `#${id}` : ''}${cls ? `.${cls.trim().split(/\s+/).join('.')}` : ''}`
        }

        const colorWell = nodes.filter(node => !node.ignored && node.role?.value === 'ColorWell')
        expect(colorWell.length).toBeGreaterThanOrEqual(1)
        expect(colorWell.some(node => domIds.get(node.backendDOMNodeId) === 'colorWellInput'
            && (node.name?.value || '').includes('Foreground Color')), described(colorWell[0])).toBe(true)

        // And the default boot state exposes no other interactive control
        // without an accessible name: every non-ignored button, slider,
        // textbox and the like in the full tree carries one. Chromium reports
        // ARIA-mapped roles in lowercase ("button", "slider") and only its
        // internal roles capitalized ("ColorWell"), so roles are compared
        // case-insensitively.
        const interactiveRoles = new Set([
            'button', 'slider', 'textbox', 'checkbox', 'radio', 'togglebutton',
            'switch', 'link', 'menuitem', 'menuitemcheckbox', 'menuitemradio',
            'menubutton', 'popupbutton', 'combobox', 'listbox', 'option',
            'spinbutton', 'colorwell', 'textfield', 'searchbox', 'tab', 'treeitem',
        ])
        const roleOf = node => String(node.role?.value ?? '').toLowerCase()
        const interactive = nodes.filter(node => !node.ignored && interactiveRoles.has(roleOf(node)))
        // The sweep must see the controls it guards, or it passes vacuously:
        // the boot tree holds the toolbar's buttons and the layer opacity
        // slider.
        expect(interactive.filter(node => roleOf(node) === 'button').length,
            'boot-state buttons seen by the sweep').toBeGreaterThan(0)
        expect(interactive.filter(node => roleOf(node) === 'slider').length,
            'boot-state sliders seen by the sweep').toBeGreaterThan(0)
        const unnamed = interactive
            .filter(node => !(node.name?.value || '').trim())
            .map(described)
        expect(unnamed, 'accessibility-tree interactive nodes without an accessible name').toEqual([])
    })
})
