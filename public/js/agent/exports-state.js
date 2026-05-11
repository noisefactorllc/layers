/**
 * In-memory ring of recent exportImage / exportVideo entries plus the captureOnly
 * blob-URL registry used by releaseExport.
 *
 * Lives in its own module so snapshot.js can read the recent-exports list
 * without importing commands.js — a circular import that ESM's live bindings
 * tolerated but broke single-file reasoning. Now:
 *
 *   commands.js → exports-state.js  (writes)
 *   snapshot.js → exports-state.js  (reads)
 *
 * ...with no cycle between commands and snapshot.
 *
 * @module agent/exports-state
 */

import { RECENT_EXPORTS_CAP } from './constants.js'

/**
 * Module-scoped ring of recent export entries. Newest is last; the oldest is
 * dropped once we exceed RECENT_EXPORTS_CAP. Kept outside LayersApp state so
 * exports aren't persisted across reloads (matches the human UI's behavior).
 */
const _recentExports = []

/**
 * captureOnly exports allocate a browser blob URL the caller can fetch.
 * Browsers keep the underlying Blob alive until the URL is revoked or the
 * document unloads — agents that produce many captureOnly exports can leak
 * memory until they release them.
 *
 * Map<exportId, blobUrl>. exportImage / exportVideo write here on success;
 * `releaseExport` reads + revokes + deletes.
 */
const _captureBlobUrls = new Map()

/**
 * Return a shallow copy of the recent-exports ring. Callers can hold the
 * returned array without worrying about subsequent recordExport mutations.
 */
export function getRecentExports() {
    return _recentExports.slice()
}

/**
 * Push a new export entry onto the ring, dropping the oldest if we overflow
 * RECENT_EXPORTS_CAP. One push per call so we can only ever be exactly one
 * entry over the cap.
 */
export function recordExport(entry) {
    _recentExports.push(entry)
    if (_recentExports.length > RECENT_EXPORTS_CAP) _recentExports.shift()
}

/**
 * Mint a fresh export id. Uses RFC 4122 v4 when crypto.randomUUID is available
 * (Chrome 92+, Firefox 95+, Safari 15.4+) and falls back to a timestamp+rand
 * tag on older browsers — collision-resistant in a way Math.random alone isn't.
 */
export function makeExportId() {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
        return `export-${crypto.randomUUID()}`
    }
    return `export-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
}

/**
 * Build a `<baseName>.<ext>` filename or, when baseName is missing, a sortable
 * timestamped fallback like `layers-2026-01-15T12-34-56.png`.
 */
export function timestampedFilename(baseName, ext) {
    if (baseName) return `${baseName}.${ext}`
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    return `layers-${ts}.${ext}`
}

/**
 * Remember a captureOnly export's blob URL so releaseExport can revoke it later.
 * No-op when blobUrl is missing (non-captureOnly exports never call here).
 */
export function rememberCaptureBlobUrl(exportId, blobUrl) {
    if (!exportId || !blobUrl) return
    _captureBlobUrls.set(exportId, blobUrl)
}

/**
 * Look up and consume a captureOnly export's blob URL. Returns the URL string
 * if known (and removes the entry from the map), or null if the id has no
 * registered URL. Callers are expected to URL.revokeObjectURL() the returned
 * value when non-null.
 */
export function consumeCaptureBlobUrl(exportId) {
    if (!_captureBlobUrls.has(exportId)) return null
    const url = _captureBlobUrls.get(exportId)
    _captureBlobUrls.delete(exportId)
    return url
}

/**
 * Test helper — checks whether a given exportId currently has a tracked
 * captureOnly URL. Used by tests to assert releaseExport actually cleared
 * the map entry.
 */
export function hasCaptureBlobUrl(exportId) {
    return _captureBlobUrls.has(exportId)
}
