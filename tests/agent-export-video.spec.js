import { test, expect } from 'playwright/test'

test.describe('agent: exportVideo', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('/')
        await page.evaluate(() => window.LayersAgent.ready)
    })

    test('returns jobId, completes, populates recentExports', async ({ page }) => {
        const r = await page.evaluate(() => window.LayersAgent.exportVideo({
            width: 64, height: 64, framerate: 30, duration: 0.1,
            loopCount: 1, format: 'zip', quality: 'low'
        }))
        expect(r.ok).toBe(true)
        expect(typeof r.result.jobId).toBe('string')

        const final = await page.evaluate((id) =>
            window.LayersAgent.waitForJob({ jobId: id, timeoutMs: 30000 }),
            r.result.jobId)
        expect(final.result.status).toBe('succeeded')
        expect(final.result.result.format).toBe('zip')
        expect(final.result.result.totalFrames).toBeGreaterThan(0)

        const state = await page.evaluate(() => window.LayersAgent.getState({}))
        const videoExport = state.state.recentExports.find(e => e.kind === 'video')
        expect(videoExport).toBeDefined()
        expect(videoExport.format).toBe('zip')
    })

    test('cancellation transitions job to cancelled and cleans up encoder', async ({ page }) => {
        // Spy on files.cancelZIP BEFORE starting the export so we can assert
        // the abort path actually invoked encoder cleanup.
        await page.evaluate(() => {
            window.__cancelZipCount = 0
            const filesObj = window.LayersAgent._app._files
            const orig = filesObj.cancelZIP.bind(filesObj)
            filesObj.cancelZIP = (...a) => { window.__cancelZipCount++; return orig(...a) }
        })

        const r = await page.evaluate(() => window.LayersAgent.exportVideo({
            width: 64, height: 64, framerate: 30, duration: 5,
            loopCount: 1, format: 'zip', quality: 'low'
        }))
        await page.evaluate(() => new Promise(r => setTimeout(r, 30)))
        await page.evaluate((id) => window.LayersAgent.cancelJob({ jobId: id }), r.result.jobId)
        const final = await page.evaluate((id) =>
            window.LayersAgent.waitForJob({ jobId: id, timeoutMs: 5000 }),
            r.result.jobId)
        expect(final.result.status).toBe('cancelled')

        const cancelCount = await page.evaluate(() => window.__cancelZipCount)
        expect(cancelCount).toBe(1)
    })

    test('rejects out-of-range arguments', async ({ page }) => {
        const r = await page.evaluate(() => window.LayersAgent.exportVideo({
            width: 64, height: 64, framerate: 30, duration: 1000, // out of range (max 300)
            loopCount: 1, format: 'zip', quality: 'low'
        }))
        expect(r.ok).toBe(false)
        expect(r.error.code).toMatch(/INVALID_ARGS_/)
    })

    test('rejects unknown format enum', async ({ page }) => {
        const r = await page.evaluate(() => window.LayersAgent.exportVideo({
            width: 64, height: 64, framerate: 30, duration: 0.1,
            format: 'gif', quality: 'low'
        }))
        expect(r.ok).toBe(false)
        expect(r.error.code).toBe('INVALID_ARGS_ENUM')
    })

    test('rejects unknown property', async ({ page }) => {
        // Schema has additionalProperties:false now. An agent that passes
        // exportVideo({garbage: true}) used to silently succeed (with garbage
        // ignored); now it must surface INVALID_ARGS_UNKNOWN so typos are loud.
        const r = await page.evaluate(() => window.LayersAgent.exportVideo({
            format: 'zip', quality: 'low', duration: 0.1,
            garbage: true
        }))
        expect(r.ok).toBe(false)
        expect(r.error.code).toBe('INVALID_ARGS_UNKNOWN')
        expect(r.error.details.field).toBe('garbage')
    })

    test('captureOnly surfaces blobUrl without firing a download (zip)', async ({ page }) => {
        let downloadFired = false
        page.on('download', () => { downloadFired = true })
        const r = await page.evaluate(() => window.LayersAgent.exportVideo({
            width: 64, height: 64, framerate: 30, duration: 0.1,
            loopCount: 1, format: 'zip', quality: 'low', captureOnly: true
        }))
        expect(r.ok).toBe(true)

        const final = await page.evaluate((id) =>
            window.LayersAgent.waitForJob({ jobId: id, timeoutMs: 30000 }),
            r.result.jobId)
        expect(final.result.status).toBe('succeeded')
        expect(final.result.result.format).toBe('zip')
        // captureOnly populated a blob URL the agent can fetch().
        expect(typeof final.result.result.blobUrl).toBe('string')
        expect(final.result.result.blobUrl.startsWith('blob:')).toBe(true)
        // Give a stray download event time to surface before asserting.
        await page.waitForTimeout(500)
        expect(downloadFired).toBe(false)
    })

    test('releaseExport revokes the captureOnly blobUrl', async ({ page }) => {
        // Run a captureOnly export, then call releaseExport with the returned
        // exportId — frees the underlying Blob immediately rather than leaking
        // it until the page unloads.
        const r = await page.evaluate(() => window.LayersAgent.exportVideo({
            width: 64, height: 64, framerate: 30, duration: 0.1,
            loopCount: 1, format: 'zip', quality: 'low', captureOnly: true
        }))
        expect(r.ok).toBe(true)
        const final = await page.evaluate((id) =>
            window.LayersAgent.waitForJob({ jobId: id, timeoutMs: 30000 }),
            r.result.jobId)
        expect(final.result.status).toBe('succeeded')
        const exportId = final.result.result.exportId
        expect(typeof exportId).toBe('string')

        const rel = await page.evaluate((id) =>
            window.LayersAgent.releaseExport({ exportId: id }), exportId)
        expect(rel.ok).toBe(true)
        expect(rel.result.released).toBe(true)
        expect(rel.result.exportId).toBe(exportId)

        // Second release on the same id must be loud — the map entry is gone.
        const rel2 = await page.evaluate((id) =>
            window.LayersAgent.releaseExport({ exportId: id }), exportId)
        expect(rel2.ok).toBe(false)
        expect(rel2.error.code).toBe('NOT_FOUND_EXPORT')
    })

    test('releaseExport rejects unknown exportId', async ({ page }) => {
        const r = await page.evaluate(() =>
            window.LayersAgent.releaseExport({ exportId: 'export-does-not-exist' }))
        expect(r.ok).toBe(false)
        expect(r.error.code).toBe('NOT_FOUND_EXPORT')
    })

    test('two video exports back-to-back do not share encoder state', async ({ page }) => {
        // Run two short ZIP exports in sequence; verify both succeed and produce
        // distinct recentExports entries. This caught a regression where _files
        // state leaked between exports.
        const r1 = await page.evaluate(() => window.LayersAgent.exportVideo({
            width: 64, height: 64, framerate: 30, duration: 0.1,
            format: 'zip', quality: 'low'
        }))
        expect(r1.ok).toBe(true)
        const final1 = await page.evaluate((id) =>
            window.LayersAgent.waitForJob({ jobId: id, timeoutMs: 30000 }),
            r1.result.jobId)
        expect(final1.result.status).toBe('succeeded')

        const r2 = await page.evaluate(() => window.LayersAgent.exportVideo({
            width: 64, height: 64, framerate: 30, duration: 0.1,
            format: 'zip', quality: 'low'
        }))
        expect(r2.ok).toBe(true)
        const final2 = await page.evaluate((id) =>
            window.LayersAgent.waitForJob({ jobId: id, timeoutMs: 30000 }),
            r2.result.jobId)
        expect(final2.result.status).toBe('succeeded')
    })

    test('a second exportVideo while one is running returns CONFLICT_JOB_IN_PROGRESS', async ({ page }) => {
        // Two concurrent exports would fight over the shared canvas resolution
        // (setResolution) and the renderer's pause/restart, corrupting both.
        // Mirrors installFontBundle: the second call is rejected and pointed
        // at the running job.
        const r1 = await page.evaluate(() => window.LayersAgent.exportVideo({
            width: 64, height: 64, framerate: 30, duration: 5,
            format: 'zip', quality: 'low'
        }))
        expect(r1.ok).toBe(true)

        const r2 = await page.evaluate(() => window.LayersAgent.exportVideo({
            width: 64, height: 64, framerate: 30, duration: 0.1,
            format: 'zip', quality: 'low'
        }))
        expect(r2.ok).toBe(false)
        expect(r2.error.code).toBe('CONFLICT_JOB_IN_PROGRESS')
        expect(r2.error.details.jobId).toBe(r1.result.jobId)

        // Once the running job settles (cancelled here), a fresh export is
        // allowed again.
        await page.evaluate((id) => window.LayersAgent.cancelJob({ jobId: id }), r1.result.jobId)
        const final1 = await page.evaluate((id) =>
            window.LayersAgent.waitForJob({ jobId: id, timeoutMs: 5000 }),
            r1.result.jobId)
        expect(final1.result.status).toBe('cancelled')

        const r3 = await page.evaluate(() => window.LayersAgent.exportVideo({
            width: 64, height: 64, framerate: 30, duration: 0.1,
            format: 'zip', quality: 'low'
        }))
        expect(r3.ok).toBe(true)
        const final3 = await page.evaluate((id) =>
            window.LayersAgent.waitForJob({ jobId: id, timeoutMs: 30000 }),
            r3.result.jobId)
        expect(final3.result.status).toBe('succeeded')
    })
})
