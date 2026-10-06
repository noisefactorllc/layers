import { test, expect } from './fixtures.js'
import { appReady, appState, framePainted, quietWindow } from './waits.js'
import { SEANCE_SDK_URL, hasLocalSeanceHarness, localServerPrunesImages, localSdkSupportsImages, routeSeanceSdkLocal, startSeanceServer } from './seanceLocal.js'
import { reopenNewProjectDialog } from './helpers/new-project.js'

let seance

// Each case here boots its own Seance server and drives two pages through a
// real convergence, so this is the most expensive file in the suite by a wide
// margin. Sharding splits the run by file unless a file says otherwise, which
// would pin the whole thing to one runner and make that shard the harness's
// wall clock no matter how many shards the others get. Parallel mode makes
// each case its own unit, so the shards can carry a share each. Nothing here
// is shared between cases: `seance` is set per case below, and every case
// gets its own page and its own database.
test.describe.configure({ mode: 'parallel' })

test.skip(!hasLocalSeanceHarness(), 'requires a local Seance checkout; set SEANCE_ROOT (or SEANCE_DIST_DIR + SEANCE_PYTHON)')

test.beforeEach(async ({ baseURL }, testInfo) => {
    // Convergence tests chain several expect.poll() waits against a real
    // local server, and this suite must also survive CPU-starved parallel
    // full-suite runs (software WebGL × N workers), where a single boot or
    // join can take 10x its isolated wall-clock. Budgets are sized for that
    // contended case.
    testInfo.setTimeout(180000)
    // Each case gets an independent database and rate-limit window. Sharing
    // one server exhausted its real anonymous session-creation limit.
    // The server's allowed-origin list must match the origin the app is
    // actually served from, which varies with the config in use.
    seance = await startSeanceServer({ origin: baseURL })
})

test.afterEach(async () => {
    await seance?.stop()
    seance = null
})

// ---------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------

async function preparePage(page) {
    await routeSeanceSdkLocal(page)
    await page.addInitScript(() => {
        Object.defineProperty(navigator, 'clipboard', {
            configurable: true,
            value: {
                async writeText(text) { window.__clipboardText = text },
                async readText() { return window.__clipboardText || '' },
            },
        })
    })
}

function appPath(params = {}) {
    const url = new URL('/', 'http://localhost:3002')
    url.searchParams.set('seanceUrl', seance.url)
    url.searchParams.set('seanceSdk', SEANCE_SDK_URL)
    if (params.seance) url.searchParams.set('seance', params.seance)
    return `${url.pathname}${url.search}`
}

async function gotoApp(page, params = {}) {
    await page.goto(appPath(params), { waitUntil: 'networkidle' })
    await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 25000 })
}

// 512 preset default: quarters the composited-frame raster cost on software-
// rendered CI (the webkit 4/10 shard cap). Every pixel read in this suite is
// fractional/relative to canvas.width, so the boot size is free; explicit
// sizes (128/400) still override for their tests.
async function createProject(page, type = 'transparent', size = 512) {
    await reopenNewProjectDialog(page)
    await page.click(`.media-option[data-type="${type}"]`)
    await page.waitForSelector('.canvas-size-dialog', { timeout: 15000 })
    if (size) {
        await page.locator('#canvas-width').fill(String(size))
        await page.locator('#canvas-height').fill(String(size))
    }
    await page.click('.canvas-size-dialog .action-btn.primary')
    await page.waitForSelector('.open-dialog-backdrop.visible', { state: 'hidden', timeout: 5000 })
    await appReady(page)
}

async function openFileMenu(page) {
    // The bar renders one panel per menu and the logo menu's panel is first in
    // the DOM, so `.hf-menubar-panel` first() is a panel this click never
    // opens: it stays hidden and the wait burns the whole test timeout. Wait
    // on an item the File menu owns instead. That proves the right panel, and
    // the id belongs to Layers rather than to the component's own markup, so a
    // handfish release cannot quietly move it.
    await page.locator('#menu .hf-menubar-trigger', { hasText: 'file' }).click()
    await page.locator('#exportImageMenuItem').waitFor({ state: 'visible' })
}

async function openSeanceDialog(page) {
    await openFileMenu(page)
    await page.click('#goOnlineMenuItem')
    await expect(page.locator('#seanceDialog dialog')).toBeVisible()
}

