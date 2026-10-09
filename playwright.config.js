import { defineConfig } from 'playwright/test'

// Shard sizes, one vector per engine, expressed as the number of tests each
// shard should carry. Playwright's default shard split divides the suite by
// test count alone, and test counts are a poor proxy for cost: collaboration
// (18 tests) took 431 worker-seconds on webkit while 29 tests of agent
// validation took 37. To give the sharding finer grain, eleven heavy spec
// files are split into -a/-b files at test boundaries (tests unchanged), so
// shards can pack halves of the big files separately.
//
// The vectors below minimize the worst predicted test step over the five
// green main windows measured since the file inventory settled: 37883866720
// (b1988c2), 37887898419 (24386f5), 37890558307 (3912c72), 37905322304
// (4a8cf7f) and 37912810115 (b3cdab8), using the per-file worker-seconds
// from each window's report artifacts; the three 512-preset trimmed files
// (welcome-dialog-a/b, transform-tool) take their pre-trim shares in the
// first three windows scaled down by each file's measured post-trim share
// ratio, since those windows ran the heavier boot. 23 heavy spec files
// declare parallel mode (their cases boot their own app and share no state,
// like collaboration-a/b), so each of their cases is its own shard group.
// These vectors come from an exact min-max dynamic program over the exact
// shard boundary model of Playwright 1.63 (shards are contiguous slices of
// the suite in group order, each group placed by its first test), checked by
// randomized local search, so no split at these shard counts predicts a
// smaller worst window: 1007 s chromium, 1059 s firefox and 995 s webkit.
// The previous vectors predicted 1073/1099/1032 s over the same envelope
// and measured 1197 s (firefox 2/4) and 1201 s (webkit 4/10, killed at the
// 20-minute globalTimeout with no failing test) in run 37912810115.
//
// Step prediction: webkit runs one worker, so its step is its
// worker-seconds plus about nine seconds of startup. chromium and firefox
// run two workers, and their step is modeled as greedy in-order two-worker
// scheduling over the shard's groups. Checked against all 56 measured legs
// of the three most recent windows (each under the vectors it ran): webkit
// is near-exact (RMS 4 s), but the two-worker model underestimates real
// steps on a contended runner - median +46 s firefox, +72 s chromium (RMS
// 49 s overall, model always optimistic there). The bias comes from the
// serial in-order file schedule a single large group forces on one worker;
// the parallel-mode files above break exactly that pattern, since their
// cases interleave across both workers with only a single case as the
// tail.
//
// History, for why single-run splits are avoided: a first split measured
// against a single run put webkit 8/10 and chromium 5/5 within seconds of
// the cap in the next run, so the envelope is always taken over several
// windows, never one.
//
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
    chromium: [287, 190, 213, 219, 237],
    firefox: [287, 257, 291, 311],
    webkit: [117, 133, 134, 53, 107, 125, 102, 136, 122, 117],
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
