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

test('remote bounds reject invalid canvas dimensions', async ({ page }) => {
    await page.goto('/')
    const result = await page.evaluate(async () => {
        const {
            MAX_REMOTE_CANVAS_DIMENSION,
            assertRemoteNodeModelWithinBounds,
        } = await import('/js/collab/docModel.js')

        const nodesFor = (width, height = 100) => [{
            id: 'meta',
            kind: 'layers-meta',
            text: JSON.stringify({ v: 1, canvas: { w: width, h: height }, order: [] }),
            parentId: null,
        }]
        const cases = [
            ['negative', -1],
            ['fractional', 1.5],
            ['string', '100'],
            ['non-safe', Number.MAX_SAFE_INTEGER + 1],
            ['oversized', MAX_REMOTE_CANVAS_DIMENSION + 1],
        ]
        const errors = cases.map(([name, width]) => {
            try {
                assertRemoteNodeModelWithinBounds(nodesFor(width))
                return [name, null]
            } catch (err) {
                return [name, err.message]
            }
        })
        let maxAccepted = true
        try {
            assertRemoteNodeModelWithinBounds(nodesFor(
                MAX_REMOTE_CANVAS_DIMENSION, MAX_REMOTE_CANVAS_DIMENSION))
        } catch {
            maxAccepted = false
        }
        return { errors, maxAccepted }
    })

    expect(result.errors.map(([name]) => name)).toEqual([
        'negative', 'fractional', 'string', 'non-safe', 'oversized',
    ])
    for (const [, error] of result.errors) expect(error).toMatch(/canvas/i)
    expect(result.maxAccepted).toBe(true)
})

test('remote bounds reject invalid or oversized layer scales while allowing fractional scale and flips', async ({ page }) => {
    await page.goto('/')
    const result = await page.evaluate(async () => {
        const { assertRemoteNodeModelWithinBounds, buildNodeModel } =
            await import('/js/collab/docModel.js')
        const meta = {
            id: 'meta', kind: 'layers-meta', parentId: null,
            text: JSON.stringify({
                v: 1, canvas: { w: 100, h: 100 }, order: ['Lmedia'],
            }),
        }
        const layer = (scaleX, extra = {}) => ({
            id: 'Lmedia', kind: 'layers-layer', parentId: null,
            text: JSON.stringify({
                v: 1, sourceType: 'media', visible: true,
                scaleX, scaleY: 1, flipH: false, flipV: false,
                childOrder: [], maskMeta: null, ...extra,
            }),
        })
        const rejection = (node) => {
            try {
                assertRemoteNodeModelWithinBounds([meta, node])
                return null
            } catch (err) {
                return err.message
            }
        }
        const infinity = layer(1)
        infinity.text = infinity.text.replace('"scaleX":1', '"scaleX":1e400')
        const nan = layer(1)
        nan.text = nan.text.replace('"scaleX":1', '"scaleX":NaN')
        let negativeRoundTrip = null
        try {
            assertRemoteNodeModelWithinBounds(buildNodeModel([{
                id: 'negative-local', name: 'Negative local transform',
                visible: true, opacity: 100, blendMode: 'mix', locked: false,
                offsetX: 0, offsetY: 0, scaleX: -0.5, scaleY: 0.75,
                rotation: 0, flipH: false, flipV: true,
                sourceType: 'media', mediaType: 'image', effectId: null,
                effectParams: {}, children: [], mask: null,
                maskEnabled: true, maskVisible: false,
            }], { width: 100, height: 100 }))
        } catch (err) {
            negativeRoundTrip = err.message
        }
        return {
            zero: rejection(layer(0)),
            negative: rejection(layer(-1, { flipH: true })),
            infinity: rejection(infinity),
            nan: rejection(nan),
            oversized: rejection(layer(9000)),
            fullBudgetMedia: rejection(layer(8192, { scaleY: 8192 })),
            fractional: rejection(layer(0.25, { flipH: true, flipV: true })),
            emptyDrawing: rejection(layer(1_000_000, {
                sourceType: 'drawing', mediaType: null, scaleY: -1_000_000,
                strokesMeta: null,
            })),
            negativeRoundTrip,
        }
    })

    expect(result.zero).toMatch(/scale/i)
    expect(result.negative).toBeNull()
    expect(result.infinity).toMatch(/scale/i)
    expect(result.nan).toMatch(/layer/i)
    expect(result.oversized).toMatch(/dimension/i)
    expect(result.fullBudgetMedia).toMatch(/raster pixels/i)
    expect(result.fractional).toBeNull()
    expect(result.emptyDrawing).toBeNull()
    expect(result.negativeRoundTrip).toBeNull()
})

