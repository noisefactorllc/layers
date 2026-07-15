/**
 * Export Video Dialog
 * Frame-accurate video export with MP4/ZIP output.
 * Ported from Noisedeck ExportMode, adapted for Layers' video layer seeking.
 *
 * @module ui/export-video-dialog
 */

import { runVideoExport } from './video-exporter.js'
import { MAX_EXPORT_FRAMES } from '../agent/limits.js'

export class ExportVideoDialog {
    constructor(options) {
        this.files = options.files
        this.renderer = options.renderer
        this.canvas = options.canvas
        this.getResolution = options.getResolution
        this.setResolution = options.setResolution
        this.acquireMutation = options.acquireMutation || (() => ({ release() {} }))
        this.acquireSnapshotOverride = options.acquireSnapshotOverride
            || (() => ({ release() {} }))
        this.getProjectGeneration = options.getProjectGeneration || (() => 0)
        this.onComplete = options.onComplete || (() => {})
        this.onCancel = options.onCancel || (() => {})

        this.state = 'idle'
        this.currentFrame = 0
        this.totalFrames = 0
        this.abortController = null
        this.wasRunning = false
        this.pausedNormalizedTime = 0
        this.startTime = 0
        this._projectGeneration = 0
        this._pausedForExport = false

        this._dialog = null
        this._elements = {}

        this._handleKeydown = this._handleKeydown.bind(this)
        this._handleDialogClick = this._handleDialogClick.bind(this)
        // Stable handler refs so _addEventListeners/_removeEventListeners pair up.
        // The dialog reuses the same DOM nodes across every open/close, so fresh
        // anonymous closures would stack up (leak + duplicate firing) on each open.
        this._handleInputChange = () => this._updateCalculations()
        this._handleBeginClick = () => this.beginExport()
        this._handleCancelClick = () => this.cancel()
    }

    _cacheElements() {
        this._dialog = document.getElementById('exportModal')
        if (!this._dialog) return false

        this._elements = {
            widthInput: document.getElementById('exportWidth'),
            heightInput: document.getElementById('exportHeight'),
            framerateSelect: document.getElementById('exportFramerate'),
            durationInput: document.getElementById('exportDuration'),
            loopCountInput: document.getElementById('exportLoopCount'),
            formatSelect: document.getElementById('exportFormat'),
            qualitySelect: document.getElementById('exportQuality'),
            playFromSelect: document.getElementById('exportPlayFrom'),
            totalFramesDisplay: document.getElementById('exportTotalFrames'),
            estimatedSizeDisplay: document.getElementById('exportEstimatedSize'),
            beginBtn: document.getElementById('exportBeginBtn'),
            cancelBtn: document.getElementById('exportCancelBtn'),
            dialogView: document.getElementById('exportDialogView'),
            progressView: document.getElementById('exportProgressView'),
            progressBar: document.getElementById('exportProgressBar'),
            progressText: document.getElementById('exportProgressText'),
            progressElapsed: document.getElementById('exportProgressElapsed'),
            progressRemaining: document.getElementById('exportProgressRemaining'),
            progressCancelBtn: document.getElementById('exportProgressCancelBtn')
        }
        return true
    }

    open() {
        if (!this._cacheElements()) return

        this.state = 'dialog'
        this._projectGeneration = this.getProjectGeneration()

        const res = this.getResolution()
        this._elements.widthInput.value = res.width
        this._elements.heightInput.value = res.height

        this._loadPreferences()
        this._updateCalculations()

        this._elements.dialogView.style.display = 'block'
        this._elements.progressView.style.display = 'none'

        this._addEventListeners()
        this._dialog.showModal()
    }

    close() {
        if (!this._dialog) return
        this._removeEventListeners()
        this._dialog.close()

        this.state = 'idle'
    }

    _restoreRendererAfterExport() {
        if (!this._pausedForExport) return
        try {
            this.renderer.restoreLoopFromNormalizedTime(this.pausedNormalizedTime)
        } finally {
            try {
                this.renderer.start()
            } finally {
                this._pausedForExport = false
            }
        }
    }

    _completeSuccessfulExport(format) {
        try {
            this.close()
        } catch (err) {
            this.state = 'idle'
            console.error('Failed to close video export dialog:', err)
        }
        try {
            this.onComplete(format)
        } catch (err) {
            console.error('Failed to report completed video export:', err)
        }
    }

