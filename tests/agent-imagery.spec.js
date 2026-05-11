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
