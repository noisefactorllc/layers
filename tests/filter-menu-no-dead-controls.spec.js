import { test, expect } from 'playwright/test'

// No dead controls: every entry in the Filter menu must add a layer that
// VISIBLY changes the rendered canvas. A menu item that compiles but renders
// identically to the composite below it (e.g. an effect whose spec defaults
// are a no-op, like glitchiness: 0) is a dead control and fails here.
//
// DOM-driven: iterates the actual #filterMenu [data-effect] entries, honoring
// each item's optional data-params (the same JSON the click handler applies),
// so any future menu addition is automatically covered by this guard.
//
// Methodology (mirrors tests/effect-param-define-recompile.spec.js):
//  - noise base layer gives tonal/spatial content for filters to act on
//  - the run loop is stopped and frames are rendered at a fixed loop time, so
//    the ONLY variable between captures is the added effect (a time-varying
//    synth can't masquerade as "the effect did something")
//  - five renders at the frozen time give feedback/simulation effects
//    (convolutionFeedback, reverb, video feedback) frames to accumulate;
//    pure effects are idempotent across repeated renders
//  - t=0.37 rather than 0 because some time-seeded overlays are degenerate
//    at exactly t=0

const FROZEN_TIME = 0.37

test('every filter menu entry visibly changes the render', async ({ page }) => {
    test.setTimeout(600000)

    const consoleErrors = []
    page.on('console', msg => {
        if (msg.type() === 'error') consoleErrors.push(msg.text())
    })

    await page.goto('/', { waitUntil: 'networkidle' })
    await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })
    await page.waitForSelector('.open-dialog-backdrop.visible')
    await page.click('.media-option[data-type="solid"]')
    await page.waitForSelector('.canvas-size-dialog', { timeout: 5000 })
    await page.click('.canvas-size-dialog .action-btn.primary')
    await page.waitForSelector('.open-dialog-backdrop.visible', { state: 'hidden', timeout: 5000 })
    await page.waitForTimeout(1500)

    await page.evaluate(async () => {
        const app = window.layersApp
        await app._handleAddEffectLayer('synth/noise')
        await app._rebuild({ force: true })
    })
    await page.waitForTimeout(800)

    // Collect the menu's entries exactly as the click handler sees them.
    const entries = await page.evaluate(() =>
        [...document.querySelectorAll('#filterMenu .submenu [data-effect]')].map(item => ({
            effectId: item.dataset.effect,
            label: item.textContent.trim(),
            params: item.dataset.params ? JSON.parse(item.dataset.params) : null,
        }))
    )
    expect(entries.length).toBeGreaterThan(60)

    const capture = () => page.evaluate((time) => {
        const app = window.layersApp
        if (app._renderer.isRunning) app._renderer.stop()
        for (let i = 0; i < 5; i++) app._renderer.render(time)
        const canvasEl = document.getElementById('canvas')
        const gl = canvasEl.getContext('webgl2')
        gl.bindFramebuffer(gl.FRAMEBUFFER, null)
        const w = canvasEl.width, h = canvasEl.height
        const pixels = new Uint8Array(w * h * 4)
        gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, pixels)
        let hash = 2166136261 >>> 0
        for (let i = 0; i < pixels.length; i += 4) {
            for (let c = 0; c < 3; c++) {
                hash ^= pixels[i + c]
                hash = Math.imul(hash, 16777619) >>> 0
            }
        }
        return hash >>> 0
    }, FROZEN_TIME)

    const baseline = await capture()
    // Boot/baseline console noise (e.g. unrelated resource 404s) is not this
    // spec's concern; from here on every console error is attributable to a
    // menu entry's add/render/delete cycle and fails the test.
    consoleErrors.length = 0
    const dead = []
    const failed = []

    for (const entry of entries) {
        const errBefore = consoleErrors.length
        const outcome = await page.evaluate(async ({ effectId, params }) => {
            const app = window.layersApp
            try {
                const res = await app._handleAddEffectLayer(
                    effectId, params ? { params } : {})
                return res?.status === 'added'
                    ? { added: true, layerId: res.layerId }
                    : { added: false, error: res?.error?.message || res?.status || 'not added' }
            } catch (err) {
                return { added: false, error: err.message }
            }
        }, entry)

        if (!outcome.added) {
            failed.push(`${entry.label} (${entry.effectId}): ${outcome.error}`)
            continue
        }

        // Async-overlay effects (fibers/scratches/strayHair) render their
        // texture via CPU tracing that lands a beat after the layer compiles
        // (~600ms observed), so an unchanged first capture gets bounded
        // retries before the entry is declared dead. Alive entries exit on
        // the first differing capture, so only genuinely dead controls pay
        // the full retry cost.
        await page.waitForTimeout(200)
        let changed = false
        for (let attempt = 0; attempt < 8; attempt++) {
            if ((await capture()) !== baseline) { changed = true; break }
            await page.waitForTimeout(500)
        }
        if (!changed) {
            dead.push(`${entry.label} (${entry.effectId})`)
        }
        const errs = consoleErrors.slice(errBefore)
        if (errs.length > 0) {
            failed.push(`${entry.label} (${entry.effectId}): console: ${errs[0]}`)
        }

        await page.evaluate(async (layerId) => {
            await window.layersApp._handleDeleteLayer(layerId)
        }, outcome.layerId)
        await page.waitForTimeout(120)
    }

    expect(failed, `menu entries that errored:\n${failed.join('\n')}`).toEqual([])
    expect(dead, `dead controls (no visible change):\n${dead.join('\n')}`).toEqual([])
    // Catches errors that fall between per-entry windows (layer deletion,
    // async render fallout) — nothing in the whole sweep may error.
    expect(consoleErrors, `console errors during sweep:\n${consoleErrors.join('\n')}`).toEqual([])
})
