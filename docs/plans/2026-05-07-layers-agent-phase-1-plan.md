# Layers Agent — Phase 1 (Foundation) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a read-only agent inspection API on `window.LayersAgent` v1.0. After this phase, an agent can introspect every aspect of a Layers project — composition, layers, child effects, masks, selection, settings, project, effect catalog. Mutating commands ship in later phases.

**Architecture:** A new `public/js/agent/` ES module is loaded at the end of `app.js` init. It attaches `window.LayersAgent` with a `version` string, a `ready` promise, and one async method per command. Each command runs through a dispatcher that validates args against a JSON-Schema-like definition, runs the handler under a serialized queue (one command in flight at a time), and returns a standard envelope `{ ok, command, apiVersion, result, state, warnings? }`. The state field is a bounded JSON snapshot derived from existing app state.

**Tech Stack:** Vanilla ES modules (existing pattern). No new runtime dependencies. Playwright for tests (existing test runner).

**Reference spec:** `docs/plans/2026-05-07-layers-agent-instrumentation-design.md`

---

## File Structure

**Create:**
- `public/js/agent/index.js` — module entry; exposes `window.LayersAgent`, holds `version`, `ready` promise, and the bootstrap function called by `app.js`.
- `public/js/agent/dispatcher.js` — envelope builders, serialized command queue, command registration helper.
- `public/js/agent/schemas.js` — tiny JSON-Schema-like validator + the per-command schema map for Phase 1.
- `public/js/agent/snapshot.js` — `buildSnapshot(app)` — converts `LayersApp` state to the canonical JSON snapshot.
- `public/js/agent/effects.js` — effect catalog helpers built on the renderer's existing `getAllEffects` / `getEffectDefinition`.
- `public/js/agent/commands.js` — Phase 1 command implementations (all read-only).
- `tests/agent-foundation.spec.js` — bootstrap, version, ready, envelope shape.
- `tests/agent-validation.spec.js` — schema validator behaviour and INVALID_ARGS_* error envelopes.
- `tests/agent-snapshot.spec.js` — snapshot serializer covering project/canvas/view, layers, children, masks, selection.
- `tests/agent-state-commands.spec.js` — `getState`, `getLayer`, `getCanvasSize`, `getSelection`.
- `tests/agent-project-commands.spec.js` — `getProjectInfo`, `listProjects`, `getSettings`, `getForegroundColor`.
- `tests/agent-effect-commands.spec.js` — `searchEffects`, `listEffectCategories`, `listCuratedEffects`, `getEffectDefinition`.
- `tests/agent-job-commands.spec.js` — `getJob`, `waitForJob`, `cancelJob` (stubs).
- `tests/agent-concurrency.spec.js` — parallel calls serialize.
- `tests/agent-snapshot-golden.spec.js` — snapshot golden file regression.
- `tests/fixtures/agent-snapshot-blank.json` — checked-in golden snapshot (regenerated via env flag).

**Modify:**
- `public/js/app.js` — one new import, one call to `bootstrapAgent(this)` at the end of `init()`. Wrap in try/catch so an agent-module failure does not break the app for human users.

---

## Task 1: Module skeleton with version and ready promise

**Files:**
- Create: `public/js/agent/index.js`
- Modify: `public/js/app.js` (add import + bootstrap call near end of `init`)
- Test: `tests/agent-foundation.spec.js`

- [ ] **Step 1: Write the failing test**

Create `tests/agent-foundation.spec.js`:

```js
import { test, expect } from 'playwright/test'

test.describe('LayersAgent foundation', () => {
    test('exposes version 1.0', async ({ page }) => {
        await page.goto('/', { waitUntil: 'networkidle' })
        await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })
        const version = await page.evaluate(() => window.LayersAgent?.version)
        expect(version).toBe('1.0')
    })

    test('ready promise resolves after init', async ({ page }) => {
        await page.goto('/', { waitUntil: 'networkidle' })
        await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })
        const ready = await page.evaluate(async () => {
            await window.LayersAgent.ready
            return true
        })
        expect(ready).toBe(true)
    })
})
```

- [ ] **Step 2: Run test to verify it fails**

```
npx playwright test tests/agent-foundation.spec.js --reporter=line
```

Expected: both tests FAIL because `window.LayersAgent` is undefined.

- [ ] **Step 3: Create the module skeleton**

Create `public/js/agent/index.js`:

```js
/**
 * Layers Agent API — public, JSON-only programmatic surface for software agents.
 *
 * Loaded after LayersApp init. Attaches window.LayersAgent with:
 *   - version: API version string
 *   - ready: Promise that resolves once bootstrap completes
 *   - one async method per command
 *
 * Human UI behavior is unchanged; this module is purely additive.
 *
 * @module agent
 */

export const API_VERSION = '1.0'

let _readyResolve
const _ready = new Promise((resolve) => { _readyResolve = resolve })

export const LayersAgent = {
    version: API_VERSION,
    ready: _ready
}

if (typeof window !== 'undefined') {
    window.LayersAgent = LayersAgent
}

/**
 * Wire commands and resolve the ready promise.
 * Call once from app.js after LayersApp.init() finishes.
 *
 * @param {LayersApp} app - The initialized application instance.
 */
export function bootstrapAgent(app) {
    LayersAgent._app = app
    _readyResolve()
}
```

- [ ] **Step 4: Wire bootstrap into app.js**

Modify `public/js/app.js`. Near the top with the other imports, add:

```js
import { bootstrapAgent } from './agent/index.js'
```

At the very end of `LayersApp.init()` (just before its closing brace, after every existing initialization step), add:

```js
        // Public agent API — purely additive, must never break the app for humans.
        try {
            bootstrapAgent(this)
        } catch (err) {
            console.error('[Layers] Failed to bootstrap agent API:', err)
        }
```

- [ ] **Step 5: Run test to verify it passes**

```
npx playwright test tests/agent-foundation.spec.js --reporter=line
```

Expected: both tests PASS.

- [ ] **Step 6: Commit**

```
git add public/js/agent/index.js public/js/app.js tests/agent-foundation.spec.js
git commit -m "feat(agent): bootstrap window.LayersAgent module with version and ready promise"
```

---

## Task 2: Dispatcher — envelopes and serialized queue

**Files:**
- Create: `public/js/agent/dispatcher.js`
- Modify: `public/js/agent/index.js` (use dispatcher to register a smoke command)
- Test: extend `tests/agent-foundation.spec.js`

- [ ] **Step 1: Add failing tests for envelopes and serialization**

Append to `tests/agent-foundation.spec.js`:

```js
test.describe('LayersAgent envelopes', () => {
    test('successful command returns ok envelope with apiVersion', async ({ page }) => {
        await page.goto('/', { waitUntil: 'networkidle' })
        await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })
        await page.evaluate(async () => { await window.LayersAgent.ready })
        const env = await page.evaluate(() => window.LayersAgent._ping())
        expect(env.ok).toBe(true)
        expect(env.command).toBe('_ping')
        expect(env.apiVersion).toBe('1.0')
        expect(env.result).toEqual({ pong: true })
    })

    test('serializes parallel calls in order', async ({ page }) => {
        await page.goto('/', { waitUntil: 'networkidle' })
        await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })
        await page.evaluate(async () => { await window.LayersAgent.ready })
        const order = await page.evaluate(async () => {
            const events = []
            window.__pingHook = (label) => events.push(label)
            await Promise.all([
                window.LayersAgent._ping().then(() => events.push('done-1')),
                window.LayersAgent._ping().then(() => events.push('done-2')),
                window.LayersAgent._ping().then(() => events.push('done-3'))
            ])
            return events
        })
        // Each command resolves before the next starts; we observe a strict
        // pairing of start-end with no interleaving.
        expect(order).toEqual(['done-1', 'done-2', 'done-3'])
    })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```
npx playwright test tests/agent-foundation.spec.js --reporter=line
```

Expected: FAIL — `_ping` is not defined.

- [ ] **Step 3: Create the dispatcher**

Create `public/js/agent/dispatcher.js`:

```js
/**
 * Command dispatcher — wraps every LayersAgent command in:
 *   - Argument validation (Task 3 will add schema enforcement)
 *   - Serialized execution (one command in flight at a time)
 *   - Standard success/failure envelope
 *   - Latest state snapshot attached to every response (Task 7+ will add real state)
 *
 * @module agent/dispatcher
 */

import { API_VERSION } from './index.js'

let _tail = Promise.resolve()

/**
 * Run a function under the serial queue. Each call awaits the previous one to
 * settle (regardless of success/failure) before starting.
 *
 * @template T
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
function serialize(fn) {
    const next = _tail.then(fn, fn)
    _tail = next.catch(() => {})
    return next
}

export function makeSuccess(command, result, state = null, warnings = []) {
    const env = { ok: true, command, apiVersion: API_VERSION, result, state }
    if (warnings.length) env.warnings = warnings
    return env
}

export function makeFailure(command, code, message, details = {}, state = null) {
    return {
        ok: false,
        command,
        apiVersion: API_VERSION,
        error: { code, message, details },
        state
    }
}

/**
 * Register a command on the LayersAgent namespace.
 *
 * @param {object} agent - The LayersAgent object.
 * @param {string} name - Command name.
 * @param {(args: object, app: object) => Promise<{ result, warnings? }>} handler
 *   Async handler receiving validated args and the app instance.
 *   Returns a plain object with result/warnings; the dispatcher wraps it.
 */
