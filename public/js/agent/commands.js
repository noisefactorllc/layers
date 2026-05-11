/**
 * Phase 1 read-only commands.
 *
 * Handlers receive (args, app) and return { result, warnings? }. The dispatcher
 * wraps each call in an envelope with the latest state snapshot.
 *
 * @module agent/commands
 */

import { buildSnapshot } from './snapshot.js'
import { commandError } from './dispatcher.js'
import { listProjects as listProjectsStorage } from '../utils/project-storage.js'
import * as effectsModule from './effects.js'
import { createDrawingLayer } from '../layers/layer-model.js'

export async function getState(_args, app) {
    return { result: buildSnapshot(app) }
}

export async function getLayer({ layerId }, app) {
    const snap = buildSnapshot(app)
    const layer = snap.layers.find(l => l.id === layerId)
    if (!layer) {
        throw commandError('NOT_FOUND_LAYER', `Layer not found: ${layerId}`, { layerId })
    }
    return { result: layer }
}

export async function getCanvasSize(_args, app) {
    return {
        result: {
            width: app?._canvas?.width || 0,
            height: app?._canvas?.height || 0
        }
    }
}

export async function getSelection(_args, app) {
    const snap = buildSnapshot(app)
    return { result: snap.selection }
}

export async function getProjectInfo(_args, app) {
    const snap = buildSnapshot(app)
    return { result: snap.project }
}

export async function listProjects(_args, _app) {
    let projects = []
    try {
        const raw = await listProjectsStorage()
        projects = (raw || []).map(p => ({
            id: p.id,
            name: p.name,
            createdAt: p.createdAt,
            modifiedAt: p.modifiedAt
        }))
    } catch (err) {
        return {
            result: { projects: [] },
            warnings: [`listProjects storage error: ${err.message || err}`]
        }
    }
    return { result: { projects } }
}

export async function getSettings(_args, app) {
    const snap = buildSnapshot(app)
    return { result: snap.settings }
}

export async function getForegroundColor(_args, app) {
    return { result: { color: app?._foregroundColor || '#000000' } }
}

export async function searchEffects(args, app) {
    return { result: effectsModule.searchEffects(app, args || {}) }
}

export async function listEffectCategories(_args, app) {
    return { result: effectsModule.listCategories(app) }
}

export async function listCuratedEffects(_args, _app) {
    return { result: effectsModule.listCurated() }
}

export async function getEffectDefinition({ effectId }, app) {
    const def = await effectsModule.getEffectDefinition(app, { effectId })
    if (!def) {
        const allList = app?._renderer?.getAllEffects?.() || []
        const allIds = allList.map(e => e.effectId)
        const didYouMean = closest(effectId, allIds, 3)
        throw commandError('NOT_FOUND_EFFECT',
            `Effect not found: ${effectId}`,
            { effectId, didYouMean })
    }
    return { result: def }
}

function closest(needle, haystack, k) {
    const scored = haystack.map((id) => [id, levenshtein(needle, id)])
    scored.sort((a, b) => a[1] - b[1])
    return scored.slice(0, k).map(([id]) => id)
}

function levenshtein(a, b) {
    const m = a.length, n = b.length
    if (m === 0) return n
    if (n === 0) return m
    const dp = Array.from({ length: m + 1 }, () => new Array(n + 1))
    for (let i = 0; i <= m; i++) dp[i][0] = i
    for (let j = 0; j <= n; j++) dp[0][j] = j
    for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1
            dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost)
        }
    }
    return dp[m][n]
}

export async function getJob({ jobId }) {
    throw commandError('NOT_FOUND_JOB', `Job not found: ${jobId}`, { jobId })
}

export async function waitForJob({ jobId }) {
    throw commandError('NOT_FOUND_JOB', `Job not found: ${jobId}`, { jobId })
}

export async function cancelJob({ jobId }) {
    throw commandError('NOT_FOUND_JOB', `Job not found: ${jobId}`, { jobId })
}

/**
 * Look up a layer by id; throw NOT_FOUND_LAYER if missing.
 * Used by every layerId-taking handler.
 */
function requireLayer(layerId, app) {
    const layer = (app?._layers || []).find(l => l.id === layerId)
    if (!layer) {
        throw commandError('NOT_FOUND_LAYER', `Layer not found: ${layerId}`, { layerId })
    }
    return layer
}

/**
 * Look up a child effect within a layer; throw NOT_FOUND_LAYER if either is missing.
 */
