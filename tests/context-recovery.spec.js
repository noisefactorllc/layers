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
        const canvasOutput = document.getElementById('canvas')
        if (!canvasOutput?.isConnected || canvasOutput !== app._renderer.canvas || app._canvas !== canvasOutput) {
            throw new Error('Application canvas must be the displayed renderer canvas')
        }
        return app._canvas.toDataURL()
    })
    for (let loss = 0; loss < 3; loss++) {
        await page.evaluate(async iteration => {
            const renderer = window.layersApp._renderer
            if (iteration === 1) renderer.start()
            const canvas = document.getElementById('canvas')
            if (!canvas?.isConnected || canvas !== renderer.canvas) {
                throw new Error('Recovery must lose the displayed renderer canvas')
            }
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
            const canvasOutput = document.getElementById('canvas')
            if (!canvasOutput?.isConnected || canvasOutput !== app._renderer.canvas) {
                throw new Error('Recovery must capture the displayed renderer canvas')
            }
            return app._canvas.toDataURL()
        }), { timeout: 15000 }).toBe(before)
        await expect.poll(() => page.evaluate(() => {
            const app = window.layersApp
            const canvasOutput = document.getElementById('canvas')
            if (!canvasOutput?.isConnected || canvasOutput !== app._renderer.canvas) {
                throw new Error('Recovery must capture the displayed renderer canvas')
            }
            return canvasOutput.toDataURL()
        }), { timeout: 15000 }).toBe(before)
        expect(await page.evaluate(() => {
            const app = window.layersApp
            return app._canvas.isConnected && app._canvas === document.getElementById('canvas')
                && app._canvas === app._renderer.canvas
        })).toBe(true)
        expect(await page.evaluate(() => window.layersApp._renderer.isRunning)).toBe(loss === 2)
    }
})

async function setupRecoveryImage(page) {
    await page.goto('/', { waitUntil: 'networkidle' })
    await page.waitForFunction(() => !!window.LayersAgent, null, { timeout: 15000 })
    return page.evaluate(async () => {
        await window.LayersAgent.ready
        await window.LayersAgent.newProject({ width: 128, height: 128 })
        const source = document.createElement('canvas')
        source.width = 128
        source.height = 128
        source.getContext('2d').fillStyle = '#ef3413'
        source.getContext('2d').fillRect(0, 0, 128, 128)
        const added = await window.LayersAgent.addLayer({
            kind: 'media', mediaType: 'image',
            source: { kind: 'base64', data: source.toDataURL().split(',')[1], mimeType: 'image/png' },
        })
        if (!added.ok) throw new Error(added.error.message)
        window.layersApp._renderer.stop()
        window.layersApp._renderer.render(0)
        return document.getElementById('canvas').toDataURL()
    })
}

async function restoreRecoveryImage(page, before) {
    await page.evaluate(async () => {
        const canvas = document.getElementById('canvas')
        const extension = canvas.getContext('webgl2').getExtension('WEBGL_lose_context')
        if (!extension) throw new Error('Context-loss extension is required for this test')
        const lost = new Promise(resolve => canvas.addEventListener('webglcontextlost', resolve, { once: true }))
        extension.loseContext()
        await lost
        const restored = new Promise(resolve => canvas.addEventListener('webglcontextrestored', resolve, { once: true }))
        await new Promise(resolve => setTimeout(resolve, 100))
        extension.restoreContext()
        await restored
    })
    await expect.poll(() => page.evaluate(() => {
        const app = window.layersApp
        if (app._renderer._renderer.isContextLost) return null
        app._renderer.render(0)
        return document.getElementById('canvas').toDataURL()
    }), { timeout: 15000 }).toBe(before)
}

test('getThumbnail preserves media pixels after context restoration', async ({ page }) => {
    test.setTimeout(60000)
    const before = await setupRecoveryImage(page)
    await restoreRecoveryImage(page, before)
    const result = await page.evaluate(async () => {
        const thumbnail = await window.LayersAgent.getThumbnail({ maxDimension: 128, format: 'png' })
        if (!thumbnail.ok) throw new Error(thumbnail.error.message)
        const bytes = Uint8Array.from(atob(thumbnail.result.bytes), character => character.charCodeAt(0))
        const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }))
        const sample = new OffscreenCanvas(1, 1)
        sample.getContext('2d').drawImage(bitmap, 64, 64, 1, 1, 0, 0, 1, 1)
        const pixel = [...sample.getContext('2d').getImageData(0, 0, 1, 1).data]
        bitmap.close()
        return { width: thumbnail.result.width, height: thumbnail.result.height, pixel }
    })
    expect(result).toEqual({ width: 128, height: 128, pixel: [239, 52, 19, 255] })
})

test('resize after context restoration keeps app and existing canvas consumers current', async ({ page }) => {
    test.setTimeout(60000)
    const before = await setupRecoveryImage(page)
    await restoreRecoveryImage(page, before)
    const result = await page.evaluate(async () => {
        const resized = await window.LayersAgent.resizeCanvas({ width: 192, height: 160, anchor: 'top-left' })
        if (!resized.ok) throw new Error(resized.error.message)
        const app = window.layersApp
        app._renderer.render(0)
        const displayed = document.getElementById('canvas')
        const sample = (canvas, x, y) => {
            const copy = new OffscreenCanvas(1, 1)
            copy.getContext('2d').drawImage(canvas, x, y, 1, 1, 0, 0, 1, 1)
            return [...copy.getContext('2d').getImageData(0, 0, 1, 1).data]
        }
        const consumers = [app._canvas, app._selectionManager._sourceCanvas,
            app._fillTool._canvas, app._eyedropperTool._canvas,
            app._exportImageDialog.canvas, app._exportVideoDialog.canvas]
        return {
            dimensions: [displayed.width, displayed.height],
            overlay: [app._selectionOverlay.width, app._selectionOverlay.height],
            displayedPixel: sample(displayed, 64, 64),
            appPixel: sample(app._canvas, 64, 64),
            paddingPixel: sample(displayed, 191, 159),
            currentConsumers: consumers.map(canvas => canvas === displayed && canvas.isConnected),
            consumerDimensions: consumers.map(canvas => [canvas.width, canvas.height]),
        }
    })
    expect(result.dimensions).toEqual([192, 160])
    expect(result.overlay).toEqual([192, 160])
    expect(result.displayedPixel).toEqual([239, 52, 19, 255])
    expect(result.appPixel).toEqual([239, 52, 19, 255])
    expect(result.paddingPixel).toEqual([0, 0, 0, 0])
    expect(result.currentConsumers).toEqual([true, true, true, true, true, true])
    expect(result.consumerDimensions).toEqual(Array.from({ length: 6 }, () => [192, 160]))
})
