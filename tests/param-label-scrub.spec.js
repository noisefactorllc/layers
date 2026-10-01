import { test, expect } from './fixtures.js'
import { appReady, layerCount } from './waits.js'
import { reopenNewProjectDialog } from './helpers/new-project.js'

// Scrubby effect-param labels (Domain 1 ergonomics): dragging a slider
// param's .control-label horizontally scrubs the value (1 px = one step,
// clamped to the declared range, quantized to the step grid) through the
// same param-change path the slider itself uses; Escape mid-drag restores
// the starting value; a click without travel changes nothing; and the app's
// slider-drag undo coalescing (.control-label is in app.js CONTROL_SELECTOR)
// commits the whole drag as one undo entry.

// Transparent 512 canvas keeps the boot cheap and makes the effect layer the
// only rendered row (same shard-cost trim as other dialog-booting suites; no
// assertion here reads pixels).
async function boot(page) {
    await page.goto('/', { waitUntil: 'networkidle' })
    await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })
    await reopenNewProjectDialog(page)
    await page.click('.media-option[data-type="transparent"]')
    await page.waitForSelector('.canvas-size-dialog', { timeout: 5000 })
    await page.fill('#canvas-width', '512')
    await page.fill('#canvas-height', '512')
    await page.click('.canvas-size-dialog .action-btn.primary')
    await page.waitForSelector('.open-dialog-backdrop.visible', { state: 'hidden', timeout: 5000 })
    await appReady(page)

    await page.evaluate(async () => {
        const env = await window.LayersAgent.addLayer({ kind: 'effect', effectId: 'filter/blur' })
        if (!env.ok) throw new Error(`addLayer failed: ${JSON.stringify(env.error)}`)
    })
    await layerCount(page, 2)
}

// Expand the effect layer's params panel and return a handle to the first
// slider control group: { label, slider, paramKey }.
async function openSliderGroup(page) {
    const layerItem = page.locator('layer-item.effect-layer:not(.base-layer)')
    await expect(layerItem).toBeVisible()
    await layerItem.locator('.layer-params-toggle').click()
    const group = layerItem.locator('.control-group', { has: page.locator('slider-value') }).first()
    await group.waitFor({ state: 'visible' })
    return group
}

// Read the slider's live state: { value, min, max, step, paramKey }.
async function sliderState(page, group) {
    return group.evaluate((g) => {
        const slider = g.querySelector('slider-value')
        return {
            paramKey: g.dataset.paramKey,
            value: Number(slider.value),
            min: Number(slider.min),
            max: Number(slider.max),
            step: Number(slider.step) || null,
        }
    })
}

// Read the committed effectParams value for a param key from the model.
async function modelParam(page, paramKey) {
    return page.evaluate((key) => {
        const layer = window.layersApp._layers.find(l => l.effectId === 'filter/blur')
        return layer?.effectParams?.[key]
    }, paramKey)
}

async function dragLabel(page, group, dx) {
    const label = group.locator('.control-label')
    const box = await label.boundingBox()
    expect(box).toBeTruthy()
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    // Two intermediate moves: each committed scrub value drives a full DSL
    // recompile on software GL, so extra steps only burn the 90s test budget.
    await page.mouse.move(box.x + box.width / 2 + dx / 2, box.y + box.height / 2)
    await page.mouse.move(box.x + box.width / 2 + dx, box.y + box.height / 2)
}

test.describe('Scrubby effect-param labels', () => {
    test('label is scrub-abled with an ew-resize cursor', async ({ page }) => {
        await boot(page)
        const group = await openSliderGroup(page)
        const label = group.locator('.control-label')
        await expect(label).toHaveClass(/control-label-scrub/)
        const cursor = await label.evaluate((el) => getComputedStyle(el).cursor)
        expect(cursor).toBe('ew-resize')
    })

    test('dragging right increases the value and commits it to the model', async ({ page }) => {
        await boot(page)
        const group = await openSliderGroup(page)
        const before = await sliderState(page, group)

        await dragLabel(page, group, 60)
        await page.mouse.up()
        await page.waitForFunction(
            ({ key, v }) => {
                const layer = window.layersApp._layers.find(l => l.effectId === 'filter/blur')
                const cur = layer?.effectParams?.[key]
                return typeof cur === 'number' && cur !== v
            },
            { key: before.paramKey, v: before.value },
        )

        const after = await sliderState(page, group)
        expect(after.value).toBeGreaterThan(before.value)
        // The committed model param tracks the scrubbed value (same param-change
        // path as the slider itself). step may be unreadable from the component,
        // so tolerate one step of quantization slack.
        const model = await modelParam(page, before.paramKey)
        const slack = Number.isFinite(after.step) ? after.step : Math.max(0.02, (after.max - after.min) / 100)
        expect(Math.abs(model - after.value)).toBeLessThanOrEqual(slack + 1e-6)
    })

    test('a drag past the range clamps at max without escaping it', async ({ page }) => {
        await boot(page)
        const group = await openSliderGroup(page)
        const before = await sliderState(page, group)

        await dragLabel(page, group, 4000)
        await page.mouse.up()

        await page.waitForFunction(
            ({ key, max }) => {
                const layer = window.layersApp._layers.find(l => l.effectId === 'filter/blur')
                const cur = layer?.effectParams?.[key]
                return typeof cur === 'number' && cur >= max
            },
            { key: before.paramKey, max: before.max },
        )
        const after = await sliderState(page, group)
        expect(after.value).toBeCloseTo(before.max, 6)
        expect(after.value).toBeLessThanOrEqual(before.max)
    })

    test('Escape mid-drag restores the starting value', async ({ page }) => {
        await boot(page)
        const group = await openSliderGroup(page)
        const before = await sliderState(page, group)

        await dragLabel(page, group, 60)
        await page.keyboard.press('Escape')
        await page.mouse.up()

        const after = await sliderState(page, group)
        expect(after.value).toBeCloseTo(before.value, 6)
        const model = await modelParam(page, before.paramKey)
        expect(model ?? before.value).toBeCloseTo(before.value, 6)
    })

    test('a click with no travel does not change the value', async ({ page }) => {
        await boot(page)
        const group = await openSliderGroup(page)
        const before = await sliderState(page, group)

        const label = group.locator('.control-label')
        const box = await label.boundingBox()
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
        await page.mouse.down()
        await page.mouse.up()

        const after = await sliderState(page, group)
        expect(after.value).toBeCloseTo(before.value, 6)
        const model = await modelParam(page, before.paramKey)
        if (model !== undefined) expect(model).toBeCloseTo(before.value, 6)
    })

    test('a whole drag lands as one undo entry', async ({ page }) => {
        await boot(page)
        const group = await openSliderGroup(page)
        const before = await sliderState(page, group)

        await dragLabel(page, group, 60)
        await page.mouse.up()
        await page.waitForFunction(
            ({ key, v }) => {
                const layer = window.layersApp._layers.find(l => l.effectId === 'filter/blur')
                return layer?.effectParams?.[key] !== undefined &&
                    layer.effectParams[key] !== v
            },
            { key: before.paramKey, v: before.value },
        )

        // One undo step must return the param to its pre-drag value: if the
        // drag had spammed history, the first undo would land mid-drag.
        await page.evaluate(async () => { await window.layersApp._undo() })
        const model = await modelParam(page, before.paramKey)
        expect(model ?? before.value).toBeCloseTo(before.value, 6)
    })
})