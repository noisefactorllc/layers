// The session route of the agent contract: a software agent joins the Seance
// session that a Layers tab took online, runs agent commands in that tab, and
// receives images as bytes. tests/helpers/agent-session.js plays the agent.
import { createHash } from 'node:crypto'
import { deflateSync } from 'node:zlib'
import { test, expect } from './fixtures.js'
import { appReady } from './waits.js'
import { SEANCE_SDK_URL, hasLocalSeanceHarness, routeSeanceSdkLocal, startSeanceServer } from './seanceLocal.js'
import { joinAgentSession, RELAY } from './helpers/agent-session.js'

let seance

// Each case boots its own Seance server and at least one Layers page.
test.describe.configure({ mode: 'parallel' })

test.skip(!hasLocalSeanceHarness(), 'requires a local Seance checkout; set SEANCE_ROOT (or SEANCE_DIST_DIR + SEANCE_PYTHON)')

test.beforeEach(async ({ baseURL }, testInfo) => {
    testInfo.setTimeout(180000)
    seance = await startSeanceServer({ origin: baseURL })
})

test.afterEach(async () => {
    await seance?.stop()
    seance = null
})

const digest = bytes => createHash('sha256').update(bytes).digest('hex')

// A 2x2 PNG of one color.
function png(red, green, blue) {
    const chunk = (type, data) => {
        const body = Buffer.concat([Buffer.from(type), data])
        let crc = 0xffffffff
        for (const byte of body) {
            crc ^= byte
            for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0)
        }
        const length = Buffer.alloc(4)
        const checksum = Buffer.alloc(4)
        length.writeUInt32BE(data.length)
        checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0)
        return Buffer.concat([length, body, checksum])
    }
    const header = Buffer.alloc(13)
    header.writeUInt32BE(2, 0)
    header.writeUInt32BE(2, 4)
    header[8] = 8
    header[9] = 6
    const row = [0, red, green, blue, 255, red, green, blue, 255]
    return Buffer.concat([
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
        chunk('IHDR', header),
        chunk('IDAT', deflateSync(Buffer.from([...row, ...row]))),
        chunk('IEND', Buffer.alloc(0)),
    ])
}

function appPath(params = {}) {
    const url = new URL('/', 'http://localhost:3002')
    url.searchParams.set('seanceUrl', seance.url)
    url.searchParams.set('seanceSdk', SEANCE_SDK_URL)
    if (params.seance) url.searchParams.set('seance', params.seance)
    return `${url.pathname}${url.search}`
}

async function openLayers(page, params = {}) {
    await routeSeanceSdkLocal(page)
    await page.goto(appPath(params), { waitUntil: 'networkidle' })
    await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 25000 })
    await appReady(page)
    await page.evaluate(() => window.LayersAgent.ready)
}

async function takeOnline(page) {
    const code = await page.evaluate(() => window.layersApp._onlineAdapter.takeOnline())
    expect(code).toMatch(/^[A-Za-z0-9]{6}$/)
    return code
}

async function openFileMenu(page) {
    await page.locator('#menu .hf-menubar-trigger', { hasText: 'file' }).click()
    await page.locator('#exportImageMenuItem').waitFor({ state: 'visible' })
}

async function closeMenu(page) {
    await page.keyboard.press('Escape')
    await page.locator('#exportImageMenuItem').waitFor({ state: 'hidden' })
}

function recordSentFrames(page) {
    const sent = []
    page.on('websocket', socket => socket.on('framesent', frame => sent.push(String(frame.payload))))
    return sent
}

function recordImageUploads(page) {
    const uploads = []
    page.on('request', request => {
        if (request.method() === 'POST' && new URL(request.url()).pathname.endsWith('/images')) {
            uploads.push({ type: request.headers()['content-type'], body: request.postDataBuffer() })
        }
    })
    return uploads
}

async function joinAgent(baseURL, code) {
    const agent = await joinAgentSession({ server: seance.url, code, origin: baseURL })
    const answers = await agent.describe()
    expect(answers).toHaveLength(1)
    return { agent, tab: answers[0].tab, describe: answers[0] }
}

