import { test, expect } from 'playwright/test'

// Imported-media size clamp (noisedeck free-tier style): square sources cap
// at 2048², rectangular sources at 1080p bounds (1920 long / 1080 short),
// aspect preserved via a single scale factor. Oversized imports otherwise
// become both a GPU texture and — for new projects — the canvas size, which
// multiplies every shader pass's cost ("large images bog the app down").

async function loadApp(page) {
    await page.goto('/', { waitUntil: 'networkidle' })
    await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })
    await page.waitForSelector('.open-dialog-backdrop.visible')
}

async function createSolidProject(page) {
    await page.click('.media-option[data-type="solid"]')
    await page.waitForSelector('.canvas-size-dialog', { timeout: 5000 })
    await page.click('.canvas-size-dialog .action-btn.primary')
    await page.waitForSelector('.open-dialog-backdrop.visible', { state: 'hidden', timeout: 5000 })
    await page.waitForTimeout(1000)
}

// Build a PNG File of the given dimensions inside the page.
function makeImageFile(page, width, height) {
    return page.evaluateHandle(async ({ width, height }) => {
        const canvas = document.createElement('canvas')
        canvas.width = width
        canvas.height = height
        const ctx = canvas.getContext('2d')
        ctx.fillStyle = '#3a7'
        ctx.fillRect(0, 0, width, height)
        ctx.fillStyle = '#f60'
        ctx.fillRect(0, 0, Math.ceil(width / 2), Math.ceil(height / 2))
        const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'))
        return new File([blob], `test-${width}x${height}.png`, { type: 'image/png' })
    }, { width, height })
}

test('clampMediaDimensions applies square/rect caps and preserves aspect', async ({ page }) => {
    await loadApp(page)
    const results = await page.evaluate(async () => {
        const { clampMediaDimensions } = await import('./js/noisemaker/renderer.js')
        return {
            squareSmall: clampMediaDimensions(1024, 1024),
            squareAtCap: clampMediaDimensions(2048, 2048),
            squareLarge: clampMediaDimensions(4096, 4096),
            landscapeSmall: clampMediaDimensions(1280, 720),
            landscapeLarge: clampMediaDimensions(4000, 3000),
            portraitLarge: clampMediaDimensions(3000, 4000),
            panorama: clampMediaDimensions(5000, 800),
            tallBanner: clampMediaDimensions(800, 5000),
        }
    })

    // Square: only the 2048 cap applies
    expect(results.squareSmall).toEqual({ width: 1024, height: 1024 })
    expect(results.squareAtCap).toEqual({ width: 2048, height: 2048 })
    expect(results.squareLarge).toEqual({ width: 2048, height: 2048 })

    // Rect within bounds: untouched
    expect(results.landscapeSmall).toEqual({ width: 1280, height: 720 })

    // Rect over bounds: single scale factor honors both caps, aspect kept
    // 4000×3000 → scale min(1920/4000, 1080/3000) = 0.36 → 1440×1080
    expect(results.landscapeLarge).toEqual({ width: 1440, height: 1080 })
    expect(results.portraitLarge).toEqual({ width: 1080, height: 1440 })

    // Extreme aspect: long-side cap dominates, aspect kept
    // 5000×800 → scale min(1920/5000, 1080/800) = 0.384 → 1920×307
    expect(results.panorama).toEqual({ width: 1920, height: 307 })
    expect(results.tallBanner).toEqual({ width: 307, height: 1920 })
})

test('opening a large square image clamps media and canvas to 2048', async ({ page }) => {
    await loadApp(page)
    await createSolidProject(page)

    const fileHandle = await makeImageFile(page, 3000, 3000)
    const result = await page.evaluate(async (file) => {
        const app = window.layersApp
        const status = await app._handleOpenMedia(file, 'image')
        const media = app._layers
            .filter(l => l.sourceType === 'media')
            .map(l => app._renderer.getMediaInfo(l.id))
            .find(Boolean)
        const canvas = document.getElementById('canvas')
        return {
            status,
            mediaW: media?.width, mediaH: media?.height,
            canvasW: canvas.width, canvasH: canvas.height,
        }
    }, fileHandle)

    expect(result.status).toBe('opened')
    expect(result.mediaW).toBe(2048)
    expect(result.mediaH).toBe(2048)
    expect(result.canvasW).toBe(2048)
    expect(result.canvasH).toBe(2048)
})

test('opening a large landscape image clamps to 1080p bounds with aspect kept', async ({ page }) => {
    await loadApp(page)
    await createSolidProject(page)

    const fileHandle = await makeImageFile(page, 4000, 2000)
    const result = await page.evaluate(async (file) => {
        const app = window.layersApp
        const status = await app._handleOpenMedia(file, 'image')
        const canvas = document.getElementById('canvas')
        return { status, canvasW: canvas.width, canvasH: canvas.height }
    }, fileHandle)

    // 4000×2000 → scale min(1920/4000, 1080/2000) = 0.48 → 1920×960
    expect(result.status).toBe('opened')
    expect(result.canvasW).toBe(1920)
    expect(result.canvasH).toBe(960)
})

test('small images import at native size', async ({ page }) => {
    await loadApp(page)
    await createSolidProject(page)

    const fileHandle = await makeImageFile(page, 800, 600)
    const result = await page.evaluate(async (file) => {
        const app = window.layersApp
        const status = await app._handleOpenMedia(file, 'image')
        const canvas = document.getElementById('canvas')
        return { status, canvasW: canvas.width, canvasH: canvas.height }
    }, fileHandle)

    expect(result.status).toBe('opened')
    expect(result.canvasW).toBe(800)
    expect(result.canvasH).toBe(600)
})

test('adding an oversized media layer clamps its texture without resizing the canvas', async ({ page }) => {
    await loadApp(page)
    await createSolidProject(page)

    const fileHandle = await makeImageFile(page, 4096, 4096)
    const result = await page.evaluate(async (file) => {
        const app = window.layersApp
        const before = {
            canvasW: document.getElementById('canvas').width,
            canvasH: document.getElementById('canvas').height,
        }
        const added = await app._handleAddMediaLayer(file, 'image')
        const layerId = added.layerId
            ?? app._layers.filter(l => l.sourceType === 'media').at(-1)?.id
        const media = app._renderer.getMediaInfo(layerId)
        return {
            status: added.status,
            mediaW: media?.width, mediaH: media?.height,
            before,
            after: {
                canvasW: document.getElementById('canvas').width,
                canvasH: document.getElementById('canvas').height,
            },
        }
    }, fileHandle)

    expect(result.status).toBe('added')
    expect(result.mediaW).toBe(2048)
    expect(result.mediaH).toBe(2048)
    // Adding a layer never resizes the project canvas
    expect(result.after).toEqual(result.before)
})
