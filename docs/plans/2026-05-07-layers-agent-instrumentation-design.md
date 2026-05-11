# Layers Agent Instrumentation — Design

**Status:** approved (brainstorming complete; awaiting plan)
**Date:** 2026-05-07
**Authors:** Alex Ayars + Claude (Opus 4.7)

---

## Problem & goals

Layers is currently a human-driven, browser-based, layer-based image and video editor. Software agents have no first-class way to compose layers, search effects, modify parameters, manage settings, inspect state, or obtain results. The handful of tests that drive the app via `window.layersApp._handle*` use private, unstable methods.

**Goal:** transparently instrument Layers so that software agents can perform every operation a human can — composing layers, searching for effects, viewing/modifying params, viewing/updating settings, retrieving results as image or video downloads, reviewing composition state — through a stable, versioned, JSON-only public API. Human workflow remains unchanged; the instrumentation is purely additive.

**Non-goals:**
- Replacing or modifying the existing UI.
- Server-side rendering or a Node-runnable headless renderer (Layers is browser-only by design; CDN-loaded shaders are not portable to Node without a vendor-specific port).
- Sandboxing the agent from the user's filesystem beyond MIME sniffing on path reads. The MCP runs locally with the user's privileges and is treated as an unprivileged peer.
- Multi-tenant or remote-access scenarios. Single user, single host, local stdio MCP.
- Visual quality scoring of agent outputs (eval predicates are deterministic; LLM-as-judge is out of scope).

---

## Architecture

Two repositories, three concerns separated.

```
layers/  (existing)                  layers-mcp/  (new sibling repo)
├── public/                          ├── src/
│   └── js/                          │   ├── server.ts       MCP stdio server
│       └── agent/      ← NEW        │   ├── session.ts      Playwright lifecycle
│           ├── api.js  (LayersAgent)│   ├── localServer.ts  http server for vendored layers
│           ├── schemas.js           │   ├── downloads.ts    download capture
│           ├── snapshot.js          │   ├── bridge.ts       page.evaluate wrapper
│           └── effects.js           │   ├── schemas/        per-tool JSON schemas
└── tests/                           │   ├── tools/          one file per MCP tool
    └── agent/          ← NEW        │   └── ...
        └── *.spec.js                ├── vendored/layers/    pinned Layers build
                                     ├── scripts/vendor.sh   pulls Layers @ pinned tag
                                     ├── evals/              agent-driven task suite
                                     └── tests/              MCP-level Playwright tests
```

### Layers repo — purely additive changes

- New module: `public/js/agent/`. Loaded once during `app.js` init, after the renderer is ready, and attached as `window.LayersAgent`.
- Zero changes to UI behavior. Existing private `_handle*` methods are not modified; `LayersAgent` calls them internally.
- `window.LayersAgent.version = '1.0'`. `window.LayersAgent.ready` is a Promise that resolves when init is complete; the sidecar awaits it before issuing commands.
- Existing `window.layersApp` debug export is preserved.

### `layers-mcp` sidecar — lifecycle

1. **Boot.** Read environment variables (see Configuration). Start an internal `http-server` on a random localhost port serving `vendored/layers/`. Skipped if `LAYERS_URL` is set (development against `http://localhost:3002` or production `https://layers.noisefactor.io`).
2. **Browser.** Launch Playwright Chromium with a persistent context at `LAYERS_USER_DATA_DIR` (default `~/.layers-mcp/profile/`) so IndexedDB-stored projects survive restarts.
3. **Navigate.** Open the Layers URL. Await `window.LayersAgent?.ready`. Read `LayersAgent.version`; abort with `SESSION_VERSION_MISMATCH` if it doesn't match the version the sidecar was built against.
4. **Downloads.** Register a Playwright `download` listener that saves every download into `LAYERS_OUTPUT_DIR` (default `~/.layers-mcp/exports/`) with a sanitized, timestamped filename, surfaced via an internal event bus that `exportImage`/`exportVideo` tools subscribe to.
5. **Tools.** Register MCP tools (one per `LayersAgent` command, plus three thin wrappers — see *Tool mapping*). Begin stdio loop.

