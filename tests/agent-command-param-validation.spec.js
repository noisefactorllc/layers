import { test, expect } from 'playwright/test'

async function bootApp(page) {
    await page.goto('/', { waitUntil: 'networkidle' })
    await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })
    await page.evaluate(async () => { await window.LayersAgent.ready })
    const visible = await page.evaluate(() =>
        !!document.querySelector('.open-dialog-backdrop.visible'))
    if (visible) {
        await page.click('.media-option[data-type="solid"]')
        await page.waitForSelector('.canvas-size-dialog', { timeout: 5000 })
        await page.click('.canvas-size-dialog .action-btn.primary')
        await page.waitForSelector('.open-dialog-backdrop.visible', {
            state: 'hidden', timeout: 5000,
        })
    }
}

function expectRejectedWithoutMutation(result, code, field) {
    expect(result.envelope.ok).toBe(false)
    expect(result.envelope.error.code).toBe(code)
    expect(result.envelope.error.details.field).toBe(field)
    expect(result.modelAfter).toBe(result.modelBefore)
    expect(result.dslAfter).toBe(result.dslBefore)
}

test.describe('agent effect parameter command boundary', () => {
    test('addEffectLayer rejects unsafe parameter identifiers without mutation', async ({ page }) => {
        await bootApp(page)
        const result = await page.evaluate(async () => {
            const app = window.layersApp
            const modelBefore = JSON.stringify(app._layers)
            const dslBefore = app._renderer.currentDsl
            const envelope = await window.LayersAgent.addLayer({
                kind: 'effect',
                effectId: 'synth/solid',
                params: { 'alpha).write(o9)': 1 },
            })
            return {
                envelope,
                modelBefore,
                dslBefore,
                modelAfter: JSON.stringify(app._layers),
                dslAfter: app._renderer.currentDsl,
            }
        })

        expectRejectedWithoutMutation(result, 'INVALID_ARGS_TYPE',
            'params.alpha).write(o9)')
    })

    test('addEffectLayer rejects inherited manifest names without mutation', async ({ page }) => {
        await bootApp(page)
        const result = await page.evaluate(async () => {
            const app = window.layersApp
            const modelBefore = JSON.stringify(app._layers)
            const dslBefore = app._renderer.currentDsl
            const envelope = await window.LayersAgent.addLayer({
                kind: 'effect',
                effectId: 'toString',
            })
            return {
                envelope,
                modelBefore,
                dslBefore,
                modelAfter: JSON.stringify(app._layers),
                dslAfter: app._renderer.currentDsl,
            }
        })

        expect(result.envelope.ok).toBe(false)
        expect(result.envelope.error.code).toBe('NOT_FOUND_EFFECT')
        expect(result.modelAfter).toBe(result.modelBefore)
        expect(result.dslAfter).toBe(result.dslBefore)
    })

    test('addChildEffect rejects inherited manifest names without mutation', async ({ page }) => {
        await bootApp(page)
        const result = await page.evaluate(async () => {
            const app = window.layersApp
            const layerId = app._layers[0].id
            const modelBefore = JSON.stringify(app._layers)
            const dslBefore = app._renderer.currentDsl
            const envelope = await window.LayersAgent.addChildEffect({
                layerId,
                effectId: 'constructor',
            })
            return {
                envelope,
                modelBefore,
                dslBefore,
                modelAfter: JSON.stringify(app._layers),
                dslAfter: app._renderer.currentDsl,
            }
        })

        expect(result.envelope.ok).toBe(false)
        expect(result.envelope.error.code).toBe('NOT_FOUND_EFFECT')
        expect(result.modelAfter).toBe(result.modelBefore)
        expect(result.dslAfter).toBe(result.dslBefore)
    })

    test('addTextLayer recursively rejects nested triple quotes without mutation', async ({ page }) => {
        await bootApp(page)
        const result = await page.evaluate(async () => {
            const app = window.layersApp
            const modelBefore = JSON.stringify(app._layers)
            const dslBefore = app._renderer.currentDsl
            const envelope = await window.LayersAgent.addLayer({
                kind: 'text',
                text: 'safe',
                params: { font: { fallbacks: ['safe', 'unsafe"""font'] } },
            })
            return {
                envelope,
                modelBefore,
                dslBefore,
                modelAfter: JSON.stringify(app._layers),
                dslAfter: app._renderer.currentDsl,
            }
        })

        expectRejectedWithoutMutation(result, 'INVALID_ARGS_TYPE',
            'params.font.fallbacks[1]')
    })

    test('setLayerEffectParams rejects undeclared parameter names without mutation', async ({ page }) => {
        await bootApp(page)
        const result = await page.evaluate(async () => {
            const app = window.layersApp
            const layerId = app._layers[0].id
            const modelBefore = JSON.stringify(app._layers)
            const dslBefore = app._renderer.currentDsl
            const envelope = await window.LayersAgent.setLayerEffectParams({
                layerId,
                params: { unexpected: 1 },
            })
            return {
                envelope,
                modelBefore,
                dslBefore,
                modelAfter: JSON.stringify(app._layers),
                dslAfter: app._renderer.currentDsl,
            }
        })

        expectRejectedWithoutMutation(result, 'INVALID_ARGS_UNKNOWN',
            'params.unexpected')
    })

    test('setLayerEffectParams rejects inherited validator names without mutation', async ({ page }) => {
        await bootApp(page)
        const result = await page.evaluate(async () => {
            const app = window.layersApp
            const added = await window.LayersAgent.addLayer({
                kind: 'effect',
                effectId: 'synth/gradient',
                params: { type: 2 },
            })
            const layerId = added.result.layerId
            const modelBefore = JSON.stringify(app._layers)
            const dslBefore = app._renderer.currentDsl
            const envelope = await window.LayersAgent.setLayerEffectParams({
                layerId,
                params: JSON.parse('{"__proto__":1}'),
            })
            return {
                envelope,
                modelBefore,
                dslBefore,
                modelAfter: JSON.stringify(app._layers),
                dslAfter: app._renderer.currentDsl,
            }
        })

        expectRejectedWithoutMutation(result, 'INVALID_ARGS_UNKNOWN',
            'params.__proto__')
    })

    test('addEffectLayer rejects malformed colors without mutation', async ({ page }) => {
        await bootApp(page)
        const result = await page.evaluate(async () => {
            const app = window.layersApp
            const modelBefore = JSON.stringify(app._layers)
            const dslBefore = app._renderer.currentDsl
            const envelope = await window.LayersAgent.addLayer({
                kind: 'effect',
                effectId: 'synth/solid',
                params: { color: '#not-a-color' },
            })
            return {
                envelope,
                modelBefore,
                dslBefore,
                modelAfter: JSON.stringify(app._layers),
                dslAfter: app._renderer.currentDsl,
            }
        })

        expectRejectedWithoutMutation(result, 'INVALID_ARGS_TYPE', 'params.color')
    })

    for (const operation of ['add', 'update']) {
        test(`${operation} rejects string colors for the base solid layer without mutation`, async ({ page }) => {
            await page.goto('/', { waitUntil: 'networkidle' })
            await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })
            await page.evaluate(async () => { await window.LayersAgent.ready })
            if (operation === 'update') {
                await page.click('.media-option[data-type="solid"]')
                await page.waitForSelector('.canvas-size-dialog', { timeout: 5000 })
                await page.click('.canvas-size-dialog .action-btn.primary')
                await page.waitForSelector('.open-dialog-backdrop.visible', {
                    state: 'hidden', timeout: 5000,
                })
            }
            const result = await page.evaluate(async ({ operation }) => {
                const app = window.layersApp
                const modelBefore = JSON.stringify(app._layers)
                const dslBefore = app._renderer.currentDsl
                const envelope = operation === 'add'
                    ? await window.LayersAgent.addLayer({
                        kind: 'effect',
                        effectId: 'synth/solid',
                        params: { color: '#ff0000', alpha: 1 },
                    })
                    : await window.LayersAgent.setLayerEffectParams({
                        layerId: app._layers[0].id,
                        params: { color: '#ff0000' },
                    })
                return {
                    envelope,
                    modelBefore,
                    dslBefore,
                    modelAfter: JSON.stringify(app._layers),
                    dslAfter: app._renderer.currentDsl,
                }
            }, { operation })

            expectRejectedWithoutMutation(result, 'INVALID_ARGS_TYPE', 'params.color')
        })
    }

    for (const [label, field, value] of [
        ['shorthand color', 'color', '#f00'],
        ['alpha matte color', 'matteColor', '#00ff0080'],
        ['RGBA array', 'color', [1, 0, 0, 0.5]],
    ]) {
        test(`text rejects unsupported ${label} syntax without mutation`, async ({ page }) => {
            await bootApp(page)
            const result = await page.evaluate(async ({ field, value }) => {
                const app = window.layersApp
                const modelBefore = JSON.stringify(app._layers)
                const dslBefore = app._renderer.currentDsl
                const envelope = await window.LayersAgent.addLayer({
                    kind: 'text',
                    text: 'Color',
                    params: { [field]: value },
                })
                return {
                    envelope,
                    modelBefore,
                    dslBefore,
                    modelAfter: JSON.stringify(app._layers),
                    dslAfter: app._renderer.currentDsl,
                }
            }, { field, value })

            expectRejectedWithoutMutation(result, 'INVALID_ARGS_TYPE', `params.${field}`)
        })
    }

    test('six-digit text and matte colors rasterize with their declared RGB values', async ({ page }) => {
        await bootApp(page)
        const result = await page.evaluate(async () => {
            const envelope = await window.LayersAgent.addLayer({
                kind: 'text',
                text: 'M',
                params: {
                    size: 0.5,
                    color: '#ff0000',
                    matteColor: '#00ff00',
                    matteOpacity: 1,
                },
            })
            if (!envelope.ok) return { envelope }
            const canvas = window.layersApp._renderer._textCanvases
                .get(envelope.result.layerId).canvas
            const data = canvas.getContext('2d')
                .getImageData(0, 0, canvas.width, canvas.height).data
            let hasRedText = false
            for (let index = 0; index < data.length; index += 4) {
                if (data[index] > 200 && data[index + 1] < 30 && data[index + 2] < 30) {
                    hasRedText = true
                    break
                }
            }
            return {
                envelope,
                background: Array.from(data.slice(0, 4)),
                hasRedText,
            }
        })

        expect(result.envelope.ok).toBe(true)
        expect(result.background).toEqual([0, 255, 0, 255])
        expect(result.hasRedText).toBe(true)
    })

    test('addEffectLayer rejects undeclared choices without mutation', async ({ page }) => {
        await bootApp(page)
        const result = await page.evaluate(async () => {
            const app = window.layersApp
            const modelBefore = JSON.stringify(app._layers)
            const dslBefore = app._renderer.currentDsl
            const envelope = await window.LayersAgent.addLayer({
                kind: 'effect',
                effectId: 'synth/gradient',
                params: { type: 99 },
            })
            return {
                envelope,
                modelBefore,
                dslBefore,
                modelAfter: JSON.stringify(app._layers),
                dslAfter: app._renderer.currentDsl,
            }
        })

        expectRejectedWithoutMutation(result, 'INVALID_ARGS_ENUM', 'params.type')
    })

    test('addChildEffect rejects out-of-range params without mutation', async ({ page }) => {
        await bootApp(page)
        const result = await page.evaluate(async () => {
            const app = window.layersApp
            const layerId = app._layers[0].id
            const modelBefore = JSON.stringify(app._layers)
            const dslBefore = app._renderer.currentDsl
            const envelope = await window.LayersAgent.addChildEffect({
                layerId,
                effectId: 'filter/blur',
                params: { radiusX: 51 },
            })
            return {
                envelope,
                modelBefore,
                dslBefore,
                modelAfter: JSON.stringify(app._layers),
                dslAfter: app._renderer.currentDsl,
            }
        })

        expectRejectedWithoutMutation(result, 'INVALID_ARGS_RANGE', 'params.radiusX')
    })

    test('addChildEffect rejects malformed vectors without mutation', async ({ page }) => {
        await bootApp(page)
        const result = await page.evaluate(async () => {
            const app = window.layersApp
            const layerId = app._layers[0].id
            const modelBefore = JSON.stringify(app._layers)
            const dslBefore = app._renderer.currentDsl
            const envelope = await window.LayersAgent.addChildEffect({
                layerId,
                effectId: 'filter/celShading',
                params: { lightDirection: [0, 1] },
            })
            return {
                envelope,
                modelBefore,
                dslBefore,
                modelAfter: JSON.stringify(app._layers),
                dslAfter: app._renderer.currentDsl,
            }
        })

        expectRejectedWithoutMutation(result, 'INVALID_ARGS_TYPE',
            'params.lightDirection')
    })

    test('valid declared vectors survive the child-effect round trip', async ({ page }) => {
        await bootApp(page)
        const result = await page.evaluate(async () => {
            const layerId = window.layersApp._layers[0].id
            return window.LayersAgent.addChildEffect({
                layerId,
                effectId: 'filter/celShading',
                params: { lightDirection: [0.25, 0.5, 1] },
            })
        })

        expect(result.ok).toBe(true)
        const layer = result.state.layers.find(candidate =>
            candidate.children.some(child => child.id === result.result.childId))
        const child = layer.children.find(candidate => candidate.id === result.result.childId)
        expect(child.params.lightDirection).toEqual([0.25, 0.5, 1])
    })

    test('valid declared members compile and survive the child-effect round trip', async ({ page }) => {
        await bootApp(page)
        const result = await page.evaluate(async () => {
            const layerId = window.layersApp._layers[0].id
            return window.LayersAgent.addChildEffect({
                layerId,
                effectId: 'filter/channel',
                params: { channel: 'channel.r' },
            })
        })

        expect(result.ok).toBe(true)
        const layer = result.state.layers.find(candidate =>
            candidate.children.some(child => child.id === result.result.childId))
        const child = layer.children.find(candidate => candidate.id === result.result.childId)
        expect(child.params.channel).toBe('channel.r')
    })

    test('member values outside the declared enum prefix are rejected without mutation', async ({ page }) => {
        await bootApp(page)
        const result = await page.evaluate(async () => {
            const app = window.layersApp
            const layerId = app._layers[0].id
            const modelBefore = JSON.stringify(app._layers)
            const dslBefore = app._renderer.currentDsl
            const envelope = await window.LayersAgent.addChildEffect({
                layerId,
                effectId: 'filter/channel',
                params: { channel: 'evil.value' },
            })
            return {
                envelope,
                modelBefore,
                dslBefore,
                modelAfter: JSON.stringify(app._layers),
                dslAfter: app._renderer.currentDsl,
            }
        })

        expectRejectedWithoutMutation(result, 'INVALID_ARGS_ENUM', 'params.channel')
    })

    for (const operation of ['add', 'update']) {
        test(`${operation} rejects unknown members inside the declared enum without mutation`, async ({ page }) => {
            await bootApp(page)
            const result = await page.evaluate(async ({ operation }) => {
                const app = window.layersApp
                const layerId = app._layers[0].id
                let childId = null
                if (operation === 'update') {
                    const added = await window.LayersAgent.addChildEffect({
                        layerId,
                        effectId: 'filter/channel',
                        params: { channel: 'channel.r' },
                    })
                    childId = added.result.childId
                }
                const modelBefore = JSON.stringify(app._layers)
                const dslBefore = app._renderer.currentDsl
                const envelope = operation === 'add'
                    ? await window.LayersAgent.addChildEffect({
                        layerId,
                        effectId: 'filter/channel',
                        params: { channel: 'channel.notARealMember' },
                    })
                    : await window.LayersAgent.setChildEffectParams({
                        layerId,
                        childId,
                        params: { channel: 'channel.notARealMember' },
                    })
                return {
                    envelope,
                    modelBefore,
                    dslBefore,
                    modelAfter: JSON.stringify(app._layers),
                    dslAfter: app._renderer.currentDsl,
                }
            }, { operation })

            expectRejectedWithoutMutation(result, 'INVALID_ARGS_ENUM', 'params.channel')
        })
    }

    for (const [field, value] of [
        ['source', 'vol999'],
        ['geoSource', 'geo999'],
    ]) {
        test(`add rejects nonexistent ${field} references without mutation`, async ({ page }) => {
            await bootApp(page)
            const result = await page.evaluate(async ({ field, value }) => {
                const app = window.layersApp
                const modelBefore = JSON.stringify(app._layers)
                const dslBefore = app._renderer.currentDsl
                const envelope = await window.LayersAgent.addLayer({
                    kind: 'effect',
                    effectId: 'synth3d/cellularAutomata3d',
                    params: { [field]: value },
                })
                return {
                    envelope,
                    modelBefore,
                    dslBefore,
                    modelAfter: JSON.stringify(app._layers),
                    dslAfter: app._renderer.currentDsl,
                }
            }, { field, value })

            expectRejectedWithoutMutation(result, 'INVALID_ARGS_ENUM', `params.${field}`)
        })
    }

    test('setLayerEffectParams rejects non-finite primitives without mutation', async ({ page }) => {
        await bootApp(page)
        const result = await page.evaluate(async () => {
            const app = window.layersApp
            const layerId = app._layers[0].id
            const modelBefore = JSON.stringify(app._layers)
            const dslBefore = app._renderer.currentDsl
            const envelope = await window.LayersAgent.setLayerEffectParams({
                layerId,
                params: { alpha: Infinity },
            })
            return {
                envelope,
                modelBefore,
                dslBefore,
                modelAfter: JSON.stringify(app._layers),
                dslAfter: app._renderer.currentDsl,
            }
        })

        expectRejectedWithoutMutation(result, 'INVALID_ARGS_TYPE', 'params.alpha')
    })

    test('setChildEffectParams rejects invalid types without mutation', async ({ page }) => {
        await bootApp(page)
        const result = await page.evaluate(async () => {
            const app = window.layersApp
            const layerId = app._layers[0].id
            const added = await window.LayersAgent.addChildEffect({
                layerId,
                effectId: 'filter/blur',
            })
            const modelBefore = JSON.stringify(app._layers)
            const dslBefore = app._renderer.currentDsl
            const envelope = await window.LayersAgent.setChildEffectParams({
                layerId,
                childId: added.result.childId,
                params: { radiusY: 'wide' },
            })
            return {
                envelope,
                modelBefore,
                dslBefore,
                modelAfter: JSON.stringify(app._layers),
                dslAfter: app._renderer.currentDsl,
            }
        })

        expectRejectedWithoutMutation(result, 'INVALID_ARGS_TYPE', 'params.radiusY')
    })

    test('valid parameter aliases survive add and update round trips', async ({ page }) => {
        await bootApp(page)
        const result = await page.evaluate(async () => {
            const added = await window.LayersAgent.addLayer({
                kind: 'text',
                text: 'alias',
                params: { bgOpacity: 0.25 },
            })
            const updated = await window.LayersAgent.setLayerEffectParams({
                layerId: added.result.layerId,
                params: { bgAlpha: 0.5 },
            })
            return { added, updated }
        })

        expect(result.added.ok).toBe(true)
        expect(result.updated.ok).toBe(true)
        const layer = result.updated.state.layers.find(
            candidate => candidate.id === result.added.result.layerId)
        expect(layer.effect.params).toMatchObject({
            bgOpacity: 0.25,
            bgAlpha: 0.5,
        })
    })
})

