/**
 * Layers <-> Seance node-doc mapping (session dialect "layers", v1).
 *
 * Pure, dependency-free mapping between the LayersApp `_layers` array (plus
 * canvas dimensions) and the flat node-doc shape Seance's `poly` lane
 * carries over the wire: `{id, kind, text, parentId}`, where `text` is
 * always a JSON string. No imports from the app — this module is testable
 * standalone (see tests/collab-doc-model.spec.js).
 *
 * Binding node contract (do not improvise different names/shapes — see
 * seance/docs/superpowers/specs/2026-07-09-layers-dialect-design.md §5):
 *
 *   meta                    layers-meta     {v, canvas:{w,h}, order:[...]}
 *   L<layerId>              layers-layer    {v, ...props, childOrder, strokesMeta, maskMeta}
 *   L<layerId>.C<childId>   layers-child    {v, name, effectId, effectParams, visible}
 *   L<layerId>.S<i>         layers-strokes  {v, i, strokes:[...]}         (chunk i)
 *   L<layerId>.M<i>         layers-mask     {v, i, data:"<base64 slice>"} (chunk i)
 *
 * Layer props = the `createLayer()` fields minus runtime objects
 * (drawingCanvas, mask ImageData, mediaFile) and minus strokes (chunked
 * separately). Ordering is owned by `meta.order` / layer `childOrder`;
 * readers self-heal drift (see resolveOrder). Deleting a layer deletes node
 * `L<id>`; the server cascades every `L<id>.*` descendant automatically.
 *
 * @module collab/docModel
 */

export const NODE_VERSION = 1
export const META_NODE_ID = 'meta'

// Chunk payload budget: keep chunk text comfortably under the protocol's
// 65,536-char node text cap.
export const CHUNK_BUDGET = 48000

const LAYER_PROP_KEYS = [
    'name', 'visible', 'opacity', 'blendMode', 'locked',
    'offsetX', 'offsetY', 'scaleX', 'scaleY', 'rotation', 'flipH', 'flipV',
    'sourceType', 'mediaType', 'effectId', 'effectParams',
    'maskEnabled', 'maskVisible'
]

// ---------------------------------------------------------------------
// id helpers — layer/child ids must not contain '.' (the dotted-id
// scheme uses '.' as the parent/child separator); sanitize defensively.
// ---------------------------------------------------------------------

function sanitizeId(id) {
    return String(id).replace(/\./g, '_')
}

function layerNodeId(layerId) {
    return `L${sanitizeId(layerId)}`
}

function childNodeId(layerId, childId) {
    return `${layerNodeId(layerId)}.C${sanitizeId(childId)}`
}

function strokesNodeId(layerId, i) {
    return `${layerNodeId(layerId)}.S${i}`
}

function maskNodeId(layerId, i) {
    return `${layerNodeId(layerId)}.M${i}`
}

function layerIdFromNodeId(nodeId) {
    return nodeId.slice(1) // "Lfoo" -> "foo"
}

function childIdFromNodeId(nodeId) {
    const i = nodeId.lastIndexOf('.C')
    return i === -1 ? null : nodeId.slice(i + 2)
}

function safeParse(text) {
    try {
        return JSON.parse(text)
    } catch {
        return null
    }
}

// ---------------------------------------------------------------------
// FNV-1a (32-bit) — cheap sync content hash for mask chunk-set guarding.
// Not cryptographic; just needs to be deterministic and collision-shy
// enough to catch chunks mixed from two generations of the same mask.
// ---------------------------------------------------------------------

export function fnv1a(str) {
    let hash = 0x811c9dc5
    const s = String(str ?? '')
    for (let i = 0; i < s.length; i++) {
        hash ^= s.charCodeAt(i)
        hash = Math.imul(hash, 0x01000193)
    }
    return (hash >>> 0).toString(16).padStart(8, '0')
}

// ---------------------------------------------------------------------
// Chunk helpers
// ---------------------------------------------------------------------

/**
 * Split a stroke array into chunks whose serialized size stays under the
 * chunk budget. Strokes are normally atomic (never split mid-stroke) — EXCEPT
 * a single stroke whose own serialized size already exceeds the budget (a
 * sustained freehand drag can sample thousands of points — see
 * tools/brush-tool.js MIN_DISTANCE), which splitOversizedStroke() below
 * breaks into several smaller strokes first so it can still be chunked
 * normally instead of producing one oversized, server-rejectable node.
 * @param {Array} strokes
 * @returns {Array<Array>} array of stroke-array chunks
 */
