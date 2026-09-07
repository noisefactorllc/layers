const MAX_OUTPUT_PIXELS = 32 * 1024 * 1024
const MAX_EXPORT_GPU_BYTES = 384 * 1024 * 1024
const FIXED_ENGINE_BYTES = 64 * 1024 * 1024

function fail(message) {
    const error = new Error(message)
    error.code = 'FULL_RESOLUTION_UNSUPPORTED'
    throw error
}

function pointwiseLayers(layers) {
    return layers.every(layer => !layer.visible || (
        !(layer.children || []).some(child => child.visible) &&
        (['media', 'drawing'].includes(layer.sourceType) ||
            (layer.sourceType === 'effect' && layer.effectId === 'synth/solid'))
    ))
}

/** Single-frame convenience API. The returned canvas survives session disposal. */
export async function renderFullResolution(owner, options = {}) {
    const normalizedTime = options.normalizedTime ?? owner.getPausedNormalizedTime()
    if (!Number.isFinite(normalizedTime)) fail('Invalid export frame time')
    const session = await createFullResolutionCapture(owner, options)
    try {
        return await session.render(normalizedTime)
    } finally {
        await session.dispose()
    }
}

// A session owns its output canvas. Consumers must finish copying/encoding a
// frame before requesting the next frame. Disposal also waits for active work.
function captureSession(renderFrame, release = async () => {}) {
    let active = null
    let disposal = null
    return {
        async render(normalizedTime) {
            if (disposal) throw new Error('Full-resolution capture session is disposed')
            if (active) throw new Error('A full-resolution frame is already rendering')
            if (!Number.isFinite(normalizedTime)) fail('Invalid export frame time')
            active = Promise.resolve().then(() => renderFrame(normalizedTime))
            try { return await active } finally { active = null }
        },
        dispose() {
            if (!disposal) disposal = (async () => {
                try { await active } catch { /* release resources after failed frames */ }
                await release()
            })()
            return disposal
        },
    }
}

/**
 * Allocate original sources and the bounded shader graph once per capture.
 * The caller holds the project mutation lease until disposal. Native videos
 * are shared, so seek them before render(); image uploads remain unchanged.
 */
