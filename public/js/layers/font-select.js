/**
 * Font Select Web Component
 *
 * A font picker dialog with search, tags, and font preview.
 * Based on slotEffectSelect pattern with font-specific enhancements.
 *
 * @module layers/font-select
 */

// Track the currently open dialog globally
let currentOpenFontDialog = null

// Style injection for light DOM
const FONT_SELECT_STYLES_ID = 'font-select-styles'
if (!document.getElementById(FONT_SELECT_STYLES_ID)) {
    const style = document.createElement('style')
    style.id = FONT_SELECT_STYLES_ID
    style.textContent = `
        font-select {
            display: block;
            position: relative;
            font-family: Nunito, 'Nunito Block';
            width: 100%;
            box-sizing: border-box;
        }

        font-select[disabled] {
            opacity: 0.5;
            pointer-events: none;
        }

        font-select .select-trigger {
            all: unset;
            display: flex;
            align-items: center;
            gap: 6px;
            width: 100%;
            padding: 0.25rem 0.375rem;
            box-sizing: border-box;
            background: color-mix(in srgb, var(--hf-accent-3) 15%, transparent 85%);
            border: none;
            border-radius: var(--hf-radius-sm);
            color: var(--hf-color-7);
            font-family: Nunito, 'Nunito Block';
            font-size: 0.6875rem;
            font-weight: 560;
            cursor: pointer;
        }

        font-select .trigger-text {
            flex: 1;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }

        font-select .trigger-arrow {
            font-size: 0.6rem;
            color: var(--hf-color-5);
            flex-shrink: 0;
            margin-left: auto;
            transition: transform 0.15s ease;
        }

        font-select.dropdown-open .trigger-arrow {
            transform: rotate(180deg);
        }

        font-select .font-dialog {
            border: none;
            border-radius: var(--hf-radius-lg);
            padding: 0 !important;
            margin: auto;
            color: var(--hf-color-7);
            min-width: 280px;
            max-width: 400px;
            width: min(400px, 92vw);
            overflow: hidden;
        }

        font-select .font-dialog::backdrop {
            background: rgba(0, 0, 0, 0.6);
            backdrop-filter: blur(4px);
        }

        font-select .dialog-titlebar {
            background: linear-gradient(180deg, rgba(255,255,255,0.02) 0%, transparent 100%);
            border-bottom: 1px solid var(--hf-color-3);
            padding: 8px 12px;
            font-size: 0.7rem;
            font-weight: 600;
            color: var(--hf-color-7);
            text-transform: lowercase;
            letter-spacing: 0.05em;
            display: flex;
            align-items: center;
            gap: 8px;
        }

        font-select .dialog-title {
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }

        font-select .dialog-close {
            background: transparent;
            border: none;
            color: var(--hf-color-5);
            cursor: pointer;
            font-size: 0.8rem;
            padding: 4px;
            width: auto;
            height: auto;
            line-height: 1;
            opacity: 0.7;
            transition: opacity 0.15s ease;
            margin-left: auto;
        }

        font-select .dialog-close:hover {
            opacity: 1;
            color: var(--hf-color-7);
        }

        font-select .dialog-body {
            padding: 0;
            max-height: 360px;
            overflow: hidden;
            display: flex;
            flex-direction: column;
        }

        font-select .dropdown-search {
            position: relative;
            z-index: 2;
            padding: 6px 10px;
            background: color-mix(in srgb, var(--hf-color-1) 70%, transparent 30%);
            border-bottom: 1px solid color-mix(in srgb, var(--hf-accent-3) 15%, transparent 85%);
            box-sizing: border-box;
            display: flex;
            align-items: center;
            gap: 6px;
        }

        font-select .search-clear {
            background: transparent;
            border: none;
            color: var(--hf-color-5);
            cursor: pointer;
            padding: 4px;
            line-height: 1;
            opacity: 0.6;
            transition: opacity 0.15s ease, color 0.15s ease;
            display: flex;
            align-items: center;
            justify-content: center;
            flex-shrink: 0;
            font-size: 0.75rem;
        }

        font-select .search-clear:hover {
            opacity: 1;
            color: var(--hf-color-7);
        }

        font-select .search-clear[hidden] {
            display: none;
        }

        font-select .search-input {
            width: 100%;
            max-width: 100%;
            box-sizing: border-box;
            font-family: inherit;
            font-size: 0.8rem;
            font-weight: 600;
            text-transform: lowercase;
            letter-spacing: 0.05em;
            color: var(--hf-color-7);
            background: transparent;
            border: none;
            padding: 2px 0;
            outline: none;
        }

        font-select .search-input::placeholder {
            color: var(--hf-color-5);
            opacity: 0.7;
        }

        font-select .dropdown-options {
            outline: none;
            overflow-x: hidden;
            overflow-y: auto;
            flex: 1;
        }

        font-select .group-header {
            padding: 6px 10px;
            font-size: 0.65rem;
            font-weight: 700;
            text-transform: lowercase;
            letter-spacing: 0.05em;
            color: var(--hf-accent-3);
            background: color-mix(in srgb, var(--hf-color-1) 70%, transparent 30%);
            border-bottom: 1px solid color-mix(in srgb, var(--hf-accent-3) 15%, transparent 85%);
            position: sticky;
            top: 0;
            z-index: 1;
        }

        font-select .option {
            padding: 6px 10px;
            cursor: pointer;
            transition: background 0.1s ease;
            border-bottom: 1px solid color-mix(in srgb, var(--hf-accent-3) 8%, transparent 92%);
            display: grid;
            grid-template-columns: 1fr auto;
            column-gap: 8px;
            align-items: center;
        }

        font-select .option:last-child {
            border-bottom: none;
        }

        font-select .option:hover,
        font-select .option.focused {
            background: color-mix(in srgb, var(--hf-accent-3) 20%, transparent 80%);
        }

        font-select .option.selected {
            background: color-mix(in srgb, var(--hf-accent-3) 30%, transparent 70%);
        }

        font-select .option-name {
            font-size: 0.75rem;
            font-weight: 500;
            color: var(--hf-color-7);
            min-width: 0;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }

        font-select .option-tags {
            display: inline-flex;
            flex-wrap: nowrap;
            gap: 2px;
            flex-shrink: 0;
            min-width: 0;
            overflow: hidden;
        }

        font-select .option-tag {
            font-size: 0.6rem;
            font-weight: 700;
            text-transform: lowercase;
            letter-spacing: 0.04em;
            padding: 1px 6px;
            background: color-mix(in srgb, var(--hf-accent-3) 15%, transparent 85%);
            border: none;
            border-radius: var(--hf-radius-sm);
            color: var(--hf-accent-3);
            opacity: 0.65;
            cursor: pointer;
            transition: opacity 0.15s ease, background 0.15s ease;
            font-family: Nunito, 'Nunito Block';
        }

        font-select .option-tag:hover {
            opacity: 1;
            background: color-mix(in srgb, var(--hf-accent-3) 25%, transparent 75%);
        }

        font-select .dropdown-options::-webkit-scrollbar {
            width: 0.3rem;
        }

        font-select .dropdown-options::-webkit-scrollbar-track {
            background: transparent;
        }

        font-select .dropdown-options::-webkit-scrollbar-thumb {
            background: color-mix(in srgb, var(--hf-accent-3) 30%, transparent 70%);
            border-radius: 0.2rem;
        }

        font-select .dropdown-options::-webkit-scrollbar-thumb:hover {
            background: color-mix(in srgb, var(--hf-accent-3) 50%, transparent 50%);
        }

        font-select .dropdown-options {
            scrollbar-width: thin;
            scrollbar-color: color-mix(in srgb, var(--hf-accent-3) 30%, transparent 70%) transparent;
        }

        font-select .empty-message {
            padding: 16px 12px;
            font-size: 0.75rem;
            font-style: italic;
            color: var(--hf-color-5);
            text-align: center;
        }

        font-select .font-install-prompt {
            padding: 10px 12px;
            border-top: 1px solid var(--hf-color-3);
            text-align: center;
        }

        font-select .font-install-btn {
            display: inline-flex;
            align-items: center;
            gap: 6px;
            padding: 6px 12px;
            background: color-mix(in srgb, var(--hf-accent-3) 20%, transparent 80%);
            border: 1px solid color-mix(in srgb, var(--hf-accent-3) 40%, transparent 60%);
            border-radius: var(--hf-radius-sm);
            color: var(--hf-color-7);
            font-family: Nunito, 'Nunito Block';
            font-size: 0.75rem;
            font-weight: 600;
            cursor: pointer;
            transition: background 0.15s ease;
        }

        font-select .font-install-btn:hover {
            background: color-mix(in srgb, var(--hf-accent-3) 35%, transparent 65%);
        }
    `
    document.head.appendChild(style)
}

