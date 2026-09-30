# Handfish UI Toolkit Port — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Port the Layers app from custom CSS variables and native controls to the Handfish design system, matching the patterns used in Noisedeck.

**Architecture:** Replace `colors.css` with Handfish CDN tokens + neutral theme. Create a bridge `theme.css` for computed variables. Migrate all `--color-*` / `--radius-*` / `--shadow-*` references in 7 CSS files to `--hf-*` tokens. Replace custom controls in `effect-params.js` with Handfish web components (`<slider-value>`, `<select-dropdown>`, `<toggle-switch>`, `<color-picker>`).

**Tech Stack:** Handfish 0.9.0 (CDN), vanilla JS web components, CSS custom properties

**Reference:** Noisedeck port at `../noisedeck/` — particularly `app/css/theme.css`, `app/js/ui/controlFactory.js`, `app/js/ui/controlGroupBuilder.js`, and `app/index.html`.

---

### Task 1: Add Handfish CDN imports and importmap

**Files:**
- Modify: `public/index.html`

**Step 1: Add importmap for Handfish JS**

Add before the existing `<link rel="stylesheet" href="css/fonts.css">` line:

```html
<script type="importmap">
    {
        "imports": {
            "noisemaker/shader-effects": "./js/noisemaker/bundle.js",
            "handfish": "https://handfish.noisefactor.io/0.9.0/handfish.esm.min.js"
        }
    }
</script>
```

Note: Layers currently has no importmap. The noisemaker import must be included since `bundle.js` is loaded as a module.

**Step 2: Add Handfish CSS imports**

Replace the `colors.css` stylesheet link with Handfish token + theme CSS:

```html
<!-- Handfish Design System -->
<link rel="stylesheet" href="https://handfish.noisefactor.io/0.9.0/styles/tokens.css">
<link rel="stylesheet" href="https://handfish.noisefactor.io/0.9.0/styles/themes/neutral.css">
```

**Step 3: Set theme attribute**

Change `<html lang="en">` to `<html lang="en" data-theme="neutral-dark">`.

**Step 4: Add Handfish CDN preconnect**

Add to the preconnect section:

```html
<link rel="preconnect" href="https://handfish.noisefactor.io" crossorigin>
```

**Step 5: Remove colors.css link**

Remove: `<link rel="stylesheet" href="css/colors.css">`

**Step 6: Add theme.css link**

Add after the Handfish CSS links: `<link rel="stylesheet" href="css/theme.css">`

**Step 7: Verify in browser**

Open the app. It will look broken (variables unresolved) — that's expected until the CSS migration tasks complete.

**Step 8: Commit**

```
feat: add Handfish CDN imports and importmap
```

---

### Task 2: Create theme.css bridge and delete colors.css

**Files:**
- Create: `public/css/theme.css`
- Delete: `public/css/colors.css`

**Step 1: Create theme.css**

This file bridges Handfish primitive tokens to app-level aliases used throughout Layers. Reference: `../noisedeck/app/css/theme.css`.

```css
/* Layers theme — computed variables built on Handfish primitives */

:root {
    /* Glass & blur */
    --glass-blur-strength: var(--hf-glass-blur);

    /* UI sizing */
    --ui-titlebar-height: 2.25rem;
    --ui-corner-radius: var(--hf-radius);
    --ui-corner-radius-small: var(--hf-radius-md);

    /* Surface opacity (for glassmorphism) */
    --effect-surface-opacity: var(--hf-panel-opacity);
    --effect-surface-transparency: var(--hf-panel-transparency);

    /* Menu bar gradient — built on handfish color tokens */
    --ui-gradient-top: color-mix(in srgb, var(--hf-color-3) 80%, var(--hf-color-4) 20%);
    --ui-gradient-bottom: color-mix(in srgb, var(--hf-color-2) 60%, var(--hf-color-3) 40%);

    /* Font family aliases — Handfish provides these but keep local aliases too */
    --font-body: var(--hf-font-family);
    --font-mono: var(--hf-font-family-mono);
    --font-accent: 'Cormorant Upright', 'Cormorant Upright Block';

    /* Checkerboard transparency pattern */
    --checkerboard-bg: var(--hf-color-3);
    --checkerboard-check: var(--hf-color-4);
}
```

**Step 2: Delete colors.css**

Remove `public/css/colors.css`.

**Step 3: Commit**

```
feat: create theme.css bridge, delete colors.css
```

---

