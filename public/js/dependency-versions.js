// Promote these immutable releases only after the browser/pixel suite passes.
// Noisemaker 1.0.136 predates the source-alpha blend fix: that regression must
// remain a release blocker until a corrected Noisemaker release is published.
export const NOISEMAKER_VERSION = '1.0.136'
export const NOISEMAKER_BASE = `https://shaders.noisedeck.app/${NOISEMAKER_VERSION}`
export const HANDFISH_VERSION = '0.10.24'
export const HANDFISH_BASE = `https://handfish.noisefactor.io/${HANDFISH_VERSION}`
