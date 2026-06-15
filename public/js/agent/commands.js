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
import { safeClone } from './constants.js'
import {
    recordExport,
    makeExportId,
    timestampedFilename,
    rememberCaptureBlobUrl,
    consumeCaptureBlobUrl
} from './exports-state.js'
import {
    listProjects as listProjectsStorage,
    saveProject as saveProjectStorage,
    loadProject as loadProjectStorage,
    deleteProject as deleteProjectStorage,
    getProject as getProjectStorage
} from '../utils/project-storage.js'
import * as effectsModule from './effects.js'
import { createDrawingLayer } from '../layers/layer-model.js'
// We use namespace import here because the agent's handler functions
// (featherMask, expandMask, contractMask, smoothMask) shadow the selection-
// modify export names — `selectionMods.featherMask(...)` tracks provenance
// at each call site and avoids the alias dance. `public/js/app.js` uses
// named imports for the same module because it has no such collision (the
// app methods are bound to `this`, not free functions). Both styles are
// fine; the divergence is collision avoidance, not a coding-standard split.
import * as selectionMods from '../selection/selection-modify.js'
import { floodFill } from '../selection/flood-fill.js'
import { readRenderPixels } from '../utils/canvas-readback.js'
import { createPathStroke, createShapeStroke } from '../drawing/stroke-model.js'
import {
    autoLevels as autoLevelsFn,
    autoContrast as autoContrastFn,
    autoWhiteBalance as autoWhiteBalanceFn
} from '../utils/auto-adjust.js'
import * as jobsRegistry from './jobs.js'
import { JOB_KINDS } from './jobs.js'
import { MAX_EXPORT_FRAMES } from './limits.js'
import { getFontaineLoader } from '../layers/fontaine-loader.js'
import { runVideoExport } from '../ui/video-exporter.js'
import { toast } from '../ui/toast.js'
import { setTheme } from '../ui/settings-dialog.js'

/**
 * Reject any param value whose string content contains a literal `"""`.
 *
 * Background: the renderer emits param strings inside `"""..."""` triple-quoted
 * DSL literals so internal `"` characters survive the lexer (font stacks,
 * multi-line text). The DSL lexer has no escape sequences inside triple-quoted
 * strings, so a value that itself contains `"""` would close the literal
 * mid-stream and corrupt emission. The renderer logs a warning when this
 * happens, but warning is informational — the agent layer is the right place
 * to reject the input cleanly before it reaches the renderer.
 *
 * Walks the params object's own enumerable values one level deep. Vec / color
 * arrays of numbers are skipped (they don't go through the triple-quote path).
 *
 * @param {object} params
 * @param {string} fieldPrefix - prepended to the field path in the error details.
 * @throws INVALID_ARGS_TYPE when any string value contains `"""`.
 */
function rejectTripleQuoteInParams(params, fieldPrefix = 'params') {
    if (!params || typeof params !== 'object') return
    for (const [key, value] of Object.entries(params)) {
        if (typeof value === 'string' && value.includes('"""')) {
            const preview = value.length > 60 ? value.slice(0, 57) + '...' : value
            throw commandError('INVALID_ARGS_TYPE',
                `Param value contains '"""' which would corrupt DSL emission`,
                { field: `${fieldPrefix}.${key}`, got: preview })
        }
    }
}

/**
 * Return the full state snapshot. Equivalent to the `state` field the
 * dispatcher attaches to every other envelope — useful when an agent wants
 * the snapshot in isolation without performing any side effect.
 *
 * @returns {Promise<{result: object}>}
 */
export async function getState(_args, app) {
    return { result: buildSnapshot(app) }
}

/**
 * Return the snapshot view of a single layer.
 *
 * @param {{layerId: string}} args
 * @returns {Promise<{result: object}>}
 * @throws NOT_FOUND_LAYER — when no layer has that id.
 */
export async function getLayer({ layerId }, app) {
    const snap = buildSnapshot(app)
    const layer = snap.layers.find(l => l.id === layerId)
    if (!layer) {
        throw commandError('NOT_FOUND_LAYER', `Layer not found: ${layerId}`, { layerId })
    }
    return { result: layer }
}

/**
 * Return the current canvas pixel dimensions. Cheap shortcut over getState
 * for callers that only need the size.
 *
 * @returns {Promise<{result: {width: number, height: number}}>}
 */
export async function getCanvasSize(_args, app) {
    return {
        result: {
            width: app?._canvas?.width || 0,
            height: app?._canvas?.height || 0
        }
    }
}

/**
 * Return the current selection descriptor (kind + bounds + optional points),
 * or null when no selection is active.
 *
 * @returns {Promise<{result: object|null}>}
 */
export async function getSelection(_args, app) {
    const snap = buildSnapshot(app)
    return { result: snap.selection }
}

/**
 * Return project metadata: id, name, dirty/undo/redo flags.
 *
 * @returns {Promise<{result: object}>}
 */
export async function getProjectInfo(_args, app) {
    const snap = buildSnapshot(app)
    return { result: snap.project }
}

/**
 * List the saved projects in browser storage. Storage failures are reported
 * via the envelope's `warnings` array (success-with-empty-list) rather than
 * a failure envelope. Warnings use the structured shape documented in
 * `public/llms.txt`: `{ code, key?, message }`.
 *
 * @returns {Promise<{result: {projects: Array}, warnings?: Array<{code: string, message: string}>}>}
 */
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
            warnings: [{
                code: 'PROJECT_STORAGE_ERROR',
                message: `listProjects storage error: ${err.message || err}`
            }]
        }
    }
    return { result: { projects } }
}

/**
 * Return the flat settings view — theme + export presets read from
 * localStorage. Missing/unparseable keys are silently omitted.
 *
 * @returns {Promise<{result: object}>}
 */
export async function getSettings(_args, app) {
    const snap = buildSnapshot(app)
    return { result: snap.settings }
}

/**
 * Return the current foreground color as a `#rrggbb` string.
 *
 * @returns {Promise<{result: {color: string}}>}
 */
export async function getForegroundColor(_args, app) {
    return { result: { color: app?._foregroundColor || '#000000' } }
}

/**
 * Search the renderer's effect manifest. Supports query (substring), namespace,
 * tags (AND), and limit. Surfaces synth/starter effects (hidden from the human
 * Image menu) — they're valid for addLayer.
 *
 * @param {{query?: string, namespace?: string, tags?: string[], limit?: number}} args
 * @returns {Promise<{result: {effects: Array}}>}
 */
export async function searchEffects(args, app) {
    return { result: effectsModule.searchEffects(app, args || {}) }
}

/**
 * Return the union of namespaces and tags across all manifest effects.
 *
 * @returns {Promise<{result: {namespaces: string[], tags: string[]}}>}
 */
export async function listEffectCategories(_args, app) {
    return { result: effectsModule.listCategories(app) }
}

/**
 * Return the same effect groups the human Image menu shows: tone, color,
 * blur-sharpen, stylize. Useful for agents that want to mirror the curated
 * UX rather than crawl every namespace.
 *
 * @returns {Promise<{result: {groups: Array}}>}
 */
export async function listCuratedEffects(_args, _app) {
    return { result: effectsModule.listCurated() }
}

/**
 * Return a normalized effect descriptor with parameter schema (name, type,
 * default, range, enum values).
 *
 * @param {{effectId: string}} args
 * @returns {Promise<{result: object}>}
 * @throws NOT_FOUND_EFFECT — with `details.didYouMean` listing the 3 closest
 *         known ids by Levenshtein distance.
 */
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

/**
 * Look up a single job by id. Returns the latest serialized state (status,
 * progress, result/error).
 *
 * @param {{jobId: string}} args
 * @returns {Promise<{result: object}>}
 * @throws NOT_FOUND_JOB — when the job id is unknown.
 */
export async function getJob({ jobId }) {
    const j = jobsRegistry.getJob(jobId)
    if (!j) throw commandError('NOT_FOUND_JOB', `Job not found: ${jobId}`, { jobId })
    return { result: j }
}

/**
 * Wait for a job to settle, or timeout.
 *
 * IMPORTANT: when `timeoutMs` is exceeded, the returned envelope is STILL a
 * success envelope (`ok: true`). The job state is returned with
 * `result.timedOut === true` and the job's current (likely still 'running')
 * status. Agents must check `result.timedOut` to distinguish "job not done
 * yet" from "job actually settled".
 *
 * Only NOT_FOUND_JOB produces a failure envelope here. A genuine job failure
 * is reported via `result.status === 'failed'` plus `result.error`, not via
 * the command envelope.
 */
export async function waitForJob({ jobId, timeoutMs }) {
    const existing = jobsRegistry.getJob(jobId)
    if (!existing) throw commandError('NOT_FOUND_JOB', `Job not found: ${jobId}`, { jobId })
    const settled = await jobsRegistry.waitForJob(jobId, timeoutMs || 0)
    return { result: settled }
}

/**
 * Request cancellation of a running job. Cooperative — the job's runFn
 * only notices the abort at its next checkAbort() call, which for some
 * jobs (font install, video export) is only between progress events.
 *
 * @param {{jobId: string}} args
 * @returns {Promise<{result: object}>}
 * @throws NOT_FOUND_JOB — when the job id is unknown.
 */
