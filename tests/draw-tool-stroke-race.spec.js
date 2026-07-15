import { test, expect } from 'playwright/test'

// Regression: brush/shape _onMouseUp cleared instance gesture state
// (_currentPoints / _startPt / _currentPt) AFTER awaiting the rasterize +
// rebuild. If a new gesture began during that await window, the resolving
// mouseup clobbered the new stroke's in-progress state, losing it and making
// the next mousemove dereference undefined (TypeError). The handler must
// capture its own state into locals and clear instance state before awaiting.

test('brush: a stroke started during the previous stroke\'s rebuild is not clobbered', async ({ page }) => {
    await page.goto('/', { waitUntil: 'networkidle' })
    await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })

    const result = await page.evaluate(async () => {
        const { BrushTool } = await import('/js/tools/brush-tool.js')

        let resolveRebuild
        const rebuild = () => new Promise(r => { resolveRebuild = r })
        const layer = { strokes: [] }
        let owner = null
        const acquireMutation = (existing) => {
            if (owner && existing === owner && !owner.released) {
                owner.references += 1
                return owner
            }
            if (owner && !owner.released) return null
            owner = {
                released: false,
                references: 1,
                release() {
                    this.references -= 1
                    if (this.references === 0) this.released = true
                }
            }
            return owner
        }

        const overlay = document.createElement('canvas')
        overlay.width = 200; overlay.height = 200
        document.body.appendChild(overlay)

        const tool = new BrushTool({
            overlay,
            commitStroke: async (stroke) => {
                layer.strokes.push(stroke)
                await rebuild()
            },
            acquireMutation
        })
        tool.activate()
        const fire = (type, x, y) => overlay.dispatchEvent(
            new MouseEvent(type, { clientX: x, clientY: y, bubbles: true, button: 0 }))

        // Stroke 1 — mouseup suspends at the held rebuild await.
        fire('mousedown', 10, 10)
        fire('mousemove', 30, 30)
        fire('mouseup', 30, 30)
        await new Promise(r => setTimeout(r, 0))

        // Stroke 2 begins during stroke 1's rebuild window.
        fire('mousedown', 100, 100)
        const pointsAfterStroke2Down = tool._currentPoints.length

        // Stroke 1's rebuild resolves and its mouseup continuation runs.
        resolveRebuild()
        await new Promise(r => setTimeout(r, 0))

        const out = {
            pointsAfterStroke2Down,
            pointsAfterResolve: tool._currentPoints.length,
            stateAfterResolve: tool._state,
            stroke1Committed: layer.strokes.length
        }
        tool.deactivate()
        overlay.remove()
        return out
    })

    expect(result.pointsAfterStroke2Down).toBe(1)
    expect(result.stroke1Committed).toBe(1)           // stroke 1 still finishes
    expect(result.stateAfterResolve).toBe('drawing')  // stroke 2 still active
    expect(result.pointsAfterResolve).toBe(1)         // stroke 2 NOT clobbered
})

test('shape: a shape started during the previous shape\'s rebuild is not clobbered', async ({ page }) => {
    await page.goto('/', { waitUntil: 'networkidle' })
    await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })

    const result = await page.evaluate(async () => {
        const { ShapeTool } = await import('/js/tools/shape-tool.js')

        let resolveRebuild
        const rebuild = () => new Promise(r => { resolveRebuild = r })
        const layer = { strokes: [] }
        let owner = null
        const acquireMutation = (existing) => {
            if (owner && existing === owner && !owner.released) {
                owner.references += 1
                return owner
            }
            if (owner && !owner.released) return null
            owner = {
                released: false,
                references: 1,
                release() {
                    this.references -= 1
                    if (this.references === 0) this.released = true
                }
            }
            return owner
        }

        const overlay = document.createElement('canvas')
        overlay.width = 200; overlay.height = 200
        document.body.appendChild(overlay)

        const tool = new ShapeTool({
            overlay,
            commitStroke: async (stroke) => {
                layer.strokes.push(stroke)
                await rebuild()
            },
            acquireMutation
        })
        tool.activate()
        const fire = (type, x, y) => overlay.dispatchEvent(
            new MouseEvent(type, { clientX: x, clientY: y, bubbles: true, button: 0 }))

        fire('mousedown', 10, 10)
        fire('mousemove', 40, 40)
        fire('mouseup', 40, 40)
        await new Promise(r => setTimeout(r, 0))

        fire('mousedown', 100, 100)
        const startPtSetForStroke2 = tool._startPt !== null

        resolveRebuild()
        await new Promise(r => setTimeout(r, 0))

        const out = {
            startPtSetForStroke2,
            startPtAfterResolve: tool._startPt !== null,
            stateAfterResolve: tool._state,
            stroke1Committed: layer.strokes.length
        }
        tool.deactivate()
        overlay.remove()
        return out
    })

    expect(result.startPtSetForStroke2).toBe(true)
    expect(result.stroke1Committed).toBe(1)
    expect(result.stateAfterResolve).toBe('drawing')
    expect(result.startPtAfterResolve).toBe(true)     // stroke 2 NOT clobbered
})

