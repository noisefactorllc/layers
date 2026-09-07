import { test as base, expect } from 'playwright/test'

// WebKit's ephemeral contexts cannot persist Blob/File values in IndexedDB.
// Give each test a fresh normal profile so project storage uses the same native
// APIs as a normal browser session. An empty path asks Playwright to create and
// remove the temporary profile. No user profile or storage shim is involved.
export const test = base.extend({
    newContext: async ({ browserName, browser, playwright, video, storageState }, use) => {
        const videoMode = typeof video === 'string' ? video : video.mode
        if (videoMode !== 'off') {
            throw new Error('The Layers context fixture supports trace and screenshot artifacts; video retention needs an explicit fixture implementation.')
        }
        const contexts = []
        try {
            await use(async (options = {}) => {
                const { storageState: requestedStorageState = storageState, ...contextOptions } = options
                // Playwright Test applies the configured context/launch options,
                // timeouts, tracing, and screenshots to both public APIs.
                const context = browserName === 'webkit'
                    ? await playwright.webkit.launchPersistentContext('', contextOptions)
                    : await browser.newContext(options)
                contexts.push(context)
                if (browserName === 'webkit' && requestedStorageState) {
                    await context.setStorageState(requestedStorageState)
                }
                return context
            })
        } finally {
            const results = await Promise.allSettled(contexts.map(context => context.close()))
            const errors = results.filter(result => result.status === 'rejected').map(result => result.reason)
            if (errors.length) throw new AggregateError(errors, 'Failed to close Layers test contexts')
        }
    },
    context: async ({ newContext }, use) => {
        await use(await newContext())
    },
    page: async ({ context }, use) => {
        await use(context.pages()[0] ?? await context.newPage())
    },
})

export { expect }
