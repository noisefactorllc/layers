// Port of polymorphic's tests/seanceLocal.js harness, adapted for Layers:
// routes the SDK URL to the sibling seance checkout's *built* dist bundle
// (../seance/dist/index.js) rather than the unbundled sdk/ source, per the
// Layers dialect design doc §6 ("route ... to the local ../seance/dist
// build").
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

export const SEANCE_SDK_URL = 'https://seance.noisefactor.io/sdk/0/index.js'

export function resolveSeanceHarnessPaths({ env = process.env, cwd = process.cwd() } = {}) {
    const distDir = env.SEANCE_DIST_DIR ? resolve(env.SEANCE_DIST_DIR) : null
    const root = resolve(env.SEANCE_ROOT || (distDir ? dirname(distDir) : resolve(cwd, '../seance')))
    return {
        root,
        distDir: distDir || resolve(root, 'dist'),
        python: resolve(env.SEANCE_PYTHON || resolve(root, '.venv/bin/python')),
        app: resolve(root, 'bin/app.py'),
    }
}

const harnessPaths = resolveSeanceHarnessPaths()

export function hasLocalSeanceHarness(paths = harnessPaths, exists = existsSync) {
    return exists(resolve(paths.distDir, 'index.js')) &&
        exists(paths.python) &&
        exists(paths.app)
}

export async function routeSeanceSdkLocal(page) {
    await page.route('https://seance.noisefactor.io/sdk/0/**', async (route) => {
        const rel = new URL(route.request().url()).pathname.replace(/^\/sdk\/0\//, '')
        const file = resolve(harnessPaths.distDir, rel)
        if (!file.startsWith(harnessPaths.distDir) || !existsSync(file)) {
            await route.fulfill({ status: 404, body: `missing ${rel}` })
            return
        }
        const body = readFileSync(file)
        await route.fulfill({
            status: 200,
            contentType: rel.endsWith('.js') ? 'text/javascript' : 'application/octet-stream',
            headers: { 'Access-Control-Allow-Origin': '*' },
            body,
        })
    })
}

export async function startSeanceServer({ origin = 'http://localhost:3002' } = {}) {
    if (!hasLocalSeanceHarness()) {
        throw new Error(
            'Layers collaboration tests require a local Seance harness; ' +
            'set SEANCE_ROOT, or set SEANCE_DIST_DIR to a Seance checkout dist dir and SEANCE_PYTHON.'
        )
    }
    const port = await getFreePort()
    const tmp = mkdtempSync(join(tmpdir(), 'layers-seance-'))
    const key = randomBytes(32).toString('base64').replace(/\+/g, '-').replace(/\//g, '_')
    let logs = ''

    const proc = spawn(harnessPaths.python, [harnessPaths.app], {
        cwd: harnessPaths.root,
        env: {
            ...process.env,
            PYTHONPATH: harnessPaths.root,
            SEANCE_BIND: `127.0.0.1:${port}`,
            SEANCE_SECRET: key,
            SEANCE_DB: join(tmp, 'seance.db'),
            SEANCE_ALLOWED_ORIGINS: origin,
            SEANCE_TRUSTED_PROXIES: '',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
    })
    proc.stdout.on('data', (chunk) => { logs += chunk.toString() })
    proc.stderr.on('data', (chunk) => { logs += chunk.toString() })

    const url = `http://127.0.0.1:${port}`
    try {
        await waitForHealthy(url, () => proc.exitCode, () => logs)
    } catch (error) {
        proc.kill('SIGTERM')
        rmSync(tmp, { recursive: true, force: true })
        throw error
    }

    return {
        url,
        stop: async () => {
            if (proc.exitCode == null) {
                proc.kill('SIGTERM')
                await new Promise((resolve) => {
                    const timer = setTimeout(resolve, 1500)
                    proc.once('exit', () => {
                        clearTimeout(timer)
                        resolve()
                    })
                })
            }
            rmSync(tmp, { recursive: true, force: true })
        },
        logs: () => logs,
    }
}

async function waitForHealthy(url, exitCode, logs) {
    const deadline = Date.now() + 15000
    while (Date.now() < deadline) {
        if (exitCode() != null) {
            throw new Error(`Seance exited before startup:\n${logs()}`)
        }
        try {
            const response = await fetch(`${url}/up`)
            if (response.ok) return
        } catch {
            // keep polling
        }
        await new Promise((resolve) => setTimeout(resolve, 150))
    }
    throw new Error(`Timed out waiting for Seance:\n${logs()}`)
}

function getFreePort() {
    return new Promise((resolve, reject) => {
        const server = net.createServer()
        server.unref()
        server.on('error', reject)
        server.listen(0, '127.0.0.1', () => {
            const address = server.address()
            server.close(() => resolve(address.port))
        })
    })
}
