/**
 * Effect Parameters Component
 * Displays parameter controls for an effect layer
 *
 * @module layers/effect-params
 */

import { getEffect } from '../noisemaker/bundle.js'
import './font-select.js'
import { getFontaineLoader, BASE_FONTS, previewFamilyFor } from './fontaine-loader.js'
import { SliderValue, SelectDropdown, ToggleSwitch, ColorPicker, Vector3dPicker } from 'handfish'

// Static effect loader function (set by app after renderer init)
let effectLoader = null

// Resolves a param spec to its declared DSL identifier values (member/volume/
// geometry enums), for dropdowns that declare no explicit `choices`. Injected
// by the app so this component stays engine-agnostic.
let declaredValuesResolver = null

/**
 * EffectParams - Web component for effect parameter editing
 * Single-column layout inspired by noisedeck controls
 * @extends HTMLElement
 */
class EffectParams extends HTMLElement {
    /**
     * Set the effect loader function
     * @param {function} loader - Async function: (effectId) => effectDef
     */
    static setEffectLoader(loader) {
        effectLoader = loader
    }

    /**
     * Set the declared-values resolver (spec => string[] of DSL identifiers).
     * Used to populate dropdowns for member/volume/geometry enum params that
     * declare no explicit `choices`.
     * @param {function} resolver
     */
    static setDeclaredValuesResolver(resolver) {
        declaredValuesResolver = resolver
    }

    constructor() {
        super()
        this._effectId = null
        this._layerId = null
        this._params = {}
        this._effectDef = null
        this._controls = new Map()
        this._loading = false
    }

    connectedCallback() {
        this._render()
    }

    disconnectedCallback() {
        this._controls.clear()
    }

    /**
     * Set the effect to display parameters for
     * @param {string} effectId - Effect ID (e.g., 'filter/blur')
     * @param {string} layerId - Layer ID for events
     * @param {object} params - Current parameter values
     */
    async setEffect(effectId, layerId, params = {}) {
        this._effectId = effectId
        this._layerId = layerId
        this._params = { ...params }

        // Try synchronous first (already loaded)
        this._effectDef = effectId ? getEffect(effectId) : null

        // If not found and we have a loader, load async
        if (!this._effectDef && effectId && effectLoader) {
            this._loading = true
            this._render() // Show loading state
            try {
                this._effectDef = await effectLoader(effectId)
            } catch (err) {
                console.warn(`[effect-params] Failed to load ${effectId}:`, err)
            }
            this._loading = false
        }

        this._render()
    }

    /**
     * Clear the effect display
     */
    clear() {
        this._effectId = null
        this._layerId = null
        this._params = {}
        this._effectDef = null
        this._controls.clear()
        this._render()
    }

    /**
     * Get current parameter values
     * @returns {object} Current parameters
     */
    getParams() {
        return { ...this._params }
    }

    /**
     * Render the component
     * @private
     */
    _render() {
        this._controls.clear()

        // Loading state
        if (this._loading) {
            this.innerHTML = '<div class="effect-params-loading">Loading parameters...</div>'
            this.classList.remove('empty')
            return
        }

        if (!this._effectDef) {
            this.innerHTML = ''
            this.classList.add('empty')
            return
        }

        const globals = this._effectDef.globals || {}

        // surface: engine-managed texture handles (e.g. lighting heightMap in
        // newer shader bundles) — _inferControlType would fall through to a
        // slider holding a texture name string, a broken control.
        const unsupportedTypes = ['vec2', 'surface']
        const isVisible = spec =>
            !spec.ui?.hidden && !spec.internal && !unsupportedTypes.includes(spec.type)

        const visibleParams = Object.entries(globals).filter(([_, spec]) => isVisible(spec))

        if (visibleParams.length === 0) {
            this.innerHTML = '<div class="effect-params-empty">No adjustable parameters</div>'
            this.classList.remove('empty')
            return
        }

        this.classList.remove('empty')

        this.innerHTML = `
            <div class="effect-params-header">
                <span class="effect-params-title">Parameters</span>
            </div>
            <div class="effect-params-controls"></div>
        `

        const controlsContainer = this.querySelector('.effect-params-controls')

        for (const [paramName, spec] of visibleParams) {
            const controlGroup = this._createControlGroup(paramName, spec)
            if (controlGroup) {
                controlsContainer.appendChild(controlGroup)
            }
        }

        // Grey out any control whose ui.enabledBy condition is not currently met.
        this._applyEnabledStates()
    }

