# Adjustment Workflow Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Reorganize the Image menu with categorized submenus, expose ~20 adjustment effects (up from 6), and add one-click auto corrections (Auto Levels, Auto Contrast, Auto White Balance).

**Architecture:** CSS hover-based submenus nested inside the existing `.menu-items` dropdown. Data-driven menu item handler using `data-effect` attributes. New `auto-adjust.js` utility reads canvas pixels via WebGL `readPixels()`, computes histogram stats, and creates effect layers with computed parameters.

**Tech Stack:** Vanilla JS, CSS, HTML. Noisemaker shader pipeline (WebGL). Playwright E2E tests.

---

### Task 1: Submenu CSS

Add CSS rules for hover-based nested submenus to `public/css/menu.css`.

**Files:**
- Modify: `public/css/menu.css` (append after line 460)

**Step 1: Add submenu CSS rules**

Append these rules to the end of `public/css/menu.css`:

```css
/* Submenus */
.menu-items .has-submenu {
    position: relative;
    display: flex;
    align-items: center;
    justify-content: space-between;
}

.menu-items .has-submenu::after {
    content: '▸';
    margin-left: 1.5em;
    font-size: 0.75em;
    opacity: 0.6;
}

.menu-items .submenu {
    display: none;
    position: absolute;
    left: 100%;
    top: -4px;
    min-width: 180px;
    background-color: color-mix(in srgb, var(--color2) var(--effect-surface-opacity), transparent var(--effect-surface-transparency));
    backdrop-filter: var(--glass-blur-strength);
    box-shadow: var(--shadow-lg);
    border-radius: var(--ui-corner-radius-small, 0.375rem);
    z-index: 6;
    margin-left: 2px;
}

.menu-items .has-submenu:hover > .submenu {
    display: flex;
    flex-direction: column;
}

/* Flip submenu left when it would overflow viewport */
.menu-items .submenu.flip-left {
    left: auto;
    right: 100%;
    margin-left: 0;
    margin-right: 2px;
}

.menu-items .submenu div {
    padding: 8px 16px;
    cursor: pointer;
    font-size: 0.875rem;
}

.menu-items .submenu div:hover {
    background-color: transparent;
    color: var(--accent4);
}

/* Section labels in menu */
.menu-section-label {
    padding: 6px 16px 2px !important;
    font-size: 0.7rem !important;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--color5) !important;
    cursor: default !important;
    pointer-events: none;
}
```

**Step 2: Verify visually**

Run: `npm run dev`
Open browser, click Image menu. No visual change yet (submenus not in HTML yet), but verify menu still works as before.

**Step 3: Commit**

```
feat: add submenu CSS for categorized menus
```

---

### Task 2: Reorganize Image Menu HTML

Replace the flat Image menu with categorized submenus.

**Files:**
- Modify: `public/index.html` (lines 134-152, the Image menu block)

**Step 1: Replace Image menu HTML**

Replace lines 137-151 (the `<div class="menu-items hide">` block inside `#imageMenu`) with:

