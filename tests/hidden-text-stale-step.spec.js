import { test, expect } from 'playwright/test'

// Regression tests for updateTextParams on hidden text layers.
//
// _uploadTextTextures deliberately retains hidden text layers' canvases (so
// toggling visibility doesn't churn them) but only reassigns stepIndex for
// VISIBLE layers. A hidden layer therefore keeps a stale stepIndex — one that
// after a rebuild can belong to a DIFFERENT visible text layer. Writing
// through it (e.g. nudging a hidden-but-active text layer, which calls
// updateTextParams) overwrote that other layer's texture. updateTextParams
// must no-op for hidden layers; their canvas re-renders from effectParams on
// the next rebuild when they become visible again.

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

async function addTextLayer(page, text) {
    const env = await page.evaluate((t) =>
        window.LayersAgent.addLayer({ kind: 'text', text: t }), text)
    expect(env.ok).toBe(true)
    return env.result.layerId
}

/**
 * Install a spy on the inner renderer's updateTextureFromSource that records
 * textTex_* uploads into window.__textTexUploads.
 */
async function spyTextUploads(page) {
    await page.evaluate(() => {
        const inner = window.layersApp._renderer._renderer
        window.__textTexUploads = []
        const orig = inner.updateTextureFromSource.bind(inner)
        window.__restoreTextSpy = () => { delete inner.updateTextureFromSource }
        inner.updateTextureFromSource = (id, src, opts) => {
            if (String(id).startsWith('textTex')) window.__textTexUploads.push(String(id))
            return orig(id, src, opts)
        }
    })
}

test.describe('updateTextParams on hidden text layers', () => {
    test('updating a hidden text layer does not write to a stale texture slot', async ({ page }) => {
        await bootApp(page)
        const t1 = await addTextLayer(page, 'FIRST')
        const t2 = await addTextLayer(page, 'SECOND')

        const setup = await page.evaluate(async ({ t1Id, t2Id }) => {
            const renderer = window.layersApp._renderer
            const before = {
                t1Index: renderer._textCanvases.get(t1Id)?.stepIndex,
                t2Index: renderer._textCanvases.get(t2Id)?.stepIndex
            }
            const env = await window.LayersAgent.setLayerProps({
                layerId: t1Id, props: { visible: false }
            })
            const after = {
                t1Index: renderer._textCanvases.get(t1Id)?.stepIndex,
                t2Index: renderer._textCanvases.get(t2Id)?.stepIndex
            }
            return { ok: env.ok, before, after }
        }, { t1Id: t1, t2Id: t2 })

        expect(setup.ok).toBe(true)
        // The hidden layer's canvas is retained (by design) with its now-stale
        // stepIndex, while the remaining visible text layer was reassigned.
        expect(setup.after.t1Index).toBe(setup.before.t1Index)
        expect(setup.after.t2Index).not.toBe(setup.before.t2Index)

        await spyTextUploads(page)
        const uploads = await page.evaluate(async ({ t1Id }) => {
            const app = window.layersApp
            const layer = app._layers.find(l => l.id === t1Id)
            // Nudge the hidden layer the way _updateActiveLayerPosition does:
            // model first, then updateTextParams.
            layer.effectParams = { ...layer.effectParams, posX: 0.25, posY: 0.25 }
            app._renderer.updateTextParams(t1Id, layer.effectParams)
            // Let the async fontaine re-render path settle too.
            await new Promise(r => setTimeout(r, 150))
            window.__restoreTextSpy()
            return window.__textTexUploads
        }, { t1Id: t1 })

        // A hidden layer's stepIndex is stale — with two text layers it now
        // aliases the visible layer's slot. No upload may happen at all.
        expect(uploads).toEqual([])
    })

    test('updating a visible text layer still renders and uploads its texture', async ({ page }) => {
        await bootApp(page)
        await addTextLayer(page, 'FIRST')
        const t2 = await addTextLayer(page, 'SECOND')

        await spyTextUploads(page)
        const out = await page.evaluate(async ({ t2Id }) => {
            const app = window.layersApp
            const layer = app._layers.find(l => l.id === t2Id)
            const stepIndex = app._renderer._textCanvases.get(t2Id)?.stepIndex
            layer.effectParams = { ...layer.effectParams, posX: 0.75 }
            app._renderer.updateTextParams(t2Id, layer.effectParams)
            await new Promise(r => setTimeout(r, 150))
            window.__restoreTextSpy()
            return { stepIndex, uploads: window.__textTexUploads }
        }, { t2Id: t2 })

        expect(out.uploads.length).toBeGreaterThan(0)
        for (const id of out.uploads) {
            expect(id).toBe(`textTex_step_${out.stepIndex}`)
        }
    })
})