// seance-dialog wraps a native <dialog> shown via showModal(), which blocks
// pointer events on the rest of the page while open (by design). Tests that
// need to drive real mouse/keyboard interaction with the canvas/toolbar
// after taking online or joining must close it first.
async function closeSeanceDialog(page) {
    await page.keyboard.press('Escape')
    await expect(page.locator('#seanceDialog dialog')).toBeHidden()
}

async function takeOnline(page) {
    await openSeanceDialog(page)
    await page.locator('#seanceDialog [data-action="take-online"]').click()
    await expect(page.locator('#seanceDialog .hf-seance-status-text')).toHaveText('Online', { timeout: 60000 })
    const sessionId = await page.locator('#seanceDialog').evaluate((el) => el.sessionId)
    expect(sessionId).toMatch(/^[A-Za-z0-9]{6}$/)
    return sessionId
}

async function joinById(page, sessionId) {
    await openSeanceDialog(page)
    const dialog = page.locator('#seanceDialog')
    await dialog.locator('.hf-seance-join-input').fill(sessionId)
    await dialog.locator('[data-action="join"]').click()
    // Joining over a non-empty local composition confirms first (design doc
    // §6); the adapter closes the (native, top-layer) seance-dialog before
    // showing that (plain-div) confirm so it's actually visible — dismiss it
    // if the joiner already has a project open, then check status via the
    // app directly since the seance-dialog itself may now be closed.
    const confirmOk = page.locator('.confirm-dialog-backdrop.visible #confirm-ok')
    if (await confirmOk.isVisible({ timeout: 2000 }).catch(() => false)) {
        await confirmOk.click()
    }
    await expect.poll(() => page.evaluate(() => window.layersApp._onlineAdapter?.getStatus()), { timeout: 60000 }).toBe('online')
}

async function layersState(page) {
    return page.evaluate(() => window.layersApp._layers.map(l => ({
        id: l.id, name: l.name, sourceType: l.sourceType, opacity: l.opacity,
        blendMode: l.blendMode, effectId: l.effectId, visible: l.visible,
        strokeCount: l.strokes?.length || 0, hasMask: !!l.mask,
    })))
}

// ---------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------

test('go online menu item is visible by default and the dialog stays closed until opened', async ({ page }) => {
    await preparePage(page)
    await gotoApp(page)
    // Preserved 1024 case: the suite defaults to the 512 preset for shard
    // cost (see createProject), but one boot keeps default-resolution
    // coverage of the online menu surface. No canvas reads in this test.
    await createProject(page, 'transparent', 1024)

    await openFileMenu(page)
    await expect(page.locator('#goOnlineMenuItem')).toBeVisible()
    await expect(page.locator('#onlineCollabMenuSeparator')).toBeVisible()
    await expect(page.locator('#seanceDialog dialog')).toBeHidden()
})

test('concurrent layer additions from independent peers both survive', async ({ page, context }) => {
    const peer = await context.newPage()
    await preparePage(page)
    await preparePage(peer)
    await gotoApp(page)
    await createProject(page, 'solid', 128)
    const sessionId = await takeOnline(page)
    await gotoApp(peer, { seance: sessionId })
    await expect.poll(() => layersState(peer).then(layers => layers.length), { timeout: 60000 }).toBe(1)
    await expect.poll(() => peer.evaluate(() => window.layersApp._onlineAdapter.getStatus())).toBe('online')

    // Hold only the publish funnel, so both real app mutations allocate and
    // render before either peer can learn about the other's new IDs.
    const ids = await Promise.all([page, peer].map((client, index) => client.evaluate(async (name) => {
        const app = window.layersApp
        const publish = app._onlineAdapter.schedulePublish
        app._onlineAdapter.schedulePublish = () => {}
        window.__releasePublish = () => {
            app._onlineAdapter.schedulePublish = publish
            publish()
        }
        await app._handleAddEffectLayer('filter/blur')
        const layer = app._layers.at(-1)
        layer.name = name
        return layer.id
    }, `Peer ${index + 1}`)))
    expect(ids[0]).not.toBe(ids[1])
    await Promise.all([page, peer].map(client => client.evaluate(() => window.__releasePublish())))
    const expected = ['Peer 1', 'Peer 2']
    for (const client of [page, peer]) {
        await expect.poll(async () => (await layersState(client))
            .filter(layer => ids.includes(layer.id)).map(layer => layer.name).sort(),
        { timeout: 60000 }).toEqual(expected)
    }
})

