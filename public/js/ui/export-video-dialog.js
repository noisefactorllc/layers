/**
 * Export Video Dialog
 * Frame-accurate video export with MP4/ZIP output.
 * Ported from Noisedeck ExportMode, adapted for Layers' video layer seeking.
 *
 * @module ui/export-video-dialog
 */

import { runVideoExport } from './video-exporter.js'

export class ExportVideoDialog {
    constructor(options) {
        this.files = options.files
        this.renderer = options.renderer
        this.canvas = options.canvas
        this.getResolution = options.getResolution
        this.setResolution = options.setResolution
        this.onComplete = options.onComplete || (() => {})
        this.onCancel = options.onCancel || (() => {})

        this.state = 'idle'
        this.currentFrame = 0
        this.totalFrames = 0
        this.abortController = null
        this.originalResolution = null
        this.wasRunning = false
        this.pausedNormalizedTime = 0
        this.startTime = 0

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

        this.wasRunning = this.renderer.isRunning
        if (this.wasRunning) {
            this.pausedNormalizedTime = this.renderer.getPausedNormalizedTime()
            this.renderer.stop()
        }

        this.state = 'dialog'

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

        if (this.wasRunning) {
            this.renderer.restoreLoopFromNormalizedTime(this.pausedNormalizedTime)
            this.renderer.start()
        }

        this.state = 'idle'
    }

    async beginExport() {
        if (this.state !== 'dialog') return

        this.state = 'preparing'
        this.abortController = new AbortController()

        const settings = this._gatherSettings()
        this.totalFrames = Math.ceil(settings.framerate * settings.duration * settings.loopCount)
        this.currentFrame = 0
        this.startTime = performance.now()

        this._savePreferences(settings)
        this._elements.dialogView.style.display = 'none'
        this._elements.progressView.style.display = 'block'
        this._updateProgress()

        try {
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
            this.close()
            this.onComplete(settings.format)
        } catch (err) {
            if (err?.code === 'JOB_CANCELLED') {
                this.close()
                this.onCancel()
            } else {
                console.error('Export failed:', err)
                this._handleExportError(err)
            }
        }
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

    _gatherSettings() {
        const rawWidth = parseInt(this._elements.widthInput.value, 10) || 1024
        const rawHeight = parseInt(this._elements.heightInput.value, 10) || 1024

        return {
            width: this._ensureEven(rawWidth),
            height: this._ensureEven(rawHeight),
            framerate: parseInt(this._elements.framerateSelect.value, 10) || 30,
            duration: parseFloat(this._elements.durationInput.value) || 15,
            loopCount: parseInt(this._elements.loopCountInput.value, 10) || 1,
            format: this._elements.formatSelect.value || 'mp4',
            quality: this._elements.qualitySelect.value || 'very high',
            playFrom: this._elements.playFromSelect?.value || 'beginning'
        }
    }

    _updateCalculations() {
        const settings = this._gatherSettings()
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
