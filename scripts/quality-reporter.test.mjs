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
    reporter.onBegin({}, { allTests: () => [{ outcome: () => 'expected', expectedStatus: 'passed', results: [{ status: 'passed', retry: 0 }] }] })
    assert.equal(reporter.onEnd(), undefined)
})

test('release reporter rejects a retried pass, and names it', () => {
    const flaky = {
        outcome: () => 'flaky',
        expectedStatus: 'passed',
        title: 'clone with selection only includes pixels from the selected layer',
        location: { file: 'tests/clone-tool.spec.js', line: 176 },
        results: [{ status: 'timedOut' }, { status: 'passed' }],
    }
    const reporter = new QualityReporter()
    reporter.onBegin({}, { allTests: () => [flaky] })

    const said = []
    const error = console.error
    console.error = (line) => said.push(String(line))
    try {
        assert.deepEqual(reporter.onEnd(), { status: 'failed' }, 'a test that passed on retry cannot certify the release')
    } finally {
        console.error = error
    }
    assert.ok(said.some(line => line.includes('retry')), 'flakiness must be announced')
    assert.ok(said.some(line => line.includes('clone-tool.spec.js:176')), 'the flaky test must be named')
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


test('release reporter rejects hidden retries and prohibited annotations', () => {
    const clean = { outcome: () => 'expected', expectedStatus: 'passed', title: 'example',
        location: { file: 'tests/x.spec.js', line: 1 }, results: [{ status: 'passed', retry: 0 }] }
    const adverse = [
        { ...clean, results: [{ status: 'failed', retry: 0 }, { status: 'passed', retry: 1 }] },
        { ...clean, results: [{ status: 'passed', retry: 1 }] },
        ...['skip', 'fixme', 'fail'].map(type => ({ ...clean, annotations: [{ type }] })),
        ...['skip', 'fixme', 'fail'].map(type => ({ ...clean, results: [{ status: 'passed', retry: 0, annotations: [{ type }] }] })),
    ]
    for (const testCase of adverse) {
        const reporter = new QualityReporter()
        reporter.onBegin({}, { allTests: () => [testCase] })
        assert.deepEqual(reporter.onEnd(), { status: 'failed' })
    }
})
