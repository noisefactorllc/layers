/**
 * Layers Agent API — public, JSON-only programmatic surface for software agents.
 *
 * Loaded after LayersApp init. Attaches window.LayersAgent with:
 *   - version: API version string
 *   - ready: Promise that resolves once bootstrap completes
 *   - one async method per command
 *
 * Human UI behavior is unchanged; this module is purely additive.
 *
 * @module agent
 */

export const API_VERSION = '1.0'

import { registerCommand } from './dispatcher.js'
import { buildSnapshot } from './snapshot.js'
import * as commands from './commands.js'

let _readyResolve
const _ready = new Promise((resolve) => { _readyResolve = resolve })

export const LayersAgent = {
    version: API_VERSION,
    ready: _ready
}

if (typeof window !== 'undefined') {
    window.LayersAgent = LayersAgent
}

/**
 * Wire commands and resolve the ready promise.
 * Call once from app.js after LayersApp.init() finishes.
 *
 * @param {LayersApp} app - The initialized application instance.
 */
export function bootstrapAgent(app) {
    LayersAgent._app = app
    registerCommand(LayersAgent, '_ping', async () => ({ result: { pong: true } }))
    registerCommand(LayersAgent, '_echoNumber', async ({ value }) => ({ result: { value } }))
    registerCommand(LayersAgent, '_echoEnum', async ({ choice }) => ({ result: { choice } }))
    registerCommand(LayersAgent, '_echoNested', async ({ outer }) => ({ result: { outer } }))
    registerCommand(LayersAgent, '_sleep', async ({ delayMs }) => {
        await new Promise(resolve => setTimeout(resolve, delayMs))
        return { result: { delayMs } }
    })
    registerCommand(LayersAgent, 'getState', commands.getState)
    registerCommand(LayersAgent, 'getLayer', commands.getLayer)
    registerCommand(LayersAgent, 'getCanvasSize', commands.getCanvasSize)
    registerCommand(LayersAgent, 'getSelection', commands.getSelection)
    registerCommand(LayersAgent, 'getProjectInfo', commands.getProjectInfo)
    registerCommand(LayersAgent, 'listProjects', commands.listProjects)
    registerCommand(LayersAgent, 'getSettings', commands.getSettings)
    registerCommand(LayersAgent, 'getForegroundColor', commands.getForegroundColor)
    registerCommand(LayersAgent, 'searchEffects', commands.searchEffects)
    registerCommand(LayersAgent, 'listEffectCategories', commands.listEffectCategories)
    registerCommand(LayersAgent, 'listCuratedEffects', commands.listCuratedEffects)
    registerCommand(LayersAgent, 'getEffectDefinition', commands.getEffectDefinition)
    registerCommand(LayersAgent, 'getJob', commands.getJob)
    registerCommand(LayersAgent, 'waitForJob', commands.waitForJob)
    registerCommand(LayersAgent, 'cancelJob', commands.cancelJob)
    if (typeof window !== 'undefined') {
        window.__buildSnapshot = buildSnapshot
    }
    _readyResolve()
}
