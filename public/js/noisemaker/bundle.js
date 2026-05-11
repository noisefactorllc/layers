/**
 * ESM bundle loader for Noisemaker Shaders Core
 *
 * Dynamically imports from the appropriate ESM bundle:
 * - Non-minified for local development (localhost, 127.0.0.1, file://)
 * - Minified for production
 */

const SHADER_CDN = 'https://shaders.noisedeck.app/1'
const BUNDLE_VERSION = SHADER_CDN.split('/').pop()

const isLocalDev = typeof window !== 'undefined' && (
    window.location.hostname === 'localhost' ||
    window.location.hostname === '127.0.0.1' ||
    window.location.protocol === 'file:'
)

const bundlePath = isLocalDev
    ? `${SHADER_CDN}/noisemaker-shaders-core.esm.js`
    : `${SHADER_CDN}/noisemaker-shaders-core.esm.min.js`

const bundle = await import(bundlePath)
console.debug(`[bundle.js] Noisemaker bundle v${BUNDLE_VERSION} loaded from ${bundlePath}`)

export const {
    CanvasRenderer,
    ProgramState,
    registerEffect,
    getEffect,
    getAllEffects,
    registerOp,
    registerStarterOps,
    mergeIntoEnums,
    stdEnums,
    compile,
    validate,
    lex,
    parse,
    unparse,
    extractEffectNamesFromDsl,
    extractEffectsFromDsl,
    formatDslError,
    cloneParamValue,
    isStarterEffect,
    hasTexSurfaceParam,
    is3dGenerator,
    is3dProcessor,
    isValidIdentifier,
    sanitizeEnumName,
    groupGlobalsByCategory
} = bundle

export const _bundle = bundle
