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

    // Regression: featherMask must ramp 255 (deep inside) -> ~50% at the
    // marquee boundary -> 0 (radius outside), monotonically. It used to ramp
    // to ~0 approaching the boundary from inside and restart at ~255 just
    // outside — a sawtooth that rendered a hard edge with the effect's
    // strongest band OUTSIDE the user's selection.
    test('feathered selection applies the effect proportionally across the band', async ({ page }) => {
        const { height } = await bootSolidProject(page)
        const midY = Math.floor(height / 2)

        const maskLine = await page.evaluate(async ([y]) => {
            const app = window.layersApp
            const sm = app._selectionManager
            sm.setSelection({
                type: 'polygon',
                points: [
                    { x: 100, y: y - 200 }, { x: 400, y: y - 200 },
                    { x: 400, y: y + 200 }, { x: 100, y: y + 200 },
                ],
            })
            const { featherMask } = await import('/js/selection/selection-modify.js')
            sm.setSelection({ type: 'mask', data: featherMask(sm.rasterizeSelection(), 30) })

            await app._handleAddEffectLayer('filter/invert', { name: 'invert' })
            const layer = app._layers[app._layers.length - 1]
            if (!layer.mask) return null
            const values = []
            for (let x = 360; x <= 440; x += 5) {
                values.push(layer.mask.data[(y * layer.mask.width + x) * 4])
            }
            return values
        }, [midY])

        expect(maskLine, 'no mask captured from feathered selection').not.toBeNull()

        // Deep inside fully selected, radius-outside fully unselected
        expect(maskLine[0]).toBe(255)
        expect(maskLine[maskLine.length - 1]).toBe(0)

        // Monotone non-increasing across the band — no sawtooth
        for (let i = 1; i < maskLine.length; i++) {
            expect(maskLine[i] <= maskLine[i - 1] + 2,
                `mask values not monotone at sample ${i}: ${maskLine.join(', ')}`).toBe(true)
        }

        // ~50% at the marquee boundary (x=400 is sample index 8)
        const boundary = maskLine[8]
        expect(Math.abs(boundary - 128) <= 24,
            `boundary value ${boundary} not near 50% — band misplaced: ${maskLine.join(', ')}`).toBe(true)

        // The rendered composite must track the ramp: sample the midpoint of
        // the outside half of the band; it must sit between the extremes,
        // not at either (which is what a hard edge produces).
        await expect.poll(async () => (await samplePixel(page, 360, midY))[0], {
            timeout: 20000,
            message: 'deep-inside pixel never rendered the inverted value',
        }).toBeGreaterThan(170)
        const rendered = await page.evaluate(([y]) => {
            const canvas = document.getElementById('canvas')
            const gl = canvas.getContext('webgl2')
            gl.bindFramebuffer(gl.FRAMEBUFFER, null)
            const read = (x) => {
                const p = new Uint8Array(4)
                gl.readPixels(x, canvas.height - 1 - y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, p)
                return p[0]
            }
            return { deep: read(360), mid: read(415), out: read(440) }
        }, [midY])

        const lo = Math.min(rendered.deep, rendered.out)
        const hi = Math.max(rendered.deep, rendered.out)
        expect(rendered.mid > lo + 15 && rendered.mid < hi - 15,
            `mid-band pixel ${rendered.mid} not between extremes ${lo}..${hi} — hard edge`).toBe(true)
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

    // Pins the R-channel convention the capture relies on: wand masks carry
    // their value in RGB (and A), and the capture reads R.
    test('wand selection is captured with its value channel intact', async ({ page }) => {
        const { width, height } = await bootSolidProject(page)

        const result = await page.evaluate(async () => {
            const app = window.layersApp
            const w = app._canvas.width
            const h = app._canvas.height
            const wandMask = new ImageData(w, h)
            for (let y = 0; y < h; y++) {
                for (let x = 0; x < w; x++) {
                    const i = (y * w + x) * 4
                    const v = x < w / 2 ? 255 : 0
                    wandMask.data[i] = v
                    wandMask.data[i + 1] = v
                    wandMask.data[i + 2] = v
                    wandMask.data[i + 3] = v
                }
            }
            app._selectionManager.setSelection({ type: 'wand', mask: wandMask })
            await app._handleAddEffectLayer('filter/invert', { name: 'invert' })
            const layer = app._layers[app._layers.length - 1]
            if (!layer.mask) return null
            const mid = Math.floor(layer.mask.height / 2)
            const at = x => layer.mask.data[(mid * layer.mask.width + x) * 4]
            return {
                insideValue: at(Math.floor(w / 4)),
                outsideValue: at(Math.floor(w * 3 / 4)),
                width: layer.mask.width,
                height: layer.mask.height,
            }
        })

        expect(result, 'no mask captured from wand selection').not.toBeNull()
        expect(result.width).toBe(width)
        expect(result.height).toBe(height)
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
