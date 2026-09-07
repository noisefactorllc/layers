import { readdir } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { checkDependencies } from './check-dependencies.mjs'

async function checkSyntax(root) {
    for (const entry of await readdir(root, { withFileTypes: true })) {
        const path = join(root, entry.name)
        if (entry.isDirectory()) await checkSyntax(path)
        else if (/\.(js|mjs)$/.test(entry.name)) {
            const result = spawnSync(process.execPath, ['--check', path], { stdio: 'inherit' })
            if (result.status !== 0) throw new Error(`Syntax check failed: ${path}`)
        }
    }
}
await checkDependencies()
await checkSyntax('public/js')
await checkSyntax('scripts')
