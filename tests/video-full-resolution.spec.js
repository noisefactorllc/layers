import { test, expect } from './fixtures.js'

test('video export awaits full-resolution frames and encoder work, reads 2D pixels bottom-up, and restores a paused frame', async ({ page }) => {
    await page.goto('/')
    const result = await page.evaluate(async () => {
        const { runVideoExport } = await import('/js/ui/video-exporter.js')
        const canvas = document.createElement('canvas'); canvas.width = 8; canvas.height = 8
        const captured = [], rendered = [], encoded = []
        const renderer = {
            isRunning: false, getPausedNormalizedTime: () => 0.25,
            updateVideoTextures() {}, render: time => rendered.push(time),
            renderFullResolution: async ({ width, height, normalizedTime }) => {
                await new Promise(resolve => setTimeout(resolve, 15))
                captured.push({ width, height, normalizedTime })
                const frame = document.createElement('canvas'); frame.width = width; frame.height = height
                const ctx = frame.getContext('2d'); ctx.fillStyle = '#f00'; ctx.fillRect(0, 0, width, height / 2)
                ctx.fillStyle = '#00f'; ctx.fillRect(0, height / 2, width, height / 2)
                return frame
            },
        }
        let finalizedAfterFrames = null
        const files = {
            saveZip() {}, cancelZIP() {},
            addZipFrame: async (pixels, settings) => {
                await new Promise(resolve => setTimeout(resolve, 35))
                encoded.push({ first: [...pixels.slice(0,4)], last: [...pixels.slice(-4)], width: settings.width, height: settings.height })
            },
            endRecordingZip: async () => { finalizedAfterFrames = encoded.length },
        }
        const exported = await runVideoExport({
            settings: { width: 128, height: 64, framerate: 2, duration: 1, loopCount: 1, format: 'zip', playFrom: 'current' },
            canvas, renderer, files, getResolution: () => ({ width: 8, height: 8 }),
            setResolution: () => { throw new Error('live document resized') },
        })
        return { captured, encoded, finalizedAfterFrames, lastRender: rendered.at(-1), live: [canvas.width,canvas.height], output: [exported.width,exported.height] }
    })
    expect(result.captured).toEqual([{ width: 128, height: 64, normalizedTime: 0.25 }, { width: 128, height: 64, normalizedTime: 0.75 }])
    expect(result.finalizedAfterFrames).toBe(2)
    expect(result.encoded).toEqual(Array.from({length:2}, () => ({first:[0,0,255,255],last:[255,0,0,255],width:128,height:64})))
    expect(result.lastRender).toBe(0.25)
    expect(result.live).toEqual([8,8])
    expect(result.output).toEqual([128,64])
})

for (const failure of ['capture', 'dimensions', 'late abort']) {
    test(`video ${failure} failure cancels without encoding or success and restores live playback`, async ({ page }) => {
        await page.goto('/')
        const result = await page.evaluate(async failure => {
            const { runVideoExport } = await import('/js/ui/video-exporter.js')
            const canvas = document.createElement('canvas'); canvas.width = 8; canvas.height = 8
            const ac = new AbortController()
            const calls = { stop:0, start:0, cancel:0, encode:0, finalize:0, restored:null }
            const renderer = {
                isRunning:true, getPausedNormalizedTime:()=>0.4,
                stop:()=>calls.stop++, start:()=>calls.start++, restoreLoopFromNormalizedTime:t=>{calls.restored=t},
                updateVideoTextures(){}, render(){},
                renderFullResolution:async()=>{
                    await new Promise(resolve=>setTimeout(resolve,10))
                    if(failure==='capture') throw new Error('capture failed')
                    const frame=document.createElement('canvas'); frame.width=failure==='dimensions'?8:128; frame.height=64
                    if(failure==='late abort') ac.abort()
                    return frame
                },
            }
            const files={startRecordingMP4:async()=>{},cancelMP4:async()=>{calls.cancel++},encodeVideoFrame:()=>calls.encode++,endRecordingMP4:async()=>calls.finalize++}
            try {
                await runVideoExport({settings:{width:128,height:64,framerate:1,duration:1,loopCount:1,format:'mp4',playFrom:'beginning'},
                    canvas,renderer,files,getResolution:()=>({width:8,height:8}),setResolution:()=>{throw new Error('live resized')},abortSignal:ac.signal})
                return {succeeded:true,calls}
            } catch(error) { return {succeeded:false,message:error.message,code:error.code,calls,live:[canvas.width,canvas.height]} }
        }, failure)
        expect(result.succeeded).toBe(false)
        expect(result.calls).toEqual({stop:1,start:1,cancel:1,encode:0,finalize:0,restored:0.4})
        expect(result.live).toEqual([8,8])
        if(failure==='late abort') expect(result.code).toBe('JOB_CANCELLED')
    })
}