    /**
     * Create a control group for a parameter
     * @param {string} paramName - Parameter name
     * @param {object} spec - Parameter specification
     * @returns {HTMLElement|null} Control group element
     * @private
     */
    _createControlGroup(paramName, spec) {
        const group = document.createElement('div')
        group.className = 'control-group'
        group.dataset.paramKey = paramName

        // Label
        const label = document.createElement('label')
        label.className = 'control-label'
        label.textContent = spec.ui?.label || paramName
        group.appendChild(label)

        // Get current value or default
        const currentValue = this._params[paramName] !== undefined
            ? this._params[paramName]
            : spec.default

        // Create appropriate control based on type
        const controlHandle = this._createControl(paramName, spec, currentValue)
        if (!controlHandle) return null

        // Append the control element(s)
        if (controlHandle.element) {
            group.appendChild(controlHandle.element)
        }

        this._controls.set(paramName, controlHandle)
        return group
    }

    /**
     * Create a control element for a parameter
     * @param {string} paramName - Parameter name
     * @param {object} spec - Parameter specification
     * @param {*} currentValue - Current value
     * @returns {object|null} Control handle with element and getValue/setValue
     * @private
     */
    _createControl(paramName, spec, currentValue) {
        // Special case: font parameter gets the font-select component
        if (paramName === 'font' && spec.choices) {
            return this._createFontSelect(paramName, spec, currentValue)
        }

        let controlType = spec.ui?.control || this._inferControlType(spec)

        // vec3 params render as 3D vector pickers regardless of a declared
        // slider control — mirrors noisedeck's type-first dispatch (e.g.
        // filter/grade's tint/wheel params are vec3 with control: "slider",
        // which would break a scalar slider). An explicit color control
        // still wins, as in noisedeck.
        if (spec.type === 'vec3' && controlType !== 'color') {
            controlType = 'vector3'
        }

        switch (controlType) {
            case 'slider':
                return this._createSlider(paramName, spec, currentValue)
            case 'dropdown':
                return this._createDropdown(paramName, spec, currentValue)
            case 'checkbox':
            case 'toggle':
                return this._createToggle(paramName, spec, currentValue)
            case 'color':
                return this._createColorPicker(paramName, spec, currentValue)
            case 'vector3':
                return this._createVec3(paramName, spec, currentValue)
            case 'button':
                return this._createButton(paramName, spec)
            case 'text':
            case 'textarea':
                return this._createTextInput(paramName, spec, currentValue)
            default:
                return null
        }
    }

    /**
     * Infer control type from spec
     * @param {object} spec - Parameter specification
     * @returns {string} Control type
     * @private
     */
    _inferControlType(spec) {
        if (spec.choices) return 'dropdown'
        if (spec.type === 'boolean') return 'toggle'
        if (spec.type === 'color' || spec.type === 'vec4') return 'color'
        if (spec.type === 'vec3') return 'vector3'
        if (spec.type === 'string') return 'text'
        if (spec.type === 'float' || spec.type === 'int') return 'slider'
        return 'slider'
    }

    /**
     * Create a slider control
     * @private
     */
    _createSlider(paramName, spec, currentValue) {
        const slider = document.createElement('slider-value')
        slider.min = spec.min ?? 0
        slider.max = spec.max ?? 100
        slider.step = spec.step ?? (spec.type === 'int' ? 1 : 0.01)
        slider.value = currentValue
        slider.type = spec.type === 'int' ? 'int' : 'float'

        slider.addEventListener('input', () => {
            const value = spec.type === 'int'
                ? parseInt(slider.value, 10)
                : parseFloat(slider.value)
            this._handleValueChange(paramName, value, spec)
        })

        return {
            element: slider,
            getValue: () => spec.type === 'int' ? parseInt(slider.value, 10) : parseFloat(slider.value),
            setValue: (v) => { slider.value = v }
        }
    }

