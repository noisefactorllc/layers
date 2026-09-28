/**
 * Pan Tool - Handles viewport dragging/panning
 *
 * FSM States: IDLE -> PANNING -> IDLE
 *
 * @module tools/pan-tool
 */

const State = {
    IDLE: 'idle',
    PANNING: 'panning'
}

// Momentum glide tuning.
// The sample window is deliberately wide: in WebKit automation (and on
// loaded CI runners) each synthetic pointer-move dispatch can land well
// over 100 ms apart, so a narrow window would prune all but one sample
// and no release velocity could be estimated. Real pointer input moves
// every ~8-16 ms, so 250 ms still tracks only the final gesture segment.
const SAMPLE_WINDOW_MS = 250
const MIN_SAMPLE_DT_MS = 8     // ignore degenerate sample spans
const GLIDE_START_SPEED = 0.25 // px/ms of scroll speed required to glide
const GLIDE_STOP_SPEED = 0.02  // px/ms at which the glide ends
const GLIDE_HALF_LIFE_MS = 160 // exponential decay time constant
const MAX_FRAME_DT_MS = 64     // clamp background-tab frame jumps

export class PanTool {
    constructor(options) {
        this._overlay = options.overlay
        this._panel = options.panel || document.getElementById('canvas-panel')
        this._toolClass = options.toolClass || 'pan-tool'
        this._onPanStart = options.onPanStart
        this._onPanEnd = options.onPanEnd

        this._active = false
        this._state = State.IDLE
        this._pointerStartX = 0
        this._pointerStartY = 0
        this._scrollStartX = 0
        this._scrollStartY = 0
        this._activePointerId = null
        this._capturedElement = null

        // Momentum (inertia) glide state. Velocity is in scroll px/ms;
        // pointer velocity is negated because panning inverts it.
        this._samples = [] // recent {t, x, y} pointer samples for release velocity
        this._glideRaf = null
        this._glideVX = 0
        this._glideVY = 0
        this._glideLastT = 0
        this._suppressGlide = false
        this._onGlideFrame = this._onGlideFrame.bind(this)
        this._onGlideInterrupt = this._onGlideInterrupt.bind(this)
        this._boundStopGlide = this._stopGlide.bind(this)

        // Glide-interrupt and blur listeners are attached once here: the
        // momentum glide intentionally outlives the pan gesture and even a
        // tool switch (a spacebar-hold pan restores the previous tool
        // immediately on keyup, which must not kill inertia), so they must
        // not be tied to activate()/deactivate().
        if (this._panel) {
            this._panel.addEventListener('pointerdown', this._onGlideInterrupt)
            this._panel.addEventListener('wheel', this._onGlideInterrupt)
            this._panel.addEventListener('gesturestart', this._onGlideInterrupt)
        }
        window.addEventListener('blur', this._boundStopGlide)

        this._onPointerDown = this._onPointerDown.bind(this)
        this._onPointerMove = this._onPointerMove.bind(this)
        this._onPointerUp = this._onPointerUp.bind(this)
        this._onCancel = this._onCancel.bind(this)
    }

    get isActive() {
        return this._active
    }

    get isPanning() {
        return this._state === State.PANNING
    }

    activate() {
        if (this._active) return
        this._active = true
        this._state = State.IDLE

        if (this._panel) {
            this._panel.addEventListener('pointerdown', this._onPointerDown)
            this._panel.classList.add(this._toolClass)
        }
        if (this._overlay) {
            this._overlay.classList.add(this._toolClass)
        }
        window.addEventListener('blur', this._onCancel)
    }

    deactivate() {
        if (!this._active) return
        this._active = false
        this._cancelGesture()

        if (this._panel) {
            this._panel.removeEventListener('pointerdown', this._onPointerDown)
            this._panel.classList.remove(this._toolClass)
            this._panel.classList.remove('panning')
        }
        if (this._overlay) {
            this._overlay.classList.remove(this._toolClass)
            this._overlay.classList.remove('panning')
        }
        window.removeEventListener('blur', this._onCancel)
    }

    _onPointerDown(e) {
        if (this._state !== State.IDLE) return
        if (e.button !== 0) return // Left click only
        if (!this._panel) return

        // A new interaction over the panel always stops inertia.
        this._stopGlide()
        this._suppressGlide = false
        this._samples.length = 0

        this._state = State.PANNING
        this._activePointerId = e.pointerId
        this._pointerStartX = e.clientX
        this._pointerStartY = e.clientY
        this._scrollStartX = this._panel.scrollLeft
        this._scrollStartY = this._panel.scrollTop

        this._capturedElement = e.target
        try {
            this._capturedElement.setPointerCapture(e.pointerId)
        } catch {
            // ignore if capture fails
        }

        window.addEventListener('pointermove', this._onPointerMove)
        window.addEventListener('pointerup', this._onPointerUp)
        window.addEventListener('pointercancel', this._onCancel)

        this._panel.classList.add('panning')
        this._overlay?.classList.add('panning')

        if (this._onPanStart) this._onPanStart()
    }

