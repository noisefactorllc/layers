import { test, expect } from 'playwright/test'

// Regression guard for effect-parameter dropdown controls (effect-params.js).
// Three distinct "dropdown does nothing" bugs are covered:
//
//  1. enabledBy: a param whose ui.enabledBy condition is not met is inert in
//     the shader (e.g. filter/halftone `pattern` only applies in mono mode,
//     mode===1; in the default color mode it does nothing). Its control must be
//     visibly disabled, and must re-evaluate when the dependency param changes.
//
//  2. numeric-choice coercion: a dropdown for a numeric param whose type is not
//     'int' (e.g. filter/historicPalette `rotation`, a float with choices
//     {none:0,fwd:1,back:-1}) must emit a Number, not the string "1" — a string
//     serializes to a broken triple-quoted DSL value the shader can't read.
//
//  3. member-enum population: a member-type param declared with a dropdown but
//     no explicit `choices` (e.g. filter/palette `index`, a 50+ member enum)
//     must populate its options from the declared enum, not render empty.

async function loadWithSolidBase(page) {
    await page.goto('/', { waitUntil: 'networkidle' })
    await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })
    await page.waitForSelector('.open-dialog-backdrop.visible')
    await page.click('.media-option[data-type="solid"]')
    await page.waitForSelector('.canvas-size-dialog', { timeout: 5000 })
    await page.click('.canvas-size-dialog .action-btn.primary')
    await page.waitForSelector('.open-dialog-backdrop.visible', { state: 'hidden', timeout: 5000 })
    await page.waitForTimeout(1500)
}

// Read the disabled state of a control group by param key, from the
// effect-params element bound to the given layer.
async function groupDisabled(page, layerId, paramKey) {
    return page.evaluate(({ layerId, paramKey }) => {
        const ep = [...document.querySelectorAll('effect-params')].find(e => e._layerId === layerId)
        if (!ep) return { found: false }
        const group = [...ep.querySelectorAll('.control-group')].find(g => g.dataset.paramKey === paramKey)
        if (!group) return { found: false, keys: [...ep.querySelectorAll('.control-group')].map(g => g.dataset.paramKey) }
        return { found: true, disabled: group.classList.contains('disabled') }
    }, { layerId, paramKey })
}

// Drive a real dropdown (select-dropdown) inside the layer's effect-params,
// exactly as handfish's _selectOption does on a user click: set value, then
// dispatch a bubbling change event.
async function driveDropdown(page, layerId, paramKey, value) {
    return page.evaluate(({ layerId, paramKey, value }) => {
        const ep = [...document.querySelectorAll('effect-params')].find(e => e._layerId === layerId)
        if (!ep) return { ok: false, reason: 'no effect-params' }
        const group = [...ep.querySelectorAll('.control-group')].find(g => g.dataset.paramKey === paramKey)
        if (!group) return { ok: false, reason: 'no group ' + paramKey }
        const dd = group.children[1]
        if (dd?.tagName?.toLowerCase() !== 'select-dropdown') return { ok: false, reason: 'not a dropdown: ' + dd?.tagName }
        dd.value = String(value)
        dd.dispatchEvent(new Event('change', { bubbles: true }))
        return { ok: true }
    }, { layerId, paramKey, value })
}

test('enabledBy greys out an inert control and re-evaluates when its dependency changes', async ({ page }) => {
    await loadWithSolidBase(page)

    const layerId = await page.evaluate(async () => {
        const app = window.layersApp
        await app._handleAddEffectLayer('synth/noise')
        await app._handleAddEffectLayer('filter/halftone', { params: { mode: 0, pattern: 0, frequency: 20 } })
        await app._rebuild({ force: true })
        return app._layers[app._layers.length - 1].id
    })
    await page.waitForTimeout(800)

    // Default color mode (mode 0): `pattern` (enabledBy mode===1) is inert and
    // must be disabled; `cyanAngle` (enabledBy mode===0) is active.
    expect(await groupDisabled(page, layerId, 'pattern')).toEqual({ found: true, disabled: true })
    expect(await groupDisabled(page, layerId, 'cyanAngle')).toEqual({ found: true, disabled: false })

    // Switch to mono mode via the real mode dropdown; the states must flip.
    expect((await driveDropdown(page, layerId, 'mode', 1)).ok).toBe(true)
    await page.waitForTimeout(400)

    expect(await groupDisabled(page, layerId, 'pattern')).toEqual({ found: true, disabled: false })
    expect(await groupDisabled(page, layerId, 'cyanAngle')).toEqual({ found: true, disabled: true })
})