test('two-page convergence: add layer, opacity, blend mode, reorder, delete', async ({ page, context }) => {
    const pageA = page
    const pageB = await context.newPage()
    await preparePage(pageA)
    await preparePage(pageB)

    await gotoApp(pageA)
    // State convergence needs real rendering, but no particular document size.
    await createProject(pageA, 'solid', 128)
    const sessionId = await takeOnline(pageA)

    await gotoApp(pageB)
    await createProject(pageB, 'solid', 128)
    await joinById(pageB, sessionId)
    await expect.poll(() => layersState(pageB).then(l => l.length), { timeout: 60000 }).toBe(1)

    // Add an effect layer on A -> appears on B.
    await pageA.evaluate(async () => { await window.layersApp._handleAddEffectLayer('filter/blur') })
    await expect.poll(() => layersState(pageB).then(l => l.length), { timeout: 60000 }).toBe(2)
    await expect.poll(() => layersState(pageB).then(l => l[1]?.effectId), { timeout: 60000 }).toBe('filter/blur')
    const targetId = await pageB.evaluate(() => window.layersApp._layers[1].id)

    // Opacity change on B -> converges to A.
    await pageB.evaluate(async (id) => {
        await window.layersApp._handleLayerChange({ layerId: id, property: 'opacity', value: 42 })
    }, targetId)
    await expect.poll(async () => (await layersState(pageA)).find(l => l.id === targetId)?.opacity, { timeout: 60000 }).toBe(42)

    // Blend mode change on B -> converges to A.
    await pageB.evaluate(async (id) => {
        await window.layersApp._handleLayerChange({ layerId: id, property: 'blendMode', value: 'screen' })
    }, targetId)
    await expect.poll(async () => (await layersState(pageA)).find(l => l.id === targetId)?.blendMode, { timeout: 60000 }).toBe('screen')

    // Add a third layer so there's something to reorder.
    await pageA.evaluate(async () => { await window.layersApp._handleAddEffectLayer('filter/sharpen') })
    await expect.poll(() => layersState(pageB).then(l => l.length), { timeout: 60000 }).toBe(3)

    // Reorder on A -> converges to B.
    const beforeIds = (await layersState(pageA)).map(l => l.id)
    await pageA.evaluate(async () => {
        const app = window.layersApp
        const sourceId = app._layers[1].id
        const dropTargetId = app._layers[2].id
        app._startDrag(sourceId)
        await app._processDrop(dropTargetId, 'above')
    })
    await expect.poll(() => layersState(pageA).then(l => l.map(x => x.id)), { timeout: 60000 }).not.toEqual(beforeIds)
    const afterIds = (await layersState(pageA)).map(l => l.id)
    await expect.poll(() => layersState(pageB).then(l => l.map(x => x.id)), { timeout: 60000 }).toEqual(afterIds)

    // Delete on B -> converges to A.
    const toDeleteId = afterIds[afterIds.length - 1]
    await pageB.evaluate(async (id) => { await window.layersApp._handleDeleteLayer(id) }, toDeleteId)
    await expect.poll(() => layersState(pageB).then(l => l.length), { timeout: 60000 }).toBe(2)
    await expect.poll(() => layersState(pageA).then(l => l.map(x => x.id)), { timeout: 60000 }).not.toContain(toDeleteId)
    await expect.poll(() => layersState(pageA).then(l => l.length), { timeout: 60000 }).toBe(2)
})

test('go offline stops syncing', async ({ page, context }) => {
    const pageA = page
    const pageB = await context.newPage()
    await preparePage(pageA)
    await preparePage(pageB)

    await gotoApp(pageA)
    await createProject(pageA, 'transparent')
    const sessionId = await takeOnline(pageA)

    await gotoApp(pageB)
    await createProject(pageB, 'transparent')
    await joinById(pageB, sessionId)
    await expect.poll(() => layersState(pageB).then(l => l.length), { timeout: 60000 }).toBe(1)

    await openSeanceDialog(pageB)
    await pageB.locator('#seanceDialog [data-action="go-offline"]').click()
    await expect(pageB.locator('#seanceDialog .hf-seance-status-text')).toHaveText('Offline')

    await pageA.evaluate(async () => { await window.layersApp._handleAddEffectLayer('filter/blur') })
    await quietWindow(pageA, 1000) // give a would-be sync every chance to (wrongly) land
    expect((await layersState(pageB)).length).toBe(1)
})

