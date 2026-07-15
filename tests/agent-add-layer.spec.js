import { test, expect } from 'playwright/test'

async function bootApp(page) {
    await page.goto('/', { waitUntil: 'networkidle' })
    await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })
    await page.evaluate(async () => { await window.LayersAgent.ready })
    const visible = await page.evaluate(() => !!document.querySelector('.open-dialog-backdrop.visible'))
    if (visible) {
        await page.click('.media-option[data-type="solid"]')
        await page.waitForSelector('.canvas-size-dialog', { timeout: 5000 })
        await page.click('.canvas-size-dialog .action-btn.primary')
        await page.waitForSelector('.open-dialog-backdrop.visible', { state: 'hidden', timeout: 5000 })
    }
}

test.describe('LayersAgent.addLayer — effect kind', () => {
    test('adds an effect layer and returns its id', async ({ page }) => {
        await bootApp(page)
        const before = await page.evaluate(() => window.layersApp._layers.length)
        const env = await page.evaluate(() =>
            window.LayersAgent.addLayer({ kind: 'effect', effectId: 'synth/gradient' })
        )
        expect(env.ok).toBe(true)
        expect(env.result.layerId).toMatch(/^layer-/)
        const after = await page.evaluate(() => window.layersApp._layers.length)
        expect(after).toBe(before + 1)
        const stateLast = env.state.layers[env.state.layers.length - 1]
        expect(stateLast.id).toBe(env.result.layerId)
        expect(stateLast.sourceType).toBe('effect')
        expect(stateLast.effect.id).toBe('synth/gradient')
        expect(stateLast.effect.params).toEqual({ type: 2 })
    })

    test('addLayer returns NOT_FOUND_EFFECT for unknown effectId', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() =>
            window.LayersAgent.addLayer({ kind: 'effect', effectId: 'filter/totallyMadeUp' })
        )
        expect(env.ok).toBe(false)
        expect(env.error.code).toBe('NOT_FOUND_EFFECT')
    })

    test('addLayer effect with params applies them after creation', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() =>
            window.LayersAgent.addLayer({
                kind: 'effect',
                effectId: 'synth/solid',
                params: { color: [1, 0, 0] }
            })
        )
        expect(env.ok).toBe(true)
        const layer = env.state.layers.find(l => l.id === env.result.layerId)
        expect(layer.effect.params.color).toEqual([1, 0, 0])
    })

    test('named effect params are one undo step and survive redo', async ({ page }) => {
        await bootApp(page)
        const result = await page.evaluate(async () => {
            const app = window.layersApp
            const beforeCount = app._layers.length
            const added = await window.LayersAgent.addLayer({
                kind: 'effect',
                effectId: 'synth/gradient',
                name: 'Agent Gradient',
                params: { type: 3 },
            })
            const layerId = added.result.layerId
            await window.LayersAgent.undo()
            const countAfterUndo = app._layers.length
            await window.LayersAgent.redo()
            const redone = app._layers.find(layer => layer.id === layerId)
            return {
                added,
                beforeCount,
                countAfterUndo,
                redone: redone && {
                    name: redone.name,
                    effectParams: redone.effectParams,
                },
            }
        })

        expect(result.added.ok).toBe(true)
        expect(result.countAfterUndo).toBe(result.beforeCount)
        expect(result.redone.name).toBe('Agent Gradient')
        expect(result.redone.effectParams.type).toBe(3)
    })

    test('addLayer rejects missing required kind', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() => window.LayersAgent.addLayer({}))
        expect(env.ok).toBe(false)
        expect(env.error.code).toBe('INVALID_ARGS_REQUIRED')
        expect(env.error.details.field).toBe('kind')
    })

    test('addLayer rejects unknown kind enum', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() => window.LayersAgent.addLayer({ kind: 'silly' }))
        expect(env.ok).toBe(false)
        expect(env.error.code).toBe('INVALID_ARGS_ENUM')
    })
})

test.describe('LayersAgent.addLayer — drawing kind', () => {
    test('adds an empty drawing layer', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() =>
            window.LayersAgent.addLayer({ kind: 'drawing' })
        )
        expect(env.ok).toBe(true)
        expect(env.result.layerId).toMatch(/^layer-/)
        const layer = env.state.layers.find(l => l.id === env.result.layerId)
        expect(layer.sourceType).toBe('drawing')
        expect(layer.drawing).toMatchObject({ strokeCount: 0 })
    })

    test('addLayer drawing accepts an optional name', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() =>
            window.LayersAgent.addLayer({ kind: 'drawing', name: 'Sketch 1' })
        )
        expect(env.ok).toBe(true)
        const layer = env.state.layers.find(l => l.id === env.result.layerId)
        expect(layer.name).toBe('Sketch 1')
    })
})