test('current-position video export freezes native video frames and restores their original time and playback', async ({ page }) => {
    await page.goto('/')
    const result = await page.evaluate(async () => {
        const { runVideoExport } = await import('/js/ui/video-exporter.js')
        const canvas=document.createElement('canvas'); canvas.width=64; canvas.height=64
        const video=new EventTarget(); let currentTime=2.25
        Object.assign(video,{paused:false,seeking:false,pause(){this.paused=true},async play(){this.paused=false}})
        Object.defineProperty(video,'currentTime',{get:()=>currentTime,set(value){currentTime=value;video.seeking=true;queueMicrotask(()=>{video.seeking=false;video.dispatchEvent(new Event('seeked'))})}})
        const captures=[]
        const renderer={isRunning:false,getPausedNormalizedTime:()=>0.25,updateVideoTextures(){},render(){},
            *getVideoMediaIterator(){yield{videoElement:video,duration:5}},
            renderFullResolution:async()=>{captures.push({time:video.currentTime,paused:video.paused});return canvas}}
        const files={saveZip(){},addZipFrame(){},async endRecordingZip(){},cancelZIP(){}}
        await runVideoExport({settings:{width:64,height:64,framerate:2,duration:1,loopCount:1,format:'zip',playFrom:'current'},
            canvas,renderer,files,getResolution:()=>({width:64,height:64}),setResolution(){}})
        return {captures,time:video.currentTime,paused:video.paused}
    })
    expect(result.captures).toEqual([{time:2.25,paused:true},{time:2.75,paused:true}])
    expect(result.time).toBe(2.25)
    expect(result.paused).toBe(false)
})

for (const duration of [Infinity, NaN, 0, -1]) {
    test(`unknown duration ${duration} rejects video export before changing playback or starting an encoder`, async () => {
        const { runVideoExport } = await import('../public/js/ui/video-exporter.js')
        const calls = []
        const video = { currentTime: 2, paused: false, pause: () => calls.push('pause') }
        const renderer = {
            isRunning: true, getPausedNormalizedTime: () => 0.2,
            getVideoMediaIterator: () => [{ videoElement: video, duration }],
            stop: () => calls.push('stop'), start: () => calls.push('start'),
            restoreLoopFromNormalizedTime() {}, updateVideoTextures() {}, render() {},
            renderFullResolution: async () => { calls.push('capture') },
        }
        const files = { startRecordingMP4: async () => calls.push('encoder') }
        await expect(runVideoExport({
            settings: { width: 64, height: 64, framerate: 1, duration: 1, loopCount: 1, format: 'mp4' },
            canvas: {}, renderer, files, getResolution: () => ({ width: 64, height: 64 }),
        })).rejects.toMatchObject({ code: 'VIDEO_DURATION_UNAVAILABLE' })
        expect(calls).toEqual([])
    })
}