test('connect agent walks the person through going online, copying the prompt and the agent joining', async ({ page, context, browserName, baseURL }) => {
    // Chromium reads the real clipboard back. Firefox and WebKit have no
    // clipboard permissions in Playwright, so the test records what the
    // dialog writes through the same clipboard call.
    if (browserName === 'chromium') {
        await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: baseURL })
    } else {
        await page.addInitScript(() => {
            navigator.clipboard.writeText = async text => { window.__copiedPrompt = text }
        })
    }
    await openLayers(page)
    let agent
    try {
        await openFileMenu(page)
        const item = page.locator('#connectAgentMenuItem')
        await expect(item).toBeVisible()
        await expect(item).toHaveText('connect agent...')
        await item.click()

        const dialog = page.locator('#agentConnectDialog dialog')
        await expect(dialog).toBeVisible()
        await expect(dialog.locator('.hf-agent-lead')).toHaveText('To connect an agent, follow these steps:')
        const states = () => dialog.locator('.hf-agent-step').evaluateAll(items => items.map(step => step.dataset.state))
        expect(await states()).toEqual(['active', 'pending', 'pending'])

        await dialog.locator('[data-action="go-online"]').click()
        await expect.poll(states, { timeout: 60000 }).toEqual(['done', 'active', 'pending'])
        const code = new URL(page.url()).searchParams.get('seance')
        expect(code).toMatch(/^[A-Za-z0-9]{6}$/)

        await dialog.locator('[data-action="copy-prompt"]').click()
        await expect.poll(states, { timeout: 30000 }).toEqual(['done', 'done', 'active'])
        const prompt = browserName === 'chromium'
            ? await page.evaluate(() => navigator.clipboard.readText())
            : await page.evaluate(() => window.__copiedPrompt)
        expect(prompt).toBe([
            'Connect to my Layers session and help me with it.',
            'Read https://layers.noisefactor.io/llms-full.txt first.',
            'Then run:',
            '  curl -fsSLO https://noisedeck.app/agent/seance-agent.mjs',
            `  node seance-agent.mjs join '${baseURL}/?seance=${code}'`,
        ].join('\n'))

        // The agent joins with the link that the prompt's last line names.
        const link = /join '([^']+)'$/.exec(prompt.trim().split('\n').at(-1))[1]
        const joined = await joinAgent(baseURL, new URL(link).searchParams.get('seance'))
        agent = joined.agent
        expect(joined.describe.app).toBe('layers')
        await expect.poll(states, { timeout: 30000 }).toEqual(['done', 'done', 'done'])
        await expect(dialog).toBeHidden({ timeout: 10000 })
        await expect(page.locator('#toast-container .toast-message', { hasText: 'Agent connected' })).toBeVisible()

        // Opened again while online, the dialog starts at the prompt and
        // waits for the next agent.
        await openFileMenu(page)
        await page.locator('#connectAgentMenuItem').click()
        await expect(dialog).toBeVisible()
        expect(await states()).toEqual(['done', 'active', 'pending'])
        await expect(dialog.locator('[data-action="copy-prompt"]')).toBeEnabled()
    } finally {
        agent?.close()
    }
})

test('the go online item reads go offline while the session is online', async ({ page }) => {
    await openLayers(page)
    const item = page.locator('#goOnlineMenuItem')
    await openFileMenu(page)
    await expect(item).toHaveText('go online...')
    await closeMenu(page)

    await takeOnline(page)
    await openFileMenu(page)
    await expect(item).toHaveText('go offline...')
    // The same dialog: online, it shows the session link and Go Offline.
    await item.click()
    const dialog = page.locator('#seanceDialog')
    await expect(dialog.locator('dialog')).toBeVisible()
    await expect(dialog.locator('[data-action="go-offline"]')).toBeVisible()
    await dialog.locator('[data-action="go-offline"]').click()
    await expect.poll(() => page.evaluate(() => window.layersApp._onlineAdapter.getStatus())).toBe('offline')
    await page.keyboard.press('Escape')
    await expect(dialog.locator('dialog')).toBeHidden()

    await openFileMenu(page)
    await expect(item).toHaveText('go online...')
    // With the menu open, the label follows the status as it changes.
    await takeOnline(page)
    await expect(item).toHaveText('go offline...')
})