export async function cancelJob({ jobId }) {
    const existing = jobsRegistry.getJob(jobId)
    if (!existing) throw commandError('NOT_FOUND_JOB', `Job not found: ${jobId}`, { jobId })
    const next = jobsRegistry.cancelJob(jobId)
    return { result: next }
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
 * Resolve a layer from args.layerId, falling back to the currently-selected
 * layer when the caller omits one. Throws NOT_FOUND_LAYER if neither is set
 * or the resolved id doesn't map to a real layer.
 *
 * Use for handlers where layerId is optional and "act on the active layer"
 * is the obvious default. Do NOT use for handlers where an explicit layerId
 * is required (deleteLayer, reorderLayer, etc.) — there the caller must be
 * forced to name the target.
 */
function withSelectedLayer(args, app) {
    const layerId = args?.layerId || app?._layerStack?.selectedLayerId
    if (!layerId) {
        throw commandError('NOT_FOUND_LAYER',
            'No layerId given and no layer is currently selected', {})
    }
    return requireLayer(layerId, app)
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

/**
 * Add a new layer. `kind` selects the path:
 *   - 'effect'  — args: {effectId, params?, name?}
 *   - 'drawing' — args: {name?}
 *   - 'media'   — args: {source: {kind:'base64'|'url', ...}, mediaType, name?}
 *   - 'text'    — args: {text, params?, name?} (sugar over filter/text effect)
 *
 * @param {object} args
 * @returns {Promise<{result: {layerId: string}}>}
 * @throws NOT_FOUND_EFFECT — when effectId isn't in the renderer manifest.
 * @throws INVALID_ARGS_REQUIRED — when required args for the chosen kind are missing.
 * @throws INVALID_ARGS_TYPE — when source.data/source.value has the wrong shape.
 * @throws INVALID_ARGS_ENUM — when source.kind isn't 'base64' or 'url'.
 * @throws RESOURCE_DECODE_FAILED — when fetching a source URL fails or returns non-2xx.
 */
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
    // Reject DSL-corrupting `"""` substrings before we touch any state.
    rejectTripleQuoteInParams(params)
    await app._handleAddEffectLayer(effectId)
    const layer = app._layers[app._layers.length - 1]
    if (name) layer.name = name
    if (params) {
        // Defensive deep copy: the agent may hold a reference to `params` and
        // mutate it after the call returns. Without cloning, those mutations
        // would leak into the layer's effectParams (including any nested
        // objects like color tables or vec arrays).
        const cloned = safeClone(params)
        await app._handleLayerChange({
            layerId: layer.id,
            property: 'effectParams',
            value: { ...layer.effectParams, ...cloned }
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
    // Reject DSL-corrupting `"""` in either the text field itself or in any
    // string-valued param. addEffectLayer will re-check, but reporting `text`
    // as the field here gives a clearer error than `params.text`.
    if (text.includes('"""')) {
        const preview = text.length > 60 ? text.slice(0, 57) + '...' : text
        throw commandError('INVALID_ARGS_TYPE',
            `Param value contains '"""' which would corrupt DSL emission`,
            { field: 'text', got: preview })
    }
    return addEffectLayer({
        effectId: 'filter/text',
        params: { text, ...(params || {}) },
        name
    }, app)
}

/**
 * Delete a layer by id.
 *
 * @param {{layerId: string}} args
 * @returns {Promise<{result: {layerId: string}}>}
 * @throws NOT_FOUND_LAYER — when the layer doesn't exist.
 */
export async function deleteLayer({ layerId }, app) {
    requireLayer(layerId, app)
    await app._handleDeleteLayer(layerId)
    return { result: { layerId } }
}

/**
 * Duplicate a layer; the new layer becomes the active selection. Returns the
 * id of the duplicate.
 *
 * @param {{layerId: string}} args
 * @returns {Promise<{result: {layerId: string}}>}
 * @throws NOT_FOUND_LAYER — when the source layer doesn't exist.
 * @throws CONFLICT_DUPLICATE_FAILED — when the app rejects the duplicate
 *         (e.g. unsupported layer type).
 */
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

/**
 * Move a layer to a new index in the stack. Stack order is bottom-to-top.
 *
 * @param {{layerId: string, toIndex: number}} args
 * @returns {Promise<{result: {layerId: string, toIndex: number}}>}
 * @throws NOT_FOUND_LAYER — when the layer doesn't exist.
 * @throws INVALID_ARGS_RANGE — when toIndex is outside [0, layers.length).
 */
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

/**
 * Make a single layer the active selection.
 *
 * @param {{layerId: string}} args
 * @returns {Promise<{result: {layerId: string}}>}
 * @throws NOT_FOUND_LAYER — when the layer doesn't exist.
 */
export async function selectLayer({ layerId }, app) {
    requireLayer(layerId, app)
    if (app._layerStack) {
        app._layerStack.selectedLayerId = layerId
    }
    return { result: { layerId } }
}

/**
 * Select multiple layers. The first id in the array becomes the active
 * selection (matches the human Shift-click behavior).
 *
 * @param {{layerIds: string[]}} args
 * @returns {Promise<{result: {layerIds: string[]}}>}
 * @throws NOT_FOUND_LAYER — when any layerId doesn't exist.
 */
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

/**
 * Flatten every layer into a single rasterized media layer.
 *
 * @returns {Promise<{result: {ok: true}}>}
 */
export async function flattenImage(_args, app) {
    await app._flattenImage()
    return { result: { ok: true } }
}

/**
 * Flatten the named layers (must be 2 or more) into a single rasterized
 * layer. Layers not in the set are left alone.
 *
 * @param {{layerIds: string[]}} args
 * @returns {Promise<{result: {ok: true}}>}
 * @throws NOT_FOUND_LAYER — when any layerId doesn't exist.
 * @throws INVALID_ARGS_RANGE — when fewer than 2 layerIds supplied.
 */
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

/**
 * Rasterize an effect/drawing layer in place, converting it to a media layer
 * with the current rendered pixels baked in. Effect parameters and drawing
 * strokes are discarded after this call.
 *
 * @param {{layerId: string}} args
 * @returns {Promise<{result: {layerId: string}}>}
 * @throws NOT_FOUND_LAYER — when the layer doesn't exist.
 */
export async function rasterizeLayer({ layerId }, app) {
    requireLayer(layerId, app)
    await app._rasterizeLayer(layerId)
    return { result: { layerId } }
}

/**
 * Flip a media layer horizontally ('h') or vertically ('v'). Limited to
 * media layers — effect/drawing layers throw CONFLICT_TOOL_BLOCKED_FOR_TYPE.
 *
 * @param {{layerId: string, axis: 'h'|'v'}} args
 * @returns {Promise<{result: {layerId: string, axis: string}}>}
 * @throws NOT_FOUND_LAYER — when the layer doesn't exist.
 * @throws CONFLICT_TOOL_BLOCKED_FOR_TYPE — for non-media layers.
 */
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

/**
 * Update one or more layer-level properties. Only keys in
 * `SET_LAYER_PROPS_FIELDS` (name, visible, opacity, blendMode, locked) are
 * honored; unknown keys are silently ignored.
 *
 * @param {{layerId: string, props: object}} args
 * @returns {Promise<{result: {layerId: string}}>}
 * @throws NOT_FOUND_LAYER — when the layer doesn't exist.
 */
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

/**
 * Update a layer's affine transform. Only keys in `TRANSFORM_FIELDS`
 * (offsetX, offsetY, scaleX, scaleY, rotation, flipH, flipV) are honored.
 * Calling with an empty `transform` is a no-op.
 *
 * @param {{layerId: string, transform: object}} args
 * @returns {Promise<{result: {layerId: string}}>}
 * @throws NOT_FOUND_LAYER — when the layer doesn't exist.
 */
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

/**
 * Update the effect parameters on an effect layer. By default merges into
 * the existing params; `replace: true` clears them first. Deep-clones the
 * input so post-call agent mutation can't leak into stored state.
 *
 * @param {{layerId: string, params: object, replace?: boolean}} args
 * @returns {Promise<{result: {layerId: string, params: object}}>}
 * @throws NOT_FOUND_LAYER — when the layer doesn't exist.
 * @throws CONFLICT_NOT_EFFECT_LAYER — when the layer isn't an effect layer.
 */
export async function setLayerEffectParams({ layerId, params, replace }, app) {
    const layer = requireLayer(layerId, app)
    if (layer.sourceType !== 'effect') {
        throw commandError('CONFLICT_NOT_EFFECT_LAYER',
            `Layer ${layerId} is not an effect layer (sourceType=${layer.sourceType})`,
            { layerId, sourceType: layer.sourceType })
    }
    // Reject DSL-corrupting `"""` before touching state.
    rejectTripleQuoteInParams(params)
    // Deep clone agent-provided params so post-call mutation by the agent
    // can't corrupt the layer's stored effectParams (including any nested
    // arrays/objects).
    const cloned = safeClone(params) || {}
    const next = replace ? { ...cloned } : { ...layer.effectParams, ...cloned }
    await app._handleLayerChange({
        layerId,
        property: 'effectParams',
        value: next
    })
    return { result: { layerId, params: next } }
}

/**
 * Add a child effect onto a layer. Child effects stack on top of the parent's
 * own effect/media output. Params are deep-cloned.
 *
 * @param {{layerId: string, effectId: string, params?: object}} args
 * @returns {Promise<{result: {childId: string}}>}
 * @throws NOT_FOUND_LAYER — when the parent doesn't exist.
 * @throws NOT_FOUND_EFFECT — when effectId isn't in the manifest.
 */
export async function addChildEffect({ layerId, effectId, params }, app) {
    const layer = requireLayer(layerId, app)
    const manifest = app?._renderer?.manifest || {}
    if (!manifest[effectId]) {
        throw commandError('NOT_FOUND_EFFECT', `Effect not found: ${effectId}`, { effectId })
    }
    // Reject DSL-corrupting `"""` before touching state.
    rejectTripleQuoteInParams(params)
    await app._handleAddChildEffect(layerId, effectId)
    const newChild = layer.children[layer.children.length - 1]
    if (params) {
        // Deep clone before merging into the child's effectParams so the agent
        // can hold and mutate `params` after the call without corrupting state.
        const cloned = safeClone(params)
        await app._handleLayerChange({
            layerId: newChild.id,
            parentLayerId: layerId,
            property: 'effectParams',
            value: { ...newChild.effectParams, ...cloned }
        })
    }
    return { result: { childId: newChild.id } }
}

/**
 * Remove a child effect from a layer.
 *
 * @param {{layerId: string, childId: string}} args
 * @returns {Promise<{result: {childId: string}}>}
 * @throws NOT_FOUND_LAYER — when the parent or child doesn't exist.
 */
export async function removeChildEffect({ layerId, childId }, app) {
    requireChildEffect(layerId, childId, app)
    await app._handleDeleteLayer(childId, layerId)
    return { result: { childId } }
}

/**
 * Move a child effect to a new index within its parent's children array.
 *
 * @param {{layerId: string, childId: string, toIndex: number}} args
 * @returns {Promise<{result: {layerId: string, childId: string, toIndex: number}}>}
 * @throws NOT_FOUND_LAYER — when the parent or child doesn't exist.
 * @throws INVALID_ARGS_RANGE — when toIndex is outside [0, children.length).
 */
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

/**
 * Update child-effect properties — currently `visible` and `name`. Other
 * keys in `props` are silently ignored.
 *
 * @param {{layerId: string, childId: string, props: object}} args
 * @returns {Promise<{result: {layerId: string, childId: string}}>}
 * @throws NOT_FOUND_LAYER — when the parent or child doesn't exist.
 */
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
        // _handleLayerChange's visibility branch already pushes undo state, but
        // the name path used to skip it — leaving renames non-undoable. Push
        // here so an agent rename can be undone like any other edit.
        app._pushUndoState?.()
    }
    return { result: { layerId, childId } }
}

/**
 * Update child-effect parameters. By default merges into existing params;
 * `replace: true` clears them first. Deep-clones the input.
 *
 * @param {{layerId: string, childId: string, params: object, replace?: boolean}} args
 * @returns {Promise<{result: {layerId: string, childId: string, params: object}}>}
 * @throws NOT_FOUND_LAYER — when the parent or child doesn't exist.
 */
export async function setChildEffectParams({ layerId, childId, params, replace }, app) {
    const { child } = requireChildEffect(layerId, childId, app)
    // Reject DSL-corrupting `"""` before touching state.
    rejectTripleQuoteInParams(params)
    // Deep clone first so any nested objects/arrays in `params` aren't aliased
    // with the agent's input — protects child.effectParams from post-call mutation.
    const cloned = safeClone(params) || {}
    const next = replace ? { ...cloned } : { ...child.effectParams, ...cloned }
    await app._handleLayerChange({
        layerId: childId,
        parentLayerId: layerId,
        property: 'effectParams',
        value: next
    })
    return { result: { layerId, childId, params: next } }
}

const FORMAT_TO_MIME = {
    png: 'image/png',
    jpg: 'image/jpeg',
    webp: 'image/webp'
}

/**
 * Default JPG/WEBP quality used across imagery commands when the caller
 * doesn't pass one. 0.92 mirrors Photoshop's default "Maximum" preset and
 * preserves quality well enough for most agent-driven workflows.
 */
const DEFAULT_IMAGE_QUALITY = 0.92

/**
 * Whether OffscreenCanvas is available in this environment. Modern browsers
 * (Chrome 69+, Firefox 105+, Safari 16.4+) have it; older Safari versions
 * don't, and Node-style runners certainly don't. When absent, fall back to
 * a regular `<canvas>` and `canvas.toBlob`.
 */
const HAS_OFFSCREEN_CANVAS = typeof OffscreenCanvas !== 'undefined'

/**
 * Allocate a drawable surface at width×height, returning `{ surface, ctx }`.
 * Picks OffscreenCanvas when available, falls back to a detached <canvas>
 * so the call sites don't need to branch.
 */
function makeDrawSurface(width, height) {
    if (HAS_OFFSCREEN_CANVAS) {
        const off = new OffscreenCanvas(width, height)
        return { surface: off, ctx: off.getContext('2d') }
    }
    const cv = document.createElement('canvas')
    cv.width = width
    cv.height = height
    return { surface: cv, ctx: cv.getContext('2d') }
}

/**
 * Encode the surface returned by makeDrawSurface as a Blob.
 * OffscreenCanvas exposes `convertToBlob`; HTMLCanvasElement exposes `toBlob`.
 */
async function drawSurfaceToBlob(surface, mimeType, quality) {
    if (typeof surface.convertToBlob === 'function') {
        return surface.convertToBlob({ type: mimeType, quality })
    }
    return new Promise((resolve, reject) => {
        surface.toBlob(b => b ? resolve(b) : reject(new Error('toBlob produced null')),
            mimeType, quality)
    })
}

/**
 * Read a blob as base64 (data-url-strip pattern).
 */
async function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onloadend = () => {
            const result = reader.result
            if (typeof result !== 'string') {
                reject(new Error('FileReader produced non-string result'))
                return
            }
            const comma = result.indexOf(',')
            resolve(comma >= 0 ? result.slice(comma + 1) : result)
        }
        reader.onerror = () => reject(reader.error || new Error('FileReader failed'))
        reader.readAsDataURL(blob)
    })
}