test('remote bounds include transformed drawing canvases in the aggregate raster budget', async ({ page }) => {
    await page.goto('/')
    const result = await page.evaluate(async () => {
        const { assertRemoteNodeModelWithinBounds } =
            await import('/js/collab/docModel.js')
        const meta = {
            id: 'meta', kind: 'layers-meta', parentId: null,
            text: JSON.stringify({
                v: 1,
                canvas: { w: 4000, h: 4000 },
                order: ['Lone', 'Ltwo'],
            }),
        }
        const layer = id => ({
            id: `L${id}`, kind: 'layers-layer', parentId: null,
            text: JSON.stringify({
                v: 1, sourceType: 'drawing', visible: true,
                scaleX: 1.5, scaleY: 1.5, flipH: false, flipV: false,
                strokesMeta: { n: 1 }, childOrder: [], maskMeta: null,
            }),
        })
        try {
            assertRemoteNodeModelWithinBounds([meta, layer('one'), layer('two')])
            return null
        } catch (err) {
            return err.message
        }
    })

    expect(result).toMatch(/raster pixels/i)
})

test('remote node semantics reject renderer DSL injection and malformed declared parameters', async ({ page }) => {
    await page.goto('/')
    const result = await page.evaluate(async () => {
        const {
            assertRemoteNodeModelWithinBounds,
            assertRemoteNodeSemantics,
        } = await import('/js/collab/docModel.js')
        const manifest = {
            'synth/solid': { starter: true },
            'synth/gradient': { starter: true },
            'filter/blur': { starter: false },
            'filter/text': { starter: false },
            'filter/vector': { starter: false },
            'filter/channel': { starter: false },
            'synth3d/cellularAutomata3d': { starter: true },
            'mixer/mashup': { starter: true },
        }
        const definitions = {
            'synth/solid': {
                globals: {
                    color: { type: 'color' },
                    alpha: { type: 'float', min: 0, max: 1 },
                },
            },
            'synth/gradient': { globals: { type: { type: 'int' } } },
            'filter/blur': {
                globals: { radiusX: { type: 'float', min: 0, max: 50 } },
            },
            'filter/text': {
                globals: {
                    text: { type: 'string' },
                    font: {
                        type: 'string',
                        choices: { Nunito: 'Nunito' },
                    },
                    justify: {
                        type: 'string',
                        choices: { Left: 'left', Center: 'center', Right: 'right' },
                    },
                    color: { type: 'color' },
                },
            },
            'filter/vector': { globals: { point: { type: 'vec2' } } },
            'filter/channel': {
                globals: { channel: { type: 'member', enum: 'channel' } },
            },
            'synth3d/cellularAutomata3d': {
                globals: {
                    source: { type: 'volume' },
                    geoSource: { type: 'geometry' },
                },
            },
            'mixer/mashup': { globals: {} },
        }
        const options = {
            manifest,
            layerEffectIds: new Set([
                'synth/solid', 'synth/gradient', 'filter/blur',
                'filter/text', 'filter/vector', 'filter/channel',
                'synth3d/cellularAutomata3d',
            ]),
            childEffectIds: new Set([
                'filter/blur', 'filter/text', 'filter/vector', 'filter/channel',
            ]),
            getEffectDefinition: async effectId => definitions[effectId] || null,
            getDeclaredDslIdentifierValues: spec => ({
                member: ['channel.r', 'channel.g', 'channel.b', 'channel.a'],
                volume: Array.from({ length: 8 }, (_, index) => `vol${index}`),
                geometry: Array.from({ length: 8 }, (_, index) => `geo${index}`),
            })[spec.type] || [],
        }
        const nodesFor = (layerProps = {}, childProps = null) => {
            const layer = {
                v: 1, name: 'Remote', visible: true, opacity: 100,
                blendMode: 'mix', locked: false,
                offsetX: 0, offsetY: 0, scaleX: 1, scaleY: 1,
                rotation: 0, flipH: false, flipV: false,
                sourceType: 'effect', mediaType: null,
                effectId: 'synth/solid',
                effectParams: { color: [0.2, 0.3, 0.4], alpha: 1 },
                childOrder: childProps ? ['Lremote.Cchild'] : [],
                strokesMeta: null, maskMeta: null,
                maskEnabled: true, maskVisible: false,
                ...layerProps,
            }
            const nodes = [{
                id: 'meta', kind: 'layers-meta', parentId: null,
                text: JSON.stringify({
                    v: 1, canvas: { w: 100, h: 100 }, order: ['Lremote'],
                }),
            }, {
                id: 'Lremote', kind: 'layers-layer', parentId: null,
                text: JSON.stringify(layer),
            }]
            if (childProps) {
                nodes.push({
                    id: 'Lremote.Cchild', kind: 'layers-child', parentId: 'Lremote',
                    text: JSON.stringify({
                        v: 1, name: 'Child', visible: true,
                        effectId: 'filter/blur', effectParams: { radiusX: 5 },
                        ...childProps,
                    }),
                })
            }
            return nodes
        }
        const rejection = async (nodes) => {
            try {
                assertRemoteNodeModelWithinBounds(nodes)
                await assertRemoteNodeSemantics(nodes, options)
                return null
            } catch (err) {
                return err.message
            }
        }

        const unsafeKeyNodes = nodesFor({
            effectParams: { 'alpha) .write(o9)': 1 },
        })
        const inheritedNameNodes = nodesFor({
            effectParams: JSON.parse('{"__proto__":1}'),
        })
        const nonfiniteNodes = nodesFor({ effectParams: { alpha: 1 } })
        nonfiniteNodes[1].text = nonfiniteNodes[1].text.replace(
            '"effectParams":{"alpha":1}', '"effectParams":{"alpha":1e400}')
        const nonfiniteScalarNodes = nodesFor({ opacity: 1 })
        nonfiniteScalarNodes[1].text = nonfiniteScalarNodes[1].text.replace(
            '"opacity":1', '"opacity":1e400')

        return {
            effectId: await rejection(nodesFor({
                effectId: 'synth/solid).write(o9)', effectParams: {},
            })),
            disallowedLayerEffect: await rejection(nodesFor({
                effectId: 'mixer/mashup', effectParams: {},
            })),
            key: await rejection(unsafeKeyNodes),
            inheritedName: await rejection(inheritedNameNodes),
            tripleQuote: await rejection(nodesFor({
                effectId: 'filter/text', effectParams: { text: 'safe""".write(o9)' },
            })),
            color: await rejection(nodesFor({
                effectParams: { color: '#fff).write(o9)', alpha: 1 },
            })),
            vector: await rejection(nodesFor({
                effectId: 'filter/vector', effectParams: { point: [0, '1).write(o9)'] },
            })),
            nonfinite: await rejection(nonfiniteNodes),
            sourceType: await rejection(nodesFor({ sourceType: 'effect).write(o9)' })),
            blendMode: await rejection(nodesFor({ blendMode: 'mix).write(o9)' })),
            scalar: await rejection(nonfiniteScalarNodes),
            childEffect: await rejection(nodesFor({}, {
                effectId: 'synth/gradient', effectParams: { type: 0 },
            })),
            childTripleQuote: await rejection(nodesFor({}, {
                effectId: 'filter/text', effectParams: { text: 'x""".write(o9)' },
            })),
            member: await rejection(nodesFor({}, {
                effectId: 'filter/channel',
                effectParams: { channel: 'channel.notARealMember' },
            })),
            volume: await rejection(nodesFor({
                effectId: 'synth3d/cellularAutomata3d',
                effectParams: { source: 'vol999', geoSource: 'geo0' },
            })),
            geometry: await rejection(nodesFor({
                effectId: 'synth3d/cellularAutomata3d',
                effectParams: { source: 'vol0', geoSource: 'geo999' },
            })),
            rgba: await rejection(nodesFor({}, {
                effectId: 'filter/text',
                effectParams: { color: [1, 0, 0, 0.5] },
            })),
            stringChoice: await rejection(nodesFor({}, {
                effectId: 'filter/text',
                effectParams: { text: 'Choice', justify: 'diagonal' },
            })),
            freeformFont: await rejection(nodesFor({}, {
                effectId: 'filter/text',
                effectParams: { text: 'Font', font: 'Arial Black' },
            })),
            valid: await rejection(nodesFor({}, {
                effectId: 'filter/blur', effectParams: { radiusX: 12 },
            })),
        }
    })

    expect(result.effectId).toMatch(/effectId/i)
    expect(result.disallowedLayerEffect).toMatch(/layer effect/i)
    expect(result.key).toMatch(/parameter key/i)
    expect(result.inheritedName).toMatch(/not declared/i)
    expect(result.tripleQuote).toMatch(/triple quotes/i)
    expect(result.color).toMatch(/color/i)
    expect(result.vector).toMatch(/vec2/i)
    expect(result.nonfinite).toMatch(/finite number/i)
    expect(result.sourceType).toMatch(/sourceType/i)
    expect(result.blendMode).toMatch(/blendMode/i)
    expect(result.scalar).toMatch(/opacity/i)
    expect(result.childEffect).toMatch(/child effect/i)
    expect(result.childTripleQuote).toMatch(/triple quotes/i)
    expect(result.member).toMatch(/declared enum member/i)
    expect(result.volume).toMatch(/volume/i)
    expect(result.geometry).toMatch(/geometry/i)
    expect(result.rgba).toMatch(/RGB array/i)
    expect(result.stringChoice).toMatch(/declared choice/i)
    expect(result.freeformFont).toBeNull()
    expect(result.valid).toBeNull()
})

