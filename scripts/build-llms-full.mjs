/**
 * Writes public/llms-full.txt: the text of public/llms.txt, then a reference
 * for every LayersAgent command. The reference comes from the descriptions in
 * public/js/agent/descriptions.js and the argument schemas in
 * public/js/agent/schemas.js.
 *
 * Run `npm run build:llms` after you change llms.txt, a description or a
 * schema. scripts/llms-full.test.mjs fails when llms-full.txt is stale.
 */
import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { COMMAND_GROUPS } from '../public/js/agent/descriptions.js'
import { SCHEMAS } from '../public/js/agent/schemas.js'

export const LLMS_PATH = fileURLToPath(new URL('../public/llms.txt', import.meta.url))
export const LLMS_FULL_PATH = fileURLToPath(new URL('../public/llms-full.txt', import.meta.url))

const code = (value) => `\`${value}\``
const isClosed = schema => schema?.additionalProperties === false

function describeRange(schema) {
    const { min, max } = schema
    if (typeof min === 'number' && typeof max === 'number') return `from ${min} to ${max}`
    if (typeof min === 'number') return `${min} or more`
    if (typeof max === 'number') return `${max} or less`
    return null
}

// One-line description of a field type. Nested object fields come from
// fieldLines() instead.
function describeType(schema) {
    const parts = [schema.type === 'any' ? 'any JSON value' : schema.type]
    if (schema.enum) parts.push(`one of ${schema.enum.map(code).join(', ')}`)
    const range = describeRange(schema)
    if (range) parts.push(range)
    if (typeof schema.minLength === 'number') {
        parts.push(`at least ${schema.minLength} character${schema.minLength === 1 ? '' : 's'}`)
    }
    if (schema.pattern) parts.push(`matches ${code(`/${schema.pattern}/`)}`)
    if (schema.type === 'array' && schema.items) {
        const item = describeType(schema.items)
        parts[0] = schema.items.type === 'object' && schema.items.properties
            ? (isClosed(schema.items)
                ? 'array of objects with only these fields'
                : 'array of objects with these fields')
            : item === schema.items.type ? `array of ${item}s` : `array, each item ${item}`
    }
    if (schema.type === 'object' && schema.properties && Object.keys(schema.properties).length > 0) {
        parts[0] = isClosed(schema)
            ? 'object with only these fields'
            : 'object with these fields'
    }
    return parts.join(', ')
}

function fieldLines(schema, depth) {
    const required = new Set(schema.required || [])
    const indent = '  '.repeat(depth)
    const lines = []
    for (const [name, field] of Object.entries(schema.properties || {})) {
        const label = required.has(name) ? `${code(name)} (required)` : code(name)
        lines.push(`${indent}- ${label}: ${describeType(field)}`)
        const nested = field.type === 'array' ? field.items : field
        if (nested?.type === 'object' && nested.properties) {
            lines.push(...fieldLines(nested, depth + 1))
        }
    }
    return lines
}

function commandSection(name, description) {
    const schema = SCHEMAS[name]
    const fields = schema ? fieldLines(schema, 0) : []
    const lines = [`#### ${code(name)}`, '', description, '']
    if (fields.length === 0) {
        lines.push(isClosed(schema)
            ? 'Arguments: none. Any field fails with `INVALID_ARGS_UNKNOWN`.'
            : 'Arguments: none.')
    } else {
        lines.push('Arguments:', '', ...fields)
        if (isClosed(schema)) {
            lines.push('', 'Other fields fail with `INVALID_ARGS_UNKNOWN`.')
        }
    }
    lines.push('')
    return lines.join('\n')
}

export function renderReference() {
    const total = COMMAND_GROUPS.reduce((n, group) => n + Object.keys(group.commands).length, 0)
    const out = [
        '## Command reference',
        '',
        `Layers has ${total} public commands. Call a command as \`await window.LayersAgent.<name>(args)\`.`,
        'You can omit the argument object: `getState()` is the same as `getState({})`.',
        '',
    ]
    for (const group of COMMAND_GROUPS) {
        out.push(`### ${group.title}`, '')
        for (const [name, description] of Object.entries(group.commands)) {
            out.push(commandSection(name, description))
        }
    }
    return out.join('\n')
}

export async function renderLlmsFull() {
    const base = await readFile(LLMS_PATH, 'utf8')
    return `${base.trimEnd()}\n\n---\n\n${renderReference()}`
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    await writeFile(LLMS_FULL_PATH, await renderLlmsFull())
}