### Configuration (env vars, all optional)

| Variable | Default | Purpose |
|---|---|---|
| `LAYERS_OUTPUT_DIR` | `~/.layers-mcp/exports/` | Where exports are saved |
| `LAYERS_USER_DATA_DIR` | `~/.layers-mcp/profile/` | Chromium profile (project persistence) |
| `LAYERS_LOG_DIR` | `~/.layers-mcp/logs/` | Structured tool-call logs |
| `LAYERS_URL` | (vendored build, served locally) | Override Layers source URL |
| `LAYERS_HEADED` | `0` | Show the browser window for debugging |

### Reproducibility

A given `layers-mcp` version pins the `layers` version it ships against. `scripts/vendor.sh` clones `layers@<tag>`, copies `public/` into `vendored/layers/`. The pinned tag and bundle metadata are recorded in `layers-mcp`'s `package.json`. Mismatches at runtime are caught by the version check.

---

## In-page agent API (`window.LayersAgent`)

### Envelope

Every command is async and returns:

```js
// success
{
  ok: true,
  command: 'addLayer',
  apiVersion: '1.0',
  result: { /* command-specific */ },
  state: { /* full snapshot, see "State snapshot shape" */ },
  warnings?: ['…']
}

// failure
{
  ok: false,
  command: 'addLayer',
  apiVersion: '1.0',
  error: { code, message, details },
  state: { /* full snapshot, possibly unchanged */ }
}
```

State is included on both success and failure, so the agent never needs a separate refresh after a failure.

### Long-running jobs

Two operations are job-modeled:
- `exportVideo` (renders many frames; can take minutes)
- `installFontBundle` (140 MB download)

Job-modeled commands return `{ jobId }` immediately. The agent uses:
- `getJob({ jobId })` — current snapshot of the job
- `waitForJob({ jobId, timeoutMs? })` — resolves when status becomes `done` or `error`
- `cancelJob({ jobId })` — best-effort cancel

The MCP sidecar wraps these so the corresponding MCP tools block until completion (and emit MCP progress notifications when the protocol allows).

### Versioning

`LayersAgent.version = '1.0'` is exposed on the namespace. Each response echoes `apiVersion`. Major version bumps are breaking; minor bumps are additive.

### Command catalogue

| Domain | Commands |
|---|---|
| **Project** | `newProject`, `openProject`, `saveProject`, `saveProjectAs`, `listProjects`, `deleteProject`, `getProjectInfo` |
| **Layer CRUD** | `addLayer`, `deleteLayer`, `duplicateLayer`, `reorderLayer`, `selectLayer`, `selectLayers`, `flattenImage`, `flattenLayers`, `rasterizeLayer` |
| **Layer props** | `setLayerProps`, `setLayerTransform`, `setLayerEffectParams`, `flipLayer` |
| **Child effects** | `addChildEffect`, `removeChildEffect`, `reorderChildEffect`, `setChildEffectProps`, `setChildEffectParams` |
| **Masks** | `addLayerMask`, `addMaskFromSelection`, `deleteLayerMask`, `invertLayerMask`, `setMaskEnabled`, `featherMask`, `expandMask`, `contractMask`, `smoothMask` |
| **Selection** | `selectAll`, `selectNone`, `selectInverse`, `setRectangleSelection`, `setOvalSelection`, `setPolygonSelection`, `setMagicWandSelection`, `selectColorRange`, `expandSelection`, `contractSelection`, `featherSelection`, `smoothSelection`, `borderSelection`, `cropToSelection` |
| **Drawing** | `paintStroke`, `drawShape`, `fillRegion` |
| **Image** | `resizeImage`, `resizeCanvas`, `autoLevels`, `autoContrast`, `autoWhiteBalance` |
| **View** | `setZoom`, `play`, `pause` |
| **Edit** | `undo`, `redo`, `getCanvasImageBytes`, `pasteImageFromBytes` |
| **Settings** | `getSettings`, `setSettings`, `installFontBundle` (job), `listInstalledFonts` |
| **Foreground color** | `getForegroundColor`, `setForegroundColor` |
| **Effect catalog** | `searchEffects`, `getEffectDefinition`, `listEffectCategories`, `listCuratedEffects` |
| **Export** | `exportImage`, `exportVideo` (job) |
| **State** | `getState`, `getLayer`, `getCanvasSize`, `getSelection`, `getThumbnail`, `getLayerThumbnail`, `getJob`, `waitForJob`, `cancelJob` |

