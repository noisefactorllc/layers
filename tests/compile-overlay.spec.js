import { test, expect } from 'playwright/test'

// "Compiling shaders..." overlay (a la noisedeck): shown over the canvas
// while the renderer is legitimately recompiling the DSL, and ONLY then.
// Uniform-only param changes and hovering over param controls must never
// compile — and therefore must never flash the overlay. The hover case pins
// the original regression report: mousing over a layer's param controls must
// not trigger DSL rebuilds.

async function loadWithSolidBase(page) {
    await page.goto('/', { waitUntil: 'networkidle' })
    await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })
    await page.waitForSelector('.open-dialog-backdrop.visible')
    await page.click('.media-option[data-type="solid"]')
    await page.waitForSelector('.canvas-size-dialog', { timeout: 5000 })
    await page.click('.canvas-size-dialog .action-btn.primary')
    await page.waitForSelector('.open-dialog-backdrop.visible', { state: 'hidden', timeout: 5000 })
    await page.waitForTimeout(1000)
}

// Start observing the overlay's class attribute; returns whether 'visible'
// ever appeared between start() and stop().
function armOverlayWatch(page) {
    return page.evaluate(() => {
        const overlay = document.getElementById('compile-overlay')
        window.__overlaySeen = { visible: false }
        window.__overlayObserver = new MutationObserver(() => {
            if (overlay.classList.contains('visible')) {
                window.__overlaySeen.visible = true
            }
        })
        window.__overlayObserver.observe(overlay, { attributes: true, attributeFilter: ['class'] })
    })
}

function readOverlayWatch(page) {
    return page.evaluate(() => {
        window.__overlayObserver.disconnect()
        return window.__overlaySeen.visible
    })
}

test('overlay exists and is hidden at rest', async ({ page }) => {
    await loadWithSolidBase(page)
    const overlay = page.locator('#compile-overlay')
    await expect(overlay).toHaveCount(1)
    await expect(overlay).not.toHaveClass(/visible/)
    await expect(overlay).toHaveAttribute('aria-hidden', 'true')
})

test('overlay shows during a real compile and hides after', async ({ page }) => {
    await loadWithSolidBase(page)

    // Hold the engine compile open behind a gate so the in-flight state is
    // deterministic, then force a rebuild.
    await page.evaluate(() => {
        const inner = window.layersApp._renderer._renderer
        const origCompile = inner.compile.bind(inner)
        window.__releaseCompile = null
        inner.compile = async (dsl) => {
            await new Promise(resolve => { window.__releaseCompile = resolve })
            return origCompile(dsl)
        }
        window.__rebuildPromise = window.layersApp._rebuild({ force: true })
    })

    await expect(page.locator('#compile-overlay')).toHaveClass(/visible/, { timeout: 5000 })
    await expect(page.locator('#compile-overlay')).toHaveAttribute('aria-hidden', 'false')

    const result = await page.evaluate(async () => {
        window.__releaseCompile()
        return window.__rebuildPromise
    })
    expect(result.success).toBe(true)

    await expect(page.locator('#compile-overlay')).not.toHaveClass(/visible/, { timeout: 5000 })
    await expect(page.locator('#compile-overlay')).toHaveAttribute('aria-hidden', 'true')
})

test('uniform-only param changes update without compiling or showing the overlay', async ({ page }) => {
    const dslCompiles = []
    page.on('console', msg => {
        if (msg.text().includes('[LayersRenderer] Built DSL:')) dslCompiles.push(msg.text())
    })
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
    await page.waitForTimeout(800)

    await armOverlayWatch(page)
    const compilesBefore = dslCompiles.length

    // halftone `frequency` is a runtime uniform (mode/pattern are the define-
    // backed ones), so this must take the cheap updateLayerParams path: no
    // rebuild, no compile, no overlay.
    await page.evaluate(async ({ layerId }) => {
        const app = window.layersApp
        const layer = app._layers.find(l => l.id === layerId)
        await app._handleLayerChange({
            layerId,
            property: 'effectParams',
            value: { ...layer.effectParams, frequency: 35 },
            layer,
        })
    }, { layerId: setup.layerId })
    await page.waitForTimeout(600)

    const overlayFlashed = await readOverlayWatch(page)
    expect(overlayFlashed, 'uniform-only change must not show the compile overlay').toBe(false)
    expect(dslCompiles.length, 'uniform-only change must not compile DSL').toBe(compilesBefore)
})

test('hovering over param controls never compiles or shows the overlay', async ({ page }) => {
    const dslCompiles = []
    page.on('console', msg => {
        if (msg.text().includes('[LayersRenderer] Built DSL:')) dslCompiles.push(msg.text())
    })
    await loadWithSolidBase(page)

    await page.evaluate(async () => {
        const app = window.layersApp
        await app._handleAddEffectLayer('synth/noise')
        await app._handleAddEffectLayer('filter/halftone', {
            params: { mode: 0, pattern: 0, frequency: 20 }
        })
        await app._rebuild({ force: true })
    })
    await page.waitForTimeout(800)

    // Expand the top layer's params so the controls are hoverable
    await page.locator('layer-item .layer-params-toggle').first().click({ force: true })
    await page.waitForTimeout(400)

    const box = await page.evaluate(() => {
        const el = document.querySelector('layer-item effect-params')
        const r = el.getBoundingClientRect()
        return { x: r.x, y: r.y, width: r.width, height: r.height }
    })
    expect(box.width).toBeGreaterThan(0)

    await armOverlayWatch(page)
    const compilesBefore = dslCompiles.length

    // Sweep the cursor across the params panel like a user browsing controls
    for (let i = 0; i <= 60; i++) {
        await page.mouse.move(
            box.x + 4 + ((box.width - 8) * (i % 30)) / 30,
            box.y + 4 + ((box.height - 8) * ((i * 7) % 30)) / 30)
    }
    await page.waitForTimeout(500)

    const overlayFlashed = await readOverlayWatch(page)
    expect(overlayFlashed, 'hover must not show the compile overlay').toBe(false)
    expect(dslCompiles.length, 'hover must not trigger DSL compiles').toBe(compilesBefore)
})
