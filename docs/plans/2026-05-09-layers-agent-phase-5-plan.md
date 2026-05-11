# Layers Agent — Phase 5 (Project & Settings) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the agent's session-management surface — project CRUD (new/open/save/save-as/delete), undo/redo, settings/foreground/zoom/play, image and canvas resize, and auto-adjust commands.

**Architecture:** All commands live in `public/js/agent/commands.js`. Most wrap existing `app._*` methods directly (`_loadProject`, `_saveProject`, `_undo`, `_redo`, `_setZoom`, `_setForegroundColor`, `_resizeImage`, `_changeCanvasSize`, `_handleAutoCorrection`). `newProject` replicates `_resetLayers` plus canvas/state cleanup, deliberately bypassing the `openDialog` UI flow to give the agent a programmatic blank-canvas operation. `setSettings` writes the canonical localStorage keys directly (matching `getSettings` in Phase 1's `buildSettings`); for Phase 5 it supports the `theme` field and ignores unknown keys with a warning.

**Tech Stack:** Vanilla ES modules. No new runtime dependencies. Playwright for tests.

**Reference spec:** `docs/plans/2026-05-07-layers-agent-instrumentation-design.md`
**Reference Phase 4-drawing plan:** `docs/plans/2026-05-09-layers-agent-phase-4-drawing-plan.md`

---

## File structure

**Modify:**
- `public/js/agent/commands.js` — add ~14 handlers + 1 helper.
- `public/js/agent/schemas.js` — append schemas.
- `public/js/agent/index.js` — register each new command.

**Create (tests):**
- `tests/agent-project-lifecycle.spec.js` — newProject, openProject, saveProject, saveProjectAs, deleteProject.
- `tests/agent-edit-history.spec.js` — undo, redo.
- `tests/agent-view-color-settings.spec.js` — setForegroundColor, setZoom, play, pause, setSettings.
- `tests/agent-resize.spec.js` — resizeImage, resizeCanvas.
- `tests/agent-auto-adjust.spec.js` — autoLevels, autoContrast, autoWhiteBalance.

---

## Task 1: Project lifecycle (newProject, openProject, saveProject, saveProjectAs, deleteProject)

**Files:**
- Modify: `public/js/agent/commands.js`, `public/js/agent/schemas.js`, `public/js/agent/index.js`
- Test: `tests/agent-project-lifecycle.spec.js`

`newProject` resets state to a blank canvas at given dimensions. `openProject` wraps `_loadProject`. `saveProject` saves the current project (errors if no name and no current id). `saveProjectAs` always creates a new saved record. `deleteProject` wraps the storage `deleteProject`.

- [ ] **Step 1: Write the failing tests**

Create `tests/agent-project-lifecycle.spec.js`:

```js
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
        // Create a project, save it.
        const saved = await page.evaluate(() =>
            window.LayersAgent.saveProjectAs({ name: 'open-target' }))
        const projectId = saved.result.projectId
        // Modify state.
        await page.evaluate(() =>
            window.LayersAgent.newProject({ width: 100, height: 100 }))
        // Open the saved one back.
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
        // Fresh boot: no current project, no name → REQUIRED.
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
        // Add a layer to dirty the state.
        await page.evaluate(() =>
            window.LayersAgent.addLayer({ kind: 'effect', effectId: 'synth/gradient' }))
        // Quick-save without name; should update the same id.
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
})
```

- [ ] **Step 2: Run test to verify it fails**

```
npx playwright test tests/agent-project-lifecycle.spec.js --reporter=line
```

Expected: FAIL — commands not registered.

- [ ] **Step 3: Add schemas**

Modify `public/js/agent/schemas.js`. Append to `SCHEMAS`:

```js
    newProject: {
        type: 'object',
        required: ['width', 'height'],
        properties: {
            width: { type: 'integer', min: 1, max: 8192 },
            height: { type: 'integer', min: 1, max: 8192 },
            name: { type: 'string' }
        }
    },
    openProject: {
        type: 'object',
        required: ['projectId'],
        properties: { projectId: { type: 'string' } }
    },
    saveProject: {
        type: 'object',
        properties: { name: { type: 'string' } }
    },
    saveProjectAs: {
        type: 'object',
        required: ['name'],
        properties: { name: { type: 'string' } }
    },
    deleteProject: {
        type: 'object',
        required: ['projectId'],
        properties: { projectId: { type: 'string' } }
    },
```

- [ ] **Step 4: Add handlers**

Modify `public/js/agent/commands.js`. Add the import at the top alongside the existing imports (the existing file already imports `listProjects as listProjectsStorage`; extend that import):

```js
import {
    listProjects as listProjectsStorage,
    saveProject as saveProjectStorage,
    loadProject as loadProjectStorage,
    deleteProject as deleteProjectStorage,
    getProject as getProjectStorage
} from '../utils/project-storage.js'
```

(Replace the existing single-import line with this multi-import line.)

Append (after the existing drawing handlers — find `fillRegion` and add after):

```js
export async function newProject({ width, height, name }, app) {
    app._finalizePendingUndo?.()
    // Clear selection if any.
    app._selectionManager?.clearSelection?.()
    // Reset layers (handles media unload + mask cleanup + undo clear).
    app._resetLayers()
    // Resize canvas to requested dimensions.
    app._renderer?.stop?.()
    app._resizeCanvas(width, height)
    await app._rebuild?.()
    await new Promise(resolve => requestAnimationFrame(resolve))
    app._renderer?.start?.()
    // Reset project identity and clean state.
    app._currentProjectId = null
    app._currentProjectName = name || null
    app._markClean?.()
    app._updateLayerStack?.()
    app._pushUndoState?.()
    return { result: { width, height } }
}

export async function openProject({ projectId }, app) {
    const stored = await getProjectStorage(projectId).catch(() => null)
    if (!stored) {
        throw commandError('NOT_FOUND_PROJECT',
            `Project not found: ${projectId}`,
            { projectId })
    }
    await app._loadProject(projectId)
    return { result: { projectId } }
}

export async function saveProject({ name }, app) {
    const haveCurrent = !!app._currentProjectId && !!app._currentProjectName
    const useName = name || app._currentProjectName
    if (!haveCurrent && !name) {
        throw commandError('INVALID_ARGS_REQUIRED',
            'name is required when there is no current project to update',
            { field: 'name' })
    }
    await app._saveProject(app._currentProjectId, useName)
    return { result: { projectId: app._currentProjectId } }
}

export async function saveProjectAs({ name }, app) {
    // saveProjectAs always creates a NEW saved record — pass null id.
    await app._saveProject(null, name)
    return { result: { projectId: app._currentProjectId } }
}

export async function deleteProject({ projectId }, app) {
    const existing = await getProjectStorage(projectId).catch(() => null)
    if (!existing) {
        throw commandError('NOT_FOUND_PROJECT',
            `Project not found: ${projectId}`,
            { projectId })
    }
    await deleteProjectStorage(projectId)
    // If we just deleted the currently-loaded project, clear the current project id.
    if (app._currentProjectId === projectId) {
        app._currentProjectId = null
    }
    return { result: { projectId } }
}
```

- [ ] **Step 5: Register the commands**

Modify `public/js/agent/index.js`. After the existing drawing registrations, append:

```js
    registerCommand(LayersAgent, 'newProject', commands.newProject)
    registerCommand(LayersAgent, 'openProject', commands.openProject)
    registerCommand(LayersAgent, 'saveProject', commands.saveProject)
    registerCommand(LayersAgent, 'saveProjectAs', commands.saveProjectAs)
    registerCommand(LayersAgent, 'deleteProject', commands.deleteProject)
```

- [ ] **Step 6: Run tests to verify they pass**

```
npx playwright test tests/agent-project-lifecycle.spec.js --reporter=line
```

Expected: 9/9 PASS (3 newProject + 6 save/open/delete).

Smoke check the rest:

```
npx playwright test tests/agent-*.spec.js --reporter=line
```

Expected: 171 (Phase 1+2+3+4) + 9 = 180 tests pass.

- [ ] **Step 7: Commit**

```
git add public/js/agent/commands.js public/js/agent/schemas.js public/js/agent/index.js tests/agent-project-lifecycle.spec.js
git commit -m "feat(agent): newProject, openProject, saveProject, saveProjectAs, deleteProject"
```

---

## Task 2: undo + redo

**Files:**
- Modify: `public/js/agent/commands.js`, `public/js/agent/schemas.js`, `public/js/agent/index.js`
- Test: `tests/agent-edit-history.spec.js`

Wraps `app._undo()` / `app._redo()`. Returns ok envelope. The snapshot already surfaces `canUndo` / `canRedo` via `state.project`, so callers can pre-check.

- [ ] **Step 1: Write the failing tests**

Create `tests/agent-edit-history.spec.js`:

```js
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

test.describe('undo / redo', () => {
    test('undo reverses the last addLayer', async ({ page }) => {
        await bootApp(page)
        const before = await page.evaluate(() => window.layersApp._layers.length)
        await page.evaluate(() =>
            window.LayersAgent.addLayer({ kind: 'effect', effectId: 'synth/gradient' }))
        const env = await page.evaluate(() => window.LayersAgent.undo())
        expect(env.ok).toBe(true)
        expect(env.state.layers.length).toBe(before)
    })

    test('redo reapplies an undone change', async ({ page }) => {
        await bootApp(page)
        await page.evaluate(() =>
            window.LayersAgent.addLayer({ kind: 'effect', effectId: 'synth/gradient' }))
        const afterAdd = await page.evaluate(() => window.layersApp._layers.length)
        await page.evaluate(() => window.LayersAgent.undo())
        const env = await page.evaluate(() => window.LayersAgent.redo())
        expect(env.ok).toBe(true)
        expect(env.state.layers.length).toBe(afterAdd)
    })

    test('undo no-op succeeds when nothing to undo', async ({ page }) => {
        await bootApp(page)
        // After bootApp the default solid layer was added, but undo can roll back
        // either to the previous state or be a no-op depending on initial undo
        // history. Either way, undo() returns ok=true without throwing.
        const env = await page.evaluate(() => window.LayersAgent.undo())
        expect(env.ok).toBe(true)
    })

    test('snapshot exposes canUndo/canRedo', async ({ page }) => {
        await bootApp(page)
        await page.evaluate(() =>
            window.LayersAgent.addLayer({ kind: 'effect', effectId: 'synth/gradient' }))
        const env = await page.evaluate(() => window.LayersAgent.getState())
        expect(env.state.project.canUndo).toBe(true)
    })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```
npx playwright test tests/agent-edit-history.spec.js --reporter=line
```

Expected: FAIL.

- [ ] **Step 3: Add schemas**

Modify `public/js/agent/schemas.js`. Append:

```js
    undo: null,
    redo: null,
```

- [ ] **Step 4: Add handlers**

Modify `public/js/agent/commands.js`. Append (after `deleteProject`):

```js
export async function undo(_args, app) {
    await app._undo()
    return { result: { ok: true } }
}

export async function redo(_args, app) {
    await app._redo()
    return { result: { ok: true } }
}
```

- [ ] **Step 5: Register the commands**

Modify `public/js/agent/index.js`. After `deleteProject`:

```js
    registerCommand(LayersAgent, 'undo', commands.undo)
    registerCommand(LayersAgent, 'redo', commands.redo)
```

- [ ] **Step 6: Run tests to verify they pass**

```
npx playwright test tests/agent-edit-history.spec.js --reporter=line
```

Expected: 4/4 PASS.

- [ ] **Step 7: Commit**

```
git add public/js/agent/commands.js public/js/agent/schemas.js public/js/agent/index.js tests/agent-edit-history.spec.js
git commit -m "feat(agent): undo and redo commands"
```

---

## Task 3: setForegroundColor + setZoom + play + pause + setSettings

**Files:**
- Modify: `public/js/agent/commands.js`, `public/js/agent/schemas.js`, `public/js/agent/index.js`
- Test: `tests/agent-view-color-settings.spec.js`

Five small commands grouped because they all touch view/UI state and are similarly trivial wrappers.

- `setForegroundColor({ color })` — wraps `_setForegroundColor`.
- `setZoom({ mode })` — wraps `_setZoom`. Accepts `'fit' | '50' | '100' | '200'`.
- `play()` — calls `app._renderer.start()`.
- `pause()` — calls `app._renderer.stop()`.
- `setSettings({ theme? })` — writes `'layers-theme'` to localStorage and applies via `settingsDialog` if available.

- [ ] **Step 1: Write the failing tests**

Create `tests/agent-view-color-settings.spec.js`:

```js
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

test.describe('setForegroundColor', () => {
    test('updates the agent-visible color', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() =>
            window.LayersAgent.setForegroundColor({ color: '#abcdef' }))
        expect(env.ok).toBe(true)
        expect(env.state.foreground.color).toBe('#abcdef')
    })

    test('rejects malformed color', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() =>
            window.LayersAgent.setForegroundColor({ color: 'not-a-color' }))
        expect(env.ok).toBe(false)
        expect(env.error.code).toBe('INVALID_ARGS_TYPE')
    })
})

