import { test, expect } from './fixtures.js'

async function bootSolid(page) {
    await page.goto('/', { waitUntil: 'networkidle' })
    await page.locator('#loading-screen').waitFor({ state: 'hidden' })
    const backdrop = page.locator('.open-dialog-backdrop.visible')
    await backdrop.waitFor()
    await page.locator('.media-option[data-type="solid"]').click()
    await page.locator('.canvas-size-dialog .action-btn.primary').click()
    await backdrop.waitFor({ state: 'hidden' })
}

test('a failed SDK import can be retried and read-only status stays visible', async ({ page }) => {
    await bootSolid(page)
    const result = await page.evaluate(async () => {
        const { createLayersOnlineAdapter } = await import('/js/collab/onlineAdapter.js')
        const handlers = new Map()
        let imports = 0
        let status = 'offline'
        const layer = {
            on: (name, fn) => handlers.set(name, fn),
            getStatus: () => status,
            getSessionId: () => 'try123',
            getShareUrl: () => 'https://layers.test/?seance=try123',
            getNodes: () => [],
            takeOnline: async () => { status = 'online' },
            goOffline: () => { status = 'offline' },
            writeSessionToUrl: url => url,
        }
        const dialog = { state: 'offline' }
        const adapter = createLayersOnlineAdapter(window.layersApp, {
            location: new URL('https://layers.test/'), history: { replaceState() {} }, dialog,
            importSdk: async () => {
                if (++imports === 1) throw new Error('temporary SDK download failure')
                return { createOnlineDslLayer: () => layer }
            },
        })
        let firstError
        try { await adapter.takeOnline() } catch (error) { firstError = error.message }
        let secondError
        try { await adapter.takeOnline() } catch (error) { secondError = error.message }
        status = 'readonly'
        handlers.get('status')?.('readonly')
        const result = { imports, firstError, secondError, state: dialog.state }
        adapter.goOffline()
        return result
    })
    expect(result).toEqual({ imports: 2, firstError: 'temporary SDK download failure', secondError: undefined, state: 'readonly' })
})

test('take-online rejects a composition over the peer raster budget before creating a session', async ({ page }) => {
    await bootSolid(page)
    const result = await page.evaluate(async () => {
        const { createLayersOnlineAdapter } = await import('/js/collab/onlineAdapter.js')
        const { createDrawingLayer } = await import('/js/layers/layer-model.js')
        const app = window.layersApp
        const originalLayers = app._layers
        // Each drawing uses the 1024x1024 canvas when a peer rasterizes it;
        // sixty-five exceed the shared 8192x8192 total without allocating them here.
        app._layers = Array.from({ length: 65 }, (_, index) => {
            const drawing = createDrawingLayer()
            drawing.strokes = [{ id: `stroke-test-${index}`, type: 'path', color: '#000000',
                size: 5, opacity: 1, points: [{ x: 1, y: 1 }, { x: 2, y: 2 }] }]
            return drawing
        })
        let creates = 0
        let status = 'offline'
        const layer = {
            on() {}, getStatus: () => status, getSessionId: () => 'big123',
            getNodes: () => [], getShareUrl: () => '', writeSessionToUrl: url => url,
            takeOnline: async () => { creates++; status = 'online' },
            goOffline: () => { status = 'offline' },
        }
        const adapter = createLayersOnlineAdapter(app, {
            location: new URL('https://layers.test/'), history: { replaceState() {} }, dialog: null,
            importSdk: async () => ({ createOnlineDslLayer: () => layer }),
        })
        let error
        try { await adapter.takeOnline() } catch (err) { error = err.message }
        const result = { creates, error, status: adapter.getStatus() }
        adapter.goOffline()
        app._layers = originalLayers
        return result
    })
    expect(result.creates).toBe(0)
    expect(result.error).toContain('raster pixels exceed')
    expect(result.status).toBe('offline')
})