/**
 * Render `canvas` to bytes at the requested format/quality and (optionally) target size.
 * If target size matches canvas size, the canvas is encoded directly.
 * If target size differs, the canvas is drawn into an OffscreenCanvas at the target size
 * before encoding (high-quality 2D resampling — not a re-render of the shader graph).
 */
async function canvasToBytes(canvas, format, quality, targetW, targetH) {
    const mimeType = FORMAT_TO_MIME[format]
    if (!mimeType) {
        // Schema enums in dispatchers should catch a bad `format` long before
        // we get here; an unknown format at this depth means the schema and
        // FORMAT_TO_MIME drifted apart — flag it as an internal-consistency
        // error rather than blaming the caller.
        throw commandError('INTERNAL_ERROR',
            `canvasToBytes received an unknown format: ${format}`,
            { field: 'format', allowed: Object.keys(FORMAT_TO_MIME), got: format })
    }
    const sw = canvas.width
    const sh = canvas.height
    const tw = targetW && targetW > 0 ? targetW : sw
    const th = targetH && targetH > 0 ? targetH : sh

    let blob
    if (tw === sw && th === sh) {
        // drawSurfaceToBlob handles both HTMLCanvasElement (.toBlob) and
        // OffscreenCanvas (.convertToBlob), so getLayerThumbnail can pass us
        // an OffscreenCanvas at native resolution without the call site
        // needing to know which surface kind it allocated.
        blob = await drawSurfaceToBlob(canvas, mimeType, quality)
    } else {
        const { surface, ctx } = makeDrawSurface(tw, th)
        ctx.imageSmoothingEnabled = true
        ctx.imageSmoothingQuality = 'high'
        ctx.drawImage(canvas, 0, 0, sw, sh, 0, 0, tw, th)
        blob = await drawSurfaceToBlob(surface, mimeType, quality)
    }

    const base64 = await blobToBase64(blob)
    return {
        blob,
        base64,
        mimeType,
        width: tw,
        height: th,
        sizeBytes: blob.size,
        format
    }
}

/**
 * Encode the current canvas to base64-encoded image bytes at full resolution.
 * Format defaults to 'png'; quality defaults to 0.92 and is ignored for png.
 * Does not trigger a download — use exportImage for that.
 *
 * @param {{format?: 'png'|'jpg'|'webp', quality?: number}} args
 * @returns {Promise<{result: object}>}
 */
export async function getCanvasImageBytes(args, app) {
    const format = args?.format || 'png'
    const quality = args?.quality ?? DEFAULT_IMAGE_QUALITY
    const out = await canvasToBytes(app._canvas, format, quality)
    return {
        result: {
            bytes: out.base64,
            mimeType: out.mimeType,
            format: out.format,
            width: out.width,
            height: out.height,
            sizeBytes: out.sizeBytes
        }
    }
}

function thumbnailDimensions(srcWidth, srcHeight, maxDimension) {
    const longest = Math.max(srcWidth, srcHeight)
    if (longest <= maxDimension) {
        return { width: srcWidth, height: srcHeight }
    }
    const ratio = maxDimension / longest
    return {
        width: Math.max(1, Math.round(srcWidth * ratio)),
        height: Math.max(1, Math.round(srcHeight * ratio))
    }
}

/**
 * Encode a downscaled snapshot of the canvas. The longest side is clamped
 * to `maxDimension` (default 256). Format defaults to 'jpg'.
 *
 * @param {{maxDimension?: number, format?: 'png'|'jpg'|'webp', quality?: number}} args
 * @returns {Promise<{result: object}>}
 */
export async function getThumbnail(args, app) {
    const maxDim = args?.maxDimension ?? 256
    const format = args?.format || 'jpg'
    const quality = args?.quality ?? DEFAULT_IMAGE_QUALITY
    const { width: tw, height: th } = thumbnailDimensions(
        app._canvas.width, app._canvas.height, maxDim)
    const out = await canvasToBytes(app._canvas, format, quality, tw, th)
    return {
        result: {
            bytes: out.base64,
            mimeType: out.mimeType,
            format: out.format,
            width: out.width,
            height: out.height,
            sizeBytes: out.sizeBytes
        }
    }
}

/**
 * Encode a thumbnail of a single layer (and its children/mask), as if only
 * that layer were rendered. Useful for layer-panel previews.
 *
 * @param {{layerId: string, maxDimension?: number, format?: 'png'|'jpg'|'webp', quality?: number}} args
 * @returns {Promise<{result: object}>}
 * @throws NOT_FOUND_LAYER — when the layer doesn't exist.
 * @throws RENDER_LAYER_COMPOSITE_FAILED — when the renderer can't isolate the layer.
 */
export async function getLayerThumbnail({ layerId, maxDimension, format, quality }, app) {
    requireLayer(layerId, app)
    const maxDim = maxDimension ?? 256
    const fmt = format || 'jpg'
    const q = quality ?? DEFAULT_IMAGE_QUALITY

    // _renderLayerComposite returns an HTMLImageElement of the canvas after
    // rendering only the named layer (and its children/mask).
    const sourceImg = await app._renderLayerComposite([layerId])
    if (!sourceImg) {
        throw commandError('RENDER_LAYER_COMPOSITE_FAILED',
            `Could not render layer ${layerId}`,
            { layerId })
    }

    const sw = sourceImg.naturalWidth || sourceImg.width
    const sh = sourceImg.naturalHeight || sourceImg.height
    const { width: tw, height: th } = thumbnailDimensions(sw, sh, maxDim)

    // canvasToBytes operates on a drawable surface, so paint the source
    // image into a native-size canvas first, then let canvasToBytes handle
    // the resampling + encode. Same path used by getCanvasImageBytes /
    // getThumbnail / exportImage.
    const { surface: imgCanvas, ctx: imgCtx } = makeDrawSurface(sw, sh)
    imgCtx.drawImage(sourceImg, 0, 0)
    const out = await canvasToBytes(imgCanvas, fmt, q, tw, th)
    return {
        result: {
            bytes: out.base64,
            mimeType: out.mimeType,
            format: out.format,
            width: out.width,
            height: out.height,
            sizeBytes: out.sizeBytes,
            layerId
        }
    }
}

// Recent-exports ring, capture-blob-URL map, makeExportId, recordExport,
// and timestampedFilename all live in exports-state.js — split out so
// snapshot.js no longer has to reach back into commands.js for the snapshot
// getter (true circular import dropped).

