# Phase 7: layers-mcp Sidecar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A new sibling repo at `~/platform/layers-mcp/` — an MCP server that brokers between an MCP client (Claude Code, etc.) and the in-page `window.LayersAgent` API. The server launches headless Chromium pointed at `https://layers.noisefactor.io` (configurable), exposes every LayersAgent command as an MCP tool, and writes export downloads to a configurable output directory.

**Architecture:**
- Mirror `shade-mcp/` layout: TS + tsup + vitest, `@modelcontextprotocol/sdk` over stdio.
- One persistent Playwright Chromium session per MCP-server lifetime. Browser profile dir is configurable so localStorage/IndexedDB (saved projects, installed fonts, preferences) persist across MCP sessions.
- Tool registration is **schema-driven**: at MCP-server startup the harness loads the page, awaits `LayersAgent.ready`, then evaluates `import('/js/agent/schemas.js')` to fetch the SCHEMAS map and enumerates `LayersAgent` keys. One MCP tool registered per command, using the layers schema as the MCP tool's `inputSchema`.
- Tool handlers do `page.evaluate((n,a) => window.LayersAgent[n](a), name, args)` and return the full LayersAgent envelope as a JSON text content block. The envelope already contains `result` + `state` snapshot, so MCP clients get full state on every response (matches the original design choice).
- Export tools (`exportImage`, `exportVideo`) wire a Playwright `download` event handler that saves the blob to `LAYERS_MCP_OUTPUT_DIR` and attaches `{filePath}` to the returned envelope.

**Tech Stack:** Node 18+, TypeScript 5, tsup, vitest, `@modelcontextprotocol/sdk`, playwright. No bundler in the layers app itself; layers-mcp is its own TS project.

**Testing model (decision: 2026-05-10):** The Layers Phase 1-6 work is currently local-only (not pushed; prod `layers.noisefactor.io` does NOT yet have the agent code). Until that push happens, **all Phase 7 tests run against a local Layers dev server**. The runtime default for `LAYERS_URL` remains prod (forward-compatible); tests require the caller to set `LAYERS_URL=http://localhost:PORT` and start the layers dev server first. A `tests/setup.ts` helper asserts reachability and bails fast if the server isn't up.

**Config (env vars):**
- `LAYERS_URL` — default `https://layers.noisefactor.io`
- `LAYERS_MCP_OUTPUT_DIR` — default `$PWD/layers-mcp-exports`
- `LAYERS_MCP_PROFILE_DIR` — default `~/.cache/layers-mcp/profile` (Chromium user-data-dir for state persistence)
- `LAYERS_MCP_HEADFUL` — default `false`; set `true` to see the browser
- `LAYERS_MCP_LOG_LEVEL` — default `info`; `debug`/`warn`/`error`

---

## Task 1: Repo scaffold

**Files:**
- Create: `/Users/aayars/platform/layers-mcp/` (whole directory)
- Create: `/Users/aayars/platform/layers-mcp/package.json`
- Create: `/Users/aayars/platform/layers-mcp/tsconfig.json`
- Create: `/Users/aayars/platform/layers-mcp/tsup.config.ts`
- Create: `/Users/aayars/platform/layers-mcp/.gitignore`
- Create: `/Users/aayars/platform/layers-mcp/README.md`
- Create: `/Users/aayars/platform/layers-mcp/src/index.ts` (stub, no commands wired yet)
- Create: `/Users/aayars/platform/layers-mcp/src/config.ts`

- [ ] **Step 1: Create the directory and initialize git**

```bash
mkdir -p /Users/aayars/platform/layers-mcp/src
cd /Users/aayars/platform/layers-mcp
git init -b main
```

- [ ] **Step 2: Create `package.json`**

```json
{
  "name": "layers-mcp",
  "version": "0.1.0",
  "description": "MCP server for the Layers image/video editor (Noise Factor)",
  "type": "module",
  "license": "MIT",
  "main": "dist/index.js",
  "bin": { "layers-mcp": "dist/index.js" },
  "scripts": {
    "prepare": "npm run build",
    "build": "tsup",
    "postbuild": "node -e \"import{readFileSync as r,writeFileSync as w}from'fs';const f='dist/index.js';w(f,'#!/usr/bin/env node\\n'+r(f,'utf8'))\"",
    "dev": "tsup --watch",
    "start": "node dist/index.js",
    "setup": "playwright install chromium",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "engines": { "node": ">=18.0.0" },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.26.0",
    "playwright": "^1.57.0"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "tsup": "^8.0.0",
    "typescript": "^5.7.0",
    "vitest": "^3.0.0"
  }
}
```