### Task 3: Migrate menu.css to Handfish tokens

**Files:**
- Modify: `public/css/menu.css`

**Step 1: Replace the :root variable block**

Remove the `:root` block (lines 6-28), the light mode block (lines 31-45), and the `@media (prefers-color-scheme: light)` block (lines 48-61). These are all replaced by Handfish tokens.

**Step 2: Replace variable references throughout the file**

Apply these replacements across the entire file:

| Old | New |
|-----|-----|
| `var(--color2)` | `var(--hf-color-2)` |
| `var(--color1)` | `var(--hf-color-1)` |
| `var(--color3)` | `var(--hf-color-3)` |
| `var(--color5)` | `var(--hf-color-5)` |
| `var(--color6)` | `var(--hf-color-6)` |
| `var(--color7)` | `var(--hf-color-7)` |
| `var(--accent3)` | `var(--hf-accent-3)` |
| `var(--accent4)` | `var(--hf-accent-4)` |
| `var(--red)` | `var(--hf-red)` |
| `var(--color-accent)` | `var(--hf-accent-3)` |
| `var(--color-text-primary)` | `var(--hf-color-7)` |

**Step 3: Verify menu bar renders**

Open in browser, check menu bar and dropdowns look correct.

**Step 4: Commit**

```
feat: migrate menu.css to Handfish tokens
```

---

### Task 4: Migrate fonts.css to Handfish tokens

**Files:**
- Modify: `public/css/fonts.css`

**Step 1: Remove font-face declarations that Handfish provides**

Handfish CDN CSS already loads Nunito, Noto Sans Mono, and Material Symbols. Remove those `@font-face` blocks. Keep:
- `Nunito Block` (block display fallback)
- `Noto Sans Mono Block` (block display fallback)
- `Cormorant Upright Block` (block display fallback)
- `Cormorant Upright` (layers-specific accent font)

Remove:
- `Nunito` @font-face (line 40-47)
- `Noto Sans Mono` @font-face (line 32-38)
- `Material Symbols Outlined` @font-face (line 49-55)

**Step 2: Remove the :root font variables block**

Remove the `:root` block (lines 68-72) — these are now in `theme.css`.

**Step 3: Commit**

```
feat: simplify fonts.css, defer to Handfish CDN
```

---

### Task 5: Migrate layout.css to Handfish tokens

**Files:**
- Modify: `public/css/layout.css`

**Step 1: Replace all variable references**

| Old | New |
|-----|-----|
| `var(--color-bg)` | `var(--hf-color-2)` |
| `var(--color-bg-elevated)` | `var(--hf-color-1)` |
| `var(--color-bg-hover)` | `var(--hf-color-3)` |
| `var(--color-bg-active)` | `var(--hf-color-3)` |
| `var(--color-text-primary)` | `var(--hf-color-7)` |
| `var(--color-text-secondary)` | `var(--hf-color-6)` |
| `var(--color-text-muted)` | `var(--hf-color-5)` |
| `var(--color-border)` | `var(--hf-color-3)` |
| `var(--color-border-muted)` | `var(--hf-color-2)` |
| `var(--color-ui)` | `var(--hf-color-5)` |
| `var(--color-ui-hover)` | `var(--hf-color-6)` |
| `var(--color-ui-muted)` | `color-mix(in srgb, var(--hf-color-5) 15%, transparent 85%)` |
| `var(--color-accent)` | `var(--hf-accent-3)` |
| `var(--radius-sm)` | `var(--hf-radius-sm)` |
| `var(--radius-md)` | `var(--hf-radius-md)` |
| `var(--shadow-lg)` | `var(--hf-shadow-lg)` |
| `var(--transition-fast)` | `0.12s ease-out` |

Also replace any references to the menu-specific vars (`--accent3`, `--accent4`, `--color2`, etc.) with their `--hf-*` equivalents as in Task 3.

**Step 2: Verify layout renders**

Check canvas panel, layers panel, drawing options bar.

**Step 3: Commit**

```
feat: migrate layout.css to Handfish tokens
```

---

### Task 6: Migrate layers.css to Handfish tokens

**Files:**
- Modify: `public/css/layers.css`

**Step 1: Replace all variable references**

Same mapping as Task 5, plus these specific to layers.css:

| Old | New |
|-----|-----|
| `var(--color-bg-active)` | `var(--hf-color-3)` |
| `var(--color-accent-muted)` | `color-mix(in srgb, var(--hf-accent-3) 12%, transparent 88%)` |
| `var(--color-error)` | `var(--hf-red)` |
| `var(--color-error-muted)` | `color-mix(in srgb, var(--hf-red) 12%, transparent 88%)` |
| `var(--color-secondary)` | `var(--hf-accent-1)` |
| `var(--color-warning)` | `var(--hf-yellow)` |
| `var(--color-ui-glow)` | `0 0 6px color-mix(in srgb, var(--hf-color-5) 40%, transparent 60%)` |
| `var(--overlay-dark)` | `rgba(0, 0, 0, 0.4)` |
| `var(--radius-sm)` | `var(--hf-radius-sm)` |
| `var(--radius-md)` | `var(--hf-radius-md)` |
| `var(--transition-fast)` | `0.12s ease-out` |

**Step 2: Remove custom toggle/slider/color-picker/dropdown CSS**

Remove the following CSS blocks that will be replaced by Handfish component styles:
- `.control-toggle`, `.toggle-track`, `.toggle-thumb` blocks (lines 639-677)
- `.control-color-container`, `.control-color`, `.control-color::-webkit-*`, `.control-color-hex` blocks (lines 680-710)
- `.control-dropdown` and related blocks (lines 610-636)
- `.control-slider` and related blocks (lines 564-607)
- `.control-value` block (lines 555-561)

Keep: `.control-group`, `.control-label`, `.control-button`, `.control-text`, `.control-textarea` blocks.

**Step 3: Update .control-group grid**

The grid layout needs adjusting since `<slider-value>` handles its own value display:

```css
.control-group {
    display: grid;
    grid-template-columns: 70px 1fr;
    align-items: center;
    gap: 8px;
    min-height: 24px;
}
```

(Changed from `70px 1fr 40px` to `70px 1fr` — the third column was for the value display that `<slider-value>` now handles internally.)

**Step 4: Add handfish component grid spanning**

```css
/* Handfish components span the control column */
.control-group select-dropdown,
.control-group toggle-switch,
.control-group color-picker {
    grid-column: 2 / -1;
}
```

**Step 5: Verify layers panel renders**

Check layer items, blend mode select, opacity slider, effect params.

**Step 6: Commit**

```
feat: migrate layers.css to Handfish tokens
```

---

### Task 7: Migrate components.css to Handfish tokens

**Files:**
- Modify: `public/css/components.css`

**Step 1: Replace all variable references**

Same core mapping as Task 5, plus these specific to components.css:

| Old | New |
|-----|-----|
| `var(--color-bg-overlay)` | `color-mix(in srgb, var(--hf-color-2) 92%, transparent 8%)` |
| `var(--color-glass)` | `color-mix(in srgb, var(--hf-color-2) var(--hf-panel-opacity), transparent var(--hf-panel-transparency))` |
| `var(--color-glass-border)` | `color-mix(in srgb, var(--hf-color-7) 8%, transparent 92%)` |
| `var(--color-backdrop)` | `rgba(0, 0, 0, 0.8)` |
| `var(--color-text-inverse)` | `white` |
| `var(--color-text-placeholder)` | `var(--hf-color-4)` |
| `var(--color-success)` | `var(--hf-green)` |
| `var(--color-error)` | `var(--hf-red)` |
| `var(--color-warning)` | `var(--hf-yellow)` |
| `var(--color-accent-hover)` | `var(--hf-accent-4)` |
| `var(--color-accent-muted)` | `color-mix(in srgb, var(--hf-accent-3) 12%, transparent 88%)` |
| `var(--color-success-muted)` | `color-mix(in srgb, var(--hf-green) 12%, transparent 88%)` |
| `var(--color-error-muted)` | `color-mix(in srgb, var(--hf-red) 12%, transparent 88%)` |
| `var(--color-warning-muted)` | `color-mix(in srgb, var(--hf-yellow) 12%, transparent 88%)` |
| `var(--overlay-dark)` | `rgba(0, 0, 0, 0.4)` |
| `var(--radius-sm)` | `var(--hf-radius-sm)` |
| `var(--radius-md)` | `var(--hf-radius-md)` |
| `var(--radius-lg)` | `var(--hf-radius-lg)` |
| `var(--radius-xl)` | `var(--hf-radius-xl)` |
| `var(--shadow-sm)` | `var(--hf-shadow-sm)` |
| `var(--shadow-md)` | `var(--hf-shadow-md)` |
| `var(--shadow-lg)` | `var(--hf-shadow-lg)` |
| `var(--shadow-xl)` | `var(--hf-shadow-xl)` |
| `var(--transition-fast)` | `0.12s ease-out` |
| `var(--transition-normal)` | `0.2s ease-out` |
| `var(--transition-slow)` | `0.35s ease-out` |
| `var(--red, #e74c3c)` | `var(--hf-red)` |

