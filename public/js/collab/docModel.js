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

export const MAX_REMOTE_CANVAS_DIMENSION = 8192
export const MAX_REMOTE_NODES = 4096
export const MAX_REMOTE_LAYERS = 1024
export const MAX_REMOTE_NODE_ID_CHARS = 1024
export const MAX_REMOTE_NODE_TEXT_CHARS = 65536
export const MAX_REMOTE_TOTAL_TEXT_CHARS =
    MAX_REMOTE_LAYERS * MAX_REMOTE_NODE_TEXT_CHARS
export const MAX_REMOTE_MASK_CHUNKS = 1024
export const MAX_REMOTE_MASK_CHARS = MAX_REMOTE_MASK_CHUNKS * CHUNK_BUDGET
export const MAX_REMOTE_RASTER_PIXELS =
    MAX_REMOTE_CANVAS_DIMENSION * MAX_REMOTE_CANVAS_DIMENSION
export const MAX_REMOTE_MASK_PIXELS = MAX_REMOTE_RASTER_PIXELS

const REMOTE_SOURCE_TYPES = new Set(['media', 'effect', 'drawing'])
const REMOTE_MEDIA_TYPES = new Set(['image', 'video'])
const REMOTE_BLEND_MODES = new Set([
    'mix', 'multiply', 'screen', 'overlay', 'softLight', 'hardLight',
    'darken', 'lighten', 'dodge', 'burn', 'add', 'subtract', 'difference',
    'exclusion', 'negation', 'phoenix',
])

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
// Remote resource validation and session recognition
// ---------------------------------------------------------------------

function remoteBoundsError(message) {
    return new Error(`Remote composition rejected: ${message}`)
}

function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function optionalBoolean(value, field) {
    if (value != null && typeof value !== 'boolean') {
        throw remoteBoundsError(`${field} must be boolean`)
    }
}

function optionalFiniteNumber(value, field, { min = -Number.MAX_SAFE_INTEGER,
    max = Number.MAX_SAFE_INTEGER } = {}) {
    if (value == null) return
    if (!Number.isFinite(value) || value < min || value > max) {
        throw remoteBoundsError(`${field} must be a finite number from ${min} to ${max}`)
    }
}

function assertRemoteLayerFields(parsed) {
    if (!isPlainObject(parsed) || parsed.v !== NODE_VERSION) {
        throw remoteBoundsError('layer node text is invalid')
    }
    const sourceType = parsed.sourceType ?? 'effect'
    if (!REMOTE_SOURCE_TYPES.has(sourceType)) {
        throw remoteBoundsError('layer sourceType is invalid')
    }
    if (parsed.name != null && typeof parsed.name !== 'string') {
        throw remoteBoundsError('layer name must be a string')
    }
    optionalBoolean(parsed.visible, 'layer visible')
    optionalBoolean(parsed.locked, 'layer locked')
    optionalBoolean(parsed.flipH, 'layer flipH')
    optionalBoolean(parsed.flipV, 'layer flipV')
    optionalBoolean(parsed.maskEnabled, 'layer maskEnabled')
    optionalBoolean(parsed.maskVisible, 'layer maskVisible')
    optionalFiniteNumber(parsed.opacity, 'layer opacity', { min: 0, max: 100 })
    optionalFiniteNumber(parsed.offsetX, 'layer offsetX')
    optionalFiniteNumber(parsed.offsetY, 'layer offsetY')
    optionalFiniteNumber(parsed.rotation, 'layer rotation')
    if (parsed.blendMode != null && !REMOTE_BLEND_MODES.has(parsed.blendMode)) {
        throw remoteBoundsError('layer blendMode is invalid')
    }
    if (sourceType === 'media') {
        if (parsed.mediaType != null && !REMOTE_MEDIA_TYPES.has(parsed.mediaType)) {
            throw remoteBoundsError('media layer mediaType is invalid')
        }
    } else if (parsed.mediaType != null) {
        throw remoteBoundsError('non-media layer cannot declare mediaType')
    }
    if (parsed.effectParams != null && !isPlainObject(parsed.effectParams)) {
        throw remoteBoundsError('layer effectParams must be an object')
    }
}

