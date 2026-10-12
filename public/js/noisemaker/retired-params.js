/**
 * Parameter names that Noisemaker 1.0.289 retired (noisemaker a1a3fa2a removed
 * every `paramAliases` entry), keyed by effect path. A saved project or an
 * online document can still hold an old name, and the engine now rejects it,
 * so these are renamed when a project or a remote record is loaded.
 *
 * @module noisemaker/retired-params
 */

export const RETIRED_PARAMS = {
    'classicNoisedeck/bitEffects': { loopAmp: 'speed' },
    'classicNoisedeck/caustic': { loopAmp: 'speed' },
    'classicNoisedeck/cellNoise': { cellSmooth: 'smooth', cellVariation: 'variation', loopAmp: 'speed' },
    'classicNoisedeck/cellRefract': { cellSmooth: 'smooth', cellVariation: 'variation', loopAmp: 'speed', refractAmt: 'amount', refractDir: 'direction' },
    'classicNoisedeck/coalesce': { mixAmt: 'mix' },
    'classicNoisedeck/composite': { mixAmt: 'mix' },
    'classicNoisedeck/fractal': { backgroundColor: 'bgColor', backgroundOpacity: 'bgAlpha', fractalType: 'type' },
    'classicNoisedeck/glitch': { aberrationAmt: 'aberration' },
    'classicNoisedeck/kaleido': { kaleido: 'sides', loopAmp: 'speed' },
    'classicNoisedeck/lensDistortion': { aberrationAmt: 'aberration', loopAmp: 'speed', opacity: 'alpha' },
    'classicNoisedeck/moodscape': { loopAmp: 'speed' },
    'classicNoisedeck/noise': { loopAmp: 'speed', noiseType: 'type' },
    'classicNoisedeck/noise3d': { noiseScale: 'scale', noiseType: 'type' },
    'classicNoisedeck/refract': { mixAmt: 'mix', refractDir: 'direction' },
    'classicNoisedeck/shapes': { loopAAmp: 'speedA', loopBAmp: 'speedB' },
    'classicNoisedeck/shapes3d': { backgroundColor: 'bgColor', backgroundOpacity: 'bgAlpha' },
    'classicNoisedeck/splat': { splatColor: 'color', splatCutoff: 'cutoff', splatMode: 'mode', splatScale: 'scale', splatSeed: 'seed', splatSpeed: 'speed', useSplats: 'enabled' },
    'filter/celShading': { mixAmount: 'mix', shadingStrength: 'strength' },
    'filter/chromaticAberration': { aberrationAmt: 'aberration' },
    'filter/dither': { ditherType: 'type', mixAmount: 'mix' },
    'filter/feedback': { aberrationAmt: 'aberration', mixAmt: 'mix' },
    'filter/grade': { vignetteHighlightProtect: 'vigHiProtect' },
    'filter/historicPalette': { paletteIndex: 'index' },
    'filter/lowPoly': { freq: 'scale', nth: 'mode' },
    'filter/octaveWarp': { frequency: 'freq' },
    'filter/palette': { paletteIndex: 'index', paletteOffset: 'offset', paletteRepeat: 'repeat', paletteRotation: 'rotation' },
    'filter/prismaticAberration': { aberrationAmt: 'aberration' },
    'filter/text': { bgAlpha: 'matteOpacity', bgColor: 'matteColor', bgOpacity: 'matteOpacity' },
    'filter3d/palette3d': { paletteIndex: 'index', paletteOffset: 'offset', paletteRepeat: 'repeat', paletteRotation: 'rotation' },
    'mixer/alphaMask': { mixAmt: 'mix' },
    'mixer/applyMode': { mixAmt: 'mix' },
    'mixer/blendMode': { mixAmt: 'mix' },
    'mixer/centerMask': { mixAmt: 'mix' },
    'render/pointsBillboardRender': { rotationVariation: 'rotationVar' },
    'synth/cell': { cellVariation: 'variation', loopAmp: 'speed' },
    'synth/mandelbrot': { poiMode: 'poi' },
    'synth/media': { backgroundColor: 'bgColor', backgroundOpacity: 'bgAlpha' },
    'synth/noise': { loopAmp: 'speed', noiseType: 'type', xScale: 'scaleX', yScale: 'scaleY' },
    'synth/osc2d': { frequency: 'freq' },
    'synth/pattern': { patternType: 'type' },
    'synth/shape': { loopAAmp: 'speedA', loopBAmp: 'speedB' },
    'synth3d/cell3d': { cellVariation: 'variation' },
    'synth3d/flythrough3d': { fractalType: 'type' },
    'synth3d/fractal3d': { fractalType: 'type' },
}

/**
 * Return `params` with each retired name of `effectId` renamed to its
 * canonical name. When both names are present, the canonical value wins.
 * Returns the same object when nothing needs to change.
 *
 * @param {string|null} effectId - Effect path such as 'filter/text'
 * @param {object} params - Effect parameters keyed by name
 * @returns {object}
 */
export function migrateRetiredParams(effectId, params) {
    const retired = effectId && Object.hasOwn(RETIRED_PARAMS, effectId) ? RETIRED_PARAMS[effectId] : null
    if (!retired || !params || !Object.keys(params).some(key => Object.hasOwn(retired, key))) return params
    const out = {}
    for (const [key, value] of Object.entries(params)) {
        if (!Object.hasOwn(retired, key)) {
            out[key] = value
            continue
        }
        const canonical = retired[key]
        if (!Object.hasOwn(params, canonical) && !Object.hasOwn(out, canonical)) out[canonical] = value
    }
    return out
}