export async function createFullResolutionCapture(owner, {
    width = owner.width, height = owner.height, tileSize = 512, layerIds = null,
} = {}) {
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) ||
        width < 1 || height < 1 || width > 8192 || height > 8192 || width * height > MAX_OUTPUT_PIXELS) {
        fail('Full-resolution output exceeds the 8192-pixel side or 32-megapixel memory limit. Choose a smaller explicit export size.')
    }
    if (!Number.isInteger(tileSize) || tileSize < 64 || tileSize > 512) fail('Invalid export tile size')
    const layers = owner.layers.map(layer => ({ ...layer,
        visible: layer.visible && (!layerIds || layerIds.includes(layer.id)),
    }))
    const pipeline = owner._renderer.pipeline
    const nativeSources = layers.filter(layer => layer.visible).every(layer => {
        const media = owner.getMediaInfo(layer.id)
        const source = media?.element
        if (source && ((source.videoWidth || source.naturalWidth || source.width) !== media.width ||
            (source.videoHeight || source.naturalHeight || source.height) !== media.height || media.previewCanvas)) return false
        if (media?.transformCanvas && (media.transformCanvas.width !== Math.ceil(media.width * Math.abs(layer.scaleX ?? 1)) ||
            media.transformCanvas.height !== Math.ceil(media.height * Math.abs(layer.scaleY ?? 1)))) return false
        return !owner._maskTextures.get(layer.id)?.previewCanvas
    })
    if (tileSize === 512 && !layerIds && width === owner.width && height === owner.height &&
        width === pipeline?.width && height === pipeline?.height && nativeSources) {
        const output = document.createElement('canvas')
        output.width = width; output.height = height
        const ctx = output.getContext('2d')
        if (!ctx) throw new Error('Could not allocate full-resolution output')
        return captureSession(normalizedTime => {
            owner.render(normalizedTime)
            ctx.clearRect(0, 0, width, height)
            ctx.drawImage(owner.canvas, 0, 0)
            return output
        })
    }
    const tiled = pointwiseLayers(layers)
    const renderWidth = tiled ? Math.min(width, tileSize) : width
    const renderHeight = tiled ? Math.min(height, tileSize) : height
    const scaleX = width / owner.width, scaleY = height / owner.height
    const maxTextureSize = owner._renderer.capabilities?.maxTextureSize || 4096
    let sourceBytes = 0
    for (const layer of layers.filter(layer => layer.visible)) {
        const media = owner.getMediaInfo(layer.id)
        if (media) {
            const w = Math.ceil(media.width * Math.abs(layer.scaleX ?? 1) * scaleX)
            const h = Math.ceil(media.height * Math.abs(layer.scaleY ?? 1) * scaleY)
            if (Math.max(media.width, media.height, w, h) > maxTextureSize) {
                fail(`Original media for "${layer.name || layer.id}" exceeds this GPU's ${maxTextureSize}-pixel texture limit.`)
            }
            // Original and transformed upload may coexist during preparation.
            sourceBytes += (media.width * media.height + w * h) * 4
        }
        const mask = owner._maskTextures.get(layer.id)
        if (mask && layer.maskEnabled !== false) {
            if (Math.max(mask.width, mask.height) > maxTextureSize) fail('A native mask exceeds the GPU texture limit.')
            sourceBytes += mask.width * mask.height * 4
        }
    }
    const passCount = owner._renderer.pipeline?.graph?.passes?.length || layers.length * 4
    // The current engine allocates 32 double-buffer attachments for o/geo,
    // fixed volume/mesh storage, and graph intermediates. Budget before any
    // full-size decode, texture upload, framebuffer or renderer allocation.
    let estimate = FIXED_ENGINE_BYTES + sourceBytes + renderWidth * renderHeight * (32 * 8 + passCount * 32 + 8)
    if (!tiled) {
        const pipeline = owner._renderer.pipeline
        const textures = pipeline?.backend?.textures
        if (!textures?.size) fail('Full-resolution export requires a compiled texture allocation profile.')
        // Scale every live allocation, including fixed buffers, conservatively.
        // This deliberately overestimates fixed storage rather than guessing
        // effect-specific sampling, volume or parameter-dependent dimensions.
        const ratio = Math.max(1, width / pipeline.width, height / pipeline.height)
        const formatBytes = { r8: 1, rg8: 2, rgba8: 4, r16f: 2, rg16f: 4, rgba16f: 8,
            r32f: 4, rg32f: 8, rgba32f: 16 }
        estimate = sourceBytes + renderWidth * renderHeight * 8
        for (const texture of textures.values()) {
            const bytes = formatBytes[texture.format]
            if (!bytes || !texture.width || !texture.height) fail('Cannot certify the GPU memory cost of this effect graph.')
            const w = Math.ceil(texture.width * ratio), h = Math.ceil(texture.height * ratio)
            if (w > maxTextureSize || h > maxTextureSize || (texture.depth > 1 && ratio > 1)) {
                fail('This effect graph exceeds the full-resolution GPU texture budget.')
            }
            estimate += w * h * (texture.depth || 1) * bytes
        }
    }
    if (renderWidth > maxTextureSize || renderHeight > maxTextureSize || estimate > MAX_EXPORT_GPU_BYTES) {
        fail(tiled
            ? 'Full-resolution media exceeds the export GPU memory budget. Choose a smaller explicit export size.'
            : 'This effect graph cannot be tiled without changing its pixels and exceeds the full-resolution GPU memory budget. Choose a smaller explicit export size.')
    }

    const canvas = document.createElement('canvas')
    canvas.width = renderWidth; canvas.height = renderHeight
    const renderer = new owner.constructor(canvas, { width: renderWidth, height: renderHeight, fullResolution: true })
    const owned = []
    const release = async () => {
        try {
            renderer.stop()
        } finally {
            try {
                await renderer._renderer.dispose({ loseContext: true })
            } finally {
                for (const resource of owned) renderer.disposeMediaResource(resource)
            }
        }
    }
    try {
        await renderer.init()
        const mediaTextures = new Map()
        const videoFrames = []
        for (const layer of layers.filter(layer => layer.visible)) {
            const media = owner.getMediaInfo(layer.id)
            if (!media) continue
            const file = media.sourceFile || layer.mediaFile
            let resource
            if (media.type === 'image' && file) {
                resource = await renderer.prepareMediaResource(file, 'image', { fullResolution: true })
                owned.push(resource)
            } else {
                const frozen = document.createElement('canvas')
                frozen.width = media.width; frozen.height = media.height
                frozen.getContext('2d').drawImage(media.videoElement || media.element, 0, 0, media.width, media.height)
                resource = { type: 'image', element: frozen, width: media.width, height: media.height }
                if (media.type === 'video') videoFrames.push({ layer, resource, source: media.videoElement || media.element })
            }
            mediaTextures.set(layer.id, resource)
            layer.scaleX = (layer.scaleX ?? 1) * scaleX
            layer.scaleY = (layer.scaleY ?? 1) * scaleY
            layer.offsetX = (layer.offsetX || 0) * scaleX
            layer.offsetY = (layer.offsetY || 0) * scaleY
        }
        renderer._mediaTextures = mediaTextures
        renderer._maskTextures = new Map([...owner._maskTextures].map(([id, mask]) => [id, {
            ...mask, width: mask.width * scaleX, height: mask.height * scaleY,
        }]))
        const compiled = await renderer.setLayers(layers, { force: true, strictTextures: true })
        if (!compiled.success) throw new Error(compiled.error || 'Full-resolution shader compilation failed')
        const output = document.createElement('canvas')
        output.width = width; output.height = height
        const context = output.getContext('2d')
        if (!context) throw new Error('Could not allocate full-resolution output')
        return captureSession(async normalizedTime => {
            for (const { layer, resource, source } of videoFrames) {
                const ctx = resource.element.getContext('2d')
                ctx.clearRect(0, 0, resource.width, resource.height)
                ctx.drawImage(source, 0, 0, resource.width, resource.height)
                renderer.updateLayerTransform(layer.id, layer, layer.offsetX, layer.offsetY, { strict: true })
            }
            context.clearRect(0, 0, width, height)
            for (let y = 0; y < height; y += renderHeight) {
                for (let x = 0; x < width; x += renderWidth) {
                    if (tiled) {
                        const values = {}
                        for (const layer of layers.filter(layer => layer.visible)) {
                            for (const [id, dx, dy] of [
                                [layer.id, layer.offsetX || 0, layer.offsetY || 0],
                                [`mask_${layer.id}`, 0, 0],
                            ]) {
                                const step = renderer._layerStepMap.get(id)
                                if (step === undefined || (id === layer.id && !mediaTextures.has(layer.id))) continue
                                values[`step_${step}`] = {
                                    offsetX: (width / 2 - x - renderWidth / 2 + dx) / renderWidth / 1.5 * 100,
                                    offsetY: (height / 2 - y - renderHeight / 2 + dy) / renderHeight / 1.5 * 100,
                                }
                            }
                        }
                        renderer._renderer.applyStepParameterValues(values)
                    }
                    renderer.render(normalizedTime)
                    context.drawImage(canvas, 0, 0, Math.min(renderWidth, width - x), Math.min(renderHeight, height - y),
                        x, y, Math.min(renderWidth, width - x), Math.min(renderHeight, height - y))
                    await new Promise(resolve => setTimeout(resolve, 0))
                }
            }
            return output
        }, release)
    } catch (error) {
        await release()
        throw error
    }
}
