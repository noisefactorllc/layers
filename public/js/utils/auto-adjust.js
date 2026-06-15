/**
 * Auto-adjustment utilities
 * Analyzes canvas pixels to compute correction parameters
 */

import { readRenderPixels } from './canvas-readback.js'

/**
 * Read current canvas pixels for analysis. Uses WebGL readback when available
 * and a 2D-snapshot fallback otherwise, so analysis works under both the WebGL2
 * and WebGPU backends.
 * @param {HTMLCanvasElement} canvas
 * @returns {Uint8Array|null} RGBA pixel data (unordered — callers use aggregate stats only)
 */
function readCanvasPixels(canvas) {
    try {
        return readRenderPixels(canvas, 0, 0, canvas.width, canvas.height)
    } catch {
        return null
    }
}

/**
 * Compute histogram from pixel data
 * @param {Uint8Array} pixels - RGBA pixel data
 * @returns {{ r, g, b, lum, percentile, mean, totalPixels }}
 */
function computeHistogram(pixels) {
    const r = new Uint32Array(256)
    const g = new Uint32Array(256)
    const b = new Uint32Array(256)
    const lum = new Uint32Array(256)
    let totalPixels = 0

    for (let i = 0; i < pixels.length; i += 4) {
        const ri = pixels[i], gi = pixels[i + 1], bi = pixels[i + 2]
        r[ri]++
        g[gi]++
        b[bi]++
        // Luminance: 0.299R + 0.587G + 0.114B
        lum[Math.round(0.299 * ri + 0.587 * gi + 0.114 * bi)]++
        totalPixels++
    }

    function percentile(channel, pct) {
        const target = Math.floor(totalPixels * pct)
        let count = 0
        for (let i = 0; i < 256; i++) {
            count += channel[i]
            if (count >= target) return i
        }
        return 255
    }

    function mean(channel) {
        let sum = 0
        for (let i = 0; i < 256; i++) sum += i * channel[i]
        return sum / totalPixels
    }

    return { r, g, b, lum, percentile, mean, totalPixels }
}

/**
 * Auto Levels - stretch the overall tonal range to fill 0-1.
 * Per-channel 1st/99th percentiles are reduced to a single low/high and
 * expressed as global brightness/contrast (filter/adjust has no per-channel
 * levels).
 *
 * filter/adjust shader model (brightness/contrast subset):
 *   brightness: default 1, range 0-10, multiplicative (color *= brightness)
 *   contrast: default 0.5, range 0-1, formula: (color - 0.5) * contrast * 2 + 0.5
 *   Identity = brightness 1, contrast 0.5
 *
 * @returns {{ effectId: string, effectParams: object, name: string } | null}
 */
export function autoLevels(canvas) {
    const pixels = readCanvasPixels(canvas)
    if (!pixels) return null

    const hist = computeHistogram(pixels)

    // Find 1st and 99th percentile across all channels
    const rLow = hist.percentile(hist.r, 0.01), rHigh = hist.percentile(hist.r, 0.99)
    const gLow = hist.percentile(hist.g, 0.01), gHigh = hist.percentile(hist.g, 0.99)
    const bLow = hist.percentile(hist.b, 0.01), bHigh = hist.percentile(hist.b, 0.99)

    const low = Math.min(rLow, gLow, bLow) / 255
    const high = Math.max(rHigh, gHigh, bHigh) / 255
    const mid = (low + high) / 2

    const range = high - low
    if (range > 0.9) return null // already nearly full range

    // Brightness: multiply to shift midpoint toward 0.5
    // If image is dark (mid < 0.5), brighten. If light (mid > 0.5), darken.
    const brightness = mid > 0.01 ? 0.5 / mid : 2

    // Contrast: expand range to fill 0-1
    // contrast=0.5 is identity, higher expands, lower compresses
    const contrast = Math.min(0.5 / range, 1)

    return {
        effectId: 'filter/adjust',
        effectParams: {
            brightness: Math.max(0.1, Math.min(10, brightness)),
            contrast: Math.max(0, Math.min(1, contrast))
        },
        name: 'Auto Levels'
    }
}

/**
 * Auto Contrast - stretch luminance histogram
 * @returns {{ effectId: string, effectParams: object, name: string } | null}
 */
export function autoContrast(canvas) {
    const pixels = readCanvasPixels(canvas)
    if (!pixels) return null

    const hist = computeHistogram(pixels)

    const low = hist.percentile(hist.lum, 0.01) / 255
    const high = hist.percentile(hist.lum, 0.99) / 255
    const mid = (low + high) / 2

    const range = high - low
    if (range > 0.9) return null // already nearly full range

    const brightness = mid > 0.01 ? 0.5 / mid : 2
    const contrast = Math.min(0.5 / range, 1)

    return {
        effectId: 'filter/adjust',
        effectParams: {
            brightness: Math.max(0.1, Math.min(10, brightness)),
            contrast: Math.max(0, Math.min(1, contrast))
        },
        name: 'Auto Contrast'
    }
}

/**
 * Auto White Balance - neutralize color cast via hue rotation
 *
 * filter/adjust shader model (hue/saturation subset):
 *   rotation: default 120, range -180 to 180 (degrees)
 *   hueRange: default 40, range 0-200
 *   saturation: default 1, range 0-4 (multiplicative)
 *   Identity = rotation 0, hueRange 200, saturation 1
 *
 * @returns {{ effectId: string, effectParams: object, name: string } | null}
 */
export function autoWhiteBalance(canvas) {
    const pixels = readCanvasPixels(canvas)
    if (!pixels) return null

    const hist = computeHistogram(pixels)

    const rMean = hist.mean(hist.r)
    const gMean = hist.mean(hist.g)
    const bMean = hist.mean(hist.b)

    // Gray world assumption: ideal is equal R, G, B means
    const overall = (rMean + gMean + bMean) / 3

    const rDev = rMean - overall
    const gDev = gMean - overall
    const bDev = bMean - overall
    const maxDev = Math.max(Math.abs(rDev), Math.abs(gDev), Math.abs(bDev))

    if (maxDev < 5) return null // negligible cast

    // Map dominant color cast to hue rotation (degrees)
    // and slight desaturation to reduce the cast
    let rotation = 0
    let saturation = 1

    if (Math.abs(rDev) >= Math.abs(gDev) && Math.abs(rDev) >= Math.abs(bDev)) {
        // Red cast → rotate toward cyan, desaturate slightly
        rotation = rDev > 0 ? -maxDev / 255 * 60 : maxDev / 255 * 60
        saturation = 1 - maxDev / 255 * 0.3
    } else if (Math.abs(bDev) >= Math.abs(rDev) && Math.abs(bDev) >= Math.abs(gDev)) {
        // Blue cast → rotate toward yellow
        rotation = bDev > 0 ? maxDev / 255 * 60 : -maxDev / 255 * 60
        saturation = 1 - maxDev / 255 * 0.3
    } else {
        // Green cast → rotate away, desaturate more
        rotation = gDev > 0 ? maxDev / 255 * 40 : -maxDev / 255 * 40
        saturation = 1 - maxDev / 255 * 0.4
    }

    return {
        effectId: 'filter/adjust',
        effectParams: {
            rotation: Math.max(-180, Math.min(180, rotation)),
            hueRange: 100,
            saturation: Math.max(0.1, Math.min(4, saturation))
        },
        name: 'Auto White Balance'
    }
}
