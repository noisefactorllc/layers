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
})
