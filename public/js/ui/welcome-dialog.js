/**
 * Welcome Dialog
 *
 * A warm, restrained first-run splash + quick start, shown in place of the
 * open dialog on first launch. Two tiles route into the app's existing
 * new-canvas / open-media flows; closing without a choice falls through to the
 * open dialog so the user is never stranded. Re-openable from the logo menu.
 *
 * @module ui/welcome-dialog
 */

const STORAGE_KEY = 'layers-welcome-dismissed'

// Layered-slabs wordmark logo, matching #logo in index.html and the About dialog.
const LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 600" fill="currentColor"><g transform="translate(0,600) scale(0.1,-0.1)"><path d="M840 5478 c-10 -18 -120 -204 -244 -413 l-225 -380 1314 -3 c723 -1 1907 -1 2630 0 l1315 3 -236 390 c-130 215 -241 400 -247 413 l-10 22 -2139 0 -2139 0 -19 -32z"/><path d="M659 4118 c-111 -189 -222 -376 -246 -415 l-43 -73 2630 0 2630 0 -249 413 -249 412 -2135 3 -2135 2 -203 -342z"/><path d="M858 3403 c-8 -10 -90 -146 -183 -303 -92 -157 -199 -337 -237 -400 l-68 -115 1315 -3 c723 -1 1907 -1 2630 0 l1314 3 -251 418 -251 417 -2127 0 c-2013 0 -2128 -1 -2142 -17z"/><path d="M619 1959 c-134 -226 -245 -414 -247 -418 -1 -3 1179 -6 2623 -6 1743 0 2625 3 2625 10 0 6 -110 192 -244 415 l-244 405 -2135 3 -2134 2 -244 -411z"/><path d="M714 1073 c-81 -137 -191 -322 -245 -413 l-99 -165 1315 -3 c723 -1 1906 -1 2629 0 l1315 3 -248 410 -247 410 -2137 3 -2136 2 -147 -247z"/></g></svg>`

/**
 * Whether the user opted out of the welcome splash.
 * @returns {boolean}
 */
export function isWelcomeDismissed() {
    try {
        return localStorage.getItem(STORAGE_KEY) === 'true'
    } catch {
        return false
    }
}

/**
 * WelcomeDialog — first-run splash singleton.
 */
class WelcomeDialog {
    constructor() {
        this._dialog = null
        this._deps = {}
        this._chose = false
        this._fallThrough = false
    }

    /**
     * Inject the flows the tiles / dismiss route into.
     * @param {{onNewCanvas?:Function, onOpenFile?:Function, onDismiss?:Function}} deps
     */
    init(deps = {}) {
        this._deps = deps
    }

    /**
     * Show the dialog.
     * @param {{fallThrough?:boolean}} [opts] - when true, closing WITHOUT a tile
     *   choice runs `onDismiss` (used only for the first-run entry point so the
     *   user still lands in the open dialog).
     */
    show({ fallThrough = false } = {}) {
        if (!this._dialog) this._createDialog()
        this._chose = false
        this._fallThrough = fallThrough
        const checkbox = this._dialog.querySelector('#welcome-dontshow')
        if (checkbox) checkbox.checked = isWelcomeDismissed()
        this._dialog.showModal()
    }

    /**
     * Hide the dialog.
     */
    hide() {
        this._dialog?.close()
    }

    /**
     * @private
     */
    _createDialog() {
        this._dialog = document.createElement('dialog')
        this._dialog.className = 'welcome-dialog'
        this._dialog.setAttribute('aria-label', 'Welcome to Layers')
        this._dialog.innerHTML = `
            <div class="welcome-hero">
                <div class="welcome-logo">${LOGO_SVG}</div>
                <h1 class="welcome-title">Welcome to Layers</h1>
                <p class="welcome-subtitle">Layered, non-destructive image editing.</p>
            </div>
            <div class="welcome-tiles">
                <button class="welcome-tile" data-action="new" type="button">
                    <span class="icon-material">add</span>
                    <span class="welcome-tile-label">New canvas</span>
                </button>
                <button class="welcome-tile" data-action="open" type="button">
                    <span class="icon-material">add_photo_alternate</span>
                    <span class="welcome-tile-label">Open file</span>
                </button>
            </div>
            <div class="welcome-footer">
                <label class="welcome-dontshow-label">
                    <input type="checkbox" id="welcome-dontshow"> don't show again
                </label>
                <button class="action-btn welcome-close" type="button">Close</button>
            </div>
        `

        document.body.appendChild(this._dialog)

        // Tiles route into the injected flows.
        this._dialog.querySelectorAll('.welcome-tile').forEach((btn) => {
            btn.addEventListener('click', () => {
                this._chose = true
                const action = btn.dataset.action
                this.hide()
                if (action === 'new') this._deps.onNewCanvas?.()
                else if (action === 'open') this._deps.onOpenFile?.()
            })
        })

        // "don't show again" persists immediately on toggle.
        this._dialog.querySelector('#welcome-dontshow').addEventListener('change', (e) => {
            try {
                localStorage.setItem(STORAGE_KEY, e.target.checked ? 'true' : 'false')
            } catch { /* ignore */ }
        })

        // Close button.
        this._dialog.querySelector('.welcome-close').addEventListener('click', () => this.hide())

        // Backdrop click.
        this._dialog.addEventListener('click', (e) => {
            if (e.target === this._dialog) this.hide()
        })

        // Fall-through to the open dialog on dismiss (first-run only), unless a
        // tile was chosen (the tile handler runs its own flow).
        this._dialog.addEventListener('close', () => {
            if (!this._chose && this._fallThrough) this._deps.onDismiss?.()
        })
    }
}

export const welcomeDialog = new WelcomeDialog()
