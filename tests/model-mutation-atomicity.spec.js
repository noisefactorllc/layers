import { test, expect } from './fixtures.js'
import { reopenNewProjectDialog } from './helpers/new-project.js'

const TINY_PNG_B64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='

async function bootSolid(page) {
    await page.goto('/', { waitUntil: 'networkidle' })
    await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })
    await reopenNewProjectDialog(page)
    const backdrop = page.locator('.open-dialog-backdrop.visible')
    await page.locator('.media-option[data-type="solid"]').click()
            // 512 preset: quarters the composited frame cost on software-rendered CI
            // shards (same capacity trim as drawing-shortcuts); this suite reads no
    // absolute canvas coordinates.
    await page.locator('.size-preset[data-width="512"]').click()
    await page.locator('.canvas-size-dialog .action-btn.primary').click()
    await backdrop.waitFor({ state: 'hidden' })
}

const modelCases = [
    { name: 'auto correction', operation: 'auto' },
    { name: 'child add', operation: 'child-add' },
    { name: 'child delete', operation: 'child-delete' },
    { name: 'layer visibility', operation: 'visibility' },
    { name: 'layer opacity with pending undo', operation: 'opacity' },
    { name: 'layer blend mode', operation: 'blendMode' },
    { name: 'layer name', operation: 'name' },
]

for (const entry of modelCases) {
    test(`${entry.name} restores exact model and history when render fails`, async ({ page }) => {
        await bootSolid(page)

        const result = await page.evaluate(async ({ operation }) => {
            const app = window.layersApp
            const added = await app._handleAddEffectLayer('synth/gradient')
            const parent = app._layers.find(layer => layer.id === added.layerId)
            if (operation === 'child-delete') {
                await app._handleAddChildEffect(parent.id, 'filter/blur')
            }
            if (operation === 'opacity') {
                parent.locked = true
                app._markDirty()
                app._pushUndoStateDebounced()
            } else {
                app._markClean()
            }

            const layersArray = app._layers
            const childrenArray = parent.children
            const childObjects = (parent.children || []).slice()
            const state = () => ({
                model: JSON.stringify(app._layers, (key, value) => {
                    if (key === 'drawingCanvas' || key === 'mediaFile' || key === 'mask') {
                        return undefined
                    }
                    return value
                }),
                selectedLayerIds: app._layerStack.selectedLayerIds,
                selectionAnchor: app._layerStack._lastClickedLayerId,
                dirty: app._isDirty,
                mutationRevision: app._projectMutationRevision,
                undoStackLength: app._undoManager._stack.length,
                undoIndex: app._undoManager._index,
                pendingUndo: Boolean(app._undoDebounceTimer),
            })
            const before = state()
            const rebuild = app._rebuild.bind(app)
            let rebuildCalls = 0
            let stageCalls = 0
            if (operation === 'auto') {
                app._renderer.stageLayerSet = async () => {
                    stageCalls += 1
                    return {
                        success: false,
                        error: 'injected model stage failure',
                        rollback: async () => ({ success: true }),
                    }
                }
            } else {
                app._rebuild = (...args) => {
                    if (rebuildCalls++ === 0) {
                        return Promise.resolve({
                            success: false,
                            error: 'injected model rebuild failure',
                        })
                    }
                    return rebuild(...args)
                }
            }

            let outcome
            if (operation === 'auto') {
                outcome = await app._handleAutoCorrection(() => ({
                    effectId: 'filter/brightness',
                    name: 'Atomic correction',
                    effectParams: { amount: 0.25 },
                }))
            } else if (operation === 'child-add') {
                outcome = await app._handleAddChildEffect(parent.id, 'filter/blur')
            } else if (operation === 'child-delete') {
                outcome = await app._handleDeleteLayer(parent.children[0].id, parent.id)
            } else {
                const values = {
                    visibility: !parent.visible,
                    opacity: 37,
                    blendMode: 'screen',
                    name: 'Rejected rename',
                }
                outcome = await app._handleLayerChange({
                    layerId: parent.id,
                    property: operation,
                    value: values[operation],
                })
            }

            return {
                before,
                after: state(),
                outcomeStatus: outcome?.status || null,
                outcomeError: JSON.stringify(outcome?.error?.message ?? outcome?.error ?? null),
                renderCalls: operation === 'auto' ? stageCalls : rebuildCalls,
                sameLayersArray: app._layers === layersArray,
                sameParentObject: app._layers.includes(parent),
                sameChildrenArray: parent.children === childrenArray,
                sameChildObjects: childObjects.every(
                    (child, index) => parent.children[index] === child),
            }
        }, { operation: entry.operation })

        expect(result.outcomeStatus).toBe('failed')
        const expectedRenderCalls = entry.operation === 'auto' ? 1 : 2
        expect(result.renderCalls, result.outcomeError)
            .toBeGreaterThanOrEqual(expectedRenderCalls)
        expect(result.after).toEqual(result.before)
        expect(result.sameLayersArray).toBe(true)
        expect(result.sameParentObject).toBe(true)
        expect(result.sameChildrenArray).toBe(true)
        expect(result.sameChildObjects).toBe(true)
    })
}

