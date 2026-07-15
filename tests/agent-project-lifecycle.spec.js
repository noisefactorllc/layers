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

    test('failed staging leaves an online session connected', async ({ page }) => {
        await bootApp(page)
        const result = await page.evaluate(async () => {
            const app = window.layersApp
            let online = true
            let disconnects = 0
            app._onlineAdapter = {
                isOnline: () => online,
                isApplyingRemote: () => false,
                goOffline: () => { online = false; disconnects += 1 },
                schedulePublish: () => {},
            }
            app._renderer.stageLayerSet = async () => ({
                success: false,
                error: 'candidate compile failed',
                commit() {},
                rollback: async () => ({ success: true }),
            })
            const envelope = await window.LayersAgent.newProject({
                width: 210, height: 120, name: 'Should fail',
            })
            return { envelope, online, disconnects }
        })

        expect(result.envelope.ok).toBe(false)
        expect(result.online).toBe(true)
        expect(result.disconnects).toBe(0)
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

    test('saveProjectAs stays successful when its success toast throws', async ({ page }) => {
        await bootApp(page)
        const result = await page.evaluate(async () => {
            const app = window.layersApp
            const { toast } = await import('/js/ui/toast.js')
            const { getProject } = await import('/js/utils/project-storage.js')
            toast.success = () => { throw new Error('injected save toast failure') }
            const envelope = await window.LayersAgent.saveProjectAs({
                name: 'durable-save',
            })
            const stored = app._currentProjectId
                ? await getProject(app._currentProjectId)
                : null
            return {
                envelope,
                projectId: app._currentProjectId,
                projectName: app._currentProjectName,
                dirty: app._isDirty,
                storedName: stored?.name || null,
            }
        })

        expect(result.envelope.ok).toBe(true)
        expect(result.envelope.result.projectId).toBe(result.projectId)
        expect(result.projectId).toBeTruthy()
        expect(result.projectName).toBe('durable-save')
        expect(result.dirty).toBe(false)
        expect(result.storedName).toBe('durable-save')
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

    test('openProject reports a generation-cancelled load as a conflict', async ({ page }) => {
        await bootApp(page)
        const saved = await page.evaluate(() =>
            window.LayersAgent.saveProjectAs({ name: 'cancelled-open-target' }))
        const env = await page.evaluate(async (projectId) => {
            window.layersApp._loadProject = async () => 'cancelled'
            return window.LayersAgent.openProject({ projectId })
        }, saved.result.projectId)

        expect(env.ok).toBe(false)
        expect(env.error.code).toBe('CONFLICT_PROJECT_REPLACEMENT')
    })

    test('openProject preserves a not-found result from a deletion race', async ({ page }) => {
        await bootApp(page)
        const saved = await page.evaluate(() =>
            window.LayersAgent.saveProjectAs({ name: 'deleted-open-target' }))
        const env = await page.evaluate(async (projectId) => {
            window.layersApp._loadProject = async () => 'not-found'
            return window.LayersAgent.openProject({ projectId })
        }, saved.result.projectId)

        expect(env.ok).toBe(false)
        expect(env.error.code).toBe('NOT_FOUND_PROJECT')
    })

    test('failed open staging leaves an online session connected', async ({ page }) => {
        await bootApp(page)
        const saved = await page.evaluate(() =>
            window.LayersAgent.saveProjectAs({ name: 'online-open-failure' }))
        const result = await page.evaluate(async (projectId) => {
            const app = window.layersApp
            let online = true
            let disconnects = 0
            app._onlineAdapter = {
                isOnline: () => online,
                isApplyingRemote: () => false,
                goOffline: () => { online = false; disconnects += 1 },
                schedulePublish: () => {},
            }
            app._renderer.stageLayerSet = async () => ({
                success: false,
                error: 'candidate compile failed',
                commit() {},
                rollback: async () => ({ success: true }),
            })
            const envelope = await window.LayersAgent.openProject({ projectId })
            return { envelope, online, disconnects }
        }, saved.result.projectId)

        expect(result.envelope.ok).toBe(false)
        expect(result.online).toBe(true)
        expect(result.disconnects).toBe(0)
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
        // Schema-level minLength:1 fires before the handler's own check.
        expect(env.error.code).toBe('INVALID_ARGS_RANGE')
        expect(env.error.details.field).toBe('name')
    })

    test('saveProjectAs rejects empty name', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() => window.LayersAgent.saveProjectAs({ name: '' }))
        expect(env.ok).toBe(false)
        // Schema-level minLength:1 fires before the handler's own check.
        expect(env.error.code).toBe('INVALID_ARGS_RANGE')
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
