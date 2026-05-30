#!/usr/bin/env node
/**
 * Downloads pinned Noisemaker engine + effect bundles to <repo>/vendor/noisemaker/<v>/.
 * Writes SHA256SUMS for app-launch integrity verification.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { dirname, join, relative, sep, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

const REPO_ROOT = resolve(__dirname, '..')
const PIN_PATH = join(REPO_ROOT, 'desktop', 'noisemaker.version.json')

async function main() {
    const pin = JSON.parse(await readFile(PIN_PATH, 'utf8'))
    const { version, baseUrl } = pin
    const versionUrl = `${baseUrl}/${version}`
    const destRoot = join(REPO_ROOT, 'public', 'vendor', 'noisemaker', version)
    const effectsDest = join(destRoot, 'effects')
    await mkdir(effectsDest, { recursive: true })

    const checksums = []

    async function download(url, destPath) {
        const resp = await fetch(url)
        if (!resp.ok) throw new Error(`Failed ${resp.status}: ${url}`)
        const buf = Buffer.from(await resp.arrayBuffer())
        await mkdir(dirname(destPath), { recursive: true })
        await writeFile(destPath, buf)
        const hash = createHash('sha256').update(buf).digest('hex')
        checksums.push(`${hash}  ${relative(destRoot, destPath).split(sep).join('/')}`)
    }

    console.log(`Fetching Noisemaker ${version} from ${versionUrl}`)

    await download(
        `${versionUrl}/noisemaker-shaders-core.esm.min.js`,
        join(destRoot, 'noisemaker-shaders-core.esm.min.js')
    )

    const manifestResp = await fetch(`${versionUrl}/effects/manifest.json`)
    if (!manifestResp.ok) throw new Error(`Manifest fetch failed: ${manifestResp.status}`)
    const manifestText = await manifestResp.text()
    const manifest = JSON.parse(manifestText)

    const effectIds = Object.keys(manifest)
    console.log(`Downloading ${effectIds.length} effect bundles...`)
    for (const id of effectIds) {
        const rel = `${id}.js`
        await download(`${versionUrl}/effects/${rel}`, join(effectsDest, rel))
    }

    const manifestDest = join(effectsDest, 'manifest.json')
    await writeFile(manifestDest, manifestText)
    const manifestHash = createHash('sha256').update(manifestText).digest('hex')
    checksums.push(`${manifestHash}  effects/manifest.json`)

    const sumsPath = join(destRoot, 'SHA256SUMS')
    await writeFile(sumsPath, checksums.join('\n') + '\n')
    console.log(`Wrote ${checksums.length} checksums to ${sumsPath}`)
}

main().catch((err) => {
    console.error(err)
    process.exit(1)
})
