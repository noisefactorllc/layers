import { defineConfig } from 'playwright/test'

export default defineConfig({
    testDir: './tests',
    // Software-rendered browser runs include shader compilation and page
    // startup; individual assertions retain their shorter failure deadlines.
    timeout: 60000,
    forbidOnly: !!process.env.CI,
    // The full suite is about an hour across three browsers, so one timeout
    // under runner load must not throw that away. A retry that passes is still
    // reported as flaky by name (scripts/quality-reporter.mjs) so it gets fixed
    // rather than absorbed. Locally, no retries: a flake should be visible
    // while you are the one who caused it.
    retries: process.env.CI ? 2 : 0,
    // A whole-run ceiling, set against measured runtime rather than a guess.
    // Successful webkit legs have taken 78.9, 90.4, 95.5 and 100.4 minutes, so
    // the honest worst case is about 100 and webkit is two to three times
    // slower than the other two engines. Three hours is roughly 80 percent
    // headroom over that: still far below GitHub's six hour default, so a
    // genuinely wedged run fails with a Playwright report while the job is
    // alive, but far enough above real runtime that a slow runner or a growing
    // suite does not start failing legitimately. Do not tighten this without
    // re-measuring; a ceiling set just above the observed maximum produces
    // exactly the phantom failures it was meant to catch.
    globalTimeout: process.env.CI ? 3 * 60 * 60 * 1000 : 0,
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
        { name: 'chromium', use: { browserName: 'chromium' } },
        { name: 'firefox', use: { browserName: 'firefox' } },
        { name: 'webkit', use: { browserName: 'webkit' } },
    ],
    webServer: {
        command: 'npm run dev',
        url: 'http://localhost:3002',
        reuseExistingServer: !process.env.CI,
    },
})