test('remote bounds cap node, layer, per-node text, and document text totals', async ({ page }) => {
    await page.goto('/')
    const result = await page.evaluate(async () => {
        const {
            MAX_REMOTE_LAYERS,
            MAX_REMOTE_NODES,
            MAX_REMOTE_NODE_TEXT_CHARS,
            MAX_REMOTE_TOTAL_TEXT_CHARS,
            assertRemoteNodeModelWithinBounds,
        } = await import('/js/collab/docModel.js')
        const meta = {
            id: 'meta',
            kind: 'layers-meta',
            text: JSON.stringify({ v: 1, canvas: { w: 100, h: 100 }, order: [] }),
            parentId: null,
        }
        const rejection = (nodes) => {
            try {
                assertRemoteNodeModelWithinBounds(nodes)
                return null
            } catch (err) {
                return err.message
            }
        }

        const tooManyNodes = [meta]
        for (let i = 1; i <= MAX_REMOTE_NODES; i++) {
            tooManyNodes.push({ id: `N${i}`, kind: 'other', text: '{}', parentId: null })
        }

        const tooManyLayers = [meta]
        const layerText = JSON.stringify({ v: 1, childOrder: [], maskMeta: null })
        for (let i = 0; i <= MAX_REMOTE_LAYERS; i++) {
            tooManyLayers.push({
                id: `L${i}`, kind: 'layers-layer', text: layerText, parentId: null,
            })
        }

        const tooLongText = [meta, {
            id: 'Ntext',
            kind: 'other',
            text: 'x'.repeat(MAX_REMOTE_NODE_TEXT_CHARS + 1),
            parentId: null,
        }]

        const sharedText = 'x'.repeat(MAX_REMOTE_NODE_TEXT_CHARS)
        const totalTextNodes = [meta]
        const textNodeCount = Math.floor(MAX_REMOTE_TOTAL_TEXT_CHARS / sharedText.length) + 1
        for (let i = 0; i < textNodeCount; i++) {
            totalTextNodes.push({
                id: `T${i}`, kind: 'other', text: sharedText, parentId: null,
            })
        }

        return {
            node: rejection(tooManyNodes),
            layer: rejection(tooManyLayers),
            perNodeText: rejection(tooLongText),
            totalText: rejection(totalTextNodes),
        }
    })

    expect(result.node).toMatch(/node count/i)
    expect(result.layer).toMatch(/layer count/i)
    expect(result.perNodeText).toMatch(/node text/i)
    expect(result.totalText).toMatch(/document text/i)
})

