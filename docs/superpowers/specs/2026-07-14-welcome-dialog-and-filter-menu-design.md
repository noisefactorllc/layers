# Welcome dialog + Photoshop-style filter menu — design

Date: 2026-07-14
Status: awaiting user review

## Overview

Two coordinated, Layers-side additions that share one spec because they ship
together as a first-impression + discoverability pass:

1. **Welcome to Layers** — a warm, restrained splash + quick-start dialog shown
   on launch (styled after noisedeck's startup dialog, but simpler and classier
   to match Layers' "grown-up Photoshop" feel).
2. **A dedicated `filter` menu** — restructure the effect menus toward
   Photoshop's taxonomy: a new top-level `filter` menu, with the existing
   filters reorganized into it and a *selective* subset of 25 newly-shipped
   engine effects curated in.

## Goals

- A warm, positive, no-aislop first impression of Layers.
- A menu structure a Photoshop user recognizes immediately ("close UI match").
- Surface the best of the 25 new effects where users expect them, selectively —
  not a data dump.

## Hard constraints

- **Engine is off-limits.** All effect definitions, GLSL, WGSL, param specs, and
  the manifest live in the external shader core at `shaders.noisedeck.app`. This
  work touches **only** the Layers repo (menus, one dialog, curated lists,
  tests). No engine/shader authoring.
- **Protected default output is untouched.** No effect params, defaults, or
  render paths change. Adding a menu entry calls the same
  `_handleAddEffectLayer(effectId)` path that exists today, so pixel output for
  every effect is byte-identical to before.
- **No push / no PR** without explicit authorization. Local work only.

## Context established during research

- Effect definitions come from the CDN engine; the Layers repo references
  effects by string id only. All 25 new effects (`filter/chrome` … `filter/wind`)
  and the 6 filters mentioned for extension already exist live in the engine
  manifest (verified against `https://shaders.noisedeck.app/1/effects/manifest.json`).
- The **human effect menu** is static HTML: `public/index.html` `#imageMenu`
  (lines ~158–205), with `.has-submenu[data-submenu]` rows + `.submenu`
  blocks of `<div data-effect="filter/…">label</div>`. Click delegation is in
  `public/js/app.js` (`#imageMenu` → `closest('[data-effect]')` →
  `_handleAddEffectLayer`); submenu hover show/hide is `_setupMenuHandlers`.
- The **agent curated list** is `CURATED_GROUPS` in `public/js/agent/effects.js`
  (groups: tone, color, blur-sharpen, stylize) — a second, independently
  hand-maintained surface that today mostly mirrors the HTML menu (with one
  drift: `filter/colorReplace` is in the HTML `color` submenu but not in
  `CURATED_GROUPS`).
- The **searchable "Add Effect" picker** (`public/js/ui/effect-picker.js`)
  already lists every manifest effect automatically, grouped by namespace — so
  the 25 new effects are *already discoverable* there. Curation is specifically
  about the promoted menu + the agent list, not about making effects reachable.
- **Startup flow:** at the end of `LayersApp.init()`,
  `if (!joinedFromUrl) this._showOpenDialog()` shows the New/Open/base chooser
  (`openDialog.show({...})`). There is no first-run flag today.
- **Dialog conventions:** native `<dialog>` + `showModal()`, singleton class
  (see `settings-dialog.js`), `.dialog-header`/`.dialog-body`/`.dialog-actions`
  chrome in `components.css`, glassy `backdrop-filter`, `dialog-open` scale-in
  animation. Brand fonts: `--font-accent` = Cormorant Upright (elegant serif,
  used for headers/wordmark), `--font-body` = Nunito. Signature accent
  `--hf-accent-3` (burnt orange ≈ `#d26200`). Layered-slabs logo SVG is inline
  in `index.html` (`#logo`) and `about-dialog.js`.
- There is **no bundled sample project** and no local help/i18n system (both
  intentionally out of scope here).

## Scope

**In**
- Welcome dialog (new singleton + styles + wiring + first-run gate + re-open item).
- New `filter` top-level menu; move `blur & sharpen` + `stylize` out of `image`;
  `image` keeps Adjustments-style content (tone/color/auto/crop/size).
- Selective curation of 16 of the 25 new effects into the `filter` menu.
- Restructure `CURATED_GROUPS` to mirror the new taxonomy (fixes the colorReplace drift).
- Light Playwright regression tests (in-convention; no WebGPU seam).

**Out** (per scoping decisions)
- Extended-filter mode UI (edge/emboss/invert/lowPoly/texture/grain new controls).
- Local per-effect help copy / catalog / localization system.
- WebGL2+WebGPU dual-backend test seam.
- Any engine/shader change.

---

## Part A — Welcome dialog

### Lifecycle & trigger

- New singleton module `public/js/ui/welcome-dialog.js`, mirroring
  `settings-dialog.js` (native `<dialog>`, `show()`/`hide()`, lazy `_createDialog()`).
- **First-run gate:** persist `localStorage['layers-welcome-dismissed']`. On
  launch, in `init()`, branch the existing tail:
  - if `joinedFromUrl` → neither dialog (unchanged; a shared session replaces it).
  - else if welcome not dismissed → `welcomeDialog.show()` (in place of the open dialog).
  - else → `_showOpenDialog()` (today's behavior).
- **Never a dead end:** closing Welcome via backdrop / Esc / Close *without*
  choosing a tile falls through to `_showOpenDialog()`, so the user still lands
  in the normal start flow.
- **Opt-out:** a "don't show again" checkbox writes the flag on change. Unchecked
  = Welcome shows each launch as the front door (like noisedeck); checked = boot
  goes straight to the open dialog.
- **Re-open:** new logo-menu item `welcomeMenuItem` ("welcome to Layers…")
  inserted above `aboutMenuItem`, calling `welcomeDialog.show()`.

### Layout & content (two tiles)

```
 ┌─────────────────────────────────────┐
 │  ▨  Welcome to Layers               │   logo (layered slabs) + Cormorant wordmark
 │     Layered, non-destructive editing│   one muted Nunito subtitle
 ├─────────────────────────────────────┤
 │       ┌──────────┐ ┌──────────┐     │
 │       │    ✚     │ │    ▤     │     │   two centered tiles,
 │       │   New    │ │   Open   │     │   burnt-orange hover
 │       │  canvas  │ │   file   │     │
 │       └──────────┘ └──────────┘     │
 ├─────────────────────────────────────┤
 │  ☐ don't show again        [ Close ]│
 └─────────────────────────────────────┘
```

- **New canvas** → routes into the existing new-canvas flow (the open dialog's
  solid/gradient/transparent + size path; reuses `openDialog` callbacks /
  base-creation handlers). Dismisses Welcome first.
- **Open file** → routes into the existing open-media flow (`_handleOpenMedia`
  via the open dialog / file input). Dismisses Welcome first.
- Exact handler wiring finalized in the implementation plan; the principle is
  that Welcome reuses existing flows rather than duplicating base-creation logic.

### Copy (direction — finalized during implementation)

- Wordmark: **Welcome to Layers** (Cormorant Upright, title case).
- Subtitle candidates (one line, muted): "Layered, non-destructive image
  editing." / "A calm, layered way to edit images." Warm, plain, confident —
  no marketing padding, no emoji.
- Tile labels: "New canvas", "Open file". Checkbox: "don't show again"
  (lowercase, matching the menu house style). Close button label: "Close".

### Styling

- Reuse native `<dialog>` + `.dialog-*` classes and theme tokens; add a scoped
  `.welcome-dialog` block in `public/css/components.css`.
- Typographic rhythm borrowed from noisedeck but simplified: logo + serif
  wordmark → single muted subtitle → tiles. One accent color (`--hf-accent-3`).
- Centered modal, ~ 460–520px wide; glassy panel; `dialog-open` scale-in.
- Tiles reuse the `.media-option` visual language (icon + label, orange hover/
  selected state) already in `components.css`.
- Honor `prefers-reduced-motion` (no gratuitous animation). Responsive: tiles
  stack on very narrow viewports. Theme-aware via existing `--hf-*` variables
  (works across all Layers themes, light and dark).
- Material Symbols icons for the tiles (e.g. `add`/`add_photo_alternate`) and
  the close button, consistent with other dialogs.

### Files (Part A)

- `public/js/ui/welcome-dialog.js` (new)
- `public/css/components.css` (add `.welcome-dialog` styles)
- `public/index.html` (logo-menu `welcomeMenuItem`)
- `public/js/app.js` (first-run branch in `init()`; wire `welcomeMenuItem`;
  import the singleton)

---

## Part B — `filter` menu + selective curation

### Menu bar

`file · edit · image · layer · select · `**`filter`**` · view`
(Photoshop places Filter after Select — matched.)

### `image` menu after (Adjustments-style)

- auto levels / auto contrast / auto white balance
- `tone ▸` : brightness/contrast (`filter/adjust`), levels (`filter/smoothstep`),
  posterize (`filter/posterize`), threshold (`filter/threshold`)
- `color ▸` : hue/saturation (`filter/adjust`), color grading (`filter/grade`),
  tint (`filter/tint`), color replace (`filter/colorReplace`),
  invert (`filter/invert`), gradient palette (`filter/tetraColorArray`)
- crop to selection · image size… · canvas size…

### `filter` menu (new) — final taxonomy

New effects marked ★. Submenu earns a slot only with ≥2 curated effects.

- `blur ▸` : blur, motion blur (`motionBlur`), zoom blur (`zoomBlur`), ★spin blur (`spinBlur`)
- `sharpen ▸` : sharpen, ★unsharp mask (`unsharpMask`)
- `pixelate ▸` : ★halftone (`halftone`), dither (`dither`)
- `stylize ▸` : bloom, vignette, edge detect (`edge`), emboss, ★extrude (`extrude`),
  ★oil paint (`oilPaint`), ★wind (`wind`)
- `sketch ▸` : ★chrome (`chrome`), ★photocopy (`photocopy`), ★stamp (`stamp`)
- `brush strokes ▸` : ★hatch (`hatch`), ★strokes (`strokes`)
- `artistic ▸` : ★watercolor (`watercolor`), ★plastic wrap (`plasticWrap`)
- `texture ▸` : grain, ★craquelure (`craquelure`), ★mosaic tiles (`mosaicTiles`), ★patchwork (`patchwork`)

**Promoted new effects (16):** spinBlur, unsharpMask, halftone, extrude,
oilPaint, wind, chrome, photocopy, stamp, hatch, strokes, watercolor,
plasticWrap, craquelure, mosaicTiles, patchwork.

**Left to the search picker (9):** directionalBlur (overlaps motion blur),
highPass, lensFlare, median, morphology (technical min/max), pondRipples,
relief (overlaps emboss), scatter (overlaps strokes), stipple (niche). All
remain fully usable via "Add Effect" search.

- Rationale for the two staples in that list: `highPass` and `lensFlare` are
  common, but each would be alone in its Photoshop category (`other` / `render`)
  under the ≥2 rule. Flagged as easy promotions if desired (add an `other` and/or
  `render` submenu). Deferred to keep the menu tidy per the "be selective" steer.

### Agent curated list

Restructure `CURATED_GROUPS` in `public/js/agent/effects.js` to mirror the new
taxonomy exactly (groups: tone, color, blur, sharpen, pixelate, stylize, sketch,
brushStrokes, artistic, texture), so `listCuratedEffects` and the human menu stay
in lockstep. This also resolves the pre-existing `colorReplace` drift.

### Default-output safety

Pure menu wiring: new `<div data-effect="filter/…">` entries flow through the
same `_handleAddEffectLayer` → `createEffectLayer` path as existing entries. No
param, default, or render change. Existing effects keep their exact behavior;
they are only relocated in the menu tree.

### Files (Part B)

- `public/index.html` (new `filter` menu block; trim `image` submenus; keep
  wiring generic so `#filterMenu` delegates like `#imageMenu`)
- `public/js/app.js` (`_setupMenuHandlers` / click delegation to include the
  `filter` menu; `_updateImageMenu` split/rename if it gates submenu state)
- `public/js/agent/effects.js` (`CURATED_GROUPS` restructure)

---

## Part C — Testing

Light, in-convention Playwright specs (flat in `tests/`, WebGL2 only — no new
backend seam):

1. `tests/filter-menu.spec.js`
   - Every `data-effect` in the `image` + `filter` menus resolves in
     `app._renderer.manifest` (guards against typo'd / dead menu items).
   - `CURATED_GROUPS` effect ids all resolve, and the promoted set matches the
     HTML `filter` menu (keeps the two surfaces in sync).
   - Clicking a representative new entry (e.g. `filter/oilPaint`) adds a layer
     with that `effectId` (reuses the existing add-effect UI pattern; assert on
     `_layers`/DSL as current effect specs do).
2. `tests/welcome-dialog.spec.js`
   - First run (cleared `localStorage`) shows the welcome dialog.
   - "don't show again" persists the flag; next boot skips to the open dialog.
   - Closing without choosing falls through to the open dialog.
   - `welcomeMenuItem` re-opens it.

Run render/UI specs single-worker to avoid software-WebGL contention flake
(existing repo guidance).

---

## Files touched (summary)

- New: `public/js/ui/welcome-dialog.js`, `tests/filter-menu.spec.js`,
  `tests/welcome-dialog.spec.js`
- Edit: `public/index.html`, `public/js/app.js`, `public/css/components.css`,
  `public/js/agent/effects.js`

## Risks / open items

- **Welcome ↔ open-dialog wiring** is the fiddliest bit; the plan will pin the
  exact reuse of `openDialog` callbacks so the two tiles don't duplicate
  base-creation logic and the fall-through path is airtight.
- **Menu-state gating:** if `_updateImageMenu` enables/disables submenu rows
  based on selection, the moved submenus must keep that behavior under `filter`.
- **highPass / lensFlare** promotion is a one-line-each follow-up if wanted.
- Copy + exact icon glyphs finalized during implementation (frontend-design).

## Out of scope (explicit)

Extended-filter mode UI; local help/catalog/localization; WebGPU test seam;
any engine or shader change; pushing or opening a PR.
