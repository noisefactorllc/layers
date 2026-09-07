import { test, expect } from './fixtures.js'
import { readFile } from 'node:fs/promises'
import { commandError, registerCommand } from '../public/js/agent/dispatcher.js'
import { readRenderPixels } from '../public/js/utils/canvas-readback.js'

// Evaluate the actual handler without the unrelated browser-only settings UI
// import, then exercise it through the real schema validator and dispatcher.
const source = await readFile(new URL('../public/js/agent/commands.js', import.meta.url), 'utf8')
const start = source.indexOf('export async function fillRegion(')
const end = source.indexOf('\n}', start) + 2
const fillRegion = new Function('commandError', 'readRenderPixels',
    `return ${source.slice(start, end).replace('export ', '')}`)(commandError, readRenderPixels)

for (const failure of ['unsupported capture', 'unexpected capture', 'unexpected readback']) {
    test(`agent fill reports ${failure} without creating a layer`, async () => {
        let mutations = 0, releases = 0, captures = 0
        const message = 'This effect graph cannot be tiled and exceeds the full-resolution GPU memory budget.'
        const layers = [{ id: 'original', sourceType: 'effect', effectId: 'synth/solid', visible: true }]
        const app = {
            _canvas: { width: 64, height: 64 }, _layers: layers,
            _acquireProjectLifecycle: async () => ({ release: () => releases++ }),
            _captureFullResolutionFrame: async () => {
                captures++
                if (failure === 'unsupported capture') throw Object.assign(new Error(message), { code: 'FULL_RESOLUTION_UNSUPPORTED' })
                if (failure === 'unexpected capture') throw new Error('Unexpected decoder internals')
                return { getContext: () => { throw new Error('Unexpected readback internals') } }
            },
            _addMediaLayerFromCanvas: () => { mutations++; throw new Error('Must not mutate after a failed capture') },
        }
        const agent = { _app: app }
        registerCommand(agent, 'fillRegion', fillRegion)
        const envelope = await agent.fillRegion({ x: 1, y: 1, color: '#ff0000' })
        expect(envelope).toMatchObject({ ok: false, command: 'fillRegion', error: {
            code: 'INTERNAL_ERROR',
            message: failure === 'unsupported capture' ? message : 'Could not read canvas pixels for fill',
            details: failure === 'unsupported capture' ? { reason: 'FULL_RESOLUTION_UNSUPPORTED' } : {},
        } })
        expect(captures).toBe(1)
        expect(mutations).toBe(0)
        expect(releases).toBe(1)
        expect(app._layers).toBe(layers)
        expect(app._layers.map(layer => layer.id)).toEqual(['original'])
    })
}