test.describe('LayersAgent.addLayer — media kind', () => {
    // 1x1 transparent PNG, base64 encoded
    const TINY_PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='

    test('adds a media layer from base64 source', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate((data) =>
            window.LayersAgent.addLayer({
                kind: 'media',
                mediaType: 'image',
                name: 'tiny.png',
                source: { kind: 'base64', data, mimeType: 'image/png' }
            }),
            TINY_PNG_B64
        )
        expect(env.ok).toBe(true)
        expect(env.result.layerId).toMatch(/^layer-/)
        const layer = env.state.layers.find(l => l.id === env.result.layerId)
        expect(layer.sourceType).toBe('media')
        expect(layer.media.type).toBe('image')
        expect(layer.media.filename).toBe('tiny.png')
    })

    test('named media layer survives undo and redo exactly', async ({ page }) => {
        await bootApp(page)
        const result = await page.evaluate(async (data) => {
            const app = window.layersApp
            const beforeCount = app._layers.length
            const added = await window.LayersAgent.addLayer({
                kind: 'media',
                mediaType: 'image',
                name: 'Agent Media.png',
                source: { kind: 'base64', data, mimeType: 'image/png' },
            })
            const layerId = added.result.layerId
            await window.LayersAgent.undo()
            const countAfterUndo = app._layers.length
            await window.LayersAgent.redo()
            const redone = app._layers.find(layer => layer.id === layerId)
            return {
                added,
                beforeCount,
                countAfterUndo,
                redoneName: redone?.name || null,
            }
        }, TINY_PNG_B64)

        expect(result.added.ok).toBe(true)
        expect(result.countAfterUndo).toBe(result.beforeCount)
        expect(result.redoneName).toBe('Agent Media.png')
    })

    test('decode failure returns RESOURCE_DECODE_FAILED without a ghost layer', async ({ page }) => {
        await bootApp(page)
        const result = await page.evaluate(async (data) => {
            const app = window.layersApp
            const beforeIds = app._layers.map(layer => layer.id)
            app._renderer.prepareMediaResource = async () => {
                throw new Error('corrupt image')
            }
            const envelope = await window.LayersAgent.addLayer({
                kind: 'media',
                mediaType: 'image',
                name: 'corrupt.png',
                source: { kind: 'base64', data, mimeType: 'image/png' }
            })
            return {
                envelope,
                beforeIds,
                afterIds: app._layers.map(layer => layer.id),
            }
        }, TINY_PNG_B64)

        expect(result.envelope.ok).toBe(false)
        expect(result.envelope.error.code).toBe('RESOURCE_DECODE_FAILED')
        expect(result.afterIds).toEqual(result.beforeIds)
    })

    test('an online transition during source fetch blocks media without false success', async ({ page }) => {
        await bootApp(page)
        const result = await page.evaluate(async () => {
            const app = window.layersApp
            const originalFetch = window.fetch.bind(window)
            let online = false
            let fetchStarted = false
            let releaseFetch
            app._onlineAdapter = {
                isOnline: () => online,
                schedulePublish: () => {},
            }
            window.fetch = async (input, options) => {
                if (input === 'https://layers.test/delayed-online.png') {
                    fetchStarted = true
                    await new Promise(resolve => { releaseFetch = resolve })
                    return originalFetch('/img/og-image.png')
                }
                return originalFetch(input, options)
            }
            const beforeIds = app._layers.map(layer => layer.id)
            const promise = window.LayersAgent.addLayer({
                kind: 'media',
                mediaType: 'image',
                name: 'delayed-online.png',
                source: { kind: 'url', value: 'https://layers.test/delayed-online.png' }
            })
            while (!fetchStarted) await new Promise(resolve => setTimeout(resolve, 0))
            online = true
            releaseFetch()
            const envelope = await promise
            window.fetch = originalFetch
            return {
                envelope,
                beforeIds,
                afterIds: app._layers.map(layer => layer.id),
            }
        })

        expect(result.envelope.ok).toBe(false)
        expect(result.envelope.error.code).toBe('CONFLICT_MEDIA_BLOCKED_ONLINE')
        expect(result.afterIds).toEqual(result.beforeIds)
    })

    test('addLayer media rejects missing source', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() =>
            window.LayersAgent.addLayer({ kind: 'media', mediaType: 'image' })
        )
        expect(env.ok).toBe(false)
        expect(env.error.code).toBe('INVALID_ARGS_REQUIRED')
        expect(env.error.details.field).toBe('source')
    })

    test('addLayer media rejects missing mediaType', async ({ page }, testInfo) => {
        await bootApp(page)
        const env = await page.evaluate((data) =>
            window.LayersAgent.addLayer({
                kind: 'media',
                source: { kind: 'base64', data, mimeType: 'image/png' }
            }),
            'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='
        )
        expect(env.ok).toBe(false)
        expect(env.error.code).toBe('INVALID_ARGS_REQUIRED')
        expect(env.error.details.field).toBe('mediaType')
    })

    test('addLayer media rejects unsupported source.kind', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() =>
            window.LayersAgent.addLayer({
                kind: 'media',
                mediaType: 'image',
                source: { kind: 'unsupported', value: 'whatever' }
            })
        )
        expect(env.ok).toBe(false)
        expect(env.error.code).toBe('INVALID_ARGS_ENUM')
        expect(env.error.details.field).toBe('source.kind')
    })
})

