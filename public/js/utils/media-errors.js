/**
 * Media Load Error Descriptions
 * Friendly, actionable messages for undecodable media files
 *
 * @module utils/media-errors
 */

const IMAGE_HINT = 'Try a PNG, JPEG, GIF, or WebP file.'
const VIDEO_HINT = 'Try an H.264 MP4 or a VP9 WebM file.'

/**
 * Turn a media load failure into a user-facing message that names the file
 * and tells the user what will actually work, instead of leaking a raw
 * MediaError/decode event. Non-decode failures (e.g. canvas allocation)
 * fall back to the original error text.
 *
 * @param {unknown} err - Thrown value (Error, MediaError text, or a decode Event)
 * @param {string} mediaType - 'image' or 'video'
 * @param {string} [fileName] - Original file name, when known
 * @returns {string}
 */
export function describeMediaLoadError(err, mediaType, fileName = '') {
    const name = fileName ? `“${fileName}”` : 'the file'
    const detail = typeof err?.message === 'string' ? err.message : String(err || '')
    const isEvent = typeof Event !== 'undefined' && err instanceof Event

    if (mediaType === 'video') {
        if (detail.startsWith('Video error:')) {
            const code = detail.slice('Video error:'.length).trim()
            if (/DEMUXER|DECODE|NOT_SUPPORTED|UNSUPPORTED|CODE 3|CODE 4/i.test(code)) {
                return `Couldn’t decode ${name} — this browser doesn’t support the video’s format or codec. ${VIDEO_HINT}`
            }
            if (/NETWORK/i.test(code)) {
                return `Couldn’t read ${name} — a network error occurred while opening the video.`
            }
            return `Couldn’t open ${name} as a video. The file may be corrupt or use an unsupported format.`
        }
        return detail || `Couldn’t open ${name} as a video.`
    }

    // Image: an <img> onerror rejection used to surface as an Event with no
    // message at all ("Failed to load media: undefined"), or now as the
    // renderer's decode-failure sentinel.
    if (isEvent || /decode failed/i.test(detail) || !detail) {
        return `Couldn’t decode ${name} — this browser doesn’t support this image format. ${IMAGE_HINT}`
    }
    return `Failed to load media: ${detail}`
}