test.describe('setZoom', () => {
    test('sets zoom mode to 100', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() =>
            window.LayersAgent.setZoom({ mode: '100' }))
        expect(env.ok).toBe(true)
        expect(env.state.view.zoomMode).toBe('100')
    })

    test('rejects unknown mode', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() =>
            window.LayersAgent.setZoom({ mode: '300' }))
        expect(env.ok).toBe(false)
        expect(env.error.code).toBe('INVALID_ARGS_ENUM')
    })
})

test.describe('play / pause', () => {
    test('pause stops the renderer', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() => window.LayersAgent.pause())
        expect(env.ok).toBe(true)
        expect(env.state.view.isPlaying).toBe(false)
    })

    test('play restarts the renderer after pause', async ({ page }) => {
        await bootApp(page)
        await page.evaluate(() => window.LayersAgent.pause())
        const env = await page.evaluate(() => window.LayersAgent.play())
        expect(env.ok).toBe(true)
        expect(env.state.view.isPlaying).toBe(true)
    })
})

test.describe('setSettings', () => {
    test('persists theme', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() =>
            window.LayersAgent.setSettings({ theme: 'gray' }))
        expect(env.ok).toBe(true)
        expect(env.state.settings.theme).toBe('gray')
        const stored = await page.evaluate(() => localStorage.getItem('layers-theme'))
        expect(stored).toBe('gray')
    })

    test('warns on unknown setting key', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() =>
            window.LayersAgent.setSettings({ unknownKey: 'whatever' }))
        expect(env.ok).toBe(true)
        expect(env.warnings).toBeDefined()
        expect(env.warnings.some(w => w.includes('unknownKey'))).toBe(true)
    })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```
npx playwright test tests/agent-view-color-settings.spec.js --reporter=line
```

