/**
 * Open Dialog
 * Initial base layer chooser - media, solid, gradient, or transparent
 *
 * @module ui/open-dialog
 */

import { canvasSizeDialog } from './canvas-size-dialog.js'
import { listProjects } from '../utils/project-storage.js'

/**
 * OpenDialog - Modal for choosing base layer type
 * Uses div-based modal to avoid native dialog ESC behavior
 */
class OpenDialog {
    constructor() {
        this._backdrop = null
        this._modal = null
        this._onOpen = null
        this._onSolid = null
        this._onGradient = null
        this._onTransparent = null
        this._onClipboard = null
        this._onLoadProject = null
        this._mode = 'choose'
        this._hasProjects = false
        this._canClose = false
    }

    async show(options = {}) {
        this._onOpen = options.onOpen
        this._onSolid = options.onSolid
        this._onGradient = options.onGradient
        this._onTransparent = options.onTransparent
        this._onClipboard = options.onClipboard
        this._onLoadProject = options.onLoadProject
        this._canClose = options.canClose || false

        try {
            const projects = await listProjects()
            this._hasProjects = projects.length > 0
        } catch (e) {
            this._hasProjects = false
        }

        if (!this._backdrop) {
            this._createModal()
        }

        this._updateLoadProjectVisibility()
        this._updateCloseButtonVisibility()
        this._setMode('choose')

        const fileInput = this._modal.querySelector('#open-file-input')
        if (fileInput) fileInput.value = ''

        this._backdrop.classList.add('visible')
    }

    _updateLoadProjectVisibility() {
        const loadProjectOption = this._modal.querySelector('.load-project-section')
        if (loadProjectOption) {
            loadProjectOption.classList.toggle('hidden', !this._hasProjects)
        }
    }

    _updateCloseButtonVisibility() {
        const closeBtn = this._modal.querySelector('.dialog-close')
        if (closeBtn) {
            closeBtn.classList.toggle('hidden', !this._canClose)
        }
    }

    _close() {
        if (this._canClose) {
            this._backdrop.classList.remove('visible')
        }
    }

    get element() {
        return { close: () => this._backdrop.classList.remove('visible') }
    }

    _createModal() {
        // Backdrop
        this._backdrop = document.createElement('div')
        this._backdrop.className = 'open-dialog-backdrop'

        // Modal
        this._modal = document.createElement('div')
        this._modal.className = 'open-dialog'
        this._modal.setAttribute('role', 'dialog')
        this._modal.setAttribute('aria-modal', 'true')
        this._modal.innerHTML = `
            <div class="dialog-header">
                <h2>New Project</h2>
                <button class="dialog-close hidden" title="Cancel">
                    <span class="icon-material">close</span>
                </button>
            </div>
            <div class="dialog-body">
                <div class="open-mode-choose">
                    <div class="media-options media-options-grid">
                        <div class="media-option" data-type="media">
                            <span class="icon-material">image</span>
                            <span>Media</span>
                        </div>
                        <div class="media-option" data-type="solid">
                            <span class="icon-material">square</span>
                            <span>Solid</span>
                        </div>
                        <div class="media-option" data-type="gradient">
                            <span class="icon-material">gradient</span>
                            <span>Gradient</span>
                        </div>
                        <div class="media-option" data-type="transparent">
                            <span class="icon-material">grid_on</span>
                            <span>Transparent</span>
                        </div>
                    </div>
                    <div class="privacy-notice">
                        <span class="icon-material">lock</span>
                        <span>All files stay on your machine. Nothing is uploaded or transmitted.</span>
                    </div>

                    <div class="load-project-section hidden">
                        <div class="section-divider">
                            <span>or</span>
                        </div>
                        <button class="action-btn load-project-btn" id="open-load-project-btn">
                            <span class="icon-material">folder_open</span>
                            Load Saved Project
                        </button>
                    </div>
                </div>

                <div class="open-mode-media hidden">
                    <button class="action-btn" id="open-back-btn">
                        <span class="icon-material">arrow_back</span>
                        Back
                    </button>
                    <div class="form-field" style="margin-top: 16px;">
                        <label for="open-file-input">Choose an image or video clip</label>
                        <input type="file" id="open-file-input" accept="image/*,video/*">
                    </div>
                    <div class="section-divider" style="margin-top: 16px;">
                        <span>or</span>
                    </div>
                    <button class="action-btn" id="open-clipboard-btn">
                        <span class="icon-material">content_paste</span>
                        Paste from Clipboard
                    </button>
                </div>
            </div>
        `

        this._backdrop.appendChild(this._modal)
        document.body.appendChild(this._backdrop)
        this._setupEventListeners()
    }

    _setMode(mode) {
        this._mode = mode

        const chooseSection = this._modal.querySelector('.open-mode-choose')
        const mediaSection = this._modal.querySelector('.open-mode-media')

        chooseSection.classList.toggle('hidden', mode !== 'choose')
        mediaSection.classList.toggle('hidden', mode !== 'media')

        const titles = { choose: 'New Project', media: 'Choose Media' }
        this._modal.querySelector('.dialog-header h2').textContent = titles[mode] || 'New Project'
    }

    _setupEventListeners() {
        const mediaOptions = this._modal.querySelectorAll('.media-option')
        mediaOptions.forEach(opt => {
            opt.addEventListener('click', () => {
                this._handleTypeSelect(opt.dataset.type)
            })
        })

        const backBtn = this._modal.querySelector('#open-back-btn')
        backBtn.addEventListener('click', () => this._setMode('choose'))

        const fileInput = this._modal.querySelector('#open-file-input')
        fileInput.addEventListener('change', () => {
            if (fileInput.files.length > 0) {
                this._handleMediaSelect(fileInput.files[0])
            }
        })

        const clipboardBtn = this._modal.querySelector('#open-clipboard-btn')
        clipboardBtn.addEventListener('click', () => {
            if (this._onClipboard) {
                this._onClipboard()
            }
        })

        const loadProjectBtn = this._modal.querySelector('#open-load-project-btn')
        loadProjectBtn.addEventListener('click', () => {
            if (this._onLoadProject) {
                this._onLoadProject()
            }
        })

        // Close button
        const closeBtn = this._modal.querySelector('.dialog-close')
        closeBtn.addEventListener('click', () => this._close())

        // Backdrop click to close
        this._backdrop.addEventListener('click', (e) => {
            if (e.target === this._backdrop) {
                this._close()
            }
        })

        // ESC key to close
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && this._backdrop.classList.contains('visible')) {
                this._close()
            }
        })
    }

    _handleTypeSelect(type) {
        switch (type) {
            case 'media':
                this._setMode('media')
                break
            case 'solid':
            case 'gradient':
            case 'transparent':
                this._showCanvasSizeDialog(type)
                break
        }
    }

    _showCanvasSizeDialog(type) {
        const callbacks = {
            solid: this._onSolid,
            gradient: this._onGradient,
            transparent: this._onTransparent
        }

        canvasSizeDialog.show({
            isRequired: true,
            onConfirm: (width, height) => {
                const callback = callbacks[type]
                if (callback) {
                    callback(width, height)
                }
            }
        })
    }

    _handleMediaSelect(file) {
        const mediaType = this._detectMediaType(file)
        if (mediaType && this._onOpen) {
            this._onOpen(file, mediaType)
        }
    }

    _detectMediaType(file) {
        if (file.type.startsWith('image/')) {
            return 'image'
        } else if (file.type.startsWith('video/')) {
            return 'video'
        }
        return null
    }
}

export const openDialog = new OpenDialog()
