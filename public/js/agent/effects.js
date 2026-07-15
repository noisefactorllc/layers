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
            { effectId: 'filter/colorReplace',    label: 'color replace' },
            { effectId: 'filter/invert',          label: 'invert' },
            { effectId: 'filter/tetraColorArray', label: 'gradient palette' }
        ]
    },
    {
        id: 'blur',
        label: 'blur',
        effects: [
            { effectId: 'filter/blur',            label: 'blur' },
            { effectId: 'filter/directionalBlur', label: 'motion blur' },
            { effectId: 'filter/zoomBlur',        label: 'zoom blur' },
            { effectId: 'filter/spinBlur',        label: 'spin blur' },
            { effectId: 'filter/median',          label: 'median' },
            { effectId: 'filter/vaseline',        label: 'soft focus' }
        ]
    },
    {
        id: 'sharpen',
        label: 'sharpen',
        effects: [
            { effectId: 'filter/sharpen',     label: 'sharpen' },
            { effectId: 'filter/unsharpMask', label: 'unsharp mask' },
            { effectId: 'filter/highPass',    label: 'high pass' }
        ]
    },
    {
        id: 'pixelate',
        label: 'pixelate',
        effects: [
            { effectId: 'filter/pixels',   label: 'pixelate' },
            { effectId: 'filter/halftone', label: 'halftone' },
            { effectId: 'filter/dither',   label: 'dither' },
            { effectId: 'filter/lowPoly',  label: 'low poly' },
            { effectId: 'filter/glyphMap', label: 'glyph map' },
            { effectId: 'filter/stipple',  label: 'stipple' }
        ]
    },
    {
        id: 'distort',
        label: 'distort',
        effects: [
            { effectId: 'filter/warp',        label: 'warp' },
            { effectId: 'filter/bulge',       label: 'bulge' },
            { effectId: 'filter/pinch',       label: 'pinch' },
            { effectId: 'filter/skew',        label: 'skew' },
            { effectId: 'filter/waves',       label: 'waves' },
            { effectId: 'filter/pondRipples', label: 'ripples' },
            { effectId: 'filter/spiral',      label: 'twirl' },
            { effectId: 'filter/polar',       label: 'polar coordinates' },
            { effectId: 'filter/tunnel',      label: 'tunnel' },
            { effectId: 'filter/wormhole',    label: 'wormhole' }
        ]
    },
    {
        id: 'glitch',
        label: 'glitch',
        effects: [
            // Initial params where the effect's spec defaults would render as
            // a no-op — the menu must never add a do-nothing layer.
            { effectId: 'classicNoisedeck/glitch',    label: 'glitch',
                params: { glitchiness: 50, aberration: 30 } },
            { effectId: 'filter/corrupt',             label: 'corrupt' },
            { effectId: 'filter/pixelSort',           label: 'pixel sort' },
            { effectId: 'filter/scanlineError',       label: 'scanline error' },
            { effectId: 'filter/crt',                 label: 'crt' },
            { effectId: 'filter/snow',                label: 'tv snow' },
            { effectId: 'filter/degauss',             label: 'degauss' },
            { effectId: 'filter/chromaticAberration', label: 'chromatic aberration' },
            { effectId: 'filter/convolutionFeedback', label: 'feedback' },
            { effectId: 'filter/reverb',              label: 'echo trails' },
            { effectId: 'filter/feedback',            label: 'video feedback',
                params: { mix: 50, scaleAmt: 97, rotation: 2 } }
        ]
    },
    {
        id: 'stylize',
        label: 'stylize',
        effects: [
            { effectId: 'filter/edge',        label: 'edge detect' },
            { effectId: 'filter/glowingEdge', label: 'glowing edge' },
            { effectId: 'filter/emboss',      label: 'emboss' },
            { effectId: 'filter/extrude',     label: 'extrude' },
            { effectId: 'filter/celShading',  label: 'cel shading' },
            { effectId: 'filter/oilPaint',    label: 'oil paint' },
            { effectId: 'filter/wind',        label: 'wind' },
            { effectId: 'filter/scatter',     label: 'scatter' }
        ]
    },
    {
        id: 'sketch',
        label: 'sketch',
        effects: [
            { effectId: 'filter/chrome',    label: 'chrome' },
            { effectId: 'filter/photocopy', label: 'photocopy' },
            { effectId: 'filter/stamp',     label: 'stamp' },
            { effectId: 'filter/relief',    label: 'relief' }
        ]
    },
    {
        id: 'brushStrokes',
        label: 'brush strokes',
        effects: [
            { effectId: 'filter/hatch',   label: 'hatch' },
            { effectId: 'filter/strokes', label: 'strokes' },
            { effectId: 'filter/spatter', label: 'spatter' },
            { effectId: 'filter/outline', label: 'outline' }
        ]
    },
    {
        id: 'artistic',
        label: 'artistic',
        effects: [
            { effectId: 'filter/watercolor',      label: 'watercolor' },
            { effectId: 'filter/plasticWrap',     label: 'plastic wrap' },
            { effectId: 'filter/historicPalette', label: 'historic palette' }
        ]
    },
    {
        id: 'texture',
        label: 'texture',
        effects: [
            { effectId: 'filter/grain',       label: 'grain' },
            { effectId: 'filter/craquelure',  label: 'craquelure' },
            { effectId: 'filter/mosaicTiles', label: 'mosaic tiles' },
            { effectId: 'filter/patchwork',   label: 'patchwork' },
            { effectId: 'filter/texture',     label: 'texturizer' },
            { effectId: 'filter/grime',       label: 'grime' }
        ]
    },
    {
        id: 'lightLens',
        label: 'light & lens',
        effects: [
            { effectId: 'filter/bloom',     label: 'bloom' },
            { effectId: 'filter/vignette',  label: 'vignette' },
            { effectId: 'filter/lensFlare', label: 'lens flare' },
            { effectId: 'filter/lightLeak', label: 'light leak' },
            { effectId: 'filter/lighting',  label: 'lighting' },
            { effectId: 'filter/lens',      label: 'lens distortion',
                params: { displacement: 0.3 } },
            { effectId: 'filter/clouds',    label: 'clouds' }
        ]
    },
    {
        id: 'tile',
        label: 'tile',
        effects: [
            { effectId: 'filter/tile',       label: 'kaleidoscope' },
            { effectId: 'filter/repeat',     label: 'repeat' },
            { effectId: 'filter/seamless',   label: 'seamless' },
            { effectId: 'filter/flipMirror', label: 'flip mirror' }
        ]
    }
]

