import { test, expect } from 'playwright/test'

// In-page unit tests of public/js/collab/docModel.js — the pure Layers <->
// Seance node-doc mapping (dialect "layers", design doc §5). No app
// bootstrap and no Seance server needed: these exercise the module
// standalone via dynamic import, matching the repo's existing convention
// for unit-testing plain modules (e.g. tests/canvas-readback.spec.js).

test('build -> apply round-trips a representative composition', async ({ page }) => {
    await page.goto('/')
    const result = await page.evaluate(async () => {
        const { buildNodeModel, applyNodesToComposition, fnv1a } = await import('/js/collab/docModel.js')

        const mask = new ImageData(4, 4)
        for (let i = 0; i < mask.data.length; i += 4) {
            mask.data[i] = 128; mask.data[i + 1] = 128; mask.data[i + 2] = 128; mask.data[i + 3] = 255
        }

        const layers = [
            {
                id: 'layer-0', name: 'Base', visible: true, opacity: 100, blendMode: 'mix', locked: false,
                offsetX: 0, offsetY: 0, scaleX: 1, scaleY: 1, rotation: 0, flipH: false, flipV: false,
                sourceType: 'effect', mediaFile: null, mediaType: null,
                effectId: 'synth/solid', effectParams: { color: [0.2, 0.2, 0.2], alpha: 1 },
                strokes: undefined, drawingCanvas: null,
                children: [], mask: null, maskEnabled: true, maskVisible: false
            },
            {
                id: 'layer-1', name: 'Blurred', visible: true, opacity: 80, blendMode: 'screen', locked: false,
                offsetX: 5, offsetY: -5, scaleX: 1.1, scaleY: 1.1, rotation: 15, flipH: true, flipV: false,
                sourceType: 'effect', mediaFile: null, mediaType: null,
                effectId: 'filter/blur', effectParams: { radius: 4 },
                strokes: undefined, drawingCanvas: null,
                children: [
                    { id: 'layer-2', name: 'Sharpen', effectId: 'filter/sharpen', effectParams: { amount: 0.5 }, visible: true },
                    { id: 'layer-3', name: 'Tint', effectId: 'filter/tint', effectParams: { color: [1, 0, 0] }, visible: false }
                ],
                mask, maskEnabled: true, maskVisible: false
            },
            {
                id: 'layer-4', name: 'Drawing', visible: true, opacity: 100, blendMode: 'mix', locked: false,
                offsetX: 0, offsetY: 0, scaleX: 1, scaleY: 1, rotation: 0, flipH: false, flipV: false,
                sourceType: 'drawing', mediaFile: null, mediaType: null,
                effectId: null, effectParams: {},
                strokes: [
                    { id: 'stroke-0', type: 'path', color: '#ff0000', size: 5, opacity: 1, mode: 'brush', points: [{ x: 1, y: 2 }, { x: 3, y: 4 }] }
                ],
                drawingCanvas: null,
                children: [], mask: null, maskEnabled: true, maskVisible: false
            }
        ]
        const canvas = { width: 640, height: 480 }

        const nodes = buildNodeModel(layers, canvas)
        const applied = applyNodesToComposition(nodes, [])
        const layerJson = JSON.parse(nodes.find(n => n.id === 'Llayer-1').text)

        return {
            appliedCanvas: applied.canvas,
            appliedIds: applied.layers.map(l => l.id),
            base: { effectId: applied.layers[0].effectId, effectParams: applied.layers[0].effectParams },
            middle: {
                name: applied.layers[1].name, opacity: applied.layers[1].opacity, blendMode: applied.layers[1].blendMode,
                offsetX: applied.layers[1].offsetX, scaleX: applied.layers[1].scaleX, rotation: applied.layers[1].rotation,
                flipH: applied.layers[1].flipH,
                effectId: applied.layers[1].effectId, effectParams: applied.layers[1].effectParams,
                children: applied.layers[1].children,
                maskIsString: typeof applied.layers[1].mask === 'string',
                maskHashMatches: applied.layers[1].mask ? fnv1a(applied.layers[1].mask) === layerJson.maskMeta.hash : false
            },
            drawing: { sourceType: applied.layers[2].sourceType, strokes: applied.layers[2].strokes }
        }
    })

    expect(result.appliedIds).toEqual(['layer-0', 'layer-1', 'layer-4'])
    expect(result.appliedCanvas).toEqual({ width: 640, height: 480 })
    expect(result.base.effectId).toBe('synth/solid')
    expect(result.base.effectParams).toEqual({ color: [0.2, 0.2, 0.2], alpha: 1 })
    expect(result.middle.opacity).toBe(80)
    expect(result.middle.blendMode).toBe('screen')
    expect(result.middle.offsetX).toBe(5)
    expect(result.middle.scaleX).toBe(1.1)
    expect(result.middle.rotation).toBe(15)
    expect(result.middle.flipH).toBe(true)
    expect(result.middle.effectId).toBe('filter/blur')
    expect(result.middle.effectParams).toEqual({ radius: 4 })
    expect(result.middle.children).toEqual([
        { id: 'layer-2', name: 'Sharpen', effectId: 'filter/sharpen', effectParams: { amount: 0.5 }, visible: true },
        { id: 'layer-3', name: 'Tint', effectId: 'filter/tint', effectParams: { color: [1, 0, 0] }, visible: false }
    ])
    expect(result.middle.maskIsString).toBe(true)
    expect(result.middle.maskHashMatches).toBe(true)
    expect(result.drawing.sourceType).toBe('drawing')
    expect(result.drawing.strokes).toEqual([
        { id: 'stroke-0', type: 'path', color: '#ff0000', size: 5, opacity: 1, mode: 'brush', points: [{ x: 1, y: 2 }, { x: 3, y: 4 }] }
    ])
})

