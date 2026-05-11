import fs from 'node:fs'
import path from 'node:path'
import { test, expect } from 'playwright/test'

const FIXTURE = path.resolve('tests/fixtures/agent-snapshot-blank.json')

async function bootBlankProject(page) {
    await page.goto('/', { waitUntil: 'networkidle' })
    await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })
    await page.evaluate(async () => { await window.LayersAgent.ready })
    await page.click('.media-option[data-type="solid"]')
    await page.waitForSelector('.canvas-size-dialog', { timeout: 5000 })
    await page.click('.canvas-size-dialog .action-btn.primary')
    await page.waitForSelector('.open-dialog-backdrop.visible', { state: 'hidden', timeout: 5000 })
    await page.waitForTimeout(300)
}

function normalize(snap) {
    // Strip non-deterministic fields. Preserve structure.
    const clone = JSON.parse(JSON.stringify(snap))
    if (Array.isArray(clone.layers)) {
        for (const l of clone.layers) {
            l.id = '<id>'
            for (const c of l.children || []) c.id = '<id>'
        }
    }
    if (Array.isArray(clone.selectedLayerIds)) {
        clone.selectedLayerIds = clone.selectedLayerIds.map(() => '<id>')
    }
    if (clone.activeLayerId) clone.activeLayerId = '<id>'
    return clone
}

test('blank-project snapshot matches golden', async ({ page }) => {
    await bootBlankProject(page)
    const snap = await page.evaluate(() => window.LayersAgent.getState())
    expect(snap.ok).toBe(true)
    const normalized = normalize(snap.state)

    if (process.env.UPDATE_GOLDEN) {
        fs.mkdirSync(path.dirname(FIXTURE), { recursive: true })
        fs.writeFileSync(FIXTURE, JSON.stringify(normalized, null, 2) + '\n')
        return
    }

    const golden = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'))
    expect(normalized).toEqual(golden)
})