    async beginExport() {
        if (this.state !== 'dialog') return
        if (this._projectGeneration !== this.getProjectGeneration()) {
            this.close()
            this.onCancel()
            return
        }
        let settings
        try {
            settings = this._gatherSettings({ reportValidation: true })
        } catch (err) {
            console.error('Invalid video export settings:', err)
            return
        }
        const mutationToken = this.acquireMutation()
        if (!mutationToken) return

        let completed = false
        let restoreError = null
        let snapshotToken = null
        try {
            snapshotToken = this.acquireSnapshotOverride()
            this.wasRunning = this.renderer.isRunning
            this._pausedForExport = false
            if (this.wasRunning) {
                const pausedNormalizedTime = this.renderer.getPausedNormalizedTime()
                this.renderer.stop()
                this.pausedNormalizedTime = pausedNormalizedTime
                this._pausedForExport = true
            }

            this.state = 'preparing'
            this.abortController = new AbortController()

            this.totalFrames = Math.ceil(settings.framerate * settings.duration * settings.loopCount)
            this.currentFrame = 0
            this.startTime = performance.now()

            this._savePreferences(settings)
            this._elements.dialogView.style.display = 'none'
            this._elements.progressView.style.display = 'block'
            this._updateProgress()

            this.state = 'exporting'
            await runVideoExport({
                settings,
                canvas: this.canvas,
                renderer: this.renderer,
                files: this.files,
                getResolution: this.getResolution,
                setResolution: this.setResolution,
                abortSignal: this.abortController.signal,
                onProgress: (current, total, _phase) => {
                    this.currentFrame = current
                    this.totalFrames = total
                    this._updateProgress()
                }
            })
            completed = true
        } catch (err) {
            if (err?.code === 'JOB_CANCELLED') {
                this.close()
                this.onCancel()
            } else {
                console.error('Export failed:', err)
                this._handleExportError(err)
            }
        } finally {
            try {
                this._restoreRendererAfterExport()
            } catch (err) {
                restoreError = err
                console.error('Failed to restore renderer after export:', err)
            } finally {
                try {
                    snapshotToken?.release()
                } finally {
                    mutationToken.release()
                }
            }
        }
        if (!completed) return
        if (restoreError) {
            this._handleExportError(restoreError)
            return
        }
        this._completeSuccessfulExport(settings.format)
    }

    async cancel() {
        if (this.state === 'dialog') {
            this.close()
            return
        }
        if (this.state !== 'preparing' && this.state !== 'exporting') return
        this.abortController?.abort()
        // The runner's catch block + beginExport's catch above handle cleanup + close.
    }

    _ensureEven(value) {
        const floored = Math.floor(value)
        return Math.max(2, floored - (floored % 2))
    }

    _readBoundedNumber(input, label, {
        min,
        max,
        integer = false,
        step = null,
        reportValidation = false,
    }) {
        const value = Number(input.value)
        input.setCustomValidity('')
        const onStep = step === null || Number.isInteger((value - min) / step)
        if (Number.isFinite(value) && value >= min && value <= max
            && (!integer || Number.isInteger(value)) && onStep) {
            return value
        }

        const qualifier = integer ? 'whole number' : 'number'
        const message = `${label} must be a ${qualifier} from ${min} to ${max}`
        input.setCustomValidity(message)
        if (reportValidation) input.reportValidity()
        throw new RangeError(message)
    }

    _gatherSettings({ reportValidation = false } = {}) {
        const width = this._readBoundedNumber(this._elements.widthInput, 'Width', {
            min: 64, max: 4096, integer: true, reportValidation,
        })
        const height = this._readBoundedNumber(this._elements.heightInput, 'Height', {
            min: 64, max: 4096, integer: true, reportValidation,
        })
        const framerate = this._readBoundedNumber(
            this._elements.framerateSelect, 'Framerate', {
                min: 24, max: 60, integer: true, reportValidation,
            })
        const duration = this._readBoundedNumber(this._elements.durationInput, 'Duration', {
            min: 1, max: 300, step: 0.5, reportValidation,
        })
        const loopCount = this._readBoundedNumber(
            this._elements.loopCountInput, 'Loop count', {
                min: 1, max: 10, integer: true, reportValidation,
            })
        const totalFrames = Math.ceil(framerate * duration * loopCount)
        if (totalFrames > MAX_EXPORT_FRAMES) {
            const message = `Total frames must not exceed ${MAX_EXPORT_FRAMES}`
            this._elements.loopCountInput.setCustomValidity(message)
            if (reportValidation) this._elements.loopCountInput.reportValidity()
            throw new RangeError(message)
        }

        return {
            width: this._ensureEven(width),
            height: this._ensureEven(height),
            framerate,
            duration,
            loopCount,
            format: this._elements.formatSelect.value || 'mp4',
            quality: this._elements.qualitySelect.value || 'very high',
            playFrom: this._elements.playFromSelect?.value || 'beginning'
        }
    }

