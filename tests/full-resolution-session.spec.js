import { test, expect } from './fixtures.js'
import * as capture from '../public/js/noisemaker/full-resolution.js'

function harness() {
    const calls = { allocations: 0, compiles: 0, decodes: 0, disposals: 0, releases: 0, frames: [], videoTimes: [] }
    const previousDocument = globalThis.document
    globalThis.document = { createElement: () => ({ width: 0, height: 0, getContext: () => ({ clearRect() {}, drawImage(source) {
        if (source.currentTime !== undefined) calls.videoTimes.push(source.currentTime)
    } }) }) }
    class Detached {
        constructor(canvas) {
            calls.allocations++
            this._layerStepMap = new Map([['photo', 1], ['video', 2]])
            this._renderer = { applyStepParameterValues() {}, async dispose() {
                await new Promise(resolve => setTimeout(resolve, 10)); calls.disposals++
            } }
        }
        async init() {}
        async prepareMediaResource() { calls.decodes++; return { element: {}, width: 128, height: 64 } }
        disposeMediaResource() { calls.releases++ }
        async setLayers() { calls.compiles++; return { success: true } }
        updateLayerTransform() {}
        render(time) { calls.frames.push(time) }
        stop() {}
    }
    const video = { currentTime: 0 }
    const media = new Map([
        ['photo', { type: 'image', width: 128, height: 64, sourceFile: {}, element: { width: 64, height: 32 } }],
        ['video', { type: 'video', width: 128, height: 64, element: {}, videoElement: video }],
    ])
    const owner = {
        constructor: Detached, width: 128, height: 64,
        layers: [...media.keys()].map(id => ({ id, visible: true, sourceType: 'media' })),
        _renderer: { pipeline: { width: 64, height: 32 }, capabilities: { maxTextureSize: 8192 } },
        _maskTextures: new Map(), getMediaInfo: id => media.get(id), getPausedNormalizedTime: () => 0,
    }
    return { owner, calls, video, restore: () => { globalThis.document = previousDocument } }
}

test('24 full-resolution frames reuse one compiled renderer and original image decode, refresh native videos, and await disposal', async () => {
    const { owner, calls, video, restore } = harness()
    let session
    try {
        session = await capture.createFullResolutionCapture(owner)
        for (let frame = 0; frame < 24; frame++) {
            video.currentTime = frame / 24
            const output = await session.render(frame / 24)
            expect([output.width, output.height]).toEqual([128, 64])
        }
        await Promise.all([session.dispose(), session.dispose()])
        expect(calls).toMatchObject({ allocations: 1, compiles: 1, decodes: 1, disposals: 1, releases: 1 })
        expect(calls.frames).toEqual(Array.from({ length: 24 }, (_, n) => n / 24))
        expect(calls.videoTimes.slice(-24)).toEqual(calls.frames)
        await expect(session.render(0)).rejects.toThrow(/disposed/i)
    } finally {
        await session?.dispose()
        restore()
    }
})

for (const failCapture of [false, true]) {
    test(`video exporter reuses and awaits session cleanup when capture ${failCapture ? 'fails' : 'succeeds'}`, async () => {
        const { runVideoExport } = await import('../public/js/ui/video-exporter.js')
        const previousDocument = globalThis.document
        const previousRAF = globalThis.requestAnimationFrame
        globalThis.document = { createElement: () => ({ getContext: () => ({ clearRect() {}, drawImage() {} }) }) }
        globalThis.requestAnimationFrame = callback => setTimeout(callback, 0)
        const calls = [], times = []
        const renderer = {
            isRunning: true, getPausedNormalizedTime: () => 0.25, stop() {}, start: () => calls.push('start'),
            updateVideoTextures() {}, render() {}, restoreLoopFromNormalizedTime() {},
            renderFullResolution: () => { throw new Error('one-frame API must not be called') },
            async createFullResolutionCapture(options) {
                expect(options).toEqual({ width: 128, height: 64 })
                calls.push('allocate')
                return {
                    async render(time) {
                        times.push(time)
                        if (failCapture) throw new Error('capture failed')
                        return { width: 128, height: 64 }
                    },
                    async dispose() { await new Promise(resolve => setTimeout(resolve, 10)); calls.push('dispose') },
                }
            },
        }
        const files = {
            async startRecordingMP4() {}, async encodeVideoFrame() { await new Promise(resolve => setTimeout(resolve, 0)); calls.push('encode') },
            async endRecordingMP4() { calls.push('finalize') }, async cancelMP4() { calls.push('cancel') },
        }
        try {
            const exportPromise = runVideoExport({
                settings: { width: 128, height: 64, framerate: 24, duration: 1, loopCount: 1, format: 'mp4', playFrom: 'current' },
                canvas: {}, renderer, files, getResolution: () => ({ width: 1024, height: 1024 }),
            })
            if (failCapture) await expect(exportPromise).rejects.toThrow('capture failed')
            else await exportPromise
            expect(calls.filter(call => call === 'allocate')).toHaveLength(1)
            expect(calls.filter(call => call === 'encode')).toHaveLength(failCapture ? 0 : 24)
            expect(calls.slice(-2)).toEqual(['dispose', 'start'])
            if (failCapture) expect(calls).toContain('cancel')
            else times.forEach((time, frame) => expect(time).toBeCloseTo((frame / 24 + 0.25) % 1, 12))
        } finally {
            globalThis.document = previousDocument
            globalThis.requestAnimationFrame = previousRAF
        }
    })
}

