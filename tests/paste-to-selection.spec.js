import { test, expect } from './fixtures.js'
import { seedClipboardRead } from './helpers/clipboard.js'

async function createTransparentProject(page) {
    await page.waitForSelector('.open-dialog-backdrop.visible')
    await page.click('.media-option[data-type="transparent"]')
    await page.waitForSelector('.canvas-size-dialog', { timeout: 5000 })
    await page.click('.canvas-size-dialog .action-btn.primary')
    await page.waitForSelector('.open-dialog-backdrop.visible', { state: 'hidden', timeout: 5000 })
    await page.waitForTimeout(1000)
}

async function copyColorSquareToClipboard(page, color) {
    await seedClipboardRead(page, { width: 50, height: 50, color })
}

test.describe('Paste to selection', () => {
    test('SQUARE selection pastes SQUARE image (not rectangle)', async ({ page }) => {
        await page.goto('/', { waitUntil: 'networkidle' })
        await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })
        await createTransparentProject(page)
        await copyColorSquareToClipboard(page, 'red')

        // Create a SQUARE selection: 150x150 at (200, 200)
        const selectionSize = 150

        await page.evaluate(({ size }) => {
            const sm = window.layersApp._selectionManager
            sm._selectionPath = { type: 'rect', x: 200, y: 200, width: size, height: size }
            sm._startAnimation()
        }, { size: selectionSize })

        await page.waitForTimeout(500)

        // Verify selection is square
        const beforePaste = await page.evaluate(() => {
            const sm = window.layersApp._selectionManager
            const path = sm.selectionPath
            return {
                width: path.width,
                height: path.height,
                isSquare: path.width === path.height
            }
        })

        console.log('Selection before paste:', beforePaste)
        expect(beforePaste.isSquare).toBe(true)
        expect(beforePaste.width).toBe(selectionSize)
        expect(beforePaste.height).toBe(selectionSize)

        // Paste
        await page.evaluate(async () => {
            await window.layersApp._handlePaste()
        })
        await page.waitForTimeout(1000)

        // Verify pasted layer is selection-sized with correct offset
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
                            imageWidth: img.width,
                            imageHeight: img.height,
                            isSquare: img.width === img.height,
                            offsetX: pastedLayer.offsetX,
                            offsetY: pastedLayer.offsetY
                        })
                    }
                    img.src = reader.result
                }
                reader.readAsDataURL(mediaFile)
            })
        })

        console.log('Pasted image info:', pastedInfo)

        // Pasted layer should be selection-sized, not full canvas
        expect(pastedInfo.isSquare).toBe(true)
        expect(pastedInfo.imageWidth).toBe(selectionSize)
        expect(pastedInfo.imageHeight).toBe(selectionSize)
        // Offset is center-relative: (200 + 150/2) - 1024/2 = -237
        expect(pastedInfo.offsetX).toBe(Math.round(200 + selectionSize / 2 - 1024 / 2))
        expect(pastedInfo.offsetY).toBe(Math.round(200 + selectionSize / 2 - 1024 / 2))
    })

    test('pasted image scales to fit marquee selection bounds', async ({ page }) => {
        await page.goto('/', { waitUntil: 'networkidle' })
        await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })
        await createTransparentProject(page)
        await copyColorSquareToClipboard(page, 'red')

        // Create a selection at known coordinates: 200x100 at (100, 150)
        const selectionX = 100
        const selectionY = 150
        const selectionW = 200
        const selectionH = 100

        await page.evaluate(({ x, y, w, h }) => {
            const sm = window.layersApp._selectionManager
            sm._selectionPath = { type: 'rect', x, y, width: w, height: h }
            sm._startAnimation()
        }, { x: selectionX, y: selectionY, w: selectionW, h: selectionH })

        await page.waitForTimeout(500)

        expect(await page.evaluate(() => window.layersApp._selectionManager?.hasSelection())).toBe(true)

        // Paste
        const pasteResult = await page.evaluate(async () => {
            const app = window.layersApp
            const sm = app._selectionManager

            const result = {
                beforePasteHasSelection: sm.hasSelection(),
            }

            await app._handlePaste()

            result.afterPasteHasSelection = sm.hasSelection()
            result.afterPasteLayerCount = app._layers.length

            return result
        })

        console.log('Paste result:', pasteResult)
        expect(pasteResult.beforePasteHasSelection).toBe(true)
        expect(pasteResult.afterPasteHasSelection).toBe(false)
        expect(pasteResult.afterPasteLayerCount).toBe(2)

        await page.waitForTimeout(500)

        // Verify the pasted layer is selection-sized with correct offset
        const pixelCheck = await page.evaluate(({ selX, selY, selW, selH }) => {
            const app = window.layersApp
            const layers = app._layers
            const pastedLayer = layers[layers.length - 1]
            const mediaFile = pastedLayer.mediaFile
            if (!mediaFile) return { error: 'No media file on pasted layer' }

            return new Promise((resolve) => {
                const reader = new FileReader()
                reader.onload = async () => {
                    const img = new Image()
                    img.onload = () => {
                        const testCanvas = document.createElement('canvas')
                        testCanvas.width = img.width
                        testCanvas.height = img.height
                        const ctx = testCanvas.getContext('2d')
                        ctx.drawImage(img, 0, 0)

                        const imageData = ctx.getImageData(0, 0, testCanvas.width, testCanvas.height)

                        let redPixelCount = 0
                        for (let y = 0; y < testCanvas.height; y++) {
                            for (let x = 0; x < testCanvas.width; x++) {
                                const idx = (y * testCanvas.width + x) * 4
                                if (imageData.data[idx] > 200 && imageData.data[idx + 1] < 50) {
                                    redPixelCount++
                                }
                            }
                        }

                        resolve({
                            imageSize: { width: testCanvas.width, height: testCanvas.height },
                            offsetX: pastedLayer.offsetX,
                            offsetY: pastedLayer.offsetY,
                            expectedBounds: { x: selX, y: selY, width: selW, height: selH },
                            redPixelCount
                        })
                    }
                    img.onerror = () => resolve({ error: 'Failed to load pasted image' })
                    img.src = reader.result
                }
                reader.onerror = () => resolve({ error: 'Failed to read media file' })
                reader.readAsDataURL(mediaFile)
            })
        }, { selX: selectionX, selY: selectionY, selW: selectionW, selH: selectionH })

        console.log('Pixel check:', pixelCheck)

        expect(pixelCheck.error).toBeUndefined()
        // Layer file should be selection-sized
        expect(pixelCheck.imageSize.width).toBe(selectionW)
        expect(pixelCheck.imageSize.height).toBe(selectionH)
        // Offset is center-relative: (selX + selW/2) - 1024/2
        expect(pixelCheck.offsetX).toBe(Math.round(selectionX + selectionW / 2 - 1024 / 2))
        expect(pixelCheck.offsetY).toBe(Math.round(selectionY + selectionH / 2 - 1024 / 2))
        expect(pixelCheck.redPixelCount).toBeGreaterThan(0)
    })

    test('paste without selection centers the image', async ({ page }) => {
        await page.goto('/', { waitUntil: 'networkidle' })
        await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })
        await createTransparentProject(page)
        await copyColorSquareToClipboard(page, 'blue')

        // Verify no selection
        const hasSelection = await page.evaluate(() => {
            return window.layersApp._selectionManager?.hasSelection() || false
        })
        expect(hasSelection).toBe(false)

        // Paste
        await page.evaluate(async () => {
            await window.layersApp._handlePaste()
        })
        await page.waitForTimeout(1000)

        // Check layer was added with centered offset
        const result = await page.evaluate(() => {
            const app = window.layersApp
            const layer = app._layers[app._layers.length - 1]
            return {
                layerCount: app._layers.length,
                offsetX: layer.offsetX,
                offsetY: layer.offsetY
            }
        })
        expect(result.layerCount).toBe(2)
        // Centered image: offset = 0 (center-relative)
        expect(result.offsetX).toBe(0)
        expect(result.offsetY).toBe(0)
    })
})
