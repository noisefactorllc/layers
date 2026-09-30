# Font Selection & Fontaine Bundle Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Port the font selection dialog and fontaine bundle system from noisedeck so Layers supports 100+ curated web fonts with search, preview, and on-demand download — while still working fine with just system fonts.

**Architecture:** The `<font-select>` web component replaces the plain `<select>` dropdown for the text effect's `font` parameter. `FontaineLoader` singleton manages IndexedDB-cached font bundles. A native `<dialog>` handles the install/download flow. The app works identically with or without the bundle installed.

**Tech Stack:** Native ES modules, Web Components, IndexedDB, native `<dialog>`, JSZip (CDN-loaded on demand), Canvas 2D font rendering.

---

### Task 1: Port FontaineLoader Module

**Files:**
- Create: `public/js/layers/fontaine-loader.js`

**Step 1: Create the fontaine-loader module**

Port from `../noisedeck/app/js/ui/components/fontaineLoader.js` with these adaptations:
- Keep the same `FONTAINE_BUNDLE_URL` (`https://fonts.noisefactor.io/bundle`)
- Keep all IndexedDB logic (meta/fonts/files stores)
- Keep `install()`, `loadFromCache()`, `isInstalled()`, `clearCache()`
- Keep `registerFont()` and `registerFontByName()` (for on-demand @font-face registration)
- Keep `getAllFonts()`, `getFont()`, `getFontsByCategory()`, `getFontOptions()`
- Keep `parseStyleFromFilename()` and `getStylesForFont()` (needed for style variants)
- Remove `registerAllFonts()` — too expensive to register 100+ fonts at once; we only register on-demand
- Remove `registerFontWithStyle()` — not needed for initial port (Layers text effect doesn't have a font style param yet)
- Keep the singleton pattern: `getFontaineLoader()` export

The file should be a clean copy of the noisedeck source with the above removals. No other changes needed — the API surface is identical.

```js
// public/js/layers/fontaine-loader.js
// Port from noisedeck/app/js/ui/components/fontaineLoader.js
// Keep: all IndexedDB management, install(), loadFromCache(), isInstalled(),
//       clearCache(), registerFont(), registerFontByName(), getAllFonts(),
//       getFont(), getFontsByCategory(), getFontOptions(), parseStyleFromFilename(),
//       getStylesForFont(), getStylesForFontByName(), singleton pattern
// Remove: registerAllFonts(), registerFontWithStyle()
```

**Step 2: Verify the module loads**

Open browser console at `http://localhost:3002`, run:
```js
const { getFontaineLoader } = await import('./js/layers/fontaine-loader.js')
const loader = getFontaineLoader()
console.log(await loader.isInstalled()) // should print false
```

**Step 3: Commit**

```bash
git add public/js/layers/fontaine-loader.js
git commit -m "feat: port fontaine-loader module from noisedeck"
```

---

### Task 2: Port Font-Select Web Component

**Files:**
- Create: `public/js/layers/font-select.js`

**Step 1: Create the font-select component**

Port from `../noisedeck/app/js/ui/components/fontSelect.js` with these adaptations:

**CSS variable mapping** — The noisedeck component uses noisedeck-specific CSS variables. Remap to Layers variables:
- `var(--accent3)` → `var(--color-accent)`
- `var(--color1, #0a0e18)` → `var(--color-bg-deep)`
- `var(--color5, #98a7c8)` → `var(--color-text-muted)`
- `var(--color6, #d9deeb)` → `var(--color-text-primary)`
- `var(--color2)` → `var(--color-bg-overlay)`
- `var(--effect-surface-opacity)` / `var(--effect-surface-transparency)` → remove, use `var(--color-bg-overlay)` directly
- `var(--glass-blur-strength)` → `blur(20px)`
- `var(--ui-corner-radius)` → `var(--radius-lg)`
- `var(--ui-corner-radius-small)` → `var(--radius-sm)`
- Remove noisedeck titlebar gradient variables (`--effect-shared-accent`, `--effect-header-opacity`, etc.)
- Use Layers titlebar style: `background: linear-gradient(180deg, rgba(255,255,255,0.02) 0%, transparent 100%); border-bottom: 1px solid var(--color-border-muted);`

**Structural changes:**
- Remove `formAssociated` / `attachInternals` — not needed, effect-params handles form state
- Keep search, filtering, category grouping, tag clicking, keyboard navigation
- Keep the `<dialog>` modal pattern (already uses `showModal()`)
- Keep inline font preview (`nameSpan.style.fontFamily = opt.value`)

The component's public API stays the same:
- `setOptions(options)` — set font list
- `value` getter/setter — current selection
- Dispatches `change` event on selection

**Step 2: Verify the component renders**

Test in browser console:
```js
await import('./js/layers/font-select.js')
const fs = document.createElement('font-select')
fs.setOptions([
    { value: 'Nunito', text: 'Nunito', category: 'sans-serif' },
    { value: 'serif', text: 'serif', category: 'serif' }
])
fs.value = 'Nunito'
document.body.appendChild(fs) // should show a trigger button
```

**Step 3: Commit**

```bash
git add public/js/layers/font-select.js
git commit -m "feat: port font-select web component from noisedeck"
```

---

### Task 3: Integrate Font-Select into Effect-Params

**Files:**
- Modify: `public/js/layers/effect-params.js`

**Step 1: Add font-select import and create method**

At the top of `effect-params.js`, add the import:
```js
import './font-select.js'
import { getFontaineLoader } from './fontaine-loader.js'
```

Add a new method `_createFontSelect` after `_createDropdown`:
```js
/**
 * Create a font-select control for the font parameter
 * @private
 */
_createFontSelect(paramName, spec, currentValue) {
    const fontSelect = document.createElement('font-select')
    fontSelect.value = currentValue || spec.default || 'Nunito'

    // Build options: base fonts + fontaine fonts
    this._loadFontOptions(fontSelect)

    fontSelect.addEventListener('change', async () => {
        // Register the font if it's a fontaine font (not a base font)
        const loader = getFontaineLoader()
        if (loader.fontsLoaded) {
            await loader.registerFontByName(fontSelect.value)
        }
        this._handleValueChange(paramName, fontSelect.value, spec)
    })

    return {
        element: fontSelect,
        getValue: () => fontSelect.value,
        setValue: (v) => { fontSelect.value = v }
    }
}

/**
 * Load font options into a font-select element
 * @private
 */
async _loadFontOptions(fontSelect) {
    const BASE_FONTS = [
        { value: 'Nunito', text: 'Nunito', category: 'sans-serif', tags: ['ui'] },
        { value: 'sans-serif', text: 'sans-serif', category: 'sans-serif', tags: ['system'] },
        { value: 'serif', text: 'serif', category: 'serif', tags: ['system'] },
        { value: 'monospace', text: 'monospace', category: 'monospace', tags: ['system'] },
        { value: 'cursive', text: 'cursive', category: 'handwriting', tags: ['system'] },
        { value: 'fantasy', text: 'fantasy', category: 'display', tags: ['system'] },
    ]

    const loader = getFontaineLoader()
    const installed = await loader.isInstalled()

    if (installed) {
        await loader.loadFromCache()
        const bundleFonts = loader.getAllFonts().map(f => ({
            value: f.name,
            text: f.name,
            category: f.category || 'other',
            tags: f.tags || []
        }))
        fontSelect.setOptions([...BASE_FONTS, ...bundleFonts])
    } else {
        fontSelect.setOptions(BASE_FONTS)
    }
}
```

**Step 2: Wire up the font-select in `_createControl`**

In the `_createControl` method (line ~200), add a check before the switch statement:
```js
_createControl(paramName, spec, currentValue) {
    // Special case: font parameter gets the font-select component
    if (paramName === 'font' && spec.choices) {
        return this._createFontSelect(paramName, spec, currentValue)
    }

    const controlType = spec.ui?.control || this._inferControlType(spec)
    // ... rest unchanged
```

**Step 3: Commit**

```bash
git add public/js/layers/effect-params.js
git commit -m "feat: integrate font-select into effect-params for text layers"
```

---

### Task 4: Add Font Install Dialog

**Files:**
- Modify: `public/index.html`
- Modify: `public/css/components.css`
- Modify: `public/js/app.js`

**Step 1: Add the dialog HTML to index.html**

After the Export Image Dialog (`</dialog>` on line 378), add:

```html
<!-- Font Bundle Install Dialog -->
<dialog id="fontInstallModal" aria-labelledby="fontInstallModalTitle">
    <div class="export-modal-title">
        <span class="material-symbols-outlined" style="font-size: 18px;">font_download</span>
        <span id="fontInstallModalTitle">Install Font Bundle</span>
        <button class="export-modal-close" id="fontInstallCloseBtn">&#10005;</button>
    </div>
    <div id="fontInstallContentView" class="export-modal-content">
        <p class="font-install-description">
            Download the Fontaine font collection — 100+ curated web fonts for use in text layers. The download is approximately 140 MB and fonts are cached locally for offline use.
        </p>
        <div class="export-button-row">
            <button class="export-btn export-btn--primary" id="fontInstallBeginBtn">Download</button>
        </div>
    </div>
    <div id="fontInstallProgressView" class="export-modal-content" style="display: none;">
        <div class="export-progress-container">
            <div class="export-progress-bar-container">
                <div class="export-progress-bar" id="fontInstallProgressBar"></div>
            </div>
            <div class="export-progress-text" id="fontInstallProgressText">Preparing...</div>
            <button class="export-progress-cancel" id="fontInstallCancelBtn">Cancel</button>
        </div>
    </div>
</dialog>
```

**Step 2: Add CSS for font install dialog**

In `public/css/components.css`, after the export dialog styles, add:

```css
/* =========================================================================
   Font Install Dialog
   ========================================================================= */

#fontInstallModal {
    min-width: 380px;
    max-width: 460px;
}

.font-install-description {
    font-size: 0.75rem;
    color: var(--color-text-muted);
    line-height: 1.5;
    margin: 0 0 0.75rem 0;
}
```

**Step 3: Wire up install dialog in app.js**

In `app.js`, import fontaine-loader at the top (near other imports):
```js
import { getFontaineLoader } from './layers/fontaine-loader.js'
```

Add a method to `LayersApp` to handle the font install flow:

```js
/**
 * Show the font bundle install dialog
 */
_showFontInstallDialog() {
    const modal = document.getElementById('fontInstallModal')
    const contentView = document.getElementById('fontInstallContentView')
    const progressView = document.getElementById('fontInstallProgressView')
    const progressBar = document.getElementById('fontInstallProgressBar')
    const progressText = document.getElementById('fontInstallProgressText')
    const beginBtn = document.getElementById('fontInstallBeginBtn')
    const cancelBtn = document.getElementById('fontInstallCancelBtn')
    const closeBtn = document.getElementById('fontInstallCloseBtn')

    // Reset to content view
    contentView.style.display = ''
    progressView.style.display = 'none'

    modal.showModal()

    const close = () => modal.close()

    closeBtn.onclick = close
    modal.onclick = (e) => { if (e.target === modal) close() }
    modal.addEventListener('cancel', (e) => { e.preventDefault(); close() }, { once: true })

    beginBtn.onclick = async () => {
        contentView.style.display = 'none'
        progressView.style.display = ''

        const loader = getFontaineLoader()

        try {
            await loader.install({
                onProgress: (percent, message) => {
                    progressBar.style.width = `${Math.min(percent, 100)}%`
                    progressText.textContent = message
                }
            })

            progressText.textContent = 'Done! Refreshing font list...'

            // Refresh any open font-select elements
            this._refreshFontSelects()

            setTimeout(close, 1000)
        } catch (err) {
            progressText.textContent = `Error: ${err.message}`
            console.error('[FontInstall] Failed:', err)
        }
    }

    cancelBtn.onclick = close
}

/**
 * Refresh all font-select elements with current font options
 */
async _refreshFontSelects() {
    const fontSelects = document.querySelectorAll('font-select')
    if (fontSelects.length === 0) return

    const loader = getFontaineLoader()
    const installed = await loader.isInstalled()

    const BASE_FONTS = [
        { value: 'Nunito', text: 'Nunito', category: 'sans-serif', tags: ['ui'] },
        { value: 'sans-serif', text: 'sans-serif', category: 'sans-serif', tags: ['system'] },
        { value: 'serif', text: 'serif', category: 'serif', tags: ['system'] },
        { value: 'monospace', text: 'monospace', category: 'monospace', tags: ['system'] },
        { value: 'cursive', text: 'cursive', category: 'handwriting', tags: ['system'] },
        { value: 'fantasy', text: 'fantasy', category: 'display', tags: ['system'] },
    ]

    let options = BASE_FONTS
    if (installed) {
        await loader.loadFromCache()
        const bundleFonts = loader.getAllFonts().map(f => ({
            value: f.name,
            text: f.name,
            category: f.category || 'other',
            tags: f.tags || []
        }))
        options = [...BASE_FONTS, ...bundleFonts]
    }

    fontSelects.forEach(fs => {
        const currentValue = fs.value
        fs.setOptions(options)
        fs.value = currentValue
    })
}
```

Expose `_showFontInstallDialog` so the font-select component can trigger it. Add a global event listener in the `_setupUI()` method (or wherever event listeners are set up):

```js
// Font install dialog trigger
document.addEventListener('font-install-request', () => {
    this._showFontInstallDialog()
})
```

**Step 4: Commit**

```bash
git add public/index.html public/css/components.css public/js/app.js
git commit -m "feat: add font bundle install dialog"
```

---

### Task 5: Add "Install Fonts" Button to Font-Select

**Files:**
- Modify: `public/js/layers/font-select.js`

**Step 1: Add install button to the dropdown**

In `font-select.js`, modify `_renderDropdown()` to append an install button at the bottom when the fontaine bundle is not installed. After the options are rendered (at the end of `_renderDropdown`):

```js
// After rendering all options, add install prompt if bundle not installed
async _appendInstallPrompt(dropdownOptions) {
    const { getFontaineLoader } = await import('./fontaine-loader.js')
    const loader = getFontaineLoader()
    const installed = await loader.isInstalled()

    if (!installed) {
        const installRow = document.createElement('div')
        installRow.className = 'font-install-prompt'
        installRow.innerHTML = `
            <button class="font-install-btn" type="button">
                <span class="material-symbols-outlined" style="font-size: 16px;">font_download</span>
                Install Font Bundle (100+ fonts)
            </button>
        `
        installRow.querySelector('.font-install-btn').addEventListener('click', (e) => {
            e.stopPropagation()
            this._close()
            document.dispatchEvent(new CustomEvent('font-install-request'))
        })
        dropdownOptions.appendChild(installRow)
    }
}
```

Call `this._appendInstallPrompt(dropdownOptions)` at the end of `_renderDropdown()`.

Add CSS for the install prompt in the component styles:

```css
font-select .font-install-prompt {
    padding: 0.5rem;
    border-top: 1px solid var(--color-border-muted, rgba(255,255,255,0.1));
    text-align: center;
}

font-select .font-install-btn {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    padding: 0.375rem 0.75rem;
    background: color-mix(in srgb, var(--color-accent, #6b8aff) 20%, transparent 80%);
    border: 1px solid color-mix(in srgb, var(--color-accent, #6b8aff) 40%, transparent 60%);
    border-radius: var(--radius-sm, 4px);
    color: var(--color-text-primary, #ccc);
    font-family: Nunito, system-ui, sans-serif;
    font-size: 0.6875rem;
    font-weight: 600;
    cursor: pointer;
    transition: background 0.15s ease;
}

font-select .font-install-btn:hover {
    background: color-mix(in srgb, var(--color-accent, #6b8aff) 35%, transparent 65%);
}
```

**Step 2: Commit**

```bash
git add public/js/layers/font-select.js
git commit -m "feat: add install font bundle button to font picker"
```

---

### Task 6: Add Font Bundle Uninstall to About Dialog

**Files:**
- Modify: `public/js/ui/about-dialog.js`

**Step 1: Add font bundle info and uninstall to about dialog**

In `about-dialog.js`, import fontaine-loader:
```js
import { getFontaineLoader } from '../layers/fontaine-loader.js'
```

In the `_createDialog()` method, after the noisemaker version line, add a font bundle row:
```html
<div class="about-modal-build font-bundle-row" style="display: none;">
    fontaine: <span class="font-bundle-info"></span>
    <button class="font-bundle-uninstall" style="margin-left: 0.5em; font-size: 0.7rem; background: none; border: 1px solid var(--color-text-muted); color: var(--color-text-muted); border-radius: 3px; padding: 0.1em 0.4em; cursor: pointer;">uninstall</button>
</div>
```

In the `show()` method, after fetching deployment metadata, check font bundle status:
```js
await this._updateFontBundleInfo()
```

Add a method:
```js
async _updateFontBundleInfo() {
    const loader = getFontaineLoader()
    const installed = await loader.isInstalled()
    const row = this._dialog?.querySelector('.font-bundle-row')
    if (!row) return

    if (installed) {
        await loader.loadFromCache()
        const info = loader.getVersionInfo()
        row.style.display = ''
        row.querySelector('.font-bundle-info').textContent = `${info.totalFonts} fonts (v${info.installed})`

        row.querySelector('.font-bundle-uninstall').onclick = async () => {
            if (confirm('Uninstall the font bundle? You can reinstall it from the text effect font picker.')) {
                await loader.clearCache()
                row.style.display = 'none'
                // Refresh any open font-selects
                document.dispatchEvent(new CustomEvent('font-bundle-changed'))
            }
        }
    } else {
        row.style.display = 'none'
    }
}
```

In `app.js`, listen for the `font-bundle-changed` event and call `_refreshFontSelects()`:
```js
document.addEventListener('font-bundle-changed', () => {
    this._refreshFontSelects()
})
```

**Step 2: Commit**

```bash
git add public/js/ui/about-dialog.js public/js/app.js
git commit -m "feat: add font bundle info and uninstall to about dialog"
```

---

### Task 7: Register Fontaine Fonts Before Text Rendering

**Files:**
- Modify: `public/js/noisemaker/renderer.js`

**Step 1: Register font before rendering text**

The renderer's `_renderTextCanvas()` method renders text using `ctx.font`. When a fontaine font is selected, we need to ensure it's registered before rendering. In renderer.js, find `_renderTextCanvas()` and add font registration at the start:

```js
// At the top of _renderTextCanvas or in updateTextParams:
const baseFonts = new Set(['Nunito', 'sans-serif', 'serif', 'monospace', 'cursive', 'fantasy'])
if (!baseFonts.has(font)) {
    // Dynamically import and register the font
    try {
        const { getFontaineLoader } = await import('../layers/fontaine-loader.js')
        const loader = getFontaineLoader()
        if (loader.fontsLoaded) {
            await loader.registerFontByName(font)
        }
    } catch (e) {
        // Fall back silently — browser will use fallback font
    }
}
```

Note: `_renderTextCanvas` may need to become async, or the registration should happen in `updateTextParams()` which is already called when params change. Check the exact call site and ensure async is handled properly.

**Step 2: Commit**

```bash
git add public/js/noisemaker/renderer.js
git commit -m "feat: register fontaine fonts before text canvas rendering"
```

---

### Task 8: Write E2E Tests

**Files:**
- Create: `tests/font-select.spec.js`

**Step 1: Write tests for font-select component**

```js
// tests/font-select.spec.js
import { test, expect } from '@playwright/test'

test.describe('Font Select', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('/')
        await page.waitForSelector('#loading-screen', { state: 'hidden' })
        // Create a solid base layer
        await page.click('.media-option[data-type="solid"]')
        await page.click('.action-btn.primary')
    })

    test('text layer shows font-select component', async ({ page }) => {
        // Add text layer
        await page.click('#textToolBtn')
        // Should have a font-select element in the params
        const fontSelect = page.locator('font-select')
        await expect(fontSelect).toBeVisible()
    })

    test('font-select shows base fonts', async ({ page }) => {
        await page.click('#textToolBtn')
        const fontSelect = page.locator('font-select')
        // Click to open
        await fontSelect.locator('.select-trigger').click()
        // Should see Nunito in the options
        const nunitoOption = page.locator('.option[data-value="Nunito"]')
        await expect(nunitoOption).toBeVisible()
    })

    test('font-select changes font parameter', async ({ page }) => {
        await page.click('#textToolBtn')
        const fontSelect = page.locator('font-select')
        await fontSelect.locator('.select-trigger').click()
        // Select serif
        await page.click('.option[data-value="serif"]')
        // Verify the trigger now shows serif
        await expect(fontSelect.locator('.trigger-text')).toHaveText('serif')
    })

    test('font-select shows install button when bundle not installed', async ({ page }) => {
        await page.click('#textToolBtn')
        const fontSelect = page.locator('font-select')
        await fontSelect.locator('.select-trigger').click()
        // Should have install prompt
        const installBtn = page.locator('.font-install-btn')
        await expect(installBtn).toBeVisible()
    })

    test('font-select search filters options', async ({ page }) => {
        await page.click('#textToolBtn')
        const fontSelect = page.locator('font-select')
        await fontSelect.locator('.select-trigger').click()
        // Type in search
        await page.fill('.search-input', 'mono')
        // Should show monospace, hide others
        const monoOption = page.locator('.option[data-value="monospace"]')
        await expect(monoOption).toBeVisible()
        const serifOption = page.locator('.option[data-value="serif"]')
        await expect(serifOption).not.toBeVisible()
    })
})
```

**Step 2: Run the tests**

```bash
npx playwright test tests/font-select.spec.js
```

**Step 3: Fix any failures and commit**

```bash
git add tests/font-select.spec.js
git commit -m "test: add e2e tests for font-select component"
```

---

### Task 9: Smoke Test & Polish

**Step 1: Manual smoke test checklist**

Run `npm run dev` and verify:
- [ ] Add a text layer → font-select appears instead of dropdown
- [ ] Click font-select → modal opens with search and base fonts
- [ ] Search filters fonts correctly
- [ ] Selecting a font updates the text rendering on canvas
- [ ] Install button appears at bottom of font list
- [ ] Clicking install opens the install dialog
- [ ] Close install dialog with X or click outside
- [ ] About dialog shows no font bundle row when not installed
- [ ] Default "Nunito" font still works as before

**Step 2: Run full test suite**

```bash
npm test
```

Ensure all 24 existing tests still pass (21 original + font-select tests).

**Step 3: Final commit if any fixes needed**

```bash
git add -A
git commit -m "fix: polish font-select integration"
```
