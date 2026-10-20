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

// API_VERSION lives in constants.js so other agent modules can import it
// without pulling in the dispatcher / registration machinery. Re-exported
// here for backwards compatibility — older external code that does
// `import { API_VERSION } from './index.js'` keeps working.
import { API_VERSION } from './constants.js'
export { API_VERSION }

import { makeFailure, registerCommand, runCommand } from './dispatcher.js'
import { buildSnapshot } from './snapshot.js'
import * as commands from './commands.js'
import { createAgentRelay } from './relay.js'
import { catalog, checkSessionRequest, sessionEnvelope } from './session.js'

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
 * Test-environment detector — gates the diagnostic underscore commands
 * (_ping/_echoNumber/_echoEnum/_echoNested/_sleep) so they don't surface
 * to agents on production deployments.
 *
 * True when hostname is localhost / 127.0.0.1 / empty, or the page was
 * loaded via file:// (used by Playwright + local dev). False for the
 * deployed layers.noisefactor.io build, where these commands would just
 * be dead surface area an agent could discover.
 */
function inTestEnv() {
    if (typeof window === 'undefined') return false
    const h = window.location?.hostname
    return h === 'localhost'
        || h === '127.0.0.1'
        || h === ''
        || window.location?.protocol === 'file:'
}

/**
 * Wire commands and resolve the ready promise.
 * Call once from app.js after LayersApp.init() finishes.
 *
 * @param {LayersApp} app - The initialized application instance.
 */
