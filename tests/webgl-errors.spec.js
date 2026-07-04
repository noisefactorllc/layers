import { test, expect } from 'playwright/test'

function collectWebGLErrors(page) {
    const webglErrors = []
    page.on('console', msg => {
        const text = msg.text()
        if (text.includes('WebGL Error') || text.includes('GL_INVALID')) {
            webglErrors.push(text)
        }
    })
    return webglErrors
}

async function createProject(page, type) {
    await page.waitForSelector('.open-dialog-backdrop.visible')
    await page.click(`.media-option[data-type="${type}"]`)
    await page.waitForSelector('.canvas-size-dialog', { timeout: 5000 })
    await page.click('.canvas-size-dialog .action-btn.primary')
    await page.waitForSelector('.open-dialog-backdrop.visible', { state: 'hidden', timeout: 5000 })
    await page.waitForTimeout(2000)
}

test.describe('WebGL error handling', () => {
    test('creating gradient composition renders without WebGL errors', async ({ page }) => {
        const consoleMessages = []
        page.on('console', msg => consoleMessages.push(msg.text()))
        const webglErrors = collectWebGLErrors(page)

        await page.goto('/', { waitUntil: 'networkidle' })
        await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })

        await createProject(page, 'gradient')

        await expect(page.locator('#canvas')).toBeVisible()
        await expect(page.locator('layer-item').first()).toBeVisible()

        const gradientState = await page.evaluate(() => ({
            params: window.layersApp._layers[0].effectParams,
            dsl: window.layersApp._renderer.currentDsl
        }))
        expect(gradientState.params).toEqual({ type: 2 })
        expect(gradientState.dsl).toContain('gradient(type: 2)')

        await page.waitForTimeout(500)
        await page.screenshot({ path: 'test-results/webgl-gradient-test.png' })

        console.log('Console messages:', consoleMessages.filter(m =>
            m.includes('WebGL') || m.includes('Error') || m.includes('error')
        ))

        expect(webglErrors).toEqual([])
    })

    test('creating solid composition renders without WebGL errors', async ({ page }) => {
        const webglErrors = collectWebGLErrors(page)

        await page.goto('/', { waitUntil: 'networkidle' })
        await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })

        await createProject(page, 'solid')

        await expect(page.locator('#canvas')).toBeVisible()

        await page.screenshot({ path: 'test-results/webgl-solid-test.png' })

        expect(webglErrors).toEqual([])
    })

    test('adding effect layer to composition renders without WebGL errors', async ({ page }) => {
        const webglErrors = collectWebGLErrors(page)

        await page.goto('/', { waitUntil: 'networkidle' })
        await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })

        await createProject(page, 'solid')

        const addLayerBtn = page.locator('#addLayerBtn')
        await expect(addLayerBtn).toBeVisible()
        await addLayerBtn.click()

        await page.waitForSelector('.add-layer-dialog', { timeout: 5000 })

        const effectOption = page.locator('.media-option[data-mode="effect"]')
        await expect(effectOption).toBeVisible()
        await effectOption.click()

        await page.waitForTimeout(500)

        const firstEffect = page.locator('.effect-option').first()
        if (await firstEffect.isVisible()) {
            await firstEffect.click()
        }

        await page.waitForTimeout(2000)
        await page.screenshot({ path: 'test-results/webgl-add-layer-test.png' })

        if (webglErrors.length > 0) {
            console.log('WebGL Errors found:', webglErrors)
        }
        expect(webglErrors).toEqual([])
    })
})
