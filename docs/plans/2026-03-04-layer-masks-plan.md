# Layer Masks Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add per-layer grayscale masks (white=visible, black=hidden) with brush painting, selection conversion, and rubylith overlay.

**Architecture:** Masks are stored as `ImageData` on each layer. The upstream `alphaMask` mixer shader is extended with an `int maskMode` param for grayscale masking. Mask textures are uploaded alongside media textures and injected into the DSL between each layer's render and blend steps. Drawing tools reuse the existing `StrokeRenderer` to paint white (reveal) or black (hide) strokes onto mask ImageData.

**Tech Stack:** Vanilla JS (ES modules), WebGL2 (GLSL 300 es), Noisemaker shader pipeline, Playwright E2E tests.

---

### Task 1: Extend the alphaMask Shader

Add a `maskMode` int uniform to the upstream alphaMask effect. When `maskMode == 1`, the shader multiplies the input's alpha by the mask texture's luminance instead of doing an alpha blend.

**Files:**
- Modify: `../noisemaker/shaders/effects/mixer/alphaMask/definition.js`
- Modify: `../noisemaker/shaders/effects/mixer/alphaMask/glsl/alphaMask.glsl`
- Modify: `../noisemaker/shaders/effects/mixer/alphaMask/wgsl/alphaMask.wgsl`

**Step 1: Add `maskMode` param to definition.js**

Open `../noisemaker/shaders/effects/mixer/alphaMask/definition.js`. Add a new `maskMode` global after the `mix` global, and add it to the pass uniforms:

```javascript
import { Effect } from '../../../src/runtime/effect.js'

export default new Effect({
  name: "Alpha Mask",
  namespace: "mixer",
  func: "alphaMask",
  tags: ["blend"],

  description: "Alpha transparency blend",
  globals: {
    tex: {
      type: "surface",
      default: "none",
      ui: { label: "source b" }
    },
    mix: {
      type: "float",
      default: 0,
      uniform: "mixAmt",
      min: -100,
      max: 100,
      ui: { label: "mix", control: "slider" }
    },
    maskMode: {
      type: "int",
      default: 0,
      uniform: "maskMode",
      min: 0,
      max: 1,
      ui: { label: "mask mode", control: "slider" }
    }
  },
  paramAliases: { mixAmt: 'mix' },
  passes: [
    {
      name: "render",
      program: "alphaMask",
      inputs: { inputTex: "inputTex", tex: "tex" },
      uniforms: { mixAmt: "mix", maskMode: "maskMode" },
      outputs: { fragColor: "outputTex" }
    }
  ]
})
```

**Step 2: Update the GLSL shader**

Replace `../noisemaker/shaders/effects/mixer/alphaMask/glsl/alphaMask.glsl` with:

```glsl
#version 300 es
precision highp float;

uniform sampler2D inputTex;
uniform sampler2D tex;
uniform vec2 resolution;
uniform float mixAmt;
uniform int maskMode;
out vec4 fragColor;

float map(float value, float inMin, float inMax, float outMin, float outMax) {
    return outMin + (outMax - outMin) * (value - inMin) / (inMax - inMin);
}

void main() {
    vec2 st = gl_FragCoord.xy / resolution;

    vec4 color1 = texture(inputTex, st);
    vec4 color2 = texture(tex, st);

    if (maskMode == 1) {
        // Grayscale mask mode: multiply input alpha by mask luminance
        float maskVal = dot(color2.rgb, vec3(0.299, 0.587, 0.114));
        fragColor = vec4(color1.rgb, color1.a * maskVal);
        return;
    }

    // Original alpha blend
    vec4 middle = mix(color1, color2, color2.a);

    float amt = map(mixAmt, -100.0, 100.0, 0.0, 1.0);
    vec4 color;
    if (amt < 0.5) {
        float factor = amt * 2.0;
        color = mix(color1, middle, factor);
    } else {
        float factor = (amt - 0.5) * 2.0;
        color = mix(middle, color2, factor);
    }

    color.a = max(color1.a, color2.a);
    fragColor = color;
}
```

**Step 3: Update the WGSL shader**

Replace `../noisemaker/shaders/effects/mixer/alphaMask/wgsl/alphaMask.wgsl` with:

```wgsl
@group(0) @binding(0) var samp : sampler;
@group(0) @binding(1) var inputTex : texture_2d<f32>;
@group(0) @binding(2) var tex : texture_2d<f32>;
@group(0) @binding(3) var<uniform> mixAmt : f32;
@group(0) @binding(4) var<uniform> maskMode : i32;

fn map_range(value : f32, inMin : f32, inMax : f32, outMin : f32, outMax : f32) -> f32 {
    return outMin + (outMax - outMin) * (value - inMin) / (inMax - inMin);
}

@fragment
fn main(@builtin(position) position : vec4<f32>) -> @location(0) vec4<f32> {
    let dims = vec2<f32>(textureDimensions(inputTex, 0));
    var st = position.xy / dims;

    let color1 = textureSample(inputTex, samp, st);
    let color2 = textureSample(tex, samp, st);

    if (maskMode == 1) {
        // Grayscale mask mode: multiply input alpha by mask luminance
        let maskVal = dot(color2.rgb, vec3<f32>(0.299, 0.587, 0.114));
        return vec4<f32>(color1.rgb, color1.a * maskVal);
    }

    // Original alpha blend
    let middle = mix(color1, color2, color2.a);

    let amt = map_range(mixAmt, -100.0, 100.0, 0.0, 1.0);
    var color : vec4<f32>;
    if (amt < 0.5) {
        let factor = amt * 2.0;
        color = mix(color1, middle, factor);
    } else {
        let factor = (amt - 0.5) * 2.0;
        color = mix(middle, color2, factor);
    }

    color.a = max(color1.a, color2.a);
    return color;
}
```

