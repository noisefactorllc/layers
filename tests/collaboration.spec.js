import { test, expect } from 'playwright/test'
import { SEANCE_SDK_URL, hasLocalSeanceHarness, routeSeanceSdkLocal, startSeanceServer } from './seanceLocal.js'

let seance

test.describe.configure({ mode: 'serial' })
test.skip(!hasLocalSeanceHarness(), 'requires a local Seance checkout; set SEANCE_ROOT (or SEANCE_DIST_DIR + SEANCE_PYTHON)')

test.beforeEach(({}, testInfo) => {
    // Convergence tests chain several expect.poll() waits against a real
    // local server, and this suite must also survive CPU-starved parallel
    // full-suite runs (software WebGL × N workers), where a single boot or
    // join can take 10x its isolated wall-clock. Budgets are sized for that
    // contended case — in serial mode one mid-file timeout skips every
    // remaining test in the file, so a premature budget costs the whole
    // file's signal, not one test.
    testInfo.setTimeout(180000)
})

test.beforeAll(async () => {
    seance = await startSeanceServer()
})

test.afterAll(async () => {
    await seance?.stop()
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

async function createProject(page, type = 'transparent') {
    await page.waitForSelector('.open-dialog-backdrop.visible')
    await page.click(`.media-option[data-type="${type}"]`)
    await page.waitForSelector('.canvas-size-dialog', { timeout: 15000 })
    await page.click('.canvas-size-dialog .action-btn.primary')
    await page.waitForSelector('.open-dialog-backdrop.visible', { state: 'hidden', timeout: 5000 })
    await page.waitForTimeout(500)
}

async function openFileMenu(page) {
    await page.evaluate(() => {
        for (const menu of document.querySelectorAll('.menu')) {
            const title = menu.querySelector('.menu-title')
            if (title && title.textContent.trim() === 'file') {
                menu.querySelector('.menu-items')?.classList.remove('hide')
                return
            }
        }
    })
    await page.waitForTimeout(50)
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

async function addMediaLayer(page, color) {
    await page.evaluate(async (fillColor) => {
        const canvas = document.createElement('canvas')
        canvas.width = 50
        canvas.height = 50
        const ctx = canvas.getContext('2d')
        ctx.fillStyle = fillColor
        ctx.fillRect(0, 0, 50, 50)
        const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'))
        const file = new File([blob], 'test.png', { type: 'image/png' })
        await window.layersApp._handleAddMediaLayer(file, 'image')
    }, color)
    await page.waitForTimeout(300)
}

// ---------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------

test('go online menu item is visible by default and the dialog stays closed until opened', async ({ page }) => {
    await preparePage(page)
    await gotoApp(page)
    await createProject(page)

    await openFileMenu(page)
    await expect(page.locator('#goOnlineMenuItem')).toBeVisible()
    await expect(page.locator('#onlineCollabMenuSeparator')).toBeVisible()
    await expect(page.locator('#seanceDialog dialog')).toBeHidden()
})

test('take online creates a session and shows a share URL in the dialog', async ({ page }) => {
    await preparePage(page)
    await gotoApp(page)
    await createProject(page)

    const sessionId = await takeOnline(page)

    const dialog = page.locator('#seanceDialog')
    const shareUrl = await dialog.locator('.hf-seance-url').inputValue()
    expect(shareUrl).toContain(`seance=${sessionId}`)
    expect(shareUrl).toContain(encodeURIComponent(SEANCE_SDK_URL))

    await dialog.locator('[data-action="copy-url"]').click()
    await expect.poll(() => page.evaluate(() => window.__clipboardText)).toBe(shareUrl)
})

test('two-page convergence: add layer, opacity, blend mode, reorder, delete', async ({ page, context }) => {
    const pageA = page
    const pageB = await context.newPage()
    await preparePage(pageA)
    await preparePage(pageB)

    await gotoApp(pageA)
    await createProject(pageA, 'solid')
    const sessionId = await takeOnline(pageA)

    await gotoApp(pageB)
    await createProject(pageB, 'solid')
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

test('drawing-layer strokes and a mask edit converge and actually render', async ({ page, context }) => {
    const pageA = page
    const pageB = await context.newPage()
    await preparePage(pageA)
    await preparePage(pageB)

    await gotoApp(pageA)
    await createProject(pageA, 'transparent')
    const sessionId = await takeOnline(pageA)
    await closeSeanceDialog(pageA) // its native <dialog> would block the mouse-driven stroke below

    await gotoApp(pageB)
    await createProject(pageB, 'transparent')
    await joinById(pageB, sessionId)
    await expect.poll(() => layersState(pageB).then(l => l.length), { timeout: 60000 }).toBe(1)

    // Drive a real mouse-drawn stroke on A (red, so the pixel sample below is
    // unambiguous against the transparent base).
    await pageA.evaluate(() => { window.layersApp._brushTool.color = '#ff0000' })
    await pageA.click('#brushToolBtn')
    const overlay = await pageA.$('#selectionOverlay')
    const box = await overlay.boundingBox()
    const startX = box.x + box.width * 0.3
    const startY = box.y + box.height * 0.3
    const endX = box.x + box.width * 0.6
    const endY = box.y + box.height * 0.6
    await pageA.mouse.move(startX, startY)
    await pageA.mouse.down()
    for (let i = 1; i <= 5; i++) {
        const t = i / 5
        await pageA.mouse.move(startX + (endX - startX) * t, startY + (endY - startY) * t)
    }
    await pageA.mouse.up()

    await expect.poll(async () => {
        const layers = await layersState(pageB)
        return layers.find(l => l.sourceType === 'drawing')?.strokeCount || 0
    }, { timeout: 60000 }).toBe(1)

    // Confirm the stroke actually rendered on B's canvas (not just present in
    // the model), following the existing drawing-render.spec.js technique.
    const pixel = await pageB.evaluate(({ fx, fy }) => {
        const app = window.layersApp
        app._renderer.render(0)
        const canvas = document.getElementById('canvas')
        const gl = canvas.getContext('webgl2') || canvas.getContext('webgl')
        const pixels = new Uint8Array(4)
        const x = Math.round(canvas.width * fx)
        const y = Math.round(canvas.height * fy)
        gl.readPixels(x, canvas.height - y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixels)
        return Array.from(pixels)
    }, { fx: 0.3, fy: 0.3 })
    expect(pixel[0]).toBeGreaterThan(100) // red channel
    expect(pixel[3]).toBeGreaterThan(0)   // opaque, not the transparent base

    // Mask edit on A -> converges to B.
    const baseId = await pageA.evaluate(() => window.layersApp._layers[0].id)
    await pageA.evaluate(async (id) => { await window.layersApp._addLayerMask(id) }, baseId)
    await expect.poll(async () => (await layersState(pageB))[0]?.hasMask, { timeout: 60000 }).toBe(true)
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
    await pageA.waitForTimeout(1000) // give a would-be sync every chance to (wrongly) land
    expect((await layersState(pageB)).length).toBe(1)
})

test('?seance= boot join applies the shared composition directly, with no confirm', async ({ page, context }) => {
    const pageA = page
    await preparePage(pageA)
    await gotoApp(pageA)
    await createProject(pageA, 'solid')
    await pageA.evaluate(async () => { await window.layersApp._handleAddEffectLayer('filter/blur') })
    await pageA.waitForTimeout(300)
    const sessionId = await takeOnline(pageA)
    await expect.poll(() => layersState(pageA).then(l => l.length), { timeout: 60000 }).toBe(2)

    const pageC = await context.newPage()
    await preparePage(pageC)
    await pageC.goto(appPath({ seance: sessionId }))
    await pageC.waitForSelector('#loading-screen', { state: 'hidden', timeout: 25000 })

    await expect(pageC.locator('.confirm-dialog-backdrop.visible')).toHaveCount(0)
    await expect(pageC.locator('.open-dialog-backdrop.visible')).toHaveCount(0)
    await expect.poll(() => layersState(pageC).then(l => l.length), { timeout: 60000 }).toBe(2)
    expect(await pageC.evaluate(() => window.layersApp._onlineAdapter?.getStatus())).toBe('online')
})

test('media gating: an existing media layer blocks take-online, and adding media is blocked while online', async ({ page }) => {
    await preparePage(page)
    await gotoApp(page)
    await createProject(page)

    // Part 1: a media layer already in the composition blocks take-online.
    await addMediaLayer(page, '#00ff00')
    await openSeanceDialog(page)
    await page.locator('#seanceDialog [data-action="take-online"]').click()
    await expect(page.locator('.info-dialog-backdrop.visible')).toBeVisible()
    await expect(page.locator('.info-dialog .info-message')).toContainText('media layer')
    await page.click('.info-dialog #info-ok')
    await expect(page.locator('.info-dialog-backdrop.visible')).toHaveCount(0)
    expect(await page.evaluate(() => window.layersApp._onlineAdapter?.getStatus())).toBe('offline')

    // Remove the media layer, then take online successfully.
    await page.evaluate(async () => {
        const app = window.layersApp
        const media = app._layers.find(l => l.sourceType === 'media')
        await app._handleDeleteLayer(media.id)
    })
    await page.waitForTimeout(300)
    await takeOnline(page)

    // Part 2: adding a media layer while online is blocked with a toast, and
    // no layer is actually added.
    const countBefore = (await layersState(page)).length
    await addMediaLayer(page, '#0000ff')
    await expect(page.locator('.toast-warning')).toBeVisible()
    expect((await layersState(page)).length).toBe(countBefore)
})

test('dialect refusal: joining a non-Layers session shows a friendly dialog and stays usable offline', async ({ page }) => {
    await preparePage(page)
    await page.goto(appPath())

    // Create a session with the server DEFAULT dialect (noisemaker-dsl) via a
    // raw fetch from the page, the way a DSL-text product (e.g. Polymorphic,
    // Noisedeck) creates one — omit "dialect" entirely.
    const sessionId = await page.evaluate(async (seanceUrl) => {
        const res = await fetch(`${seanceUrl}/v1/sessions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ snapshot: { docs: [{ id: 'main', title: 'Program', kind: 'noisemaker-dsl', text: '', default: true }] } }),
        })
        const body = await res.json()
        return body.session_id
    }, seance.url)
    expect(sessionId).toMatch(/^[A-Za-z0-9]{6}$/)

    // Navigating Layers to ?seance=<that session> refuses with the friendly
    // dialog and falls back to the normal open dialog.
    await page.goto(appPath({ seance: sessionId }))
    await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 25000 })

    await expect(page.locator('.info-dialog-backdrop.visible')).toBeVisible({ timeout: 60000 })
    await expect(page.locator('.info-dialog .info-message')).toContainText("isn't a Layers composition")
    await page.click('.info-dialog #info-ok')

    await expect(page.locator('.open-dialog-backdrop.visible')).toBeVisible()
    await createProject(page)
    expect((await layersState(page)).length).toBe(1)
    expect(await page.evaluate(() => window.layersApp._onlineAdapter?.getStatus())).toBe('offline')
})

test('transform sync: a layer transform (move/scale) converges to the joined page', async ({ page, context }) => {
    const pageA = page
    const pageB = await context.newPage()
    await preparePage(pageA)
    await preparePage(pageB)

    await gotoApp(pageA)
    await createProject(pageA, 'solid')
    const sessionId = await takeOnline(pageA)
    await closeSeanceDialog(pageA)

    await gotoApp(pageB)
    await createProject(pageB, 'solid')
    await joinById(pageB, sessionId)
    await expect.poll(() => layersState(pageB).then(l => l.length), { timeout: 60000 }).toBe(1)

    const baseId = await pageA.evaluate(() => window.layersApp._layers[0].id)
    const transformOf = (target) => target.evaluate(() => {
        const l = window.layersApp._layers[0]
        return { offsetX: l.offsetX, offsetY: l.offsetY, scaleX: l.scaleX }
    })

    // Drive the transform tool's own per-frame commit callback programmatically
    // (the same function a real handle-drag gesture invokes on every
    // mousemove — public/js/app.js _applyLayerTransform) rather than
    // simulating exact overlay handle-drag mouse geometry. This is the
    // path that CRITICAL fix #1 (undo-push-hooked publish funnel) covers:
    // transform edits never call _rebuild(), so before that fix they never
    // published at all.
    await pageA.evaluate((id) => {
        const app = window.layersApp
        app._layerStack.selectedLayerId = id
        app._applyLayerTransform({ offsetX: 37, offsetY: -21, scaleX: 1.4 })
    }, baseId)

    await expect.poll(async () => (await transformOf(pageB)).offsetX, { timeout: 60000 }).toBe(37)
    expect(await transformOf(pageB)).toEqual({ offsetX: 37, offsetY: -21, scaleX: 1.4 })
})

test('flatten gate: flattening while online shows a toast and leaves both pages unaffected', async ({ page, context }) => {
    const pageA = page
    const pageB = await context.newPage()
    await preparePage(pageA)
    await preparePage(pageB)

    await gotoApp(pageA)
    await createProject(pageA, 'solid')
    await pageA.evaluate(async () => { await window.layersApp._handleAddEffectLayer('filter/blur') })
    const sessionId = await takeOnline(pageA)
    await closeSeanceDialog(pageA)

    await gotoApp(pageB)
    await createProject(pageB, 'solid')
    await joinById(pageB, sessionId)
    await expect.poll(() => layersState(pageB).then(l => l.length), { timeout: 60000 }).toBe(2)

    const countBefore = (await layersState(pageA)).length

    await pageA.evaluate(async () => { await window.layersApp._flattenImage() })
    await expect(pageA.locator('.toast-warning')).toBeVisible()

    // No media layer was created, and the layer count didn't change.
    const stateA = await layersState(pageA)
    expect(stateA.length).toBe(countBefore)
    expect(stateA.some(l => l.sourceType === 'media')).toBe(false)

    // Nothing was published to corrupt page B either.
    await pageA.waitForTimeout(500)
    const stateB = await layersState(pageB)
    expect(stateB.length).toBe(countBefore)
    expect(stateB.some(l => l.sourceType === 'media')).toBe(false)
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
    await pageA.waitForTimeout(500)
    expect((await layersState(pageB)).length).toBe(1)
    expect(await pageB.evaluate(() => window.layersApp._onlineAdapter?.getStatus())).toBe('online')
})
