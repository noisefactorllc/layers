// A successful workflow must certify actual tests, including collaboration.
export default class QualityReporter {
    onBegin(config, suite) { this.suite = suite }
    onEnd() {
        const tests = this.suite.allTests()
        if (!tests.length || tests.some(test => test.outcome() !== 'expected'
            || test.expectedStatus !== 'passed' || test.results.at(-1)?.status !== 'passed')) {
            console.error('Quality gate requires a nonempty suite with every test passing; skipped tests cannot certify a release.')
            return { status: 'failed' }
        }
    }
}