**Step 2: Verify dialogs and toasts render**

Open the about dialog, export dialog, toasts.

**Step 3: Commit**

```
feat: migrate components.css to Handfish tokens
```

---

### Task 8: Migrate loading.css to Handfish tokens

**Files:**
- Modify: `public/css/loading.css`

**Step 1: Replace variable references**

| Old | New |
|-----|-----|
| `var(--color-bg)` | `var(--hf-color-2)` |
| `var(--color-glass)` | `color-mix(in srgb, var(--hf-color-2) var(--hf-panel-opacity), transparent var(--hf-panel-transparency))` |
| `var(--color-text-primary)` | `var(--hf-color-7)` |
| `var(--color-text-muted)` | `var(--hf-color-5)` |
| `var(--color-accent)` | `var(--hf-accent-3)` |
| `var(--radius-xl)` | `var(--hf-radius-xl)` |
| `var(--shadow-xl)` | `var(--hf-shadow-xl)` |
| `var(--shadow-glow)` | `var(--hf-shadow-lg)` |
| `var(--transition-slow)` | `0.35s ease-out` |

**Step 2: Commit**

```
feat: migrate loading.css to Handfish tokens
```

---

### Task 9: Port effect-params.js controls to Handfish components

**Files:**
- Modify: `public/js/layers/effect-params.js`

This is the core control migration. Reference: `../noisedeck/app/js/ui/controlGroupBuilder.js` lines 356-440.

**Step 1: Add Handfish import**

At top of file, add:

```javascript
import { SliderValue, SelectDropdown, ToggleSwitch, ColorPicker } from 'handfish'
```

**Step 2: Replace _createSlider**

Replace the entire `_createSlider` method:

```javascript
_createSlider(paramName, spec, currentValue) {
    const slider = document.createElement('slider-value')
    slider.min = spec.min ?? 0
    slider.max = spec.max ?? 100
    slider.step = spec.step ?? (spec.type === 'int' ? 1 : 0.01)
    slider.value = currentValue
    slider.type = spec.type === 'int' ? 'int' : 'float'

    slider.addEventListener('input', () => {
        const value = spec.type === 'int'
            ? parseInt(slider.value, 10)
            : parseFloat(slider.value)
        this._handleValueChange(paramName, value, spec)
    })

    return {
        element: slider,
        getValue: () => spec.type === 'int' ? parseInt(slider.value, 10) : parseFloat(slider.value),
        setValue: (v) => { slider.value = v }
    }
}
```

**Step 3: Replace _createDropdown**

Replace the entire `_createDropdown` method:

```javascript
_createDropdown(paramName, spec, currentValue) {
    const select = document.createElement('select-dropdown')

    const choices = spec.choices || {}
    const opts = Object.entries(choices).map(([name, value]) => ({
        value: String(value),
        text: name
    }))
    select.setOptions(opts)
    select.value = String(currentValue ?? '')

    select.addEventListener('change', () => {
        const value = spec.type === 'int'
            ? parseInt(select.value, 10)
            : select.value
        this._handleValueChange(paramName, value, spec)
    })

    return {
        element: select,
        getValue: () => spec.type === 'int' ? parseInt(select.value, 10) : select.value,
        setValue: (v) => { select.value = String(v) }
    }
}
```

**Step 4: Replace _createToggle**

Replace the entire `_createToggle` method:

```javascript
_createToggle(paramName, spec, currentValue) {
    const toggle = document.createElement('toggle-switch')
    toggle.checked = !!currentValue

    toggle.addEventListener('change', () => {
        this._handleValueChange(paramName, toggle.checked, spec)
    })

    return {
        element: toggle,
        getValue: () => toggle.checked,
        setValue: (v) => { toggle.checked = !!v }
    }
}
```

**Step 5: Replace _createColorPicker**

Replace the entire `_createColorPicker` method:

```javascript
_createColorPicker(paramName, spec, currentValue) {
    const colorPicker = document.createElement('color-picker')

    const hexValue = this._arrayToHex(currentValue)
    colorPicker.value = hexValue

    colorPicker.addEventListener('input', () => {
        const arrayValue = this._hexToArray(colorPicker.value)
        this._handleValueChange(paramName, arrayValue, spec)
    })

    return {
        element: colorPicker,
        getValue: () => this._hexToArray(colorPicker.value),
        setValue: (v) => {
            colorPicker.value = this._arrayToHex(v)
        }
    }
}
```

**Step 6: Remove the manual value display logic from _createControlGroup**

In `_createControlGroup`, remove the block that creates the value display span (lines 182-188):

```javascript
// Remove this block:
if (spec.ui?.control === 'slider' || ...) {
    const valueDisplay = ...
    ...
    controlHandle.valueDisplay = valueDisplay
}
```

Also remove the value display update from `_createSlider`'s input handler (the `if (handle?.valueDisplay)` block) — this is no longer needed since `<slider-value>` handles it.

**Step 7: Verify effect params work**

Open an effect layer, adjust slider/dropdown/toggle/color params, verify events fire correctly.

**Step 8: Commit**

```
feat: port effect-params controls to Handfish components
```

---

### Task 10: Port layer-item.js blend mode select and opacity slider

**Files:**
- Modify: `public/js/layers/layer-item.js`

The layer-item component creates blend mode `<select>` and opacity `<input type="range">` controls. These should also use Handfish.

**Step 1: Read layer-item.js to find the control creation code**

Read the file first to locate exact lines for the blend mode select and opacity slider creation.

**Step 2: Add Handfish import**

```javascript
import { SelectDropdown, SliderValue } from 'handfish'
```

**Step 3: Replace blend mode select**

Replace the native `<select>` creation for blend mode with `<select-dropdown>`:

```javascript
const blendSelect = document.createElement('select-dropdown')
blendSelect.className = 'layer-blend-mode'
const opts = blendModes.map(mode => ({
    value: mode.value,
    text: mode.label
}))
blendSelect.setOptions(opts)
blendSelect.value = layer.blendMode || 'mix'
```

**Step 4: Replace opacity slider**

Replace the native `<input type="range">` for opacity with `<slider-value>`:

```javascript
const opacitySlider = document.createElement('slider-value')
opacitySlider.className = 'layer-opacity'
opacitySlider.min = 0
opacitySlider.max = 100
opacitySlider.step = 1
opacitySlider.type = 'int'
opacitySlider.value = layer.opacity ?? 100
```

Update event handlers accordingly.

**Step 5: Remove the separate opacity value display span**

The `<span class="layer-opacity-value">` is no longer needed since `<slider-value>` shows the value.

**Step 6: Update layers.css**

Remove `.layer-blend-mode` dropdown arrow background-image (Handfish handles this). Remove `.layer-opacity-value` styles. Update `.layer-opacity-container` if needed.

**Step 7: Verify blend mode and opacity work**

Test changing blend modes and opacity on layers.

**Step 8: Commit**

```
feat: port layer-item controls to Handfish components
```

---

### Task 11: Final cleanup and visual verification

**Files:**
- Modify: Various CSS files for tweaks

**Step 1: Full visual walkthrough**

Open the app and verify every screen:
- Loading screen
- Menu bar + all dropdowns + submenus
- Toolbar (should be unchanged)
- Canvas panel
- Layers panel (empty state, with layers)
- Layer items (selected, hover, drag states)
- Effect parameters (slider, dropdown, toggle, color picker)
- Blend mode select + opacity slider on layers
- All dialogs: About, Export Image, Export Video, Font Install, Open, Save, Load, Confirm
- Toast notifications
- Context menus (mask, layer)
- Responsive breakpoints (910px, 700px)
- Drawing options bar

**Step 2: Fix any visual discrepancies**

Adjust token mappings, spacing, or component styles as needed.

**Step 3: Delete colors.css if not already done**

Ensure `public/css/colors.css` is removed and no references remain.

**Step 4: Search for any remaining old variable references**

Grep for `--color-bg`, `--color-text`, `--color-accent`, `--color-border`, `--color-ui`, `--color-error`, `--color-success`, `--color-warning`, `--color-secondary`, `--radius-`, `--shadow-`, `--transition-`, `--overlay-`, `--modal-`, `--color-glass` across all CSS and JS files. Fix any stragglers.

**Step 5: Commit**

```
feat: complete Handfish port — final cleanup
```