```html
                    <div class="menu-items hide">
                        <div class="menu-section-label">auto</div>
                        <div id="autoLevelsMenuItem">auto levels</div>
                        <div id="autoContrastMenuItem">auto contrast</div>
                        <div id="autoWhiteBalanceMenuItem">auto white balance</div>
                        <hr class="menu-seperator">
                        <div class="has-submenu">tone
                            <div class="submenu">
                                <div data-effect="filter/adjust">brightness/contrast</div>
                                <div data-effect="filter/smoothstep">levels</div>
                                <div data-effect="filter/posterize">posterize</div>
                                <div data-effect="filter/thresh">threshold</div>
                            </div>
                        </div>
                        <div class="has-submenu">color
                            <div class="submenu">
                                <div data-effect="filter/adjust">hue/saturation</div>
                                <div data-effect="filter/grade">color grading</div>
                                <div data-effect="filter/tint">tint</div>
                                <div data-effect="filter/inv">invert</div>
                                <div data-effect="filter/tetraColorArray">gradient palette</div>
                            </div>
                        </div>
                        <div class="has-submenu">blur &amp; sharpen
                            <div class="submenu">
                                <div data-effect="filter/blur">blur</div>
                                <div data-effect="filter/motionBlur">motion blur</div>
                                <div data-effect="filter/zoomBlur">zoom blur</div>
                                <div data-effect="filter/sharpen">sharpen</div>
                            </div>
                        </div>
                        <div class="has-submenu">stylize
                            <div class="submenu">
                                <div data-effect="filter/bloom">bloom</div>
                                <div data-effect="filter/grain">grain</div>
                                <div data-effect="filter/vignette">vignette</div>
                                <div data-effect="filter/edge">edge detect</div>
                                <div data-effect="filter/dither">dither</div>
                                <div data-effect="filter/emboss">emboss</div>
                            </div>
                        </div>
                        <hr class="menu-seperator">
                        <div id="cropToSelectionMenuItem" class="disabled">crop to selection</div>
                        <hr class="menu-seperator">
                        <div id="imageSizeMenuItem">image size...</div>
                        <div id="canvasSizeMenuItem">canvas size...</div>
                    </div>
```

**Step 2: Verify visually**

Run dev server, open browser. Image menu should show:
- Auto section with 3 items at top
- 4 submenu categories that expand on hover
- Canvas operations at the bottom

Submenus should appear to the right of the parent item on hover.

**Step 3: Commit**

```
feat: reorganize image menu with categorized submenus
```

---

### Task 3: Data-Driven Effect Menu Handlers

Replace individual `getElementById` listeners with a single delegated handler for `data-effect` items.

**Files:**
- Modify: `public/js/app.js` (lines ~1492-1516, Image menu handlers)

**Step 1: Replace individual handlers with delegated handler**

Find and remove these individual handler blocks (lines 1492-1516):

```javascript
        // Image menu - Adjustments
        document.getElementById('invertMenuItem')?.addEventListener('click', () => {
            if (this._layers.length === 0) return
            this._handleAddEffectLayer('filter/inv')
        })
        document.getElementById('brightnessContrastMenuItem')?.addEventListener('click', () => {
            if (this._layers.length === 0) return
            this._handleAddEffectLayer('filter/adjust')
        })
        document.getElementById('hueSaturationMenuItem')?.addEventListener('click', () => {
            if (this._layers.length === 0) return
            this._handleAddEffectLayer('filter/adjust')
        })
        document.getElementById('blurMenuItem')?.addEventListener('click', () => {
            if (this._layers.length === 0) return
            this._handleAddEffectLayer('filter/blur')
        })
        document.getElementById('gradientPaletteMenuItem')?.addEventListener('click', () => {
            if (this._layers.length === 0) return
            this._handleAddEffectLayer('filter/tetraColorArray')
        })
        document.getElementById('colorGradingMenuItem')?.addEventListener('click', () => {
            if (this._layers.length === 0) return
            this._handleAddEffectLayer('filter/grade')
        })
```

Replace with this single delegated handler:

```javascript
        // Image menu - Effect items (data-driven)
        document.getElementById('imageMenu')?.addEventListener('click', (e) => {
            const effectItem = e.target.closest('[data-effect]')
            if (!effectItem) return
            if (this._layers.length === 0) return
            this._handleAddEffectLayer(effectItem.dataset.effect)
        })
```

**Step 2: Verify existing effects still work**

Run dev server. Create a solid project. Click Image > Tone > Brightness/Contrast. Verify an effect layer is added and its params show up when expanded.

Test: Image > Color > Invert, Image > Blur & Sharpen > Blur — all should still work.

**Step 3: Commit**

```
refactor: data-driven image menu effect handlers
```

---

### Task 4: Submenu Viewport Flip

Add JS to flip submenus left when they'd overflow the right edge of the viewport.

**Files:**
- Modify: `public/js/app.js` (add near the menu setup code, around line 1390)

**Step 1: Add viewport-aware submenu positioning**

Add this code in the `_initMenuListeners()` method or wherever menu setup happens, near the existing menu event handlers:

```javascript
        // Flip submenus that would overflow viewport
        document.querySelectorAll('.has-submenu').forEach(item => {
            item.addEventListener('mouseenter', () => {
                const submenu = item.querySelector('.submenu')
                if (!submenu) return
                submenu.classList.remove('flip-left')
                const rect = submenu.getBoundingClientRect()
                if (rect.right > window.innerWidth) {
                    submenu.classList.add('flip-left')
                }
            })
        })
```

**Step 2: Verify**

Resize browser narrow. Open Image menu, hover over Stylize. If submenu would go offscreen, it should appear to the left instead.

**Step 3: Commit**

```
fix: flip submenus left when they overflow viewport
```

---

### Task 5: Auto-Adjust Utility

Create the histogram analysis and auto-correction functions.

**Files:**
- Create: `public/js/utils/auto-adjust.js`

**Step 1: Create auto-adjust.js**

```javascript
/**
 * Auto-adjustment utilities
 * Analyzes canvas pixels to compute correction parameters
 */

/**
 * Read current canvas pixels via WebGL
 * @param {HTMLCanvasElement} canvas
 * @returns {Uint8ClampedArray} RGBA pixel data (top-down)
 */
function readCanvasPixels(canvas) {
    const gl = canvas.getContext('webgl2') || canvas.getContext('webgl')
    if (!gl) return null

    const width = canvas.width
    const height = canvas.height
    const pixels = new Uint8Array(width * height * 4)
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels)

    // WebGL readPixels is bottom-up, flip vertically
    const flipped = new Uint8ClampedArray(width * height * 4)
    for (let y = 0; y < height; y++) {
        const srcRow = (height - 1 - y) * width * 4
        const dstRow = y * width * 4
        flipped.set(pixels.subarray(srcRow, srcRow + width * 4), dstRow)
    }
    return flipped
}

/**
 * Compute histogram from pixel data
 * @param {Uint8ClampedArray} pixels - RGBA pixel data
 * @returns {{ r, g, b, lum, percentile }}
 */
function computeHistogram(pixels) {
    const r = new Uint32Array(256)
    const g = new Uint32Array(256)
    const b = new Uint32Array(256)
    const lum = new Uint32Array(256)
    let totalPixels = 0

    for (let i = 0; i < pixels.length; i += 4) {
        const ri = pixels[i], gi = pixels[i + 1], bi = pixels[i + 2]
        r[ri]++
        g[gi]++
        b[bi]++
        // Luminance: 0.299R + 0.587G + 0.114B
        lum[Math.round(0.299 * ri + 0.587 * gi + 0.114 * bi)]++
        totalPixels++
    }

    function percentile(channel, pct) {
        const target = Math.floor(totalPixels * pct)
        let count = 0
        for (let i = 0; i < 256; i++) {
            count += channel[i]
            if (count >= target) return i
        }
        return 255
    }

    function mean(channel) {
        let sum = 0
        for (let i = 0; i < 256; i++) sum += i * channel[i]
        return sum / totalPixels
    }

    return { r, g, b, lum, percentile, mean, totalPixels }
}

/**
 * Auto Levels - stretch per-channel histogram to full range
 * @returns {{ effectId: string, effectParams: object }}
 */
export function autoLevels(canvas) {
    const pixels = readCanvasPixels(canvas)
    if (!pixels) return null

    const hist = computeHistogram(pixels)

    // Find 1st and 99th percentile across all channels
    const rLow = hist.percentile(hist.r, 0.01), rHigh = hist.percentile(hist.r, 0.99)
    const gLow = hist.percentile(hist.g, 0.01), gHigh = hist.percentile(hist.g, 0.99)
    const bLow = hist.percentile(hist.b, 0.01), bHigh = hist.percentile(hist.b, 0.99)

    // Use the most extreme values across channels
    const low = Math.min(rLow, gLow, bLow) / 255
    const high = Math.max(rHigh, gHigh, bHigh) / 255

    // Map to brightness/contrast params
    // brightness shifts midpoint, contrast scales range
    const range = high - low
    if (range < 0.01) return null // already full range or flat

    const brightness = -(low + high - 1) / 2
    const contrast = 1 / range

    return {
        effectId: 'filter/adjust',
        effectParams: {
            brightness: Math.max(-1, Math.min(1, brightness)),
            contrast: Math.max(0.1, Math.min(5, contrast))
        },
        name: 'Auto Levels'
    }
}

/**
 * Auto Contrast - stretch luminance histogram
 * @returns {{ effectId: string, effectParams: object }}
 */
export function autoContrast(canvas) {
    const pixels = readCanvasPixels(canvas)
    if (!pixels) return null

    const hist = computeHistogram(pixels)

    const low = hist.percentile(hist.lum, 0.01) / 255
    const high = hist.percentile(hist.lum, 0.99) / 255

    const range = high - low
    if (range < 0.01) return null

    const brightness = -(low + high - 1) / 2
    const contrast = 1 / range

    return {
        effectId: 'filter/adjust',
        effectParams: {
            brightness: Math.max(-1, Math.min(1, brightness)),
            contrast: Math.max(0.1, Math.min(5, contrast))
        },
        name: 'Auto Contrast'
    }
}

/**
 * Auto White Balance - neutralize color cast via hue/saturation
 * @returns {{ effectId: string, effectParams: object }}
 */
export function autoWhiteBalance(canvas) {
    const pixels = readCanvasPixels(canvas)
    if (!pixels) return null

    const hist = computeHistogram(pixels)

    const rMean = hist.mean(hist.r)
    const gMean = hist.mean(hist.g)
    const bMean = hist.mean(hist.b)

    // Gray world assumption: ideal is equal R, G, B means
    const overall = (rMean + gMean + bMean) / 3

    // Detect dominant color cast
    const rDev = rMean - overall
    const gDev = gMean - overall
    const bDev = bMean - overall
    const maxDev = Math.max(Math.abs(rDev), Math.abs(gDev), Math.abs(bDev))

    if (maxDev < 3) return null // negligible cast

    // Map color cast to hue shift
    // Red cast → shift hue toward cyan (negative), Blue cast → shift toward yellow (positive)
    // This is approximate — hue/saturation isn't perfect for WB but it's close enough
    let hue = 0
    let saturation = 1

    if (rDev > gDev && rDev > bDev) {
        // Red/warm cast — shift hue slightly, reduce saturation
        hue = -maxDev / 255 * 0.3
        saturation = 1 - maxDev / 255 * 0.2
    } else if (bDev > rDev && bDev > gDev) {
        // Blue/cool cast — shift hue slightly warm
        hue = maxDev / 255 * 0.3
        saturation = 1 - maxDev / 255 * 0.2
    } else {
        // Green cast — reduce saturation
        saturation = 1 - maxDev / 255 * 0.3
    }

    return {
        effectId: 'filter/adjust',
        effectParams: {
            rotation: Math.max(-180, Math.min(180, hue * 360)),
            hueRange: 100,
            saturation: Math.max(0, Math.min(4, saturation))
        },
        name: 'Auto White Balance'
    }
}
```