/**
 * Normalize text for case-insensitive matching.
 * @param {string} str
 * @returns {string}
 */
function normalizeForSearch(str) {
    return (str || '')
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .trim()
}

/**
 * FontSelect - Web component for font selection with preview and search
 * @extends HTMLElement
 */
/**
 * CSS font stack for showing a font name in its own typeface.
 *
 * Bundled fonts register their preview face under a dedicated family (see
 * `previewFamilyFor`) so it cannot outrank the weight/style a text layer
 * selected. Base/system fonts have no preview registration, so the real family
 * is kept as the fallback and they still preview correctly.
 *
 * @param {{value: string, previewFamily?: string}} option
 * @returns {string} CSS font-family value
 */
function previewFontStack(option) {
    const family = option?.previewFamily
    const name = option?.value || ''
    return family ? `"${family}", ${name}` : name
}

class FontSelect extends HTMLElement {
    static get observedAttributes() {
        return ['value', 'disabled', 'name']
    }

    constructor() {
        super()

        /** @type {Array<{value: string, text: string, category?: string, tags?: string[]}>} */
        this._allOptions = []

        /** @type {Array<{value: string, text: string, category?: string, tags?: string[]}>} */
        this._filteredOptions = []

        /** @type {string} */
        this._value = ''

        /** @type {boolean} */
        this._isOpen = false

        /** @type {number} */
        this._focusedIndex = -1

        /** @type {string} */
        this._filterText = ''

        /** @type {boolean} */
        this._rendered = false

        /** @type {boolean} */
        this._listenersAttached = false
    }

