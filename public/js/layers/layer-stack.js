/**
 * Layer Stack Web Component
 * Container for all layers
 *
 * @module layers/layer-stack
 */

import './layer-item.js'
import { structuralSignature, refreshRovingTabindex } from './layer-item.js'

/**
 * LayerStack - Web component for the layer list
 * Displays layers in reverse order (top layer first visually)
 * @extends HTMLElement
 */
class LayerStack extends HTMLElement {
    constructor() {
        super()
        this._layers = []
        this._selectedLayerIds = new Set()
        this._lastClickedLayerId = null  // For shift-click range
        this._edgeScrollFrame = null     // rAF id while auto-scrolling
        this._edgeScrollDir = 0          // -1 toward the top edge, 1 toward the bottom
        this._edgeScrollY = 0            // last dragover pointer Y
    }

    connectedCallback() {
        this._render()
        this._setupEventListeners()
    }

    disconnectedCallback() {
        this._stopEdgeAutoScroll()
    }


    _firstSelectedId() {
        return this._selectedLayerIds.values().next().value ?? null
    }

    /**
     * Set the layers array
     *
     * Reconciles the existing layer-item elements instead of rebuilding the
     * stack from scratch: items whose layer structure is unchanged are
     * patched in place (or left untouched), so a property-only change such
     * as a visibility toggle does not tear down every control in the panel,
     * drop focus from the eye button, or re-create thumbnail canvases.
     * Structural changes (add, remove, type change) rebuild the affected
     * items; reorders are applied by repositioning items in place.
     *
     * @param {Array} layers - Array of layer objects (bottom to top order)
     */
    set layers(layers) {
        this._layers = layers || []
        this._renderLayers()
    }

    /**
     * Get the layers array
     * @returns {Array} Layer array
     */
    get layers() {
        return this._layers
    }

    /**
     * Set the selected layer ID (single select, clears others)
     * @param {string|null} id - Layer ID or null
     */
    set selectedLayerId(id) {
        this._selectedLayerIds.clear()
        if (id) {
            this._selectedLayerIds.add(id)
            this._lastClickedLayerId = id
        }
        this._updateSelection()
    }

    /**
     * Get the primary selected layer ID (first in set)
     * @returns {string|null} Selected layer ID
     */
    get selectedLayerId() {
        return this._firstSelectedId()
    }

    /**
     * Get all selected layer IDs
     * @returns {string[]} Array of selected layer IDs
     */
    get selectedLayerIds() {
        return [...this._selectedLayerIds]
    }

    /**
     * Set multiple selected layer IDs
     * @param {string[]} ids - Array of layer IDs to select
     */
    set selectedLayerIds(ids) {
        this._selectedLayerIds = new Set(ids)
        if (ids.length > 0) {
            this._lastClickedLayerId = ids[ids.length - 1]
        }
        this._updateSelection()
    }

    /**
     * Get all selected layers
     * @returns {object[]} Array of selected layer objects
     */
    get selectedLayers() {
        return this._layers.filter(l => this._selectedLayerIds.has(l.id))
    }

    /**
     * Render the layer stack (full rebuild)
     * @private
     */
    _render() {
        this.innerHTML = ''

        if (this._layers.length === 0) {
            this.innerHTML = `
                <div class="empty-state">
                    <span class="icon-material">layers</span>
                    <p>No layers yet</p>
                    <p style="font-size: 12px; opacity: 0.7;">Open a media file to get started</p>
                </div>
            `
            return
        }

        // Render layers in reverse order (top first visually)
        const reversedLayers = [...this._layers].reverse()

        for (let i = 0; i < reversedLayers.length; i++) {
            const layer = reversedLayers[i]
            const isBase = i === reversedLayers.length - 1

            const item = document.createElement('layer-item')
            item.layer = layer
            if (isBase) {
                item.setAttribute('base', '')
            }
            if (this._selectedLayerIds.has(layer.id)) {
                item.selected = true
            }

            this.appendChild(item)

            // Render child effects (in order, below parent)
            for (const child of (layer.children || [])) {
                const childItem = document.createElement('layer-item')
                childItem.layer = child
                childItem.isChild = true
                childItem.parentLayerId = layer.id
                if (this._selectedLayerIds.has(child.id)) {
                    childItem.selected = true
                }
                this.appendChild(childItem)
            }
        }

        // Roving tabindex: exactly one row is the stack's Tab stop — the
        // selected row when one exists, else the first row.
        refreshRovingTabindex(this)
    }

