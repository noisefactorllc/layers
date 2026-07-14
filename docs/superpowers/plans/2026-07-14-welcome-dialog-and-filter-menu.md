# Welcome Dialog + Photoshop-style Filter Menu — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (inline, autonomous per user request). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a warm first-run "Welcome to Layers" splash and restructure the effect menus into a Photoshop-style top-level `filter` menu with a selective set of the 25 new engine effects.

**Architecture:** Pure Layers-side changes. The `filter` menu is static HTML wired through the existing generic submenu-hover + a generalized effect-click delegation. The welcome dialog is a native `<dialog>` singleton (like `settings-dialog.js`) shown on first run in place of the open dialog. No engine/shader changes; no effect param/default changes.

**Tech Stack:** Vanilla ES modules, native `<dialog>`, existing `--hf-*`/`--font-*` theme tokens, Playwright.

## Global Constraints

- Engine off-limits: reference effects by string id only; no GLSL/WGSL/manifest edits.
- Protected default output untouched: no effect params/defaults/render changes.
- No push / no PR without explicit authorization.
- Effect ids must exactly match engine manifest keys (verified: all 25 new + existing exist).
- Copy/house style: lowercase menu items; Cormorant Upright (`--font-accent`) for the wordmark; burnt-orange accent `--hf-accent-3`; no emoji, no aislop.
- Run render/UI specs single-worker to avoid software-WebGL contention flake.

---

### Task 1: `filter` menu — HTML restructure + click wiring

**Files:**
- Modify: `public/index.html` (image menu trims; new `filter` menu after `select`)
- Modify: `public/js/app.js:2288` (generalize effect-click delegation to `#imageMenu` + `#filterMenu`)
- Test: `tests/filter-menu.spec.js` (new)

**Interfaces:**
- Consumes: `window.layersApp._renderer.manifest` (id→entry map), `_handleAddEffectLayer(effectId)`.
- Produces: `#filterMenu` with 8 submenus; `image` menu retains `tone`/`color` only.

- [ ] **Step 1: Write failing test** — `tests/filter-menu.spec.js`

```js
import { test, expect } from '@playwright/test'

async function bootBlank(page) {
  await page.goto('/')
  await page.locator('#loading-screen').waitFor({ state: 'hidden' })
  await page.evaluate(() => window.LayersAgent?.ready)
  const openDlg = page.locator('.open-dialog-backdrop.visible')
  if (await openDlg.count()) {
    await page.locator('.media-option[data-type="solid"]').click()
    await page.locator('.canvas-size-dialog .action-btn.primary').click()
  }
}

test('every menu data-effect resolves in the engine manifest', async ({ page }) => {
  await bootBlank(page)
  const missing = await page.evaluate(() => {
    const manifest = window.layersApp._renderer.manifest || {}
    const ids = [...document.querySelectorAll('#imageMenu [data-effect], #filterMenu [data-effect]')]
      .map(el => el.dataset.effect)
    return { count: ids.length, missing: ids.filter(id => !(id in manifest)) }
  })
  expect(missing.count).toBeGreaterThan(20)
  expect(missing.missing).toEqual([])
})

test('filter menu exposes the promoted new effects', async ({ page }) => {
  await bootBlank(page)
  const ids = await page.evaluate(() =>
    [...document.querySelectorAll('#filterMenu [data-effect]')].map(el => el.dataset.effect))
  for (const id of ['filter/oilPaint','filter/watercolor','filter/halftone','filter/spinBlur','filter/unsharpMask','filter/craquelure'])
    expect(ids).toContain(id)
})

test('clicking a filter effect adds a layer with that effectId', async ({ page }) => {
  await bootBlank(page)
  const before = await page.evaluate(() => window.layersApp._layers.length)
  await page.evaluate(() => window.layersApp._handleAddEffectLayer('filter/oilPaint'))
  await page.waitForTimeout(400)
  const after = await page.evaluate(() => ({
    n: window.layersApp._layers.length,
    ids: window.layersApp._layers.map(l => l.effectId),
  }))
  expect(after.n).toBe(before + 1)
  expect(after.ids).toContain('filter/oilPaint')
})
```