test('remote bounds reject malformed node and parent identities', async ({ page }) => {
    await page.goto('/')
    const result = await page.evaluate(async () => {
        const { assertRemoteNodeModelWithinBounds } =
            await import('/js/collab/docModel.js')
        const rejection = (node) => {
            try {
                assertRemoteNodeModelWithinBounds([node])
                return null
            } catch (err) {
                return err.message
            }
        }
        const node = (id = 'node', parentId = null) => ({
            id, parentId, kind: 'other', text: '{}',
        })
        return {
            nonStringId: rejection(node(7)),
            emptyId: rejection(node('')),
            oversizedId: rejection(node('n'.repeat(1025))),
            nonStringParent: rejection(node('child', 7)),
            emptyParent: rejection(node('child', '')),
            oversizedParent: rejection(node('child', 'p'.repeat(1025))),
            validParent: rejection(node('child', 'parent')),
        }
    })

    expect(result.nonStringId).toMatch(/node id/i)
    expect(result.emptyId).toMatch(/node id/i)
    expect(result.oversizedId).toMatch(/node id/i)
    expect(result.nonStringParent).toMatch(/parent id/i)
    expect(result.emptyParent).toMatch(/parent id/i)
    expect(result.oversizedParent).toMatch(/parent id/i)
    expect(result.validParent).toBeNull()
})

