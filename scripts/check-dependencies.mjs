import { readdir, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import * as dependencies from '../public/js/dependency-versions.js'
const { NOISEMAKER_VERSION, HANDFISH_VERSION } = dependencies

export function validateDependencyBases(values = dependencies) {
    if (values.NOISEMAKER_BASE !== `https://shaders.noisedeck.app/${values.NOISEMAKER_VERSION}`
        || values.HANDFISH_BASE !== `https://handfish.noisefactor.io/${values.HANDFISH_VERSION}`) {
        throw new Error('Dependency base URLs must match their exact pinned versions')
    }
}

const versions = { 'shaders.noisedeck.app': NOISEMAKER_VERSION, 'handfish.noisefactor.io': HANDFISH_VERSION }
export function validateDependencyReferences(source) {
    for (const version of Object.values(versions)) {
        if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`Invalid dependency version: ${version}`)
    }
    for (const match of source.matchAll(/https:\/\/(shaders\.noisedeck\.app|handfish\.noisefactor\.io)\/([^/'"\s`]+)/g)) {
        if (match[2] !== versions[match[1]]) throw new Error(`Unpinned or inconsistent dependency: ${match[0]}`)
    }
}

export async function checkDependencies(root = 'public') {
    validateDependencyBases()
    for (const entry of await readdir(root, { withFileTypes: true })) {
        const path = resolve(root, entry.name)
        if (entry.isDirectory()) await checkDependencies(path)
        else if (/\.(html|js|css)$/.test(entry.name) && entry.name !== 'dependency-versions.js') {
            validateDependencyReferences(await readFile(path, 'utf8'))
        }
    }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await checkDependencies()