function assertRemoteChildFields(parsed) {
    if (!isPlainObject(parsed) || parsed.v !== NODE_VERSION) {
        throw remoteBoundsError('child node text is invalid')
    }
    if (parsed.name != null && typeof parsed.name !== 'string') {
        throw remoteBoundsError('child name must be a string')
    }
    optionalBoolean(parsed.visible, 'child visible')
    if (parsed.effectParams != null && !isPlainObject(parsed.effectParams)) {
        throw remoteBoundsError('child effectParams must be an object')
    }
}

function readPngDimensions(data) {
    const prefix = 'data:image/png;base64,'
    if (typeof data !== 'string' || !data.startsWith(prefix)) {
        throw remoteBoundsError('mask PNG header is invalid')
    }

    const encodedHeader = data.slice(prefix.length, prefix.length + 32)
    if (encodedHeader.length < 32) {
        throw remoteBoundsError('mask PNG header is incomplete')
    }

    let binary
    try {
        binary = atob(encodedHeader)
    } catch {
        throw remoteBoundsError('mask PNG header is invalid')
    }
    if (binary.length < 24) {
        throw remoteBoundsError('mask PNG header is incomplete')
    }

    const expected = [137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]
    for (let i = 0; i < expected.length; i++) {
        if (binary.charCodeAt(i) !== expected[i]) {
            throw remoteBoundsError('mask PNG header is invalid')
        }
    }

    const uint32 = (offset) => (
        binary.charCodeAt(offset) * 0x1000000
        + binary.charCodeAt(offset + 1) * 0x10000
        + binary.charCodeAt(offset + 2) * 0x100
        + binary.charCodeAt(offset + 3)
    )
    return { width: uint32(16), height: uint32(20) }
}

/**
 * Reject a remote node model whose bounded wire representation could cause
 * excessive parsing, concatenation, decode, or image allocation. This runs
 * before applyNodesToComposition() so none of those costs reach live state.
 * @param {Array} nodes
 */
