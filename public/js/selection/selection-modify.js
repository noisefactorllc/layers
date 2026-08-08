/**
 * Selection Mask Modification Operations
 * Pure functions for expanding, contracting, feathering, and other mask operations.
 * All functions take ImageData masks and return new ImageData masks.
 * Alpha channel determines selection (>127 = selected).
 *
 * @module selection/selection-modify
 */

const INF = 1e9

/**
 * Write a uniform value to all 4 RGBA channels for each pixel.
 * @param {Uint8ClampedArray} result - Output RGBA buffer
 * @param {number} pixelIndex - Pixel index (not byte offset)
 * @param {number} val - Value to write to all channels
 * @private
 */
function fillPixel(result, pixelIndex, val) {
    const idx = pixelIndex * 4
    result[idx] = val
    result[idx + 1] = val
    result[idx + 2] = val
    result[idx + 3] = val
}

/**
 * Build a new mask by evaluating a per-pixel function.
 * @param {number} width
 * @param {number} height
 * @param {function(number): number} fn - Maps pixel index to RGBA value (0 or 255, or alpha)
 * @returns {ImageData}
 * @private
 */
function buildMask(width, height, fn) {
    const size = width * height
    const result = new Uint8ClampedArray(size * 4)
    for (let i = 0; i < size; i++) {
        fillPixel(result, i, fn(i))
    }
    return new ImageData(result, width, height)
}

/**
 * Compute distance from each pixel to the nearest selected pixel (alpha > 127).
 * @param {ImageData} mask
 * @returns {Float32Array}
 * @private
 */
function distanceToSelected(mask) {
    const { width, height, data } = mask
    return computeDistanceTransform(data, width, height, (idx) => data[idx + 3] > 127)
}

/**
 * Compute distance from each pixel to the nearest unselected pixel (alpha <= 127).
 * @param {ImageData} mask
 * @returns {Float32Array}
 * @private
 */
function distanceToUnselected(mask) {
    const { width, height, data } = mask
    return computeDistanceTransform(data, width, height, (idx) => data[idx + 3] <= 127)
}

/**
 * Invert a selection mask (flip alpha channel).
 * @param {ImageData} mask - Input mask
 * @returns {ImageData} New mask with inverted selection
 */
function invertMask(mask) {
    const { width, height, data } = mask
    return buildMask(width, height, (i) => data[i * 4 + 3] > 127 ? 0 : 255)
}

/**
 * Compute 1D distance transform using Meijster's parabola envelope method.
 * Given an array f of squared distances from Phase 1, computes the exact
 * Euclidean distance transform along one row.
 *
 * @param {Float32Array} f - Input array of squared distances (one row/col)
 * @param {number} n - Length of the array
 * @param {Float32Array} d - Output array (will be filled with results)
 * @param {Int32Array} v - Scratch array for parabola locations (length n)
 * @param {Float32Array} z - Scratch array for parabola boundaries (length n+1)
 * @private
 */
function edt1d(f, n, d, v, z) {
    let k = 0
    v[0] = 0
    z[0] = -INF
    z[1] = INF

    for (let q = 1; q < n; q++) {
        let s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k])
        while (s <= z[k]) {
            k--
            s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k])
        }
        k++
        v[k] = q
        z[k] = s
        z[k + 1] = INF
    }

    k = 0
    for (let q = 0; q < n; q++) {
        while (z[k + 1] < q) k++
        const dx = q - v[k]
        d[q] = dx * dx + f[v[k]]
    }
}

/**
 * Compute distance transform using Meijster's two-pass algorithm.
 * Returns Float32Array of Euclidean distances from each pixel to the nearest
 * "background" pixel (as defined by the predicate).
 *
 * Phase 1: Column scan - compute distance to nearest background pixel in same column
 * Phase 2: Row scan - use parabola envelope to find true 2D nearest distance
 *
 * @param {Uint8ClampedArray} data - RGBA pixel data
 * @param {number} width - Image width
 * @param {number} height - Image height
 * @param {function(number): boolean} predicate - Returns true if pixel at given
 *   flat index (i*4 offset into data) is "background" (distance = 0)
 * @returns {Float32Array} Euclidean distance for each pixel
 * @private
 */