### Notes on individual commands

**Dialogs are bypassed.** Wherever the human UI uses a dialog to gather inputs (`newProject`'s size picker, `saveProjectAs`'s name prompt, `exportImage`'s format/quality picker, etc.), the corresponding agent command takes those inputs directly as args and skips the dialog entirely. The dialogs and the menu items that open them remain unchanged for human users; agent commands are a parallel, programmatic path into the same underlying operations.

**`addLayer`** — kind: `media` | `effect` | `drawing` | `text`.
- `media`: `{ kind: 'media', source: { kind: 'path' | 'url' | 'base64', value, mimeType? }, mediaType: 'image' | 'video', name? }`. `path` is resolved sidecar-side (the page never sees the filesystem); the sidecar reads bytes, MIME-sniffs, base64-encodes, and submits as `{ kind: 'base64', data, mimeType }`.
- `effect`: `{ kind: 'effect', effectId, params?, name? }`.
- `drawing`: `{ kind: 'drawing', name? }` — empty drawing layer.
- `text`: `{ kind: 'text', text, params?, name? }` — sugar for `effect` with `effectId: 'filter/text'`.

**Selection commands** accept `mode: 'replace' | 'add' | 'subtract' | 'intersect'` matching the modifier-key model in the human UI.

**`paintStroke`, `drawShape`, `fillRegion`** replace mouse-drag interactions with single point-array commands. Pressure-aware via `points: [{x, y, pressure?}]`.

**`getCanvasImageBytes`** — full-resolution PNG/JPG bytes as base64. Expensive; intended for export-equivalent use.

**`getThumbnail({ maxDimension: 256, format: 'jpg' })`** — returns `{ data, format, width, height }`. Cheap (sub-50KB at default settings); intended as the agent's "look at what I just did" channel.

**`getLayerThumbnail({ layerId, maxDimension, format })`** — same shape, but rendered with only the named layer visible (and its children). Lets the agent inspect a single layer's contribution.

**`searchEffects({ query?, namespace?, tags?, limit? })`** — fuzzy match over name + description + tags. Returns `[{ effectId, name, namespace, tags, description, hasParams }]`.

**`listCuratedEffects()`** — returns the same hierarchical groupings the human Image menu uses (`tone`, `color`, `blur-sharpen`, `stylize` and any future groups). Lets agents discover effects by intent without free-text searching the full catalog.

**`getEffectDefinition({ effectId })`** — full param schema:

```js
{
  effectId, name, namespace, description, tags,
  params: [
    {
      name, type,                         // 'number' | 'integer' | 'boolean' | 'enum' | 'color' | 'string' | 'select-effect'
      default,
      min?, max?, step?,                  // for numeric types
      enumValues?: [{ value, label }],    // for 'enum'
      description, group?
    }
  ]
}
```

This is the canonical schema, also returned in `INVALID_ARGS_RANGE` / `INVALID_ARGS_ENUM` error `details` for self-correction.

### Concurrency

The page-side bridge serializes all commands. Only one is in flight at a time (WebGL state is shared mutable). Long-running operations use the job model so they don't block the queue.

---

## State snapshot shape

The same JSON object is returned in every command envelope and from `getState()`. Bounded — no pixel data inline. Small even at 200+ layers (a few tens of KB).

```js
{
  apiVersion: '1.0',
  schemaVersion: '1.0',          // separate from API; lets snapshot evolve

  project: {
    id, name, isDirty,
    canUndo, canRedo, canSaveAs
  },

  canvas: { width, height },
  view: { zoomMode, isPlaying, loopDuration },
  foreground: { color },

  selection: null | {
    kind: 'rectangle' | 'oval' | 'polygon' | 'lasso' | 'wand' | 'color-range',
    bounds: { x, y, width, height },
    isEmpty: false,
    polygonPoints?: [[x, y], ...]   // present only when set via setPolygonSelection
  },

  layers: [                         // bottom-to-top in stack
    {
      id, name, sourceType: 'media' | 'effect' | 'drawing',
      visible, opacity, blendMode, locked,
      transform: { offsetX, offsetY, scaleX, scaleY, rotation, flipH, flipV },

      media: null | { type: 'image' | 'video', filename, width, height, durationSec? },
      effect: null | { id, name, params: { ... } },
      drawing: null | { strokeCount },

      children: [
        { id, name, effectId, visible, params: { ... } }
      ],

      mask: null | {
        enabled, visible,
        width, height,
        coverage,                   // 0..1, fraction of non-black pixels
        bounds: { x, y, width, height }
      }
    }
  ],
  selectedLayerIds: [...],
  activeLayerId: null | string,

  jobs: [
    { id, kind: 'video-export' | 'font-install',
      status: 'pending' | 'running' | 'done' | 'error',
      progress: 0..1, startedAt, finishedAt?, result?, error? }
  ],

  recentExports: [                  // capped at last 50
    { id, path, filename, mimeType, sizeBytes, createdAt, kind: 'image' | 'video' }
  ],

  settings: { theme, baseTheme, /* etc */ }
}
```

### Deliberate omissions

- **Effect definitions.** Fetched on demand via `getEffectDefinition`.
- **Drawing strokes.** Only `strokeCount` is exposed.
- **Mask & selection raw pixel masks.** Only bbox + coverage. Agents that need pixels go through export.
- **Media file blobs.** Filename + dimensions only.

### Identity & ordering

- Layer order in the array is bottom-to-top (matches the renderer composition order). `reorderLayer({ layerId, toIndex })` uses this index space.
- Layer IDs are stable for a session and persist through save/load.
- Child effect IDs are stable for the lifetime of their parent layer.

---

## MCP sidecar (`layers-mcp`)

### Tool mapping

Default rule: **1:1**. Each `LayersAgent` command becomes one MCP tool with the same name.

**Schema source of truth:** definitions live in `layers/public/js/agent/schemas.js`. The vendor script copies that file into `layers-mcp/vendored/layers/`. MCP tool definitions in `layers-mcp/src/tools/*.ts` import the vendored copy and derive their JSON Schema and arg validators from it. There is one canonical definition; the MCP side never re-declares a schema independently. Drift is impossible because there is only one place a schema is written.

The thin `bridge.ts`:

```ts
async function call(toolName, args) {
  const envelope = await page.evaluate(
    (n, a) => window.LayersAgent[n](a),
    toolName, args
  );
  if (!envelope.ok) throw mcpErrorFrom(envelope.error);
  return { result: envelope.result, state: envelope.state, warnings: envelope.warnings };
}
```

### Three wrapped tools

**`addLayer` / `loadMedia` / `pasteImageFromBytes`** — when `source.kind === 'path'`, the sidecar reads from disk first, MIME-sniffs to confirm image/video, base64-encodes, then forwards to the page-side command with `{ kind: 'base64', data, mimeType }`. The page never touches the filesystem.

**`exportImage`** — sets up a one-shot download listener, invokes `LayersAgent.exportImage`, awaits the download event, persists the file under `LAYERS_OUTPUT_DIR`, returns `{ path, filename, mimeType, sizeBytes }` plus the latest state.

**`exportVideo`** — invokes `LayersAgent.exportVideo`, receives `{ jobId }`, polls `waitForJob` (~500ms cadence; emits MCP progress notifications when supported). On completion, captures the resulting download (same as image flow), returns the same export descriptor.

### Lifecycle / robustness

- **Page crash** → `session.ts` reloads the page, restores last-saved project if a current project ID exists, surfaces an `mcp` notification. In-flight job state is reset to `error`.
- **Sidecar restart** → projects intact via persistent user-data-dir; in-progress exports lost.
- **`LAYERS_HEADED=1`** → Chromium runs headed; useful for development and demos.
- **`--snapshot-on-error` flag** → on tool error, save a screenshot and DOM dump alongside the error response. Cheap, big debugging payoff.

### Output dir hygiene

- Exports are never auto-deleted (agent may need to reference them later).
- `state.recentExports` (capped at 50) gives the agent visibility.
- A `cleanExports({ olderThanDays? })` MCP tool lets the agent manage its own scratch space.

### MCP client config

Same pattern as `shade-mcp`. Example for Claude Code:

```json
{
  "mcpServers": {
    "layers": {
      "command": "node",
      "args": ["/path/to/layers-mcp/dist/index.js"],
      "env": {
        "LAYERS_OUTPUT_DIR": "/tmp/layers-exports"
      }
    }
  }
}
```

`docs/SETUP.md` ships parallel snippets for VS Code Copilot, Cursor, and Claude Desktop.

---

## Error handling

### Error taxonomy

| Code prefix | Meaning |
|---|---|
| `INVALID_ARGS_*` | Schema validation failed at the API boundary; no state change. `INVALID_ARGS_TYPE`, `INVALID_ARGS_RANGE`, `INVALID_ARGS_ENUM`, `INVALID_ARGS_REQUIRED`. |
| `NOT_FOUND_*` | Referenced thing doesn't exist. `NOT_FOUND_LAYER`, `NOT_FOUND_EFFECT`, `NOT_FOUND_PROJECT`, `NOT_FOUND_JOB`. |
| `CONFLICT_*` | Args valid but operation can't proceed in current state. `CONFLICT_LAYER_LOCKED`, `CONFLICT_LAYER_HAS_MASK`, `CONFLICT_TOOL_BLOCKED_FOR_VIDEO`, `CONFLICT_EXPORT_IN_PROGRESS`. |
| `RENDER_*` | WebGL / shader pipeline failure. `RENDER_SHADER_COMPILE`, `RENDER_GL_LOST` (triggers auto-recovery). |
| `RESOURCE_*` | Media / font / asset load failure. `RESOURCE_TOO_LARGE`, `RESOURCE_UNSUPPORTED_FORMAT`, `RESOURCE_DECODE_FAILED`. |
| `JOB_*` | Long-running op failed/cancelled/timed out. `JOB_FAILED`, `JOB_CANCELLED`, `JOB_TIMEOUT`. |
| `SESSION_*` | Sidecar/page-level failures (returned by MCP layer, not page). `SESSION_PAGE_CRASHED`, `SESSION_VERSION_MISMATCH`. |

`details` carries everything the agent needs to self-correct:
- `INVALID_ARGS_RANGE`: `{ field: 'opacity', value: 250, min: 0, max: 100 }`
- `NOT_FOUND_EFFECT`: `{ effectId: 'filter/blr', didYouMean: ['filter/blur', 'filter/zoomBlur'] }`
- `CONFLICT_LAYER_HAS_MASK`: `{ layerId, suggestion: 'call deleteLayerMask first' }`

### Atomicity

Every command either fully applies or fully doesn't. Undo state is pushed only on success. Multi-step internal ops (rasterize, flatten, crop-to-selection) preserve atomicity from the agent's perspective.

### Resource limits

- Media file > 200 MB → `RESOURCE_TOO_LARGE`.
- Canvas dimension > 8192 → `INVALID_ARGS_RANGE` (matches existing UI cap).
- > 1 concurrent video export → `CONFLICT_EXPORT_IN_PROGRESS`.
- Soft warning at > 200 layers; never an error.

### Path & filesystem safety (sidecar)

- Path-accepting commands are read by the sidecar from the user's filesystem. The agent's effective read scope = the user's read scope. Not pretending to sandbox.
- MIME sniffing on path reads refuses non-image/non-video content.
- Writes go **only** under `LAYERS_OUTPUT_DIR`. Filenames sanitized (strip `..`, leading `/`, control chars; whitelist of extensions per export format).

### Network safety

- Page makes its own outbound calls to pinned CDNs (shaders, fonts). No agent-supplied URLs ever drive a sidecar `fetch`. URL-loaded media is fetched by the page itself, subject to standard browser CORS — same posture as a human user.

### Snapshot privacy

Snapshot exposes user-chosen filenames and names, plus export paths under `LAYERS_OUTPUT_DIR` (necessary for handoff). Nothing else from the host filesystem leaks. Pixel data never included.

### Auto-recovery

`RENDER_GL_LOST` and `SESSION_PAGE_CRASHED` trigger automatic page reload + restore-last-saved-project (if a current project ID exists). Agent sees one error response, then a fresh state from the recovered session.

### Logging

Every tool call logged to `LAYERS_LOG_DIR` (default `~/.layers-mcp/logs/`): timestamp, tool, args (with media bytes elided), result code, duration. No state snapshots, no media bytes.

---

## Testing strategy

Four layers.

### 1. Schema / contract tests (`layers/`)

- Schemas in `public/js/agent/schemas.js` are the single source of truth, used for runtime arg validation, snapshot serialization, MCP tool definitions, and test fixture generation.
- Snapshot golden tests: fixture project → scripted command sequence → diff resulting state JSON against checked-in golden. Catches schema drift on every run.

### 2. Page-level integration tests (`layers/`, Playwright)

- Existing `_handle*`-based tests stay untouched.
- New tests prefer `window.LayersAgent.<command>`. Migrate opportunistically; no big-bang rewrite.
- One spec per command domain: positive cases + key negative cases (`INVALID_ARGS_RANGE`, `NOT_FOUND_LAYER`, `CONFLICT_LAYER_LOCKED`).
- Concurrency test: dispatch 5 commands in parallel without `await`, assert serialization + all-success.

### 3. MCP-level end-to-end tests (`layers-mcp/`, Playwright)

- Smoke (< 10s): boot → `getState` → `addLayer({kind:'effect', effectId:'synth/gradient'})` → `exportImage` → verify file exists, valid PNG, expected dimensions.
- Per-tool integration: every MCP tool called at least once, tool result + state both verified.
- Failure injection: force `RENDER_SHADER_COMPILE`, assert error envelope shape, assert next command works.
- Long-running: kick `exportVideo` at 1s/30fps, assert progress notifications, assert final file is a valid MP4.
- Crash recovery: kill page mid-session, assert reload + restore + clear error envelope.

### 4. Agent-driven evals (`layers-mcp/evals/`)

A small task suite + a runner using the Anthropic SDK to drive a real agent against the local MCP. Catches design problems unit tests miss.

```
layers-mcp/evals/
├── tasks/
│   ├── 01-vintage-photo.json
│   ├── 01-vintage-photo.predicate.js
│   ├── 02-soft-blur-video.{json,predicate.js}
│   ├── 03-color-graded-mask.{json,predicate.js}
│   ├── 04-looping-gradient.{json,predicate.js}
│   ├── 05-text-on-photo.{json,predicate.js}
│   ├── 06-mask-from-color-range.{json,predicate.js}
│   ├── 07-effect-chain-tweak.{json,predicate.js}
│   ├── 08-flatten-and-export.{json,predicate.js}
│   └── (8–12 total at MVP)
├── fixtures/                         test media (small, public-domain)
└── runner.ts                         boot sidecar, spawn agent, score
```

Task manifest:

```js
{
  id: 'vintage-photo',
  setup: { /* media files to copy in, project to load, or 'blank' */ },
  goal: "Make this photo look like a faded 70s film print. Export 1024x1024 PNG.",
  budget: { maxTurns: 30, maxTokens: 50000 },
  predicate: 'predicate.js'
}
```

Predicate examples (deterministic, programmatic — no LLM-as-judge):
- `vintage-photo`: state has ≥ 2 layers, the top has at least one of `[grain, vignette, grade, tint]` in its child chain, an exported PNG exists at requested dimensions and is a valid image with non-trivial color variance.
- `looping-gradient`: state has a `synth/gradient` effect layer, `loopDuration <= 4`, exported MP4 exists, ffprobe reports `duration ≈ 4s`, FPS matches.
- `soft-blur-video`: layer is video, has `filter/blur` (or motionBlur/zoomBlur) child, exported MP4 dimensions correct.

Runner output per task: `{ passed, turns, toolCalls, tokens, durationMs, finalState, transcriptPath }`. Suite output: pass-rate matrix, regressions vs. last run.

### Run cadence

- (1), (2) → every `layers/` PR.
- (3) → every `layers-mcp/` PR.
- (4) → opt-in. `npm run eval` runs the full suite (~$1–5 of API spend). `npm run eval:smoke` runs 2 quickest tasks. `npm run eval:interactive <task>` streams tool calls to terminal for iteration. Don't gate PRs on it; periodic confidence check + design-feedback loop.

### Manual smoke

`npm run dev:headed` — boots the sidecar with `LAYERS_HEADED=1` so a developer can watch the agent work in a real browser window.

---

## Implementation phasing

This design is intentionally too large for a single implementation plan. The plan writer should decompose roughly along these phases (each independently shippable, each preserving the "human workflow unchanged" invariant):

1. **Foundation** — `layers/public/js/agent/` module skeleton, envelope shape, version, ready-promise, schema infrastructure, snapshot serializer, `getState`. No commands yet beyond inspection. End state: agent can read everything, change nothing.
2. **Core composition** — Layer CRUD, layer props, transforms, child effects, blend modes, opacity, visibility, lock. Effect catalog (search/list/curated/getDefinition). The 80% case for "compose layers".
3. **Image export** — `exportImage`, `getThumbnail`, `getLayerThumbnail`, `getCanvasImageBytes`, `pasteImageFromBytes`. End of phase: agent can produce a PNG/JPG output from a composed scene.
4. **Selections + masks** — full selection suite, mask CRUD, mask modify ops, crop-to-selection. Drawing strokes (`paintStroke`, `drawShape`, `fillRegion`).
5. **Project & settings** — project CRUD, undo/redo, settings, foreground color, view controls, image/canvas resize, auto-adjust commands.
6. **Long-running ops + video export** — job model, `exportVideo`, `installFontBundle`, font listing.
7. **`layers-mcp` sidecar** — repo init, vendor script, localhost server, Playwright session, downloads, bridge, MCP tool registration. Initially against phase 1–2 of the agent API; expanded as agent API phases land.
8. **Agent-driven evals** — runner, fixtures, initial 8–12 task suite.

Phases 1–6 happen in `layers/`. Phases 7–8 happen in `layers-mcp/`. There is no hard ordering between (1–6) and (7); the sidecar can begin once the foundation phase ships.

---

## Open questions / future work

- **Streaming progress to MCP clients.** MCP progress notifications are useful for video export but only some clients render them. Treat as nice-to-have; functional behavior must work without them.
- **Shared-session transport.** A future "agent drives my live tab" mode (WebSocket relay or DevTools attach) is enabled by the `LayersAgent` API but not in this design.
- **Per-namespace tool grouping.** If MCP clients ever support tool namespaces, group as `layers.layers.add`, `layers.export.image`, etc. For now: flat names.
- **Browser-context recipes.** A future companion repo of "saved agent recipes" (stored projects + replayable command sequences) for benchmarking and demos.
- **Video frame seeking determinism.** The existing UI warns that exported video frames may vary slightly from live preview. Eval predicates that compare exact pixel values are unreliable; predicates use structural assertions (file validity, duration, dimensions, color variance) instead.