test('only the tab that took the session online answers agents', async ({ page, newContext, baseURL }) => {
    await openLayers(page)
    const code = await takeOnline(page)
    const visitor = await (await newContext()).newPage()
    const visitorSent = recordSentFrames(visitor)
    await openLayers(visitor, { seance: code })
    await expect.poll(() => visitor.evaluate(() => window.layersApp._onlineAdapter.getStatus()), { timeout: 60000 }).toBe('online')

    const { agent, tab, describe } = await joinAgent(baseURL, code)
    try {
        // One answer, from the person's tab, with the session's command list.
        expect(describe.envelope).toMatchObject({ ok: true, command: 'describe', result: { app: 'layers', tab } })
        const commands = Object.fromEntries(describe.envelope.result.commands.map(command => [command.name, command]))
        expect(commands.getThumbnail).toMatchObject({ remote: true, readOnly: true })
        expect(commands.addLayer).toMatchObject({ remote: true, readOnly: false })
        expect(commands.addLayer.args.required).toEqual(['kind'])
        for (const name of ['exportImage', 'listProjects', 'saveProject', 'getSettings']) {
            expect(commands[name].remote, name).toBe(false)
        }
        expect(Object.keys(commands).filter(name => name.startsWith('_'))).toEqual([])
        expect(visitorSent.filter(frame => frame.includes(RELAY))).toEqual([])

        // Only the tab that took the session online offers "connect agent...".
        expect(await page.evaluate(() => window.layersApp._onlineAdapter.canConnectAgent())).toBe(true)
        expect(await visitor.evaluate(() => window.layersApp._onlineAdapter.canConnectAgent())).toBe(false)
        await openFileMenu(visitor)
        await expect(visitor.locator('#goOnlineMenuItem')).toBeVisible()
        await expect(visitor.locator('#connectAgentMenuItem')).toBeHidden()
        await openFileMenu(page)
        await expect(page.locator('#connectAgentMenuItem')).toBeVisible()

        // The person's tab leaves, and Seance makes the visitor the owner. The
        // visitor's tab did not take the session online, so it stays silent.
        const creator = agent.owner
        await page.close()
        await expect.poll(() => agent.owner, { timeout: 20000 }).not.toBe(creator)
        expect(agent.owner).not.toBe(agent.you.user_id)
        expect(await agent.describe()).toEqual([])
        expect(visitorSent.filter(frame => frame.includes(RELAY))).toEqual([])
    } finally {
        agent.close()
    }
})

test('an agent reads, changes and looks at the composition, and images cross only as bytes', async ({ page, baseURL }) => {
    await openLayers(page)
    const sent = recordSentFrames(page)
    const uploads = recordImageUploads(page)
    const code = await takeOnline(page)
    const { agent, tab } = await joinAgent(baseURL, code)
    try {
        const read = await agent.call(tab, 'getState')
        expect(read.envelope.ok).toBe(true)
        const layerCount = await page.evaluate(() => window.layersApp._layers.length)
        expect(read.envelope.result.layers).toHaveLength(layerCount)
        // What the person keeps in this browser stays out of the session.
        for (const state of [read.envelope.result, read.envelope.state]) {
            for (const key of ['settings', 'recentExports', 'jobs', 'foreground']) expect(state[key], key).toBeUndefined()
            expect(Object.keys(state.project).sort()).toEqual(['canRedo', 'canUndo'])
        }

        const added = await agent.call(tab, 'addLayer', { kind: 'effect', effectId: 'synth/gradient', name: 'from the agent' })
        expect(added.envelope.ok, JSON.stringify(added.envelope.error)).toBe(true)
        const layerId = added.envelope.result.layerId
        await expect(page.locator(`layer-item[data-layer-id="${layerId}"]`)).toBeVisible({ timeout: 30000 })
        expect(await page.evaluate(id => window.layersApp._layers.find(layer => layer.id === id)?.name, layerId)).toBe('from the agent')

        const look = await agent.call(tab, 'getThumbnail', { maxDimension: 48, format: 'png' })
        expect(look.envelope.ok, JSON.stringify(look.envelope.error)).toBe(true)
        const result = look.envelope.result
        expect(result.bytes).toBeUndefined()
        expect(result).toMatchObject({ mimeType: 'image/png', format: 'png', image: { mimeType: 'image/png' } })
        expect(Math.max(result.width, result.height)).toBe(48)
        const image = await agent.getImage(result.image.id)
        expect(image.mimeType).toBe('image/png')
        expect(image.bytes.subarray(1, 4).toString()).toBe('PNG')
        expect(image.bytes.length).toBe(result.image.bytes)
        expect(digest(image.bytes)).toBe(result.image.id)
        // The tab uploaded the PNG as the request body. (WebKit does not
        // expose binary request bodies to the test.)
        expect(uploads.some(upload => upload.type === 'image/png'
            && (upload.body === null || upload.body.equals(image.bytes)))).toBe(true)
        // No frame from the tab carried the image, or any image, as text.
        expect(sent.filter(frame => frame.includes(image.bytes.toString('base64'))
            || /data:image|[A-Za-z0-9+/]{200,}/.test(frame))).toEqual([])

        // The person's stored data, downloads and media from outside the
        // session are not reachable.
        for (const [command, args] of [['listProjects', {}], ['exportImage', { format: 'png' }], ['saveProject', { name: 'x' }]]) {
            const refused = await agent.call(tab, command, args)
            expect(refused.envelope.error?.code, command).toBe('REMOTE_UNAVAILABLE')
        }
        const asText = await agent.call(tab, 'pasteImageFromBytes', { source: { kind: 'base64', data: png(255, 0, 0).toString('base64'), mimeType: 'image/png' } })
        expect(asText.envelope.error?.code).toBe('IMAGE_AS_TEXT')
        const linked = await agent.call(tab, 'addLayer', { kind: 'media', mediaType: 'image', source: { kind: 'url', value: 'https://example.invalid/a.png' } })
        expect(linked.envelope.error?.code).toBe('OUTSIDE_LINK')
        const unknown = await agent.call(tab, '_ping')
        expect(unknown.envelope.error?.code).toBe('NOT_FOUND_COMMAND')

        // An image the agent adds to the session becomes a layer.
        const red = png(255, 0, 0)
        const put = await agent.putImage(red, 'image/png')
        expect(put.id).toBe(digest(red))
        const pasted = await agent.call(tab, 'pasteImageFromBytes', { source: { kind: 'url', value: `image:${put.id}` }, name: 'red' })
        expect(pasted.envelope.ok, JSON.stringify(pasted.envelope.error)).toBe(true)
        await expect.poll(() => page.evaluate(id => {
            const layer = window.layersApp._layers.find(candidate => candidate.id === id)
            return layer && { sourceType: layer.sourceType, imageId: layer.imageId }
        }, pasted.envelope.result.layerId), { timeout: 60000 }).toEqual({ sourceType: 'media', imageId: put.id })
        const media = (await agent.call(tab, 'getLayer', { layerId: pasted.envelope.result.layerId })).envelope.result.media
        expect(media).toMatchObject({ type: 'image', width: 2, height: 2 })
        expect(media.filename).toBeUndefined()
    } finally {
        agent.close()
    }
})