test('a numeric (float) choice dropdown emits a Number, serialized as a bare DSL value', async ({ page }) => {
    await loadWithSolidBase(page)

    const layerId = await page.evaluate(async () => {
        const app = window.layersApp
        await app._handleAddEffectLayer('synth/noise')
        await app._handleAddEffectLayer('filter/historicPalette', { params: { index: 5, rotation: 0 } })
        await app._rebuild({ force: true })
        return app._layers[app._layers.length - 1].id
    })
    await page.waitForTimeout(800)

    expect((await driveDropdown(page, layerId, 'rotation', 1)).ok).toBe(true)
    await page.waitForTimeout(500)

    const result = await page.evaluate((layerId) => {
        const app = window.layersApp
        const layer = app._layers.find(l => l.id === layerId)
        const dslLine = app._renderer.currentDsl.split('\n').find(l => l.includes('historicPalette')) || ''
        return { rotation: layer.effectParams.rotation, rotationType: typeof layer.effectParams.rotation, dslLine }
    }, layerId)

    expect(result.rotationType).toBe('number')
    expect(result.rotation).toBe(1)
    // Emitted bare as the number 1 (not "1.5"/"10", not a triple-quoted string).
    expect(result.dslLine).toMatch(/rotation: 1(?![.\d])/)
    expect(result.dslLine).not.toContain('rotation: """')
})

test('a member-enum dropdown with no explicit choices is populated and emits a bare identifier', async ({ page }) => {
    await loadWithSolidBase(page)

    const layerId = await page.evaluate(async () => {
        const app = window.layersApp
        await app._handleAddEffectLayer('synth/noise')
        await app._handleAddEffectLayer('filter/palette')
        await app._rebuild({ force: true })
        return app._layers[app._layers.length - 1].id
    })
    await page.waitForTimeout(800)

    // The index dropdown must have real options (the palette.* enum members).
    const opts = await page.evaluate((layerId) => {
        const ep = [...document.querySelectorAll('effect-params')].find(e => e._layerId === layerId)
        const group = [...ep.querySelectorAll('.control-group')].find(g => g.dataset.paramKey === 'index')
        const dd = group?.children[1]
        return { tag: dd?.tagName?.toLowerCase(), options: dd?.getOptions?.() ?? [] }
    }, layerId)
    expect(opts.tag).toBe('select-dropdown')
    expect(opts.options.length).toBeGreaterThan(5)

    // Selecting a member emits the fully-qualified identifier, serialized bare.
    const target = opts.options.find(o => o.value.endsWith('.vaporwave')) || opts.options[3]
    expect((await driveDropdown(page, layerId, 'index', target.value)).ok).toBe(true)
    await page.waitForTimeout(500)

    const result = await page.evaluate((layerId) => {
        const app = window.layersApp
        const layer = app._layers.find(l => l.id === layerId)
        const dslLine = app._renderer.currentDsl.split('\n').find(l => l.includes('palette(')) || ''
        return { index: layer.effectParams.index, dslLine }
    }, layerId)

    expect(result.index).toMatch(/^palette\.[A-Za-z]/)
    // Emitted bare, and as a whole identifier (not a prefix of a longer member
    // like palette.sherbet vs palette.sherbetDouble), never triple-quoted.
    const idPattern = new RegExp(`index: ${result.index.replace(/\./g, '\\.')}(?![\\w.])`)
    expect(result.dslLine).toMatch(idPattern)
    expect(result.dslLine).not.toContain('index: """')
})

