import { test, expect } from 'playwright/test'

// Regression guard: effect params declared with `define:` in the effect
// definition (e.g. filter/halftone `mode` and `pattern`) become compile-time
// GLSL `#define` constants baked into the shader at compile time — the engine
// skips them in applyStepParameterValues because they are not runtime uniforms.
// Changing such a param therefore requires a shader RECOMPILE, not a uniform
// update. Before the fix, _handleLayerChange only pushed uniforms + synced the
// DSL string without recompiling, so define-backed dropdowns did nothing.
//
// These drive the exact path the UI dropdown and the agent use (_handleLayerChange
// with property 'effectParams') and assert the rendered canvas actually changes,
// for both a top-level effect layer and a nested child effect.
//
// Animation is frozen at a fixed loop time (stop the run loop, render(0)) before
// every readback, so the ONLY variable between captures is the define param —
// a time-varying synth base cannot masquerade as "the change took effect".

// Freeze time, paint a fixed frame, and hash the full canvas — all in one
// evaluate so nothing repaints between freeze and readback. FNV-1a over the RGB
// channels is far more discriminating than a byte sum, so two visually distinct
// halftone screens cannot collide.
async function captureFrozenSignature(page) {
    return page.evaluate(() => {
        const app = window.layersApp
        if (app._renderer.isRunning) app._renderer.stop()
        app._renderer.render(0)

        const canvasEl = document.getElementById('canvas')
        const gl = canvasEl.getContext('webgl2') || canvasEl.getContext('webgl')
        if (!gl) return null
        gl.bindFramebuffer(gl.FRAMEBUFFER, null)
        const w = canvasEl.width, h = canvasEl.height
        const pixels = new Uint8Array(w * h * 4)
        gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, pixels)
        let hash = 2166136261 >>> 0
        let sum = 0
        for (let i = 0; i < pixels.length; i += 4) {
            for (let c = 0; c < 3; c++) {
                const v = pixels[i + c]
                sum += v
                hash ^= v
                hash = Math.imul(hash, 16777619) >>> 0
            }
        }
        return { hash: hash >>> 0, sum, w, h }
    })
}

async function loadWithSolidBase(page) {
    await page.goto('/', { waitUntil: 'networkidle' })
    await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })
    await page.waitForSelector('.open-dialog-backdrop.visible')
    await page.click('.media-option[data-type="solid"]')
    await page.waitForSelector('.canvas-size-dialog', { timeout: 5000 })
    await page.click('.canvas-size-dialog .action-btn.primary')
    await page.waitForSelector('.open-dialog-backdrop.visible', { state: 'hidden', timeout: 5000 })
    await page.waitForTimeout(1500)
}

// Drive an effect-params change through the exact same path the UI dropdown and
// the agent use. parentLayerId is set for child effects, omitted for top-level.
async function changeParams(page, { layerId, parentLayerId, params }) {
    await page.evaluate(async ({ layerId, parentLayerId, params }) => {
        const app = window.layersApp
        const parent = parentLayerId ? app._layers.find(l => l.id === parentLayerId) : null
        const layer = parent
            ? parent.children.find(c => c.id === layerId)
            : app._layers.find(l => l.id === layerId)
        const detail = {
            layerId,
            property: 'effectParams',
            value: { ...layer.effectParams, ...params },
            layer,
        }
        if (parentLayerId) detail.parentLayerId = parentLayerId
        await app._handleLayerChange(detail)
    }, { layerId, parentLayerId, params })
    await page.waitForTimeout(600)
}

