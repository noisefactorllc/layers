/**
 * One-line description of each public LayersAgent command, in the groups and
 * order that `public/llms-full.txt` lists them.
 *
 * `scripts/build-llms-full.mjs` renders the command reference from this file
 * and SCHEMAS. `scripts/llms-full.test.mjs` fails when a registered command
 * has no entry here, or when llms-full.txt does not match a fresh render.
 * Agents can also read this module at runtime:
 * `const { COMMAND_GROUPS } = await import('/js/agent/descriptions.js')`.
 *
 * @module agent/descriptions
 */

export const COMMAND_GROUPS = [
    {
        title: 'Read state',
        commands: {
            getState: 'Returns the full state snapshot. Every envelope already includes it in `state`.',
            getLayer: 'Returns the snapshot of one layer.',
            getCanvasSize: 'Returns the canvas width and height in pixels.',
            getSelection: 'Returns the active selection (kind, bounds, optional polygon points), or null when there is no selection.',
            getProjectInfo: 'Returns the project part of the snapshot: id, name, isDirty, canUndo, canRedo and canSaveAs.',
            listProjects: 'Lists the projects saved in this browser, with id, name, createdAt and modifiedAt.',
            getSettings: 'Returns the theme and export presets that this browser stores.',
            getForegroundColor: 'Returns `{color}`, where `color` is a `#rrggbb` string.',
        },
    },
    {
        title: 'Find effects',
        commands: {
            searchEffects: 'Searches the effect catalog. `query` matches a substring, every tag in `tags` must match, and `limit` sets the maximum count.',
            listEffectCategories: 'Returns every namespace and tag in the effect catalog.',
            listCuratedEffects: 'Returns the effect groups that the Image and Filter menus show.',
            getEffectDefinition: 'Returns the parameters of one effect: name, type, default, range and allowed values.',
        },
    },
    {
        title: 'Jobs',
        commands: {
            getJob: 'Returns the current state of a job: status, progress, and the result or error.',
            waitForJob: 'Waits until a job settles or `timeoutMs` passes. A timeout returns `ok: true` with `result.timedOut: true`.',
            cancelJob: 'Asks a running job to stop. The job stops at its next check, for example between video frames.',
        },
    },
    {
        title: 'Layers',
        commands: {
            addLayer: 'Adds a layer and returns its id. `kind` is effect (needs `effectId`), drawing, media (needs `source` and `mediaType`) or text (needs `text`). `source` has the same shape as in pasteImageFromBytes.',
            deleteLayer: 'Deletes a layer. The base layer at index 0 cannot be deleted.',
            duplicateLayer: 'Duplicates a layer, selects the copy, and returns its id.',
            reorderLayer: 'Moves a layer to `toIndex`. Index 0 is the base layer at the bottom. The base layer cannot move, and no layer can move to index 0.',
            selectLayer: 'Makes one layer the active layer.',
            selectLayers: 'Selects the given layers. The first id becomes the active layer.',
            flattenImage: 'Merges all layers into one media layer.',
            flattenLayers: 'Merges two or more given layers into one raster layer. The other layers do not change.',
            rasterizeLayer: 'Changes an effect or drawing layer into a media layer with its current pixels. The layer loses its effect parameters or strokes.',
            flipLayer: 'Flips a media layer horizontally (`h`) or vertically (`v`). Other layer types are not supported.',
            setLayerProps: 'Sets the name, visible, opacity, blendMode or locked property of a layer.',
            setLayerTransform: 'Sets the offset, scale, rotation or flip of a layer. Only media and drawing layers accept a transform.',
        },
    },
    {
        title: 'Effect parameters and child effects',
        commands: {
            setLayerEffectParams: 'Changes the parameters of an effect layer. The new values merge into the old values. `replace: true` clears the old values first.',
            addChildEffect: 'Adds a child effect to a layer and returns its id. A child effect applies on top of the output of its layer.',
            removeChildEffect: 'Removes a child effect from a layer.',
            reorderChildEffect: 'Moves a child effect to `toIndex` in the child list of its layer.',
            setChildEffectProps: 'Sets the `visible` or `name` property of a child effect. Unknown keys fail validation.',
            setChildEffectParams: 'Changes the parameters of a child effect. The new values merge into the old values. `replace: true` clears the old values first.',
            deleteChildEffectMask: 'Removes the selection mask captured when a child effect was added.',
        },
    },
    {
        title: 'Images and export',
        commands: {
            getCanvasImageBytes: 'Returns the full-size canvas as base64 image data. No download starts.',
            getThumbnail: 'Returns a small canvas image as base64 data. The longest side is `maxDimension` (default 256).',
            getLayerThumbnail: 'Returns a small image of one layer, with its child effects and mask, as base64 data.',
            exportImage: 'Exports the canvas as an image. By default, it starts a browser download. The result always includes the image as base64 in `bytes`.',
            pasteImageFromBytes: 'Adds an image as a new media layer. `source` is `{kind: "base64", data, mimeType?}` or `{kind: "url", value}`. `data` is raw base64, without a `data:` prefix.',
            exportVideo: 'Starts a video export job (MP4, or a ZIP of PNG frames) and returns its `jobId`. The file downloads when the job succeeds.',
            releaseExport: 'Frees the blob URL of a `captureOnly` video export. Call it after you read the bytes.',
        },
    },
    {
        title: 'Selections',
        commands: {
            selectAll: 'Selects the whole canvas.',
            selectNone: 'Clears the selection.',
            selectInverse: 'Inverts the selection. A selection must be active.',
            setRectangleSelection: 'Selects a rectangle from its top-left corner, width and height.',
            setOvalSelection: 'Selects the oval inside the given rectangle.',
            setPolygonSelection: 'Selects a polygon or lasso shape from 3 or more points. Each point is `[x, y]`.',
            setMagicWandSelection: 'Selects the connected pixels with a color near the color at (x, y). `tolerance` is 0 to 255 (default 32).',
            selectColorRange: 'Selects every pixel with a color near the color at (x, y), connected or not. `tolerance` defaults to 32.',
            expandSelection: 'Grows the selection by `pixels`.',
            contractSelection: 'Shrinks the selection by `pixels`.',
            featherSelection: 'Softens the selection edge over `pixels`.',
            smoothSelection: 'Smooths rough selection edges with a blur of `pixels`.',
            borderSelection: 'Replaces the selection with a band, `pixels` wide, inside its edge.',
            cropToSelection: 'Crops the image and canvas to the bounding box of the selection.',
        },
    },
    {
        title: 'Masks',
        commands: {
            addLayerMask: 'Adds a white mask to a layer. A white mask shows the full layer.',
            deleteLayerMask: 'Removes the mask of a layer. The layer pixels do not change.',
            addMaskFromSelection: 'Adds a mask to a layer. The mask starts as a copy of the current selection.',
            selectFromLayerMask: 'Creates a raster selection from the visible values of a layer mask.',
            getRasterRegion: 'Reads up to 256 by 256 grayscale values from a selection, layer mask, or child effect mask. `values` is row-major. Pass `layerId` for a layer mask, and both `layerId` and `childId` for a child mask.',
            paintLayerMask: 'Paints a stroke on a layer mask in canvas coordinates. `mode` is `hide` (black) or `reveal` (white).',
            invertLayerMask: 'Inverts the mask of a layer.',
            setMaskEnabled: 'Turns the mask of a layer on or off. A disabled mask stays on the layer.',
            setMaskVisible: 'Shows or hides the layer mask overlay without changing its effect on the image. Only one overlay can be shown; read its owner from `state.view.maskOverlayLayerId`.',
            setMaskEditMode: 'Enters the existing mask brush mode with `enabled: true, layerId`, or exits it with `enabled: false`. The active mask edit layer is in `state.view.maskEditLayerId`.',
            featherMask: 'Softens the mask edge over `radius` pixels.',
            expandMask: 'Grows the mask by `radius` pixels.',
            contractMask: 'Shrinks the mask by `radius` pixels.',
            smoothMask: 'Smooths rough mask edges with a blur of `radius` pixels.',
        },
    },
    {
        title: 'Drawing',
        commands: {
            paintStroke: 'Paints a stroke through 2 or more `points` (`[x, y]` or `{x, y}`) on a drawing layer. With `mode: "eraser"`, the stroke paints transparency. Without `layerId`, see drawShape.',
            getDrawingStrokes: 'Returns up to `limit` editable strokes (default 100) from `offset` (default 0), including ids and geometry. `nextOffset` is null on the last page.',
            eraseStroke: 'Removes one stroke, by its `strokeId`, from a drawing layer.',
            clearDrawingLayer: 'Removes all strokes from a drawing layer and returns the number it removed.',
            drawShape: 'Draws a rectangle or ellipse, filled or outlined, on a drawing layer. Without `layerId`, it uses the active layer if that is a drawing layer. Otherwise it adds a drawing layer above the active layer.',
            fillRegion: 'Adds a media layer of `color` in the shape of the connected area with a color near the color at (x, y). The new layer has no mask.',
        },
    },
    {
        title: 'Projects and history',
        commands: {
            newProject: 'Starts a new empty project at the given size. It discards unsaved changes without a warning.',
            openProject: 'Opens a saved project in place of the current project.',
            saveProject: 'Saves the current project. `name` renames it. When the project has no name yet, `name` is necessary.',
            saveProjectAs: 'Saves the current state as a new project named `name` and returns its id.',
            deleteProject: 'Deletes a saved project. When it is the open project, the canvas keeps its content.',
            listRecoveryCopies: 'Lists recoverable unsaved compositions with id, name, dimensions, layer count, and modification time.',
            restoreRecoveryCopy: 'Restores a recovery copy by id, replacing the current composition. Save current work first if needed.',
            discardRecoveryCopy: 'Permanently discards a recovery copy by id.',
            undo: 'Undoes the last change. When `canUndo` is false, nothing changes.',
            redo: 'Redoes the last undone change. When `canRedo` is false, nothing changes.',
        },
    },
    {
        title: 'View and settings',
        commands: {
            setForegroundColor: 'Sets the foreground color from a `#rrggbb` string.',
            setZoom: 'Sets the zoom mode.',
            setPan: 'Scrolls the canvas viewport to `x`, `y` pixels. The browser clamps the result to the available scroll range.',
            setTool: 'Activates a toolbar tool. Transform requires an active media or drawing layer.',
            setSelectionTool: 'Activates a marquee selection tool and switches to selection mode.',
            play: 'Starts the animation of time-based effects.',
            pause: 'Stops the animation. The current frame stays visible.',
            setSettings: 'Changes settings. Only `theme` has an effect.',
        },
    },
    {
        title: 'Canvas and adjustments',
        commands: {
            resizeImage: 'Resamples the image and all layers to a new size. The selection does not change. Call `selectNone` to clear it.',
            resizeCanvas: 'Changes the canvas size without resampling. `anchor` (default center) sets the position of the layers.',
            autoLevels: 'Adds an adjustment layer that stretches the tonal range. Returns `applied: false` when no change is necessary.',
            autoContrast: 'Adds an adjustment layer that stretches luminance to the full range. Returns `applied: false` when no change is necessary.',
            autoWhiteBalance: 'Adds an adjustment layer that makes the brightest area neutral white. Returns `applied: false` when no change is necessary.',
        },
    },
    {
        title: 'Fonts',
        commands: {
            listInstalledFonts: 'Returns the state of the font bundle: installed, version, count, and each font as id, family and category.',
            installFontBundle: 'Starts a job that downloads the font bundle (about 140 MB) into browser storage. Returns its `jobId`.',
        },
    },
    {
        title: 'Online collaboration',
        commands: {
            takeOnline: 'Starts a shared session for the current composition when online collaboration is enabled. Returns the session id; state.collaboration includes the share URL.',
            joinSession: 'Joins a session by id, replacing the current composition without a dialog. Save first if needed.',
            goOffline: 'Leaves the active shared session without changing the composition.',
        },
    },
]
