/**
 * Project Manager Dialog
 * Web component for loading and deleting projects
 *
 * @module ui/project-manager-dialog
 */

import { listProjects, deleteProject as deleteProjectFromStorage } from '../utils/project-storage.js'

/**
 * ProjectManagerDialog - Modal for loading/deleting projects
 */
class ProjectManagerDialog {
    constructor() {
        this._dialog = null
        this._projects = []
        this._selectedProjectId = null
        this._onLoad = null
        this._onCancel = null
        this._isRequired = false
        this._mode = 'list' // 'list' | 'confirm-delete' | 'loading'
    }

    /**
     * Show the dialog
     * @param {object} options - Options
     * @param {function} options.onLoad - Callback: (projectId) => Promise<void>
     * @param {function} options.onCancel - Callback when cancelled (for required mode): () => void
     * @param {boolean} options.isRequired - If true, dialog cannot be closed without selection
     */
    async show(options = {}) {
        this._onLoad = options.onLoad
        this._onCancel = options.onCancel
        this._isRequired = options.isRequired || false
        this._selectedProjectId = null

        if (!this._dialog) {
            this._createDialog()
        }

        // Update UI for required mode
        this._updateRequiredMode()

        this._setMode('list')
        await this._refreshProjectList()

        this._dialog.showModal()
    }

    /**
     * Update UI elements for required mode
     * @private
     */
    _updateRequiredMode() {
        const closeBtn = this._dialog.querySelector('.dialog-close')
        const cancelBtn = this._dialog.querySelector('.pm-cancel-btn')

        closeBtn.style.display = this._isRequired ? 'none' : ''
        cancelBtn.textContent = this._isRequired ? 'Back' : 'Cancel'
    }

    /**
     * Hide the dialog
     */
    hide() {
        if (this._dialog && !this._isRequired) {
            this._dialog.close()
        }
    }

    /**
     * Force hide (used after successful load)
     * @private
     */
    _forceHide() {
        if (this._dialog) {
            this._dialog.close()
        }
    }

    /**
     * Temporarily leave the browser top layer so an app-level confirmation
     * can receive input. A failed or cancelled load reopens this dialog.
     */
    suspendForConfirmation() {
        if (this._dialog?.open) this._dialog.close()
    }

    /**
     * Create the dialog element
     * @private
     */
    _createDialog() {
        this._dialog = document.createElement('dialog')
        this._dialog.className = 'project-manager-dialog'
        this._dialog.innerHTML = `
            <div class="dialog-header">
                <h2>Open Project</h2>
                <button class="dialog-close" aria-label="Close">
                    <span class="icon-material">close</span>
                </button>
            </div>
            <div class="dialog-body">
                <!-- List mode -->
                <div class="pm-mode-list">
                    <div class="project-list" id="project-list"></div>
                    <div class="project-list-empty hidden" id="project-list-empty">
                        <span class="icon-material">folder_open</span>
                        <p>No saved projects yet</p>
                    </div>
                </div>

                <!-- Confirm delete mode -->
                <div class="pm-mode-confirm hidden">
                    <p class="confirm-message">
                        Are you sure you want to delete "<span id="delete-project-name"></span>"? This cannot be undone.
                    </p>
                </div>

                <!-- Loading mode -->
                <div class="pm-mode-loading hidden">
                    <div class="saving-indicator">
                        <div class="loading-spinner"></div>
                        <span id="loading-status">Loading project...</span>
                    </div>
                </div>
            </div>
            <div class="dialog-actions">
                <button class="action-btn pm-cancel-btn">Cancel</button>
                <button class="action-btn primary pm-open-btn" disabled>Open</button>
                <button class="action-btn confirm-cancel-btn hidden">Cancel</button>
                <button class="action-btn danger confirm-delete-btn hidden">Delete</button>
            </div>
        `

        document.body.appendChild(this._dialog)
        this._setupEventListeners()
    }

    /**
     * Set the dialog mode
     * @param {string} mode - 'list' | 'confirm-delete' | 'loading'
     * @private
     */
    _setMode(mode) {
        this._mode = mode

        const listSection = this._dialog.querySelector('.pm-mode-list')
        const confirmSection = this._dialog.querySelector('.pm-mode-confirm')
        const loadingSection = this._dialog.querySelector('.pm-mode-loading')

        const cancelBtn = this._dialog.querySelector('.pm-cancel-btn')
        const openBtn = this._dialog.querySelector('.pm-open-btn')
        const confirmCancelBtn = this._dialog.querySelector('.confirm-cancel-btn')
        const confirmDeleteBtn = this._dialog.querySelector('.confirm-delete-btn')

        listSection.classList.toggle('hidden', mode !== 'list')
        confirmSection.classList.toggle('hidden', mode !== 'confirm-delete')
        loadingSection.classList.toggle('hidden', mode !== 'loading')

        cancelBtn.classList.toggle('hidden', mode !== 'list')
        openBtn.classList.toggle('hidden', mode !== 'list')
        confirmCancelBtn.classList.toggle('hidden', mode !== 'confirm-delete')
        confirmDeleteBtn.classList.toggle('hidden', mode !== 'confirm-delete')
    }

    /**
     * Refresh the project list
     * @private
     */
    async _refreshProjectList() {
        try {
            this._projects = await listProjects()
        } catch (err) {
            console.error('[ProjectManagerDialog] Failed to list projects:', err)
            this._projects = []
        }

        this._renderProjectList()
    }