export function bootstrapAgent(app) {
    LayersAgent._app = app
    // Diagnostic commands used only by the agent test suite; not for production
    // agents. Registered only when running on localhost / 127.0.0.1 / file://
    // so the deployed build doesn't advertise them.
    if (inTestEnv()) {
        registerCommand(LayersAgent, '_ping', async () => ({ result: { pong: true } }))
        registerCommand(LayersAgent, '_echoNumber', async ({ value }) => ({ result: { value } }))
        registerCommand(LayersAgent, '_echoEnum', async ({ choice }) => ({ result: { choice } }))
        registerCommand(LayersAgent, '_echoNested', async ({ outer }) => ({ result: { outer } }))
        registerCommand(LayersAgent, '_sleep', async ({ delayMs }) => {
            await new Promise(resolve => setTimeout(resolve, delayMs))
            return { result: { delayMs } }
        })
    }
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
    registerCommand(LayersAgent, 'addLayer', commands.addLayer)
    registerCommand(LayersAgent, 'deleteLayer', commands.deleteLayer)
    registerCommand(LayersAgent, 'duplicateLayer', commands.duplicateLayer)
    registerCommand(LayersAgent, 'reorderLayer', commands.reorderLayer)
    registerCommand(LayersAgent, 'selectLayer', commands.selectLayer)
    registerCommand(LayersAgent, 'selectLayers', commands.selectLayers)
    registerCommand(LayersAgent, 'flattenImage', commands.flattenImage)
    registerCommand(LayersAgent, 'flattenLayers', commands.flattenLayers)
    registerCommand(LayersAgent, 'rasterizeLayer', commands.rasterizeLayer)
    registerCommand(LayersAgent, 'flipLayer', commands.flipLayer)
    registerCommand(LayersAgent, 'setLayerProps', commands.setLayerProps)
    registerCommand(LayersAgent, 'setLayerTransform', commands.setLayerTransform)
    registerCommand(LayersAgent, 'setLayerEffectParams', commands.setLayerEffectParams)
    registerCommand(LayersAgent, 'addChildEffect', commands.addChildEffect)
    registerCommand(LayersAgent, 'removeChildEffect', commands.removeChildEffect)
    registerCommand(LayersAgent, 'reorderChildEffect', commands.reorderChildEffect)
    registerCommand(LayersAgent, 'setChildEffectProps', commands.setChildEffectProps)
    registerCommand(LayersAgent, 'setChildEffectParams', commands.setChildEffectParams)
    registerCommand(LayersAgent, 'deleteChildEffectMask', commands.deleteChildEffectMask)
    registerCommand(LayersAgent, 'getCanvasImageBytes', commands.getCanvasImageBytes)
    registerCommand(LayersAgent, 'getThumbnail', commands.getThumbnail)
    registerCommand(LayersAgent, 'getLayerThumbnail', commands.getLayerThumbnail)
    registerCommand(LayersAgent, 'exportImage', commands.exportImage)
    registerCommand(LayersAgent, 'pasteImageFromBytes', commands.pasteImageFromBytes)
    registerCommand(LayersAgent, 'selectAll', commands.selectAll)
    registerCommand(LayersAgent, 'selectNone', commands.selectNone)
    registerCommand(LayersAgent, 'selectInverse', commands.selectInverse)
    registerCommand(LayersAgent, 'setRectangleSelection', commands.setRectangleSelection)
    registerCommand(LayersAgent, 'setOvalSelection', commands.setOvalSelection)
    registerCommand(LayersAgent, 'setPolygonSelection', commands.setPolygonSelection)
    registerCommand(LayersAgent, 'setMagicWandSelection', commands.setMagicWandSelection)
    registerCommand(LayersAgent, 'selectColorRange', commands.selectColorRange)
    registerCommand(LayersAgent, 'expandSelection', commands.expandSelection)
    registerCommand(LayersAgent, 'contractSelection', commands.contractSelection)
    registerCommand(LayersAgent, 'featherSelection', commands.featherSelection)
    registerCommand(LayersAgent, 'smoothSelection', commands.smoothSelection)
    registerCommand(LayersAgent, 'borderSelection', commands.borderSelection)
    registerCommand(LayersAgent, 'cropToSelection', commands.cropToSelection)
    registerCommand(LayersAgent, 'addLayerMask', commands.addLayerMask)
    registerCommand(LayersAgent, 'deleteLayerMask', commands.deleteLayerMask)
    registerCommand(LayersAgent, 'addMaskFromSelection', commands.addMaskFromSelection)
    registerCommand(LayersAgent, 'selectFromLayerMask', commands.selectFromLayerMask)
    registerCommand(LayersAgent, 'getRasterRegion', commands.getRasterRegion)
    registerCommand(LayersAgent, 'paintLayerMask', commands.paintLayerMask)
    registerCommand(LayersAgent, 'invertLayerMask', commands.invertLayerMask)
    registerCommand(LayersAgent, 'setMaskEnabled', commands.setMaskEnabled)
    registerCommand(LayersAgent, 'setMaskVisible', commands.setMaskVisible)
    registerCommand(LayersAgent, 'setMaskEditMode', commands.setMaskEditMode)
    registerCommand(LayersAgent, 'featherMask', commands.featherMask)
    registerCommand(LayersAgent, 'expandMask', commands.expandMask)
    registerCommand(LayersAgent, 'contractMask', commands.contractMask)
    registerCommand(LayersAgent, 'smoothMask', commands.smoothMask)
    registerCommand(LayersAgent, 'paintStroke', commands.paintStroke)
    registerCommand(LayersAgent, 'getDrawingStrokes', commands.getDrawingStrokes)
    registerCommand(LayersAgent, 'eraseStroke', commands.eraseStroke)
    registerCommand(LayersAgent, 'clearDrawingLayer', commands.clearDrawingLayer)
    registerCommand(LayersAgent, 'drawShape', commands.drawShape)
    registerCommand(LayersAgent, 'fillRegion', commands.fillRegion)
    registerCommand(LayersAgent, 'newProject', commands.newProject)
    registerCommand(LayersAgent, 'openProject', commands.openProject)
    registerCommand(LayersAgent, 'saveProject', commands.saveProject)
    registerCommand(LayersAgent, 'saveProjectAs', commands.saveProjectAs)
    registerCommand(LayersAgent, 'deleteProject', commands.deleteProject)
    registerCommand(LayersAgent, 'listRecoveryCopies', commands.listRecoveryCopies)
    registerCommand(LayersAgent, 'restoreRecoveryCopy', commands.restoreRecoveryCopy)
    registerCommand(LayersAgent, 'discardRecoveryCopy', commands.discardRecoveryCopy)
    registerCommand(LayersAgent, 'undo', commands.undo)
    registerCommand(LayersAgent, 'redo', commands.redo)
    registerCommand(LayersAgent, 'setForegroundColor', commands.setForegroundColor)
    registerCommand(LayersAgent, 'setZoom', commands.setZoom)
    registerCommand(LayersAgent, 'setPan', commands.setPan)
    registerCommand(LayersAgent, 'setTool', commands.setTool)
    registerCommand(LayersAgent, 'setSelectionTool', commands.setSelectionTool)
    registerCommand(LayersAgent, 'play', commands.play)
    registerCommand(LayersAgent, 'pause', commands.pause)
    registerCommand(LayersAgent, 'setSettings', commands.setSettings)
    registerCommand(LayersAgent, 'resizeImage', commands.resizeImage)
    registerCommand(LayersAgent, 'resizeCanvas', commands.resizeCanvas)
    registerCommand(LayersAgent, 'autoLevels', commands.autoLevels)
    registerCommand(LayersAgent, 'autoContrast', commands.autoContrast)
    registerCommand(LayersAgent, 'autoWhiteBalance', commands.autoWhiteBalance)
    registerCommand(LayersAgent, 'listInstalledFonts', commands.listInstalledFonts)
    registerCommand(LayersAgent, 'installFontBundle', commands.installFontBundle)
    registerCommand(LayersAgent, 'exportVideo', commands.exportVideo)
    registerCommand(LayersAgent, 'releaseExport', commands.releaseExport)
    registerCommand(LayersAgent, 'takeOnline', commands.takeOnline)
    registerCommand(LayersAgent, 'joinSession', commands.joinSession)
    registerCommand(LayersAgent, 'goOffline', commands.goOffline)
    if (typeof window !== 'undefined') {
        window.__buildSnapshot = buildSnapshot
    }
    _readyResolve()
}

