/**
 * Seance online-collaboration adapter for Layers (session dialect "layers").
 *
 * Port of polymorphic's adapter shape (public/js/onlineAdapter.js in the
 * polymorphic repo) adapted to Seance's node/poly lane instead of the
 * text-doc lane: lazy SDK import, config resolution via URL params/window
 * global, take-online/join/go-offline, session-id memory + case-probing,
 * URL stamping, <seance-dialog> wiring, plus the publish/apply engine that
 * keeps `_layers` in sync with the shared node doc (see collab/docModel.js
 * for the wire contract).
 *
 * @module collab/onlineAdapter
 */

import { decodeMasks, bumpLayerCounter } from '../layers/layer-model.js'
import { toast } from '../ui/toast.js'
import { infoDialog } from '../ui/info-dialog.js'
import { confirmDialog } from '../ui/confirm-dialog.js'
import {
    buildNodeModel,
    diffNodeModels,
    applyNodesToComposition,
    isLayersSession,
    fnv1a
} from './docModel.js'

export const DEFAULT_SEANCE_URL = 'https://seance.noisefactor.io'
export const DEFAULT_SEANCE_SDK_URL = 'https://seance.noisefactor.io/sdk/0/index.js'

const DIALECT = 'layers'
const PUBLISH_DEBOUNCE_MS = 150
const DEFERRED_APPLY_POLL_MS = 120
// Coalesces a burst of remote-node events (one per changed node) into a
// single apply attempt — matches the SDK node lane's own ~120ms send pacing
// (design doc §4.5), since that's roughly how far apart a multi-node publish
// from a peer will land anyway.
const APPLY_COALESCE_MS = 120
// Coalesces a burst of node-reject events into a single toast.
const REJECT_TOAST_COOLDOWN_MS = 2000
const SESSION_ID_CASE_STORAGE_KEY = 'layers.seance.sessionIdCaseMap'
const NOT_A_LAYERS_SESSION_MESSAGE = "This session isn't a Layers composition, so Layers can't open it."

export function resolveOnlineConfig(options = {}) {
    const location = urlFrom(options.location || globalThis.location)
    const globals = options.globals || globalThis.LAYERS_SEANCE || {}
    return {
        seanceUrl: location.searchParams.get('seanceUrl') || globals.seanceUrl || DEFAULT_SEANCE_URL,
        sdkUrl: location.searchParams.get('seanceSdk') || globals.sdkUrl || DEFAULT_SEANCE_SDK_URL
    }
}

/**
 * @param {object} app - the live LayersApp instance (same "reach into
 *   private members" convention already used by public/js/agent/commands.js)
 * @param {object} [deps] - overrides for testability (location/importSdk/dialog)
 */