test('setLayerProps rejects invalid blend modes without mutation', async ({ page }) => {
    await bootApp(page)
    const result = await page.evaluate(async () => {
        const app = window.layersApp
        const layerId = app._layers[0].id
        const modelBefore = JSON.stringify(app._layers)
        const dslBefore = app._renderer.currentDsl
        const envelope = await window.LayersAgent.setLayerProps({
            layerId,
            props: { blendMode: 'mix).write(o9)' },
        })
        return {
            envelope,
            modelBefore,
            dslBefore,
            modelAfter: JSON.stringify(app._layers),
            dslAfter: app._renderer.currentDsl,
        }
    })

    expectRejectedWithoutMutation(result, 'INVALID_ARGS_ENUM', 'props.blendMode')
})

test('renderer emits declared volume and geometry identifiers unquoted', async ({ page }) => {
    await bootApp(page)
    const call = await page.evaluate(async () => {
        const renderer = window.layersApp._renderer
        await renderer.getEffectDefinition('synth3d/cellularAutomata3d')
        return renderer._buildEffectCall({
            effectId: 'synth3d/cellularAutomata3d',
            effectParams: { source: 'vol0', geoSource: 'geo0' },
        })
    })

    expect(call).toContain('source: vol0')
    expect(call).toContain('geoSource: geo0')
    expect(call).not.toContain('"""')
})
