import { test, expect } from 'playwright/test'

// Effects must never alter pixels outside the active selection marquee or
// outside the target layer's mask. Applying an effect while a marquee
// selection is active captures the selection as the effect's mask; applying
// one while the target layer has an enabled layer mask confines the effect
// to that mask.

/** Read one RGBA pixel at top-down coords from the live WebGL canvas. */
function samplePixel(page, x, yTop) {
    return page.evaluate(([px, py]) => {
        const canvas = document.getElementById('canvas')
        const gl = canvas.getContext('webgl2') || canvas.getContext('webgl')
        gl.bindFramebuffer(gl.FRAMEBUFFER, null)
        const out = new Uint8Array(4)
        gl.readPixels(px, canvas.height - 1 - py, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, out)
        return Array.from(out)
    }, [x, yTop])
}

function channelsClose(a, b, tolerance = 3) {
    return a.every((v, i) => Math.abs(v - b[i]) <= tolerance)
}

async function waitForPixelChange(page, x, yTop, before, timeout = 20000) {
    await expect.poll(async () => {
        const now = await samplePixel(page, x, yTop)
        return channelsClose(now, before)
    }, { timeout, message: `pixel at (${x}, ${yTop}) never changed from ${before}` }).toBe(false)
}

async function bootSolidProject(page) {
    await page.goto('/', { waitUntil: 'networkidle' })
    await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })
    await page.waitForSelector('.open-dialog-backdrop.visible')
    await page.click('.media-option[data-type="solid"]')
    await page.waitForSelector('.canvas-size-dialog', { timeout: 5000 })
    await page.click('.canvas-size-dialog .action-btn.primary')
    await page.waitForSelector('.open-dialog-backdrop.visible', { state: 'hidden', timeout: 5000 })
    await page.waitForTimeout(1500)

    // Deterministic opaque dark-gray base
    await page.evaluate(async () => {
        const app = window.layersApp
        app._layers[0].effectParams = { color: [0.25, 0.25, 0.25], alpha: 1 }
        await app._rebuild()
    })
    await page.waitForTimeout(800)

    return page.evaluate(() => {
        const canvas = document.getElementById('canvas')
        return { width: canvas.width, height: canvas.height }
    })
}

/** Add an opaque light-gray solid layer above the base and return its id. */
async function addLightSolidLayer(page) {
    const layerId = await page.evaluate(async () => {
        const app = window.layersApp
        await app._handleAddEffectLayer('synth/solid')
        const layer = app._layers[app._layers.length - 1]
        layer.effectParams = { color: [0.75, 0.75, 0.75], alpha: 1 }
        await app._rebuild()
        return layer.id
    })
    await page.waitForTimeout(800)
    return layerId
}

/** Give a layer a mask that is white on the left half, black on the right. */
async function setLeftHalfMask(page, layerId) {
    await page.evaluate(async ([id]) => {
        const app = window.layersApp
        const layer = app._layers.find(l => l.id === id)
        const w = app._canvas.width
        const h = app._canvas.height
        const mask = new ImageData(w, h)
        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
                const i = (y * w + x) * 4
                const v = x < w / 2 ? 255 : 0
                mask.data[i] = v
                mask.data[i + 1] = v
                mask.data[i + 2] = v
                mask.data[i + 3] = 255
            }
        }
        layer.mask = mask
        layer.maskEnabled = true
        app._renderer.uploadMaskTexture(id, mask)
        await app._rebuild()
    }, [layerId])
    await page.waitForTimeout(800)
}

async function bootSolidProjectSized(page, width, height) {
    await page.goto('/', { waitUntil: 'networkidle' })
    await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })
    await page.waitForSelector('.open-dialog-backdrop.visible')
    await page.click('.media-option[data-type="solid"]')
    await page.waitForSelector('.canvas-size-dialog', { timeout: 5000 })
    await page.fill('#canvas-width', String(width))
    await page.fill('#canvas-height', String(height))
    await page.click('.canvas-size-dialog .action-btn.primary')
    await page.waitForSelector('.open-dialog-backdrop.visible', { state: 'hidden', timeout: 5000 })
    await page.waitForTimeout(1500)

    await page.evaluate(async () => {
        const app = window.layersApp
        app._layers[0].effectParams = { color: [0.25, 0.25, 0.25], alpha: 1 }
        await app._rebuild()
    })
    await page.waitForTimeout(800)
}

