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
export function framePainted(page) {
    return page.evaluate(() => new Promise((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
    }))
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

/** A predicate over app state, for the cases these helpers do not cover. */
export function appState(page, predicate, arg = null, options = {}) {
    return page.waitForFunction(predicate, arg, { timeout: 15000, ...options })
}
