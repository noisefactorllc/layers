/**
 * Build a JSON-serializable snapshot of the LayersApp state.
 *
 * The same shape is returned by getState() and embedded in every command
 * envelope. No pixel data, no File blobs — only structural information.
 *
 * @module agent/snapshot
 */

import { API_VERSION } from './index.js'
import { getRecentExports } from './commands.js'
import { listJobs } from './jobs.js'

const SCHEMA_VERSION = '1.0'

export function buildSnapshot(app) {
    return {
        apiVersion: API_VERSION,
        schemaVersion: SCHEMA_VERSION,
        project: buildProject(app),
        canvas: buildCanvas(app),
        view: buildView(app),
        foreground: buildForeground(app),
        selection: buildSelection(app),
        layers: buildLayers(app),
        selectedLayerIds: app?._layerStack?.selectedLayerIds?.slice() || [],
        activeLayerId: app?._layerStack?.selectedLayerId || null,
        jobs: listJobs()
            .sort((a, b) => b.updatedAt - a.updatedAt)
            .slice(0, 20),                 // sorted by recency so a long-running
                                           // job can't drop out of view after
                                           // many shorter jobs settle.
        recentExports: getRecentExports(),
        settings: buildSettings(app)
    }
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
    return {
        zoomMode: app?._zoomMode ?? 'fit',
        isPlaying: !!app?._renderer?.isRunning,
        loopDuration: app?._renderer?.loopDuration ?? 10
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
    return layers.map(buildLayer)
}

function buildLayer(layer) {
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
        media: buildMedia(layer),
        effect: buildEffect(layer),
        drawing: buildDrawing(layer),
        children: (layer.children || []).map(buildChildEffect),
        mask: buildMask(layer)
    }
}

function buildMedia(layer) {
    if (layer.sourceType !== 'media') return null
    const file = layer.mediaFile
    return {
        type: layer.mediaType,
        filename: file?.name || null,
        width: layer.mediaWidth || null,
        height: layer.mediaHeight || null,
        durationSec: layer.mediaDurationSec || null
    }
}

function buildEffect(layer) {
    if (layer.sourceType !== 'effect') return null
    return {
        id: layer.effectId,
        name: layer.name,
        params: layer.effectParams ? { ...layer.effectParams } : {}
    }
}

function buildDrawing(layer) {
    if (layer.sourceType !== 'drawing') return null
    return { strokeCount: (layer.strokes || []).length }
}

function buildChildEffect(child) {
    return {
        id: child.id,
        name: child.name,
        effectId: child.effectId,
        visible: child.visible !== false,
        params: child.effectParams ? { ...child.effectParams } : {}
    }
}

function buildMask(layer) {
    if (!layer.mask) return null
    const { width, height, data } = layer.mask
    let nonZero = 0
    let minX = width, minY = height, maxX = -1, maxY = -1

    // Mask convention: R=G=B holds value, A is always 255. Read R (idx 0).
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const idx = (y * width + x) * 4
            if (data[idx] > 0) {
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

    return {
        enabled: layer.maskEnabled !== false,
        visible: !!layer.maskVisible,
        width, height,
        coverage,
        bounds
    }
}

function buildSelection(app) {
    const sm = app?._selectionManager
    if (!sm || !sm.hasSelection?.()) return null

    const path = sm._selectionPath
    if (!path) return null

    const kind = SELECTION_KIND_MAP[path.type] || path.type
    const bounds = computeSelectionBounds(path)
    if (!bounds) return null

    const out = { kind, bounds, isEmpty: bounds.width === 0 || bounds.height === 0 }
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
    if (path.type === 'wand' && path.mask) {
        return computeImageDataAABB(path.mask)
    }
    if (path.type === 'mask' && path.data) {
        return computeImageDataAABB(path.data)
    }
    return null
}

function computeImageDataAABB(imageData) {
    const { width, height, data } = imageData
    let minX = width, minY = height, maxX = -1, maxY = -1
    let any = false
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            // Mask convention: R=G=B holds value, A is always 255. Read R (idx 0).
            if (data[(y * width + x) * 4] > 0) {
                any = true
                if (x < minX) minX = x
                if (x > maxX) maxX = x
                if (y < minY) minY = y
                if (y > maxY) maxY = y
            }
        }
    }
    if (!any) return { x: 0, y: 0, width: 0, height: 0 }
    return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 }
}