    connectedCallback() {
        if (!this._rendered) {
            this._render()
            this._rendered = true
        }
        if (!this._listenersAttached) {
            this._setupEventListeners()
            this._listenersAttached = true
        }
        this._updateDisplay()
    }

    disconnectedCallback() {
        this._removeDocumentCloseHandler()
        this._close()
    }

    attributeChangedCallback(name, oldValue, newValue) {
        if (oldValue === newValue) return

        switch (name) {
            case 'value':
                this._value = newValue || ''
                this._updateDisplay()
                break
            case 'disabled':
                this._updateDisabledState()
                break
        }
    }

    // ========================================================================
    // Public API
    // ========================================================================

    get value() {
        return this._value
    }

    set value(val) {
        const strVal = String(val ?? '')
        if (this._value === strVal) return

        this._value = strVal
        this.setAttribute('value', this._value)
        this._updateDisplay()
    }

    get disabled() {
        return this.hasAttribute('disabled')
    }

    set disabled(val) {
        if (val) {
            this.setAttribute('disabled', '')
        } else {
            this.removeAttribute('disabled')
        }
    }

    get name() {
        return this.getAttribute('name')
    }

    set name(val) {
        if (val) {
            this.setAttribute('name', val)
        } else {
            this.removeAttribute('name')
        }
    }

    get selectedIndex() {
        return this._allOptions.findIndex(o => o.value === this._value)
    }

    set selectedIndex(idx) {
        if (idx >= 0 && idx < this._allOptions.length) {
            this.value = this._allOptions[idx].value
        }
    }