function computeDistanceTransform(data, width, height, predicate) {
    const size = width * height

    // Phase 1: column scan
    const g = new Float32Array(size)

    for (let x = 0; x < width; x++) {
        g[x] = predicate(x * 4) ? 0 : INF

        for (let y = 1; y < height; y++) {
            const idx = y * width + x
            g[idx] = predicate(idx * 4) ? 0 : g[(y - 1) * width + x] + 1
        }

        for (let y = height - 2; y >= 0; y--) {
            const idx = y * width + x
            const below = g[(y + 1) * width + x] + 1
            if (below < g[idx]) {
                g[idx] = below
            }
        }
    }

    // Square the column distances for Phase 2
    for (let i = 0; i < size; i++) {
        g[i] = g[i] * g[i]
    }

    // Phase 2: row scan with parabola envelope
    const dist = new Float32Array(size)
    const maxDim = Math.max(width, height)
    const f = new Float32Array(maxDim)
    const d = new Float32Array(maxDim)
    const v = new Int32Array(maxDim)
    const z = new Float32Array(maxDim + 1)

    for (let y = 0; y < height; y++) {
        const rowOffset = y * width
        for (let x = 0; x < width; x++) {
            f[x] = g[rowOffset + x]
        }

        edt1d(f, width, d, v, z)

        for (let x = 0; x < width; x++) {
            dist[rowOffset + x] = Math.sqrt(d[x])
        }
    }

    return dist
}

/**
 * Expand (grow) selection by radius r pixels.
 * A pixel is selected if it is within distance r of any currently selected pixel.
 *
 * @param {ImageData} mask - Input selection mask
 * @param {number} r - Expansion radius in pixels
 * @returns {ImageData} New expanded mask
 */
function expandMask(mask, r) {
    const outside = distanceToSelected(mask)
    return buildMask(mask.width, mask.height, (i) => outside[i] <= r ? 255 : 0)
}

/**
 * Contract (shrink) selection by radius r pixels.
 * A pixel is deselected if it is within distance r of the selection boundary (from inside).
 *
 * @param {ImageData} mask - Input selection mask
 * @param {number} r - Contraction radius in pixels
 * @returns {ImageData} New contracted mask
 */
function contractMask(mask, r) {
    const { data } = mask
    const inside = distanceToUnselected(mask)
    return buildMask(mask.width, mask.height, (i) => {
        const wasSelected = data[i * 4 + 3] > 127
        return (wasSelected && inside[i] > r) ? 255 : 0
    })
}

/**
 * Create border selection - select pixels within r of the selection edge (inside the selection).
 *
 * @param {ImageData} mask - Input selection mask
 * @param {number} r - Border width in pixels
 * @returns {ImageData} New mask with only border pixels selected
 */
function borderMask(mask, r) {
    const { data } = mask
    const inside = distanceToUnselected(mask)
    return buildMask(mask.width, mask.height, (i) => {
        const wasSelected = data[i * 4 + 3] > 127
        return (wasSelected && inside[i] <= r) ? 255 : 0
    })
}

/**
 * Feather selection with linear alpha gradient using distance fields.
 * Ramps from 255 at r inside the selection edge, through ~50% at the edge
 * itself, to 0 at r outside — one continuous, monotone falloff centered on
 * the original boundary.
 *
 * (The previous version ramped the inside branch down to ~0 AT the edge and
 * restarted the outside branch at ~255 just past it, producing a sawtooth:
 * a hard edge on the boundary with the effect's strongest band rendered
 * outside the user's selection.)
 *
 * @param {ImageData} mask - Input selection mask
 * @param {number} r - Feather radius in pixels
 * @returns {ImageData} New mask with feathered edges
 */