    /**
     * Reconcile the rendered items against the current layers.
     * @private
     */
    _renderLayers() {
        if (this._layers.length === 0 || this.querySelector('.empty-state')) {
            this._render()
            return
        }

        // Desired flat display order: layers top-first, each followed by its
        // child effects in stack order.
        const reversedLayers = [...this._layers].reverse()
        const desired = []
        for (let i = 0; i < reversedLayers.length; i++) {
            const layer = reversedLayers[i]
            desired.push({ layer, isChild: false, parentId: null, isBase: i === reversedLayers.length - 1 })
            for (const child of (layer.children || [])) {
                desired.push({ layer: child, isChild: true, parentId: layer.id, isBase: false })
            }
        }

        const items = [...this.querySelectorAll('layer-item')]
        const byKey = new Map()
        for (const item of items) {
            const key = this._itemKey(item)
            if (key) byKey.set(key, item)
        }

        for (const entry of desired) {
            const key = this._entryKey(entry)
            const item = byKey.get(key)
            if (!item) {
                const created = document.createElement('layer-item')
                created.layer = entry.layer
                if (entry.isBase) created.setAttribute('base', '')
                if (entry.isChild) {
                    created.isChild = true
                    created.parentLayerId = entry.parentId
                }
                if (this._selectedLayerIds.has(entry.layer.id)) {
                    created.selected = true
                }
                byKey.set(key, created)
            } else if (item.hasAttribute('base') !== entry.isBase
                || item.isChild !== entry.isChild
                || structuralSignature(entry.layer) !== item._structuralSig) {
                // Structural change: rebuild this item's contents in place.
                if (entry.isBase) item.setAttribute('base', '')
                else item.removeAttribute('base')
                if (item.isChild !== entry.isChild) {
                    item.isChild = entry.isChild
                    item.parentLayerId = entry.parentId
                }
                item.layer = entry.layer
            } else {
                // Property-only change: patch in place (no-op when nothing
                // displayed changed).
                item.sync(entry.layer)
            }
        }

        for (const [key, item] of byKey) {
            if (!desired.some(entry => this._entryKey(entry) === key)) {
                item.remove()
            }
        }

        // Reorder with minimal moves: reparent only the items that are out
        // of place. appendChild/insertBefore moves disconnect and reconnect
        // the moved subtree, and layer items contain handfish dropdown and
        // slider components whose connect/disconnect clobbers document-level
        // bookkeeping — a full re-append pass after adding a top layer broke
        // the menubar's focus restore (focus fell to body). A property-only
        // toggle must move nothing at all.
        let cursor = null
        for (const entry of desired) {
            const item = byKey.get(this._entryKey(entry))
            if (!item) continue
            const expected = cursor ? cursor.nextSibling : this.firstElementChild
            if (expected !== item) {
                this.insertBefore(item, cursor ? cursor.nextSibling : this.firstElementChild)
            }
            cursor = item
        }

        // Structural changes re-rendered some rows: re-anchor the roving
        // tabindex (exactly one row must be the stack's Tab stop).
        refreshRovingTabindex(this)
    }

    /** @private */
    _itemKey(item) {
        if (!item._layer?.id) return null
        // parentLayerId has only a setter on layer-item; read the backing field.
        return (item.isChild ? (item._parentLayerId || '') : '') + '/' + item._layer.id
    }

    /** @private */
    _entryKey(entry) {
        return (entry.parentId || '') + '/' + entry.layer.id
    }

    /**
     * Update selection state on layer items
     * @private
     */
    _updateSelection() {
        const items = this.querySelectorAll('layer-item')
        items.forEach(item => {
            item.selected = this._selectedLayerIds.has(item.layer?.id)
        })
        // The roving tabindex follows the selection: a keyboard or pointer
        // selection makes that row the stack's Tab stop. Selection is
        // authoritative here over whatever happens to hold focus — Firefox
        // and WebKit leave a clicked row focused, so a later selection change
        // would otherwise keep the stop parked on the stale focused row.
        refreshRovingTabindex(this, { followSelection: true })
        this.dispatchEvent(new CustomEvent('selection-change', {
            bubbles: true,
            detail: { selectedIds: [...this._selectedLayerIds] }
        }))
    }

    /**
     * Set up event listeners
     * @private
     */
    _setupEventListeners() {
        // Listen for layer select events
        this.addEventListener('layer-select', (e) => {
            const layerId = e.detail.layerId
            const ctrlKey = e.detail.ctrlKey || e.detail.metaKey
            const shiftKey = e.detail.shiftKey

            if (ctrlKey) {
                // Cmd/Ctrl+click: toggle selection
                if (this._selectedLayerIds.has(layerId)) {
                    this._selectedLayerIds.delete(layerId)
                } else {
                    this._selectedLayerIds.add(layerId)
                }
                this._lastClickedLayerId = layerId
            } else if (shiftKey && this._lastClickedLayerId) {
                // Shift+click: range select
                const lastIndex = this._layers.findIndex(l => l.id === this._lastClickedLayerId)
                const currentIndex = this._layers.findIndex(l => l.id === layerId)

                if (lastIndex !== -1 && currentIndex !== -1) {
                    const start = Math.min(lastIndex, currentIndex)
                    const end = Math.max(lastIndex, currentIndex)

                    for (let i = start; i <= end; i++) {
                        this._selectedLayerIds.add(this._layers[i].id)
                    }
                }
            } else {
                // Plain click: single select
                this._selectedLayerIds.clear()
                this._selectedLayerIds.add(layerId)
                this._lastClickedLayerId = layerId
            }

            this._updateSelection()
        })

        // Keyboard reorder requests (layer-keyboard-move, Alt+ArrowUp/Down on
        // a focused row) need no re-emit here: the event bubbles from the
        // layer-item to this stack, where the app's own handler listens. A
        // stopPropagation + re-dispatch on `this` would re-trigger this
        // stack's listeners synchronously and loop.

        // Edge auto-scroll during a layer drag: a long stack cannot show all
        // rows at once, and a native drag near the panel's top/bottom edge
        // would otherwise be unable to reach off-screen rows.
        this.addEventListener('dragover', (e) => this._handleEdgeAutoScroll(e))
        this.addEventListener('dragend', () => this._stopEdgeAutoScroll())
        this.addEventListener('drop', () => this._stopEdgeAutoScroll())
        this.addEventListener('dragleave', (e) => {
            if (!this.contains(e.relatedTarget)) this._stopEdgeAutoScroll()
        })
    }

