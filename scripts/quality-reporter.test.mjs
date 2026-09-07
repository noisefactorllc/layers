import { test } from 'node:test'
import assert from 'node:assert/strict'
import QualityReporter from './quality-reporter.mjs'

test('release reporter rejects empty, skipped and unexpectedly failing runs', () => {
    for (const tests of [[], [{ outcome: () => 'skipped' }], [{ outcome: () => 'unexpected' }],
        [{ outcome: () => 'expected', expectedStatus: 'failed', results: [{ status: 'failed' }] }]]) {
        const reporter = new QualityReporter()
        reporter.onBegin({}, { allTests: () => tests })
        assert.deepEqual(reporter.onEnd(), { status: 'failed' })
    }
    const reporter = new QualityReporter()
    reporter.onBegin({}, { allTests: () => [{ outcome: () => 'expected', expectedStatus: 'passed', results: [{ status: 'passed' }] }] })
    assert.equal(reporter.onEnd(), undefined)
})