- [ ] **Step 2: Run — expect FAIL** (filter/oilPaint not in any menu; `#filterMenu` absent)

Run: `npx playwright test tests/filter-menu.spec.js --workers=1`

- [ ] **Step 3: Edit `public/index.html`** — in the `image` menu, remove the `blur & sharpen` and `stylize` `.has-submenu` rows and their two `.submenu` blocks; keep `tone`/`color`. Then insert a new `filter` menu immediately after the `select` menu's closing `</div>`:

```html
<!-- Filter Menu -->
<div class="menu" id="filterMenu">
    <div class="menu-title">filter</div>
    <div class="menu-items hide">
        <div class="has-submenu" data-submenu="blur">blur</div>
        <div class="has-submenu" data-submenu="sharpen">sharpen</div>
        <div class="has-submenu" data-submenu="pixelate">pixelate</div>
        <div class="has-submenu" data-submenu="stylize">stylize</div>
        <div class="has-submenu" data-submenu="sketch">sketch</div>
        <div class="has-submenu" data-submenu="brush-strokes">brush strokes</div>
        <div class="has-submenu" data-submenu="artistic">artistic</div>
        <div class="has-submenu" data-submenu="texture">texture</div>
    </div>
    <div class="submenu hide" data-submenu-id="blur">
        <div data-effect="filter/blur">blur</div>
        <div data-effect="filter/motionBlur">motion blur</div>
        <div data-effect="filter/zoomBlur">zoom blur</div>
        <div data-effect="filter/spinBlur">spin blur</div>
    </div>
    <div class="submenu hide" data-submenu-id="sharpen">
        <div data-effect="filter/sharpen">sharpen</div>
        <div data-effect="filter/unsharpMask">unsharp mask</div>
    </div>
    <div class="submenu hide" data-submenu-id="pixelate">
        <div data-effect="filter/halftone">halftone</div>
        <div data-effect="filter/dither">dither</div>
    </div>
    <div class="submenu hide" data-submenu-id="stylize">
        <div data-effect="filter/bloom">bloom</div>
        <div data-effect="filter/vignette">vignette</div>
        <div data-effect="filter/edge">edge detect</div>
        <div data-effect="filter/emboss">emboss</div>
        <div data-effect="filter/extrude">extrude</div>
        <div data-effect="filter/oilPaint">oil paint</div>
        <div data-effect="filter/wind">wind</div>
    </div>
    <div class="submenu hide" data-submenu-id="sketch">
        <div data-effect="filter/chrome">chrome</div>
        <div data-effect="filter/photocopy">photocopy</div>
        <div data-effect="filter/stamp">stamp</div>
    </div>
    <div class="submenu hide" data-submenu-id="brush-strokes">
        <div data-effect="filter/hatch">hatch</div>
        <div data-effect="filter/strokes">strokes</div>
    </div>
    <div class="submenu hide" data-submenu-id="artistic">
        <div data-effect="filter/watercolor">watercolor</div>
        <div data-effect="filter/plasticWrap">plastic wrap</div>
    </div>
    <div class="submenu hide" data-submenu-id="texture">
        <div data-effect="filter/grain">grain</div>
        <div data-effect="filter/craquelure">craquelure</div>
        <div data-effect="filter/mosaicTiles">mosaic tiles</div>
        <div data-effect="filter/patchwork">patchwork</div>
    </div>
</div>
```

- [ ] **Step 4: Edit `public/js/app.js:2288`** — generalize the delegation:

```js
// Image + Filter menus — effect items (data-driven)
for (const menuId of ['imageMenu', 'filterMenu']) {
    document.getElementById(menuId)?.addEventListener('click', (e) => {
        const effectItem = e.target.closest('[data-effect]')
        if (!effectItem) return
        if (this._layers.length === 0) return
        this._handleAddEffectLayer(effectItem.dataset.effect)
    })
}
```

