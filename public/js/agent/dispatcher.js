/**
 * Command dispatcher — wraps every LayersAgent command in:
 *   - Argument validation (Task 3 will add schema enforcement)
 *   - Serialized execution (one command in flight at a time)
 *   - Standard success/failure envelope
 *   - Latest state snapshot attached to every response (Task 7+ will add real state)
 *
 * @module agent/dispatcher
 */

import { API_VERSION } from './constants.js'
import { SCHEMAS, validate } from './schemas.js'
import { buildSnapshot } from './snapshot.js'

let _tail = Promise.resolve()

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

/**
 * Register a command on the LayersAgent namespace.
 *
 * @param {object} agent - The LayersAgent object.
 * @param {string} name - Command name.
 * @param {(args: object, app: object) => Promise<{ result, warnings? }>} handler
 *   Async handler receiving validated args and the app instance.
 *   Returns a plain object with result/warnings; the dispatcher wraps it.
 */
export function registerCommand(agent, name, handler) {
    agent[name] = (args = {}) => serialize(async () => {
        const schema = SCHEMAS[name]
        if (schema) {
            const v = validate(args, schema)
            if (!v.ok) {
                const snap = safeSnapshot(agent._app)
                return makeFailure(name, v.code, v.message, v.details, snap)
            }
        }
        try {
            const out = await handler(args, agent._app)
            const snap = safeSnapshot(agent._app)
            return makeSuccess(name, out.result, snap, out.warnings || [])
        } catch (err) {
            const snap = safeSnapshot(agent._app)
            if (err && err.__envelope) {
                err.__envelope.command = name
                err.__envelope.state = snap
                return err.__envelope
            }
            return makeFailure(name, 'INTERNAL_ERROR', err.message || String(err),
                { stack: err.stack }, snap)
        }
    })
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