test('post-settlement stage cleanup failure preserves a committed prepared mutation', async ({ page }) => {
    await bootSolid(page)

    const result = await page.evaluate(async () => {
        const app = window.layersApp
        const stageLayerSet = app._renderer.stageLayerSet.bind(app._renderer)
        app._renderer.stageLayerSet = async (candidate) => {
            const stage = await stageLayerSet(candidate)
            const commit = stage.commit.bind(stage)
            stage.commit = () => {
                commit()
                throw new Error('injected settled-stage cleanup failure')
            }
            return stage
        }

        const outcome = await app._handleAddEffectLayer('filter/blur', {
            name: 'Committed correction',
            params: { radiusX: 5 },
        })
        return {
            status: outcome.status,
            effectId: app._layers.at(-1)?.effectId,
            sameLayers: app._renderer._layers === app._layers,
        }
    })

    expect(result).toEqual({
        status: 'added',
        effectId: 'filter/blur',
        sameLayers: true,
    })
})

for (const entry of [
    { name: 'parameter apply', failurePoint: 'update', agent: false },
    { name: 'DSL sync', failurePoint: 'sync', agent: true },
]) {
    test(`effectParams ${entry.name} failure restores model and reapplies renderer params`, async ({ page }) => {
        await bootSolid(page)

        const result = await page.evaluate(async ({ failurePoint, agent }) => {
            const app = window.layersApp
            const renderer = app._renderer
            const added = await app._handleAddEffectLayer('synth/gradient')
            const layer = app._layers.find(candidate => candidate.id === added.layerId)
            layer.locked = true
            app._markDirty()
            app._pushUndoStateDebounced()
            const previousParams = layer.effectParams
            const previousParamsJson = JSON.stringify(previousParams)
            const state = () => ({
                params: JSON.stringify(layer.effectParams),
                dirty: app._isDirty,
                mutationRevision: app._projectMutationRevision,
                undoStackLength: app._undoManager._stack.length,
                undoIndex: app._undoManager._index,
                pendingUndo: Boolean(app._undoDebounceTimer),
            })
            const before = state()

            const rebuild = app._rebuild.bind(app)
            let rebuildCalls = 0
            app._rebuild = (...args) => {
                rebuildCalls += 1
                return rebuild(...args)
            }
            const updateLayerParams = renderer.updateLayerParams.bind(renderer)
            const syncDsl = renderer.syncDsl.bind(renderer)
            const appliedParams = []
            let updateCalls = 0
            let syncCalls = 0
            renderer.updateLayerParams = (layerId, params) => {
                updateCalls += 1
                appliedParams.push(JSON.stringify(params))
                if (failurePoint === 'update' && updateCalls === 1) {
                    throw new Error('injected parameter apply failure')
                }
                return updateLayerParams(layerId, params)
            }
            renderer.syncDsl = (...args) => {
                syncCalls += 1
                if (failurePoint === 'sync' && syncCalls === 1) {
                    throw new Error('injected DSL sync failure')
                }
                return syncDsl(...args)
            }

            let outcome = null
            let envelope = null
            let thrown = null
            try {
                if (agent) {
                    envelope = await window.LayersAgent.setLayerEffectParams({
                        layerId: layer.id,
                        params: { type: 3 },
                    })
                } else {
                    outcome = await app._handleLayerChange({
                        layerId: layer.id,
                        property: 'effectParams',
                        value: { ...layer.effectParams, type: 3 },
                    })
                }
            } catch (error) {
                thrown = error.message
            }

            return {
                before,
                after: state(),
                outcomeStatus: outcome?.status || null,
                envelope,
                thrown,
                rebuildCalls,
                sameParams: layer.effectParams === previousParams,
                previousParamsJson,
                appliedParams,
                updateCalls,
                syncCalls,
            }
        }, { failurePoint: entry.failurePoint, agent: entry.agent })

        expect(result.thrown).toBeNull()
        expect(result.after).toEqual(result.before)
        expect(result.sameParams).toBe(true)
        expect(result.rebuildCalls).toBeGreaterThanOrEqual(1)
        expect(result.updateCalls).toBeGreaterThanOrEqual(2)
        expect(result.appliedParams.at(-1)).toBe(result.previousParamsJson)
        if (entry.agent) {
            expect(result.envelope.ok).toBe(false)
            expect(result.envelope.error.code).toBe('INTERNAL_ERROR')
        } else {
            expect(result.outcomeStatus).toBe('failed')
        }
    })
}