    _updateCalculations() {
        let settings
        try {
            settings = this._gatherSettings()
        } catch {
            this._elements.totalFramesDisplay.textContent = 'Invalid settings'
            this._elements.estimatedSizeDisplay.textContent = '—'
            return
        }
        const totalFrames = Math.ceil(settings.framerate * settings.duration * settings.loopCount)

        this._elements.totalFramesDisplay.textContent = `${totalFrames} frames`

        const pixels = settings.width * settings.height
        const qualityMultiplier = { 'low': 0.2, 'medium': 0.4, 'high': 0.6, 'very high': 0.8, 'ultra': 1.0 }
        const bytesPerFrame = (pixels / 1000) * 0.5 * (qualityMultiplier[settings.quality] || 0.8)
        const estimatedBytes = bytesPerFrame * totalFrames * 1024

        const sizeStr = estimatedBytes < 1024 * 1024
            ? `~${Math.round(estimatedBytes / 1024)} KB`
            : `~${(estimatedBytes / (1024 * 1024)).toFixed(1)} MB`
        this._elements.estimatedSizeDisplay.textContent = sizeStr
    }

    _updateProgress() {
        const percent = this.totalFrames > 0 ? (this.currentFrame / this.totalFrames) * 100 : 0

        this._elements.progressBar.style.width = `${percent}%`
        this._elements.progressText.textContent = `Frame ${this.currentFrame} of ${this.totalFrames}`

        const elapsed = performance.now() - this.startTime
        this._elements.progressElapsed.textContent = this._formatTime(elapsed)

        if (this.currentFrame > 0) {
            const msPerFrame = elapsed / this.currentFrame
            const remainingMs = msPerFrame * (this.totalFrames - this.currentFrame)
            this._elements.progressRemaining.textContent = this._formatTime(remainingMs)
        } else {
            this._elements.progressRemaining.textContent = '--:--'
        }
    }

    _formatTime(ms) {
        const totalSeconds = Math.floor(ms / 1000)
        const minutes = Math.floor(totalSeconds / 60)
        const seconds = totalSeconds % 60
        return `${minutes}:${seconds.toString().padStart(2, '0')}`
    }

    _handleExportError(err) {
        this._elements.progressText.textContent = `Error: ${err.message}`
        this._elements.progressBar.style.background = 'var(--red, #e74c3c)'
        // Was a 3-second hold before close. Now: close after a short
        // confirmation pulse so the user sees the error but the UI doesn't
        // appear frozen. 800ms is enough to register the red bar but short
        // enough to feel responsive.
        setTimeout(() => {
            this.close()
            this.onCancel()
        }, 800)
    }

    _getCalcInputs() {
        return [
            this._elements.widthInput,
            this._elements.heightInput,
            this._elements.framerateSelect,
            this._elements.durationInput,
            this._elements.loopCountInput,
            this._elements.qualitySelect
        ].filter(Boolean)
    }

    _addEventListeners() {
        for (const input of this._getCalcInputs()) {
            input.addEventListener('input', this._handleInputChange)
            input.addEventListener('change', this._handleInputChange)
        }

        this._elements.beginBtn?.addEventListener('click', this._handleBeginClick)
        this._elements.cancelBtn?.addEventListener('click', this._handleCancelClick)
        this._elements.progressCancelBtn?.addEventListener('click', this._handleCancelClick)

        document.addEventListener('keydown', this._handleKeydown)
        this._dialog.addEventListener('click', this._handleDialogClick)
    }

    _removeEventListeners() {
        for (const input of this._getCalcInputs()) {
            input.removeEventListener('input', this._handleInputChange)
            input.removeEventListener('change', this._handleInputChange)
        }

        this._elements.beginBtn?.removeEventListener('click', this._handleBeginClick)
        this._elements.cancelBtn?.removeEventListener('click', this._handleCancelClick)
        this._elements.progressCancelBtn?.removeEventListener('click', this._handleCancelClick)

        document.removeEventListener('keydown', this._handleKeydown)
        this._dialog?.removeEventListener('click', this._handleDialogClick)
    }

    _handleKeydown(e) {
        if (e.key === 'Escape') {
            e.preventDefault()
            this.cancel()
        }
    }

    _handleDialogClick(e) {
        if (e.target === this._dialog && this.state === 'dialog') {
            this.cancel()
        }
    }

    _loadPreferences() {
        try {
            const saved = localStorage.getItem('layers-export-prefs')
            if (saved) {
                const prefs = JSON.parse(saved)
                if (prefs.framerate) this._elements.framerateSelect.value = prefs.framerate
                if (prefs.duration) this._elements.durationInput.value = prefs.duration
                if (prefs.loopCount) this._elements.loopCountInput.value = prefs.loopCount
                if (prefs.format) this._elements.formatSelect.value = prefs.format
                if (prefs.quality) this._elements.qualitySelect.value = prefs.quality
                if (prefs.playFrom && this._elements.playFromSelect) this._elements.playFromSelect.value = prefs.playFrom
            }
        } catch (err) {
            // ignore
        }
    }

    _savePreferences(settings) {
        try {
            localStorage.setItem('layers-export-prefs', JSON.stringify({
                framerate: settings.framerate,
                duration: settings.duration,
                loopCount: settings.loopCount,
                format: settings.format,
                quality: settings.quality,
                playFrom: settings.playFrom
            }))
        } catch (err) {
            // ignore
        }
    }
}