export function chunkStrokes(strokes) {
    if (!strokes || strokes.length === 0) return []
    const chunks = []
    let current = []
    let currentSize = 2 // "[]"
    for (const stroke of strokes) {
        for (const piece of splitOversizedStroke(stroke)) {
            const pieceSize = JSON.stringify(piece).length + 1
            if (current.length > 0 && currentSize + pieceSize > CHUNK_BUDGET) {
                chunks.push(current)
                current = []
                currentSize = 2
            }
            current.push(piece)
            currentSize += pieceSize
        }
    }
    if (current.length > 0) chunks.push(current)
    return chunks
}

/**
 * Split a single oversized stroke into consecutive point-range segments,
 * each individually at or under the chunk budget.
 *
 * The drawing rasterizer (drawing/stroke-renderer.js `_drawPath()`) renders
 * a 'path' stroke as ONE continuous curve, not point-stamped dabs:
 * moveTo(points[0]), then for each interior point a quadraticCurveTo using
 * that point as the control and the midpoint to the next point as the
 * curve's endpoint, finishing with lineTo(lastPoint). Because there's no
 * per-point "dab", a 'path' stroke can be split into consecutive point-range
 * segments with no visible gap, PROVIDED each segment shares its boundary
 * point with the next one (segment N's last point === segment N+1's first
 * point) — segment N+1's moveTo then starts exactly where segment N's
 * lineTo ended, so the rendered result is visually identical to the
 * unsplit curve (the curvature immediately adjacent to a boundary point
 * changes by a sub-pixel amount, since that point stops also acting as a
 * Bezier control point for its neighbor — imperceptible at the point
 * density brush strokes sample).
 *
 * Other stroke types don't carry an unbounded points array (rect/ellipse
 * have none, line/arrow always have exactly 2), so they can't legitimately
 * exceed the budget on their own and are left whole; a pathological
 * oversized non-path stroke still falls through as a single over-budget
 * chunk, same as this module's pre-existing fallback for an unsplittable
 * piece.
 *
 * @param {object} stroke
 * @returns {Array<object>} one or more strokes; each inherits every
 *   non-point property of the original stroke. Segment ids are derived
 *   deterministically (`${stroke.id}.${segmentIndex}`) — not randomly or
 *   from a counter — so calling this repeatedly on unchanged input always
 *   produces byte-identical output (required for the publish funnel's diff
 *   to see "no change" once a stroke has already been split once).
 */
function splitOversizedStroke(stroke) {
    if (stroke.type !== 'path' || !Array.isArray(stroke.points) || stroke.points.length < 2) {
        return [stroke]
    }
    if (JSON.stringify(stroke).length <= CHUNK_BUDGET) return [stroke]

    const points = stroke.points
    const restSize = JSON.stringify({ ...stroke, points: [] }).length
    const pointBudget = Math.max(CHUNK_BUDGET - restSize, 64)

    const segments = []
    let seg = [points[0]]
    let segLen = JSON.stringify(points[0]).length + 2 // brackets
    for (let i = 1; i < points.length; i++) {
        const point = points[i]
        const addLen = JSON.stringify(point).length + 1 // comma
        if (seg.length >= 2 && segLen + addLen > pointBudget) {
            segments.push(seg)
            seg = [seg[seg.length - 1]] // next segment shares the boundary point
            segLen = JSON.stringify(seg[0]).length + 2
        }
        seg.push(point)
        segLen += addLen
    }
    segments.push(seg)

    return segments.map((segPoints, i) => ({ ...stroke, id: `${stroke.id}.${i}`, points: segPoints }))
}

/**
 * Split a base64 string into fixed-size character slices.
 * @param {string} base64
 * @returns {Array<string>}
 */
export function chunkBase64(base64) {
    if (!base64) return []
    const chunks = []
    for (let i = 0; i < base64.length; i += CHUNK_BUDGET) {
        chunks.push(base64.slice(i, i + CHUNK_BUDGET))
    }
    return chunks
}

