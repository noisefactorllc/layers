import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SCHEMAS, validate } from '../public/js/agent/schemas.js'

test('existing command roots accept legacy extra fields while nested edits reject typos', () => {
    assert.equal(validate({ layerId: 'one', layerIds: ['one'] },
        SCHEMAS.duplicateLayer).ok, true)
    assert.equal(validate({ layerId: 'one', layerIds: ['one'] },
        SCHEMAS.flattenLayers).ok, true)
    const typo = validate({ layerId: 'one', props: { opactiy: 25 } },
        SCHEMAS.setLayerProps)
    assert.equal(typo.code, 'INVALID_ARGS_UNKNOWN')
    assert.equal(typo.details.field, 'props.opactiy')
})

test('new command roots reject undeclared fields', () => {
    const typo = validate({ layerId: 'one', visble: true }, SCHEMAS.setMaskVisible)
    assert.equal(typo.code, 'INVALID_ARGS_REQUIRED')
    const extra = validate({ layerId: 'one', visible: true, extra: true },
        SCHEMAS.setMaskVisible)
    assert.equal(extra.code, 'INVALID_ARGS_UNKNOWN')
})