test('diffNodeModels emits minimal upserts/deletes', async ({ page }) => {
    await page.goto('/')
    const result = await page.evaluate(async () => {
        const { buildNodeModel, diffNodeModels } = await import('/js/collab/docModel.js')
        const baseLayer = (overrides = {}) => ({
            id: 'layer-0', name: 'Base', visible: true, opacity: 100, blendMode: 'mix', locked: false,
            offsetX: 0, offsetY: 0, scaleX: 1, scaleY: 1, rotation: 0, flipH: false, flipV: false,
            sourceType: 'effect', mediaFile: null, mediaType: null, effectId: 'synth/solid', effectParams: {},
            strokes: undefined, drawingCanvas: null, children: [], mask: null, maskEnabled: true, maskVisible: false,
            ...overrides
        })

        const modelA = buildNodeModel([baseLayer()], { width: 100, height: 100 })
        const modelB = buildNodeModel([baseLayer(), baseLayer({ id: 'layer-1', name: 'Second' })], { width: 100, height: 100 })

        const diffAB = diffNodeModels(modelA, modelB)
        const diffAA = diffNodeModels(modelA, modelA)
        const diffBA = diffNodeModels(modelB, modelA)

        return {
            noopUpserts: diffAA.upserts.length,
            noopDeletes: diffAA.deletes.length,
            addUpsertIds: diffAB.upserts.map(n => n.id).sort(),
            addDeletes: diffAB.deletes,
            removeDeletes: diffBA.deletes,
            metaUpserted: diffAB.upserts.some(n => n.id === 'meta')
        }
    })

    expect(result.noopUpserts).toBe(0)
    expect(result.noopDeletes).toBe(0)
    expect(result.addUpsertIds).toEqual(['Llayer-1', 'meta'])
    expect(result.addDeletes).toEqual([])
    expect(result.removeDeletes).toEqual(['Llayer-1'])
    expect(result.metaUpserted).toBe(true)
})