**Step 4: Rebuild the Noisemaker bundle**

Run from the noisemaker repo root:
```bash
cd ../noisemaker && npm run build
```

Then copy the updated vendor bundle into Layers:
```bash
cp -r ../noisemaker/dist/effects/mixer/alphaMask.js public/js/noisemaker/vendor/effects/mixer/alphaMask.js
```

(Or however the vendor bundle is updated — check if `pull-noisemaker` script exists.)

**Step 5: Verify the shader compiles**

Start the dev server (`npm run dev`) and open the app. Open browser console — no shader compilation errors should appear. The existing alphaMask usage (if any) should still work since `maskMode` defaults to 0.

**Step 6: Commit**

```bash
git add -A && git commit -m "feat: add maskMode param to alphaMask shader for grayscale masking"
```

---

### Task 2: Extend the Layer Data Model

Add `mask`, `maskEnabled`, and `maskVisible` properties to the layer model. Update `cloneLayer()` and serialization.

**Files:**
- Modify: `public/js/layers/layer-model.js`

**Step 1: Add mask properties to `createLayer()`**

In `createLayer()` (line 27), add three new properties after the `children` property (line 59):

```javascript
        // Child effects (per-layer filter chain)
        children: options.children || [],

        // Layer mask (grayscale ImageData, white=visible, black=hidden)
        mask: options.mask || null,
        maskEnabled: options.maskEnabled !== false,
        maskVisible: options.maskVisible || false
```

**Step 2: Update `cloneLayer()` to deep-clone mask**

In `cloneLayer()` (line 131), add mask cloning. After the `drawingCanvas: null` line (138), add:

```javascript
        mask: layer.mask ? new ImageData(
            new Uint8ClampedArray(layer.mask.data),
            layer.mask.width, layer.mask.height
        ) : null,
```

The full `cloneLayer` should look like:

```javascript
export function cloneLayer(layer) {
    return {
        ...layer,
        id: `layer-${layerCounter++}`,
        name: `${layer.name} copy`,
        effectParams: JSON.parse(JSON.stringify(layer.effectParams)),
        strokes: layer.strokes ? JSON.parse(JSON.stringify(layer.strokes)) : layer.strokes,
        drawingCanvas: null,
        mask: layer.mask ? new ImageData(
            new Uint8ClampedArray(layer.mask.data),
            layer.mask.width, layer.mask.height
        ) : null,
        children: (layer.children || []).map(child => ({
            ...child,
            id: `layer-${layerCounter++}`,
            effectParams: JSON.parse(JSON.stringify(child.effectParams))
        }))
    }
}
```

**Step 3: Update `serializeLayers()` to encode masks**

Replace the `serializeLayers` function (line 152):

```javascript
export function serializeLayers(layers) {
    const serializableLayers = layers.map(layer => {
        const serialized = {
            ...layer,
            mediaFile: null,
            drawingCanvas: undefined
        }
        // Encode mask ImageData as base64 PNG
        if (layer.mask) {
            const canvas = document.createElement('canvas')
            canvas.width = layer.mask.width
            canvas.height = layer.mask.height
            canvas.getContext('2d').putImageData(layer.mask, 0, 0)
            serialized.mask = canvas.toDataURL('image/png')
        }
        return serialized
    })
    return JSON.stringify(serializableLayers)
}
```

**Step 4: Update `deserializeLayers()` to decode masks**

Replace the `deserializeLayers` function (line 167):

```javascript
export function deserializeLayers(json) {
    try {
        const layers = JSON.parse(json)
        // Mask base64 strings are decoded asynchronously after load
        return layers
    } catch {
        return []
    }
}

/**
 * Decode base64 mask strings to ImageData (call after deserialize)
 * @param {Array} layers - Layer array with possible base64 mask strings
 * @returns {Promise<void>}
 */
export async function decodeMasks(layers) {
    for (const layer of layers) {
        if (typeof layer.mask === 'string') {
            const img = new Image()
            await new Promise((resolve, reject) => {
                img.onload = resolve
                img.onerror = reject
                img.src = layer.mask
            })
            const canvas = document.createElement('canvas')
            canvas.width = img.width
            canvas.height = img.height
            const ctx = canvas.getContext('2d')
            ctx.drawImage(img, 0, 0)
            layer.mask = ctx.getImageData(0, 0, img.width, img.height)
        }
    }
}
```

**Step 5: Commit**

```bash
git add public/js/layers/layer-model.js && git commit -m "feat: add mask properties to layer data model"
```

---

### Task 3: Renderer Mask Texture Support

Add `_maskTextures` map to the renderer, mask texture upload, and inject `alphaMask(maskMode: 1)` into the DSL for masked layers.

**Files:**
- Modify: `public/js/noisemaker/renderer.js`

**Step 1: Add `_maskTextures` map**

In the constructor (after line 36 `this._mediaTextures = new Map()`), add:

```javascript
        this._maskTextures = new Map()
```

**Step 2: Add mask texture upload method**

