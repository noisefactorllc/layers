// Boot lands on a default solid canvas; reach the New Project chooser the way a user does.
import { defaultProjectReady } from '../waits.js'

export async function reopenNewProjectDialog(page) {
    await defaultProjectReady(page)
    // Playing the canvas being replaced starves input on CI's software GL;
    // the new project's commit restarts playback.
    const dirty = await page.evaluate(() => {
        const app = window.layersApp
        if (app._renderer.isRunning) app._togglePlayPause()
        return app._isDirty
    })
    await page.locator('#menu .hf-menubar-trigger', { hasText: 'file' }).click()
    await page.locator('#menu #newMenuItem').waitFor({ state: 'visible' })
    await page.locator('#menu #newMenuItem').click()
    if (dirty) await page.locator('.confirm-dialog-backdrop.visible #confirm-ok').click()
    await page.locator('.open-dialog-backdrop.visible').waitFor()
}