Expected: FAIL.

- [ ] **Step 3: Add schemas**

Modify `public/js/agent/schemas.js`. Append:

```js
    setForegroundColor: {
        type: 'object',
        required: ['color'],
        properties: { color: { type: 'string' } }
    },
    setZoom: {
        type: 'object',
        required: ['mode'],
        properties: {
            mode: { type: 'string', enum: ['fit', '50', '100', '200'] }
        }
    },
    play: null,
    pause: null,
    setSettings: {
        type: 'object',
        properties: {
            theme: { type: 'string' }
        }
    },
```

- [ ] **Step 4: Add handlers + helper**

Modify `public/js/agent/commands.js`. Append (after `redo`):

```js
const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/

export async function setForegroundColor({ color }, app) {
    if (!HEX_COLOR_RE.test(color)) {
        throw commandError('INVALID_ARGS_TYPE',
            `color must be a 6-digit hex string like '#aabbcc', got '${color}'`,
            { field: 'color', expected: '#rrggbb' })
    }
    app._setForegroundColor(color)
    return { result: { color } }
}

export async function setZoom({ mode }, app) {
    app._setZoom(mode)
    return { result: { mode } }
}

export async function play(_args, app) {
    app._renderer?.start?.()
    return { result: { isPlaying: true } }
}

export async function pause(_args, app) {
    app._renderer?.stop?.()
    return { result: { isPlaying: false } }
}

const KNOWN_SETTINGS = ['theme']

/**
 * Apply a theme name to the document. Mirrors settings-dialog's private
 * applyTheme — kept inline because that function isn't exported.
 */
function applyThemeInline(themeValue) {
    const resolved = themeValue === 'system'
        ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'neutral-dark' : 'neutral-light')
        : themeValue
    document.documentElement.dataset.theme = resolved
}

export async function setSettings(args = {}, _app) {
    const warnings = []
    if (typeof args.theme === 'string') {
        try {
            localStorage.setItem('layers-theme', args.theme)
            applyThemeInline(args.theme)
        } catch (err) {
            warnings.push(`failed to persist theme: ${err.message || err}`)
        }
    }
    for (const key of Object.keys(args)) {
        if (!KNOWN_SETTINGS.includes(key)) {
            warnings.push(`unknown setting key: ${key} (ignored)`)
        }
    }
    return { result: { applied: KNOWN_SETTINGS.filter(k => k in args) }, warnings }
}
```

