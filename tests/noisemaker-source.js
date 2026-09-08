import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

// Release CI always uses the pinned CDN artifact. This explicit local override
// tests pending shared shader changes without building or publishing bundles.
export async function installNoisemakerSource(page, effects) {
    if (!process.env.LAYERS_NOISEMAKER_SOURCE) return
    for (const effect of effects) {
        const root = path.join(process.env.LAYERS_NOISEMAKER_SOURCE, 'shaders/effects', effect)
        const exported = (await import(pathToFileURL(path.join(root, 'definition.js')).href)).default
        const definition = typeof exported === 'function' ? new exported() : exported
        const shaders = {}
        for (const program of new Set(definition.passes.map(pass => pass.program))) {
            shaders[program] = {
                glsl: await readFile(path.join(root, `glsl/${program}.glsl`), 'utf8'),
                wgsl: await readFile(path.join(root, `wgsl/${program}.wgsl`), 'utf8'),
            }
        }
        await page.route(`https://shaders.noisedeck.app/*/effects/${effect}.js`, async route => {
            const response = await route.fetch()
            const source = await response.text()
            const name = source.match(/export\s*\{\s*([\w$]+)\s+as\s+default\b/)?.[1]
            if (!name) throw new Error('Cannot locate bundled effect export for source verification')
            const config = JSON.stringify({ globals: definition.globals, passes: definition.passes, textures: definition.textures })
            await route.fulfill({ response, body: `${source}\nObject.assign(${name}, ${config});\nObject.assign(${name}.shaders, ${JSON.stringify(shaders)});` })
        })
    }
}
