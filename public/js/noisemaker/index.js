/**
 * Noisemaker integration for Layers
 *
 * Re-exports the LayersRenderer and useful utilities from the Noisemaker
 * shader bundle. On web this loads from the CDN; desktop builds redirect those
 * requests to a build-time vendored copy via @nf/desktop-shell.
 *
 * @module noisemaker
 */

export { LayersRenderer } from './renderer.js'
export {
    extractEffectNamesFromDsl,
    extractEffectsFromDsl,
    getAllEffects,
    parse,
    unparse,
    lex,
    compile
} from './bundle.js'