function requireChildEffect(layerId, childId, app) {
    const layer = requireLayer(layerId, app)
    const child = (layer.children || []).find(c => c.id === childId)
    if (!child) {
        throw commandError('NOT_FOUND_LAYER',
            `Child effect not found: ${childId} (in ${layerId})`,
            { layerId, childId })
    }
    return { layer, child }
}

/**
 * Convert a base64-encoded buffer to a File for use with _handleAddMediaLayer.
 */
function base64ToFile(data, mimeType, name) {
    const binary = atob(data)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    return new File([bytes], name || 'media', { type: mimeType || 'application/octet-stream' })
}

export async function addLayer(args, app) {
    const { kind } = args
    if (kind === 'effect') return addEffectLayer(args, app)
    if (kind === 'drawing') return addDrawingLayer(args, app)
    if (kind === 'media') return addMediaLayer(args, app)
    if (kind === 'text') return addTextLayer(args, app)
    // Schema enum guarantees one of the four; this is unreachable.
    throw commandError('INVALID_ARGS_ENUM', `Unknown kind: ${kind}`, { field: 'kind', got: kind })
}

async function addEffectLayer({ effectId, params, name }, app) {
    if (!effectId) {
        throw commandError('INVALID_ARGS_REQUIRED', 'effectId is required for kind=effect',
            { field: 'effectId' })
    }
    // Validate the effectId exists by looking at the manifest. Synth effects are
    // hidden from getAllEffects() but ARE valid for addLayer; check the renderer's
    // raw manifest instead.
    const manifest = app?._renderer?.manifest || {}
    if (!manifest[effectId]) {
        throw commandError('NOT_FOUND_EFFECT', `Effect not found: ${effectId}`, { effectId })
    }
    await app._handleAddEffectLayer(effectId)
    const layer = app._layers[app._layers.length - 1]
    if (name) layer.name = name
    if (params) {
        await app._handleLayerChange({
            layerId: layer.id,
            property: 'effectParams',
            value: { ...layer.effectParams, ...params }
        })
    }
    return { result: { layerId: layer.id } }
}

async function addDrawingLayer({ name }, app) {
    app._finalizePendingUndo?.()
    const layer = createDrawingLayer(name)
    app._layers.push(layer)
    if (app._layerStack) app._layerStack.selectedLayerId = layer.id
    app._updateLayerStack?.()
    await app._rebuild?.()
    app._markDirty?.()
    app._pushUndoState?.()
    return { result: { layerId: layer.id } }
}

async function addMediaLayer({ source, mediaType, name }, app) {
    if (!source) {
        throw commandError('INVALID_ARGS_REQUIRED', 'source is required for kind=media',
            { field: 'source' })
    }
    if (!mediaType) {
        throw commandError('INVALID_ARGS_REQUIRED', 'mediaType is required for kind=media',
            { field: 'mediaType' })
    }
    const file = await sourceToFile(source, name || 'media')
    await app._handleAddMediaLayer(file, mediaType)
    const layer = app._layers[app._layers.length - 1]
    if (name) layer.name = name
    return { result: { layerId: layer.id } }
}

async function sourceToFile(source, defaultName) {
    if (!source || typeof source !== 'object') {
        throw commandError('INVALID_ARGS_TYPE', 'source must be an object',
            { field: 'source', expected: 'object' })
    }
    if (source.kind === 'base64') {
        if (typeof source.data !== 'string') {
            throw commandError('INVALID_ARGS_TYPE', 'source.data must be a base64 string',
                { field: 'source.data', expected: 'string' })
        }
        return base64ToFile(source.data, source.mimeType, defaultName)
    }
    if (source.kind === 'url') {
        if (typeof source.value !== 'string') {
            throw commandError('INVALID_ARGS_TYPE', 'source.value must be a URL string',
                { field: 'source.value', expected: 'string' })
        }
        let response
        try {
            response = await fetch(source.value)
        } catch (err) {
            throw commandError('RESOURCE_DECODE_FAILED',
                `Failed to fetch source URL: ${err.message || err}`,
                { url: source.value })
        }
        if (!response.ok) {
            throw commandError('RESOURCE_DECODE_FAILED',
                `Source URL returned HTTP ${response.status}`,
                { url: source.value, status: response.status })
        }
        const blob = await response.blob()
        return new File([blob], defaultName, { type: blob.type })
    }
    throw commandError('INVALID_ARGS_ENUM',
        `source.kind must be 'base64' or 'url', got '${source.kind}'`,
        { field: 'source.kind', allowed: ['base64', 'url'], got: source.kind })
}

