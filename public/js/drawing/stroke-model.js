/**
 * Stroke data model — factory functions for creating drawing strokes.
 *
 * @module drawing/stroke-model
 */

let strokeCounter = 0

export function createPathStroke({ color, size, opacity = 1, points = [], mode = 'brush' }) {
    return {
        id: `stroke-${strokeCounter++}`,
        type: 'path',
        color,
        size,
        opacity,
        mode,
        points: points.map(p => ({ x: p.x, y: p.y }))
    }
}

export function createShapeStroke({ type, color, size, opacity = 1, x, y, width, height, filled = false }) {
    return {
        id: `stroke-${strokeCounter++}`,
        type,
        color,
        size,
        opacity,
        x, y, width, height,
        filled,
        points: []
    }
}

export function createLineStroke({ type = 'line', color, size, opacity = 1, points = [] }) {
    return {
        id: `stroke-${strokeCounter++}`,
        type,
        color,
        size,
        opacity,
        points: points.map(p => ({ x: p.x, y: p.y })),
        x: 0, y: 0, width: 0, height: 0,
        filled: false
    }
}

export function cloneStrokes(strokes) {
    return JSON.parse(JSON.stringify(strokes))
}
