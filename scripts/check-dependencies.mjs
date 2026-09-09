import { readdir, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import * as dependencies from '../public/js/dependency-versions.js'
export function validateDependencyBases(values = dependencies) {
    if (values.NOISEMAKER_VERSION !== '1') throw new Error('Shader dependency must use the /1 release channel')
    if (values.HANDFISH_VERSION !== '0') throw new Error('Handfish dependency must use the /0 release channel')
    if (values.NOISEMAKER_BASE !== `https://shaders.noisedeck.app/${values.NOISEMAKER_VERSION}`
        || values.HANDFISH_BASE !== `https://handfish.noisefactor.io/${values.HANDFISH_VERSION}`) {
        throw new Error('Dependency base URLs must match their declared versions')
    }
}

export function validateDependencyReferences(source) {
    validateDependencyBases()
    const versions = { 'shaders.noisedeck.app': dependencies.NOISEMAKER_VERSION, 'handfish.noisefactor.io': dependencies.HANDFISH_VERSION }
    for (const match of source.matchAll(/https:\/\/(shaders\.noisedeck\.app|handfish\.noisefactor\.io)\/([^/'"\s`]+)/g)) {
        if (match[2] !== versions[match[1]]) throw new Error(`Inconsistent dependency version: ${match[0]}`)
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
