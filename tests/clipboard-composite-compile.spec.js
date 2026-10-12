import { test, expect } from './fixtures.js'
import { appReady, framePainted, layerCount } from './waits.js'
import { seedClipboardRead } from './helpers/clipboard.js'
import { reopenNewProjectDialog } from './helpers/new-project.js'

// Every composite goes through the engine's blendMode op. When the engine
// drops a parameter name the renderer still emits, the layer stack fails to
// compile and New from Clipboard fails to install its media. This test runs
// the clipboard path, then adds a layer so the stack must blend, and fails on
// any compile or install error the app logs.
const FAILURE_PATTERNS = [
    /Unknown argument/,
    /Recompilation failed/,
    /Compilation error/,
    /Failed to install media/
]

test('New from Clipboard then adding a layer compiles the blended stack', async ({ page }) => {
    const failures = []
    page.on('console', msg => {
        const text = msg.text()
        if (FAILURE_PATTERNS.some(pattern => pattern.test(text))) failures.push(text)
    })
    page.on('pageerror', error => failures.push(String(error)))

    await page.goto('/', { waitUntil: 'networkidle' })
    await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })
    await reopenNewProjectDialog(page)

    await seedClipboardRead(page, { width: 200, height: 100, color: 'red' })
    await page.click('.media-option[data-type="media"]')
    await page.click('#open-clipboard-btn')
    await expect(page.locator('.open-dialog-backdrop.visible')).toBeHidden({ timeout: 10000 })
    await appReady(page)
    await framePainted(page)
    expect(failures).toEqual([])

    await page.evaluate(async () => {
        const app = window.layersApp
        await app._handleAddEffectLayer('synth/solid')
        await app._rebuild()
    })
    await layerCount(page, 2)
    await framePainted(page)
    expect(failures).toEqual([])
})