function featherMask(mask, r) {
    const { data } = mask
    const inside = distanceToUnselected(mask)
    const outside = distanceToSelected(mask)

    return buildMask(mask.width, mask.height, (i) => {
        const wasSelected = data[i * 4 + 3] > 127

        if (wasSelected) {
            if (inside[i] >= r) return 255
            return Math.round(128 + (inside[i] / r) * 127)
        }

        if (outside[i] >= r) return 0
        return Math.round(128 - (outside[i] / r) * 128)
    })
}

/**
 * Smooth selection edges using 3-pass box blur followed by re-threshold.
 *
 * @param {ImageData} mask - Input selection mask
 * @param {number} r - Blur radius in pixels
 * @returns {ImageData} New mask with smoothed edges
 */
function smoothMask(mask, r) {
    const { width, height, data } = mask
    const size = width * height

    let buf = new Float32Array(size)
    for (let i = 0; i < size; i++) {
        buf[i] = data[i * 4 + 3]
    }

    for (let pass = 0; pass < 3; pass++) {
        buf = boxBlur(buf, width, height, r)
    }

    return buildMask(width, height, (i) => buf[i] > 128 ? 255 : 0)
}

/**
 * Single-pass box blur (horizontal then vertical).
 * @param {Float32Array} input - Input buffer
 * @param {number} width
 * @param {number} height
 * @param {number} r - Blur radius
 * @returns {Float32Array} Blurred buffer
 * @private
 */
function boxBlur(input, width, height, r) {
    const temp = new Float32Array(width * height)
    const output = new Float32Array(width * height)
    const kernelSize = 2 * r + 1

    // Horizontal pass
    for (let y = 0; y < height; y++) {
        const rowOffset = y * width
        let sum = 0

        for (let dx = -r; dx <= r; dx++) {
            const x = Math.min(Math.max(dx, 0), width - 1)
            sum += input[rowOffset + x]
        }
        temp[rowOffset] = sum / kernelSize

        for (let x = 1; x < width; x++) {
            const addX = Math.min(x + r, width - 1)
            const removeX = Math.max(x - r - 1, 0)
            sum += input[rowOffset + addX] - input[rowOffset + removeX]
            temp[rowOffset + x] = sum / kernelSize
        }
    }

    // Vertical pass
    for (let x = 0; x < width; x++) {
        let sum = 0

        for (let dy = -r; dy <= r; dy++) {
            const y = Math.min(Math.max(dy, 0), height - 1)
            sum += temp[y * width + x]
        }
        output[x] = sum / kernelSize

        for (let y = 1; y < height; y++) {
            const addY = Math.min(y + r, height - 1)
            const removeY = Math.max(y - r - 1, 0)
            sum += temp[addY * width + x] - temp[removeY * width + x]
            output[y * width + x] = sum / kernelSize
        }
    }

    return output
}

/**
 * Select pixels by color range (non-contiguous).
 * Uses the same SAD (Sum of Absolute Differences) formula as flood-fill.
 *
 * @param {ImageData} imageData - Source image data
 * @param {number} x - Sample X coordinate
 * @param {number} y - Sample Y coordinate
 * @param {number} tolerance - Color tolerance (0-255)
 * @returns {ImageData} Mask where matching pixels are selected
 */
function colorRange(imageData, x, y, tolerance) {
    const { width, height, data } = imageData

    const startIdx = (y * width + x) * 4
    const targetR = data[startIdx]
    const targetG = data[startIdx + 1]
    const targetB = data[startIdx + 2]
    const targetA = data[startIdx + 3]

    const threshold = tolerance * 4

    return buildMask(width, height, (i) => {
        const idx = i * 4
        const diff = Math.abs(data[idx] - targetR) +
                     Math.abs(data[idx + 1] - targetG) +
                     Math.abs(data[idx + 2] - targetB) +
                     Math.abs(data[idx + 3] - targetA)
        return diff <= threshold ? 255 : 0
    })
}

export {
    invertMask,
    expandMask,
    contractMask,
    borderMask,
    featherMask,
    smoothMask,
    colorRange
}
