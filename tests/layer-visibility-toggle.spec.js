import { test, expect } from './fixtures.js'
import { appReady, appState, layerCount } from './waits.js'
import { reopenNewProjectDialog } from './helpers/new-project.js'

/**
 * Layer visibility toggle ergonomics.
 *
 * A visibility toggle is a property-only mutation: it must flip the eye icon
 * instantly, in place, without rebuilding the layer panel's DOM (which would
 * drop keyboard focus, re-create every control and thumbnail canvas, and
 * stomp in-progress edits) while the render pipeline catches up.
 */
test.describe('Layer visibility toggle', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('/', { waitUntil: 'networkidle' })
        await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })

        await reopenNewProjectDialog(page)
        await page.click('.media-option[data-type="solid"]')
        await page.waitForSelector('.canvas-size-dialog', { timeout: 5000 })
        await page.click('.canvas-size-dialog .action-btn.primary')
        await page.waitForSelector('.open-dialog-backdrop.visible', { state: 'hidden', timeout: 5000 })
        await appReady(page)

        // Add an effect layer on top so two rows exist and the pipeline
        // actually changes when it is hidden.
        await page.evaluate(async () => {
            await window.layersApp._handleAddEffectLayer('synth/gradient')
        })
        await layerCount(page, 2)
    })

    test('eye icon flips synchronously in place, without re-rendering the item', async ({ page }) => {
        const topId = await page.evaluate(() => window.layersApp._layers[1].id)

        // Tag the live button so a re-render (which creates a new element)
        // is distinguishable from an in-place update.
        await page.evaluate((id) => {
            const btn = document.querySelector(
                `layer-item[data-layer-id="${id}"] .layer-visibility`)
            btn.dataset.probe = 'probe-1'
        }, topId)

        await page.click(`layer-item[data-layer-id="${topId}"] .layer-visibility`)

        const state = await page.evaluate((id) => {
            const btn = document.querySelector(
                `layer-item[data-layer-id="${id}"] .layer-visibility`)
            return {
                sameNode: btn.dataset.probe === 'probe-1',
                visibleClass: btn.classList.contains('visible'),
                glyph: btn.querySelector('.icon-material').textContent.trim(),
            }
        }, topId)
        expect(state.sameNode).toBe(true)
        expect(state.visibleClass).toBe(false)
        expect(state.glyph).toBe('visibility_off')

        await appState(page,
            (id) => window.layersApp._layers.find(l => l.id === id).visible === false,
            topId)

        // The committed state matches the optimistic icon.
        const committed = await page.evaluate((id) => {
            const btn = document.querySelector(
                `layer-item[data-layer-id="${id}"] .layer-visibility`)
            return {
                sameNode: btn.dataset.probe === 'probe-1',
                visibleClass: btn.classList.contains('visible'),
                glyph: btn.querySelector('.icon-material').textContent.trim(),
            }
        }, topId)
        expect(committed.sameNode).toBe(true)
        expect(committed.visibleClass).toBe(false)
        expect(committed.glyph).toBe('visibility_off')
    })

    test('keyboard toggle keeps focus on the eye button', async ({ page }) => {
        const topId = await page.evaluate(() => window.layersApp._layers[1].id)
        const selector = `layer-item[data-layer-id="${topId}"] .layer-visibility`

        await page.evaluate((id) => {
            document.querySelector(
                `layer-item[data-layer-id="${id}"] .layer-visibility`).dataset.probe = 'probe-2'
        }, topId)

        await page.focus(selector)
        await page.keyboard.press('Enter')

        await appState(page,
            (id) => window.layersApp._layers.find(l => l.id === id).visible === false,
            topId)

        const focus = await page.evaluate((id) => {
            const btn = document.querySelector(
                `layer-item[data-layer-id="${id}"] .layer-visibility`)
            return {
                isFocused: document.activeElement === btn,
                sameNode: btn.dataset.probe === 'probe-2',
            }
        }, topId)
        expect(focus.isFocused).toBe(true)
        expect(focus.sameNode).toBe(true)
    })

    test('the render pipeline reflects the toggle and round-trips', async ({ page }) => {
        const topId = await page.evaluate(() => window.layersApp._layers[1].id)

        const dslVisible = await page.evaluate(() =>
            window.layersApp._renderer._currentDsl)

        await page.click(`layer-item[data-layer-id="${topId}"] .layer-visibility`)
        await appState(page,
            (id) => window.layersApp._layers.find(l => l.id === id).visible === false,
            topId)
        const dslHidden = await page.waitForFunction((before) =>
            window.layersApp._renderer._currentDsl
            && window.layersApp._renderer._currentDsl !== before, dslVisible)
            .then(() => page.evaluate(() => window.layersApp._renderer._currentDsl))
        expect(dslHidden).not.toBe(dslVisible)

        await page.click(`layer-item[data-layer-id="${topId}"] .layer-visibility`)
        await appState(page,
            (id) => window.layersApp._layers.find(l => l.id === id).visible === true,
            topId)
        const dslRestored = await page.waitForFunction((before) =>
            window.layersApp._renderer._currentDsl === before, dslVisible)
            .then(() => page.evaluate(() => window.layersApp._renderer._currentDsl))
        expect(dslRestored).toBe(dslVisible)
    })

    test('toggling one layer leaves every other row untouched', async ({ page }) => {
        const [bottomId, topId] = await page.evaluate(() =>
            [window.layersApp._layers[0].id, window.layersApp._layers[1].id])

        await page.evaluate((ids) => {
            for (const id of ids) {
                const item = document.querySelector(`layer-item[data-layer-id="${id}"]`)
                item.querySelector('.layer-blend-mode').dataset.probe = 'blend-' + id
                item.querySelector('.layer-name').dataset.probe = 'name-' + id
            }
        }, [bottomId, topId])

        await page.click(`layer-item[data-layer-id="${topId}"] .layer-visibility`)
        await appState(page,
            (id) => window.layersApp._layers.find(l => l.id === id).visible === false,
            topId)

        const probes = await page.evaluate((ids) => ids.map((id) => {
            const item = document.querySelector(`layer-item[data-layer-id="${id}"]`)
            return {
                blend: item.querySelector('.layer-blend-mode').dataset.probe,
                name: item.querySelector('.layer-name').dataset.probe,
            }
        }), [bottomId, topId])
        // The bottom row must be completely untouched by the other row's toggle.
        expect(probes[0].blend).toBe('blend-' + bottomId)
        expect(probes[0].name).toBe('name-' + bottomId)
        // The toggled row keeps its controls too (in-place patch).
        expect(probes[1].blend).toBe('blend-' + topId)
        expect(probes[1].name).toBe('name-' + topId)
    })

    test('an in-progress rename on another row is not stomped', async ({ page }) => {
        const [bottomId, topId] = await page.evaluate(() =>
            [window.layersApp._layers[0].id, window.layersApp._layers[1].id])

        const nameSelector = `layer-item[data-layer-id="${bottomId}"] .layer-name`
        await page.dblclick(nameSelector)
        await page.waitForFunction((id) => {
            const el = document.querySelector(
                `layer-item[data-layer-id="${id}"] .layer-name`)
            return el.isContentEditable && document.activeElement === el
        }, bottomId)
        await page.keyboard.insertText('Renamed below')

        // A property-only mutation on another row must not rebuild the panel
        // (which would end the edit and discard the draft).
        await page.evaluate((id) => window.layersApp._handleLayerChange({
            layerId: id, property: 'visibility', value: false, updateLayerStack: true,
        }), topId)
        await appState(page,
            (id) => window.layersApp._layers.find(l => l.id === id).visible === false,
            topId)

        const editing = await page.evaluate((id) => {
            const el = document.querySelector(`layer-item[data-layer-id="${id}"] .layer-name`)
            return {
                editable: el.isContentEditable,
                focused: document.activeElement === el,
                text: el.textContent,
            }
        }, bottomId)
        expect(editing.editable).toBe(true)
        expect(editing.focused).toBe(true)
        expect(editing.text).toBe('Renamed below')
    })

    test('rapid double toggle ends in the correct final state', async ({ page }) => {
        const topId = await page.evaluate(() => window.layersApp._layers[1].id)
        const selector = `layer-item[data-layer-id="${topId}"] .layer-visibility`

        await page.click(selector)
        await page.click(selector)

        await appState(page,
            (id) => window.layersApp._layers.find(l => l.id === id).visible === true,
            topId)
        const glyph = await page.evaluate((id) => document.querySelector(
            `layer-item[data-layer-id="${id}"] .layer-visibility .icon-material`).textContent.trim(), topId)
        expect(glyph).toBe('visibility')
    })

    test('child-effect visibility toggles in place', async ({ page }) => {
        const topId = await page.evaluate(() => window.layersApp._layers[1].id)
        await page.evaluate(async (id) => {
            await window.layersApp._handleAddChildEffect(id, 'filter/blur')
        }, topId)
        await appState(page,
            (id) => (window.layersApp._layers.find(l => l.id === id).children || []).length === 1,
            topId)

        const childId = await page.evaluate((id) =>
            window.layersApp._layers.find(l => l.id === id).children[0].id, topId)

        await page.evaluate((id) => {
            const item = document.querySelector(`layer-item[data-layer-id="${id}"]`)
            item.querySelector('.layer-visibility').dataset.probe = 'child-probe'
        }, childId)

        await page.click(`layer-item[data-layer-id="${childId}"] .layer-visibility`)
        await appState(page, (ids) => {
            const parent = window.layersApp._layers.find(l => l.id === ids.parentId)
            return parent.children.find(c => c.id === ids.childId).visible === false
        }, { parentId: topId, childId })

        const state = await page.evaluate((id) => {
            const btn = document.querySelector(
                `layer-item[data-layer-id="${id}"] .layer-visibility`)
            return {
                sameNode: btn.dataset.probe === 'child-probe',
                visibleClass: btn.classList.contains('visible'),
                glyph: btn.querySelector('.icon-material').textContent.trim(),
            }
        }, childId)
        expect(state.sameNode).toBe(true)
        expect(state.visibleClass).toBe(false)
        expect(state.glyph).toBe('visibility_off')
    })

    test('a rolled-back visibility commit repairs the optimistic icon', async ({ page }) => {
        const topId = await page.evaluate(() => window.layersApp._layers[1].id)
        const selector = `layer-item[data-layer-id="${topId}"] .layer-visibility`

        // Force the first _rebuild after the toggle to fail, driving
        // _commitModelMutation through its rollback path: the model is
        // restored, but the eye icon was already flipped optimistically in
        // the DOM — sync() must repair it from the restored model.
        await page.evaluate(() => {
            const app = window.layersApp
            const orig = app._rebuild.bind(app)
            let failed = false
            app._rebuild = (...args) => {
                if (!failed) {
                    failed = true
                    return Promise.resolve({ success: false, error: 'injected rebuild failure' })
                }
                return orig(...args)
            }
        })

        await page.click(selector)

        await appState(page,
            (id) => window.layersApp._layers.find(l => l.id === id).visible === true,
            topId)

        const state = await page.evaluate((id) => {
            const btn = document.querySelector(
                `layer-item[data-layer-id="${id}"] .layer-visibility`)
            return {
                visibleClass: btn.classList.contains('visible'),
                glyph: btn.querySelector('.icon-material').textContent.trim(),
            }
        }, topId)
        expect(state.visibleClass).toBe(true)
        expect(state.glyph).toBe('visibility')
    })

    test('structural changes still rebuild the affected rows', async ({ page }) => {
        const topId = await page.evaluate(() => window.layersApp._layers[1].id)

        // Add a third layer: a new row must appear in the right place.
        await page.evaluate(async () => {
            await window.layersApp._handleAddEffectLayer('synth/gradient')
        })
        await layerCount(page, 3)

        const order = await page.evaluate(() =>
            [...document.querySelectorAll('layer-item')]
                .map(item => item.dataset.layerId))
        const modelIds = await page.evaluate(() =>
            [...window.layersApp._layers].reverse().map(l => l.id))
        expect(order).toEqual(modelIds)

        // Deleting the top layer removes only that row, others stay intact.
        const toDeleteId = await page.evaluate(() => window.layersApp._layers[2].id)
        await page.evaluate(async (id) => {
            await window.layersApp._handleDeleteLayer(id)
        }, toDeleteId)
        await layerCount(page, 2)

        const after = await page.evaluate(() =>
            [...document.querySelectorAll('layer-item')].map(item => item.dataset.layerId))
        expect(after).not.toContain(toDeleteId)
        expect(after).toContain(topId)
        expect(after).toHaveLength(2)
    })
})