    /**
     * Set the font options
     * @param {Array<{value: string, text: string, category?: string, tags?: string[]}>} options
     */
    setOptions(options) {
        this._allOptions = options || []
        this._applyFilter()
        this._renderDropdown()
        this._updateDisplay()
    }

    getOptions() {
        return this._allOptions.slice()
    }

    // ========================================================================
    // Private Methods
    // ========================================================================

    _render() {
        this.innerHTML = `
            <button class="select-trigger" type="button" aria-haspopup="listbox" aria-expanded="false">
                <span class="trigger-text">select...</span>
                <span class="trigger-arrow">▼</span>
            </button>
            <dialog class="font-dialog" aria-label="select font">
                <div class="dialog-titlebar">
                    <span class="dialog-title">select font</span>
                    <button class="dialog-close" type="button" aria-label="close">✕</button>
                </div>
                <div class="dialog-body">
                    <div class="dropdown-search">
                        <button class="search-clear" type="button" aria-label="clear search" hidden>✕</button>
                        <input class="search-input" type="text" placeholder="search fonts..." autocomplete="off" spellcheck="false" />
                    </div>
                    <div class="dropdown-options" role="listbox" tabindex="-1"></div>
                </div>
            </dialog>
        `
    }

    _installDocumentCloseHandler() {
        if (this._onDocumentClick) return
        this._onDocumentClick = (e) => {
            if (this.contains(e.target)) return
            this._close()
        }
        document.addEventListener('click', this._onDocumentClick, true)
    }

    _removeDocumentCloseHandler() {
        if (!this._onDocumentClick) return
        document.removeEventListener('click', this._onDocumentClick, true)
        this._onDocumentClick = null
    }

    _setupEventListeners() {
        const trigger = this.querySelector('.select-trigger')
        const dialog = this.querySelector('.font-dialog')
        const dropdownOptions = this.querySelector('.dropdown-options')
        const searchInput = this.querySelector('.search-input')
        const searchClear = this.querySelector('.search-clear')
        const closeBtn = this.querySelector('.dialog-close')

        if (!trigger || !dialog || !dropdownOptions) return

        trigger.addEventListener('click', (e) => {
            e.stopPropagation()
            if (this.disabled) return
            this._toggle()
        })

        // Select on option click, or add tag to search on tag click
        dropdownOptions.addEventListener('click', (e) => {
            const tag = e.target.closest('.option-tag')
            if (tag) {
                e.stopPropagation()
                this._addTagToSearch(tag.textContent)
                return
            }

            const option = e.target.closest('.option')
            if (option) {
                this._selectOption(option.dataset.value)
            }
        })

        // Filter on search input
        if (searchInput) {
            searchInput.addEventListener('input', () => {
                this._filterText = searchInput.value
                this._applyFilter()
                this._renderDropdown()

                if (searchClear) {
                    searchClear.hidden = !searchInput.value.trim()
                }
            })
        }

        if (searchClear) {
            searchClear.addEventListener('click', () => {
                if (searchInput) {
                    searchInput.value = ''
                    this._filterText = ''
                    this._applyFilter()
                    this._renderDropdown()
                    searchClear.hidden = true
                    searchInput.focus()
                }
            })
        }

        if (closeBtn) {
            closeBtn.addEventListener('click', () => this._close())
        }

        dialog.addEventListener('click', (e) => {
            if (e.target === dialog) {
                this._close()
            }
        })

        dialog.addEventListener('cancel', (e) => {
            e.preventDefault()
            this._close()
        })

        dialog.addEventListener('close', () => {
            this._onClosed()
        })

        trigger.addEventListener('keydown', (e) => this._handleKeydown(e))
        dialog.addEventListener('keydown', (e) => this._handleKeydown(e))
    }

