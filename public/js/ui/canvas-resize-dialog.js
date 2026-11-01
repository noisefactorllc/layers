/**
 * Canvas Resize Dialog
 * Change canvas dimensions with anchor position control
 *
 * @module ui/canvas-resize-dialog
 */

const MIN_SIZE = 64
const MAX_SIZE = 2048

const ANCHORS = [
    'top-left', 'top-center', 'top-right',
    'middle-left', 'center', 'middle-right',
    'bottom-left', 'bottom-center', 'bottom-right'
]

class CanvasResizeDialog {
    constructor() {
        this._dialog = null
        this._onConfirm = null
        this._anchor = 'center'
    }

    show(options = {}) {
        this._onConfirm = options.onConfirm
        this._anchor = 'center'

        if (!this._dialog) {
            this._createDialog()
        }

        this._setInputValue('canvas-resize-width', options.width || 1024)
        this._setInputValue('canvas-resize-height', options.height || 1024)
        this._clearErrors()
        this._updateAnchorGrid()

        this._dialog.showModal()
    }

    hide() {
        if (this._dialog) this._dialog.close()
    }

    _createDialog() {
        this._dialog = document.createElement('dialog')
        this._dialog.className = 'canvas-resize-dialog'
        this._dialog.innerHTML = `
            <div class="dialog-header">
                <h2>Canvas Size</h2>
                <button class="dialog-close" aria-label="Close">
                    <span class="icon-material">close</span>
                </button>
            </div>
            <div class="dialog-body">
                <div class="size-inputs">
                    <div class="form-field">
                        <label for="canvas-resize-width">Width</label>
                        <div class="input-with-unit">
                            <input type="number" id="canvas-resize-width"
                                min="${MIN_SIZE}" max="${MAX_SIZE}" step="1">
                            <span class="input-unit">px</span>
                        </div>
                        <div class="form-error" id="canvas-resize-width-error"></div>
                    </div>

                    <span class="size-separator">x</span>

                    <div class="form-field">
                        <label for="canvas-resize-height">Height</label>
                        <div class="input-with-unit">
                            <input type="number" id="canvas-resize-height"
                                min="${MIN_SIZE}" max="${MAX_SIZE}" step="1">
                            <span class="input-unit">px</span>
                        </div>
                        <div class="form-error" id="canvas-resize-height-error"></div>
                    </div>
                </div>

                <div class="anchor-section">
                    <label>Anchor</label>
                    <div class="anchor-grid">
                        ${ANCHORS.map(a => `<button class="anchor-btn${a === 'center' ? ' active' : ''}" data-anchor="${a}" title="${a}">
                            <span class="anchor-dot"></span>
                        </button>`).join('')}
                    </div>
                </div>

                <div class="size-limits">
                    Min: ${MIN_SIZE}px | Max: ${MAX_SIZE}px
                </div>
            </div>
            <div class="dialog-actions">
                <button class="action-btn" id="canvas-resize-cancel">Cancel</button>
                <button class="action-btn primary" id="canvas-resize-ok">OK</button>
            </div>
        `

        document.body.appendChild(this._dialog)
        this._setupEventListeners()
    }

    _setupEventListeners() {
        this._dialog.querySelector('.dialog-close').addEventListener('click', () => this.hide())
        this._dialog.querySelector('#canvas-resize-cancel').addEventListener('click', () => this.hide())
        this._dialog.querySelector('#canvas-resize-ok').addEventListener('click', () => this._handleConfirm())

        this._dialog.querySelectorAll('.anchor-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                this._anchor = btn.dataset.anchor
                this._updateAnchorGrid()
            })
        })

        this._dialog.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.target.closest('.dialog-close, #canvas-resize-cancel')) {
                e.preventDefault()
                this._handleConfirm()
            }
        })
    }

    _updateAnchorGrid() {
        this._dialog.querySelectorAll('.anchor-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.anchor === this._anchor)
        })
    }

    _handleConfirm() {
        const w = this._getInputValue('canvas-resize-width')
        const h = this._getInputValue('canvas-resize-height')
        if (!this._validateInput('width') || !this._validateInput('height')) return
        if (this._onConfirm) this._onConfirm(w, h, this._anchor)
        this.hide()
    }

    _validateInput(field) {
        const inputId = field === 'width' ? 'canvas-resize-width' : 'canvas-resize-height'
        const errorId = `canvas-resize-${field}-error`
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
        this._dialog.querySelector('#canvas-resize-width-error').textContent = ''
        this._dialog.querySelector('#canvas-resize-height-error').textContent = ''
    }

    _getInputValue(id) {
        return parseInt(this._dialog.querySelector(`#${id}`).value, 10)
    }

    _setInputValue(id, value) {
        const input = this._dialog.querySelector(`#${id}`)
        if (input) input.value = value
    }
}

export const canvasResizeDialog = new CanvasResizeDialog()
