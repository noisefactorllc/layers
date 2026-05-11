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

test.describe('LayersAgent job commands (registry-backed)', () => {
    test('getJob returns NOT_FOUND_JOB for unknown id', async ({ page }) => {
        await bootApp(page)
        const r = await page.evaluate(() => window.LayersAgent.getJob({ jobId: 'nope' }))
        expect(r.ok).toBe(false)
        expect(r.error.code).toBe('NOT_FOUND_JOB')
    })

    test('snapshot exposes empty jobs array when no jobs have run', async ({ page }) => {
        await bootApp(page)
        const before = await page.evaluate(() => {
            window.__layersJobs._reset()
            return window.LayersAgent.getState({})
        })
        expect(before.state.jobs).toEqual([])
    })

    test('snapshot exposes jobs after a registry-created job settles', async ({ page }) => {
        await bootApp(page)
        const after = await page.evaluate(async () => {
            window.__layersJobs._reset()
            const { id } = window.__layersJobs.createJob('test-kind', async () => ({ ok: 1 }))
            await window.__layersJobs.waitForJob(id, 2000)
            return window.LayersAgent.getState({})
        })
        expect(after.state.jobs.length).toBeGreaterThan(0)
        const j = after.state.jobs.find(x => x.kind === 'test-kind')
        expect(j).toBeDefined()
        expect(j.status).toBe('succeeded')
    })

    test('waitForJob with timeoutMs returns timedOut envelope', async ({ page }) => {
        await bootApp(page)
        const r = await page.evaluate(async () => {
            const { id } = window.__layersJobs.createJob('test-kind', async () => {
                await new Promise(r => setTimeout(r, 500))
                return { ok: 1 }
            })
            return await window.LayersAgent.waitForJob({ jobId: id, timeoutMs: 50 })
        })
        expect(r.ok).toBe(true)
        expect(r.result.timedOut).toBe(true)
    })

    test('cancelJob transitions to cancelled', async ({ page }) => {
        await bootApp(page)
        const final = await page.evaluate(async () => {
            const { id } = window.__layersJobs.createJob('test-kind', async (api) => {
                while (!api.abortSignal.aborted) await new Promise(r => setTimeout(r, 5))
                api.checkAbort()
            })
            await new Promise(r => setTimeout(r, 20))
            await window.LayersAgent.cancelJob({ jobId: id })
            const settled = await window.LayersAgent.waitForJob({ jobId: id, timeoutMs: 1000 })
            return settled.result
        })
        expect(final.status).toBe('cancelled')
    })
})