for (const toolName of ['brush', 'shape']) {
    test(`${toolName}: an older failed commit cannot roll back a newer successful commit`, async ({ page }) => {
        await page.goto('/', { waitUntil: 'networkidle' })
        await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })
        const backdrop = page.locator('.open-dialog-backdrop.visible')
        await backdrop.waitFor()
        await page.locator('.media-option[data-type="solid"]').click()
        await page.locator('.canvas-size-dialog .action-btn.primary').click()
        await backdrop.waitFor({ state: 'hidden' })

        const result = await page.evaluate(async ({ toolName }) => {
            const app = window.layersApp
            const renderer = app._renderer
            const baseline = await window.LayersAgent.paintStroke({
                points: [[30, 30], [90, 70]],
                size: 8,
                color: '#00aa00',
            })
            const layerId = baseline.result.layerId
            const layer = app._layers.find(candidate => candidate.id === layerId)
            const strokes = layer.strokes
            const baselineResource = renderer.getMediaInfo(layerId)
            app._markClean()
            const before = {
                undoStackLength: app._undoManager._stack.length,
                undoIndex: app._undoManager._index,
                mutationRevision: app._projectMutationRevision,
            }

            const preparedResources = []
            const prepareCanvasMediaResource =
                renderer.prepareCanvasMediaResource.bind(renderer)
            renderer.prepareCanvasMediaResource = (...args) => {
                const resource = prepareCanvasMediaResource(...args)
                preparedResources.push(resource)
                return resource
            }

            let releaseFirstRebuild
            let notifyFirstRebuild
            const firstRebuildStarted = new Promise(resolve => {
                notifyFirstRebuild = resolve
            })
            const firstRebuildGate = new Promise(resolve => {
                releaseFirstRebuild = resolve
            })
            let rebuildCalls = 0
            app._rebuild = async () => {
                rebuildCalls += 1
                if (rebuildCalls === 1) {
                    notifyFirstRebuild()
                    await firstRebuildGate
                    return { success: false, error: 'injected older commit failure' }
                }
                return { success: true }
            }

            app._setToolMode(toolName)
            const tool = app[`_${toolName}Tool`]
            const outcomes = []
            const commitStroke = tool._commitStroke
            tool._commitStroke = async (stroke) => {
                const outcome = await commitStroke(stroke)
                outcomes.push({ color: stroke.color, status: outcome.status })
                return outcome
            }
            const overlay = app._selectionOverlay
            const rect = overlay.getBoundingClientRect()
            const event = (type, x, y) => new MouseEvent(type, {
                clientX: rect.left + x * rect.width / overlay.width,
                clientY: rect.top + y * rect.height / overlay.height,
                bubbles: true,
                button: 0,
            })
            const startGesture = (color, offset) => {
                tool.color = color
                tool._onMouseDown(event('mousedown', offset, offset))
                tool._onMouseMove(event('mousemove', offset + 70, offset + 50))
                return tool._onMouseUp(event('mouseup', offset + 70, offset + 50))
            }

            const olderCommit = startGesture('#ff0000', 110)
            await firstRebuildStarted

            tool.color = '#0000ff'
            tool._onMouseDown(event('mousedown', 220, 180))
            tool._onMouseMove(event('mousemove', 300, 240))
            const newerGestureCaptured = toolName === 'brush'
                ? tool._currentPoints.length > 1
                : tool._startPt !== null && tool._currentPt !== null
            const newerCommit = tool._onMouseUp(event('mouseup', 300, 240))
            await new Promise(resolve => setTimeout(resolve, 0))

            releaseFirstRebuild()
            await Promise.all([olderCommit, newerCommit])

            const finalResource = renderer.getMediaInfo(layerId)
            const undoLayer = app._undoManager._stack.at(-1).layers.find(
                candidate => candidate.id === layerId)
            return {
                newerGestureCaptured,
                rebuildCalls,
                outcomes,
                strokeColors: layer.strokes.map(stroke => stroke.color),
                sameLayerObject: app._layers.find(
                    candidate => candidate.id === layerId) === layer,
                sameStrokeArray: layer.strokes === strokes,
                resourceChanged: finalResource !== baselineResource,
                finalResourceIsNewest: finalResource === preparedResources.at(-1),
                preparedResourceCount: preparedResources.length,
                dirty: app._isDirty,
                mutationRevision: app._projectMutationRevision,
                undoStackLength: app._undoManager._stack.length,
                undoIndex: app._undoManager._index,
                undoStrokeColors: undoLayer.strokes.map(stroke => stroke.color),
                before,
            }
        }, { toolName })

        expect(result.newerGestureCaptured).toBe(true)
        expect(result.rebuildCalls).toBe(3)
        expect(result.outcomes).toHaveLength(2)
        expect(result.outcomes).toContainEqual({ color: '#ff0000', status: 'failed' })
        expect(result.outcomes).toContainEqual({ color: '#0000ff', status: 'committed' })
        expect(result.strokeColors).toEqual(['#00aa00', '#0000ff'])
        expect(result.undoStrokeColors).toEqual(result.strokeColors)
        expect(result.sameLayerObject).toBe(true)
        expect(result.sameStrokeArray).toBe(true)
        expect(result.preparedResourceCount).toBe(2)
        expect(result.resourceChanged).toBe(true)
        expect(result.finalResourceIsNewest).toBe(true)
        expect(result.dirty).toBe(true)
        expect(result.mutationRevision).toBe(result.before.mutationRevision + 1)
        expect(result.undoStackLength).toBe(result.before.undoStackLength + 1)
        expect(result.undoIndex).toBe(result.before.undoIndex + 1)
    })
}
