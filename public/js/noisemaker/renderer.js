/**
 * Layers Renderer - Wrapper around Noisemaker CanvasRenderer
 *
 * Manages a layer stack and builds DSL programs to composite
 * media and effects using Noisemaker's blendMode effect.
 *
 * @module noisemaker/renderer
 */

import {
    CanvasRenderer,
    getAllEffects,
    formatDslError,
    _bundle,
} from './bundle.js'

const DSL_IDENTIFIER_PATTERN = /^[_A-Za-z][_A-Za-z0-9]*$/

/**
 * Extract manifest-known effect ids referenced by a DSL program, WITHOUT
 * compiling it. Used to discover which effects to load before compile — a
 * compile-based extractor (the engine's extractEffectsFromDsl) resolves
 * against the registered-effects registry and silently drops exactly the
 * unregistered effects this discovery step exists to find.
 *
 * Ported verbatim from the engine's legacy extractEffectNamesFromDsl, whose
 * export is being retired upstream; layers only ever parses DSL it emits
 * itself (plus tryCompile input built the same way), so owning the extractor
 * pins discovery behavior to our own emission grammar. Handles the
 * `from(namespace, call(...))` qualifier this renderer emits for colliding
 * short names, dotted `ns.name(...)` calls, and unqualified calls resolved
 * through the program's `search` line. Over-approximation is safe (loading
 * an extra effect is harmless); under-approximation breaks compile.
 *
 * @param {string} dsl - DSL source
 * @param {object} manifest - effectId → manifest entry
 * @returns {Array<{effectId: string, namespace: string, name: string}>}
 */
