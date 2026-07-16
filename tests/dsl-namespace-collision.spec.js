import { test, expect } from 'playwright/test'

// Short-name collision guard: DSL effect calls are unqualified short names
// resolved first-match-wins over the program's `search` order, and _buildDsl
// always lists `synth` first. The manifest has two colliding short names —
// `noise` (synth, classicNoisedeck) and `noise3d` (synth3d, classicNoisedeck) —
// so an unqualified `noise()` emitted for a classicNoisedeck/noise layer
// silently rendered synth/noise instead (wrong effect, no error anywhere).
//
// _buildEffectCall now wraps ambiguous short names in the DSL's
// `from(namespace, call)` qualifier, pinning resolution to the layer's own
// namespace. Non-colliding effects keep their unqualified form.

async function bootBlank(page) {
    await page.goto('/', { waitUntil: 'networkidle' })
    await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })
    await page.waitForSelector('.open-dialog-backdrop.visible')
    await page.click('.media-option[data-type="solid"]')
    await page.waitForSelector('.canvas-size-dialog', { timeout: 5000 })
    await page.click('.canvas-size-dialog .action-btn.primary')
    await page.waitForSelector('.open-dialog-backdrop.visible', { state: 'hidden', timeout: 5000 })
    await page.waitForTimeout(1500)
}

test('classicNoisedeck/noise layer renders its own effect, not synth/noise', async ({ page }) => {
    await bootBlank(page)

    const result = await page.evaluate(async () => {
        const app = window.layersApp
        const res = await app._handleAddEffectLayer('classicNoisedeck/noise')
        await app._rebuild({ force: true })
        const renderer = app._renderer
        const passes = renderer._renderer.pipeline?.graph?.passes || []
        return {
            status: res?.status,
            dsl: renderer._currentDsl,
            passEffectKeys: [...new Set(passes.map(p => p.effectKey).filter(Boolean))],
        }
    })

    expect(result.status).toBe('added')
    // The DSL pins the colliding short name to the layer's namespace...
    expect(result.dsl).toContain('from(classicNoisedeck, noise(')
    // ...and the compiled pipeline runs the layer's actual effect.
    expect(result.passEffectKeys).toContain('classicNoisedeck.noise')
    expect(result.passEffectKeys).not.toContain('synth.noise')
})

test('synth/noise pins to synth; non-colliding filters stay unqualified', async ({ page }) => {
    await bootBlank(page)

    const result = await page.evaluate(async () => {
        const app = window.layersApp
        await app._handleAddEffectLayer('synth/noise')
        await app._handleAddEffectLayer('filter/blur')
        await app._rebuild({ force: true })
        const renderer = app._renderer
        const passes = renderer._renderer.pipeline?.graph?.passes || []
        return {
            dsl: renderer._currentDsl,
            passEffectKeys: [...new Set(passes.map(p => p.effectKey).filter(Boolean))],
        }
    })

    // synth/noise is ambiguous too, so it gets pinned to synth explicitly.
    expect(result.dsl).toContain('from(synth, noise(')
    expect(result.passEffectKeys).toContain('synth.noise')
    expect(result.passEffectKeys).not.toContain('classicNoisedeck.noise')
    // Non-colliding effects keep the plain unqualified call.
    expect(result.dsl).toMatch(/\.blur\(/)
    expect(result.dsl).not.toContain('from(filter')
})

test('both noise variants coexist in one composition', async ({ page }) => {
    await bootBlank(page)

    const result = await page.evaluate(async () => {
        const app = window.layersApp
        await app._handleAddEffectLayer('synth/noise')
        await app._handleAddEffectLayer('classicNoisedeck/noise')
        await app._rebuild({ force: true })
        const renderer = app._renderer
        const passes = renderer._renderer.pipeline?.graph?.passes || []
        return {
            passEffectKeys: [...new Set(passes.map(p => p.effectKey).filter(Boolean))],
        }
    })

    // The whole point of per-call qualification: the same short name resolves
    // to different effects on different layers within one program.
    expect(result.passEffectKeys).toContain('synth.noise')
    expect(result.passEffectKeys).toContain('classicNoisedeck.noise')
})

test('mid-chain from(): child emission qualifies and the shape compiles', async ({ page }) => {
    await bootBlank(page)

    // Child effects emit as read(oN).call.write(oM) — the mid-chain from()
    // position, distinct from the chain-head shape the layer tests cover.
    //
    // Both of today's colliding short names are GENERATORS, which the engine
    // rejects mid-chain regardless of qualification (verified: unqualified
    // noise() fails there too) — so no ambiguous child can currently compile
    // end-to-end. Guard the two halves separately: (1) _buildChildChain wraps
    // an ambiguous child's call in from(); (2) the engine accepts the
    // mid-chain from() shape for a chainable (filter) effect.
    const result = await page.evaluate(async () => {
        const renderer = window.layersApp._renderer

        const lines = []
        renderer._buildChildChain({
            children: [{
                id: 'probe-child',
                visible: true,
                effectId: 'classicNoisedeck/noise',
                effectParams: {},
            }],
        }, 0, lines)

        const midChainCompile = await renderer.tryCompile(
            'search synth, filter\n\n' +
            'solid(color: #808080, alpha: 1).write(o0)\n\n' +
            'read(o0).from(filter, blur(radiusX: 4, radiusY: 4)).write(o1)\n\n' +
            'render(o1)')

        return { childLine: lines[0] || '', midChainCompile }
    })

    expect(result.childLine).toMatch(/^read\(o0\)\.from\(classicNoisedeck, noise\(\)\)\.write\(o1\)$/)
    expect(result.midChainCompile.success).toBe(true)
})

test('tripwire: the manifest collision set is exactly noise + noise3d', async ({ page }) => {
    await bootBlank(page)

    // The qualifier only wraps ambiguous short names, and several emission
    // paths (hardcoded solid/media/blendMode/alphaMask calls) rely on their
    // names being unambiguous. A NEW manifest collision extends the hazard to
    // paths this fix doesn't cover — fail loudly so it's a conscious decision.
    const colliding = await page.evaluate(() => {
        const manifest = window.layersApp._renderer.manifest || {}
        const counts = new Map()
        for (const id of Object.keys(manifest)) {
            const short = id.split('/')[1]
            if (!short) continue
            counts.set(short, (counts.get(short) || 0) + 1)
        }
        return [...counts.entries()].filter(([, n]) => n > 1).map(([s]) => s).sort()
    })
    expect(colliding).toEqual(['noise', 'noise3d'])
})
