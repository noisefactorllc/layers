// The ?seanceSdk= value is handed to import(), and ?seanceUrl= decides which
// server receives the whole composition. Both are development conveniences and
// must never be honoured on a public origin, or any share link could run the
// sender's code here. See collab/onlineAdapter.js resolveOnlineConfig.
import assert from 'node:assert/strict'
import test from 'node:test'

import {
    DEFAULT_SEANCE_SDK_URL,
    DEFAULT_SEANCE_URL,
    isLocalDevLocation,
    resolveOnlineConfig
} from '../public/js/collab/onlineAdapter.js'

test('defaults to the hosted Seance server and rolling major SDK', () => {
    const config = resolveOnlineConfig({ location: 'https://layers.noisefactor.io/' })

    assert.equal(config.seanceUrl, DEFAULT_SEANCE_URL)
    assert.equal(config.sdkUrl, DEFAULT_SEANCE_SDK_URL)
})

test('ignores URL overrides on a public origin', () => {
    const config = resolveOnlineConfig({
        location: 'https://layers.noisefactor.io/?seance=Ab12Cd'
            + '&seanceSdk=https%3A%2F%2Fevil.example%2Fx.js'
            + '&seanceUrl=https%3A%2F%2Fevil.example'
    })

    assert.equal(config.sdkUrl, DEFAULT_SEANCE_SDK_URL)
    assert.equal(config.seanceUrl, DEFAULT_SEANCE_URL)
})

test('honours URL overrides on a development host, so the harness still works', () => {
    const config = resolveOnlineConfig({
        location: 'http://localhost:3002/?seanceUrl=http%3A%2F%2F127.0.0.1%3A8123'
            + '&seanceSdk=http%3A%2F%2F127.0.0.1%3A8123%2Fsdk%2F0%2Findex.js'
    })

    assert.equal(config.seanceUrl, 'http://127.0.0.1:8123')
    assert.equal(config.sdkUrl, 'http://127.0.0.1:8123/sdk/0/index.js')
})

test('a window global still configures an embedder on a public origin', () => {
    const config = resolveOnlineConfig({
        location: 'https://layers.noisefactor.io/',
        globals: { seanceUrl: 'https://seance.example', sdkUrl: 'https://seance.example/sdk/0/index.js' }
    })

    assert.equal(config.seanceUrl, 'https://seance.example')
    assert.equal(config.sdkUrl, 'https://seance.example/sdk/0/index.js')
})

test('isLocalDevLocation recognises loopback hosts only', () => {
    for (const href of ['http://localhost:3002/', 'http://127.0.0.1/', 'http://[::1]:8080/']) {
        assert.equal(isLocalDevLocation(href), true, href)
    }
    for (const href of [
        'https://layers.noisefactor.io/',
        'https://localhost.evil.example/',
        'https://evil.example/?x=localhost'
    ]) {
        assert.equal(isLocalDevLocation(href), false, href)
    }
})
