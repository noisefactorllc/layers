import { test, expect } from 'playwright/test'

/**
 * A catalog entry is not always one typeface. "Monaspace" is five (Argon,
 * Krypton, Neon, Radon, Xenon) across three widths; "Roboto" ships Roboto and
 * RobotoCondensed; "Inter" ships Inter and InterDisplay; IBM Plex splits each
 * face across unicode subsets.
 *
 * Registration used to pick "the first non-italic woff2" from that pile, so
 * choosing a font could register a completely different typeface than the one
 * named — Monaspace previewed as Krypton Wide ExtraLight, and an IBM Plex pick
 * could land on a symbols-only subset with no letters at all. These lock the
 * parse and the pick to the face the name actually means.
 */

/** Filenames verbatim from https://fonts.noisefactor.io/bundle/fonts.json. */
const FIXTURE = [
    {
        id: '47-monaspace', name: 'Monaspace', dir_name: '47-monaspace',
        files: [
            'MonaspaceKryptonFrozen-WideExtraLight.woff2',
            'MonaspaceRadonFrozen-SemiWideMediumItalic.woff2',
            'MonaspaceNeonFrozen-SemiWideExtraBold.woff2',
            'MonaspaceArgonFrozen-Regular.woff2',
            'MonaspaceNeonFrozen-Regular.woff2',
            'MonaspaceXenonFrozen-Medium.woff2',
            'MonaspaceArgonFrozen-Bold.woff2',
        ].map(filename => ({ filename })),
    },
    {
        id: '02-roboto', name: 'Roboto', dir_name: '02-roboto',
        files: ['Roboto-Regular.woff2', 'RobotoCondensed-Regular.woff2', 'Roboto-Bold.woff2']
            .map(filename => ({ filename })),
    },
    {
        id: '12-ibm-plex-sans', name: 'IBM Plex Sans', dir_name: '12-ibm-plex-sans',
        files: [
            'IBMPlexSans-Regular-Pi.woff2',
            'IBMPlexSans-Regular-Cyrillic.woff2',
            'IBMPlexSans-Regular-Latin1.woff2',
            'IBMPlexSans-Bold-Latin1.woff2',
        ].map(filename => ({ filename })),
    },
    {
        id: '40-source-code-pro', name: 'Source Code Pro', dir_name: '40-source-code-pro',
        files: ['SourceCodePro-Regular.woff2', 'SourceCodePro-ExtraLightIt.woff2', 'SourceCodePro-BoldIt.woff2']
            .map(filename => ({ filename })),
    },
]

async function withLoader(page, fn) {
    await page.goto('/')
    return page.evaluate(async ({ fixture, body }) => {
        const m = await import('/js/layers/fontaine-loader.js')
        const loader = new m.FontaineLoader()
        loader.catalog = { fonts: fixture }
        // eslint-disable-next-line no-new-func
        return new Function('loader', `return (${body})(loader)`)(loader)
    }, { fixture: FIXTURE, body: fn.toString() })
}