/**
 * The Seance relay for this tab (see relay.js): its WebSocket class goes to the
 * Seance SDK, sessionCreated marks a session this tab took online, and onAgent
 * hears the first request from each agent. A request runs the same command,
 * validation and checks as the in-page API, within the limits of session.js.
 *
 * A request waits its turn behind other commands. If its session is no longer
 * this tab's current one when its turn comes, it does not run.
 *
 * @param {{appVersion: string, uploadImage: (blob: Blob) => Promise<string>, onAgent?: Function,
 *   currentSession?: () => *}} options - `currentSession` names the session a
 *   request arrives in, or returns null when none is current.
 * @returns {{ WebSocket: typeof WebSocket, tabId: string, sessionCreated: (sessionId: string) => void, answers: () => boolean }}
 */
export function createSeanceAgentRelay({ appVersion, uploadImage, onAgent, currentSession = () => true }) {
    const ended = command => makeFailure(command, 'CONFLICT_SESSION_ENDED',
        'The session that sent this command is no longer online in this tab.')
    return createAgentRelay({
        app: 'layers',
        appVersion,
        catalog,
        uploadImage,
        onAgent,
        async invoke(command, args) {
            const session = currentSession()
            const refused = checkSessionRequest(command, args)
            if (refused) return { envelope: refused }
            if (session === null) return { envelope: ended(command) }
            const isCurrent = () => currentSession() === session
            await LayersAgent.ready
            const { envelope, image } = await runCommand(command, args, { session: true, isCurrent })
            // The answer, and any image, belong only to the session that asked.
            if (!isCurrent()) return { envelope: ended(command) }
            return { envelope: sessionEnvelope(command, envelope, LayersAgent._app), image }
        },
    })
}
