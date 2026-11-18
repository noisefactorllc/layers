import { test, expect } from './fixtures.js'
import { defaultProjectReady } from './waits.js'
import { pausePlayback, reopenNewProjectDialog } from './helpers/new-project.js'

// Every hover tooltip goes through handfish: the `.tooltip` class plus
// data-title, shown in handfish's layer, which keeps it on screen and at its
// full width at the edges of the page. No element Layers renders carries a
// native title, which would add the browser's own tooltip. The color wheel's
// swatch titles are handfish's own markup, so they are left to handfish.
test.describe.configure({ mode: 'parallel' })

const nativeTitles = page => page.evaluate(() => [...document.querySelectorAll('body [title]')]
    .filter(el => el.localName !== 'iframe' && !el.closest('color-wheel'))
    .map(el => `${el.localName}.${el.className}: ${el.getAttribute('title')}`))

async function boot(page) {
    await page.goto('/', { waitUntil: 'networkidle' })
    await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })
    await defaultProjectReady(page)
    await pausePlayback(page)
}

/** Click a menu-bar item by id, through whichever menu holds it. */
async function menuItem(page, id) {
    const triggers = page.locator('#menu .hf-menubar-trigger')
    for (let i = 0; i < await triggers.count(); i++) {
        await triggers.nth(i).click()
        const item = page.locator(`#menu #${id}`)
        if (await item.isVisible()) {
            await item.click()
            return
        }
        await page.keyboard.press('Escape')
    }
    throw new Error(`No menu item #${id}`)
}

test('hover tooltips go through handfish, and no menu, dialog or layer row adds a native title', async ({ page }) => {
    await boot(page)
    expect(await nativeTitles(page)).toEqual([])
    const hand = page.locator('#handToolBtn')
    await expect(hand).toHaveAttribute('data-title', 'Hand Tool (H)')
    await expect(hand).toHaveClass(/\btooltip\b/)
    await hand.hover()
    await expect(page.locator('#hf-tooltip-layer')).toHaveText('Hand Tool (H)')

    const triggers = page.locator('#menu .hf-menubar-trigger')
    for (let i = 0; i < await triggers.count(); i++) {
        await triggers.nth(i).click()
        expect(await nativeTitles(page), `menu ${i}`).toEqual([])
        await page.keyboard.press('Escape')
    }

    await menuItem(page, 'canvasSizeMenuItem')
    await expect(page.locator('.canvas-resize-dialog .anchor-btn').first()).toBeVisible()
    await expect(page.locator('.anchor-btn[data-anchor="center"]')).toHaveAttribute('data-title', 'center')
    expect(await nativeTitles(page), 'canvas size dialog').toEqual([])
    await page.keyboard.press('Escape')

    await menuItem(page, 'addLayerMaskMenuItem')
    await expect(page.locator('.layer-mask-thumbnail').first()).toBeVisible()
    expect(await nativeTitles(page), 'layer mask').toEqual([])

    // A changed project asks before it is replaced; the helper answers, as a user would.
    await reopenNewProjectDialog(page)
    expect(await nativeTitles(page), 'new project dialog').toEqual([])
})

test('a tooltip at the edge of a small window stays on screen at its full width', async ({ page }) => {
    await page.setViewportSize({ width: 1000, height: 600 })
    await boot(page)
    // The tooltip controls nearest the left edge, the right edge and the bottom-right corner.
    const edges = await page.evaluate(() => {
        const shown = [...document.querySelectorAll('.tooltip[data-title]')].map(el => ({ el, r: el.getBoundingClientRect() }))
            .filter(({ el, r }) => r.width > 0 && r.height > 0 && r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight
                && document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)?.closest('.tooltip') === el)
        const pick = score => shown.reduce((best, c) => (score(c.r) > score(best.r) ? c : best))
        return [['left', pick(r => -r.left)], ['right', pick(r => r.right)], ['corner', pick(r => r.right + r.bottom)]].map(([edge, { el }]) => {
            el.setAttribute(`data-edge-${edge}`, '')
            return { edge, text: el.dataset.title }
        })
    })
    for (const { edge, text } of edges) {
        await page.mouse.move(500, 300)
        await page.locator(`[data-edge-${edge}]`).hover()
        const layer = page.locator('#hf-tooltip-layer')
        await expect(layer).toHaveText(text)
        const fit = await layer.evaluate(el => {
            const r = el.getBoundingClientRect()
            // The same tooltip moved to the middle of the page, then put back.
            const { left, top } = el.style
            el.style.left = `${innerWidth / 2}px`
            el.style.top = `${innerHeight / 2}px`
            const free = el.getBoundingClientRect().width
            el.style.left = left
            el.style.top = top
            return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, free, vw: document.documentElement.clientWidth, vh: innerHeight }
        })
        expect(fit.left, `${edge} "${text}": left`).toBeGreaterThanOrEqual(0)
        expect(fit.top, `${edge} "${text}": top`).toBeGreaterThanOrEqual(0)
        expect(fit.right, `${edge} "${text}": right`).toBeLessThanOrEqual(fit.vw)
        expect(fit.bottom, `${edge} "${text}": bottom`).toBeLessThanOrEqual(fit.vh)
        expect(Math.abs(fit.width - fit.free), `${edge} "${text}": width ${fit.width} at the edge, ${fit.free} away from it`).toBeLessThanOrEqual(1)
    }
})
