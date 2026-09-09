import { test, expect } from './fixtures.js'

test('context restoration restores content and respects playback changes while lost', async ({ page }) => {
    test.setTimeout(60000)
    await page.goto('/', { waitUntil: 'networkidle' })
    await page.waitForFunction(() => !!window.LayersAgent, null, { timeout: 15000 })
    await page.evaluate(async () => { await window.LayersAgent.ready })
    const before = await page.evaluate(async () => {
        await window.LayersAgent.newProject({ width: 128, height: 128 })
        const canvas = document.createElement('canvas'); canvas.width = 128; canvas.height = 128
        const ctx = canvas.getContext('2d'); ctx.fillStyle = '#ef3413'; ctx.fillRect(0, 0, 128, 128)
        const added = await window.LayersAgent.addLayer({ kind: 'media', mediaType: 'image',
            source: { kind: 'base64', data: canvas.toDataURL().split(',')[1], mimeType: 'image/png' } })
        await window.LayersAgent.addLayerMask({ layerId: added.result.layerId })
        await window.LayersAgent.setLayerTransform({ layerId: added.result.layerId,
            transform: { scaleX: 0.75, scaleY: 0.75, rotation: 15 } })
        const app = window.layersApp
        const { createDrawingLayer } = await import('/js/layers/layer-model.js')
        const { createPathStroke } = await import('/js/drawing/stroke-model.js')
        const drawing = createDrawingLayer('Drawing')
        drawing.strokes.push(createPathStroke({ color: '#10ff20', size: 10,
            points: [{ x: 10, y: 30 }, { x: 100, y: 60 }] }))
        app._layers.push(drawing)
        await app._rasterizeDrawingLayer(drawing)
        await window.LayersAgent.addLayer({ kind: 'text', text: 'A' })
        await app._rebuild({ force: true })
        app._renderer.stop()
        app._renderer.render(0)
        return app._canvas.toDataURL()
    })
    for (let loss = 0; loss < 3; loss++) {
        await page.evaluate(async iteration => {
            const renderer = window.layersApp._renderer
            if (iteration === 1) renderer.start()
            const canvas = window.layersApp._canvas
            const gl = canvas.getContext('webgl2')
            const extension = gl.getExtension('WEBGL_lose_context')
            if (!extension) throw new Error('Context-loss extension is required for this test')
            const lost = new Promise(resolve => canvas.addEventListener('webglcontextlost', resolve, { once: true }))
            extension.loseContext()
            await lost
            if (iteration === 1) renderer.stop()
            if (iteration === 2) renderer.start()
            const restored = new Promise(resolve => canvas.addEventListener('webglcontextrestored', resolve, { once: true }))
            // Deliberate: this is the lost window the test applies, not a
            // readiness guess. restoreContext() is only honoured once the
            // contextlost dispatch has finished, and the playback change above
            // is made while the context is down, which is what this checks.
            await new Promise(resolve => setTimeout(resolve, 100))
            extension.restoreContext()
            await restored
        }, loss)
        await expect.poll(() => page.evaluate(() => {
            const app = window.layersApp
            if (app._renderer._renderer.isContextLost) return null
            app._renderer.render(0)
            return app._canvas.toDataURL()
        }), { timeout: 15000 }).toBe(before)
        expect(await page.evaluate(() => window.layersApp._renderer.isRunning)).toBe(loss === 2)
    }
})