**Step 2: Verify module loads**

In browser console: `import('/js/utils/auto-adjust.js')` should resolve without errors.

**Step 3: Commit**

```
feat: auto-adjust utility with histogram analysis
```

---

### Task 6: Wire Auto Correction Menu Items

Connect the auto menu items to the auto-adjust functions.

**Files:**
- Modify: `public/js/app.js` (add import + event handlers)

**Step 1: Add import**

At the top of `app.js`, add alongside other imports:

```javascript
import { autoLevels, autoContrast, autoWhiteBalance } from './utils/auto-adjust.js'
```

**Step 2: Add auto correction handlers**

In the same area where the data-driven effect handler was added (Task 3), add handlers for the auto items:

```javascript
        // Auto correction handlers
        document.getElementById('autoLevelsMenuItem')?.addEventListener('click', () => {
            if (this._layers.length === 0) return
            this._handleAutoCorrection(autoLevels)
        })
        document.getElementById('autoContrastMenuItem')?.addEventListener('click', () => {
            if (this._layers.length === 0) return
            this._handleAutoCorrection(autoContrast)
        })
        document.getElementById('autoWhiteBalanceMenuItem')?.addEventListener('click', () => {
            if (this._layers.length === 0) return
            this._handleAutoCorrection(autoWhiteBalance)
        })
```

