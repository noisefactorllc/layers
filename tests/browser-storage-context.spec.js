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
