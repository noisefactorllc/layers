/**
 * Tiny JSON-Schema-like validator. Supports the subset we actually need:
 *   - { type: 'object', properties: { ... }, required: [...], additionalProperties: false }
 *   - field types: 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object' | 'any'
 *   - numeric constraints: min, max
 *   - enum constraints: enum: [...]
 *   - string constraints: minLength, pattern (RegExp source string)
 *   - nested object schemas via type: 'object' + properties
 *   - arrays via type: 'array' + items: <schema>
 *
 * Returns { ok: true } on success or { ok: false, code, message, details } on
 * the first violation. Errors mirror the agent error taxonomy (INVALID_ARGS_*).
 *
 * @module agent/schemas
 */

import { getBlendModeIds } from '../layers/blend-modes.js'

const BLEND_MODE_IDS = getBlendModeIds()

function fail(code, message, details) {
    return { ok: false, code, message, details }
}

/**
 * Validate `args` against `schema`. The dispatcher calls this before handlers.
 *
 * @param {object} args
 * @param {object} schema
 * @returns {{ok: true} | {ok: false, code: string, message: string, details: object}}
 */
export function validate(args, schema) {
    return _validate(args, schema, '')
}

function _validate(value, schema, path) {
    if (!schema) return { ok: true }

    const type = schema.type
    if (type === 'any') return { ok: true }

    if (type === 'object') {
        if (value === null || typeof value !== 'object' || Array.isArray(value)) {
            return fail('INVALID_ARGS_TYPE',
                `${path || 'args'}: expected object, got ${typeName(value)}`,
                { field: path || '<root>', expected: 'object', got: typeName(value) })
        }
        for (const req of schema.required || []) {
            if (!(req in value)) {
                const fullPath = path ? `${path}.${req}` : req
                return fail('INVALID_ARGS_REQUIRED',
                    `${fullPath} is required`,
                    { field: fullPath })
            }
        }
        for (const [key, sub] of Object.entries(schema.properties || {})) {
            if (!(key in value)) continue
            const r = _validate(value[key], sub, path ? `${path}.${key}` : key)
            if (!r.ok) return r
        }
        if (schema.additionalProperties === false) {
            const allowed = schema.properties || {}
            for (const key of Object.keys(value)) {
                if (!(key in allowed)) {
                    const fullPath = path ? `${path}.${key}` : key
                    return fail('INVALID_ARGS_UNKNOWN',
                        `${fullPath}: unknown property`,
                        { field: fullPath, expected: 'one of declared properties', got: 'unknown property' })
                }
            }
        }
        return { ok: true }
    }

    if (type === 'array') {
        if (!Array.isArray(value)) {
            return fail('INVALID_ARGS_TYPE',
                `${path}: expected array, got ${typeName(value)}`,
                { field: path, expected: 'array', got: typeName(value) })
        }
        if (schema.items) {
            for (let i = 0; i < value.length; i++) {
                const r = _validate(value[i], schema.items, `${path}[${i}]`)
                if (!r.ok) return r
            }
        }
        return { ok: true }
    }

    if (type === 'string') {
        if (typeof value !== 'string') {
            return fail('INVALID_ARGS_TYPE',
                `${path}: expected string, got ${typeName(value)}`,
                { field: path, expected: 'string', got: typeName(value) })
        }
        if (typeof schema.minLength === 'number' && value.length < schema.minLength) {
            return fail('INVALID_ARGS_RANGE',
                `${path}: length ${value.length} is below minLength ${schema.minLength}`,
                { field: path, got: value.length, min: schema.minLength })
        }
        if (schema.pattern) {
            const re = _compiledPattern(schema)
            if (!re.test(value)) {
                return fail('INVALID_ARGS_TYPE',
                    `${path}: '${value}' does not match /${schema.pattern}/`,
                    { field: path, got: value, expected: `matches /${schema.pattern}/` })
            }
        }
        if (schema.enum && !schema.enum.includes(value)) {
            return fail('INVALID_ARGS_ENUM',
                `${path}: expected one of [${schema.enum.join(', ')}], got '${value}'`,
                { field: path, allowed: schema.enum, got: value })
        }
        return { ok: true }
    }

    if (type === 'number' || type === 'integer') {
        if (typeof value !== 'number' || !Number.isFinite(value)) {
            return fail('INVALID_ARGS_TYPE',
                `${path}: expected ${type}, got ${typeName(value)}`,
                { field: path, expected: type, got: typeName(value) })
        }
        if (type === 'integer' && !Number.isInteger(value)) {
            return fail('INVALID_ARGS_TYPE',
                `${path}: expected integer, got ${value}`,
                { field: path, expected: 'integer', got: 'number' })
        }
        if (schema.enum && !schema.enum.includes(value)) {
            return fail('INVALID_ARGS_ENUM',
                `${path}: expected one of [${schema.enum.join(', ')}], got ${value}`,
                { field: path, allowed: schema.enum, got: value })
        }
        if (typeof schema.min === 'number' && value < schema.min) {
            return fail('INVALID_ARGS_RANGE',
                `${path}: ${value} is below min ${schema.min}`,
                { field: path, value, min: schema.min, max: schema.max })
        }
        if (typeof schema.max === 'number' && value > schema.max) {
            return fail('INVALID_ARGS_RANGE',
                `${path}: ${value} is above max ${schema.max}`,
                { field: path, value, min: schema.min, max: schema.max })
        }
        return { ok: true }
    }

    if (type === 'boolean') {
        if (typeof value !== 'boolean') {
            return fail('INVALID_ARGS_TYPE',
                `${path}: expected boolean, got ${typeName(value)}`,
                { field: path, expected: 'boolean', got: typeName(value) })
        }
        return { ok: true }
    }

    return { ok: true }
}

