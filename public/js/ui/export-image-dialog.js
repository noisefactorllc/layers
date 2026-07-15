/**
 * Export Image Dialog
 * Configurable resolution, format, and quality image export.
 * Ported from Noisedeck ExportImageMode.
 *
 * @module ui/export-image-dialog
 */

export class ExportImageDialog {
    constructor(options) {
        this.files = options.files
        this.canvas = options.canvas
        this.getResolution = options.getResolution
        this.setResolution = options.setResolution
        this.renderCurrentFrame = options.renderCurrentFrame || (() => {})
        this.acquireMutation = options.acquireMutation || (() => ({ release() {} }))
        this.acquireSnapshotOverride = options.acquireSnapshotOverride
            || (() => ({ release() {} }))
        this.getProjectGeneration = options.getProjectGeneration || (() => 0)
        this.onComplete = options.onComplete || (() => {})
        this.onCancel = options.onCancel || (() => {})

        this.originalResolution = null
        this.state = 'idle'
        this._projectGeneration = 0
        this._dialog = null
        this._elements = {}

        this._handleKeydown = this._handleKeydown.bind(this)
        this._handleDialogClick = this._handleDialogClick.bind(this)
        this._handleExport = this._export.bind(this)
        this._handleCancel = this._cancel.bind(this)
        this._handleFormatChange = this._updateQualityVisibility.bind(this)
    }

    _cacheElements() {
        this._dialog = document.getElementById('exportImageModal')
        if (!this._dialog) return false

        this._elements = {
            widthInput: document.getElementById('exportImageWidth'),
            heightInput: document.getElementById('exportImageHeight'),
            formatSelect: document.getElementById('exportImageFormat'),
            qualitySelect: document.getElementById('exportImageQuality'),
            qualityGroup: document.getElementById('exportImageQualityGroup'),
            exportBtn: document.getElementById('exportImageBeginBtn'),
            cancelBtn: document.getElementById('exportImageCancelBtn')
        }
        return true
    }

    open() {
        if (!this._dialog && !this._cacheElements()) return

        this.state = 'dialog'
        this._projectGeneration = this.getProjectGeneration()
        this.originalResolution = this.getResolution()
        this._elements.widthInput.value = this.originalResolution.width
        this._elements.heightInput.value = this.originalResolution.height

        this._loadPreferences()
        this._updateQualityVisibility()
        this._setupEventListeners()
        this._dialog.showModal()
    }

    close() {
        if (this._dialog) {
            this._removeEventListeners()
            this._dialog.close()
        }
        this.state = 'idle'
    }

    _setupEventListeners() {
        this._elements.exportBtn?.addEventListener('click', this._handleExport)
        this._elements.cancelBtn?.addEventListener('click', this._handleCancel)
        this._elements.formatSelect?.addEventListener('change', this._handleFormatChange)
        document.addEventListener('keydown', this._handleKeydown)
        this._dialog.addEventListener('click', this._handleDialogClick)
    }

    _removeEventListeners() {
        this._elements.exportBtn?.removeEventListener('click', this._handleExport)
        this._elements.cancelBtn?.removeEventListener('click', this._handleCancel)
        this._elements.formatSelect?.removeEventListener('change', this._handleFormatChange)
        document.removeEventListener('keydown', this._handleKeydown)
        this._dialog?.removeEventListener('click', this._handleDialogClick)
    }

    _handleKeydown(e) {
        if (e.key === 'Escape') {
            e.preventDefault()
            this._cancel()
        } else if (e.key === 'Enter' && !e.repeat) {
            e.preventDefault()
            this._export()
        }
    }

    _handleDialogClick(e) {
        if (e.target === this._dialog) {
            this._cancel()
        }
    }

    _updateQualityVisibility() {
        const format = this._elements.formatSelect?.value || 'png'
        if (this._elements.qualityGroup) {
            this._elements.qualityGroup.style.display = format === 'png' ? 'none' : ''
        }
    }

    _readDimension(input, label, { reportValidation = false } = {}) {
        const value = Number(input.value)
        input.setCustomValidity('')
        if (Number.isInteger(value) && value >= 64 && value <= 8192) return value

        const message = `${label} must be a whole number from 64 to 8192`
        input.setCustomValidity(message)
        if (reportValidation) input.reportValidity()
        throw new RangeError(message)
    }

    _completeSuccessfulExport(format) {
        try {
            this.close()
        } catch (err) {
            this.state = 'idle'
            console.error('Failed to close image export dialog:', err)
        }
        try {
            this.onComplete(format)
        } catch (err) {
            console.error('Failed to report completed image export:', err)
        }
    }

    _gatherSettings({ reportValidation = false } = {}) {
        return {
            width: this._readDimension(
                this._elements.widthInput, 'Width', { reportValidation }),
            height: this._readDimension(
                this._elements.heightInput, 'Height', { reportValidation }),
            format: this._elements.formatSelect.value || 'png',
            quality: this._elements.qualitySelect.value || 'high'
        }
    }

    _qualityToValue(quality) {
        const qualityMap = {
            'low': 0.5,
            'medium': 0.75,
            'high': 0.9,
            'very high': 0.95,
            'maximum': 1.0
        }
        return qualityMap[quality] || 0.9
    }

    async _export() {
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
            console.error('Invalid image export settings:', err)
            return
        }
        const mutationToken = this.acquireMutation()
        if (!mutationToken) return
        let needsResize = false
        let completed = false
        let restoreResolution = null
        let snapshotToken = null
        try {
            snapshotToken = this.acquireSnapshotOverride()
            this.state = 'exporting'
            this._savePreferences(settings)

            restoreResolution = this.getResolution()
            const width = settings.width
            const height = settings.height
            needsResize = width !== restoreResolution.width ||
                          height !== restoreResolution.height

            if (needsResize) {
                this.setResolution(width, height)
                await new Promise(resolve => requestAnimationFrame(resolve))
                await new Promise(resolve => requestAnimationFrame(resolve))
            }

            this.renderCurrentFrame()
            const qualityValue = settings.format === 'png' ? 1.0 : this._qualityToValue(settings.quality)
            this.files.saveImage(this.canvas, settings.format, qualityValue)
            completed = true
        } catch (err) {
            console.error('Export image failed:', err)
        } finally {
            try {
                if (needsResize) {
                    this.setResolution(restoreResolution.width, restoreResolution.height)
                    this.renderCurrentFrame()
                }
            } catch (err) {
                completed = false
                console.error('Failed to restore image export resolution:', err)
            } finally {
                try {
                    snapshotToken?.release()
                } finally {
                    mutationToken.release()
                }
            }
        }
        if (completed) {
            this._completeSuccessfulExport(settings.format)
        } else {
            this.state = 'dialog'
        }
    }

    _cancel() {
        if (this.state === 'exporting') return
        this.close()
        this.onCancel()
    }

    _savePreferences(settings) {
        try {
            localStorage.setItem('layers-export-image-prefs', JSON.stringify({
                format: settings.format,
                quality: settings.quality
            }))
        } catch (err) {
            // ignore
        }
    }

    _loadPreferences() {
        try {
            const saved = localStorage.getItem('layers-export-image-prefs')
            if (saved) {
                const prefs = JSON.parse(saved)
                if (prefs.format) this._elements.formatSelect.value = prefs.format
                if (prefs.quality) this._elements.qualitySelect.value = prefs.quality
            }
        } catch (err) {
            // ignore
        }
    }
}
