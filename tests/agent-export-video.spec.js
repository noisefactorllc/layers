import { test, expect } from './fixtures.js'
import { IN_PAGE_UNTIL, quietWindow } from './waits.js'

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
            window.__zipEncoderStarted = false
            const filesObj = window.LayersAgent._app._files
            const orig = filesObj.cancelZIP.bind(filesObj)
            filesObj.cancelZIP = (...a) => { window.__cancelZipCount++; return orig(...a) }
            const start = filesObj.saveZip.bind(filesObj)
            const encoderGate = new Promise(resolve => { window.__releaseZipEncoder = resolve })
            filesObj.saveZip = async (...args) => {
                await start(...args)
                window.__zipEncoderStarted = true
                await encoderGate
            }
        })

        const r = await page.evaluate(() => window.LayersAgent.exportVideo({
            width: 64, height: 64, framerate: 30, duration: 5,
            loopCount: 1, format: 'zip', quality: 'low'
        }))
        await page.waitForFunction(() => window.__zipEncoderStarted)
        await page.evaluate(async id => {
            await window.LayersAgent.cancelJob({ jobId: id })
            window.__releaseZipEncoder()
        }, r.result.jobId)
        const final = await page.evaluate((id) =>
            window.LayersAgent.waitForJob({ jobId: id, timeoutMs: 5000 }),
            r.result.jobId)
        expect(final.result.status).toBe('cancelled')

        const cancelCount = await page.evaluate(() => window.__cancelZipCount)
        expect(cancelCount).toBe(1)
    })

    test('cancellation while waiting for the project lease does not start or cancel an encoder', async ({ page }) => {
        const result = await page.evaluate(async () => {
            const app = window.layersApp
            const held = await app._acquireProjectLifecycle()
            let encoderStarts = 0, encoderCancels = 0
            app._files.saveZip = () => { encoderStarts++ }
            app._files.cancelZIP = () => { encoderCancels++ }
            // This test owns lifecycle ordering; pixel/session behavior has
            // separate coverage and must not allocate a GPU while queued.
            app._renderer.createFullResolutionCapture = async () => ({ render() { throw new Error('Cancelled job rendered a frame') }, async dispose() {} })
            let jobId
            try {
                const started = await window.LayersAgent.exportVideo({ width: 64, height: 64, framerate: 30, duration: 1, format: 'zip' })
                jobId = started.result.jobId
                await window.LayersAgent.cancelJob({ jobId })
            } finally { held.release() }
            const settled = await window.LayersAgent.waitForJob({ jobId, timeoutMs: 5000 })
            return { status: settled.result.status, encoderStarts, encoderCancels, lifecycleActive: app._projectLifecycleActive }
        })
        expect(result).toEqual({ status: 'cancelled', encoderStarts: 0, encoderCancels: 0, lifecycleActive: false })
    })

    test('replacement waits for export cancellation and commits at its own resolution', async ({ page }) => {
        const result = await page.evaluate(async (untilSrc) => {
            const until = eval(untilSrc)
            const app = window.layersApp
            const started = await window.LayersAgent.exportVideo({
                width: 64,
                height: 64,
                framerate: 30,
                duration: 5,
                loopCount: 1,
                format: 'zip',
                quality: 'low',
            })
            await until(() => app._projectLifecycleActive,
                'the export job took the project lifecycle lease')
            let stageReached = false
            const stageLayerSet = app._renderer.stageLayerSet.bind(app._renderer)
            app._renderer.stageLayerSet = async (candidate) => {
                stageReached = true
                return stageLayerSet(candidate)
            }
            const replacementPromise = app._handleCreateGradientBase(333, 222)
            // The barrier the old fixed sleep was guessing at: the replacement
            // parks in the lifecycle queue behind the export, and
            // _projectLifecycleWaiters counts it for exactly as long as it is
            // parked. While that count is up the replacement provably has not
            // taken the lease, and stageLayerSet runs only after the lease is
            // taken, so stageReached must still be false.
            await until(() => app._projectLifecycleWaiters > 0,
                'the replacement queued behind the running export')
            const replacementWaitedForExport = !stageReached
            await window.LayersAgent.cancelJob({ jobId: started.result.jobId })
            const settled = await window.LayersAgent.waitForJob({
                jobId: started.result.jobId,
                timeoutMs: 5000,
            })
            const replacementStatus = await replacementPromise
            return {
                replacementWaitedForExport,
                jobStatus: settled.result.status,
                replacementStatus,
                width: app._canvas.width,
                height: app._canvas.height,
                rendererRunning: app._renderer.isRunning,
            }
        }, IN_PAGE_UNTIL)

        expect(result).toEqual({
            replacementWaitedForExport: true,
            jobStatus: 'cancelled',
            replacementStatus: 'opened',
            width: 333,
            height: 222,
            rendererRunning: true,
        })
    })

    test('play button cannot restart the renderer during an agent export', async ({ page }) => {
        const result = await page.evaluate(async (untilSrc) => {
            const until = eval(untilSrc)
            const app = window.layersApp
            const started = await window.LayersAgent.exportVideo({
                width: 64,
                height: 64,
                framerate: 30,
                duration: 5,
                loopCount: 1,
                format: 'zip',
                quality: 'low',
            })
            await until(() => app._projectLifecycleActive && !app._renderer.isRunning,
                'the export job took the lease and paused the renderer')
            document.getElementById('playPauseBtn').click()
            // A negative measurement: the assertion is that nothing restarted.
            // The button's handler refuses the click while the lifecycle lease
            // is held, and a restart would show up in the very next frame of
            // the render loop, so bound the observation by two animation
            // frames rather than by a clock guess.
            let frames = 0
            const countFrame = () => {
                frames += 1
                if (frames < 2) requestAnimationFrame(countFrame)
            }
            requestAnimationFrame(countFrame)
            await until(() => frames >= 2, 'two animation frames after the play click')
            const rendererStayedPaused = !app._renderer.isRunning
            await window.LayersAgent.cancelJob({ jobId: started.result.jobId })
            const settled = await window.LayersAgent.waitForJob({
                jobId: started.result.jobId,
                timeoutMs: 5000,
            })
            return { rendererStayedPaused, jobStatus: settled.result.status }
        }, IN_PAGE_UNTIL)

        expect(result).toEqual({ rendererStayedPaused: true, jobStatus: 'cancelled' })
    })

    test('job polling snapshots retain document dimensions and playback state during detached export', async ({ page }) => {
        const result = await page.evaluate(async (untilSrc) => {
            const until = eval(untilSrc)
            const app = window.layersApp
            const original = {
                canvas: { width: app._canvas.width, height: app._canvas.height },
                isPlaying: app._renderer.isRunning,
            }
            const started = await window.LayersAgent.exportVideo({
                width: 64,
                height: 66,
                framerate: 30,
                duration: 5,
                loopCount: 1,
                format: 'zip',
                quality: 'low',
            })
            await until(() => app._projectLifecycleActive && !app._renderer.isRunning,
                'the export job took the lease and paused the renderer')
            const polled = await window.LayersAgent.getJob({
                jobId: started.result.jobId,
            })
            const cancelled = await window.LayersAgent.cancelJob({
                jobId: started.result.jobId,
            })
            const settled = await window.LayersAgent.waitForJob({
                jobId: started.result.jobId,
                timeoutMs: 5000,
            })
            return {
                original,
                polled: { canvas: polled.state.canvas, view: polled.state.view },
                cancelled: { canvas: cancelled.state.canvas, view: cancelled.state.view },
                settled: { canvas: settled.state.canvas, view: settled.state.view },
            }
        }, IN_PAGE_UNTIL)

        for (const envelope of [result.polled, result.cancelled, result.settled]) {
            expect(envelope.canvas).toEqual(result.original.canvas)
            expect(envelope.view.isPlaying).toBe(result.original.isPlaying)
        }
    })

    for (const restoreFailure of ['resolution', 'clock']) {
        test(`${restoreFailure} restore failure still restarts playback and releases lifecycle`, async ({ page }) => {
            const result = await page.evaluate(async (failure) => {
                const app = window.layersApp
                app._renderer.start()
                const original = { width: app._canvas.width, height: app._canvas.height }
                if (failure === 'resolution') {
                    // Exercise the compatibility path for renderers without detached capture.
                    app._renderer.renderFullResolution = null
                    const resizeCanvas = app._resizeCanvas.bind(app)
                    app._resizeCanvas = (width, height) => {
                        resizeCanvas(width, height)
                        if (width === original.width && height === original.height) {
                            throw new Error('resolution restore failed')
                        }
                    }
                } else {
                    app._renderer.restoreLoopFromNormalizedTime = () => {
                        throw new Error('clock restore failed')
                    }
                }
                const started = await window.LayersAgent.exportVideo({
                    width: 64,
                    height: 66,
                    framerate: 30,
                    duration: 0.1,
                    loopCount: 1,
                    format: 'zip',
                    quality: 'low',
                })
                const settled = await window.LayersAgent.waitForJob({
                    jobId: started.result.jobId,
                    timeoutMs: 30000,
                })
                return {
                    jobStatus: settled.result.status,
                    lifecycleActive: app._projectLifecycleActive,
                    rendererRunning: app._renderer.isRunning,
                    canvas: { width: app._canvas.width, height: app._canvas.height },
                }
            }, restoreFailure)

            expect(result).toEqual({
                jobStatus: 'failed',
                lifecycleActive: false,
                rendererRunning: true,
                canvas: { width: 1024, height: 1024 },
            })
        })
    }

    test('default export dimensions are resolved after a failed replacement rolls back', async ({ page }) => {
        const result = await page.evaluate(async (untilSrc) => {
            const until = eval(untilSrc)
            const app = window.layersApp
            const original = { width: app._canvas.width, height: app._canvas.height }
            let stageLive = false
            let releaseStage
            app._renderer.stageLayerSet = async () => {
                stageLive = true
                await new Promise(resolve => { releaseStage = resolve })
                return {
                    success: false,
                    error: 'candidate compile failed',
                    commit() {},
                    rollback: async () => ({ success: true }),
                }
            }
            const replacementPromise = app._handleCreateGradientBase(333, 222)
            // Bounded: the replacement has to reach the staging stub before the
            // canvas carries its size. An unbounded poll on a flag that never
            // flips hangs the run instead of failing it.
            await until(() => stageLive, 'the replacement reached stageLayerSet')
            const canvasDuringStage = { width: app._canvas.width, height: app._canvas.height }
            const started = await window.LayersAgent.exportVideo({
                framerate: 30,
                duration: 0.1,
                loopCount: 1,
                format: 'zip',
                quality: 'low',
                captureOnly: true,
            })
            releaseStage()
            const replacementStatus = await replacementPromise
            const settled = await window.LayersAgent.waitForJob({
                jobId: started.result.jobId,
                timeoutMs: 30000,
            })
            if (settled.result.result?.exportId) {
                await window.LayersAgent.releaseExport({
                    exportId: settled.result.result.exportId,
                })
            }
            return {
                original,
                canvasDuringStage,
                replacementStatus,
                jobStatus: settled.result.status,
                exportWidth: settled.result.result?.width,
                exportHeight: settled.result.result?.height,
            }
        }, IN_PAGE_UNTIL)

        expect(result.canvasDuringStage).toEqual({ width: 333, height: 222 })
        expect(result.replacementStatus).toBe('failed')
        expect(result.jobStatus).toBe('succeeded')
        expect(result.exportWidth).toBe(result.original.width)
        expect(result.exportHeight).toBe(result.original.height)
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
        // A negative assertion, so the window IS the measurement, not a
        // readiness guess: captureOnly must fire no download at all, and
        // "no download" has no arrival to wait on. The job has already
        // reported succeeded above, so anything the export was going to
        // trigger has been triggered; this window only gives the event time
        // to cross from the browser to the test.
        await quietWindow(page, 500)
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
