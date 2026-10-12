import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { COMMAND_GROUPS } from '../public/js/agent/descriptions.js'
import { SCHEMAS } from '../public/js/agent/schemas.js'
import { LLMS_PATH, LLMS_FULL_PATH, renderLlmsFull } from './build-llms-full.mjs'

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

test('public/llms-full.txt matches a fresh render (run npm run build:llms)', async () => {
    assert.equal(await readFile(LLMS_FULL_PATH, 'utf8'), await renderLlmsFull())
})

test('llms.txt lists every error code that the agent API returns', async () => {
    const codes = new Set()
    for (const name of await readdir(AGENT_DIR)) {
        if (!name.endsWith('.js')) continue
        const source = await readFile(new URL(name, AGENT_DIR), 'utf8')
        for (const match of source.matchAll(/(?:commandError|fail)\(\s*'([A-Z_]+)'|\.code = '([A-Z_]+)'/g)) {
            codes.add(match[1] || match[2])
        }
    }
    assert.ok(codes.size > 10, `expected the agent API to define error codes, found ${codes.size}`)
    const llms = await readFile(LLMS_PATH, 'utf8')
    assert.deepEqual([...codes].filter(code => !llms.includes(`| \`${code}\` |`)).sort(), [])
})
