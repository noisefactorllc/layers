/**
 * Tiny JSON-Schema-like validator. Supports the subset we actually need:
 *   - { type: 'object', properties: { ... }, required: [...] }
 *   - field types: 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object' | 'any'
 *   - numeric constraints: min, max
 *   - enum constraints: enum: [...]
 *   - nested object schemas via type: 'object' + properties
 *   - arrays via type: 'array' + items: <schema>
 *
 * Returns { ok: true } on success or { ok: false, code, message, details } on
 * the first violation. Errors mirror the agent error taxonomy (INVALID_ARGS_*).
 *
 * @module agent/schemas
 */

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
        if (schema.enum && !schema.enum.includes(value)) {
            return fail('INVALID_ARGS_ENUM',
                `${path}: expected one of [${schema.enum.join(', ')}], got '${value}'`,
                { field: path, allowed: schema.enum, got: value })
        }
        return { ok: true }
    }

    if (type === 'number' || type === 'integer') {
        if (typeof value !== 'number' || Number.isNaN(value)) {
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
                    blendMode: { type: 'string' },
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
}
