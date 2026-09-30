import { test, expect } from './fixtures.js'
import { defaultProjectReady } from './waits.js'
import { SEANCE_SDK_URL, hasLocalSeanceHarness, localSdkSupportsImages, routeSeanceSdkLocal, startSeanceServer } from './seanceLocal.js'

let seance
test.skip(!hasLocalSeanceHarness(), 'requires a local Seance checkout and Python')
// Reopen when the CI harness pin advances to seance aaec82b or later: the
// image feature needs an SDK with prepareImage, which the pinned pre-image
// harness lacks.
test.skip(!localSdkSupportsImages(),
    'requires a Seance SDK with prepareImage (harness pin >= seance aaec82b)')
test.beforeEach(async ({ baseURL }, testInfo) => {
    // The creator-leave leg runs a 6000x4000 import, full-resolution render,
    // project save and reload in one evaluate. Measured 246s serial under
    // software rendering (chromium, workers=1, image-capable harness) — the
    // old 180s budget killed the test before it finished and its two CI
    // retries pushed whole shards over the 20-minute globalTimeout.
    testInfo.setTimeout(480000)
    seance = await startSeanceServer({ origin: baseURL })
})
test.afterEach(async () => { await seance?.stop() })

async function open(page, sessionId = null) {
    await routeSeanceSdkLocal(page)
    await page.addInitScript(() => {
        window.hashImageBytes = async bytes => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
            .map(value => value.toString(16).padStart(2, '0')).join('')
    })
    const params = new URLSearchParams({ seanceUrl: seance.url, seanceSdk: SEANCE_SDK_URL })
    if (sessionId) params.set('seance', sessionId)
    await page.goto(`/?${params}`, { waitUntil: 'networkidle' })
    await defaultProjectReady(page)
    if (sessionId) await expect.poll(() => page.evaluate(() => window.layersApp._onlineAdapter.isOnline())).toBe(true)
}

test('a new viewer retains native image bytes and export detail after the creator leaves, then saves offline', async ({ page, context }) => {
    await open(page)
    const original = await page.evaluate(async () => {
        const app = window.layersApp
        const source = document.createElement('canvas')
        source.width = 6000; source.height = 4000
        const ctx = source.getContext('2d')
        ctx.fillStyle = 'white'; ctx.fillRect(0, 0, 6000, 4000)
        ctx.fillStyle = 'black'; ctx.fillRect(3000, 0, 1, 4000)
        const blob = await new Promise(resolve => source.toBlob(resolve, 'image/png'))
        const file = new File([blob], 'original.png', { type: 'image/png' })
        await app._handleOpenMedia(file, 'image')
        const sessionId = await app._onlineAdapter.takeOnline()
        return { sessionId, hash: await window.hashImageBytes(await file.arrayBuffer()),
            nodeChars: JSON.stringify(app._onlineAdapter.online.getNodes()).length }
    })
    expect(original.sessionId).toBeTruthy()
    expect(original.nodeChars).toBeLessThan(65536)
    // WebKit runs in a persistent context (fixtures.js), and closing its last
    // page tears down the web context: the next newPage aborts MiniBrowser. So
    // the viewer's blank page exists first, and joins only after the creator
    // has left.
    const viewer = await context.newPage()
    await page.close()
    await open(viewer, original.sessionId)
    const restored = await viewer.evaluate(async () => {
        const app = window.layersApp
        const layer = app._layers[0]
        const media = app._renderer.getMediaInfo(layer.id)
        const hash = await window.hashImageBytes(await layer.mediaFile.arrayBuffer())
        const output = await app._renderer.renderFullResolution({ normalizedTime: 0 })
        const pixels = [...output.getContext('2d').getImageData(2999, 2000, 3, 1).data]
        const { saveProject } = await import('/js/utils/project-storage.js')
        const project = await app._capturePersistableProject()
        const projectId = await saveProject({ ...project, name: 'Shared original' })
        app._onlineAdapter.goOffline()
        const reopened = await app._loadProject(projectId)
        return { hash, pixels, reopened,
            reopenedHash: await window.hashImageBytes(await app._layers[0].mediaFile.arrayBuffer()),
            width: media.width, height: media.height,
            previewWidth: media.element.width, previewHeight: media.element.height,
            canvas: [app._canvas.width, app._canvas.height] }
    })
    expect(restored.hash).toBe(original.hash)
    expect(restored.reopenedHash).toBe(original.hash)
    expect(restored.reopened).toBe('opened')
    expect(restored.canvas).toEqual([6000, 4000])
    expect([restored.width, restored.height]).toEqual([6000, 4000])
    expect(restored.previewWidth).toBeLessThanOrEqual(1920)
    expect(restored.previewHeight).toBeLessThanOrEqual(1080)
    expect(restored.pixels).toEqual([255,255,255,255, 0,0,0,255, 255,255,255,255])
})