// ---------------------------------------------------------------------
// Ordering self-heal: order entries without a node are ignored; nodes
// missing from order append last (sorted by id) — tolerant of drift under
// the non-atomic two-op window (node upsert + meta upsert).
// ---------------------------------------------------------------------

export function resolveOrder(order, availableIds) {
    const available = new Set(availableIds)
    const used = new Set()
    const result = []
    for (const id of Array.isArray(order) ? order : []) {
        if (available.has(id) && !used.has(id)) {
            result.push(id)
            used.add(id)
        }
    }
    const missing = availableIds.filter(id => !used.has(id)).sort()
    result.push(...missing)
    return result
}

// ---------------------------------------------------------------------
// Mask <-> base64 PNG data URL (same encoding approach as
// utils/project-storage.js / layers/layer-model.js serializeLayers — a
// canvas round trip. No decode here; applyNodesToComposition returns the
// mask as a string and leaves ImageData decoding to the caller, exactly
// like project-storage's decodeMasks()).
// ---------------------------------------------------------------------

function encodeMaskToBase64(mask) {
    const canvas = document.createElement('canvas')
    canvas.width = mask.width
    canvas.height = mask.height
    canvas.getContext('2d').putImageData(mask, 0, 0)
    return canvas.toDataURL('image/png')
}

// ---------------------------------------------------------------------
// buildNodeModel
// ---------------------------------------------------------------------

/**
 * Build the full node-doc array for a composition.
 * @param {Array} layers - LayersApp._layers
 * @param {{width:number, height:number}} canvas
 * @returns {Array<{id:string, kind:string, text:string, parentId:string|null}>}
 */
export function buildNodeModel(layers, canvas) {
    const list = layers || []
    const nodes = []

    nodes.push({
        id: META_NODE_ID,
        kind: 'layers-meta',
        text: JSON.stringify({
            v: NODE_VERSION,
            canvas: { w: canvas?.width || 0, h: canvas?.height || 0 },
            order: list.map(l => layerNodeId(l.id))
        }),
        parentId: null
    })

    for (const layer of list) {
        const lid = layerNodeId(layer.id)

        // Compute chunk metadata (and build the chunk node objects) before
        // pushing anything, but don't push the chunk/child nodes onto the
        // array until AFTER the layer node itself: the server rejects a
        // child upsert as an unretryable "orphan" if its parent doesn't
        // exist yet, and publish send order follows this array's order, so
        // every parentId: lid node here must come after `lid` is pushed.
        let strokesMeta = null
        let strokeNodes = []
        if (layer.sourceType === 'drawing' && layer.strokes && layer.strokes.length > 0) {
            const chunks = chunkStrokes(layer.strokes)
            strokeNodes = chunks.map((strokeChunk, i) => ({
                id: strokesNodeId(layer.id, i),
                kind: 'layers-strokes',
                text: JSON.stringify({ v: NODE_VERSION, i, strokes: strokeChunk }),
                parentId: lid
            }))
            strokesMeta = { n: chunks.length }
        }

        let maskMeta = null
        let maskNodes = []
        if (layer.mask) {
            const base64 = encodeMaskToBase64(layer.mask)
            const hash = fnv1a(base64)
            const chunks = chunkBase64(base64)
            maskNodes = chunks.map((slice, i) => ({
                id: maskNodeId(layer.id, i),
                kind: 'layers-mask',
                text: JSON.stringify({ v: NODE_VERSION, i, data: slice }),
                parentId: lid
            }))
            maskMeta = { n: chunks.length, hash }
        }

        const props = {}
        for (const key of LAYER_PROP_KEYS) props[key] = layer[key] ?? null

        nodes.push({
            id: lid,
            kind: 'layers-layer',
            text: JSON.stringify({
                v: NODE_VERSION,
                ...props,
                childOrder: (layer.children || []).map(c => childNodeId(layer.id, c.id)),
                strokesMeta,
                maskMeta
            }),
            parentId: null
        })

        nodes.push(...strokeNodes)
        nodes.push(...maskNodes)

        for (const child of layer.children || []) {
            nodes.push({
                id: childNodeId(layer.id, child.id),
                kind: 'layers-child',
                text: JSON.stringify({
                    v: NODE_VERSION,
                    name: child.name,
                    effectId: child.effectId,
                    effectParams: child.effectParams || {},
                    visible: child.visible !== false
                }),
                parentId: lid
            })
        }
    }

    return nodes
}