Add this method after `unloadMedia()` (around line 590):

```javascript
    /**
     * Upload or update a mask texture for a layer.
     * @param {string} layerId - Layer ID
     * @param {ImageData} maskData - Grayscale mask ImageData
     */
    uploadMaskTexture(layerId, maskData) {
        const canvas = document.createElement('canvas')
        canvas.width = maskData.width
        canvas.height = maskData.height
        const ctx = canvas.getContext('2d')
        ctx.putImageData(maskData, 0, 0)

        this._maskTextures.set(layerId, {
            element: canvas,
            width: maskData.width,
            height: maskData.height
        })
    }

    /**
     * Remove a mask texture.
     * @param {string} layerId
     */
    removeMaskTexture(layerId) {
        this._maskTextures.delete(layerId)
    }
```

**Step 3: Add `_uploadMaskTextures()` method**

Add this method near `_uploadMediaTextures()` (around line 520):

```javascript
    _uploadMaskTextures() {
        const passes = this._renderer.pipeline?.graph?.passes
        if (!passes) return

        for (const [layerId, maskData] of this._maskTextures) {
            // Find the alphaMask step for this layer's mask
            // The texture ID follows the pattern: imageTex_step_{stepIndex}
            const maskStepKey = `mask_${layerId}`
            const stepIndex = this._layerStepMap.get(maskStepKey)
            if (stepIndex === undefined) continue

            const textureId = `imageTex_step_${stepIndex}`
            try {
                this._renderer.updateTextureFromSource?.(textureId, maskData.element, { flipY: false })
            } catch (err) {
                console.warn(`[LayersRenderer] Failed to upload mask texture for ${layerId}:`, err)
            }
        }
    }
```

**Step 4: Modify `_buildDsl()` to inject mask steps**

In `_buildDsl()`, for each visible layer with an enabled mask, insert an `alphaMask(maskMode: 1)` step between the layer render and the blend step.

For **non-base layers** (the `else` block starting at line 812), the current code is:

```javascript
            } else {
                // Non-base layers - blend with previous
                const prevOutput = currentOutput
                currentOutput++
                const mixAmt = this._opacityToMixAmt(layer.opacity)

                if (layer.sourceType === 'media' || layer.sourceType === 'drawing') {
                    lines.push(`${this._buildMediaCall()}.write(o${currentOutput})`)
                } else if (layer.sourceType === 'effect') {
                    // ...effect handling...
                }

                // Apply child effects to this layer's output
                currentOutput = this._buildChildChain(layer, currentOutput, lines)

                const nextOutput = currentOutput + 1
                lines.push(`read(o${prevOutput}).blendMode(tex: read(o${currentOutput}), mode: ${layer.blendMode}, mixAmt: ${mixAmt}).write(o${nextOutput})`)
                currentOutput = nextOutput
            }
```

After the `_buildChildChain()` call and before the `blendMode` line, insert the mask step:

```javascript
                // Apply child effects to this layer's output
                currentOutput = this._buildChildChain(layer, currentOutput, lines)

                // Apply layer mask if present and enabled
                if (layer.mask && layer.maskEnabled !== false) {
                    const maskOutput = currentOutput + 1
                    lines.push(`read(o${currentOutput}).alphaMask(tex: media(), maskMode: 1).write(o${maskOutput})`)
                    currentOutput = maskOutput
                }

                const nextOutput = currentOutput + 1
                lines.push(`read(o${prevOutput}).blendMode(tex: read(o${currentOutput}), mode: ${layer.blendMode}, mixAmt: ${mixAmt}).write(o${nextOutput})`)
                currentOutput = nextOutput
```

For the **base layer** non-solid case (line 800-810), add the same mask injection after `_buildChildChain()`:

```javascript
                    currentOutput += 2
                    currentOutput = this._buildChildChain(layer, currentOutput, lines)

                    // Apply layer mask if present and enabled
                    if (layer.mask && layer.maskEnabled !== false) {
                        const maskOutput = currentOutput + 1
                        lines.push(`read(o${currentOutput}).alphaMask(tex: media(), maskMode: 1).write(o${maskOutput})`)
                        currentOutput = maskOutput
                    }
```

**Step 5: Update `_buildLayerStepMap()` to track mask steps**

In `_buildLayerStepMap()` (line 245), after mapping a layer's main step, also map its mask step if it has one:

After the existing `mapStepIndex(layer.id, effectName)` call (line 281), add:

```javascript
            // Map mask step (alphaMask effect for this layer's mask)
            if (layer.mask && layer.maskEnabled !== false) {
                mapStepIndex(`mask_${layer.id}`, 'alphaMask')
            }
```

**Step 6: Call `_uploadMaskTextures()` after `_uploadMediaTextures()`**

Find where `_uploadMediaTextures()` is called in the rebuild flow. Add `this._uploadMaskTextures()` right after it.

Search for `_uploadMediaTextures` calls and add `_uploadMaskTextures` after each one.

**Step 7: Commit**

```bash
git add public/js/noisemaker/renderer.js && git commit -m "feat: renderer mask texture upload and DSL injection"
```

---

### Task 4: App-Level Mask Management

Add mask creation, deletion, inversion, and selection-to-mask conversion methods to `LayersApp`.

**Files:**
- Modify: `public/js/app.js`

**Step 1: Add mask state variables to constructor**

After line 78 (`this._restoring = false`), add:

```javascript
        // Mask editing
        this._maskEditMode = false
        this._maskEditLayerId = null
```

**Step 2: Update `_cloneLayers()` to deep-clone masks**

In `_cloneLayers()` (line 103), add mask cloning after the drawing clone block:

```javascript
    _cloneLayers(layers) {
        return layers.map(l => {
            const clone = {
                ...l,
                effectParams: JSON.parse(JSON.stringify(l.effectParams)),
                children: (l.children || []).map(c => ({
                    ...c,
                    effectParams: JSON.parse(JSON.stringify(c.effectParams))
                }))
            }
            if (l.sourceType === 'drawing') {
                clone.strokes = JSON.parse(JSON.stringify(l.strokes || []))
                clone.drawingCanvas = null
            }
            if (l.mask) {
                clone.mask = new ImageData(
                    new Uint8ClampedArray(l.mask.data),
                    l.mask.width, l.mask.height
                )
            }
            return clone
        })
    }
```

**Step 3: Update `_restoreState()` to reload mask textures**

In `_restoreState()` (line 176), after the drawing layer re-rasterization block (line 206), add:

```javascript
        // Re-upload mask textures after undo restore
        for (const layer of this._layers) {
            if (layer.mask) {
                this._renderer.uploadMaskTexture(layer.id, layer.mask)
            } else {
                this._renderer.removeMaskTexture(layer.id)
            }
        }
```

**Step 4: Add mask management methods**

Add these methods to `LayersApp` (after `_handleAutoCorrection` or similar):

```javascript
    /**
     * Add a fully white (revealed) mask to a layer.
     * @param {string} layerId
     */
    async _addLayerMask(layerId) {
        const layer = this._layers.find(l => l.id === layerId)
        if (!layer || layer.mask) return

        this._finalizePendingUndo()

        const w = this._canvas.width
        const h = this._canvas.height
        const mask = new ImageData(w, h)
        // Fill with white (fully visible)
        for (let i = 0; i < mask.data.length; i += 4) {
            mask.data[i] = 255     // R
            mask.data[i + 1] = 255 // G
            mask.data[i + 2] = 255 // B
            mask.data[i + 3] = 255 // A
        }
        layer.mask = mask
        layer.maskEnabled = true

        this._renderer.uploadMaskTexture(layerId, mask)
        this._updateLayerStack()
        await this._rebuild()
        this._markDirty()
        this._pushUndoState()
        toast.success('Layer mask added')
    }

    /**
     * Create a mask from the current selection.
     * @param {string} layerId
     */
    async _maskFromSelection(layerId) {
        const layer = this._layers.find(l => l.id === layerId)
        if (!layer) return

        const selMask = this._selectionManager.rasterizeSelection()
        if (!selMask) {
            toast.info('No selection active')
            return
        }

        this._finalizePendingUndo()
        layer.mask = selMask
        layer.maskEnabled = true

        this._renderer.uploadMaskTexture(layerId, selMask)
        this._updateLayerStack()
        await this._rebuild()
        this._markDirty()
        this._pushUndoState()
        toast.success('Mask created from selection')
    }

    /**
     * Delete a layer's mask.
     * @param {string} layerId
     */
    async _deleteLayerMask(layerId) {
        const layer = this._layers.find(l => l.id === layerId)
        if (!layer || !layer.mask) return

        this._finalizePendingUndo()
        layer.mask = null
        layer.maskEnabled = true
        layer.maskVisible = false

        if (this._maskEditMode && this._maskEditLayerId === layerId) {
            this._exitMaskEditMode()
        }

        this._renderer.removeMaskTexture(layerId)
        this._updateLayerStack()
        await this._rebuild()
        this._markDirty()
        this._pushUndoState()
        toast.info('Layer mask deleted')
    }

    /**
     * Invert a layer's mask (swap black/white).
     * @param {string} layerId
     */
    async _invertLayerMask(layerId) {
        const layer = this._layers.find(l => l.id === layerId)
        if (!layer?.mask) return

        this._finalizePendingUndo()
        const data = layer.mask.data
        for (let i = 0; i < data.length; i += 4) {
            data[i] = 255 - data[i]         // R
            data[i + 1] = 255 - data[i + 1] // G
            data[i + 2] = 255 - data[i + 2] // B
            // A stays 255
        }

        this._renderer.uploadMaskTexture(layerId, layer.mask)
        await this._rebuild()
        this._markDirty()
        this._pushUndoState()
        toast.success('Mask inverted')
    }

    /**
     * Toggle mask enabled/disabled.
     * @param {string} layerId
     */
    async _toggleMaskEnabled(layerId) {
        const layer = this._layers.find(l => l.id === layerId)
        if (!layer?.mask) return

        this._finalizePendingUndo()
        layer.maskEnabled = !layer.maskEnabled
        this._updateLayerStack()
        await this._rebuild()
        this._markDirty()
        this._pushUndoState()
    }

    /**
     * Create a selection from a layer's mask.
     * @param {string} layerId
     */
    _selectionFromMask(layerId) {
        const layer = this._layers.find(l => l.id === layerId)
        if (!layer?.mask) return

        this._selectionManager.setSelection({
            type: 'mask',
            data: new ImageData(
                new Uint8ClampedArray(layer.mask.data),
                layer.mask.width, layer.mask.height
            )
        })
        toast.success('Selection created from mask')
    }
```

**Step 5: Commit**