    /**
     * Add a tag to the search input
     * @param {string} tag
     * @private
     */
    _addTagToSearch(tag) {
        const searchInput = this.querySelector('.search-input')
        if (!searchInput) return

        const currentTerms = searchInput.value.trim()
        const terms = currentTerms ? currentTerms.split(/\s+/) : []

        if (!terms.includes(tag)) {
            terms.push(tag)
            searchInput.value = terms.join(' ')
            this._filterText = searchInput.value
            this._applyFilter()
            this._renderDropdown()
            searchInput.focus()

            const searchClear = this.querySelector('.search-clear')
            if (searchClear) {
                searchClear.hidden = false
            }
        }
    }

    /**
     * Apply current filter text to options
     * @private
     */
    _applyFilter() {
        const q = normalizeForSearch(this._filterText)
        if (!q) {
            this._filteredOptions = this._allOptions
        } else {
            const terms = q.split(' ').filter(Boolean)
            this._filteredOptions = this._allOptions.filter(opt => {
                const name = opt.text || opt.value || ''
                const category = opt.category || ''
                const tags = Array.isArray(opt.tags) ? opt.tags.join(' ') : ''

                const haystack = normalizeForSearch([name, category, tags].join(' '))
                return terms.every(term => haystack.includes(term))
            })
        }
        this._focusedIndex = -1
    }

    _renderDropdown() {
        const dropdownOptions = this.querySelector('.dropdown-options')
        if (!dropdownOptions) return

        dropdownOptions.innerHTML = ''

        if (this._filteredOptions.length === 0) {
            const emptyMsg = document.createElement('div')
            emptyMsg.className = 'empty-message'
            emptyMsg.textContent = this._allOptions.length === 0 ? 'no fonts available' : 'no matching fonts'
            dropdownOptions.appendChild(emptyMsg)
            return
        }

        // Group by category
        const byCategory = {}
        for (const opt of this._filteredOptions) {
            const cat = opt.category || 'other'
            if (!byCategory[cat]) {
                byCategory[cat] = []
            }
            byCategory[cat].push(opt)
        }

        // Sort categories in a fixed order, with unknown categories at the end
        const categoryOrder = ['sans-serif', 'serif', 'monospace', 'display', 'handwriting', 'other']
        const sortedCategories = Object.keys(byCategory).sort((a, b) => {
            const aIdx = categoryOrder.indexOf(a)
            const bIdx = categoryOrder.indexOf(b)
            if (aIdx === -1 && bIdx === -1) return a.localeCompare(b)
            if (aIdx === -1) return 1
            if (bIdx === -1) return -1
            return aIdx - bIdx
        })

        for (const cat of sortedCategories) {
            const header = document.createElement('div')
            header.className = 'group-header'
            header.textContent = cat
            dropdownOptions.appendChild(header)

            const sorted = byCategory[cat].sort((a, b) => (a.text || '').localeCompare(b.text || ''))
            for (const opt of sorted) {
                dropdownOptions.appendChild(this._createOptionElement(opt))
            }
        }

        this._updateSelectedOption()
        this._appendInstallPrompt(dropdownOptions)
    }

    /**
     * Create a single option element for the dropdown
     * @param {object} opt - Option data with value, text, tags
     * @returns {HTMLElement}
     * @private
     */
    _createOptionElement(opt) {
        const option = document.createElement('div')
        option.className = 'option'
        option.dataset.value = opt.value
        option.setAttribute('role', 'option')

        const nameSpan = document.createElement('span')
        nameSpan.className = 'option-name'
        nameSpan.textContent = opt.text || opt.value
        // Previews are registered under their own family so they cannot shadow
        // the weight/style the text layer actually selected.
        nameSpan.style.fontFamily = previewFontStack(opt)
        option.appendChild(nameSpan)

        const tagsSpan = document.createElement('span')
        tagsSpan.className = 'option-tags'
        if (opt.tags && opt.tags.length > 0) {
            for (const tag of opt.tags) {
                const tagSpan = document.createElement('span')
                tagSpan.className = 'option-tag'
                tagSpan.textContent = tag
                tagsSpan.appendChild(tagSpan)
            }
        }
        option.appendChild(tagsSpan)

        return option
    }