test('keyboard visibility toggle restores visibility and lifecycle state when rebuild fails', async ({ page }) => {
    await bootSolid(page)

    const before = await page.evaluate(() => {
        const app = window.layersApp
        const layer = app._layers[0]
        app._layerStack.selectedLayerId = layer.id
        app._markClean()
        const rebuild = app._rebuild.bind(app)
        app.__keyboardRebuildCalls = 0
        app._rebuild = (...args) => {
            if (app.__keyboardRebuildCalls++ === 0) {
                return Promise.resolve({ success: false, error: 'injected V rebuild failure' })
            }
            return rebuild(...args)
        }
        return {
            visible: layer.visible,
            selectedLayerIds: app._layerStack.selectedLayerIds,
            selectionAnchor: app._layerStack._lastClickedLayerId,
            dirty: app._isDirty,
            mutationRevision: app._projectMutationRevision,
            undoStackLength: app._undoManager._stack.length,
            undoIndex: app._undoManager._index,
            pendingUndo: Boolean(app._undoDebounceTimer),
        }
    })

    await page.keyboard.press('Shift+V')
    await page.waitForFunction(() => !window.layersApp._projectLifecycleActive)

    const after = await page.evaluate(() => {
        const app = window.layersApp
        const layer = app._layers[0]
        return {
            state: {
                visible: layer.visible,
                selectedLayerIds: app._layerStack.selectedLayerIds,
                selectionAnchor: app._layerStack._lastClickedLayerId,
                dirty: app._isDirty,
                mutationRevision: app._projectMutationRevision,
                undoStackLength: app._undoManager._stack.length,
                undoIndex: app._undoManager._index,
                pendingUndo: Boolean(app._undoDebounceTimer),
            },
            rebuildCalls: app.__keyboardRebuildCalls,
            lifecycleReleased: !app._projectLifecycleActive,
        }
    })

    expect(after.state).toEqual(before)
    expect(after.rebuildCalls).toBeGreaterThanOrEqual(2)
    expect(after.lifecycleReleased).toBe(true)
})

test('layer-stack visibility event restores model and live control on failure', async ({ page }) => {
    await bootSolid(page)

    const before = await page.evaluate(() => {
        const app = window.layersApp
        const layer = app._layers[0]
        app._markClean()
        const rebuild = app._rebuild.bind(app)
        app.__stackVisibilityRebuildCalls = 0
        app._rebuild = (...args) => {
            if (app.__stackVisibilityRebuildCalls++ === 0) {
                return Promise.resolve({
                    success: false,
                    error: 'injected layer-stack visibility rebuild failure',
                })
            }
            return rebuild(...args)
        }
        return {
            layerId: layer.id,
            visible: layer.visible,
            dirty: app._isDirty,
            mutationRevision: app._projectMutationRevision,
            undoStackLength: app._undoManager._stack.length,
            undoIndex: app._undoManager._index,
        }
    })

    await page.locator(
        `layer-item[data-layer-id="${before.layerId}"] .layer-visibility`).click()
    await page.waitForFunction(() => !window.layersApp._projectLifecycleActive)

    const after = await page.evaluate((layerId) => {
        const app = window.layersApp
        const layer = app._layers.find(candidate => candidate.id === layerId)
        return {
            visible: layer.visible,
            dirty: app._isDirty,
            mutationRevision: app._projectMutationRevision,
            undoStackLength: app._undoManager._stack.length,
            undoIndex: app._undoManager._index,
            rebuildCalls: app.__stackVisibilityRebuildCalls,
            controlVisible: document.querySelector(
                `layer-item[data-layer-id="${layerId}"] .layer-visibility`)
                ?.classList.contains('visible') || false,
        }
    }, before.layerId)

    expect(after).toEqual({
        visible: before.visible,
        dirty: before.dirty,
        mutationRevision: before.mutationRevision,
        undoStackLength: before.undoStackLength,
        undoIndex: before.undoIndex,
        rebuildCalls: 2,
        controlVisible: before.visible,
    })
})

