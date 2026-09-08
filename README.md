<!-- repo-hero -->
<a href="https://layers.noisefactor.io/"><img src="docs/hero.jpg" alt="Layers Non-destructive image and video editor" width="100%"></a>

<sub>Open source from <a href="https://noisefactor.io">Noise Factor</a> &middot; <a href="https://github.com/noisefactorllc">more projects</a></sub>

# Layers

Layers is a browser-based media editor with non-destructive layer compositing, powered by the Noisemaker shader pipeline. It runs entirely client-side.

## Features

- Layer stack with opacity, blend modes, visibility, and locking
- GPU-accelerated effects via WebGL shaders (blur, warp, noise, edge detection, dither, and others)
- Selection tools: rectangle, oval, lasso, polygon, magic wand
- Selection operations: expand, contract, feather, smooth, border, color range
- Image and video layer support
- Copy/paste, crop to selection, canvas resize, image resize
- Project persistence via IndexedDB
- Undo/redo with debounced parameter tracking
- Online collaboration (see below)

## Saving, recovery, and export

Save projects explicitly to keep them in this browser's IndexedDB storage. Layers also writes local recovery checkpoints while you edit. If unsaved work is available, use **File → recover unsaved work...** to restore it. **Keep for later** preserves a recovery copy for a later session. Checkpoints are asynchronous and can lag recent edits; they do not replace saving your project.

Undo history retains up to 50 states, including the current state, within an estimated 128 MiB budget. Older states are removed first. A large document can exceed that budget on its own, leaving the current state with no undo step. This budget covers retained history data, not the editor's total memory use.

Image imports retain the original file and dimensions while using a bounded interactive preview. Exports render at the requested dimensions, up to 8192 pixels per side and 33,554,432 pixels total, subject to the device's GPU limits. Large exports use tiles for supported layer combinations. Effects that cannot be tiled without changing their pixels must fit the GPU memory budget as a complete frame. If Layers rejects the requested size, choose smaller export dimensions; some original media can also exceed the device's texture limit.

## Requirements

- Node.js and npm
- A browser with WebGL2 support

## Development

```
npm install
npm run dev
```

This starts a local server on port 3002.

### Noisemaker

Layers loads the shader pipeline at runtime from the [Noisemaker](https://github.com/noisefactorllc/noisemaker) CDN at `https://shaders.noisedeck.app/1`. This follows the version 1 release channel. Browser CI records the channel's release metadata before and after testing in its evidence artifact.

## Testing

End-to-end tests use Playwright:

```
npm test
```

On Linux, the Firefox and WebKit CI jobs use a virtual display. Run their suites with:

```sh
xvfb-run -a npm test -- --project=firefox --headed
WEBKIT_GST_ALLOW_PLAYBACK_OF_INVISIBLE_VIDEOS=1 xvfb-run -a npm test -- --project=webkit --headed --workers=1
```

The WebKit command uses its upstream GLib test policy for offscreen video playback. These runs do not certify Apple Safari or default GTK offscreen-video behavior. CI runs the full Chromium, Firefox, and WebKit suites and requires every collected test to pass before releasing that source commit.

## Online collaboration

"go online..." (File menu) shares the current composition live via
[Seance](https://seance.noisefactor.io). Anyone with the link can join and
edit together in real time. Only Layers sessions are supported. Layers
cannot open a session from another Seance-connected app. Those apps cannot
open Layers sessions either.

Shared sessions do not support media layers (images/video clips) yet.
Their bytes live only in your browser's local storage. Remove any media
layers before you take a composition online.

## Third-Party Libraries

- [Noisemaker](https://github.com/noisefactorllc/noisemaker) — WebGL shader pipeline (MIT License)
- [Mediabunny](https://github.com/Vanilagy/mediabunny) by Vanilagy — MP4 video encoding via WebCodecs (MPL-2.0 License)
- [JSZip](http://stuartk.com/jszip) — ZIP file generation (MIT License or GPLv3)
- Cormorant Upright, Nunito, Noto Sans Mono — typefaces (OFL-1.1)
- Material Symbols Outlined — icon font by Google (Apache 2.0 License)

## License

Layers is released under the [MIT License](LICENSE). Use of name in derivative products is subject to the [Trademark Policy](TRADEMARK.md).

Copyright 2026 [Noise Factor LLC](https://noisefactor.io/)