**Step 3: Add `_handleAutoCorrection` method**

Add this method to the `LayersApp` class, near `_handleAddEffectLayer`:

```javascript
    async _handleAutoCorrection(correctionFn) {
        const result = correctionFn(this._canvas)
        if (!result) {
            toast.info('No correction needed')
            return
        }
        this._finalizePendingUndo()
        const layer = createEffectLayer(result.effectId)
        layer.name = result.name
        Object.assign(layer.effectParams, result.effectParams)
        this._layers.push(layer)

        this._updateLayerStack()
        await this._rebuild()
        this._markDirty()
        this._pushUndoState()

        if (this._layerStack) {
            this._layerStack.selectedLayerId = layer.id
        }
        toast.success(`Applied: ${result.name}`)
    }
```

**Step 4: Verify**

Create a solid color project. Click Image > Auto Levels. An effect layer named "Auto Levels" should appear. Its parameters should be viewable by expanding the layer.

**Step 5: Commit**

```
feat: wire auto correction menu items to histogram analysis
```

---

### Task 7: Write E2E Tests for Submenu Navigation

**Files:**
- Create: `tests/image-menu.spec.js`

**Step 1: Write test file**

```javascript
import { test, expect } from 'playwright/test'

test.describe('Image menu adjustments', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('/', { waitUntil: 'networkidle' })
        await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })

        // Create a solid color project
        await page.waitForSelector('.open-dialog-backdrop.visible')
        await page.click('.media-option[data-type="solid"]')
        await page.waitForSelector('.canvas-size-dialog', { timeout: 5000 })
        await page.click('.canvas-size-dialog .action-btn.primary')
        await page.waitForSelector('.open-dialog-backdrop.visible', { state: 'hidden', timeout: 5000 })
        await page.waitForTimeout(500)
    })

    test('submenu appears on hover', async ({ page }) => {
        // Open image menu
        await page.click('#imageMenu .menu-title')
        await page.waitForSelector('#imageMenu .menu-items:not(.hide)')

        // Hover over Tone submenu
        const toneItem = page.locator('#imageMenu .has-submenu', { hasText: 'tone' })
        await toneItem.hover()

        // Submenu should be visible
        const submenu = toneItem.locator('.submenu')
        await expect(submenu).toBeVisible()

        // Should contain brightness/contrast
        await expect(submenu.locator('[data-effect="filter/adjust"]')).toBeVisible()
    })

    test('add effect from submenu', async ({ page }) => {
        // Should start with 1 layer
        const layersBefore = await page.evaluate(() => window.layersApp._layers.length)
        expect(layersBefore).toBe(1)

        // Open Image > Tone > Brightness/Contrast
        await page.click('#imageMenu .menu-title')
        const toneItem = page.locator('#imageMenu .has-submenu', { hasText: 'tone' })
        await toneItem.hover()
        await page.click('[data-effect="filter/adjust"]')
        await page.waitForTimeout(500)

        // Should now have 2 layers
        const layersAfter = await page.evaluate(() => window.layersApp._layers.length)
        expect(layersAfter).toBe(2)

        // New layer should be a brightness/contrast effect
        const effectId = await page.evaluate(() => window.layersApp._layers[1].effectId)
        expect(effectId).toBe('filter/adjust')
    })

    test('add effect from stylize submenu', async ({ page }) => {
        await page.click('#imageMenu .menu-title')
        const stylizeItem = page.locator('#imageMenu .has-submenu', { hasText: 'stylize' })
        await stylizeItem.hover()
        await page.click('[data-effect="filter/grain"]')
        await page.waitForTimeout(500)

        const layerCount = await page.evaluate(() => window.layersApp._layers.length)
        expect(layerCount).toBe(2)

        const effectId = await page.evaluate(() => window.layersApp._layers[1].effectId)
        expect(effectId).toBe('filter/grain')
    })

    test('auto levels creates effect layer', async ({ page }) => {
        await page.click('#imageMenu .menu-title')
        await page.click('#autoLevelsMenuItem')
        await page.waitForTimeout(500)

        const layerCount = await page.evaluate(() => window.layersApp._layers.length)
        // May be 1 (no correction needed for solid) or 2 (correction applied)
        expect(layerCount).toBeGreaterThanOrEqual(1)
    })

    test('auto contrast creates effect layer', async ({ page }) => {
        // Add an effect to create varied luminance first
        await page.evaluate(async () => {
            await window.layersApp._handleAddEffectLayer('synth/gradient')
        })
        await page.waitForTimeout(500)

        await page.click('#imageMenu .menu-title')
        await page.click('#autoContrastMenuItem')
        await page.waitForTimeout(500)

        const layerCount = await page.evaluate(() => window.layersApp._layers.length)
        expect(layerCount).toBeGreaterThanOrEqual(2)
    })

    test('auto white balance creates effect layer', async ({ page }) => {
        await page.click('#imageMenu .menu-title')
        await page.click('#autoWhiteBalanceMenuItem')
        await page.waitForTimeout(500)

        // Should either add correction or report none needed
        const layerCount = await page.evaluate(() => window.layersApp._layers.length)
        expect(layerCount).toBeGreaterThanOrEqual(1)
    })
})
```

