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

test.describe('exportImage', () => {
    test('returns PNG bytes inline', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() =>
            window.LayersAgent.exportImage({ format: 'png', triggerDownload: false }))
        expect(env.ok).toBe(true)
        expect(env.result.format).toBe('png')
        expect(env.result.mimeType).toBe('image/png')
        expect(env.result.bytes.startsWith('iVBOR')).toBe(true)
        expect(env.result.sizeBytes).toBeGreaterThan(0)
        expect(env.result.filename).toMatch(/\.png$/)
    })

    test('exports JPG with custom quality', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() =>
            window.LayersAgent.exportImage({ format: 'jpg', quality: 0.5, triggerDownload: false }))
        expect(env.ok).toBe(true)
        expect(env.result.format).toBe('jpg')
        expect(env.result.bytes.startsWith('/9j/')).toBe(true)
    })

    test('honors target width/height (resampled)', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() =>
            window.LayersAgent.exportImage({
                format: 'png', width: 256, height: 256, triggerDownload: false
            }))
        expect(env.ok).toBe(true)
        expect(env.result.width).toBe(256)
        expect(env.result.height).toBe(256)
    })

    test('triggers a browser download by default and adds a recentExports entry', async ({ page }) => {
        await bootApp(page)
        const downloadPromise = page.waitForEvent('download', { timeout: 5000 })
        const env = await page.evaluate(() =>
            window.LayersAgent.exportImage({ format: 'png', filename: 'agent-test' }))
        const download = await downloadPromise
        expect(env.ok).toBe(true)
        expect(download.suggestedFilename()).toMatch(/\.png$/)
        expect(env.state.recentExports.length).toBeGreaterThan(0)
        const last = env.state.recentExports[env.state.recentExports.length - 1]
        expect(last.kind).toBe('image')
        expect(last.mimeType).toBe('image/png')
    })

    test('accepts a custom filename', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() =>
            window.LayersAgent.exportImage({
                format: 'png', filename: 'my-export', triggerDownload: false
            }))
        expect(env.ok).toBe(true)
        expect(env.result.filename).toBe('my-export.png')
    })

    test('rejects unknown format', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() =>
            window.LayersAgent.exportImage({ format: 'gif' }))
        expect(env.ok).toBe(false)
        expect(env.error.code).toBe('INVALID_ARGS_ENUM')
    })

    test('captureOnly suppresses download but still returns bytes', async ({ page }) => {
        await bootApp(page)
        // If a download did fire, this listener would catch it and our
        // assertion below would see downloadFired === true. We need a
        // longer-running test path to be confident no event fires; here we
        // give 500ms after the command completes for any pending download
        // to surface.
        let downloadFired = false
        page.on('download', () => { downloadFired = true })
        const env = await page.evaluate(() =>
            window.LayersAgent.exportImage({ format: 'png', captureOnly: true }))
        expect(env.ok).toBe(true)
        expect(env.result.bytes.startsWith('iVBOR')).toBe(true)
        expect(env.result.sizeBytes).toBeGreaterThan(0)
        // Give any rogue download event time to land before asserting.
        await page.waitForTimeout(500)
        expect(downloadFired).toBe(false)
    })
})
