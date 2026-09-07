/**
 * Headless video exporter — frame-loop and encoder driver, no DOM.
 * Used by both the human-facing ExportVideoDialog and the agent's
 * `exportVideo` command.
 *
 * @module ui/video-exporter
 */

import { readRenderPixels } from '../utils/canvas-readback.js'

// One export at a time: the exporter pauses the shared renderer and seeks
// native video sources. The compatibility path also resizes the live canvas,
// so overlapping runs corrupt frames and restoration state. This module is the chokepoint for BOTH the
// export dialog and the agent's exportVideo command — the agent-side job
// guard cannot see a dialog-initiated export, so the refusal lives here.
let _exportInFlight = false

export async function runVideoExport(opts) {
    if (_exportInFlight) {
        const err = new Error('A video export is already running')
        err.code = 'CONFLICT_EXPORT_IN_PROGRESS'
        throw err
    }
    _exportInFlight = true
    try {
        return await runVideoExportInner(opts)
    } finally {
        _exportInFlight = false
    }
}

async function runVideoExportInner(opts) {
    const {
        settings, canvas, renderer, files,
        getResolution, setResolution,
        abortSignal, onProgress = () => {}
    } = opts

    const totalFrames = Math.ceil(settings.framerate * settings.duration * settings.loopCount)
    const wasRunning = renderer.isRunning
    const pausedNormalizedTime = renderer.getPausedNormalizedTime()

    const originalRes = getResolution()
    const captureOriginal = typeof renderer.renderFullResolution === 'function'
    let exportCanvas = canvas
    let captureSession = null
    const videos = typeof renderer.getVideoMediaIterator === 'function'
        ? [...renderer.getVideoMediaIterator()].map(({ videoElement, duration }) => ({
            element: videoElement, duration, currentTime: videoElement.currentTime, paused: videoElement.paused,
        })) : []
    if (videos.some(video => !Number.isFinite(video.duration) || video.duration <= 0)) {
        const error = new Error('Video export requires a finite source duration. Reimport a seekable video file with duration metadata.')
        error.code = 'VIDEO_DURATION_UNAVAILABLE'
        throw error
    }
    const videoOffsets = new Map(videos.map(video => [video.element,
        settings.playFrom === 'beginning' ? 0 : video.currentTime]))
    let stopRequested = false
    let started = false  // track whether encoder was started, for cleanup
    // Only restore resolution if we changed it. Without this flag, the finally
    // block snapshots `originalRes` at entry and unconditionally restores —
    // which clobbers any external resizeCanvas that happened to land mid-export.
    let wasResized = false

    try {
        if (wasRunning) {
            stopRequested = true
            renderer.stop()
        }
        for (const video of videos) video.element.pause()
        if (captureOriginal) {
            exportCanvas = document.createElement('canvas')
            exportCanvas.width = settings.width
            exportCanvas.height = settings.height
            if (typeof renderer.createFullResolutionCapture === 'function') {
                captureSession = await renderer.createFullResolutionCapture({ width: settings.width, height: settings.height })
            }
        }
        if (!captureOriginal && (settings.width !== originalRes.width || settings.height !== originalRes.height)) {
            wasResized = true
            setResolution(settings.width, settings.height)
            await waitFrame()
        }

        if (settings.playFrom === 'beginning') {
            await seekAllVideos(renderer, 0, abortSignal)
        }

        if (abortSignal?.aborted) throw cancelledError()

        const exportSettings = {
            width: settings.width,
            height: settings.height,
            framerate: settings.framerate,
            videoQuality: settings.quality,
            totalFrames,
            // captureOnly suppresses the browser download in files.js — the
            // returned bytes / blob URL ride out via runVideoExport's result.
            captureOnly: !!settings.captureOnly,
            captureFilename: settings.captureFilename || null
        }

        if (settings.format === 'mp4') {
            await files.startRecordingMP4(exportCanvas, exportSettings)
        } else {
            await files.saveZip(exportSettings)
        }
        started = true

        const frameDurationMs = 1000 / settings.framerate
        const exportDurationSec = settings.duration
        const timeOffset = settings.playFrom === 'beginning' ? 0 : pausedNormalizedTime

        onProgress(0, totalFrames, 'exporting')

        for (let n = 0; n < totalFrames; n++) {
            if (abortSignal?.aborted) {
                if (settings.format === 'mp4') await files.cancelMP4()
                else files.cancelZIP()
                started = false
                const err = new Error('Export cancelled')
                err.code = 'JOB_CANCELLED'
                throw err
            }

            const targetTimeSec = (n * frameDurationMs) / 1000
            const timeInLoop = targetTimeSec % exportDurationSec
            const baseNormalizedTime = timeInLoop / exportDurationSec
            const normalizedTime = (baseNormalizedTime + timeOffset) % 1

            await seekAllVideos(renderer, targetTimeSec, abortSignal, videoOffsets)
            renderer.updateVideoTextures()
            if (captureOriginal) {
                const frame = captureSession ? await captureSession.render(normalizedTime)
                    : await renderer.renderFullResolution({
                        width: settings.width, height: settings.height, normalizedTime,
                    })
                if (!frame || frame.width !== settings.width || frame.height !== settings.height) {
                    throw new Error('Full-resolution video capture returned incorrect frame dimensions')
                }
                const context = exportCanvas.getContext('2d')
                if (!context) throw new Error('Could not allocate the video export frame')
                context.clearRect(0, 0, exportCanvas.width, exportCanvas.height)
                context.drawImage(frame, 0, 0)
            } else {
                renderer.render(normalizedTime)
            }
            await waitFrame()
            if (abortSignal?.aborted) throw cancelledError()

            if (settings.format === 'mp4') {
                await files.encodeVideoFrame(exportCanvas, {
                    framerate: settings.framerate,
                    videoQuality: settings.quality
                })
            } else {
                const pixels = readRenderPixels(exportCanvas, 0, 0, exportCanvas.width, exportCanvas.height)
                await files.addZipFrame(pixels, {
                    width: exportCanvas.width,
                    height: exportCanvas.height,
                    totalFrames
                })
            }

            if (n % 5 === 0) {
                onProgress(n, totalFrames, 'exporting')
                await new Promise(r => setTimeout(r, 0))
            }
        }

        // Abort check between the frame loop and finalize: a late cancel
        // after the last frame would otherwise still produce a completed
        // download because endRecordingMP4 runs uninterrupted.
        if (abortSignal?.aborted) {
            if (settings.format === 'mp4') await files.cancelMP4()
            else files.cancelZIP()
            started = false
            const err = new Error('Export cancelled')
            err.code = 'JOB_CANCELLED'
            throw err
        }

        onProgress(totalFrames, totalFrames, 'finalizing')
        // captureOnly: endRecording* returns the blob URL + filename instead
        // of triggering a download. Forwarded out via the result object so
        // the agent (or MCP sidecar) can fetch the bytes from the URL.
        let capture = null
        if (settings.format === 'mp4') {
            capture = await files.endRecordingMP4()
        } else {
            // Wait for the zipWorker's `done` event so the job doesn't settle
            // 'succeeded' before the file is assembled and either the
            // download is triggered or the bytes are surfaced. Without this,
            // an agent reading recentExports right after the job settled
            // would race the worker.
            capture = await files.endRecordingZip()
        }
        started = false

        const result = {
            format: settings.format,
            width: settings.width,
            height: settings.height,
            framerate: settings.framerate,
            durationSec: settings.duration * settings.loopCount,
            totalFrames
        }
        if (settings.captureOnly && capture) {
            // blobUrl is an object URL the caller can fetch(); blob is the
            // raw Blob (mp4 only — ZIP path has no blob handle on this side,
            // only the URL, because the worker generated and revoked its
            // own Blob inside the worker scope).
            result.blobUrl = capture.blobUrl
            result.captureFilename = capture.filename
            if (capture.blob) result.blob = capture.blob
        }
        return result
    } catch (err) {
        // Best-effort cleanup if encoder was started but loop didn't reach end
        if (started) {
            try {
                if (settings.format === 'mp4') await files.cancelMP4()
                else files.cancelZIP()
            } catch (_) { /* swallow cleanup errors */ }
        }
        throw err
    } finally {
        let restoreError = null
        const attemptRestore = async (restore) => {
            try {
                await restore()
            } catch (err) {
                if (!restoreError) restoreError = err
            }
        }
        if (captureSession) await attemptRestore(() => captureSession.dispose())
        if (wasResized) {
            await attemptRestore(() => setResolution(originalRes.width, originalRes.height))
        }
        for (const video of videos) {
            await attemptRestore(() => seekVideo(video.element, video.currentTime))
        }
        await attemptRestore(() => renderer.updateVideoTextures())
        if (stopRequested) {
            await attemptRestore(() => renderer.restoreLoopFromNormalizedTime(pausedNormalizedTime))
            await attemptRestore(() => renderer.start())
        } else {
            await attemptRestore(() => renderer.render(pausedNormalizedTime))
        }
        for (const video of videos) {
            if (!video.paused) await attemptRestore(() => video.element.play())
        }
        if (restoreError) throw restoreError
    }
}