export function registerCommand(agent, name, handler) {
    agent[name] = (args = {}) => serialize(async () => {
        try {
            const out = await handler(args, agent._app)
            return makeSuccess(name, out.result, null, out.warnings || [])
        } catch (err) {
            if (err && err.__envelope) {
                err.__envelope.command = name
                return err.__envelope
            }
            return makeFailure(name, 'INTERNAL_ERROR', err.message || String(err), {
                stack: err.stack
            })
        }
    })
}

/**
 * Throw a structured error from inside a handler. The dispatcher unwraps it
 * into a failure envelope.
 */
export function commandError(code, message, details = {}) {
    const err = new Error(message)
    err.__envelope = makeFailure(null, code, message, details, null)
    return err
}
```

- [ ] **Step 4: Register a `_ping` smoke command**

Modify `public/js/agent/index.js` to import the dispatcher and register `_ping`:

Add the import near the top:

```js
import { registerCommand } from './dispatcher.js'
```

Replace `bootstrapAgent` with:

```js
export function bootstrapAgent(app) {
    LayersAgent._app = app
    registerCommand(LayersAgent, '_ping', async () => ({ result: { pong: true } }))
    _readyResolve()
}
```

- [ ] **Step 5: Run tests to verify they pass**

```
npx playwright test tests/agent-foundation.spec.js --reporter=line
```

Expected: all four tests PASS.

- [ ] **Step 6: Commit**

```
git add public/js/agent/dispatcher.js public/js/agent/index.js tests/agent-foundation.spec.js
git commit -m "feat(agent): add dispatcher with serialized queue and envelope builders"
```

---

## Task 3: Schema validator

**Files:**
- Create: `public/js/agent/schemas.js`
- Modify: `public/js/agent/dispatcher.js` (validate args before handler)
- Test: `tests/agent-validation.spec.js`

- [ ] **Step 1: Write the failing tests**

Create `tests/agent-validation.spec.js`:

```js
import { test, expect } from 'playwright/test'

async function bootApp(page) {
    await page.goto('/', { waitUntil: 'networkidle' })
    await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })
    await page.evaluate(async () => { await window.LayersAgent.ready })
}

test.describe('LayersAgent schema validation', () => {
    test('returns INVALID_ARGS_TYPE for wrong field type', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() =>
            window.LayersAgent._echoNumber({ value: 'not a number' })
        )
        expect(env.ok).toBe(false)
        expect(env.error.code).toBe('INVALID_ARGS_TYPE')
        expect(env.error.details.field).toBe('value')
    })

    test('returns INVALID_ARGS_REQUIRED when required field missing', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() => window.LayersAgent._echoNumber({}))
        expect(env.ok).toBe(false)
        expect(env.error.code).toBe('INVALID_ARGS_REQUIRED')
        expect(env.error.details.field).toBe('value')
    })

    test('returns INVALID_ARGS_RANGE for out-of-range number', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() =>
            window.LayersAgent._echoNumber({ value: 999 })
        )
        expect(env.ok).toBe(false)
        expect(env.error.code).toBe('INVALID_ARGS_RANGE')
        expect(env.error.details).toMatchObject({ field: 'value', min: 0, max: 100 })
    })

    test('returns INVALID_ARGS_ENUM for unknown enum value', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() =>
            window.LayersAgent._echoEnum({ choice: 'nope' })
        )
        expect(env.ok).toBe(false)
        expect(env.error.code).toBe('INVALID_ARGS_ENUM')
        expect(env.error.details.field).toBe('choice')
    })

    test('passes valid args to handler', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() =>
            window.LayersAgent._echoNumber({ value: 50 })
        )
        expect(env.ok).toBe(true)
        expect(env.result.value).toBe(50)
    })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```
npx playwright test tests/agent-validation.spec.js --reporter=line
```

Expected: all FAIL — `_echoNumber` and `_echoEnum` are undefined.

- [ ] **Step 3: Create the schema validator**

Create `public/js/agent/schemas.js`:

```js
/**
 * Tiny JSON-Schema-like validator. Supports the subset we actually need:
 *   - { type: 'object', properties: { ... }, required: [...] }
 *   - field types: 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object' | 'any'
 *   - numeric constraints: min, max
 *   - enum constraints: enum: [...]
 *   - nested object schemas via type: 'object' + properties
 *   - arrays via type: 'array' + items: <schema>
 *
 * Returns { ok: true } on success or { ok: false, code, message, details } on
 * the first violation. Errors mirror the agent error taxonomy (INVALID_ARGS_*).
 *
 * @module agent/schemas
 */

function fail(code, message, details) {
    return { ok: false, code, message, details }
}

/**
 * Validate `args` against `schema`. The dispatcher calls this before handlers.
 *
 * @param {object} args
 * @param {object} schema
 * @returns {{ok: true} | {ok: false, code: string, message: string, details: object}}
 */
export function validate(args, schema) {
    return _validate(args, schema, '')
}

function _validate(value, schema, path) {
    if (!schema) return { ok: true }

    const type = schema.type
    if (type === 'any') return { ok: true }

    if (type === 'object') {
        if (value === null || typeof value !== 'object' || Array.isArray(value)) {
            return fail('INVALID_ARGS_TYPE',
                `${path || 'args'}: expected object, got ${typeName(value)}`,
                { field: path || '<root>', expected: 'object', got: typeName(value) })
        }
        for (const req of schema.required || []) {
            if (!(req in value)) {
                return fail('INVALID_ARGS_REQUIRED',
                    `${path ? path + '.' : ''}${req} is required`,
                    { field: req })
            }
        }
        for (const [key, sub] of Object.entries(schema.properties || {})) {
            if (!(key in value)) continue
            const r = _validate(value[key], sub, path ? `${path}.${key}` : key)
            if (!r.ok) return r
        }
        return { ok: true }
    }

    if (type === 'array') {
        if (!Array.isArray(value)) {
            return fail('INVALID_ARGS_TYPE',
                `${path}: expected array, got ${typeName(value)}`,
                { field: path, expected: 'array', got: typeName(value) })
        }
        if (schema.items) {
            for (let i = 0; i < value.length; i++) {
                const r = _validate(value[i], schema.items, `${path}[${i}]`)
                if (!r.ok) return r
            }
        }
        return { ok: true }
    }

    if (type === 'string') {
        if (typeof value !== 'string') {
            return fail('INVALID_ARGS_TYPE',
                `${path}: expected string, got ${typeName(value)}`,
                { field: path, expected: 'string', got: typeName(value) })
        }
        if (schema.enum && !schema.enum.includes(value)) {
            return fail('INVALID_ARGS_ENUM',
                `${path}: expected one of [${schema.enum.join(', ')}], got '${value}'`,
                { field: path, allowed: schema.enum, got: value })
        }
        return { ok: true }
    }

    if (type === 'number' || type === 'integer') {
        if (typeof value !== 'number' || Number.isNaN(value)) {
            return fail('INVALID_ARGS_TYPE',
                `${path}: expected ${type}, got ${typeName(value)}`,
                { field: path, expected: type, got: typeName(value) })
        }
        if (type === 'integer' && !Number.isInteger(value)) {
            return fail('INVALID_ARGS_TYPE',
                `${path}: expected integer, got ${value}`,
                { field: path, expected: 'integer', got: 'number' })
        }
        if (schema.enum && !schema.enum.includes(value)) {
            return fail('INVALID_ARGS_ENUM',
                `${path}: expected one of [${schema.enum.join(', ')}], got ${value}`,
                { field: path, allowed: schema.enum, got: value })
        }
        if (typeof schema.min === 'number' && value < schema.min) {
            return fail('INVALID_ARGS_RANGE',
                `${path}: ${value} is below min ${schema.min}`,
                { field: path, value, min: schema.min, max: schema.max })
        }
        if (typeof schema.max === 'number' && value > schema.max) {
            return fail('INVALID_ARGS_RANGE',
                `${path}: ${value} is above max ${schema.max}`,
                { field: path, value, min: schema.min, max: schema.max })
        }
        return { ok: true }
    }

    if (type === 'boolean') {
        if (typeof value !== 'boolean') {
            return fail('INVALID_ARGS_TYPE',
                `${path}: expected boolean, got ${typeName(value)}`,
                { field: path, expected: 'boolean', got: typeName(value) })
        }
        return { ok: true }
    }

    return { ok: true }
}

function typeName(v) {
    if (v === null) return 'null'
    if (Array.isArray(v)) return 'array'
    return typeof v
}

/**
 * Per-command schema map. Each key is a command name; each value is the schema
 * for its single args object. `null` means no args / accepts anything.
 *
 * Phase 1 schemas only — extended in later phases.
 */
export const SCHEMAS = {
    _ping: null,
    _echoNumber: {
        type: 'object',
        required: ['value'],
        properties: {
            value: { type: 'number', min: 0, max: 100 }
        }
    },
    _echoEnum: {
        type: 'object',
        required: ['choice'],
        properties: {
            choice: { type: 'string', enum: ['a', 'b', 'c'] }
        }
    }
}
```

