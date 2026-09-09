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

test('release reporter certifies a retried pass, and names it', () => {
    const flaky = {
        outcome: () => 'flaky',
        expectedStatus: 'passed',
        title: 'grade vec3 params get pickers, not sliders',
        location: { file: 'tests/effect-params-vec3.spec.js', line: 110 },
        results: [{ status: 'timedOut' }, { status: 'passed' }],
    }
    const reporter = new QualityReporter()
    reporter.onBegin({}, { allTests: () => [flaky] })

    const said = []
    const error = console.error
    console.error = (line) => said.push(String(line))
    try {
        assert.equal(reporter.onEnd(), undefined, 'a test that passed on retry certifies the release')
    } finally {
        console.error = error
    }
    assert.ok(said.some(line => line.includes('only passed on a retry')), 'flakiness must be announced')
    assert.ok(said.some(line => line.includes('effect-params-vec3.spec.js:110')), 'the flaky test must be named')
})

test('release reporter still rejects a retried test that never passed', () => {
    const reporter = new QualityReporter()
    reporter.onBegin({}, { allTests: () => [{
        outcome: () => 'unexpected',
        expectedStatus: 'passed',
        title: 'never passes',
        location: { file: 'tests/x.spec.js', line: 1 },
        results: [{ status: 'timedOut' }, { status: 'timedOut' }, { status: 'timedOut' }],
    }] })
    assert.deepEqual(reporter.onEnd(), { status: 'failed' })
})
