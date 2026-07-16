import { test, expect } from 'playwright/test'

// vec3 effect params render a working handfish <vector3d-picker> (mirroring
// noisedeck's controlGroupBuilder) instead of being silently hidden by the
// old unsupportedTypes filter. Guards:
//  - the control exists, is visible, and is normalized for direction params
//  - driving it updates layer.effectParams AND visibly changes the render
//  - vec3 params that declare control:"slider" (filter/grade tints/wheels)
//    still get the picker via type-first dispatch, never a scalar slider

async function bootWithNoise(page) {
    await page.goto('/', { waitUntil: 'networkidle' })
    await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })
    await page.waitForSelector('.open-dialog-backdrop.visible')
    await page.click('.media-option[data-type="solid"]')
    await page.waitForSelector('.canvas-size-dialog', { timeout: 5000 })
    await page.click('.canvas-size-dialog .action-btn.primary')
    await page.waitForSelector('.open-dialog-backdrop.visible', { state: 'hidden', timeout: 5000 })
    await page.waitForTimeout(1500)
    await page.evaluate(async () => {
        const app = window.layersApp
        await app._handleAddEffectLayer('synth/noise')
        await app._rebuild({ force: true })
    })
    await page.waitForTimeout(500)
}

const captureFrozen = (page) => page.evaluate(() => {
    const app = window.layersApp
    if (app._renderer.isRunning) app._renderer.stop()
    app._renderer.render(0.25)
    const canvasEl = document.getElementById('canvas')
    const gl = canvasEl.getContext('webgl2')
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    const w = canvasEl.width, h = canvasEl.height
    const pixels = new Uint8Array(w * h * 4)
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, pixels)
    let hash = 2166136261 >>> 0
    for (let i = 0; i < pixels.length; i += 4) {
        for (let c = 0; c < 3; c++) {
            hash ^= pixels[i + c]
            hash = Math.imul(hash, 16777619) >>> 0
        }
    }
    return hash >>> 0
})

test('lighting lightDirection renders a vector3d-picker that drives the render', async ({ page }) => {
    await bootWithNoise(page)

    const layerId = await page.evaluate(async () => {
        const app = window.layersApp
        const res = await app._handleAddEffectLayer('filter/lighting')
        return res.value ?? app._layers[app._layers.length - 1].id
    })
    await page.waitForTimeout(800)

    // Expand the lighting layer's params
    const layerItem = page.locator(`layer-item[data-layer-id="${layerId}"]`)
    const toggleBtn = layerItem.locator('.layer-params-toggle').first()
    await toggleBtn.click()
    await expect(layerItem).toHaveClass(/params-expanded/)

    const picker = layerItem.locator(
        'effect-params .control-group[data-param-key="lightDirection"] vector3d-picker')
    await expect(picker).toBeVisible()
    // Direction params get normalized mode (unit vector gizmo)
    await expect(picker).toHaveAttribute('normalized', '')

    // The picker must fit the params panel
    const panelBox = await layerItem.locator('effect-params').boundingBox()
    const pickerBox = await picker.boundingBox()
    expect(pickerBox.width).toBeGreaterThan(50)
    expect(pickerBox.x).toBeGreaterThanOrEqual(panelBox.x - 1)
    expect(pickerBox.x + pickerBox.width).toBeLessThanOrEqual(panelBox.x + panelBox.width + 1)

    const before = await captureFrozen(page)

    // Drive the control the way a user drag ends up: set value, fire input
    await picker.evaluate((el) => {
        el.value = { x: -0.9, y: -0.35, z: 0.2 }
        el.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await page.waitForTimeout(600)

    const params = await page.evaluate((id) => {
        const app = window.layersApp
        const layer = app._layers.find(l => l.id === id)
        return layer?.effectParams?.lightDirection
    }, layerId)
    expect(Array.isArray(params)).toBe(true)
    expect(params.length).toBe(3)
    expect(params[0]).toBeCloseTo(-0.9, 1)

    const after = await captureFrozen(page)
    expect(after, 'changing lightDirection must visibly change the render').not.toBe(before)
})

test('grade vec3 params (declared control:"slider") get pickers, not sliders', async ({ page }) => {
    await bootWithNoise(page)

    const layerId = await page.evaluate(async () => {
        const app = window.layersApp
        const res = await app._handleAddEffectLayer('filter/grade')
        return res.value ?? app._layers[app._layers.length - 1].id
    })
    await page.waitForTimeout(800)

    const layerItem = page.locator(`layer-item[data-layer-id="${layerId}"]`)
    await layerItem.locator('.layer-params-toggle').first().click()
    await expect(layerItem).toHaveClass(/params-expanded/)

    const result = await layerItem.locator('effect-params').evaluate((paramsEl) => {
        const groups = [...paramsEl.querySelectorAll('.control-group')]
        return groups.map(group => ({
            param: group.dataset.paramKey,
            hasPicker: !!group.querySelector('vector3d-picker'),
            hasSlider: !!group.querySelector('slider-value'),
        }))
    })

    // shadowTint and highlightTint are vec3 with control:"slider" in the
    // definition; both must render pickers and neither may render a slider.
    for (const key of ['shadowTint', 'highlightTint']) {
        const row = result.find(r => r.param === key)
        expect(row, `param group for ${key} should render`).toBeTruthy()
        expect(row.hasPicker, `${key} must get a vector3d-picker`).toBe(true)
        expect(row.hasSlider, `${key} must not get a scalar slider`).toBe(false)
    }
})