- [ ] **Step 4: Wire validation into the dispatcher**

Modify `public/js/agent/dispatcher.js`. Add the import at the top:

```js
import { SCHEMAS, validate } from './schemas.js'
```

Replace `registerCommand` with:

```js
export function registerCommand(agent, name, handler) {
    agent[name] = (args = {}) => serialize(async () => {
        const schema = SCHEMAS[name]
        if (schema) {
            const v = validate(args, schema)
            if (!v.ok) return makeFailure(name, v.code, v.message, v.details)
        }
        try {
            const out = await handler(args, agent._app)
            return makeSuccess(name, out.result, null, out.warnings || [])
        } catch (err) {
            if (err && err.__envelope) {
                err.__envelope.command = name
                return err.__envelope
            }
            return makeFailure(name, 'INTERNAL_ERROR', err.message || String(err), {
                stack: err.stack
            })
        }
    })
}
```

- [ ] **Step 5: Register the echo commands for tests**

Modify `bootstrapAgent` in `public/js/agent/index.js`:

```js
export function bootstrapAgent(app) {
    LayersAgent._app = app
    registerCommand(LayersAgent, '_ping', async () => ({ result: { pong: true } }))
    registerCommand(LayersAgent, '_echoNumber', async ({ value }) => ({ result: { value } }))
    registerCommand(LayersAgent, '_echoEnum', async ({ choice }) => ({ result: { choice } }))
    _readyResolve()
}
```

- [ ] **Step 6: Run tests to verify they pass**

```
npx playwright test tests/agent-validation.spec.js tests/agent-foundation.spec.js --reporter=line
```

Expected: all PASS.

- [ ] **Step 7: Commit**

```
git add public/js/agent/schemas.js public/js/agent/dispatcher.js public/js/agent/index.js tests/agent-validation.spec.js
git commit -m "feat(agent): add schema validator with INVALID_ARGS_* error envelopes"
```

---

## Task 4: Snapshot — project, canvas, view, foreground

**Files:**
- Create: `public/js/agent/snapshot.js`
- Test: `tests/agent-snapshot.spec.js`

- [ ] **Step 1: Write the failing test**

Create `tests/agent-snapshot.spec.js`:

```js
import { test, expect } from 'playwright/test'

async function bootApp(page) {
    await page.goto('/', { waitUntil: 'networkidle' })
    await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })
    await page.evaluate(async () => { await window.LayersAgent.ready })
}

async function dismissOpenDialog(page) {
    const visible = await page.evaluate(() => !!document.querySelector('.open-dialog-backdrop.visible'))
    if (visible) {
        await page.click('.media-option[data-type="solid"]')
        await page.waitForSelector('.canvas-size-dialog', { timeout: 5000 })
        await page.click('.canvas-size-dialog .action-btn.primary')
        await page.waitForSelector('.open-dialog-backdrop.visible', { state: 'hidden', timeout: 5000 })
    }
}

test.describe('snapshot scaffolding', () => {
    test('contains project, canvas, view, foreground', async ({ page }) => {
        await bootApp(page)
        await dismissOpenDialog(page)
        const snap = await page.evaluate(() => {
            return window.__buildSnapshot(window.layersApp)
        })
        expect(snap.apiVersion).toBe('1.0')
        expect(snap.schemaVersion).toBe('1.0')
        expect(snap.project).toMatchObject({
            id: null,
            isDirty: expect.any(Boolean),
            canUndo: expect.any(Boolean),
            canRedo: expect.any(Boolean),
            canSaveAs: true
        })
        expect(snap.canvas).toMatchObject({
            width: expect.any(Number),
            height: expect.any(Number)
        })
        expect(snap.canvas.width).toBeGreaterThan(0)
        expect(snap.canvas.height).toBeGreaterThan(0)
        expect(snap.view).toMatchObject({
            zoomMode: expect.anything(),
            isPlaying: expect.any(Boolean),
            loopDuration: expect.any(Number)
        })
        expect(snap.foreground).toMatchObject({
            color: expect.stringMatching(/^#[0-9a-fA-F]{6}$/)
        })
    })
})
```

(The `dismissOpenDialog` helper is reused across snapshot/state tests; the open-project dialog auto-shows on a fresh load, so we close it by creating a default solid-color project.)

(`window.__buildSnapshot` is a test-only export wired below — it lets us exercise the serializer directly without going through dispatch.)

- [ ] **Step 2: Run test to verify it fails**

```
npx playwright test tests/agent-snapshot.spec.js --reporter=line
```

Expected: FAIL — `__buildSnapshot` is not defined.

- [ ] **Step 3: Create the snapshot module (scaffolding only)**

Create `public/js/agent/snapshot.js`:

```js
/**
 * Build a JSON-serializable snapshot of the LayersApp state.
 *
 * The same shape is returned by getState() and embedded in every command
 * envelope. No pixel data, no File blobs — only structural information.
 *
 * @module agent/snapshot
 */

import { API_VERSION } from './index.js'

const SCHEMA_VERSION = '1.0'

export function buildSnapshot(app) {
    return {
        apiVersion: API_VERSION,
        schemaVersion: SCHEMA_VERSION,
        project: buildProject(app),
        canvas: buildCanvas(app),
        view: buildView(app),
        foreground: buildForeground(app),
        selection: null,           // filled in Task 6
        layers: [],                // filled in Task 5
        selectedLayerIds: [],
        activeLayerId: null,
        jobs: [],                  // populated when Phase 6 jobs ship
        recentExports: [],         // populated when Phase 3 exports ship
        settings: buildSettings(app)
    }
}

function buildProject(app) {
    const undoMgr = app?._undoManager
    return {
        id: app?._currentProjectId || null,
        name: app?._currentProjectName || null,
        isDirty: !!app?._isDirty,
        canUndo: undoMgr ? undoMgr.canUndo() : false,
        canRedo: undoMgr ? undoMgr.canRedo() : false,
        canSaveAs: true
    }
}

function buildCanvas(app) {
    const c = app?._canvas
    return {
        width: c ? c.width : 0,
        height: c ? c.height : 0
    }
}

function buildView(app) {
    return {
        zoomMode: app?._zoomMode ?? 'fit',
        isPlaying: !!app?._renderer?.isRunning,
        loopDuration: app?._renderer?.loopDuration ?? 10
    }
}

function buildForeground(app) {
    return { color: app?._foregroundColor || '#000000' }
}

function buildSettings(app) {
    // Minimal pass-through for Phase 1; expanded as needed.
    const stored = (() => {
        try { return JSON.parse(localStorage.getItem('layers-settings') || '{}') }
        catch { return {} }
    })()
    return stored
}
```

- [ ] **Step 4: Expose `__buildSnapshot` for tests via `index.js`**

Modify `public/js/agent/index.js`. Add the import:

```js
import { buildSnapshot } from './snapshot.js'
```

Replace `bootstrapAgent` body to also expose the test hook:

```js
export function bootstrapAgent(app) {
    LayersAgent._app = app
    registerCommand(LayersAgent, '_ping', async () => ({ result: { pong: true } }))
    registerCommand(LayersAgent, '_echoNumber', async ({ value }) => ({ result: { value } }))
    registerCommand(LayersAgent, '_echoEnum', async ({ choice }) => ({ result: { choice } }))
    if (typeof window !== 'undefined') {
        window.__buildSnapshot = buildSnapshot
    }
    _readyResolve()
}
```

- [ ] **Step 5: Run test to verify it passes**

```
npx playwright test tests/agent-snapshot.spec.js --reporter=line
```

Expected: PASS.

- [ ] **Step 6: Commit**

```
git add public/js/agent/snapshot.js public/js/agent/index.js tests/agent-snapshot.spec.js
git commit -m "feat(agent): snapshot scaffolding for project/canvas/view/foreground"
```

---

## Task 5: Snapshot — layers and child effects

**Files:**
- Modify: `public/js/agent/snapshot.js`
- Test: extend `tests/agent-snapshot.spec.js`

- [ ] **Step 1: Add failing tests**

Append to `tests/agent-snapshot.spec.js`:

```js
test.describe('snapshot layers', () => {
    test('serializes a solid-color effect layer with params', async ({ page }) => {
        await bootApp(page)
        await dismissOpenDialog(page)
        // First layer is the synth/solid created by the open dialog default path.
        const snap = await page.evaluate(() => window.__buildSnapshot(window.layersApp))
        expect(Array.isArray(snap.layers)).toBe(true)
        expect(snap.layers.length).toBeGreaterThanOrEqual(1)
        const base = snap.layers[0]
        expect(base).toMatchObject({
            id: expect.stringMatching(/^layer-/),
            name: expect.any(String),
            sourceType: 'effect',
            visible: true,
            opacity: expect.any(Number),
            blendMode: expect.any(String),
            locked: false,
            transform: {
                offsetX: 0, offsetY: 0,
                scaleX: 1, scaleY: 1,
                rotation: 0,
                flipH: false, flipV: false
            },
            effect: { id: expect.any(String), name: expect.any(String), params: expect.any(Object) },
            media: null,
            drawing: null,
            children: [],
            mask: null
        })
    })

    test('serializes child effects on a layer', async ({ page }) => {
        await bootApp(page)
        await dismissOpenDialog(page)
        await page.evaluate(async () => {
            const layerId = window.layersApp._layers[0].id
            await window.layersApp._handleAddChildEffect(layerId, 'filter/blur')
        })
        await page.waitForTimeout(200)
        const snap = await page.evaluate(() => window.__buildSnapshot(window.layersApp))
        const layer = snap.layers[0]
        expect(layer.children.length).toBe(1)
        expect(layer.children[0]).toMatchObject({
            id: expect.stringMatching(/^layer-/),
            effectId: 'filter/blur',
            visible: true,
            params: expect.any(Object)
        })
    })

    test('layers array order is bottom-to-top', async ({ page }) => {
        await bootApp(page)
        await dismissOpenDialog(page)
        await page.evaluate(async () => {
            await window.layersApp._handleAddEffectLayer('synth/gradient')
        })
        await page.waitForTimeout(200)
        const ids = await page.evaluate(() => window.__buildSnapshot(window.layersApp).layers.map(l => l.id))
        const internal = await page.evaluate(() => window.layersApp._layers.map(l => l.id))
        expect(ids).toEqual(internal)
    })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```
npx playwright test tests/agent-snapshot.spec.js --reporter=line
```

Expected: layer tests FAIL (layers still empty array).

- [ ] **Step 3: Implement layer serialization**

Modify `public/js/agent/snapshot.js`. Replace `buildSnapshot` with one that delegates to a new `buildLayers` and pulls selection IDs:

```js
export function buildSnapshot(app) {
    return {
        apiVersion: API_VERSION,
        schemaVersion: SCHEMA_VERSION,
        project: buildProject(app),
        canvas: buildCanvas(app),
        view: buildView(app),
        foreground: buildForeground(app),
        selection: null,
        layers: buildLayers(app),
        selectedLayerIds: app?._layerStack?.selectedLayerIds?.slice() || [],
        activeLayerId: app?._layerStack?.selectedLayerId || null,
        jobs: [],
        recentExports: [],
        settings: buildSettings(app)
    }
}

function buildLayers(app) {
    const layers = app?._layers || []
    return layers.map(buildLayer)
}

function buildLayer(layer) {
    return {
        id: layer.id,
        name: layer.name,
        sourceType: layer.sourceType,
        visible: !!layer.visible,
        opacity: typeof layer.opacity === 'number' ? layer.opacity : 100,
        blendMode: layer.blendMode || 'mix',
        locked: !!layer.locked,
        transform: {
            offsetX: layer.offsetX || 0,
            offsetY: layer.offsetY || 0,
            scaleX: layer.scaleX ?? 1,
            scaleY: layer.scaleY ?? 1,
            rotation: layer.rotation ?? 0,
            flipH: !!layer.flipH,
            flipV: !!layer.flipV
        },
        media: buildMedia(layer),
        effect: buildEffect(layer),
        drawing: buildDrawing(layer),
        children: (layer.children || []).map(buildChildEffect),
        mask: null  // filled in Task 6
    }
}

function buildMedia(layer) {
    if (layer.sourceType !== 'media') return null
    const file = layer.mediaFile
    return {
        type: layer.mediaType,
        filename: file?.name || null,
        width: layer.mediaWidth || null,
        height: layer.mediaHeight || null,
        durationSec: layer.mediaDurationSec || null
    }
}

function buildEffect(layer) {
    if (layer.sourceType !== 'effect') return null
    return {
        id: layer.effectId,
        name: layer.name,
        params: layer.effectParams ? { ...layer.effectParams } : {}
    }
}

function buildDrawing(layer) {
    if (layer.sourceType !== 'drawing') return null
    return { strokeCount: (layer.strokes || []).length }
}

function buildChildEffect(child) {
    return {
        id: child.id,
        name: child.name,
        effectId: child.effectId,
        visible: child.visible !== false,
        params: child.effectParams ? { ...child.effectParams } : {}
    }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```
npx playwright test tests/agent-snapshot.spec.js --reporter=line
```

Expected: all PASS.

- [ ] **Step 5: Commit**

```
git add public/js/agent/snapshot.js tests/agent-snapshot.spec.js
git commit -m "feat(agent): snapshot serializes layers, transforms, child effects"
```

---

## Task 6: Snapshot — masks and selection

**Files:**
- Modify: `public/js/agent/snapshot.js`
- Test: extend `tests/agent-snapshot.spec.js`

- [ ] **Step 1: Add failing tests**

Append to `tests/agent-snapshot.spec.js`:

```js
test.describe('snapshot masks and selection', () => {
    test('serializes a layer mask with bounds and coverage', async ({ page }) => {
        await bootApp(page)
        await dismissOpenDialog(page)
        await page.evaluate(async () => {
            const layerId = window.layersApp._layers[0].id
            await window.layersApp._addLayerMask(layerId)
        })
        await page.waitForTimeout(200)
        const snap = await page.evaluate(() => window.__buildSnapshot(window.layersApp))
        const layer = snap.layers[0]
        expect(layer.mask).toMatchObject({
            enabled: true,
            visible: expect.any(Boolean),
            width: expect.any(Number),
            height: expect.any(Number),
            coverage: expect.any(Number),
            bounds: expect.objectContaining({
                x: expect.any(Number),
                y: expect.any(Number),
                width: expect.any(Number),
                height: expect.any(Number)
            })
        })
        // A fresh mask is fully white => coverage = 1
        expect(layer.mask.coverage).toBeCloseTo(1, 1)
    })

    test('serializes a rectangle selection', async ({ page }) => {
        await bootApp(page)
        await dismissOpenDialog(page)
        await page.evaluate(() => {
            window.layersApp._selectionManager._selectionPath = {
                type: 'rect', x: 10, y: 20, width: 100, height: 200
            }
            window.layersApp._selectionManager._drawMarchingAnts()
        })
        const snap = await page.evaluate(() => window.__buildSnapshot(window.layersApp))
        expect(snap.selection).toMatchObject({
            kind: 'rectangle',
            bounds: { x: 10, y: 20, width: 100, height: 200 },
            isEmpty: false
        })
    })

    test('snapshot.selection is null when no selection', async ({ page }) => {
        await bootApp(page)
        await dismissOpenDialog(page)
        const snap = await page.evaluate(() => window.__buildSnapshot(window.layersApp))
        expect(snap.selection).toBeNull()
    })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```
npx playwright test tests/agent-snapshot.spec.js --reporter=line
```

Expected: mask and selection tests FAIL.

- [ ] **Step 3: Implement mask + selection serialization**

Modify `public/js/agent/snapshot.js`. Replace the `selection: null` literal in `buildSnapshot` with a call to `buildSelection(app)`. Replace `mask: null` in `buildLayer` with `mask: buildMask(layer)`. Add the helpers at the end of the file:

```js
function buildMask(layer) {
    if (!layer.mask) return null
    const { width, height, data } = layer.mask
    let nonZero = 0
    let minX = width, minY = height, maxX = -1, maxY = -1

    // Iterate alpha (or red, since masks are grayscale) channel; threshold > 0.
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const idx = (y * width + x) * 4
            if (data[idx] > 0) {
                nonZero++
                if (x < minX) minX = x
                if (x > maxX) maxX = x
                if (y < minY) minY = y
                if (y > maxY) maxY = y
            }
        }
    }

    const coverage = nonZero / (width * height)
    const bounds = nonZero === 0
        ? { x: 0, y: 0, width: 0, height: 0 }
        : { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 }

    return {
        enabled: layer.maskEnabled !== false,
        visible: !!layer.maskVisible,
        width, height,
        coverage,
        bounds
    }
}

function buildSelection(app) {
    const sm = app?._selectionManager
    if (!sm || !sm.hasSelection?.()) return null

    const path = sm._selectionPath
    if (!path) return null

    const kind = SELECTION_KIND_MAP[path.type] || path.type
    const bounds = computeSelectionBounds(path, app)
    if (!bounds) return null

    const out = { kind, bounds, isEmpty: bounds.width === 0 || bounds.height === 0 }
    if (path.type === 'polygon' || path.type === 'lasso') {
        out.polygonPoints = path.points.map(p => [p.x, p.y])
    }
    return out
}

const SELECTION_KIND_MAP = {
    rect: 'rectangle',
    oval: 'oval',
    lasso: 'lasso',
    polygon: 'polygon',
    wand: 'wand',
    mask: 'color-range'
}