test('two queued layer-item opacity failures restore the committed value', async ({ page }) => {
    await bootSolid(page)

    const result = await page.evaluate(async () => {
        const app = window.layersApp
        const layer = app._layers[0]
        const item = app._layerStack.querySelector(
            `layer-item[data-layer-id="${layer.id}"]`)
        app._finalizePendingUndo()
        app._markClean()

        const before = {
            opacity: layer.opacity,
            dirty: app._isDirty,
            mutationRevision: app._projectMutationRevision,
            undoStackLength: app._undoManager._stack.length,
            undoIndex: app._undoManager._index,
            pendingUndo: Boolean(app._undoDebounceTimer),
        }
        const rebuild = app._rebuild.bind(app)
        let rebuildCalls = 0
        app._rebuild = (...args) => {
            rebuildCalls += 1
            if (rebuildCalls === 1 || rebuildCalls === 3) {
                return Promise.resolve({
                    success: false,
                    error: 'injected queued opacity rebuild failure',
                })
            }
            return rebuild(...args)
        }

        item._handleOpacityChange(90)
        item._handleOpacityChange(80)
        await app._projectLifecycleTail

        return {
            before,
            after: {
                opacity: layer.opacity,
                dirty: app._isDirty,
                mutationRevision: app._projectMutationRevision,
                undoStackLength: app._undoManager._stack.length,
                undoIndex: app._undoManager._index,
                pendingUndo: Boolean(app._undoDebounceTimer),
            },
            rebuildCalls,
            lifecycleReleased: !app._projectLifecycleActive,
        }
    })

    expect(result.after).toEqual(result.before)
    expect(result.rebuildCalls).toBeGreaterThanOrEqual(4)
    expect(result.lifecycleReleased).toBe(true)
})

test('immediate lifecycle rejection restores the real opacity host and range', async ({ page }) => {
    await bootSolid(page)

    const result = await page.evaluate(() => {
        const app = window.layersApp
        const layer = app._layers[0]
        const item = app._layerStack.querySelector(
            `layer-item[data-layer-id="${layer.id}"]`)
        const opacityHost = item.querySelector('.layer-opacity')
        const opacityRange = opacityHost.querySelector('input[type="range"]')
        app._finalizePendingUndo()
        app._markClean()
        const before = {
            opacity: layer.opacity,
            hostValue: Number(opacityHost.value),
            rangeValue: Number(opacityRange.value),
            dirty: app._isDirty,
            mutationRevision: app._projectMutationRevision,
            undoStackLength: app._undoManager._stack.length,
            undoIndex: app._undoManager._index,
        }

        app._projectReplacementActive = true
        try {
            opacityRange.value = '40'
            opacityRange.dispatchEvent(new Event('input', { bubbles: true }))
        } finally {
            app._projectReplacementActive = false
        }

        const restoredHost = app._layerStack.querySelector(
            `layer-item[data-layer-id="${layer.id}"] .layer-opacity`)
        const restoredRange = restoredHost.querySelector('input[type="range"]')

        return {
            before,
            after: {
                opacity: layer.opacity,
                hostValue: Number(restoredHost.value),
                rangeValue: Number(restoredRange.value),
                dirty: app._isDirty,
                mutationRevision: app._projectMutationRevision,
                undoStackLength: app._undoManager._stack.length,
                undoIndex: app._undoManager._index,
            },
        }
    })

    expect(result.after).toEqual(result.before)
})

