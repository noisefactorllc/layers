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

test.describe('getCanvasImageBytes', () => {
    test('returns base64 PNG bytes by default', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() => window.LayersAgent.getCanvasImageBytes())
        expect(env.ok).toBe(true)
        expect(env.result.format).toBe('png')
        expect(env.result.mimeType).toBe('image/png')
        expect(env.result.width).toBeGreaterThan(0)
        expect(env.result.height).toBeGreaterThan(0)
        expect(typeof env.result.bytes).toBe('string')
        expect(env.result.bytes.length).toBeGreaterThan(0)
        expect(env.result.bytes.startsWith('iVBOR')).toBe(true)
    })

    test('captures an effect parameter update from the immediately preceding command', async ({ page }) => {
        await bootApp(page)
        const pixel = await page.evaluate(async () => {
            const app = window.layersApp
            const layer = app._layers[0]
            await window.LayersAgent.setLayerEffectParams({
                layerId: layer.id,
                params: { color: [1, 0, 0], alpha: 1 },
                replace: true,
            })
            const encoded = await window.LayersAgent.getCanvasImageBytes({ format: 'png' })
            const binary = atob(encoded.result.bytes)
            const bytes = Uint8Array.from(binary, character => character.charCodeAt(0))
            const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }))
            const sample = new OffscreenCanvas(1, 1)
            sample.getContext('2d').drawImage(
                bitmap,
                Math.floor(bitmap.width / 2), Math.floor(bitmap.height / 2), 1, 1,
                0, 0, 1, 1)
            const value = [...sample.getContext('2d').getImageData(0, 0, 1, 1).data]
            bitmap.close()
            return value
        })

        expect(pixel[0]).toBeGreaterThan(240)
        expect(pixel[1]).toBeLessThan(15)
        expect(pixel[2]).toBeLessThan(15)
        expect(pixel[3]).toBeGreaterThan(240)
    })

    test('honors format=jpg', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() =>
            window.LayersAgent.getCanvasImageBytes({ format: 'jpg', quality: 0.8 }))
        expect(env.ok).toBe(true)
        expect(env.result.format).toBe('jpg')
        expect(env.result.mimeType).toBe('image/jpeg')
        expect(env.result.bytes.startsWith('/9j/')).toBe(true)
    })

    test('rejects unknown format', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() =>
            window.LayersAgent.getCanvasImageBytes({ format: 'gif' }))
        expect(env.ok).toBe(false)
        expect(env.error.code).toBe('INVALID_ARGS_ENUM')
    })

    test('encodes WebP with valid RIFF/WEBP magic bytes', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() =>
            window.LayersAgent.getCanvasImageBytes({ format: 'webp', quality: 0.9 }))
        expect(env.ok).toBe(true)
        expect(env.result.format).toBe('webp')
        expect(env.result.mimeType).toBe('image/webp')
        expect(env.result.bytes.length).toBeGreaterThan(100)
        // Verify magic number: WebP starts with "RIFF" then 4 size bytes then "WEBP"
        const decoded = atob(env.result.bytes)
        expect(decoded.slice(0, 4)).toBe('RIFF')
        expect(decoded.slice(8, 12)).toBe('WEBP')
    })
})

test.describe('getThumbnail', () => {
    test('returns a small JPG thumbnail by default', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() => window.LayersAgent.getThumbnail())
        expect(env.ok).toBe(true)
        expect(env.result.format).toBe('jpg')
        expect(env.result.mimeType).toBe('image/jpeg')
        expect(env.result.width).toBeGreaterThan(0)
        expect(env.result.height).toBeGreaterThan(0)
        expect(Math.max(env.result.width, env.result.height)).toBeLessThanOrEqual(256)
        expect(env.result.bytes.startsWith('/9j/')).toBe(true)
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
            let thumbnail
            try {
                thumbnail = await window.LayersAgent.getThumbnail({
                    maxDimension: 64,
                    format: 'png',
                })
            } finally {
                app._renderCurrentFrame = renderCurrentFrame
            }
            const binary = atob(thumbnail.result.bytes)
            const bytes = Uint8Array.from(binary, character => character.charCodeAt(0))
            const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }))
            const sample = new OffscreenCanvas(1, 1)
            sample.getContext('2d').drawImage(
                bitmap,
                Math.floor(bitmap.width / 2), Math.floor(bitmap.height / 2), 1, 1,
                0, 0, 1, 1)
            const pixel = [...sample.getContext('2d').getImageData(0, 0, 1, 1).data]
            bitmap.close()
            return { preceding, thumbnail, freshFrameCalls, pixel }
        })

        expect(result.preceding.ok).toBe(true)
        expect(result.thumbnail.ok).toBe(true)
        expect(result.thumbnail.result.format).toBe('png')
        expect(result.freshFrameCalls).toBe(1)
        expect(result.pixel[0]).toBeGreaterThan(240)
        expect(result.pixel[1]).toBeLessThan(15)
        expect(result.pixel[2]).toBeLessThan(15)
        expect(result.pixel[3]).toBeGreaterThan(240)
    })

    test('honors maxDimension', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() => window.LayersAgent.getThumbnail({ maxDimension: 64 }))
        expect(env.ok).toBe(true)
        expect(Math.max(env.result.width, env.result.height)).toBeLessThanOrEqual(64)
    })

    test('preserves aspect ratio', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() => window.LayersAgent.getThumbnail({ maxDimension: 100 }))
        expect(env.ok).toBe(true)
        // Default canvas is 1024x1024 → both sides should be 100
        expect(env.result.width).toBe(100)
        expect(env.result.height).toBe(100)
    })

    test('rejects out-of-range maxDimension', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() => window.LayersAgent.getThumbnail({ maxDimension: 0 }))
        expect(env.ok).toBe(false)
        expect(env.error.code).toBe('INVALID_ARGS_RANGE')
    })
})