- [ ] **Step 5: Register the commands**

Modify `public/js/agent/index.js`. After `redo`:

```js
    registerCommand(LayersAgent, 'setForegroundColor', commands.setForegroundColor)
    registerCommand(LayersAgent, 'setZoom', commands.setZoom)
    registerCommand(LayersAgent, 'play', commands.play)
    registerCommand(LayersAgent, 'pause', commands.pause)
    registerCommand(LayersAgent, 'setSettings', commands.setSettings)
```

- [ ] **Step 6: Run tests to verify they pass**

```
npx playwright test tests/agent-view-color-settings.spec.js --reporter=line
```

Expected: 8/8 PASS.

- [ ] **Step 7: Commit**

```
git add public/js/agent/commands.js public/js/agent/schemas.js public/js/agent/index.js tests/agent-view-color-settings.spec.js
git commit -m "feat(agent): setForegroundColor, setZoom, play, pause, setSettings"
```

---

## Task 4: resizeImage + resizeCanvas

**Files:**
- Modify: `public/js/agent/commands.js`, `public/js/agent/schemas.js`, `public/js/agent/index.js`
- Test: `tests/agent-resize.spec.js`

`resizeImage` resamples all media at the new dimensions (changes content). `resizeCanvas` changes the canvas size with an anchor (no resampling — adds/crops borders). Both wrap existing `_resizeImage` / `_changeCanvasSize`.

