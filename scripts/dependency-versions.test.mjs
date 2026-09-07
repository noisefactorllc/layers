import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validateDependencyReferences, validateDependencyBases } from './check-dependencies.mjs'
import * as dependencies from '../public/js/dependency-versions.js'

test('runtime dependency base URLs match pinned version declarations', () => {
    assert.doesNotThrow(() => validateDependencyBases())
    assert.throws(() => validateDependencyBases({ ...dependencies, NOISEMAKER_BASE: 'https://shaders.noisedeck.app/1' }), /base URLs/)
    assert.throws(() => validateDependencyBases({ ...dependencies, HANDFISH_BASE: 'https://handfish.noisefactor.io/0.10.23' }), /base URLs/)
})

test('release dependency checks reject rolling CDN aliases and inconsistent exact pins', () => {
    for (const source of [
        'https://shaders.noisedeck.app/1/effects/manifest.json',
        'https://handfish.noisefactor.io/0/handfish.esm.min.js',
        'https://handfish.noisefactor.io/0.10.23/styles/tokens.css',
    ]) assert.throws(() => validateDependencyReferences(source), /dependency/)
    assert.doesNotThrow(() => validateDependencyReferences('https://handfish.noisefactor.io/0.10.24/styles/tokens.css'))
})
