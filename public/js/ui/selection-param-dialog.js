/**
 * Selection Param Dialog
 * Reusable numeric input dialog for selection operations (e.g. expand/contract radius, border width)
 *
 * @module ui/selection-param-dialog
 */

class SelectionParamDialog {
    constructor() {
        this._dialog = null
        this._resolve = null
    }

    /**
     * Show the dialog and return a Promise that resolves with the numeric value or null on cancel.
     * @param {Object} options
     * @param {string} options.title - Dialog title
     * @param {string} options.label - Input label text
     * @param {number} [options.defaultValue=10] - Default input value
     * @param {number} [options.min=1] - Minimum allowed value
     * @param {number} [options.max=100] - Maximum allowed value
     * @returns {Promise<number|null>}
     */
    show(options = {}) {
        const {
            title = 'Selection Parameter',
            label = 'Radius',
            defaultValue = 10,
            min = 1,
            max = 100
        } = options

        return new Promise((resolve) => {
            this._resolve = resolve

            if (!this._dialog) {
                this._createDialog()
            }

            this._dialog.querySelector('.dialog-header h2').textContent = title
            const inputEl = this._dialog.querySelector('#selection-param-input')
            const labelEl = this._dialog.querySelector('label[for="selection-param-input"]')
            labelEl.textContent = label
            inputEl.min = min
            inputEl.max = max
            inputEl.value = defaultValue

            this._dialog.showModal()
            inputEl.select()
        })
    }

    hide() {
        if (this._dialog) this._dialog.close()
    }

    _createDialog() {
        this._dialog = document.createElement('dialog')
        this._dialog.className = 'selection-param-dialog'
        this._dialog.innerHTML = `
            <div class="dialog-header">
                <h2></h2>
                <button class="dialog-close" aria-label="Close">
                    <span class="icon-material">close</span>
                </button>
            </div>
            <div class="dialog-body">
                <div class="form-field">
                    <label for="selection-param-input"></label>
                    <div class="input-with-unit">
                        <input type="number" id="selection-param-input"
                            min="1" max="100" step="1">
                        <span class="input-unit">px</span>
                    </div>
                </div>
            </div>
            <div class="dialog-actions">
                <button class="action-btn" id="selection-param-cancel">Cancel</button>
                <button class="action-btn primary" id="selection-param-ok">OK</button>
            </div>
        `

        document.body.appendChild(this._dialog)
        this._setupEventListeners()
    }

    _setupEventListeners() {
        this._dialog.querySelector('.dialog-close').addEventListener('click', () => this._cancel())
        this._dialog.querySelector('#selection-param-cancel').addEventListener('click', () => this._cancel())
        this._dialog.querySelector('#selection-param-ok').addEventListener('click', () => this._confirm())

        this._dialog.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.target.closest('.dialog-close, #selection-param-cancel')) {
                e.preventDefault()
                this._confirm()
            }
        })

        // Handle native dialog cancel (Escape key)
        this._dialog.addEventListener('cancel', (e) => {
            e.preventDefault()
            this._cancel()
        })
    }

    _confirm() {
        const input = this._dialog.querySelector('#selection-param-input')
        const value = parseInt(input.value, 10)
        const min = parseInt(input.min, 10)
        const max = parseInt(input.max, 10)

        if (isNaN(value) || value < min || value > max) return

        this._finish(value)
    }

    _cancel() {
        this._finish(null)
    }

    _finish(result) {
        this.hide()
        if (this._resolve) {
            this._resolve(result)
            this._resolve = null
        }
    }
}

export const selectionParamDialog = new SelectionParamDialog()
