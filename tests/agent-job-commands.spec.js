import { test, expect } from './fixtures.js'
import { IN_PAGE_UNTIL } from './waits.js'

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
            window.__LAYERS_TEST_HOOKS.jobs._reset()
            return window.LayersAgent.getState({})
        })
        expect(before.state.jobs).toEqual([])
    })

    test('snapshot exposes jobs after a registry-created job settles', async ({ page }) => {
        await bootApp(page)
        const after = await page.evaluate(async () => {
            window.__LAYERS_TEST_HOOKS.jobs._reset()
            const { id } = window.__LAYERS_TEST_HOOKS.jobs.createJob('test-kind', async () => ({ ok: 1 }))
            await window.__LAYERS_TEST_HOOKS.jobs.waitForJob(id, 2000)
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
            const { id } = window.__LAYERS_TEST_HOOKS.jobs.createJob('test-kind', async () => {
                // Fixture duration, not a wait: the job has to outlive the
                // 50ms waitForJob below for the timedOut envelope to exist.
                await new Promise(r => setTimeout(r, 500))
                return { ok: 1 }
            })
            return await window.LayersAgent.waitForJob({ jobId: id, timeoutMs: 50 })
        })
        expect(r.ok).toBe(true)
        expect(r.result.timedOut).toBe(true)
    })

    test('waitForJob does not hold the project lifecycle while it waits', async ({ page }) => {
        await bootApp(page)
        const result = await page.evaluate(async (untilSrc) => {
            const until = eval(untilSrc)
            const app = window.layersApp
            let releaseJob
            const { id } = window.__LAYERS_TEST_HOOKS.jobs.createJob('test-kind', async () => {
                await new Promise(resolve => { releaseJob = resolve })
                return { ok: 1 }
            })
            await until(() => Boolean(releaseJob), 'job body parked on its gate')
            const waitPromise = window.LayersAgent.waitForJob({ jobId: id, timeoutMs: 30000 })
            const replacementPromise = app._handleCreateGradientBase(333, 222)
            let deadline
            let replacementCompletedWhileJobPending
            try {
                // Keep the job pending until replacement actually completes.
                // Shader compilation speed is not the lifecycle contract. The
                // timer is this race's failure bound, not a wait: it wins only
                // if the replacement never completes.
                replacementCompletedWhileJobPending = await Promise.race([
                    replacementPromise.then(() => true),
                    new Promise(resolve => { deadline = setTimeout(() => resolve(false), 15000) }),
                ])
            } finally {
                clearTimeout(deadline)
                releaseJob()
            }
            const [waitEnvelope, replacementStatus] = await Promise.all([
                waitPromise,
                replacementPromise,
            ])
            return {
                replacementCompletedWhileJobPending,
                replacementStatus,
                jobStatus: waitEnvelope.result.status,
            }
        }, IN_PAGE_UNTIL)

        expect(result).toEqual({
            replacementCompletedWhileJobPending: true,
            replacementStatus: 'opened',
            jobStatus: 'succeeded',
        })
    })

    test('cancelJob transitions to cancelled', async ({ page }) => {
        await bootApp(page)
        const final = await page.evaluate(async (untilSrc) => {
            const until = eval(untilSrc)
            const jobs = window.__LAYERS_TEST_HOOKS.jobs
            const { id } = jobs.createJob('test-kind', async (api) => {
                // Runs until cancelled. Parked on the abort event rather than
                // polling a timer, so the job notices the cancel at once.
                if (!api.abortSignal.aborted) {
                    await new Promise(resolve => {
                        api.abortSignal.addEventListener('abort', resolve, { once: true })
                    })
                }
                api.checkAbort()
            })
            await until(() => jobs.getJob(id)?.status === 'running', 'job running')
            await window.LayersAgent.cancelJob({ jobId: id })
            const settled = await window.LayersAgent.waitForJob({ jobId: id, timeoutMs: 1000 })
            return settled.result
        }, IN_PAGE_UNTIL)
        expect(final.status).toBe('cancelled')
    })

    test('cancelJob can interrupt a concurrent waitForJob command', async ({ page }) => {
        await bootApp(page)
        const result = await page.evaluate(async (untilSrc) => {
            const until = eval(untilSrc)
            const jobs = window.__LAYERS_TEST_HOOKS.jobs
            const { id } = jobs.createJob('test-kind', async (api) => {
                // Runs until cancelled. Parked on the abort event rather than
                // polling a timer, so the job notices the cancel at once.
                if (!api.abortSignal.aborted) {
                    await new Promise(resolve => {
                        api.abortSignal.addEventListener('abort', resolve, { once: true })
                    })
                }
                api.checkAbort()
            })
            const waitPromise = window.LayersAgent.waitForJob({ jobId: id, timeoutMs: 2000 })
            // waitForJob registers its waiter synchronously, so holding here
            // until the job is running leaves the cancel interrupting a live
            // wait, which is the contract under test.
            await until(() => jobs.getJob(id)?.status === 'running', 'job running')
            const cancelEnvelope = await window.LayersAgent.cancelJob({ jobId: id })
            const waitEnvelope = await waitPromise
            return { cancelEnvelope, waitEnvelope }
        }, IN_PAGE_UNTIL)

        expect(result.cancelEnvelope.ok).toBe(true)
        expect(result.waitEnvelope.ok).toBe(true)
        expect(result.waitEnvelope.result.status).toBe('cancelled')
        expect(result.waitEnvelope.result.timedOut).not.toBe(true)
    })
})