```bash
git add public/js/app.js && git commit -m "feat: mask management methods (add, delete, invert, from selection)"
```

---

### Task 5: Mask Editing Mode & Rubylith Overlay

Add mask editing mode: enter/exit, rubylith canvas overlay, and brush/eraser painting on the mask.

**Files:**
- Modify: `public/index.html` (add mask overlay canvas)
- Modify: `public/css/menu.css` (or a new CSS file for mask overlay)
- Modify: `public/js/app.js`

**Step 1: Add mask overlay canvas to HTML**

In `public/index.html`, after the selection overlay canvas (line 331):

```html
                <canvas id="selectionOverlay" width="1024" height="1024"></canvas>
                <canvas id="maskOverlay" width="1024" height="1024"></canvas>
```

**Step 2: Add CSS for mask overlay**

Add to `public/css/menu.css` (or wherever selection overlay styles live — check for `selectionOverlay` styles):

```css
#maskOverlay {
    position: absolute;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    pointer-events: none;
    z-index: 10;
}

#maskOverlay.hidden {
    display: none;
}
```

**Step 3: Add mask edit mode methods to LayersApp**

```javascript
    /**
     * Enter mask editing mode for a layer.
     * Shows rubylith overlay and switches tools to paint on mask.
     * @param {string} layerId
     */
    _enterMaskEditMode(layerId) {
        const layer = this._layers.find(l => l.id === layerId)
        if (!layer?.mask) return

        this._maskEditMode = true
        this._maskEditLayerId = layerId
        layer.maskVisible = true

        this._renderMaskOverlay(layer)
        this._updateLayerStack()
    }

    /**
     * Exit mask editing mode.
     */
    _exitMaskEditMode() {
        if (!this._maskEditMode) return

        const layer = this._layers.find(l => l.id === this._maskEditLayerId)
        if (layer) {
            layer.maskVisible = false
        }

        this._maskEditMode = false
        this._maskEditLayerId = null

        const overlay = document.getElementById('maskOverlay')
        if (overlay) {
            overlay.classList.add('hidden')
        }
        this._updateLayerStack()
    }

    /**
     * Render the rubylith overlay for a mask.
     * Red = hidden areas, transparent = visible areas.
     * @param {object} layer
     */
    _renderMaskOverlay(layer) {
        const overlay = document.getElementById('maskOverlay')
        if (!overlay || !layer.mask) return

        overlay.width = layer.mask.width
        overlay.height = layer.mask.height
        overlay.classList.remove('hidden')

        const ctx = overlay.getContext('2d')
        ctx.clearRect(0, 0, overlay.width, overlay.height)

        // Create rubylith: red where mask is dark (hidden)
        const maskData = layer.mask
        const overlayData = ctx.createImageData(overlay.width, overlay.height)
        for (let i = 0; i < maskData.data.length; i += 4) {
            const maskVal = maskData.data[i] // Red channel = mask value
            const hiddenAmount = 1 - maskVal / 255
            overlayData.data[i] = 255       // R
            overlayData.data[i + 1] = 0     // G
            overlayData.data[i + 2] = 0     // B
            overlayData.data[i + 3] = Math.round(hiddenAmount * 128) // A (semi-transparent)
        }
        ctx.putImageData(overlayData, 0, 0)
    }

    /**
     * Handle a completed stroke in mask edit mode.
     * Composites the stroke onto the mask ImageData.
     * @param {object} stroke - Stroke object
     * @param {boolean} isEraser - True if erasing (paint black/hide)
     */
    async _handleMaskStroke(stroke, isEraser) {
        const layer = this._layers.find(l => l.id === this._maskEditLayerId)
        if (!layer?.mask) return

        this._finalizePendingUndo()

        // Rasterize the stroke to a temporary canvas
        if (!this._strokeRenderer) {
            this._strokeRenderer = new StrokeRenderer()
        }

        // Force stroke color: white for brush (reveal), black for eraser (hide)
        const maskStroke = { ...stroke, color: isEraser ? '#000000' : '#ffffff' }
        const strokeCanvas = this._strokeRenderer.rasterize(
            [maskStroke], layer.mask.width, layer.mask.height
        )

        // Composite onto the mask
        const maskCanvas = document.createElement('canvas')
        maskCanvas.width = layer.mask.width
        maskCanvas.height = layer.mask.height
        const ctx = maskCanvas.getContext('2d')
        ctx.putImageData(layer.mask, 0, 0)
        ctx.drawImage(strokeCanvas, 0, 0)

        // Read back the composited result
        layer.mask = ctx.getImageData(0, 0, maskCanvas.width, maskCanvas.height)

        // Update texture and overlay
        this._renderer.uploadMaskTexture(layer.id, layer.mask)
        this._renderMaskOverlay(layer)
        await this._rebuild()
        this._markDirty()
        this._pushUndoStateDebounced()
    }
```

**Step 4: Wire up the drawing tools to handle mask mode**

Find where brush/eraser tools commit strokes (search for `_commitStroke` or the stroke completion handler). When `_maskEditMode` is true, route the completed stroke to `_handleMaskStroke()` instead of adding it to a drawing layer.

Look at how `BrushTool` and `EraserTool` dispatch completed strokes — they likely emit an event or call a callback. Intercept that:

In the brush/eraser completion handler in `app.js`, add a check:

```javascript
// Inside the stroke completion callback:
if (this._maskEditMode) {
    await this._handleMaskStroke(completedStroke, isEraser)
    return // Don't add to drawing layer
}
// ...existing drawing layer logic...
```

