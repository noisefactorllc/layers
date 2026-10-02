import { test, expect } from './fixtures.js'
import { PNG } from 'pngjs'

// Layer stack output-surface budget. _buildDsl() used to give every
// intermediate result a fresh output surface with no reuse, so any stack
// deeper than about four rendered layers emitted o8 and the Noisemaker lexer
// rejected the whole program ("Output surface reference 'o8' is out of
// range; expected o0-o7") — the stack stopped compositing with a "Failed to
// render" toast. _buildDsl now recycles surfaces whose contents are provably
// dead, so any stack the app lets a user build compiles within o0-o7.
//
// Acceptance (GAP-001, issue #7): eight stacked drawing layers with distinct
// strokes composite with every stroke visible in the pixels; a mixed stack of
// the same depth with text overlays, a layer mask and a child effect renders
// without an error toast; the emitted DSL never references a surface above o7.

const MAX_SURFACE = 7

// Collect every o<N> surface reference from the DSL text.
function surfaceRefs(dsl) {
    const refs = []
    for (const match of dsl.matchAll(/\bo(\d+)\b/g)) {
        refs.push(Number(match[1]))
    }
    return refs
}

async function newSmallProject(page) {
    await page.goto('/', { waitUntil: 'networkidle' })
    await page.waitForFunction(() => !!window.LayersAgent, null, { timeout: 15000 })
    await page.evaluate(async () => {
        await window.LayersAgent.ready
        const result = await window.LayersAgent.newProject({ width: 128, height: 128 })
        if (!result.ok) throw new Error(result.error?.message || 'Project creation failed')
    })
}

async function assertNoErrorToast(page) {
    const errors = await page.evaluate(() => {
        const container = document.querySelector('#toast-container')
        return container
            ? [...container.querySelectorAll('.toast')]
                .filter(el => el.classList.contains('toast-error'))
                .map(el => el.textContent.trim())
            : []
    })
    expect(errors, `no error toast expected, saw: ${errors.join(' | ')}`).toEqual([])
}

async function assertDslWithinBudget(page) {
    const dsl = await page.evaluate(() => window.layersApp._renderer._currentDsl)
    const refs = surfaceRefs(dsl)
    expect(refs.length, 'DSL must reference at least one output surface').toBeGreaterThan(0)
    expect(
        Math.max(...refs),
        `every output surface reference must stay within o0-o7; DSL:\n${dsl}`
    ).toBeLessThanOrEqual(MAX_SURFACE)
    return dsl
}

test('eight stacked drawing layers with distinct strokes composite fully', async ({ page }) => {
    await newSmallProject(page)

    const failures = await page.evaluate(async () => {
        const { createPathStroke } = await import('/js/drawing/stroke-model.js')
        const app = window.layersApp
        const colors = [
            '#ff0000', '#00ff00', '#0000ff', '#ffff00',
            '#ff00ff', '#00ffff', '#ff8000', '#8000ff',
        ]
        const errors = []
        for (let i = 0; i < colors.length; i++) {
            const added = await window.LayersAgent.addLayer({ kind: 'drawing' })
            if (!added.ok) {
                errors.push(`addLayer ${i}: ${added.error?.message || 'failed'}`)
                continue
            }
            const layerId = added.result.layerId
            const layer = app._layers.find(candidate => candidate.id === layerId)
            const stroke = createPathStroke({
                color: colors[i],
                size: 6,
                points: [{ x: 10 + i * 14, y: 20 }, { x: 10 + i * 14, y: 108 }],
            })
            const outcome = await app._commitDrawingStroke(stroke, layer)
            if (outcome.status !== 'committed') {
                errors.push(`stroke ${i}: ${outcome.error?.message || outcome.status}`)
            }
        }
        return errors
    })
    expect(failures, `every layer and stroke must commit: ${failures.join(' | ')}`).toEqual([])

    await assertNoErrorToast(page)
    await assertDslWithinBudget(page)

    // Pixel readback: export the composite and require every stroke color.
    const bytes = await page.evaluate(async () => {
        const exported = await window.LayersAgent.exportImage({ format: 'png', captureOnly: true })
        if (!exported.ok) throw new Error(exported.error?.message || 'Export failed')
        return exported.result.bytes
    })
    const exported = PNG.sync.read(Buffer.from(bytes, 'base64'))
    expect([exported.width, exported.height]).toEqual([128, 128])

    const strokeColors = [
        [255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 0],
        [255, 0, 255], [0, 255, 255], [255, 128, 0], [128, 0, 255],
    ]
    for (const [r, g, b] of strokeColors) {
        const found = exported.data.some((value, index) =>
            index % 4 === 0
            && Math.abs(exported.data[index] - r) <= 2
            && Math.abs(exported.data[index + 1] - g) <= 2
            && Math.abs(exported.data[index + 2] - b) <= 2)
        expect(found, `stroke color rgb(${r},${g},${b}) must appear in the composite`).toBe(true)
    }
})

