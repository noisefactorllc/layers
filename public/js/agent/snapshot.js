/**
 * Build a JSON-serializable snapshot of the LayersApp state.
 *
 * The same shape is returned by getState() and embedded in every command
 * envelope. No pixel data, no File blobs — only structural information.
 *
 * @module agent/snapshot
 */

import { API_VERSION, SCHEMA_VERSION, safeClone } from './constants.js'
import { getRecentExports } from './exports-state.js'
import { listJobs } from './jobs.js'

// Layer/selection mask mutations replace their ImageData. Reuse the summary
// while that object is unchanged; large masks need not be scanned for every
// command envelope. Return a copy so callers cannot alter cached bounds.
const maskSummaries = new WeakMap()

export function buildSnapshot(app) {
    const override = app?._projectSnapshotCanvasOverride
    const part = (key, build) => override && Object.hasOwn(override, key)
        ? safeClone(override[key])
        : build(app)
    return {
        apiVersion: API_VERSION,
        schemaVersion: SCHEMA_VERSION,
        project: part('project', buildProject),
        canvas: part('canvas', buildCanvas),
        view: part('view', buildView),
        foreground: buildForeground(app),
        selection: part('selection', buildSelection),
        layers: part('layers', buildLayers),
        selectedLayerIds: override && Object.hasOwn(override, 'selectedLayerIds')
            ? override.selectedLayerIds.slice()
            : app?._layerStack?.selectedLayerIds?.slice() || [],
        activeLayerId: override && Object.hasOwn(override, 'activeLayerId')
            ? override.activeLayerId
            : app?._layerStack?.selectedLayerId || null,
        // Each job entry carries two timestamps:
        //   - job.updatedAt       — last state change (progress OR settle)
        //   - job.progress.updatedAt — last progress-event time only (null
        //     until the runner makes its first reportProgress call)
        // We sort by job.updatedAt so a long-running job whose runFn is
        // still ticking progress can't drop out of view after many shorter
        // jobs settle.
        jobs: listJobs()
            .sort((a, b) => b.updatedAt - a.updatedAt)
            .slice(0, 20),
        recentExports: getRecentExports(),
        settings: buildSettings(app),
        collaboration: buildCollaboration(app)
    }
}

export function captureProjectSnapshotOverride(app, { canvasOnly = false } = {}) {
    const current = app?._projectSnapshotCanvasOverride
    const capture = (key, build) => current && Object.hasOwn(current, key)
        ? safeClone(current[key])
        : build(app)
    const captured = {
        canvas: capture('canvas', buildCanvas),
        view: capture('view', buildView),
    }
    if (canvasOnly) return captured
    captured.project = capture('project', buildProject)
    captured.selection = capture('selection', buildSelection)
    captured.layers = capture('layers', buildLayers)
    captured.selectedLayerIds = current
        && Object.hasOwn(current, 'selectedLayerIds')
        ? current.selectedLayerIds.slice()
        : app?._layerStack?.selectedLayerIds?.slice() || []
    captured.activeLayerId = current && Object.hasOwn(current, 'activeLayerId')
        ? current.activeLayerId
        : app?._layerStack?.selectedLayerId || null
    return captured
}

function buildProject(app) {
    const undoMgr = app?._undoManager
    return {
        id: app?._currentProjectId || null,
        name: app?._currentProjectName || null,
        isDirty: !!app?._isDirty,
        canUndo: undoMgr ? undoMgr.canUndo() : false,
        canRedo: undoMgr ? undoMgr.canRedo() : false,
        canSaveAs: true
    }
}

function buildCanvas(app) {
    const c = app?._canvas
    return {
        width: c ? c.width : 0,
        height: c ? c.height : 0
    }
}

