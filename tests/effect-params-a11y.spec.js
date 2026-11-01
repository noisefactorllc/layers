import { test, expect } from './fixtures.js'
import { reopenNewProjectDialog } from './helpers/new-project.js'

async function openPanel(page, kind) {
    await page.goto('/', { waitUntil: 'networkidle' })
    await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })
    await reopenNewProjectDialog(page)
    await page.click('.media-option[data-type="solid"]')
    await page.fill('#canvas-width', '128')
    await page.fill('#canvas-height', '128')
    await page.click('.canvas-size-dialog .action-btn.primary')
    await page.waitForSelector('.open-dialog-backdrop.visible', { state: 'hidden' })
    const layerId = await page.evaluate(async kind => {
        await window.LayersAgent.ready
        if (kind === 'base') return window.layersApp._layers[0].id
        const added = await window.LayersAgent.addLayer(kind === 'text'
            ? { kind: 'text', text: 'Accessible text' }
            : { kind: 'effect', effectId: `filter/${kind}` })
        if (!added.ok) throw new Error(added.error.message)
        return added.result.layerId
    }, kind)
    const row = page.locator(`layer-item[data-layer-id="${layerId}"]`)
    await row.locator('.layer-params-toggle').click()
    const panel = row.locator('effect-params')
    await expect(panel.locator('.control-group').first()).toBeVisible()
    return { panel, layerId }
}

async function expectParameterNames(panel) {
    const groups = panel.locator('.control-group')
    expect(await groups.count()).toBeGreaterThan(0)
    let focusableCount = 0
    for (const group of await groups.all()) {
        const label = (await group.locator('.control-label').textContent()).trim()
        expect(label).not.toBe('')
        const controls = group.locator('input, button, textarea, select, [tabindex], [contenteditable="true"]')
            .filter({ visible: true })
        // Discover focusability together; retain a computed-name assertion for each control.
        const indices = await controls.evaluateAll(elements => elements.flatMap((el, index) =>
            !el.matches(':disabled') && !el.closest('[aria-disabled="true"]')
                && (el.tabIndex >= 0 || el.isContentEditable)
                ? [{ index, fontStyle: !!el.closest('.font-control-stack > select-dropdown') }] : []))
        for (const { index, fontStyle } of indices) {
            await expect(controls.nth(index)).toHaveAccessibleName(fontStyle ? 'font style' : label)
            focusableCount++
        }
    }
    expect(focusableCount).toBeGreaterThan(0)
    const fontGroup = panel.locator('.control-group[data-param-key="font"]')
    if (await fontGroup.count()) {
        const label = (await fontGroup.locator('.control-label').textContent()).trim()
        await expect(fontGroup.locator('font-select > .select-trigger')).toHaveAccessibleName(label)
        await expect(fontGroup.locator('.font-control-stack > select-dropdown > .select-trigger'))
            .toHaveAccessibleName('font style')
    }
}

for (const kind of ['blur', 'text', 'base', 'lighting']) {
    test(`${kind} parameter controls keep their visible label names through updates and reconnection`, async ({ page }) => {
        const { panel, layerId } = await openPanel(page, kind)
        await expectParameterNames(panel)

        const updated = await page.evaluate(async ({ kind, layerId }) => {
            const params = kind === 'blur' ? { radiusX: 6 }
                : kind === 'text' ? { text: 'Updated text' }
                    : kind === 'lighting' ? { lightDirection: [0.25, 0.5, 0.75] } : { alpha: 0.5 }
            return window.LayersAgent.setLayerEffectParams({ layerId, params })
        }, { kind, layerId })
        expect(updated.ok).toBe(true)
        await expectParameterNames(panel)

        await panel.evaluate(el => {
            const parent = el.parentElement
            el.remove()
            parent.appendChild(el)
        })
        await expectParameterNames(panel)
    })
}
