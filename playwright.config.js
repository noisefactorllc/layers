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
    // A whole-run ceiling. The suite takes 80 to 100 minutes across three
    // browsers; anything past two hours is wedged rather than slow, and this
    // turns that into a Playwright failure with a report instead of a job that
    // sits until GitHub's six hour default kills it silently.
    globalTimeout: process.env.CI ? 2 * 60 * 60 * 1000 : 0,
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