test.describe('fontaine: face identity', () => {
    test('compound weight/width/slant descriptors parse', async ({ page }) => {
        const parsed = await withLoader(page, (loader) => ({
            monaspace: loader.parseStyleFromFilename('MonaspaceRadonFrozen-SemiWideMediumItalic.woff2'),
            abbreviated: loader.parseStyleFromFilename('SourceCodePro-ExtraLightIt.woff2'),
            extraBold: loader.parseStyleFromFilename('MonaspaceNeonFrozen-SemiWideExtraBold.woff2'),
        }))
        expect(parsed.monaspace.weight).toBe('500')
        expect(parsed.monaspace.style).toBe('italic')
        expect(parsed.abbreviated.weight).toBe('200')
        expect(parsed.abbreviated.style).toBe('italic')
        // The bug: unparsed descriptors all collapsed onto Regular/400.
        expect(parsed.extraBold.weight).toBe('800')
    })

    test('a style bucket never mixes typefaces or duplicate subsets', async ({ page }) => {
        const report = await withLoader(page, (loader) => {
            const problems = []
            for (const font of loader.getAllFonts()) {
                for (const style of loader.getStylesForFont(font.id)) {
                    const faces = new Set(style.files.map(f => {
                        const p = loader.parseStyleFromFilename(f.filename)
                        return `${p.face}|${p.weight}|${p.style}`
                    }))
                    if (faces.size > 1) problems.push(`${font.name}/${style.label}: ${[...faces].join(' , ')}`)
                    const slots = style.files.map(f => {
                        const { subset } = loader.parseStyleFromFilename(f.filename)
                        return loader.unicodeRangeForSubset(subset) || `unranged:${subset}`
                    })
                    if (new Set(slots).size !== slots.length) {
                        problems.push(`${font.name}/${style.label}: colliding CSS slots`)
                    }
                }
            }
            return problems
        })
        expect(report).toEqual([])
    })

    test('registration picks the face the family name means', async ({ page }) => {
        const picks = await withLoader(page, (loader) => {
            const out = {}
            for (const font of loader.getAllFonts()) {
                out[font.name] = loader.pickPreviewFile(font).filename
            }
            return out
        })
        expect(picks.Monaspace).toBe('MonaspaceArgonFrozen-Regular.woff2')
        expect(picks.Roboto).toBe('Roboto-Regular.woff2')
        expect(picks['Source Code Pro']).toBe('SourceCodePro-Regular.woff2')
        // Must not be the symbols-only subset, which renders no Latin at all.
        expect(picks['IBM Plex Sans']).toBe('IBMPlexSans-Regular-Latin1.woff2')
    })

    test('every weight of a family is selectable, not just the registered 400', async ({ page }) => {
        const styles = await withLoader(page, (loader) => {
            const out = {}
            for (const font of loader.getAllFonts()) {
                out[font.name] = loader.getStylesForFont(font.id).map(s => `${s.label}|${s.weight}|${s.style}`)
            }
            return out
        })
        // Monaspace's cuts must surface as distinct, per-typeface choices.
        expect(styles.Monaspace).toContain('Argon Regular|400|normal')
        expect(styles.Monaspace).toContain('Argon Bold|700|normal')
        expect(styles.Monaspace).toContain('Xenon Medium|500|normal')
        expect(styles.Monaspace).toContain('Neon Regular|400|normal')
        // Roboto keeps plain labels but still separates weights.
        expect(styles.Roboto).toContain('Regular|400|normal')
        expect(styles.Roboto).toContain('Bold|700|normal')
    })

    test('a legacy bare label still resolves to its weight', async ({ page }) => {
        const resolved = await withLoader(page, (loader) => {
            const mona = loader.getAllFonts().find(f => f.name === 'Monaspace')
            const roboto = loader.getAllFonts().find(f => f.name === 'Roboto')
            const pick = (font, label) => {
                const s = loader.resolveStyle(font.id, label)
                return { label: s.label, weight: s.weight, style: s.style, file: s.files[0].filename }
            }
            return {
                monaRegular: pick(mona, 'Regular'),
                robotoBold: pick(roboto, 'Bold'),
                unknown: pick(mona, 'Not A Real Label'),
            }
        })
        expect(resolved.monaRegular.weight).toBe('400')
        expect(resolved.monaRegular.style).toBe('normal')
        expect(resolved.robotoBold.file).toBe('Roboto-Bold.woff2')
        expect(resolved.unknown).toBeTruthy()
    })

    test('previews register under their own family so they cannot shadow a style', async ({ page }) => {
        const family = await page.goto('/').then(() => page.evaluate(async () => {
            const m = await import('/js/layers/fontaine-loader.js')
            return m.previewFamilyFor('Monaspace')
        }))
        expect(family).not.toBe('Monaspace')
        expect(family).toContain('Monaspace')
    })

    test('subset files carry a unicode-range so they stop overwriting each other', async ({ page }) => {
        const ranges = await withLoader(page, (loader) => ({
            latin: loader.unicodeRangeForSubset('Latin1'),
            cyrillic: loader.unicodeRangeForSubset('Cyrillic'),
            unknown: loader.unicodeRangeForSubset('Pi'),
            none: loader.unicodeRangeForSubset(''),
        }))
        expect(ranges.latin).toBeTruthy()
        expect(ranges.cyrillic).toBeTruthy()
        expect(ranges.latin).not.toBe(ranges.cyrillic)
        expect(ranges.unknown).toBeNull()
        expect(ranges.none).toBeNull()
    })
})