function computeSelectionBounds(path, app) {
    if (path.type === 'rect') {
        return { x: path.x, y: path.y, width: path.width, height: path.height }
    }
    if (path.type === 'oval') {
        return {
            x: Math.round(path.cx - path.rx),
            y: Math.round(path.cy - path.ry),
            width: Math.round(path.rx * 2),
            height: Math.round(path.ry * 2)
        }
    }
    if ((path.type === 'lasso' || path.type === 'polygon') && Array.isArray(path.points)) {
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
        for (const p of path.points) {
            if (p.x < minX) minX = p.x
            if (p.x > maxX) maxX = p.x
            if (p.y < minY) minY = p.y
            if (p.y > maxY) maxY = p.y
        }
        if (minX === Infinity) return { x: 0, y: 0, width: 0, height: 0 }
        return {
            x: Math.round(minX), y: Math.round(minY),
            width: Math.round(maxX - minX),
            height: Math.round(maxY - minY)
        }
    }
    if ((path.type === 'wand' || path.type === 'mask') && path.bounds) {
        return { ...path.bounds }
    }
    return null
}
```

Also update the calls in `buildSnapshot` and `buildLayer`:

```js
        selection: buildSelection(app),
```

```js
        mask: buildMask(layer)
```

- [ ] **Step 4: Run tests to verify they pass**

```
npx playwright test tests/agent-snapshot.spec.js --reporter=line
```

Expected: all PASS. (Selection kind for `_selectionPath = { type: 'rect', ... }` maps to `'rectangle'` per `SELECTION_KIND_MAP`.)

- [ ] **Step 5: Commit**

```
git add public/js/agent/snapshot.js tests/agent-snapshot.spec.js
git commit -m "feat(agent): snapshot serializes masks (coverage+bounds) and selection"
```

---

## Task 7: `getState` command

**Files:**
- Create: `public/js/agent/commands.js`
- Modify: `public/js/agent/index.js` (register commands)
- Modify: `public/js/agent/dispatcher.js` (auto-attach state to envelope)
- Test: `tests/agent-state-commands.spec.js`

- [ ] **Step 1: Write the failing test**

Create `tests/agent-state-commands.spec.js`:

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

test.describe('LayersAgent.getState', () => {
    test('returns ok envelope with full snapshot', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() => window.LayersAgent.getState())
        expect(env.ok).toBe(true)
        expect(env.command).toBe('getState')
        expect(env.apiVersion).toBe('1.0')
        expect(env.state).toMatchObject({
            apiVersion: '1.0',
            schemaVersion: '1.0',
            project: expect.any(Object),
            canvas: expect.any(Object),
            view: expect.any(Object),
            layers: expect.any(Array)
        })
        // result is the same snapshot for getState specifically
        expect(env.result).toEqual(env.state)
    })

    test('every command response includes a state snapshot', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() => window.LayersAgent._ping())
        expect(env.state).not.toBeNull()
        expect(env.state.apiVersion).toBe('1.0')
    })
})
```

- [ ] **Step 2: Run test to verify it fails**

```
npx playwright test tests/agent-state-commands.spec.js --reporter=line
```

Expected: FAIL — `getState` not defined.

- [ ] **Step 3: Auto-attach snapshot to all envelopes**

Modify `public/js/agent/dispatcher.js` so the dispatcher always attaches the latest snapshot. Add at top:

```js
import { buildSnapshot } from './snapshot.js'
```

Replace `registerCommand`:

```js
export function registerCommand(agent, name, handler) {
    agent[name] = (args = {}) => serialize(async () => {
        const schema = SCHEMAS[name]
        if (schema) {
            const v = validate(args, schema)
            if (!v.ok) {
                const snap = safeSnapshot(agent._app)
                return makeFailure(name, v.code, v.message, v.details, snap)
            }
        }
        try {
            const out = await handler(args, agent._app)
            const snap = safeSnapshot(agent._app)
            return makeSuccess(name, out.result, snap, out.warnings || [])
        } catch (err) {
            const snap = safeSnapshot(agent._app)
            if (err && err.__envelope) {
                err.__envelope.command = name
                err.__envelope.state = snap
                return err.__envelope
            }
            return makeFailure(name, 'INTERNAL_ERROR', err.message || String(err),
                { stack: err.stack }, snap)
        }
    })
}

function safeSnapshot(app) {
    try { return buildSnapshot(app) }
    catch (err) {
        console.warn('[agent] buildSnapshot threw:', err)
        return null
    }
}
```

- [ ] **Step 4: Create commands.js with `getState`**

Create `public/js/agent/commands.js`:

```js
/**
 * Phase 1 read-only commands.
 *
 * Handlers receive (args, app) and return { result, warnings? }. The dispatcher
 * wraps each call in an envelope with the latest state snapshot.
 *
 * @module agent/commands
 */

import { buildSnapshot } from './snapshot.js'

export async function getState(_args, app) {
    return { result: buildSnapshot(app) }
}
```

- [ ] **Step 5: Register `getState` in `index.js`**

Modify `public/js/agent/index.js`. Add the import:

```js
import * as commands from './commands.js'
```

In `bootstrapAgent`, after the existing `_ping/_echoNumber/_echoEnum` lines, add:

```js
    registerCommand(LayersAgent, 'getState', commands.getState)
```

- [ ] **Step 6: Run test to verify it passes**

```
npx playwright test tests/agent-state-commands.spec.js --reporter=line
```

Expected: PASS.

- [ ] **Step 7: Commit**

```
git add public/js/agent/commands.js public/js/agent/index.js public/js/agent/dispatcher.js tests/agent-state-commands.spec.js
git commit -m "feat(agent): add getState command and auto-attach state to envelopes"
```

---

## Task 8: Single-layer inspection commands

**Files:**
- Modify: `public/js/agent/commands.js`
- Modify: `public/js/agent/schemas.js`
- Modify: `public/js/agent/index.js`
- Test: extend `tests/agent-state-commands.spec.js`

- [ ] **Step 1: Add failing tests**

Append to `tests/agent-state-commands.spec.js`:

```js
test.describe('LayersAgent inspection commands', () => {
    test('getLayer returns a single layer descriptor', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() => {
            const id = window.layersApp._layers[0].id
            return window.LayersAgent.getLayer({ layerId: id })
        })
        expect(env.ok).toBe(true)
        expect(env.result).toMatchObject({
            id: expect.stringMatching(/^layer-/),
            sourceType: expect.any(String)
        })
    })

    test('getLayer returns NOT_FOUND_LAYER for missing layer', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() =>
            window.LayersAgent.getLayer({ layerId: 'layer-nope' })
        )
        expect(env.ok).toBe(false)
        expect(env.error.code).toBe('NOT_FOUND_LAYER')
    })

    test('getCanvasSize returns width and height', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() => window.LayersAgent.getCanvasSize())
        expect(env.ok).toBe(true)
        expect(env.result.width).toBeGreaterThan(0)
        expect(env.result.height).toBeGreaterThan(0)
    })

    test('getSelection returns null when no selection', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() => window.LayersAgent.getSelection())
        expect(env.ok).toBe(true)
        expect(env.result).toBeNull()
    })

    test('getSelection returns descriptor when selection exists', async ({ page }) => {
        await bootApp(page)
        await page.evaluate(() => {
            window.layersApp._selectionManager._selectionPath = {
                type: 'rect', x: 1, y: 2, width: 30, height: 40
            }
            window.layersApp._selectionManager._drawMarchingAnts()
        })
        const env = await page.evaluate(() => window.LayersAgent.getSelection())
        expect(env.ok).toBe(true)
        expect(env.result.kind).toBe('rectangle')
        expect(env.result.bounds).toEqual({ x: 1, y: 2, width: 30, height: 40 })
    })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```
npx playwright test tests/agent-state-commands.spec.js --reporter=line
```

Expected: new tests FAIL — commands not defined.

- [ ] **Step 3: Add schemas**

Modify `public/js/agent/schemas.js`. Append to `SCHEMAS`:

```js
    getState: null,
    getLayer: {
        type: 'object',
        required: ['layerId'],
        properties: { layerId: { type: 'string' } }
    },
    getCanvasSize: null,
    getSelection: null,
```

- [ ] **Step 4: Add command implementations**

Modify `public/js/agent/commands.js`. Add the helper imports and new commands (note `commandError` from dispatcher):

```js
import { buildSnapshot } from './snapshot.js'
import { commandError } from './dispatcher.js'
```

After `getState`, add:

```js
export async function getLayer({ layerId }, app) {
    const snap = buildSnapshot(app)
    const layer = snap.layers.find(l => l.id === layerId)
    if (!layer) {
        throw commandError('NOT_FOUND_LAYER', `Layer not found: ${layerId}`, { layerId })
    }
    return { result: layer }
}

export async function getCanvasSize(_args, app) {
    return {
        result: {
            width: app?._canvas?.width || 0,
            height: app?._canvas?.height || 0
        }
    }
}

