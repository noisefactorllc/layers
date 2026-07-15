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
        this.acquireMutation = options.acquireMutation || (() => ({ release() {} }))
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

    _gatherSettings() {
        return {
            width: parseInt(this._elements.widthInput.value, 10) || 1024,
            height: parseInt(this._elements.heightInput.value, 10) || 1024,
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

    _ensureEven(value) {
        const floored = Math.floor(value)
        return Math.max(2, floored - (floored % 2))
    }

    async _export() {
        if (this.state !== 'dialog') return
        if (this._projectGeneration !== this.getProjectGeneration()) {
            this.close()
            this.onCancel()
            return
        }
        const mutationToken = this.acquireMutation()
        if (!mutationToken) return
        this.state = 'exporting'
        const settings = this._gatherSettings()
        this._savePreferences(settings)

        const width = this._ensureEven(settings.width)
        const height = this._ensureEven(settings.height)
        const needsResize = width !== this.originalResolution.width ||
                          height !== this.originalResolution.height

        let completed = false
        try {
            if (needsResize) {
                this.setResolution(width, height)
                await new Promise(resolve => requestAnimationFrame(resolve))
                await new Promise(resolve => requestAnimationFrame(resolve))
            }

            const qualityValue = settings.format === 'png' ? 1.0 : this._qualityToValue(settings.quality)
            this.files.saveImage(this.canvas, settings.format, qualityValue)
            completed = true
        } catch (err) {
            console.error('Export image failed:', err)
        } finally {
            if (needsResize) {
                this.setResolution(this.originalResolution.width, this.originalResolution.height)
            }
            mutationToken.release()
        }
        if (completed) {
            this.close()
            this.onComplete(settings.format)
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
