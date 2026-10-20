/**
 * What an agent in the person's Seance session sees and may do.
 *
 * The relay (relay.js) sends every answer to everyone in the session, and
 * anyone who can edit the session can send requests. So a session reaches the
 * shared composition and the person's view of it, and nothing that the person
 * keeps in this browser: commands in LOCAL_ONLY answer REMOTE_UNAVAILABLE, a
 * request cannot bring in media as base64 text or from an outside link, and
 * the state in each answer leaves out the saved project, the settings, the
 * foreground color, jobs, exports and media file names.
 *
 * Layers is an island: its sessions hold Layers' own document, and no
 * programs or images move between it and other apps.
 *
 * @module agent/session
 */

import { COMMAND_GROUPS, LOCAL_ONLY } from './descriptions.js'
import { SCHEMAS } from './schemas.js'
import { makeFailure } from './dispatcher.js'

const DESCRIPTIONS = Object.assign({}, ...COMMAND_GROUPS.map(group => group.commands))

/** Commands that an agent in the person's session can run in this tab. */
export const REMOTE = new Set(Object.keys(DESCRIPTIONS).filter(name => !LOCAL_ONLY.includes(name)))

// Commands that change neither the composition nor the person's view.
const READ_ONLY = new Set([
    'getState', 'getLayer', 'getCanvasSize', 'getSelection', 'getProjectInfo',
    'listProjects', 'getSettings', 'getForegroundColor', 'searchEffects',
    'listEffectCategories', 'listCuratedEffects', 'getEffectDefinition',
    'getJob', 'waitForJob', 'getCanvasImageBytes', 'getThumbnail',
    'getLayerThumbnail', 'listInstalledFonts',
])

// The state that a session sees. Everything else in a snapshot stays in this
// tab: the saved project's id and name, the foreground color, jobs, exports,
// settings and media file names, and any field added to the snapshot later.
export const SESSION_STATE_KEYS = ['apiVersion', 'schemaVersion', 'project', 'canvas', 'view',
    'selection', 'layers', 'selectedLayerIds', 'activeLayerId']
export const SESSION_LAYER_KEYS = ['id', 'name', 'sourceType', 'visible', 'opacity', 'blendMode',
    'locked', 'transform', 'media', 'effect', 'drawing', 'children', 'mask']
export const SESSION_MEDIA_KEYS = ['type', 'width', 'height', 'durationSec']

// An image that the session holds, named by the SHA-256 of its bytes.
const SESSION_IMAGE_REF = /^image:[a-f0-9]{64}$/

/** The command list that the relay's `describe` returns. */
export function catalog() {
    return COMMAND_GROUPS.flatMap(group => Object.entries(group.commands).map(([name, does]) => ({
        name,
        group: group.title,
        does,
        args: jsonSchema(SCHEMAS[name]),
        readOnly: READ_ONLY.has(name),
        remote: REMOTE.has(name),
    })))
}

/** A command's argument schema in JSON Schema terms. */
export function jsonSchema(schema) {
    if (!schema) return { type: 'object', properties: {} }
    const out = {}
    for (const [key, value] of Object.entries(schema)) {
        if (key.startsWith('_')) continue
        if (key === 'min') out.minimum = value
        else if (key === 'max') out.maximum = value
        else if (key === 'items') out.items = jsonSchema(value)
        else if (key === 'properties') {
            out.properties = Object.fromEntries(Object.entries(value)
                .map(([name, field]) => [name, jsonSchema(field)]))
        } else out[key] = value
    }
    return out
}

function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Refuse a session request that this tab must not run.
 *
 * @param {string} command
 * @param {*} args
 * @returns {object|null} a failure envelope, or null to run the command
 */
export function checkSessionRequest(command, args) {
    if (!Object.hasOwn(DESCRIPTIONS, command)) {
        return makeFailure(command, 'NOT_FOUND_COMMAND', `Layers has no command ${command}.`)
    }
    if (!REMOTE.has(command)) {
        return makeFailure(command, 'REMOTE_UNAVAILABLE',
            `${command} needs the person at the browser and is not available through a session.`)
    }
    if (!isPlainObject(args)) {
        return makeFailure(command, 'INVALID_ARGS_TYPE', 'args must be an object',
            { field: 'args', expected: 'object' })
    }
    const source = args.source
    if (isPlainObject(source) && source.kind === 'base64') {
        return makeFailure(command, 'IMAGE_AS_TEXT',
            'Images travel through a session as bytes, never as text. Add the image with image-put and refer to it as image:<sha256>.')
    }
    if (isPlainObject(source) && source.kind === 'url'
        && !(typeof source.value === 'string' && SESSION_IMAGE_REF.test(source.value))) {
        return makeFailure(command, 'OUTSIDE_LINK',
            'A session request cannot name media by an outside link, which would make the person\'s browser fetch it. Add the image with image-put and refer to it as image:<sha256>.')
    }
    return null
}

function pick(object, keys) {
    return Object.fromEntries(Object.entries(object).filter(([key]) => keys.includes(key)))
}

/** One layer's snapshot as a session sees it: no name of the person's media file. */
export function sessionLayer(layer) {
    if (!isPlainObject(layer)) return layer
    const out = pick(layer, SESSION_LAYER_KEYS)
    if (isPlainObject(out.media)) out.media = pick(out.media, SESSION_MEDIA_KEYS)
    return out
}

/**
 * The state snapshot as a session sees it: no saved project, settings,
 * foreground color, jobs, exports or media file names. `project` keeps only
 * `canUndo` and `canRedo`, which count only the states since the session
 * started.
 *
 * @param {object} state - A snapshot from buildSnapshot.
 * @param {object} [app]
 */
export function sessionState(state, app) {
    if (!isPlainObject(state)) return state
    const reaches = step => Boolean(app?._onlineAdapter?.reachesBeforeSession?.(step))
    const out = {}
    for (const [key, value] of Object.entries(state)) {
        if (!SESSION_STATE_KEYS.includes(key)) continue
        if (key === 'project' && isPlainObject(value)) {
            out.project = {
                canUndo: Boolean(value.canUndo) && !reaches(-1),
                canRedo: Boolean(value.canRedo) && !reaches(1),
            }
        } else if (key === 'layers' && Array.isArray(value)) {
            out.layers = value.map(sessionLayer)
        } else {
            out[key] = value
        }
    }
    return out
}

/**
 * An envelope as the session receives it.
 *
 * @param {string} command
 * @param {object} envelope
 * @param {object} [app]
 */
export function sessionEnvelope(command, envelope, app) {
    const out = { ...envelope }
    if (out.state) out.state = sessionState(out.state, app)
    if (out.ok && command === 'getState') out.result = sessionState(out.result, app)
    if (out.ok && command === 'getLayer') out.result = sessionLayer(out.result)
    return out
}