    /**
     * Scroll the layers list while a drag pointer hovers near its top or
     * bottom edge, so off-screen rows become reachable drop targets.
     * @param {DragEvent} e
     * @private
     */
    _handleEdgeAutoScroll(e) {
        const list = this.closest('.layers-list')
        if (!list) return
        this._edgeScrollY = e.clientY

        const rect = list.getBoundingClientRect()
        const edge = 36
        let dir = 0
        if (e.clientY < rect.top + edge) dir = -1
        else if (e.clientY > rect.bottom - edge) dir = 1

        if (dir === 0) {
            this._stopEdgeAutoScroll()
            return
        }

        if (this._edgeScrollDir === dir && this._edgeScrollFrame !== null) return
        this._edgeScrollDir = dir
        this._startEdgeScrollLoop(list)
    }

    /**
     * rAF loop: scroll a step toward the hovered edge, then continue while
     * the pointer stays in the edge zone.
     * @param {HTMLElement} list - the scrollable layers list
     * @private
     */
    _startEdgeScrollLoop(list) {
        if (this._edgeScrollFrame !== null) return
        const step = () => {
            this._edgeScrollFrame = null
            const rect = list.getBoundingClientRect()
            const edge = 36
            const y = this._edgeScrollY
            let dir = 0
            if (y < rect.top + edge) dir = -1
            else if (y > rect.bottom - edge) dir = 1

            if (dir === 0 || this._edgeScrollDir === 0) {
                this._edgeScrollDir = 0
                return
            }
            // Speed ramps with how deep the pointer sits in the edge zone.
            const depth = dir > 0
                ? y - (rect.bottom - edge)
                : (rect.top + edge) - y
            const speed = 4 + 10 * Math.min(1, Math.max(0, depth / edge))
            list.scrollTop += dir * speed
            this._edgeScrollFrame = requestAnimationFrame(step)
        }
        this._edgeScrollFrame = requestAnimationFrame(step)
    }

    /** Stop the edge auto-scroll loop (drag ended, left the panel, or moved off the edges). */
    _stopEdgeAutoScroll() {
        this._edgeScrollDir = 0
        if (this._edgeScrollFrame !== null) {
            cancelAnimationFrame(this._edgeScrollFrame)
            this._edgeScrollFrame = null
        }
    }

    /**
     * Add a layer to the stack
     * @param {object} layer - Layer to add
     * @param {number} [index] - Index to insert at (default: top)
     */
    addLayer(layer, index) {
        if (index === undefined) {
            this._layers.push(layer)
        } else {
            this._layers.splice(index, 0, layer)
        }
        this._selectedLayerIds.clear()
        this._selectedLayerIds.add(layer.id)
        this._lastClickedLayerId = layer.id
        this._render()
    }

    /**
     * Remove a layer from the stack
     * @param {string} layerId - Layer ID to remove
     */
    removeLayer(layerId) {
        const index = this._layers.findIndex(l => l.id === layerId)
        if (index === -1 || index === 0) return // Can't remove base layer

        this._layers.splice(index, 1)

        // Remove from selection if selected
        this._selectedLayerIds.delete(layerId)

        // If we removed the last clicked layer, update it
        if (this._lastClickedLayerId === layerId) {
            this._lastClickedLayerId = this._firstSelectedId()
        }

        // If no selection remains, select adjacent layer
        if (this._selectedLayerIds.size === 0) {
            if (index < this._layers.length) {
                this._selectedLayerIds.add(this._layers[index].id)
            } else if (this._layers.length > 0) {
                this._selectedLayerIds.add(this._layers[this._layers.length - 1].id)
            }
        }

        this._render()
    }

    /**
     * Get the selected layer (primary/first if multiple)
     * @returns {object|null} Selected layer or null
     */
    getSelectedLayer() {
        const id = this._firstSelectedId()
        if (!id) return null
        return this._layers.find(l => l.id === id) || null
    }
}

customElements.define('layer-stack', LayerStack)

export { LayerStack }