test('remote bounds reject wire identities that normalize to invalid or duplicate local ids', async ({ page }) => {
    await page.goto('/')
    const result = await page.evaluate(async () => {
        const { assertRemoteNodeModelWithinBounds } =
            await import('/js/collab/docModel.js')
        const layerText = JSON.stringify({ v: 1, childOrder: [], maskMeta: null })
        const childText = JSON.stringify({ v: 1 })
        const layer = id => ({
            id, kind: 'layers-layer', parentId: null, text: layerText,
        })
        const child = (id, parentId) => ({
            id, kind: 'layers-child', parentId, text: childText,
        })
        const strokes = (id, parentId, index) => ({
            id, kind: 'layers-strokes', parentId,
            text: JSON.stringify({ v: 1, i: index, strokes: [] }),
        })
        const rejection = nodes => {
            try {
                assertRemoteNodeModelWithinBounds(nodes)
                return null
            } catch (err) {
                return err.message
            }
        }
        return {
            layerPrefix: rejection([layer('Xa')]),
            dottedLayer: rejection([layer('La.bad')]),
            childPrefix: rejection([layer('La'), child('Lb.Cchild', 'La')]),
            chunkPrefix: rejection([layer('La'), strokes('Lb.S0', 'La', 0)]),
            chunkIndex: rejection([layer('La'), strokes('La.S01', 'La', 1)]),
            missingParent: rejection([child('La.Cchild', 'La')]),
            layerChildCollision: rejection([
                layer('La'), layer('Lb'), child('Lb.Ca', 'Lb'),
            ]),
            crossParentChildCollision: rejection([
                layer('La'), layer('Lb'),
                child('La.Csame', 'La'), child('Lb.Csame', 'Lb'),
            ]),
        }
    })

    expect(result.layerPrefix).toMatch(/layers-layer wire id/i)
    expect(result.dottedLayer).toMatch(/layers-layer wire id/i)
    expect(result.childPrefix).toMatch(/layers-child wire id/i)
    expect(result.chunkPrefix).toMatch(/layers-strokes wire id/i)
    expect(result.chunkIndex).toMatch(/layers-strokes wire id/i)
    expect(result.missingParent).toMatch(/parent layer is missing/i)
    expect(result.layerChildCollision).toMatch(/duplicate normalized local id/i)
    expect(result.crossParentChildCollision).toMatch(/duplicate normalized local id/i)
})

