/**
 * Undo Manager
 * Snapshot-based history stack for undo/redo
 *
 * @module utils/undo-manager
 */

export class UndoManager {
    constructor(maxSize = 50, maxBytes = 128 * 1024 * 1024) {
        this._stack = []
        this._index = -1
        this._maxSize = maxSize
        this._maxBytes = maxBytes
        this.retainedBytes = 0
    }

    /**
     * Push a snapshot onto the stack.
     * Truncates any redo branch and trims oldest if over max.
     * @param {object} snapshot - { layers, canvasWidth, canvasHeight }
     */
    pushState(snapshot) {
        this._stack.length = this._index + 1
        this._stack.push(snapshot)

        this.retainedBytes = retainedSize(this._stack)
        // Always retain the current state, even when one document alone
        // exceeds the budget. It does not provide an undo step in that case.
        while (this._stack.length > 1 && (this._stack.length > this._maxSize
            || this.retainedBytes > this._maxBytes)) {
            this._stack.shift()
            this.retainedBytes = retainedSize(this._stack)
        }

        this._index = this._stack.length - 1
    }

    /**
     * Undo: move back one step and return the snapshot to restore.
     * @returns {object|null} The snapshot to restore, or null if nothing to undo
     */
    undo() {
        if (!this.canUndo()) return null
        this._index--
        return this._stack[this._index]
    }

    /**
     * Redo: move forward one step and return the snapshot to restore.
     * @returns {object|null} The snapshot to restore, or null if nothing to redo
     */
    redo() {
        if (!this.canRedo()) return null
        this._index++
        return this._stack[this._index]
    }

    canUndo() {
        return this._index > 0
    }

    canRedo() {
        return this._index < this._stack.length - 1
    }

    clear() {
        this._stack = []
        this._index = -1
        this.retainedBytes = 0
    }
}

// Account for unique backing stores, shared immutable assets, and JS metadata.
// This is a conservative retained-data estimate, not a browser heap reading.
function retainedSize(states) {
    const seen = new Set()
    function size(value) {
        if (value === null || value === undefined) return 0
        if (typeof value === 'string') return value.length * 2
        if (typeof value !== 'object') return 8
        if (seen.has(value)) return 0
        seen.add(value)
        if (value instanceof ArrayBuffer) return value.byteLength
        if (ArrayBuffer.isView(value)) return 32 + size(value.buffer)
        if (typeof Blob !== 'undefined' && value instanceof Blob) return value.size
        if (typeof ImageData !== 'undefined' && value instanceof ImageData) return 32 + size(value.data)
        if (typeof value.getContext === 'function') return value.width * value.height * 4
        if (value instanceof Map) return 32 + [...value].reduce((n, [k, v]) => n + size(k) + size(v), 0)
        return 32 + Object.entries(value).reduce((n, [k, v]) => n + k.length * 2 + 8 + size(v), 0)
    }
    return states.reduce((n, state) => n + size(state), 0)
}
