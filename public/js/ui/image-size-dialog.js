/**
 * Image Size Dialog
 * Resize image with optional constrained proportions
 *
 * @module ui/image-size-dialog
 */

const MIN_SIZE = 64
const MAX_SIZE = 2048

class ImageSizeDialog {
    constructor() {
        this._dialog = null
        this._onConfirm = null
        this._originalWidth = 0
        this._originalHeight = 0
        this._constrain = true
    }

    show(options = {}) {
        this._onConfirm = options.onConfirm
        this._originalWidth = options.width || 1024
        this._originalHeight = options.height || 1024

        if (!this._dialog) {
            this._createDialog()
        }

        this._constrain = true
        this._dialog.querySelector('#image-size-constrain').checked = true
        this._setInputValue('image-width', this._originalWidth)
        this._setInputValue('image-height', this._originalHeight)
        this._clearErrors()

        this._dialog.showModal()
    }

    hide() {
        if (this._dialog) this._dialog.close()
    }

    _createDialog() {
        this._dialog = document.createElement('dialog')
        this._dialog.className = 'image-size-dialog'
        this._dialog.innerHTML = `
            <div class="dialog-header">
                <h2>Image Size</h2>
                <button class="dialog-close" aria-label="Close">
                    <span class="icon-material">close</span>
                </button>
            </div>
            <div class="dialog-body">
                <div class="size-inputs">
                    <div class="form-field">
                        <label for="image-width">Width</label>
                        <div class="input-with-unit">
                            <input type="number" id="image-width"
                                min="${MIN_SIZE}" max="${MAX_SIZE}" step="1">
                            <span class="input-unit">px</span>
                        </div>
                        <div class="form-error" id="image-width-error"></div>
                    </div>

                    <span class="size-separator">x</span>

                    <div class="form-field">
                        <label for="image-height">Height</label>
                        <div class="input-with-unit">
                            <input type="number" id="image-height"
                                min="${MIN_SIZE}" max="${MAX_SIZE}" step="1">
                            <span class="input-unit">px</span>
                        </div>
                        <div class="form-error" id="image-height-error"></div>
                    </div>
                </div>

                <div class="constrain-row">
                    <label>
                        <input type="checkbox" id="image-size-constrain" checked>
                        Constrain proportions
                    </label>
                </div>

                <div class="size-limits">
                    Min: ${MIN_SIZE}px | Max: ${MAX_SIZE}px
                </div>
            </div>
            <div class="dialog-actions">
                <button class="action-btn" id="image-size-cancel">Cancel</button>
                <button class="action-btn primary" id="image-size-ok">OK</button>
            </div>
        `

        document.body.appendChild(this._dialog)
        this._setupEventListeners()
    }

    _setupEventListeners() {
        this._dialog.querySelector('.dialog-close').addEventListener('click', () => this.hide())
        this._dialog.querySelector('#image-size-cancel').addEventListener('click', () => this.hide())
        this._dialog.querySelector('#image-size-ok').addEventListener('click', () => this._handleConfirm())

        this._dialog.querySelector('#image-size-constrain').addEventListener('change', (e) => {
            this._constrain = e.target.checked
        })

        const widthInput = this._dialog.querySelector('#image-width')
        const heightInput = this._dialog.querySelector('#image-height')

        widthInput.addEventListener('input', () => {
            this._validateInput('width')
            if (this._constrain) {
                const w = parseInt(widthInput.value, 10)
                if (!isNaN(w) && w > 0) {
                    const ratio = this._originalHeight / this._originalWidth
                    this._setInputValue('image-height', Math.round(w * ratio))
                }
            }
        })

        heightInput.addEventListener('input', () => {
            this._validateInput('height')
            if (this._constrain) {
                const h = parseInt(heightInput.value, 10)
                if (!isNaN(h) && h > 0) {
                    const ratio = this._originalWidth / this._originalHeight
                    this._setInputValue('image-width', Math.round(h * ratio))
                }
            }
        })

        this._dialog.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.target.closest('.dialog-close, #image-size-cancel')) {
                e.preventDefault()
                this._handleConfirm()
            }
        })
    }

    _handleConfirm() {
        const w = this._getInputValue('image-width')
        const h = this._getInputValue('image-height')
        if (!this._validateInput('width') || !this._validateInput('height')) return
        if (this._onConfirm) this._onConfirm(w, h)
        this.hide()
    }

    _validateInput(field) {
        const inputId = field === 'width' ? 'image-width' : 'image-height'
        const errorId = `image-${field}-error`
        const value = this._getInputValue(inputId)
        const errorEl = this._dialog.querySelector(`#${errorId}`)
        if (isNaN(value) || value < MIN_SIZE) {
            errorEl.textContent = `Minimum ${MIN_SIZE}px`
            return false
        }
        if (value > MAX_SIZE) {
            errorEl.textContent = `Maximum ${MAX_SIZE}px`
            return false
        }
        errorEl.textContent = ''
        return true
    }

    _clearErrors() {
        this._dialog.querySelector('#image-width-error').textContent = ''
        this._dialog.querySelector('#image-height-error').textContent = ''
    }

    _getInputValue(id) {
        return parseInt(this._dialog.querySelector(`#${id}`).value, 10)
    }

    _setInputValue(id, value) {
        const input = this._dialog.querySelector(`#${id}`)
        if (input) input.value = value
    }
}

export const imageSizeDialog = new ImageSizeDialog()