for (const phase of ['initialization', 'compilation']) {
    test(`capture ${phase} failure releases its detached renderer and decoded sources`, async () => {
        const { owner, calls, restore } = harness()
        const Original = owner.constructor
        owner.constructor = class extends Original {
            async init() { if (phase === 'initialization') throw new Error('initialization failed') }
            async setLayers() { throw new Error('compilation failed') }
        }
        try {
            await expect(capture.createFullResolutionCapture(owner)).rejects.toThrow(`${phase} failed`)
            expect(calls.disposals).toBe(1)
            expect(calls.releases).toBe(phase === 'initialization' ? 0 : 1)
        } finally { restore() }
    })
}

test('capture disposal waits for an active frame and rejects overlapping or subsequent renders', async () => {
    const { owner, calls, restore } = harness()
    let session
    try {
        session = await capture.createFullResolutionCapture(owner)
        const frame = session.render(0)
        await expect(session.render(0.5)).rejects.toThrow(/already rendering/)
        const disposal = session.dispose()
        await expect(session.render(0.75)).rejects.toThrow(/disposed/)
        await frame
        await disposal
        expect(calls.frames).toEqual([0])
        expect(calls.disposals).toBe(1)
    } finally { await session?.dispose(); restore() }
})

for (const path of ['session', 'one-shot', 'legacy']) {
    test(`native video ${path} export renders once per frame, with restoration counted separately`, async () => {
        const { runVideoExport } = await import('../public/js/ui/video-exporter.js')
        const previousDocument = globalThis.document, previousRAF = globalThis.requestAnimationFrame
        const canvas = () => ({ width: 64, height: 64, getContext: () => ({ clearRect() {}, drawImage() {} }) })
        globalThis.document = { createElement: canvas }
        globalThis.requestAnimationFrame = callback => setTimeout(callback, 0)
        let finalized = false
        const exported = [], restored = []
        const owner = { width: 64, height: 64, canvas: canvas(), layers: [], _maskTextures: new Map(), isRunning: false,
            _renderer: { pipeline: { width: 64, height: 64 } }, getPausedNormalizedTime: () => 0.25,
            updateVideoTextures() {}, render: time => (finalized ? restored : exported).push(time) }
        if (path !== 'legacy') owner.renderFullResolution = options => capture.renderFullResolution(owner, options)
        if (path === 'session') owner.createFullResolutionCapture = options => capture.createFullResolutionCapture(owner, options)
        const files = { async startRecordingMP4() {}, async encodeVideoFrame() {}, async endRecordingMP4() { finalized = true } }
        try {
            await runVideoExport({ settings: { width: 64, height: 64, framerate: 4, duration: 1, loopCount: 1, format: 'mp4', playFrom: 'current' },
                canvas: owner.canvas, renderer: owner, files, getResolution: () => ({ width: 64, height: 64 }) })
            expect(exported).toEqual([0.25, 0.5, 0.75, 0])
            expect(restored).toEqual([0.25])
        } finally { globalThis.document = previousDocument; globalThis.requestAnimationFrame = previousRAF }
    })
}

test('video cancellation during capture preparation disposes the session without starting or cancelling an encoder', async () => {
    const { runVideoExport } = await import('../public/js/ui/video-exporter.js')
    const previousDocument = globalThis.document
    globalThis.document = { createElement: () => ({}) }
    const abort = new AbortController(), calls = []
    let prepared
    const preparing = new Promise(resolve => { prepared = resolve })
    let releasePreparation
    const gate = new Promise(resolve => { releasePreparation = resolve })
    const renderer = { isRunning: true, getPausedNormalizedTime: () => 0.25,
        stop: () => calls.push('stop'), start: () => calls.push('start'), updateVideoTextures() {}, restoreLoopFromNormalizedTime() {},
        renderFullResolution() {}, async createFullResolutionCapture() {
            prepared(); await gate
            return { render: () => calls.push('frame'), dispose: async () => { await Promise.resolve(); calls.push('dispose') } }
        } }
    const files = { saveZip: () => calls.push('encoder'), cancelZIP: () => calls.push('cancel'), endRecordingZip: () => calls.push('finalize') }
    try {
        const pending = runVideoExport({ settings: { width: 64, height: 64, framerate: 1, duration: 1, loopCount: 1, format: 'zip', playFrom: 'beginning' },
            canvas: {}, renderer, files, getResolution: () => ({ width: 64, height: 64 }), abortSignal: abort.signal })
        await preparing; abort.abort(); releasePreparation()
        await expect(pending).rejects.toMatchObject({ code: 'JOB_CANCELLED' })
        expect(calls).toEqual(['stop', 'dispose', 'start'])
    } finally { globalThis.document = previousDocument }
})
