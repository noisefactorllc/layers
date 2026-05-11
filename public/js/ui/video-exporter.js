/**
 * Headless video exporter — frame-loop and encoder driver, no DOM.
 * Used by both the human-facing ExportVideoDialog and the agent's
 * `exportVideo` command.
 *
 * @module ui/video-exporter
 */

export async function runVideoExport(opts) {
    const {
        settings, canvas, renderer, files,
        getResolution, setResolution,
        abortSignal, onProgress = () => {}
    } = opts

    const totalFrames = Math.ceil(settings.framerate * settings.duration * settings.loopCount)
    const wasRunning = renderer.isRunning
    let pausedNormalizedTime = 0

    if (wasRunning) {
        pausedNormalizedTime = renderer.getPausedNormalizedTime()
        renderer.stop()
    }

    const originalRes = getResolution()
    let started = false  // track whether encoder was started, for cleanup
    // Only restore resolution if we changed it. Without this flag, the finally
    // block snapshots `originalRes` at entry and unconditionally restores —
    // which clobbers any external resizeCanvas that happened to land mid-export.
    let wasResized = false

    try {
        if (settings.width !== originalRes.width || settings.height !== originalRes.height) {
            setResolution(settings.width, settings.height)
            wasResized = true
            await waitFrame()
        }

        if (settings.playFrom === 'beginning') {
            await seekAllVideos(renderer, 0)
        }

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
            await files.startRecordingMP4(canvas, exportSettings)
        } else {
            files.saveZip(exportSettings)
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

            await seekAllVideos(renderer, targetTimeSec)
            renderer.updateVideoTextures()
            renderer.render(normalizedTime)
            await waitFrame()

            if (settings.format === 'mp4') {
                files.encodeVideoFrame(canvas, {
                    framerate: settings.framerate,
                    videoQuality: settings.quality
                })
            } else {
                const gl = canvas.getContext('webgl2')
                if (gl) {
                    const pixels = new Uint8Array(canvas.width * canvas.height * 4)
                    gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels)
                    files.addZipFrame(pixels, {
                        width: canvas.width,
                        height: canvas.height,
                        totalFrames
                    })
                }
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
        if (wasResized) {
            setResolution(originalRes.width, originalRes.height)
        }
        if (wasRunning) {
            renderer.restoreLoopFromNormalizedTime(pausedNormalizedTime)
            renderer.start()
        }
    }
}

async function seekAllVideos(renderer, timeSec) {
    if (typeof renderer.getVideoMediaIterator !== 'function') return
    const promises = []
    for (const { videoElement, duration } of renderer.getVideoMediaIterator()) {
        const seekTime = timeSec % duration
        if (Math.abs(videoElement.currentTime - seekTime) > 0.01) {
            promises.push(new Promise(resolve => {
                const onSeeked = () => {
                    videoElement.removeEventListener('seeked', onSeeked)
                    resolve()
                }
                videoElement.addEventListener('seeked', onSeeked)
                videoElement.currentTime = seekTime
            }))
        }
    }
    await Promise.all(promises)
}

function waitFrame() {
    return new Promise(resolve => requestAnimationFrame(resolve))
}