export function listCurated() {
    // Deep clone: entries may carry nested `params` objects, and a shallow
    // copy would let callers mutate the shared catalog for the whole session.
    return structuredClone({ groups: CURATED_GROUPS })
}

/**
 * Walk the renderer's raw manifest and return one descriptor per effect,
 * including synth/starter/3D effects that LayersRenderer.getAllEffects hides
 * from the human Image menu. addLayer/addChildEffect accept those effectIds,
 * so the agent surface must be able to discover them.
 *
 * Each descriptor includes a `kind` field:
 *   - 'starter' — manifest entry has `starter:true` (e.g. synth/...)
 *   - 'synth'   — effectId namespace is 'synth' or 'synth3d' (no starter flag)
 *   - 'effect'  — everything else (filter/, mixer/, etc.)
 *
 * Effects without a manifest entry (loadable but unannounced) are skipped —
 * they would not be addressable by addLayer anyway.
 */
function listAllManifestEffects(app) {
    const manifest = app?._renderer?.manifest || {}
    const out = []
    for (const [effectId, entry] of Object.entries(manifest)) {
        if (!effectId.includes('/')) continue
        const [namespace, name] = effectId.split('/')
        const starter = !!entry?.starter
        let kind = 'effect'
        if (starter) {
            kind = 'starter'
        } else if (namespace === 'synth' || namespace === 'synth3d') {
            kind = 'synth'
        }
        out.push({
            effectId,
            namespace,
            name,
            description: entry?.description || '',
            tags: Array.isArray(entry?.tags) ? entry.tags.slice() : [],
            starter,
            kind
        })
    }
    // Stable order: namespace, then name. Mirrors LayersRenderer._queryEffects'
    // sort so agents see a predictable ordering across calls.
    out.sort((a, b) =>
        a.namespace !== b.namespace
            ? a.namespace.localeCompare(b.namespace)
            : a.name.localeCompare(b.name)
    )
    return out
}

export function searchEffects(app, { query, namespace, tags, limit }) {
    const all = listAllManifestEffects(app)
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
            starter: !!e.starter,
            kind: e.kind
        }))
    }
}

export function listCategories(app) {
    const all = listAllManifestEffects(app)
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
    // Use the full manifest (not getAllEffects, which hides synth/starter) so
    // synth/synth3d/starter effects resolve metadata too — they're valid for
    // addLayer, so the agent must be able to introspect their params.
    const all = listAllManifestEffects(app)
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
