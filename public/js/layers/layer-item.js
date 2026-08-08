/**
 * Layer Item Web Component
 * Individual layer in the stack
 *
 * @module layers/layer-item
 */

import { BLEND_MODES } from './blend-modes.js'
import './effect-params.js'
import { SelectDropdown, SliderValue } from 'handfish'

/**
 * LayerItem - Web component for a single layer
 * @extends HTMLElement
 */
class LayerItem extends HTMLElement {
    constructor() {
        super()
        this._layer = null
        this._selected = false
        this._paramsExpanded = false
        this._dragFromHandle = false
        this._isChild = false
        this._parentLayerId = null
        this._listenersAttached = false
    }

    connectedCallback() {
        this._render()
        if (!this._listenersAttached) {
            this._setupEventListeners()
            this._listenersAttached = true
        }
    }

    /**
     * Set the layer data
     * @param {object} layer - Layer object
     */
    set layer(layer) {
        this._layer = layer
        this._render()
    }

    /**
     * Get the layer data
     * @returns {object} Layer object
     */
    get layer() {
        return this._layer
    }

    /**
     * Set selected state
     * @param {boolean} selected
     */
    set selected(selected) {
        this._selected = selected
        this.classList.toggle('selected', selected)
    }

    /**
     * Get selected state
     * @returns {boolean}
     */
    get selected() {
        return this._selected
    }

    set isChild(val) {
        this._isChild = val
    }

    get isChild() {
        return this._isChild
    }

    set parentLayerId(val) {
        this._parentLayerId = val
    }

    /**
     * Render the component
     * @private
     */
    _render() {
        if (!this._layer) {
            this.innerHTML = ''
            return
        }

        const layer = this._layer
        const isVisible = layer.visible
        const isEffect = layer.sourceType === 'effect'
        const isBase = this.hasAttribute('base')

        let iconName = 'image'
        if (this._isChild) iconName = 'tune'
        else if (isEffect) iconName = 'auto_awesome'
        else if (layer.sourceType === 'drawing') iconName = 'draw'
        else if (layer.mediaType === 'video') iconName = 'videocam'

        const classes = [
            'layer-item',
            isEffect ? 'effect-layer' : 'media-layer',
            isBase && 'base-layer',
            this._isChild && 'child-layer',
            layer.locked && 'locked',
            this._selected && 'selected'
        ].filter(Boolean).join(' ')
        this.className = classes
        this.dataset.layerId = layer.id
        this.draggable = !isBase

        this.innerHTML = `
            <div class="layer-row">
                <div class="layer-drag-handle" title="Drag to reorder">
                    <span class="icon-material">drag_indicator</span>
                </div>
                <button class="layer-visibility ${isVisible ? 'visible' : ''}" title="Toggle visibility">
                    <span class="icon-material">${isVisible ? 'visibility' : 'visibility_off'}</span>
                </button>
                <div class="layer-thumbnail">
                    <span class="icon-material">${iconName}</span>
                </div>
                ${layer.mask ? `<div class="layer-mask-thumbnail ${layer.maskVisible ? 'mask-visible' : ''} ${(!this._isChild && !layer.maskEnabled) ? 'mask-disabled' : ''}" title="${this._isChild ? 'Effect mask (captured from selection) | Click: mask options' : 'Click: edit mask | Right-click: mask options'}">
                    <canvas class="mask-thumb-canvas" width="36" height="36"></canvas>
                </div>` : ''}
                <div class="layer-info">
                    <div class="layer-name" contenteditable="false" spellcheck="false">${this._escapeHtml(layer.name)}</div>
                    <div class="layer-type ${layer.sourceType}">${this._formatLayerType(layer)}</div>
                </div>
                ${!this._isChild ? `<button class="layer-add-child" title="Add effect">
                    <span class="icon-material">add</span>
                </button>` : ''}
                <button class="layer-delete" title="Delete layer">
                    <span class="icon-material">close</span>
                </button>
            </div>
            <div class="layer-controls">
                <button class="layer-params-toggle ${this._paramsExpanded ? 'expanded' : ''}" title="Toggle parameters">
                    <span class="icon-material">arrow_right</span>
                </button>
                ${!this._isChild ? `<select-dropdown class="layer-blend-mode" title="Blend mode"></select-dropdown>
                <div class="layer-opacity-container">
                    <slider-value class="layer-opacity" min="0" max="100" step="1" type="int" value="${layer.opacity}" title="Opacity"></slider-value>
                </div>` : ''}
            </div>
            <effect-params class="layer-effect-params"></effect-params>
        `

        // Initialize blend mode select-dropdown
        const blendSelect = this.querySelector('.layer-blend-mode')
        if (blendSelect && !this._isChild) {
            const opts = BLEND_MODES.map(mode => ({
                value: mode.id,
                text: mode.name
            }))
            blendSelect.setOptions(opts)
            blendSelect.value = layer.blendMode || 'mix'
        }

        this._initEffectParams()
        this._renderMaskThumbnail()
    }

