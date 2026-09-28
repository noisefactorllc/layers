import { test, expect } from './fixtures.js'
import { appReady } from './waits.js'

// MP4 export failure-path hardening: fatal WebCodecs encoder errors and an
// empty Mediabunny buffer previously produced a "successful" export with no
// usable file (encoder errors were console-only; a null buffer returned null
// from endRecordingMP4). These specs pin the new behavior: the export fails
// with an actionable error and the encoder state is cleaned up.

const MP4_SETTINGS = {
    width: 64, height: 64, framerate: 30, duration: 0.1,
    loopCount: 1, format: 'mp4', quality: 'low'
}

async function waitForSettledJob(page, jobId) {
    return page.evaluate(id =>
        window.LayersAgent.waitForJob({ jobId: id, timeoutMs: 30000 }), jobId)
}

test.describe('video export failure paths (mp4)', () => {
    test('fatal VideoEncoder error fails the export with an actionable message', async ({ page }) => {
        // Install a stub encoder before the app loads so startRecordingMP4's
        // typeof guard sees it. The stub reports a fatal error right after
        // the first frame, like a real WebCodecs fatal failure would.
        await page.addInitScript(() => {
            window.__encoderInstances = []
            window.VideoEncoder = class {
                constructor(opts) {
                    this._opts = opts
                    window.__encoderInstances.push(this)
                }
                configure() {}
                encode() {
                    setTimeout(() => this._opts.error(new Error('simulated fatal encode error')), 0)
                }
                flush() { return Promise.resolve() }
                close() {}
            }
        })
        await page.goto('/')
        await page.evaluate(() => window.LayersAgent.ready)

        const r = await page.evaluate(s => window.LayersAgent.exportVideo(s), MP4_SETTINGS)
        expect(r.ok).toBe(true)

        const final = await waitForSettledJob(page, r.result.jobId)
        expect(final.result.status).toBe('failed')
        expect(final.result.error.code).toBe('VIDEO_EXPORT_ENCODE_FAILED')
        expect(final.result.error.message).toContain('simulated fatal encode error')
        expect(final.result.error.message).toContain('ZIP')

        // No export is recorded for a failed run, and encoder state is reset.
        const state = await page.evaluate(() => window.LayersAgent.getState({}))
        expect(state.state.recentExports.filter(e => e.format === 'mp4')).toEqual([])

        const encoderState = await page.evaluate(() => {
            const files = window.LayersAgent._app._files
            return { ready: files.ready, encoder: files.videoEncoder, target: files.mp4Target }
        })
        expect(encoderState.ready).toBe(false)
        expect(encoderState.encoder).toBeNull()
        expect(encoderState.target).toBeNull()
    })

    test('an empty MP4 buffer fails the export instead of reporting success', async ({ page }) => {
        await page.goto('/')
        await page.evaluate(() => window.LayersAgent.ready)

        // Swap in a recording that ends with an empty Mediabunny target —
        // the shape a mid-export encoder failure used to leave behind —
        // and stub the frame encoder so no real WebCodecs is needed.
        await page.evaluate(() => {
            const files = window.LayersAgent._app._files
            // No real WebCodecs needed: the frame encoder is stubbed and the
            // recording ends on an empty target — the shape a mid-export
            // encoder failure used to leave behind.
            files.encodeVideoFrame = () => {}
            files.startRecordingMP4 = async () => {
                files.recording = true
                files.ready = true
                files._mp4CaptureOnly = false
                files._mp4CaptureFilename = null
                files._mp4EncoderError = null
                files.videoEncoder = null
                files.videoSource = null
                files.pendingVideoPacketPromise = Promise.resolve()
                files.output = null
                files.mp4Target = { get buffer() { return null } }
                files.videoPacketsAdded = 0
                files.videoPacketsAddFailed = 0
            }
        })

        const r = await page.evaluate(s => window.LayersAgent.exportVideo(s), MP4_SETTINGS)
        expect(r.ok).toBe(true)

        const final = await waitForSettledJob(page, r.result.jobId)
        expect(final.result.status).toBe('failed')
        expect(final.result.error.code).toBe('VIDEO_EXPORT_EMPTY')
        expect(final.result.error.message).toContain('no video data')
        expect(final.result.error.message).toContain('ZIP')

        // Encoder state was reset by the failure cleanup.
        const encoderState = await page.evaluate(() => {
            const files = window.LayersAgent._app._files
            return { ready: files.ready, encoder: files.videoEncoder, target: files.mp4Target }
        })
        expect(encoderState.ready).toBe(false)
        expect(encoderState.encoder).toBeNull()
        expect(encoderState.target).toBeNull()
    })

    test('a healthy MP4 export still succeeds after the hardening', async ({ page }) => {
        await page.goto('/')
        await page.evaluate(() => window.LayersAgent.ready)

        const canEncode = await page.evaluate(() => typeof VideoEncoder !== 'undefined')
        test.skip(!canEncode, 'this engine exposes no WebCodecs VideoEncoder')

        // Capture-only so no browser download fires during the run.
        const r = await page.evaluate(s => window.LayersAgent.exportVideo({
            ...s,
            captureOnly: true
        }), MP4_SETTINGS)
        expect(r.ok).toBe(true)

        const final = await waitForSettledJob(page, r.result.jobId)
        expect(final.result.status).toBe('succeeded')
        expect(final.result.result.blobUrl).toBeTruthy()
        expect(final.result.result.totalFrames).toBeGreaterThan(0)

        await page.evaluate(id => window.LayersAgent.releaseExport({ exportId: id }),
            final.result.result.exportId)
    })
})