(No `@anthropic-ai/sdk`/`openai` deps — layers-mcp is a passthrough, no AI provider needed in v1.)

- [ ] **Step 3: Create `tsconfig.json`** (mirror shade-mcp's settings — read its tsconfig and copy verbatim, adjusting `outDir`/`rootDir` to be relative to this repo).

```bash
cat /Users/aayars/platform/shade-mcp/tsconfig.json
```

Then write the same content to `/Users/aayars/platform/layers-mcp/tsconfig.json`.

- [ ] **Step 4: Create `tsup.config.ts`** (mirror shade-mcp's).

```bash
cat /Users/aayars/platform/shade-mcp/tsup.config.ts
```

Write the same content. Adjust the `entry` array to just `['src/index.ts']` (no extra sub-modules in v1).

- [ ] **Step 5: Create `.gitignore`**

```
node_modules/
dist/
*.log
.DS_Store
.vscode/
.idea/
```

- [ ] **Step 6: Create `src/config.ts`**

```typescript
import { homedir } from 'os'
import { join } from 'path'

export interface Config {
  layersUrl: string
  outputDir: string
  profileDir: string
  headful: boolean
  logLevel: 'debug' | 'info' | 'warn' | 'error'
}

export function loadConfig(): Config {
  const layersUrl = process.env.LAYERS_URL || 'https://layers.noisefactor.io'
  const outputDir = process.env.LAYERS_MCP_OUTPUT_DIR ||
    join(process.cwd(), 'layers-mcp-exports')
  const profileDir = process.env.LAYERS_MCP_PROFILE_DIR ||
    join(homedir(), '.cache', 'layers-mcp', 'profile')
  const headful = process.env.LAYERS_MCP_HEADFUL === 'true'
  const level = (process.env.LAYERS_MCP_LOG_LEVEL || 'info') as Config['logLevel']
  if (!['debug', 'info', 'warn', 'error'].includes(level)) {
    throw new Error(`LAYERS_MCP_LOG_LEVEL must be debug|info|warn|error, got: ${level}`)
  }
  return { layersUrl, outputDir, profileDir, headful, logLevel: level }
}
```

- [ ] **Step 7: Create `src/index.ts` stub**

```typescript
/**
 * layers-mcp — MCP server fronting window.LayersAgent in a headless browser.
 * See README.md for architecture.
 *
 * Note: the shebang line is prepended by the `postbuild` script in package.json,
 * not committed to source. Do not add `#!/usr/bin/env node` here.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { loadConfig } from './config.js'

async function main() {
  const config = loadConfig()
  const server = new Server(
    { name: 'layers-mcp', version: '0.1.0' },
    { capabilities: { tools: {} } }
  )
  // T2 will attach the harness here.
  // T6 will register tools here.

  const transport = new StdioServerTransport()
  await server.connect(transport)

  // Log to stderr so it doesn't corrupt the MCP stdio protocol.
  console.error(`[layers-mcp] connected; targeting ${config.layersUrl}`)
}

main().catch((err) => {
  console.error('[layers-mcp] fatal:', err)
  process.exit(1)
})
```

- [ ] **Step 8: Create a stub `README.md`**

Just enough to anchor the repo. Don't write extensive docs — T8 expands it.

```markdown
# layers-mcp

MCP server for the [Layers](https://layers.noisefactor.io) image/video editor.

Brokers between MCP clients (Claude Code, Cursor, etc.) and the in-page
`window.LayersAgent` API. Launches headless Chromium, drives Layers as a
human would, exposes every LayersAgent command as an MCP tool.

Detailed documentation in Task 8.
```

- [ ] **Step 9: Install dependencies and verify build**

```bash
cd /Users/aayars/platform/layers-mcp
npm install
npm run setup       # downloads Playwright Chromium
npm run build
```

Expected: `dist/index.js` produced, shebanged, with no TS errors.

- [ ] **Step 10: Smoke test the stub**

```bash
node dist/index.js &
sleep 2
kill %1
```

Expected: `[layers-mcp] connected; targeting https://layers.noisefactor.io` on stderr, then graceful exit when killed.

- [ ] **Step 11: Initial commit**

```bash
git add -A
git commit -m "feat(layers-mcp): repo scaffold + stub MCP server"
```

---

## Task 2: Browser harness

**Files:**
- Create: `/Users/aayars/platform/layers-mcp/src/harness/browser-session.ts`
- Create: `/Users/aayars/platform/layers-mcp/tests/browser-session.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/browser-session.test.ts
import { describe, it, expect, afterAll } from 'vitest'
import { BrowserSession } from '../src/harness/browser-session.js'
import { loadConfig } from '../src/config.js'

const session = new BrowserSession(loadConfig())

afterAll(async () => { await session.shutdown() })

describe('BrowserSession (real Playwright, real prod)', () => {
  it('launches, navigates, and awaits LayersAgent.ready', async () => {
    await session.start()
    const version = await session.evaluate<string>(() =>
      (window as any).LayersAgent.version
    )
    expect(typeof version).toBe('string')
    expect(version.length).toBeGreaterThan(0)
  }, 60_000)

  it('exposes a list of registered LayersAgent commands', async () => {
    const commands = await session.evaluate<string[]>(() =>
      Object.keys((window as any).LayersAgent).filter(k =>
        typeof (window as any).LayersAgent[k] === 'function'
      )
    )
    expect(commands.length).toBeGreaterThan(50)
    expect(commands).toContain('getState')
    expect(commands).toContain('exportImage')
  }, 60_000)
})
```

- [ ] **Step 2: Run the test to confirm RED**

```bash
cd /Users/aayars/platform/layers-mcp
npx vitest run tests/browser-session.test.ts
```

Expected: FAIL — `BrowserSession` not yet exported.

- [ ] **Step 3: Implement `src/harness/browser-session.ts`**

```typescript
import { chromium, type BrowserContext, type Page } from 'playwright'
import { mkdir } from 'fs/promises'
import { dirname } from 'path'
import type { Config } from '../config.js'

export class BrowserSession {
  private context: BrowserContext | null = null
  private page: Page | null = null

  constructor(private readonly config: Config) {}

  async start(): Promise<void> {
    if (this.page) return
    await mkdir(dirname(this.config.profileDir), { recursive: true })
    await mkdir(this.config.profileDir, { recursive: true })

    this.context = await chromium.launchPersistentContext(this.config.profileDir, {
      headless: !this.config.headful,
      acceptDownloads: true,
      viewport: { width: 1280, height: 800 }
    })
    this.page = this.context.pages()[0] || await this.context.newPage()
    await this.page.goto(this.config.layersUrl, { waitUntil: 'domcontentloaded' })
    await this.page.waitForFunction(
      () => (window as any).LayersAgent?.ready,
      { timeout: 30_000 }
    )
    await this.page.evaluate(() => (window as any).LayersAgent.ready)
  }

  async evaluate<T>(fn: (...args: any[]) => T | Promise<T>, ...args: any[]): Promise<T> {
    if (!this.page) throw new Error('BrowserSession.start() not called')
    return this.page.evaluate(fn as any, ...args)
  }

  /** Internal: used by tool handlers to invoke an arbitrary LayersAgent command. */
  async runCommand(name: string, args: unknown): Promise<unknown> {
    return this.evaluate(
      ({ n, a }) => (window as any).LayersAgent[n](a),
      { n: name, a: args }
    )
  }

  getPage(): Page {
    if (!this.page) throw new Error('BrowserSession.start() not called')
    return this.page
  }

  async shutdown(): Promise<void> {
    if (this.context) {
      await this.context.close()
      this.context = null
      this.page = null
    }
  }
}
```

- [ ] **Step 4: Run the tests; expect GREEN**

```bash
npx vitest run tests/browser-session.test.ts
```

Expected: 2/2 PASS. (Network access required — this hits prod.)

- [ ] **Step 5: Commit**

```bash
git add src/harness/browser-session.ts tests/browser-session.test.ts
git commit -m "feat(layers-mcp): browser harness (Playwright persistent context)"
```

---

## Task 3: Schema-driven tool registry

**Files:**
- Create: `/Users/aayars/platform/layers-mcp/src/tools/registry.ts`
- Create: `/Users/aayars/platform/layers-mcp/src/tools/index.ts`
- Create: `/Users/aayars/platform/layers-mcp/tests/registry.test.ts`

The registry fetches the live `SCHEMAS` map + command list from the page and produces an array of MCP tool definitions (name, description, inputSchema, handler).

- [ ] **Step 1: Write the failing test**

```typescript
// tests/registry.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { BrowserSession } from '../src/harness/browser-session.js'
import { buildToolRegistry } from '../src/tools/registry.js'
import { loadConfig } from '../src/config.js'

const session = new BrowserSession(loadConfig())

beforeAll(async () => { await session.start() }, 60_000)
afterAll(async () => { await session.shutdown() })

describe('buildToolRegistry', () => {
  it('produces one tool per LayersAgent command', async () => {
    const tools = await buildToolRegistry(session)
    const names = tools.map(t => t.name)
    expect(names).toContain('getState')
    expect(names).toContain('addLayer')
    expect(names).toContain('exportImage')
    expect(names).toContain('exportVideo')
    expect(tools.length).toBeGreaterThan(50)
  }, 60_000)

  it('every tool has an inputSchema object', async () => {
    const tools = await buildToolRegistry(session)
    for (const t of tools) {
      expect(t.inputSchema).toBeDefined()
      expect(t.inputSchema.type).toBe('object')
    }
  }, 60_000)

  it('handler invokes the LayersAgent command and returns its envelope', async () => {
    const tools = await buildToolRegistry(session)
    const getStateTool = tools.find(t => t.name === 'getState')!
    const resp = await getStateTool.handler({})
    expect(resp.ok).toBe(true)
    expect(resp.command).toBe('getState')
    expect(resp.state).toBeDefined()
  }, 60_000)
})
```

- [ ] **Step 2: Confirm RED**

```bash
npx vitest run tests/registry.test.ts
```

- [ ] **Step 3: Implement `src/tools/registry.ts`**

```typescript
import type { BrowserSession } from '../harness/browser-session.js'

export interface ToolDef {
  name: string
  description: string
  inputSchema: { type: 'object'; properties?: Record<string, unknown>; required?: string[]; additionalProperties?: boolean }
  handler: (args: unknown) => Promise<unknown>
}

/**
 * Pull the live schema map and command names from the loaded Layers page,
 * then synthesize one MCP tool definition per command.
 *
 * Skips test/diagnostic commands prefixed with `_` (they're internal).
 */
export async function buildToolRegistry(session: BrowserSession): Promise<ToolDef[]> {
  const { commandNames, schemas } = await session.evaluate(async () => {
    const agent = (window as any).LayersAgent
    const m = await import('/js/agent/schemas.js')
    const commandNames = Object.keys(agent).filter(k =>
      typeof agent[k] === 'function' && !k.startsWith('_')
    )
    return { commandNames, schemas: m.SCHEMAS || {} }
  }) as { commandNames: string[]; schemas: Record<string, any> }

  const tools: ToolDef[] = []
  for (const name of commandNames) {
    const raw = schemas[name]
    const inputSchema = normalizeSchema(raw)
    tools.push({
      name,
      description: `LayersAgent.${name} — see https://layers.noisefactor.io for command reference.`,
      inputSchema,
      handler: async (args: unknown) => session.runCommand(name, args ?? {})
    })
  }
  return tools
}