test('empty drawing candidates avoid raster allocation', async ({ page }) => {
    await page.goto('/', { waitUntil: 'networkidle' })
    await page.locator('#loading-screen').waitFor({ state: 'hidden' })
    const result = await page.evaluate(async () => {
        const { assertRemoteNodeModelWithinBounds } =
            await import('/js/collab/docModel.js')
        const app = window.layersApp
        app._strokeRenderer = null
        const originalCreateElement = document.createElement.bind(document)
        let canvasAllocations = 0
        document.createElement = (name, options) => {
            if (String(name).toLowerCase() === 'canvas') canvasAllocations++
            return originalCreateElement(name, options)
        }
        try {
            const emptyLayerNodes = Array.from({ length: 300 }, (_, index) => ({
                id: `Lempty-${index}`,
                kind: 'layers-layer',
                parentId: null,
                text: JSON.stringify({
                    v: 1,
                    sourceType: 'drawing',
                    childOrder: [],
                    maskMeta: null,
                    strokesMeta: null,
                }),
            }))
            assertRemoteNodeModelWithinBounds([{
                id: 'meta',
                kind: 'layers-meta',
                parentId: null,
                text: JSON.stringify({
                    v: 1,
                    canvas: { w: 8192, h: 8192 },
                    order: emptyLayerNodes.map(node => node.id),
                }),
            }, ...emptyLayerNodes])
            const results = await Promise.all(Array.from({ length: 300 }, (_, index) =>
                app._createDrawingLayerCanvas({
                    id: `empty-${index}`, sourceType: 'drawing', strokes: [],
                    drawingCanvas: {},
                }, 8192, 8192)))
            return {
                allNull: results.every(value => value === null),
                boundsAccepted: true,
                canvasAllocations,
                strokeRendererCreated: app._strokeRenderer !== null,
            }
        } finally {
            document.createElement = originalCreateElement
        }
    })

    expect(result).toEqual({
        allNull: true,
        boundsAccepted: true,
        canvasAllocations: 0,
        strokeRendererCreated: false,
    })
})

for (const rasterCase of [
    {
        name: 'drawing',
        props: { sourceType: 'drawing', strokesMeta: { n: 1 } },
    },
    {
        name: 'text',
        props: {
            sourceType: 'effect', effectId: 'filter/text', visible: true,
        },
    },
]) {
    test(`remote bounds cap aggregate ${rasterCase.name} raster pixels`, async ({ page }) => {
        await page.goto('/')
        const result = await page.evaluate(async ({ props }) => {
            const { assertRemoteNodeModelWithinBounds } =
                await import('/js/collab/docModel.js')
            const meta = {
                id: 'meta', kind: 'layers-meta', parentId: null,
                text: JSON.stringify({
                    v: 1,
                    canvas: { w: 8192, h: 8192 },
                    order: ['Lone', 'Ltwo'],
                }),
            }
            const layer = (id) => ({
                id: `L${id}`, kind: 'layers-layer', parentId: null,
                text: JSON.stringify({
                    v: 1, childOrder: [], maskMeta: null, ...props,
                }),
            })
            try {
                assertRemoteNodeModelWithinBounds([meta, layer('one'), layer('two')])
                return null
            } catch (err) {
                return err.message
            }
        }, { props: rasterCase.props })

        expect(result).toMatch(/raster pixels/i)
    })
}

