import { test, expect } from './fixtures.js'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { PNG } from 'pngjs'

const source = new PNG({ width: 64, height: 64 })
for (let i = 0; i < source.data.length; i += 4) source.data.set([128, 64, 32, 128], i)
const sourcePng = PNG.sync.write(source).toString('base64')

// Release CI tests the exact pinned CDN artifact. A local source override can
// certify a pending Noisemaker shader fix without building/publishing it.
test.beforeEach(async ({ page }) => {
    if (!process.env.LAYERS_NOISEMAKER_SOURCE) return
    for (const [effect, program] of [['mixer/blendMode', 'blendMode'], ['synth/media', 'mediaInput']]) {
        const root = path.join(process.env.LAYERS_NOISEMAKER_SOURCE, 'shaders/effects', effect)
        const shaders = {
            glsl: await readFile(path.join(root, `glsl/${program}.glsl`), 'utf8'),
            wgsl: await readFile(path.join(root, `wgsl/${program}.wgsl`), 'utf8'),
        }
        await page.route(`https://shaders.noisedeck.app/*/effects/${effect}.js`, async route => {
            const response = await route.fetch()
            const source = await response.text()
            const name = source.match(/export\s*\{\s*([\w$]+)\s+as\s+default\b/)?.[1]
            if (!name) throw new Error('Cannot locate bundled effect export for source verification')
            await route.fulfill({ response, body: `${source}\n${name}.shaders.${program} = ${JSON.stringify(shaders)};` })
        })
    }
})

for (const opacity of [100, 50]) {
    test(`PNG preserves fractional RGB at source alpha 50% and layer opacity ${opacity}%`, async ({ page }, testInfo) => {
        await page.goto('/', { waitUntil: 'networkidle' })
        await page.waitForFunction(() => !!window.LayersAgent, null, { timeout: 15000 })
        await page.evaluate(async () => { await window.LayersAgent.ready })
        const bytes = await page.evaluate(async ({ layerOpacity, sourcePng }) => {
            const app = window.layersApp
            await window.LayersAgent.newProject({ width: 64, height: 64 })
            const added = await window.LayersAgent.addLayer({ kind: 'media', mediaType: 'image',
                source: { kind: 'base64', data: sourcePng, mimeType: 'image/png' } })
            if (!added.ok) throw new Error(added.error?.message || 'Import failed')
            app._layers[0].opacity = layerOpacity
            await app._rebuild({ force: true })
            const exported = await window.LayersAgent.exportImage({ format: 'png', captureOnly: true })
            if (!exported.ok) throw new Error(exported.error?.message || 'Export failed')
            return exported.result.bytes
        }, { layerOpacity: opacity, sourcePng })
        // Inspect the exported artifact directly. Drawing a translucent PNG
        // through Canvas 2D introduces browser-specific alpha rounding.
        const exported = PNG.sync.read(Buffer.from(bytes, 'base64'))
        expect([exported.width, exported.height]).toEqual([64, 64])
        const expected = Buffer.alloc(64 * 64 * 4)
        for (let i = 0; i < expected.length; i += 4) expected.set([128, 64, 32, opacity === 100 ? 128 : 64], i)
        const firstDifference = exported.data.findIndex((value, index) => value !== expected[index])
        if (firstDifference !== -1) {
            await testInfo.attach('exported-alpha.png', { body: Buffer.from(bytes, 'base64'), contentType: 'image/png' })
        }
        expect(firstDifference, `every exported RGBA byte must match; first difference at ${firstDifference}: expected ${expected[firstDifference]}, received ${exported.data[firstDifference]}`).toBe(-1)
    })
}
