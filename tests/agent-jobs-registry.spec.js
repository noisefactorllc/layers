import { test, expect } from './fixtures.js'
import { IN_PAGE_UNTIL } from './waits.js'

test.describe('agent: jobs registry', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('/')
        await page.evaluate(() => window.LayersAgent.ready)
        // jobs.js is now imported transitively via commands.js/snapshot.js,
        // so its side-effect attaches window.__LAYERS_TEST_HOOKS.jobs during agent bootstrap.
        // _reset() is harmless today (each test runs in a fresh page) but
        // protects against future test-style changes that share pages between
        // tests in the same describe block.
        await page.evaluate(() => window.__LAYERS_TEST_HOOKS?.jobs?._reset?.())
    })

    test('createJob reaches succeeded with result', async ({ page }) => {
        const final = await page.evaluate(async () => {
            const j = window.__LAYERS_TEST_HOOKS.jobs
            const { id } = j.createJob('test-kind', async () => ({ ok: 1 }))
            return await j.waitForJob(id, 2000)
        })
        expect(final.status).toBe('succeeded')
        expect(final.result).toEqual({ ok: 1 })
    })

    test('reportProgress updates state', async ({ page }) => {
        const states = await page.evaluate(async (untilSrc) => {
            const until = eval(untilSrc)
            const j = window.__LAYERS_TEST_HOOKS.jobs
            // Gates, not sleeps. The job holds at each phase until the test
            // releases it, so the mid-flight sample reads the phase it means
            // to read rather than whichever one a 15ms guess lands on.
            let releaseWorking
            let releaseDone
            const working = new Promise(resolve => { releaseWorking = resolve })
            const done = new Promise(resolve => { releaseDone = resolve })
            const { id } = j.createJob('test-kind', async (api) => {
                api.reportProgress('starting', 0, 100)
                await working
                api.reportProgress('working', 50, 100)
                await done
                api.reportProgress('done', 100, 100)
                return { ok: true }
            })
            await until(() => j.getJob(id)?.progress?.phase === 'starting',
                'first progress reported')
            releaseWorking()
            await until(() => j.getJob(id)?.progress?.phase === 'working',
                'mid progress reported')
            const mid = j.getJob(id)
            releaseDone()
            const final = await j.waitForJob(id, 2000)
            return { mid, final }
        }, IN_PAGE_UNTIL)
        expect(states.final.status).toBe('succeeded')
        expect(states.final.progress.current).toBe(100)
    })

    test('cancelJob aborts running job', async ({ page }) => {
        const final = await page.evaluate(async (untilSrc) => {
            const until = eval(untilSrc)
            const j = window.__LAYERS_TEST_HOOKS.jobs
            const { id } = j.createJob('test-kind', async (api) => {
                // Runs until cancelled. Parked on the abort event rather than
                // polling a timer, so the job notices the cancel at once.
                if (!api.abortSignal.aborted) {
                    await new Promise(resolve => {
                        api.abortSignal.addEventListener('abort', resolve, { once: true })
                    })
                }
                api.checkAbort()
            })
            await until(() => j.getJob(id)?.status === 'running', 'job running')
            j.cancelJob(id)
            return await j.waitForJob(id, 2000)
        }, IN_PAGE_UNTIL)
        expect(final.status).toBe('cancelled')
    })

    test('waitForJob with timeout returns timedOut marker', async ({ page }) => {
        const out = await page.evaluate(async () => {
            const j = window.__LAYERS_TEST_HOOKS.jobs
            const { id } = j.createJob('test-kind', async () => {
                // Fixture duration, not a wait: the job has to outlive the
                // 50ms waitForJob below for the timedOut marker to exist.
                await new Promise(r => setTimeout(r, 500))
                return { ok: true }
            })
            return await j.waitForJob(id, 50)
        })
        expect(out.timedOut).toBe(true)
        expect(out.status).toBe('running')
    })

    test('getJob returns null for unknown id', async ({ page }) => {
        const r = await page.evaluate(() => window.__LAYERS_TEST_HOOKS.jobs.getJob('does-not-exist'))
        expect(r).toBeNull()
    })

    test('listJobs caps at 50 entries', async ({ page }) => {
        const count = await page.evaluate(async () => {
            const j = window.__LAYERS_TEST_HOOKS.jobs
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
            const j = window.__LAYERS_TEST_HOOKS.jobs
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