function triggerBrowserDownload(blob, filename) {
    const url = URL.createObjectURL(blob)
    try {
        const a = document.createElement('a')
        a.href = url
        a.download = filename
        document.body.appendChild(a)
        a.click()
        document.body.removeChild(a)
        // Defer revoke so the click has time to consume the URL.
        setTimeout(() => URL.revokeObjectURL(url), 4000)
    } catch (err) {
        URL.revokeObjectURL(url)
        throw err
    }
}

/**
 * Encode the canvas AND trigger a browser download (default) or skip it.
 * Records a recentExports entry the snapshot exposes so agents can list past
 * exports.
 *
 * `captureOnly: true` is a stronger form of `triggerDownload: false`: it
 * disables the browser download (same effect) and exists so MCP-side callers
 * can read the bytes without intercepting Playwright download events. The
 * returned result already includes `bytes` (base64), so captureOnly is mostly
 * symmetry with exportVideo — same flag name on both commands.
 *
 * @param {object} args - {format?, quality?, width?, height?, triggerDownload?,
 *                         captureOnly?, filename?}
 * @returns {Promise<{result: object}>}
 */
export async function exportImage(args, app) {
    const format = args?.format || 'png'
    const quality = args?.quality ?? DEFAULT_IMAGE_QUALITY
    const width = args?.width
    const height = args?.height
    const captureOnly = !!args?.captureOnly
    // captureOnly forces no-download; otherwise triggerDownload defaults true.
    const triggerDownload = !captureOnly && (args?.triggerDownload !== false)
    const filename = timestampedFilename(args?.filename, format)

    const out = await canvasToBytes(app._canvas, format, quality, width, height)

    if (triggerDownload) {
        triggerBrowserDownload(out.blob, filename)
    }

    const entry = {
        id: makeExportId(),
        path: null,                 // populated by the MCP sidecar in Phase 7
        filename,
        mimeType: out.mimeType,
        sizeBytes: out.sizeBytes,
        createdAt: new Date().toISOString(),
        kind: 'image',
        // `format` mirrors the exportVideo entry — redundant with mimeType
        // but easier for agents to switch on ('png' | 'jpg' | 'webp').
        format: out.format
    }
    recordExport(entry)

    return {
        result: {
            bytes: out.base64,
            mimeType: out.mimeType,
            format: out.format,
            width: out.width,
            height: out.height,
            sizeBytes: out.sizeBytes,
            filename,
            exportId: entry.id
        }
    }
}

/**
 * Add a media layer from inline bytes — sugar over addLayer(kind:'media',
 * mediaType:'image'). Source is `{kind:'base64', data, mimeType?}` or
 * `{kind:'url', value}`.
 *
 * @param {{source: object, name?: string}} args
 * @returns {Promise<{result: {layerId: string}}>}
 * @throws INVALID_ARGS_REQUIRED|INVALID_ARGS_TYPE|INVALID_ARGS_ENUM|RESOURCE_DECODE_FAILED
 *         (forwarded from addMediaLayer)
 */
export async function pasteImageFromBytes({ source, name }, app) {
    return addMediaLayer({ source, mediaType: 'image', name: name || 'pasted' }, app)
}

/**
 * Throw CONFLICT_NO_SELECTION if there's no active selection.
 */
function requireSelection(app) {
    const sm = app?._selectionManager
    if (!sm || !sm.hasSelection?.()) {
        throw commandError('CONFLICT_NO_SELECTION',
            'No active selection. Set one first with selectAll or setRectangleSelection.',
            {})
    }
    return sm
}

/**
 * Set a rectangle selection covering the entire canvas.
 *
 * @returns {Promise<{result: {ok: true}}>}
 * @throws INTERNAL_ERROR — when the selection manager isn't initialized.
 */
export async function selectAll(_args, app) {
    const sm = app?._selectionManager
    if (!sm) {
        throw commandError('INTERNAL_ERROR',
            'Selection manager not available', {})
    }
    sm.setSelection({
        type: 'rect',
        x: 0, y: 0,
        width: app._canvas.width,
        height: app._canvas.height
    })
    return { result: { ok: true } }
}

/**
 * Clear any active selection.
 *
 * @returns {Promise<{result: {ok: true}}>}
 * @throws INTERNAL_ERROR — when the selection manager isn't initialized.
 */
export async function selectNone(_args, app) {
    const sm = app?._selectionManager
    if (!sm) {
        throw commandError('INTERNAL_ERROR',
            'Selection manager not available', {})
    }
    sm.clearSelection()
    return { result: { ok: true } }
}

/**
 * Invert the current selection so the previously-selected pixels become
 * unselected and vice versa. Requires an existing selection.
 *
 * @returns {Promise<{result: {ok: true}}>}
 * @throws CONFLICT_NO_SELECTION — when there's no active selection.
 * @throws INTERNAL_ERROR — when the current selection can't be rasterized.
 */
export async function selectInverse(_args, app) {
    const sm = requireSelection(app)
    const mask = sm.rasterizeSelection()
    if (!mask) {
        throw commandError('INTERNAL_ERROR',
            'Could not rasterize current selection',
            {})
    }
    sm.setSelection({ type: 'mask', data: selectionMods.invertMask(mask) })
    return { result: { ok: true } }
}

/**
 * Set a rectangular selection from top-left corner + size.
 *
 * @param {{x: number, y: number, width: number, height: number}} args
 * @returns {Promise<{result: {ok: true}}>}
 * @throws INTERNAL_ERROR — when the selection manager isn't initialized.
 */
export async function setRectangleSelection({ x, y, width, height }, app) {
    const sm = app?._selectionManager
    if (!sm) {
        throw commandError('INTERNAL_ERROR',
            'Selection manager not available', {})
    }
    sm.setSelection({ type: 'rect', x, y, width, height })
    return { result: { ok: true } }
}

/**
 * Set an oval selection inscribed in the bounding rect [x, y, width, height].
 * Internally stored as center+radii.
 *
 * @param {{x: number, y: number, width: number, height: number}} args
 * @returns {Promise<{result: {ok: true}}>}
 * @throws INTERNAL_ERROR — when the selection manager isn't initialized.
 */
export async function setOvalSelection({ x, y, width, height }, app) {
    const sm = app?._selectionManager
    if (!sm) {
        throw commandError('INTERNAL_ERROR',
            'Selection manager not available', {})
    }
    // SelectionManager's oval path uses center-radii form.
    sm.setSelection({
        type: 'oval',
        cx: x + width / 2,
        cy: y + height / 2,
        rx: width / 2,
        ry: height / 2
    })
    return { result: { ok: true } }
}

/**
 * Set a polygon or lasso selection from a points list. `kind` is 'polygon'
 * (closed straight-edge) or 'lasso' (closed free-form, same data shape).
 * Points may be `[x, y]` tuples (normalized to `{x, y}` internally).
 *
 * @param {{kind: 'polygon'|'lasso', points: Array<[number, number]|{x:number,y:number}>}} args
 * @returns {Promise<{result: {ok: true}}>}
 * @throws INTERNAL_ERROR — when the selection manager isn't initialized.
 * @throws INVALID_ARGS_RANGE — when fewer than 3 points supplied.
 * @throws INVALID_ARGS_TYPE — when any point isn't [number, number].
 */
export async function setPolygonSelection({ kind, points }, app) {
    const sm = app?._selectionManager
    if (!sm) {
        throw commandError('INTERNAL_ERROR',
            'Selection manager not available', {})
    }
    if (!Array.isArray(points) || points.length < 3) {
        throw commandError('INVALID_ARGS_RANGE',
            `polygon/lasso selection requires at least 3 points, got ${points?.length ?? 0}`,
            { field: 'points', min: 3, value: points?.length ?? 0 })
    }
    const sanitized = []
    for (let i = 0; i < points.length; i++) {
        const p = points[i]
        if (!Array.isArray(p) || p.length < 2 ||
            typeof p[0] !== 'number' || typeof p[1] !== 'number') {
            throw commandError('INVALID_ARGS_TYPE',
                `points[${i}] must be a [number, number] tuple`,
                { field: `points[${i}]`, expected: '[number, number]' })
        }
        sanitized.push({ x: p[0], y: p[1] })
    }
    sm.setSelection({ type: kind || 'polygon', points: sanitized })
    return { result: { ok: true } }
}

/**
 * Set a magic-wand selection: contiguous flood-fill from the click point at
 * the given color tolerance (default 32, range 0-255).
 *
 * @param {{x: number, y: number, tolerance?: number}} args
 * @returns {Promise<{result: {ok: true}}>}
 * @throws INTERNAL_ERROR — when the selection manager isn't initialized.
 * @throws INVALID_ARGS_RANGE — when (x, y) is outside the canvas.
 */
export async function setMagicWandSelection({ x, y, tolerance }, app) {
    const sm = app?._selectionManager
    if (!sm) {
        throw commandError('INTERNAL_ERROR',
            'Selection manager not available', {})
    }
    const canvas = app._canvas
    if (x >= canvas.width || y >= canvas.height) {
        throw commandError('INVALID_ARGS_RANGE',
            `Point (${x}, ${y}) is outside canvas (${canvas.width}x${canvas.height})`,
            { field: 'x|y', max: { x: canvas.width - 1, y: canvas.height - 1 } })
    }
    // Read current canvas pixels into an offscreen 2D context for flood fill.
    const tmp = document.createElement('canvas')
    tmp.width = canvas.width
    tmp.height = canvas.height
    tmp.getContext('2d').drawImage(canvas, 0, 0)
    const imageData = tmp.getContext('2d').getImageData(0, 0, canvas.width, canvas.height)
    const tol = tolerance ?? sm.wandTolerance ?? 32
    const mask = floodFill(imageData, x, y, tol)
    sm.setSelection({ type: 'wand', mask })
    return { result: { ok: true } }
}

/**
 * Set a non-contiguous color-range selection — every pixel whose color
 * matches the sample at (x, y) within `tolerance`.
 *
 * @param {{x: number, y: number, tolerance?: number}} args
 * @returns {Promise<{result: {ok: true}}>}
 * @throws INTERNAL_ERROR — when the selection manager isn't initialized.
 * @throws INVALID_ARGS_RANGE — when (x, y) is outside the canvas.
 */
