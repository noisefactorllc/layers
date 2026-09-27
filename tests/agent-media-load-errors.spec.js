import { test, expect } from './fixtures.js'
import { appReady } from './waits.js'
import { reopenNewProjectDialog } from './helpers/new-project.js'

// Domain 4 fault recovery: undecodable media files get a friendly, actionable
// toast instead of a raw decoder error or a silent no-op.

test.setTimeout(60000)

async function loadApp(page) {
    await page.goto('/', { waitUntil: 'networkidle' })
    await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })
    await reopenNewProjectDialog(page)
}

async function createSolidProject(page) {
    await page.click('.media-option[data-type="solid"]')
    await page.waitForSelector('.canvas-size-dialog', { timeout: 5000 })
    await page.click('.canvas-size-dialog .action-btn.primary')
    await page.waitForSelector('.open-dialog-backdrop.visible', { state: 'hidden', timeout: 5000 })
    await appReady(page)
}

async function makeCorruptFile(page, name, type) {
    const handle = await page.evaluateHandle(([name, type]) => {
        // Realistic JPEG SOI header followed by garbage: the browser accepts
        // the File but cannot decode it.
        const bytes = new Uint8Array([0xFF, 0xD8, 0xFF, 0xE0, ...new Uint8Array(256).fill(0x41)])
        return new File([bytes], name, { type })
    }, [name, type])
    return handle
}

function lastErrorToast(page) {
    return page.locator('#toast-container .toast').last()
}

test('an undecodable image shows an actionable toast and no project opens', async ({ page }) => {
    await loadApp(page)
    await createSolidProject(page)
    const file = await makeCorruptFile(page, 'corrupt.jpg', 'image/jpeg')

    const result = await page.evaluate(async (file) => {
        const app = window.layersApp
        const status = await app._handleOpenMedia(file, 'image')
        return { status, layerCount: app._layers.length }
    }, file)

    expect(result.status).toBe('failed')
    // The original project stays untouched.
    expect(result.layerCount).toBe(1)

    const toast = lastErrorToast(page)
    await expect(toast).toContainText('corrupt.jpg')
    await expect(toast).toContainText("doesn’t support")
    await expect(toast).toContainText('PNG, JPEG, GIF, or WebP')
})

test('an undecodable video names the codec problem', async ({ page }) => {
    await loadApp(page)
    await createSolidProject(page)
    const file = await makeCorruptFile(page, 'clip.mp4', 'video/mp4')

    const result = await page.evaluate(async (file) => {
        const app = window.layersApp
        const status = await app._handleOpenMedia(file, 'video')
        return { status, layerCount: app._layers.length }
    }, file)

    expect(result.status).toBe('failed')
    expect(result.layerCount).toBe(1)

    const toast = lastErrorToast(page)
    await expect(toast).toContainText('clip.mp4')
    // Firefox classifies garbage MP4 data as MEDIA_ERR_ABORTED (Code 1), so
    // the actionable message may name the codec or the corrupt file; both are
    // friendly decodings of the failure, never a raw decoder string.
    await expect(toast).toContainText(/format or codec|corrupt or use an unsupported format/)
})

test('adding an undecodable media layer surfaces a toast instead of failing silently', async ({ page }) => {
    await loadApp(page)
    await createSolidProject(page)
    const file = await makeCorruptFile(page, 'broken.png', 'image/png')

    const result = await page.evaluate(async (file) => {
        const app = window.layersApp
        const outcome = await app._handleAddMediaLayer(file, 'image')
        return { status: outcome.status, message: outcome.error?.message }
    }, file)

    expect(result.status).toBe('decode-failed')
    expect(result.message).toContain('broken.png')
    expect(result.message).toContain("doesn’t support")

    const toast = lastErrorToast(page)
    await expect(toast).toContainText('broken.png')

    // No layer was added.
    const layerCount = await page.evaluate(() => window.layersApp._layers.length)
    expect(layerCount).toBe(1)
})

test('a valid image still opens after decode failures', async ({ page }) => {
    await loadApp(page)
    await createSolidProject(page)

    const corrupt = await makeCorruptFile(page, 'corrupt.jpg', 'image/jpeg')
    const failed = await page.evaluate(async (file) => {
        return window.layersApp._handleOpenMedia(file, 'image')
    }, corrupt)
    expect(failed).toBe('failed')

    // Wait for the failure toast to expire so it cannot match the success path.
    await page.waitForTimeout(3500)

    const file = await page.evaluateHandle(async () => {
        const canvas = document.createElement('canvas')
        canvas.width = 64
        canvas.height = 64
        const ctx = canvas.getContext('2d')
        ctx.fillStyle = '#4a7'
        ctx.fillRect(0, 0, 64, 64)
        const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'))
        return new File([blob], 'valid.png', { type: 'image/png' })
    })

    const status = await page.evaluate(async (file) => {
        return window.layersApp._handleOpenMedia(file, 'image')
    }, file)
    expect(status).toBe('opened')

    const dims = await page.evaluate(() => {
        const canvas = document.getElementById('canvas')
        return { w: canvas.width, h: canvas.height }
    })
    expect(dims).toEqual({ w: 64, h: 64 })
})