test('flattening while online shares the resulting image with the peer', async ({ page, context }) => {
    // Reopen when the CI harness pin advances to seance aaec82b or later:
    // the shared flatten result rides the SDK's prepareImage, which the
    // pinned pre-image harness lacks.
    test.skip(!localSdkSupportsImages(),
        'requires a Seance SDK with prepareImage (harness pin >= seance aaec82b)')
    const pageB = await context.newPage()
    await preparePage(page)
    await preparePage(pageB)
    await gotoApp(page)
    await createProject(page, 'solid', 128)
    await page.evaluate(async () => { await window.layersApp._handleAddEffectLayer('filter/blur') })
    const sessionId = await takeOnline(page)
    await closeSeanceDialog(page)
    await gotoApp(pageB, { seance: sessionId })
    await expect.poll(() => layersState(pageB).then(l => l.length), { timeout: 60000 }).toBe(2)
    expect(await page.evaluate(async () => (await window.LayersAgent.flattenImage()).ok)).toBe(true)
    await expect.poll(() => layersState(pageB).then(l => l.length), { timeout: 60000 }).toBe(1)
    const shared = await pageB.evaluate(() => {
        const layer = window.layersApp._layers[0]
        return { type: layer.mediaType, file: layer.mediaFile instanceof File, id: layer.imageId }
    })
    expect(shared.type).toBe('image')
    expect(shared.file).toBe(true)
    expect(shared.id).toMatch(/^[a-f0-9]{64}$/)
})

test('agent newProject while online takes the session offline first, without wiping the peer', async ({ page, context }) => {
    const pageA = page
    const pageB = await context.newPage()
    await preparePage(pageA)
    await preparePage(pageB)

    await gotoApp(pageA)
    await pageA.evaluate(async () => { await window.LayersAgent.ready })
    await createProject(pageA, 'solid')
    const sessionId = await takeOnline(pageA)
    await closeSeanceDialog(pageA)

    await gotoApp(pageB)
    await createProject(pageB, 'solid')
    await joinById(pageB, sessionId)
    await expect.poll(() => layersState(pageB).then(l => l.length), { timeout: 60000 }).toBe(1)

    // Agents can't answer the confirm dialog the human File > New path shows
    // (_confirmLeaveOnlineSession); newProject takes the session offline
    // itself instead and reports it via the envelope's warnings array.
    const env = await pageA.evaluate(() => window.LayersAgent.newProject({ width: 400, height: 400 }))
    expect(env.ok).toBe(true)
    expect(env.warnings?.some(w => w.code === 'SESSION_TAKEN_OFFLINE')).toBe(true)
    expect(await pageA.evaluate(() => window.layersApp._onlineAdapter?.isOnline())).toBe(false)

    // Page B's composition must survive untouched — A's local reset must
    // never have been published as a wiping remote apply.
    // The window stays: A is offline by the line above, so it has no change
    // left that could propagate as a barrier, and B is the only other peer.
    await quietWindow(pageA, 500)
    expect((await layersState(pageB)).length).toBe(1)
    expect(await pageB.evaluate(() => window.layersApp._onlineAdapter?.getStatus())).toBe('online')
})

// A socket drop is the one transition the app cannot see coming: the SDK
// reconnects on its own, and both directions of the exchange used to be lost
// with it. Driven by closing the socket directly, which is what a Caddy
// reload, a server restart or a sleeping laptop look like from here.
async function dropSocket(page) {
    await page.evaluate(() => {
        const online = window.layersApp._onlineAdapter.online
        online.options.reconnectBaseMs = 2500
        online.socket.close()
    })
    await expect.poll(() => page.evaluate(
        () => window.layersApp._onlineAdapter?.getStatus()), { timeout: 15000 }).toBe('connecting')
}

async function setOpacity(page, layerId, value) {
    await page.evaluate(async ({ id, v }) => {
        await window.layersApp._handleLayerChange({ layerId: id, property: 'opacity', value: v })
    }, { id: layerId, v: value })
}

const opacityOf = async (page, id) => (await layersState(page)).find(l => l.id === id)?.opacity