**Step 5: Add Escape key handler for mask edit mode**

In the keyboard shortcut handler (search for `keydown` in app.js), add:

```javascript
if (e.key === 'Escape' && this._maskEditMode) {
    this._exitMaskEditMode()
    return
}
```

**Step 6: Commit**

```bash
git add public/index.html public/css/menu.css public/js/app.js && git commit -m "feat: mask editing mode with rubylith overlay and brush painting"
```

---

### Task 6: Layer-Item Mask UI

Add mask thumbnail, click-to-edit, shift-click-for-overlay, and context menu to layer-item.

**Files:**
- Modify: `public/js/layers/layer-item.js`
- Modify: `public/css/layers.css` (mask thumbnail styles)

**Step 1: Add mask thumbnail to `_render()` template**

In `layer-item.js` `_render()` method (line 81), after the layer thumbnail div (line 122-124), add a mask thumbnail:

```javascript
                <div class="layer-thumbnail">
                    <span class="icon-material">${iconName}</span>
                </div>
                ${layer.mask ? `<div class="layer-mask-thumbnail ${layer.maskVisible ? 'mask-visible' : ''} ${!layer.maskEnabled ? 'mask-disabled' : ''}" title="Click: edit mask | Shift+click: toggle overlay | Right-click: mask options">
                    <canvas class="mask-thumb-canvas" width="24" height="24"></canvas>
                </div>` : ''}
```

**Step 2: Render the mask thumbnail canvas**

After `_render()` completes, add a method to draw the mask preview:

```javascript
    /**
     * Draw the mask preview into the thumbnail canvas
     * @private
     */
    _renderMaskThumbnail() {
        const canvas = this.querySelector('.mask-thumb-canvas')
        if (!canvas || !this._layer?.mask) return

        const ctx = canvas.getContext('2d')
        const mask = this._layer.mask

        // Draw scaled-down mask preview
        const tempCanvas = document.createElement('canvas')
        tempCanvas.width = mask.width
        tempCanvas.height = mask.height
        tempCanvas.getContext('2d').putImageData(mask, 0, 0)

        ctx.clearRect(0, 0, 24, 24)
        ctx.drawImage(tempCanvas, 0, 0, 24, 24)
    }
```

Call this at the end of `_render()`, after the `_initEffectParams()` call:

```javascript
        this._initEffectParams()
        this._renderMaskThumbnail()
```

**Step 3: Add mask event handlers**

In `_setupEventListeners()` (line 198), add handlers for the mask thumbnail:

```javascript
            // Mask thumbnail interactions
            const maskThumb = e.target.closest('.layer-mask-thumbnail')
            if (maskThumb) {
                e.stopPropagation()
                if (e.shiftKey) {
                    // Shift+click: toggle rubylith overlay
                    this.dispatchEvent(new CustomEvent('mask-toggle-visible', {
                        bubbles: true,
                        detail: { layerId: this._layer.id }
                    }))
                } else {
                    // Click: enter/exit mask edit mode
                    this.dispatchEvent(new CustomEvent('mask-edit', {
                        bubbles: true,
                        detail: { layerId: this._layer.id }
                    }))
                }
                return
            }
```

Add right-click context menu for the mask:

```javascript
        // Right-click on mask thumbnail
        this.addEventListener('contextmenu', (e) => {
            const maskThumb = e.target.closest('.layer-mask-thumbnail')
            if (maskThumb) {
                e.preventDefault()
                e.stopPropagation()
                this.dispatchEvent(new CustomEvent('mask-context-menu', {
                    bubbles: true,
                    detail: {
                        layerId: this._layer.id,
                        x: e.clientX,
                        y: e.clientY
                    }
                }))
            }
        })
```

**Step 4: Add mask thumbnail CSS**

In the layers CSS file, add:

```css
.layer-mask-thumbnail {
    width: 24px;
    height: 24px;
    border: 1px solid var(--accent3);
    border-radius: 2px;
    cursor: pointer;
    flex-shrink: 0;
    overflow: hidden;
}

.layer-mask-thumbnail:hover {
    border-color: var(--accent4);
}

.layer-mask-thumbnail.mask-visible {
    border-color: #e74c3c;
    box-shadow: 0 0 0 1px #e74c3c;
}

.layer-mask-thumbnail.mask-disabled {
    opacity: 0.4;
}

.mask-thumb-canvas {
    width: 100%;
    height: 100%;
    display: block;
}
```

**Step 5: Commit**

```bash
git add public/js/layers/layer-item.js public/css/layers.css && git commit -m "feat: mask thumbnail UI in layer-item with click/shift-click/right-click"
```

---

### Task 7: Wire Up Mask Events & Context Menu

Connect the layer-item mask events to the app's mask management methods. Build a lightweight context menu for mask operations.

**Files:**
- Modify: `public/js/app.js`
- Modify: `public/index.html` (add mask context menu)

**Step 1: Add mask context menu HTML**

In `index.html`, add a context menu element (e.g., near the end of the body, before the closing `</body>` tag):

```html
        <div id="maskContextMenu" class="mask-context-menu hidden">
            <div data-action="invert">Invert Mask</div>
            <div data-action="disable">Disable Mask</div>
            <div data-action="selection-from-mask">Selection from Mask</div>
            <hr class="menu-seperator">
            <div data-action="delete">Delete Mask</div>
        </div>
```