function normalizeSchema(raw: unknown): ToolDef['inputSchema'] {
  if (!raw || typeof raw !== 'object') {
    return { type: 'object', properties: {}, additionalProperties: false }
  }
  const s = raw as any
  if (s.type === 'object') {
    return {
      type: 'object',
      properties: s.properties || {},
      required: Array.isArray(s.required) ? s.required : undefined,
      additionalProperties: typeof s.additionalProperties === 'boolean'
        ? s.additionalProperties
        : false
    }
  }
  return { type: 'object', properties: {}, additionalProperties: false }
}
```

- [ ] **Step 4: Create `src/tools/index.ts` (barrel)**

```typescript
export { buildToolRegistry, type ToolDef } from './registry.js'
```

- [ ] **Step 5: Run tests; expect GREEN**

```bash
npx vitest run tests/registry.test.ts
```

Expected: 3/3 PASS.

- [ ] **Step 6: Commit**

```bash
git add src/tools/ tests/registry.test.ts
git commit -m "feat(layers-mcp): schema-driven tool registry"
```

---

## Task 4: Wire registry into the MCP server

**Files:**
- Modify: `/Users/aayars/platform/layers-mcp/src/index.ts`
- Create: `/Users/aayars/platform/layers-mcp/tests/index.test.ts`

- [ ] **Step 1: Write a failing integration test**

```typescript
// tests/index.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawn, ChildProcess } from 'child_process'
import { join } from 'path'