    /**
     * Create a dropdown control
     * @private
     */
    _createDropdown(paramName, spec, currentValue) {
        const select = document.createElement('select-dropdown')

        // Options come from the explicit `choices` map when present, otherwise
        // from the param's declared enum members (member/volume/geometry types
        // such as filter/palette `index` — a 50+ member enum with no `choices`,
        // which would otherwise render an empty, useless dropdown).
        const choices = spec.choices
        let opts
        let typedByString
        if (choices && Object.keys(choices).length > 0) {
            opts = Object.entries(choices).map(([name, value]) => ({
                value: String(value),
                text: name
            }))
            typedByString = new Map(Object.values(choices).map(v => [String(v), v]))
        } else {
            const declared = declaredValuesResolver ? declaredValuesResolver(spec) : []
            opts = declared.map(id => ({
                value: String(id),
                text: String(id).includes('.') ? String(id).split('.').pop() : String(id)
            }))
            typedByString = new Map(declared.map(id => [String(id), id]))
        }

        // The handfish select-dropdown only round-trips strings, so map the
        // selected option string back to its original typed choice value. A
        // numeric choice (e.g. a float `rotation` {none:0,fwd:1,back:-1}) must
        // emit the Number 1, not the string "1" — which _buildEffectCall would
        // serialize as a broken triple-quoted "1" the shader can't read.
        const coerce = (raw) => typedByString.has(raw) ? typedByString.get(raw) : raw

        select.setOptions(opts)
        select.value = String(currentValue ?? '')

        select.addEventListener('change', () => {
            this._handleValueChange(paramName, coerce(select.value), spec)
        })

        return {
            element: select,
            getValue: () => coerce(select.value),
            setValue: (v) => { select.value = String(v) }
        }
    }

    /**
     * Create a font-select control for the font parameter
     * @private
     */
    _createFontSelect(paramName, spec, currentValue) {
        const wrapper = document.createElement('div')
        wrapper.className = 'font-control-stack'

        const fontSelect = document.createElement('font-select')
        fontSelect.value = currentValue || spec.default || 'Nunito'
        wrapper.appendChild(fontSelect)

        // Companion style picker. A bundled family ships many cuts — Monaspace
        // alone is five typefaces across three widths and seven weights — and
        // without this the layer could only ever render whichever face got
        // registered at weight 400.
        const styleSelect = document.createElement('select-dropdown')
        styleSelect.setAttribute('aria-label', 'font style')
        wrapper.appendChild(styleSelect)

        const syncStyles = async () => {
            const loader = getFontaineLoader()
            const font = loader.fontsLoaded
                ? loader.getAllFonts().find(f => f.name === fontSelect.value)
                : null

            if (!font) {
                styleSelect.setOptions([{ value: 'Regular', text: 'Regular' }])
                styleSelect.value = 'Regular'
                styleSelect.disabled = true
                return null
            }

            const styles = loader.getStylesForFont(font.id)
            styleSelect.disabled = styles.length <= 1
            styleSelect.setOptions(styles.map(s => ({ value: s.label, text: s.label })))
            // Resolve rather than match: a layer saved before an entry was split
            // per typeface carries the old bare label ("Regular").
            const resolved = loader.resolveStyle(font.id, this._params.style) || styles[0]
            styleSelect.value = resolved.label
            return resolved
        }

        const applyStyle = async (resolved) => {
            const loader = getFontaineLoader()
            if (!resolved || !loader.fontsLoaded) return
            await loader.registerFontWithStyle(fontSelect.value, resolved.label)
        }

        this._loadFontOptions(fontSelect).then(async () => {
            const resolved = await syncStyles()
            if (resolved && resolved.label !== this._params.style) {
                this._handleValueChange('style', resolved.label, { type: 'string' })
            }
            await applyStyle(resolved)
        })

        fontSelect.addEventListener('change', async () => {
            this._params.style = null
            const resolved = await syncStyles()
            await applyStyle(resolved)
            if (resolved) this._handleValueChange('style', resolved.label, { type: 'string' })
            this._handleValueChange(paramName, fontSelect.value, spec)
        })

        styleSelect.addEventListener('change', async () => {
            const loader = getFontaineLoader()
            const font = loader.fontsLoaded
                ? loader.getAllFonts().find(f => f.name === fontSelect.value)
                : null
            const resolved = font ? loader.resolveStyle(font.id, styleSelect.value) : null
            await applyStyle(resolved)
            this._handleValueChange('style', resolved ? resolved.label : styleSelect.value, { type: 'string' })
        })

        return {
            element: wrapper,
            getValue: () => fontSelect.value,
            setValue: (v) => { fontSelect.value = v; syncStyles() }
        }
    }

