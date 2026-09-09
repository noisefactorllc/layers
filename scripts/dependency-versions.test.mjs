import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validateDependencyReferences, validateDependencyBases } from './check-dependencies.mjs'
import * as dependencies from '../public/js/dependency-versions.js'

test('runtime dependency base URLs match the shader channel and Handfish version', () => {
    assert.doesNotThrow(() => validateDependencyBases())
    assert.throws(() => validateDependencyBases({ ...dependencies, NOISEMAKER_BASE: 'https://shaders.noisedeck.app/2' }), /base URLs/)
    assert.throws(() => validateDependencyBases({ ...dependencies, NOISEMAKER_VERSION: '1.0.139', NOISEMAKER_BASE: 'https://shaders.noisedeck.app/1.0.139' }), /release channel/)
    assert.throws(() => validateDependencyBases({ ...dependencies, HANDFISH_BASE: 'https://handfish.noisefactor.io/0.10.23' }), /base URLs/)
    assert.throws(() => validateDependencyBases({ ...dependencies, HANDFISH_VERSION: '0.10.24', HANDFISH_BASE: 'https://handfish.noisefactor.io/0.10.24' }), /release channel/)
})

test('release dependency checks accept shader /1 and reject inconsistent references', () => {
    for (const source of [
        'https://shaders.noisedeck.app/1.0.139/effects/manifest.json',
        'https://shaders.noisedeck.app/2/effects/manifest.json',
        'https://handfish.noisefactor.io/0.10.23/styles/tokens.css',
        'https://handfish.noisefactor.io/0.10.25/handfish.esm.min.js',
    ]) assert.throws(() => validateDependencyReferences(source), /dependency/)
    assert.doesNotThrow(() => validateDependencyReferences('https://shaders.noisedeck.app/1/effects/manifest.json'))
    assert.doesNotThrow(() => validateDependencyReferences('https://handfish.noisefactor.io/0/handfish.esm.min.js'))
})