let child: ChildProcess

const ROOT = join(import.meta.dirname || __dirname, '..')

beforeAll(async () => {
  // Build first
  const { execSync } = await import('child_process')
  execSync('npm run build', { cwd: ROOT, stdio: 'inherit' })
}, 60_000)

afterAll(() => {
  if (child && !child.killed) child.kill('SIGKILL')
})

describe('MCP server end-to-end (stdio JSON-RPC)', () => {
  it('responds to tools/list with a non-empty tool array', async () => {
    child = spawn('node', [join(ROOT, 'dist/index.js')], {
      cwd: ROOT,
      stdio: ['pipe', 'pipe', 'pipe']
    })

    const responsePromise = new Promise<any>((resolve, reject) => {
      let buf = ''
      child.stdout!.on('data', (chunk) => {
        buf += chunk.toString()
        const lines = buf.split('\n')
        buf = lines.pop() || ''
        for (const line of lines) {
          if (!line.trim()) continue
          try {
            const msg = JSON.parse(line)
            if (msg.id === 1) return resolve(msg)
          } catch { /* not JSON yet */ }
        }
      })
      child.on('error', reject)
      setTimeout(() => reject(new Error('timeout')), 90_000)
    })

    // Wait for the harness to become ready by polling stderr
    await new Promise<void>((resolve, reject) => {
      let stderrBuf = ''
      child.stderr!.on('data', (chunk) => {
        stderrBuf += chunk.toString()
        if (stderrBuf.includes('connected; targeting')) resolve()
      })
      setTimeout(() => reject(new Error('harness boot timeout')), 60_000)
    })

    const req = JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'tools/list', params: {}
    }) + '\n'
    child.stdin!.write(req)

    const resp = await responsePromise
    expect(resp.result.tools.length).toBeGreaterThan(50)
    const names = resp.result.tools.map((t: any) => t.name)
    expect(names).toContain('getState')
  }, 180_000)
})
```

- [ ] **Step 2: Run and confirm RED** (tools aren't wired yet)

```bash
npx vitest run tests/index.test.ts
```

- [ ] **Step 3: Update `src/index.ts`**

```typescript
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema
} from '@modelcontextprotocol/sdk/types.js'
import { loadConfig } from './config.js'
import { BrowserSession } from './harness/browser-session.js'
import { buildToolRegistry, type ToolDef } from './tools/index.js'

