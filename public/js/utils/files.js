/**
 * Files - MP4/ZIP recording and image export
 * Ported from Noisedeck, adapted for Layers.
 *
 * @module utils/files
 */

import { Output, Mp4OutputFormat, BufferTarget, EncodedVideoPacketSource, EncodedPacket } from '../lib/mediabunny.min.mjs'

export class Files {
    constructor() {
        this.ready = false
        this.currentFrame = 0

        this._initZipWorker()
        this._resetMP4State()

        this.videoPacketsAdded = 0
        this.videoPacketsAddFailed = 0
    }

    _initZipWorker() {
        this.zipWorker = new Worker('./js/lib/zipWorker.js')
        // Tracks the in-flight zip recording so endRecordingZip() can await
        // the worker's `done` event before the export job settles. Replaces
        // the previous fire-and-forget model where the worker would post
        // `done` long after the caller assumed the export succeeded.
        this._zipDonePromise = null
        this._zipDoneResolve = null
        this._zipDoneReject = null
        this.zipWorker.onmessage = (msg) => {
            if (msg.data.ready) {
                this.ready = true
            } else if (msg.data.doneRecording) {
                this.createZip()
            } else if (msg.data.done) {
                this.downloadFile(msg.data.url, 'zip')
                if (this._zipDoneResolve) {
                    this._zipDoneResolve()
                    this._zipDoneResolve = null
                    this._zipDoneReject = null
                    this._zipDonePromise = null
                }
            }
        }
    }

    _resetMP4State() {
        this.output = null
        this.videoSource = null
        this.mp4Target = null
        this.pendingVideoPacketPromise = Promise.resolve()
        this.videoEncoder = null
        this.startTime = null
        this.recording = false
        this.lastKeyFrame = null
        this.framesGenerated = 0
        this.ready = false
    }

    saveImage(canvas, type, quality = 1) {
        const mimeTypes = { jpg: 'image/jpeg', webp: 'image/webp' }
        const mimeType = mimeTypes[type] || 'image/png'
        const url = canvas.toDataURL(mimeType, quality)
        this.downloadFile(url, type)
    }

    calculateBitrate(settings) {
        const motionFactors = {
            'low': 0.02,
            'medium': 0.04,
            'high': 0.07,
            'very high': 0.1,
            'ultra': 0.15
        }
        const compressionRatio = 0.1
        return settings.width * settings.height * settings.framerate * motionFactors[settings.videoQuality] / compressionRatio
    }

    async startRecordingMP4(canvas, settings) {
        if (typeof VideoEncoder === 'undefined') {
            throw new Error('Browser does not support VideoEncoder / WebCodecs API')
        }

        this.mp4Target = new BufferTarget()
        this.output = new Output({
            format: new Mp4OutputFormat({ fastStart: 'reserve' }),
            target: this.mp4Target
        })

        this.videoSource = new EncodedVideoPacketSource('avc')
        const estimatedFrames = settings?.totalFrames ?? 0
        const SAFETY_MULTIPLIER = 6
        const maximumPacketCount = Math.max(60, Math.ceil(estimatedFrames * SAFETY_MULTIPLIER)) || 600

        await this.output.addVideoTrack(this.videoSource, {
            frameRate: settings.framerate,
            maximumPacketCount
        })
        await this.output.start()

        this.pendingVideoPacketPromise = Promise.resolve()

        this.videoEncoder = new VideoEncoder({
            output: (chunk, meta) => {
                if (!this.videoSource) return
                const packet = EncodedPacket.fromEncodedChunk(chunk)
                this.pendingVideoPacketPromise = this.pendingVideoPacketPromise
                    .then(() => this.videoSource.add(packet, meta))
                    .then(() => { this.videoPacketsAdded++ })
                    .catch((error) => {
                        this.videoPacketsAddFailed++
                        console.error('Failed to add video packet', error)
                    })
            },
            error: e => console.error(e)
        })
        this.videoEncoder.configure({
            codec: 'avc1.4d0034',
            width: canvas.width,
            height: canvas.height,
            bitrate: this.calculateBitrate(settings)
        })

        this.startTime = document.timeline.currentTime
        this.recording = true
        this.lastKeyFrame = -Infinity
        this.framesGenerated = 0
        this.ready = true
    }

    encodeVideoFrame(canvas, settings) {
        const frameIndex = this.framesGenerated
        const timestampUs = Math.round(frameIndex * (1e6 / settings.framerate))
        const frame = new VideoFrame(canvas, {
            timestamp: timestampUs,
            duration: Math.round(1e6 / settings.framerate)
        })
        this.framesGenerated++

        const framesPerKeySpan = Math.max(1, Math.round(settings.framerate * 5))
        const forcePerFrameKeyFrame = settings?.videoQuality === 'ultra'
        const needsKeyFrame = forcePerFrameKeyFrame || (frameIndex % framesPerKeySpan === 0)
        this.videoEncoder.encode(frame, { keyFrame: needsKeyFrame })
        frame.close()
    }

    async endRecordingMP4() {
        this.recording = false

        await this.videoEncoder?.flush()
        this.videoEncoder?.close()

        try {
            await this.pendingVideoPacketPromise
        } catch (error) {
            console.error('Failed to add video packet', error)
        }

        if (this.output) {
            await this.output.finalize()
        }

        const buffer = this.mp4Target?.buffer
        if (buffer) {
            const url = window.URL.createObjectURL(new Blob([buffer]))
            this.downloadFile(url, 'mp4')
        } else {
            console.error('Unable to retrieve MP4 buffer from Mediabunny target')
        }

        this._resetMP4State()
    }

    async cancelMP4() {
        try {
            this.videoEncoder?.close()
        } catch (error) {
            console.error('Error closing video encoder', error)
        }

        this._resetMP4State()
        this.currentFrame = 0
    }

    saveZip(settings) {
        // Install a fresh awaitable for the in-flight recording. The export
        // pipeline calls endRecordingZip() after the last frame and awaits
        // this promise so the job doesn't settle 'succeeded' until the
        // worker has assembled the zip blob and triggered the download.
        this._zipDonePromise = new Promise((resolve, reject) => {
            this._zipDoneResolve = resolve
            this._zipDoneReject = reject
        })
        // Swallow unhandled rejection if the caller never awaits the promise
        // (e.g. an early throw before endRecordingZip is reached).
        this._zipDonePromise.catch(() => {})
        this.zipWorker.postMessage({ settings })
    }

    addZipFrame(pixels, settings) {
        this.zipWorker.postMessage({ settings, pixels })
    }

    createZip() {
        this.ready = false
    }

    /**
     * Await the zipWorker's `done` event for the in-flight recording.
     * Resolves once the worker has assembled the zip and the download has
     * been triggered; rejects with a JOB_CANCELLED-shaped error if
     * cancelZIP() runs while the recording is still in flight.
     * @returns {Promise<void>}
     */
    async endRecordingZip() {
        if (!this._zipDonePromise) return
        await this._zipDonePromise
    }

    cancelZIP() {
        // Snapshot the awaiter before _initZipWorker() resets the handles,
        // then reject so runVideoExport's await unwinds promptly.
        const reject = this._zipDoneReject
        if (this.zipWorker) {
            this.zipWorker.terminate()
            this._initZipWorker()
        }
        if (reject) {
            const err = new Error('Export cancelled')
            err.code = 'JOB_CANCELLED'
            reject(err)
        }
        this.currentFrame = 0
        this.ready = false
    }

    downloadFile(url, extension) {
        const a = document.createElement('a')
        a.href = url
        a.setAttribute('download', `layers-${Date.now().toString()}.${extension}`)
        a.click()
    }
}
