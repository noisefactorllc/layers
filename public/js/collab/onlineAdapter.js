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
    assertRemoteNodeModelWithinBounds,
    assertRemoteNodeSemantics,
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
const DELETE_REJECTION_WINDOW_MS = 2000
const MAX_PENDING_DELETE_REJECTIONS = 256
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

    let lastPublished = []      // active session baseline for local publish diffing
    let applyTaskRunning = false // single-flight lock spanning lifecycle acquisition and the apply attempt
    let applyingRemote = false  // true only while this adapter owns the lifecycle token and may mutate app state; also guards the publish funnel
    let applyingJoinedSession = false // joined baseline must land before mutations queued behind its transition lease
    let applyRerunRequested = null // freshest { layer, epoch } requested while an apply was in flight
    let applyDebounceTimer = null   // coalesces a burst of scheduleApply() calls (one per remote-node event) into a single triggerApply()
    const expectedSeedSnapshots = new Map() // candidate layer -> exact locally seeded node model
    const pendingSeedSnapshotApplies = new Set()
    let publishTimer = null
    let deferredApplyRequest = null
    let deferredPollTimer = null
    let rejectedNodeHashes = new Map() // node id -> fnv1a(text) of content the server last rejected; suppresses resending unchanged rejected content (cleared once the content changes)
    let pendingDeleteRejections = new Map() // deleted node id -> rejection deadline
    let pendingDeleteExpiryTimer = null
    let rejectToastCooldown = false    // coalesces a burst of node-reject events into one toast
    let remoteLifecycleToken = null
    let sessionEpoch = 0
    let transitionIntentGeneration = 0
    let pendingSessionTransitionGeneration = null

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

    async function createOnlineLayer() {
        if (!sdkPromise) sdkPromise = importSdk(config.sdkUrl)
        const sdk = await sdkPromise
        const layer = sdk.createOnlineDslLayer({
            seanceUrl: config.seanceUrl,
            publicAppUrl,
            location,
            dialect: DIALECT,
            dialects: [DIALECT]
        })
        layer.on('status', () => {
            if (layer === online) refreshStatus()
        })
        layer.on('error', (err) => console.error('[Layers] Seance error:', err))
        // Neither handler needs to pass its event payload through anymore:
        // applyOnce() always re-fetches the captured session layer's nodes
        // right before applying, so every apply uses that session's freshest set
        // regardless of how long it sat coalesced/deferred (see
        // scheduleApply/runApply below).
        layer.on('node-snapshot', () => {
            const expectedSeed = expectedSeedSnapshots.get(layer)
            if (expectedSeed) {
                const actual = layer.getNodes()
                expectedSeedSnapshots.delete(layer)
                const seedDiff = diffNodeModels(expectedSeed, actual)
                if (seedDiff.upserts.length === 0 && seedDiff.deletes.length === 0) return
                if (layer !== online) {
                    pendingSeedSnapshotApplies.add(layer)
                    return
                }
            }
            if (layer !== online) return
            scheduleApply(currentSessionRequest(layer))
        })
        layer.on('remote-node', () => {
            if (layer === online) scheduleApply(currentSessionRequest(layer))
        })
        layer.on('node-reject', (info) => {
            if (layer !== online) return
            console.warn('[Layers] Seance node rejected:', info)
            handleNodeReject(info)
        })
        return layer
    }

    async function ensureOnline(isCurrent = () => true) {
        if (online) return online
        const layer = await createOnlineLayer()
        if (!isCurrent()) return layer
        online = layer
        refreshStatus('offline')
        return online
    }

    async function prepareSessionTransition(isCurrent = () => true) {
        const current = await ensureOnline(isCurrent)
        if (!isConnected(current)) return { layer: current, previous: null }
        return { layer: await createOnlineLayer(), previous: current }
    }

    function currentSessionRequest(layer = online, epoch = sessionEpoch) {
        return { layer, epoch }
    }

    function isCurrentSession({ layer, epoch }) {
        return layer === online && epoch === sessionEpoch && isConnected(layer)
    }

    function clearScheduledSessionWork() {
        clearTimeout(publishTimer)
        publishTimer = null
        clearTimeout(applyDebounceTimer)
        applyDebounceTimer = null
        if (deferredPollTimer) {
            clearInterval(deferredPollTimer)
            deferredPollTimer = null
        }
        deferredApplyRequest = null
        applyRerunRequested = null
    }

    function prunePendingDeleteRejections(now = Date.now()) {
        for (const [id, expiresAt] of pendingDeleteRejections) {
            if (expiresAt <= now) pendingDeleteRejections.delete(id)
        }
    }

    function armPendingDeleteExpiryTimer() {
        clearTimeout(pendingDeleteExpiryTimer)
        pendingDeleteExpiryTimer = null
        prunePendingDeleteRejections()
        let earliest = Infinity
        for (const expiresAt of pendingDeleteRejections.values()) {
            earliest = Math.min(earliest, expiresAt)
        }
        if (!Number.isFinite(earliest)) return
        pendingDeleteExpiryTimer = setTimeout(() => {
            pendingDeleteExpiryTimer = null
            prunePendingDeleteRejections()
            armPendingDeleteExpiryTimer()
        }, Math.max(0, earliest - Date.now()))
    }

    function clearPendingDeleteRejections() {
        clearTimeout(pendingDeleteExpiryTimer)
        pendingDeleteExpiryTimer = null
        pendingDeleteRejections.clear()
    }

    function rememberPendingDeleteRejection(id) {
        prunePendingDeleteRejections()
        pendingDeleteRejections.delete(id)
        while (pendingDeleteRejections.size >= MAX_PENDING_DELETE_REJECTIONS) {
            pendingDeleteRejections.delete(pendingDeleteRejections.keys().next().value)
        }
        pendingDeleteRejections.set(id, Date.now() + DELETE_REJECTION_WINDOW_MS)
        armPendingDeleteExpiryTimer()
    }

    function bestEffortSessionEffect(label, effect) {
        try {
            effect()
        } catch (err) {
            console.error(`[Layers] ${label}:`, err)
        }
    }

    function activateSessionTransition(layer, baseline) {
        online = layer
        sessionEpoch++
        clearScheduledSessionWork()
        rejectedNodeHashes.clear()
        clearPendingDeleteRejections()
        for (const candidate of expectedSeedSnapshots.keys()) {
            if (candidate !== layer) expectedSeedSnapshots.delete(candidate)
        }
        for (const candidate of pendingSeedSnapshotApplies) {
            if (candidate !== layer) pendingSeedSnapshotApplies.delete(candidate)
        }
        lastPublished = baseline
        if (pendingSeedSnapshotApplies.delete(layer)) {
            scheduleApply(currentSessionRequest(layer))
        }
    }

    function finishSessionTransition(previous) {
        if (previous) {
            bestEffortSessionEffect(
                'Failed to disconnect previous collaboration session',
                () => previous.goOffline?.())
        }
    }

    function captureSessionState() {
        return {
            online,
            lastPublished,
            rejectedNodeHashes: new Map(rejectedNodeHashes),
            pendingDeleteRejections: new Map(pendingDeleteRejections),
            publishPending: publishTimer !== null,
            applyPending: applyDebounceTimer !== null || deferredApplyRequest !== null
                || applyRerunRequested !== null || applyTaskRunning,
        }
    }

    function restoreSessionState(state) {
        online = state.online
        sessionEpoch++
        clearScheduledSessionWork()
        rejectedNodeHashes = new Map(state.rejectedNodeHashes)
        clearPendingDeleteRejections()
        pendingDeleteRejections = new Map(state.pendingDeleteRejections)
        armPendingDeleteExpiryTimer()
        lastPublished = state.lastPublished
        if (state.publishPending) schedulePublish()
        if (state.applyPending) scheduleApply(currentSessionRequest())
    }

    function captureSessionTransitionIntent(generation) {
        return { layer: online, epoch: sessionEpoch, generation }
    }

    function isCurrentSessionTransitionIntent(intent) {
        return intent.generation === transitionIntentGeneration
            && intent.layer === online && intent.epoch === sessionEpoch
            && isConnected(intent.layer)
    }

    function abandonSessionTransition(layer) {
        expectedSeedSnapshots.delete(layer)
        pendingSeedSnapshotApplies.delete(layer)
        bestEffortSessionEffect('Failed to disconnect superseded collaboration session',
            () => layer?.goOffline?.())
        bestEffortSessionEffect('Failed to refresh superseded collaboration status',
            () => refreshStatus())
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
        return app._projectInstallActive || app._projectReplacementActive
            || (!applyingJoinedSession && app._projectLifecycleWaiters > 0)
            || (app._projectLifecycleActive
                && app._projectLifecycleOwner !== remoteLifecycleToken)
            || isGestureActive() || isPublishPending()
    }

    // Debounce/coalesce a burst of remote-node events (one per changed node)
    // into a single triggerApply() — otherwise a multi-node remote edit
    // would rebuild + push an undo state once per node instead of once
    // total.
    function scheduleApply(request = currentSessionRequest()) {
        if (!isCurrentSession(request) || !isOnline()) return
        if (applyDebounceTimer) clearTimeout(applyDebounceTimer)
        applyDebounceTimer = setTimeout(() => {
            applyDebounceTimer = null
            triggerApply(request)
        }, APPLY_COALESCE_MS)
    }

    // Entry point for actually starting an apply attempt: defers (via the
    // shared poll loop) while unsafe, otherwise hands off to runApply().
    // Also the re-entry point a deferred-mid-apply bailout (see applyOnce)
    // and a coalesced rerun (see runApply) both funnel back through, so
    // there's exactly one place that decides "safe to go now vs. keep
    // waiting".
    function triggerApply(request = currentSessionRequest()) {
        if (!isCurrentSession(request) || !isOnline()) return
        if (shouldDeferApply()) {
            deferredApplyRequest = request
            if (!deferredPollTimer) {
                deferredPollTimer = setInterval(() => {
                    const pending = deferredApplyRequest
                    if (!pending || !isCurrentSession(pending) || !isOnline()) {
                        deferredApplyRequest = null
                        clearInterval(deferredPollTimer)
                        deferredPollTimer = null
                        return
                    }
                    if (shouldDeferApply()) return
                    clearInterval(deferredPollTimer)
                    deferredPollTimer = null
                    deferredApplyRequest = null
                    void runApply(pending)
                }, DEFERRED_APPLY_POLL_MS)
            }
            return
        }
        void runApply(request)
    }

    function refuseSession(layer = online) {
        bestEffortSessionEffect('Failed to disconnect incompatible collaboration session',
            () => layer?.goOffline?.())
        bestEffortSessionEffect('Failed to refresh collaboration status after refusal',
            () => refreshStatus(layer === online ? 'offline' : getStatus()))
        // Close the seance-dialog first if it's open: its native <dialog>
        // lives in the browser's top layer, which would otherwise bury this
        // (non-native) info dialog. No-op if it was never opened (e.g. a
        // ?seance= boot-time refusal). Fire-and-forget, matching the rest of
        // the app's infoDialog.show() call sites — this can run during boot,
        // and awaiting it would leave the (much higher z-index) loading
        // screen stuck up behind the modal until the user dismisses it.
        bestEffortSessionEffect('Failed to hide collaboration dialog after refusal',
            () => dialog?.hide?.())
        try {
            Promise.resolve(infoDialog.show({ message: NOT_A_LAYERS_SESSION_MESSAGE }))
                .catch(err => console.error('[Layers] Failed to show session refusal:', err))
        } catch (err) {
            console.error('[Layers] Failed to show session refusal:', err)
        }
    }

    // applyTaskRunning is the single-flight guard across lifecycle waiting;
    // applyingRemote is narrower and becomes observable only after this
    // adapter owns the lifecycle token. This lets an operation already ahead
    // of a remote rerun commit without mistaking that queued rerun for an
    // active remote mutation.
    async function runApply(request = currentSessionRequest()) {
        if (!isCurrentSession(request) || !isOnline()) return
        if (applyTaskRunning) {
            applyRerunRequested = request
            return
        }

        applyTaskRunning = true
        let needsRerun = false
        try {
            remoteLifecycleToken = await app._acquireProjectLifecycle()
            if (isCurrentSession(request) && isOnline()) {
                applyingRemote = true
                needsRerun = await applyOnce(request)
            }
        } catch (err) {
            console.error('[Layers] Failed to apply remote project:', err)
            toast.warning('A remote project update was rejected')
        } finally {
            applyingRemote = false
            remoteLifecycleToken?.release()
            remoteLifecycleToken = null
            applyTaskRunning = false
        }

        const rerunRequest = applyRerunRequested
        applyRerunRequested = null
        if (rerunRequest && isCurrentSession(rerunRequest) && isOnline()) {
            triggerApply(rerunRequest)
        } else if (needsRerun && isCurrentSession(request) && isOnline()) {
            triggerApply(request)
        }
    }

    async function applyJoinedSession(request, lifecycleToken) {
        if (!isCurrentSession(request) || !isOnline()) {
            return { success: false, error: new Error('Joined session is no longer active') }
        }
        let joinedDiff
        try {
            const currentNodes = buildNodeModel(app._layers, canvasDims())
            const joinedNodes = request.layer.getNodes()
            joinedDiff = diffNodeModels(currentNodes, joinedNodes)
        } catch (err) {
            return { success: false, error: err }
        }
        if (joinedDiff.upserts.length === 0 && joinedDiff.deletes.length === 0) {
            return { success: true }
        }
        applyTaskRunning = true
        remoteLifecycleToken = lifecycleToken
        applyingRemote = true
        applyingJoinedSession = true
        let needsRerun = false
        try {
            needsRerun = await applyOnce(request)
        } catch (err) {
            console.error('[Layers] Failed to apply joined project:', err)
            return { success: false, error: err }
        } finally {
            applyingRemote = false
            applyingJoinedSession = false
            remoteLifecycleToken = null
            applyTaskRunning = false
        }
        if (needsRerun) {
            return {
                success: false,
                error: new Error('Joined project changed before it could be applied'),
            }
        }
        return { success: true }
    }

    /**
     * Perform (or safely bail out of) one apply attempt.
     * @returns {Promise<boolean>} true if the caller should requeue (nothing
     *   was applied — a gesture/publish became active, or a local mutation
     *   raced in), false once handled (applied, or refused as not a Layers
     *   session).
     */
    async function applyOnce(request) {
        if (!isCurrentSession(request)) return false
        const nodes = request.layer.getNodes()
        assertRemoteCompositionWithinBounds(nodes)
        if (!isLayersSession(nodes)) {
            if (isCurrentSession(request)) refuseSession(request.layer)
            return false
        }
        await assertRemoteCompositionSemantics(nodes)
        if (!isCurrentSession(request)) return false

        // Abort-on-race backstop: snapshot the live composition now, so we
        // can tell — right before the synchronous commit below — whether a
        // local mutation landed while we were awaiting.
        const before = JSON.stringify(buildNodeModel(app._layers, canvasDims()))

        const { layers, canvas, mediaPlaceholderLayerIds } = applyNodesToComposition(nodes, app._layers)
        await decodeMasks(layers)
        if (!isCurrentSession(request)) return false

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

        const nextLayerCounter = nextLayerCounterPast(layers)
        const previousSize = canvasDims()
        const targetSize = canvas.width && canvas.height
            ? { width: canvas.width, height: canvas.height }
            : previousSize
        const candidate = {
            layers,
            mediaTextures: new Map(),
            maskTextures: new Map()
        }
        let candidateOwned = true
        let committed = false
        let stage = null
        let previousAppState = null
        let candidateBaseline = null
        let snapshotTransaction = null

        const disposeCandidate = () => {
            app._renderer.disposeMediaResources(candidate.mediaTextures)
            candidate.maskTextures.clear()
        }
        const restoreLiveCanvas = () => {
            if (app._canvas.width !== previousSize.width
                || app._canvas.height !== previousSize.height) {
                app._resizeCanvas(previousSize.width, previousSize.height)
            }
            if (!app._maskEditMode) return
            const maskLayer = app._layers.find(layer => layer.id === app._maskEditLayerId)
            if (maskLayer) app._renderMaskOverlay(maskLayer)
        }
        const redrawRestoredCanvas = () => {
            if (!app._renderer.isRunning) app._renderCurrentFrame()
        }
        const rollback = async () => {
            const errors = []
            try {
                restoreLiveCanvas()
            } catch (err) {
                errors.push(err instanceof Error ? err : new Error(String(err)))
            }
            if (stage) {
                try {
                    const result = await stage.rollback()
                    if (!result?.success) {
                        errors.push(new Error(
                            result?.error || 'Unknown renderer restoration failure'))
                    }
                } catch (err) {
                    errors.push(err instanceof Error ? err : new Error(String(err)))
                } finally {
                    stage = null
                }
            }
            if (errors.length === 0) {
                try {
                    redrawRestoredCanvas()
                } catch (err) {
                    errors.push(err instanceof Error ? err : new Error(String(err)))
                }
            }
            if (errors.length === 0) return null
            if (errors.length === 1) return errors[0]
            return new Error(errors.map(error => error.message).join('; '))
        }

        try {
            // Raster and mask resources are prepared into detached maps. A
            // remote media layer has no transferable bytes, so its staged
            // placeholder is a transparent pixel rather than a missing strict
            // texture that would reject the otherwise-valid composition.
            for (const layer of layers) {
                if (layer.sourceType === 'drawing') {
                    const drawingCanvas = await app._createDrawingLayerCanvas(
                        layer, targetSize.width, targetSize.height)
                    if (drawingCanvas) {
                        candidate.mediaTextures.set(
                            layer.id,
                            app._renderer.prepareCanvasMediaResource(drawingCanvas))
                    }
                } else if (layer.sourceType === 'media') {
                    const placeholder = document.createElement('canvas')
                    placeholder.width = 1
                    placeholder.height = 1
                    candidate.mediaTextures.set(
                        layer.id, app._renderer.prepareCanvasMediaResource(placeholder))
                }
                if (layer.mask) {
                    candidate.maskTextures.set(
                        layer.id, app._renderer.prepareMaskTexture(layer.mask))
                }
            }

            // Resource preparation can await a lazy drawing-rasterizer import.
            // Preserve the same abort-on-race guarantee as mask decoding.
            if (!isCurrentSession(request)) {
                disposeCandidate()
                candidateOwned = false
                return false
            }
            if (shouldDeferApply()
                || JSON.stringify(buildNodeModel(app._layers, previousSize)) !== before) {
                disposeCandidate()
                candidateOwned = false
                return true
            }

            // Canonicalization (notably mask PNG encoding) is fallible. Build
            // the publish baseline before resizing live state or committing a
            // staged renderer candidate so failure remains fully rollbackable.
            candidateBaseline = buildNodeModel(layers, targetSize)
            app._finalizePendingUndo()
            snapshotTransaction = app._beginPublishTransaction()

            if (targetSize.width !== previousSize.width
                || targetSize.height !== previousSize.height) {
                app._resizeCanvas(targetSize.width, targetSize.height)
                await new Promise(resolve => queueMicrotask(resolve))
            }
            if (!isCurrentSession(request)) {
                restoreLiveCanvas()
                redrawRestoredCanvas()
                disposeCandidate()
                candidateOwned = false
                return false
            }

            stage = await app._renderer.stageLayerSet(candidate)
            candidateOwned = false
            if (!stage.success) {
                throw new Error(stage.error || 'Remote candidate render failed')
            }

            // Staging is fallible and asynchronous. If a local replacement or
            // direct mutation arrived meanwhile, restore the old renderer and
            // let the normal deferred-apply path retry from fresh nodes.
            if (!isCurrentSession(request)) {
                const restoreError = await rollback()
                if (restoreError) throw restoreError
                return false
            }
            if (shouldDeferApply()
                || JSON.stringify(buildNodeModel(app._layers, previousSize)) !== before) {
                const restoreError = await rollback()
                if (restoreError) throw restoreError
                return true
            }

            previousAppState = app._captureProjectCommitState()
            if (app._maskEditMode) {
                await app._exitMaskEditMode({ updateRenderer: false })
            }
            if (!isCurrentSession(request)) {
                const restoreError = await rollback()
                app._restoreProjectCommitState(previousAppState)
                if (restoreError) throw restoreError
                return false
            }
            app._layers = layers
            app._updateLayerStack()
            const nextSelection = app._validSelectionForLayers(
                layers,
                previousAppState.selectedLayerIds,
                previousAppState.selectionAnchor)
            if (app._layerStack) {
                app._layerStack.selectedLayerIds = nextSelection.selectedLayerIds
                app._layerStack._lastClickedLayerId = nextSelection.selectionAnchor
            }
            if (targetSize.width !== previousSize.width
                || targetSize.height !== previousSize.height) {
                app._selectionManager?.clearSelection()
            }
            app._markDirty()
            // Undo semantics v1 (documented per design doc §6): whole-state
            // snapshot undo also captures remote states. Undoing after a
            // remote apply restores the local pre-apply composition and — via
            // the same publish funnel every other mutation goes through —
            // republishes it as a new local edit, same behavior family as
            // the shipped DSL-text products.
            app._pushUndoState()

            // Every fallible candidate operation has succeeded. Commit owns
            // the staged resources and disposes the old set atomically; only
            // now invalidate callbacks captured from the prior composition.
            committed = true
            const committedStage = stage
            stage = null
            try {
                const commitResult = committedStage.commit()
                if (commitResult?.success === false) {
                    console.error('[Layers] Failed to retire remote project resources:',
                        commitResult.error || 'Unknown renderer cleanup failure')
                }
            } catch (err) {
                console.error('[Layers] Failed to retire remote project resources:', err)
            }
            app._replacementGeneration += 1
            if (nextLayerCounter !== null) bumpLayerCounter(nextLayerCounter)

            // Build from local layer objects so masks/strokes use this
            // browser's canonical encoding. The lifecycle lease prevents a
            // local edit from racing this successful commit snapshot.
            lastPublished = candidateBaseline

            if (!app._renderer.isRunning) {
                try {
                    await new Promise(resolve => requestAnimationFrame(resolve))
                    app._renderer.start()
                } catch (err) {
                    console.error('[Layers] Failed to restart renderer after remote apply:', err)
                }
            }

            if (mediaPlaceholderLayerIds.length > 0) {
                try {
                    toast.warning('This session includes a media layer, which can’t be shown here yet.')
                } catch (err) {
                    console.error('[Layers] Failed to show remote media warning:', err)
                }
            }
            return false
        } catch (err) {
            if (committed) throw err
            const errors = [err instanceof Error ? err : new Error(String(err))]
            const restoreError = await rollback()
            if (restoreError) errors.push(restoreError)
            if (previousAppState) {
                try {
                    app._restoreProjectCommitState(previousAppState)
                } catch (stateError) {
                    errors.push(stateError instanceof Error
                        ? stateError
                        : new Error(String(stateError)))
                }
            }
            if (candidateOwned) {
                try {
                    disposeCandidate()
                } catch (disposeError) {
                    errors.push(disposeError instanceof Error
                        ? disposeError
                        : new Error(String(disposeError)))
                }
            }
            if (errors.length === 1) throw errors[0]
            throw new Error(errors.map(error => error.message).join('; '))
        } finally {
            if (snapshotTransaction) app._endPublishTransaction(snapshotTransaction)
        }
    }

    // -- node-reject handling ---------------------------------------------

    function handleNodeReject({ id }) {
        // Remember what we last tried to send for this id so a later,
        // unrelated publish tick doesn't silently skip resending it just
        // because it still (optimistically) matches lastPublished — but
        // also don't hammer the server with the exact same doomed content:
        // publishComposition() below skips resending while the hash matches.
        const rejected = lastPublished.find(n => n.id === id)
        if (rejected) {
            rejectedNodeHashes.set(id, fnv1a(rejected.text))
            lastPublished = lastPublished.filter(n => n.id !== id)
        } else {
            prunePendingDeleteRejections()
            if (pendingDeleteRejections.delete(id)) {
                lastPublished = [
                    ...lastPublished,
                    { id, kind: '', text: '', parentId: null },
                ]
                armPendingDeleteExpiryTimer()
            }
        }

        if (!rejectToastCooldown) {
            rejectToastCooldown = true
            toast.warning('Some changes couldn’t be synced')
            setTimeout(() => { rejectToastCooldown = false }, REJECT_TOAST_COOLDOWN_MS)
        }
    }

    function nextLayerCounterPast(layers) {
        let max = -1
        const scan = (id) => {
            const m = /^layer-(\d+)$/.exec(String(id))
            if (!m) return
            const value = Number(m[1])
            if (!Number.isSafeInteger(value) || !Number.isSafeInteger(value + 1)) {
                throw new Error(`Remote project has unsafe layer id: ${id}`)
            }
            max = Math.max(max, value)
        }
        for (const layer of layers) {
            scan(layer.id)
            for (const child of layer.children || []) scan(child.id)
        }
        return max >= 0 ? max + 1 : null
    }

    function canvasDims() {
        return { width: app._canvas?.width || 0, height: app._canvas?.height || 0 }
    }

    function assertRemoteCompositionWithinBounds(nodes) {
        const rendererTextPredicate = app._renderer?._isTextEffect
        assertRemoteNodeModelWithinBounds(nodes, {
            isTextEffect: typeof rendererTextPredicate === 'function'
                ? rendererTextPredicate.bind(app._renderer)
                : undefined,
        })
    }

    async function assertRemoteCompositionSemantics(nodes) {
        const manifest = app._renderer?.manifest || {}
        const layerEffectIds = new Set(
            app._renderer?.getAllEffects?.().map(effect => effect.effectId) || [])
        const excludedStarterNamespaces = new Set([
            'mixer', 'render', 'points', '3d', 'filter3d',
        ])
        for (const [effectId, entry] of Object.entries(manifest)) {
            const namespace = effectId.split('/')[0]
            if (entry?.starter && !entry.externalTexture
                && !excludedStarterNamespaces.has(namespace)) {
                layerEffectIds.add(effectId)
            }
        }
        const childEffectIds = new Set(
            app._renderer?.getLayerEffects?.().map(effect => effect.effectId) || [])
        await assertRemoteNodeSemantics(nodes, {
            manifest,
            getEffectDefinition: effectId =>
                app._renderer?.getEffectDefinition?.(effectId),
            getDeclaredDslIdentifierValues: spec =>
                app._renderer?.getDeclaredDslIdentifierValues?.(spec) || [],
            layerEffectIds,
            childEffectIds,
        })
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
        const request = currentSessionRequest()
        if (!isCurrentSession(request) || !isOnline()) return
        if (publishTimer) return
        publishTimer = setTimeout(() => {
            publishTimer = null
            if (!isCurrentSession(request) || !isOnline()) return
            if (pendingSessionTransitionGeneration !== null) {
                schedulePublish()
                return
            }
            if (applyingRemote || app._publishTransactionDepth > 0) {
                // A local or remote transaction is mid-commit right now —
                // don't read and publish its candidate model.
                // Re-arm instead of dropping so this still fires once the
                // transaction finishes.
                schedulePublish()
                return
            }
            publishComposition(request)
        }, PUBLISH_DEBOUNCE_MS)
    }

    function publishComposition(request = currentSessionRequest()) {
        if (!isCurrentSession(request) || !isOnline()) return
        if (applyingRemote) {
            schedulePublish()
            return
        }
        const nextModel = buildNodeModel(app._layers, canvasDims())
        const { upserts, deletes } = diffNodeModels(lastPublished, nextModel)
        for (const node of upserts) {
            if (pendingDeleteRejections.delete(node.id)) armPendingDeleteExpiryTimer()
            const rejectedHash = rejectedNodeHashes.get(node.id)
            if (rejectedHash !== undefined) {
                if (rejectedHash === fnv1a(node.text)) continue // still the rejected content — wait for it to change
                rejectedNodeHashes.delete(node.id) // content changed since the reject — retry normally
            }
            request.layer.upsertNode(
                node.id, { kind: node.kind, text: node.text, parentId: node.parentId })
        }
        for (const id of deletes) {
            rememberPendingDeleteRejection(id)
            rejectedNodeHashes.delete(id)
            request.layer.deleteNode(id)
        }
        lastPublished = nextModel
    }

    // -- media gating -------------------------------------------------

    function hasMediaLayer() {
        return (app._layers || []).some(l => l.sourceType === 'media')
    }

    async function showUnsupportedMediaMessage() {
        bestEffortSessionEffect('Failed to hide collaboration dialog for media warning',
            () => dialog?.hide?.())
        try {
            await infoDialog.show({
                message: 'This composition has a media layer. Media layers aren’t supported in shared sessions yet — remove it before going online.'
            })
        } catch (err) {
            console.error('[Layers] Failed to show collaboration media warning:', err)
        }
    }

    // -- take online / join / go offline ---------------------------------

    async function runSessionTransition(intentGeneration, transition) {
        pendingSessionTransitionGeneration = intentGeneration
        try {
            return await transition()
        } finally {
            if (pendingSessionTransitionGeneration === intentGeneration) {
                pendingSessionTransitionGeneration = null
            }
        }
    }

    async function takeOnline() {
        const intentGeneration = ++transitionIntentGeneration
        return runSessionTransition(intentGeneration, () =>
            takeOnlineForIntent(intentGeneration))
    }

    async function takeOnlineForIntent(intentGeneration) {
        if (hasMediaLayer()) {
            await showUnsupportedMediaMessage()
            return null
        }
        const transition = await prepareSessionTransition(
            () => intentGeneration === transitionIntentGeneration)
        if (intentGeneration !== transitionIntentGeneration) {
            abandonSessionTransition(transition.layer)
            return null
        }
        const lifecycleToken = await app._acquireProjectLifecycle()
        try {
            if (intentGeneration !== transitionIntentGeneration) {
                abandonSessionTransition(transition.layer)
                return null
            }
            // A mutation that was ahead of this lifecycle request may have
            // added media after the optimistic preflight above. The leased
            // composition is the one that must satisfy the session gate.
            if (hasMediaLayer()) {
                abandonSessionTransition(transition.layer)
                await showUnsupportedMediaMessage()
                return null
            }
            const { layer, previous } = transition
            const transitionIntent = captureSessionTransitionIntent(intentGeneration)
            const nodes = buildNodeModel(app._layers, canvasDims())
            let committedSessionId
            try {
                expectedSeedSnapshots.set(layer, nodes)
                await layer.takeOnline({ poly: { programText: '', nodes } })
                if (!isCurrentSessionTransitionIntent(transitionIntent)) {
                    abandonSessionTransition(layer)
                    return null
                }
                committedSessionId = layer.getSessionId()
            } catch (err) {
                expectedSeedSnapshots.delete(layer)
                pendingSeedSnapshotApplies.delete(layer)
                bestEffortSessionEffect(
                    'Failed to clean up rejected collaboration session',
                    () => layer.goOffline?.())
                bestEffortSessionEffect(
                    'Failed to refresh collaboration status after rejection',
                    () => refreshStatus(previous ? getStatus() : 'offline'))
                throw err
            }
            activateSessionTransition(layer, nodes)
            finishSessionTransition(previous)
            bestEffortSessionEffect('Failed to remember collaboration session',
                () => rememberSessionId(committedSessionId))
            bestEffortSessionEffect('Failed to update collaboration session URL',
                () => writeSessionToBrowserUrl(committedSessionId))
            bestEffortSessionEffect('Failed to refresh collaboration status',
                () => refreshStatus())
            bestEffortSessionEffect('Failed to show collaboration confirmation',
                () => toast.success('Session is online'))
            return committedSessionId
        } finally {
            lifecycleToken.release()
        }
    }

    async function joinSession(sessionId, { skipConfirm = false } = {}) {
        const intentGeneration = ++transitionIntentGeneration
        return runSessionTransition(intentGeneration, () =>
            joinSessionForIntent(sessionId, { skipConfirm }, intentGeneration))
    }

    async function joinSessionForIntent(
        sessionId, { skipConfirm = false } = {}, intentGeneration) {
        const id = String(sessionId || '').trim()
        if (!id) return null

        let resolvedId = null
        let bootstrapReady = false
        let lifecycleToken = null
        while (!lifecycleToken) {
            const consentState = {
                mutationRevision: app._projectMutationRevision,
                sessionEpoch,
                hasComposition: hasComposition(),
            }
            if (!skipConfirm && consentState.hasComposition) {
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
            if (intentGeneration !== transitionIntentGeneration) return null

            if (resolvedId === null) {
                try {
                    resolvedId = await resolveJoinSessionId(id)
                } catch (err) {
                    await handleJoinFailure(err)
                    return null
                }
                if (intentGeneration !== transitionIntentGeneration) return null
            }
            if (!bootstrapReady) {
                const hadOnlineLayer = Boolean(online)
                let bootstrapLayer
                try {
                    bootstrapLayer = await ensureOnline(
                        () => intentGeneration === transitionIntentGeneration)
                } catch (err) {
                    await handleJoinFailure(err)
                    return null
                }
                if (intentGeneration !== transitionIntentGeneration) {
                    if (!hadOnlineLayer) abandonSessionTransition(bootstrapLayer)
                    return null
                }
                bootstrapReady = true
            }
            if (intentGeneration !== transitionIntentGeneration) return null
            lifecycleToken = await app._acquireProjectLifecycle()
            if (intentGeneration !== transitionIntentGeneration) {
                lifecycleToken.release()
                return null
            }
            if (skipConfirm || (
                consentState.mutationRevision === app._projectMutationRevision
                && consentState.sessionEpoch === sessionEpoch
                && consentState.hasComposition === hasComposition()
            )) break
            lifecycleToken.release()
            lifecycleToken = null
        }
        try {
            let layer
            let previous = null
            let joinedNodes
            let committedSessionId
            try {
                const transition = await prepareSessionTransition(
                    () => intentGeneration === transitionIntentGeneration)
                layer = transition.layer
                previous = transition.previous
                if (intentGeneration !== transitionIntentGeneration) {
                    abandonSessionTransition(layer)
                    return null
                }
                const transitionIntent = captureSessionTransitionIntent(intentGeneration)
                await layer.joinSession(resolvedId)
                if (!isCurrentSessionTransitionIntent(transitionIntent)) {
                    abandonSessionTransition(layer)
                    return null
                }
                joinedNodes = layer.getNodes()
                assertRemoteCompositionWithinBounds(joinedNodes)
                if (!isLayersSession(joinedNodes)) {
                    refuseSession(layer)
                    return null
                }
                await assertRemoteCompositionSemantics(joinedNodes)
                if (!isCurrentSessionTransitionIntent(transitionIntent)) {
                    abandonSessionTransition(layer)
                    return null
                }
                committedSessionId = layer.getSessionId()
            } catch (err) {
                await handleJoinFailure(err, layer)
                return null
            }

            const previousSessionState = captureSessionState()
            activateSessionTransition(layer, joinedNodes)
            const applyResult = await applyJoinedSession(
                currentSessionRequest(layer), lifecycleToken)
            if (!applyResult.success) {
                restoreSessionState(previousSessionState)
                await handleJoinFailure(applyResult.error, layer)
                return null
            }
            finishSessionTransition(previous)
            bestEffortSessionEffect('Failed to remember collaboration session',
                () => rememberSessionId(committedSessionId))
            bestEffortSessionEffect('Failed to update collaboration session URL',
                () => writeSessionToBrowserUrl(committedSessionId))
            bestEffortSessionEffect('Failed to refresh collaboration status',
                () => refreshStatus())
            bestEffortSessionEffect('Failed to show collaboration confirmation',
                () => toast.success('Joined session'))
            return committedSessionId
        } finally {
            lifecycleToken.release()
        }
    }

    async function joinFromUrl() {
        const sessionId = readSessionIdFromLocation(location)
        if (!sessionId) return false
        const result = await joinSession(sessionId, { skipConfirm: true })
        return result !== null
    }

    function goOffline() {
        transitionIntentGeneration++
        pendingSessionTransitionGeneration = null
        expectedSeedSnapshots.clear()
        pendingSeedSnapshotApplies.clear()
        if (!online) return
        let disconnectError = null
        try {
            online.goOffline()
        } catch (err) {
            disconnectError = err
        }
        if (disconnectError && isConnected(online)) throw disconnectError
        if (disconnectError) {
            console.error('[Layers] Collaboration disconnect reported an error after going offline:',
                disconnectError)
        }
        sessionEpoch++
        clearScheduledSessionWork()
        rejectedNodeHashes.clear()
        clearPendingDeleteRejections()
        lastPublished = []
        bestEffortSessionEffect('Failed to clear collaboration session URL',
            () => writeSessionToBrowserUrl(null))
        bestEffortSessionEffect('Failed to refresh offline collaboration status',
            () => refreshStatus('offline'))
        bestEffortSessionEffect('Failed to show offline confirmation',
            () => toast.info('Offline'))
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

    async function handleJoinFailure(err, failedLayer = online) {
        if (isDialectMismatch(err)) {
            refuseSession(failedLayer)
            return
        }
        bestEffortSessionEffect('Failed to clean up rejected collaboration session',
            () => failedLayer?.goOffline?.())
        bestEffortSessionEffect('Failed to refresh collaboration status after rejection',
            () => refreshStatus(failedLayer === online ? 'offline' : getStatus()))
        console.error('[Layers] Seance join failed:', err)
        bestEffortSessionEffect('Failed to show collaboration join error',
            () => toast.error(`Could not join session: ${err?.message || err}`))
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
        isApplyingRemote: () => applyingRemote,
        getSessionIdentity: () => sessionEpoch,
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
