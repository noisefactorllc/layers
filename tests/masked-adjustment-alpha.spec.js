import { test, expect } from './fixtures.js'
import { PNG } from 'pngjs'
import { installNoisemakerSource } from './noisemaker-source.js'

test.beforeEach(async ({ page }) => {
    await installNoisemakerSource(page, ['mixer/alphaMask', 'filter/invert', 'filter/tint'])
    await page.goto('/', { waitUntil: 'networkidle' })
    await page.waitForSelector('#loading-screen', { state: 'hidden' })
    await page.click('.media-option[data-type="solid"]')
    await page.fill('#canvas-width', '128')
    await page.fill('#canvas-height', '64')
    await page.click('.canvas-size-dialog .action-btn.primary')
    await page.waitForSelector('.open-dialog-backdrop.visible', { state: 'hidden' })
    await page.evaluate(async () => {
        const app = window.layersApp
        await app._projectLifecycleTail
        app._layers[0].effectParams = { color: [0, 0, 1], alpha: 0.5 }
        await app._rebuild({ force: true })
    })
})

for (const effectAlpha of [0, 0.5]) {
    test(`masked child replaces RGBA at effect alpha ${effectAlpha} through its parent mask`, async ({ page }) => {
        const result = await page.evaluate(async alpha => {
            const app = window.layersApp
            const parentId = app._layers[0].id
            // A black luminance mask erases; a full red tint preserves coverage.
            const added = await app._handleAddChildEffect(parentId,
                alpha === 0 ? 'mixer/alphaMask' : 'filter/tint', {
                    params: alpha === 0 ? { maskMode: true } : { color: [1, 0, 0], alpha: 1, mode: 0 },
                })
            if (added?.status !== 'committed') throw new Error(`Child effect failed: ${JSON.stringify(added)}`)
            const parent = app._layers.find(layer => layer.id === parentId)
            const child = parent.children[0]
            const mask = makeMask((x) => x < 44 ? 0 : x < 86 ? 128 : 255)
            const parentMask = makeMask((x, y) => y < 32 ? 255 : 128)
            child.mask = mask
            parent.mask = parentMask
            parent.maskEnabled = true
            app._renderer.uploadMaskTexture(child.id, mask)
            app._renderer.uploadMaskTexture(parent.id, parentMask)
            await app._rebuild({ force: true })
            app._renderer.render(0)
            const gl = app._canvas.getContext('webgl2')
            gl.bindFramebuffer(gl.FRAMEBUFFER, null)
            const pixels = new Uint8Array(128 * 64 * 4)
            gl.readPixels(0, 0, 128, 64, gl.RGBA, gl.UNSIGNED_BYTE, pixels)
            const exported = await window.LayersAgent.exportImage({ format: 'png', captureOnly: true })
            if (!exported.ok) throw new Error(exported.error?.message || 'Export failed')
            return { pixels: Array.from(pixels), png: exported.result.bytes }

            function makeMask(value) {
                const image = new ImageData(128, 64)
                for (let y = 0; y < 64; y++) for (let x = 0; x < 128; x++) {
                    const v = value(x, y)
                    image.data.set([v, v, v, 255], (y * 128 + x) * 4)
                }
                return image
            }
        }, effectAlpha)
        const png = PNG.sync.read(Buffer.from(result.png, 'base64'))
        expect([png.width, png.height]).toEqual([128, 64])
        let firstDifference = null
        for (let y = 0; y < 64; y++) for (let x = 0; x < 128; x++) {
            const mask = x < 44 ? 0 : x < 86 ? 128 / 255 : 1
            const parent = y < 32 ? 1 : 128 / 255
            const red = effectAlpha * mask * parent
            const blue = 0.5 * (1 - mask) * parent
            const alpha = red + blue
            const raw = [red, 0, blue, alpha].map(v => Math.round(v * 255))
            const exported = alpha ? [red / alpha, 0, blue / alpha, alpha].map(v => Math.round(v * 255)) : [0, 0, 0, 0]
            for (let c = 0; c < 4; c++) {
                const liveValue = result.pixels[((63 - y) * 128 + x) * 4 + c]
                const exportValue = png.data[(y * 128 + x) * 4 + c]
                if (!firstDifference && (Math.abs(liveValue - raw[c]) > 1 || Math.abs(exportValue - exported[c]) > 2)) {
                    firstDifference = { x, y, channel: c, liveValue, exportValue, expectedLive: raw[c], expectedExport: exported[c] }
                }
            }
        }
        expect(firstDifference, 'every live and exported pixel must match the coverage oracle').toBeNull()
    })
}

test('a masked invert preserves fractional coverage and the unselected color', async ({ page }) => {
    const pixels = await page.evaluate(async () => {
        const app = window.layersApp
        const parent = app._layers[0]
        app._selectionManager.setSelection({ type: 'rect', x: 0, y: 0, width: 64, height: 64 })
        await app._handleAddChildEffect(parent.id, 'filter/invert')
        app._renderer.render(0)
        const gl = app._canvas.getContext('webgl2')
        gl.bindFramebuffer(gl.FRAMEBUFFER, null)
        return [32, 96].map(x => {
            const pixel = new Uint8Array(4)
            gl.readPixels(x, 32, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel)
            return Array.from(pixel)
        })
    })
    expect(pixels).toEqual([[128, 128, 0, 128], [0, 0, 128, 128]])
})

test('two child masks, a parent mask, and following media keep separate texture identities', async ({ page }) => {
    const pixels = await page.evaluate(async () => {
        const app = window.layersApp
        const parentId = app._layers[0].id
        for (const [selection, color] of [
            [{ type: 'rect', x: 0, y: 0, width: 64, height: 64 }, [1, 0, 0]],
            [{ type: 'rect', x: 0, y: 0, width: 128, height: 32 }, [0, 1, 0]],
        ]) {
            app._selectionManager.setSelection(selection)
            const result = await app._handleAddChildEffect(parentId, 'filter/tint', { params: { color, alpha: 1, mode: 0 } })
            if (result?.status !== 'committed') throw new Error('Child did not commit')
        }
        app._selectionManager.clearSelection()
        const parent = app._layers.find(layer => layer.id === parentId)
        const mask = new ImageData(128, 64)
        for (let y = 0; y < 64; y++) for (let x = 0; x < 128; x++) {
            const v = y < 32 ? 255 : 128
            mask.data.set([v, v, v, 255], (y * 128 + x) * 4)
        }
        parent.mask = mask
        parent.maskEnabled = true
        app._renderer.uploadMaskTexture(parentId, mask)
        const source = document.createElement('canvas')
        source.width = 128; source.height = 64
        const ctx = source.getContext('2d')
        ctx.fillStyle = '#ffff00'
        ctx.fillRect(104, 40, 16, 16)
        const blob = await new Promise(resolve => source.toBlob(resolve, 'image/png'))
        await app._handleAddMediaLayer(new File([blob], 'mask-identity.png', { type: 'image/png' }), 'image')
        app._renderer.render(0)
        const gl = app._canvas.getContext('webgl2')
        gl.bindFramebuffer(gl.FRAMEBUFFER, null)
        return [[16, 16], [16, 48], [96, 16], [96, 48], [112, 48]].map(([x, y]) => {
            const pixel = new Uint8Array(4)
            gl.readPixels(x, 63 - y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel)
            return Array.from(pixel)
        })
    })
    expect(pixels).toEqual([[0, 128, 0, 128], [64, 0, 0, 64], [0, 128, 0, 128], [0, 0, 64, 64], [255, 255, 0, 255]])
})
