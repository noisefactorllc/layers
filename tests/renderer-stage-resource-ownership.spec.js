import { test, expect } from 'playwright/test'

async function bootSolid(page) {
    await page.goto('/', { waitUntil: 'networkidle' })
    await page.locator('#loading-screen').waitFor({ state: 'hidden' })
    const backdrop = page.locator('.open-dialog-backdrop.visible')
    await backdrop.waitFor()
    await page.locator('.media-option[data-type="solid"]').click()
    await page.locator('.canvas-size-dialog .action-btn.primary').click()
    await backdrop.waitFor({ state: 'hidden' })
}

test('an in-flight rebuild cannot observe a later stage candidate', async ({ page }) => {
    await bootSolid(page)

    const result = await page.evaluate(async () => {
        const renderer = window.layersApp._renderer
        renderer.stop()

        const previousLayers = renderer._layers
        const candidateLayers = previousLayers.map(layer => ({
            ...layer,
            id: `candidate-${layer.id}`,
        }))
        const previousMedia = new Map([['previous-media', { kind: 'previous-media' }]])
        const candidateMedia = new Map([['candidate-media', { kind: 'candidate-media' }]])
        const previousMasks = new Map([['previous-mask', { kind: 'previous-mask' }]])
        const candidateMasks = new Map([['candidate-mask', { kind: 'candidate-mask' }]])
        renderer._mediaTextures = previousMedia
        renderer._maskTextures = previousMasks

        let releaseFirstCompile
        let markFirstCompileStarted
        const firstCompileGate = new Promise(resolve => { releaseFirstCompile = resolve })
        const firstCompileStarted = new Promise(resolve => { markFirstCompileStarted = resolve })
        let compileCount = 0
        renderer._loadAndCompile = async () => {
            compileCount += 1
            if (compileCount === 1) {
                markFirstCompileStarted()
                await firstCompileGate
            }
        }

        const observations = []
        const buildLayerStepMap = renderer._buildLayerStepMap.bind(renderer)
        renderer._buildLayerStepMap = () => {
            observations.push({
                previousLayers: renderer._layers === previousLayers,
                candidateLayers: renderer._layers === candidateLayers,
                previousMedia: renderer._mediaTextures === previousMedia,
                candidateMedia: renderer._mediaTextures === candidateMedia,
                previousMasks: renderer._maskTextures === previousMasks,
                candidateMasks: renderer._maskTextures === candidateMasks,
            })
            return buildLayerStepMap()
        }

        const rebuildPromise = renderer.rebuild({ force: true })
        await firstCompileStarted
        const stagePromise = renderer.stageLayerSet({
            layers: candidateLayers,
            mediaTextures: candidateMedia,
            maskTextures: candidateMasks,
        })
        await Promise.resolve()
        releaseFirstCompile()

        const rebuild = await rebuildPromise
        const stage = await stagePromise
        stage.commit()

        return {
            rebuildSuccess: rebuild.success,
            stageSuccess: stage.success,
            compileCount,
            observations,
        }
    })

    expect(result).toEqual({
        rebuildSuccess: true,
        stageSuccess: true,
        compileCount: 2,
        observations: [
            {
                previousLayers: true,
                candidateLayers: false,
                previousMedia: true,
                candidateMedia: false,
                previousMasks: true,
                candidateMasks: false,
            },
            {
                previousLayers: false,
                candidateLayers: true,
                previousMedia: false,
                candidateMedia: true,
                previousMasks: false,
                candidateMasks: true,
            },
        ],
    })
})

