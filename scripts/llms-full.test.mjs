import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { COMMAND_GROUPS, LOCAL_ONLY } from '../public/js/agent/descriptions.js'
import { SCHEMAS } from '../public/js/agent/schemas.js'
import { LLMS_PATH, LLMS_FULL_PATH, renderLlmsFull, renderReference } from './build-llms-full.mjs'

const AGENT_DIR = new URL('../public/js/agent/', import.meta.url)

async function registeredCommands() {
    const source = await readFile(new URL('index.js', AGENT_DIR), 'utf8')
    return [...source.matchAll(/registerCommand\(LayersAgent,\s*'(\w+)'/g)]
        .map(match => match[1])
        .filter(name => !name.startsWith('_'))
}

const describedCommands = () => COMMAND_GROUPS.flatMap(group => Object.keys(group.commands))

test('every registered command has exactly one description', async () => {
    const described = describedCommands()
    assert.deepEqual(described.filter((name, i) => described.indexOf(name) !== i), [],
        'a command is described twice')
    assert.deepEqual([...described].sort(), (await registeredCommands()).sort())
})

test('every public schema belongs to a registered command', async () => {
    const registered = new Set(await registeredCommands())
    const orphans = Object.keys(SCHEMAS).filter(name => !name.startsWith('_') && !registered.has(name))
    assert.deepEqual(orphans, [])
})

test('the reference marks each command that a session cannot run', () => {
    const reference = renderReference()
    const marked = [...reference.matchAll(/^#### `(\w+)`\n\n.*\n\nNot available through a session/gm)]
        .map(match => match[1])
    assert.deepEqual(marked.sort(), [...LOCAL_ONLY].sort())
})

test('public/llms-full.txt matches a fresh render (run npm run build:llms)', async () => {
    assert.equal(await readFile(LLMS_FULL_PATH, 'utf8'), await renderLlmsFull())
})

// The agent modules, plus the job runners whose error codes reach a job's
// `error.code` through jobs.js.
const JOB_RUNNERS = ['../ui/video-exporter.js', '../utils/files.js', '../layers/fontaine-loader.js']

test('llms.txt names every error and warning code that the agent API returns', async () => {
    const files = (await readdir(AGENT_DIR)).filter(name => name.endsWith('.js')).concat(JOB_RUNNERS)
    const codes = new Set()
    for (const name of files) {
        const source = await readFile(new URL(name, AGENT_DIR), 'utf8')
        // commandError('X'), fail('X'), err.code = 'X', code: 'X', code: err?.code || 'X',
        // makeFailure(command, 'X')
        const pattern = /(?:commandError|fail)\(\s*'([A-Z][A-Z_]+)'|\bcode\s*[:=]\s*(?:[\w?.]+\s*\|\|\s*)?'([A-Z][A-Z_]+)'|makeFailure\([^,()]*,\s*'([A-Z][A-Z_]+)'/g
        for (const match of source.matchAll(pattern)) codes.add(match[1] || match[2] || match[3])
    }
    for (const code of ['JOB_FAILED', 'VIDEO_EXPORT_ENCODE_FAILED', 'UNKNOWN_SETTING_KEY', 'REMOTE_UNAVAILABLE', 'IMAGE_LIMIT']) {
        assert.ok(codes.has(code), `the code scan no longer finds ${code}`)
    }
    // Error codes are table rows. Warning codes are list items in Warnings.
    const llms = await readFile(LLMS_PATH, 'utf8')
    const listed = code => new RegExp(`^(?:\\| |- )\`${code}\``, 'm').test(llms)
    assert.deepEqual([...codes].filter(code => !listed(code)).sort(), [])
})
