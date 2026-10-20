import { test, expect } from './fixtures.js'

// Parallel mode makes each case its own sharding unit: every case here boots
// its own app and shares no state with its siblings, so shards can split this
// file instead of pinning all of it to one runner.
test.describe.configure({ mode: 'parallel' })

test.describe('LayersAgent foundation', () => {
    test('exposes version 1.0', async ({ page }) => {
        await page.goto('/', { waitUntil: 'networkidle' })
        await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })
        const version = await page.evaluate(() => window.LayersAgent?.version)
        expect(version).toBe('1.0')
    })

    test('ready promise resolves after init', async ({ page }) => {
        await page.goto('/', { waitUntil: 'networkidle' })
        await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })
        const ready = await page.evaluate(async () => {
            await window.LayersAgent.ready
            return true
        })
        expect(ready).toBe(true)
    })

    test('describes every public command for llms-full.txt', async ({ page }) => {
        await page.goto('/', { waitUntil: 'networkidle' })
        await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })
        const { live, described } = await page.evaluate(async () => {
            await window.LayersAgent.ready
            const agent = window.LayersAgent
            const live = Object.keys(agent)
                .filter(k => typeof agent[k] === 'function' && !k.startsWith('_'))
            const { COMMAND_GROUPS } = await import('/js/agent/descriptions.js')
            return { live, described: COMMAND_GROUPS.flatMap(g => Object.keys(g.commands)) }
        })
        expect([...described].sort()).toEqual([...live].sort())
    })
})

test.describe('LayersAgent envelopes', () => {
    test('lists, restores, and discards recovery copies by id', async ({ page }) => {
        await page.goto('/', { waitUntil: 'networkidle' })
        await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })
        const result = await page.evaluate(async () => {
            await window.LayersAgent.ready
            const app = window.layersApp
            const original = app._recovery
            const originalLoad = app._loadProject
            let loaded = false
            app._recovery = {
                list: async () => [{ id: 'copy-1', name: 'Draft', canvasWidth: 32,
                    canvasHeight: 16, layers: [], modifiedAt: 123 }],
                restore: async (id, load) => id === 'copy-1' && load({
                    id, name: 'Draft', canvasWidth: 32, canvasHeight: 16, layers: [],
                }),
                discard: async id => id === 'copy-1',
            }
            app._loadProject = async (_id, options) => {
                loaded = !!options.recovery && !!options.mutationToken
                return 'opened'
            }
            try {
                const listed = await window.LayersAgent.listRecoveryCopies()
                const restored = await window.LayersAgent.restoreRecoveryCopy({ id: 'copy-1' })
                const discarded = await window.LayersAgent.discardRecoveryCopy({ id: 'copy-1' })
                return { listed, restored, discarded, loaded }
            } finally {
                app._recovery = original
                app._loadProject = originalLoad
            }
        })
        expect(result.listed.result.copies).toEqual([{
            id: 'copy-1', name: 'Draft', width: 32, height: 16,
            layerCount: 0, modifiedAt: 123,
        }])
        expect(result.loaded).toBe(true)
        expect(result.restored.ok).toBe(true)
        expect(result.discarded.ok).toBe(true)
    })
    test('controls online session transitions through the application adapter', async ({ page }) => {
        await page.goto('/', { waitUntil: 'networkidle' })
        await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })
        const result = await page.evaluate(async () => {
            await window.LayersAgent.ready
            const app = window.layersApp
            const adapter = {
                status: 'offline',
                getStatus() { return this.status },
                async takeOnline() {
                    const token = await app._acquireProjectLifecycle()
                    try { this.status = 'online'; return 'session-1' }
                    finally { token.release() }
                },
                async joinSession(id, options) {
                    if (!options.skipConfirm) throw new Error('Expected agent-safe join')
                    this.status = 'online'
                    return id
                },
                goOffline() { this.status = 'offline' },
                get online() { return {
                    getSessionId: () => 'session-1',
                    getShareUrl: () => 'https://example.invalid/session-1',
                } },
            }
            app._onlineAdapter = adapter
            const started = await window.LayersAgent.takeOnline()
            const joined = await window.LayersAgent.joinSession({ sessionId: 'session-2' })
            const stopped = await window.LayersAgent.goOffline()
            return { started, joined, stopped }
        })
        expect(result.started.ok).toBe(true)
        expect(result.started.state.collaboration.status).toBe('online')
        expect(result.joined.ok).toBe(true)
        expect(result.joined.result.sessionId).toBe('session-2')
        expect(result.stopped.ok).toBe(true)
        expect(result.stopped.state.collaboration.status).toBe('offline')
    })
    test('online transition rejects media and child masks before opening a blocking dialog', async ({ page }) => {
        await page.goto('/', { waitUntil: 'networkidle' })
        await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })
        const result = await page.evaluate(async () => {
            await window.LayersAgent.ready
            const app = window.layersApp
            const originalLayers = app._layers
            const originalAdapter = app._onlineAdapter
            let called = 0
            app._onlineAdapter = { async takeOnline() { called++; return 'unexpected' } }
            try {
                app._layers = [{ id: 'media', sourceType: 'media', mediaType: 'video' }]
                const media = await window.LayersAgent.takeOnline()
                app._layers = [{ id: 'masked', children: [{ id: 'child', mask: {} }] }]
                const childMask = await window.LayersAgent.takeOnline()
                app._layers = []
                app._onlineAdapter.takeOnline = async () => {
                    app._layers = [{ id: 'late-video', sourceType: 'media', mediaType: 'video' }]
                    return null
                }
                const lateMedia = await window.LayersAgent.takeOnline()
                return { media, childMask, lateMedia, called }
            } finally {
                app._layers = originalLayers
                app._onlineAdapter = originalAdapter
            }
        })
        expect(result.media.ok).toBe(false)
        expect(result.media.error.code).toBe('CONFLICT_SESSION_TRANSITION')
        expect(result.childMask.ok).toBe(false)
        expect(result.childMask.error.code).toBe('CONFLICT_SESSION_TRANSITION')
        expect(result.lateMedia.error.details.reason).toBe('unsupported-media')
        expect(result.called).toBe(0)
    })
    test('successful command returns ok envelope with apiVersion', async ({ page }) => {
        await page.goto('/', { waitUntil: 'networkidle' })
        await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })
        await page.evaluate(async () => { await window.LayersAgent.ready })
        const env = await page.evaluate(() => window.LayersAgent._ping())
        expect(env.ok).toBe(true)
        expect(env.command).toBe('_ping')
        expect(env.apiVersion).toBe('1.0')
        expect(env.result).toEqual({ pong: true })
    })

    test('serializes parallel calls in order', async ({ page }) => {
        await page.goto('/', { waitUntil: 'networkidle' })
        await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })
        await page.evaluate(async () => { await window.LayersAgent.ready })
        const order = await page.evaluate(async () => {
            const events = []
            window.__pingHook = (label) => events.push(label)
            await Promise.all([
                window.LayersAgent._ping().then(() => events.push('done-1')),
                window.LayersAgent._ping().then(() => events.push('done-2')),
                window.LayersAgent._ping().then(() => events.push('done-3'))
            ])
            return events
        })
        expect(order).toEqual(['done-1', 'done-2', 'done-3'])
    })
})