    /**
     * Render the project list
     * @private
     */
    _renderProjectList() {
        const listEl = this._dialog.querySelector('#project-list')
        const emptyEl = this._dialog.querySelector('#project-list-empty')
        const openBtn = this._dialog.querySelector('.pm-open-btn')

        if (this._projects.length === 0) {
            listEl.classList.add('hidden')
            emptyEl.classList.remove('hidden')
            openBtn.disabled = true
            return
        }

        listEl.classList.remove('hidden')
        emptyEl.classList.add('hidden')

        listEl.innerHTML = this._projects.map(project => `
            <div class="project-item${project.id === this._selectedProjectId ? ' selected' : ''}" data-id="${project.id}">
                <div class="project-item-info">
                    <div class="project-item-name">${this._escapeHtml(project.name)}</div>
                    <div class="project-item-date">${this._formatDate(project.modifiedAt)}</div>
                </div>
                <button class="project-item-delete" data-id="${project.id}" title="Delete project">
                    <span class="icon-material">delete</span>
                </button>
            </div>
        `).join('')

        // Update open button state
        openBtn.disabled = !this._selectedProjectId

        // Re-attach event listeners
        this._setupProjectListeners()
    }

    /**
     * Set up project list event listeners
     * @private
     */
    _setupProjectListeners() {
        const listEl = this._dialog.querySelector('#project-list')

        // Item click (select)
        listEl.querySelectorAll('.project-item').forEach(item => {
            item.addEventListener('click', (e) => {
                // Ignore if clicking delete button
                if (e.target.closest('.project-item-delete')) return

                this._selectedProjectId = item.dataset.id
                this._renderProjectList()
            })

            // Double-click to open
            item.addEventListener('dblclick', (e) => {
                if (e.target.closest('.project-item-delete')) return

                this._selectedProjectId = item.dataset.id
                this._handleOpen()
            })
        })

        // Delete button click
        listEl.querySelectorAll('.project-item-delete').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation()
                this._showDeleteConfirm(btn.dataset.id)
            })
        })
    }

    /**
     * Set up event listeners
     * @private
     */
    _setupEventListeners() {
        const closeBtn = this._dialog.querySelector('.dialog-close')
        const cancelBtn = this._dialog.querySelector('.pm-cancel-btn')
        const openBtn = this._dialog.querySelector('.pm-open-btn')
        const confirmCancelBtn = this._dialog.querySelector('.confirm-cancel-btn')
        const confirmDeleteBtn = this._dialog.querySelector('.confirm-delete-btn')

        closeBtn.addEventListener('click', () => this.hide())
        cancelBtn.addEventListener('click', () => this._handleCancel())

        openBtn.addEventListener('click', () => this._handleOpen())

        confirmCancelBtn.addEventListener('click', () => {
            this._pendingDeleteId = null
            this._setMode('list')
        })

        confirmDeleteBtn.addEventListener('click', () => this._handleDelete())
    }

    /**
     * Handle cancel/back action
     * @private
     */
    _handleCancel() {
        if (this._isRequired && this._onCancel) {
            this._forceHide()
            this._onCancel()
        } else {
            this.hide()
        }
    }

    /**
     * Show delete confirmation
     * @param {string} projectId - Project ID to delete
     * @private
     */
    _showDeleteConfirm(projectId) {
        const project = this._projects.find(p => p.id === projectId)
        if (!project) return

        this._pendingDeleteId = projectId
        this._dialog.querySelector('#delete-project-name').textContent = project.name
        this._setMode('confirm-delete')
    }

    /**
     * Handle open button click
     * @private
     */
    async _handleOpen() {
        if (!this._selectedProjectId) return

        this._setMode('loading')
        this._dialog.querySelector('#loading-status').textContent = 'Loading project...'

        try {
            if (this._onLoad) {
                await this._onLoad(this._selectedProjectId)
            }
            this._forceHide()
        } catch (err) {
            console.error('[ProjectManagerDialog] Load failed:', err)
            this._setMode('list')
            if (!this._dialog.open) this._dialog.showModal()
        }
    }

    /**
     * Handle delete confirmation
     * @private
     */
    async _handleDelete() {
        if (!this._pendingDeleteId) return

        this._setMode('loading')
        this._dialog.querySelector('#loading-status').textContent = 'Deleting project...'

        try {
            await deleteProjectFromStorage(this._pendingDeleteId)

            // Clear selection if we deleted the selected project
            if (this._selectedProjectId === this._pendingDeleteId) {
                this._selectedProjectId = null
            }

            this._pendingDeleteId = null
            await this._refreshProjectList()
            this._setMode('list')
        } catch (err) {
            console.error('[ProjectManagerDialog] Delete failed:', err)
            this._setMode('list')
        }
    }

    /**
     * Format a timestamp as a readable date
     * @param {number} timestamp - Unix timestamp
     * @returns {string}
     * @private
     */
    _formatDate(timestamp) {
        const MS_PER_MINUTE = 60000
        const MS_PER_HOUR = 3600000
        const MS_PER_DAY = 86400000
        const MS_PER_WEEK = 604800000

        const date = new Date(timestamp)
        const diff = Date.now() - date

        if (diff < MS_PER_MINUTE) return 'Just now'
        if (diff < MS_PER_HOUR) return `${Math.floor(diff / MS_PER_MINUTE)} minutes ago`
        if (diff < MS_PER_DAY) return `${Math.floor(diff / MS_PER_HOUR)} hours ago`
        if (diff < MS_PER_WEEK) return date.toLocaleDateString(undefined, { weekday: 'long' })

        return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
    }

    /**
     * Escape HTML entities
     * @param {string} str - String to escape
     * @returns {string}
     * @private
     */
    _escapeHtml(str) {
        const div = document.createElement('div')
        div.textContent = str
        return div.innerHTML
    }
}

// Export singleton
export const projectManagerDialog = new ProjectManagerDialog()