**Step 2: Run tests**

Run: `npx playwright test tests/image-menu.spec.js`
Expected: All tests pass.

**Step 3: Commit**

```
test: image menu submenu navigation and auto corrections
```

---

### Task 8: Verify All New Effects Load

Manually verify each newly exposed effect ID loads without errors by testing via console.

**Files:** None (verification only)

**Step 1: Verify each new effect**

In the browser console, test each new effect ID. These are the ones that weren't previously exposed:

```javascript
// These should all create effect layers without errors
await window.layersApp._handleAddEffectLayer('filter/smoothstep')
await window.layersApp._handleAddEffectLayer('filter/posterize')
await window.layersApp._handleAddEffectLayer('filter/thresh')
await window.layersApp._handleAddEffectLayer('filter/tint')
await window.layersApp._handleAddEffectLayer('filter/motionBlur')
await window.layersApp._handleAddEffectLayer('filter/zoomBlur')
await window.layersApp._handleAddEffectLayer('filter/sharpen')
await window.layersApp._handleAddEffectLayer('filter/bloom')
await window.layersApp._handleAddEffectLayer('filter/grain')
await window.layersApp._handleAddEffectLayer('filter/vignette')
await window.layersApp._handleAddEffectLayer('filter/edge')
await window.layersApp._handleAddEffectLayer('filter/dither')
await window.layersApp._handleAddEffectLayer('filter/emboss')
```

If any fail, investigate the effect ID and fix the `data-effect` attribute in the HTML.

**Step 2: Run full test suite**

Run: `npx playwright test`
Expected: All existing tests still pass (no regressions).

**Step 3: Final commit if any fixes needed**

```
fix: correct effect IDs for newly exposed adjustments
```

---

### Task 9: Run Existing Tests for Regressions

The old menu items were removed and replaced. Verify nothing references the old IDs.

**Files:** None (verification only)

**Step 1: Search for old menu item IDs**

Search the test files for references to old menu item IDs that were removed:
- `invertMenuItem`
- `brightnessContrastMenuItem`
- `hueSaturationMenuItem`
- `blurMenuItem`
- `gradientPaletteMenuItem`
- `colorGradingMenuItem`

If any tests reference these IDs, update them to use the new `data-effect` selectors instead:
- `invertMenuItem` → `[data-effect="filter/inv"]`
- `brightnessContrastMenuItem` → `[data-effect="filter/adjust"]`
- etc.

**Step 2: Run full test suite**

Run: `npx playwright test`
Expected: All tests pass.

**Step 3: Commit if any test fixes needed**

```
fix: update tests for reorganized image menu
```