- [ ] **Step 5: Run — expect PASS**

Run: `npx playwright test tests/filter-menu.spec.js --workers=1`

- [ ] **Step 6: Commit**

```bash
git add public/index.html public/js/app.js tests/filter-menu.spec.js
git commit -m "feat(menu): add photoshop-style filter menu; curate 16 new effects"
```

---

### Task 2: Restructure agent `CURATED_GROUPS` to mirror the menu

**Files:**
- Modify: `public/js/agent/effects.js:7-51`
- Modify: `tests/agent-effect-commands.spec.js:54-63` (update expected group ids)
- Test: extend `tests/filter-menu.spec.js` (curated ↔ menu sync)

**Interfaces:**
- Produces: `CURATED_GROUPS` with ids `tone,color,blur,sharpen,pixelate,stylize,sketch,brushStrokes,artistic,texture`, mirroring the HTML `image`+`filter` menus. `listCurated()` unchanged in shape.

- [ ] **Step 1: Add sync test to `tests/filter-menu.spec.js`**

```js
test('curated groups mirror the filter menu and all resolve', async ({ page }) => {
  await bootBlank(page)
  const res = await page.evaluate(() => {
    const env = window.LayersAgent.listCuratedEffects()
    const manifest = window.layersApp._renderer.manifest || {}
    const curatedIds = env.result.groups.flatMap(g => g.effects.map(e => e.effectId))
    const menuIds = [...document.querySelectorAll('#filterMenu [data-effect]')].map(el => el.dataset.effect)
    const curatedSet = new Set(curatedIds)
    return {
      unresolved: curatedIds.filter(id => !(id in manifest)),
      menuNotCurated: menuIds.filter(id => !curatedSet.has(id)),
    }
  })
  expect(res.unresolved).toEqual([])
  expect(res.menuNotCurated).toEqual([])   // every filter-menu effect is curated for the agent too
})
```

- [ ] **Step 2: Run — expect FAIL** (new filter-menu ids not yet in CURATED_GROUPS)

Run: `npx playwright test tests/filter-menu.spec.js --workers=1 -g "curated groups mirror"`

- [ ] **Step 3: Replace `CURATED_GROUPS` in `public/js/agent/effects.js`** with the 10-group taxonomy (tone, color, blur, sharpen, pixelate, stylize, sketch, brushStrokes, artistic, texture) — effect ids/labels exactly matching the HTML menu (see spec Part B table). tone/color unchanged from today (color adds `filter/colorReplace` to match the HTML).

- [ ] **Step 4: Update `tests/agent-effect-commands.spec.js:60`** expected ids:

```js
expect(groupNames).toEqual(expect.arrayContaining(['tone', 'color', 'blur', 'stylize', 'texture']))
```

- [ ] **Step 5: Run — expect PASS**

Run: `npx playwright test tests/filter-menu.spec.js tests/agent-effect-commands.spec.js --workers=1`

- [ ] **Step 6: Commit**

```bash
git add public/js/agent/effects.js tests/agent-effect-commands.spec.js tests/filter-menu.spec.js
git commit -m "feat(agent): mirror filter-menu taxonomy in curated groups"
```

---

### Task 3: Welcome dialog component + styles + re-open menu item

**Files:**
- Create: `public/js/ui/welcome-dialog.js`
- Modify: `public/css/components.css` (append `.welcome-dialog` block)
- Modify: `public/index.html` (logo menu `welcomeMenuItem` above `aboutMenuItem`)
- Test: `tests/welcome-dialog.spec.js` (new)

**Interfaces:**
- Produces:
  - `welcomeDialog` singleton with `init(deps)`, `show({ fallThrough })`, `hide()`.
  - `isWelcomeDismissed(): boolean` (reads `localStorage['layers-welcome-dismissed']`).
  - `deps` shape: `{ onNewCanvas(), onOpenFile(), onDismiss() }`.

- [ ] **Step 1: Write failing test** — `tests/welcome-dialog.spec.js`