export function assertRemoteNodeModelWithinBounds(nodes, options = {}) {
    const isTextEffect = options.isTextEffect || (effectId => effectId === 'filter/text')
    if (!Array.isArray(nodes) || nodes.length > MAX_REMOTE_NODES) {
        throw remoteBoundsError(`node count exceeds ${MAX_REMOTE_NODES}`)
    }

    let totalTextChars = 0
    let layerCount = 0
    let maskChunkCount = 0
    let totalMaskChars = 0
    const layerNodes = []
    const maskChunksByParent = new Map()
    const strokeParentsWithContent = new Set()
    const nodeIds = new Set()
    const nodesById = new Map()
    const normalizedLocalIds = new Set()
    const nestedSuffix = (node, marker) => {
        if (!/^L[^.]+$/.test(node.parentId || '')) return null
        const prefix = `${node.parentId}.${marker}`
        if (!node.id.startsWith(prefix)) return null
        const suffix = node.id.slice(prefix.length)
        return suffix && !suffix.includes('.') ? suffix : null
    }
    const rememberLocalId = (id) => {
        if (normalizedLocalIds.has(id)) {
            throw remoteBoundsError(`duplicate normalized local id: ${id}`)
        }
        normalizedLocalIds.add(id)
    }

    for (const node of nodes) {
        if (!node || typeof node !== 'object' || typeof node.text !== 'string') {
            throw remoteBoundsError('node text must be a string')
        }
        if (typeof node.id !== 'string' || node.id.length < 1
            || node.id.length > MAX_REMOTE_NODE_ID_CHARS) {
            throw remoteBoundsError(
                `node id must be a non-empty string of at most ${MAX_REMOTE_NODE_ID_CHARS} characters`)
        }
        if (node.parentId !== null
            && (typeof node.parentId !== 'string' || node.parentId.length < 1
                || node.parentId.length > MAX_REMOTE_NODE_ID_CHARS)) {
            throw remoteBoundsError(
                `parent id must be null or a non-empty string of at most ${MAX_REMOTE_NODE_ID_CHARS} characters`)
        }
        if (node.text.length > MAX_REMOTE_NODE_TEXT_CHARS) {
            throw remoteBoundsError(`node text exceeds ${MAX_REMOTE_NODE_TEXT_CHARS} characters`)
        }
        totalTextChars += node.text.length
        if (totalTextChars > MAX_REMOTE_TOTAL_TEXT_CHARS) {
            throw remoteBoundsError(
                `document text exceeds ${MAX_REMOTE_TOTAL_TEXT_CHARS} characters`)
        }
        if (nodeIds.has(node.id)) {
            throw remoteBoundsError(`duplicate node id: ${node.id}`)
        }
        nodeIds.add(node.id)
        nodesById.set(node.id, node)
        if (node.kind === 'layers-meta') {
            if (node.id !== META_NODE_ID || node.parentId !== null) {
                throw remoteBoundsError('layers-meta wire id or parent is invalid')
            }
        } else if (node.kind === 'layers-layer') {
            if (!/^L[^.]+$/.test(node.id) || node.parentId !== null) {
                throw remoteBoundsError('layers-layer wire id or parent is invalid')
            }
            rememberLocalId(node.id.slice(1))
        } else if (node.kind === 'layers-child') {
            const suffix = nestedSuffix(node, 'C')
            if (!suffix) {
                throw remoteBoundsError('layers-child wire id or parent is invalid')
            }
            rememberLocalId(suffix)
            assertRemoteChildFields(safeParse(node.text))
        } else if (node.kind === 'layers-strokes' || node.kind === 'layers-mask') {
            const marker = node.kind === 'layers-strokes' ? 'S' : 'M'
            const suffix = nestedSuffix(node, marker)
            if (!suffix || !/^(0|[1-9]\d*)$/.test(suffix)) {
                throw remoteBoundsError(`${node.kind} wire id or parent is invalid`)
            }
        }
        if (node.kind === 'layers-layer') {
            layerCount++
            layerNodes.push(node)
        } else if (node.kind === 'layers-mask') {
            maskChunkCount++
            const parsed = safeParse(node.text)
            if (!parsed || parsed.v !== NODE_VERSION || typeof parsed.data !== 'string') continue
            totalMaskChars += parsed.data.length
            if (totalMaskChars > MAX_REMOTE_MASK_CHARS) {
                throw remoteBoundsError(
                    `mask data exceeds ${MAX_REMOTE_MASK_CHARS} characters`)
            }
            if (!Number.isSafeInteger(parsed.i) || parsed.i < 0) continue
            let chunks = maskChunksByParent.get(node.parentId)
            if (!chunks) {
                chunks = new Map()
                maskChunksByParent.set(node.parentId, chunks)
            }
            chunks.set(parsed.i, parsed.data)
        } else if (node.kind === 'layers-strokes') {
            const parsed = safeParse(node.text)
            if (parsed?.v === NODE_VERSION && Array.isArray(parsed.strokes)
                && parsed.strokes.length > 0) {
                strokeParentsWithContent.add(node.parentId)
            }
        }
    }

    if (layerCount > MAX_REMOTE_LAYERS) {
        throw remoteBoundsError(`layer count exceeds ${MAX_REMOTE_LAYERS}`)
    }
    if (maskChunkCount > MAX_REMOTE_MASK_CHUNKS) {
        throw remoteBoundsError(`mask chunk count exceeds ${MAX_REMOTE_MASK_CHUNKS}`)
    }
    for (const node of nodes) {
        if (node.kind !== 'layers-child' && node.kind !== 'layers-strokes'
            && node.kind !== 'layers-mask') continue
        if (nodesById.get(node.parentId)?.kind !== 'layers-layer') {
            throw remoteBoundsError(`${node.kind} parent layer is missing`)
        }
    }

    const meta = nodes.find(node =>
        node.id === META_NODE_ID && node.kind === 'layers-meta')
    const metaParsed = meta ? safeParse(meta.text) : null
    if (!metaParsed || metaParsed.v !== NODE_VERSION
        || !metaParsed.canvas || !Array.isArray(metaParsed.order)) return

    const { w: canvasWidth, h: canvasHeight } = metaParsed.canvas
    if (!Number.isSafeInteger(canvasWidth) || !Number.isSafeInteger(canvasHeight)
        || canvasWidth < 1 || canvasHeight < 1
        || canvasWidth > MAX_REMOTE_CANVAS_DIMENSION
        || canvasHeight > MAX_REMOTE_CANVAS_DIMENSION) {
        throw remoteBoundsError(
            `canvas dimensions must be safe integers from 1 to ${MAX_REMOTE_CANVAS_DIMENSION}`)
    }

    let totalRasterPixels = 0
    let totalMaskPixels = 0
    const canvasPixels = canvasWidth * canvasHeight
    const addRasterPixels = (pixels) => {
        if (pixels > MAX_REMOTE_RASTER_PIXELS - totalRasterPixels) {
            throw remoteBoundsError(
                `document raster pixels exceed ${MAX_REMOTE_RASTER_PIXELS}`)
        }
        totalRasterPixels += pixels
    }
    for (const node of layerNodes) {
        const parsed = safeParse(node.text)
        assertRemoteLayerFields(parsed)

        const sourceType = parsed.sourceType ?? 'effect'
        const scaleX = parsed.scaleX ?? 1
        const scaleY = parsed.scaleY ?? 1
        if (!Number.isFinite(scaleX) || scaleX === 0
            || Math.abs(scaleX) > Number.MAX_SAFE_INTEGER
            || !Number.isFinite(scaleY) || scaleY === 0
            || Math.abs(scaleY) > Number.MAX_SAFE_INTEGER) {
            throw remoteBoundsError(
                'layer scale must contain finite nonzero safe-range numbers')
        }
        const flipH = parsed.flipH ?? false
        const flipV = parsed.flipV ?? false

        if (parsed.strokesMeta) {
            const count = parsed.strokesMeta.n
            if (!Number.isSafeInteger(count) || count < 1 || count > MAX_REMOTE_NODES) {
                throw remoteBoundsError('stroke metadata chunk count is invalid')
            }
        }
        const hasDrawingRaster = sourceType === 'drawing'
            && (parsed.strokesMeta || strokeParentsWithContent.has(node.id))
        if (sourceType === 'media') {
            addRasterPixels(1)
        }
        if (hasDrawingRaster) {
            addRasterPixels(canvasPixels)
        }
        const hasRasterSource = sourceType === 'media' || hasDrawingRaster
        const needsCpuTransform = scaleX !== 1 || scaleY !== 1 || flipH || flipV
        if (parsed.visible !== false && hasRasterSource && needsCpuTransform) {
            const sourceWidth = sourceType === 'media' ? 1 : canvasWidth
            const sourceHeight = sourceType === 'media' ? 1 : canvasHeight
            const width = Math.ceil(sourceWidth * Math.abs(scaleX))
            const height = Math.ceil(sourceHeight * Math.abs(scaleY))
            if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height)
                || width < 1 || height < 1
                || width > MAX_REMOTE_CANVAS_DIMENSION
                || height > MAX_REMOTE_CANVAS_DIMENSION) {
                throw remoteBoundsError(
                    `transformed raster dimensions must be from 1 to ${MAX_REMOTE_CANVAS_DIMENSION}`)
            }
            addRasterPixels(width * height)
        }
        if (parsed.visible !== false && sourceType === 'effect'
            && isTextEffect(parsed.effectId)) {
            addRasterPixels(canvasPixels)
        }
        if (!parsed.maskMeta) continue

        const count = parsed.maskMeta.n
        if (!Number.isSafeInteger(count) || count < 1
            || count > MAX_REMOTE_MASK_CHUNKS) {
            throw remoteBoundsError('mask metadata chunk count is invalid')
        }

        const firstChunk = maskChunksByParent.get(node.id)?.get(0)
        if (firstChunk === undefined) continue
        const { width, height } = readPngDimensions(firstChunk)
        if (width < 1 || height < 1
            || width > MAX_REMOTE_CANVAS_DIMENSION
            || height > MAX_REMOTE_CANVAS_DIMENSION) {
            throw remoteBoundsError(
                `mask dimensions must be from 1 to ${MAX_REMOTE_CANVAS_DIMENSION}`)
        }
        if (width > canvasWidth || height > canvasHeight) {
            throw remoteBoundsError('mask dimensions exceed the canvas dimensions')
        }
        const pixels = width * height
        if (pixels > MAX_REMOTE_MASK_PIXELS - totalMaskPixels) {
            throw remoteBoundsError(
                `document mask pixels exceed ${MAX_REMOTE_MASK_PIXELS}`)
        }
        totalMaskPixels += pixels
        addRasterPixels(pixels)
    }
}

