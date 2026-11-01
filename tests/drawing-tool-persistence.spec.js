import { test, expect } from './fixtures.js'
import { appReady, defaultProjectReady } from './waits.js'
import { reopenNewProjectDialog } from './helpers/new-project.js'

const STORAGE_KEY = 'layers-drawing-preferences'
const defaults = { size: '5', opacity: '100', opacityText: '100%', tolerance: '32',
    brushSize: 5, shapeSize: 2, brushOpacity: 1, shapeOpacity: 1, fillTolerance: 32, tool: 'selection' }

async function ready(page) {
    await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })
    await appReady(page)
    await defaultProjectReady(page)
}
async function boot(page) {
    await page.goto('/', { waitUntil: 'networkidle' })
    await ready(page)
}
async function project(page) {
    await reopenNewProjectDialog(page)
    await page.click('.media-option[data-type="transparent"]')
    await page.fill('#canvas-width', '128')
    await page.fill('#canvas-height', '128')
    await page.click('.canvas-size-dialog .action-btn.primary')
    await page.waitForSelector('.open-dialog-backdrop.visible', { state: 'hidden' })
}
async function reload(page) {
    await page.reload({ waitUntil: 'networkidle' })
    await ready(page)
}
async function state(page) {
    return page.evaluate(() => {
        const app = window.layersApp
        return { size: document.getElementById('drawingSizeInput').value,
            opacity: document.getElementById('drawingOpacityInput').value,
            opacityText: document.getElementById('drawingOpacityValue').textContent,
            tolerance: document.getElementById('drawingToleranceInput').value,
            brushSize: app._brushTool.size, shapeSize: app._shapeTool.size,
            brushOpacity: app._brushTool.opacity, shapeOpacity: app._shapeTool.opacity,
            fillTolerance: app._fillTool.tolerance, tool: app._currentTool }
    })
}
async function range(page, id, value) {
    await page.locator(id).evaluate((el, value) => {
        el.value = String(value)
        el.dispatchEvent(new Event('input', { bubbles: true }))
    }, value)
}
async function choose(page) {
    await page.click('#brushToolBtn')
    await page.fill('#drawingSizeInput', '42')
    await page.dispatchEvent('#drawingSizeInput', 'change')
    await range(page, '#drawingOpacityInput', 37)
    await page.click('#fillToolBtn')
    await range(page, '#drawingToleranceInput', 96)
}

const chosen = { size: '42', opacity: '37', opacityText: '37%', tolerance: '96',
    brushSize: 42, shapeSize: 42, brushOpacity: 0.37, shapeOpacity: 0.37, fillTolerance: 96, tool: 'fill' }

test('chosen drawing preferences restore every consumer without restoring the active tool', async ({ page }) => {
    await boot(page); await project(page); await choose(page)
    const before = await state(page)
    expect(before).toEqual(chosen)
    await reload(page)
    expect(await state(page)).toEqual({ ...before, tool: 'selection' })
})

test('a fresh profile retains the existing field and tool defaults', async ({ page }) => {
    await boot(page)
    expect(await state(page)).toEqual(defaults)
})

test('choosing only opacity leaves size and tolerance defaults untouched after reload', async ({ page }) => {
    await boot(page); await project(page); await page.click('#brushToolBtn')
    await range(page, '#drawingOpacityInput', 37)
    await reload(page)
    expect(await state(page)).toEqual({ ...defaults, opacity: '37', opacityText: '37%',
        brushOpacity: 0.37, shapeOpacity: 0.37 })
})

for (const [key, brushSize, shapeSize] of [[']', 10, 7], ['[', 1, 1]]) {
    test(`the ${key} size shortcut restores its exact existing consumer values`, async ({ page }) => {
        await boot(page); await project(page); await page.click('#brushToolBtn')
        await page.keyboard.press(key)
        const before = await state(page)
        expect(before).toEqual({ ...defaults, size: String(brushSize), brushSize, shapeSize, tool: 'brush' })
        await reload(page)
        expect(await state(page)).toEqual({ ...before, tool: 'selection' })
    })
}

test('malformed preferences retain defaults and subsequent real choices still persist', async ({ page }) => {
    await page.addInitScript(key => {
        if (localStorage.getItem(key) === null) localStorage.setItem(key, '{')
    }, STORAGE_KEY)
    await boot(page)
    expect(await state(page)).toEqual(defaults)
    await project(page); await choose(page)
    await reload(page)
    expect(await state(page)).toEqual({ ...chosen, tool: 'selection' })
})

test('invalid stored consumer values leave their defaults while valid partial values restore', async ({ page }) => {
    await page.addInitScript(({ key, value }) => localStorage.setItem(key, JSON.stringify(value)), {
        key: STORAGE_KEY, value: { size: { brush: 42, shape: -3 }, opacity: 101, tolerance: '96' },
    })
    await boot(page)
    expect(await state(page)).toEqual({ ...defaults, size: '42', brushSize: 42 })
})

test('unavailable preference storage does not block choices or change fresh defaults on reload', async ({ page }) => {
    await page.addInitScript(key => {
        for (const name of ['getItem', 'setItem']) {
            const original = Storage.prototype[name]
            Storage.prototype[name] = function(candidate, ...args) {
                if (candidate === key) throw new DOMException('Storage unavailable', 'SecurityError')
                return original.call(this, candidate, ...args)
            }
        }
    }, STORAGE_KEY)
    await boot(page); await project(page); await choose(page)
    expect(await state(page)).toEqual(chosen)
    await reload(page)
    expect(await state(page)).toEqual(defaults)
})