**Step 2: Add context menu CSS**

Add to `menu.css`:

```css
.mask-context-menu {
    position: fixed;
    background-color: color-mix(in srgb, var(--color2) var(--effect-surface-opacity), transparent var(--effect-surface-transparency));
    backdrop-filter: var(--glass-blur-strength);
    -webkit-backdrop-filter: var(--glass-blur-strength);
    box-shadow: var(--shadow-lg);
    border-radius: var(--ui-corner-radius-small);
    z-index: 3000;
    min-width: 180px;
    font-family: Nunito, 'Nunito Block';
    font-size: 0.875rem;
    color: var(--accent3);
}

.mask-context-menu.hidden {
    display: none;
}

.mask-context-menu div {
    padding: 8px 16px;
    cursor: pointer;
}

.mask-context-menu div:hover {
    background-color: rgba(255, 255, 255, 0.08);
    color: var(--accent4);
}
```

**Step 3: Add mask event listeners in app.js**

In the `_setupMenuHandlers()` method (or wherever layer-stack events are handled), add listeners for the mask events:

```javascript
        // Mask events from layer-item
        this._layerStack?.addEventListener('mask-edit', (e) => {
            const { layerId } = e.detail
            if (this._maskEditMode && this._maskEditLayerId === layerId) {
                this._exitMaskEditMode()
            } else {
                if (this._maskEditMode) this._exitMaskEditMode()
                this._enterMaskEditMode(layerId)
            }
        })

        this._layerStack?.addEventListener('mask-toggle-visible', (e) => {
            const layer = this._layers.find(l => l.id === e.detail.layerId)
            if (!layer?.mask) return
            layer.maskVisible = !layer.maskVisible
            if (layer.maskVisible) {
                this._renderMaskOverlay(layer)
            } else {
                document.getElementById('maskOverlay')?.classList.add('hidden')
            }
            this._updateLayerStack()
        })

        this._layerStack?.addEventListener('mask-context-menu', (e) => {
            const { layerId, x, y } = e.detail
            this._showMaskContextMenu(layerId, x, y)
        })
```

**Step 4: Add context menu handler methods**

```javascript
    _showMaskContextMenu(layerId, x, y) {
        const menu = document.getElementById('maskContextMenu')
        if (!menu) return

        const layer = this._layers.find(l => l.id === layerId)
        if (!layer) return

        // Update disable/enable text
        const disableItem = menu.querySelector('[data-action="disable"]')
        if (disableItem) {
            disableItem.textContent = layer.maskEnabled ? 'Disable Mask' : 'Enable Mask'
        }

        menu.style.left = `${x}px`
        menu.style.top = `${y}px`
        menu.classList.remove('hidden')
        menu.dataset.layerId = layerId

        // Close on click outside
        const close = (e) => {
            if (!menu.contains(e.target)) {
                menu.classList.add('hidden')
                document.removeEventListener('click', close)
            }
        }
        setTimeout(() => document.addEventListener('click', close), 0)

        // Handle menu item clicks
        menu.onclick = async (e) => {
            const action = e.target.closest('[data-action]')?.dataset.action
            if (!action) return
            menu.classList.add('hidden')

            switch (action) {
                case 'invert': await this._invertLayerMask(layerId); break
                case 'disable': await this._toggleMaskEnabled(layerId); break
                case 'selection-from-mask': this._selectionFromMask(layerId); break
                case 'delete': await this._deleteLayerMask(layerId); break
            }
        }
    }
```

**Step 5: Add "Add Mask" and "Mask from Selection" to the layer right-click or layer-stack UI**

Add right-click context menu support to the layer-item itself (for layers without masks):

In `layer-item.js`, add a `contextmenu` handler for the whole layer row:

```javascript
        // Right-click on layer row (when no mask thumbnail targeted)
        this.addEventListener('contextmenu', (e) => {
            if (e.target.closest('.layer-mask-thumbnail')) return // handled above
            e.preventDefault()
            this.dispatchEvent(new CustomEvent('layer-context-menu', {
                bubbles: true,
                detail: {
                    layerId: this._layer.id,
                    hasMask: !!this._layer.mask,
                    x: e.clientX,
                    y: e.clientY
                }
            }))
        })
```

Then in app.js, handle `layer-context-menu` to show options including "Add Layer Mask" and "Mask from Selection":

```javascript
        this._layerStack?.addEventListener('layer-context-menu', (e) => {
            const { layerId, hasMask, x, y } = e.detail
            this._showLayerContextMenu(layerId, hasMask, x, y)
        })
```

Add a second context menu element to HTML for layers, and the handler method. Keep it simple — just "Add Layer Mask" and "Mask from Selection" for now.

**Step 6: Exit mask edit mode when selecting a different layer**

In the layer selection handler (search for `layer-select` event in app.js), add:

```javascript
        // When selecting a different layer, exit mask edit mode
        if (this._maskEditMode && layerId !== this._maskEditLayerId) {
            this._exitMaskEditMode()
        }
```

**Step 7: Commit**

```bash
git add public/js/app.js public/js/layers/layer-item.js public/index.html public/css/menu.css && git commit -m "feat: mask context menus and event wiring"
```

---

### Task 8: E2E Tests for Layer Masks

Write Playwright tests covering mask creation, mask editing, mask visibility, and undo/redo.