export async function selectColorRange({ x, y, tolerance }, app) {
    const sm = app?._selectionManager
    if (!sm) {
        throw commandError('INTERNAL_ERROR',
            'Selection manager not available', {})
    }
    const canvas = app._canvas
    if (x >= canvas.width || y >= canvas.height) {
        throw commandError('INVALID_ARGS_RANGE',
            `Point (${x}, ${y}) is outside canvas (${canvas.width}x${canvas.height})`,
            { field: 'x|y', max: { x: canvas.width - 1, y: canvas.height - 1 } })
    }
    const tmp = document.createElement('canvas')
    tmp.width = canvas.width
    tmp.height = canvas.height
    tmp.getContext('2d').drawImage(canvas, 0, 0)
    const imageData = tmp.getContext('2d').getImageData(0, 0, canvas.width, canvas.height)
    const tol = tolerance ?? 32
    const mask = selectionMods.colorRange(imageData, x, y, tol)
    sm.setSelection({ type: 'mask', data: mask })
    return { result: { ok: true } }
}

function applySelectionMaskTransform(app, fn) {
    const sm = requireSelection(app)
    const mask = sm.rasterizeSelection()
    if (!mask) {
        throw commandError('INTERNAL_ERROR',
            'Could not rasterize current selection',
            {})
    }
    sm.setSelection({ type: 'mask', data: fn(mask) })
}

/**
 * Grow the current selection by `pixels` (Euclidean distance from the boundary).
 *
 * @param {{pixels: number}} args
 * @returns {Promise<{result: {ok: true, pixels: number}}>}
 * @throws CONFLICT_NO_SELECTION — when there's no active selection.
 */
export async function expandSelection({ pixels }, app) {
    applySelectionMaskTransform(app, (mask) => selectionMods.expandMask(mask, pixels))
    return { result: { ok: true, pixels } }
}

/**
 * Shrink the current selection by `pixels` (Euclidean distance from the boundary, inward).
 *
 * @param {{pixels: number}} args
 * @returns {Promise<{result: {ok: true, pixels: number}}>}
 * @throws CONFLICT_NO_SELECTION — when there's no active selection.
 */
export async function contractSelection({ pixels }, app) {
    applySelectionMaskTransform(app, (mask) => selectionMods.contractMask(mask, pixels))
    return { result: { ok: true, pixels } }
}

/**
 * Feather the current selection — ramp alpha from 255 inside to 0 outside
 * over `pixels` of the boundary.
 *
 * @param {{pixels: number}} args
 * @returns {Promise<{result: {ok: true, pixels: number}}>}
 * @throws CONFLICT_NO_SELECTION — when there's no active selection.
 */
export async function featherSelection({ pixels }, app) {
    applySelectionMaskTransform(app, (mask) => selectionMods.featherMask(mask, pixels))
    return { result: { ok: true, pixels } }
}

/**
 * Smooth selection edges via 3-pass box blur followed by re-threshold.
 *
 * @param {{pixels: number}} args
 * @returns {Promise<{result: {ok: true, pixels: number}}>}
 * @throws CONFLICT_NO_SELECTION — when there's no active selection.
 */
export async function smoothSelection({ pixels }, app) {
    applySelectionMaskTransform(app, (mask) => selectionMods.smoothMask(mask, pixels))
    return { result: { ok: true, pixels } }
}

/**
 * Replace the current selection with a `pixels`-wide border just inside its
 * boundary.
 *
 * @param {{pixels: number}} args
 * @returns {Promise<{result: {ok: true, pixels: number}}>}
 * @throws CONFLICT_NO_SELECTION — when there's no active selection.
 */
export async function borderSelection({ pixels }, app) {
    applySelectionMaskTransform(app, (mask) => selectionMods.borderMask(mask, pixels))
    return { result: { ok: true, pixels } }
}

/**
 * Crop the entire image to the current selection's bounding box. All layers
 * are clipped and the canvas is resized.
 *
 * @returns {Promise<{result: {ok: true}}>}
 * @throws CONFLICT_NO_SELECTION — when there's no active selection.
 */
export async function cropToSelection(_args, app) {
    requireSelection(app)
    await app._cropToSelection()
    return { result: { ok: true } }
}

/**
 * Look up a layer that already has a mask; throw CONFLICT_NO_MASK if missing.
 */
function requireMaskedLayer(layerId, app) {
    const layer = requireLayer(layerId, app)
    if (!layer.mask) {
        throw commandError('CONFLICT_NO_MASK',
            `Layer ${layerId} has no mask. Call addLayerMask or addMaskFromSelection first.`,
            { layerId })
    }
    return layer
}

/**
 * Look up a layer that DOES NOT have a mask; throw CONFLICT_LAYER_HAS_MASK
 * if one is already attached. Mirror image of `requireMaskedLayer`.
 */
function requireUnmaskedLayer(layerId, app) {
    const layer = requireLayer(layerId, app)
    if (layer.mask) {
        throw commandError('CONFLICT_LAYER_HAS_MASK',
            `Layer ${layerId} already has a mask. Call deleteLayerMask first.`,
            { layerId })
    }
    return layer
}

/**
 * Attach an all-white (fully revealing) mask to a layer.
 *
 * @param {{layerId: string}} args
 * @returns {Promise<{result: {layerId: string}}>}
 * @throws NOT_FOUND_LAYER — when the layer doesn't exist.
 * @throws CONFLICT_LAYER_HAS_MASK — when the layer already has a mask.
 */
export async function addLayerMask({ layerId }, app) {
    const layer = requireUnmaskedLayer(layerId, app)
    // Replicate the core of app._addLayerMask but skip _enterMaskEditMode.
    app._finalizePendingUndo?.()
    const w = app._canvas.width
    const h = app._canvas.height
    const mask = new ImageData(w, h)
    for (let i = 0; i < mask.data.length; i += 4) {
        mask.data[i] = 255
        mask.data[i + 1] = 255
        mask.data[i + 2] = 255
        mask.data[i + 3] = 255
    }
    layer.mask = mask
    layer.maskEnabled = true
    app._renderer?.uploadMaskTexture?.(layerId, mask)
    app._updateLayerStack?.()
    await app._rebuild?.()
    app._markDirty?.()
    app._pushUndoState?.()
    return { result: { layerId } }
}

/**
 * Remove a layer's mask. Layer pixels themselves are unchanged.
 *
 * @param {{layerId: string}} args
 * @returns {Promise<{result: {layerId: string}}>}
 * @throws NOT_FOUND_LAYER — when the layer doesn't exist.
 * @throws CONFLICT_NO_MASK — when the layer has no mask.
 */
export async function deleteLayerMask({ layerId }, app) {
    requireMaskedLayer(layerId, app)
    // `_deleteLayerMask` is the same code-path the human menu uses, so it
    // fires a user-facing "Layer mask deleted" toast. Agents have no
    // foreground UI to acknowledge — suppress while the call runs.
    await toast.suppress(() => app._deleteLayerMask(layerId))
    return { result: { layerId } }
}

/**
 * Attach a mask to a layer using the current selection as its initial values.
 *
 * @param {{layerId: string}} args
 * @returns {Promise<{result: {layerId: string}}>}
 * @throws NOT_FOUND_LAYER — when the layer doesn't exist.
 * @throws CONFLICT_LAYER_HAS_MASK — when the layer already has a mask.
 * @throws CONFLICT_NO_SELECTION — when there's no active selection.
 */
export async function addMaskFromSelection({ layerId }, app) {
    requireUnmaskedLayer(layerId, app)
    requireSelection(app)   // throws CONFLICT_NO_SELECTION if missing
    // Suppress the "Mask created from selection" toast that the human-UI
    // path fires — agents drive this programmatically.
    await toast.suppress(() => app._maskFromSelection(layerId))
    return { result: { layerId } }
}

/**
 * Invert a layer's mask values.
 *
 * @param {{layerId: string}} args
 * @returns {Promise<{result: {layerId: string}}>}
 * @throws NOT_FOUND_LAYER — when the layer doesn't exist.
 * @throws CONFLICT_NO_MASK — when the layer has no mask.
 */
export async function invertLayerMask({ layerId }, app) {
    requireMaskedLayer(layerId, app)
    // Suppress the "Mask inverted" toast that the human-UI path fires.
    await toast.suppress(() => app._invertLayerMask(layerId))
    return { result: { layerId } }
}

/**
 * Toggle whether a layer's mask is active. Disabled masks remain attached
 * but stop affecting the composite.
 *
 * @param {{layerId: string, enabled: boolean}} args
 * @returns {Promise<{result: {layerId: string, enabled: boolean}}>}
 * @throws NOT_FOUND_LAYER — when the layer doesn't exist.
 * @throws CONFLICT_NO_MASK — when the layer has no mask.
 */
export async function setMaskEnabled({ layerId, enabled }, app) {
    const layer = requireMaskedLayer(layerId, app)
    if (layer.maskEnabled === enabled) {
        // No-op: already in requested state.
        return { result: { layerId, enabled } }
    }
    app._finalizePendingUndo?.()
    layer.maskEnabled = enabled
    app._updateLayerStack?.()
    await app._rebuild?.()
    app._markDirty?.()
    app._pushUndoState?.()
    return { result: { layerId, enabled } }
}

/**
 * Apply a selection-modify transform to a layer's mask.
 *
 * Mask storage uses RGB=val/A=255; selection-modify ops expect A=val.
 * The transform helper converts in/out via app._maskToSelectionFormat
 * and app._selectionFormatToMask.
 */
async function applyMaskTransform(app, layerId, fn) {
    const layer = requireMaskedLayer(layerId, app)
    app._finalizePendingUndo?.()
    const converted = app._maskToSelectionFormat(layer.mask)
    layer.mask = app._selectionFormatToMask(fn(converted))
    app._renderer?.uploadMaskTexture?.(layerId, layer.mask)
    if (app._maskEditMode) app._renderMaskOverlay?.(layer)
    await app._rebuild?.()
    app._markDirty?.()
    app._pushUndoState?.()
}

/**
 * Feather a layer mask's edges by `radius` pixels.
 *
 * @param {{layerId: string, radius: number}} args
 * @returns {Promise<{result: {layerId: string, radius: number}}>}
 * @throws NOT_FOUND_LAYER — when the layer doesn't exist.
 * @throws CONFLICT_NO_MASK — when the layer has no mask.
 */
export async function featherMask({ layerId, radius }, app) {
    await applyMaskTransform(app, layerId, (mask) => selectionMods.featherMask(mask, radius))
    return { result: { layerId, radius } }
}

/**
 * Grow a layer mask by `radius` pixels.
 *
 * @param {{layerId: string, radius: number}} args
 * @returns {Promise<{result: {layerId: string, radius: number}}>}
 * @throws NOT_FOUND_LAYER — when the layer doesn't exist.
 * @throws CONFLICT_NO_MASK — when the layer has no mask.
 */