test('an edit made while reconnecting is published once the socket returns', async ({ page, context }) => {
    const pageA = page
    const pageB = await context.newPage()
    await preparePage(pageA)
    await preparePage(pageB)

    await gotoApp(pageA)
    await createProject(pageA, 'solid', 128)
    const sessionId = await takeOnline(pageA)

    await gotoApp(pageB)
    await createProject(pageB, 'solid', 128)
    await joinById(pageB, sessionId)
    await expect.poll(() => layersState(pageB).then(l => l.length), { timeout: 60000 }).toBe(1)
    const layerId = (await layersState(pageB))[0].id

    await dropSocket(pageB)
    // schedulePublish() refuses to arm while the status is 'connecting', so
    // without a re-arm on reconnect this edit was never sent at all.
    await setOpacity(pageB, layerId, 42)
    expect(await opacityOf(pageB, layerId)).toBe(42)

    await expect.poll(() => pageB.evaluate(
        () => window.layersApp._onlineAdapter?.getStatus()), { timeout: 60000 }).toBe('online')
    await expect.poll(() => opacityOf(pageA, layerId), { timeout: 60000 }).toBe(42)
    expect(await opacityOf(pageB, layerId)).toBe(42)
})

test('a peer edit made during an outage is adopted on reconnect', async ({ page, context }) => {
    const pageA = page
    const pageB = await context.newPage()
    await preparePage(pageA)
    await preparePage(pageB)

    await gotoApp(pageA)
    await createProject(pageA, 'solid', 128)
    const sessionId = await takeOnline(pageA)

    await gotoApp(pageB)
    await createProject(pageB, 'solid', 128)
    await joinById(pageB, sessionId)
    await expect.poll(() => layersState(pageB).then(l => l.length), { timeout: 60000 }).toBe(1)
    const layerId = (await layersState(pageB))[0].id

    await dropSocket(pageB)
    await setOpacity(pageA, layerId, 77)
    await expect.poll(() => pageB.evaluate(
        () => window.layersApp._onlineAdapter?.getStatus()), { timeout: 60000 }).toBe('online')

    // The SDK adopts the reconnect snapshot and emits 'node-snapshot' just
    // before it flips the status to 'online', so the apply has to be
    // re-requested from the status transition or the outage stays invisible.
    await expect.poll(() => opacityOf(pageB, layerId), { timeout: 60000 }).toBe(77)
})

test('a peer edit does not throw the local user out of mask editing', async ({ page, context }) => {
    const pageA = page
    const pageB = await context.newPage()
    await preparePage(pageA)
    await preparePage(pageB)

    await gotoApp(pageA)
    await createProject(pageA, 'solid', 128)
    await pageA.evaluate(async () => { await window.layersApp._handleAddEffectLayer('filter/blur') })
    const sessionId = await takeOnline(pageA)
    await closeSeanceDialog(pageA)

    await gotoApp(pageB)
    await createProject(pageB, 'solid', 128)
    await joinById(pageB, sessionId)
    await expect.poll(() => layersState(pageB).then(l => l.length), { timeout: 60000 }).toBe(2)

    const [baseId, blurId] = (await layersState(pageA)).map(l => l.id)
    await pageA.evaluate(async (id) => { await window.layersApp._addLayerMask(id) }, baseId)
    expect(await pageA.evaluate(() => window.layersApp._maskEditMode)).toBe(true)
    await expect.poll(async () => (await layersState(pageB))[0]?.hasMask, { timeout: 60000 }).toBe(true)

    // An apply swaps the whole layer array, so mask editing is torn down for
    // it. A peer touching an unrelated layer must not cost this user the mask
    // they are painting.
    await pageB.evaluate(async (id) => {
        await window.layersApp._handleLayerChange({ layerId: id, property: 'opacity', value: 33 })
    }, blurId)
    await expect.poll(async () => (await layersState(pageA)).find(l => l.id === blurId)?.opacity,
        { timeout: 60000 }).toBe(33)

    expect(await pageA.evaluate(() => window.layersApp._maskEditMode)).toBe(true)
    expect(await pageA.evaluate(() => window.layersApp._maskEditLayerId)).toBe(baseId)
})

// SHA-256 of a layer's decoded mask pixels, or null without a mask.
async function maskDigest(page, layerId) {
    return page.evaluate(async (id) => {
        const mask = window.layersApp._layers.find(l => l.id === id)?.mask
        if (!mask?.data) return null
        const digest = await crypto.subtle.digest('SHA-256', mask.data)
        return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('')
    }, layerId)
}

