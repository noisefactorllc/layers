/**
 * Layers Renderer - Wrapper around Noisemaker CanvasRenderer
 *
 * Manages a layer stack and builds DSL programs to composite
 * media and effects using Noisemaker's blendMode effect.
 *
 * @module noisemaker/renderer
 */

import { CanvasRenderer, extractEffectNamesFromDsl, getAllEffects, formatDslError } from './bundle.js'

export class LayersRenderer {
    constructor(canvas, options = {}) {
        this._canvas = canvas
        this.width = options.width || canvas?.width || 1024
        this.height = options.height || canvas?.height || 1024
        this.loopDuration = options.loopDuration || 10

        this._renderer = new CanvasRenderer({
            canvas,
            canvasContainer: canvas?.parentElement || null,
            width: this.width,
            height: this.height,
            basePath: 'https://shaders.noisedeck.app/1',
            preferWebGPU: false,
            useBundles: true,
            bundlePath: 'https://shaders.noisedeck.app/1/effects',
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
        this._layerStepMap = new Map()
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
        this._startVideoUpdateLoop()
        this._renderer.start()
    }

    stop() {
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
        const allStepIndices = this._getMediaStepIndices()
        if (!allStepIndices) return

        // Filter out media step indices that belong to mask textures
        const maskStepIndices = this._getMaskMediaStepIndices()
        const stepIndices = allStepIndices.filter(idx => !maskStepIndices.has(idx))

        const visibleMediaLayers = this._layers.filter(l => l.visible && (l.sourceType === 'media' || l.sourceType === 'drawing'))

        for (let i = 0; i < visibleMediaLayers.length && i < stepIndices.length; i++) {
            const media = this._mediaTextures.get(visibleMediaLayers[i].id)
            if (!media || media.type !== 'video') continue

            try {
                this._renderer.updateTextureFromSource?.(`imageTex_step_${stepIndices[i]}`, media.element, { flipY: false })
            } catch {
                // Silently ignore texture update errors during playback
            }
        }
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
        this._layers = layers
        return this.rebuild(options)
    }

    /**
     * Rebuild DSL from current layers and recompile
     * @param {object} [options={}] - Options
     * @param {boolean} [options.force=false] - Force rebuild even if DSL unchanged (needed after layer reorder)
     * @returns {Promise<{success: boolean, error?: string}>}
     */
    async rebuild(options = {}) {
        const { force = false } = options

        if (!this._initialized) {
            await this.init()
        }

        if (this._layers.length === 0) {
            this._currentDsl = ''
            return { success: true }
        }

        try {
            const dsl = this._buildDsl()

            // force=true is needed after layer reorder because the DSL may be
            // string-identical but the layer-to-step mapping needs to be rebuilt
            if (dsl === this._currentDsl && !force) {
                return { success: true }
            }

            this._currentDsl = dsl
            console.debug('[LayersRenderer] Built DSL:', dsl)

            await this._loadAndCompile(dsl)
            this._normalizeColorUniforms()

            this._buildLayerStepMap()
            this._uploadMediaTextures()
            this._uploadMaskTextures()
            this._uploadTextTextures()
            this._applyAllLayerParams()

            return { success: true }
        } catch (err) {
            this._logDslError('Compilation error', this._currentDsl, err)
            return { success: false, error: err.message || String(err) }
        }
    }

    /**
     * Try to compile DSL without rebuilding layer state
     * @param {string} dsl - DSL to compile
     * @returns {Promise<{success: boolean, error?: string}>}
     */
    async tryCompile(dsl) {
        if (!dsl?.trim()) {
            return { success: true }
        }

        try {
            await this._loadAndCompile(dsl)
            this._normalizeColorUniforms()
            return { success: true }
        } catch (err) {
            this._logDslError('tryCompile failed', dsl, err)
            return { success: false, error: err.message || String(err) }
        }
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
        const effectData = extractEffectNamesFromDsl(dsl, this._renderer.manifest || {})
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
     * Scale and flip are applied CPU-side via OffscreenCanvas.
     * Rotation uses the shader's built-in rotation uniform to avoid
     * bounding-box inflation that would make the image appear scaled.
     * @param {string} layerId
     * @param {{scaleX: number, scaleY: number, rotation: number, flipH: boolean, flipV: boolean}} transform
     * @param {number} offsetX
     * @param {number} offsetY
     */
    updateLayerTransform(layerId, transform, offsetX, offsetY) {
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
                console.warn(`[LayersRenderer] Failed to restore texture for layer ${layerId}:`, err)
            }
            this.updateLayerOffset(layerId, offsetX, offsetY)
            return
        }

        if (needsCpuTransform) {
            // CPU-side scale and flip (no rotation — shader handles that)
            const destW = Math.ceil(srcW * Math.abs(scaleX))
            const destH = Math.ceil(srcH * Math.abs(scaleY))

            if (!this._transformCanvas || this._transformCanvas.width !== destW || this._transformCanvas.height !== destH) {
                this._transformCanvas = new OffscreenCanvas(destW, destH)
            }
            const canvas = this._transformCanvas
            canvas.width = destW
            canvas.height = destH
            const ctx = canvas.getContext('2d')

            ctx.clearRect(0, 0, destW, destH)
            ctx.imageSmoothingEnabled = true
            ctx.imageSmoothingQuality = 'high'
            ctx.translate(destW / 2, destH / 2)
            ctx.scale(flipH ? -1 : 1, flipV ? -1 : 1)
            ctx.drawImage(media.element, -destW / 2, -destH / 2, destW, destH)

            try {
                this._renderer.updateTextureFromSource?.(textureId, canvas, { flipY: false })
                this._renderer.applyStepParameterValues?.({
                    [`step_${stepIndex}`]: { imageSize: [destW, destH], rotation }
                })
            } catch (err) {
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

    _applyAllLayerParams() {
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
                        layer.offsetX || 0, layer.offsetY || 0)
                } else {
                    this.updateLayerOffset(layer.id, layer.offsetX || 0, layer.offsetY || 0)
                }
            }
        }
    }