async function main() {
  const config = loadConfig()
  const session = new BrowserSession(config)

  console.error(`[layers-mcp] starting browser harness…`)
  await session.start()
  console.error(`[layers-mcp] harness ready`)

  const tools = await buildToolRegistry(session)
  const toolByName = new Map<string, ToolDef>(tools.map(t => [t.name, t]))
  console.error(`[layers-mcp] registered ${tools.length} tools`)

  const server = new Server(
    { name: 'layers-mcp', version: '0.1.0' },
    { capabilities: { tools: {} } }
  )

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map(t => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema
    }))
  }))

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params
    const tool = toolByName.get(name)
    if (!tool) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ ok: false, error: { code: 'UNKNOWN_TOOL', message: `Unknown tool: ${name}` } }) }],
        isError: true
      }
    }
    try {
      const result = await tool.handler(args ?? {})
      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
        isError: !(result as any)?.ok
      }
    } catch (err: any) {
      return {
        content: [{ type: 'text', text: JSON.stringify({
          ok: false,
          error: { code: 'HANDLER_THREW', message: err?.message || String(err) }
        })}],
        isError: true
      }
    }
  })

  const transport = new StdioServerTransport()

  // Clean shutdown
  const shutdown = async () => {
    try { await session.shutdown() } catch {}
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  await server.connect(transport)
  console.error(`[layers-mcp] connected; targeting ${config.layersUrl}`)
}

main().catch((err) => {
  console.error('[layers-mcp] fatal:', err)
  process.exit(1)
})
```

- [ ] **Step 4: Build + run tests; expect GREEN**

```bash
npm run build && npx vitest run tests/index.test.ts
```

Expected: 1/1 PASS.

- [ ] **Step 5: Commit**

```bash
git add src/index.ts tests/index.test.ts
git commit -m "feat(layers-mcp): wire harness + tool registry into MCP server"
```

---

## Task 5: Download interception for exports

**Files:**
- Modify: `/Users/aayars/platform/layers-mcp/src/harness/browser-session.ts`
- Create: `/Users/aayars/platform/layers-mcp/src/tools/exports.ts`
- Modify: `/Users/aayars/platform/layers-mcp/src/tools/registry.ts`
- Modify: `/Users/aayars/platform/layers-mcp/src/index.ts` (only for wiring `config.outputDir`)
- Create: `/Users/aayars/platform/layers-mcp/tests/exports.test.ts`

`exportImage` and `exportVideo` trigger browser downloads. Playwright's `page.on('download')` fires for each one. We capture them, save to `LAYERS_MCP_OUTPUT_DIR`, then enrich the LayersAgent envelope with `result.filePath`.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/exports.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { existsSync, statSync, mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { BrowserSession } from '../src/harness/browser-session.js'
import { buildToolRegistry } from '../src/tools/registry.js'
import { loadConfig } from '../src/config.js'

const outDir = mkdtempSync(join(tmpdir(), 'layers-mcp-test-'))
const config = { ...loadConfig(), outputDir: outDir }
const session = new BrowserSession(config)

beforeAll(async () => { await session.start() }, 60_000)
afterAll(async () => { await session.shutdown() })

describe('export-tool download interception', () => {
  it('exportImage writes a PNG to outputDir and returns filePath', async () => {
    const tools = await buildToolRegistry(session, { outputDir: config.outputDir })
    const tool = tools.find(t => t.name === 'exportImage')!
    const resp = await tool.handler({ format: 'png' }) as any
    expect(resp.ok).toBe(true)
    expect(typeof resp.result.filePath).toBe('string')
    expect(existsSync(resp.result.filePath)).toBe(true)
    expect(statSync(resp.result.filePath).size).toBeGreaterThan(100)
    expect(resp.result.filePath.startsWith(outDir)).toBe(true)
  }, 60_000)
})
```