test('generation-invalidated queued opacity restores the real host and range', async ({ page }) => {
    await bootSolid(page)

    const result = await page.evaluate(async () => {
        const app = window.layersApp
        const layer = app._layers[0]
        const opacityHost = app._layerStack.querySelector(
            `layer-item[data-layer-id="${layer.id}"] .layer-opacity`)
        const opacityRange = opacityHost.querySelector('input[type="range"]')
        app._finalizePendingUndo()
        app._markClean()
        const before = {
            opacity: layer.opacity,
            hostValue: Number(opacityHost.value),
            rangeValue: Number(opacityRange.value),
            dirty: app._isDirty,
            mutationRevision: app._projectMutationRevision,
            undoStackLength: app._undoManager._stack.length,
            undoIndex: app._undoManager._index,
        }

        const blocker = app._tryAcquireProjectLifecycle()
        if (!blocker) throw new Error('failed to acquire lifecycle blocker')
        const runPointerMutation = app._runPointerMutation
        let queuedMutation
        app._runPointerMutation = function (...args) {
            queuedMutation = runPointerMutation.apply(this, args)
            return queuedMutation
        }
        try {
            opacityRange.value = '40'
            opacityRange.dispatchEvent(new Event('input', { bubbles: true }))
            app._replacementGeneration += 1
        } finally {
            app._runPointerMutation = runPointerMutation
            blocker.release()
        }
        if (!queuedMutation) throw new Error('opacity input did not queue a pointer mutation')
        // Releasing the lifecycle lock precedes the event handler's control
        // refresh. Wait for that actual mutation promise before reading UI.
        await queuedMutation
        await app._projectLifecycleTail

        const restoredHost = app._layerStack.querySelector(
            `layer-item[data-layer-id="${layer.id}"] .layer-opacity`)
        const restoredRange = restoredHost.querySelector('input[type="range"]')
        return {
            before,
            after: {
                opacity: layer.opacity,
                hostValue: Number(restoredHost.value),
                rangeValue: Number(restoredRange.value),
                dirty: app._isDirty,
                mutationRevision: app._projectMutationRevision,
                undoStackLength: app._undoManager._stack.length,
                undoIndex: app._undoManager._index,
            },
            lifecycleReleased: !app._projectLifecycleActive,
        }
    })

    expect(result.after).toEqual(result.before)
    expect(result.lifecycleReleased).toBe(true)
})

test('committed opacity input preserves its live control host', async ({ page }) => {
    await bootSolid(page)

    const result = await page.evaluate(async () => {
        const app = window.layersApp
        const layer = app._layers[0]
        const host = app._layerStack.querySelector(
            `layer-item[data-layer-id="${layer.id}"] .layer-opacity`)
        const range = host.querySelector('input[type="range"]')
        range.value = '40'
        range.dispatchEvent(new Event('input', { bubbles: true }))
        await app._projectLifecycleTail

        const currentHost = app._layerStack.querySelector(
            `layer-item[data-layer-id="${layer.id}"] .layer-opacity`)
        return {
            sameHost: currentHost === host,
            opacity: layer.opacity,
            hostValue: Number(currentHost.value),
            rangeValue: Number(
                currentHost.querySelector('input[type="range"]').value),
        }
    })

    expect(result).toEqual({
        sameHost: true,
        opacity: 40,
        hostValue: 40,
        rangeValue: 40,
    })
})