test.describe('LayersAgent.addLayer — text kind', () => {
    test('adds a text layer with text param set', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() =>
            window.LayersAgent.addLayer({ kind: 'text', text: 'Hello' })
        )
        expect(env.ok).toBe(true)
        const layer = env.state.layers.find(l => l.id === env.result.layerId)
        expect(layer.sourceType).toBe('effect')
        expect(layer.effect.id).toBe('filter/text')
        expect(layer.effect.params.text).toBe('Hello')
    })

    test('addLayer text rejects missing text field', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() =>
            window.LayersAgent.addLayer({ kind: 'text' })
        )
        expect(env.ok).toBe(false)
        expect(env.error.code).toBe('INVALID_ARGS_REQUIRED')
        expect(env.error.details.field).toBe('text')
    })

    test('text param with embedded quotes compiles (regression: triple-quoted DSL emission)', async ({ page }) => {
        await bootApp(page)
        // Font stack with internal double quotes used to break the DSL parser:
        //   font: "Impact, "Arial Black", ..."
        // ...because renderer emitted "${value}" without escaping. Triple-quoted
        // strings preserve internal quotes verbatim.
        const env = await page.evaluate(() =>
            window.LayersAgent.addLayer({
                kind: 'text',
                text: 'STACKED',
                params: { font: 'Impact, "Arial Black", "Helvetica Neue Bold", sans-serif' }
            })
        )
        expect(env.ok).toBe(true)
        const layer = env.state.layers.find(l => l.id === env.result.layerId)
        expect(layer.effect.params.font).toContain('"Arial Black"')

        // The render pipeline must have actually compiled (not silently fallen
        // back to the previous compiled program). Adding a second text layer
        // and verifying it compiles too proves stacking still works.
        const env2 = await page.evaluate(() =>
            window.LayersAgent.addLayer({
                kind: 'text',
                text: 'AGAIN',
                params: { font: '"Helvetica Neue", sans-serif' }
            })
        )
        expect(env2.ok).toBe(true)
        expect(env2.state.layers.length).toBe(env.state.layers.length + 1)
    })

    test('text param with embedded newlines compiles', async ({ page }) => {
        await bootApp(page)
        // Multi-line text used to emit unterminated string literals in DSL.
        const env = await page.evaluate(() =>
            window.LayersAgent.addLayer({
                kind: 'text',
                text: 'LINE ONE\nLINE TWO'
            })
        )
        expect(env.ok).toBe(true)
        const layer = env.state.layers.find(l => l.id === env.result.layerId)
        expect(layer.effect.params.text).toContain('\n')
    })

    test('text param containing """ is rejected at the agent layer', async ({ page }) => {
        await bootApp(page)
        // The renderer emits text/font/justify inside `"""..."""` triple-quoted
        // DSL literals (no escapes inside). A value that itself contains `"""`
        // would close the literal mid-stream and corrupt emission, so the
        // agent rejects it cleanly before touching state. Renderer-side warn
        // remains as belt-and-suspenders, but the agent layer is the gate.
        const env = await page.evaluate(() =>
            window.LayersAgent.addLayer({
                kind: 'text',
                text: 'a"""b'   // three consecutive double quotes mid-string
            })
        )
        expect(env.ok).toBe(false)
        expect(env.error.code).toBe('INVALID_ARGS_TYPE')
        expect(env.error.details.field).toBe('text')
    })

    test('triple-quote rejection also fires for embedded params', async ({ page }) => {
        await bootApp(page)
        // Same rule, but via the params route (font, justify, etc.) rather
        // than `text`. Field path should pinpoint the offending key.
        const env = await page.evaluate(() =>
            window.LayersAgent.addLayer({
                kind: 'text',
                text: 'ok',
                params: { font: 'evil"""font' }
            })
        )
        expect(env.ok).toBe(false)
        expect(env.error.code).toBe('INVALID_ARGS_TYPE')
        expect(env.error.details.field).toBe('params.font')
    })
})