    _onPointerMove(e) {
        if (this._state !== State.PANNING || !this._panel) return
        if (e.pointerId !== this._activePointerId) return

        const dx = e.clientX - this._pointerStartX
        const dy = e.clientY - this._pointerStartY

        this._panel.scrollLeft = this._scrollStartX - dx
        this._panel.scrollTop = this._scrollStartY - dy

        // Sample for release-velocity estimation (pruned window).
        // performance.now() rather than e.timeStamp: WebKit synthesizes
        // CDP-driven pointer moves with identical event timestamps, which
        // would collapse every sample window below the minimum span.
        const t = performance.now()
        this._samples.push({ t, x: e.clientX, y: e.clientY })
        const cutoff = t - SAMPLE_WINDOW_MS
        while (this._samples.length > 2 && this._samples[0].t < cutoff) {
            this._samples.shift()
        }
    }

    _onPointerUp(e) {
        if (this._state !== State.PANNING) return
        if (e.pointerId !== this._activePointerId || e.button !== 0) return
        this._finishGesture()
        this._maybeStartGlide()
    }

    _onCancel(e) {
        if (e && e.pointerId !== undefined && this._activePointerId !== null && e.pointerId !== this._activePointerId) {
            return
        }
        // A cancelled gesture (Escape, pointercancel, window blur) must
        // never hand off to inertia.
        this._suppressGlide = true
        this._cancelGesture()
    }

    _finishGesture() {
        if (this._capturedElement && this._activePointerId !== null) {
            try {
                if (this._capturedElement.hasPointerCapture(this._activePointerId)) {
                    this._capturedElement.releasePointerCapture(this._activePointerId)
                }
            } catch {
                // ignore
            }
        }
        this._capturedElement = null
        this._activePointerId = null

        window.removeEventListener('pointermove', this._onPointerMove)
        window.removeEventListener('pointerup', this._onPointerUp)
        window.removeEventListener('pointercancel', this._onCancel)

        this._panel?.classList.remove('panning')
        this._overlay?.classList.remove('panning')

        this._state = State.IDLE

        if (this._onPanEnd) this._onPanEnd()
    }

    _cancelGesture() {
        if (this._state === State.PANNING) {
            this._finishGesture()
        }
    }

    get isGliding() {
        return this._glideRaf !== null
    }

    /**
     * Hand off to a momentum glide if the pan drag ended with enough
     * pointer velocity. Cancelled gestures never glide.
     * @private
     */
    _maybeStartGlide() {
        if (this._suppressGlide) return
        if (!this._panel) return
        const s = this._samples
        if (s.length < 2) return
        const first = s[0]
        const last = s[s.length - 1]
        const dt = last.t - first.t
        if (dt < MIN_SAMPLE_DT_MS) return

        // Scroll velocity is the negated pointer velocity.
        const vx = -(last.x - first.x) / dt
        const vy = -(last.y - first.y) / dt
        const speed = Math.hypot(vx, vy)
        if (speed < GLIDE_START_SPEED) return

        this._startGlide(vx, vy)
    }

    _startGlide(vx, vy) {
        this._stopGlide()
        this._glideVX = vx
        this._glideVY = vy
        this._glideLastT = performance.now()
        this._glideRaf = requestAnimationFrame(this._onGlideFrame)
    }

    _onGlideFrame(now) {
        if (this._glideRaf === null || !this._panel) {
            this._glideRaf = null
            return
        }
        const dt = Math.min(now - this._glideLastT, MAX_FRAME_DT_MS)
        this._glideLastT = now

        // Exponential decay of velocity over the elapsed frame.
        const decay = Math.exp(-dt / GLIDE_HALF_LIFE_MS)
        const dx = this._glideVX * dt
        const dy = this._glideVY * dt

        const beforeX = this._panel.scrollLeft
        const beforeY = this._panel.scrollTop
        const targetX = beforeX + dx
        const targetY = beforeY + dy
        this._panel.scrollLeft = targetX
        this._panel.scrollTop = targetY
        // An axis pinned at a scroll bound stops contributing velocity.
        // The |delta| guard keeps browsers that round scroll offsets to
        // integers from zeroing an axis on a sub-pixel frame step.
        if (Math.abs(dx) >= 0.5 && this._panel.scrollLeft === beforeX) this._glideVX = 0
        if (Math.abs(dy) >= 0.5 && this._panel.scrollTop === beforeY) this._glideVY = 0
        this._glideVX *= decay
        this._glideVY *= decay

        if (Math.hypot(this._glideVX, this._glideVY) < GLIDE_STOP_SPEED) {
            this._stopGlide()
            return
        }
        this._glideRaf = requestAnimationFrame(this._onGlideFrame)
    }

    _stopGlide() {
        if (this._glideRaf !== null) {
            cancelAnimationFrame(this._glideRaf)
            this._glideRaf = null
        }
        this._glideVX = 0
        this._glideVY = 0
    }

    _onGlideInterrupt() {
        this._stopGlide()
    }
}
