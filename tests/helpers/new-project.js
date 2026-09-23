// Boot lands on a default solid canvas; reach the New Project chooser the way a user does.
import { defaultProjectReady } from '../waits.js'

// Playing a canvas the test is about to replace starves input on CI's
// software GL; every project commit restarts playback.
export async function pausePlayback(page) {
    await page.evaluate(() => {
        const app = window.layersApp
        if (app._renderer.isRunning) app._togglePlayPause()
    })
}

export async function reopenNewProjectDialog(page) {
    await defaultProjectReady(page)
    await pausePlayback(page)
    await page.locator('#menu .hf-menubar-trigger', { hasText: 'file' }).click()
    await page.locator('#menu #newMenuItem').waitFor({ state: 'visible' })
    await page.locator('#menu #newMenuItem').click()
    // A dirty project raises the discard guard first; a clean one goes straight to the chooser.
    const confirm = page.locator('.confirm-dialog-backdrop.visible #confirm-ok')
    const chooser = page.locator('.open-dialog-backdrop.visible')
    await confirm.or(chooser).first().waitFor()
    if (await confirm.isVisible()) await confirm.click()
    await chooser.waitFor()
}
