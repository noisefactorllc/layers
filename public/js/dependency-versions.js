// Follow the shader version 1 release channel. CI records the resolved release
// metadata alongside the complete browser/pixel suite's evidence.
export const NOISEMAKER_VERSION = '1'
export const NOISEMAKER_BASE = `https://shaders.noisedeck.app/${NOISEMAKER_VERSION}`
// Follow the Handfish major 0 release channel, the same way the shaders above
// follow channel 1. The origin publishes each patch to its own immutable
// directory and repoints /0 at it, so consumers pick up minor and patch
// releases without editing anything, and only a major bump needs a code change.
// Pinning a patch here silently freezes this app on an old component library.
export const HANDFISH_VERSION = '0'
export const HANDFISH_BASE = `https://handfish.noisefactor.io/${HANDFISH_VERSION}`