async function addTextLayer({ text, params, name }, app) {
    if (typeof text !== 'string') {
        throw commandError('INVALID_ARGS_REQUIRED', 'text is required for kind=text',
            { field: 'text' })
    }
    return addEffectLayer({
        effectId: 'filter/text',
        params: { text, ...(params || {}) },
        name
    }, app)
}

export async function deleteLayer({ layerId }, app) {
    requireLayer(layerId, app)
    await app._handleDeleteLayer(layerId)
    return { result: { layerId } }
}

export async function duplicateLayer({ layerId }, app) {
    requireLayer(layerId, app)
    const prevSelected = app._layerStack?.selectedLayerId
    if (app._layerStack) app._layerStack.selectedLayerId = layerId
    const ok = await app._duplicateActiveLayer()
    if (!ok) {
        if (app._layerStack && prevSelected) app._layerStack.selectedLayerId = prevSelected
        throw commandError('CONFLICT_DUPLICATE_FAILED',
            `Could not duplicate layer ${layerId}`, { layerId })
    }
    // _duplicateActiveLayer sets selectedLayerId to the new layer.
    const newId = app._layerStack?.selectedLayerId
    return { result: { layerId: newId } }
}

export async function reorderLayer({ layerId, toIndex }, app) {
    requireLayer(layerId, app)
    const layers = app._layers
    if (toIndex < 0 || toIndex >= layers.length) {
        throw commandError('INVALID_ARGS_RANGE',
            `toIndex ${toIndex} is out of range (layers.length=${layers.length})`,
            { field: 'toIndex', value: toIndex, min: 0, max: layers.length - 1 })
    }
    app._finalizePendingUndo?.()
    const fromIndex = layers.findIndex(l => l.id === layerId)
    const [moved] = layers.splice(fromIndex, 1)
    layers.splice(toIndex, 0, moved)
    app._updateLayerStack?.()
    await app._rebuild?.()
    app._markDirty?.()
    app._pushUndoState?.()
    return { result: { layerId, toIndex } }
}

export async function selectLayer({ layerId }, app) {
    requireLayer(layerId, app)
    if (app._layerStack) {
        app._layerStack.selectedLayerId = layerId
    }
    return { result: { layerId } }
}

export async function selectLayers({ layerIds }, app) {
    for (const id of layerIds) requireLayer(id, app)
    if (app._layerStack) {
        // The setter for selectedLayerId clears the set, so don't call it after
        // selectedLayerIds — the selectedLayerId getter already returns the first
        // element in the set.
        app._layerStack.selectedLayerIds = [...layerIds]
    }
    return { result: { layerIds } }
}

export async function flattenImage(_args, app) {
    await app._flattenImage()
    return { result: { ok: true } }
}

export async function flattenLayers({ layerIds }, app) {
    for (const id of layerIds) requireLayer(id, app)
    if (layerIds.length < 2) {
        throw commandError('INVALID_ARGS_RANGE',
            'flattenLayers requires at least 2 layerIds',
            { field: 'layerIds', value: layerIds.length, min: 2 })
    }
    await app._flattenLayers(layerIds)
    return { result: { ok: true } }
}

export async function rasterizeLayer({ layerId }, app) {
    requireLayer(layerId, app)
    await app._rasterizeLayer(layerId)
    return { result: { layerId } }
}

export async function flipLayer({ layerId, axis }, app) {
    const layer = requireLayer(layerId, app)
    if (layer.sourceType !== 'media') {
        throw commandError('CONFLICT_TOOL_BLOCKED_FOR_TYPE',
            'flipLayer only supports media layers',
            { layerId, sourceType: layer.sourceType })
    }
    if (app._layerStack) app._layerStack.selectedLayerId = layerId
    app._flipActiveLayer(axis === 'h' ? 'horizontal' : 'vertical')
    return { result: { layerId, axis } }
}

const SET_LAYER_PROPS_FIELDS = ['name', 'visible', 'opacity', 'blendMode', 'locked']

export async function setLayerProps({ layerId, props }, app) {
    const layer = requireLayer(layerId, app)
    for (const field of SET_LAYER_PROPS_FIELDS) {
        if (props[field] === undefined) continue
        if (field === 'visible') {
            // The UI emits 'visibility' as the property name on layer-change
            // events but the actual layer field is `visible`. _handleLayerChange's
            // unconditional layer[property] = value assignment would write to a
            // dead `layer.visibility` field, so we mutate `visible` ourselves
            // first, then call through for the side effects (rebuild, undo push).
            layer.visible = props[field]
            await app._handleLayerChange({
                layerId,
                property: 'visibility',
                value: props[field]
            })
        } else {
            await app._handleLayerChange({
                layerId,
                property: field,
                value: props[field]
            })
        }
    }
    if (app._updateLayerStack) app._updateLayerStack()
    return { result: { layerId } }
}