- [ ] **Step 2: Confirm RED** (registry's `buildToolRegistry` doesn't take an options arg yet, and downloads aren't intercepted).

- [ ] **Step 3: Update `BrowserSession`** to expose download interception

Add to `src/harness/browser-session.ts`:

```typescript
// Inside the class:

/**
 * Run an action and capture any download triggered by it. Resolves to the
 * absolute path the download was saved to. Returns null if no download fired
 * within timeoutMs.
 */
async withDownloadCapture<T>(
  outputDir: string,
  action: () => Promise<T>,
  timeoutMs = 120_000
): Promise<{ result: T; filePath: string | null }> {
  if (!this.page) throw new Error('BrowserSession.start() not called')
  await mkdir(outputDir, { recursive: true })

  let resolveDownload!: (p: string) => void
  let rejectDownload!: (e: any) => void
  const downloadPromise = new Promise<string>((res, rej) => {
    resolveDownload = res
    rejectDownload = rej
  })

  const onDownload = async (download: any) => {
    try {
      const suggested = download.suggestedFilename()
      const dest = join(outputDir, suggested)
      await download.saveAs(dest)
      resolveDownload(dest)
    } catch (e) {
      rejectDownload(e)
    }
  }
  this.page.once('download', onDownload)

  const timer = setTimeout(() => resolveDownload(''), timeoutMs)

  let result: T
  try {
    result = await action()
  } finally {
    clearTimeout(timer)
  }

  const filePath = await downloadPromise
  return { result, filePath: filePath || null }
}
```

(Add `import { mkdir } from 'fs/promises'` and `import { join } from 'path'` at top if not present.)

- [ ] **Step 4: Implement `src/tools/exports.ts`** (the export tool wrappers)

```typescript
import type { BrowserSession } from '../harness/browser-session.js'
import type { ToolDef } from './registry.js'

/**
 * Wrap an existing pass-through tool so its handler also captures any download
 * triggered by the underlying LayersAgent command. The returned ToolDef has
 * the same name, description, and inputSchema as the original; only the
 * handler is replaced.
 */
export function wrapDownloadingTool(
  base: ToolDef,
  session: BrowserSession,
  outputDir: string
): ToolDef {
  return {
    ...base,
    handler: async (args: unknown) => {
      const { result, filePath } = await session.withDownloadCapture(
        outputDir,
        async () => base.handler(args)
      )
      // Splice the local path into the LayersAgent envelope.
      const env = result as any
      if (env && typeof env === 'object' && env.result && filePath) {
        env.result.filePath = filePath
      }
      return env
    }
  }
}

export const DOWNLOADING_COMMANDS = new Set(['exportImage', 'exportVideo'])
```

- [ ] **Step 5: Update `buildToolRegistry`** to take options + auto-wrap

```typescript
// In registry.ts, update the signature and body:

import { wrapDownloadingTool, DOWNLOADING_COMMANDS } from './exports.js'

export interface RegistryOptions { outputDir: string }

export async function buildToolRegistry(
  session: BrowserSession,
  opts?: Partial<RegistryOptions>
): Promise<ToolDef[]> {
  const { commandNames, schemas } = await session.evaluate(async () => {
    // (same as before)
  }) as { commandNames: string[]; schemas: Record<string, any> }

  const tools: ToolDef[] = []
  for (const name of commandNames) {
    const raw = schemas[name]
    const inputSchema = normalizeSchema(raw)
    const baseTool: ToolDef = {
      name,
      description: `LayersAgent.${name} — see https://layers.noisefactor.io for command reference.`,
      inputSchema,
      handler: async (args: unknown) => session.runCommand(name, args ?? {})
    }
    const finalTool = DOWNLOADING_COMMANDS.has(name) && opts?.outputDir
      ? wrapDownloadingTool(baseTool, session, opts.outputDir)
      : baseTool
    tools.push(finalTool)
  }
  return tools
}
```

(The earlier `tests/registry.test.ts` continues to pass — `opts` is optional, and when omitted, exportImage/exportVideo behave unchanged.)

- [ ] **Step 6: Update `src/index.ts`** to pass `outputDir`

```typescript
// Replace:
//   const tools = await buildToolRegistry(session)
// with:
const tools = await buildToolRegistry(session, { outputDir: config.outputDir })
```

- [ ] **Step 7: Run tests; expect GREEN**

```bash
npx vitest run tests/exports.test.ts tests/registry.test.ts
```

Expected: 4/4 PASS (1 new + 3 existing).

- [ ] **Step 8: Commit**

```bash
git add src/harness/browser-session.ts src/tools/exports.ts src/tools/registry.ts src/index.ts tests/exports.test.ts
git commit -m "feat(layers-mcp): intercept export downloads and surface filePath"
```

---

## Task 6: Long-running job awaitable wrapper

**Files:**
- Modify: `/Users/aayars/platform/layers-mcp/src/tools/exports.ts` (extend the same export wrapper)
- Create: `/Users/aayars/platform/layers-mcp/tests/jobs-integration.test.ts`

Phase 6 made `exportVideo` job-modeled — the LayersAgent command returns `{jobId}` immediately and the actual export runs in the background. The browser download fires only when the job finishes. The existing `withDownloadCapture` waits for the download to fire (timeout 120s), which works as long as the export finishes inside that window. But the MCP envelope returned to the caller is `{ok:true, result:{jobId:...}}` from the FIRST command call — it doesn't include the job's actual result.

This task makes the `exportVideo` MCP tool a **synchronous wait** from the caller's perspective: the handler kicks off the job, awaits both the job's settle (via `waitForJob`) and the download, and returns the final job result (plus filePath).

- [ ] **Step 1: Write the failing test**

```typescript
// tests/jobs-integration.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { existsSync, mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { BrowserSession } from '../src/harness/browser-session.js'
import { buildToolRegistry } from '../src/tools/registry.js'
import { loadConfig } from '../src/config.js'

