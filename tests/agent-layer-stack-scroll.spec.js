import { test, expect } from './fixtures.js'
import { appReady, layerCount } from './waits.js'
import { reopenNewProjectDialog } from './helpers/new-project.js'

// Layer drag edge auto-scroll lives in its own spec so these two stack-building
// tests land in a CI shard with headroom: drag-reorder.spec.js runs in a
// chromium shard that finished ~25s under the 20-minute globalTimeout cap at
// the previous green commit, and stacking these tests there pushed that shard
// over the cap (CI run 36524373883, chromium 3/5, test step 1201s). The
// agent- filename prefix is alphabetical shard placement, not scope: these
// are panel UI tests.

async function bootSmallProject(page) {
    await page.setViewportSize({ width: 1100, height: 260 })
    await page.goto('/', { waitUntil: 'networkidle' })
    await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })
    await appReady(page)
    await reopenNewProjectDialog(page)
    await page.click('.media-option[data-type="transparent"]')
    await page.waitForSelector('.canvas-size-dialog', { timeout: 5000 })
    await page.fill('#canvas-width', '128')
    await page.fill('#canvas-height', '128')
    await page.click('.canvas-size-dialog .action-btn.primary')
    await page.waitForSelector('.open-dialog-backdrop.visible', { state: 'hidden', timeout: 5000 })
    await appReady(page)
}

// Text layers are the cheapest rows the panel can build (no shader compile),
// and two of them at this viewport height overflow the list. The WebGL output
// surface budget caps stacked rendered layers well below five, so cheap rows
// and a short viewport are the honest way to build the overflow.
async function buildOverflowingStack(page) {
    const oks = await page.evaluate(async () => {
        const results = []
        for (let i = 0; i < 2; i++) {
            const env = await window.LayersAgent.addLayer({ kind: 'text', text: `Layer ${i}` })
            results.push(env.ok)
        }
        return results
    })
    expect(oks.every(Boolean)).toBe(true)
    await layerCount(page, 3)
    const overflow = await page.evaluate(() => {
        const list = document.querySelector('.layers-list')
        return list.scrollHeight - list.clientHeight
    })
    expect(overflow).toBeGreaterThan(0)
}

test.describe('Layer drag edge auto-scroll', () => {
    test('auto-scrolls the layers list while a drag hovers its bottom edge', async ({ page }) => {
        await bootSmallProject(page)
        await buildOverflowingStack(page)

        const scrolled = await page.evaluate(async () => {
            const list = document.querySelector('.layers-list')
            const stack = document.querySelector('layer-stack')
            const rect = list.getBoundingClientRect()
            stack.dispatchEvent(new DragEvent('dragover', {
                bubbles: true,
                cancelable: true,
                clientY: rect.bottom - 8,
                dataTransfer: new DataTransfer(),
            }))
            const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
            const before = list.scrollTop
            await wait(700)
            return { before, after: list.scrollTop }
        })
        // The rAF loop keeps scrolling toward the hovered bottom edge.
        expect(scrolled.after).toBeGreaterThan(scrolled.before)
        expect(scrolled.after - scrolled.before).toBeGreaterThan(10)

        // dragend must stop the loop: the position settles.
        const settled = await page.evaluate(async () => {
            const list = document.querySelector('.layers-list')
            const stack = document.querySelector('layer-stack')
            stack.dispatchEvent(new DragEvent('dragend', { bubbles: true }))
            const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
            const before = list.scrollTop
            await wait(400)
            return { before, after: list.scrollTop }
        })
        expect(settled.after).toBe(settled.before)
    })

    test('a drag pointer in the middle of the list does not scroll it', async ({ page }) => {
        await bootSmallProject(page)
        await buildOverflowingStack(page)

        const result = await page.evaluate(async () => {
            const list = document.querySelector('.layers-list')
            const stack = document.querySelector('layer-stack')
            const rect = list.getBoundingClientRect()
            stack.dispatchEvent(new DragEvent('dragover', {
                bubbles: true,
                cancelable: true,
                clientY: rect.top + rect.height / 2,
                dataTransfer: new DataTransfer(),
            }))
            const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
            await wait(700)
            return list.scrollTop
        })
        expect(result).toBe(0)
    })
})
