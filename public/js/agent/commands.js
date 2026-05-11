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