test('chunking splits large stroke sets and reassembles losslessly', async ({ page }) => {
    await page.goto('/')
    const result = await page.evaluate(async () => {
        const { buildNodeModel, applyNodesToComposition } = await import('/js/collab/docModel.js')

        const strokes = []
        for (let i = 0; i < 1000; i++) {
            strokes.push({
                id: `stroke-${i}`, type: 'path', color: '#000000', size: 3, opacity: 1, mode: 'brush',
                points: Array.from({ length: 10 }, (_, j) => ({ x: i + j, y: i - j }))
            })
        }
        const totalSize = JSON.stringify(strokes).length

        const layers = [{
            id: 'layer-0', name: 'Drawing', visible: true, opacity: 100, blendMode: 'mix', locked: false,
            offsetX: 0, offsetY: 0, scaleX: 1, scaleY: 1, rotation: 0, flipH: false, flipV: false,
            sourceType: 'drawing', mediaFile: null, mediaType: null, effectId: null, effectParams: {},
            strokes, drawingCanvas: null, children: [], mask: null, maskEnabled: true, maskVisible: false
        }]

        const nodes = buildNodeModel(layers, { width: 100, height: 100 })
        const strokeNodes = nodes.filter(n => n.kind === 'layers-strokes')
        const layerJson = JSON.parse(nodes.find(n => n.id === 'Llayer-0').text)
        const applied = applyNodesToComposition(nodes, [])

        return {
            totalSize,
            chunkCount: strokeNodes.length,
            strokesMetaN: layerJson.strokesMeta.n,
            allChunksUnderCap: strokeNodes.every(n => n.text.length <= 65536),
            reassembledCount: applied.layers[0].strokes.length,
            reassembledMatches: JSON.stringify(applied.layers[0].strokes) === JSON.stringify(strokes)
        }
    })

    expect(result.totalSize).toBeGreaterThan(48000)
    expect(result.chunkCount).toBeGreaterThan(1)
    expect(result.strokesMetaN).toBe(result.chunkCount)
    expect(result.allChunksUnderCap).toBe(true)
    expect(result.reassembledCount).toBe(1000)
    expect(result.reassembledMatches).toBe(true)
})

test('a single oversized stroke splits at shared point boundaries and reassembles losslessly', async ({ page }) => {
    await page.goto('/')
    const result = await page.evaluate(async () => {
        const { buildNodeModel, applyNodesToComposition } = await import('/js/collab/docModel.js')

        // One 'path' stroke whose OWN serialized size already exceeds the
        // 48KB chunk budget — chunkStrokes() must split IT, not just place
        // it whole in its own oversized (server-rejectable) chunk.
        const points = Array.from({ length: 4000 }, (_, i) => ({ x: i % 997, y: (i * 7) % 991 }))
        const bigStroke = { id: 'stroke-big', type: 'path', color: '#123456', size: 7, opacity: 0.8, mode: 'brush', points }
        const soloSize = JSON.stringify(bigStroke).length

        const layers = [{
            id: 'layer-0', name: 'Drawing', visible: true, opacity: 100, blendMode: 'mix', locked: false,
            offsetX: 0, offsetY: 0, scaleX: 1, scaleY: 1, rotation: 0, flipH: false, flipV: false,
            sourceType: 'drawing', mediaFile: null, mediaType: null, effectId: null, effectParams: {},
            strokes: [bigStroke], drawingCanvas: null, children: [], mask: null, maskEnabled: true, maskVisible: false
        }]

        const nodes = buildNodeModel(layers, { width: 100, height: 100 })
        const strokeNodes = nodes.filter(n => n.kind === 'layers-strokes')
        const applied = applyNodesToComposition(nodes, [])
        const segments = applied.layers[0].strokes

        // Concatenate every reassembled segment's points, dropping the
        // duplicate boundary point each pair of consecutive segments shares
        // (segment N's last point === segment N+1's first point), and
        // confirm the merged sequence matches the original exactly.
        let mergedPoints = []
        for (const s of segments) {
            mergedPoints = mergedPoints.concat(mergedPoints.length > 0 ? s.points.slice(1) : s.points)
        }

        return {
            soloSize,
            segmentCount: segments.length,
            segmentIdsUnique: new Set(segments.map(s => s.id)).size === segments.length,
            nonPointPropsPreserved: segments.every(s =>
                s.type === bigStroke.type && s.color === bigStroke.color &&
                s.size === bigStroke.size && s.opacity === bigStroke.opacity && s.mode === bigStroke.mode),
            allChunksUnderCap: strokeNodes.every(n => n.text.length <= 65536),
            mergedMatchesOriginal: JSON.stringify(mergedPoints) === JSON.stringify(points)
        }
    })

    expect(result.soloSize).toBeGreaterThan(48000)
    expect(result.segmentCount).toBeGreaterThan(1)
    expect(result.segmentIdsUnique).toBe(true)
    expect(result.nonPointPropsPreserved).toBe(true)
    expect(result.allChunksUnderCap).toBe(true)
    expect(result.mergedMatchesOriginal).toBe(true)
})