test('remote bounds reject oversized mask metadata, chunk totals, and decoded dimensions', async ({ page }) => {
    await page.goto('/')
    const result = await page.evaluate(async () => {
        const {
            MAX_REMOTE_CANVAS_DIMENSION,
            MAX_REMOTE_MASK_CHARS,
            MAX_REMOTE_MASK_CHUNKS,
            assertRemoteNodeModelWithinBounds,
        } = await import('/js/collab/docModel.js')

        const pngHeader = (width, height) => {
            const bytes = new Uint8Array([
                137, 80, 78, 71, 13, 10, 26, 10,
                0, 0, 0, 13, 73, 72, 68, 82,
                (width >>> 24) & 255, (width >>> 16) & 255,
                (width >>> 8) & 255, width & 255,
                (height >>> 24) & 255, (height >>> 16) & 255,
                (height >>> 8) & 255, height & 255,
            ])
            return `data:image/png;base64,${btoa(String.fromCharCode(...bytes))}`
        }
        const meta = (width = 100, height = 100) => ({
            id: 'meta',
            kind: 'layers-meta',
            text: JSON.stringify({ v: 1, canvas: { w: width, h: height }, order: [] }),
            parentId: null,
        })
        const layer = (id, maskCount = 1) => ({
            id: `L${id}`,
            kind: 'layers-layer',
            text: JSON.stringify({
                v: 1,
                childOrder: [],
                maskMeta: { n: maskCount, hash: '00000000' },
            }),
            parentId: null,
        })
        const mask = (id, parentId, data, index = 0) => ({
            id,
            kind: 'layers-mask',
            text: JSON.stringify({ v: 1, i: index, data }),
            parentId,
        })
        const rejection = (nodes) => {
            try {
                assertRemoteNodeModelWithinBounds(nodes)
                return null
            } catch (err) {
                return err.message
            }
        }

        const metadataNodes = [meta(), layer('metadata', MAX_REMOTE_MASK_CHUNKS + 1)]

        const chunkCountNodes = [meta(), layer('chunks')]
        const sharedSmallChunk = JSON.stringify({ v: 1, i: 1, data: 'A' })
        for (let i = 0; i <= MAX_REMOTE_MASK_CHUNKS; i++) {
            chunkCountNodes.push({
                id: `Lchunks.M${i}`,
                kind: 'layers-mask',
                text: sharedSmallChunk,
                parentId: 'Lchunks',
            })
        }

        const chunkTotalNodes = [meta(), layer('total')]
        const sharedLargeChunk = JSON.stringify({ v: 1, i: 1, data: 'A'.repeat(62000) })
        const chunkCountForTotal = Math.floor(MAX_REMOTE_MASK_CHARS / 62000) + 1
        for (let i = 0; i < chunkCountForTotal; i++) {
            chunkTotalNodes.push({
                id: `Ltotal.M${i}`,
                kind: 'layers-mask',
                text: sharedLargeChunk,
                parentId: 'Ltotal',
            })
        }

        const decodedOversize = [
            meta(MAX_REMOTE_CANVAS_DIMENSION, MAX_REMOTE_CANVAS_DIMENSION),
            layer('decoded'),
            mask('Ldecoded.M0', 'Ldecoded',
                pngHeader(MAX_REMOTE_CANVAS_DIMENSION + 1, 1)),
        ]
        const beyondCanvas = [
            meta(100, 100),
            layer('canvas'),
            mask('Lcanvas.M0', 'Lcanvas', pngHeader(101, 1)),
        ]
        const globalPixels = [
            meta(MAX_REMOTE_CANVAS_DIMENSION, MAX_REMOTE_CANVAS_DIMENSION),
            layer('pixels-a'),
            mask('Lpixels-a.M0', 'Lpixels-a',
                pngHeader(MAX_REMOTE_CANVAS_DIMENSION, 4097)),
            layer('pixels-b'),
            mask('Lpixels-b.M0', 'Lpixels-b',
                pngHeader(MAX_REMOTE_CANVAS_DIMENSION, 4097)),
        ]

        return {
            metadata: rejection(metadataNodes),
            chunkCount: rejection(chunkCountNodes),
            chunkTotal: rejection(chunkTotalNodes),
            decodedOversize: rejection(decodedOversize),
            beyondCanvas: rejection(beyondCanvas),
            globalPixels: rejection(globalPixels),
        }
    })

    expect(result.metadata).toMatch(/mask metadata/i)
    expect(result.chunkCount).toMatch(/mask chunk count/i)
    expect(result.chunkTotal).toMatch(/mask data/i)
    expect(result.decodedOversize).toMatch(/mask dimensions/i)
    expect(result.beyondCanvas).toMatch(/canvas/i)
    expect(result.globalPixels).toMatch(/mask pixels/i)
})