    /**
     * Append install prompt to dropdown if bundle not installed
     * @private
     */
    async _appendInstallPrompt(dropdownOptions) {
        try {
            const { getFontaineLoader } = await import('./fontaine-loader.js')
            const loader = getFontaineLoader()
            const installed = await loader.isInstalled()

            if (!installed) {
                const installRow = document.createElement('div')
                installRow.className = 'font-install-prompt'
                installRow.innerHTML = `
                    <button class="font-install-btn" type="button">
                        <span class="material-symbols-outlined" style="font-size: 16px;">font_download</span>
                        Install Font Bundle (100+ fonts)
                    </button>
                `
                installRow.querySelector('.font-install-btn').addEventListener('click', (e) => {
                    e.stopPropagation()
                    this._close()
                    document.dispatchEvent(new CustomEvent('font-install-request'))
                })
                dropdownOptions.appendChild(installRow)
            }
        } catch (e) {
            // Fontaine loader not available, skip install prompt
        }
    }

    _updateDisplay() {
        const triggerText = this.querySelector('.trigger-text')
        if (!triggerText) return

        const selected = this._allOptions.find(o => o.value === this._value)
        triggerText.textContent = selected ? (selected.text || selected.value) : (this._value || 'select...')
        triggerText.style.fontFamily = previewFontStack(
            this._allOptions?.find(o => o.value === this._value) || { value: this._value })

        this._updateSelectedOption()
    }

    _updateSelectedOption() {
        const dropdownOptions = this.querySelector('.dropdown-options')
        if (!dropdownOptions) return

        dropdownOptions.querySelectorAll('.option').forEach(option => {
            option.classList.toggle('selected', option.dataset.value === this._value)
        })
    }