test('unexpected layer-change rejection logs and restores the live opacity control', async ({ page }) => {
    await bootSolid(page)

    const result = await page.evaluate(async () => {
        const app = window.layersApp
        const layer = app._layers[0]
        const host = app._layerStack.querySelector(
            `layer-item[data-layer-id="${layer.id}"] .layer-opacity`)
        const range = host.querySelector('input[type="range"]')
        const originalHandleLayerChange = app._handleLayerChange.bind(app)
        const originalConsoleError = console.error
        const errors = []
        const preventUnhandled = event => event.preventDefault()
        window.addEventListener('unhandledrejection', preventUnhandled)
        app._handleLayerChange = async () => {
            throw new Error('injected unexpected layer-change rejection')
        }
        console.error = (...args) => {
            errors.push(args.map(value => value?.message || String(value)).join(' '))
        }

        try {
            range.value = '40'
            range.dispatchEvent(new Event('input', { bubbles: true }))
            await app._projectLifecycleTail
            await new Promise(resolve => setTimeout(resolve, 0))
        } finally {
            app._handleLayerChange = originalHandleLayerChange
            console.error = originalConsoleError
            window.removeEventListener('unhandledrejection', preventUnhandled)
        }

        const restoredHost = app._layerStack.querySelector(
            `layer-item[data-layer-id="${layer.id}"] .layer-opacity`)
        return {
            opacity: layer.opacity,
            hostValue: Number(restoredHost.value),
            rangeValue: Number(
                restoredHost.querySelector('input[type="range"]').value),
            logged: errors.some(message =>
                message.includes('injected unexpected layer-change rejection')),
        }
    })

    expect(result).toEqual({
        opacity: 100,
        hostValue: 100,
        rangeValue: 100,
        logged: true,
    })
})

test('immediate lifecycle rejection restores real name and blend controls', async ({ page }) => {
    await bootSolid(page)

    const result = await page.evaluate(() => {
        const app = window.layersApp
        const layer = app._layers[0]
        const before = {
            name: layer.name,
            blendMode: layer.blendMode,
        }

        app._projectReplacementActive = true
        try {
            let item = app._layerStack.querySelector(
                `layer-item[data-layer-id="${layer.id}"]`)
            const name = item.querySelector('.layer-name')
            name.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
            name.textContent = 'Rejected name'
            name.dispatchEvent(new Event('blur'))

            item = app._layerStack.querySelector(
                `layer-item[data-layer-id="${layer.id}"]`)
            const blend = item.querySelector('.layer-blend-mode')
            blend.value = 'multiply'
            blend.dispatchEvent(new Event('change', { bubbles: true }))
        } finally {
            app._projectReplacementActive = false
        }

        const restoredItem = app._layerStack.querySelector(
            `layer-item[data-layer-id="${layer.id}"]`)
        return {
            before,
            after: {
                name: layer.name,
                blendMode: layer.blendMode,
            },
            nameControl: restoredItem.querySelector('.layer-name').textContent,
            blendControl: restoredItem.querySelector('.layer-blend-mode').value,
        }
    })

    expect(result.after).toEqual(result.before)
    expect(result.nameControl).toBe(result.before.name)
    expect(result.blendControl).toBe(result.before.blendMode)
})

for (const failurePoint of ['renderer-upload', 'fallback-rebuild']) {
    test(`agent transform ${failurePoint} failure restores exact state`, async ({ page }) => {
        await bootSolid(page)

        const result = await page.evaluate(async ({ failurePoint, data }) => {
            const app = window.layersApp
            const added = await window.LayersAgent.addLayer({
                kind: 'media',
                mediaType: 'image',
                source: { kind: 'base64', data, mimeType: 'image/png' },
            })
            const layer = app._layers.find(candidate => candidate.id === added.result.layerId)
            layer.locked = true
            app._markDirty()
            app._pushUndoStateDebounced()
            const state = () => ({
                transform: {
                    offsetX: layer.offsetX,
                    offsetY: layer.offsetY,
                    scaleX: layer.scaleX,
                    scaleY: layer.scaleY,
                    rotation: layer.rotation,
                    flipH: layer.flipH,
                    flipV: layer.flipV,
                },
                dirty: app._isDirty,
                mutationRevision: app._projectMutationRevision,
                undoStackLength: app._undoManager._stack.length,
                undoIndex: app._undoManager._index,
                pendingUndo: Boolean(app._undoDebounceTimer),
            })
            const before = state()

            const rebuild = app._rebuild.bind(app)
            let updateCalls = 0
            let rebuildCalls = 0
            if (failurePoint === 'renderer-upload') {
                const renderer = app._renderer._renderer
                const updateTextureFromSource = renderer.updateTextureFromSource.bind(renderer)
                renderer.updateTextureFromSource = (...args) => {
                    updateCalls += 1
                    if (updateCalls === 1) {
                        throw new Error('injected transform renderer failure')
                    }
                    return updateTextureFromSource(...args)
                }
            } else {
                app._updateTransformRender = null
                app._rebuild = (...args) => {
                    rebuildCalls += 1
                    if (rebuildCalls === 1) {
                        return Promise.resolve({
                            success: false,
                            error: 'injected transform fallback rebuild failure',
                        })
                    }
                    return rebuild(...args)
                }
            }

            const envelope = await window.LayersAgent.setLayerTransform({
                layerId: layer.id,
                transform: { offsetX: 41, rotation: 27, flipH: true },
            })
            return {
                before,
                after: state(),
                envelope,
                updateCalls,
                rebuildCalls,
            }
        }, { failurePoint, data: TINY_PNG_B64 })

        expect(result.envelope.ok).toBe(false)
        expect(result.envelope.error.code).toBe('INTERNAL_ERROR')
        expect(result.after).toEqual(result.before)
        if (failurePoint === 'renderer-upload') {
            expect(result.updateCalls).toBeGreaterThanOrEqual(2)
        } else {
            expect(result.rebuildCalls).toBeGreaterThanOrEqual(2)
        }
    })
}