test('stage commit retires only descriptors absent from the staged maps', async ({ page }) => {
    await bootSolid(page)

    const result = await page.evaluate(async () => {
        const renderer = window.layersApp._renderer
        renderer.stop()

        const sharedMedia = { kind: 'shared-media' }
        const oldMedia = { kind: 'old-media' }
        const stagedMedia = { kind: 'staged-media' }
        const previousMedia = new Map([
            ['old-shared-id', sharedMedia],
            ['old-only-id', oldMedia],
        ])
        const candidateMedia = new Map([
            ['new-shared-id', sharedMedia],
            ['new-only-id', stagedMedia],
        ])

        const sharedMask = { kind: 'shared-mask' }
        const oldMask = { kind: 'old-mask' }
        const stagedMask = { kind: 'staged-mask' }
        const previousMasks = new Map([
            ['old-shared-id', sharedMask],
            ['old-only-id', oldMask],
        ])
        const candidateMasks = new Map([
            ['new-shared-id', sharedMask],
            ['new-only-id', stagedMask],
        ])

        const sharedText = { kind: 'shared-text' }
        const oldText = { kind: 'old-text' }
        const stagedText = { kind: 'staged-text' }
        const previousText = new Map([
            ['old-shared-id', sharedText],
            ['old-only-id', oldText],
        ])

        renderer._mediaTextures = previousMedia
        renderer._maskTextures = previousMasks
        renderer._textCanvases = previousText
        const disposed = []
        renderer.disposeMediaResource = resource => { disposed.push(resource) }
        renderer._rebuildNow = async () => {
            renderer._textCanvases.set('new-shared-id', sharedText)
            renderer._textCanvases.set('new-only-id', stagedText)
            return { success: true }
        }

        const stage = await renderer.stageLayerSet({
            layers: window.layersApp._layers,
            mediaTextures: candidateMedia,
            maskTextures: candidateMasks,
        })
        const candidateText = renderer._textCanvases
        const commitResult = stage.commit()

        return {
            stageSuccess: stage.success,
            commitSuccess: commitResult.success,
            activeMediaIsCandidate: renderer._mediaTextures === candidateMedia,
            activeMasksAreCandidate: renderer._maskTextures === candidateMasks,
            activeTextIsCandidate: renderer._textCanvases === candidateText,
            disposedOnlyOldMedia:
                disposed.length === 1 && disposed[0] === oldMedia,
            previousMediaRetainsOnlyShared:
                previousMedia.size === 1
                && previousMedia.get('old-shared-id') === sharedMedia,
            previousMasksRetainOnlyShared:
                previousMasks.size === 1
                && previousMasks.get('old-shared-id') === sharedMask,
            previousTextRetainsOnlyShared:
                previousText.size === 1
                && previousText.get('old-shared-id') === sharedText,
            candidateMapsUntouched:
                candidateMedia.size === 2
                && candidateMedia.get('new-shared-id') === sharedMedia
                && candidateMedia.get('new-only-id') === stagedMedia
                && candidateMasks.size === 2
                && candidateMasks.get('new-shared-id') === sharedMask
                && candidateMasks.get('new-only-id') === stagedMask
                && candidateText.size === 2
                && candidateText.get('new-shared-id') === sharedText
                && candidateText.get('new-only-id') === stagedText,
        }
    })

    expect(result).toEqual({
        stageSuccess: true,
        commitSuccess: true,
        activeMediaIsCandidate: true,
        activeMasksAreCandidate: true,
        activeTextIsCandidate: true,
        disposedOnlyOldMedia: true,
        previousMediaRetainsOnlyShared: true,
        previousMasksRetainOnlyShared: true,
        previousTextRetainsOnlyShared: true,
        candidateMapsUntouched: true,
    })
})

test('stage rollback retires only descriptors absent from the restored maps', async ({ page }) => {
    await bootSolid(page)

    const result = await page.evaluate(async () => {
        const renderer = window.layersApp._renderer
        renderer.stop()

        const sharedMedia = { kind: 'shared-media' }
        const oldMedia = { kind: 'old-media' }
        const stagedMedia = { kind: 'staged-media' }
        const previousMedia = new Map([
            ['old-shared-id', sharedMedia],
            ['old-only-id', oldMedia],
        ])
        const candidateMedia = new Map([
            ['new-shared-id', sharedMedia],
            ['new-only-id', stagedMedia],
        ])

        const sharedMask = { kind: 'shared-mask' }
        const oldMask = { kind: 'old-mask' }
        const stagedMask = { kind: 'staged-mask' }
        const previousMasks = new Map([
            ['old-shared-id', sharedMask],
            ['old-only-id', oldMask],
        ])
        const candidateMasks = new Map([
            ['new-shared-id', sharedMask],
            ['new-only-id', stagedMask],
        ])

        const sharedText = { kind: 'shared-text' }
        const oldText = { kind: 'old-text' }
        const stagedText = { kind: 'staged-text' }
        const previousText = new Map([
            ['old-shared-id', sharedText],
            ['old-only-id', oldText],
        ])

        renderer._mediaTextures = previousMedia
        renderer._maskTextures = previousMasks
        renderer._textCanvases = previousText
        const disposed = []
        renderer.disposeMediaResource = resource => { disposed.push(resource) }
        let rebuilds = 0
        renderer._rebuildNow = async () => {
            rebuilds += 1
            if (rebuilds === 1) {
                renderer._textCanvases.set('new-shared-id', sharedText)
                renderer._textCanvases.set('new-only-id', stagedText)
            }
            return { success: true }
        }

        const stage = await renderer.stageLayerSet({
            layers: window.layersApp._layers,
            mediaTextures: candidateMedia,
            maskTextures: candidateMasks,
        })
        const candidateText = renderer._textCanvases
        const rollbackResult = await stage.rollback()

        return {
            stageSuccess: stage.success,
            rollbackSuccess: rollbackResult.success,
            rebuilds,
            activeMediaRestored: renderer._mediaTextures === previousMedia,
            activeMasksRestored: renderer._maskTextures === previousMasks,
            activeTextRestored: renderer._textCanvases === previousText,
            disposedOnlyStagedMedia:
                disposed.length === 1 && disposed[0] === stagedMedia,
            candidateMediaRetainsOnlyShared:
                candidateMedia.size === 1
                && candidateMedia.get('new-shared-id') === sharedMedia,
            candidateMasksRetainOnlyShared:
                candidateMasks.size === 1
                && candidateMasks.get('new-shared-id') === sharedMask,
            candidateTextRetainsOnlyShared:
                candidateText.size === 1
                && candidateText.get('new-shared-id') === sharedText,
            previousMapsUntouched:
                previousMedia.size === 2
                && previousMedia.get('old-shared-id') === sharedMedia
                && previousMedia.get('old-only-id') === oldMedia
                && previousMasks.size === 2
                && previousMasks.get('old-shared-id') === sharedMask
                && previousMasks.get('old-only-id') === oldMask
                && previousText.size === 2
                && previousText.get('old-shared-id') === sharedText
                && previousText.get('old-only-id') === oldText,
        }
    })

    expect(result).toEqual({
        stageSuccess: true,
        rollbackSuccess: true,
        rebuilds: 2,
        activeMediaRestored: true,
        activeMasksRestored: true,
        activeTextRestored: true,
        disposedOnlyStagedMedia: true,
        candidateMediaRetainsOnlyShared: true,
        candidateMasksRetainOnlyShared: true,
        candidateTextRetainsOnlyShared: true,
        previousMapsUntouched: true,
    })
})