function assertRemoteParamRange(value, spec, field) {
    if (typeof value !== 'number') return
    if (spec.min !== undefined && value < spec.min) {
        throw remoteBoundsError(`${field} is below its declared minimum`)
    }
    if (spec.max !== undefined && value > spec.max) {
        throw remoteBoundsError(`${field} exceeds its declared maximum`)
    }
}

function assertRemoteParamChoice(value, spec, field, effectId, canonicalName) {
    if (!isPlainObject(spec.choices)) return
    if (effectId === 'filter/text' && canonicalName === 'font') return
    if (!Object.values(spec.choices).some(choice => Object.is(choice, value))) {
        throw remoteBoundsError(`${field} is not a declared choice`)
    }
}

function assertRemoteEffectParamValue(value, spec, field, effectId,
    getDeclaredDslIdentifierValues) {
    const fail = (expected) => {
        throw remoteBoundsError(`${field} for ${effectId} must be ${expected}`)
    }
    switch (spec.type) {
        case 'float':
            if (!Number.isFinite(value)) fail('a finite number')
            assertRemoteParamRange(value, spec, field)
            return
        case 'int':
            if (!Number.isSafeInteger(value)) fail('a safe integer')
            assertRemoteParamRange(value, spec, field)
            return
        case 'boolean':
            if (typeof value !== 'boolean') fail('boolean')
            return
        case 'string':
            if (typeof value !== 'string') fail('a string')
            if (value.includes('"""')) fail('a string without triple quotes')
            return
        case 'member':
            if (typeof value !== 'string'
                || !/^[_A-Za-z][_A-Za-z0-9]*\.[_A-Za-z][_A-Za-z0-9]*$/.test(value)
                || !getDeclaredDslIdentifierValues(spec).includes(value)) {
                fail('a declared enum member')
            }
            return
        case 'volume':
            if (typeof value !== 'string'
                || !getDeclaredDslIdentifierValues(spec).includes(value)) {
                fail('a declared volume identifier')
            }
            return
        case 'geometry':
            if (typeof value !== 'string'
                || !getDeclaredDslIdentifierValues(spec).includes(value)) {
                fail('a declared geometry identifier')
            }
            return
        case 'surface':
            fail('omitted because surface inputs are not remotely configurable')
            return
        case 'color':
            if (typeof value === 'string') {
                if (!/^#[\da-f]{6}$/i.test(value)) {
                    fail('a 6-digit hexadecimal color')
                }
                if (effectId === 'synth/solid') {
                    fail('an RGB numeric array')
                }
                return
            }
            if (!Array.isArray(value) || value.length !== 3
                || value.some(component => !Number.isFinite(component)
                    || component < 0 || component > 1)) {
                fail('an RGB array with finite components from 0 to 1')
            }
            return
        case 'vec2':
        case 'vec3':
        case 'vec4': { // eslint-disable-line no-case-declarations
            const length = Number(spec.type.slice(3))
            if (!Array.isArray(value) || value.length !== length
                || value.some(component => !Number.isFinite(component))) {
                fail(`a ${spec.type} finite numeric array`)
            }
            for (const component of value) assertRemoteParamRange(component, spec, field)
            return
        }
        default:
            if (typeof value === 'number') {
                if (!Number.isFinite(value)) fail('a finite scalar')
                assertRemoteParamRange(value, spec, field)
                return
            }
            if (typeof value === 'boolean') return
            if (typeof value === 'string') {
                if (value.includes('"""')) fail('a string without triple quotes')
                return
            }
            if (Array.isArray(value) && value.length >= 2 && value.length <= 4
                && value.every(component => Number.isFinite(component))) return
            fail('a DSL-safe scalar or finite vector')
    }
}

