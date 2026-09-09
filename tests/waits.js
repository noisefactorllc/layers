// Waiting on conditions, not on the clock.
//
// A `waitForTimeout` is a constant standing in for work whose duration varies
// with the machine. It fails in three ways, all of which this suite has hit in
// production CI: the guess expires early and the next interaction absorbs the
// remainder until the test times out; the guess expires early and an assertion
// reads state that has not arrived, reporting a wrong value rather than a
// timeout; or the guess outlives a fixture and the test observes something that
// has already finished. Every helper here waits for the thing the next line
// actually needs, so it is as fast as the machine allows and correct on a slow
// one.
//
// Prefer, in order: an app-state predicate (appReady, layerCount, layerItem),
// a rendered frame (framePainted) when the next step reads pixels, and
// settled() only where the thing being waited for genuinely has no observable
// signal. Reach for a raw sleep never.

/** The app and its agent surface are constructed and reachable. */
export function appReady(page, options = {}) {
    return page.waitForFunction(
        () => !!window.LayersAgent && !!window.layersApp,
        null,
        { timeout: 15000, ...options },
    )
}

/** The project has exactly `count` layers. */
export function layerCount(page, count, options = {}) {
    return page.waitForFunction(
        (n) => window.layersApp?._layers?.length === n,
        count,
        { timeout: 15000, ...options },
    )
}

/** A layer with `id` exists in the model. */
export function layerPresent(page, id, options = {}) {
    return page.waitForFunction(
        (layerId) => !!window.layersApp?._layers?.some(l => l.id === layerId),
        id,
        { timeout: 15000, ...options },
    )
}

/** A layer with `id` is gone from the model. */
export function layerAbsent(page, id, options = {}) {
    return page.waitForFunction(
        (layerId) => !window.layersApp?._layers?.some(l => l.id === layerId),
        id,
        { timeout: 15000, ...options },
    )
}

/** The list row for `id` is rendered and visible. */
export function layerItem(page, id, options = {}) {
    return page.locator(`layer-item[data-layer-id="${id}"]`)
        .waitFor({ state: 'visible', timeout: 15000, ...options })
}

/** The drawing layer carries at least `count` strokes. */
export function strokeCount(page, count = 1, options = {}) {
    return page.waitForFunction(
        (n) => {
            const layer = window.layersApp?._layers?.find(l => l.sourceType === 'drawing')
            return (layer?.strokes?.length ?? 0) >= n
        },
        count,
        { timeout: 15000, ...options },
    )
}

/**
 * Two animation frames have been produced.
 *
 * The honest equivalent of "let it paint": bounded by real frames rather than
 * by wall-clock, so it costs nothing on a fast machine and still waits on a
 * slow one. Use where the next step reads pixels or measured geometry.
 */
export function framePainted(page, timeout = 15000) {
    // Bounded on purpose. A sleep fails loudly when it runs out; a wait that
    // can never finish hangs until something else kills the job, which on this
    // suite means a six hour CI run rather than a red test. If frames are not
    // being produced, say so here instead.
    return page.evaluate((ms) => new Promise((resolve, reject) => {
        const timer = setTimeout(
            () => reject(new Error(`framePainted: no animation frame within ${ms}ms`)), ms)
        requestAnimationFrame(() => requestAnimationFrame(() => {
            clearTimeout(timer)
            resolve()
        }))
    }), timeout)
}

/**
 * Any queued microtasks and one timer turn have run.
 *
 * The last resort, for a handler that genuinely exposes no observable result.
 * Still preferable to a sleep: it yields to the event loop rather than
 * guessing a duration. If you find yourself reaching for this, look once more
 * for a predicate, because one usually exists.
 */
export function settled(page) {
    return page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 0)))
}

// Every helper above is bounded: the predicate waits carry an explicit timeout
// and framePainted rejects rather than waiting forever. Keep it that way. A
// condition that cannot become true must fail, not hang.

/** A predicate over app state, for the cases these helpers do not cover. */
export function appState(page, predicate, arg = null, options = {}) {
    return page.waitForFunction(predicate, arg, { timeout: 15000, ...options })
}

/**
 * Observe for a fixed window that something does NOT happen.
 *
 * This is the one place a duration is legitimate, and it is not a readiness
 * guess: the window IS the measurement. "No sync landed within a second" has
 * no condition to wait on, because the assertion is about absence. Naming it
 * separates it from the sleeps this module exists to replace, so a reader can
 * tell a deliberate observation window from someone hoping the app has caught
 * up.
 *
 * Use it only for negative assertions, and prefer a barrier where one exists:
 * if you can make something that SHOULD propagate and wait for it to arrive,
 * that proves the channel had its chance, and it is both faster and stronger
 * than any window.
 */
export function quietWindow(page, ms) {
    return page.waitForTimeout(ms)
}

/**
 * The in-page equivalent of the helpers above, as source text.
 *
 * Some waits cannot be expressed from the Playwright side at all: a test that
 * instruments a race has to observe it from inside the same evaluate that set
 * the trap, because the thing it is waiting for is a local variable in that
 * closure. Those places kept raw `setTimeout` sleeps long after the
 * Playwright-side ones were converted, for the simple reason that a grep for
 * `waitForTimeout` cannot see them.
 *
 * Inline this at the top of such an evaluate and wait on the predicate. It
 * polls rather than sleeping a guessed duration, so it returns as soon as the
 * condition holds, and it rejects with the label when it cannot, which is the
 * property a sleep never had: an unmet condition fails the test instead of
 * silently letting the next line read a value that never arrived.
 *
 *     await page.evaluate(async () => {
 *         const until = ${IN_PAGE_UNTIL}
 *         ...
 *         await until(() => calls.length === 2, 'both writes issued')
 *     })
 *
 * Note it must be interpolated into the evaluate body, not imported: the
 * function passed to evaluate is serialized and runs in the page, where this
 * module does not exist.
 */
export const IN_PAGE_UNTIL = `(async (predicate, label, timeout = 10000) => {
    const deadline = performance.now() + timeout
    for (;;) {
        let value
        try { value = await predicate() } catch (error) { value = false }
        if (value) return value
        if (performance.now() > deadline) {
            throw new Error('timed out after ' + timeout + 'ms waiting for: ' + label)
        }
        await new Promise(resolve => requestAnimationFrame(resolve))
    }
})`