export function createLayersOnlineAdapter(app, deps = {}) {
    const location = deps.location || globalThis.location
    const history = deps.history || globalThis.history
    const importSdk = deps.importSdk || ((url) => import(url))
    const config = resolveOnlineConfig({ location, globals: deps.globals })
    const publicAppUrl = shareBaseUrl(location)
    const dialog = deps.dialog !== undefined ? deps.dialog : document.getElementById('seanceDialog')

    let online = null
    let sdkPromise = null

    let lastPublished = []      // last node model actually sent (for diffing)
    let applyingRemote = false  // single-flight lock: true for the whole span of one apply attempt (see runApply/applyOnce); also guards the publish funnel while true
    let applyRerunRequested = false // a fresh apply was requested while one was already in flight; coalesced into a rerun after it finishes
    let applyDebounceTimer = null   // coalesces a burst of scheduleApply() calls (one per remote-node event) into a single triggerApply()
    let suppressNextSnapshot = false // true right after our own takeOnline() seed
    let publishTimer = null
    let deferredApplyPending = false
    let deferredPollTimer = null
    let rejectedNodeHashes = new Map() // node id -> fnv1a(text) of content the server last rejected; suppresses resending unchanged rejected content (cleared once the content changes)
    let rejectToastCooldown = false    // coalesces a burst of node-reject events into one toast

    // -- status -------------------------------------------------------

    function getStatus() {
        return online?.getStatus?.() || 'offline'
    }

    function isOnline() {
        const status = getStatus()
        return status === 'online' || status === 'readonly'
    }

    function isConnected(layer = online) {
        const status = layer?.getStatus?.()
        return status === 'online' || status === 'readonly' || status === 'connecting'
    }

    function hasComposition() {
        return (app._layers || []).length > 0
    }

    function refreshStatus(status = getStatus()) {
        if (!dialog) return
        const onlineish = status === 'online' || status === 'readonly'
        dialog.state = onlineish ? 'online' : (status === 'connecting' ? 'connecting' : 'offline')
        dialog.sessionId = onlineish ? (online?.getSessionId?.() || '') : ''
        dialog.sessionUrl = onlineish ? (online?.getShareUrl?.() || '') : ''
    }

    // -- SDK bootstrap --------------------------------------------------

    async function ensureOnline() {
        if (online) return online
        if (!sdkPromise) sdkPromise = importSdk(config.sdkUrl)
        const sdk = await sdkPromise
        online = sdk.createOnlineDslLayer({
            seanceUrl: config.seanceUrl,
            publicAppUrl,
            location,
            dialect: DIALECT,
            dialects: [DIALECT]
        })
        online.on('status', () => refreshStatus())
        online.on('error', (err) => console.error('[Layers] Seance error:', err))
        // Neither handler needs to pass its event payload through anymore:
        // applyOnce() always re-fetches online.getNodes() itself right
        // before applying, so every apply uses the freshest node set
        // regardless of how long it sat coalesced/deferred (see
        // scheduleApply/runApply below).
        online.on('node-snapshot', ({ nodes }) => {
            if (suppressNextSnapshot) {
                suppressNextSnapshot = false
                return
            }
            scheduleApply()
        })
        online.on('remote-node', () => scheduleApply())
        online.on('node-reject', (info) => {
            console.warn('[Layers] Seance node rejected:', info)
            handleNodeReject(info)
        })
        refreshStatus('offline')
        return online
    }

    function closeActiveSession(layer = online) {
        if (!isConnected(layer)) return
        layer.goOffline?.()
        refreshStatus('offline')
    }

    // -- gesture- and publish-aware deferral -----------------------------
    //
    // If a brush/eraser stroke, a transform handle drag, a move/clone drag
    // (including the async extraction/duplication that precedes it), or the
    // layer-reorder FSM is mid-gesture, applying a remote snapshot now would
    // clobber it the same way a stale rebuild can (see the brush tool's own
    // "don't clobber a stroke begun during the previous stroke's rebuild"
    // fix). Separately, a publish debounce being armed means a local edit is
    // waiting to go out — since local edits always arm one (_pushUndoState/
    // _pushUndoStateDebounced), letting it flush before an apply starts
    // guarantees that edit reaches the wire instead of being silently
    // replaced by the incoming remote state. Both cases defer and flush via
    // the same poll loop once they clear.

    function isGestureActive() {
        return Boolean(
            app._brushTool?.isDrawing ||
            app._eraserTool?.isErasing ||
            app._transformTool?.isDragging ||
            app._moveTool?.isDragging ||
            app._cloneTool?.isDragging ||
            (app._reorderState && app._reorderState !== 'IDLE')
        )
    }

    function isPublishPending() {
        return publishTimer !== null
    }

    function shouldDeferApply() {
        return isGestureActive() || isPublishPending()
    }

    // Debounce/coalesce a burst of remote-node events (one per changed node)
    // into a single triggerApply() — otherwise a multi-node remote edit
    // would rebuild + push an undo state once per node instead of once
    // total.
    function scheduleApply() {
        if (applyDebounceTimer) clearTimeout(applyDebounceTimer)
        applyDebounceTimer = setTimeout(() => {
            applyDebounceTimer = null
            triggerApply()
        }, APPLY_COALESCE_MS)
    }

    // Entry point for actually starting an apply attempt: defers (via the
    // shared poll loop) while unsafe, otherwise hands off to runApply().
    // Also the re-entry point a deferred-mid-apply bailout (see applyOnce)
    // and a coalesced rerun (see runApply) both funnel back through, so
    // there's exactly one place that decides "safe to go now vs. keep
    // waiting".
    function triggerApply() {
        if (shouldDeferApply()) {
            deferredApplyPending = true
            if (!deferredPollTimer) {
                deferredPollTimer = setInterval(() => {
                    if (shouldDeferApply()) return
                    clearInterval(deferredPollTimer)
                    deferredPollTimer = null
                    if (deferredApplyPending) {
                        deferredApplyPending = false
                        void runApply()
                    }
                }, DEFERRED_APPLY_POLL_MS)
            }
            return
        }
        void runApply()
    }

    function refuseSession() {
        online?.goOffline?.()
        refreshStatus('offline')
        // Close the seance-dialog first if it's open: its native <dialog>
        // lives in the browser's top layer, which would otherwise bury this
        // (non-native) info dialog. No-op if it was never opened (e.g. a
        // ?seance= boot-time refusal). Fire-and-forget, matching the rest of
        // the app's infoDialog.show() call sites — this can run during boot,
        // and awaiting it would leave the (much higher z-index) loading
        // screen stuck up behind the modal until the user dismisses it.
        dialog?.hide?.()
        infoDialog.show({ message: NOT_A_LAYERS_SESSION_MESSAGE })
    }

    // Single-flight owner: applyingRemote spans the WHOLE synchronous+async
    // life of one apply attempt (set before any awaits, cleared in finally),
    // so it doubles as the reentrancy guard AND the publish-funnel guard.
    // A call arriving while one is already in flight coalesces into a
    // rerun — never two interleaved applies.
    async function runApply() {
        if (!online) return
        if (applyingRemote) {
            applyRerunRequested = true
            return
        }

        applyingRemote = true
        let needsRerun = false
        try {
            needsRerun = await applyOnce()
        } finally {
            applyingRemote = false
        }

        if (needsRerun || applyRerunRequested) {
            applyRerunRequested = false
            triggerApply()
        }
    }

    /**
     * Perform (or safely bail out of) one apply attempt.
     * @returns {Promise<boolean>} true if the caller should requeue (nothing
     *   was applied — a gesture/publish became active, or a local mutation
     *   raced in), false once handled (applied, or refused as not a Layers
     *   session).
     */
    async function applyOnce() {
        const nodes = online.getNodes()
        if (!isLayersSession(nodes)) {
            refuseSession()
            return false
        }

        // Abort-on-race backstop: snapshot the live composition now, so we
        // can tell — right before the synchronous commit below — whether a
        // local mutation landed while we were awaiting.
        const before = JSON.stringify(buildNodeModel(app._layers, canvasDims()))

        const { layers, canvas, mediaPlaceholderLayerIds } = applyNodesToComposition(nodes, app._layers)
        await decodeMasks(layers)

        // A gesture may have started, or a local edit may have armed a
        // publish, while we were decoding masks: bail out without touching
        // app state and let the caller requeue through the standard
        // deferral path.
        if (shouldDeferApply()) return true

        // Re-check immediately before the synchronous mutation block: if the
        // live composition no longer matches what we snapshotted above, a
        // local mutation raced in during the awaits. Bail out WITHOUT
        // touching app state — requeuing will defer (per shouldDeferApply)
        // until that mutation's publish flushes, then retry with fresh
        // nodes. This is what makes the overwrite below provably safe.
        if (JSON.stringify(buildNodeModel(app._layers, canvasDims())) !== before) return true

        for (const layer of app._layers) {
            if (layer.sourceType === 'media' || layer.sourceType === 'drawing') {
                app._renderer.unloadMedia(layer.id)
            }
        }
        if (app._maskEditMode) app._exitMaskEditMode()

        bumpLayerCounterPast(layers)
        app._layers = layers

        const canvasChanged = canvas.width && canvas.height &&
            (canvas.width !== app._canvas.width || canvas.height !== app._canvas.height)
        if (canvasChanged) {
            app._renderer.stop()
            app._resizeCanvas(canvas.width, canvas.height)
        }

        // Capture lastPublished NOW, inside the synchronous commit block: the
        // awaits below (rasterize/rebuild/rAF) can be raced by a local edit
        // mutating this same `layers` array, and building the model after
        // them would fold that edit into lastPublished — making the next
        // diff empty and silently never publishing it. Built from the layer
        // objects (not the wire nodes) so mask/stroke text stays in THIS
        // browser's canonical encoding.
        lastPublished = buildNodeModel(layers, canvasDims())

        for (const layer of layers) {
            if (layer.sourceType === 'drawing' && layer.strokes?.length > 0) {
                await app._rasterizeDrawingLayer(layer)
            }
        }
        for (const layer of layers) {
            if (layer.mask) app._renderer.uploadMaskTexture(layer.id, layer.mask)
            else app._renderer.removeMaskTexture(layer.id)
        }

        app._updateLayerStack()
        await app._rebuild({ force: true })

        if (!app._renderer.isRunning) {
            await new Promise(resolve => requestAnimationFrame(resolve))
            app._renderer.start()
        }

        app._markDirty()
        // Undo semantics v1 (documented per design doc §6): whole-state
        // snapshot undo also captures remote states. Undoing after a
        // remote apply restores the local pre-apply composition and — via
        // the same publish funnel every other mutation goes through —
        // republishes it as a new local edit, same behavior family as
        // the shipped DSL-text products.
        app._pushUndoState()

        if (mediaPlaceholderLayerIds.length > 0) {
            toast.warning('This session includes a media layer, which can’t be shown here yet.')
        }
        return false
    }

    // -- node-reject handling ---------------------------------------------

    function handleNodeReject({ id }) {
        // Remember what we last tried to send for this id so a later,
        // unrelated publish tick doesn't silently skip resending it just
        // because it still (optimistically) matches lastPublished — but
        // also don't hammer the server with the exact same doomed content:
        // publishComposition() below skips resending while the hash matches.
        const rejected = lastPublished.find(n => n.id === id)
        if (rejected) rejectedNodeHashes.set(id, fnv1a(rejected.text))
        lastPublished = lastPublished.filter(n => n.id !== id)

        if (!rejectToastCooldown) {
            rejectToastCooldown = true
            toast.warning('Some changes couldn’t be synced')
            setTimeout(() => { rejectToastCooldown = false }, REJECT_TOAST_COOLDOWN_MS)
        }
    }

    function bumpLayerCounterPast(layers) {
        let max = -1
        const scan = (id) => {
            const m = /^layer-(\d+)$/.exec(String(id))
            if (m) max = Math.max(max, Number(m[1]))
        }
        for (const layer of layers) {
            scan(layer.id)
            for (const child of layer.children || []) scan(child.id)
        }
        if (max >= 0) bumpLayerCounter(max + 1)
    }

    function canvasDims() {
        return { width: app._canvas?.width || 0, height: app._canvas?.height || 0 }
    }

    // -- publish funnel ---------------------------------------------------
    //
    // One funnel, no per-command instrumentation: callers just call
    // schedulePublish() after a mutation settles. It diffs the current
    // model against the last-published model and sends minimal
    // upserts/deletes — echo-safe by construction (a remote apply updates
    // lastPublished directly, so the very next diff is empty).
    //
    // Deliberately arms even while applyingRemote is true (unlike the old
    // hard-return): local edits always call this now (_pushUndoState/
    // _pushUndoStateDebounced), and an apply attempt that hasn't yet started
    // its commit defers until isPublishPending() clears (see
    // shouldDeferApply above) — so the timer must actually exist for that
    // deferral to have anything to wait for.

    function schedulePublish() {
        if (!isOnline()) return
        if (publishTimer) return
        publishTimer = setTimeout(() => {
            publishTimer = null
            if (applyingRemote) {
                // An apply is mid-commit right now — don't publish over it.
                // Re-arm instead of dropping so this still fires once the
                // apply finishes.
                schedulePublish()
                return
            }
            publishComposition()
        }, PUBLISH_DEBOUNCE_MS)
    }

    function publishComposition() {
        if (!online || !isOnline()) return
        if (applyingRemote) {
            schedulePublish()
            return
        }
        const nextModel = buildNodeModel(app._layers, canvasDims())
        const { upserts, deletes } = diffNodeModels(lastPublished, nextModel)
        for (const node of upserts) {
            const rejectedHash = rejectedNodeHashes.get(node.id)
            if (rejectedHash !== undefined) {
                if (rejectedHash === fnv1a(node.text)) continue // still the rejected content — wait for it to change
                rejectedNodeHashes.delete(node.id) // content changed since the reject — retry normally
            }
            online.upsertNode(node.id, { kind: node.kind, text: node.text, parentId: node.parentId })
        }
        for (const id of deletes) {
            rejectedNodeHashes.delete(id)
            online.deleteNode(id)
        }
        lastPublished = nextModel
    }

    // -- media gating -------------------------------------------------

    function hasMediaLayer() {
        return (app._layers || []).some(l => l.sourceType === 'media')
    }

    // -- take online / join / go offline ---------------------------------

    async function takeOnline() {
        if (hasMediaLayer()) {
            // Same top-layer conflict as the join confirm above: close the
            // still-open seance-dialog first so this (non-native) info
            // dialog is actually visible/clickable.
            dialog?.hide?.()
            await infoDialog.show({
                message: 'This composition has a media layer. Media layers aren’t supported in shared sessions yet — remove it before going online.'
            })
            return null
        }
        const layer = await ensureOnline()
        closeActiveSession(layer)
        const nodes = buildNodeModel(app._layers, canvasDims())
        suppressNextSnapshot = true
        lastPublished = nodes
        await layer.takeOnline({ poly: { programText: '', nodes } })
        rememberSessionId(layer.getSessionId())
        writeSessionToBrowserUrl(layer.getSessionId())
        refreshStatus()
        toast.success('Session is online')
        return layer.getSessionId()
    }

    async function joinSession(sessionId, { skipConfirm = false } = {}) {
        const id = String(sessionId || '').trim()
        if (!id) return null

        if (!skipConfirm && hasComposition()) {
            // confirmDialog is a plain (non-native) modal; <seance-dialog>'s
            // native <dialog> would bury it in the browser's top layer if
            // left open, so close it first. The caller can reopen it, or
            // just watch for the "Joined session" toast, once this settles.
            dialog?.hide?.()
            const ok = await confirmDialog.show({
                message: 'Joining replaces your current composition. Continue?',
                confirmText: 'Join',
                cancelText: 'Cancel'
            })
            if (!ok) return null
        }

        let layer
        try {
            const resolvedId = await resolveJoinSessionId(id)
            layer = await ensureOnline()
            closeActiveSession(layer)
            await layer.joinSession(resolvedId)
        } catch (err) {
            await handleJoinFailure(err)
            return null
        }

        rememberSessionId(layer.getSessionId())
        writeSessionToBrowserUrl(layer.getSessionId())
        refreshStatus()
        toast.success('Joined session')
        return layer.getSessionId()
    }

    async function joinFromUrl() {
        const sessionId = readSessionIdFromLocation(location)
        if (!sessionId) return false
        const result = await joinSession(sessionId, { skipConfirm: true })
        return result !== null
    }

    function goOffline() {
        if (!online) return
        online.goOffline()
        clearTimeout(publishTimer)
        publishTimer = null
        clearTimeout(applyDebounceTimer)
        applyDebounceTimer = null
        if (deferredPollTimer) {
            clearInterval(deferredPollTimer)
            deferredPollTimer = null
        }
        deferredApplyPending = false
        applyRerunRequested = false
        rejectedNodeHashes.clear()
        writeSessionToBrowserUrl(null)
        refreshStatus('offline')
        toast.info('Offline')
    }

    async function copyShareUrl() {
        const url = dialog?.sessionUrl || online?.getShareUrl?.()
        if (!url) return false
        await navigator.clipboard?.writeText?.(url)
        toast.success('Session URL copied')
        return true
    }

    function isDialectMismatch(err) {
        return err?.code === 'dialect_mismatch' || err?.frame?.code === 'dialect_mismatch'
    }

    async function handleJoinFailure(err) {
        if (isDialectMismatch(err)) {
            refuseSession()
            return
        }
        refreshStatus('offline')
        console.error('[Layers] Seance join failed:', err)
        toast.error(`Could not join session: ${err?.message || err}`)
    }

    // -- <seance-dialog> wiring -------------------------------------------
    // State/session-id/session-url attributes are one-way (adapter -> dialog
    // via refreshStatus); the dialog is shown/hidden only by its own trigger
    // (the "go online..." menu item in app.js) — never toggled here.

    function wireUi() {
        dialog?.addEventListener('take-online', () => {
            takeOnline().catch((err) => {
                console.error('[Layers] Take online failed:', err)
                toast.error(`Could not take online: ${err.message}`)
            })
        })
        dialog?.addEventListener('join-session', (event) => {
            joinSession(event.detail?.sessionId).catch((err) => {
                console.error('[Layers] Join session failed:', err)
            })
        })
        dialog?.addEventListener('go-offline', () => goOffline())
        dialog?.addEventListener('copy-url', () => {
            copyShareUrl().catch((err) => {
                console.error('[Layers] Copy session URL failed:', err)
                toast.error('Could not copy session URL')
            })
        })
        refreshStatus('offline')
    }

    // -- URL / session-id helpers -----------------------------------------

    function writeSessionToBrowserUrl(sessionId) {
        if (!history?.replaceState || !online?.writeSessionToUrl) return
        try {
            const next = online.writeSessionToUrl(shareBaseUrl(location), sessionId)
            history.replaceState(null, '', next)
        } catch (err) {
            console.debug('[Layers] Could not update session URL:', err)
        }
    }

    async function resolveJoinSessionId(sessionId) {
        const remembered = recallSessionId(sessionId)
        if (remembered) return remembered

        const candidates = caseCandidates(sessionId)
        if (candidates.length <= 1 || !globalThis.fetch) return sessionId

        for (const candidate of candidates) {
            try {
                const response = await globalThis.fetch(`${stripTrailingSlash(config.seanceUrl)}/v1/sessions/${encodeURIComponent(candidate)}`, {
                    credentials: 'include'
                })
                if (response.ok) {
                    rememberSessionId(candidate)
                    return candidate
                }
            } catch {
                return sessionId
            }
        }
        return sessionId
    }

    return {
        config,
        wireUi,
        isOnline,
        getStatus,
        takeOnline,
        joinSession,
        joinFromUrl,
        goOffline,
        copyShareUrl,
        schedulePublish,
        get online() { return online }
    }
}