test('online image addition, source replacement, effects, and transforms converge with original bytes', async ({ page, context }) => {
    await open(page)
    const sessionId = await page.evaluate(() => window.layersApp._onlineAdapter.takeOnline())
    const viewer = await context.newPage()
    await open(viewer, sessionId)
    const added = await page.evaluate(async () => {
        const source = document.createElement('canvas')
        source.width = 512; source.height = 512
        const ctx = source.getContext('2d'), pixels = ctx.createImageData(512, 512)
        let value = 11
        for (let i = 0; i < pixels.data.length; i += 4) {
            value = (Math.imul(value, 1664525) + 1013904223) >>> 0
            pixels.data[i] = value & 255; pixels.data[i + 1] = (value >>> 8) & 255
            pixels.data[i + 2] = (value >>> 16) & 255; pixels.data[i + 3] = 192
        }
        ctx.putImageData(pixels, 0, 0)
        const file = new File([await new Promise(resolve => source.toBlob(resolve, 'image/png'))], 'noise.png', { type: 'image/png' })
        const outcome = await window.layersApp._handleAddMediaLayer(file, 'image')
        const child = await window.LayersAgent.addChildEffect({ layerId: outcome.layerId, effectId: 'filter/blur' })
        const transform = await window.LayersAgent.setLayerTransform({ layerId: outcome.layerId,
            transform: { offsetX: 17, offsetY: -9, scaleX: 0.5, scaleY: 0.5, rotation: 17, flipH: true } })
        return { id: outcome.layerId, size: file.size, hash: await window.hashImageBytes(await file.arrayBuffer()),
            child: child.ok, transform: transform.ok }
    })
    expect(added.size).toBeGreaterThan(65536)
    expect(added.child).toBe(true)
    expect(added.transform).toBe(true)
    await expect.poll(() => viewer.evaluate(id => {
        const layer = window.layersApp._layers.find(layer => layer.id === id)
        return { imageId: layer?.imageId, rotation: layer?.rotation, children: layer?.children.length }
    }, added.id), { timeout: 60000 }).toEqual({ imageId: added.hash, rotation: 17, children: 1 })
    const read = async target => target.evaluate(async id => {
        const app = window.layersApp, layer = app._layers.find(layer => layer.id === id)
        const { readRenderPixels } = await import('/js/utils/canvas-readback.js')
        app._renderer.render(0)
        const pixels = readRenderPixels(app._canvas, 0, 0, app._canvas.width, app._canvas.height)
        return { source: await window.hashImageBytes(await layer.mediaFile.arrayBuffer()),
            pixels: await window.hashImageBytes(pixels),
            width: layer.imageWidth, height: layer.imageHeight }
    }, added.id)
    expect(await read(viewer)).toEqual(await read(page))
    const resized = await page.evaluate(async () => {
        const result = await window.LayersAgent.resizeImage({ width: 256, height: 256 })
        return { ok: result.ok, error: result.error }
    })
    expect(resized.ok, JSON.stringify(resized.error)).toBe(true)
    await expect.poll(() => viewer.evaluate(id => window.layersApp._layers.find(layer => layer.id === id)?.imageId, added.id),
        { timeout: 60000 }).not.toBe(added.hash)
    expect(await read(viewer)).toEqual(await read(page))
})
