// @ts-check
import { test, expect } from 'playwright/test'

test.describe('Drawing layer model', () => {
    test('createEffectLayer defaults gradient layers to four-corner mode', async ({ page }) => {
        await page.goto('/', { waitUntil: 'networkidle' })
        await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })

        const { defaultParams, explicitParams, legacyParams } = await page.evaluate(async () => {
            const { createEffectLayer, deserializeLayers } = await import('/js/layers/layer-model.js')
            return {
                defaultParams: createEffectLayer('synth/gradient').effectParams,
                explicitParams: createEffectLayer('synth/gradient', undefined, { type: 3 }).effectParams,
                legacyParams: deserializeLayers(JSON.stringify([{
                    sourceType: 'effect',
                    effectId: 'synth/gradient',
                    effectParams: {}
                }]))[0].effectParams
            }
        })

        expect(defaultParams).toEqual({ type: 2 })
        expect(explicitParams).toEqual({ type: 3 })
        expect(legacyParams).toEqual({})
    })

    test('createDrawingLayer creates a layer with sourceType drawing', async ({ page }) => {
        await page.goto('/', { waitUntil: 'networkidle' })
        await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })

        const layer = await page.evaluate(() => {
            const { createDrawingLayer } = window._drawingTestExports
            return createDrawingLayer('My Drawing')
        })

        expect(layer.sourceType).toBe('drawing')
        expect(layer.name).toBe('My Drawing')
        expect(layer.strokes).toEqual([])
        expect(layer.visible).toBe(true)
        expect(layer.opacity).toBe(100)
    })

    test('drawing layer serializes strokes and omits drawingCanvas', async ({ page }) => {
        await page.goto('/', { waitUntil: 'networkidle' })
        await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 10000 })

        const result = await page.evaluate(() => {
            const { createDrawingLayer, createPathStroke } = window._drawingTestExports
            const layer = createDrawingLayer('Test')
            layer.strokes.push(createPathStroke({
                color: '#ff0000', size: 5,
                points: [{ x: 10, y: 20 }]
            }))
            layer.drawingCanvas = 'should-be-stripped'
            const serialized = JSON.parse(JSON.stringify(layer))
            return { hasStrokes: serialized.strokes.length === 1, sourceType: serialized.sourceType }
        })

        expect(result.hasStrokes).toBe(true)
        expect(result.sourceType).toBe('drawing')
    })
})
