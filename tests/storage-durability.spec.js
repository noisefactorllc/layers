import { test, expect } from './fixtures.js'

test('media cleanup cannot delete a project committed after the reference scan', async ({ page }) => {
    await page.goto('/js/utils/project-storage.js')
    const result = await page.evaluate(async () => {
        const storage = await import('/js/utils/project-storage.js')
        const original = IDBDatabase.prototype.transaction
        let injected = false
        IDBDatabase.prototype.transaction = function (stores, mode, ...args) {
            if (!injected && this.name === 'layers-projects' && mode === 'readwrite'
                && (Array.isArray(stores) ? stores.includes('media') : stores === 'media')) {
                injected = true
                const concurrent = original.call(this, ['projects', 'media'], 'readwrite')
                concurrent.objectStore('media').put({ id: 'concurrent-media', blob: new Blob(['original']), name: 'image.png', type: 'image/png' })
                concurrent.objectStore('projects').put({ id: 'concurrent-project', name: 'other tab', modifiedAt: Date.now(), layers: [{ id: 'photo', sourceType: 'media', mediaId: 'concurrent-media' }] })
            }
            return original.call(this, stores, mode, ...args)
        }
        try {
            await storage.deleteProject('unused')
            const loaded = await storage.loadProject('concurrent-project')
            return { injected, content: await loaded?.mediaFiles.get('photo')?.text() }
        } finally { IDBDatabase.prototype.transaction = original }
    })
    expect(result).toEqual({ injected: true, content: 'original' })
})

test('loading a project reads its media from the same transaction snapshot', async ({ page }) => {
    await page.goto('/js/utils/project-storage.js')
    const result = await page.evaluate(async () => {
        const storage = await import('/js/utils/project-storage.js')
        const id = await storage.saveProject({ name: 'snapshot', canvasWidth: 16, canvasHeight: 16,
            layers: [{ id: 'image', sourceType: 'media', mediaFile: new File(['pixels'], 'image.png', { type: 'image/png' }) }] })
        const original = IDBObjectStore.prototype.get
        let changed = false
        IDBObjectStore.prototype.get = function (key) {
            const request = original.call(this, key)
            if (!changed && this.name === 'projects' && key === id) {
                changed = true
                const db = this.transaction.db
                request.addEventListener('success', () => {
                    const concurrent = db.transaction(['projects', 'media'], 'readwrite')
                    concurrent.objectStore('projects').delete(id)
                    concurrent.objectStore('media').clear()
                })
            }
            return request
        }
        try {
            const loaded = await storage.loadProject(id)
            return { changed, pixels: await loaded.mediaFiles.get('image')?.text() }
        } finally { IDBObjectStore.prototype.get = original }
    })
    expect(result).toEqual({ changed: true, pixels: 'pixels' })
})

async function boot(page) {
    await page.goto('/', { waitUntil: 'networkidle' })
    await page.evaluate(async () => { await window.LayersAgent.ready })
    await page.evaluate(() => window.LayersAgent.newProject({ width: 64, height: 64 }))
    await page.evaluate(() => window.LayersAgent.addLayer({
        kind: 'effect', effectId: 'synth/solid', params: { color: [1, 0, 0] },
    }))
}

test('a transaction aborted after a successful request never reports a saved project', async ({ page }) => {
    await boot(page)
    const result = await page.evaluate(async () => {
        const original = IDBObjectStore.prototype.put
        IDBObjectStore.prototype.put = function (...args) {
            const request = original.apply(this, args)
            if (this.name === 'projects') {
                const tx = this.transaction
                request.addEventListener('success', () => tx.abort())
            }
            return request
        }
        let envelope
        try {
            envelope = await window.LayersAgent.saveProjectAs({ name: 'aborted' })
        } finally {
            IDBObjectStore.prototype.put = original
        }
        const { listProjects } = await import('/js/utils/project-storage.js')
        return {
            ok: envelope.ok,
            dirty: window.layersApp._isDirty,
            id: window.layersApp._currentProjectId,
            projects: await listProjects(),
        }
    })
    expect(result).toEqual({ ok: false, dirty: true, id: null, projects: [] })
})

test('a failed overwrite retains the previous durable project and unsaved changes', async ({ page }) => {
    await boot(page)
    const result = await page.evaluate(async () => {
        const app = window.layersApp
        const saved = await window.LayersAgent.saveProjectAs({ name: 'original' })
        await window.LayersAgent.addLayer({ kind: 'effect', effectId: 'synth/solid' })
        const original = IDBObjectStore.prototype.put
        IDBObjectStore.prototype.put = function (...args) {
            const request = original.apply(this, args)
            if (this.name === 'projects') {
                const tx = this.transaction
                request.addEventListener('success', () => tx.abort())
            }
            return request
        }
        let envelope
        try { envelope = await window.LayersAgent.saveProject({ name: 'replacement' }) }
        finally { IDBObjectStore.prototype.put = original }
        const { getProject } = await import('/js/utils/project-storage.js')
        const stored = await getProject(saved.result.projectId)
        return {
            ok: envelope.ok, dirty: app._isDirty, currentName: app._currentProjectName,
            storedName: stored.name, storedLayers: stored.layers.length,
            liveLayers: app._layers.length,
        }
    })
    expect(result).toEqual({
        ok: false, dirty: true, currentName: 'original',
        storedName: 'original', storedLayers: 1, liveLayers: 2,
    })
})

test('media and its project commit atomically', async ({ page }) => {
    await boot(page)
    const result = await page.evaluate(async () => {
        const { saveProject, listProjects } = await import('/js/utils/project-storage.js')
        const original = IDBObjectStore.prototype.put
        IDBObjectStore.prototype.put = function (...args) {
            const request = original.apply(this, args)
            if (this.name === 'projects') {
                const tx = this.transaction
                request.addEventListener('success', () => tx.abort())
            }
            return request
        }
        let rejected = false
        try {
            await saveProject({ name: 'media-abort', canvasWidth: 1, canvasHeight: 1,
                layers: [{ id: 'media', sourceType: 'media', mediaType: 'image',
                    mediaFile: new File(['original pixels'], 'image.png', { type: 'image/png' }) }],
            })
        } catch { rejected = true }
        finally { IDBObjectStore.prototype.put = original }
        const projects = await listProjects()
        const db = await new Promise((resolve, reject) => {
            const request = indexedDB.open('layers-projects')
            request.onsuccess = () => resolve(request.result)
            request.onerror = () => reject(request.error)
        })
        const mediaCount = await new Promise((resolve, reject) => {
            const request = db.transaction('media').objectStore('media').count()
            request.onsuccess = () => resolve(request.result)
            request.onerror = () => reject(request.error)
        })
        db.close()
        return { rejected, projects, mediaCount }
    })
    expect(result).toEqual({ rejected: true, projects: [], mediaCount: 0 })
})