export async function getSelection(_args, app) {
    const snap = buildSnapshot(app)
    return { result: snap.selection }
}
```

- [ ] **Step 5: Register the new commands**

Modify `public/js/agent/index.js`. In `bootstrapAgent`, append:

```js
    registerCommand(LayersAgent, 'getLayer', commands.getLayer)
    registerCommand(LayersAgent, 'getCanvasSize', commands.getCanvasSize)
    registerCommand(LayersAgent, 'getSelection', commands.getSelection)
```

- [ ] **Step 6: Run tests to verify they pass**

```
npx playwright test tests/agent-state-commands.spec.js --reporter=line
```

Expected: PASS.

- [ ] **Step 7: Commit**

```
git add public/js/agent/commands.js public/js/agent/schemas.js public/js/agent/index.js tests/agent-state-commands.spec.js
git commit -m "feat(agent): add getLayer, getCanvasSize, getSelection commands"
```

---

## Task 9: Project and settings inspection commands

**Files:**
- Modify: `public/js/agent/commands.js`
- Modify: `public/js/agent/schemas.js`
- Modify: `public/js/agent/index.js`
- Test: `tests/agent-project-commands.spec.js`

- [ ] **Step 1: Write the failing tests**

Create `tests/agent-project-commands.spec.js`:

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

test.describe('LayersAgent project & settings inspection', () => {
    test('getProjectInfo returns id/name/dirty/undo state', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() => window.LayersAgent.getProjectInfo())
        expect(env.ok).toBe(true)
        expect(env.result).toMatchObject({
            id: null,
            isDirty: expect.any(Boolean),
            canUndo: expect.any(Boolean),
            canRedo: expect.any(Boolean),
            canSaveAs: true
        })
    })

    test('listProjects returns an array', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() => window.LayersAgent.listProjects())
        expect(env.ok).toBe(true)
        expect(Array.isArray(env.result.projects)).toBe(true)
    })

    test('getSettings returns an object', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() => window.LayersAgent.getSettings())
        expect(env.ok).toBe(true)
        expect(typeof env.result).toBe('object')
    })

    test('getForegroundColor returns a hex color', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() => window.LayersAgent.getForegroundColor())
        expect(env.ok).toBe(true)
        expect(env.result.color).toMatch(/^#[0-9a-fA-F]{6}$/)
    })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```
npx playwright test tests/agent-project-commands.spec.js --reporter=line
```

Expected: FAIL — commands not registered.

- [ ] **Step 3: Add schemas**

Modify `public/js/agent/schemas.js`. Append to `SCHEMAS`:

```js
    getProjectInfo: null,
    listProjects: null,
    getSettings: null,
    getForegroundColor: null,
```

- [ ] **Step 4: Add command implementations**

Modify `public/js/agent/commands.js`. At the top, add:

```js
import { listProjects as listProjectsStorage } from '../utils/project-storage.js'
```

Append to the file:

```js
export async function getProjectInfo(_args, app) {
    const snap = buildSnapshot(app)
    return { result: snap.project }
}

export async function listProjects(_args, _app) {
    let projects = []
    try {
        const raw = await listProjectsStorage()
        projects = (raw || []).map(p => ({
            id: p.id,
            name: p.name,
            createdAt: p.createdAt,
            modifiedAt: p.modifiedAt
        }))
    } catch (err) {
        // Storage failures should not crash the agent — return empty list with a warning.
        return {
            result: { projects: [] },
            warnings: [`listProjects storage error: ${err.message || err}`]
        }
    }
    return { result: { projects } }
}

export async function getSettings(_args, app) {
    const snap = buildSnapshot(app)
    return { result: snap.settings }
}

export async function getForegroundColor(_args, app) {
    return { result: { color: app?._foregroundColor || '#000000' } }
}
```

- [ ] **Step 5: Register the commands**

Modify `public/js/agent/index.js`. In `bootstrapAgent`, append:

```js
    registerCommand(LayersAgent, 'getProjectInfo', commands.getProjectInfo)
    registerCommand(LayersAgent, 'listProjects', commands.listProjects)
    registerCommand(LayersAgent, 'getSettings', commands.getSettings)
    registerCommand(LayersAgent, 'getForegroundColor', commands.getForegroundColor)
```

- [ ] **Step 6: Run tests to verify they pass**

```
npx playwright test tests/agent-project-commands.spec.js --reporter=line
```

Expected: PASS.

- [ ] **Step 7: Commit**

```
git add public/js/agent/commands.js public/js/agent/schemas.js public/js/agent/index.js tests/agent-project-commands.spec.js
git commit -m "feat(agent): add getProjectInfo, listProjects, getSettings, getForegroundColor"
```

---

## Task 10: Effect catalog browsing commands

**Files:**
- Create: `public/js/agent/effects.js`
- Modify: `public/js/agent/commands.js`
- Modify: `public/js/agent/schemas.js`
- Modify: `public/js/agent/index.js`
- Test: `tests/agent-effect-commands.spec.js`

- [ ] **Step 1: Write the failing tests**

Create `tests/agent-effect-commands.spec.js`:

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

test.describe('LayersAgent effect catalog', () => {
    test('searchEffects with no query returns all effects', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() => window.LayersAgent.searchEffects({}))
        expect(env.ok).toBe(true)
        expect(Array.isArray(env.result.effects)).toBe(true)
        expect(env.result.effects.length).toBeGreaterThan(0)
        const sample = env.result.effects[0]
        expect(sample).toMatchObject({
            effectId: expect.stringMatching(/.+\/.+/),
            namespace: expect.any(String),
            name: expect.any(String)
        })
    })

    test('searchEffects with query filters by name/description', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() =>
            window.LayersAgent.searchEffects({ query: 'blur' })
        )
        expect(env.ok).toBe(true)
        expect(env.result.effects.length).toBeGreaterThan(0)
        for (const e of env.result.effects) {
            const hay = (e.effectId + ' ' + e.name + ' ' + (e.description || '') +
                ' ' + (e.tags || []).join(' ')).toLowerCase()
            expect(hay).toContain('blur')
        }
    })

    test('listEffectCategories returns namespaces and tags', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() => window.LayersAgent.listEffectCategories())
        expect(env.ok).toBe(true)
        expect(Array.isArray(env.result.namespaces)).toBe(true)
        expect(Array.isArray(env.result.tags)).toBe(true)
        expect(env.result.namespaces.length).toBeGreaterThan(0)
    })

    test('listCuratedEffects mirrors the human Image menu groups', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() => window.LayersAgent.listCuratedEffects())
        expect(env.ok).toBe(true)
        expect(Array.isArray(env.result.groups)).toBe(true)
        const groupNames = env.result.groups.map(g => g.id)
        expect(groupNames).toEqual(expect.arrayContaining(['tone', 'color', 'blur-sharpen', 'stylize']))
        const tone = env.result.groups.find(g => g.id === 'tone')
        expect(tone.effects.length).toBeGreaterThan(0)
        expect(tone.effects[0]).toMatchObject({
            effectId: expect.stringMatching(/.+\/.+/),
            label: expect.any(String)
        })
    })

    test('getEffectDefinition returns param schema for a known effect', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() =>
            window.LayersAgent.getEffectDefinition({ effectId: 'filter/blur' })
        )
        expect(env.ok).toBe(true)
        expect(env.result.effectId).toBe('filter/blur')
        expect(Array.isArray(env.result.params)).toBe(true)
    })

    test('getEffectDefinition returns NOT_FOUND_EFFECT for unknown id', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() =>
            window.LayersAgent.getEffectDefinition({ effectId: 'filter/totallyMadeUp' })
        )
        expect(env.ok).toBe(false)
        expect(env.error.code).toBe('NOT_FOUND_EFFECT')
    })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```
npx playwright test tests/agent-effect-commands.spec.js --reporter=line
```

Expected: FAIL — commands not registered.

- [ ] **Step 3: Create the effects helper module**

Background: Noisemaker effect param specs live on the loaded effect instance under `instance.globals` — an object keyed by parameter name. Each value spec carries fields like `type` (`'float'` | `'int'` | `'boolean'` | `'string'` | `'color'` | `'vec4'`), `default`, `min`, `max`, `step`, `choices` (an object of `{ label: value }` for enums), and a `ui` block (`ui.label`, `ui.hidden`, `ui.control`, `internal`). `instance.description` is typically not populated; description text is on the manifest entry. The renderer exposes both: `app._renderer.getAllEffects()` for the manifest metadata (description, tags), and `app._renderer.getEffectDefinition(effectId)` for the loaded instance (params via `globals`). The agent's normalizer combines both.

The curated groupings mirror the HTML submenus in `public/index.html` exactly. Hardcoding them here gives agents a stable contract independent of HTML.

Create `public/js/agent/effects.js`:

```js
/**
 * Effect catalog helpers built on the renderer's existing introspection.
 *
 * @module agent/effects
 */