test('reused native video capture preserves original single-pixel detail and refreshes each decoded frame', async ({ page }) => {
    await page.goto('/', { waitUntil: 'networkidle' })
    const { readFile } = await import('node:fs/promises')
    const bytes = await readFile(new URL('./fixtures/native-video-detail.webm', import.meta.url))
    const result = await page.evaluate(async base64 => {
        const app = window.layersApp
        const source = document.createElement('canvas'); source.width = 1800; source.height = 1200
        const ctx = source.getContext('2d')
        // Two deterministic native VP8 frames: one-pixel black line at x=900,
        // then x=901. The fixture includes finite duration metadata.
        const file = new File([Uint8Array.from(atob(base64), c => c.charCodeAt(0))], 'native-detail.webm', { type: 'video/webm' })
        await app._handleOpenMedia(file, 'video'); app._renderer.stop()
        if (!app._layers.length) throw new Error('Native video fixture did not import')
        const media = app._renderer.getMediaInfo(app._layers[0].id)
        const video = media.videoElement; video.pause()
        const seek = time => new Promise((resolve, reject) => {
            if (Math.abs(video.currentTime - time) < 0.000001 && !video.seeking) { resolve(); return }
            const timer = setTimeout(() => reject(new Error('Native fixture seek timed out')), 10000)
            video.addEventListener('seeked', () => { clearTimeout(timer); resolve() }, { once: true })
            video.currentTime = time
        })
        if (!Number.isFinite(video.duration) || video.duration <= 0) throw new Error('Native fixture duration was not resolved')
        const before = [app._canvas.width, app._canvas.height, app._renderer._renderer.pipeline.width, app._renderer._renderer.pipeline.height]
        let allocations = 0
        const Original = app._renderer.constructor
        app._renderer.constructor = class extends Original { constructor(...args) { super(...args); allocations++ } }
        const session = await app._renderer.createFullResolutionCapture()
        const samples = []
        try {
            for (const time of [0.2, 0.9]) {
                await seek(time)
                ctx.clearRect(0, 0, 1800, 1200); ctx.drawImage(video, 0, 0)
                const expected = [...ctx.getImageData(899, 600, 4, 1).data]
                const output = await session.render(time / video.duration)
                samples.push({ expected, actual: [...output.getContext('2d').getImageData(899, 600, 4, 1).data] })
            }
        } finally { await session.dispose(); app._renderer.constructor = Original }
        return { samples, allocations, before, after: [app._canvas.width, app._canvas.height, app._renderer._renderer.pipeline.width, app._renderer._renderer.pipeline.height] }
    }, bytes.toString('base64'))
    expect(result.allocations).toBe(1)
    expect(result.before.slice(0, 2)).toEqual([1800, 1200])
    expect(result.before[2] * result.before[3]).toBeLessThanOrEqual(1024 * 1024)
    expect(result.samples[0].expected[4]).toBeLessThan(50)
    expect(result.samples[1].expected[8]).toBeLessThan(50)
    expect(result.samples[0].actual[8]).toBeGreaterThan(200)
    expect(result.samples[1].actual[4]).toBeGreaterThan(200)
    for (const { expected, actual } of result.samples) {
        expected.forEach((channel, index) => expect(Math.abs(actual[index] - channel)).toBeLessThanOrEqual(2))
    }
    expect(result.after).toEqual(result.before)
})

test('native video export invokes the shader renderer once for each encoded frame and separately restores playback time', async ({ page }) => {
    await page.goto('/', { waitUntil: 'networkidle' })
    const result = await page.evaluate(async () => {
        const { runVideoExport } = await import('/js/ui/video-exporter.js')
        const app = window.layersApp
        const source = document.createElement('canvas'); source.width = 64; source.height = 64
        const ctx = source.getContext('2d'); ctx.fillStyle = '#ff0000'; ctx.fillRect(0, 0, 64, 64)
        const file = new File([await new Promise(resolve => source.toBlob(resolve))], 'native.png', { type: 'image/png' })
        await app._handleOpenMedia(file, 'image'); app._renderer.stop()
        const pausedTime = app._renderer.getPausedNormalizedTime()
        const inner = app._renderer._renderer, render = inner.render
        let finalized = false
        const capturedTimes = [], restoredTimes = [], pixels = []
        inner.render = function (time) { (finalized ? restoredTimes : capturedTimes).push(time); return render.call(this, time) }
        const files = { saveZip() {}, cancelZIP() {}, addZipFrame: frame => pixels.push([...frame.slice(0, 4)]),
            async endRecordingZip() { finalized = true } }
        try {
            await runVideoExport({ settings: { width: 64, height: 64, framerate: 2, duration: 1, loopCount: 1, format: 'zip', playFrom: 'beginning' },
                canvas: app._canvas, renderer: app._renderer, files, getResolution: () => ({ width: 64, height: 64 }) })
        } finally { inner.render = render }
        return { pausedTime, capturedTimes, restoredTimes, pixels }
    })
    expect(result.capturedTimes).toEqual([0, 0.5])
    expect(result.restoredTimes).toEqual([result.pausedTime])
    expect(result.pixels).toEqual([[255, 0, 0, 255], [255, 0, 0, 255]])
})
