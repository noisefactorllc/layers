/**
 * Settings Dialog
 * App settings with theme selection.
 *
 * @module ui/settings-dialog
 */

import { SelectDropdown } from 'handfish'

const STORAGE_KEY = 'layers-theme'

const THEMES = [
    { value: 'system', text: 'System' },
    { value: 'gray-dark', text: 'Gray Dark' },
    { value: 'gray-light', text: 'Gray Light' },
    { value: 'neutral-dark', text: 'Neutral Dark' },
    { value: 'neutral-light', text: 'Neutral Light' },
    { value: 'corporate', text: 'Corporate' },
    { value: 'cyberpunk', text: 'Cyberpunk' },
    { value: 'earthy', text: 'Earthy' },
    { value: 'organic', text: 'Organic' },
    { value: 'terminal', text: 'Terminal' },
    { value: 'dark', text: 'Dark' },
    { value: 'light', text: 'Light' },
]

/**
 * Resolve "system" to a concrete theme based on prefers-color-scheme.
 * @returns {string} 'neutral-dark' or 'neutral-light'
 */
function resolveSystemTheme() {
    return window.matchMedia('(prefers-color-scheme: dark)').matches
        ? 'neutral-dark'
        : 'neutral-light'
}

/**
 * Apply a theme to the document.
 * @param {string} themeValue - Theme key from THEMES or 'system'
 */
export function applyTheme(themeValue) {
    const resolved = themeValue === 'system' ? resolveSystemTheme() : themeValue
    document.documentElement.dataset.theme = resolved
}

// Single shared MediaQueryList + listener so the prefers-color-scheme handler
// is wired exactly once, regardless of how many call sites flip the theme to
// 'system'. The dialog instance below uses the same module-level state via
// updateSystemListener so the human UI and the agent path stay in lockstep.
const _systemMediaQuery = typeof window !== 'undefined'
    ? window.matchMedia('(prefers-color-scheme: dark)')
    : null
let _systemListener = null

function updateSystemListener(themeValue) {
    if (!_systemMediaQuery) return
    if (_systemListener) {
        _systemMediaQuery.removeEventListener('change', _systemListener)
        _systemListener = null
    }
    if (themeValue === 'system') {
        _systemListener = () => applyTheme('system')
        _systemMediaQuery.addEventListener('change', _systemListener)
    }
}

/**
 * Persist + apply a theme. Mirrors the dropdown change handler in the
 * Settings dialog so external call sites (e.g. the agent's setSettings
 * command) go through the same code path and get the prefers-color-scheme
 * listener wiring for free. The listener is module-scoped and de-duped, so
 * calling setTheme('system') repeatedly is safe.
 *
 * @param {string} themeValue
 */
export function setTheme(themeValue) {
    localStorage.setItem(STORAGE_KEY, themeValue)
    applyTheme(themeValue)
    updateSystemListener(themeValue)
}

/**
 * SettingsDialog - App settings modal
 */
class SettingsDialog {
    constructor() {
        this._dialog = null
        this._themeSelect = null
    }

    /**
     * Initialize theme on app startup (call once from app.js).
     * Reads localStorage and applies the saved theme.
     * Sets up system preference listener if in system mode.
     */
    initTheme() {
        const saved = localStorage.getItem(STORAGE_KEY) || 'system'
        applyTheme(saved)
        updateSystemListener(saved)
    }

    /**
     * Show the settings dialog.
     */
    show() {
        if (!this._dialog) {
            this._createDialog()
        }

        // Sync dropdown with current saved value
        const saved = localStorage.getItem(STORAGE_KEY) || 'system'
        this._themeSelect.value = saved

        this._dialog.showModal()
    }

    /**
     * Hide the dialog.
     */
    hide() {
        if (this._dialog) {
            this._dialog.close()
        }
    }

    /**
     * Create the dialog element.
     * @private
     */
    _createDialog() {
        this._dialog = document.createElement('dialog')
        this._dialog.className = 'settings-dialog'
        this._dialog.innerHTML = `
            <div class="dialog-header">
                <h2>Settings</h2>
                <button class="dialog-close" aria-label="Close">
                    <span class="icon-material">close</span>
                </button>
            </div>
            <div class="dialog-body">
                <div class="form-field">
                    <label class="form-label">Theme</label>
                    <select-dropdown class="settings-theme-select"></select-dropdown>
                </div>
            </div>
        `

        document.body.appendChild(this._dialog)

        // Set up theme dropdown
        this._themeSelect = this._dialog.querySelector('.settings-theme-select')
        this._themeSelect.setOptions(THEMES)

        const saved = localStorage.getItem(STORAGE_KEY) || 'system'
        this._themeSelect.value = saved

        // Theme change handler — delegate to the module-level setTheme so the
        // human UI and the agent path share the same persistence + listener
        // wiring (and the prefers-color-scheme listener stays de-duped).
        this._themeSelect.addEventListener('change', () => {
            setTheme(this._themeSelect.value)
        })

        // Close button
        this._dialog.querySelector('.dialog-close').addEventListener('click', () => {
            this.hide()
        })

        // Close on backdrop click
        this._dialog.addEventListener('click', (e) => {
            if (e.target === this._dialog) {
                this.hide()
            }
        })
    }
}

export const settingsDialog = new SettingsDialog()
