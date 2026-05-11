/**
 * Toast Notifications
 * Simple toast notification system
 *
 * @module ui/toast
 */

/**
 * Toast manager
 */
class ToastManager {
    constructor() {
        this._container = null
        this._toasts = []
        // When > 0, show() is a no-op. Agent commands bump this before
        // invoking app methods that emit user-facing toasts (a wrapper-style
        // counter rather than a flag so nested suppressions don't clobber
        // each other).
        this._suppressDepth = 0
    }

    /**
     * Run `fn` with all toast emissions silenced. Returns whatever fn returns
     * (or its resolved value, if it's async). The depth counter handles
     * nested suppress() calls correctly.
     *
     * @template T
     * @param {() => T | Promise<T>} fn
     * @returns {Promise<T> | T}
     */
    suppress(fn) {
        this._suppressDepth++
        let result
        try {
            result = fn()
        } catch (err) {
            this._suppressDepth--
            throw err
        }
        if (result && typeof result.then === 'function') {
            return result.finally(() => { this._suppressDepth-- })
        }
        this._suppressDepth--
        return result
    }

    /**
     * Get or create the toast container
     * @returns {HTMLElement}
     * @private
     */
    _getContainer() {
        if (!this._container) {
            this._container = document.getElementById('toast-container')
            if (!this._container) {
                this._container = document.createElement('div')
                this._container.id = 'toast-container'
                document.body.appendChild(this._container)
            }
        }
        return this._container
    }

    /**
     * Show a toast notification
     * @param {string} message - Message to display
     * @param {object} options - Options
     * @param {string} [options.type='info'] - Toast type: 'info', 'success', 'warning', 'error'
     * @param {number} [options.duration=3000] - Duration in ms (0 for persistent)
     * @param {boolean} [options.closable=true] - Show close button
     */
    show(message, options = {}) {
        if (this._suppressDepth > 0) return null
        const {
            type = 'info',
            duration = 3000,
            closable = true
        } = options

        const container = this._getContainer()

        // Create toast element
        const toast = document.createElement('div')
        toast.className = `toast toast-${type}`

        // Icon based on type
        const icons = {
            info: 'info',
            success: 'check_circle',
            warning: 'warning',
            error: 'error'
        }

        toast.innerHTML = `
            <div class="toast-icon">
                <span class="icon-material">${icons[type] || icons.info}</span>
            </div>
            <div class="toast-message">${this._escapeHtml(message)}</div>
            ${closable ? `
                <button class="toast-close" aria-label="Close">
                    <span class="icon-material">close</span>
                </button>
            ` : ''}
        `

        // Add to container
        container.appendChild(toast)
        this._toasts.push(toast)

        // Animate in
        requestAnimationFrame(() => {
            toast.classList.add('toast-visible')
        })

        // Set up close button
        if (closable) {
            const closeBtn = toast.querySelector('.toast-close')
            closeBtn.addEventListener('click', () => this._removeToast(toast))
        }

        // Auto-remove after duration
        if (duration > 0) {
            setTimeout(() => this._removeToast(toast), duration)
        }

        return toast
    }

    /**
     * Show an info toast
     * @param {string} message - Message to display
     * @param {object} [options] - Options
     */
    info(message, options = {}) {
        return this.show(message, { ...options, type: 'info' })
    }

    /**
     * Show a success toast
     * @param {string} message - Message to display
     * @param {object} [options] - Options
     */
    success(message, options = {}) {
        return this.show(message, { ...options, type: 'success' })
    }

    /**
     * Show a warning toast
     * @param {string} message - Message to display
     * @param {object} [options] - Options
     */
    warning(message, options = {}) {
        return this.show(message, { ...options, type: 'warning' })
    }

    /**
     * Show an error toast
     * @param {string} message - Message to display
     * @param {object} [options] - Options
     */
    error(message, options = {}) {
        return this.show(message, { ...options, type: 'error' })
    }

    /**
     * Remove a toast
     * @param {HTMLElement} toast - Toast element
     * @private
     */
    _removeToast(toast) {
        if (!toast || toast.classList.contains('toast-hiding')) return

        toast.classList.remove('toast-visible')
        toast.classList.add('toast-hiding')

        setTimeout(() => {
            toast.remove()
            const index = this._toasts.indexOf(toast)
            if (index > -1) {
                this._toasts.splice(index, 1)
            }
        }, 200)
    }

    /**
     * Remove all toasts
     */
    clear() {
        this._toasts.forEach(toast => this._removeToast(toast))
    }

    /**
     * Escape HTML special characters
     * @param {string} str - Input string
     * @returns {string} Escaped string
     * @private
     */
    _escapeHtml(str) {
        const div = document.createElement('div')
        div.textContent = str
        return div.innerHTML
    }
}

// Export singleton
export const toast = new ToastManager()