test('a mixed eight-layer stack with text, a mask and a child effect renders', async ({ page }) => {
    await newSmallProject(page)

    const failures = await page.evaluate(async () => {
        const { createPathStroke } = await import('/js/drawing/stroke-model.js')
        const app = window.layersApp
        const errors = []

        const addDrawing = async (name, color, x) => {
            const added = await window.LayersAgent.addLayer({ kind: 'drawing', name })
            if (!added.ok) {
                errors.push(`addLayer ${name}: ${added.error?.message || 'failed'}`)
                return null
            }
            const layer = app._layers.find(candidate => candidate.id === added.result.layerId)
            const stroke = createPathStroke({
                color,
                size: 6,
                points: [{ x, y: 20 }, { x, y: 108 }],
            })
            const outcome = await app._commitDrawingStroke(stroke, layer)
            if (outcome.status !== 'committed') {
                errors.push(`stroke ${name}: ${outcome.error?.message || outcome.status}`)
            }
            return layer
        }

        const strokes = []
        strokes.push(await addDrawing('Stroke A', '#ff0000', 16))
        strokes.push(await addDrawing('Stroke B', '#00ff00', 44))

        // Two text overlays on top of the drawn strokes.
        for (const text of ['Alpha', 'Beta']) {
            const added = await window.LayersAgent.addLayer({ kind: 'text', text })
            if (!added.ok) errors.push(`text ${text}: ${added.error?.message || 'failed'}`)
        }

        strokes.push(await addDrawing('Stroke C', '#0000ff', 72))

        // A layer mask on Stroke C, and a child effect on Stroke B.
        const layerC = app._layers.find(candidate => candidate.name === 'Stroke C')
        if (layerC) {
            try {
                await app._addLayerMask(layerC.id, { enterEditMode: false })
            } catch (err) {
                errors.push(`mask: ${err.message || err}`)
            }
        }
        const layerB = app._layers.find(candidate => candidate.name === 'Stroke B')
        if (layerB) {
            const child = await window.LayersAgent.addChildEffect({ layerId: layerB.id, effectId: 'filter/blur' })
            if (!child.ok) errors.push(`child effect: ${child.error?.message || 'failed'}`)
        }

        strokes.push(await addDrawing('Stroke D', '#ffff00', 100))
        strokes.push(await addDrawing('Stroke E', '#00ffff', 28))
        strokes.push(await addDrawing('Stroke F', '#ff00ff', 58))
        return errors
    })
    expect(failures, `every mutation must commit: ${failures.join(' | ')}`).toEqual([])

    await assertNoErrorToast(page)

    const stack = await page.evaluate(() => ({
        dsl: window.layersApp._renderer._currentDsl,
        layers: window.layersApp._layers.map(layer => ({
            name: layer.name,
            visible: layer.visible,
            masked: !!(layer.mask && layer.maskEnabled !== false),
            children: (layer.children || []).filter(child => child.visible).length,
        })),
    }))
    expect(stack.dsl).toBeTruthy()
    expect(stack.layers.filter(layer => layer.visible).length).toBe(8)
    expect(stack.layers.some(layer => layer.masked)).toBe(true)
    expect(stack.layers.some(layer => layer.children > 0)).toBe(true)
    await assertDslWithinBudget(page)

    // Render-success signal: the composite must actually contain the strokes
    // of the layers the stack modification did not transform. (Stroke B is
    // blurred by its child effect and Stroke C passes through its mask, so
    // only the untouched strokes are asserted here.) A failed compile cannot
    // fake these: exportImage would return stale or empty pixels.
    const bytes = await page.evaluate(async () => {
        const exported = await window.LayersAgent.exportImage({ format: 'png', captureOnly: true })
        if (!exported.ok) throw new Error(exported.error?.message || 'Export failed')
        return exported.result.bytes
    })
    const exported = PNG.sync.read(Buffer.from(bytes, 'base64'))
    expect([exported.width, exported.height]).toEqual([128, 128])
    for (const [r, g, b] of [[255, 0, 0], [255, 255, 0], [0, 255, 255], [255, 0, 255]]) {
        const found = exported.data.some((value, index) =>
            index % 4 === 0
            && Math.abs(exported.data[index] - r) <= 2
            && Math.abs(exported.data[index + 1] - g) <= 2
            && Math.abs(exported.data[index + 2] - b) <= 2)
        expect(found, `stroke color rgb(${r},${g},${b}) must appear in the composite`).toBe(true)
    }
})