test('mask chunk-set corruption and incompleteness both fall back to the previous mask', async ({ page }) => {
    await page.goto('/')
    const result = await page.evaluate(async () => {
        const { buildNodeModel, applyNodesToComposition } = await import('/js/collab/docModel.js')

        const mask = new ImageData(8, 8)
        for (let i = 0; i < mask.data.length; i += 4) {
            mask.data[i] = 200; mask.data[i + 1] = 200; mask.data[i + 2] = 200; mask.data[i + 3] = 255
        }
        const layers = [{
            id: 'layer-0', name: 'Masked', visible: true, opacity: 100, blendMode: 'mix', locked: false,
            offsetX: 0, offsetY: 0, scaleX: 1, scaleY: 1, rotation: 0, flipH: false, flipV: false,
            sourceType: 'effect', mediaFile: null, mediaType: null, effectId: 'synth/solid', effectParams: {},
            strokes: undefined, drawingCanvas: null, children: [], mask, maskEnabled: true, maskVisible: false
        }]
        const nodes = buildNodeModel(layers, { width: 50, height: 50 })
        const previous = [{ id: 'layer-0', mask: 'PREVIOUS_MASK_STRING', strokes: undefined }]

        // Case A: corrupt a mask chunk's data so the reassembled hash won't match.
        const corrupted = nodes.map(n => {
            if (n.kind !== 'layers-mask') return n
            const parsed = JSON.parse(n.text)
            parsed.data = 'CORRUPTED' + parsed.data.slice(9)
            return { ...n, text: JSON.stringify(parsed) }
        })
        const appliedCorrupt = applyNodesToComposition(corrupted, previous)

        // Case B: drop a mask chunk entirely (incomplete set).
        const firstMaskId = nodes.find(n => n.kind === 'layers-mask').id
        const incomplete = nodes.filter(n => n.id !== firstMaskId)
        const appliedIncomplete = applyNodesToComposition(incomplete, previous)

        // Control: unmodified nodes reassemble normally, i.e. NOT the fallback.
        const appliedClean = applyNodesToComposition(nodes, previous)

        return {
            corruptFallback: appliedCorrupt.layers[0].mask,
            incompleteFallback: appliedIncomplete.layers[0].mask,
            cleanIsNotFallback: appliedClean.layers[0].mask !== 'PREVIOUS_MASK_STRING' && typeof appliedClean.layers[0].mask === 'string'
        }
    })

    expect(result.corruptFallback).toBe('PREVIOUS_MASK_STRING')
    expect(result.incompleteFallback).toBe('PREVIOUS_MASK_STRING')
    expect(result.cleanIsNotFallback).toBe(true)
})

