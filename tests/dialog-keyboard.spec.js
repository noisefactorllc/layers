import { test, expect } from './fixtures.js'
import { defaultProjectReady, appState } from './waits.js'
import { pausePlayback } from './helpers/new-project.js'

const dialogs = [
    { name: 'Canvas Size', menu: 'image', item: 'canvasSizeMenuItem', selector: '.canvas-resize-dialog', input: '#canvas-resize-width', cancel: '#canvas-resize-cancel', primary: '#canvas-resize-ok' },
    { name: 'Image Size', menu: 'image', item: 'imageSizeMenuItem', selector: '.image-size-dialog', input: '#image-width', cancel: '#image-size-cancel', primary: '#image-size-ok' },
    { name: 'Selection Parameter', menu: 'select', item: 'expandSelectionMenuItem', selector: '.selection-param-dialog', input: '#selection-param-input', cancel: '#selection-param-cancel', primary: '#selection-param-ok' },
    { name: 'Export Image', menu: 'file', item: 'exportImageMenuItem', selector: '#exportImageModal', input: '#exportImageWidth', close: '#exportImageCancelBtn', primary: '#exportImageBeginBtn' },
]

test.describe.configure({ mode: 'parallel' })

async function openDialog(page, config) {
    await page.goto('/', { waitUntil: 'networkidle' })
    await defaultProjectReady(page)
    await page.evaluate(() => window.layersApp._handleCreateTransparentBase(256, 256))
    await pausePlayback(page)
    await page.evaluate(() => {
        window.layersApp._selectionManager.setSelection({
            type: 'rect', x: 100, y: 100, width: 100, height: 100,
        })
    })
    await page.locator('#menu .hf-menubar-trigger', { hasText: config.menu }).click()
    await page.locator(`#${config.item}`).click()
    await expect(page.locator(config.selector)).toBeVisible()
}

async function projectState(page) {
    return page.evaluate(() => {
        const app = window.layersApp
        const selection = app._selectionManager.selectionPath
        return {
            dimensions: [app._canvas.width, app._canvas.height],
            layers: app._layers,
            selection: selection && {
                type: selection.type, x: selection.x, y: selection.y,
                width: selection.width, height: selection.height,
            },
            exportPreferences: localStorage.getItem('layers-export-image-prefs'),
            dirty: app._isDirty,
            undoIndex: app._undoManager._index,
            undoLength: app._undoManager._stack.length,
        }
    })
}

async function tabTo(page, target, key = 'Tab') {
    for (let attempt = 0; attempt < 20; attempt++) {
        await page.keyboard.press(key)
        if (await target.evaluate(element => element === document.activeElement)) return
    }
    await expect(target).toBeFocused()
}

for (const config of dialogs) {
    for (const key of ['Enter', 'Space']) {
        for (const control of config.cancel ? ['cancel', 'close'] : ['close']) {
            test(`${config.name}: ${key} activates focused ${control} without applying edits`, async ({ page }) => {
                const downloads = []
                page.on('download', download => downloads.push(download.suggestedFilename()))
                await openDialog(page, config)
                const before = await projectState(page)
                await page.locator(config.input).fill(config.name === 'Selection Parameter' ? '10' : '640')
                const button = page.locator(control === 'cancel' ? config.cancel : (config.close || `${config.selector} .dialog-close`))
                await tabTo(page, button, control === 'close' ? 'Shift+Tab' : 'Tab')
                await expect(button).toBeFocused()
                await page.keyboard.press(key)
                await expect(page.locator(config.selector)).toBeHidden()
                await appState(page, () => !window.layersApp._projectLifecycleActive)
                expect(await projectState(page)).toEqual(before)
                expect(downloads).toEqual([])
            })
        }
    }

    for (const control of ['number field', 'primary button']) {
        test(`${config.name}: Enter on the ${control} keeps confirmation behavior`, async ({ page }) => {
            await openDialog(page, config)
            await page.locator(config.input).fill(config.name === 'Selection Parameter' ? '10' : '640')
            const download = config.name === 'Export Image' ? page.waitForEvent('download') : null
            if (control === 'primary button') await tabTo(page, page.locator(config.primary))
            await page.keyboard.press('Enter')
            await expect(page.locator(config.selector)).toBeHidden()
            await appState(page, () => !window.layersApp._projectLifecycleActive)
            if (config.name === 'Selection Parameter') {
                await appState(page, () => window.layersApp._selectionManager.selectionPath?.type === 'mask')
                expect(await page.evaluate(() => {
                    const { data } = window.layersApp._selectionManager.selectionPath
                    return data.data[(150 * data.width + 95) * 4 + 3]
                })).toBeGreaterThan(127)
            } else if (download) {
                expect((await download).suggestedFilename()).toMatch(/\.png$/)
            } else {
                expect((await projectState(page)).dimensions[0]).toBe(640)
            }
        })
    }
}

test('Canvas Size: Enter on an anchor button keeps confirmation behavior', async ({ page }) => {
    const config = dialogs[0]
    await openDialog(page, config)
    await page.locator(config.input).fill('640')
    await tabTo(page, page.locator('.canvas-resize-dialog [data-anchor="top-left"]'))
    await page.keyboard.press('Enter')
    await expect(page.locator(config.selector)).toBeHidden()
    await appState(page, () => !window.layersApp._projectLifecycleActive)
    expect((await projectState(page)).dimensions).toEqual([640, 256])
    expect(await page.evaluate(() => [window.layersApp._layers[0].offsetX, window.layersApp._layers[0].offsetY])).toEqual([192, 0])
})
