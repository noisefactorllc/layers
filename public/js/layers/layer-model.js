/**
 * Layer Model
 * Data structures for layers
 *
 * @module layers/layer-model
 */

let layerCounter = 0

const DEFAULT_EFFECT_PARAMS = {
    'synth/gradient': { type: 2 }
}

/**
 * Convert camelCase to Human Case (Title Case with spaces)
 * @param {string} str - Input string in camelCase
 * @returns {string} Human-readable string
 */
function camelToHumanCase(str) {
    return str
        .replace(/([a-z])([A-Z])/g, '$1 $2')
        .replace(/([A-Z])([A-Z][a-z])/g, '$1 $2')
        .replace(/^./, c => c.toUpperCase())
}

/**
 * Create a new layer object
 * @param {object} options - Layer options
 * @returns {object} Layer object
 */
export function createLayer(options = {}) {
    const id = options.id || `layer-${layerCounter++}`

    return {
        id,
        name: options.name || 'Untitled',
        visible: options.visible !== false,
        opacity: options.opacity ?? 100,
        blendMode: options.blendMode || 'mix',
        locked: options.locked || false,
        offsetX: options.offsetX || 0,
        offsetY: options.offsetY || 0,
        scaleX: options.scaleX ?? 1,
        scaleY: options.scaleY ?? 1,
        rotation: options.rotation ?? 0,
        flipH: options.flipH || false,
        flipV: options.flipV || false,
        sourceType: options.sourceType || 'media', // 'media' | 'effect' | 'drawing'

        // Media-specific
        mediaFile: options.mediaFile || null,
        mediaType: options.mediaType || null, // 'image' | 'video'

        // Effect-specific
        effectId: options.effectId || null,
        effectParams: options.effectParams || {},

        // Drawing-specific
        strokes: options.strokes || (options.sourceType === 'drawing' ? [] : undefined),
        drawingCanvas: null, // runtime only, never serialized

        // Child effects (per-layer filter chain)
        children: options.children || [],

        // Layer mask (grayscale ImageData, white=visible, black=hidden)
        mask: options.mask || null,
        maskEnabled: options.maskEnabled !== false,
        maskVisible: options.maskVisible || false
    }
}

/**
 * Create a media layer
 * @param {File} file - Media file
 * @param {string} mediaType - 'image' or 'video'
 * @param {string} [name] - Layer name
 * @returns {object} Layer object
 */
export function createMediaLayer(file, mediaType, name) {
    return createLayer({
        name: name || file.name.replace(/\.[^.]+$/, ''),
        sourceType: 'media',
        mediaFile: file,
        mediaType
    })
}

/**
 * Create an effect layer
 * @param {string} effectId - Effect ID (namespace/name)
 * @param {string} [name] - Layer name
 * @param {object} [params] - Effect parameters
 * @returns {object} Layer object
 */
export function createEffectLayer(effectId, name, params = {}) {
    const effectName = effectId.split('/').pop()
    const defaultParams = DEFAULT_EFFECT_PARAMS[effectId]
    return createLayer({
        name: name || camelToHumanCase(effectName),
        sourceType: 'effect',
        effectId,
        effectParams: defaultParams ? { ...defaultParams, ...params } : params
    })
}

/**
 * Create a drawing layer
 * @param {string} [name] - Layer name
 * @returns {object} Layer object
 */
export function createDrawingLayer(name) {
    return createLayer({
        name: name || 'Drawing',
        sourceType: 'drawing'
    })
}

/**
 * Create a child effect object (lightweight, no blend/opacity/media fields)
 * @param {string} effectId - Effect ID (namespace/name)
 * @param {string} [name] - Display name
 * @param {object} [params] - Effect parameters
 * @returns {object} Child effect object
 */
export function createChildEffect(effectId, name, params = {}) {
    const effectName = effectId.split('/').pop()
    return {
        id: `layer-${layerCounter++}`,
        name: name || camelToHumanCase(effectName),
        effectId,
        effectParams: params,
        visible: true
    }
}

/**
 * Clone a layer with a new ID
 * @param {object} layer - Layer to clone
 * @returns {object} Cloned layer
 */
export function cloneLayer(layer) {
    return {
        ...layer,
        id: `layer-${layerCounter++}`,
        name: `${layer.name} copy`,
        effectParams: JSON.parse(JSON.stringify(layer.effectParams)),
        strokes: layer.strokes ? JSON.parse(JSON.stringify(layer.strokes)) : layer.strokes,
        drawingCanvas: null,
        mask: layer.mask ? new ImageData(
            new Uint8ClampedArray(layer.mask.data),
            layer.mask.width, layer.mask.height
        ) : null,
        children: (layer.children || []).map(child => ({
            ...child,
            id: `layer-${layerCounter++}`,
            effectParams: JSON.parse(JSON.stringify(child.effectParams))
        }))
    }
}

/**
 * Serialize layers for storage
 * @param {Array} layers - Layer array
 * @returns {string} JSON string
 */
export function serializeLayers(layers) {
    const serializableLayers = layers.map(layer => {
        const serialized = {
            ...layer,
            mediaFile: null,
            drawingCanvas: undefined
        }
        // Encode mask ImageData as base64 PNG
        if (layer.mask) {
            const canvas = document.createElement('canvas')
            canvas.width = layer.mask.width
            canvas.height = layer.mask.height
            canvas.getContext('2d').putImageData(layer.mask, 0, 0)
            serialized.mask = canvas.toDataURL('image/png')
        }
        return serialized
    })
    return JSON.stringify(serializableLayers)
}

/**
 * Deserialize layers from storage
 * @param {string} json - JSON string
 * @returns {Array} Layer array
 */
export function deserializeLayers(json) {
    try {
        const layers = JSON.parse(json)
        return layers
    } catch {
        return []
    }
}

/**
 * Decode base64 mask strings to ImageData (call after deserialize)
 * @param {Array} layers - Layer array with possible base64 mask strings
 * @returns {Promise<void>}
 */
export async function decodeMasks(layers) {
    for (const layer of layers) {
        if (typeof layer.mask === 'string') {
            const img = new Image()
            await new Promise((resolve, reject) => {
                img.onload = resolve
                img.onerror = reject
                img.src = layer.mask
            })
            const canvas = document.createElement('canvas')
            canvas.width = img.width
            canvas.height = img.height
            const ctx = canvas.getContext('2d')
            ctx.drawImage(img, 0, 0)
            layer.mask = ctx.getImageData(0, 0, img.width, img.height)
        }
    }
}

/**
 * Reset layer counter (for testing)
 */
export function resetLayerCounter() {
    layerCounter = 0
}

/**
 * Fast-forward the internal layer id counter so future locally-created
 * layers/children never collide with ids adopted from a remote source
 * (e.g. a joined Seance collaboration session — see collab/docModel.js,
 * which reuses wire-supplied ids verbatim so publishes stay echo-safe).
 * No-op if the counter is already at or past `minNext`.
 * @param {number} minNext
 */
export function bumpLayerCounter(minNext) {
    if (Number.isFinite(minNext) && minNext > layerCounter) {
        layerCounter = minNext
    }
}