test('order self-heals: unknown entries ignored, missing nodes appended sorted by id', async ({ page }) => {
    await page.goto('/')
    const result = await page.evaluate(async () => {
        const { resolveOrder, applyNodesToComposition } = await import('/js/collab/docModel.js')

        const resolved = resolveOrder(['Lz', 'Lghost', 'La'], ['La', 'Lb', 'Lz'])

        const layerJson = (id) => JSON.stringify({
            v: 1, name: id, visible: true, opacity: 100, blendMode: 'mix', locked: false,
            offsetX: 0, offsetY: 0, scaleX: 1, scaleY: 1, rotation: 0, flipH: false, flipV: false,
            sourceType: 'effect', mediaType: null, effectId: 'synth/solid', effectParams: {},
            maskEnabled: true, maskVisible: false, childOrder: [], strokesMeta: null, maskMeta: null
        })
        // meta.order references a phantom node and omits the real "La" node —
        // both should self-heal per §5.
        const nodes = [
            { id: 'meta', kind: 'layers-meta', parentId: null, text: JSON.stringify({ v: 1, canvas: { w: 10, h: 10 }, order: ['Lb', 'Lghost'] }) },
            { id: 'La', kind: 'layers-layer', parentId: null, text: layerJson('La') },
            { id: 'Lb', kind: 'layers-layer', parentId: null, text: layerJson('Lb') }
        ]
        const applied = applyNodesToComposition(nodes, [])

        return { resolved, appliedIds: applied.layers.map(l => l.id) }
    })

    expect(result.resolved).toEqual(['Lz', 'La', 'Lb'])
    expect(result.appliedIds).toEqual(['b', 'a'])
})

test('isLayersSession requires a well-formed meta node', async ({ page }) => {
    await page.goto('/')
    const result = await page.evaluate(async () => {
        const { isLayersSession, buildNodeModel } = await import('/js/collab/docModel.js')
        return {
            empty: isLayersSession([]),
            noMeta: isLayersSession([{ id: 'Lfoo', kind: 'layers-layer', text: '{}', parentId: null }]),
            malformedMeta: isLayersSession([{ id: 'meta', kind: 'layers-meta', text: '{"v":1}', parentId: null }]),
            dslDialectShaped: isLayersSession([{ id: 'main', kind: 'noisemaker-dsl', text: 'render(o0)', parentId: null }]),
            valid: isLayersSession(buildNodeModel([], { width: 100, height: 100 }))
        }
    })

    expect(result.empty).toBe(false)
    expect(result.noMeta).toBe(false)
    expect(result.malformedMeta).toBe(false)
    expect(result.dslDialectShaped).toBe(false)
    expect(result.valid).toBe(true)
})

test('a media-typed layer node applies as a flagged placeholder, never throws', async ({ page }) => {
    await page.goto('/')
    const result = await page.evaluate(async () => {
        const { buildNodeModel, applyNodesToComposition } = await import('/js/collab/docModel.js')
        const layers = [{
            id: 'layer-0', name: 'Photo', visible: true, opacity: 100, blendMode: 'mix', locked: false,
            offsetX: 0, offsetY: 0, scaleX: 1, scaleY: 1, rotation: 0, flipH: false, flipV: false,
            sourceType: 'media', mediaFile: null, mediaType: 'image', effectId: null, effectParams: {},
            strokes: undefined, drawingCanvas: null, children: [], mask: null, maskEnabled: true, maskVisible: false
        }]
        const nodes = buildNodeModel(layers, { width: 100, height: 100 })

        let threw = false
        let applied
        try {
            applied = applyNodesToComposition(nodes, [])
        } catch {
            threw = true
        }

        return { threw, layer: applied?.layers[0], placeholderIds: applied?.mediaPlaceholderLayerIds }
    })

    expect(result.threw).toBe(false)
    expect(result.layer.sourceType).toBe('media')
    expect(result.layer.mediaFile).toBeNull()
    expect(result.layer.remoteMediaPlaceholder).toBe(true)
    expect(result.placeholderIds).toEqual(['layer-0'])
})