    _handleKeydown(e) {
        const isSearchInput = e.target?.classList?.contains('search-input')

        if (isSearchInput) {
            if (e.key === 'Escape') {
                e.preventDefault()
                this._close()
            } else if (e.key === 'ArrowDown') {
                e.preventDefault()
                if (this._focusedIndex < 0) {
                    const selectedIdx = this._filteredOptions.findIndex(o => o.value === this._value)
                    this._focusedIndex = selectedIdx >= 0 ? selectedIdx : 0
                }
                this._updateFocusedOption()
                this.querySelector('.dropdown-options')?.focus()
            } else if (e.key === 'Enter') {
                e.preventDefault()
                if (this._focusedIndex >= 0 && this._focusedIndex < this._filteredOptions.length) {
                    this._selectOption(this._filteredOptions[this._focusedIndex].value)
                } else if (this._filteredOptions.length === 1) {
                    this._selectOption(this._filteredOptions[0].value)
                }
            }
            return
        }

        switch (e.key) {
            case 'Enter':
                e.preventDefault()
                if (this._isOpen) {
                    if (this._focusedIndex >= 0 && this._focusedIndex < this._filteredOptions.length) {
                        this._selectOption(this._filteredOptions[this._focusedIndex].value)
                    } else {
                        this._close()
                    }
                } else {
                    this._open()
                }
                break
            case ' ':
                e.preventDefault()
                if (!this._isOpen) {
                    this._open()
                }
                break
            case 'ArrowDown':
                e.preventDefault()
                if (this._isOpen) {
                    this._moveFocus(1)
                }
                break
            case 'ArrowUp':
                e.preventDefault()
                if (this._isOpen) {
                    this._moveFocus(-1)
                }
                break
            case 'Escape':
                this._close()
                break
            case 'Home':
                e.preventDefault()
                if (this._filteredOptions.length > 0) {
                    this._focusedIndex = 0
                    this._updateFocusedOption()
                }
                break
            case 'End':
                e.preventDefault()
                if (this._filteredOptions.length > 0) {
                    this._focusedIndex = this._filteredOptions.length - 1
                    this._updateFocusedOption()
                }
                break
            default:
                if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
                    const searchInput = this.querySelector('.search-input')
                    if (searchInput && this._isOpen) {
                        searchInput.focus()
                        searchInput.value = e.key
                        this._filterText = e.key
                        this._applyFilter()
                        this._renderDropdown()
                    }
                }
        }
    }

    _toggle() {
        if (this._isOpen) {
            this._close()
        } else {
            this._open()
        }
    }

    _open() {
        const trigger = this.querySelector('.select-trigger')
        const dialog = this.querySelector('.font-dialog')
        if (!dialog) return

        if (currentOpenFontDialog && currentOpenFontDialog !== this) {
            currentOpenFontDialog._close()
        }

        currentOpenFontDialog = this
        this._isOpen = true
        this.classList.add('dropdown-open')
        trigger?.setAttribute('aria-expanded', 'true')

        // Reset filter on open
        const searchInput = this.querySelector('.search-input')
        const searchClear = this.querySelector('.search-clear')
        if (searchInput) {
            searchInput.value = ''
        }
        if (searchClear) {
            searchClear.hidden = true
        }
        this._filterText = ''
        this._applyFilter()
        this._renderDropdown()

        // Focus current selection
        const selectedIdx = this._filteredOptions.findIndex(o => o.value === this._value)
        this._focusedIndex = selectedIdx >= 0 ? selectedIdx : 0

        if (!dialog.open) {
            dialog.showModal()
        }

        this._installDocumentCloseHandler()

        if (searchInput) {
            searchInput.focus()
        }

        this._updateFocusedOption()

        // Scroll selected into view
        const selected = dialog.querySelector('.option.selected')
        if (selected) {
            selected.scrollIntoView({ block: 'center' })
        }
    }

    _close() {
        const dialog = this.querySelector('.font-dialog')
        if (dialog?.open) {
            dialog.close()
        } else {
            this._onClosed()
        }
    }

    _onClosed() {
        const trigger = this.querySelector('.select-trigger')
        this._isOpen = false
        this._focusedIndex = -1
        this.classList.remove('dropdown-open')
        this._clearFocus()

        if (trigger) {
            trigger.setAttribute('aria-expanded', 'false')
        }

        this._removeDocumentCloseHandler()

        // Reset filter
        const searchInput = this.querySelector('.search-input')
        if (searchInput) {
            searchInput.value = ''
        }
        this._filterText = ''
        this._applyFilter()
        this._renderDropdown()

        if (currentOpenFontDialog === this) {
            currentOpenFontDialog = null
        }

        this.dispatchEvent(new CustomEvent('closed', { bubbles: true }))
    }

    _selectOption(value) {
        const oldVal = this._value
        this._value = value
        this.setAttribute('value', value)
        this._updateDisplay()
        this._close()

        if (oldVal !== value) {
            this.dispatchEvent(new Event('change', { bubbles: true }))
        }
    }

    _moveFocus(offset) {
        if (this._filteredOptions.length === 0) return

        this._focusedIndex += offset
        if (this._focusedIndex < 0) {
            this._focusedIndex = this._filteredOptions.length - 1
        }
        if (this._focusedIndex >= this._filteredOptions.length) {
            this._focusedIndex = 0
        }
        this._updateFocusedOption()
    }

    _updateFocusedOption() {
        this._clearFocus()

        if (this._focusedIndex >= 0 && this._focusedIndex < this._filteredOptions.length) {
            const value = this._filteredOptions[this._focusedIndex].value
            const dialog = this.querySelector('.font-dialog')
            const option = dialog?.querySelector(`.option[data-value="${CSS.escape(value)}"]`)
            if (option) {
                option.classList.add('focused')
                option.scrollIntoView({ block: 'nearest' })
            }
        }
    }

    _clearFocus() {
        const dropdownOptions = this.querySelector('.dropdown-options')
        dropdownOptions?.querySelectorAll('.option.focused').forEach(o => o.classList.remove('focused'))
    }

    _updateDisabledState() {
        const trigger = this.querySelector('.select-trigger')
        if (trigger) {
            trigger.disabled = this.disabled
        }
        if (this.disabled) {
            this._close()
        }
    }
}

// Register the custom element
if (!customElements.get('font-select')) {
    customElements.define('font-select', FontSelect)
}

export { FontSelect }
