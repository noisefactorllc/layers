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
     * Get the current active snapshot
     * @returns {object|null}
     */
    get current() {
        return this._index >= 0 ? this._stack[this._index] : null
    }

    /**
     * Push a snapshot onto the stack.
     * Truncates any redo branch and trims oldest if over max.
     * Skips push if snapshot is functionally identical to the current snapshot.
     * @param {object} snapshot - { layers, canvasWidth, canvasHeight }
     * @returns {boolean} True if pushed, false if skipped as duplicate
     */
    pushState(snapshot) {
        if (this._index >= 0 && snapshotsEqual(this._stack[this._index], snapshot)) {
            return false
        }

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
        return true
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

/**
 * Compare two layer arrays for functional equality.
 * @param {Array} a
 * @param {Array} b
 * @returns {boolean}
 */
export function layersEqual(a, b) {
    if (a === b) return true
    if (!a || !b || a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) {
        const la = a[i]
        const lb = b[i]
        if (la === lb) continue
        if (!la || !lb) return false

        // Compare all top-level primitive/scalar properties
        const allKeys = new Set([...Object.keys(la), ...Object.keys(lb)])
        for (const key of allKeys) {
            if (key === 'effectParams' || key === 'strokes' || key === 'children'
                || key === 'drawingCanvas' || key === 'mask') {
                continue
            }
            if (la[key] !== lb[key]) return false
        }

        if (la.mask !== lb.mask) return false

        if ((la.strokes?.length || 0) !== (lb.strokes?.length || 0)) return false
        if (la.strokes && lb.strokes && la.strokes !== lb.strokes) {
            for (let s = 0; s < la.strokes.length; s++) {
                if (la.strokes[s] !== lb.strokes[s]) return false
            }
        }

        if (la.effectParams !== lb.effectParams) {
            try {
                if (JSON.stringify(la.effectParams || {}) !== JSON.stringify(lb.effectParams || {})) {
                    return false
                }
            } catch {
                return false
            }
        }

        if (!layersEqual(la.children, lb.children)) return false
    }
    return true
}

/**
 * Compare two undo snapshots for functional equality.
 * @param {object} a
 * @param {object} b
 * @returns {boolean}
 */
export function snapshotsEqual(a, b) {
    if (a === b) return true
    if (!a || !b) return false
    if (a.canvasWidth !== b.canvasWidth || a.canvasHeight !== b.canvasHeight) return false
    if ((a.mediaCanvases?.size || 0) !== (b.mediaCanvases?.size || 0)) return false
    if (Array.isArray(a.layers) && Array.isArray(b.layers)) {
        return layersEqual(a.layers, b.layers)
    }
    return false
}