// The mask image id the session's copy of a layer refers to.
async function sessionMaskImageId(page, layerId) {
    return page.evaluate((id) => {
        const node = window.layersApp._onlineAdapter.online.getNodes().find(n => n.id === `L${id}`)
        return node ? JSON.parse(node.text).maskImage?.id ?? null : null
    }, layerId)
}

test('undo to a mask whose image the server freed uploads it again for peers', async ({ page, context, baseURL }) => {
    test.skip(!localServerPrunesImages(), 'requires a Seance harness at 66afef6 or later (frees unreferenced images)')
    // A two-image budget with no grace: the third mask upload frees the first.
    await seance.stop()
    seance = await startSeanceServer({ origin: baseURL, env: {
        SEANCE_LIMIT_MAX_IMAGES: '2', SEANCE_LIMIT_IMAGE_PRUNE_GRACE: '0',
    } })
    const pageA = page
    const pageB = await context.newPage()
    await preparePage(pageA)
    await preparePage(pageB)

    await gotoApp(pageA)
    await createProject(pageA, 'solid', 128)
    const baseId = (await layersState(pageA))[0].id
    const paintMask = (split) => pageA.evaluate(async ({ id, split }) => {
        const app = window.layersApp
        const layer = app._layers.find(l => l.id === id)
        const mask = new ImageData(app._canvas.width, app._canvas.height)
        for (let i = 0; i < mask.data.length; i += 4) {
            const v = (i / 4) % mask.width < mask.width * split ? 255 : 0
            mask.data[i] = v; mask.data[i + 1] = v; mask.data[i + 2] = v; mask.data[i + 3] = 255
        }
        layer.mask = mask
        app._pushUndoState()
    }, { id: baseId, split })

    await paintMask(0.25)
    const firstDigest = await maskDigest(pageA, baseId)
    const sessionId = await takeOnline(pageA)
    await closeSeanceDialog(pageA)
    const firstImageId = await sessionMaskImageId(pageA, baseId)
    expect(firstImageId).toMatch(/^[a-f0-9]{64}$/)

    await gotoApp(pageB)
    await createProject(pageB, 'solid', 128)
    await joinById(pageB, sessionId)
    await expect.poll(() => maskDigest(pageB, baseId), { timeout: 60000 }).toBe(firstDigest)

    // Two replacements. The second upload finds the budget full, and the
    // server frees the first mask, which nothing refers to any more.
    for (const split of [0.5, 0.75]) {
        await paintMask(split)
        const digest = await maskDigest(pageA, baseId)
        await expect.poll(() => maskDigest(pageB, baseId), { timeout: 60000 }).toBe(digest)
    }
    const fetchFirst = () => pageB.evaluate(async (imageId) => {
        try {
            await window.layersApp._onlineAdapter.online.getImage(imageId)
            return 'present'
        } catch (error) {
            return error.message
        }
    }, firstImageId)
    expect(await fetchFirst()).toMatch(/404/)

    // Undo back to the first mask. Its bytes must reach the session again
    // before the layer refers to them, or B could never load it.
    for (let step = 0; step < 4 && await maskDigest(pageA, baseId) !== firstDigest; step++) {
        await pageA.evaluate(async () => { await window.layersApp._undo() })
        const digest = await maskDigest(pageA, baseId)
        await expect.poll(() => maskDigest(pageB, baseId), { timeout: 60000 }).toBe(digest)
    }
    expect(await maskDigest(pageA, baseId)).toBe(firstDigest)
    await expect.poll(() => maskDigest(pageB, baseId), { timeout: 60000 }).toBe(firstDigest)
    expect(await sessionMaskImageId(pageB, baseId)).toBe(firstImageId)
    expect(await fetchFirst()).toBe('present')

    // B may still hold the first mask's bytes from when it joined. A peer
    // joining now has only the server to fetch them from.
    const pageC = await context.newPage()
    await preparePage(pageC)
    await gotoApp(pageC)
    await createProject(pageC, 'solid', 128)
    await joinById(pageC, sessionId)
    await expect.poll(() => maskDigest(pageC, baseId), { timeout: 60000 }).toBe(firstDigest)
})