for (const transition of ['commit', 'rollback']) {
    test(`delayed Fontaine render is stale after stage ${transition}`, async ({ page }) => {
        await bootSolid(page)

        const result = await page.evaluate(async ({ transition }) => {
            const renderer = window.layersApp._renderer
            renderer.stop()
            const { getFontaineLoader } = await import('/js/layers/fontaine-loader.js')
            const loader = getFontaineLoader()
            const previousFontsLoaded = loader.fontsLoaded
            const previousRegister = loader.registerFontByName
            loader.fontsLoaded = true

            let registrationStarted = false
            let releaseRegistration
            loader.registerFontByName = async () => {
                registrationStarted = true
                return new Promise(resolve => {
                    releaseRegistration = () => resolve(true)
                })
            }

            const layerId = 'fontaine-stage-layer'
            const originalParams = { text: 'OLD', font: 'Fontaine Old' }
            const originalLayer = {
                id: layerId,
                sourceType: 'effect',
                effectId: 'filter/text',
                effectParams: originalParams,
                visible: true,
            }
            const originalLayers = [originalLayer]
            const originalTextMap = new Map([[layerId, { kind: 'original-text' }]])
            renderer._layers = originalLayers
            renderer._mediaTextures = new Map()
            renderer._maskTextures = new Map()
            renderer._textCanvases = originalTextMap
            renderer._rebuildNow = async () => ({ success: true })

            const renders = []
            renderer._renderTextCanvas = (id, params) => {
                renders.push({ id, text: params.text })
            }
            const delayed = renderer._registerFontaineFont(layerId, originalParams)
            while (!registrationStarted) {
                await new Promise(resolve => setTimeout(resolve, 0))
            }

            const stagedParams = { text: 'STAGED', font: 'Fontaine Staged' }
            const stagedLayer = {
                ...originalLayer,
                effectParams: stagedParams,
            }
            const stagedLayers = [stagedLayer]
            const stage = await renderer.stageLayerSet({
                layers: stagedLayers,
                mediaTextures: new Map(),
                maskTextures: new Map(),
            })

            let activeTextMap
            let newerParams = null
            if (transition === 'commit') {
                activeTextMap = renderer._textCanvases
                stage.commit()
            } else {
                await stage.rollback()
                newerParams = { text: 'NEWER', font: 'Fontaine Newer' }
                originalLayer.effectParams = newerParams
                activeTextMap = originalTextMap
            }

            releaseRegistration()
            await delayed
            loader.fontsLoaded = previousFontsLoaded
            loader.registerFontByName = previousRegister

            return {
                renders,
                activeLayersCorrect: renderer._layers === (
                    transition === 'commit' ? stagedLayers : originalLayers),
                activeTextMapCorrect: renderer._textCanvases === activeTextMap,
                activeParamsCorrect: transition === 'commit'
                    ? stagedLayer.effectParams === stagedParams
                    : originalLayer.effectParams === newerParams,
            }
        }, { transition })

        expect(result.renders).toEqual([])
        expect(result.activeLayersCorrect).toBe(true)
        expect(result.activeTextMapCorrect).toBe(true)
        expect(result.activeParamsCorrect).toBe(true)
    })
}
