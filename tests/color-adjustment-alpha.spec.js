import { test, expect } from './fixtures.js'
import { installNoisemakerSource } from './noisemaker-source.js'
import { PNG } from 'pngjs'

const source = new PNG({ width: 64, height: 64 })
for (let i = 0; i < source.data.length; i += 4) source.data.set([0, 0, 0, 128], i)
const sourcePng = PNG.sync.write(source).toString('base64')

test.beforeEach(async ({ page }) => {
    await installNoisemakerSource(page, ['filter/adjust', 'filter/grade'])
    await page.goto('/', { waitUntil: 'networkidle' })
    await page.waitForFunction(() => !!window.LayersAgent)
    await page.evaluate(async () => { await window.LayersAgent.ready })
})

for (const [effectId, params, expectedColor] of [
    ['filter/adjust', { contrast: 0 }, 128],
    ['filter/grade', { contrast: -1 }, 188],
]) {
    test(`${effectId} preserves half coverage while exporting its underlying color`, async ({ page }) => {
        const result = await page.evaluate(async ({ effectId, params, sourcePng }) => {
            const app = window.layersApp
            const created = await window.LayersAgent.newProject({ width: 64, height: 64 })
            if (!created.ok) throw new Error(created.error?.message || 'Project creation failed')
            const added = await window.LayersAgent.addLayer({ kind: 'media', mediaType: 'image',
                source: { kind: 'base64', data: sourcePng, mimeType: 'image/png' } })
            if (!added.ok) throw new Error(added.error?.message || 'Import failed')
            const parent = app._layers.find(layer => layer.sourceType === 'media')
            const child = await app._handleAddChildEffect(parent.id, effectId, { params })
            if (child?.status !== 'committed') throw new Error(`Adjustment failed: ${JSON.stringify(child)}`)
            app._renderer.render(0)
            const gl = app._canvas.getContext('webgl2')
            gl.bindFramebuffer(gl.FRAMEBUFFER, null)
            const rgba = new Uint8Array(4)
            gl.readPixels(32, 32, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, rgba)
            const exported = await window.LayersAgent.exportImage({ format: 'png', captureOnly: true })
            if (!exported.ok) throw new Error(exported.error?.message || 'Export failed')
            return { rgba: [...rgba], png: exported.result.bytes }
        }, { effectId, params, sourcePng })
        expect(result.rgba[3]).toBe(128)
        for (const channel of result.rgba.slice(0, 3)) {
            expect(Math.abs(channel - Math.round(expectedColor * 128 / 255))).toBeLessThanOrEqual(1)
        }
        const png = PNG.sync.read(Buffer.from(result.png, 'base64'))
        expect([png.width, png.height]).toEqual([64, 64])
        const expected = [expectedColor, expectedColor, expectedColor, 128]
        const firstDifference = png.data.findIndex((value, index) => Math.abs(value - expected[index % 4]) > 1)
        expect(firstDifference, `Every exported RGBA byte must preserve adjusted color and coverage; first mismatch ${firstDifference}`).toBe(-1)
    })
}
