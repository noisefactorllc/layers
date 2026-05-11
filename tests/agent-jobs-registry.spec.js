import { test, expect } from 'playwright/test'

test.describe('agent: jobs registry', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('/')
        await page.evaluate(() => window.LayersAgent.ready)
        // jobs.js is now imported transitively via commands.js/snapshot.js,
        // so its side-effect attaches window.__layersJobs during agent bootstrap.
    })

    test('createJob reaches succeeded with result', async ({ page }) => {
        const final = await page.evaluate(async () => {
            const j = window.__layersJobs
            const { id } = j.createJob('test-kind', async () => ({ ok: 1 }))
            return await j.waitForJob(id, 2000)
        })
        expect(final.status).toBe('succeeded')
        expect(final.result).toEqual({ ok: 1 })
    })

    test('reportProgress updates state', async ({ page }) => {
        const states = await page.evaluate(async () => {
            const j = window.__layersJobs
            const { id } = j.createJob('test-kind', async (api) => {
                api.reportProgress('starting', 0, 100)
                await new Promise(r => setTimeout(r, 10))
                api.reportProgress('working', 50, 100)
                await new Promise(r => setTimeout(r, 10))
                api.reportProgress('done', 100, 100)
                return { ok: true }
            })
            const mid = (await new Promise(r => setTimeout(() => r(j.getJob(id)), 15)))
            const final = await j.waitForJob(id, 2000)
            return { mid, final }
        })
        expect(states.final.status).toBe('succeeded')
        expect(states.final.progress.current).toBe(100)
    })

    test('cancelJob aborts running job', async ({ page }) => {
        const final = await page.evaluate(async () => {
            const j = window.__layersJobs
            const { id } = j.createJob('test-kind', async (api) => {
                while (!api.abortSignal.aborted) {
                    await new Promise(r => setTimeout(r, 5))
                }
                api.checkAbort()
            })
            await new Promise(r => setTimeout(r, 20))
            j.cancelJob(id)
            return await j.waitForJob(id, 2000)
        })
        expect(final.status).toBe('cancelled')
    })

    test('waitForJob with timeout returns timedOut marker', async ({ page }) => {
        const out = await page.evaluate(async () => {
            const j = window.__layersJobs
            const { id } = j.createJob('test-kind', async () => {
                await new Promise(r => setTimeout(r, 500))
                return { ok: true }
            })
            return await j.waitForJob(id, 50)
        })
        expect(out.timedOut).toBe(true)
        expect(out.status).toBe('running')
    })

    test('getJob returns null for unknown id', async ({ page }) => {
        const r = await page.evaluate(() => window.__layersJobs.getJob('does-not-exist'))
        expect(r).toBeNull()
    })

    test('listJobs caps at 50 entries', async ({ page }) => {
        const count = await page.evaluate(async () => {
            const j = window.__layersJobs
            j._reset()
            for (let i = 0; i < 60; i++) {
                const { id } = j.createJob('test-kind', async () => ({ i }))
                await j.waitForJob(id, 2000)
            }
            return j.listJobs().length
        })
        expect(count).toBeLessThanOrEqual(50)
    })

    test('failed job records error code', async ({ page }) => {
        const final = await page.evaluate(async () => {
            const j = window.__layersJobs
            const { id } = j.createJob('test-kind', async () => {
                const e = new Error('boom')
                e.code = 'INTENTIONAL'
                throw e
            })
            return await j.waitForJob(id, 2000)
        })
        expect(final.status).toBe('failed')
        expect(final.error.code).toBe('INTENTIONAL')
    })
})
