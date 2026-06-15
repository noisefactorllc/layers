/**
 * Flood Fill Algorithm
 * Stack-based (DFS) flood fill for magic wand selection
 *
 * @module selection/flood-fill
 */

/**
 * Perform flood fill from a starting point
 * @param {ImageData} imageData - Source image data
 * @param {number} startX - Starting X coordinate
 * @param {number} startY - Starting Y coordinate
 * @param {number} tolerance - Color tolerance (0-255)
 * @returns {ImageData} - Mask where 255 = selected, 0 = not selected
 */
function floodFill(imageData, startX, startY, tolerance) {
    const { width, height, data } = imageData
    const mask = new Uint8ClampedArray(width * height)

    const startIdx = (startY * width + startX) * 4
    const targetR = data[startIdx]
    const targetG = data[startIdx + 1]
    const targetB = data[startIdx + 2]
    const targetA = data[startIdx + 3]

    const threshold = tolerance * 4

    /**
     * Check if pixel matches target color within tolerance
     * @param {number} idx - Pixel index in data array
     * @returns {boolean}
     */
    function matches(idx) {
        const diff = Math.abs(data[idx] - targetR) +
                     Math.abs(data[idx + 1] - targetG) +
                     Math.abs(data[idx + 2] - targetB) +
                     Math.abs(data[idx + 3] - targetA)
        return diff <= threshold
    }

    // Stack of pixel indices (y * width + x). A flat numeric stack with O(1)
    // push/pop replaces the previous array-of-[x, y] queue drained via
    // Array.shift(): shift() is O(n), which made a large fill O(n^2) and could
    // freeze the main thread on a big uniform region. Flood fill visits the
    // same connected component regardless of traversal order, so the resulting
    // mask is identical (only BFS -> DFS order changes). A Uint8Array visited
    // map replaces the boxed-number Set for lower memory and faster membership.
    const visited = new Uint8Array(width * height)
    const start = startY * width + startX
    const stack = [start]
    visited[start] = 1

    while (stack.length > 0) {
        const pixelIdx = stack.pop()

        if (!matches(pixelIdx * 4)) continue

        mask[pixelIdx] = 255

        const x = pixelIdx % width
        const y = (pixelIdx - x) / width

        if (x > 0) {
            const n = pixelIdx - 1
            if (!visited[n]) { visited[n] = 1; stack.push(n) }
        }
        if (x < width - 1) {
            const n = pixelIdx + 1
            if (!visited[n]) { visited[n] = 1; stack.push(n) }
        }
        if (y > 0) {
            const n = pixelIdx - width
            if (!visited[n]) { visited[n] = 1; stack.push(n) }
        }
        if (y < height - 1) {
            const n = pixelIdx + width
            if (!visited[n]) { visited[n] = 1; stack.push(n) }
        }
    }

    const maskData = new Uint8ClampedArray(width * height * 4)
    for (let i = 0; i < mask.length; i++) {
        const idx = i * 4
        const val = mask[i]
        maskData[idx] = val
        maskData[idx + 1] = val
        maskData[idx + 2] = val
        maskData[idx + 3] = val
    }

    return new ImageData(maskData, width, height)
}

export { floodFill }