```js
import { test, expect } from '@playwright/test'

async function boot(page, query = '') {
  await page.goto('/' + query)
  await page.locator('#loading-screen').waitFor({ state: 'hidden' })
  await page.evaluate(() => window.LayersAgent?.ready)
}

test('auto-shows on first run (forced), open dialog suppressed', async ({ page }) => {
  await boot(page, '?welcome=1')
  await expect(page.locator('.welcome-dialog[open]')).toBeVisible()
  expect(await page.locator('.open-dialog-backdrop.visible').count()).toBe(0)
  await expect(page.locator('.welcome-tile[data-action="new"]')).toBeVisible()
  await expect(page.locator('.welcome-tile[data-action="open"]')).toBeVisible()
})

test('"don\'t show again" persists and skips welcome next load', async ({ page }) => {
  await boot(page, '?welcome=1')
  await page.locator('#welcome-dontshow').check()
  await page.locator('.welcome-close').click()
  await boot(page, '?welcome=1')
  expect(await page.locator('.welcome-dialog[open]').count()).toBe(0)
  await expect(page.locator('.open-dialog-backdrop.visible')).toBeVisible()
})

test('closing without choosing falls through to the open dialog', async ({ page }) => {
  await boot(page, '?welcome=1')
  await page.locator('.welcome-close').click()
  await expect(page.locator('.open-dialog-backdrop.visible')).toBeVisible()
})

test('re-opens from the logo menu', async ({ page }) => {
  await boot(page, '?welcome=1')
  await page.locator('.welcome-close').click()
  await page.evaluate(() => document.getElementById('welcomeMenuItem').click())
  await expect(page.locator('.welcome-dialog[open]')).toBeVisible()
})
```

- [ ] **Step 2: Run — expect FAIL** (no welcome dialog)

Run: `npx playwright test tests/welcome-dialog.spec.js --workers=1`

- [ ] **Step 3: Create `public/js/ui/welcome-dialog.js`** (singleton; native `<dialog class="welcome-dialog">`; hero logo + Cormorant wordmark + subtitle; two `.welcome-tile[data-action]` buttons; `#welcome-dontshow` checkbox persisting `layers-welcome-dismissed` on change; `.welcome-close`; backdrop-click + Esc via native close; `_chose`/`_fallThrough` guards; `onDismiss` only when `!_chose && _fallThrough`). Reuse the 5-path layered-slabs logo SVG from `#logo`.

- [ ] **Step 4: Append `.welcome-dialog` CSS to `public/css/components.css`** — centered ~480px, glassy (reuse `dialog` base), hero centered (logo `--hf-accent-3`, `.welcome-title` `font-family: var(--font-accent)`, muted `.welcome-subtitle`), two tiles reusing `.media-option` feel (orange hover), footer with checkbox + `.action-btn`. Honor `prefers-reduced-motion`; stack tiles under ~420px.

- [ ] **Step 5: Add logo-menu item** in `public/index.html` above `aboutMenuItem`:

```html
<div id="welcomeMenuItem">welcome to Layers...</div>
```

- [ ] **Step 6: Wire deps + re-open in `public/js/app.js`** (import at top; in `_setupMenuHandlers`, after the about handler):

```js
welcomeDialog.init({
    onNewCanvas: () => this._showOpenDialog(),
    onOpenFile: () => this._openMediaFilePicker(),
    onDismiss: () => this._showOpenDialog(),
})
document.getElementById('welcomeMenuItem')?.addEventListener('click', () => welcomeDialog.show())
```

Add helper method on the class:

```js
_openMediaFilePicker() {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = 'image/*,video/*'
    input.addEventListener('cancel', () => this._showOpenDialog())
    input.addEventListener('change', () => {
        const file = input.files?.[0]
        if (!file) { this._showOpenDialog(); return }
        const mediaType = file.type.startsWith('video') ? 'video' : 'image'
        this._handleOpenMedia(file, mediaType)
    })
    input.click()
}
```

- [ ] **Step 7: Import** at top of `public/js/app.js`:

```js
import { welcomeDialog, isWelcomeDismissed } from './ui/welcome-dialog.js'
```

- [ ] **Step 8: Commit**

```bash
git add public/js/ui/welcome-dialog.js public/css/components.css public/index.html public/js/app.js tests/welcome-dialog.spec.js
git commit -m "feat(welcome): first-run splash + quick-start dialog"
```

---

### Task 4: First-run auto-show wiring (webdriver-gated)

**Files:**
- Modify: `public/js/app.js:611-612` (init tail) + add `_shouldAutoShowWelcome()`

**Interfaces:**
- Consumes: `isWelcomeDismissed()`, `welcomeDialog.show({fallThrough})`, `_showOpenDialog()`.

- [ ] **Step 1: Confirm Task 3 tests still red on auto-show** (they exercise `?welcome=1` init path).

Run: `npx playwright test tests/welcome-dialog.spec.js --workers=1 -g "auto-shows"`
Expected: FAIL (init still calls `_showOpenDialog` unconditionally).

- [ ] **Step 2: Replace init tail `public/js/app.js:611-612`:**

```js
this._hideLoadingScreen()
if (!joinedFromUrl) {
    if (this._shouldAutoShowWelcome()) {
        welcomeDialog.show({ fallThrough: true })
    } else {
        this._showOpenDialog()
    }
}
```

- [ ] **Step 3: Add method** (near `_showOpenDialog`):

```js
/**
 * First-run welcome splash gate. Suppressed under automation
 * (navigator.webdriver) so it never interferes with the test harness;
 * `?welcome=1` opts back in for the welcome spec.
 * @private
 */
_shouldAutoShowWelcome() {
    if (isWelcomeDismissed()) return false
    const forced = new URLSearchParams(window.location.search).has('welcome')
    if (window.navigator.webdriver && !forced) return false
    return true
}
```

- [ ] **Step 4: Run welcome spec — expect PASS**

Run: `npx playwright test tests/welcome-dialog.spec.js --workers=1`

- [ ] **Step 5: Regression — existing boots unaffected** (welcome suppressed under webdriver without `?welcome`)

Run: `npx playwright test tests/child-effects.spec.js tests/agent-effect-commands.spec.js --workers=1`
Expected: PASS (open dialog still appears on boot).

- [ ] **Step 6: Commit**

```bash
git add public/js/app.js
git commit -m "feat(welcome): show on first run in place of the open dialog"
```

---

### Task 5: Full-suite regression sweep

- [ ] **Step 1: Run the new specs + a representative existing slice single-worker**

Run: `npx playwright test tests/filter-menu.spec.js tests/welcome-dialog.spec.js tests/agent-effect-commands.spec.js tests/child-effects.spec.js tests/webgl-errors.spec.js --workers=1`
Expected: all PASS.

- [ ] **Step 2: Manual verify** — launch app, confirm: filter menu opens with 8 submenus, effects add as layers; welcome shows with `?welcome=1`, tiles/close/don't-show behave; default render unaffected.

- [ ] **Step 3: Final commit** if any fixups.

---

## Self-Review

- **Spec coverage:** welcome dialog (T3/T4), filter menu + selective curation (T1), curated-group sync (T2), tests (T1–T5), no engine/param changes (all tasks are menu/dialog wiring). ✓
- **Placeholders:** none — code shown for each code step; taxonomy fully enumerated in T1. ✓
- **Type/name consistency:** `welcomeDialog`/`isWelcomeDismissed`/`_shouldAutoShowWelcome`/`_openMediaFilePicker`/`_handleAddEffectLayer`/`_showOpenDialog`/`_handleOpenMedia` consistent across tasks; submenu `data-submenu` ids match `data-submenu-id` blocks. ✓
- **Risks:** (a) first-run welcome vs existing tests → resolved by webdriver gate; (b) `agent-effect-commands.spec.js` group-id assertion → updated in T2; (c) submenu positioning requires `.submenu` blocks inside `#filterMenu` `.menu` → satisfied in T1 markup.