/**
 * Validate remote fields that are interpolated into renderer DSL or applied
 * as uniforms. Effect definitions are resolved before candidate preparation,
 * so undeclared identifiers and malformed values never reach compilation.
 * @param {Array} nodes
 * @param {{manifest:object,getEffectDefinition:Function,layerEffectIds?:Set<string>,
 *   childEffectIds?:Set<string>,getDeclaredDslIdentifierValues?:Function}} options
 */
export async function assertRemoteNodeSemantics(nodes, options = {}) {
    const manifest = options.manifest || {}
    const getEffectDefinition = options.getEffectDefinition
    const layerEffectIds = options.layerEffectIds || null
    const childEffectIds = options.childEffectIds || null
    const getDeclaredDslIdentifierValues =
        options.getDeclaredDslIdentifierValues || (() => [])
    const definitions = new Map()
    const effectIdPattern = /^[_A-Za-z][_A-Za-z0-9-]*\/[_A-Za-z][_A-Za-z0-9-]*$/
    const paramNamePattern = /^[_A-Za-z][_A-Za-z0-9]*$/

    const definitionFor = async (effectId) => {
        if (definitions.has(effectId)) return definitions.get(effectId)
        const definition = typeof getEffectDefinition === 'function'
            ? await getEffectDefinition(effectId)
            : null
        definitions.set(effectId, definition)
        return definition
    }
    const validateEffect = async (parsed, field, { child = false } = {}) => {
        const effectId = parsed.effectId
        if (typeof effectId !== 'string' || !effectIdPattern.test(effectId)
            || !Object.hasOwn(manifest, effectId)) {
            throw remoteBoundsError(`${field} effectId is not declared`)
        }
        if (child && childEffectIds && !childEffectIds.has(effectId)) {
            throw remoteBoundsError(`${field} effectId is not allowed as a child effect`)
        }
        if (!child && layerEffectIds && !layerEffectIds.has(effectId)) {
            throw remoteBoundsError(`${field} effectId is not allowed as a layer effect`)
        }
        const definition = await definitionFor(effectId)
        if (!definition || !isPlainObject(definition.globals)) {
            throw remoteBoundsError(`${field} effect definition is unavailable`)
        }
        const globals = definition.globals
        const aliases = isPlainObject(definition.paramAliases)
            ? definition.paramAliases
            : {}
        const params = parsed.effectParams ?? {}
        if (!isPlainObject(params)) {
            throw remoteBoundsError(`${field} effectParams must be an object`)
        }
        for (const [key, value] of Object.entries(params)) {
            if (!paramNamePattern.test(key)) {
                throw remoteBoundsError(`${field} parameter key is not a safe identifier`)
            }
            const canonicalKey = Object.hasOwn(aliases, key) ? aliases[key] : key
            const spec = Object.hasOwn(globals, canonicalKey)
                ? globals[canonicalKey]
                : null
            if (!paramNamePattern.test(canonicalKey) || !isPlainObject(spec)
                || spec.internal || spec.ui?.hidden) {
                throw remoteBoundsError(`${field} parameter ${key} is not declared`)
            }
            assertRemoteEffectParamValue(value, spec, `${field} parameter ${key}`, effectId,
                getDeclaredDslIdentifierValues)
            assertRemoteParamChoice(
                value, spec, `${field} parameter ${key}`, effectId, canonicalKey)
        }
    }

    for (const node of nodes || []) {
        if (node?.kind === 'layers-layer') {
            const parsed = safeParse(node.text)
            assertRemoteLayerFields(parsed)
            const sourceType = parsed.sourceType ?? 'effect'
            if (sourceType === 'effect') {
                await validateEffect(parsed, `layer ${node.id}`)
            } else {
                if (parsed.effectId != null) {
                    throw remoteBoundsError(`layer ${node.id} cannot declare effectId`)
                }
                if (parsed.effectParams != null
                    && Object.keys(parsed.effectParams).length > 0) {
                    throw remoteBoundsError(`layer ${node.id} cannot declare effect parameters`)
                }
            }
        } else if (node?.kind === 'layers-child') {
            const parsed = safeParse(node.text)
            assertRemoteChildFields(parsed)
            await validateEffect(parsed, `child ${node.id}`, { child: true })
        }
    }
}

// isLayersSession — reader validation per §5: interpretable iff a `meta`
// node exists with v===1 and a well-formed shape.

export function isLayersSession(nodes) {
    const meta = (nodes || []).find(n =>
        n?.id === META_NODE_ID && n.kind === 'layers-meta')
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
