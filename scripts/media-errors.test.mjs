import assert from 'node:assert/strict'
import test from 'node:test'
import { describeMediaLoadError } from '../public/js/utils/media-errors.js'

test('an image decode event becomes an actionable format message', () => {
    const err = new Event('error')
    const message = describeMediaLoadError(err, 'image', 'photo.tif')
    assert.match(message, /photo\.tif/)
    assert.match(message, /PNG, JPEG, GIF, or WebP/)
})

test('the image decode sentinel maps to the same message', () => {
    assert.equal(
        describeMediaLoadError(new Error('Image decode failed'), 'image', 'broken.png'),
        describeMediaLoadError(new Event('error'), 'image', 'broken.png'))
})

test('an image decode failure without a file name still names the problem', () => {
    assert.match(describeMediaLoadError(new Event('error'), 'image'), /this browser doesn’t support this image format/)
})

test('a video codec failure suggests an interchangeable codec', () => {
    const message = describeMediaLoadError(
        new Error('Video error: DEMUXER_ERROR_COULD_NOT_OPEN: FFmpegDemuxer: open context failed'),
        'video', 'clip.mov')
    assert.match(message, /clip\.mov/)
    assert.match(message, /H\.264 MP4 or a VP9 WebM/)
})

test('a bare MEDIA_ERR code maps to the codec message', () => {
    assert.match(describeMediaLoadError(new Error('Video error: Code 4'), 'video', 'clip.mkv'), /format or codec/)
})

test('a video network error gets its own message', () => {
    assert.match(describeMediaLoadError(new Error('Video error: NETWORK_ERROR'), 'video'), /network error/)
})

test('a generic video failure names corruption or unsupported formats', () => {
    const message = describeMediaLoadError(new Error('Video error: Code 1'), 'video', 'x.mp4')
    assert.match(message, /corrupt or use an unsupported format/)
})

test('non-decode errors keep their original detail', () => {
    const err = new Error('Could not allocate a canvas to downscale oversized media')
    assert.equal(
        describeMediaLoadError(err, 'image', 'huge.png'),
        'Failed to load media: Could not allocate a canvas to downscale oversized media')
})

test('a null error still produces a usable message', () => {
    assert.match(describeMediaLoadError(null, 'image'), /the file/)
    assert.match(describeMediaLoadError(undefined, 'video'), /the file/)
})
