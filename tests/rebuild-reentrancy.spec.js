import { test, expect } from 'playwright/test'

// Regression tests for overlapping LayersRenderer.rebuild() calls.
//
// The app has fire-and-forget rebuild call sites (mask-edit exit, V-key
// visibility toggle) that can overlap an awaited rebuild. rebuild() used to
// record _currentDsl BEFORE awaiting the compile, so:
//   - a concurrent rebuild with the same layers short-circuited "success"
//     while the pipeline was still half-built, and
//   - a FAILED compile left _currentDsl pointing at the failed DSL, so the
//     next rebuild with unchanged layers short-circuited "success" against
//     a stale pipeline instead of retrying the compile.
// rebuild() now serializes through a promise chain and records _currentDsl
// only after the compile succeeds.

async function bootApp(page) {
    await page.goto('/', { waitUntil: 'networkidle' })
    await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })
    await page.evaluate(async () => { await window.LayersAgent.ready })
    const visible = await page.evaluate(() => !!document.querySelector('.open-dialog-backdrop.visible'))
    if (visible) {
        await page.click('.media-option[data-type="solid"]')
        await page.waitForSelector('.canvas-size-dialog', { timeout: 5000 })
        await page.click('.canvas-size-dialog .action-btn.primary')
        await page.waitForSelector('.open-dialog-backdrop.visible', { state: 'hidden', timeout: 5000 })
    }
}

async function addGradientLayer(page) {
    const env = await page.evaluate(() =>
        window.LayersAgent.addLayer({ kind: 'effect', effectId: 'synth/gradient' }))
    expect(env.ok).toBe(true)
    return env.result.layerId
}

test.describe('LayersRenderer rebuild re-entrancy', () => {
    test('concurrent same-DSL rebuild resolves only after the in-flight rebuild fully applied', async ({ page }) => {
        await bootApp(page)
        const layerId = await addGradientLayer(page)

        const out = await page.evaluate(async (id) => {
            const app = window.layersApp
            const renderer = app._renderer
            const layer = app._layers.find(l => l.id === id)

            // Sanity: the gradient layer is mapped in the live pipeline.
            const mappedBefore = renderer._layerStepMap.has(id)

            // Change the DSL (hide the layer), then overlap two rebuilds the
            // way the app's fire-and-forget call sites can.
            layer.visible = false
            const p1 = renderer.rebuild()
            let mappedWhenP2Resolved = null
            const p2 = renderer.rebuild().then((r) => {
                // Snapshot the pipeline mapping at the moment the second
                // rebuild reports success.
                mappedWhenP2Resolved = renderer._layerStepMap.has(id)
                return r
            })
            const [r1, r2] = await Promise.all([p1, p2])
            return {
                mappedBefore,
                r1,
                r2,
                mappedWhenP2Resolved,
                mappedAfterBoth: renderer._layerStepMap.has(id)
            }
        }, layerId)

        expect(out.mappedBefore).toBe(true)
        expect(out.r1.success).toBe(true)
        expect(out.r2.success).toBe(true)
        // The second rebuild must not report success while the first one's
        // pipeline swap is still in flight: by the time it resolves, the
        // hidden layer must already be gone from the step map.
        expect(out.mappedWhenP2Resolved).toBe(false)
        expect(out.mappedAfterBoth).toBe(false)
    })

    test('failed compile does not poison _currentDsl: the next rebuild retries', async ({ page }) => {
        await bootApp(page)
        const layerId = await addGradientLayer(page)

        const out = await page.evaluate(async (id) => {
            const app = window.layersApp
            const renderer = app._renderer
            const layer = app._layers.find(l => l.id === id)

            // Inject a one-shot compile failure via an own-property shadow.
            renderer._loadAndCompile = () => Promise.reject(new Error('injected compile failure'))
            layer.visible = false
            const r1 = await renderer.rebuild()
            delete renderer._loadAndCompile // restore the prototype method

            const r2 = await renderer.rebuild()
            return { r1, r2, mappedAfter: renderer._layerStepMap.has(id) }
        }, layerId)

        expect(out.r1.success).toBe(false)
        // With _currentDsl recorded before the failed compile, r2 used to
        // short-circuit "success" against the stale pipeline. It must retry
        // the compile and actually apply the new layer state.
        expect(out.r2.success).toBe(true)
        expect(out.mappedAfter).toBe(false)
    })
})
