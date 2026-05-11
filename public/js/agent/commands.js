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
import {
    listProjects as listProjectsStorage,
    saveProject as saveProjectStorage,
    loadProject as loadProjectStorage,
    deleteProject as deleteProjectStorage,
    getProject as getProjectStorage
} from '../utils/project-storage.js'
import * as effectsModule from './effects.js'
import { createDrawingLayer } from '../layers/layer-model.js'
// TODO: When a 3rd or 4th name collision shows up (likely Phase 5+), refactor to
// `import * as selectionMods from '../selection/selection-modify.js'` and call
// `selectionMods.featherMask(...)` at the call sites — eliminates the alias dance
// and makes provenance explicit.
import {
    invertMask, colorRange,
    expandMask as expandMask_fn,
    contractMask as contractMask_fn,
    featherMask as featherMask_fn,
    smoothMask as smoothMask_fn,
    borderMask
} from '../selection/selection-modify.js'
import { floodFill } from '../selection/flood-fill.js'
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

const FORMAT_TO_MIME = {
    png: 'image/png',
    jpg: 'image/jpeg',
    webp: 'image/webp'
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
        throw commandError('INVALID_ARGS_ENUM',
            `Unsupported format: ${format}`,
            { field: 'format', allowed: Object.keys(FORMAT_TO_MIME), got: format })
    }
    const sw = canvas.width
    const sh = canvas.height
    const tw = targetW && targetW > 0 ? targetW : sw
    const th = targetH && targetH > 0 ? targetH : sh

    let blob
    if (tw === sw && th === sh) {
        blob = await new Promise((resolve, reject) => {
            canvas.toBlob(b => b ? resolve(b) : reject(new Error('toBlob produced null')),
                mimeType, quality)
        })
    } else {
        const off = new OffscreenCanvas(tw, th)
        const ctx = off.getContext('2d')
        ctx.imageSmoothingEnabled = true
        ctx.imageSmoothingQuality = 'high'
        ctx.drawImage(canvas, 0, 0, sw, sh, 0, 0, tw, th)
        blob = await off.convertToBlob({ type: mimeType, quality })
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

export async function getCanvasImageBytes(args, app) {
    const format = args?.format || 'png'
    const quality = args?.quality
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

export async function getThumbnail(args, app) {
    const maxDim = args?.maxDimension ?? 256
    const format = args?.format || 'jpg'
    const quality = args?.quality ?? 0.85
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

export async function getLayerThumbnail({ layerId, maxDimension, format, quality }, app) {
    requireLayer(layerId, app)
    const maxDim = maxDimension ?? 256
    const fmt = format || 'jpg'
    const q = quality ?? 0.85

    // _renderLayerComposite returns an HTMLImageElement of the canvas after
    // rendering only the named layer (and its children/mask). Draw it into
    // an offscreen canvas at the target thumbnail size.
    const sourceImg = await app._renderLayerComposite([layerId])
    if (!sourceImg) {
        throw commandError('RENDER_LAYER_COMPOSITE_FAILED',
            `Could not render layer ${layerId}`,
            { layerId })
    }

    const sw = sourceImg.naturalWidth || sourceImg.width
    const sh = sourceImg.naturalHeight || sourceImg.height
    const { width: tw, height: th } = thumbnailDimensions(sw, sh, maxDim)

    const off = new OffscreenCanvas(tw, th)
    const ctx = off.getContext('2d')
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(sourceImg, 0, 0, sw, sh, 0, 0, tw, th)

    const mimeType = FORMAT_TO_MIME[fmt]
    const blob = await off.convertToBlob({ type: mimeType, quality: q })
    const base64 = await blobToBase64(blob)
    return {
        result: {
            bytes: base64,
            mimeType,
            format: fmt,
            width: tw,
            height: th,
            sizeBytes: blob.size,
            layerId
        }
    }
}

const RECENT_EXPORTS_CAP = 50
const _recentExports = []

/**
 * Snapshot exposes recentExports through this getter — module-scoped buffer
 * keeps history without polluting the LayersApp state.
 */
export function getRecentExports() {
    return _recentExports.slice()
}

function recordExport(entry) {
    _recentExports.push(entry)
    while (_recentExports.length > RECENT_EXPORTS_CAP) _recentExports.shift()
}

function makeExportId() {
    return `export-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
}

function timestampedFilename(baseName, ext) {
    if (baseName) return `${baseName}.${ext}`
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    return `layers-${ts}.${ext}`
}

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

export async function exportImage(args, app) {
    const format = args?.format || 'png'
    const quality = args?.quality
    const width = args?.width
    const height = args?.height
    const triggerDownload = args?.triggerDownload !== false   // defaults true
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
        kind: 'image'
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

export async function selectNone(_args, app) {
    const sm = app?._selectionManager
    if (!sm) {
        throw commandError('INTERNAL_ERROR',
            'Selection manager not available', {})
    }
    sm.clearSelection()
    return { result: { ok: true } }
}

export async function selectInverse(_args, app) {
    const sm = requireSelection(app)
    const mask = sm.rasterizeSelection()
    if (!mask) {
        throw commandError('INTERNAL_ERROR',
            'Could not rasterize current selection',
            {})
    }
    sm.setSelection({ type: 'mask', data: invertMask(mask) })
    return { result: { ok: true } }
}

export async function setRectangleSelection({ x, y, width, height }, app) {
    const sm = app?._selectionManager
    if (!sm) {
        throw commandError('INTERNAL_ERROR',
            'Selection manager not available', {})
    }
    sm.setSelection({ type: 'rect', x, y, width, height })
    return { result: { ok: true } }
}

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
    const mask = colorRange(imageData, x, y, tol)
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

export async function expandSelection({ pixels }, app) {
    applySelectionMaskTransform(app, (mask) => expandMask_fn(mask, pixels))
    return { result: { ok: true, pixels } }
}

export async function contractSelection({ pixels }, app) {
    applySelectionMaskTransform(app, (mask) => contractMask_fn(mask, pixels))
    return { result: { ok: true, pixels } }
}

export async function featherSelection({ pixels }, app) {
    applySelectionMaskTransform(app, (mask) => featherMask_fn(mask, pixels))
    return { result: { ok: true, pixels } }
}

export async function smoothSelection({ pixels }, app) {
    applySelectionMaskTransform(app, (mask) => smoothMask_fn(mask, pixels))
    return { result: { ok: true, pixels } }
}

export async function borderSelection({ pixels }, app) {
    applySelectionMaskTransform(app, (mask) => borderMask(mask, pixels))
    return { result: { ok: true, pixels } }
}

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

export async function addLayerMask({ layerId }, app) {
    const layer = requireLayer(layerId, app)
    if (layer.mask) {
        throw commandError('CONFLICT_LAYER_HAS_MASK',
            `Layer ${layerId} already has a mask. Call deleteLayerMask first.`,
            { layerId })
    }
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

export async function deleteLayerMask({ layerId }, app) {
    requireMaskedLayer(layerId, app)
    await app._deleteLayerMask(layerId)
    return { result: { layerId } }
}

export async function addMaskFromSelection({ layerId }, app) {
    const layer = requireLayer(layerId, app)
    if (layer.mask) {
        throw commandError('CONFLICT_LAYER_HAS_MASK',
            `Layer ${layerId} already has a mask. Call deleteLayerMask first.`,
            { layerId })
    }
    requireSelection(app)   // throws CONFLICT_NO_SELECTION if missing
    await app._maskFromSelection(layerId)
    return { result: { layerId } }
}

export async function invertLayerMask({ layerId }, app) {
    requireMaskedLayer(layerId, app)
    await app._invertLayerMask(layerId)
    return { result: { layerId } }
}

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

export async function featherMask({ layerId, radius }, app) {
    await applyMaskTransform(app, layerId, (mask) => featherMask_fn(mask, radius))
    return { result: { layerId, radius } }
}

export async function expandMask({ layerId, radius }, app) {
    await applyMaskTransform(app, layerId, (mask) => expandMask_fn(mask, radius))
    return { result: { layerId, radius } }
}

export async function contractMask({ layerId, radius }, app) {
    await applyMaskTransform(app, layerId, (mask) => contractMask_fn(mask, radius))
    return { result: { layerId, radius } }
}

export async function smoothMask({ layerId, radius }, app) {
    await applyMaskTransform(app, layerId, (mask) => smoothMask_fn(mask, radius))
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

export async function paintStroke({ layerId, points, size, opacity, color }, app) {
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
        points: sanitized
    })
    layer.strokes.push(stroke)
    await app._rasterizeDrawingLayer(layer)
    await app._rebuild?.({ force: true })
    app._markDirty?.()
    app._pushUndoState?.()
    return { result: { layerId: layer.id, strokeId: stroke.id } }
}

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

export async function fillRegion({ x, y, color, tolerance }, app) {
    const canvas = app._canvas
    if (x >= canvas.width || y >= canvas.height) {
        throw commandError('INVALID_ARGS_RANGE',
            `Point (${x}, ${y}) is outside canvas (${canvas.width}x${canvas.height})`,
            { field: 'x|y', max: { x: canvas.width - 1, y: canvas.height - 1 } })
    }
    const tol = tolerance ?? 32

    // Read composited pixels from the WebGL canvas (mirrors FillTool._onClick).
    const gl = canvas.getContext('webgl') || canvas.getContext('webgl2')
    if (!gl) {
        throw commandError('INTERNAL_ERROR',
            'Could not get WebGL context for fill', {})
    }
    const w = canvas.width, h = canvas.height
    const pixels = new Uint8Array(w * h * 4)
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, pixels)

    // WebGL readPixels is bottom-up; flip vertically for image-space coords.
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

export async function saveProject({ name }, app) {
    if (name !== undefined) {
        if (typeof name !== 'string' || name.length === 0) {
            throw commandError('INVALID_ARGS_REQUIRED',
                'name must be a non-empty string when supplied',
                { field: 'name' })
        }
    }
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

export async function saveProjectAs({ name }, app) {
    if (typeof name !== 'string' || name.length === 0) {
        throw commandError('INVALID_ARGS_REQUIRED',
            'name must be a non-empty string',
            { field: 'name' })
    }
    await app._saveProject(null, name)
    return { result: { projectId: app._currentProjectId } }
}

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

export async function undo(_args, app) {
    await app._undo()
    return { result: { ok: true } }
}

export async function redo(_args, app) {
    await app._redo()
    return { result: { ok: true } }
}

const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/

export async function setForegroundColor({ color }, app) {
    if (!HEX_COLOR_RE.test(color)) {
        throw commandError('INVALID_ARGS_TYPE',
            `color must be a 6-digit hex string like '#aabbcc', got '${color}'`,
            { field: 'color', expected: '#rrggbb' })
    }
    app._setForegroundColor(color)
    return { result: { color } }
}

export async function setZoom({ mode }, app) {
    app._setZoom(mode)
    return { result: { mode } }
}

export async function play(_args, app) {
    app._renderer?.start?.()
    return { result: { isPlaying: true } }
}

export async function pause(_args, app) {
    app._renderer?.stop?.()
    return { result: { isPlaying: false } }
}

const KNOWN_SETTINGS = ['theme']

/**
 * Apply a theme name to the document. Mirrors settings-dialog's private
 * applyTheme — kept inline because that function isn't exported.
 */
function applyThemeInline(themeValue) {
    const resolved = themeValue === 'system'
        ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'neutral-dark' : 'neutral-light')
        : themeValue
    document.documentElement.dataset.theme = resolved
}

export async function setSettings(args = {}, _app) {
    const warnings = []
    if (typeof args.theme === 'string') {
        try {
            localStorage.setItem('layers-theme', args.theme)
            applyThemeInline(args.theme)
        } catch (err) {
            warnings.push(`failed to persist theme: ${err.message || err}`)
        }
    }
    for (const key of Object.keys(args)) {
        if (!KNOWN_SETTINGS.includes(key)) {
            warnings.push(`unknown setting key: ${key} (ignored)`)
        }
    }
    return { result: { applied: KNOWN_SETTINGS.filter(k => k in args) }, warnings }
}

export async function resizeImage({ width, height }, app) {
    await app._resizeImage(width, height)
    return { result: { width, height } }
}

export async function resizeCanvas({ width, height, anchor }, app) {
    await app._changeCanvasSize(width, height, anchor || 'center')
    return { result: { width, height, anchor: anchor || 'center' } }
}

export async function autoLevels(_args, app) {
    await app._handleAutoCorrection(autoLevelsFn)
    return { result: { ok: true } }
}

export async function autoContrast(_args, app) {
    await app._handleAutoCorrection(autoContrastFn)
    return { result: { ok: true } }
}

export async function autoWhiteBalance(_args, app) {
    await app._handleAutoCorrection(autoWhiteBalanceFn)
    return { result: { ok: true } }
}

/**
 * Report the installed fontaine bundle state.
 *
 * The catalog's font records expose `id`, `name`, `category`, and `tags`
 * (no `family` or top-level `style` — `style` is a per-file/variant attribute).
 * We map `name` → `family` to give agents the conventional CSS-style key.
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
 * Cancellation note: loader.install does not accept an AbortSignal; cancel
 * only takes effect at the next onProgress callback (so big uninterruptible
 * sections — fetch body read, ZIP extraction of a single font — must finish
 * before checkAbort fires).
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
 * Phase 6 caveat: the runner always triggers a browser download via files.js.
 * A future `captureOnly` path (return blob without download) is out of scope
 * for now — it requires worker-protocol changes and MediaBunny output redirection.
 */
export async function exportVideo(args, app) {
    const w = args?.width ?? app._canvas.width
    const h = args?.height ?? app._canvas.height
    const settings = {
        width: Math.max(2, Math.floor(w / 2) * 2),
        height: Math.max(2, Math.floor(h / 2) * 2),
        framerate: args?.framerate ?? 30,
        duration: args?.duration ?? 15,
        loopCount: args?.loopCount ?? 1,
        format: args?.format || 'mp4',
        quality: args?.quality || 'very high',
        playFrom: args?.playFrom || 'beginning'
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

            const filename = timestampedFilename(args?.filename, settings.format)
            recordExport({
                id: makeExportId(),
                path: null,                  // sidecar fills this in Phase 7
                filename,
                mimeType: settings.format === 'mp4' ? 'video/mp4' : 'application/zip',
                sizeBytes: null,             // unknown — encoder writes directly to download
                createdAt: new Date().toISOString(),
                kind: 'video',
                format: settings.format
            })

            return { ...result, filename }
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