// ---------------------------------------------------------------------
// diffNodeModels
// ---------------------------------------------------------------------

/**
 * Diff two node-doc arrays (both produced by buildNodeModel) into the
 * minimal set of upserts/deletes needed to move `prev` to `next`.
 * @param {Array} prev
 * @param {Array} next
 * @returns {{upserts: Array, deletes: Array<string>}}
 */
export function diffNodeModels(prev, next) {
    const prevMap = new Map((prev || []).map(n => [n.id, n]))
    const nextMap = new Map((next || []).map(n => [n.id, n]))

    const upserts = []
    for (const [id, node] of nextMap) {
        const before = prevMap.get(id)
        const parentId = node.parentId ?? null
        if (!before || before.kind !== node.kind || before.text !== node.text || (before.parentId ?? null) !== parentId) {
            upserts.push({ id: node.id, kind: node.kind, text: node.text, parentId })
        }
    }

    const deletes = []
    for (const id of prevMap.keys()) {
        if (!nextMap.has(id)) deletes.push(id)
    }

    return { upserts, deletes }
}

// ---------------------------------------------------------------------
// isLayersSession — reader validation per §5: interpretable iff a `meta`
// node exists with v===1 and a well-formed shape.
// ---------------------------------------------------------------------

export function isLayersSession(nodes) {
    const meta = (nodes || []).find(n => n.id === META_NODE_ID && n.kind === 'layers-meta')
    if (!meta) return false
    const parsed = safeParse(meta.text)
    if (!parsed || parsed.v !== NODE_VERSION) return false
    if (!parsed.canvas || typeof parsed.canvas.w !== 'number' || typeof parsed.canvas.h !== 'number') return false
    if (!Array.isArray(parsed.order)) return false
    return true
}

// ---------------------------------------------------------------------
// chunk reassembly (internal) — returns null when the chunk set is
// incomplete/inconsistent so the caller can keep the previous value.
// ---------------------------------------------------------------------

function reassembleStrokeChunks(nodes, parentNodeId, expectedCount) {
    if (!expectedCount || expectedCount <= 0) return []
    const byIndex = new Map()
    for (const n of nodes) {
        if (n.parentId !== parentNodeId || n.kind !== 'layers-strokes') continue
        const parsed = safeParse(n.text)
        if (!parsed || parsed.v !== NODE_VERSION || typeof parsed.i !== 'number') continue
        byIndex.set(parsed.i, parsed.strokes)
    }
    let strokes = []
    for (let i = 0; i < expectedCount; i++) {
        const piece = byIndex.get(i)
        if (!Array.isArray(piece)) return null
        strokes = strokes.concat(piece)
    }
    return strokes
}

function reassembleMaskChunks(nodes, parentNodeId, maskMeta) {
    const n = maskMeta?.n
    if (!n || n <= 0) return null
    const byIndex = new Map()
    for (const node of nodes) {
        if (node.parentId !== parentNodeId || node.kind !== 'layers-mask') continue
        const parsed = safeParse(node.text)
        if (!parsed || parsed.v !== NODE_VERSION || typeof parsed.i !== 'number') continue
        byIndex.set(parsed.i, parsed.data)
    }
    let combined = ''
    for (let i = 0; i < n; i++) {
        const slice = byIndex.get(i)
        if (typeof slice !== 'string') return null
        combined += slice
    }
    if (fnv1a(combined) !== maskMeta.hash) return null
    return combined
}

// ---------------------------------------------------------------------
// applyNodesToComposition
// ---------------------------------------------------------------------

/**
 * Tolerant reader: turn a node-doc array back into `{layers, canvas}`.
 * Never throws. Malformed individual nodes are skipped; an incomplete or
 * hash-inconsistent chunk set falls back to the matching layer's value in
 * `previousLayers` (or an empty value if there is none); a media-typed
 * layer becomes a placeholder-safe layer object flagged via
 * `remoteMediaPlaceholder` (its id is also collected in
 * `mediaPlaceholderLayerIds`) since media bytes never ride the wire.
 *
 * `mask`, when present, is the same base64 PNG data-url STRING shape
 * `layers/layer-model.js`'s serializeLayers()/decodeMasks() round-trip —
 * callers decode it to ImageData themselves (decodeMasks is not imported
 * here to keep this module free of app-adjacent dependencies).
 *
 * @param {Array} nodes - node-doc array (e.g. online.getNodes())
 * @param {Array} [previousLayers] - the composition's layers before this
 *   apply, used only as a fallback source for torn chunk reads
 * @returns {{layers: Array, canvas: {width:number, height:number}, mediaPlaceholderLayerIds: Array<string>}}
 */
