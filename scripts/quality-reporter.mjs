// A release is certified only when every selected test passes on its first attempt.
export default class QualityReporter {
    onBegin(config, suite) { this.suite = suite }
    onEnd() {
        const tests = this.suite.allTests()
        const prohibited = (annotations = []) => annotations.some(annotation =>
            ['skip', 'fixme', 'fail'].includes(annotation.type))
        const adverse = tests.filter(test => {
            const result = test.results?.[0]
            return test.outcome() !== 'expected' || test.expectedStatus !== 'passed'
                || test.results?.length !== 1 || result?.status !== 'passed' || result?.retry !== 0
                || prohibited(test.annotations) || prohibited(result?.annotations)
        })
        if (!tests.length || adverse.length) {
            console.error('Quality gate requires every test to pass without a retry or prohibited annotation.')
            for (const test of adverse) {
                console.error(`  ${test.location?.file ?? 'unknown'}:${test.location?.line ?? 0} ${test.title ?? 'unnamed test'} (outcome: ${test.outcome()}, retry or adverse result)`)
            }
            return { status: 'failed' }
        }
    }
}