function typeName(v) {
    if (v === null) return 'null'
    if (Array.isArray(v)) return 'array'
    return typeof v
}

/**
 * Lazily compile and cache a RegExp on the schema object. Mutates the schema
 * to attach `_patternRe` on first use so subsequent validations skip the
 * `new RegExp()` cost.
 */
function _compiledPattern(schema) {
    if (!schema._patternRe) {
        schema._patternRe = new RegExp(schema.pattern)
    }
    return schema._patternRe
}

/**
 * Per-command schema map. Each key is a command name; each value is the schema
 * for its single args object. `null` means no args / accepts anything.
 *
 * Phase 1 schemas only — extended in later phases.
 */
export const SCHEMAS = {
    _ping: null,
    _echoNumber: {
        type: 'object',
        required: ['value'],
        properties: {
            value: { type: 'number', min: 0, max: 100 }
        }
    },
    _echoEnum: {
        type: 'object',
        required: ['choice'],
        properties: {
            choice: { type: 'string', enum: ['a', 'b', 'c'] }
        }
    },
    _echoNested: {
        type: 'object',
        required: ['outer'],
        properties: {
            outer: {
                type: 'object',
                required: ['inner'],
                properties: {
                    inner: { type: 'number' }
                }
            }
        }
    },
    _sleep: {
        type: 'object',
        required: ['delayMs'],
        properties: {
            delayMs: { type: 'integer', min: 0, max: 5000 }
        }
    },
    getState: null,
    getLayer: {
        type: 'object',
        required: ['layerId'],
        properties: { layerId: { type: 'string' } }
    },
    getCanvasSize: null,
    getSelection: null,
    getProjectInfo: null,
    listProjects: null,
    getSettings: null,
    getForegroundColor: null,
    searchEffects: {
        type: 'object',
        properties: {
            query: { type: 'string' },
            namespace: { type: 'string' },
            tags: { type: 'array', items: { type: 'string' } },
            limit: { type: 'integer', min: 1, max: 1000 }
        }
    },
    listEffectCategories: null,
    listCuratedEffects: null,
    getEffectDefinition: {
        type: 'object',
        required: ['effectId'],
        properties: { effectId: { type: 'string' } }
    },
    getJob: {
        type: 'object',
        required: ['jobId'],
        properties: { jobId: { type: 'string' } }
    },
    waitForJob: {
        type: 'object',
        required: ['jobId'],
        properties: {
            jobId: { type: 'string' },
            timeoutMs: { type: 'integer', min: 0, max: 3600000 }
        }
    },
    cancelJob: {
        type: 'object',
        required: ['jobId'],
        properties: { jobId: { type: 'string' } }
    },
    addLayer: {
        type: 'object',
        required: ['kind'],
        properties: {
            kind: { type: 'string', enum: ['effect', 'drawing', 'media', 'text'] },
            effectId: { type: 'string' },
            params: { type: 'object' },
            name: { type: 'string' },
            text: { type: 'string' },
            mediaType: { type: 'string', enum: ['image', 'video'] },
            source: { type: 'object' }
        }
    },
    deleteLayer: {
        type: 'object',
        required: ['layerId'],
        properties: { layerId: { type: 'string' } }
    },
    duplicateLayer: {
        type: 'object',
        required: ['layerId'],
        properties: { layerId: { type: 'string' } }
    },
    reorderLayer: {
        type: 'object',
        required: ['layerId', 'toIndex'],
        properties: {
            layerId: { type: 'string' },
            toIndex: { type: 'integer', min: 0 }
        }
    },
    selectLayer: {
        type: 'object',
        required: ['layerId'],
        properties: { layerId: { type: 'string' } }
    },
    selectLayers: {
        type: 'object',
        required: ['layerIds'],
        properties: {
            layerIds: { type: 'array', items: { type: 'string' } }
        }
    },
    flattenImage: null,
    flattenLayers: {
        type: 'object',
        required: ['layerIds'],
        properties: {
            layerIds: { type: 'array', items: { type: 'string' } }
        }
    },
    rasterizeLayer: {
        type: 'object',
        required: ['layerId'],
        properties: { layerId: { type: 'string' } }
    },
    flipLayer: {
        type: 'object',
        required: ['layerId', 'axis'],
        properties: {
            layerId: { type: 'string' },
            axis: { type: 'string', enum: ['h', 'v'] }
        }
    },
    setLayerProps: {
        type: 'object',
        required: ['layerId', 'props'],
        properties: {
            layerId: { type: 'string' },
            props: {
                type: 'object',
                properties: {
                    name: { type: 'string' },
                    visible: { type: 'boolean' },
                    opacity: { type: 'number', min: 0, max: 100 },
                    blendMode: { type: 'string', enum: BLEND_MODE_IDS },
                    locked: { type: 'boolean' }
                }
            }
        }
    },
    setLayerTransform: {
        type: 'object',
        required: ['layerId', 'transform'],
        properties: {
            layerId: { type: 'string' },
            transform: {
                type: 'object',
                properties: {
                    offsetX: { type: 'number' },
                    offsetY: { type: 'number' },
                    scaleX: { type: 'number', min: 0.01, max: 100 },
                    scaleY: { type: 'number', min: 0.01, max: 100 },
                    rotation: { type: 'number' },
                    flipH: { type: 'boolean' },
                    flipV: { type: 'boolean' }
                }
            }
        }
    },
    setLayerEffectParams: {
        type: 'object',
        required: ['layerId', 'params'],
        properties: {
            layerId: { type: 'string' },
            params: { type: 'object' },
            replace: { type: 'boolean' }
        }
    },
    addChildEffect: {
        type: 'object',
        required: ['layerId', 'effectId'],
        properties: {
            layerId: { type: 'string' },
            effectId: { type: 'string' },
            params: { type: 'object' }
        }
    },
    removeChildEffect: {
        type: 'object',
        required: ['layerId', 'childId'],
        properties: {
            layerId: { type: 'string' },
            childId: { type: 'string' }
        }
    },
    reorderChildEffect: {
        type: 'object',
        required: ['layerId', 'childId', 'toIndex'],
        properties: {
            layerId: { type: 'string' },
            childId: { type: 'string' },
            toIndex: { type: 'integer', min: 0 }
        }
    },
    setChildEffectProps: {
        type: 'object',
        required: ['layerId', 'childId', 'props'],
        properties: {
            layerId: { type: 'string' },
            childId: { type: 'string' },
            props: {
                type: 'object',
                properties: {
                    visible: { type: 'boolean' },
                    name: { type: 'string' }
                }
            }
        }
    },
    setChildEffectParams: {
        type: 'object',
        required: ['layerId', 'childId', 'params'],
        properties: {
            layerId: { type: 'string' },
            childId: { type: 'string' },
            params: { type: 'object' },
            replace: { type: 'boolean' }
        }
    },
    getCanvasImageBytes: {
        type: 'object',
        properties: {
            format: { type: 'string', enum: ['png', 'jpg', 'webp'] },
            quality: { type: 'number', min: 0, max: 1 }
        }
    },
    getThumbnail: {
        type: 'object',
        properties: {
            maxDimension: { type: 'integer', min: 1, max: 4096 },
            format: { type: 'string', enum: ['png', 'jpg', 'webp'] },
            quality: { type: 'number', min: 0, max: 1 }
        }
    },
    getLayerThumbnail: {
        type: 'object',
        required: ['layerId'],
        properties: {
            layerId: { type: 'string' },
            maxDimension: { type: 'integer', min: 1, max: 4096 },
            format: { type: 'string', enum: ['png', 'jpg', 'webp'] },
            quality: { type: 'number', min: 0, max: 1 }
        }
    },
    exportImage: {
        type: 'object',
        properties: {
            format: { type: 'string', enum: ['png', 'jpg', 'webp'] },
            quality: { type: 'number', min: 0, max: 1 },
            width: { type: 'integer', min: 1, max: 8192 },
            height: { type: 'integer', min: 1, max: 8192 },
            filename: { type: 'string' },
            triggerDownload: { type: 'boolean' },
            captureOnly: { type: 'boolean' }
        }
    },
    pasteImageFromBytes: {
        type: 'object',
        required: ['source'],
        properties: {
            source: { type: 'object' },
            name: { type: 'string' }
        }
    },
    selectAll: null,
    selectNone: null,
    selectInverse: null,
    setRectangleSelection: {
        type: 'object',
        required: ['x', 'y', 'width', 'height'],
        properties: {
            x: { type: 'integer' },
            y: { type: 'integer' },
            width: { type: 'integer', min: 1 },
            height: { type: 'integer', min: 1 }
        }
    },
    setOvalSelection: {
        type: 'object',
        required: ['x', 'y', 'width', 'height'],
        properties: {
            x: { type: 'integer' },
            y: { type: 'integer' },
            width: { type: 'integer', min: 1 },
            height: { type: 'integer', min: 1 }
        }
    },
    setPolygonSelection: {
        type: 'object',
        required: ['points'],
        properties: {
            kind: { type: 'string', enum: ['polygon', 'lasso'] },
            points: {
                type: 'array',
                items: {
                    type: 'array',
                    items: { type: 'number' }
                }
            }
        }
    },
    setMagicWandSelection: {
        type: 'object',
        required: ['x', 'y'],
        properties: {
            x: { type: 'integer', min: 0 },
            y: { type: 'integer', min: 0 },
            tolerance: { type: 'integer', min: 0, max: 255 }
        }
    },
    selectColorRange: {
        type: 'object',
        required: ['x', 'y'],
        properties: {
            x: { type: 'integer', min: 0 },
            y: { type: 'integer', min: 0 },
            tolerance: { type: 'integer', min: 0, max: 255 }
        }
    },
    expandSelection: {
        type: 'object',
        required: ['pixels'],
        properties: { pixels: { type: 'integer', min: 1, max: 1000 } }
    },
    contractSelection: {
        type: 'object',
        required: ['pixels'],
        properties: { pixels: { type: 'integer', min: 1, max: 1000 } }
    },
    featherSelection: {
        type: 'object',
        required: ['pixels'],
        properties: { pixels: { type: 'integer', min: 1, max: 1000 } }
    },
    smoothSelection: {
        type: 'object',
        required: ['pixels'],
        properties: { pixels: { type: 'integer', min: 1, max: 1000 } }
    },
    borderSelection: {
        type: 'object',
        required: ['pixels'],
        properties: { pixels: { type: 'integer', min: 1, max: 1000 } }
    },
    cropToSelection: null,
    addLayerMask: {
        type: 'object',
        required: ['layerId'],
        properties: { layerId: { type: 'string' } }
    },
    deleteLayerMask: {
        type: 'object',
        required: ['layerId'],
        properties: { layerId: { type: 'string' } }
    },
    addMaskFromSelection: {
        type: 'object',
        required: ['layerId'],
        properties: { layerId: { type: 'string' } }
    },
    invertLayerMask: {
        type: 'object',
        required: ['layerId'],
        properties: { layerId: { type: 'string' } }
    },
    setMaskEnabled: {
        type: 'object',
        required: ['layerId', 'enabled'],
        properties: {
            layerId: { type: 'string' },
            enabled: { type: 'boolean' }
        }
    },
    featherMask: {
        type: 'object',
        required: ['layerId', 'radius'],
        properties: {
            layerId: { type: 'string' },
            radius: { type: 'integer', min: 1, max: 100 }
        }
    },
    expandMask: {
        type: 'object',
        required: ['layerId', 'radius'],
        properties: {
            layerId: { type: 'string' },
            radius: { type: 'integer', min: 1, max: 100 }
        }
    },
    contractMask: {
        type: 'object',
        required: ['layerId', 'radius'],
        properties: {
            layerId: { type: 'string' },
            radius: { type: 'integer', min: 1, max: 100 }
        }
    },
    smoothMask: {
        type: 'object',
        required: ['layerId', 'radius'],
        properties: {
            layerId: { type: 'string' },
            radius: { type: 'integer', min: 1, max: 100 }
        }
    },
    paintStroke: {
        type: 'object',
        required: ['points', 'size', 'color'],
        properties: {
            layerId: { type: 'string' },
            points: { type: 'array' },
            size: { type: 'integer', min: 1, max: 200 },
            opacity: { type: 'number', min: 0, max: 1 },
            color: { type: 'string' },
            mode: { type: 'string', enum: ['brush', 'eraser'] }
        }
    },
    eraseStroke: {
        type: 'object',
        required: ['layerId', 'strokeId'],
        properties: {
            layerId: { type: 'string', minLength: 1 },
            strokeId: { type: 'string', minLength: 1 }
        }
    },
    clearDrawingLayer: {
        type: 'object',
        required: ['layerId'],
        properties: {
            layerId: { type: 'string', minLength: 1 }
        }
    },
    drawShape: {
        type: 'object',
        required: ['shape', 'x', 'y', 'width', 'height', 'color', 'size'],
        properties: {
            layerId: { type: 'string' },
            shape: { type: 'string', enum: ['rect', 'ellipse'] },
            x: { type: 'integer' },
            y: { type: 'integer' },
            width: { type: 'integer', min: 1 },
            height: { type: 'integer', min: 1 },
            color: { type: 'string' },
            size: { type: 'integer', min: 1, max: 200 },
            opacity: { type: 'number', min: 0, max: 1 },
            filled: { type: 'boolean' }
        }
    },
    fillRegion: {
        type: 'object',
        required: ['x', 'y', 'color'],
        properties: {
            x: { type: 'integer', min: 0 },
            y: { type: 'integer', min: 0 },
            color: { type: 'string' },
            tolerance: { type: 'integer', min: 0, max: 255 }
        }
    },
    newProject: {
        type: 'object',
        required: ['width', 'height'],
        properties: {
            width: { type: 'integer', min: 1, max: 8192 },
            height: { type: 'integer', min: 1, max: 8192 },
            name: { type: 'string' }
        }
    },
    openProject: {
        type: 'object',
        required: ['projectId'],
        properties: { projectId: { type: 'string', minLength: 1 } }
    },
    saveProject: {
        type: 'object',
        properties: { name: { type: 'string', minLength: 1 } }
    },
    saveProjectAs: {
        type: 'object',
        required: ['name'],
        properties: { name: { type: 'string', minLength: 1 } }
    },
    deleteProject: {
        type: 'object',
        required: ['projectId'],
        properties: { projectId: { type: 'string', minLength: 1 } }
    },
    undo: null,
    redo: null,
    setForegroundColor: {
        type: 'object',
        required: ['color'],
        properties: { color: { type: 'string', pattern: '^#[0-9a-fA-F]{6}$' } }
    },
    setZoom: {
        type: 'object',
        required: ['mode'],
        properties: {
            mode: { type: 'string', enum: ['fit', '50', '100', '200'] }
        }
    },
    play: null,
    pause: null,
    setSettings: {
        type: 'object',
        properties: {
            theme: {
                type: 'string',
                enum: [
                    'system',
                    'gray-dark', 'gray-light',
                    'neutral-dark', 'neutral-light',
                    'corporate', 'cyberpunk', 'earthy', 'organic', 'terminal',
                    'dark', 'light'
                ]
            }
        }
    },
    resizeImage: {
        type: 'object',
        required: ['width', 'height'],
        properties: {
            width: { type: 'integer', min: 1, max: 8192 },
            height: { type: 'integer', min: 1, max: 8192 }
        }
    },
    resizeCanvas: {
        type: 'object',
        required: ['width', 'height'],
        properties: {
            width: { type: 'integer', min: 1, max: 8192 },
            height: { type: 'integer', min: 1, max: 8192 },
            anchor: {
                type: 'string',
                enum: ['top-left', 'top', 'top-right', 'left', 'center',
                       'right', 'bottom-left', 'bottom', 'bottom-right']
            }
        }
    },
    autoLevels: null,
    autoContrast: null,
    autoWhiteBalance: null,
    listInstalledFonts: { type: 'object', properties: {}, additionalProperties: false },
    installFontBundle: { type: 'object', properties: {}, additionalProperties: false },
    exportVideo: {
        type: 'object',
        properties: {
            width: { type: 'integer', min: 2, max: 4096 },
            height: { type: 'integer', min: 2, max: 4096 },
            framerate: { type: 'integer', enum: [24, 30, 60] },
            duration: { type: 'number', min: 0.1, max: 300 },
            loopCount: { type: 'integer', min: 1, max: 10 },
            format: { type: 'string', enum: ['mp4', 'zip'] },
            quality: { type: 'string', enum: ['low', 'medium', 'high', 'very high', 'ultra'] },
            playFrom: { type: 'string', enum: ['beginning', 'current'] },
            filename: { type: 'string' },
            captureOnly: { type: 'boolean' }
        },
        additionalProperties: false
    },
    releaseExport: {
        type: 'object',
        required: ['exportId'],
        properties: {
            exportId: { type: 'string', minLength: 1 }
        },
        additionalProperties: false
    },
}