    /**
     * Load font options into a font-select element
     * @private
     */
    async _loadFontOptions(fontSelect) {
        const loader = getFontaineLoader()
        const installed = await loader.isInstalled()

        if (!installed) {
            fontSelect.setOptions(BASE_FONTS)
            return
        }

        await loader.loadFromCache()
        const bundleFonts = loader.getAllFonts().map(f => ({
            value: f.name,
            text: f.name,
            // Preview under a dedicated family; see previewFamilyFor.
            previewFamily: previewFamilyFor(f.name),
            category: f.category || 'other',
            tags: f.tags || []
        }))
        fontSelect.setOptions(bundleFonts)
        loader.registerAllFonts()
    }

    /**
     * Create a toggle/checkbox control
     * @private
     */
    _createToggle(paramName, spec, currentValue) {
        const toggle = document.createElement('toggle-switch')
        toggle.checked = !!currentValue

        toggle.addEventListener('change', () => {
            this._handleValueChange(paramName, toggle.checked, spec)
        })

        return {
            element: toggle,
            getValue: () => toggle.checked,
            setValue: (v) => { toggle.checked = !!v }
        }
    }

    /**
     * Create a color picker control
     * @private
     */
    _createColorPicker(paramName, spec, currentValue) {
        const colorPicker = document.createElement('color-picker')

        const hexValue = this._arrayToHex(currentValue)
        colorPicker.value = hexValue

        colorPicker.addEventListener('input', () => {
            const arrayValue = this._hexToArray(colorPicker.value)
            this._handleValueChange(paramName, arrayValue, spec)
        })

        return {
            element: colorPicker,
            getValue: () => this._hexToArray(colorPicker.value),
            setValue: (v) => {
                colorPicker.value = this._arrayToHex(v)
            }
        }
    }

    /**
     * Create a 3D vector picker control (vec3 params)
     * Mirrors noisedeck's controlGroupBuilder wiring: min/max/step from the
     * spec (picker defaults -1..1 step 0.01), normalized mode for direction
     * vectors, params stored as [x, y, z] arrays.
     * @private
     */
    _createVec3(paramName, spec, currentValue) {
        const picker = document.createElement('vector3d-picker')
        picker.className = 'control-vector3d'

        if (spec.min !== undefined) picker.setAttribute('min', spec.min)
        if (spec.max !== undefined) picker.setAttribute('max', spec.max)
        if (spec.step !== undefined) picker.setAttribute('step', spec.step)

        const lowerName = paramName.toLowerCase()
        if (lowerName.includes('dir') || spec.normalized === true) {
            picker.setAttribute('normalized', '')
        }

        const toArray = (v) => {
            if (Array.isArray(v) && v.length >= 3) return v.slice(0, 3)
            if (v && typeof v === 'object') return [v.x ?? 0, v.y ?? 0, v.z ?? 0]
            return null
        }
        picker.value = toArray(currentValue) ?? toArray(spec.default) ?? [0, 1, 0]

        picker.addEventListener('input', () => {
            const v = picker.value
            this._handleValueChange(paramName, [v.x, v.y, v.z], spec)
        })

        return {
            element: picker,
            getValue: () => {
                const v = picker.value
                return [v.x, v.y, v.z]
            },
            setValue: (v) => {
                const arr = toArray(v)
                if (arr) picker.value = arr
            }
        }
    }

    /**
     * Create a button control (for momentary actions like reset)
     * @private
     */
    _createButton(paramName, spec) {
        const button = document.createElement('button')
        button.type = 'button'
        button.className = 'control-button'
        button.textContent = spec.ui?.buttonLabel || paramName

        button.addEventListener('click', () => {
            // For buttons, trigger the action (usually sets a flag temporarily)
            this._handleValueChange(paramName, true, spec)
            // Reset after a frame
            requestAnimationFrame(() => {
                this._handleValueChange(paramName, false, spec)
            })
        })

        return {
            element: button,
            getValue: () => false,
            setValue: () => {}
        }
    }

    /**
     * Create a text input control
     * @private
     */
    _createTextInput(paramName, spec, currentValue) {
        const isMultiline = spec.ui?.multiline

        let input
        if (isMultiline) {
            input = document.createElement('textarea')
            input.className = 'control-textarea'
            input.rows = 3
        } else {
            input = document.createElement('input')
            input.type = 'text'
            input.className = 'control-text'
        }

        input.value = currentValue || ''
        if (spec.ui?.placeholder) {
            input.placeholder = spec.ui.placeholder
        }

        input.addEventListener('input', () => {
            this._handleValueChange(paramName, input.value, spec)
        })

        return {
            element: input,
            getValue: () => input.value,
            setValue: (v) => { input.value = v || '' }
        }
    }

