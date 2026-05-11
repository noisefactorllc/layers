/**
 * Effect catalog helpers built on the renderer's existing introspection.
 *
 * @module agent/effects
 */

const CURATED_GROUPS = [
    {
        id: 'tone',
        label: 'tone',
        effects: [
            { effectId: 'filter/adjust',     label: 'brightness/contrast' },
            { effectId: 'filter/smoothstep', label: 'levels' },
            { effectId: 'filter/posterize',  label: 'posterize' },
            { effectId: 'filter/threshold',  label: 'threshold' }
        ]
    },
    {
        id: 'color',
        label: 'color',
        effects: [
            { effectId: 'filter/adjust',          label: 'hue/saturation' },
            { effectId: 'filter/grade',           label: 'color grading' },
            { effectId: 'filter/tint',            label: 'tint' },
            { effectId: 'filter/invert',          label: 'invert' },
            { effectId: 'filter/tetraColorArray', label: 'gradient palette' }
        ]
    },
    {
        id: 'blur-sharpen',
        label: 'blur & sharpen',
        effects: [
            { effectId: 'filter/blur',       label: 'blur' },
            { effectId: 'filter/motionBlur', label: 'motion blur' },
            { effectId: 'filter/zoomBlur',   label: 'zoom blur' },
            { effectId: 'filter/sharpen',    label: 'sharpen' }
        ]
    },
    {
        id: 'stylize',
        label: 'stylize',
        effects: [
            { effectId: 'filter/bloom',    label: 'bloom' },
            { effectId: 'filter/grain',    label: 'grain' },
            { effectId: 'filter/vignette', label: 'vignette' },
            { effectId: 'filter/edge',     label: 'edge detect' },
            { effectId: 'filter/dither',   label: 'dither' },
            { effectId: 'filter/emboss',   label: 'emboss' }
        ]
    }
]

export function listCurated() {
    return { groups: CURATED_GROUPS.map(g => ({ ...g, effects: g.effects.slice() })) }
}

export function searchEffects(app, { query, namespace, tags, limit }) {
    const all = app?._renderer?.getAllEffects?.() || []
    const q = (query || '').trim().toLowerCase()
    const filtered = all.filter((e) => {
        if (namespace && e.namespace !== namespace) return false
        if (tags && tags.length) {
            const want = tags.map(t => t.toLowerCase())
            const have = (e.tags || []).map(t => t.toLowerCase())
            if (!want.every(t => have.includes(t))) return false
        }
        if (q) {
            const hay = (e.effectId + ' ' + e.name + ' ' +
                (e.description || '') + ' ' + (e.tags || []).join(' ')).toLowerCase()
            if (!hay.includes(q)) return false
        }
        return true
    })
    const result = limit ? filtered.slice(0, limit) : filtered
    return {
        effects: result.map(e => ({
            effectId: e.effectId,
            namespace: e.namespace,
            name: e.name,
            description: e.description || '',
            tags: e.tags || [],
            starter: !!e.starter
        }))
    }
}

export function listCategories(app) {
    const all = app?._renderer?.getAllEffects?.() || []
    const namespaces = new Set()
    const tags = new Set()
    for (const e of all) {
        if (e.namespace) namespaces.add(e.namespace)
        for (const t of e.tags || []) tags.add(t)
    }
    return {
        namespaces: Array.from(namespaces).sort(),
        tags: Array.from(tags).sort()
    }
}

export async function getEffectDefinition(app, { effectId }) {
    const all = app?._renderer?.getAllEffects?.() || []
    const meta = all.find(e => e.effectId === effectId)
    const instance = await app?._renderer?.getEffectDefinition?.(effectId)
    if (!instance && !meta) return null

    const [namespace, shortName] = effectId.split('/')
    const globals = instance?.globals || {}
    const params = Object.entries(globals)
        .filter(([_, spec]) => !spec.ui?.hidden && !spec.internal)
        .map(([name, spec]) => normalizeParamSpec(name, spec))

    return {
        effectId,
        name: meta?.name || shortName,
        namespace: meta?.namespace || namespace,
        description: meta?.description || '',
        tags: meta?.tags || [],
        params
    }
}

function normalizeParamSpec(name, spec) {
    const out = {
        name,
        type: mapParamType(spec),
        default: spec.default,
        description: spec.ui?.label || ''
    }
    if (spec.min !== undefined) out.min = spec.min
    if (spec.max !== undefined) out.max = spec.max
    if (spec.step !== undefined) out.step = spec.step
    if (spec.choices && typeof spec.choices === 'object' && !Array.isArray(spec.choices)) {
        out.enumValues = Object.entries(spec.choices).map(([label, value]) => ({ value, label }))
    }
    return out
}

function mapParamType(spec) {
    if (spec.type === 'float')   return 'number'
    if (spec.type === 'int')     return 'integer'
    if (spec.type === 'boolean') return 'boolean'
    if (spec.type === 'string')  return 'string'
    if (spec.type === 'color' || spec.type === 'vec4') return 'color'
    if (spec.type === 'vec2' || spec.type === 'vec3')  return spec.type
    if (spec.choices)            return 'enum'
    return 'any'
}