const outDir = mkdtempSync(join(tmpdir(), 'layers-mcp-jobs-'))
const config = { ...loadConfig(), outputDir: outDir }
const session = new BrowserSession(config)

beforeAll(async () => { await session.start() }, 60_000)
afterAll(async () => { await session.shutdown() })

describe('exportVideo as a synchronous MCP tool', () => {
  it('returns the final job result + filePath when video finishes', async () => {
    const tools = await buildToolRegistry(session, { outputDir: config.outputDir })
    const tool = tools.find(t => t.name === 'exportVideo')!
    const resp = await tool.handler({
      width: 64, height: 64, framerate: 30, duration: 0.1,
      format: 'zip', quality: 'low'
    }) as any
    expect(resp.ok).toBe(true)
    expect(resp.result.status).toBe('succeeded')
    expect(typeof resp.result.filePath).toBe('string')
    expect(existsSync(resp.result.filePath)).toBe(true)
  }, 120_000)
})
```

- [ ] **Step 2: Update `src/tools/exports.ts`** to await jobs

```typescript
// Add a new wrapper that's used specifically for exportVideo (job-modeled):

const JOB_COMMANDS = new Set(['exportVideo'])

export function wrapJobTool(
  base: ToolDef,
  session: BrowserSession,
  outputDir: string
): ToolDef {
  return {
    ...base,
    handler: async (args: unknown) => {
      // Start the job, then wait for both download + job settle.
      const { result: kickoff, filePath } = await session.withDownloadCapture(
        outputDir,
        async () => base.handler(args),
        120_000
      )
      const env = kickoff as any
      if (!env?.ok || !env?.result?.jobId) return env  // pass through errors
      const jobId = env.result.jobId

      const finalEnv = await session.runCommand('waitForJob', {
        jobId, timeoutMs: 120_000
      }) as any
      if (!finalEnv?.ok) return finalEnv
      const job = finalEnv.result
      if (filePath && job?.result) job.result.filePath = filePath
      return finalEnv
    }
  }
}

// Update DOWNLOADING_COMMANDS to NOT include exportVideo (it has its own wrapper):
export const DOWNLOADING_COMMANDS = new Set(['exportImage'])
```

And in `registry.ts`:

```typescript
import { wrapDownloadingTool, DOWNLOADING_COMMANDS, wrapJobTool } from './exports.js'