    /**
     * Handle a parameter value change
     * @param {string} paramName - Parameter name
     * @param {*} value - New value
     * @param {object} spec - Parameter specification
     * @private
     */
    _handleValueChange(paramName, value, spec) {
        this._params[paramName] = value

        // A change may flip another param's enabledBy condition (e.g. halftone
        // `mode` toggles pattern/ink/paper vs the CMYK screen angles), so
        // re-evaluate the whole panel's enabled states.
        this._applyEnabledStates()

        // Emit event for layer to handle
        this.dispatchEvent(new CustomEvent('param-change', {
            bubbles: true,
            detail: {
                layerId: this._layerId,
                paramName,
                value,
                params: this.getParams()
            }
        }))
    }

    /**
     * Apply each control's ui.enabledBy condition to the current param values,
     * greying out (and disabling) controls whose condition is not met. A
     * disabled control is inert in the shader, so leaving it interactive is a
     * dropdown/slider that silently does nothing.
     * @private
     */
    _applyEnabledStates() {
        if (!this._effectDef) return
        const globals = this._effectDef.globals || {}
        this.querySelectorAll('.control-group').forEach(group => {
            const spec = globals[group.dataset.paramKey]
            if (!spec) return
            const enabled = this._evalEnabledBy(spec.ui?.enabledBy, this._params, globals)
            group.classList.toggle('disabled', !enabled)
            const control = this._controls.get(group.dataset.paramKey)
            if (control?.element && 'disabled' in control.element) {
                control.element.disabled = !enabled
            }
        })
    }

    /**
     * Evaluate a ui.enabledBy condition against the current param values.
     * Supported forms (mirroring the effect manifest): a bare param name
     * (truthy), `{param, eq|neq|gt|gte|lt|lte}`, `{param, in|notIn}`, and the
     * compound `{and:[...]}` / `{or:[...]}`. Absent condition = always enabled.
     * @private
     */
    _evalEnabledBy(cond, params, globals) {
        if (cond == null) return true
        if (typeof cond === 'string') return !!this._resolveParamValue(cond, params, globals)
        if (Array.isArray(cond.and)) return cond.and.every(c => this._evalEnabledBy(c, params, globals))
        if (Array.isArray(cond.or)) return cond.or.some(c => this._evalEnabledBy(c, params, globals))
        const actual = this._resolveParamValue(cond.param, params, globals)
        if ('eq' in cond) return actual === cond.eq
        if ('neq' in cond) return actual !== cond.neq
        if ('gt' in cond) return actual > cond.gt
        if ('gte' in cond) return actual >= cond.gte
        if ('lt' in cond) return actual < cond.lt
        if ('lte' in cond) return actual <= cond.lte
        if (Array.isArray(cond.in)) return cond.in.includes(actual)
        if (Array.isArray(cond.notIn)) return !cond.notIn.includes(actual)
        return true
    }

    /**
     * Resolve a param's effective value: the current value if set, else the
     * spec default (an enabledBy dependency may not be in _params yet).
     * @private
     */
    _resolveParamValue(name, params, globals) {
        if (params && params[name] !== undefined) return params[name]
        return globals?.[name]?.default
    }

    /**
     * Format a value for display
     * @param {*} value - Value to format
     * @param {object} spec - Parameter specification
     * @returns {string} Formatted value
     * @private
     */
    _formatValue(value, spec) {
        if (typeof value === 'number') {
            if (spec.type === 'int') {
                return value.toString()
            }
            // Float: show 2 decimal places
            return value.toFixed(2)
        }
        return String(value)
    }

    /**
     * Convert RGB array [0-1] to hex string
     * @private
     */
    _arrayToHex(arr) {
        if (!Array.isArray(arr)) return '#ffffff'
        const hex = c => Math.round((c || 0) * 255).toString(16).padStart(2, '0')
        return `#${hex(arr[0])}${hex(arr[1])}${hex(arr[2])}`
    }

    /**
     * Convert hex string to RGB array [0-1]
     * @private
     */
    _hexToArray(hex) {
        const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex)
        if (!result) return [1, 1, 1]
        return [
            parseInt(result[1], 16) / 255,
            parseInt(result[2], 16) / 255,
            parseInt(result[3], 16) / 255
        ]
    }
}

customElements.define('effect-params', EffectParams)

export { EffectParams }