- [ ] **Step 1: Write the failing tests**

Create `tests/agent-resize.spec.js`:

```js
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

test.describe('resizeImage', () => {
    test('changes canvas dimensions', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() =>
            window.LayersAgent.resizeImage({ width: 512, height: 384 }))
        expect(env.ok).toBe(true)
        expect(env.state.canvas).toEqual({ width: 512, height: 384 })
    })

    test('rejects oversized', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() =>
            window.LayersAgent.resizeImage({ width: 9999, height: 9999 }))
        expect(env.ok).toBe(false)
        expect(env.error.code).toBe('INVALID_ARGS_RANGE')
    })
})

test.describe('resizeCanvas', () => {
    test('changes canvas dimensions with default anchor', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() =>
            window.LayersAgent.resizeCanvas({ width: 1500, height: 1500 }))
        expect(env.ok).toBe(true)
        expect(env.state.canvas).toEqual({ width: 1500, height: 1500 })
    })

    test('honors anchor', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() =>
            window.LayersAgent.resizeCanvas({ width: 800, height: 600, anchor: 'top-left' }))
        expect(env.ok).toBe(true)
        expect(env.state.canvas).toEqual({ width: 800, height: 600 })
    })

    test('rejects unknown anchor', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() =>
            window.LayersAgent.resizeCanvas({ width: 800, height: 600, anchor: 'middle' }))
        expect(env.ok).toBe(false)
        expect(env.error.code).toBe('INVALID_ARGS_ENUM')
    })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```