export function applyNodesToComposition(nodes, previousLayers = []) {
    const list = nodes || []
    const byId = new Map(list.map(n => [n.id, n]))
    const prevById = new Map((previousLayers || []).map(l => [l.id, l]))
    const mediaPlaceholderLayerIds = []

    const meta = byId.get(META_NODE_ID)
    const metaParsed = meta ? safeParse(meta.text) : null
    if (!metaParsed || metaParsed.v !== NODE_VERSION || !metaParsed.canvas || !Array.isArray(metaParsed.order)) {
        return { layers: [], canvas: { width: 0, height: 0 }, mediaPlaceholderLayerIds }
    }

    const layerNodeIds = list.filter(n => n.kind === 'layers-layer').map(n => n.id)
    const orderedIds = resolveOrder(metaParsed.order, layerNodeIds)

    const layers = []
    for (const nodeId of orderedIds) {
        const node = byId.get(nodeId)
        if (!node) continue
        const parsed = safeParse(node.text)
        if (!parsed || parsed.v !== NODE_VERSION) continue

        const layerId = layerIdFromNodeId(nodeId)
        const prevLayer = prevById.get(layerId)

        // children
        const childNodeIds = list.filter(n => n.parentId === nodeId && n.kind === 'layers-child').map(n => n.id)
        const orderedChildIds = resolveOrder(parsed.childOrder, childNodeIds)
        const children = []
        for (const cid of orderedChildIds) {
            const cnode = byId.get(cid)
            if (!cnode) continue
            const cparsed = safeParse(cnode.text)
            if (!cparsed || cparsed.v !== NODE_VERSION) continue
            children.push({
                id: childIdFromNodeId(cid),
                name: cparsed.name,
                effectId: cparsed.effectId,
                effectParams: cparsed.effectParams || {},
                visible: cparsed.visible !== false
            })
        }

        // strokes (drawing layers only)
        let strokes = parsed.sourceType === 'drawing' ? [] : undefined
        if (parsed.sourceType === 'drawing' && parsed.strokesMeta) {
            const reassembled = reassembleStrokeChunks(list, nodeId, parsed.strokesMeta.n)
            strokes = reassembled !== null ? reassembled : (prevLayer?.strokes || [])
        }

        // mask (any layer)
        let mask = null
        if (parsed.maskMeta) {
            const reassembled = reassembleMaskChunks(list, nodeId, parsed.maskMeta)
            mask = reassembled !== null ? reassembled : (prevLayer?.mask ?? null)
        }

        const layer = {
            id: layerId,
            name: parsed.name ?? 'Untitled',
            visible: parsed.visible !== false,
            opacity: typeof parsed.opacity === 'number' ? parsed.opacity : 100,
            blendMode: parsed.blendMode || 'mix',
            locked: !!parsed.locked,
            offsetX: parsed.offsetX || 0,
            offsetY: parsed.offsetY || 0,
            scaleX: parsed.scaleX ?? 1,
            scaleY: parsed.scaleY ?? 1,
            rotation: parsed.rotation ?? 0,
            flipH: !!parsed.flipH,
            flipV: !!parsed.flipV,
            sourceType: parsed.sourceType || 'effect',
            mediaFile: null,
            mediaType: parsed.mediaType ?? null,
            effectId: parsed.effectId ?? null,
            effectParams: parsed.effectParams || {},
            strokes,
            drawingCanvas: null,
            children,
            mask,
            maskEnabled: parsed.maskEnabled !== false,
            maskVisible: !!parsed.maskVisible
        }

        if (layer.sourceType === 'media') {
            layer.remoteMediaPlaceholder = true
            mediaPlaceholderLayerIds.push(layer.id)
        }

        layers.push(layer)
    }

    return {
        layers,
        canvas: { width: metaParsed.canvas.w || 0, height: metaParsed.canvas.h || 0 },
        mediaPlaceholderLayerIds
    }
}
