import { test, expect } from './fixtures.js'
import { readFile } from 'node:fs/promises'
import { EyedropperTool } from '../public/js/tools/eyedropper-tool.js'

// Evaluate the actual app class without booting its DOM/CDN dependencies.
// These tests exercise lifecycle and error contracts, not shader rendering.
const appSource = await readFile(new URL('../public/js/app.js', import.meta.url), 'utf8')
function appHarness() {
    const errors = [], overlay = new EventTarget(), document = new EventTarget(), window = new EventTarget()
    overlay.style = {}
    const OffscreenCanvas = class { getContext() { return { drawImage() {} } } }
    const App = new Function('toast', 'document', 'window', 'OffscreenCanvas', 'getSelectionBounds',
        `return ${appSource.slice(appSource.indexOf('class LayersApp'), appSource.indexOf('// Initialize app when DOM is ready'))}`)(
        { error: message => errors.push(message) }, document, window, OffscreenCanvas,
        () => ({ x: 0, y: 0, width: 16, height: 16 }))
    const app = Object.create(App.prototype)
    Object.assign(app, { _canvas: { width: 32, height: 32 }, _selectionOverlay: overlay,
        _selectionManager: { enabled: true }, _replacementGeneration: 1 })
    return { app, errors, overlay, document }
}
const unsupported = () => Object.assign(new Error('This effect graph exceeds the full-resolution GPU memory budget'), { code: 'FULL_RESOLUTION_UNSUPPORTED' })

for (const reactivate of [false, true]) {
    test(`late eyedropper capture cannot change color or tools after ${reactivate ? 'reactivation' : 'deactivation'}`, async () => {
        let resolveCapture
        const capture = new Promise(resolve => { resolveCapture = resolve })
        const effects = []
        const overlay = { width: 1, height: 1, getBoundingClientRect: () => ({ left: 0, top: 0, width: 1, height: 1 }), addEventListener() {}, removeEventListener() {} }
        const tool = new EyedropperTool({ overlay, canvas: { width: 1, height: 1 }, captureCanvas: () => capture,
            runMutation: task => task(), setForegroundColor: color => effects.push(color), restorePreviousTool: () => effects.push('restore') })
        tool.activate()
        const pending = tool._onClick({ clientX: 0, clientY: 0 })
        tool.deactivate()
        if (reactivate) tool.activate()
        resolveCapture({ getContext: () => ({ readPixels: (x, y, w, h, f, t, bytes) => bytes.set([255, 0, 0, 255]) }) })
        await pending
        expect(effects).toEqual([])
    })
}

test('selected composite preserves unsupported capture error after restoring the live stage', async () => {
    const { app } = appHarness(); const error = unsupported(); let rollbacks = 0
    app._layers = [{ id: 'photo', visible: true }]
    app._renderer = { _mediaTextures: new Map(), _maskTextures: new Map(), getPausedNormalizedTime: () => 0, render() {},
        stageLayerSet: async () => ({ success: true, rollback: async () => { rollbacks++; return { success: true } } }) }
    app._captureFullResolutionFrame = async () => { throw error }
    await expect(app._renderLayerComposite(['photo'])).rejects.toBe(error)
    expect(rollbacks).toBe(1)
})

test('crop preserves the unsupported capture error for the pointer error reporter', async () => {
    const { app } = appHarness(); const error = unsupported()
    app._selectionManager = { hasSelection: () => true, selectionPath: {} }
    app._layers = [{ id: 'photo', sourceType: 'media', mediaType: 'image' }]
    app._cloneLayers = layers => layers.map(layer => ({ ...layer }))
    app._renderLayerComposite = async () => { throw error }
    await expect(app._cropToSelection()).rejects.toBe(error)
})