function extractEffectIdsFromDsl(dsl, manifest) {
    const effects = []
    if (!dsl || typeof dsl !== 'string') return effects
    const lines = dsl.split('\n')
    let searchNamespaces = []
    for (const line of lines) {
        const trimmed = line.trim()
        const statements = trimmed.split(';').map(s => s.trim()).filter(s => s)
        for (const stmt of statements) {
            if (stmt.startsWith('search ')) {
                searchNamespaces = stmt.slice(7).split(',').map(s => s.trim())
                continue
            }
            if (!stmt || stmt.startsWith('//')) continue

            // from(namespace, call(...)) — explicit per-call qualification
            const fromPattern = /\bfrom\s*\(\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*,\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/g
            let fromMatch
            while ((fromMatch = fromPattern.exec(stmt)) !== null) {
                const namespace = fromMatch[1]
                const name = fromMatch[2]
                const effectId = `${namespace}/${name}`
                if (manifest[effectId] && !effects.find(e => e.effectId === effectId)) {
                    effects.push({ effectId, namespace, name })
                }
            }

            const callPattern = /\b([a-zA-Z_][a-zA-Z0-9_]*(?:\.[a-zA-Z_][a-zA-Z0-9_]*)?)\s*\(/g
            let match
            while ((match = callPattern.exec(stmt)) !== null) {
                const fullName = match[1]
                let namespace = null
                let name = fullName
                if (fullName.includes('.')) {
                    const parts = fullName.split('.')
                    namespace = parts[0]
                    name = parts[1]
                }
                const builtins = ['read', 'out', 'vec2', 'vec3', 'vec4', 'from']
                if (builtins.includes(name)) continue
                if (!namespace && searchNamespaces.length > 0) {
                    for (const ns of searchNamespaces) {
                        const testId = `${ns}/${name}`
                        if (manifest[testId]) {
                            namespace = ns
                            break
                        }
                    }
                }
                if (!namespace) {
                    // Legacy discovery fallback for calls the search line
                    // doesn't resolve (including search-less programs); kept
                    // for parity with the engine implementation. Discovery
                    // order is unrelated to compile-time resolution order.
                    for (const ns of ['classicNoisedeck', 'filter', 'mixer', 'synth']) {
                        const testId = `${ns}/${name}`
                        if (manifest[testId]) {
                            namespace = ns
                            break
                        }
                    }
                }
                if (namespace) {
                    const effectId = `${namespace}/${name}`
                    if (!effects.find(e => e.effectId === effectId)) {
                        effects.push({ effectId, namespace, name })
                    }
                }
            }
        }
    }
    return effects
}
const VOLUME_IDENTIFIERS = Array.from({ length: 8 }, (_, index) => `vol${index}`)
const GEOMETRY_IDENTIFIERS = Array.from({ length: 8 }, (_, index) => `geo${index}`)

function getDeclaredDslIdentifierValues(spec) {
    if (spec?.type === 'member') {
        if (typeof spec.enum !== 'string' || !DSL_IDENTIFIER_PATTERN.test(spec.enum)) {
            return []
        }
        const declaredEnum = _bundle.stdEnums?.[spec.enum]
        if (!declaredEnum || typeof declaredEnum !== 'object') return []
        return Object.keys(declaredEnum)
            .filter(member => DSL_IDENTIFIER_PATTERN.test(member))
            .map(member => `${spec.enum}.${member}`)
    }
    if (spec?.type === 'volume') return VOLUME_IDENTIFIERS
    if (spec?.type === 'geometry') return GEOMETRY_IDENTIFIERS
    return []
}

export class LayersRenderer {
    constructor(canvas, options = {}) {
        this._canvas = canvas
        this.width = options.width || canvas?.width || 1024
        this.height = options.height || canvas?.height || 1024
        this.loopDuration = options.loopDuration || 10

        const NOISEMAKER_BASE = 'https://shaders.noisedeck.app/1'

        this._renderer = new CanvasRenderer({
            canvas,
            canvasContainer: canvas?.parentElement || null,
            width: this.width,
            height: this.height,
            basePath: NOISEMAKER_BASE,
            preferWebGPU: false,
            useBundles: true,
            bundlePath: `${NOISEMAKER_BASE}/effects`,
            alpha: true,
            onFPS: options.onFPS,
            onError: options.onError
        })

        this._initialized = false
        this._layers = []
        this._currentDsl = ''
        this._mediaTextures = new Map()
        this._maskTextures = new Map()
        this._textCanvases = new Map()
        this._videoUpdateRAF = null
        this._pausedNormalizedTime = null
        this._layerStepMap = new Map()
        // Serial queue for pipeline mutations (rebuild/tryCompile). The app
        // has fire-and-forget rebuild call sites, so overlapping calls would
        // otherwise interleave their compile + post-compile steps.
        this._compileTail = Promise.resolve()
        // A staged project swap retains the previous renderer state until the
        // app synchronously commits or explicitly rolls it back. Ordinary
        // setLayers() calls wait here so they cannot overwrite a staged map.
        this._stageBarrier = Promise.resolve()
    }

    getDeclaredDslIdentifierValues(spec) {
        return getDeclaredDslIdentifierValues(spec)
    }

    isDeclaredDslIdentifier(spec, value) {
        return typeof value === 'string'
            && getDeclaredDslIdentifierValues(spec).includes(value)
    }

    get canvas() {
        return this._renderer.canvas || this._canvas
    }

    get isRunning() {
        return this._renderer.isRunning
    }

    get currentDsl() {
        return this._currentDsl
    }

    get manifest() {
        return this._renderer.manifest
    }

    get layers() {
        return this._layers
    }

    async init() {
        if (this._initialized) return

        await this._renderer.loadManifest()
        this._renderer.setLoopDuration(this.loopDuration)
        this._initialized = true
    }

    start() {
        let restoreError = null
        if (this._pausedNormalizedTime !== null) {
            try {
                this.restoreLoopFromNormalizedTime(this._pausedNormalizedTime)
            } catch (err) {
                restoreError = err
            }
            this._pausedNormalizedTime = null
        }
        this._startVideoUpdateLoop()
        this._renderer.start()
        if (restoreError) throw restoreError
    }

    stop() {
        if (this.isRunning || this._pausedNormalizedTime === null) {
            this._pausedNormalizedTime = this._computeNormalizedLoopTime()
        }
        this._stopVideoUpdateLoop()
        this._renderer.stop()
    }

    _startVideoUpdateLoop() {
        if (this._videoUpdateRAF) return

        const updateVideoTextures = () => {
            this._updateVideoTextures()
            this._videoUpdateRAF = requestAnimationFrame(updateVideoTextures)
        }
        this._videoUpdateRAF = requestAnimationFrame(updateVideoTextures)
    }

    _stopVideoUpdateLoop() {
        if (this._videoUpdateRAF) {
            cancelAnimationFrame(this._videoUpdateRAF)
            this._videoUpdateRAF = null
        }
    }

    _updateVideoTextures() {
        // Runs on every animation frame. Skip the pipeline-pass walk and its
        // allocations entirely unless at least one loaded media is a video, so
        // the common image-only case costs nothing per frame.
        if (!this._hasVideoMedia()) return

        const allStepIndices = this._getMediaStepIndices()
        if (!allStepIndices) return

        // Filter out media step indices that belong to mask textures
        const maskStepIndices = this._getMaskMediaStepIndices()
        const stepIndices = allStepIndices.filter(idx => !maskStepIndices.has(idx))

        const visibleMediaLayers = this._layers.filter(l => l.visible && (l.sourceType === 'media' || l.sourceType === 'drawing'))

        for (let i = 0; i < visibleMediaLayers.length && i < stepIndices.length; i++) {
            const layer = visibleMediaLayers[i]
            const media = this._mediaTextures.get(layer.id)
            if (!media || media.type !== 'video') continue

            // Per-frame uploads must run through the same CPU scale/flip as
            // updateLayerTransform, or each new video frame would clobber
            // the transformed texture with the raw element and the layer's
            // flip/scale would never stick. (Rotation is a shader uniform —
            // unaffected by uploads.)
            const scaleX = layer.scaleX ?? 1
            const scaleY = layer.scaleY ?? 1
            const flipH = layer.flipH || false
            const flipV = layer.flipV || false
            const source = (scaleX !== 1 || scaleY !== 1 || flipH || flipV)
                ? this._drawTransformedMediaFrame(media, scaleX, scaleY, flipH, flipV)
                : media.element

            try {
                this._renderer.updateTextureFromSource?.(`imageTex_step_${stepIndices[i]}`, source, { flipY: false })
            } catch {
                // Silently ignore texture update errors during playback
            }
        }
    }

    /**
     * Draw a media element's current frame into a per-media canvas with
     * CPU-side scale/flip applied (no rotation — the shader's rotation
     * uniform handles that without bounding-box inflation). The canvas is
     * cached on the media descriptor so per-frame video redraws reuse it;
     * it is released with the descriptor on unloadMedia.
     *
     * Must be an HTMLCanvasElement, NOT an OffscreenCanvas: the engine's
     * updateTextureFromSource silently ignores OffscreenCanvas sources
     * (verified empirically — no throw, no texture update), which is why
     * the pre-refactor transform path never actually flipped pixels.
     * Every working upload path here (masks, text) uses a DOM canvas.
     * @param {{element: CanvasImageSource, width: number, height: number, transformCanvas?: HTMLCanvasElement}} media
     * @param {number} scaleX
     * @param {number} scaleY
     * @param {boolean} flipH
     * @param {boolean} flipV
     * @returns {HTMLCanvasElement}
     * @private
     */
    _drawTransformedMediaFrame(media, scaleX, scaleY, flipH, flipV) {
        const destW = Math.max(1, Math.ceil(media.width * Math.abs(scaleX)))
        const destH = Math.max(1, Math.ceil(media.height * Math.abs(scaleY)))

        let canvas = media.transformCanvas
        if (!canvas || canvas.width !== destW || canvas.height !== destH) {
            canvas = document.createElement('canvas')
            canvas.width = destW
            canvas.height = destH
            media.transformCanvas = canvas
        }
        const ctx = canvas.getContext('2d')

        ctx.clearRect(0, 0, destW, destH)
        ctx.imageSmoothingEnabled = true
        ctx.imageSmoothingQuality = 'high'
        ctx.save()
        ctx.translate(destW / 2, destH / 2)
        ctx.scale(flipH ? -1 : 1, flipV ? -1 : 1)
        ctx.drawImage(media.element, -destW / 2, -destH / 2, destW, destH)
        ctx.restore()
        return canvas
    }

    /**
     * @returns {boolean} true if any loaded media texture is a video.
     * @private
     */
    _hasVideoMedia() {
        for (const media of this._mediaTextures.values()) {
            if (media.type === 'video') return true
        }
        return false
    }

    /**
     * Get deduplicated step indices for all media effect passes
     * @returns {number[]|null} Step indices, or null if pipeline unavailable
     * @private
     */
    _getMediaStepIndices() {
        const passes = this._renderer.pipeline?.graph?.passes
        if (!passes) return null

        const indices = []
        for (const pass of passes) {
            if (pass.effectFunc === 'media' || pass.effectKey === 'media') {
                indices.push(pass.stepIndex)
            }
        }
        return [...new Set(indices)]
    }

    resize(width, height) {
        this.width = width
        this.height = height
        this._renderer.resize?.(width, height)
    }

    render(normalizedTime) {
        this._renderer.render(normalizedTime)
    }

    /**
     * Compute the normalized loop time the inner renderer would emit right now.
     * Used by the video export pipeline to snapshot the live render position
     * before pausing, so playback can resume from the same point afterwards.
     * @returns {number} normalized loop position in [0, 1)
     */
    getPausedNormalizedTime() {
        if (!this.isRunning && this._pausedNormalizedTime !== null) {
            return this._pausedNormalizedTime
        }
        return this._computeNormalizedLoopTime()
    }

    /** @private */
    _computeNormalizedLoopTime() {
        const inner = this._renderer
        const loopDuration = inner._loopDuration
        if (!loopDuration || !isFinite(loopDuration) || loopDuration <= 0) return 0
        const elapsedSeconds = (performance.now() - inner._loopStartTime) / 1000
        return (elapsedSeconds % loopDuration) / loopDuration
    }

    /**
     * Restore the inner renderer's loop clock so a subsequent start() resumes
     * playback at the given normalized position. Caller is responsible for
     * invoking start() afterwards.
     * @param {number} normalized - normalized loop position in [0, 1)
     */
    restoreLoopFromNormalizedTime(normalized) {
        const inner = this._renderer
        const loopDuration = inner._loopDuration
        if (!loopDuration || !isFinite(loopDuration) || loopDuration <= 0) return
        const pausedElapsedSeconds = normalized * loopDuration
        inner._loopStartTime = performance.now() - (pausedElapsedSeconds * 1000)
    }

    /**
     * Iterate over video media textures attached to the renderer.
     * Yields a stable, public-shape descriptor `{ videoElement, duration }`
     * for each video so callers (e.g. the export pipeline) can seek without
     * reaching into the internal media-textures Map.
     * @returns {Iterable<{ videoElement: HTMLVideoElement, duration: number }>}
     */
    *getVideoMediaIterator() {
        for (const [, media] of this._mediaTextures) {
            if (media.type !== 'video') continue
            const videoElement = media.element
            const duration = videoElement?.duration
            if (videoElement && isFinite(duration) && duration > 0) {
                yield { videoElement, duration }
            }
        }
    }

    /**
     * Public wrapper for the per-frame video texture update used by the
     * export pipeline. Equivalent to the internal RAF-driven update.
     */
    updateVideoTextures() {
        this._updateVideoTextures()
    }

    async setLayers(layers, options = {}) {
        await this._stageBarrier
        if (options.isCurrent && !options.isCurrent()) {
            return { success: true, stale: true }
        }
        this._layers = layers
        const { isCurrent, ...rebuildOptions } = options
        return this.rebuild(rebuildOptions)
    }

    /**
     * Temporarily install a complete, detached layer/resource set and compile
     * it while retaining the previous renderer state. The caller must invoke
     * exactly one of commit() or rollback() on the returned handle.
     *
     * @param {object} candidate
     * @param {Array} candidate.layers
     * @param {Map<string, object>} candidate.mediaTextures
     * @param {Map<string, object>} candidate.maskTextures
     * @returns {Promise<{success:boolean,error?:string,commit:Function,rollback:Function}>}
     */
    async stageLayerSet({ layers, mediaTextures, maskTextures }) {
        const waitForTurn = this._stageBarrier
        let releaseStage
        const stageGate = new Promise(resolve => { releaseStage = resolve })
        this._stageBarrier = waitForTurn.then(() => stageGate)
        await waitForTurn

        let previous
        const staged = {
            layers,
            mediaTextures,
            maskTextures,
            textCanvases: new Map()
        }
        const retireMap = (retired, surviving, dispose = null) => {
            const survivingResources = new Set(surviving.values())
            const disposedResources = new Set()
            for (const [key, resource] of retired) {
                if (survivingResources.has(resource)) continue
                if (dispose && !disposedResources.has(resource)) {
                    try {
                        dispose(resource)
                    } catch (err) {
                        console.error('[Layers] Failed to retire staged renderer resource:', err)
                    }
                    disposedResources.add(resource)
                }
                retired.delete(key)
            }
        }

        let result
        try {
            result = await this._serializeCompileOp(() => {
                previous = {
                    layers: this._layers,
                    mediaTextures: this._mediaTextures,
                    maskTextures: this._maskTextures,
                    textCanvases: this._textCanvases
                }
                this._layers = staged.layers
                this._mediaTextures = staged.mediaTextures
                this._maskTextures = staged.maskTextures
                this._textCanvases = staged.textCanvases
                return this._rebuildNow({ force: true, strictTextures: true })
            })
        } catch (err) {
            result = { success: false, error: err.message || String(err) }
        }

        let settled = false
        const release = () => {
            if (settled) return false
            settled = true
            releaseStage()
            return true
        }

        return {
            ...result,
            commit: () => {
                if (!release()) return { success: true }
                retireMap(previous.mediaTextures, staged.mediaTextures,
                    resource => this.disposeMediaResource(resource))
                retireMap(previous.maskTextures, staged.maskTextures)
                retireMap(previous.textCanvases, staged.textCanvases)
                return { success: true }
            },
            rollback: async () => {
                if (settled) return { success: true }
                this._layers = previous.layers
                this._mediaTextures = previous.mediaTextures
                this._maskTextures = previous.maskTextures
                this._textCanvases = previous.textCanvases
                let restoreResult
                try {
                    restoreResult = await this._serializeCompileOp(
                        () => this._rebuildNow({ force: true, strictTextures: true }))
                } finally {
                    retireMap(staged.mediaTextures, previous.mediaTextures,
                        resource => this.disposeMediaResource(resource))
                    retireMap(staged.maskTextures, previous.maskTextures)
                    retireMap(staged.textCanvases, previous.textCanvases)
                    release()
                }
                return restoreResult
            }
        }
    }

    /**
     * Run an async pipeline mutation exclusively, after any in-flight one
     * settles (success or failure). Mirrors the agent dispatcher's serial
     * queue. Without this, overlapping rebuilds would race their compiles
     * and interleave post-compile texture/param application on the shared
     * pipeline.
     * @template T
     * @param {() => Promise<T>} fn
     * @returns {Promise<T>}
     * @private
     */
    _serializeCompileOp(fn) {
        const next = this._compileTail.then(fn, fn)
        this._compileTail = next.catch(() => {})
        return next
    }

    /**
     * Rebuild DSL from current layers and recompile.
     * Overlapping calls are serialized; each queued rebuild reads the layer
     * state current at the time it runs, so a burst of rebuilds coalesces
     * into one compile of the latest state plus cheap no-ops.
     * @param {object} [options={}] - Options
     * @param {boolean} [options.force=false] - Force rebuild even if DSL unchanged (needed after layer reorder)
     * @returns {Promise<{success: boolean, error?: string}>}
     */
    rebuild(options = {}) {
        return this._serializeCompileOp(() => this._rebuildNow(options))
    }

    /**
     * The rebuild body. Must only run inside _serializeCompileOp.
     * @private
     */
    async _rebuildNow(options = {}) {
        const { force = false, strictTextures = false } = options

        if (!this._initialized) {
            await this.init()
        }

        let dsl = ''
        try {
            dsl = this._buildDsl()

            // force=true is needed after layer reorder because the DSL may be
            // string-identical but the layer-to-step mapping needs to be rebuilt
            if (dsl === this._currentDsl && !force) {
                return { success: true }
            }

            console.debug('[LayersRenderer] Built DSL:', dsl)

            await this._loadAndCompile(dsl)
            // Record the DSL only after it compiled: a failed compile must
            // not make the next rebuild short-circuit on the dedup check
            // above and report success against a stale pipeline.
            this._currentDsl = dsl
            this._normalizeColorUniforms()

            this._buildLayerStepMap()
            this._uploadMediaTextures({ strict: strictTextures })
            this._uploadMaskTextures({ strict: strictTextures })
            this._uploadTextTextures({ strict: strictTextures })
            this._applyAllLayerParams({ strict: strictTextures })

            return { success: true }
        } catch (err) {
            this._logDslError('Compilation error', dsl, err)
            return { success: false, error: err.message || String(err) }
        }
    }

    /**
     * Try to compile DSL without rebuilding layer state.
     * Serialized with rebuild(): both mutate the shared pipeline.
     * @param {string} dsl - DSL to compile
     * @returns {Promise<{success: boolean, error?: string}>}
     */
    async tryCompile(dsl) {
        if (!dsl?.trim()) {
            return { success: true }
        }

        return this._serializeCompileOp(async () => {
            try {
                await this._loadAndCompile(dsl)
                this._normalizeColorUniforms()
                return { success: true }
            } catch (err) {
                this._logDslError('tryCompile failed', dsl, err)
                return { success: false, error: err.message || String(err) }
            }
        })
    }

    /**
     * Log a DSL compile error with caret-pointed source context when available.
     * @private
     */
    _logDslError(label, source, err) {
        const formatted = source && typeof formatDslError === 'function'
            ? formatDslError(source, err)
            : null
        if (formatted) {
            console.error(`[LayersRenderer] ${label}:\n${formatted}`)
        } else {
            console.error(`[LayersRenderer] ${label}:`, err)
        }
    }

    /**
     * Load any unregistered effects referenced by the DSL, then compile it
     * @param {string} dsl - DSL to compile
     * @returns {Promise<void>}
     * @private
     */
    async _loadAndCompile(dsl) {
        const effectData = extractEffectIdsFromDsl(dsl, this._renderer.manifest || {})
        const registeredEffects = getAllEffects()

        const effectIdsToLoad = effectData
            .map(e => e.effectId)
            .filter(id => {
                const dotKey = id.replace('/', '.')
                return !registeredEffects.has(id) && !registeredEffects.has(dotKey)
            })

        if (effectIdsToLoad.length > 0) {
            await this._renderer.loadEffects(effectIdsToLoad)
        }

        await this._renderer.compile(dsl)
    }

    buildDslFromLayers(layers) {
        const originalLayers = this._layers
        this._layers = layers
        const dsl = this._buildDsl()
        this._layers = originalLayers
        return dsl
    }

    _buildLayerStepMap() {
        this._layerStepMap.clear()

        const passes = this._renderer.pipeline?.graph?.passes
        if (!passes) return

        const visibleLayers = this._layers.filter(l => l.visible)
        const effectTypeCounts = {}

        /**
         * Find the nth occurrence of effectName in pipeline passes and map it.
         * @param {string} id - Layer or child ID
         * @param {string} effectName - Effect function name
         */
        const mapStepIndex = (id, effectName) => {
            const seenCount = effectTypeCounts[effectName] || 0
            effectTypeCounts[effectName] = seenCount + 1

            let matchCount = 0
            for (const pass of passes) {
                if (pass.effectFunc === effectName || pass.effectKey === effectName) {
                    if (matchCount === seenCount) {
                        this._layerStepMap.set(id, pass.stepIndex)
                        return
                    }
                    matchCount++
                }
            }
        }

        for (const layer of visibleLayers) {
            const effectName = (layer.sourceType === 'media' || layer.sourceType === 'drawing')
                ? 'media'
                : layer.effectId?.split('/')[1]

            if (effectName) {
                mapStepIndex(layer.id, effectName)
            }

            for (const child of (layer.children || [])) {
                if (!child.visible) continue
                const childEffectName = child.effectId?.split('/')[1]
                if (childEffectName) {
                    mapStepIndex(child.id, childEffectName)
                }
            }

            // Map mask media step — the media() call inside alphaMask(tex: media(), ...)
            // This must come after children to match DSL generation order
            if (layer.mask && layer.maskEnabled !== false) {
                mapStepIndex(`mask_${layer.id}`, 'media')
            }
        }
    }

    updateLayerParams(layerId, params) {
        const stepIndex = this._layerStepMap.get(layerId)
        if (stepIndex === undefined) {
            console.warn(`[LayersRenderer] No step index for layer ${layerId}`)
            return
        }

        this._renderer.applyStepParameterValues?.({ [`step_${stepIndex}`]: params })

        const layer = this._layers.find(l => l.id === layerId)
        if (layer && this._isTextEffect(layer.effectId)) {
            this._renderTextCanvas(layerId, { ...(layer.effectParams || {}), ...params })
        }
    }

    /**
     * Find a layer by id, searching both top-level layers and their nested
     * child effects. Child effects live under a parent's `children`, not in the
     * top-level list, so a plain `_layers.find` misses them.
     * @param {string} layerId
     * @returns {object|null}
     * @private
     */
    _findLayerOrChild(layerId) {
        const top = this._layers.find(l => l.id === layerId)
        if (top) return top
        for (const parent of this._layers) {
            const child = parent.children?.find(c => c.id === layerId)
            if (child) return child
        }
        return null
    }

    /**
     * Whether changing a layer's effect params from `prevParams` to `nextParams`
     * alters any compile-time parameter — a global declared with `define:`, which
     * the engine bakes into the shader as a GLSL `#define` / WGSL const at compile
     * time instead of a runtime uniform. Such params are absent from pass.uniforms,
     * so applyStepParameterValues() silently skips them; only a recompile (rebuild)
     * can change them. The value is part of the DSL, so a rebuild picks it up and
     * the engine caches one compiled variant per define value.
     *
     * General across every effect: keys off the effect definition, never param
     * names, so halftone mode/pattern, noise noiseType, and any future
     * define-backed control are all covered. Returns false when the layer/effect
     * is unknown or only runtime-uniform params changed.
     *
     * @param {string} layerId
     * @param {object} prevParams - effect params before the change
     * @param {object} nextParams - effect params after the change
     * @returns {boolean}
     */
    layerParamsNeedRecompile(layerId, prevParams = {}, nextParams = {}) {
        const layer = this._findLayerOrChild(layerId)
        if (!layer?.effectId) return false
        // Slash-keyed registry, same lookup as _buildEffectCall().
        const globals = getAllEffects().get(layer.effectId)?.globals
        if (!globals) return false
        for (const [name, spec] of Object.entries(globals)) {
            if (!spec?.define) continue
            // ?? (not ||) so a legitimate falsy value like mode 0 isn't treated
            // as unset and replaced by the default.
            const prev = prevParams?.[name] ?? spec.default
            const next = nextParams?.[name] ?? spec.default
            if (!Object.is(prev, next)) return true
        }
        return false
    }

    updateLayerOffset(layerId, x, y) {
        const stepIndex = this._layerStepMap.get(layerId)
        if (stepIndex === undefined) return

        const clamp = (v) => Math.max(-100, Math.min(100, v))
        this._renderer.applyStepParameterValues?.({
            [`step_${stepIndex}`]: {
                offsetX: clamp((x / this.width) / 1.5 * 100),
                offsetY: clamp((y / this.height) / 1.5 * 100)
            }
        })
    }

    /**
     * Update layer transform.
     * Scale and flip are applied CPU-side via `_drawTransformedMediaFrame`,
     * which draws into a per-media DOM canvas — NOT an OffscreenCanvas, which
     * the engine's updateTextureFromSource silently ignores (see the note in
     * that helper).
     * Rotation uses the shader's built-in rotation uniform to avoid
     * bounding-box inflation that would make the image appear scaled.
     * @param {string} layerId
     * @param {{scaleX: number, scaleY: number, rotation: number, flipH: boolean, flipV: boolean}} transform
     * @param {number} offsetX
     * @param {number} offsetY
     * @param {{strict?: boolean}} options
     */
    updateLayerTransform(layerId, transform, offsetX, offsetY, { strict = false } = {}) {
        const stepIndex = this._layerStepMap.get(layerId)
        if (stepIndex === undefined) return

        const media = this._mediaTextures.get(layerId)
        if (!media) return

        const { scaleX = 1, scaleY = 1, rotation = 0, flipH = false, flipV = false } = transform
        const needsCpuTransform = scaleX !== 1 || scaleY !== 1 || flipH || flipV

        const textureId = `imageTex_step_${stepIndex}`
        const srcW = media.width
        const srcH = media.height

        if (!needsCpuTransform && rotation === 0) {
            // Full identity: restore original texture
            try {
                this._renderer.updateTextureFromSource?.(textureId, media.element, { flipY: false })
                if (srcW > 0 && srcH > 0) {
                    this._renderer.applyStepParameterValues?.({
                        [`step_${stepIndex}`]: { imageSize: [srcW, srcH], rotation: 0 }
                    })
                }
            } catch (err) {
                if (strict) throw err
                console.warn(`[LayersRenderer] Failed to restore texture for layer ${layerId}:`, err)
            }
            this.updateLayerOffset(layerId, offsetX, offsetY)
            return
        }

        if (needsCpuTransform) {
            // CPU-side scale and flip (no rotation — shader handles that).
            // Same helper as the per-frame video path, so a video's next
            // frame upload reproduces this transform instead of clobbering it.
            const canvas = this._drawTransformedMediaFrame(media, scaleX, scaleY, flipH, flipV)

            try {
                this._renderer.updateTextureFromSource?.(textureId, canvas, { flipY: false })
                this._renderer.applyStepParameterValues?.({
                    [`step_${stepIndex}`]: { imageSize: [canvas.width, canvas.height], rotation }
                })
            } catch (err) {
                if (strict) throw err
                console.warn(`[LayersRenderer] Failed to upload transformed texture for layer ${layerId}:`, err)
            }
        } else {
            // Rotation only — use original texture, shader handles rotation
            try {
                this._renderer.updateTextureFromSource?.(textureId, media.element, { flipY: false })
                this._renderer.applyStepParameterValues?.({
                    [`step_${stepIndex}`]: { imageSize: [srcW, srcH], rotation }
                })
            } catch (err) {
                if (strict) throw err
                console.warn(`[LayersRenderer] Failed to restore texture for layer ${layerId}:`, err)
            }
        }

        this.updateLayerOffset(layerId, offsetX, offsetY)
    }

    /**
     * Update the DSL string from current layers without recompiling.
     * Call this after parameter-only changes to keep DSL in sync and
     * prevent spurious rebuilds on subsequent structural changes.
     */
    syncDsl() {
        if (this._layers.length > 0) {
            this._currentDsl = this._buildDsl()
        }
    }

    updateLayerOpacity(layerId, opacity) {
        const passes = this._renderer.pipeline?.graph?.passes
        if (!passes) return

        const layer = this._layers.find(l => l.id === layerId)
        if (!layer) return

        const visibleLayers = this._layers.filter(l => l.visible)
        const layerIndex = visibleLayers.indexOf(layer)
        if (layerIndex < 0) return

        const baseSolid = visibleLayers[0]?.effectId === 'synth/solid'
        const blendPasses = passes.filter(p =>
            p.effectFunc === 'blendMode' || p.effectKey === 'blendMode'
        )

        // Solid base has no blend pass, so non-base layers use index-1
        const blendPassIndex = baseSolid ? layerIndex - 1 : layerIndex

        if (blendPassIndex >= 0 && blendPassIndex < blendPasses.length) {
            const { stepIndex } = blendPasses[blendPassIndex]
            this._renderer.applyStepParameterValues?.({
                [`step_${stepIndex}`]: { mixAmt: this._opacityToMixAmt(opacity, layer.blendMode) }
            })
        }
    }

    _applyAllLayerParams({ strict = false } = {}) {
        for (let i = 0; i < this._layers.length; i++) {
            const layer = this._layers[i]
            const isBaseSolid = i === 0 && layer.effectId === 'synth/solid'

            if (layer.effectParams && Object.keys(layer.effectParams).length > 0) {
                if (isBaseSolid) {
                    // Skip alpha param for base solid (already baked into DSL with opacity)
                    const { alpha, ...rest } = layer.effectParams
                    if (Object.keys(rest).length > 0) {
                        this.updateLayerParams(layer.id, rest)
                    }
                } else {
                    this.updateLayerParams(layer.id, layer.effectParams)
                }
            }

            // Base solid uses alpha parameter; all others use blendMode
            if (layer.visible && !isBaseSolid) {
                this.updateLayerOpacity(layer.id, layer.opacity)
            }

            if (layer.sourceType === 'media' || layer.sourceType === 'drawing') {
                const sx = layer.scaleX ?? 1
                const sy = layer.scaleY ?? 1
                const rot = layer.rotation ?? 0
                const fh = layer.flipH || false
                const fv = layer.flipV || false
                const hasTransform = sx !== 1 || sy !== 1 || rot !== 0 || fh || fv
                if (hasTransform) {
                    this.updateLayerTransform(layer.id,
                        { scaleX: sx, scaleY: sy, rotation: rot, flipH: fh, flipV: fv },
                        layer.offsetX || 0, layer.offsetY || 0, { strict })
                } else {
                    this.updateLayerOffset(layer.id, layer.offsetX || 0, layer.offsetY || 0)
                }
            }
        }
    }

    _uploadMediaTextures({ strict = false } = {}) {
        const visibleMediaLayers = this._layers.filter(l =>
            l.visible && (l.sourceType === 'media' || l.sourceType === 'drawing'))
        const allStepIndices = this._getMediaStepIndices()
        if (!allStepIndices) {
            if (strict && visibleMediaLayers.length > 0) {
                throw new Error('No pipeline graph available for media textures')
            }
            console.warn('[LayersRenderer] No pipeline graph, cannot upload textures')
            return
        }

        // Filter out media step indices that belong to mask textures
        const maskStepIndices = this._getMaskMediaStepIndices()
        const stepIndices = allStepIndices.filter(idx => !maskStepIndices.has(idx))

        if (strict && stepIndices.length < visibleMediaLayers.length) {
            throw new Error('Pipeline is missing a media texture step')
        }
        const stepParameterValues = {}

        for (let i = 0; i < visibleMediaLayers.length && i < stepIndices.length; i++) {
            const layer = visibleMediaLayers[i]
            const stepIndex = stepIndices[i]
            const media = this._mediaTextures.get(layer.id)

            if (!media) {
                if (layer.sourceType === 'drawing' && (layer.strokes?.length || 0) === 0) {
                    continue
                }
                if (strict) {
                    throw new Error(`No media loaded for layer ${layer.id}`)
                }
                console.warn(`[LayersRenderer] No media loaded for layer ${layer.id}`)
                continue
            }

            const textureId = `imageTex_step_${stepIndex}`
            try {
                this._renderer.updateTextureFromSource?.(textureId, media.element, { flipY: false })

                if (media.width > 0 && media.height > 0) {
                    stepParameterValues[`step_${stepIndex}`] = {
                        imageSize: [media.width, media.height]
                    }
                }
            } catch (err) {
                if (strict) throw err
                console.warn(`[LayersRenderer] Failed to upload texture ${textureId}:`, err)
            }
        }

        if (Object.keys(stepParameterValues).length > 0) {
            this._renderer.applyStepParameterValues?.(stepParameterValues)
        }
    }

    /**
     * Upload mask textures to their corresponding media step texture slots.
     * Each mask uses a media() call in the DSL, tracked in _layerStepMap
     * with the key `mask_${layerId}`.
     * @private
     */
    _uploadMaskTextures({ strict = false } = {}) {
        const visibleMaskedLayers = this._layers.filter(layer =>
            layer.visible && layer.mask && layer.maskEnabled !== false)
        const passes = this._renderer.pipeline?.graph?.passes
        if (!passes) {
            if (strict && visibleMaskedLayers.length > 0) {
                throw new Error('No pipeline graph available for mask textures')
            }
            return
        }

        if (strict) {
            for (const layer of visibleMaskedLayers) {
                if (!this._maskTextures.has(layer.id)) {
                    throw new Error(`No mask texture loaded for layer ${layer.id}`)
                }
            }
        }

        for (const [layerId, maskData] of this._maskTextures) {
            const maskStepKey = `mask_${layerId}`
            const stepIndex = this._layerStepMap.get(maskStepKey)
            if (stepIndex === undefined) {
                const layer = this._layers.find(item => item.id === layerId)
                if (strict && layer?.visible && layer.maskEnabled !== false) {
                    throw new Error(`Pipeline is missing the mask step for layer ${layerId}`)
                }
                continue
            }

            const textureId = `imageTex_step_${stepIndex}`
            try {
                this._renderer.updateTextureFromSource?.(textureId, maskData.element, { flipY: false })
            } catch (err) {
                if (strict) throw err
                console.warn(`[LayersRenderer] Failed to upload mask texture for ${layerId}:`, err)
            }
        }
    }

    /**
     * Get the set of media step indices used by mask textures.
     * Used by _uploadMediaTextures and _updateVideoTextures to skip mask steps.
     * @returns {Set<number>}
     * @private
     */
    _getMaskMediaStepIndices() {
        const indices = new Set()
        for (const [layerId] of this._maskTextures) {
            const stepIndex = this._layerStepMap.get(`mask_${layerId}`)
            if (stepIndex !== undefined) {
                indices.add(stepIndex)
            }
        }
        return indices
    }

    /**
     * Decode media without registering it in the live renderer maps.
     * @param {File} file
     * @param {'image'|'video'} mediaType
     * @returns {Promise<object|null>} prepared renderer resource
     */
    async prepareMediaResource(file, mediaType) {
        const url = URL.createObjectURL(file)

        if (mediaType === 'image') {
            const img = new Image()
            try {
                await new Promise((resolve, reject) => {
                    img.onload = resolve
                    img.onerror = reject
                    img.src = url
                })
            } catch (err) {
                URL.revokeObjectURL(url) // not yet stored in _mediaTextures, revoke here
                throw err
            }
            const width = img.naturalWidth || img.width
            const height = img.naturalHeight || img.height
            return { type: 'image', element: img, url, width, height }
        }

        if (mediaType === 'video') {
            const video = document.createElement('video')
            video.loop = true
            video.muted = true
            video.playsInline = true
            video.crossOrigin = 'anonymous'
            try {
                await new Promise((resolve, reject) => {
                    video.onloadedmetadata = resolve
                    video.onerror = () => {
                        const mediaError = video.error
                        const message = mediaError
                            ? `Video error: ${mediaError.message || 'Code ' + mediaError.code}`
                            : 'Unknown video error'
                        reject(new Error(message))
                    }
                    video.src = url
                    video.load()
                })
            } catch (err) {
                video.src = '' // release the half-initialized element + blob
                URL.revokeObjectURL(url)
                throw err
            }
            const width = video.videoWidth
            const height = video.videoHeight

            try {
                await video.play()
            } catch (playError) {
                console.warn('[LayersRenderer] Video autoplay blocked:', playError.message)
            }
            return { type: 'video', element: video, url, width, height }
        }

        URL.revokeObjectURL(url) // unknown media type — nothing stored, don't leak
        return null
    }

    /**
     * Wrap a rasterized canvas as a detached media resource.
     * @param {HTMLCanvasElement} canvas
     * @returns {object}
     */
    prepareCanvasMediaResource(canvas) {
        return {
            type: 'image',
            element: canvas,
            width: canvas.width,
            height: canvas.height
        }
    }

    /**
     * Convert ImageData to the detached canvas resource used by mask uploads.
     * @param {ImageData} maskData
     * @returns {object}
     */
    prepareMaskTexture(maskData) {
        const canvas = document.createElement('canvas')
        canvas.width = maskData.width
        canvas.height = maskData.height
        const ctx = canvas.getContext('2d')
        ctx.putImageData(maskData, 0, 0)
        return {
            element: canvas,
            width: maskData.width,
            height: maskData.height
        }
    }

    /**
     * Register a prepared resource, disposing any previous resource at the id.
     * @param {string} layerId
     * @param {object} resource
     */
    setMediaResource(layerId, resource) {
        const previous = this._mediaTextures.get(layerId)
        if (previous && previous !== resource) this.disposeMediaResource(previous)
        this._mediaTextures.set(layerId, resource)
    }

    /**
     * Release a detached or registered media resource.
     * @param {object|null} media
     */
    disposeMediaResource(media) {
        if (!media) return
        try {
            if (media.url) URL.revokeObjectURL(media.url)
            if (media.type === 'video' && media.element) {
                media.element.pause()
                media.element.src = ''
            }
        } catch (err) {
            console.warn('[LayersRenderer] Failed to dispose media resource:', err)
        }
    }

    /**
     * Release every resource owned by a map and empty it.
     * @param {Map<string, object>} resources
     */
    disposeMediaResources(resources) {
        for (const media of resources.values()) this.disposeMediaResource(media)
        resources.clear()
    }

    async loadMedia(layerId, file, mediaType) {
        const resource = await this.prepareMediaResource(file, mediaType)
        if (!resource) return { width: 0, height: 0 }
        this.setMediaResource(layerId, resource)
        return { width: resource.width, height: resource.height }
    }

    getMediaInfo(layerId) {
        return this._mediaTextures.get(layerId) || null
    }

    unloadMedia(layerId) {
        const media = this._mediaTextures.get(layerId)
        if (!media) return
        this.disposeMediaResource(media)
        this._mediaTextures.delete(layerId)
    }

    /**
     * Upload or update a mask texture for a layer.
     * @param {string} layerId - Layer ID
     * @param {ImageData} maskData - Grayscale mask ImageData
     */
    uploadMaskTexture(layerId, maskData) {
        this._maskTextures.set(layerId, this.prepareMaskTexture(maskData))
    }

    /**
     * Remove a mask texture.
     * @param {string} layerId
     */
    removeMaskTexture(layerId) {
        this._maskTextures.delete(layerId)
    }

    _isTextEffect(effectId) {
        if (!effectId) return false
        const manifest = this._renderer.manifest || {}
        const entry = manifest[effectId]
        return entry?.externalTexture === 'textTex'
    }

    _uploadTextTextures({ strict = false } = {}) {
        // Prune canvases whose text layer no longer exists (deleted, flattened,
        // merged, or replaced). Runs on every rebuild, so this is the single
        // chokepoint that keeps _textCanvases from accumulating orphans. Keyed
        // by all text layers regardless of visibility, so toggling a layer
        // hidden/visible doesn't churn its canvas.
        const liveTextLayerIds = new Set(
            this._layers
                .filter(l => l.sourceType === 'effect' && this._isTextEffect(l.effectId))
                .map(l => l.id)
        )
        for (const layerId of this._textCanvases.keys()) {
            if (!liveTextLayerIds.has(layerId)) {
                this._textCanvases.delete(layerId)
            }
        }

        const textLayers = this._layers.filter(l =>
            l.visible && l.sourceType === 'effect' && this._isTextEffect(l.effectId)
        )

        const passes = this._renderer.pipeline?.graph?.passes
        if (!passes) {
            if (strict && textLayers.length > 0) {
                throw new Error('Pipeline is missing a text texture step')
            }
            return
        }

        const textStepIndices = []
        for (const pass of passes) {
            if (pass.effectNamespace === 'filter' && pass.effectFunc === 'text') {
                textStepIndices.push(pass.stepIndex)
            }
        }
        const uniqueStepIndices = [...new Set(textStepIndices)]

        if (strict && uniqueStepIndices.length < textLayers.length) {
            throw new Error('Pipeline is missing a text texture step')
        }

        for (let i = 0; i < textLayers.length && i < uniqueStepIndices.length; i++) {
            const layer = textLayers[i]
            const stepIndex = uniqueStepIndices[i]

            if (this._textCanvases.has(layer.id)) {
                this._textCanvases.get(layer.id).stepIndex = stepIndex
            } else {
                this._textCanvases.set(layer.id, {
                    canvas: document.createElement('canvas'),
                    stepIndex
                })
            }

            this._renderTextCanvas(layer.id, layer.effectParams || {}, { strict })
        }
    }

    _renderTextCanvas(layerId, params, { strict = false } = {}) {
        const state = this._textCanvases.get(layerId)
        if (!state || !this._renderer.pipeline) {
            if (strict) throw new Error(`Text texture state is missing for layer "${layerId}"`)
            return
        }

        const { canvas } = state
        canvas.width = this.width
        canvas.height = this.height

        const ctx = canvas.getContext('2d')

        const text = String(params.text || 'Hello World')
        const font = params.font || 'Nunito'
        const size = params.size ?? 0.1
        const posX = params.posX ?? 0.5
        const posY = params.posY ?? 0.5
        const rotation = params.rotation ?? 0
        const color = params.color || '#ffffff'
        const bgColor = params.matteColor || params.bgColor || '#000000'
        const bgOpacity = params.matteOpacity ?? params.bgOpacity ?? 0
        const justify = params.justify || 'center'

        ctx.clearRect(0, 0, canvas.width, canvas.height)

        if (bgOpacity > 0) {
            ctx.fillStyle = this._rgbToCss(this._hexToRgb(bgColor), bgOpacity)
            ctx.fillRect(0, 0, canvas.width, canvas.height)
        }

        const lines = text.split('\n')
        const fontSize = Math.round(size * canvas.height)
        const lineHeight = fontSize * 1.2

        ctx.font = `${fontSize}px ${font}`
        ctx.textAlign = justify
        ctx.textBaseline = 'middle'
        ctx.fillStyle = this._rgbToCss(this._hexToRgb(color), 1)

        ctx.save()
        ctx.translate(posX * canvas.width, posY * canvas.height)
        ctx.rotate(rotation * Math.PI / 180)

        const startY = -(lines.length - 1) * lineHeight / 2
        for (let i = 0; i < lines.length; i++) {
            ctx.fillText(lines[i], 0, startY + i * lineHeight)
        }

        ctx.restore()

        try {
            this._renderer.updateTextureFromSource?.(`textTex_step_${state.stepIndex}`, canvas, { flipY: true })
        } catch (err) {
            if (strict) throw err
            console.warn(`[LayersRenderer] Failed to upload text texture textTex_step_${state.stepIndex}:`, err)
        }
    }

    /**
     * Convert 0-1 RGB array to CSS rgba() string
     * @private
     */
    _rgbToCss(rgb, alpha) {
        return `rgba(${Math.round(rgb[0] * 255)}, ${Math.round(rgb[1] * 255)}, ${Math.round(rgb[2] * 255)}, ${alpha})`
    }

    _hexToRgb(hex) {
        if (Array.isArray(hex)) return hex.slice(0, 3)
        const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex)
        return result
            ? [parseInt(result[1], 16) / 255, parseInt(result[2], 16) / 255, parseInt(result[3], 16) / 255]
            : [1, 1, 1]
    }

    /**
     * Normalize color uniforms after compilation.
     * The DSL parser stores color defaults as hex strings (e.g. "#000000"),
     * but the WebGL uniform setter expects arrays. Convert in-place.
     * @private
     */
    _normalizeColorUniforms() {
        const passes = this._renderer.pipeline?.graph?.passes
        if (!passes) return

        for (const pass of passes) {
            if (!pass.uniforms) continue
            for (const [name, value] of Object.entries(pass.uniforms)) {
                if (typeof value === 'string' && /^#[a-f0-9]{6}$/i.test(value)) {
                    pass.uniforms[name] = this._hexToRgb(value)
                }
            }
        }
    }

    updateTextParams(layerId, params) {
        const layer = this._layers.find(l => l.id === layerId)
        if (!layer || !this._isTextEffect(layer.effectId)) return
        // A hidden layer's cached stepIndex is stale: _uploadTextTextures
        // only reassigns indices for visible layers, so writing through it
        // could overwrite a texture slot now owned by another text layer.
        // The caller keeps params on layer.effectParams; the canvas
        // re-renders from them on the rebuild that makes the layer visible.
        if (!layer.visible) return
        if (!this._textCanvases.has(layerId)) return

        this._renderTextCanvas(layerId, params)
        this._registerFontaineFont(layerId, params)
    }

    /**
     * Register a fontaine font on-demand if not a base font.
     * Re-renders the text canvas once the font is available.
     * @private
     */
    async _registerFontaineFont(layerId, params) {
        const layers = this._layers
        const textCanvases = this._textCanvases
        const layer = layers.find(candidate => candidate.id === layerId)
        const textCanvas = textCanvases.get(layerId)
        const font = params.font || 'Nunito'

        try {
            const { BASE_FONT_NAMES, getFontaineLoader } = await import('../layers/fontaine-loader.js')
            if (BASE_FONT_NAMES.has(font)) return

            const loader = getFontaineLoader()
            if (!loader.fontsLoaded) return

            const registered = await loader.registerFontByName(font)
            if (registered) {
                if (this._layers !== layers
                    || this._textCanvases !== textCanvases
                    || layers.find(candidate => candidate.id === layerId) !== layer
                    || textCanvases.get(layerId) !== textCanvas
                    || layer?.effectParams !== params
                    || !layer.visible) return
                this._renderTextCanvas(layerId, params)
            }
        } catch {
            // Fall back silently -- browser will use fallback font
        }
    }

    _buildDsl() {
        const visibleLayers = this._layers.filter(l => l.visible)

        if (visibleLayers.length === 0) {
            return 'search synth\n\nsolid(color: #000000, alpha: 0).write(o0)\n\nrender(o0)'
        }

        // Collect namespaces used by effect layers and their children
        const usedNamespaces = new Set(['synth', 'mixer']) // Always need synth for solid/media, mixer for blendMode
        for (const layer of visibleLayers) {
            if (layer.sourceType === 'effect' && layer.effectId) {
                usedNamespaces.add(layer.effectId.split('/')[0])
            }
            for (const child of (layer.children || [])) {
                if (child.visible && child.effectId) {
                    usedNamespaces.add(child.effectId.split('/')[0])
                }
            }
        }

        const lines = []
        lines.push(`search ${[...usedNamespaces].join(', ')}`)
        lines.push('')

        let currentOutput = 0 // Track which output buffer we're using

        // Process each visible layer from bottom to top
        for (let i = 0; i < visibleLayers.length; i++) {
            const layer = visibleLayers[i]
            const isBase = i === 0

            lines.push('')

            if (isBase) {
                // Base layer - handle opacity via alpha or blending
                const baseAlpha = layer.opacity / 100

                if (layer.sourceType === 'effect' && layer.effectId === 'synth/solid') {
                    // Solid base - use alpha parameter for opacity
                    const params = layer.effectParams || {}
                    const color = params.color || [0.5, 0.5, 0.5]
                    const effectAlpha = (params.alpha !== undefined ? params.alpha : 1) * baseAlpha
                    const toHex = (v) => Math.round(v * 255).toString(16).padStart(2, '0')
                    const hex = `#${toHex(color[0])}${toHex(color[1])}${toHex(color[2])}`
                    lines.push(`solid(color: ${hex}, alpha: ${effectAlpha.toFixed(4)}).write(o${currentOutput})`)
                    currentOutput = this._buildChildChain(layer, currentOutput, lines)

                    // Apply layer mask if present and enabled
                    if (layer.mask && layer.maskEnabled !== false) {
                        const maskOutput = currentOutput + 1
                        lines.push(`read(o${currentOutput}).alphaMask(tex: media(), maskMode: 1).write(o${maskOutput})`)
                        currentOutput = maskOutput
                    }
                } else {
                    // Media or effect base - blend over transparent background for opacity.
                    // Effects that require an input (non-synth: overlay like text, or
                    // adjustments like blur) must chain off the transparent buffer so their
                    // .write() isn't the first thing in the chain. Synths and media are
                    // self-contained and write directly.
                    const isMediaOrDrawing = layer.sourceType === 'media' || layer.sourceType === 'drawing'
                    const needsInput = !isMediaOrDrawing && !this._isEffectSynth(layer.effectId)
                    const layerCall = isMediaOrDrawing
                        ? this._buildMediaCall()
                        : this._buildEffectCall(layer)
                    const mixAmt = this._opacityToMixAmt(layer.opacity, layer.blendMode)
                    const shaderMode = this._shaderBlendMode(layer.blendMode)
                    lines.push(`solid(color: #000000, alpha: 0).write(o${currentOutput})`)
                    if (needsInput) {
                        lines.push(`read(o${currentOutput}).${layerCall}.write(o${currentOutput + 1})`)
                    } else {
                        lines.push(`${layerCall}.write(o${currentOutput + 1})`)
                    }
                    lines.push(`read(o${currentOutput}).blendMode(tex: read(o${currentOutput + 1}), mode: ${shaderMode}, mixAmt: ${mixAmt}).write(o${currentOutput + 2})`)
                    currentOutput += 2
                    currentOutput = this._buildChildChain(layer, currentOutput, lines)

                    // Apply layer mask if present and enabled
                    if (layer.mask && layer.maskEnabled !== false) {
                        const maskOutput = currentOutput + 1
                        lines.push(`read(o${currentOutput}).alphaMask(tex: media(), maskMode: 1).write(o${maskOutput})`)
                        currentOutput = maskOutput
                    }
                }
            } else {
                // Non-base layers - blend with previous
                const prevOutput = currentOutput
                currentOutput++
                const mixAmt = this._opacityToMixAmt(layer.opacity, layer.blendMode)

                if (layer.sourceType === 'media' || layer.sourceType === 'drawing') {
                    lines.push(`${this._buildMediaCall()}.write(o${currentOutput})`)
                } else if (layer.sourceType === 'effect') {
                    const effectCall = this._buildEffectCall(layer)
                    const isSynth = this._isEffectSynth(layer.effectId)
                    const isOverlay = this._isOverlayEffect(layer.effectId)

                    if (isSynth) {
                        lines.push(`${effectCall}.write(o${currentOutput})`)
                    } else if (isOverlay) {
                        // Overlay effects (e.g. filter/text) source their content from an
                        // external texture. Render them onto a transparent buffer so child
                        // effects and blending isolate them from the composite below.
                        lines.push(`solid(color: #000000, alpha: 0).write(o${currentOutput})`)
                        const overlayOutput = currentOutput + 1
                        lines.push(`read(o${currentOutput}).${effectCall}.write(o${overlayOutput})`)
                        currentOutput = overlayOutput
                    } else {
                        lines.push(`read(o${prevOutput}).${effectCall}.write(o${currentOutput})`)
                    }
                }

                // Apply child effects to this layer's output
                currentOutput = this._buildChildChain(layer, currentOutput, lines)

                // Apply layer mask if present and enabled
                if (layer.mask && layer.maskEnabled !== false) {
                    const maskOutput = currentOutput + 1
                    lines.push(`read(o${currentOutput}).alphaMask(tex: media(), maskMode: 1).write(o${maskOutput})`)
                    currentOutput = maskOutput
                }

                const nextOutput = currentOutput + 1
                const shaderMode = this._shaderBlendMode(layer.blendMode)
                lines.push(`read(o${prevOutput}).blendMode(tex: read(o${currentOutput}), mode: ${shaderMode}, mixAmt: ${mixAmt}).write(o${nextOutput})`)
                currentOutput = nextOutput
            }
        }

        lines.push('')
        lines.push(`render(o${currentOutput})`)

        return lines.join('\n')
    }

    _buildEffectCall(layer) {
        // Qualified so a future manifest collision on another short name can't
        // silently repoint this fallback (same hazard class as noise itself).
        if (!layer.effectId) return 'from(synth, noise())'

        const effectName = layer.effectId.split('/').pop()
        const params = layer.effectParams || {}

        // Look up effect definition to determine param types
        const effectDef = getAllEffects().get(layer.effectId) || null
        const globals = effectDef?.globals || {}
        // Build alias → canonical name map
        const aliases = effectDef?.paramAliases || {}

        const paramPairs = Object.entries(params)
            .map(([key, value]) => {
                // Resolve canonical name to check type
                const canonicalKey = aliases[key] || key
                const spec = globals[canonicalKey] || globals[key]
                const isColor = spec?.type === 'color'

                if (this.isDeclaredDslIdentifier(spec, value)) {
                    return `${key}: ${value}`
                }

                if (isColor) {
                    // Emit as unquoted DSL color literal (#rrggbb)
                    if (Array.isArray(value)) {
                        const hex = '#' + value.slice(0, 3).map(c =>
                            Math.round((c || 0) * 255).toString(16).padStart(2, '0')
                        ).join('')
                        return `${key}: ${hex}`
                    }
                    if (typeof value === 'string' && value.startsWith('#')) {
                        return `${key}: ${value}` // Already a hex string, emit unquoted
                    }
                }

                if (typeof value === 'string') {
                    // Triple-quoted strings preserve internal " and newlines
                    // verbatim, which `"${value}"` did not — Impact, "Arial
                    // Black", ... and multi-line text() params blew up the
                    // parser.
                    //
                    // A literal `"""` in user input would close the triple-
                    // quoted literal mid-string and corrupt emission, but the
                    // agent layer (commands.js: rejectTripleQuoteInParams) now
                    // refuses inputs containing `"""` before they reach the
                    // renderer. The warn below is informational, NOT
                    // protective — it would only fire if someone bypasses the
                    // agent layer and feeds the renderer directly.
                    if (value.includes('"""')) {
                        console.warn(`[LayersRenderer] Param ${key} contains '"""'; DSL emission may be ambiguous`)
                    }
                    return `${key}: """${value}"""`
                }
                if (Array.isArray(value)) return `${key}: vec${value.length}(${value.join(', ')})`
                return `${key}: ${value}`
            })

        const call = paramPairs.length > 0
            ? `${effectName}(${paramPairs.join(', ')})`
            : `${effectName}()`
        return this._qualifyEffectCall(layer.effectId, effectName, call)
    }

    /**
     * Wrap an effect call in the DSL's `from(namespace, call)` qualifier when
     * the short name is claimed by more than one namespace in the manifest.
     *
     * DSL calls are unqualified short names resolved first-match-wins over the
     * program's `search` order, and _buildDsl always lists `synth` first — so
     * an unqualified `noise()` from a classicNoisedeck/noise layer silently
     * renders synth/noise instead. `from()` pins resolution to the layer's own
     * namespace. Only ambiguous short names get wrapped (currently noise and
     * noise3d), so DSL output for everything else is unchanged.
     * @private
     */
    _qualifyEffectCall(effectId, effectName, call) {
        const namespace = effectId?.split('/')[0]
        if (!namespace || !this._isAmbiguousShortName(effectName)) return call
        return `from(${namespace}, ${call})`
    }

    /**
     * Whether more than one manifest namespace defines this effect short name.
     * Memoized per manifest object; an unloaded manifest reports not-ambiguous
     * (matching the pre-qualifier behavior) without memoizing, and a manifest
     * swap (identity change) recomputes rather than serving a stale map.
     * @private
     */
    _isAmbiguousShortName(effectName) {
        const manifest = this._renderer.manifest
        if (this._shortNameCountsFor !== manifest) {
            if (!manifest || Object.keys(manifest).length === 0) return false
            const counts = new Map()
            for (const id of Object.keys(manifest)) {
                const short = id.split('/')[1]
                if (!short) continue
                counts.set(short, (counts.get(short) || 0) + 1)
            }
            this._shortNameCounts = counts
            this._shortNameCountsFor = manifest
        }
        return (this._shortNameCounts.get(effectName) || 0) > 1
    }

    /**
     * Build DSL lines for a layer's visible child effects.
     * @param {object} layer - Parent layer
     * @param {number} currentOutput - Current output buffer index
     * @param {string[]} lines - DSL lines array to append to
     * @returns {number} Updated output buffer index
     * @private
     */
    _buildChildChain(layer, currentOutput, lines) {
        const visibleChildren = (layer.children || []).filter(c => c.visible)
        for (const child of visibleChildren) {
            const effectCall = this._buildEffectCall(child)
            const nextOutput = currentOutput + 1
            lines.push(`read(o${currentOutput}).${effectCall}.write(o${nextOutput})`)
            currentOutput = nextOutput
        }
        return currentOutput
    }

    _buildMediaCall() {
        return 'media()'
    }

    /**
     * Convert layer opacity (0-100) to blendMode mixAmt (-100 to 100).
     * The blendMode shader's amt axis treats 0.5 (mixAmt=0) as "full blend
     * applied" and 1.0 (mixAmt=100) as "pure tex replace". For non-mix
     * modes, amt>0.5 fades the blend toward pure color2 — at mixAmt=100
     * the blend is invisible. Cap non-mix modes at mixAmt=0 so blend
     * modes remain visible across the opacity range. Keep the full
     * range for mix mode where pure replace at opacity 100 is desired.
     * @private
     */
    _opacityToMixAmt(opacity, blendMode = 'mix') {
        if (blendMode === 'mix') {
            return (opacity - 50) * 2
        }
        return opacity - 100
    }

    // Translate layer-model blend mode ids to the shader's choice names.
    // 'difference' is the user-facing name; the shader's choices list it as
    // 'diff'. Other ids pass through unchanged.
    _shaderBlendMode(blendMode) {
        if (blendMode === 'difference') return 'diff'
        return blendMode
    }

    _isEffectSynth(effectId) {
        if (!effectId) return true
        const entry = (this._renderer.manifest || {})[effectId]
        if (entry?.starter) return true
        const [namespace] = effectId.split('/')
        return namespace === 'synth' || namespace === 'synth3d'
    }

    // An "overlay" is an effect whose externalTexture is its primary content
    // source (rather than a secondary input like a displacement map). Such
    // effects must render onto a transparent input so child effects isolate
    // their contribution from the composite below. `!starter` is the proxy:
    // starter effects (e.g. synth/media) are already handled as content
    // producers on the synth path; non-starter externalTexture effects
    // (today: filter/text) are the case this routes around.
    _isOverlayEffect(effectId) {
        if (!effectId) return false
        const entry = (this._renderer.manifest || {})[effectId]
        if (!entry?.externalTexture) return false
        return !entry.starter
    }

    _isHiddenNamespace(namespace, hiddenList) {
        return hiddenList.includes(namespace) ||
            namespace.startsWith('classic') ||
            namespace.includes('3d')
    }

    /**
     * Query the manifest for effects matching a filter
     * @param {object} options
     * @param {string[]} options.hiddenNamespaces - Namespaces to exclude
     * @param {function} [options.filter] - Additional per-entry filter
     * @param {string[]} [options.extraFields] - Additional entry fields to include
     * @returns {Array} Sorted effect descriptors
     * @private
     */
    _queryEffects({ hiddenNamespaces, filter, extraFields = [] }) {
        const manifest = this._renderer.manifest || {}
        const effects = []

        for (const [effectId, entry] of Object.entries(manifest)) {
            if (filter && !filter(entry)) continue

            const [namespace, name] = effectId.split('/')
            if (this._isHiddenNamespace(namespace, hiddenNamespaces)) continue

            const item = {
                effectId,
                namespace,
                name,
                description: entry.description || '',
                tags: entry.tags || []
            }
            for (const field of extraFields) {
                item[field] = entry[field] || false
            }
            effects.push(item)
        }

        effects.sort((a, b) =>
            a.namespace !== b.namespace
                ? a.namespace.localeCompare(b.namespace)
                : a.name.localeCompare(b.name)
        )
        return effects
    }

    getStarterEffects() {
        return this._queryEffects({
            hiddenNamespaces: ['3d', 'points', 'render', 'synth', 'synth3d', 'mixer', 'filter3d'],
            filter: (entry) => entry.starter
        })
    }

    getAllEffects() {
        return this._queryEffects({
            hiddenNamespaces: ['3d', 'points', 'render', 'synth', 'synth3d', 'mixer', 'filter3d'],
            extraFields: ['starter']
        })
    }

    /**
     * Get filter/processing effects that work on existing content (non-starter, non-mixer)
     */
    getLayerEffects() {
        return this._queryEffects({
            hiddenNamespaces: ['synth', 'synth3d', 'mixer', 'points', 'render', '3d', 'filter3d'],
            filter: (entry) => !entry.starter
        })
    }

    async getEffectDefinition(effectId) {
        if (!effectId) return null
        try {
            const effect = await this._renderer.loadEffect(effectId)
            return effect?.instance || null
        } catch (err) {
            console.warn(`[LayersRenderer] Failed to load effect ${effectId}:`, err)
            return null
        }
    }
}
