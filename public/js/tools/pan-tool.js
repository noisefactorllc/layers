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
    }

    _onPointerUp(e) {
        if (this._state !== State.PANNING) return
        if (e.pointerId !== this._activePointerId || e.button !== 0) return
        this._finishGesture()
    }

    _onCancel(e) {
        if (e && e.pointerId !== undefined && this._activePointerId !== null && e.pointerId !== this._activePointerId) {
            return
        }
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
}