function cancelledError() {
    const error = new Error('Export cancelled')
    error.code = 'JOB_CANCELLED'
    return error
}

async function seekAllVideos(renderer, timeSec, abortSignal, offsets = new Map()) {
    if (typeof renderer.getVideoMediaIterator !== 'function') return
    await Promise.all([...renderer.getVideoMediaIterator()].map(({ videoElement, duration }) => {
        const absoluteTime = timeSec + (offsets.get(videoElement) || 0)
        const time = Number.isFinite(duration) && duration > 0 ? absoluteTime % duration : absoluteTime
        return seekVideo(videoElement, time, abortSignal)
    }))
}

function seekVideo(video, time, abortSignal) {
    if (abortSignal?.aborted) return Promise.reject(cancelledError())
    if (!video.seeking && Math.abs(video.currentTime - time) <= 0.000001) return Promise.resolve()
    return new Promise((resolve, reject) => {
        const cleanup = () => {
            clearTimeout(timer)
            video.removeEventListener('seeked', onSeeked)
            video.removeEventListener('error', onError)
            abortSignal?.removeEventListener('abort', onAbort)
        }
        const finish = error => { cleanup(); error ? reject(error) : resolve() }
        const onSeeked = () => finish()
        const onError = () => finish(new Error('Video frame seeking failed'))
        const onAbort = () => finish(cancelledError())
        const timer = setTimeout(() => finish(new Error('Timed out seeking a video frame')), 10000)
        video.addEventListener('seeked', onSeeked)
        video.addEventListener('error', onError)
        abortSignal?.addEventListener('abort', onAbort, { once: true })
        try { video.currentTime = time } catch (error) { finish(error) }
    })
}

function waitFrame() {
    return new Promise(resolve => requestAnimationFrame(resolve))
}