const CURATED_GROUPS = [
    {
        id: 'tone',
        label: 'tone',
        effects: [
            { effectId: 'filter/adjust',     label: 'brightness/contrast' },
            { effectId: 'filter/smoothstep', label: 'levels' },
            { effectId: 'filter/posterize',  label: 'posterize' },
            { effectId: 'filter/threshold',  label: 'threshold' }
        ]
    },
    {
        id: 'color',
        label: 'color',
        effects: [
            { effectId: 'filter/adjust',          label: 'hue/saturation' },
            { effectId: 'filter/grade',           label: 'color grading' },
            { effectId: 'filter/tint',            label: 'tint' },
            { effectId: 'filter/invert',          label: 'invert' },
            { effectId: 'filter/tetraColorArray', label: 'gradient palette' }
        ]
    },
    {
        id: 'blur-sharpen',
        label: 'blur & sharpen',
        effects: [
            { effectId: 'filter/blur',       label: 'blur' },
            { effectId: 'filter/motionBlur', label: 'motion blur' },
            { effectId: 'filter/zoomBlur',   label: 'zoom blur' },
            { effectId: 'filter/sharpen',    label: 'sharpen' }
        ]
    },
    {
        id: 'stylize',
        label: 'stylize',
        effects: [
            { effectId: 'filter/bloom',    label: 'bloom' },
            { effectId: 'filter/grain',    label: 'grain' },
            { effectId: 'filter/vignette', label: 'vignette' },
            { effectId: 'filter/edge',     label: 'edge detect' },
            { effectId: 'filter/dither',   label: 'dither' },
            { effectId: 'filter/emboss',   label: 'emboss' }
        ]
    }
]

export function listCurated() {
    return { groups: CURATED_GROUPS.map(g => ({ ...g, effects: g.effects.slice() })) }
}

export function searchEffects(app, { query, namespace, tags, limit }) {
    const all = app?._renderer?.getAllEffects?.() || []
    const q = (query || '').trim().toLowerCase()
    const filtered = all.filter((e) => {
        if (namespace && e.namespace !== namespace) return false
        if (tags && tags.length) {
            const want = tags.map(t => t.toLowerCase())
            const have = (e.tags || []).map(t => t.toLowerCase())
            if (!want.every(t => have.includes(t))) return false
        }
        if (q) {
            const hay = (e.effectId + ' ' + e.name + ' ' +
                (e.description || '') + ' ' + (e.tags || []).join(' ')).toLowerCase()
            if (!hay.includes(q)) return false
        }
        return true
    })
    const result = limit ? filtered.slice(0, limit) : filtered
    return {
        effects: result.map(e => ({
            effectId: e.effectId,
            namespace: e.namespace,
            name: e.name,
            description: e.description || '',
            tags: e.tags || [],
            starter: !!e.starter
        }))
    }
}

export function listCategories(app) {
    const all = app?._renderer?.getAllEffects?.() || []
    const namespaces = new Set()
    const tags = new Set()
    for (const e of all) {
        if (e.namespace) namespaces.add(e.namespace)
        for (const t of e.tags || []) tags.add(t)
    }
    return {
        namespaces: Array.from(namespaces).sort(),
        tags: Array.from(tags).sort()
    }
}

export async function getEffectDefinition(app, { effectId }) {
    const all = app?._renderer?.getAllEffects?.() || []
    const meta = all.find(e => e.effectId === effectId)
    const instance = await app?._renderer?.getEffectDefinition?.(effectId)
    if (!instance && !meta) return null

    const [namespace, shortName] = effectId.split('/')
    const globals = instance?.globals || {}
    const params = Object.entries(globals)
        .filter(([_, spec]) => !spec.ui?.hidden && !spec.internal)
        .map(([name, spec]) => normalizeParamSpec(name, spec))

    return {
        effectId,
        name: meta?.name || shortName,
        namespace: meta?.namespace || namespace,
        description: meta?.description || '',
        tags: meta?.tags || [],
        params
    }
}

function normalizeParamSpec(name, spec) {
    const out = {
        name,
        type: mapParamType(spec),
        default: spec.default,
        description: spec.ui?.label || ''
    }
    if (spec.min !== undefined) out.min = spec.min
    if (spec.max !== undefined) out.max = spec.max
    if (spec.step !== undefined) out.step = spec.step
    if (spec.choices && typeof spec.choices === 'object' && !Array.isArray(spec.choices)) {
        out.enumValues = Object.entries(spec.choices).map(([label, value]) => ({ value, label }))
    }
    return out
}

function mapParamType(spec) {
    if (spec.type === 'float')   return 'number'
    if (spec.type === 'int')     return 'integer'
    if (spec.type === 'boolean') return 'boolean'
    if (spec.type === 'string')  return 'string'
    if (spec.type === 'color' || spec.type === 'vec4') return 'color'
    if (spec.type === 'vec2' || spec.type === 'vec3')  return spec.type
    if (spec.choices)            return 'enum'
    return 'any'
}
```

If reading the renderer reveals that `def.params` lives at a different path on the loaded effect instance, adjust `getEffectDefinition` accordingly. (The renderer's `getEffectDefinition` already returns the effect instance; the param shape comes directly from the Noisemaker effect definition.)

- [ ] **Step 4: Add schemas**

Modify `public/js/agent/schemas.js`. Append:

```js
    searchEffects: {
        type: 'object',
        properties: {
            query: { type: 'string' },
            namespace: { type: 'string' },
            tags: { type: 'array', items: { type: 'string' } },
            limit: { type: 'integer', min: 1, max: 1000 }
        }
    },
    listEffectCategories: null,
    listCuratedEffects: null,
    getEffectDefinition: {
        type: 'object',
        required: ['effectId'],
        properties: { effectId: { type: 'string' } }
    },
```

- [ ] **Step 5: Add command implementations**

Modify `public/js/agent/commands.js`. Add the import:

```js
import * as effectsModule from './effects.js'
```

Append:

```js
export async function searchEffects(args, app) {
    return { result: effectsModule.searchEffects(app, args || {}) }
}

export async function listEffectCategories(_args, app) {
    return { result: effectsModule.listCategories(app) }
}

export async function listCuratedEffects(_args, _app) {
    return { result: effectsModule.listCurated() }
}

export async function getEffectDefinition({ effectId }, app) {
    const def = await effectsModule.getEffectDefinition(app, { effectId })
    if (!def) {
        const allList = app?._renderer?.getAllEffects?.() || []
        const allIds = allList.map(e => e.effectId)
        const didYouMean = closest(effectId, allIds, 3)
        throw commandError('NOT_FOUND_EFFECT',
            `Effect not found: ${effectId}`,
            { effectId, didYouMean })
    }
    return { result: def }
}

function closest(needle, haystack, k) {
    const scored = haystack.map((id) => [id, levenshtein(needle, id)])
    scored.sort((a, b) => a[1] - b[1])
    return scored.slice(0, k).map(([id]) => id)
}

function levenshtein(a, b) {
    const m = a.length, n = b.length
    if (m === 0) return n
    if (n === 0) return m
    const dp = Array.from({ length: m + 1 }, () => new Array(n + 1))
    for (let i = 0; i <= m; i++) dp[i][0] = i
    for (let j = 0; j <= n; j++) dp[0][j] = j
    for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1
            dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost)
        }
    }
    return dp[m][n]
}
```

- [ ] **Step 6: Register the commands**

Modify `public/js/agent/index.js`. In `bootstrapAgent`, append:

```js
    registerCommand(LayersAgent, 'searchEffects', commands.searchEffects)
    registerCommand(LayersAgent, 'listEffectCategories', commands.listEffectCategories)
    registerCommand(LayersAgent, 'listCuratedEffects', commands.listCuratedEffects)
    registerCommand(LayersAgent, 'getEffectDefinition', commands.getEffectDefinition)
```

- [ ] **Step 7: Run tests to verify they pass**

```
npx playwright test tests/agent-effect-commands.spec.js --reporter=line
```

Expected: PASS.

- [ ] **Step 8: Commit**

```
git add public/js/agent/effects.js public/js/agent/commands.js public/js/agent/schemas.js public/js/agent/index.js tests/agent-effect-commands.spec.js
git commit -m "feat(agent): add effect catalog commands (search/list/curated/getDefinition)"
```

---

## Task 11: Job stubs

**Files:**
- Modify: `public/js/agent/commands.js`
- Modify: `public/js/agent/schemas.js`
- Modify: `public/js/agent/index.js`
- Test: `tests/agent-job-commands.spec.js`

The job model has no real jobs in Phase 1; these stubs return `NOT_FOUND_JOB` consistently and provide the surface area later phases will populate.

- [ ] **Step 1: Write the failing test**

Create `tests/agent-job-commands.spec.js`:

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

test.describe('LayersAgent job stubs', () => {
    test('getJob returns NOT_FOUND_JOB', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() =>
            window.LayersAgent.getJob({ jobId: 'job-x' })
        )
        expect(env.ok).toBe(false)
        expect(env.error.code).toBe('NOT_FOUND_JOB')
    })

    test('waitForJob returns NOT_FOUND_JOB', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() =>
            window.LayersAgent.waitForJob({ jobId: 'job-x' })
        )
        expect(env.ok).toBe(false)
        expect(env.error.code).toBe('NOT_FOUND_JOB')
    })

    test('cancelJob returns NOT_FOUND_JOB', async ({ page }) => {
        await bootApp(page)
        const env = await page.evaluate(() =>
            window.LayersAgent.cancelJob({ jobId: 'job-x' })
        )
        expect(env.ok).toBe(false)
        expect(env.error.code).toBe('NOT_FOUND_JOB')
    })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```