test('agent transform reports a persistent renderer restore failure', async ({ page }) => {
    await bootSolid(page)

    const result = await page.evaluate(async (data) => {
        const app = window.layersApp
        const added = await window.LayersAgent.addLayer({
            kind: 'media',
            mediaType: 'image',
            source: { kind: 'base64', data, mimeType: 'image/png' },
        })
        const layer = app._layers.find(candidate => candidate.id === added.result.layerId)
        const transformState = () => ({
            offsetX: layer.offsetX,
            offsetY: layer.offsetY,
            scaleX: layer.scaleX,
            scaleY: layer.scaleY,
            rotation: layer.rotation,
            flipH: layer.flipH,
            flipV: layer.flipV,
        })
        const before = transformState()
        const engine = app._renderer._renderer
        const updateTextureFromSource = engine.updateTextureFromSource
        const rebuild = app._rebuild
        let updateCalls = 0
        let rebuildCalls = 0
        engine.updateTextureFromSource = () => {
            updateCalls += 1
            throw new Error('persistent transform renderer failure')
        }
        app._rebuild = async () => {
            rebuildCalls += 1
            return { success: true }
        }

        let envelope
        try {
            envelope = await window.LayersAgent.setLayerTransform({
                layerId: layer.id,
                transform: { scaleX: 2, flipH: true },
            })
        } finally {
            engine.updateTextureFromSource = updateTextureFromSource
            app._rebuild = rebuild
        }
        return {
            envelope,
            before,
            after: transformState(),
            updateCalls,
            rebuildCalls,
        }
    }, TINY_PNG_B64)

    expect(result.envelope.ok).toBe(false)
    expect(result.envelope.error.code).toBe('INTERNAL_ERROR')
    expect(result.envelope.error.message).toContain('failed to restore previous state')
    expect(result.envelope.error.message).toContain('persistent transform renderer failure')
    expect(result.after).toEqual(result.before)
    expect(result.updateCalls).toBe(2)
    expect(result.rebuildCalls).toBe(1)
})

test('live move renderer failure restores the model without dirty or undo changes', async ({ page }) => {
    await bootSolid(page)

    const result = await page.evaluate(() => {
        const app = window.layersApp
        const layer = app._getActiveLayer()
        const state = () => ({
            offsetX: layer.offsetX,
            offsetY: layer.offsetY,
            dirty: app._isDirty,
            mutationRevision: app._projectMutationRevision,
            undoStackLength: app._undoManager._stack.length,
            undoIndex: app._undoManager._index,
            pendingUndo: Boolean(app._undoDebounceTimer),
        })
        const before = state()
        const updateLayerOffset = app._renderer.updateLayerOffset.bind(app._renderer)
        let calls = 0
        app._renderer.updateLayerOffset = (...args) => {
            calls += 1
            if (calls === 1) throw new Error('injected move renderer failure')
            return updateLayerOffset(...args)
        }
        let error = null
        try {
            app._updateActiveLayerPosition(40, 25)
        } catch (err) {
            error = err.message
        }
        return { before, after: state(), calls, error }
    })

    expect(result.error).toContain('injected move renderer failure')
    expect(result.calls).toBe(2)
    expect(result.after).toEqual(result.before)
})

