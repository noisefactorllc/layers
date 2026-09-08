import { test, expect } from './fixtures.js'
import { installNoisemakerSource } from './noisemaker-source.js'

test.beforeEach(async ({ page }) => {
    await installNoisemakerSource(page, [['mixer/alphaMask', 'alphaMask']])
})

test('full-resolution image resource preserves native dimensions and original File with a bounded preview', async ({ page }) => {
    await page.goto('/', { waitUntil: 'networkidle' })
    const result = await page.evaluate(async () => {
        const canvas = document.createElement('canvas')
        canvas.width = 6000
        canvas.height = 4000
        canvas.getContext('2d').fillRect(0, 0, 6000, 4000)
        const file = new File([await new Promise(resolve => canvas.toBlob(resolve))], 'original.png', { type: 'image/png' })
        const resource = await window.layersApp._renderer.prepareMediaResource(file, 'image')
        const result = { width: resource.width, height: resource.height, original: resource.sourceFile === file,
            previewWidth: resource.element.width, previewHeight: resource.element.height }
        window.layersApp._renderer.disposeMediaResource(resource)
        return result
    })
    expect(result).toMatchObject({ width: 6000, height: 4000, original: true })
    expect(result.previewWidth).toBeLessThanOrEqual(1920)
    expect(result.previewHeight).toBeLessThanOrEqual(1080)
})

test('tiled GPU output matches the same complete frame including tile boundaries', async ({ page }) => {
    await page.goto('/', { waitUntil: 'networkidle' })
    const result = await page.evaluate(async () => {
        const app = window.layersApp
        const canvas = document.createElement('canvas')
        canvas.width = 384
        canvas.height = 256
        const ctx = canvas.getContext('2d')
        ctx.fillStyle = '#ff4000'
        ctx.fillRect(0, 0, 384, 256)
        ctx.fillStyle = '#0040ff'
        for (let x = 0; x < 384; x += 2) ctx.fillRect(x, 0, 1, 256)
        const file = new File([await new Promise(resolve => canvas.toBlob(resolve))], 'detail.png', { type: 'image/png' })
        await app._handleOpenMedia(file, 'image')
        app._renderer.stop()
        app._renderer.render(0)
        const expected = document.createElement('canvas')
        expected.width = 384; expected.height = 256
        const expectedContext = expected.getContext('2d')
        expectedContext.drawImage(app._canvas, 0, 0)
        const actual = await app._renderer.renderFullResolution({ tileSize: 128 })
        const a = expectedContext.getImageData(0, 0, 384, 256).data
        const b = actual.getContext('2d').getImageData(0, 0, 384, 256).data
        let different = 0, maximum = 0
        for (let i = 0; i < a.length; i++) { if(a[i] !== b[i]) different++; maximum=Math.max(maximum,Math.abs(a[i]-b[i])) }
        return { different, maximum, width: actual.width, height: actual.height }
    })
    expect(result).toEqual({ different: 0, maximum: 0, width: 384, height: 256 })
})

test('6000x4000 import keeps document dimensions and exports original single-pixel detail through bounded GPU tiles', async ({ page }) => {
    test.setTimeout(120000)
    await page.goto('/', { waitUntil: 'networkidle' })
    const result = await page.evaluate(async () => {
        const app = window.layersApp
        const source = document.createElement('canvas')
        source.width = 6000; source.height = 4000
        const ctx = source.getContext('2d')
        ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 6000, 4000)
        ctx.fillStyle = '#000'; ctx.fillRect(3000, 0, 1, 4000)
        const file = new File([await new Promise(resolve => source.toBlob(resolve))], 'photo.png', { type: 'image/png' })
        const opened = await app._handleOpenMedia(file, 'image')
        app._renderer.stop()
        const before = { width: app._canvas.width, height: app._canvas.height,
            renderWidth: app._renderer._renderer.pipeline.width, renderHeight: app._renderer._renderer.pipeline.height }
        const output = await app._renderer.renderFullResolution()
        const pixels = [...output.getContext('2d').getImageData(2999, 2000, 3, 1).data]
        return { opened, before, output: [output.width, output.height], pixels,
            after: [app._canvas.width, app._canvas.height, app._renderer._renderer.pipeline.width, app._renderer._renderer.pipeline.height] }
    })
    expect(result.opened).toBe('opened')
    expect(result.before).toEqual({ width: 6000, height: 4000, renderWidth: 1254, renderHeight: 836 })
    expect(result.output).toEqual([6000, 4000])
    expect(result.pixels).toEqual([255,255,255,255, 0,0,0,255, 255,255,255,255])
    expect(result.after).toEqual([6000, 4000, 1254, 836])
})

