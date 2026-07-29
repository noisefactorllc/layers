/**
 * Menu-bar data extracted byte-exact from the original #menu markup when
 * the bar moved to the handfish <menu-bar> component. Labels, data-effect
 * ids, and data-params match the source markup; app.js builds the menu
 * config from these tables.
 */

export const LOGO_SVG = `<svg id="logo" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 600" fill="currentColor" style="height: 1.25em; width: 1.25em;" aria-hidden="true" focusable="false">
                            <g transform="translate(0,600) scale(0.1,-0.1)">
                                <path d="M840 5478 c-10 -18 -120 -204 -244 -413 l-225 -380 1314 -3 c723 -1 1907 -1 2630 0 l1315 3 -236 390 c-130 215 -241 400 -247 413 l-10 22 -2139 0 -2139 0 -19 -32z"/>
                                <path d="M659 4118 c-111 -189 -222 -376 -246 -415 l-43 -73 2630 0 2630 0 -249 413 -249 412 -2135 3 -2135 2 -203 -342z"/>
                                <path d="M858 3403 c-8 -10 -90 -146 -183 -303 -92 -157 -199 -337 -237 -400 l-68 -115 1315 -3 c723 -1 1907 -1 2630 0 l1314 3 -251 418 -251 417 -2127 0 c-2013 0 -2128 -1 -2142 -17z"/>
                                <path d="M619 1959 c-134 -226 -245 -414 -247 -418 -1 -3 1179 -6 2623 -6 1743 0 2625 3 2625 10 0 6 -110 192 -244 415 l-244 405 -2135 3 -2134 2 -244 -411z"/>
                                <path d="M714 1073 c-81 -137 -191 -322 -245 -413 l-99 -165 1315 -3 c723 -1 1906 -1 2629 0 l1315 3 -248 410 -247 410 -2137 3 -2136 2 -147 -247z"/>
                            </g>
                        </svg>`

export const IMAGE_SUBMENUS = [
    { submenu: "tone", label: "tone", effects: [
        { label: "brightness/contrast", effect: "filter/adjust" },
        { label: "levels", effect: "filter/smoothstep" },
        { label: "posterize", effect: "filter/posterize" },
        { label: "threshold", effect: "filter/threshold" },
    ] },
    { submenu: "color", label: "color", effects: [
        { label: "hue/saturation", effect: "filter/adjust" },
        { label: "color grading", effect: "filter/grade" },
        { label: "tint", effect: "filter/tint" },
        { label: "color replace", effect: "filter/colorReplace" },
        { label: "invert", effect: "filter/invert" },
        { label: "gradient palette", effect: "filter/tetraColorArray" },
    ] },
]