test('an agent reply waits for a delayed binary image publication', async ({ page, baseURL }) => {
    await openLayers(page)
    const code = await takeOnline(page)
    const { agent, tab } = await joinAgent(baseURL, code)
    let releaseUpload
    try {
        const put = await agent.putImage(png(255, 0, 0), 'image/png')
        let uploading = false
        const held = new Promise(resolve => { releaseUpload = resolve })
        await page.route('**/v1/sessions/*/images', async route => {
            if (route.request().method() === 'POST') {
                uploading = true
                await held
            }
            await route.continue()
        })
        const pending = agent.call(tab, 'pasteImageFromBytes', {
            source: { kind: 'url', value: `image:${put.id}` }, name: 'slow upload',
        })
        await expect.poll(() => uploading).toBe(true)
        expect(await Promise.race([
            pending.then(() => 'replied'),
            new Promise(resolve => setTimeout(() => resolve('waiting'), 650)),
        ])).toBe('waiting')
        releaseUpload()
        const reply = await pending
        expect(reply.envelope.ok, JSON.stringify(reply.envelope.error)).toBe(true)
        expect(agent.frames.some(frame => frame.type === 'poly-token-upsert'
            && frame.text?.includes(put.id))).toBe(true)
    } finally {
        releaseUpload?.()
        agent.close()
    }
})

test('through a session, undo stops at the composition the session started with', async ({ page, baseURL }) => {
    await openLayers(page)
    // Offline, the person adds an image and deletes it again.
    const offline = await page.evaluate(async (data) => {
        const pasted = await window.LayersAgent.pasteImageFromBytes({ source: { kind: 'base64', data, mimeType: 'image/png' }, name: 'private' })
        const removed = await window.LayersAgent.deleteLayer({ layerId: pasted.result.layerId })
        return { pasted: pasted.ok, removed: removed.ok, canUndo: removed.state.project.canUndo }
    }, png(0, 0, 255).toString('base64'))
    expect(offline).toEqual({ pasted: true, removed: true, canUndo: true })
    const uploads = recordImageUploads(page)
    const code = await takeOnline(page)
    const { agent, tab } = await joinAgent(baseURL, code)
    try {
        const refused = await agent.call(tab, 'undo')
        expect(refused.envelope.error?.code).toBe('CONFLICT_BEFORE_SESSION')
        expect(refused.envelope.state.project).toEqual({ canUndo: false, canRedo: false })

        const added = await agent.call(tab, 'addLayer', { kind: 'drawing', name: 'agent drawing' })
        expect(added.envelope.ok).toBe(true)
        expect(added.envelope.state.project.canUndo).toBe(true)
        const undone = await agent.call(tab, 'undo')
        expect(undone.envelope.ok, JSON.stringify(undone.envelope.error)).toBe(true)
        expect(undone.envelope.state.layers.some(layer => layer.id === added.envelope.result.layerId)).toBe(false)
        expect((await agent.call(tab, 'undo')).envelope.error?.code).toBe('CONFLICT_BEFORE_SESSION')
        expect((await agent.call(tab, 'redo')).envelope.ok).toBe(true)

        // The deleted image never went into the session.
        expect(await page.evaluate(() => window.layersApp._layers.some(layer => layer.sourceType === 'media'))).toBe(false)
        expect(uploads).toEqual([])
    } finally {
        agent.close()
    }
})

