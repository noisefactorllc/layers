/**
 * Confirm Dialog
 * Custom replacement for native browser confirm()
 *
 * @module ui/confirm-dialog
 */

/**
 * ConfirmDialog - Modal for yes/no confirmations
 */
class ConfirmDialog {
    constructor() {
        this._backdrop = null
        this._modal = null
        this._activeRequest = null
        this._requests = []
    }

    /**
     * Show a confirmation dialog
     * @param {object} options - Options
     * @param {string} options.message - The message to display
     * @param {string} options.confirmText - Text for confirm button (default: 'OK')
     * @param {string} options.cancelText - Text for cancel button (default: 'Cancel')
     * @param {boolean} options.danger - If true, confirm button is styled as dangerous
     * @returns {Promise<boolean>} Resolves to true if confirmed, false if cancelled
     */
    show(options = {}) {
        return new Promise(resolve => {
            this._requests.push({ options, resolve })
            this._showNext()
        })
    }

    /** @private */
    _showNext() {
        if (this._activeRequest || this._requests.length === 0) return
        this._activeRequest = this._requests.shift()
        const {
            message = 'Are you sure?',
            confirmText = 'OK',
            cancelText = 'Cancel',
            danger = false
        } = this._activeRequest.options

        if (!this._backdrop) {
            this._createModal()
        }

        // Update content
        this._modal.querySelector('.confirm-message').textContent = message

        const confirmBtn = this._modal.querySelector('#confirm-ok')
        confirmBtn.textContent = confirmText
        confirmBtn.classList.toggle('danger', danger)

        this._modal.querySelector('#confirm-cancel').textContent = cancelText

        this._backdrop.classList.add('visible')
    }

    /**
     * Hide the dialog
     * @private
     */
    _hide() {
        if (this._backdrop) {
            this._backdrop.classList.remove('visible')
        }
    }

    /**
     * Create the modal element
     * @private
     */
    _createModal() {
        this._backdrop = document.createElement('div')
        this._backdrop.className = 'confirm-dialog-backdrop'

        this._modal = document.createElement('div')
        this._modal.className = 'confirm-dialog'
        this._modal.setAttribute('role', 'alertdialog')
        this._modal.setAttribute('aria-modal', 'true')
        this._modal.innerHTML = `
            <div class="dialog-body">
                <p class="confirm-message"></p>
            </div>
            <div class="dialog-actions">
                <button class="action-btn" id="confirm-cancel">Cancel</button>
                <button class="action-btn primary" id="confirm-ok">OK</button>
            </div>
        `

        this._backdrop.appendChild(this._modal)
        document.body.appendChild(this._backdrop)
        this._setupEventListeners()
    }

    /**
     * Resolve the dialog promise and hide
     * @param {boolean} result - The result to resolve with
     * @private
     */
    _resolve(result) {
        this._hide()
        const request = this._activeRequest
        this._activeRequest = null
        request?.resolve(result)
        this._showNext()
    }

    /**
     * Set up event listeners
     * @private
     */
    _setupEventListeners() {
        const cancelBtn = this._modal.querySelector('#confirm-cancel')
        const confirmBtn = this._modal.querySelector('#confirm-ok')

        cancelBtn.addEventListener('click', () => this._resolve(false))
        confirmBtn.addEventListener('click', () => this._resolve(true))
    }
}

export const confirmDialog = new ConfirmDialog()
