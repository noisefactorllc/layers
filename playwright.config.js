import { defineConfig } from 'playwright/test'

// Shard sizes, one vector per engine, expressed as the number of tests each
// shard should carry. Playwright's default shard split divides the suite by
// test count alone, and test counts are a poor proxy for cost: collaboration
// (18 tests) took 431 worker-seconds on webkit while 29 tests of agent
// validation took 37. The vectors below are the min-max partitions of the
// per-file worker-seconds, each computed over the slower of eight independent
// green runs on main (37097762272 at f537250; 37101997646 at ca6a404;
// 37107393719 at 49a639a; 37110907758 at 7bf0824; 37146215821 at f14c52d;
// 37181219087 at 42a61cd; 37186286571 at 46d47ad; and 37205985800 at bae8d33)
// so the split does not overfit one fast window: a
// first split measured against a single run put webkit 8/10 and chromium 5/5
// within seconds of the cap in the next run, which executed the same files up
// to 1.6x slower, a second left webkit 9/10 at 1129 s, a third left chromium
// 1/5 at 1090 s, a fourth left chromium 5/5 at 1130 s and a fifth left
// firefox 4/4 at 1176 s. This re-partition became necessary when the keyboard
// layer specs and the foreground-color persistence spec joined the suite and
// pushed legs back past the ninety percent line on otherwise green runs:
// chromium 5/5 at 1110 s on run 37101997646, chromium 1/5 at 1138 s on run
// 37110907758, and webkit 5/10 at 1186 s on run 37146215821. They put every
// predicted shard step at or under
// about eighteen minutes against
// the twenty minute promise below, with the caveat that
// foreground-color-persistence.spec.js has been measured by the single run
// that carries it so far, so its envelope can be biased low, and files whose
// worst window has not been observed yet are unmeasured by definition.
// Playwright reads these
// through PWTEST_SHARD_WEIGHTS after this config is imported, so setting it
// here reaches the runner. Each CI leg runs exactly one --project, which is
// why one vector per engine is enough; a leg without --shard must not set the
// variable at all, because weights without a shard are a usage error.
//
// These are measurements, not preferences: adding tests to a heavy file, or
// splitting one, shifts the balance. Re-measure (worker-seconds per file per
// engine from the artifacts of recent runs, min-max partitioned) before
// touching the vectors, and never hand one a shard that runs no tests.
const shardWeights = {
    chromium: [240, 221, 203, 232, 237],
    firefox: [305, 228, 306, 294],
    webkit: [121, 139, 110, 90, 99, 132, 104, 140, 89, 109],
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