**Files:**
- Create: `tests/layer-masks.spec.js`

**Step 1: Write the test file**

```javascript
import { test, expect } from 'playwright/test'

test.describe('Layer masks', () => {
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

        // Add a second layer (gradient effect) so we can see masking
        await page.evaluate(async () => {
            await window.layersApp._handleAddEffectLayer('synth/gradient')
        })
        await page.waitForTimeout(500)
    })

    test('add layer mask creates white mask', async ({ page }) => {
        // Add mask to the top layer via the app method
        await page.evaluate(async () => {
            const topLayer = window.layersApp._layers[1]
            await window.layersApp._addLayerMask(topLayer.id)
        })

        const hasMask = await page.evaluate(() => {
            const topLayer = window.layersApp._layers[1]
            return topLayer.mask !== null && topLayer.maskEnabled === true
        })
        expect(hasMask).toBe(true)

        // Mask should be all white (255)
        const isAllWhite = await page.evaluate(() => {
            const mask = window.layersApp._layers[1].mask
            for (let i = 0; i < mask.data.length; i += 4) {
                if (mask.data[i] !== 255) return false
            }
            return true
        })
        expect(isAllWhite).toBe(true)
    })

    test('mask thumbnail appears in layer-item', async ({ page }) => {
        await page.evaluate(async () => {
            const topLayer = window.layersApp._layers[1]
            await window.layersApp._addLayerMask(topLayer.id)
        })
        await page.waitForTimeout(300)

        const maskThumb = page.locator('.layer-mask-thumbnail')
        await expect(maskThumb).toBeVisible()
    })

    test('invert mask changes white to black', async ({ page }) => {
        await page.evaluate(async () => {
            const topLayer = window.layersApp._layers[1]
            await window.layersApp._addLayerMask(topLayer.id)
            await window.layersApp._invertLayerMask(topLayer.id)
        })

        const isAllBlack = await page.evaluate(() => {
            const mask = window.layersApp._layers[1].mask
            for (let i = 0; i < mask.data.length; i += 4) {
                if (mask.data[i] !== 0) return false
            }
            return true
        })
        expect(isAllBlack).toBe(true)
    })

    test('delete mask removes it', async ({ page }) => {
        await page.evaluate(async () => {
            const topLayer = window.layersApp._layers[1]
            await window.layersApp._addLayerMask(topLayer.id)
            await window.layersApp._deleteLayerMask(topLayer.id)
        })

        const hasMask = await page.evaluate(() => {
            return window.layersApp._layers[1].mask === null
        })
        expect(hasMask).toBe(true)
    })

    test('toggle mask enabled/disabled', async ({ page }) => {
        await page.evaluate(async () => {
            const topLayer = window.layersApp._layers[1]
            await window.layersApp._addLayerMask(topLayer.id)
            await window.layersApp._toggleMaskEnabled(topLayer.id)
        })

        const isDisabled = await page.evaluate(() => {
            return window.layersApp._layers[1].maskEnabled === false
        })
        expect(isDisabled).toBe(true)
    })

    test('undo restores mask state', async ({ page }) => {
        await page.evaluate(async () => {
            const topLayer = window.layersApp._layers[1]
            await window.layersApp._addLayerMask(topLayer.id)
        })

        // Mask exists
        let hasMask = await page.evaluate(() => window.layersApp._layers[1].mask !== null)
        expect(hasMask).toBe(true)

        // Undo should remove the mask
        await page.evaluate(async () => { await window.layersApp._undo() })
        await page.waitForTimeout(300)

        hasMask = await page.evaluate(() => window.layersApp._layers[1].mask !== null)
        expect(hasMask).toBe(false)
    })
})
```

**Step 2: Run the tests to verify they fail (no implementation yet) or pass**

```bash
npx playwright test tests/layer-masks.spec.js --reporter=list
```

**Step 3: Commit**

```bash
git add tests/layer-masks.spec.js && git commit -m "test: E2E tests for layer masks"
```

---

### Task 9: Integration Testing & Bug Fixes

Run all tests, fix any issues, and verify end-to-end behavior.

**Files:**
- Modify: Any files with bugs found during testing

**Step 1: Run the full test suite**

```bash
npx playwright test --reporter=list
```

Fix any failures.

**Step 2: Manual verification checklist**

1. Create a project with 2+ layers
2. Right-click layer → Add Layer Mask → white mask thumbnail appears
3. Click mask thumbnail → rubylith overlay shows (all transparent since mask is white)
4. Select brush tool → paint on canvas → rubylith shows red where painted
5. Select eraser tool → erase on canvas → rubylith clears
6. Press Escape → exits mask edit mode
7. Shift-click mask thumbnail → toggles overlay without entering edit mode
8. Right-click mask thumbnail → Invert Mask → mask inverts visually
9. Right-click mask thumbnail → Delete Mask → mask removed
10. Undo/Redo → mask state restored correctly
11. Make a selection → right-click layer → Mask from Selection → mask matches selection shape

**Step 3: Fix any issues found**

Common issues to watch for:
- Mask texture not uploaded after rebuild → check `_uploadMaskTextures()` is called
- DSL compilation error → check output buffer indexing in mask injection
- Rubylith overlay misaligned → check canvas dimensions match
- Undo doesn't restore mask → check `_cloneLayers()` deep-clones ImageData

**Step 4: Final commit**

```bash
git add -A && git commit -m "fix: integration fixes for layer masks"
```
