import { test, expect } from './fixtures.js'

test('normal storage profiles retain native files across reload and isolate independent contexts', async ({ page, newContext }) => {
    await page.goto('/js/utils/project-storage.js')
    const id = await page.evaluate(async () => {
        const { saveProject } = await import('/js/utils/project-storage.js')
        return saveProject({
            name: 'profile isolation', canvasWidth: 16, canvasHeight: 16,
            layers: [{ id: 'image', sourceType: 'media',
                mediaFile: new File([new Uint8Array([0, 127, 255])], 'pixels.bin', { type: 'application/octet-stream' }) }],
        })
    })
    await page.reload()
    const bytes = await page.evaluate(async id => {
        const { loadProject } = await import('/js/utils/project-storage.js')
        const project = await loadProject(id)
        const file = project.mediaFiles.get('image')
        return { nativeFile: file instanceof File, bytes: [...new Uint8Array(await file.arrayBuffer())] }
    }, id)
    expect(bytes).toEqual({ nativeFile: true, bytes: [0, 127, 255] })

    const independent = await newContext({ viewport: { width: 321, height: 234 } })
    const otherPage = independent.pages()[0] ?? await independent.newPage()
    await otherPage.goto('/js/utils/project-storage.js')
    expect(otherPage.viewportSize()).toEqual({ width: 321, height: 234 })
    const projects = await otherPage.evaluate(async () => {
        const { listProjects } = await import('/js/utils/project-storage.js')
        return listProjects()
    })
    expect(projects).toEqual([])
})

test('boot requests persistent storage exactly once and repeat calls are no-ops', async ({ page }) => {
    await page.addInitScript(() => {
        window.__persistCalls = 0
        const storage = navigator.storage
        const original = storage.persist.bind(storage)
        storage.persist = () => {
            window.__persistCalls++
            return original()
        }
    })
    await page.goto('/js/utils/project-storage.js')
    const result = await page.evaluate(async () => {
        const { requestPersistentStorage } = await import('/js/utils/project-storage.js')
        const repeat = await requestPersistentStorage()
        return { callsAfterImport: window.__persistCalls, repeat }
    })
    // The module-level init already spent the one request; the explicit
    // repeat call is a no-op.
    expect(result).toEqual({ callsAfterImport: 1, repeat: null })
})

test('requestPersistentStorage tolerates a missing StorageManager', async ({ page }) => {
    await page.addInitScript(() => {
        Object.defineProperty(navigator, 'storage', { value: undefined, configurable: true })
    })
    await page.goto('/js/utils/project-storage.js')
    const result = await page.evaluate(async () => {
        const { requestPersistentStorage } = await import('/js/utils/project-storage.js')
        return { grant: await requestPersistentStorage(), hasStorage: navigator.storage }
    })
    expect(result).toEqual({ grant: null, hasStorage: undefined })
})

test('requestPersistentStorage maps a rejecting persist() to null', async ({ page }) => {
    await page.addInitScript(() => {
        Object.defineProperty(navigator, 'storage', {
            value: { persist: () => Promise.reject(new DOMException('denied', 'NotAllowedError')) },
            configurable: true,
        })
    })
    await page.goto('/js/utils/project-storage.js')
    const grant = await page.evaluate(async () => {
        const { requestPersistentStorage } = await import('/js/utils/project-storage.js')
        return requestPersistentStorage()
    })
    expect(grant).toBeNull()
})