test.describe('getLayerThumbnail', () => {
    test('returns a per-layer JPG thumbnail', async ({ page }) => {
        await bootApp(page)
        const id = await page.evaluate(() => window.layersApp._layers[0].id)
        const env = await page.evaluate((layerId) =>
            window.LayersAgent.getLayerThumbnail({ layerId }), id)
        expect(env.ok).toBe(true)
        expect(env.result.format).toBe('jpg')
        expect(Math.max(env.result.width, env.result.height)).toBeLessThanOrEqual(256)
        expect(env.result.bytes.startsWith('/9j/')).toBe(true)
    })

    test('paused layer isolation restores the visible composite and run state', async ({ page }) => {
        await bootApp(page)
        const result = await page.evaluate(async () => {
            const app = window.layersApp
            const base = app._layers[0]
            await window.LayersAgent.setLayerEffectParams({
                layerId: base.id,
                params: { color: [1, 0, 0], alpha: 1 },
                replace: true,
            })
            const added = await window.LayersAgent.addLayer({
                kind: 'effect',
                effectId: 'synth/solid',
                params: { color: [0, 1, 0], alpha: 1 },
            })
            app._renderer.stop()
            app._renderCurrentFrame()
            const sampleLivePixel = () => {
                const sample = new OffscreenCanvas(1, 1)
                const ctx = sample.getContext('2d')
                ctx.drawImage(
                    app._canvas,
                    Math.floor(app._canvas.width / 2),
                    Math.floor(app._canvas.height / 2), 1, 1,
                    0, 0, 1, 1)
                return Array.from(ctx.getImageData(0, 0, 1, 1).data)
            }
            const before = sampleLivePixel()
            const thumbnail = await window.LayersAgent.getLayerThumbnail({
                layerId: base.id,
                maxDimension: 64,
                format: 'png',
            })
            const after = sampleLivePixel()
            const binary = atob(thumbnail.result.bytes)
            const bytes = Uint8Array.from(binary, character => character.charCodeAt(0))
            const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }))
            const sample = new OffscreenCanvas(1, 1)
            sample.getContext('2d').drawImage(
                bitmap,
                Math.floor(bitmap.width / 2), Math.floor(bitmap.height / 2), 1, 1,
                0, 0, 1, 1)
            const thumbnailPixel = Array.from(
                sample.getContext('2d').getImageData(0, 0, 1, 1).data)
            bitmap.close()
            return {
                added,
                thumbnail,
                before,
                after,
                thumbnailPixel,
                running: app._renderer.isRunning,
            }
        })

        expect(result.added.ok).toBe(true)
        expect(result.thumbnail.ok).toBe(true)
        expect(result.before).toEqual([0, 255, 0, 255])
        expect(result.after).toEqual(result.before)
        expect(result.thumbnailPixel).toEqual([255, 0, 0, 255])
        expect(result.running).toBe(false)
    })

    test('NOT_FOUND_LAYER for missing id', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() =>
            window.LayersAgent.getLayerThumbnail({ layerId: 'layer-nope' }))
        expect(env.ok).toBe(false)
        expect(env.error.code).toBe('NOT_FOUND_LAYER')
    })

    test('honors maxDimension', async ({ page }) => {
        await bootApp(page)
        const id = await page.evaluate(() => window.layersApp._layers[0].id)
        const env = await page.evaluate((layerId) =>
            window.LayersAgent.getLayerThumbnail({ layerId, maxDimension: 32 }), id)
        expect(env.ok).toBe(true)
        expect(Math.max(env.result.width, env.result.height)).toBeLessThanOrEqual(32)
    })
})

test.describe('pasteImageFromBytes', () => {
    const TINY_PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='

    test('adds a media layer from base64 bytes', async ({ page }) => {
        await bootApp(page)
        const before = await page.evaluate(() => window.layersApp._layers.length)
        const env = await page.evaluate((data) =>
            window.LayersAgent.pasteImageFromBytes({
                source: { kind: 'base64', data, mimeType: 'image/png' }
            }), TINY_PNG_B64)
        expect(env.ok).toBe(true)
        expect(env.result.layerId).toMatch(/^layer-/)
        const after = await page.evaluate(() => window.layersApp._layers.length)
        expect(after).toBe(before + 1)
        const layer = env.state.layers.find(l => l.id === env.result.layerId)
        expect(layer.sourceType).toBe('media')
    })

    test('rejects missing source', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() => window.LayersAgent.pasteImageFromBytes({}))
        expect(env.ok).toBe(false)
        expect(env.error.code).toBe('INVALID_ARGS_REQUIRED')
        expect(env.error.details.field).toBe('source')
    })
})