    /**
     * Initialize effect params component
     * @private
     */
    _initEffectParams() {
        const paramsEl = this.querySelector('effect-params')
        if (!paramsEl || !this._layer) return

        // Use effectId for effects/children, 'synth/media' for media layers
        const effectId = (this._layer.sourceType === 'effect' || this._isChild)
            ? this._layer.effectId
            : 'synth/media'

        if (effectId) {
            paramsEl.setEffect(
                effectId,
                this._layer.id,
                this._layer.effectParams || {}
            )
            // Apply expanded state via class
            this.classList.toggle('params-expanded', this._paramsExpanded)
        }
    }

    /**
     * Draw the mask preview into the thumbnail canvas
     * @private
     */
    _renderMaskThumbnail() {
        const canvas = this.querySelector('.mask-thumb-canvas')
        if (!canvas || !this._layer?.mask) return

        const ctx = canvas.getContext('2d')
        const mask = this._layer.mask

        // Draw scaled-down mask preview
        const tempCanvas = document.createElement('canvas')
        tempCanvas.width = mask.width
        tempCanvas.height = mask.height
        tempCanvas.getContext('2d').putImageData(mask, 0, 0)

        ctx.clearRect(0, 0, 36, 36)
        ctx.drawImage(tempCanvas, 0, 0, 36, 36)
    }

    /**
     * Toggle params expanded state
     * @private
     */
    _toggleParamsExpanded() {
        this._paramsExpanded = !this._paramsExpanded

        // Toggle classes for CSS-based show/hide
        this.classList.toggle('params-expanded', this._paramsExpanded)

        const toggleBtn = this.querySelector('.layer-params-toggle')
        if (toggleBtn) {
            toggleBtn.classList.toggle('expanded', this._paramsExpanded)
        }
    }

