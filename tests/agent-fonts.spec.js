import { test, expect } from 'playwright/test'

test.describe('agent: listInstalledFonts', () => {
    test('returns shape with installed flag and fonts array', async ({ page }) => {
        await page.goto('/')
        await page.evaluate(() => window.LayersAgent.ready)
        const r = await page.evaluate(() => window.LayersAgent.listInstalledFonts({}))
        expect(r.ok).toBe(true)
        expect(typeof r.result.installed).toBe('boolean')
        expect(Array.isArray(r.result.fonts)).toBe(true)
        expect(typeof r.result.count).toBe('number')
        // version is string-or-null
        expect(['string', 'object']).toContain(typeof r.result.version)
    })

    test('uninstalled state returns empty fonts list and count 0', async ({ page }) => {
        // Default test environment has no bundle installed.
        await page.goto('/')
        await page.evaluate(() => window.LayersAgent.ready)
        const r = await page.evaluate(() => window.LayersAgent.listInstalledFonts({}))
        if (!r.result.installed) {
            expect(r.result.count).toBe(0)
            expect(r.result.fonts).toEqual([])
            expect(r.result.version).toBeNull()
        }
    })
})

test.describe('agent: installFontBundle', () => {
    test('returns jobId and progresses through phases (mocked)', async ({ page }) => {
        await page.goto('/')
        await page.evaluate(() => window.LayersAgent.ready)

        // Stub the loader.install to avoid the 140 MB real download. The loader
        // is a module-level singleton — dynamic-importing the same module from
        // the test gives us the same instance that commands.js holds.
        await page.evaluate(async () => {
            const m = await import('/js/layers/fontaine-loader.js')
            const loader = m.getFontaineLoader()
            loader.install = async ({ onProgress }) => {
                onProgress(0, 'Loading manifest...')
                onProgress(50, 'Downloading: 70 / 140 MB')
                onProgress(100, 'Installed 100 fonts')
                loader.installedVersion = 'test-1'
                loader.catalog = { fonts: [{ id: 'a', name: 'A' }] }
                loader.fontsLoaded = true
                return true
            }
            loader.isInstalled = async () => true
        })

        const r = await page.evaluate(() => window.LayersAgent.installFontBundle({}))
        expect(r.ok).toBe(true)
        expect(typeof r.result.jobId).toBe('string')

        const final = await page.evaluate((id) =>
            window.LayersAgent.waitForJob({ jobId: id, timeoutMs: 5000 }),
            r.result.jobId)
        expect(final.result.status).toBe('succeeded')
        expect(final.result.result.count).toBe(1)
    })

    test('progress reports phase + percent during install', async ({ page }) => {
        await page.goto('/')
        await page.evaluate(() => window.LayersAgent.ready)

        await page.evaluate(async () => {
            const m = await import('/js/layers/fontaine-loader.js')
            const loader = m.getFontaineLoader()
            loader.install = async ({ onProgress }) => {
                onProgress(25, 'Downloading: 35 / 140 MB')
                await new Promise(r => setTimeout(r, 30))
                onProgress(75, 'Extracting fonts...')
                await new Promise(r => setTimeout(r, 30))
                loader.installedVersion = 'test-2'
                loader.catalog = { fonts: [] }
                loader.fontsLoaded = true
                return true
            }
            loader.isInstalled = async () => true
        })

        const { jobId } = (await page.evaluate(() => window.LayersAgent.installFontBundle({}))).result

        const final = await page.evaluate((id) =>
            window.LayersAgent.waitForJob({ jobId: id, timeoutMs: 5000 }), jobId)
        expect(final.result.status).toBe('succeeded')
        // Progress reached the final reported value (total=100 always; current=100 at done).
        const after = await page.evaluate((id) => window.LayersAgent.getJob({ jobId: id }), jobId)
        expect(after.result.progress.total).toBe(100)
        expect(after.result.progress.current).toBe(100)
    })
})