test('a request waiting its turn does not run once the person goes offline', async ({ page, baseURL }) => {
    await openLayers(page)
    const received = []
    page.on('websocket', socket => socket.on('framereceived', frame => received.push(String(frame.payload))))
    const code = await takeOnline(page)
    const { agent, tab } = await joinAgent(baseURL, code)
    try {
        const before = await page.evaluate(() => window.layersApp._layers.map(layer => layer.id))
        // A command of the person's own holds the queue.
        await page.evaluate(() => { window.__held = window.LayersAgent._sleep({ delayMs: 4000 }) })
        agent.call(tab, 'addLayer', { kind: 'drawing', name: 'late' }, { timeoutMs: 15000 }).catch(() => {})
        await expect.poll(() => received.some(frame => frame.includes('"command":"addLayer"'))).toBe(true)
        await page.evaluate(() => window.layersApp._onlineAdapter.goOffline())
        // getState queues behind the agent's request, so it has had its turn.
        await page.evaluate(async () => {
            await window.__held
            await window.LayersAgent.getState()
        })
        expect(await page.evaluate(() => window.layersApp._layers.map(layer => layer.id))).toEqual(before)
    } finally {
        agent.close()
    }
})

test('a failed switch to another session leaves the tab answering its own', async ({ page, baseURL }) => {
    await openLayers(page)
    const code = await takeOnline(page)
    const { agent, tab } = await joinAgent(baseURL, code)
    try {
        const switched = await page.evaluate(() => window.layersApp._onlineAdapter.joinSession('zz9zz9', { skipConfirm: true }))
        expect(switched).toBeNull()
        expect(await page.evaluate(() => window.layersApp._onlineAdapter.getStatus())).toBe('online')
        const answers = await agent.describe()
        expect(answers.map(answer => answer.tab)).toEqual([tab])
        expect((await agent.call(tab, 'getCanvasSize')).envelope.ok).toBe(true)
        expect(await page.evaluate(() => window.layersApp._onlineAdapter.canConnectAgent())).toBe(true)
    } finally {
        agent.close()
    }
})

test('an edit still waiting for its undo step when the session starts counts as the session\'s start', async ({ page, baseURL }) => {
    await openLayers(page)
    // The person is still dragging an opacity slider as the session goes online.
    const code = await page.evaluate(async () => {
        const app = window.layersApp
        app._sliderDragActive = true
        app._layers.at(-1).opacity = 40
        app._pushUndoStateDebounced()
        const sessionId = await app._onlineAdapter.takeOnline()
        app._sliderDragActive = false
        app._finalizePendingUndo()
        return sessionId
    })
    const { agent, tab } = await joinAgent(baseURL, code)
    try {
        const refused = await agent.call(tab, 'undo')
        expect(refused.envelope.error?.code).toBe('CONFLICT_BEFORE_SESSION')
        expect(await page.evaluate(() => window.layersApp._layers.at(-1).opacity)).toBe(40)
    } finally {
        agent.close()
    }
})

test('the person\'s tab answers again after they reload it', async ({ page, baseURL }) => {
    await openLayers(page)
    const code = await takeOnline(page)
    const { agent, tab } = await joinAgent(baseURL, code)
    try {
        await page.reload({ waitUntil: 'networkidle' })
        await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 25000 })
        await expect.poll(() => page.evaluate(() => window.layersApp?._onlineAdapter?.getStatus()), { timeout: 60000 }).toBe('online')
        await page.evaluate(() => window.LayersAgent.ready)
        let answers = []
        await expect.poll(async () => {
            answers = await agent.describe()
            return answers.length
        }, { timeout: 30000 }).toBe(1)
        expect(answers[0].tab).not.toBe(tab)
        const read = await agent.call(answers[0].tab, 'getCanvasSize')
        expect(read.envelope).toMatchObject({ ok: true, command: 'getCanvasSize' })
        expect(await page.evaluate(() => window.layersApp._onlineAdapter.canConnectAgent())).toBe(true)
    } finally {
        agent.close()
    }
})