    /**
     * Set up event listeners
     * @private
     */
    _setupEventListeners() {
        // Visibility toggle
        this.addEventListener('click', (e) => {
            const addChildBtn = e.target.closest('.layer-add-child')
            if (addChildBtn) {
                e.stopPropagation()
                this.dispatchEvent(new CustomEvent('child-add', {
                    bubbles: true,
                    detail: { layerId: this._layer.id }
                }))
                return
            }

            const maskThumb = e.target.closest('.layer-mask-thumbnail')
            if (maskThumb) {
                e.stopPropagation()
                if (this._isChild) {
                    // Child-effect masks have no edit mode or rubylith —
                    // every click opens the (reduced) mask options menu.
                    this.dispatchEvent(new CustomEvent('mask-context-menu', {
                        bubbles: true,
                        detail: { layerId: this._layer.id, x: e.clientX, y: e.clientY }
                    }))
                } else if (e.shiftKey) {
                    // Shift+click: toggle rubylith overlay
                    this.dispatchEvent(new CustomEvent('mask-toggle-visible', {
                        bubbles: true,
                        detail: { layerId: this._layer.id }
                    }))
                } else {
                    // Click: enter/exit mask edit mode
                    this.dispatchEvent(new CustomEvent('mask-edit', {
                        bubbles: true,
                        detail: { layerId: this._layer.id }
                    }))
                }
                return
            }

            const visBtn = e.target.closest('.layer-visibility')
            if (visBtn) {
                e.stopPropagation()
                this._toggleVisibility()
                return
            }

            const deleteBtn = e.target.closest('.layer-delete')
            if (deleteBtn) {
                e.stopPropagation()
                this._handleDelete()
                return
            }

            const paramsToggle = e.target.closest('.layer-params-toggle')
            if (paramsToggle) {
                e.stopPropagation()
                this._toggleParamsExpanded()
                return
            }

            // Select layer on click (anywhere else except controls and params)
            if (!e.target.closest('.layer-controls') && !e.target.closest('effect-params')) {
                this._emitSelect(e)
            }
        })

        // Double-click to edit name
        this.addEventListener('dblclick', (e) => {
            const nameEl = e.target.closest('.layer-name')
            if (nameEl) {
                this._startEditingName(nameEl)
            }
        })

        // Blend mode change
        this.addEventListener('change', (e) => {
            const blendSelect = e.target.closest('.layer-blend-mode')
            if (blendSelect) {
                this._handleBlendModeChange(blendSelect.value)
            }
        })

        // Opacity change
        this.addEventListener('input', (e) => {
            const opacitySlider = e.target.closest('.layer-opacity')
            if (opacitySlider && e.target === opacitySlider) {
                this._handleOpacityChange(parseInt(opacitySlider.value, 10))
            }
        })

        // Drag and drop - track if mousedown was on handle
        // Temporarily disable draggable when interacting with controls,
        // otherwise the browser's drag system steals pointer events from sliders
        this.addEventListener('mousedown', (e) => {
            this._dragFromHandle = !!e.target.closest('.layer-drag-handle')
            if (e.target.closest('.layer-controls') || e.target.closest('effect-params')) {
                this.draggable = false
                const restore = () => {
                    if (this._layer && !this.classList.contains('base-layer')) {
                        this.draggable = true
                    }
                    document.removeEventListener('mouseup', restore)
                }
                document.addEventListener('mouseup', restore)
            }
        })

        this.addEventListener('dragstart', (e) => this._handleDragStart(e))
        this.addEventListener('dragend', () => this._handleDragEnd())
        this.addEventListener('dragover', (e) => this._handleDragOver(e))
        this.addEventListener('dragleave', () => this._handleDragLeave())
        this.addEventListener('drop', (e) => this._handleDrop(e))

        // Right-click context menu for mask thumbnail and layer row
        this.addEventListener('contextmenu', (e) => {
            e.preventDefault()
            const maskThumb = e.target.closest('.layer-mask-thumbnail')
            if (maskThumb) {
                e.stopPropagation()
                this.dispatchEvent(new CustomEvent('mask-context-menu', {
                    bubbles: true,
                    detail: {
                        layerId: this._layer.id,
                        x: e.clientX,
                        y: e.clientY
                    }
                }))
            } else {
                this.dispatchEvent(new CustomEvent('layer-context-menu', {
                    bubbles: true,
                    detail: {
                        layerId: this._layer.id,
                        hasMask: !!this._layer.mask,
                        x: e.clientX,
                        y: e.clientY
                    }
                }))
            }
        })

        // Effect parameter changes (from effect-params component)
        this.addEventListener('param-change', (e) => {
            e.stopPropagation()
            this._handleParamChange(e.detail)
        })
    }

    /**
     * Handle effect parameter change
     * @param {object} detail - Event detail with paramName, value, params
     * @private
     */
    _handleParamChange(detail) {
        if (!this._layer) return

        const previousValue = this._layer.effectParams
        const value = { ...detail.params }

        // Emit as a standard layer-change event
        this._emitChange('effectParams', value, previousValue)
    }

    /**
     * Toggle layer visibility
     * @private
     */
    _toggleVisibility() {
        if (!this._layer) return
        const previousValue = this._layer.visible
        this._emitChange('visibility', !previousValue, previousValue)
    }

    /**
     * Handle delete button click
     * @private
     */
    _handleDelete() {
        const detail = { layerId: this._layer.id }
        if (this._parentLayerId) {
            detail.parentLayerId = this._parentLayerId
        }
        this.dispatchEvent(new CustomEvent('layer-delete', {
            bubbles: true,
            detail
        }))
    }

