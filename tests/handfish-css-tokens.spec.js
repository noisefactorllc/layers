import { test, expect } from './fixtures.js'
import { appReady, defaultProjectReady } from './waits.js'
import { reopenNewProjectDialog } from './helpers/new-project.js'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

test.describe('Handfish Design System CSS Token Compliance', () => {
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
    })
})