test('live transform renderer failure restores the model without dirty or undo changes', async ({ page }) => {
    await bootSolid(page)

    const result = await page.evaluate(async ({ data }) => {
        const app = window.layersApp
        const added = await window.LayersAgent.addLayer({
            kind: 'media',
            mediaType: 'image',
            source: { kind: 'base64', data, mimeType: 'image/png' },
        })
        const layer = app._layers.find(candidate => candidate.id === added.result.layerId)
        const state = () => ({
            offsetX: layer.offsetX,
            offsetY: layer.offsetY,
            scaleX: layer.scaleX,
            scaleY: layer.scaleY,
            rotation: layer.rotation,
            dirty: app._isDirty,
            mutationRevision: app._projectMutationRevision,
            undoStackLength: app._undoManager._stack.length,
            undoIndex: app._undoManager._index,
            pendingUndo: Boolean(app._undoDebounceTimer),
        })
        const before = state()
        const updateTransformRender = app._updateTransformRender.bind(app)
        let calls = 0
        app._updateTransformRender = (...args) => {
            calls += 1
            if (calls === 1) throw new Error('injected live transform renderer failure')
            return updateTransformRender(...args)
        }
        let error = null
        try {
            app._applyLayerTransform({
                offsetX: 31,
                offsetY: -12,
                scaleX: 1.5,
                scaleY: 0.75,
                rotation: 22,
            })
        } catch (err) {
            error = err.message
        }
        return { before, after: state(), calls, error }
    }, { data: TINY_PNG_B64 })

    expect(result.error).toContain('injected live transform renderer failure')
    expect(result.calls).toBe(2)
    expect(result.after).toEqual(result.before)
})

for (const target of ['layer', 'child']) {
    test(`agent ${target} property batch rolls back every field when final candidate fails`, async ({ page }) => {
        await bootSolid(page)

        const result = await page.evaluate(async ({ target }) => {
            const app = window.layersApp
            const added = await app._handleAddEffectLayer('synth/gradient')
            const parent = app._layers.find(layer => layer.id === added.layerId)
            let subject = parent
            if (target === 'child') {
                const child = await app._handleAddChildEffect(parent.id, 'filter/blur')
                subject = parent.children.find(candidate => candidate.id === child.childId)
            }
            app._markClean()
            const state = () => ({
                name: subject.name,
                visible: subject.visible,
                opacity: subject.opacity,
                blendMode: subject.blendMode,
                locked: subject.locked,
                dirty: app._isDirty,
                mutationRevision: app._projectMutationRevision,
                undoStackLength: app._undoManager._stack.length,
                undoIndex: app._undoManager._index,
                pendingUndo: Boolean(app._undoDebounceTimer),
            })
            const before = state()
            const rebuild = app._rebuild.bind(app)
            let rejectedCandidate = false
            let rebuildCalls = 0
            app._rebuild = (...args) => {
                rebuildCalls += 1
                const rejected = subject.visible === false && (target === 'layer'
                    ? subject.blendMode === 'screen'
                    : subject.name === 'Rejected child')
                if (rejected && !rejectedCandidate) {
                    rejectedCandidate = true
                    return Promise.resolve({
                        success: false,
                        error: 'injected property batch rebuild failure',
                    })
                }
                return rebuild(...args)
            }

            const envelope = target === 'layer'
                ? await window.LayersAgent.setLayerProps({
                    layerId: subject.id,
                    props: { visible: false, blendMode: 'screen' },
                })
                : await window.LayersAgent.setChildEffectProps({
                    layerId: parent.id,
                    childId: subject.id,
                    props: { visible: false, name: 'Rejected child' },
                })
            return {
                before,
                after: state(),
                envelope,
                rejectedCandidate,
                rebuildCalls,
            }
        }, { target })

        expect(result.rejectedCandidate).toBe(true)
        expect(result.envelope.ok).toBe(false)
        expect(result.envelope.error.code).toBe('INTERNAL_ERROR')
        expect(result.after).toEqual(result.before)
        expect(result.rebuildCalls).toBeGreaterThanOrEqual(2)
    })
}
