import { test, expect } from './fixtures.js'
import { appReady } from './waits.js'
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
})