npx playwright test tests/agent-resize.spec.js --reporter=line
```

Expected: FAIL.

- [ ] **Step 3: Add schemas**

Modify `public/js/agent/schemas.js`. Append:

```js
    resizeImage: {
        type: 'object',
        required: ['width', 'height'],
        properties: {
            width: { type: 'integer', min: 1, max: 8192 },
            height: { type: 'integer', min: 1, max: 8192 }
        }
    },
    resizeCanvas: {
        type: 'object',
        required: ['width', 'height'],
        properties: {
            width: { type: 'integer', min: 1, max: 8192 },
            height: { type: 'integer', min: 1, max: 8192 },
            anchor: {
                type: 'string',
                enum: ['top-left', 'top', 'top-right', 'left', 'center',
                       'right', 'bottom-left', 'bottom', 'bottom-right']
            }
        }
    },
```

- [ ] **Step 4: Add handlers**

Modify `public/js/agent/commands.js`. Append (after `setSettings`):

```js
export async function resizeImage({ width, height }, app) {
    await app._resizeImage(width, height)
    return { result: { width, height } }
}

export async function resizeCanvas({ width, height, anchor }, app) {
    await app._changeCanvasSize(width, height, anchor || 'center')
    return { result: { width, height, anchor: anchor || 'center' } }
}
```

- [ ] **Step 5: Register the commands**

Modify `public/js/agent/index.js`. After `setSettings`:

```js
    registerCommand(LayersAgent, 'resizeImage', commands.resizeImage)
    registerCommand(LayersAgent, 'resizeCanvas', commands.resizeCanvas)
```

- [ ] **Step 6: Run tests to verify they pass**

```
npx playwright test tests/agent-resize.spec.js --reporter=line
```

Expected: 5/5 PASS.

- [ ] **Step 7: Commit**

```
git add public/js/agent/commands.js public/js/agent/schemas.js public/js/agent/index.js tests/agent-resize.spec.js
git commit -m "feat(agent): resizeImage and resizeCanvas commands"
```

---

## Task 5: autoLevels + autoContrast + autoWhiteBalance

**Files:**
- Modify: `public/js/agent/commands.js`, `public/js/agent/schemas.js`, `public/js/agent/index.js`
- Test: `tests/agent-auto-adjust.spec.js`

Three identical-shape wrappers around `app._handleAutoCorrection(fn)`, where `fn` is one of `autoLevels`/`autoContrast`/`autoWhiteBalance` from `utils/auto-adjust.js`. Each adds a new effect layer with the corresponding correction.

- [ ] **Step 1: Write the failing tests**

Create `tests/agent-auto-adjust.spec.js`:

```js
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

test.describe('auto-adjust commands', () => {
    test('autoLevels runs without error', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() => window.LayersAgent.autoLevels())
        expect(env.ok).toBe(true)
    })

    test('autoContrast runs without error', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() => window.LayersAgent.autoContrast())
        expect(env.ok).toBe(true)
    })

    test('autoWhiteBalance runs without error', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() => window.LayersAgent.autoWhiteBalance())
        expect(env.ok).toBe(true)
    })
})
```

These tests assert success only; the auto-adjust functions return `null` for "no correction needed" on a uniform solid canvas, which the agent treats as success (no error thrown). Real-world content would produce a new layer; the smoke tests confirm the agent surface and the wrappers work.

- [ ] **Step 2: Run tests to verify they fail**

```
npx playwright test tests/agent-auto-adjust.spec.js --reporter=line
```

Expected: FAIL.

- [ ] **Step 3: Add schemas**

Modify `public/js/agent/schemas.js`. Append:

```js
    autoLevels: null,
    autoContrast: null,
    autoWhiteBalance: null,