    _uploadMediaTextures() {
        const allStepIndices = this._getMediaStepIndices()
        if (!allStepIndices) {
            console.warn('[LayersRenderer] No pipeline graph, cannot upload textures')
            return
        }

        // Filter out media step indices that belong to mask textures
        const maskStepIndices = this._getMaskMediaStepIndices()
        const stepIndices = allStepIndices.filter(idx => !maskStepIndices.has(idx))

        const visibleMediaLayers = this._layers.filter(l => l.visible && (l.sourceType === 'media' || l.sourceType === 'drawing'))
        const stepParameterValues = {}

        for (let i = 0; i < visibleMediaLayers.length && i < stepIndices.length; i++) {
            const layer = visibleMediaLayers[i]
            const stepIndex = stepIndices[i]
            const media = this._mediaTextures.get(layer.id)

            if (!media) {
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
    _uploadMaskTextures() {
        const passes = this._renderer.pipeline?.graph?.passes
        if (!passes) return

        for (const [layerId, maskData] of this._maskTextures) {
            const maskStepKey = `mask_${layerId}`
            const stepIndex = this._layerStepMap.get(maskStepKey)
            if (stepIndex === undefined) continue

            const textureId = `imageTex_step_${stepIndex}`
            try {
                this._renderer.updateTextureFromSource?.(textureId, maskData.element, { flipY: false })
            } catch (err) {
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

    async loadMedia(layerId, file, mediaType) {
        const url = URL.createObjectURL(file)

        if (mediaType === 'image') {
            const img = new Image()
            await new Promise((resolve, reject) => {
                img.onload = resolve
                img.onerror = reject
                img.src = url
            })
            const width = img.naturalWidth || img.width
            const height = img.naturalHeight || img.height
            this._mediaTextures.set(layerId, { type: 'image', element: img, url, width, height })
            return { width, height }
        }

        if (mediaType === 'video') {
            const video = document.createElement('video')
            video.loop = true
            video.muted = true
            video.playsInline = true
            video.crossOrigin = 'anonymous'
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
            const width = video.videoWidth
            const height = video.videoHeight
            this._mediaTextures.set(layerId, { type: 'video', element: video, url, width, height })

            try {
                await video.play()
            } catch (playError) {
                console.warn('[LayersRenderer] Video autoplay blocked:', playError.message)
            }
            return { width, height }
        }

        return { width: 0, height: 0 }
    }

    getMediaInfo(layerId) {
        return this._mediaTextures.get(layerId) || null
    }

    unloadMedia(layerId) {
        const media = this._mediaTextures.get(layerId)
        if (!media) return

        if (media.url) {
            URL.revokeObjectURL(media.url)
        }
        if (media.type === 'video' && media.element) {
            media.element.pause()
            media.element.src = ''
        }
        this._mediaTextures.delete(layerId)
    }

    /**
     * Upload or update a mask texture for a layer.
     * @param {string} layerId - Layer ID
     * @param {ImageData} maskData - Grayscale mask ImageData
     */
    uploadMaskTexture(layerId, maskData) {
        const canvas = document.createElement('canvas')
        canvas.width = maskData.width
        canvas.height = maskData.height
        const ctx = canvas.getContext('2d')
        ctx.putImageData(maskData, 0, 0)

        this._maskTextures.set(layerId, {
            element: canvas,
            width: maskData.width,
            height: maskData.height
        })
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

    _uploadTextTextures() {
        const passes = this._renderer.pipeline?.graph?.passes
        if (!passes) return

        const textStepIndices = []
        for (const pass of passes) {
            if (pass.effectNamespace === 'filter' && pass.effectFunc === 'text') {
                textStepIndices.push(pass.stepIndex)
            }
        }
        const uniqueStepIndices = [...new Set(textStepIndices)]

        const textLayers = this._layers.filter(l =>
            l.visible && l.sourceType === 'effect' && this._isTextEffect(l.effectId)
        )

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

            this._renderTextCanvas(layer.id, layer.effectParams || {})
        }
    }

    _renderTextCanvas(layerId, params) {
        const state = this._textCanvases.get(layerId)
        if (!state || !this._renderer.pipeline) return

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
        const font = params.font || 'Nunito'

        try {
            const { BASE_FONT_NAMES, getFontaineLoader } = await import('../layers/fontaine-loader.js')
            if (BASE_FONT_NAMES.has(font)) return

            const loader = getFontaineLoader()
            if (!loader.fontsLoaded) return

            const registered = await loader.registerFontByName(font)
            if (registered) {
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
        if (!layer.effectId) return 'noise()'

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
                    // parser. Lexer collision on a literal `"""` in user input
                    // is theoretically possible but vanishingly unlikely for
                    // text/font/justify; we warn rather than escape.
                    if (value.includes('"""')) {
                        console.warn(`[LayersRenderer] Param ${key} contains '"""'; DSL emission may be ambiguous`)
                    }
                    return `${key}: """${value}"""`
                }
                if (Array.isArray(value)) return `${key}: vec${value.length}(${value.join(', ')})`
                return `${key}: ${value}`
            })

        return paramPairs.length > 0
            ? `${effectName}(${paramPairs.join(', ')})`
            : `${effectName}()`
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