export async function expandMask({ layerId, radius }, app) {
    await applyMaskTransform(app, layerId, (mask) => selectionMods.expandMask(mask, radius))
    return { result: { layerId, radius } }
}

/**
 * Shrink a layer mask by `radius` pixels.
 *
 * @param {{layerId: string, radius: number}} args
 * @returns {Promise<{result: {layerId: string, radius: number}}>}
 * @throws NOT_FOUND_LAYER — when the layer doesn't exist.
 * @throws CONFLICT_NO_MASK — when the layer has no mask.
 */
export async function contractMask({ layerId, radius }, app) {
    await applyMaskTransform(app, layerId, (mask) => selectionMods.contractMask(mask, radius))
    return { result: { layerId, radius } }
}

/**
 * Smooth a layer mask's edges by `radius` pixels (3-pass box blur).
 *
 * @param {{layerId: string, radius: number}} args
 * @returns {Promise<{result: {layerId: string, radius: number}}>}
 * @throws NOT_FOUND_LAYER — when the layer doesn't exist.
 * @throws CONFLICT_NO_MASK — when the layer has no mask.
 */
export async function smoothMask({ layerId, radius }, app) {
    await applyMaskTransform(app, layerId, (mask) => selectionMods.smoothMask(mask, radius))
    return { result: { layerId, radius } }
}

/**
 * Look up a layer that is a drawing layer. Throws CONFLICT_NOT_DRAWING_LAYER
 * if the layer exists but isn't of sourceType 'drawing'.
 */
function requireDrawingLayer(layerId, app) {
    const layer = requireLayer(layerId, app)
    if (layer.sourceType !== 'drawing') {
        throw commandError('CONFLICT_NOT_DRAWING_LAYER',
            `Layer ${layerId} is not a drawing layer (sourceType=${layer.sourceType})`,
            { layerId, sourceType: layer.sourceType })
    }
    return layer
}

/**
 * Normalize an array of points; accept either [x,y] tuples or {x,y} objects.
 * Throws INVALID_ARGS_RANGE if fewer than minCount points; INVALID_ARGS_TYPE on malformed.
 */
function normalizePoints(points, fieldName, minCount = 2) {
    if (!Array.isArray(points) || points.length < minCount) {
        throw commandError('INVALID_ARGS_RANGE',
            `${fieldName} requires at least ${minCount} points, got ${points?.length ?? 0}`,
            { field: fieldName, min: minCount, value: points?.length ?? 0 })
    }
    const out = []
    for (let i = 0; i < points.length; i++) {
        const p = points[i]
        if (Array.isArray(p) && p.length >= 2 &&
            typeof p[0] === 'number' && typeof p[1] === 'number') {
            out.push({ x: p[0], y: p[1] })
        } else if (p && typeof p.x === 'number' && typeof p.y === 'number') {
            out.push({ x: p.x, y: p.y })
        } else {
            throw commandError('INVALID_ARGS_TYPE',
                `${fieldName}[${i}] must be [number, number] or {x, y}`,
                { field: `${fieldName}[${i}]`, expected: '[number, number] | {x, y}' })
        }
    }
    return out
}

/**
 * Paint a brush or eraser stroke through a list of points onto a drawing
 * layer. If `layerId` is omitted, the active drawing layer is used or a new
 * one is created via `_ensureDrawingLayer`. When `mode` is `'eraser'`, the
 * stroke renders with `destination-out` compositing, erasing previously-
 * painted pixels on the layer instead of laying down color.
 *
 * @param {{layerId?: string, points: Array, size: number, opacity?: number, color: string, mode?: 'brush'|'eraser'}} args
 * @returns {Promise<{result: {layerId: string, strokeId: string}}>}
 * @throws NOT_FOUND_LAYER — when layerId is given but doesn't exist.
 * @throws CONFLICT_NOT_DRAWING_LAYER — when layerId names a non-drawing layer.
 * @throws INVALID_ARGS_RANGE|INVALID_ARGS_TYPE — when points is malformed.
 */
export async function paintStroke({ layerId, points, size, opacity, color, mode }, app) {
    const sanitized = normalizePoints(points, 'points', 2)
    let layer
    if (layerId) {
        layer = requireDrawingLayer(layerId, app)
    } else {
        layer = app._ensureDrawingLayer()
    }
    app._finalizePendingUndo?.()
    const stroke = createPathStroke({
        color,
        size,
        opacity: opacity ?? 1,
        points: sanitized,
        mode: mode ?? 'brush'
    })
    layer.strokes.push(stroke)
    await app._rasterizeDrawingLayer(layer)
    await app._rebuild?.({ force: true })
    app._markDirty?.()
    app._pushUndoState?.()
    return { result: { layerId: layer.id, strokeId: stroke.id } }
}

/**
 * Remove a single stroke from a drawing layer's `strokes` array. Mirrors
 * the human Eraser tool's per-stroke delete, but addressed by id so agents
 * don't need pixel-space hit testing.
 *
 * @param {{layerId: string, strokeId: string}} args
 * @returns {Promise<{result: {layerId: string, strokeId: string}}>}
 * @throws NOT_FOUND_LAYER — when the layer doesn't exist.
 * @throws CONFLICT_NOT_DRAWING_LAYER — when the layer isn't a drawing layer.
 * @throws NOT_FOUND_STROKE — when the strokeId isn't present on the layer.
 */
export async function eraseStroke({ layerId, strokeId }, app) {
    const layer = requireDrawingLayer(layerId, app)
    const idx = (layer.strokes || []).findIndex(s => s.id === strokeId)
    if (idx === -1) {
        throw commandError('NOT_FOUND_STROKE',
            `Stroke not found: ${strokeId}`,
            { layerId, strokeId })
    }
    app._finalizePendingUndo?.()
    layer.strokes.splice(idx, 1)
    await app._rasterizeDrawingLayer(layer)
    await app._rebuild?.({ force: true })
    app._markDirty?.()
    app._pushUndoState?.()
    return { result: { layerId, strokeId } }
}

/**
 * Remove every stroke from a drawing layer, leaving the layer in place but
 * empty. Returns the count of strokes that were removed.
 *
 * @param {{layerId: string}} args
 * @returns {Promise<{result: {layerId: string, clearedCount: number}}>}
 * @throws NOT_FOUND_LAYER — when the layer doesn't exist.
 * @throws CONFLICT_NOT_DRAWING_LAYER — when the layer isn't a drawing layer.
 */
export async function clearDrawingLayer({ layerId }, app) {
    const layer = requireDrawingLayer(layerId, app)
    const clearedCount = (layer.strokes || []).length
    app._finalizePendingUndo?.()
    layer.strokes = []
    await app._rasterizeDrawingLayer(layer)
    await app._rebuild?.({ force: true })
    app._markDirty?.()
    app._pushUndoState?.()
    return { result: { layerId, clearedCount } }
}

/**
 * Draw a shape (rect/ellipse, filled or stroked) onto a drawing layer.
 * Same layer fallback as paintStroke.
 *
 * @param {object} args - {layerId?, shape, x, y, width, height, color, size, opacity?, filled?}
 * @returns {Promise<{result: {layerId: string, strokeId: string}}>}
 * @throws NOT_FOUND_LAYER — when layerId is given but doesn't exist.
 * @throws CONFLICT_NOT_DRAWING_LAYER — when layerId names a non-drawing layer.
 */
export async function drawShape({ layerId, shape, x, y, width, height, color, size, opacity, filled }, app) {
    let layer
    if (layerId) {
        layer = requireDrawingLayer(layerId, app)
    } else {
        layer = app._ensureDrawingLayer()
    }
    app._finalizePendingUndo?.()
    const stroke = createShapeStroke({
        type: shape,
        color,
        size,
        opacity: opacity ?? 1,
        x, y, width, height,
        filled: !!filled
    })
    layer.strokes.push(stroke)
    await app._rasterizeDrawingLayer(layer)
    await app._rebuild?.({ force: true })
    app._markDirty?.()
    app._pushUndoState?.()
    return { result: { layerId: layer.id, strokeId: stroke.id } }
}

/**
 * Add a new media layer filled with `color`, masked to the contiguous region
 * matching the pixel at (x, y) within `tolerance`. Mirrors the human Fill tool.
 *
 * @param {{x: number, y: number, color: string, tolerance?: number}} args
 * @returns {Promise<{result: {layerId: string}}>}
 * @throws INVALID_ARGS_RANGE — when (x, y) is outside the canvas.
 * @throws INTERNAL_ERROR — when the WebGL context can't be acquired.
 */
export async function fillRegion({ x, y, color, tolerance }, app) {
    const canvas = app._canvas
    if (x >= canvas.width || y >= canvas.height) {
        throw commandError('INVALID_ARGS_RANGE',
            `Point (${x}, ${y}) is outside canvas (${canvas.width}x${canvas.height})`,
            { field: 'x|y', max: { x: canvas.width - 1, y: canvas.height - 1 } })
    }
    const tol = tolerance ?? 32

    // Read composited pixels from the render canvas (mirrors FillTool._onClick).
    const w = canvas.width, h = canvas.height
    let pixels
    try {
        pixels = readRenderPixels(canvas, 0, 0, w, h)
    } catch {
        throw commandError('INTERNAL_ERROR', 'Could not read canvas pixels for fill', {})
    }

    // readPixels order is bottom-up; flip vertically for image-space coords.
    const flipped = new Uint8ClampedArray(w * h * 4)
    for (let row = 0; row < h; row++) {
        const srcRow = (h - 1 - row) * w * 4
        const dstRow = row * w * 4
        flipped.set(pixels.subarray(srcRow, srcRow + w * 4), dstRow)
    }
    const imageData = new ImageData(flipped, w, h)

    // Flood fill at the click point. `floodFill` is already imported at the top
    // of commands.js (added in Phase 4-selections T4 for setMagicWandSelection).
    const mask = floodFill(imageData, x, y, tol)

    // Build a fill canvas masked by the flood-fill mask.
    const fillCanvas = document.createElement('canvas')
    fillCanvas.width = w
    fillCanvas.height = h
    const ctx = fillCanvas.getContext('2d')
    ctx.fillStyle = color
    ctx.fillRect(0, 0, w, h)
    const fillData = ctx.getImageData(0, 0, w, h)
    for (let i = 0; i < mask.data.length; i += 4) {
        if (mask.data[i + 3] === 0) {
            fillData.data[i + 3] = 0
        }
    }
    ctx.putImageData(fillData, 0, 0)

    app._finalizePendingUndo?.()
    await app._addMediaLayerFromCanvas(fillCanvas, 'Fill')
    app._markDirty?.()
    app._pushUndoState?.()
    const newLayer = app._layers[app._layers.length - 1]
    return { result: { layerId: newLayer.id } }
}

