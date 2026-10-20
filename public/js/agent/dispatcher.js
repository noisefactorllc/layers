/**
 * Command dispatcher — wraps every LayersAgent command in:
 *   - Argument validation against the command's registered schema
 *   - Serialized execution (one command in flight at a time)
 *   - Standard success/failure envelope
 *   - Latest state snapshot attached to every response
 *
 * @module agent/dispatcher
 */

import { API_VERSION } from './constants.js'
import { SCHEMAS, validate } from './schemas.js'
import { buildSnapshot } from './snapshot.js'

// The Seance relay (relay.js) reads the API version from here.
export { API_VERSION }

let _tail = Promise.resolve()
const LIFECYCLE_EXEMPT_COMMANDS = new Set([
    'getJob', 'waitForJob', 'cancelJob', 'exportVideo',
    'takeOnline', 'joinSession', 'goOffline', '_sleep'
])
const CONCURRENT_COMMANDS = new Set(['getJob', 'waitForJob', 'cancelJob'])

/**
 * Run a function under the serial queue. Each call awaits the previous one to
 * settle (regardless of success/failure) before starting.
 *
 * @template T
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
function serialize(fn) {
    const next = _tail.then(fn, fn)
    _tail = next.catch(() => {})
    return next
}

export function makeSuccess(command, result, state = null, warnings = []) {
    const env = { ok: true, command, apiVersion: API_VERSION, result, state }
    if (warnings.length) env.warnings = warnings
    return env
}

export function makeFailure(command, code, message, details = {}, state = null) {
    return {
        ok: false,
        command,
        apiVersion: API_VERSION,
        error: { code, message, details },
        state
    }
}

const RUNNERS = new Map()

/**
 * Register a command on the LayersAgent namespace.
 *
 * A handler that produces an image returns it as a Blob in `image`. The
 * in-page method puts its bytes in the result as base64 `bytes`; runCommand
 * hands the Blob itself to a transport that carries binary bytes.
 *
 * @param {object} agent - The LayersAgent object.
 * @param {string} name - Command name.
 * @param {(args: object, app: object, mutationToken?: object, context?: {session?: boolean}) => Promise<{ result, warnings?, image? }>} handler
 *   Async handler receiving validated args, the app, its lifecycle token, and
 *   the context of the call: `context.session` is true when the command came
 *   through the person's Seance session, and `context.isCurrent()`, when
 *   given, says whether that session is still current once the command's turn
 *   comes. Returns a plain object with result/warnings and, for an image,
 *   `image`; the dispatcher wraps it.
 */
export function registerCommand(agent, name, handler) {
    const run = (args = {}, context = {}) => {
        const execute = async () => {
        let mutationToken = null
        try {
            if (!LIFECYCLE_EXEMPT_COMMANDS.has(name)) {
                mutationToken = await agent._app?._acquireProjectLifecycle?.()
            }
            if (context.isCurrent && !context.isCurrent()) {
                return { envelope: makeFailure(name, 'CONFLICT_SESSION_ENDED',
                    'The session that sent this command is no longer online in this tab.',
                    {}, safeSnapshot(agent._app)) }
            }
            const schema = SCHEMAS[name]
            if (schema) {
                const v = validate(args, schema)
                if (!v.ok) {
                    const snap = safeSnapshot(agent._app)
                    return { envelope: makeFailure(name, v.code, v.message, v.details, snap) }
                }
            }
            const out = await handler(args, agent._app, mutationToken, context)
            const snap = safeSnapshot(agent._app)
            return {
                envelope: makeSuccess(name, out.result, snap, out.warnings || []),
                image: out.image || null
            }
        } catch (err) {
            const snap = safeSnapshot(agent._app)
            if (err && err.__envelope) {
                err.__envelope.command = name
                err.__envelope.state = snap
                return { envelope: err.__envelope }
            }
            return { envelope: makeFailure(name, 'INTERNAL_ERROR', err.message || String(err),
                { stack: err.stack }, snap) }
        } finally {
            mutationToken?.release?.()
        }
        }
        return CONCURRENT_COMMANDS.has(name) ? execute() : serialize(execute)
    }
    RUNNERS.set(name, run)
    agent[name] = async (args = {}) => inlineImage(name, await run(args))
}

/**
 * Run a registered command for a transport that carries binary bytes. An
 * image result keeps its bytes out of the envelope and comes back as a Blob.
 *
 * @param {string} name
 * @param {object} [args]
 * @param {{session?: boolean}} [context]
 * @returns {Promise<{envelope: object, image?: Blob|null}>}
 */
export function runCommand(name, args = {}, context = {}) {
    const run = RUNNERS.get(name)
    if (!run) {
        return Promise.resolve({
            envelope: makeFailure(name, 'NOT_FOUND_COMMAND', `Unknown command: ${name}`)
        })
    }
    return run(args, context)
}

/**
 * Encode a Blob's bytes as base64 text, for the in-page API only.
 *
 * @param {Blob} blob
 * @returns {Promise<string>}
 */
export function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onloadend = () => {
            const result = reader.result
            if (typeof result !== 'string') {
                reject(reader.error || new Error('FileReader produced non-string result'))
                return
            }
            const comma = result.indexOf(',')
            resolve(comma >= 0 ? result.slice(comma + 1) : result)
        }
        reader.onerror = () => reject(reader.error || new Error('FileReader failed'))
        reader.readAsDataURL(blob)
    })
}

// The in-page method returns the image's bytes as base64 in the result, as
// it always has. An encoding failure is a failure envelope, not a rejection.
async function inlineImage(name, { envelope, image }) {
    if (!image) return envelope
    try {
        return { ...envelope, result: { bytes: await blobToBase64(image), ...envelope.result } }
    } catch (err) {
        return makeFailure(name, 'INTERNAL_ERROR', err?.message || String(err), {}, envelope.state)
    }
}

function safeSnapshot(app) {
    try { return buildSnapshot(app) }
    catch (err) {
        console.warn('[agent] buildSnapshot threw:', err)
        return null
    }
}

/**
 * Throw a structured error from inside a handler. The dispatcher unwraps it
 * into a failure envelope.
 */
export function commandError(code, message, details = {}) {
    const err = new Error(message)
    err.__envelope = makeFailure(null, code, message, details, null)
    return err
}
