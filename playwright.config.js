import { defineConfig } from 'playwright/test'

// Shard sizes, one vector per engine, expressed as the number of tests each
// shard should carry. Playwright's default shard split divides the suite by
// test count alone, and test counts are a poor proxy for cost: collaboration
// (18 tests) took 431 worker-seconds on webkit while 29 tests of agent
// validation took 37. To give the sharding finer grain, the seven heaviest
// spec files are split into balanced -a/-b halves at test boundaries (tests
// unchanged; worker-seconds re-measured per half from the CI artifacts), so
// shards can pack halves of the big files separately. The vectors below
// minimize the worst predicted test step over the eleven green runs on main
// measured so far (37097762272 at f537250; 37101997646 at ca6a404;
// 37107393719 at 49a639a; 37110907758 at 7bf0824; 37146215821 at f14c52d;
// 37181219087 at 42a61cd; 37186286571 at 46d47ad; 37205985800 at bae8d33;
// 37209658207 at 56e1f96; 37212362193 at cc70181; and 37217268294 at
// 41d9bec), where a shard's step
// is predicted from that run's own per-file worker-seconds as S/workers plus,
// on the two-worker engines, the largest file's share again, because it
// starts last and runs alone (run 37209658207 chromium 5/5: predicted 1165 s
// this way, 1148 s actual; run 37212362193 chromium 3/5: predicted 1155 s,
// 1156 s actual; webkit runs one worker, so its step is just its
// worker-seconds plus about nine seconds of startup).
// Minimizing the worst measured window rather than a per-file envelope
// matters: an envelope overstates, because no single run was slowest on
// every file at once. History, for why single-run splits are avoided: a
// first split measured against a single run put webkit 8/10 and chromium
// 5/5 within seconds of the cap in the next run, which executed the same
// files up to 1.6x slower, a second left webkit 9/10 at 1129 s, a third
// left chromium 1/5 at 1090 s, a fourth left chromium 5/5 at 1130 s and a
// fifth left firefox 4/4 at 1176 s. These vectors predict, on the eleven
// measured windows, worst steps of 1118 s (chromium), 1087 s (firefox; its
// heaviest measured window 201 is about 8% over its window average) and
// 1035 s (webkit) for the best split there is at these shard counts with
// this file inventory; actual steps have been observed up to about 120 s
// under the prediction, so windows remain a draw. Chromium's floor is its
// total worker-seconds divided by ten worker-slots, about 1024 s at the
// heaviest measured totals, and its cross-window variance adds about 90 s
// more at the best granularity this inventory reaches: past the point these
// vectors already sit at, only more shards move it.
// Playwright reads these
// through PWTEST_SHARD_WEIGHTS after this config is imported, so setting it
// here reaches the runner. Each CI leg runs exactly one --project, which is
// why one vector per engine is enough; a leg without --shard must not set the
// variable at all, because weights without a shard are a usage error.
//
// These are measurements, not preferences: adding tests to a heavy file, or
// splitting one, shifts the balance. Re-measure (worker-seconds per file per
// engine from the artifacts of recent runs, worst observed window
// minimized) before
// touching the vectors, and never hand one a shard that runs no tests.
const shardWeights = {
    chromium: [240, 221, 207, 232, 238],
    firefox: [305, 247, 291, 295],
    webkit: [121, 139, 127, 91, 82, 135, 104, 140, 89, 110],
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
