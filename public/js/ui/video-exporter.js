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
    const inner = renderer._renderer
    const wasRunning = renderer.isRunning
    let pausedNormalizedTime = 0

    if (wasRunning) {
        const elapsedSeconds = (performance.now() - inner._loopStartTime) / 1000
        pausedNormalizedTime = (elapsedSeconds % inner._loopDuration) / inner._loopDuration
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
            totalFrames
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
            renderer._updateVideoTextures()
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
        if (settings.format === 'mp4') {
            await files.endRecordingMP4()
        }
        started = false

        return {
            format: settings.format,
            width: settings.width,
            height: settings.height,
            framerate: settings.framerate,
            durationSec: settings.duration * settings.loopCount,
            totalFrames
        }
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
            const now = performance.now()
            const pausedElapsedSeconds = pausedNormalizedTime * inner._loopDuration
            inner._loopStartTime = now - (pausedElapsedSeconds * 1000)
            renderer.start()
        }
    }
}

async function seekAllVideos(renderer, timeSec) {
    const mediaTextures = renderer._mediaTextures
    if (!mediaTextures) return
    const promises = []
    for (const [, media] of mediaTextures) {
        if (media.type !== 'video') continue
        const video = media.element
        if (video.duration && isFinite(video.duration)) {
            const seekTime = timeSec % video.duration
            if (Math.abs(video.currentTime - seekTime) > 0.01) {
                promises.push(new Promise(resolve => {
                    const onSeeked = () => {
                        video.removeEventListener('seeked', onSeeked)
                        resolve()
                    }
                    video.addEventListener('seeked', onSeeked)
                    video.currentTime = seekTime
                }))
            }
        }
    }
    await Promise.all(promises)
}

function waitFrame() {
    return new Promise(resolve => requestAnimationFrame(resolve))
}
