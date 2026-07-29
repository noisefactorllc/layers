import { test, expect } from 'playwright/test'

async function openFileMenuItem(page, menuItemId) {
    await page.locator('#menu .hf-menubar-trigger', { hasText: 'file' }).click()
    await page.locator(`#menu #${menuItemId}`).waitFor({ state: 'visible' })
    await page.locator(`#menu #${menuItemId}`).click()
}

async function createSolidProject(page) {
    await page.waitForSelector('.open-dialog-backdrop.visible')
    await page.click('.media-option[data-type="solid"]')
    await page.waitForSelector('.canvas-size-dialog', { timeout: 5000 })
    await page.click('.canvas-size-dialog .action-btn.primary')
    await page.waitForSelector('.open-dialog-backdrop.visible', { state: 'hidden', timeout: 5000 })
    await page.waitForTimeout(1000)
}

async function dismissConfirmDialog(page) {
    const confirmDialog = page.locator('.confirm-dialog-backdrop.visible')
    if (await confirmDialog.isVisible({ timeout: 500 }).catch(() => false)) {
        await page.click('.confirm-dialog .action-btn.danger')
        await confirmDialog.waitFor({ state: 'hidden' })
    }
}

async function openMenuItemWithConfirm(page, menuItemId) {
    await openFileMenuItem(page, menuItemId)
    await dismissConfirmDialog(page)
}

test.describe('Open dialog close behavior', () => {
    test('open dialog cannot be closed at startup (no active project)', async ({ page }) => {
        await page.goto('/', { waitUntil: 'networkidle' })
        await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })

        const backdrop = page.locator('.open-dialog-backdrop.visible')
        await expect(backdrop).toBeVisible()

        // Close button should NOT be visible (no active project)
        await expect(page.locator('.open-dialog .dialog-close')).toBeHidden()

        // Clicking backdrop should NOT close the dialog
        await backdrop.click({ position: { x: 10, y: 10 } })
        await expect(backdrop).toBeVisible()

        // ESC should NOT close the dialog
        await page.keyboard.press('Escape')
        await expect(backdrop).toBeVisible()
    })

    test('open dialog can be closed from File > Open menu (has active project)', async ({ page }) => {
        await page.goto('/', { waitUntil: 'networkidle' })
        await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })
        await createSolidProject(page)

        await openMenuItemWithConfirm(page, 'openMenuItem')

        const backdrop = page.locator('.open-dialog-backdrop.visible')
        await expect(backdrop).toBeVisible({ timeout: 5000 })

        // Close button SHOULD be visible (has active project)
        const closeBtn = page.locator('.open-dialog .dialog-close')
        await expect(closeBtn).toBeVisible()

        await closeBtn.click()
        await expect(backdrop).toBeHidden()
    })

    test('open dialog can be closed via backdrop click when has active project', async ({ page }) => {
        await page.goto('/', { waitUntil: 'networkidle' })
        await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })
        await createSolidProject(page)

        await openMenuItemWithConfirm(page, 'openMenuItem')

        const backdrop = page.locator('.open-dialog-backdrop.visible')
        await expect(backdrop).toBeVisible({ timeout: 5000 })

        await backdrop.click({ position: { x: 10, y: 10 } })
        await expect(backdrop).toBeHidden()
    })

    test('open dialog can be closed via ESC when has active project', async ({ page }) => {
        await page.goto('/', { waitUntil: 'networkidle' })
        await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })
        await createSolidProject(page)

        await openMenuItemWithConfirm(page, 'openMenuItem')

        const backdrop = page.locator('.open-dialog-backdrop.visible')
        await expect(backdrop).toBeVisible({ timeout: 5000 })

        await page.keyboard.press('Escape')
        await expect(backdrop).toBeHidden()
    })

    test('open dialog CAN be closed after File > New (project not reset until selection)', async ({ page }) => {
        await page.goto('/', { waitUntil: 'networkidle' })
        await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })
        await createSolidProject(page)

        await openMenuItemWithConfirm(page, 'newMenuItem')

        const backdrop = page.locator('.open-dialog-backdrop.visible')
        await expect(backdrop).toBeVisible({ timeout: 5000 })

        // Close button SHOULD be visible (project still exists until user selects something)
        await expect(page.locator('.open-dialog .dialog-close')).toBeVisible()

        await page.keyboard.press('Escape')
        await expect(backdrop).toBeHidden()
    })

    test('Escape closes the required Canvas Size dialog before the replacement backdrop', async ({ page }) => {
        await page.goto('/', { waitUntil: 'networkidle' })
        await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })
        await createSolidProject(page)

        await openMenuItemWithConfirm(page, 'newMenuItem')
        const backdrop = page.locator('.open-dialog-backdrop.visible')
        await backdrop.locator('.media-option[data-type="solid"]').click()
        const sizeDialog = page.locator('.canvas-size-dialog[open]')
        await expect(sizeDialog).toBeVisible()

        await page.keyboard.press('Escape')

        await expect(sizeDialog).toBeHidden()
        await expect(backdrop).toBeVisible()
    })
})