// in the loop:
let finalTool = baseTool
if (opts?.outputDir) {
  if (DOWNLOADING_COMMANDS.has(name)) finalTool = wrapDownloadingTool(baseTool, session, opts.outputDir)
  else if (name === 'exportVideo') finalTool = wrapJobTool(baseTool, session, opts.outputDir)
}
tools.push(finalTool)
```

- [ ] **Step 3: Run; expect GREEN**

```bash
npx vitest run tests/jobs-integration.test.ts tests/exports.test.ts tests/registry.test.ts
```

Expected: 5/5 PASS.

- [ ] **Step 4: Commit**

```bash
git add src/tools/exports.ts src/tools/registry.ts tests/jobs-integration.test.ts
git commit -m "feat(layers-mcp): exportVideo synchronously waits for job + download"
```

---

## Task 7: Full test suite + manual MCP smoke

**Files:** none (verification only)

- [ ] **Step 1: Run the full vitest suite**

```bash
cd /Users/aayars/platform/layers-mcp
npm test
```

Expected: all PASS.

- [ ] **Step 2: Build and verify the bin works**

```bash
npm run build
node dist/index.js &
PID=$!
sleep 5
# Send a tools/list JSON-RPC request via stdio and check the response includes getState
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' | nc -U /dev/null   # placeholder
# Actually use a real check:
kill $PID
```

(Manual smoke is also covered by `tests/index.test.ts` — running it again is enough.)

- [ ] **Step 3: Write an example MCP client config to `examples/claude-code.json`**

```bash
mkdir -p examples
```

```json
{
  "mcpServers": {
    "layers": {
      "command": "node",
      "args": ["/absolute/path/to/layers-mcp/dist/index.js"],
      "env": {
        "LAYERS_URL": "https://layers.noisefactor.io",
        "LAYERS_MCP_OUTPUT_DIR": "/tmp/layers-exports"
      }
    }
  }
}
```

- [ ] **Step 4: Commit**

```bash
git add examples/
git commit -m "docs(layers-mcp): example MCP client config"
```

---

## Task 8: README + final polish

**Files:**
- Modify: `/Users/aayars/platform/layers-mcp/README.md`
- Create: `/Users/aayars/platform/layers-mcp/CLAUDE.md` (project instructions for future Claude sessions)

- [ ] **Step 1: Write the full README**

Sections:
- What it does (one paragraph)
- Architecture diagram (text): MCP client → stdio → layers-mcp → Playwright → headless Chromium → layers.noisefactor.io
- Setup (npm install, npm run setup, npm run build)
- Configuration (table of env vars + defaults)
- Available tools (note that they're auto-generated from `LayersAgent`; ~67 tools; reference the layers repo for full schemas)
- Client integration (claude-code, cursor, windsurf — JSON blocks)
- Development (npm test, npm run dev)
- Known limitations:
  - Job cancellation in `exportVideo` is best-effort (matches the layers-side limitation)
  - First call to `installFontBundle` triggers a 140 MB download in the headless browser
  - Browser profile persists between MCP runs (LAYERS_MCP_PROFILE_DIR) — delete if you want a clean state

- [ ] **Step 2: Write `CLAUDE.md`**

Short. Document the architecture decisions:
- Connects to `layers.noisefactor.io` (configurable via `LAYERS_URL`) — does NOT serve the app locally
- Tool registry is built from the live page; adding a new command in layers automatically surfaces it as an MCP tool (no codegen step)
- Browser profile persists; the user's saved projects and installed fonts carry across sessions
- Mirror shade-mcp's structure when extending; same TS/tsup/vitest stack
- BANNED: anything from `~/platform/CLAUDE.md` (no untested commits, no committing private info to public repos, no temp solutions)

- [ ] **Step 3: Final commit**

```bash
git add README.md CLAUDE.md
git commit -m "docs(layers-mcp): README + project CLAUDE.md"
```

- [ ] **Step 4: Tag v0.1.0**

```bash
git tag -a v0.1.0 -m "layers-mcp v0.1.0 — initial MCP sidecar for LayersAgent"
```

(Do NOT push the tag or push to a remote. Phase 7 is local-only until human override.)

---

## Phase 7 verification gate

Before declaring Phase 7 done:

1. `npm test` in `~/platform/layers-mcp/` passes 100%.
2. `node dist/index.js` boots, registers >50 tools, responds to `tools/list` over stdio JSON-RPC.
3. A real end-to-end exercise: launch the MCP server, send a `tools/call` for `getState`, verify the response. Send a `tools/call` for `exportImage`, verify a PNG file exists in `LAYERS_MCP_OUTPUT_DIR`.
4. Manual smoke against the LAYERS-side app: `await window.LayersAgent.getState({})` in the layers DevTools still returns a valid envelope (no regression).
5. The cleanup task #23 in the Layers repo gets a Phase 7 follow-ups section.

---