// Direct coverage of the enabledBy predicate for every operator form the effect
// manifests use (real effects use gt/neq/in/notIn/and/or/truthy, not just the
// eq form the halftone test above exercises). This gates dozens of controls, so
// a typo in any branch would silently mis-grey controls across many effects.
test('enabledBy evaluator handles every operator + default-fallback form', async ({ page }) => {
    await loadWithSolidBase(page)

    const r = await page.evaluate(() => {
        const ep = document.createElement('effect-params')
        const G = { a: { default: 1 }, m: { default: 5 } }   // globals with defaults
        const ev = (cond, params) => ep._evalEnabledBy(cond, params, G)
        return {
            nullAlwaysEnabled: ev(null, {}),
            stringTruthy: [ev('a', { a: 1 }), ev('a', { a: 0 })],
            stringFallsBackToDefault: ev('a', {}),                       // default 1 → truthy
            eq: [ev({ param: 'm', eq: 1 }, { m: 1 }), ev({ param: 'm', eq: 1 }, { m: 0 })],
            eqZeroOperand: ev({ param: 'm', eq: 0 }, { m: 0 }),          // falsy operand still compares
            neq: [ev({ param: 'm', neq: 1 }, { m: 0 }), ev({ param: 'm', neq: 1 }, { m: 1 })],
            gt: [ev({ param: 'k', gt: 2 }, { k: 3 }), ev({ param: 'k', gt: 2 }, { k: 2 })],
            gte: [ev({ param: 'k', gte: 2 }, { k: 2 }), ev({ param: 'k', gte: 2 }, { k: 1 })],
            lt: [ev({ param: 'k', lt: 2 }, { k: 1 }), ev({ param: 'k', lt: 2 }, { k: 2 })],
            lte: [ev({ param: 'k', lte: 2 }, { k: 2 }), ev({ param: 'k', lte: 2 }, { k: 3 })],
            inOp: [ev({ param: 'k', in: [1, 2] }, { k: 2 }), ev({ param: 'k', in: [1, 2] }, { k: 3 })],
            notIn: [ev({ param: 'k', notIn: [2] }, { k: 3 }), ev({ param: 'k', notIn: [2] }, { k: 2 })],
            and: [
                ev({ and: [{ param: 'm', eq: 1 }, { param: 'p', eq: 0 }] }, { m: 1, p: 0 }),
                ev({ and: [{ param: 'm', eq: 1 }, { param: 'p', eq: 0 }] }, { m: 1, p: 1 }),
            ],
            or: [
                ev({ or: [{ param: 'm', eq: 1 }, { param: 'p', eq: 0 }] }, { m: 0, p: 0 }),
                ev({ or: [{ param: 'm', eq: 1 }, { param: 'p', eq: 0 }] }, { m: 0, p: 1 }),
            ],
            operandFallsBackToDefault: ev({ param: 'm', eq: 5 }, {}),    // default 5 → true
        }
    })

    expect(r.nullAlwaysEnabled).toBe(true)
    expect(r.stringTruthy).toEqual([true, false])
    expect(r.stringFallsBackToDefault).toBe(true)
    expect(r.eq).toEqual([true, false])
    expect(r.eqZeroOperand).toBe(true)
    expect(r.neq).toEqual([true, false])
    expect(r.gt).toEqual([true, false])
    expect(r.gte).toEqual([true, false])
    expect(r.lt).toEqual([true, false])
    expect(r.lte).toEqual([true, false])
    expect(r.inOp).toEqual([true, false])
    expect(r.notIn).toEqual([true, false])
    expect(r.and).toEqual([true, false])
    expect(r.or).toEqual([true, false])
    expect(r.operandFallsBackToDefault).toBe(true)
})