const TRANSFORM_FIELDS = ['offsetX', 'offsetY', 'scaleX', 'scaleY', 'rotation', 'flipH', 'flipV']

export async function setLayerTransform({ layerId, transform }, app) {
    const layer = requireLayer(layerId, app)
    let touched = false
    for (const field of TRANSFORM_FIELDS) {
        if (transform[field] === undefined) continue
        layer[field] = transform[field]
        touched = true
    }
    if (touched) {
        if (app._updateTransformRender) {
            app._updateTransformRender(layer)
        } else {
            await app._rebuild?.()
        }
        app._markDirty?.()
        app._pushUndoStateDebounced?.()
    }
    return { result: { layerId } }
}

export async function setLayerEffectParams({ layerId, params, replace }, app) {
    const layer = requireLayer(layerId, app)
    if (layer.sourceType !== 'effect') {
        throw commandError('CONFLICT_NOT_EFFECT_LAYER',
            `Layer ${layerId} is not an effect layer (sourceType=${layer.sourceType})`,
            { layerId, sourceType: layer.sourceType })
    }
    const next = replace ? { ...params } : { ...layer.effectParams, ...params }
    await app._handleLayerChange({
        layerId,
        property: 'effectParams',
        value: next
    })
    return { result: { layerId, params: next } }
}

export async function addChildEffect({ layerId, effectId, params }, app) {
    const layer = requireLayer(layerId, app)
    const manifest = app?._renderer?.manifest || {}
    if (!manifest[effectId]) {
        throw commandError('NOT_FOUND_EFFECT', `Effect not found: ${effectId}`, { effectId })
    }
    await app._handleAddChildEffect(layerId, effectId)
    const newChild = layer.children[layer.children.length - 1]
    if (params) {
        await app._handleLayerChange({
            layerId: newChild.id,
            parentLayerId: layerId,
            property: 'effectParams',
            value: { ...newChild.effectParams, ...params }
        })
    }
    return { result: { childId: newChild.id } }
}

export async function removeChildEffect({ layerId, childId }, app) {
    const { layer } = requireChildEffect(layerId, childId, app)
    await app._handleDeleteLayer(childId, layerId)
    return { result: { childId } }
}

export async function reorderChildEffect({ layerId, childId, toIndex }, app) {
    const { layer } = requireChildEffect(layerId, childId, app)
    const children = layer.children
    if (toIndex < 0 || toIndex >= children.length) {
        throw commandError('INVALID_ARGS_RANGE',
            `toIndex ${toIndex} is out of range (children.length=${children.length})`,
            { field: 'toIndex', value: toIndex, min: 0, max: children.length - 1 })
    }
    app._finalizePendingUndo?.()
    const fromIndex = children.findIndex(c => c.id === childId)
    const [moved] = children.splice(fromIndex, 1)
    children.splice(toIndex, 0, moved)
    app._updateLayerStack?.()
    await app._rebuild?.()
    app._markDirty?.()
    app._pushUndoState?.()
    return { result: { layerId, childId, toIndex } }
}

export async function setChildEffectProps({ layerId, childId, props }, app) {
    const { child } = requireChildEffect(layerId, childId, app)
    if (props.visible !== undefined) {
        // Same `visibility`-vs-`visible` rename issue as setLayerProps:
        // mutate the actual field, then call through for rebuild/undo.
        child.visible = props.visible
        await app._handleLayerChange({
            layerId: childId,
            parentLayerId: layerId,
            property: 'visibility',
            value: props.visible
        })
    }
    if (props.name !== undefined) {
        child.name = props.name
        app._updateLayerStack?.()
        app._markDirty?.()
    }
    return { result: { layerId, childId } }
}

export async function setChildEffectParams({ layerId, childId, params, replace }, app) {
    const { child } = requireChildEffect(layerId, childId, app)
    const next = replace ? { ...params } : { ...child.effectParams, ...params }
    await app._handleLayerChange({
        layerId: childId,
        parentLayerId: layerId,
        property: 'effectParams',
        value: next
    })
    return { result: { layerId, childId, params: next } }
}