npx playwright test tests/agent-job-commands.spec.js --reporter=line
```

Expected: FAIL.

- [ ] **Step 3: Add schemas**

Modify `public/js/agent/schemas.js`. Append:

```js
    getJob: {
        type: 'object',
        required: ['jobId'],
        properties: { jobId: { type: 'string' } }
    },
    waitForJob: {
        type: 'object',
        required: ['jobId'],
        properties: {
            jobId: { type: 'string' },
            timeoutMs: { type: 'integer', min: 0, max: 3600000 }
        }
    },
    cancelJob: {
        type: 'object',
        required: ['jobId'],
        properties: { jobId: { type: 'string' } }
    },
```

- [ ] **Step 4: Implement the stubs**

Modify `public/js/agent/commands.js`. Append:

```js
export async function getJob({ jobId }) {
    throw commandError('NOT_FOUND_JOB', `Job not found: ${jobId}`, { jobId })
}

export async function waitForJob({ jobId }) {
    throw commandError('NOT_FOUND_JOB', `Job not found: ${jobId}`, { jobId })
}

export async function cancelJob({ jobId }) {
    throw commandError('NOT_FOUND_JOB', `Job not found: ${jobId}`, { jobId })
}
```

- [ ] **Step 5: Register the commands**

Modify `public/js/agent/index.js`. In `bootstrapAgent`, append:

```js
    registerCommand(LayersAgent, 'getJob', commands.getJob)
    registerCommand(LayersAgent, 'waitForJob', commands.waitForJob)
    registerCommand(LayersAgent, 'cancelJob', commands.cancelJob)
```

- [ ] **Step 6: Run tests to verify they pass**

```
npx playwright test tests/agent-job-commands.spec.js --reporter=line
```

Expected: PASS.

- [ ] **Step 7: Commit**

```
git add public/js/agent/commands.js public/js/agent/schemas.js public/js/agent/index.js tests/agent-job-commands.spec.js
git commit -m "feat(agent): add getJob/waitForJob/cancelJob stubs"
```

---

## Task 12: Concurrency end-to-end test

**Files:**
- Test: `tests/agent-concurrency.spec.js`

This task is verification-only — it exercises the queue serialization that already exists. No production code changes.

- [ ] **Step 1: Write the test**

Create `tests/agent-concurrency.spec.js`:

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

test.describe('LayersAgent concurrency', () => {
    test('5 parallel calls all succeed and run sequentially', async ({ page }) => {
        await bootApp(page)
        const results = await page.evaluate(async () => {
            const out = await Promise.all([
                window.LayersAgent.getState(),
                window.LayersAgent.getCanvasSize(),
                window.LayersAgent.getProjectInfo(),
                window.LayersAgent.getForegroundColor(),
                window.LayersAgent.getState()
            ])
            return out.map(e => ({ ok: e.ok, command: e.command }))
        })
        expect(results.every(r => r.ok)).toBe(true)
        expect(results.map(r => r.command)).toEqual([
            'getState', 'getCanvasSize', 'getProjectInfo',
            'getForegroundColor', 'getState'
        ])
    })

    test('failure in one command does not block subsequent commands', async ({ page }) => {
        await bootApp(page)
        const results = await page.evaluate(async () => {
            const out = await Promise.all([
                window.LayersAgent.getLayer({ layerId: 'layer-nope' }),
                window.LayersAgent.getCanvasSize()
            ])
            return out.map(e => ({ ok: e.ok, command: e.command, code: e.error?.code }))
        })
        expect(results[0].ok).toBe(false)
        expect(results[0].code).toBe('NOT_FOUND_LAYER')
        expect(results[1].ok).toBe(true)
    })
})
```

- [ ] **Step 2: Run the test**

```
npx playwright test tests/agent-concurrency.spec.js --reporter=line
```

Expected: PASS (queue already in place from Task 2).

- [ ] **Step 3: Commit**

```
git add tests/agent-concurrency.spec.js
git commit -m "test(agent): verify command serialization and isolation"
```

---

## Task 13: Snapshot golden regression test

**Files:**
- Test: `tests/agent-snapshot-golden.spec.js`
- Test fixture: `tests/fixtures/agent-snapshot-blank.json`

This task captures a known-good snapshot of an app in a deterministic post-init state and diffs it against future runs. It catches accidental schema changes or default-value drift.

- [ ] **Step 1: Write the test (uses an UPDATE env flag to regenerate)**

Create `tests/agent-snapshot-golden.spec.js`:

```js
import fs from 'node:fs'
import path from 'node:path'
import { test, expect } from 'playwright/test'

const FIXTURE = path.resolve('tests/fixtures/agent-snapshot-blank.json')

async function bootBlankProject(page) {
    await page.goto('/', { waitUntil: 'networkidle' })
    await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })
    await page.evaluate(async () => { await window.LayersAgent.ready })
    await page.click('.media-option[data-type="solid"]')
    await page.waitForSelector('.canvas-size-dialog', { timeout: 5000 })
    await page.click('.canvas-size-dialog .action-btn.primary')
    await page.waitForSelector('.open-dialog-backdrop.visible', { state: 'hidden', timeout: 5000 })
    await page.waitForTimeout(300)
}

function normalize(snap) {
    // Strip non-deterministic fields. Preserve structure.
    const clone = JSON.parse(JSON.stringify(snap))
    if (Array.isArray(clone.layers)) {
        for (const l of clone.layers) {
            l.id = '<id>'
            for (const c of l.children || []) c.id = '<id>'
        }
    }
    if (Array.isArray(clone.selectedLayerIds)) {
        clone.selectedLayerIds = clone.selectedLayerIds.map(() => '<id>')
    }
    if (clone.activeLayerId) clone.activeLayerId = '<id>'
    return clone
}

test('blank-project snapshot matches golden', async ({ page }) => {
    await bootBlankProject(page)
    const snap = await page.evaluate(() => window.LayersAgent.getState())
    expect(snap.ok).toBe(true)
    const normalized = normalize(snap.state)

    if (process.env.UPDATE_GOLDEN) {
        fs.mkdirSync(path.dirname(FIXTURE), { recursive: true })
        fs.writeFileSync(FIXTURE, JSON.stringify(normalized, null, 2) + '\n')
        return
    }

    const golden = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'))
    expect(normalized).toEqual(golden)
})
```

- [ ] **Step 2: Generate the golden file**

```
UPDATE_GOLDEN=1 npx playwright test tests/agent-snapshot-golden.spec.js --reporter=line
```

Expected: test passes (it's writing the file). Verify the file exists:

```
cat tests/fixtures/agent-snapshot-blank.json | head -40
```

It should contain the normalized snapshot with `<id>` placeholders.

- [ ] **Step 3: Run normally to verify diff comparison**

```
npx playwright test tests/agent-snapshot-golden.spec.js --reporter=line
```

Expected: PASS.

- [ ] **Step 4: Commit**

```
git add tests/agent-snapshot-golden.spec.js tests/fixtures/agent-snapshot-blank.json
git commit -m "test(agent): add snapshot golden regression test"
```

---

## Task 14: Phase 1 verification — run the full agent test suite

**Files:** none — verification only.

- [ ] **Step 1: Run every agent spec**

```
npx playwright test tests/agent-*.spec.js --reporter=line
```

Expected: every test PASSES. If any fail, fix and re-run before proceeding.

- [ ] **Step 2: Run the full Layers test suite to verify no regressions**

```
npx playwright test --reporter=line
```

Expected: all existing tests PASS. Phase 1 is purely additive; if any pre-existing test breaks, root-cause and fix.

- [ ] **Step 3: Manual smoke — verify the human UI is unaffected**

Boot the dev server and confirm Layers behaves identically to before:

```
npx http-server public -p 3002 -c-1
```

In a browser, verify:
- The app loads, the open dialog appears, the canvas renders.
- Adding/deleting/reordering layers works as before.
- `window.LayersAgent.version` is `'1.0'` in the devtools console.
- `await window.LayersAgent.getState()` returns a snapshot without errors.

- [ ] **Step 4: Tag the milestone (optional)**

```
git tag agent-phase-1
```

(Tag stays local; do not push without explicit approval.)

---

## Out of scope for Phase 1 (deferred to later plans)

- All mutating commands: `addLayer`, `setLayerProps`, `setChildEffectParams`, etc. — Phase 2 onward.
- `getThumbnail`, `getLayerThumbnail`, `getCanvasImageBytes`, `pasteImageFromBytes`, `exportImage` — Phase 3.
- Selection set/modify, drawing, masks-CRUD — Phase 4.
- `setSettings`, `setForegroundColor`, undo/redo control, view controls — Phase 5.
- `exportVideo`, `installFontBundle`, real job model — Phase 6.
- The `layers-mcp` sidecar — Phase 7.
- Agent-driven evals — Phase 8.
