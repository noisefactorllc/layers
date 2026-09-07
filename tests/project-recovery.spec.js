import { test, expect } from './fixtures.js'

async function boot(page) {
    await page.goto('/', { waitUntil: 'networkidle' })
    await page.waitForFunction(() => !!window.LayersAgent, null, { timeout: 15000 })
    await page.evaluate(async () => { await window.LayersAgent.ready })
    await page.click('.media-option[data-type="solid"]')
    await page.locator('#canvas-width').fill('128')
    await page.locator('#canvas-height').fill('128')
    await page.click('.canvas-size-dialog .action-btn.primary')
    await page.waitForSelector('.open-dialog-backdrop.visible', { state: 'hidden' })
}

async function waitForCheckpoint(page, layerCount = 1) {
    await expect.poll(() => page.evaluate(async expectedLayers => {
        const request = indexedDB.open('layers-recovery')
        return new Promise(resolve => {
            request.onsuccess = () => {
                const db = request.result
                if (!db.objectStoreNames.contains('documents')) { db.close(); resolve(0); return }
                const rows = db.transaction('documents').objectStore('documents').getAll()
                rows.onsuccess = () => {
                    db.close()
                    resolve(rows.result.some(row => row.layers.length === expectedLayers
                        && (expectedLayers === 1 || row.layers.at(-1).mask)) ? 1 : 0)
                }
            }
        })
    }, layerCount), { timeout: 10000 }).toBeGreaterThan(0)
}

test('dirty navigation is protected and a cancelled reload retains the document', async ({ page }) => {
    await boot(page)
    const before = await page.evaluate(() => window.layersApp._layers.length)
    const prompt = page.waitForEvent('dialog')
    await page.evaluate(() => { setTimeout(() => location.reload(), 0) })
    const dialog = await prompt
    expect(dialog.type()).toBe('beforeunload')
    await dialog.dismiss()
    expect(await page.evaluate(() => window.layersApp._layers.length)).toBe(before)
})

test('reload recovers the exact unsaved document pixels, media, and masks', async ({ page }) => {
    await boot(page)
    const before = await page.evaluate(async () => {
        const c = document.createElement('canvas'); c.width = 64; c.height = 64
        const ctx = c.getContext('2d'); ctx.fillStyle = '#13ab67'; ctx.fillRect(0, 0, 64, 64)
        const added = await window.LayersAgent.addLayer({ kind: 'media', mediaType: 'image',
            source: { kind: 'base64', data: c.toDataURL().split(',')[1], mimeType: 'image/png' } })
        await window.LayersAgent.addLayerMask({ layerId: added.result.layerId })
        const exported = await window.LayersAgent.exportImage({ format: 'png', captureOnly: true })
        return { bytes: exported.result.bytes, layerCount: window.layersApp._layers.length }
    })
    await waitForCheckpoint(page, before.layerCount)
    page.on('dialog', dialog => dialog.accept())
    await page.reload({ waitUntil: 'networkidle' })
    await page.getByRole('button', { name: 'Restore', exact: true }).first().click()
    await expect.poll(() => page.evaluate(() => window.layersApp._layers.length), { timeout: 15000 }).toBe(before.layerCount)
    const after = await page.evaluate(async () => {
        const exported = await window.LayersAgent.exportImage({ format: 'png', captureOnly: true })
        const layer = window.layersApp._layers.at(-1)
        return { bytes: exported.result.bytes, dirty: window.layersApp._isDirty,
            hasMedia: layer.mediaFile instanceof File, hasMask: layer.mask instanceof ImageData }
    })
    expect(after).toEqual({ bytes: before.bytes, dirty: true, hasMedia: true, hasMask: true })
})

test('a committed save clears recovery and does not warn on reload', async ({ page }) => {
    await boot(page)
    await waitForCheckpoint(page)
    const saved = await page.evaluate(() => window.LayersAgent.saveProjectAs({ name: 'saved' }))
    expect(saved.ok).toBe(true)
    let dialogs = 0
    page.on('dialog', dialog => { dialogs++; return dialog.accept() })
    await page.reload({ waitUntil: 'networkidle' })
    await page.waitForFunction(() => !!window.LayersAgent, null, { timeout: 15000 })
    await page.evaluate(async () => { await window.LayersAgent.ready })
    expect(dialogs).toBe(0)
    await expect(page.locator('.recovery-dialog')).not.toBeVisible()
})