// ---------------------------------------------------------------------
// module-level helpers (no closure state)
// ---------------------------------------------------------------------

function urlFrom(locationLike) {
    if (typeof locationLike === 'string') return new URL(locationLike, 'http://localhost/')
    if (locationLike instanceof URL) return new URL(locationLike.toString())
    if (locationLike?.href) return new URL(locationLike.href)
    return new URL('http://localhost/')
}

function shareBaseUrl(locationLike = globalThis.location) {
    const url = urlFrom(locationLike)
    url.searchParams.delete('seance')
    return url.toString()
}

function readSessionIdFromLocation(locationLike) {
    try {
        return urlFrom(locationLike).searchParams.get('seance')
    } catch {
        return null
    }
}

function stripTrailingSlash(value) {
    return String(value || '').replace(/\/+$/, '')
}

function caseCandidates(sessionId) {
    const value = String(sessionId || '').trim()
    if (!/^[A-Z0-9]{6}$/.test(value)) return [value]
    const chars = [...value]
    let variants = ['']
    for (const ch of chars) {
        const lower = /[A-Z]/.test(ch) ? ch.toLowerCase() : ch
        const options = lower === ch ? [ch] : [ch, lower]
        const next = []
        for (const prefix of variants) {
            for (const option of options) next.push(prefix + option)
        }
        variants = next
    }
    return [value, ...variants.filter((candidate) => candidate !== value)]
}

function rememberSessionId(sessionId) {
    const value = String(sessionId || '')
    if (!value) return
    try {
        const raw = globalThis.localStorage?.getItem(SESSION_ID_CASE_STORAGE_KEY)
        const map = raw ? JSON.parse(raw) : {}
        map[value.toUpperCase()] = value
        globalThis.localStorage?.setItem(SESSION_ID_CASE_STORAGE_KEY, JSON.stringify(map))
    } catch {
        // Local storage is a convenience only; probing still works without it.
    }
}

function recallSessionId(sessionId) {
    try {
        const raw = globalThis.localStorage?.getItem(SESSION_ID_CASE_STORAGE_KEY)
        const map = raw ? JSON.parse(raw) : {}
        return map[String(sessionId || '').toUpperCase()] || null
    } catch {
        return null
    }
}