for (const cancel of [false, true]) {
    test(`color-range capture ${cancel ? 'cancellation retains ownership until completion' : 'failure reports the error and releases ownership'}`, async () => {
        const { app, errors, overlay, document } = appHarness()
        let resolveCapture, rejectCapture, references = 1, calls = 0
        const capture = new Promise((resolve, reject) => { resolveCapture = resolve; rejectCapture = reject })
        app._tryAcquireProjectLifecycle = () => ({ retain() { references++; return true }, release() { references-- } })
        app._handleColorRangePick = async () => { calls++; return capture }
        let clickHandler
        const originalAdd = overlay.addEventListener.bind(overlay)
        overlay.addEventListener = (name, handler, ...args) => {
            if (name === 'click') clickHandler = handler
            originalAdd(name, handler, ...args)
        }
        app._startColorRangePick()
        const handlerPromise = clickHandler(new Event('click'))
        await clickHandler(new Event('click')) // Duplicate clicks must not start another capture.
        if (cancel) {
            const escape = new Event('keydown'); Object.defineProperty(escape, 'key', { value: 'Escape' }); document.dispatchEvent(escape)
            expect(references).toBe(1)
            resolveCapture()
        } else rejectCapture(unsupported())
        await expect(handlerPromise).resolves.toBeUndefined()
        expect(references).toBe(0)
        expect(app._colorRangePicking).toBe(false)
        expect(app._selectionManager.enabled).toBe(true)
        expect(errors).toEqual(cancel ? [] : [unsupported().message])
        expect(calls).toBe(1)
    })
}

test('native full-resolution app capture refreshes once and renders exactly one frame at the requested time', async () => {
    const capture = await import('../public/js/noisemaker/full-resolution.js')
    const { app } = appHarness()
    const previousDocument = globalThis.document
    globalThis.document = { createElement: () => ({ getContext: () => ({ clearRect() {}, drawImage() {} }) }) }
    const times = []
    const owner = { width: 64, height: 64, canvas: {}, layers: [], _maskTextures: new Map(),
        _renderer: { pipeline: { width: 64, height: 64 } }, getPausedNormalizedTime: () => 0.25,
        render: time => times.push(time), renderFullResolution: options => capture.renderFullResolution(owner, options) }
    app._renderer = owner
    const refresh = app._renderCurrentFrame.bind(app)
    let freshFrameCalls = 0
    app._renderCurrentFrame = (...args) => { freshFrameCalls++; return refresh(...args) }
    try {
        const canvas = await app._captureFullResolutionFrame({ normalizedTime: 0.5 })
        expect([canvas.width, canvas.height]).toEqual([64, 64])
        expect(times).toEqual([0.5])
        expect(freshFrameCalls).toBe(1)
    } finally { globalThis.document = previousDocument }
})

test('staged layer composite requests its stable zero frame without a redundant live render', async () => {
    const { app } = appHarness(); const error = unsupported(); const times = [], captures = []
    app._layers = [{ id: 'photo', visible: true }]
    app._renderer = { _mediaTextures: new Map(), _maskTextures: new Map(), getPausedNormalizedTime: () => 0.25,
        render: time => times.push(time), stageLayerSet: async () => ({ success: true, rollback: async () => ({ success: true }) }) }
    app._captureFullResolutionFrame = async options => { captures.push(options); throw error }
    await expect(app._renderLayerComposite(['photo'])).rejects.toBe(error)
    expect(captures).toEqual([{ normalizedTime: 0 }])
    expect(times).toEqual([0.25]) // Only restore the original live frame.
})

test('native app capture invokes the real shader renderer once and returns its fresh pixels', async ({ page }) => {
    await page.goto('/', { waitUntil: 'networkidle' })
    const result = await page.evaluate(async () => {
        const app = window.layersApp
        const source = document.createElement('canvas'); source.width = 64; source.height = 64
        const ctx = source.getContext('2d'); ctx.fillStyle = '#ff0000'; ctx.fillRect(0, 0, 64, 64)
        const file = new File([await new Promise(resolve => source.toBlob(resolve))], 'native-frame.png', { type: 'image/png' })
        await app._handleOpenMedia(file, 'image'); app._renderer.stop()
        const inner = app._renderer._renderer
        const render = inner.render
        let renders = 0
        inner.render = function (...args) { renders++; return render.apply(this, args) }
        try {
            const canvas = await app._captureFullResolutionFrame({ normalizedTime: 0.5 })
            return { renders, pixel: [...canvas.getContext('2d').getImageData(32, 32, 1, 1).data] }
        } finally { inner.render = render }
    })
    expect(result.renders).toBe(1)
    expect(result.pixel).toEqual([255, 0, 0, 255])
})