/**
 * Reset state and start a new project at the given canvas size. Discards
 * unsaved changes silently (agents must save first if they care).
 *
 * @param {{width: number, height: number, name?: string}} args
 * @returns {Promise<{result: {width: number, height: number}}>}
 */
export async function newProject({ width, height, name }, app) {
    app._finalizePendingUndo?.()
    app._selectionManager?.clearSelection?.()
    app._resetLayers()
    app._renderer?.stop?.()
    app._resizeCanvas(width, height)
    await app._rebuild?.()
    await new Promise(resolve => requestAnimationFrame(resolve))
    app._renderer?.start?.()
    app._currentProjectId = null
    app._currentProjectName = name || null
    app._markClean?.()
    app._updateLayerStack?.()
    app._pushUndoState?.()
    return { result: { width, height } }
}

/**
 * Load a previously-saved project by id.
 *
 * @param {{projectId: string}} args
 * @returns {Promise<{result: {projectId: string}}>}
 * @throws NOT_FOUND_PROJECT — when no project has that id.
 */
export async function openProject({ projectId }, app) {
    const stored = await getProjectStorage(projectId).catch(() => null)
    if (!stored) {
        throw commandError('NOT_FOUND_PROJECT',
            `Project not found: ${projectId}`,
            { projectId })
    }
    await app._loadProject(projectId)
    return { result: { projectId } }
}

/**
 * Save the current project. If a project is already open, updates it in
 * place; otherwise creates a new one named `name`. `name` is only required
 * when there is no current project.
 *
 * @param {{name?: string}} args
 * @returns {Promise<{result: {projectId: string}}>}
 * @throws INVALID_ARGS_REQUIRED — when `name` is omitted and there's no current project.
 */
export async function saveProject({ name }, app) {
    // The schema enforces `name: { type: 'string', minLength: 1 }` (when
    // supplied), so a missing/empty/non-string `name` is rejected by the
    // dispatcher before we get here. The only remaining business rule is
    // "you can't save-in-place when there's no current project".
    const haveCurrent = !!app._currentProjectId && !!app._currentProjectName
    const useName = name || app._currentProjectName
    if (!haveCurrent && !useName) {
        throw commandError('INVALID_ARGS_REQUIRED',
            'name is required when there is no current project to update',
            { field: 'name' })
    }
    await app._saveProject(app._currentProjectId, useName)
    return { result: { projectId: app._currentProjectId } }
}

/**
 * Save the current state as a new project, regardless of whether one is open.
 * `name` is required.
 *
 * @param {{name: string}} args
 * @returns {Promise<{result: {projectId: string}}>}
 * @throws INVALID_ARGS_REQUIRED — when `name` is empty or missing.
 */
export async function saveProjectAs({ name }, app) {
    // The schema marks `name` required with minLength:1 — the dispatcher
    // rejects empty/missing/non-string values before reaching this handler.
    await app._saveProject(null, name)
    return { result: { projectId: app._currentProjectId } }
}

/**
 * Delete a stored project. If the deleted project is the one currently
 * open, the open-project handle is cleared but the in-memory state stays.
 *
 * @param {{projectId: string}} args
 * @returns {Promise<{result: {projectId: string}}>}
 * @throws NOT_FOUND_PROJECT — when no project has that id.
 */
export async function deleteProject({ projectId }, app) {
    const existing = await getProjectStorage(projectId).catch(() => null)
    if (!existing) {
        throw commandError('NOT_FOUND_PROJECT',
            `Project not found: ${projectId}`,
            { projectId })
    }
    await deleteProjectStorage(projectId)
    if (app._currentProjectId === projectId) {
        app._currentProjectId = null
    }
    return { result: { projectId } }
}

/**
 * Undo the most recent state change in the undo stack. No-op when canUndo is false.
 *
 * @returns {Promise<{result: {ok: true}}>}
 */
export async function undo(_args, app) {
    await app._undo()
    return { result: { ok: true } }
}

/**
 * Redo the most recently undone change. No-op when canRedo is false.
 *
 * @returns {Promise<{result: {ok: true}}>}
 */
export async function redo(_args, app) {
    await app._redo()
    return { result: { ok: true } }
}

const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/

/**
 * Set the foreground color. Color must be `#rrggbb` (6-digit hex).
 *
 * @param {{color: string}} args
 * @returns {Promise<{result: {color: string}}>}
 * @throws INVALID_ARGS_TYPE — when color isn't a valid #rrggbb string.
 */
export async function setForegroundColor({ color }, app) {
    if (!HEX_COLOR_RE.test(color)) {
        throw commandError('INVALID_ARGS_TYPE',
            `color must be a 6-digit hex string like '#aabbcc', got '${color}'`,
            { field: 'color', expected: '#rrggbb' })
    }
    app._setForegroundColor(color)
    return { result: { color } }
}

/**
 * Set the zoom mode — 'fit' to fit canvas to viewport, '100' for 1:1, etc.
 *
 * @param {{mode: string}} args
 * @returns {Promise<{result: {mode: string}}>}
 */
export async function setZoom({ mode }, app) {
    app._setZoom(mode)
    return { result: { mode } }
}

/**
 * Start the renderer's animation loop (for time-varying effects).
 *
 * @returns {Promise<{result: {isPlaying: true}}>}
 */
export async function play(_args, app) {
    app._renderer?.start?.()
    return { result: { isPlaying: true } }
}

/**
 * Stop the renderer's animation loop. The current frame stays visible.
 *
 * @returns {Promise<{result: {isPlaying: false}}>}
 */
export async function pause(_args, app) {
    app._renderer?.stop?.()
    return { result: { isPlaying: false } }
}

const KNOWN_SETTINGS = ['theme']

/**
 * Update app settings. Only `theme` is currently honored; unknown keys are
 * reported via the envelope's `warnings` array. Persistence failures are
 * also surfaced as warnings (not failures), preserving the "best effort"
 * semantics of the human Settings dialog.
 *
 * Theme application delegates to settings-dialog's `setTheme`, which both
 * persists to localStorage and wires the `prefers-color-scheme` listener
 * when `theme === 'system'`. This is the same code path the human dialog
 * uses, so an agent setting `theme: 'system'` gets the same live OS-preference
 * tracking the dialog does.
 *
 * Warnings are emitted as structured objects:
 *   { code: 'UNKNOWN_SETTING_KEY' | 'THEME_PERSIST_FAILED', key?, message }
 * (See `public/llms.txt` for the contract.)
 *
 * @param {{theme?: string}} args
 * @returns {Promise<{result: {applied: string[]}, warnings?: Array<{code: string, key?: string, message: string}>}>}
 */
export async function setSettings(args = {}, _app) {
    const warnings = []
    // `applied` is populated as we actually process each known key — driven by
    // the work we did, not by a static KNOWN_SETTINGS.filter against the args
    // (which would incorrectly count keys we'd intended to handle but didn't,
    // e.g. a future key that's listed in KNOWN_SETTINGS but whose setter
    // branch wasn't taken because the value's type was wrong).
    const applied = []
    if (typeof args.theme === 'string') {
        try {
            setTheme(args.theme)
            applied.push('theme')
        } catch (err) {
            warnings.push({
                code: 'THEME_PERSIST_FAILED',
                key: 'theme',
                message: `failed to persist theme: ${err.message || err}`
            })
        }
    }
    // Warn on any input key we didn't end up applying — both genuinely unknown
    // keys and known keys whose setter rejected (e.g. theme persist failure
    // already raised THEME_PERSIST_FAILED above; suppress the duplicate
    // UNKNOWN_SETTING_KEY warning for those).
    const warnedKeys = new Set(warnings.map(w => w.key).filter(Boolean))
    for (const key of Object.keys(args)) {
        if (applied.includes(key)) continue
        if (warnedKeys.has(key)) continue
        warnings.push({
            code: 'UNKNOWN_SETTING_KEY',
            key,
            message: `unknown setting key: ${key} (ignored)`
        })
    }
    return { result: { applied }, warnings }
}

/**
 * Resample the entire image to a new width and height. Layers are
 * stretched/squashed proportionally; selection is cleared.
 *
 * NOTE: if width/height match the current canvas size, this is a no-op —
 * `app._resizeImage` early-returns without pushing undo state or rebuilding.
 * The envelope still succeeds (callers shouldn't rely on a "did anything
 * change?" signal beyond inspecting `state.canvas` themselves).
 *
 * @param {{width: number, height: number}} args
 * @returns {Promise<{result: {width: number, height: number}}>}
 */
export async function resizeImage({ width, height }, app) {
    await app._resizeImage(width, height)
    return { result: { width, height } }
}

/**
 * Change the canvas size without resampling layers — they keep their
 * pixel dimensions and shift relative to the new canvas. `anchor` (default
 * 'center') controls how layers are positioned within the new canvas.
 *
 * NOTE: if width/height match the current canvas size, this is a no-op —
 * `app._changeCanvasSize` early-returns without pushing undo state or
 * rebuilding. The envelope still succeeds.
 *
 * @param {{width: number, height: number, anchor?: string}} args
 * @returns {Promise<{result: {width: number, height: number, anchor: string}}>}
 */
export async function resizeCanvas({ width, height, anchor }, app) {
    await app._changeCanvasSize(width, height, anchor || 'center')
    return { result: { width, height, anchor: anchor || 'center' } }
}

/**
 * Build the standard envelope for auto-correction commands: report whether
 * an adjustment layer was actually added (`applied`) and, if so, which
 * layer the agent should look at (`layerId`). Returning `applied:false`
 * lets agents distinguish "no work needed" from a successful adjustment.
 */
function autoCorrectionResult(addedLayer) {
    return {
        result: {
            applied: !!addedLayer,
            layerId: addedLayer?.id || null
        }
    }
}

/**
 * Auto-levels: add an adjustment layer that stretches per-channel histograms
 * to full range. Returns `applied: false` when no adjustment was needed.
 *
 * @returns {Promise<{result: {applied: boolean, layerId: string|null}}>}
 */