    /**
     * Start editing the layer name
     * @param {HTMLElement} nameEl - Name element
     * @private
     */
    _startEditingName(nameEl) {
        nameEl.contentEditable = 'true'
        nameEl.classList.add('editing')
        nameEl.focus()

        // Select all text
        const range = document.createRange()
        range.selectNodeContents(nameEl)
        const sel = window.getSelection()
        sel.removeAllRanges()
        sel.addRange(range)

        // Handle blur and enter
        const finishEdit = () => {
            nameEl.contentEditable = 'false'
            nameEl.classList.remove('editing')
            const newName = nameEl.textContent.trim() || 'Untitled'
            nameEl.textContent = newName
            if (this._layer && this._layer.name !== newName) {
                const previousValue = this._layer.name
                this._emitChange('name', newName, previousValue)
            }
        }

        nameEl.addEventListener('blur', finishEdit, { once: true })
        nameEl.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault()
                nameEl.blur()
            }
        })
    }

    /**
     * Handle blend mode change
     * @param {string} mode - New blend mode
     * @private
     */
    _handleBlendModeChange(mode) {
        if (!this._layer) return
        const previousValue = this._layer.blendMode
        this._emitChange('blendMode', mode, previousValue)
    }

    /**
     * Handle opacity change
     * @param {number} opacity - New opacity
     * @private
     */
    _handleOpacityChange(opacity) {
        if (!this._layer) return
        const previousValue = this._layer.opacity
        this._emitChange('opacity', opacity, previousValue)
    }

    /**
     * Emit a change event
     * @param {string} property - Property that changed
     * @param {*} value - New value
     * @private
     */
    _emitChange(property, value, previousValue) {
        const detail = {
            layerId: this._layer.id,
            property,
            value,
            previousValue,
            layer: this._layer
        }
        if (this._parentLayerId) {
            detail.parentLayerId = this._parentLayerId
        }
        this.dispatchEvent(new CustomEvent('layer-change', {
            bubbles: true,
            detail
        }))
    }

    /**
     * Emit select event
     * @param {MouseEvent} [e] - Original mouse event for modifier keys
     * @private
     */
    _emitSelect(e) {
        this.dispatchEvent(new CustomEvent('layer-select', {
            bubbles: true,
            detail: {
                layerId: this._layer.id,
                ctrlKey: e?.ctrlKey || false,
                metaKey: e?.metaKey || false,
                shiftKey: e?.shiftKey || false
            }
        }))
    }

    // =========================================================================
    // Drag & Drop
    // =========================================================================

    _handleDragStart(e) {
        // Only allow drag from the drag handle
        if (!this._layer || this.hasAttribute('base') || !this._dragFromHandle) {
            e.preventDefault()
            return
        }
        this.classList.add('dragging')
        e.dataTransfer.effectAllowed = 'move'
        e.dataTransfer.setData('text/plain', this._layer.id)

        // Emit granular event for FSM
        this.dispatchEvent(new CustomEvent('layer-drag-start', {
            bubbles: true,
            detail: { layerId: this._layer.id }
        }))
    }

    _handleDragEnd() {
        this.classList.remove('dragging')
        this._dragFromHandle = false

        // Emit granular event for FSM
        this.dispatchEvent(new CustomEvent('layer-drag-end', {
            bubbles: true,
            detail: { layerId: this._layer.id }
        }))
    }

    _handleDragOver(e) {
        if (this.hasAttribute('base')) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'

        const dropPosition = this._getDropPosition(e)

        this.classList.remove('drag-over', 'drag-over-above', 'drag-over-below')
        this.classList.add('drag-over', `drag-over-${dropPosition}`)

        this.dispatchEvent(new CustomEvent('layer-drag-over', {
            bubbles: true,
            detail: {
                targetId: this._layer.id,
                dropPosition
            }
        }))
    }

    _handleDragLeave() {
        this.classList.remove('drag-over', 'drag-over-above', 'drag-over-below')
    }

    _handleDrop(e) {
        e.preventDefault()

        const dropPosition = this._getDropPosition(e)
        this.classList.remove('drag-over', 'drag-over-above', 'drag-over-below')

        const sourceId = e.dataTransfer.getData('text/plain')
        if (sourceId && sourceId !== this._layer.id) {
            this.dispatchEvent(new CustomEvent('layer-drop', {
                bubbles: true,
                detail: {
                    sourceId,
                    targetId: this._layer.id,
                    dropPosition
                }
            }))
        }
    }

    _getDropPosition(e) {
        const rect = this.getBoundingClientRect()
        return e.clientY < rect.top + rect.height / 2 ? 'above' : 'below'
    }

    _formatLayerType(layer) {
        if (layer.sourceType === 'effect') return 'Effect'
        if (layer.sourceType === 'drawing') return 'Drawing'
        if (layer.mediaType) return layer.mediaType.charAt(0).toUpperCase() + layer.mediaType.slice(1)
        return 'Media'
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

customElements.define('layer-item', LayerItem)

export { LayerItem }