test('top-level effect dropdowns (halftone mode/pattern) recompile and change render', async ({ page }) => {
    await loadWithSolidBase(page)

    // Halftone-over-noise: noise gives tonal/spatial content so the halftone
    // screen has structure to reproduce, and CMYK (mode 0) vs monochrome (mode 1)
    // produce clearly distinct output.
    const setup = await page.evaluate(async () => {
        const app = window.layersApp
        await app._handleAddEffectLayer('synth/noise')
        const added = await app._handleAddEffectLayer('filter/halftone', {
            params: { mode: 0, pattern: 0, frequency: 20 }
        })
        await app._rebuild({ force: true })
        const halftone = app._layers[app._layers.length - 1]
        return { layerId: halftone.id, effectId: halftone.effectId, status: added.status }
    })
    expect(setup.status).toBe('added')
    expect(setup.effectId).toBe('filter/halftone')
    await page.waitForTimeout(1000)

    // mode 0 = color (CMYK) screen
    const sigColor = await captureFrozenSignature(page)
    expect(sigColor).not.toBeNull()

    // Change the define-backed `mode` param 0 -> 1 (mono) via the UI path.
    await changeParams(page, { layerId: setup.layerId, params: { mode: 1, pattern: 0 } })
    const sigMonoDot = await captureFrozenSignature(page)

    // Change the define-backed `pattern` param 0 (dot) -> 1 (line) in mono mode.
    await changeParams(page, { layerId: setup.layerId, params: { mode: 1, pattern: 1 } })
    const sigMonoLine = await captureFrozenSignature(page)

    console.log('top-level halftone signatures:', JSON.stringify({ sigColor, sigMonoDot, sigMonoLine }))

    expect(sigMonoDot.hash,
        `mode 0->1 should change the render (define recompile). color=${sigColor.hash} mono=${sigMonoDot.hash}`
    ).not.toBe(sigColor.hash)

    expect(sigMonoLine.hash,
        `pattern 0->1 should change the render (define recompile). dot=${sigMonoDot.hash} line=${sigMonoLine.hash}`
    ).not.toBe(sigMonoDot.hash)
})

test('child effect dropdowns (nested halftone mode) recompile and change render', async ({ page }) => {
    await loadWithSolidBase(page)

    // Add a noise layer, then a halftone CHILD effect on it. Child effects are
    // nested under the parent's `children`, exercising the child-lookup branch of
    // the recompile check.
    const setup = await page.evaluate(async () => {
        const app = window.layersApp
        const noiseRes = await app._handleAddEffectLayer('synth/noise')
        const noiseId = noiseRes.layerId ?? app._layers[app._layers.length - 1].id
        const childRes = await app._handleAddChildEffect(noiseId, 'filter/halftone', {
            params: { mode: 0, pattern: 0, frequency: 20 }
        })
        await app._rebuild({ force: true })
        return { noiseId, childId: childRes.childId, status: childRes.status }
    })
    expect(setup.status).toBe('committed')
    expect(setup.childId).toBeTruthy()
    await page.waitForTimeout(1000)

    const sigColor = await captureFrozenSignature(page)
    expect(sigColor).not.toBeNull()

    // Change the child's define-backed `mode` param 0 -> 1 via the child path.
    await changeParams(page, {
        layerId: setup.childId,
        parentLayerId: setup.noiseId,
        params: { mode: 1, pattern: 0 },
    })
    const sigMono = await captureFrozenSignature(page)

    console.log('child halftone signatures:', JSON.stringify({ sigColor, sigMono }))

    expect(sigMono.hash,
        `child mode 0->1 should change the render (define recompile). color=${sigColor.hash} mono=${sigMono.hash}`
    ).not.toBe(sigColor.hash)
})

test('undo/redo of a define-param change reverts and reapplies the render', async ({ page }) => {
    await loadWithSolidBase(page)

    const setup = await page.evaluate(async () => {
        const app = window.layersApp
        await app._handleAddEffectLayer('synth/noise')
        const added = await app._handleAddEffectLayer('filter/halftone', {
            params: { mode: 0, pattern: 0, frequency: 20 }
        })
        await app._rebuild({ force: true })
        const halftone = app._layers[app._layers.length - 1]
        return { layerId: halftone.id, status: added.status }
    })
    expect(setup.status).toBe('added')
    await page.waitForTimeout(1000)

    const sigColor = await captureFrozenSignature(page)

    // Single define change: mode 0 -> 1.
    await changeParams(page, { layerId: setup.layerId, params: { mode: 1, pattern: 0 } })
    const sigMono = await captureFrozenSignature(page)
    expect(sigMono.hash, 'sanity: mode change should alter the render').not.toBe(sigColor.hash)

    // The param change pushes a *debounced* undo entry; finalize it so the undo
    // stack is deterministic, then undo — the render must revert to mode 0.
    await page.evaluate(async () => {
        window.layersApp._finalizePendingUndo()
        await window.layersApp._undo()
    })
    await page.waitForTimeout(600)
    const sigUndone = await captureFrozenSignature(page)
    expect(sigUndone.hash,
        `undo should revert the define (recompile). color=${sigColor.hash} undone=${sigUndone.hash}`
    ).toBe(sigColor.hash)

    // Redo — the render must return to mode 1.
    await page.evaluate(async () => { await window.layersApp._redo() })
    await page.waitForTimeout(600)
    const sigRedone = await captureFrozenSignature(page)
    expect(sigRedone.hash,
        `redo should reapply the define (recompile). mono=${sigMono.hash} redone=${sigRedone.hash}`
    ).toBe(sigMono.hash)
})
