import { test, expect } from './fixtures.js'
import { seedClipboardRead } from './helpers/clipboard.js'

async function createTransparentProject(page) {
    await page.waitForSelector('.open-dialog-backdrop.visible')
    await page.click('.media-option[data-type="transparent"]')
    await page.waitForSelector('.canvas-size-dialog', { timeout: 5000 })
    await page.click('.canvas-size-dialog .action-btn.primary')
    await page.waitForSelector('.open-dialog-backdrop.visible', { state: 'hidden', timeout: 5000 })
    await page.waitForTimeout(500)
}

async function copyColorSquareToClipboard(page, color) {
    await seedClipboardRead(page, { width: 50, height: 50, color })
}

async function drawMouseSelection(page, overlayBox, startOffset, endOffset) {
    await page.mouse.move(overlayBox.x + startOffset.x, overlayBox.y + startOffset.y)
    await page.mouse.down()
    await page.mouse.move(overlayBox.x + endOffset.x, overlayBox.y + endOffset.y, { steps: 10 })
    await page.mouse.up()
    await page.waitForTimeout(500)
}

function getSelectionInfo() {
    const sm = window.layersApp._selectionManager
    if (!sm.hasSelection()) return { error: 'No selection created' }
    const path = sm.selectionPath
    return {
        type: path.type,
        x: path.x,
        y: path.y,
        width: path.width,
        height: path.height,
        aspectRatio: path.width / path.height
    }
}

test.describe('Paste with real mouse-drawn selection', () => {
    test('mouse-drawn selection matches pasted image dimensions', async ({ page }) => {
        await page.goto('/', { waitUntil: 'networkidle' })
        await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })
        await createTransparentProject(page)
        await copyColorSquareToClipboard(page, 'red')

        const overlay = page.locator('#selectionOverlay')
        const overlayBox = await overlay.boundingBox()
        if (!overlayBox) throw new Error('Could not get overlay bounding box')

        await drawMouseSelection(page, overlayBox, { x: 100, y: 100 }, { x: 250, y: 250 })

        const selectionInfo = await page.evaluate(getSelectionInfo)
        console.log('Selection created:', selectionInfo)

        expect(selectionInfo.error).toBeUndefined()
        expect(selectionInfo.type).toBe('rect')
        expect(selectionInfo.aspectRatio).toBeGreaterThan(0.9)
        expect(selectionInfo.aspectRatio).toBeLessThan(1.1)

        await page.evaluate(async () => { await window.layersApp._handlePaste() })
        await page.waitForTimeout(1000)

        // Verify pasted layer is selection-sized with offset
        const pastedInfo = await page.evaluate(() => {
            const layers = window.layersApp._layers
            const pastedLayer = layers[layers.length - 1]
            const mediaFile = pastedLayer.mediaFile

            return new Promise((resolve) => {
                const reader = new FileReader()
                reader.onload = () => {
                    const img = new Image()
                    img.onload = () => {
                        resolve({
                            width: img.width,
                            height: img.height,
                            aspectRatio: img.width / img.height,
                            offsetX: pastedLayer.offsetX,
                            offsetY: pastedLayer.offsetY
                        })
                    }
                    img.src = reader.result
                }
                reader.readAsDataURL(mediaFile)
            })
        })
        console.log('Pasted image:', pastedInfo)

        // Image dimensions should match selection dimensions
        expect(Math.abs(pastedInfo.width - selectionInfo.width)).toBeLessThan(3)
        expect(Math.abs(pastedInfo.height - selectionInfo.height)).toBeLessThan(3)
        expect(Math.abs(pastedInfo.aspectRatio - selectionInfo.aspectRatio)).toBeLessThan(0.1)
        // Offset is center-relative: (selX + selW/2) - canvasW/2
        const expectedOffsetX = Math.round(selectionInfo.x + selectionInfo.width / 2 - 1024 / 2)
        const expectedOffsetY = Math.round(selectionInfo.y + selectionInfo.height / 2 - 1024 / 2)
        expect(Math.abs(pastedInfo.offsetX - expectedOffsetX)).toBeLessThan(3)
        expect(Math.abs(pastedInfo.offsetY - expectedOffsetY)).toBeLessThan(3)
    })

    test('non-square mouse selection pastes correct aspect ratio', async ({ page }) => {
        await page.goto('/', { waitUntil: 'networkidle' })
        await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })
        await createTransparentProject(page)
        await copyColorSquareToClipboard(page, 'blue')

        const overlay = page.locator('#selectionOverlay')
        const overlayBox = await overlay.boundingBox()
        if (!overlayBox) throw new Error('Could not get overlay bounding box')

        // Draw a WIDE rectangle: 200x100 in displayed coordinates
        await drawMouseSelection(page, overlayBox, { x: 100, y: 100 }, { x: 300, y: 200 })

        const selectionInfo = await page.evaluate(getSelectionInfo)
        console.log('Wide selection:', selectionInfo)

        expect(selectionInfo.error).toBeUndefined()
        expect(selectionInfo.aspectRatio).toBeGreaterThan(1.5)
        expect(selectionInfo.aspectRatio).toBeLessThan(2.5)

        await page.evaluate(async () => { await window.layersApp._handlePaste() })
        await page.waitForTimeout(1000)

        const pastedInfo = await page.evaluate(() => {
            const layers = window.layersApp._layers
            const pastedLayer = layers[layers.length - 1]
            const mediaFile = pastedLayer.mediaFile

            return new Promise((resolve) => {
                const reader = new FileReader()
                reader.onload = () => {
                    const img = new Image()
                    img.onload = () => {
                        resolve({
                            width: img.width,
                            height: img.height,
                            aspectRatio: img.width / img.height,
                            offsetX: pastedLayer.offsetX,
                            offsetY: pastedLayer.offsetY
                        })
                    }
                    img.src = reader.result
                }
                reader.readAsDataURL(mediaFile)
            })
        })
        console.log('Pasted wide image:', pastedInfo)

        expect(Math.abs(pastedInfo.aspectRatio - selectionInfo.aspectRatio)).toBeLessThan(0.2)
        expect(Math.abs(pastedInfo.width - selectionInfo.width)).toBeLessThan(3)
        expect(Math.abs(pastedInfo.height - selectionInfo.height)).toBeLessThan(3)
    })
})