export const FILTER_CATEGORIES = [
    { id: "filterBlurTrigger", submenu: "blur", label: "blur", effects: [
        { label: "blur", effect: "filter/blur" },
        { label: "motion blur", effect: "filter/directionalBlur" },
        { label: "zoom blur", effect: "filter/zoomBlur" },
        { label: "spin blur", effect: "filter/spinBlur" },
        { label: "median", effect: "filter/median" },
        { label: "soft focus", effect: "filter/vaseline" },
    ] },
    { id: "filterSharpenTrigger", submenu: "sharpen", label: "sharpen", effects: [
        { label: "sharpen", effect: "filter/sharpen" },
        { label: "unsharp mask", effect: "filter/unsharpMask" },
        { label: "high pass", effect: "filter/highPass" },
    ] },
    { id: "filterPixelateTrigger", submenu: "pixelate", label: "pixelate", effects: [
        { label: "pixelate", effect: "filter/pixels" },
        { label: "halftone", effect: "filter/halftone" },
        { label: "dither", effect: "filter/dither" },
        { label: "low poly", effect: "filter/lowPoly" },
        { label: "glyph map", effect: "filter/glyphMap" },
        { label: "stipple", effect: "filter/stipple" },
    ] },
    { id: "filterDistortTrigger", submenu: "distort", label: "distort", effects: [
        { label: "warp", effect: "filter/warp" },
        { label: "bulge", effect: "filter/bulge" },
        { label: "pinch", effect: "filter/pinch" },
        { label: "skew", effect: "filter/skew" },
        { label: "waves", effect: "filter/waves" },
        { label: "ripples", effect: "filter/pondRipples" },
        { label: "twirl", effect: "filter/spiral" },
        { label: "polar coordinates", effect: "filter/polar" },
        { label: "tunnel", effect: "filter/tunnel" },
        { label: "wormhole", effect: "filter/wormhole" },
    ] },
    { id: "filterGlitchTrigger", submenu: "glitch", label: "glitch", effects: [
        { label: "glitch", effect: "classicNoisedeck/glitch", params: {"glitchiness": 50, "aberration": 30} },
        { label: "corrupt", effect: "filter/corrupt" },
        { label: "pixel sort", effect: "filter/pixelSort" },
        { label: "scanline error", effect: "filter/scanlineError" },
        { label: "crt", effect: "filter/crt" },
        { label: "tv snow", effect: "filter/snow" },
        { label: "degauss", effect: "filter/degauss" },
        { label: "chromatic aberration", effect: "filter/chromaticAberration" },
        { label: "feedback", effect: "filter/convolutionFeedback" },
        { label: "echo trails", effect: "filter/reverb" },
        { label: "video feedback", effect: "filter/feedback", params: {"mix": 50, "scaleAmt": 97, "rotation": 2} },
    ] },
    { id: "filterStylizeTrigger", submenu: "stylize", label: "stylize", effects: [
        { label: "edge detect", effect: "filter/edge" },
        { label: "glowing edge", effect: "filter/glowingEdge" },
        { label: "emboss", effect: "filter/emboss" },
        { label: "extrude", effect: "filter/extrude" },
        { label: "cel shading", effect: "filter/celShading" },
        { label: "oil paint", effect: "filter/oilPaint" },
        { label: "wind", effect: "filter/wind" },
        { label: "scatter", effect: "filter/scatter" },
    ] },
    { id: "filterSketchTrigger", submenu: "sketch", label: "sketch", effects: [
        { label: "chrome", effect: "filter/chrome" },
        { label: "photocopy", effect: "filter/photocopy" },
        { label: "stamp", effect: "filter/stamp" },
        { label: "relief", effect: "filter/relief" },
    ] },
    { id: "filterBrushStrokesTrigger", submenu: "brush-strokes", label: "brush strokes", effects: [
        { label: "hatch", effect: "filter/hatch" },
        { label: "strokes", effect: "filter/strokes" },
        { label: "spatter", effect: "filter/spatter" },
        { label: "outline", effect: "filter/outline" },
    ] },
    { id: "filterArtisticTrigger", submenu: "artistic", label: "artistic", effects: [
        { label: "watercolor", effect: "filter/watercolor" },
        { label: "plastic wrap", effect: "filter/plasticWrap" },
        { label: "historic palette", effect: "filter/historicPalette" },
    ] },
    { id: "filterTextureTrigger", submenu: "texture", label: "texture", effects: [
        { label: "grain", effect: "filter/grain" },
        { label: "craquelure", effect: "filter/craquelure" },
        { label: "mosaic tiles", effect: "filter/mosaicTiles" },
        { label: "patchwork", effect: "filter/patchwork" },
        { label: "texturizer", effect: "filter/texture" },
        { label: "grime", effect: "filter/grime" },
        { label: "fibers", effect: "filter/fibers" },
        { label: "scratches", effect: "filter/scratches" },
        { label: "stray hair", effect: "filter/strayHair" },
    ] },
    { id: "filterLightLensTrigger", submenu: "light-lens", label: "light & lens", effects: [
        { label: "bloom", effect: "filter/bloom" },
        { label: "vignette", effect: "filter/vignette" },
        { label: "lens flare", effect: "filter/lensFlare" },
        { label: "light leak", effect: "filter/lightLeak" },
        { label: "lighting", effect: "filter/lighting" },
        { label: "lens distortion", effect: "filter/lens", params: {"displacement": 0.3} },
        { label: "clouds", effect: "filter/clouds" },
    ] },
    { id: "filterTileTrigger", submenu: "tile", label: "tile", effects: [
        { label: "kaleidoscope", effect: "filter/tile" },
        { label: "repeat", effect: "filter/repeat" },
        { label: "seamless", effect: "filter/seamless" },
        { label: "flip mirror", effect: "filter/flipMirror" },
    ] },
]