test('tiled GPU capture preserves translated, flipped, rotated, masked blend output', async ({ page }) => {
    test.setTimeout(60000)
    await page.goto('/', { waitUntil: 'networkidle' })
    const result = await page.evaluate(async () => {
        const app = window.layersApp
        await app._handleCreateSolidBase(384, 256)
        const source = document.createElement('canvas')
        source.width = 180; source.height = 140
        const ctx = source.getContext('2d')
        ctx.fillStyle = '#f00'; ctx.fillRect(0, 0, 90, 140)
        ctx.fillStyle = '#0f0'; ctx.fillRect(90, 0, 90, 140)
        const file = new File([await new Promise(resolve => source.toBlob(resolve))], 'transformed.png', { type: 'image/png' })
        await app._handleAddMediaLayer(file, 'image')
        const layer = app._layers.at(-1)
        layer.offsetX = 37; layer.offsetY = -21
        layer.scaleX = 1.25; layer.scaleY = 0.8; layer.flipH = true; layer.rotation = 30; layer.opacity = 0.6
        const maskCanvas = document.createElement('canvas')
        maskCanvas.width = 384; maskCanvas.height = 256
        const maskCtx = maskCanvas.getContext('2d')
        maskCtx.fillStyle = '#fff'; maskCtx.fillRect(0, 0, 220, 256)
        layer.mask = maskCtx.getImageData(0, 0, 384, 256); layer.maskEnabled = true
        app._renderer.uploadMaskTexture(layer.id, layer.mask)
        await app._rebuild({ force: true })
        app._renderer.stop(); app._renderer.render(0)
        const expected = document.createElement('canvas')
        expected.width = 384; expected.height = 256
        const expectedCtx = expected.getContext('2d')
        expectedCtx.drawImage(app._canvas, 0, 0)
        const actual = await app._renderer.renderFullResolution({ tileSize: 128 })
        const a = expectedCtx.getImageData(0, 0, 384, 256).data
        const b = actual.getContext('2d').getImageData(0, 0, 384, 256).data
        let difference = 0, maxDifference = 0
        for (let i = 0; i < a.length; i++) { if (a[i] !== b[i]) difference++; maxDifference = Math.max(maxDifference,Math.abs(a[i] - b[i])) }
        return { difference, maxDifference }
    })
    expect(result).toEqual({ difference: 0, maxDifference: 0 })
})

test('unsafe large filter output is rejected before source decoding or renderer allocation', async ({ page }) => {
    await page.goto('/', { waitUntil: 'networkidle' })
    const result = await page.evaluate(async () => {
        const app = window.layersApp
        await app._handleCreateGradientBase(256, 256)
        app._renderer.stop()
        const owner = app._renderer
        const pipeline = owner._renderer.pipeline
        let allocations = 0
        Object.defineProperty(owner, 'constructor', { configurable: true, value: class { constructor() { allocations++; throw new Error('allocation attempted') } } })
        try {
            await owner.renderFullResolution({ width: 6000, height: 4000 })
            return { succeeded: true }
        } catch (error) {
            return { code: error.code, message: error.message, allocations,
                unchanged: pipeline === owner._renderer.pipeline && app._canvas.width === 256 && app._canvas.height === 256 }
        } finally { delete owner.constructor }
    })
    expect(result.code).toBe('FULL_RESOLUTION_UNSUPPORTED')
    expect(result.message).toMatch(/budget|limit/)
    expect(result.allocations).toBe(0)
    expect(result.unchanged).toBe(true)
})

test('a failed tiled capture disposes detached GPU resources and retains the live renderer and original media', async ({ page }) => {
    await page.goto('/', { waitUntil: 'networkidle' })
    const result = await page.evaluate(async () => {
        const app = window.layersApp
        await app._handleCreateSolidBase(384, 256)
        app._renderer.stop()
        const owner = app._renderer
        const Original = owner.constructor
        let disposed = false
        class FailingRenderer extends Original {
            constructor(...args) {
                super(...args)
                const dispose = this._renderer.dispose.bind(this._renderer)
                this._renderer.dispose = async options => { disposed = true; return dispose(options) }
            }
            render() { throw new Error('Injected tile failure') }
        }
        Object.defineProperty(owner, 'constructor', { configurable: true, value: FailingRenderer })
        const pipeline = owner._renderer.pipeline
        try { await owner.renderFullResolution({ tileSize: 128 }); return { succeeded: true } }
        catch (error) { return { message: error.message, disposed, unchanged: pipeline === owner._renderer.pipeline } }
        finally { delete owner.constructor }
    })
    expect(result).toEqual({ message: 'Injected tile failure', disposed: true, unchanged: true })
})

test('agent image export returns a 6000x4000 PNG with original single-pixel detail', async ({ page }) => {
    test.setTimeout(120000)
    await page.goto('/', { waitUntil: 'networkidle' })
    await page.waitForFunction(() => !!window.LayersAgent, null, { timeout: 15000 })
    const result = await page.evaluate(async () => {
        await window.LayersAgent.ready
        const app = window.layersApp
        const source = document.createElement('canvas'); source.width = 6000; source.height = 4000
        const ctx = source.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0,0,6000,4000)
        ctx.fillStyle = '#000'; ctx.fillRect(3000,0,1,4000)
        const file = new File([await new Promise(resolve => source.toBlob(resolve))], 'agent-original.png', {type:'image/png'})
        await app._handleOpenMedia(file,'image'); app._renderer.stop()
        const before = [app._canvas.width,app._canvas.height,app._renderer._renderer.pipeline.width,app._renderer._renderer.pipeline.height]
        const exported = await window.LayersAgent.exportImage({format:'png',captureOnly:true})
        if (!exported.ok) return {ok:false,error:exported.error}
        const bytes = Uint8Array.from(atob(exported.result.bytes), c=>c.charCodeAt(0))
        const bitmap = await createImageBitmap(new Blob([bytes],{type:'image/png'}))
        const sample = new OffscreenCanvas(3,1)
        sample.getContext('2d').drawImage(bitmap,2999,2000,3,1,0,0,3,1)
        const pixel = [...sample.getContext('2d').getImageData(0,0,3,1).data]
        const size = [bitmap.width,bitmap.height]; bitmap.close()
        if(exported.result.exportId) await window.LayersAgent.releaseExport({exportId:exported.result.exportId})
        return {ok:true,size,pixel,before,after:[app._canvas.width,app._canvas.height,app._renderer._renderer.pipeline.width,app._renderer._renderer.pipeline.height]}
    })
    expect(result.ok).toBe(true)
    expect(result.size).toEqual([6000,4000])
    expect(result.pixel).toEqual([255,255,255,255,0,0,0,255,255,255,255,255])
    expect(result.after).toEqual(result.before)
})