test.describe('Effects respect selection marquee and layer mask', () => {
    // Regression: on a non-square canvas the mask media() step must render
    // the mask texture 1:1 with the frame. Without its imageSize uniform the
    // shader assumes 1024x1024 content and draws the captured selection
    // squished and displaced — the effect lands outside the user's marquee.
    test('non-square canvas: polygon selection stays pixel-aligned (effect layer)', async ({ page }) => {
        await bootSolidProjectSized(page, 1920, 1080)

        // Polygon covering x in [100, 700], y in [300, 800]
        await page.evaluate(() => {
            window.layersApp._selectionManager.setSelection({
                type: 'polygon',
                points: [
                    { x: 100, y: 300 }, { x: 700, y: 300 },
                    { x: 700, y: 800 }, { x: 100, y: 800 },
                ],
            })
        })

        const inX = 400, inY = 550     // center of the polygon
        const outX = 900, outY = 550   // right of the polygon
        const beforeIn = await samplePixel(page, inX, inY)
        const beforeOut = await samplePixel(page, outX, outY)

        await page.evaluate(async () => {
            await window.layersApp._handleAddEffectLayer('filter/invert', { name: 'invert' })
        })

        await waitForPixelChange(page, inX, inY, beforeIn)
        const afterOut = await samplePixel(page, outX, outY)
        expect(channelsClose(afterOut, beforeOut),
            `outside-polygon pixel changed: ${beforeOut} -> ${afterOut}`).toBe(true)
    })

    test('non-square canvas: polygon selection stays pixel-aligned (child effect)', async ({ page }) => {
        await bootSolidProjectSized(page, 1920, 1080)

        await page.evaluate(() => {
            window.layersApp._selectionManager.setSelection({
                type: 'polygon',
                points: [
                    { x: 100, y: 300 }, { x: 700, y: 300 },
                    { x: 700, y: 800 }, { x: 100, y: 800 },
                ],
            })
        })

        const inX = 400, inY = 550
        const outX = 900, outY = 550
        const beforeIn = await samplePixel(page, inX, inY)
        const beforeOut = await samplePixel(page, outX, outY)

        await page.evaluate(async () => {
            const app = window.layersApp
            await app._handleAddChildEffect(app._layers[0].id, 'filter/invert')
        })

        await waitForPixelChange(page, inX, inY, beforeIn)
        const afterOut = await samplePixel(page, outX, outY)
        expect(channelsClose(afterOut, beforeOut),
            `outside-polygon pixel changed: ${beforeOut} -> ${afterOut}`).toBe(true)
    })

    test('effect layer only alters pixels inside the marquee selection', async ({ page }) => {
        const { width, height } = await bootSolidProject(page)
        const inX = Math.floor(width / 4)
        const outX = Math.floor(width * 3 / 4)
        const midY = Math.floor(height / 2)

        // Select the left half of the canvas
        await page.evaluate(([w, h]) => {
            window.layersApp._selectionManager.setSelection(
                { type: 'rect', x: 0, y: 0, width: w / 2, height: h })
        }, [width, height])

        const beforeIn = await samplePixel(page, inX, midY)
        const beforeOut = await samplePixel(page, outX, midY)

        await page.evaluate(async () => {
            await window.layersApp._handleAddEffectLayer('filter/invert', { name: 'invert' })
        })

        await waitForPixelChange(page, inX, midY, beforeIn)
        const afterOut = await samplePixel(page, outX, midY)
        expect(channelsClose(afterOut, beforeOut),
            `outside-selection pixel changed: ${beforeOut} -> ${afterOut}`).toBe(true)
    })

    test('effect layer only alters pixels inside the target layer mask', async ({ page }) => {
        const { width, height } = await bootSolidProject(page)
        const inX = Math.floor(width / 4)
        const outX = Math.floor(width * 3 / 4)
        const midY = Math.floor(height / 2)

        // Light solid layer, masked to the left half, sits over the dark base.
        const layerId = await addLightSolidLayer(page)
        await setLeftHalfMask(page, layerId)

        // The masked layer is the selected target when the filter is applied.
        await page.evaluate(([id]) => {
            window.layersApp._layerStack.selectedLayerIds = [id]
        }, [layerId])

        const beforeIn = await samplePixel(page, inX, midY)   // light (masked layer)
        const beforeOut = await samplePixel(page, outX, midY) // dark (base through mask)

        await page.evaluate(async () => {
            await window.layersApp._handleAddEffectLayer('filter/invert', { name: 'invert' })
        })

        await waitForPixelChange(page, inX, midY, beforeIn)
        const afterOut = await samplePixel(page, outX, midY)
        expect(channelsClose(afterOut, beforeOut),
            `outside-mask pixel changed: ${beforeOut} -> ${afterOut}`).toBe(true)
    })

    test('child effect only alters pixels inside the marquee selection', async ({ page }) => {
        const { width, height } = await bootSolidProject(page)
        const inX = Math.floor(width / 4)
        const outX = Math.floor(width * 3 / 4)
        const midY = Math.floor(height / 2)

        await page.evaluate(([w, h]) => {
            window.layersApp._selectionManager.setSelection(
                { type: 'rect', x: 0, y: 0, width: w / 2, height: h })
        }, [width, height])

        const beforeIn = await samplePixel(page, inX, midY)
        const beforeOut = await samplePixel(page, outX, midY)

        await page.evaluate(async () => {
            const app = window.layersApp
            await app._handleAddChildEffect(app._layers[0].id, 'filter/invert')
        })

        await waitForPixelChange(page, inX, midY, beforeIn)
        const afterOut = await samplePixel(page, outX, midY)
        expect(channelsClose(afterOut, beforeOut),
            `outside-selection pixel changed: ${beforeOut} -> ${afterOut}`).toBe(true)
    })

    test('child effect stays confined by the parent layer mask', async ({ page }) => {
        const { width, height } = await bootSolidProject(page)
        const inX = Math.floor(width / 4)
        const outX = Math.floor(width * 3 / 4)
        const midY = Math.floor(height / 2)

        const layerId = await addLightSolidLayer(page)
        await setLeftHalfMask(page, layerId)

        const beforeIn = await samplePixel(page, inX, midY)
        const beforeOut = await samplePixel(page, outX, midY)

        await page.evaluate(async ([id]) => {
            await window.layersApp._handleAddChildEffect(id, 'filter/invert')
        }, [layerId])

        await waitForPixelChange(page, inX, midY, beforeIn)
        const afterOut = await samplePixel(page, outX, midY)
        expect(channelsClose(afterOut, beforeOut),
            `outside-mask pixel changed: ${beforeOut} -> ${afterOut}`).toBe(true)
    })

    test('selection is captured as a mask on the new effect layer', async ({ page }) => {
        const { width, height } = await bootSolidProject(page)

        await page.evaluate(([w, h]) => {
            window.layersApp._selectionManager.setSelection(
                { type: 'rect', x: 0, y: 0, width: w / 2, height: h })
        }, [width, height])

        const result = await page.evaluate(async () => {
            const app = window.layersApp
            await app._handleAddEffectLayer('filter/invert', { name: 'invert' })
            const layer = app._layers[app._layers.length - 1]
            if (!layer.mask) return { hasMask: false }
            const w = layer.mask.width
            const mid = Math.floor(layer.mask.height / 2)
            const at = x => layer.mask.data[(mid * w + x) * 4]
            return {
                hasMask: true,
                maskEnabled: layer.maskEnabled,
                insideValue: at(Math.floor(w / 4)),
                outsideValue: at(Math.floor(w * 3 / 4)),
            }
        })

        expect(result.hasMask).toBe(true)
        expect(result.maskEnabled).toBe(true)
        expect(result.insideValue).toBe(255)
        expect(result.outsideValue).toBe(0)
    })

    test('text layers ignore the marquee selection (no captured mask)', async ({ page }) => {
        const { width, height } = await bootSolidProject(page)

        await page.evaluate(([w, h]) => {
            window.layersApp._selectionManager.setSelection(
                { type: 'rect', x: 0, y: 0, width: w / 2, height: h })
        }, [width, height])

        const hasMask = await page.evaluate(async () => {
            const app = window.layersApp
            await app._handleAddEffectLayer('filter/text', { name: 'text' })
            return app._layers[app._layers.length - 1].mask !== null
        })
        expect(hasMask).toBe(false)
    })

    test('child effect mask survives serialize/decode roundtrip', async ({ page }) => {
        const { width, height } = await bootSolidProject(page)

        await page.evaluate(([w, h]) => {
            window.layersApp._selectionManager.setSelection(
                { type: 'rect', x: 0, y: 0, width: w / 2, height: h })
        }, [width, height])

        const result = await page.evaluate(async () => {
            const app = window.layersApp
            await app._handleAddChildEffect(app._layers[0].id, 'filter/invert')
            const child = app._layers[0].children[0]
            if (!child.mask) return { hasMask: false }

            const { serializeLayers, deserializeLayers, decodeMasks } =
                await import('/js/layers/layer-model.js')
            const json = serializeLayers(app._layers)
            const restored = deserializeLayers(json)
            await decodeMasks(restored, {
                expectedWidth: app._canvas.width,
                expectedHeight: app._canvas.height,
            })
            const restoredChild = restored[0].children[0]
            const mask = restoredChild.mask
            if (!mask || typeof mask === 'string') return { hasMask: true, decoded: false }
            const mid = Math.floor(mask.height / 2)
            const at = x => mask.data[(mid * mask.width + x) * 4]
            return {
                hasMask: true,
                decoded: true,
                width: mask.width,
                height: mask.height,
                insideValue: at(Math.floor(mask.width / 4)),
                outsideValue: at(Math.floor(mask.width * 3 / 4)),
            }
        })

        expect(result.hasMask, 'child effect captured no mask from selection').toBe(true)
        expect(result.decoded, 'child mask did not decode back to ImageData').toBe(true)
        expect(result.width).toBe(width)
        expect(result.height).toBe(height)
        expect(result.insideValue).toBe(255)
        expect(result.outsideValue).toBe(0)
    })
})
