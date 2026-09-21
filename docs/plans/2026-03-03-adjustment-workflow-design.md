# Adjustment Workflow Design

Date: 2026-03-03
Phase: 3 (per feature roadmap)

## Goal

Make existing Noisemaker effects more accessible for quick photo editing. Reorganize the Image menu with categorized submenus, expose more adjustment effects, and add one-click auto corrections.

## Approach

Categorized submenus in the Image menu (Approach A from brainstorming). CSS hover-based submenu system. All adjustments create separate effect layers (no child effects). Auto corrections analyze canvas pixels and create effect layers with computed params.

## 1. Submenu System

New CSS/HTML submenu mechanism for the menu bar:

- Menu items with children get `has-submenu` class and right-arrow indicator
- Nested `.menu-items.submenu` container appears on hover
- Viewport-aware positioning (flip left if overflow)
- `_closeAllMenus()` handles cleanup (already exists)

```html
<div class="menu-item has-submenu">
  Tone
  <div class="menu-items submenu">
    <div id="brightnessContrastMenuItem" data-effect="filter/adjust">Brightness/Contrast</div>
    <div id="posterizeMenuItem" data-effect="filter/posterize">Posterize</div>
  </div>
</div>
```

## 2. Image Menu Structure

```
Image >
  Auto Levels                  (top-level, one-click)
  Auto Contrast                (top-level, one-click)
  Auto White Balance           (top-level, one-click)
  ─────────────
  Tone >
    Brightness/Contrast        → filter/adjust
    Levels                     → filter/smoothstep
    Posterize                  → filter/posterize
    Threshold                  → filter/thresh
  Color >
    Hue/Saturation             → filter/adjust
    Color Grading              → filter/grade
    Tint                       → filter/tint
    Invert                     → filter/inv
    Gradient Palette           → filter/tetraColorArray
  Blur & Sharpen >
    Blur                       → filter/blur
    Motion Blur                → filter/motionBlur
    Zoom Blur                  → filter/zoomBlur
    Sharpen                    → filter/sharpen
  Stylize >
    Bloom                      → filter/bloom
    Grain                      → filter/grain
    Vignette                   → filter/vignette
    Edge Detect                → filter/edge
    Dither                     → filter/dither
    Emboss                     → filter/emboss
  ─────────────
  Crop to Selection
  Image Size...
  Canvas Size...
```

## 3. Auto Corrections

New utility: `public/js/utils/auto-adjust.js`

### computeHistogram(gl, canvas)

Reads canvas pixels via `gl.readPixels()`. Returns:
```js
{
  r: Uint32Array(256),
  g: Uint32Array(256),
  b: Uint32Array(256),
  lum: Uint32Array(256),
  min: [r, g, b],
  max: [r, g, b],
  mean: [r, g, b],
  percentile: (channel, pct) => value
}
```

### Auto Levels

Computes per-channel min/max from histogram (1st-99th percentile). Creates `filter/adjust` effect layer with brightness/contrast values that stretch histogram to full range.

### Auto Contrast

Computes luminance histogram. Creates `filter/adjust` effect layer with contrast value mapping 1st-99th percentile luminance range to full range.

### Auto White Balance

Computes average R, G, B values. Creates `filter/adjust` effect layer with hue shift and saturation adjustments to neutralize color cast. Approximate — uses existing hue/saturation shader.

### Behavior

One-click: auto-apply creates effect layer immediately. User can then expand the layer to tweak params via the existing effect-params UI.

## 4. Menu Handler Refactor

Replace individual `getElementById` listeners with data-driven approach:
- Effect menu items get `data-effect="filter/xyz"` attributes
- Single delegated click listener on the Image menu handles all effect items
- Auto correction items get `data-auto="levels|contrast|whiteBalance"` attributes with separate handler

## Out of Scope

- No sidebar panel changes
- No floating adjustment panel
- No child effect application model
- No new shaders (using existing filter/ namespace only)
- No adjustment presets or favorites