function buildView(app) {
    const panel = typeof document !== 'undefined'
        ? document.getElementById('canvas-panel') : null
    const maskOverlay = typeof document !== 'undefined'
        ? document.getElementById('maskOverlay') : null
    return {
        zoomMode: app?._zoomMode ?? 'fit',
        tool: app?._currentTool ?? 'selection',
        selectionTool: app?._selectionManager?.currentTool ?? 'rectangle',
        maskEditLayerId: app?._maskEditMode ? app._maskEditLayerId : null,
        maskOverlayLayerId: maskOverlay && !maskOverlay.classList.contains('hidden')
            ? maskOverlay.dataset.layerId || null : null,
        scrollX: panel?.scrollLeft || 0,
        scrollY: panel?.scrollTop || 0,
        scrollMaxX: panel ? Math.max(0, panel.scrollWidth - panel.clientWidth) : 0,
        scrollMaxY: panel ? Math.max(0, panel.scrollHeight - panel.clientHeight) : 0,
        isPlaying: !!app?._renderer?.isRunning,
        loopDuration: app?._renderer?.loopDuration ?? 10
    }
}

function buildCollaboration(app) {
    const adapter = app?._onlineAdapter
    const status = adapter?.getStatus?.() || 'offline'
    const connected = status === 'online' || status === 'readonly'
    return {
        available: !!adapter,
        status: adapter ? status : 'unavailable',
        sessionId: connected ? adapter.online?.getSessionId?.() || null : null,
        shareUrl: connected ? adapter.online?.getShareUrl?.() || null : null,
    }
}

function buildForeground(app) {
    return { color: app?._foregroundColor || '#000000' }
}

function buildSettings(_app) {
    // Settings are scattered across several localStorage keys today.
    // Read the canonical ones the human UI writes and present a flat view.
    const out = {}
    try {
        const theme = localStorage.getItem('layers-theme')
        if (theme) out.theme = theme
    } catch { /* localStorage unavailable */ }
    try {
        const exportPrefs = localStorage.getItem('layers-export-prefs')
        if (exportPrefs) out.exportVideo = JSON.parse(exportPrefs)
    } catch { /* parse failure or storage unavailable */ }
    try {
        const exportImagePrefs = localStorage.getItem('layers-export-image-prefs')
        if (exportImagePrefs) out.exportImage = JSON.parse(exportImagePrefs)
    } catch { /* parse failure or storage unavailable */ }
    return out
}

function buildLayers(app) {
    const layers = app?._layers || []
    return layers.map(layer => buildLayer(layer, app))
}

function buildLayer(layer, app) {
    return {
        id: layer.id,
        name: layer.name,
        sourceType: layer.sourceType,
        visible: !!layer.visible,
        opacity: typeof layer.opacity === 'number' ? layer.opacity : 100,
        blendMode: layer.blendMode || 'mix',
        locked: !!layer.locked,
        transform: {
            offsetX: layer.offsetX || 0,
            offsetY: layer.offsetY || 0,
            scaleX: layer.scaleX ?? 1,
            scaleY: layer.scaleY ?? 1,
            rotation: layer.rotation ?? 0,
            flipH: !!layer.flipH,
            flipV: !!layer.flipV
        },
        media: buildMedia(layer, app),
        effect: buildEffect(layer),
        drawing: buildDrawing(layer),
        children: (layer.children || []).map(buildChildEffect),
        mask: buildMask(layer)
    }
}

function buildMedia(layer, app) {
    if (layer.sourceType !== 'media') return null
    const file = layer.mediaFile
    // `mediaWidth`/`mediaHeight`/`mediaDurationSec` aren't set on the layer
    // model today; the renderer's media cache (loadMedia) is authoritative for
    // dimensions, and the HTMLVideoElement carries the live duration. Fall back
    // to those when the layer fields aren't populated, then to null.
    const mediaInfo = app?._renderer?.getMediaInfo?.(layer.id) || null
    const videoElement = mediaInfo?.type === 'video' ? mediaInfo.element : null
    const naturalDuration = videoElement && isFinite(videoElement.duration)
        ? videoElement.duration
        : null
    return {
        type: layer.mediaType,
        filename: file?.name || null,
        width: layer.mediaWidth || mediaInfo?.width || null,
        height: layer.mediaHeight || mediaInfo?.height || null,
        durationSec: layer.mediaDurationSec || naturalDuration
    }
}

function buildEffect(layer) {
    if (layer.sourceType !== 'effect') return null
    // Deep clone so the snapshot reader can't mutate nested param values
    // (vec arrays, color tables, etc.) and ripple changes back into the
    // live layer. Falls back to a shallow copy if structuredClone refuses
    // the input — see safeClone.
    return {
        id: layer.effectId,
        name: layer.name,
        params: layer.effectParams ? safeClone(layer.effectParams) : {}
    }
}

