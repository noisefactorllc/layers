import { test, expect } from 'playwright/test'

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

test.describe('undo / redo', () => {
    test('undo reverses the last addLayer', async ({ page }) => {
        await bootApp(page)
        const before = await page.evaluate(() => window.layersApp._layers.length)
        await page.evaluate(() =>
            window.LayersAgent.addLayer({ kind: 'effect', effectId: 'synth/gradient' }))
        const env = await page.evaluate(() => window.LayersAgent.undo())
        expect(env.ok).toBe(true)
        expect(env.state.layers.length).toBe(before)
    })

    test('redo reapplies an undone change', async ({ page }) => {
        await bootApp(page)
        await page.evaluate(() =>
            window.LayersAgent.addLayer({ kind: 'effect', effectId: 'synth/gradient' }))
        const afterAdd = await page.evaluate(() => window.layersApp._layers.length)
        await page.evaluate(() => window.LayersAgent.undo())
        const env = await page.evaluate(() => window.LayersAgent.redo())
        expect(env.ok).toBe(true)
        expect(env.state.layers.length).toBe(afterAdd)
    })

    test('undo no-op succeeds when nothing to undo', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() => window.LayersAgent.undo())
        expect(env.ok).toBe(true)
    })

    test('snapshot exposes canUndo/canRedo', async ({ page }) => {
        await bootApp(page)
        await page.evaluate(() =>
            window.LayersAgent.addLayer({ kind: 'effect', effectId: 'synth/gradient' }))
        const env = await page.evaluate(() => window.LayersAgent.getState())
        expect(env.state.project.canUndo).toBe(true)
    })

    test('job polling hides undo history changes while restore preparation can fail', async ({ page }) => {
        await bootApp(page)
        const result = await page.evaluate(async () => {
            const app = window.layersApp
            await window.LayersAgent.addLayer({
                kind: 'effect', effectId: 'synth/gradient',
            })
            const readState = async () => {
                const { state } = await window.LayersAgent.getJob({ jobId: 'missing-job' })
                return {
                    project: state.project,
                    canvas: state.canvas,
                    selection: state.selection,
                    layers: state.layers,
                    selectedLayerIds: state.selectedLayerIds,
                    activeLayerId: state.activeLayerId,
                }
            }
            const before = await readState()
            let enteredPrepare
            let releasePrepare
            const entered = new Promise(resolve => { enteredPrepare = resolve })
            const release = new Promise(resolve => { releasePrepare = resolve })
            app._prepareLayerSetCandidate = async () => {
                enteredPrepare()
                await release
                throw new Error('injected undo preparation failure')
            }

            const undo = window.LayersAgent.undo()
            await entered
            const during = await readState()
            releasePrepare()
            const envelope = await undo
            const after = await readState()
            return { before, during, envelope, after }
        })

        expect(result.envelope.ok).toBe(false)
        expect(result.during).toEqual(result.before)
        expect(result.after).toEqual(result.before)
    })
})