test('Keep for later retains the old checkpoint after creating and saving another document', async ({ page }) => {
    await boot(page)
    await waitForCheckpoint(page)
    const original = await page.evaluate(async () => (await (await import('/js/utils/project-recovery.js')).listRecoveries())[0].id)
    page.on('dialog', dialog => dialog.accept())
    await page.reload({ waitUntil: 'networkidle' })
    await page.getByRole('button', { name: 'Keep for later', exact: true }).click()
    await page.click('.media-option[data-type="solid"]')
    await page.click('.canvas-size-dialog .action-btn.primary')
    await page.evaluate(() => window.LayersAgent.saveProjectAs({ name: 'another document' }))
    const ids = await page.evaluate(async () => (await (await import('/js/utils/project-recovery.js')).listRecoveries()).map(row => row.id))
    expect(ids).toContain(original)
})

test('a second live tab ignores the first tab checkpoint, then discovers it after its owner closes', async ({ page, context }) => {
    await boot(page)
    const original = await page.evaluate(async () => {
        await window.layersApp._recovery.flush()
        return window.layersApp._recovery._id
    })
    const other = await context.newPage()
    await other.goto('/', { waitUntil: 'networkidle' })
    await other.waitForFunction(() => !!window.LayersAgent, null, { timeout: 15000 })
    await other.evaluate(() => window.LayersAgent.ready)
    await expect(other.locator('.recovery-dialog')).not.toBeVisible()
    await expect(other.locator('.open-dialog-backdrop.visible')).toBeVisible()
    expect(await other.evaluate(async () => (await (await import('/js/utils/project-recovery.js')).listRecoveries()).map(row => row.id))).not.toContain(original)
    await page.close()
    await expect.poll(() => other.evaluate(async () => (await (await import('/js/utils/project-recovery.js')).listRecoveries()).map(row => row.id))).toContain(original)
    await other.close()
})