```

- [ ] **Step 4: Add handlers**

Modify `public/js/agent/commands.js`. Add the import at the top:

```js
import {
    autoLevels as autoLevelsFn,
    autoContrast as autoContrastFn,
    autoWhiteBalance as autoWhiteBalanceFn
} from '../utils/auto-adjust.js'
```

Append (after `resizeCanvas`):

```js
export async function autoLevels(_args, app) {
    await app._handleAutoCorrection(autoLevelsFn)
    return { result: { ok: true } }
}

export async function autoContrast(_args, app) {
    await app._handleAutoCorrection(autoContrastFn)
    return { result: { ok: true } }
}

export async function autoWhiteBalance(_args, app) {
    await app._handleAutoCorrection(autoWhiteBalanceFn)
    return { result: { ok: true } }
}
```

- [ ] **Step 5: Register the commands**

Modify `public/js/agent/index.js`. After `resizeCanvas`:

```js
    registerCommand(LayersAgent, 'autoLevels', commands.autoLevels)
    registerCommand(LayersAgent, 'autoContrast', commands.autoContrast)
    registerCommand(LayersAgent, 'autoWhiteBalance', commands.autoWhiteBalance)
```

- [ ] **Step 6: Run tests to verify they pass**

```
npx playwright test tests/agent-auto-adjust.spec.js --reporter=line
```

Expected: 3/3 PASS.

- [ ] **Step 7: Commit**

```
git add public/js/agent/commands.js public/js/agent/schemas.js public/js/agent/index.js tests/agent-auto-adjust.spec.js
git commit -m "feat(agent): autoLevels, autoContrast, autoWhiteBalance commands"
```

---

## Task 6: Phase 5 verification

**Files:** none — verification only.

- [ ] **Step 1: Run every agent spec**

```
npx playwright test tests/agent-*.spec.js --reporter=line
```

Expected: 171 (Phase 1+2+3+4) + 9 (T1 lifecycle) + 4 (T2 history) + 8 (T3 view) + 5 (T4 resize) + 3 (T5 auto-adjust) = 200 tests pass.

- [ ] **Step 2: Run the full Layers suite**

```
npx playwright test --reporter=line
```

Expected: existing non-agent tests still pass.

- [ ] **Step 3: Manual smoke**

Boot the dev server:

```
npx http-server public -p 3002 -c-1
```

In a browser:
- App loads.
- Devtools console:
  ```js
  await window.LayersAgent.newProject({ width: 800, height: 600 })
  await window.LayersAgent.addLayer({ kind: 'effect', effectId: 'synth/gradient' })
  await window.LayersAgent.saveProjectAs({ name: 'manual-smoke' })
  await window.LayersAgent.undo()
  await window.LayersAgent.redo()
  await window.LayersAgent.setForegroundColor({ color: '#ff00ff' })
  await window.LayersAgent.setZoom({ mode: '50' })
  await window.LayersAgent.resizeCanvas({ width: 1024, height: 1024, anchor: 'center' })
  await window.LayersAgent.autoLevels()
  ```
- All commands return ok envelopes; UI reflects each change.
- Existing UI File menu and image menu still work.

- [ ] **Step 4: Tag the milestone (optional)**

```
git tag agent-phase-5
```

(Local only.)

---

## Out of scope for Phase 5 (deferred)

- **`newProject` with `type: 'solid' | 'media' | 'clipboard'`** — Phase 5 only supports the blank canvas. Solid-color initialization is a one-line `addLayer` follow-up; full media/clipboard initialization is more involved and deferred.
- **Settings beyond theme** — `setSettings` accepts `theme` only for now. `baseTheme`, default canvas size, default export prefs etc. are deferrable.
- **`installFontBundle` / `listInstalledFonts`** — Phase 6 (uses the job model; the 140 MB font download is long-running).
- **`exportVideo`** — Phase 6 (the only remaining export type).
- **MCP sidecar** — Phase 7.
- **Agent-driven evals** — Phase 8.
