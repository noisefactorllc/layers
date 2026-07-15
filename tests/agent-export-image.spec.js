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

    test('captures a red effect update from the immediately preceding command', async ({ page }) => {
        await bootApp(page)
        const result = await page.evaluate(async () => {
            const app = window.layersApp
            const layer = app._layers[0]
            const preceding = await window.LayersAgent.setLayerEffectParams({
                layerId: layer.id,
                params: { color: [1, 0, 0], alpha: 1 },
                replace: true,
            })
            const renderCurrentFrame = app._renderCurrentFrame
            let freshFrameCalls = 0
            app._renderCurrentFrame = (...args) => {
                freshFrameCalls += 1
                return renderCurrentFrame.apply(app, args)
            }
            let exported
            try {
                exported = await window.LayersAgent.exportImage({
                    format: 'png',
                    triggerDownload: false,
                })
            } finally {
                app._renderCurrentFrame = renderCurrentFrame
            }
            const binary = atob(exported.result.bytes)
            const bytes = Uint8Array.from(binary, character => character.charCodeAt(0))
            const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }))
            const sample = new OffscreenCanvas(1, 1)
            sample.getContext('2d').drawImage(
                bitmap,
                Math.floor(bitmap.width / 2), Math.floor(bitmap.height / 2), 1, 1,
                0, 0, 1, 1)
            const pixel = [...sample.getContext('2d').getImageData(0, 0, 1, 1).data]
            bitmap.close()
            return { preceding, exported, freshFrameCalls, pixel }
        })

        expect(result.preceding.ok).toBe(true)
        expect(result.exported.ok).toBe(true)
        expect(result.exported.result.format).toBe('png')
        expect(result.freshFrameCalls).toBe(1)
        expect(result.pixel[0]).toBeGreaterThan(240)
        expect(result.pixel[1]).toBeLessThan(15)
        expect(result.pixel[2]).toBeLessThan(15)
        expect(result.pixel[3]).toBeGreaterThan(240)
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

    test('releaseExport on an image exportId throws NOT_FOUND_EXPORT', async ({ page }) => {
        // exportImage's captureOnly path returns bytes inline (no blob URL),
        // so there's nothing to release. Calling releaseExport on the returned
        // id must be loud rather than silently succeeding.
        await bootApp(page)
        const env = await page.evaluate(() =>
            window.LayersAgent.exportImage({ format: 'png', captureOnly: true }))
        expect(env.ok).toBe(true)
        const id = env.result.exportId
        expect(typeof id).toBe('string')
        const rel = await page.evaluate((id) =>
            window.LayersAgent.releaseExport({ exportId: id }), id)
        expect(rel.ok).toBe(false)
        expect(rel.error.code).toBe('NOT_FOUND_EXPORT')
    })
})