async function recoveryHarness(page) {
    await page.route('**/__recovery_test__', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Recovery ownership test</title>' }))
    await page.goto('/__recovery_test__')
}

test('Keep for later releases its old ownership only after pending work settles', async ({ page, context }) => {
    await recoveryHarness(page)
    const original = await page.evaluate(async () => {
        const { ProjectRecovery } = await import('/js/utils/project-recovery.js')
        let dirty = true
        const snapshot = { name: 'deferred', layers: [], canvasWidth: 64, canvasHeight: 64 }
        const journal = new ProjectRecovery({ capture: async () => snapshot, isDirty: () => dirty, onError: error => { throw error } })
        await journal.flush()
        const id = await journal._id
        let started
        const capturing = new Promise(resolve => { started = resolve })
        journal.capture = async () => { started(); return new Promise(resolve => { window.__finishCapture = () => resolve(snapshot) }) }
        journal.flush()
        await capturing
        dirty = false
        window.__retained = journal.retain()
        return id
    })
    const observer = await context.newPage()
    await recoveryHarness(observer)
    const list = () => observer.evaluate(async () => (await (await import('/js/utils/project-recovery.js')).listRecoveries()).map(row => row.id))
    expect(await list()).not.toContain(original)
    await page.evaluate(async () => { window.__finishCapture(); await window.__retained })
    expect(await list()).toContain(original)
    const held = await page.evaluate(async () => (await navigator.locks.query()).held.map(lock => lock.name))
    expect(held).not.toContain(`layers-recovery-${original}`)
    await observer.close()
})

test('restoring a deferred copy adopts its slot, preserves it on failed save, and clears it after durable save', async ({ page }) => {
    await boot(page)
    const original = await page.evaluate(async () => { await window.layersApp._recovery.flush(); return window.layersApp._recovery._id })
    page.on('dialog', dialog => dialog.accept())
    await page.reload({ waitUntil: 'networkidle' })
    await page.getByRole('button', { name: 'Keep for later', exact: true }).click()
    await page.evaluate(() => window.layersApp._showRecoveryDialog())
    await page.getByRole('button', { name: 'Restore', exact: true }).click()
    await expect.poll(() => page.evaluate(() => window.layersApp._layers.length)).toBe(1)
    expect(await page.evaluate(() => window.layersApp._recovery._id)).toBe(original)
    const failed = await page.evaluate(async () => {
        const app = window.layersApp, capture = app._capturePersistableProject
        app._capturePersistableProject = async () => { throw new Error('injected durable save failure') }
        try { return await window.LayersAgent.saveProjectAs({ name: 'failed save' }) }
        finally { app._capturePersistableProject = capture }
    })
    expect(failed.ok).toBe(false)
    expect(await page.evaluate(async () => (await (await import('/js/utils/project-recovery.js')).listRecoveries()).map(row => row.id))).toContain(original)
    expect((await page.evaluate(() => window.LayersAgent.saveProjectAs({ name: 'recovered saved' }))).ok).toBe(true)
    await page.reload({ waitUntil: 'networkidle' })
    await page.waitForFunction(() => !!window.LayersAgent, null, { timeout: 15000 })
    await page.evaluate(() => window.LayersAgent.ready)
    await expect(page.locator('.recovery-dialog')).not.toBeVisible()
    expect(await page.evaluate(async () => (await (await import('/js/utils/project-recovery.js')).listRecoveries()).map(row => row.id))).not.toContain(original)
})

test('failed restore preserves its source, and another live owner prevents source adoption', async ({ page, context }) => {
    await recoveryHarness(page)
    const initial = await page.evaluate(async () => {
        const { ProjectRecovery, listRecoveries } = await import('/js/utils/project-recovery.js')
        let dirty = true
        const journal = new ProjectRecovery({ capture: async () => ({ name: 'source', layers: [] }), isDirty: () => dirty, onError: error => { throw error } })
        window.__journal = journal
        await journal.flush()
        const sourceId = await journal._id
        dirty = false
        await journal.retain()
        const currentId = await journal._id
        const restored = await journal.restore(sourceId, async () => false)
        return { sourceId, currentId, restored, afterId: await journal._id, records: (await listRecoveries()).map(row => row.id) }
    })
    expect(initial.restored).toBe(false)
    expect(initial.afterId).toBe(initial.currentId)
    expect(initial.records).toContain(initial.sourceId)
    const owner = await context.newPage()
    await recoveryHarness(owner)
    expect(await owner.evaluate(async id => {
        sessionStorage.setItem('layers-recovery-id', id)
        const { ProjectRecovery } = await import('/js/utils/project-recovery.js')
        window.__journal = new ProjectRecovery({ capture: async () => null, isDirty: () => false, onError: error => { throw error } })
        return window.__journal._id
    }, initial.sourceId)).toBe(initial.sourceId)
    const blocked = await page.evaluate(async id => {
        let loads = 0
        try { await window.__journal.restore(id, async () => { loads++; return true }) }
        catch (error) { return { code: error.code, loads, currentId: await window.__journal._id } }
    }, initial.sourceId)
    expect(blocked).toEqual({ code: 'RECOVERY_IN_USE', loads: 0, currentId: initial.currentId })
    expect(await owner.evaluate(async () => (await window.__journal.list()).map(row => row.id))).toContain(initial.sourceId)
    await owner.close()
})

test('restore reads the latest durable source under its claim and refuses a missing checkpoint', async ({ page }) => {
    await recoveryHarness(page)
    const result = await page.evaluate(async () => {
        const { ProjectRecovery } = await import('/js/utils/project-recovery.js')
        let dirty = true
        const journal = new ProjectRecovery({ capture: async () => ({ name: 'old list snapshot', layers: [] }), isDirty: () => dirty, onError: error => { throw error } })
        await journal.flush()
        const id = await journal._id
        dirty = false
        await journal.retain()
        const currentId = await journal._id
        const request = indexedDB.open('layers-recovery')
        const db = await new Promise(resolve => { request.onsuccess = () => resolve(request.result) })
        async function write(remove = false) {
            await new Promise((resolve, reject) => {
                const tx = db.transaction('documents', 'readwrite')
                if (remove) tx.objectStore('documents').delete(id)
                else tx.objectStore('documents').put({ id, name: 'latest durable snapshot', layers: [], modifiedAt: Date.now() })
                tx.oncomplete = resolve
                tx.onabort = () => reject(tx.error)
            })
        }
        await write()
        let loadedName
        await journal.restore(id, async record => { loadedName = record?.name; return false })
        await write(true)
        let missingCode, loads = 0
        try { await journal.restore(id, async () => { loads++; return true }) }
        catch (error) { missingCode = error.code }
        db.close()
        return { loadedName, missingCode, loads, currentId, afterId: await journal._id }
    })
    expect(result.loadedName).toBe('latest durable snapshot')
    expect(result.missingCode).toBe('RECOVERY_NOT_FOUND')
    expect(result.loads).toBe(0)
    expect(result.afterId).toBe(result.currentId)
})
