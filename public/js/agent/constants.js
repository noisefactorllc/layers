/**
 * Agent layer protocol-level constants.
 *
 * Lives here (not in index.js) so other modules can import these without
 * pulling in the dispatcher / registration machinery — eliminates the
 * circular-import risk that was building up between snapshot.js,
 * commands.js, and index.js.
 *
 * @module agent/constants
 */

/**
 * Wire protocol version. Every command envelope advertises this. Bump only
 * for breaking changes to the envelope or command-naming contract.
 */
export const API_VERSION = '1.0'

/**
 * State-snapshot schema version. Embedded in every snapshot. Bump for any
 * change to the snapshot shape (new fields are minor; renamed/removed fields
 * are breaking).
 */
export const SCHEMA_VERSION = '1.0'

/**
 * How many recent export entries to retain in the in-memory ring. Older
 * entries get shifted out as new exports complete. Lives here so it can
 * be tuned without touching the command file.
 */
export const RECENT_EXPORTS_CAP = 50

/**
 * structuredClone with a graceful fallback for values that contain
 * non-cloneable bits (functions, Symbols, DOM nodes that aren't transferable).
 * Used at agent-command boundaries to defend the layer's state against
 * caller mutation of param objects after a call returns.
 *
 * Plain JSON params always clone fine; the fallback only triggers for exotic
 * inputs we shouldn't see from agent calls anyway.
 */
export function safeClone(v) {
    if (v == null) return v
    try {
        return structuredClone(v)
    } catch {
        return v
    }
}
