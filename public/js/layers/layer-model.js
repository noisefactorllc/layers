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

function allocateLayerIds(count = 1) {
    if (!Number.isSafeInteger(count) || count < 1
        || !Number.isSafeInteger(layerCounter)
        || layerCounter > Number.MAX_SAFE_INTEGER - (count - 1)) {
        throw new Error('Layer ID counter exceeded the safe integer range')
    }
    const first = layerCounter
    layerCounter += count
    return Array.from({ length: count }, (_, index) => `layer-${first + index}`)
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
    const id = options.id || allocateLayerIds()[0]

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
        id: allocateLayerIds()[0],
        name: name || camelToHumanCase(effectName),
        effectId,
        effectParams: params,
        visible: true
    }
}

/** Deep-copy a mask ImageData (null/undefined pass through). */
function cloneMask(mask) {
    if (!mask) return mask
    return new ImageData(
        new Uint8ClampedArray(mask.data), mask.width, mask.height)
}

/**
 * Clone a layer with a new ID
 * @param {object} layer - Layer to clone
 * @returns {object} Cloned layer
 */
export function cloneLayer(layer) {
    const children = (layer.children || []).map(child => ({
        ...child,
        effectParams: JSON.parse(JSON.stringify(child.effectParams)),
        mask: cloneMask(child.mask)
    }))
    const ids = allocateLayerIds(1 + children.length)
    return {
        ...layer,
        id: ids[0],
        name: `${layer.name} copy`,
        effectParams: JSON.parse(JSON.stringify(layer.effectParams)),
        strokes: layer.strokes ? JSON.parse(JSON.stringify(layer.strokes)) : layer.strokes,
        drawingCanvas: null,
        mask: layer.mask ? new ImageData(
            new Uint8ClampedArray(layer.mask.data),
            layer.mask.width, layer.mask.height
        ) : null,
        children: children.map((child, index) => ({
            ...child,
            id: ids[index + 1]
        }))
    }
}

/** Encode a mask ImageData as a base64 PNG data URL. */
function encodeMaskToDataUrl(mask) {
    const canvas = document.createElement('canvas')
    canvas.width = mask.width
    canvas.height = mask.height
    canvas.getContext('2d').putImageData(mask, 0, 0)
    return canvas.toDataURL('image/png')
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
        // Encode mask ImageData as base64 PNG. ImageData does not survive
        // JSON.stringify (it flattens to {}), so child masks must be encoded
        // here too, not just the layer's own mask.
        if (layer.mask) {
            serialized.mask = encodeMaskToDataUrl(layer.mask)
        }
        if ((layer.children || []).some(child => child.mask)) {
            serialized.children = layer.children.map(child => child.mask
                ? { ...child, mask: encodeMaskToDataUrl(child.mask) }
                : child)
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
export async function decodeMasks(layers, {
    maxWidth = 8192,
    maxHeight = 8192,
    maxPixels = maxWidth * maxHeight,
    expectedWidth = null,
    expectedHeight = null,
} = {}) {
    const decodeOne = async (maskString) => {
        const prefix = 'data:image/png;base64,'
        if (!maskString.startsWith(prefix)) {
            throw new Error('Saved mask PNG header is invalid')
        }
        let header
        try {
            header = atob(maskString.slice(prefix.length, prefix.length + 32))
        } catch {
            throw new Error('Saved mask PNG header is invalid')
        }
        const signature = [137, 80, 78, 71, 13, 10, 26, 10,
            0, 0, 0, 13, 73, 72, 68, 82]
        if (header.length < 24 || signature.some((byte, index) =>
            header.charCodeAt(index) !== byte)) {
            throw new Error('Saved mask PNG header is invalid')
        }
        const uint32 = (offset) => (
            header.charCodeAt(offset) * 0x1000000
            + header.charCodeAt(offset + 1) * 0x10000
            + header.charCodeAt(offset + 2) * 0x100
            + header.charCodeAt(offset + 3)
        )
        const width = uint32(16)
        const height = uint32(20)
        if (!Number.isSafeInteger(width) || width < 1 || width > maxWidth
            || !Number.isSafeInteger(height) || height < 1 || height > maxHeight
            || width * height > maxPixels) {
            throw new Error('Saved mask dimensions exceed the project canvas')
        }
        if ((expectedWidth !== null && width !== expectedWidth)
            || (expectedHeight !== null && height !== expectedHeight)) {
            throw new Error('Saved mask dimensions do not match the project canvas')
        }
        const img = new Image()
        await new Promise((resolve, reject) => {
            img.onload = resolve
            img.onerror = reject
            img.src = maskString
        })
        if (img.width !== width || img.height !== height) {
            throw new Error('Saved mask dimensions do not match its PNG header')
        }
        const canvas = document.createElement('canvas')
        canvas.width = img.width
        canvas.height = img.height
        const ctx = canvas.getContext('2d')
        ctx.drawImage(img, 0, 0)
        return ctx.getImageData(0, 0, img.width, img.height)
    }

    for (const layer of layers) {
        if (typeof layer.mask === 'string') {
            layer.mask = await decodeOne(layer.mask)
        }
        for (const child of layer.children || []) {
            if (typeof child.mask === 'string') {
                child.mask = await decodeOne(child.mask)
            }
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
    if (Number.isSafeInteger(minNext) && minNext > layerCounter) {
        layerCounter = minNext
    }
}