function buildDrawing(layer) {
    if (layer.sourceType !== 'drawing') return null
    const strokes = layer.strokes || []
    return {
        strokeCount: strokes.length,
        strokeIds: strokes.slice(0, 20).map(stroke => stroke.id),
        strokeIdsTruncated: strokes.length > 20,
    }
}

function buildChildEffect(child) {
    // Deep clone params for the same reason as buildEffect — defend live
    // child effectParams from snapshot-consumer mutation.
    return {
        id: child.id,
        name: child.name,
        effectId: child.effectId,
        visible: child.visible !== false,
        params: child.effectParams ? safeClone(child.effectParams) : {},
        mask: child.mask ? summarizeMask(child.mask) : null
    }
}

function buildMask(layer) {
    if (!layer.mask) return null
    return {
        enabled: layer.maskEnabled !== false,
        visible: !!layer.maskVisible,
        ...summarizeMask(layer.mask)
    }
}

function summarizeMask(mask, channel = 0) {
    const cached = maskSummaries.get(mask)?.[channel]
    if (cached) return { ...cached, bounds: { ...cached.bounds } }
    const { width, height, data } = mask
    let nonZero = 0
    let minX = width, minY = height, maxX = -1, maxY = -1

    // Mask convention: R=G=B holds value, A is always 255. Read R (idx 0).
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const idx = (y * width + x) * 4
            if (data[idx + channel] > (channel === 3 ? 127 : 0)) {
                nonZero++
                if (x < minX) minX = x
                if (x > maxX) maxX = x
                if (y < minY) minY = y
                if (y > maxY) maxY = y
            }
        }
    }

    const coverage = nonZero / (width * height)
    const bounds = nonZero === 0
        ? { x: 0, y: 0, width: 0, height: 0 }
        : { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 }

    const summary = { width, height, coverage, bounds }
    const entries = maskSummaries.get(mask) || {}
    entries[channel] = summary
    maskSummaries.set(mask, entries)
    return { ...summary, bounds: { ...summary.bounds } }
}

function buildSelection(app) {
    const sm = app?._selectionManager
    if (!sm || !sm.hasSelection?.()) return null

    const path = sm._selectionPath
    if (!path) return null

    const kind = SELECTION_KIND_MAP[path.type] || path.type
    const mask = path.type === 'wand' ? path.mask : path.type === 'mask' ? path.data : null
    const maskSummary = mask ? summarizeMask(mask, 3) : null
    const bounds = maskSummary?.bounds || computeSelectionBounds(path)
    if (!bounds) return null

    const out = { kind, bounds, isEmpty: bounds.width === 0 || bounds.height === 0 }
    if (maskSummary) out.mask = maskSummary
    if (path.type === 'polygon' || path.type === 'lasso') {
        out.polygonPoints = path.points.map(p => [p.x, p.y])
    }
    return out
}

const SELECTION_KIND_MAP = {
    rect: 'rectangle',
    oval: 'oval',
    lasso: 'lasso',
    polygon: 'polygon',
    wand: 'wand',
    mask: 'color-range'
}

function computeSelectionBounds(path) {
    if (path.type === 'rect') {
        return { x: path.x, y: path.y, width: path.width, height: path.height }
    }
    if (path.type === 'oval') {
        return {
            x: Math.round(path.cx - path.rx),
            y: Math.round(path.cy - path.ry),
            width: Math.round(path.rx * 2),
            height: Math.round(path.ry * 2)
        }
    }
    if ((path.type === 'lasso' || path.type === 'polygon') && Array.isArray(path.points)) {
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
        for (const p of path.points) {
            if (p.x < minX) minX = p.x
            if (p.x > maxX) maxX = p.x
            if (p.y < minY) minY = p.y
            if (p.y > maxY) maxY = p.y
        }
        if (minX === Infinity) return { x: 0, y: 0, width: 0, height: 0 }
        return {
            x: Math.round(minX), y: Math.round(minY),
            width: Math.round(maxX - minX),
            height: Math.round(maxY - minY)
        }
    }
    return null
}
