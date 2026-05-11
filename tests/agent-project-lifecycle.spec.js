import { test, expect } from 'playwright/test'

async function bootApp(page) {
    await page.goto('/', { waitUntil: 'networkidle' })
    await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })
    await page.evaluate(async () => { await window.LayersAgent.ready })
    const visible = await page.evaluate(() => !!document.querySelector('.open-dialog-backdrop.visible'))
    if (visible) {
        await page.click('.media-option[data-type="solid"]')
        await page.waitForSelector('.canvas-size-dialog', { timeout: 5000 })
        await page.click('.canvas-size-dialog .action-btn.primary')
        await page.waitForSelector('.open-dialog-backdrop.visible', { state: 'hidden', timeout: 5000 })
    }
}

test.describe('newProject', () => {
    test('clears layers and sets canvas to requested dimensions', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() =>
            window.LayersAgent.newProject({ width: 800, height: 600 }))
        expect(env.ok).toBe(true)
        expect(env.state.canvas).toEqual({ width: 800, height: 600 })
        expect(env.state.layers).toEqual([])
        expect(env.state.project.isDirty).toBe(false)
        expect(env.state.project.id).toBeNull()
    })

    test('rejects invalid dimensions', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() =>
            window.LayersAgent.newProject({ width: 0, height: 600 }))
        expect(env.ok).toBe(false)
        expect(env.error.code).toBe('INVALID_ARGS_RANGE')
    })

    test('rejects oversized canvas', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() =>
            window.LayersAgent.newProject({ width: 9999, height: 9999 }))
        expect(env.ok).toBe(false)
        expect(env.error.code).toBe('INVALID_ARGS_RANGE')
    })
})

test.describe('saveProject / openProject / deleteProject', () => {
    test('saveProjectAs persists to storage; listProjects reflects it', async ({ page }) => {
        await bootApp(page)
        const saved = await page.evaluate(() =>
            window.LayersAgent.saveProjectAs({ name: 'agent-test-project' }))
        expect(saved.ok).toBe(true)
        expect(saved.result.projectId).toBeTruthy()
        expect(saved.state.project.name).toBe('agent-test-project')
        expect(saved.state.project.isDirty).toBe(false)

        const env = await page.evaluate(() => window.LayersAgent.listProjects())
        expect(env.ok).toBe(true)
        const found = env.result.projects.find(p => p.name === 'agent-test-project')
        expect(found).toBeDefined()
    })

    test('openProject loads a saved project', async ({ page }) => {
        await bootApp(page)
        const saved = await page.evaluate(() =>
            window.LayersAgent.saveProjectAs({ name: 'open-target' }))
        const projectId = saved.result.projectId
        await page.evaluate(() =>
            window.LayersAgent.newProject({ width: 100, height: 100 }))
        const env = await page.evaluate((id) =>
            window.LayersAgent.openProject({ projectId: id }), projectId)
        expect(env.ok).toBe(true)
        expect(env.state.project.id).toBe(projectId)
        expect(env.state.project.name).toBe('open-target')
    })

    test('openProject NOT_FOUND_PROJECT for unknown id', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() =>
            window.LayersAgent.openProject({ projectId: 'project-nope' }))
        expect(env.ok).toBe(false)
        expect(env.error.code).toBe('NOT_FOUND_PROJECT')
    })

    test('saveProject (quick-save) requires either current project or name', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() => window.LayersAgent.saveProject({}))
        expect(env.ok).toBe(false)
        expect(env.error.code).toBe('INVALID_ARGS_REQUIRED')
        expect(env.error.details.field).toBe('name')
    })

    test('saveProject (quick-save) updates existing project after first save', async ({ page }) => {
        await bootApp(page)
        const first = await page.evaluate(() =>
            window.LayersAgent.saveProjectAs({ name: 'rolling' }))
        const projectId = first.result.projectId
        await page.evaluate(() =>
            window.LayersAgent.addLayer({ kind: 'effect', effectId: 'synth/gradient' }))
        const env = await page.evaluate(() => window.LayersAgent.saveProject({}))
        expect(env.ok).toBe(true)
        expect(env.result.projectId).toBe(projectId)
    })

    test('deleteProject removes from storage', async ({ page }) => {
        await bootApp(page)
        const saved = await page.evaluate(() =>
            window.LayersAgent.saveProjectAs({ name: 'doomed' }))
        const projectId = saved.result.projectId
        const env = await page.evaluate((id) =>
            window.LayersAgent.deleteProject({ projectId: id }), projectId)
        expect(env.ok).toBe(true)
        const list = await page.evaluate(() => window.LayersAgent.listProjects())
        const found = list.result.projects.find(p => p.id === projectId)
        expect(found).toBeUndefined()
    })

    test('saveProject rejects empty name', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() => window.LayersAgent.saveProject({ name: '' }))
        expect(env.ok).toBe(false)
        expect(env.error.code).toBe('INVALID_ARGS_REQUIRED')
        expect(env.error.details.field).toBe('name')
    })

    test('saveProjectAs rejects empty name', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() => window.LayersAgent.saveProjectAs({ name: '' }))
        expect(env.ok).toBe(false)
        expect(env.error.code).toBe('INVALID_ARGS_REQUIRED')
        expect(env.error.details.field).toBe('name')
    })

    test('deleteProject of active project clears project id', async ({ page }) => {
        await bootApp(page)
        const saved = await page.evaluate(() =>
            window.LayersAgent.saveProjectAs({ name: 'self-delete' }))
        const projectId = saved.result.projectId
        // confirm it's the active project
        expect(saved.state.project.id).toBe(projectId)
        const env = await page.evaluate((id) =>
            window.LayersAgent.deleteProject({ projectId: id }), projectId)
        expect(env.ok).toBe(true)
        expect(env.state.project.id).toBeNull()
    })
})