export async function autoLevels(_args, app) {
    const layer = await app._handleAutoCorrection(autoLevelsFn)
    return autoCorrectionResult(layer)
}

/**
 * Auto-contrast: stretch luminance to full range. Returns `applied: false`
 * when no adjustment was needed.
 *
 * @returns {Promise<{result: {applied: boolean, layerId: string|null}}>}
 */
export async function autoContrast(_args, app) {
    const layer = await app._handleAutoCorrection(autoContrastFn)
    return autoCorrectionResult(layer)
}

/**
 * Auto-white-balance: shift colors so the brightest region is neutral white.
 * Returns `applied: false` when no adjustment was needed.
 *
 * @returns {Promise<{result: {applied: boolean, layerId: string|null}}>}
 */
export async function autoWhiteBalance(_args, app) {
    const layer = await app._handleAutoCorrection(autoWhiteBalanceFn)
    return autoCorrectionResult(layer)
}

/**
 * Report the installed fontaine bundle state.
 *
 * The catalog's font records expose `id`, `name`, `category`, and `tags`
 * (no `family` or top-level `style` — `style` is a per-file/variant attribute).
 * We map `name` → `family` to give agents the conventional CSS-style key.
 *
 * Note: the returned descriptor is `{id, family, category}` only — no
 * `style` field. The fontaine catalog doesn't carry per-variant style
 * metadata today (italic, weight, etc. live on individual font files, not
 * on the family record). If per-variant style becomes available upstream,
 * surface it here.
 */
export async function listInstalledFonts(_args, _app) {
    const loader = getFontaineLoader()
    const installed = await loader.isInstalled()
    if (!installed) {
        return { result: { installed: false, version: null, count: 0, fonts: [] } }
    }
    if (!loader.fontsLoaded) {
        await loader.loadFromCache()
    }
    const raw = (loader.catalog?.fonts) || []
    // The fontaine catalog records expose `name` as the family — there is no
    // `f.family` field. Don't synthesize a fallback that would never trigger.
    const fonts = raw.map(f => ({
        id: f.id || f.name,
        family: f.name,
        category: f.category || null
    }))
    return {
        result: {
            installed: true,
            version: loader.installedVersion || null,
            count: fonts.length,
            fonts
        }
    }
}

/**
 * Install the fontaine font bundle (~140 MB) as a background job.
 *
 * Returns immediately with a jobId; agents can poll via getJob/waitForJob.
 * The loader emits coarse-grained progress (percent + message) — we translate
 * percent ranges into named phases (manifest/downloading/extracting/finalizing).
 *
 * Cancellation: the job's AbortSignal is passed to loader.install, which
 * threads it into every fetch call and re-checks between download chunks
 * and between per-font ZIP extractions. A cancel mid-flight unwinds within
 * one chunk (or one font during extraction), no longer needing the next
 * onProgress callback to take effect.
 *
 * @throws CONFLICT_JOB_IN_PROGRESS — when an install is already running.
 *         `details.jobId` is the existing run; the caller should poll it via
 *         getJob/waitForJob rather than retrying.
 */
export async function installFontBundle(_args, _app) {
    const loader = getFontaineLoader()
    // Reject duplicate runs: only one install-font-bundle job can be active.
    // The loader writes to a singleton cache, so two concurrent installs would
    // race over manifest/extraction. Existence of an unsettled job from a prior
    // call means we should send the caller back to poll the original jobId.
    const existing = jobsRegistry.listJobs().find(j =>
        j.kind === JOB_KINDS.INSTALL_FONT_BUNDLE &&
        j.status !== 'succeeded' &&
        j.status !== 'failed' &&
        j.status !== 'cancelled'
    )
    if (existing) {
        throw commandError('CONFLICT_JOB_IN_PROGRESS',
            'A font bundle install is already running.',
            { jobId: existing.id })
    }
    let jobId
    try {
        const { id } = jobsRegistry.createJob(JOB_KINDS.INSTALL_FONT_BUNDLE, async (api) => {
            api.reportProgress('starting', 0, 100)
            let lastPercent = 0
            await loader.install({
                signal: api.abortSignal,
                onProgress: (percent, message) => {
                    lastPercent = Math.round(percent)
                    let phase = 'downloading'
                    if (lastPercent < 10) phase = 'manifest'
                    else if (lastPercent < 70) phase = 'downloading'
                    else if (lastPercent < 95) phase = 'extracting'
                    else phase = 'finalizing'
                    api.reportProgress(phase, lastPercent, 100, message || null)
                    api.checkAbort()
                }
            })
            api.reportProgress('done', 100, 100)
            const fonts = (loader.catalog?.fonts) || []
            return { count: fonts.length, version: loader.installedVersion || null }
        })
        jobId = id
    } catch (err) {
        if (err?.code === 'JOB_LIMIT_EXCEEDED') {
            throw commandError('JOB_LIMIT_EXCEEDED',
                err.message,
                err.details || {})
        }
        throw err
    }
    return { result: { jobId } }
}

/**
 * Export the rendered canvas to a video file (MP4 via WebCodecs or a ZIP of
 * PNG frames) as a background job.
 *
 * Returns immediately with a jobId; agents can poll via getJob/waitForJob.
 * The runner drives the frame loop, encoder lifecycle, and resolution restore;
 * we translate frame progress into job progress and record a recentExports
 * entry on success (mirrors exportImage).
 *
 * When captureOnly:true, the job's result includes `blobUrl` (an object URL)
 * but not `blob` (Blob handles can't cross the envelope's JSON boundary).
 * The caller can fetch the URL synchronously and then call
 * `releaseExport({exportId})` to free the memory; otherwise the Blob
 * stays alive until the document unloads. Holds for both MP4 and ZIP —
 * the dispatcher strips the live Blob handle either way so the envelope
 * stays JSON-clean.
 */
export async function exportVideo(args, app) {
    const w = args?.width ?? app._canvas.width
    const h = args?.height ?? app._canvas.height
    const captureOnly = !!args?.captureOnly
    // Pre-compute the export filename so we can pass it into files.js when
    // captureOnly is set — keeps the MCP sidecar's filename in sync with the
    // recentExports entry below.
    const filename = timestampedFilename(args?.filename, args?.format || 'mp4')
    const settings = {
        width: Math.max(2, Math.floor(w / 2) * 2),
        height: Math.max(2, Math.floor(h / 2) * 2),
        framerate: args?.framerate ?? 30,
        duration: args?.duration ?? 15,
        loopCount: args?.loopCount ?? 1,
        format: args?.format || 'mp4',
        quality: args?.quality || 'very high',
        playFrom: args?.playFrom || 'beginning',
        captureOnly,
        captureFilename: captureOnly ? filename : null
    }

    const totalFrames = Math.ceil(settings.framerate * settings.duration * settings.loopCount)
    if (totalFrames > MAX_EXPORT_FRAMES) {
        throw commandError('INVALID_ARGS_RANGE',
            `Total frames ${totalFrames} exceeds maximum ${MAX_EXPORT_FRAMES} ` +
            `(framerate × duration × loopCount). Reduce duration, framerate, or loopCount.`,
            {
                field: 'duration|framerate|loopCount',
                totalFrames,
                max: MAX_EXPORT_FRAMES
            })
    }

    let jobId
    try {
        const { id } = jobsRegistry.createJob(JOB_KINDS.EXPORT_VIDEO, async (api) => {
            const result = await runVideoExport({
                settings,
                canvas: app._canvas,
                renderer: app._renderer,
                files: app._files,
                getResolution: () => ({ width: app._canvas.width, height: app._canvas.height }),
                setResolution: (w, h) => app._resizeCanvas(w, h),
                abortSignal: api.abortSignal,
                onProgress: (current, total, phase) => api.reportProgress(phase, current, total)
            })

            // Recorded only on success — cancelled jobs leave partial bytes
            // in the user's browser-download dir but no recentExports entry.
            // (runVideoExport throws on abort, so we never reach this point.)
            const exportId = makeExportId()
            recordExport({
                id: exportId,
                path: null,                  // sidecar fills this in Phase 7
                filename,
                mimeType: settings.format === 'mp4' ? 'video/mp4' : 'application/zip',
                sizeBytes: null,             // unknown — encoder writes directly to download
                createdAt: new Date().toISOString(),
                kind: 'video',
                format: settings.format
            })
            // captureOnly produces a browser blob URL we have to revoke later
            // or the underlying Blob leaks until the page unloads. Register it
            // in the exports-state map so releaseExport({exportId}) can free it.
            if (settings.captureOnly && result.blobUrl) {
                rememberCaptureBlobUrl(exportId, result.blobUrl)
            }

            // Drop the live Blob handle before serializing — it's not
            // structured-clonable through the dispatcher envelope. blobUrl
            // is a string and travels cleanly. (Blob is kept off the
            // returned object explicitly even though structured-clone can
            // handle it in some contexts — keeping the envelope JSON-clean.)
            const { blob: _blob, ...serializable } = result
            return { ...serializable, filename, exportId }
        })
        jobId = id
    } catch (err) {
        if (err?.code === 'JOB_LIMIT_EXCEEDED') {
            throw commandError('JOB_LIMIT_EXCEEDED',
                err.message,
                err.details || {})
        }
        throw err
    }
    return { result: { jobId } }
}

/**
 * Free the browser blob URL allocated by a captureOnly export. Without this,
 * the underlying Blob stays alive until the document unloads — agents that
 * stream many captureOnly exports through fetch() will accumulate megabytes
 * of unreleased buffers.
 *
 * Calling releaseExport on an export id that has no tracked URL (because the
 * export wasn't captureOnly, or because it was already released) throws
 * NOT_FOUND_EXPORT so accidental double-releases are loud rather than silent.
 *
 * @param {{exportId: string}} args
 * @returns {Promise<{result: {released: true, exportId: string}}>}
 * @throws NOT_FOUND_EXPORT — when no captureOnly URL is tracked under exportId.
 */
export async function releaseExport({ exportId }, _app) {
    const url = consumeCaptureBlobUrl(exportId)
    if (!url) {
        throw commandError('NOT_FOUND_EXPORT',
            `No captureOnly export blob tracked for exportId: ${exportId}`,
            { exportId })
    }
    URL.revokeObjectURL(url)
    return { result: { released: true, exportId } }
}
