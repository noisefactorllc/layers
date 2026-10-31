import test from 'node:test'
import assert from 'node:assert/strict'
import { PanTool } from '../public/js/tools/pan-tool.js'

function glide(t, { left = 100, top = 100, vx = -2, vy = 1 } = {}) {
    const saved = new Map(['window', 'requestAnimationFrame', 'cancelAnimationFrame'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
    Object.assign(globalThis, {
        window: new EventTarget(),
        requestAnimationFrame: () => 1,
        cancelAnimationFrame: () => {},
    })
    t.after(() => {
        for (const [key, descriptor] of saved) {
            if (descriptor) Object.defineProperty(globalThis, key, descriptor)
            else delete globalThis[key]
        }
    })
    const panel = new EventTarget()
    Object.defineProperties(panel, {
        scrollLeft: { get: () => left, set: value => { left = Math.max(0, Math.min(1000, value)) } },
        scrollTop: { get: () => top, set: value => { top = Math.max(0, Math.min(1000, value)) } },
    })
    const tool = new PanTool({ panel })
    tool._glideRaf = 1
    tool._glideLastT = 100
    tool._glideVX = vx
    tool._glideVY = vy
    return { tool, panel }
}

test('an early glide frame preserves motion and the next frame integrates only elapsed time', t => {
    const { tool, panel } = glide(t)
    tool._onGlideFrame(99.5)
    assert.deepEqual([panel.scrollLeft, panel.scrollTop, tool._glideVX, tool._glideVY, tool._glideLastT], [100, 100, -2, 1, 100])
    tool._onGlideFrame(110)
    assert.equal(panel.scrollLeft, 80)
    assert.equal(panel.scrollTop, 110)
    assert.ok(Math.abs(tool._glideVX - -1.8788261256269516) < 1e-12)
    assert.ok(Math.abs(tool._glideVY - 0.9394130628134758) < 1e-12)
    assert.equal(tool._glideLastT, 110)
})

test('an early glide frame cannot move away from the scroll boundary', t => {
    const { tool, panel } = glide(t, { left: 0, vx: -2, vy: 0 })
    tool._onGlideFrame(99.5)
    assert.equal(panel.scrollLeft, 0)
    assert.equal(tool._glideVX, -2)
    tool._onGlideFrame(110)
    assert.equal(panel.scrollLeft, 0)
    assert.equal(tool._glideVX, 0)
    assert.equal(tool._glideRaf, null)
})

test('a long glide frame retains the frame cap without carrying excess time forward', t => {
    const { tool, panel } = glide(t, { vx: 1, vy: 0 })
    tool._onGlideFrame(1100)
    assert.equal(panel.scrollLeft, 164)
    assert.ok(Math.abs(tool._glideVX - 0.6703200460356393) < 1e-12)
    assert.equal(tool._glideLastT, 1100)
    tool._onGlideFrame(1110)
    assert.ok(Math.abs(panel.scrollLeft - 170.7032004603564) < 1e-12)
})
