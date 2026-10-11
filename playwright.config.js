import { defineConfig } from 'playwright/test'

// Chromium keeps the five-shard split measured in 5e4bbc5. Firefox and
// WebKit subdivide that commit's measured ranges to restore capacity margin.
// Recent green main runs 38069362590, 38099015213 and 38104236503 measured
// maxima of 998 s chromium, 1125 s firefox and 1088 s webkit under the prior
// layout. The latter two exceed GAP-002's 1080 s acceptance limit despite
// passing the 1200 s timeout. See https://github.com/noisefactorllc/layers/issues/8.
//
// 5e4bbc5 re-derived the parent weights over eight measured windows through
// 38104236503, predicting worst steps of 991/1064/1009 seconds. Its Firefox
// vector [305,242,310,293] and WebKit vector
// [115,130,128,55,111,132,103,136,123,117] each sum to the current 1150 tests.
// Split each weight into adjacent halves. Playwright 1.63 assigns groups by
// their first test, so each new pair retains the former shard's exact group
// membership at this inventory. These are subdivisions, not a new timing
// optimization. Verify their union with --list and measure full CI runs.
//
// The workflow has 5/8/20 shards. Keep it aligned with these vectors. More
// jobs can wait for runner capacity, but each shard keeps the same 20-minute
// execution ceiling and every test still runs once per engine. Weights only
// apply when the command selects one project and its matching shard count.
const shardWeights = {
    chromium: [297, 201, 208, 240, 204],
    firefox: [152, 153, 121, 121, 155, 155, 146, 147],
    webkit: [57, 58, 65, 65, 64, 64, 27, 28, 55, 56, 66, 66, 51, 52, 68, 68, 61, 62, 58, 59],
}

function cliFlag(flag) {
    const argv = process.argv
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === flag)
            return argv[i + 1]
        if (argv[i].startsWith(flag + '='))
            return argv[i].slice(flag.length + 1)
    }
    return undefined
}

if (process.env.CI) {
    const project = cliFlag('--project')
    const shard = cliFlag('--shard')
    const total = shard ? Number((shard.split('/')[1] || '')) : NaN
    const weights = shardWeights[project]
    if (weights && Number.isInteger(total) && total === weights.length)
        process.env.PWTEST_SHARD_WEIGHTS = weights.join(':')
}

export default defineConfig({
    testDir: './tests',
    // Software-rendered browser runs include shader compilation and page
    // startup; individual assertions retain their shorter failure deadlines.
    //
    // Ninety seconds, not sixty, because of what shares the runner. Two
    // workers each drive a browser with no GPU on four cores, so a single
    // click that expands a params panel was measured at 22 seconds and the
    // whole test at just over sixty: not a hang, a starved machine doing real
    // work slowly. A budget that tight turns those into three full re-runs
    // apiece, which costs the harness far more wall clock than the headroom
    // does. Raise the shard count before raising this again.
    timeout: 90000,
    forbidOnly: !!process.env.CI,
    // With the weighted split above, every shard's test step is measured or
    // predicted at or under about eighteen minutes, so one timeout under
    // runner load must not throw that away. A retry that passes is still
    // reported as flaky by
    // name (scripts/quality-reporter.mjs) so it gets fixed rather than
    // absorbed. Locally, no retries: a flake should be visible while you are
    // the one who caused it.
    retries: process.env.CI ? 2 : 0,
    // A whole-run ceiling, and a deliberately strict one. CI runs each engine
    // in shards on separate runners, so no single Playwright run is the whole
    // suite any more: the weighted split above keeps every shard's test step
    // at or under about eighteen minutes against a twenty minute promise for
    // the harness as a whole. Twenty here is that promise, not a safety margin
    // around a number nobody measured. If a shard reaches it, find what got
    // slow or rebalance the shards; never raise this.
    globalTimeout: process.env.CI ? 20 * 60 * 1000 : 0,
    workers: process.env.CI ? 2 : undefined,
    reporter: process.env.CI
        ? [['line'], ['html', { open: 'never' }], ['./scripts/quality-reporter.mjs']]
        : [['list']],
    use: {
        baseURL: 'http://localhost:3002',
        headless: true,
        trace: 'retain-on-failure',
        screenshot: 'only-on-failure',
    },
    projects: [
        {
            name: 'chromium',
            use: {
                browserName: 'chromium',
                // Two-page collaboration tests under two workers exhaust a
                // 64MB /dev/shm and the renderer dies at page.goto ("Page
                // crashed"). This is the standard Playwright hardening for
                // that; it moves chromium's shared memory onto /tmp instead.
                launchOptions: { args: ['--disable-dev-shm-usage'] },
            },
        },
        { name: 'firefox', use: { browserName: 'firefox' } },
        { name: 'webkit', use: { browserName: 'webkit' } },
    ],
    webServer: {
        command: 'npm run dev',
        url: 'http://localhost:3002',
        reuseExistingServer: !process.env.CI,
    },
})
