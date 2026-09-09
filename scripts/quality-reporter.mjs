// A successful workflow must certify actual tests, including collaboration.
//
// Every test must end passing and none may be skipped: a release is not
// certified by a suite that quietly did not run. What this does tolerate is a
// test that needed a retry, because the suite takes about an hour across three
// browsers and a single timeout under runner load otherwise throws that hour
// away and blocks the deploy behind a result that says nothing about the code.
//
// Tolerated is not ignored. A retry that passes is printed here by name, so a
// test that keeps needing one is visible and gets fixed at its source rather
// than being absorbed silently forever. The usual source is a fixed sleep
// standing in for work whose duration varies with the machine.
export default class QualityReporter {
    onBegin(config, suite) { this.suite = suite }
    onEnd() {
        const tests = this.suite.allTests()
        const ended = (test) => test.results.at(-1)?.status
        const certified = (test) => (test.outcome() === 'expected' || test.outcome() === 'flaky')
            && test.expectedStatus === 'passed'
            && ended(test) === 'passed'

        if (!tests.length || tests.some(test => !certified(test))) {
            console.error('Quality gate requires a nonempty suite with every test passing; skipped tests cannot certify a release.')
            return { status: 'failed' }
        }

        const flaky = tests.filter(test => test.outcome() === 'flaky')
        if (flaky.length) {
            console.error(`Quality gate passed, but ${flaky.length} test(s) only passed on a retry. Fix these at the source:`)
            for (const test of flaky) {
                console.error(`  ${test.location.file}:${test.location.line} ${test.title} (${test.results.length} attempts)`)
            }
        }
    }
}
