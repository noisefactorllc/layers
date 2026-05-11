/**
 * Fontaine Font Loader Module
 *
 * Integrates the fontaine font bundle (100 curated web fonts) with Noisedeck.
 * Downloads fonts from https://fonts.noisefactor.io/bundle with progress tracking
 * and caches them in IndexedDB for offline use.
 *
 * @module ui/fontaineLoader
 */

const FONTAINE_BUNDLE_URL = 'https://fonts.noisefactor.io/bundle'
const FONTAINE_BUNDLE_SIZE_MB = 140
const DB_NAME = 'fontaine'
const DB_VERSION = 1

/** Base font options available without the fontaine bundle */
const BASE_FONTS = [
    { value: 'Nunito', text: 'Nunito', category: 'sans-serif', tags: ['ui'] },
    { value: 'sans-serif', text: 'sans-serif', category: 'sans-serif', tags: ['system'] },
    { value: 'serif', text: 'serif', category: 'serif', tags: ['system'] },
    { value: 'monospace', text: 'monospace', category: 'monospace', tags: ['system'] },
    { value: 'cursive', text: 'cursive', category: 'handwriting', tags: ['system'] },
    { value: 'fantasy', text: 'fantasy', category: 'display', tags: ['system'] },
]

/** Set of base font names for quick membership checks */
const BASE_FONT_NAMES = new Set(BASE_FONTS.map(f => f.value))

/**
 * FontaineLoader - Manages fontaine font bundle downloading, caching, and access
 */
class FontaineLoader {
    constructor() {
        /** @type {IDBDatabase|null} */
        this.db = null

        /** @type {Object|null} */
        this.catalog = null

        /** @type {string|null} */
        this.installedVersion = null

        /** @type {boolean} */
        this.fontsLoaded = false

        /** @type {Set<string>} */
        this._registeredFonts = new Set()
    }

    // =========================================================================
    // IndexedDB Management
    // =========================================================================

    async openDB() {
        if (this.db) return this.db

        return new Promise((resolve, reject) => {
            const request = indexedDB.open(DB_NAME, DB_VERSION)

            request.onerror = () => reject(request.error)

            request.onsuccess = () => {
                this.db = request.result
                resolve(this.db)
            }

            request.onupgradeneeded = (event) => {
                const db = event.target.result

                // Store for bundle metadata
                if (!db.objectStoreNames.contains('meta')) {
                    db.createObjectStore('meta', { keyPath: 'key' })
                }

                // Store for font catalog
                if (!db.objectStoreNames.contains('fonts')) {
                    const fontStore = db.createObjectStore('fonts', { keyPath: 'id' })
                    fontStore.createIndex('category', 'category', { unique: false })
                    fontStore.createIndex('style', 'style', { unique: false })
                }

                // Store for font file blobs
                if (!db.objectStoreNames.contains('files')) {
                    db.createObjectStore('files', { keyPath: 'path' })
                }
            }
        })
    }

    async getInstalledVersion() {
        const db = await this.openDB()
        return new Promise((resolve, reject) => {
            const tx = db.transaction('meta', 'readonly')
            const store = tx.objectStore('meta')
            const request = store.get('version')
            request.onsuccess = () => resolve(request.result?.value || null)
            request.onerror = () => reject(request.error)
        })
    }

    async setInstalledVersion(version, versionDate, bundleSha256) {
        const db = await this.openDB()
        return new Promise((resolve, reject) => {
            const tx = db.transaction('meta', 'readwrite')
            const store = tx.objectStore('meta')
            store.put({ key: 'version', value: version, versionDate, bundleSha256 })
            tx.oncomplete = () => resolve()
            tx.onerror = () => reject(tx.error)
        })
    }

    async saveCatalog(fonts) {
        const db = await this.openDB()
        return new Promise((resolve, reject) => {
            const tx = db.transaction('fonts', 'readwrite')
            const store = tx.objectStore('fonts')
            store.clear()
            fonts.forEach(font => store.put(font))
            tx.oncomplete = () => resolve()
            tx.onerror = () => reject(tx.error)
        })
    }

    async saveFile(path, blob) {
        const db = await this.openDB()
        return new Promise((resolve, reject) => {
            const tx = db.transaction('files', 'readwrite')
            const store = tx.objectStore('files')
            store.put({ path, blob })
            tx.oncomplete = () => resolve()
            tx.onerror = () => reject(tx.error)
        })
    }

    async getFile(path) {
        const db = await this.openDB()
        return new Promise((resolve, reject) => {
            const tx = db.transaction('files', 'readonly')
            const store = tx.objectStore('files')
            const request = store.get(path)
            request.onsuccess = () => resolve(request.result?.blob || null)
            request.onerror = () => reject(request.error)
        })
    }

    async getAllFontsFromDB() {
        const db = await this.openDB()
        return new Promise((resolve, reject) => {
            const tx = db.transaction('fonts', 'readonly')
            const store = tx.objectStore('fonts')
            const request = store.getAll()
            request.onsuccess = () => resolve(request.result || [])
            request.onerror = () => reject(request.error)
        })
    }

    // =========================================================================
    // Status Check
    // =========================================================================

    /**
     * Check if the fontaine bundle is installed
     * @returns {Promise<boolean>}
     */
    async isInstalled() {
        try {
            const version = await this.getInstalledVersion()
            return version !== null
        } catch (e) {
            return false
        }
    }

    /**
     * Load fonts from cache (if already installed)
     * @returns {Promise<boolean>} True if fonts were loaded from cache
     */
    async loadFromCache() {
        try {
            const version = await this.getInstalledVersion()
            if (!version) return false

            this.installedVersion = version
            const fonts = await this.getAllFontsFromDB()
            if (fonts.length === 0) return false

            this.catalog = { fonts }
            this.fontsLoaded = true
            return true
        } catch (e) {
            console.warn('Failed to load fontaine from cache:', e)
            return false
        }
    }

    // =========================================================================
    // Download
    // =========================================================================

    /**
     * Download and install the fontaine bundle
     * @param {Object} options
     * @param {Function} [options.onProgress] - Progress callback (percent, message)
     * @param {AbortSignal} [options.signal] - Optional abort signal. When aborted,
     *   the in-flight fetch is interrupted and the chunk loop / extraction step
     *   throws between iterations — no need to wait for the next onProgress tick.
     * @returns {Promise<boolean>} True if successful
     */
    async install(options = {}) {
        const { onProgress = () => {}, signal } = options

        // Helper: throw if aborted. Surfaces signal.reason when available so
        // the caller's error has the AbortController's original cause.
        const checkAbort = () => {
            if (signal?.aborted) throw signal.reason || new Error('aborted')
        }

        checkAbort()
        onProgress(0, 'Loading manifest...')

        // Fetch manifest
        const manifestRes = await fetch(`${FONTAINE_BUNDLE_URL}/manifest.json`, { signal })
        if (!manifestRes.ok) {
            throw new Error(`Failed to load manifest: ${manifestRes.status}`)
        }
        const manifest = await manifestRes.json()
        const bundleVersion = manifest.version

        checkAbort()
        onProgress(5, 'Loading catalog...')

        // Fetch catalog
        const catalogRes = await fetch(`${FONTAINE_BUNDLE_URL}/fonts.json`, { signal })
        if (!catalogRes.ok) {
            throw new Error(`Failed to load catalog: ${catalogRes.status}`)
        }
        this.catalog = await catalogRes.json()

        checkAbort()
        onProgress(10, 'Downloading fonts...')

        // Fetch bundle ZIP
        const bundleRes = await fetch(`${FONTAINE_BUNDLE_URL}/fonts.zip`, { signal })
        if (!bundleRes.ok) {
            throw new Error(`Failed to load bundle: ${bundleRes.status}`)
        }

        const totalSize = manifest.bundle_size || parseInt(bundleRes.headers.get('content-length') || '0')
        const reader = bundleRes.body.getReader()
        const chunks = []
        let downloadedSize = 0

        while (true) {
            // Check between reads — a chunk in flight finishes, but the next
            // read won't start once the signal is aborted. With AbortSignal
            // passed to fetch above, reader.read() itself will reject when
            // aborted, but this check covers the gap if the signal flips
            // between reads.
            checkAbort()
            const { done, value } = await reader.read()
            if (done) break

            chunks.push(value)
            downloadedSize += value.length

            const percent = 10 + (downloadedSize / totalSize * 60)
            const mb = (downloadedSize / 1024 / 1024).toFixed(1)
            const totalMb = (totalSize / 1024 / 1024).toFixed(1)
            onProgress(percent, `Downloading: ${mb} / ${totalMb} MB`)
        }

        checkAbort()
        onProgress(70, 'Extracting fonts...')

        // Combine chunks into blob
        const zipBlob = new Blob(chunks)

        // Extract using JSZip (loaded dynamically if needed)
        await this._extractBundle(zipBlob, onProgress, signal)

        checkAbort()
        onProgress(95, 'Updating database...')

        // Save catalog and version
        await this.saveCatalog(this.catalog.fonts)
        await this.setInstalledVersion(bundleVersion, manifest.version_date, manifest.bundle_sha256)
        this.installedVersion = bundleVersion
        this.fontsLoaded = true

        onProgress(100, `Installed ${this.catalog.fonts.length} fonts`)

        return true
    }

    async _extractBundle(zipBlob, onProgress, signal) {
        // Dynamically load JSZip if not present
        if (typeof JSZip === 'undefined') {
            await this._loadJSZip()
        }

        // eslint-disable-next-line no-undef
        const zip = await JSZip.loadAsync(zipBlob)
        const files = Object.keys(zip.files)
        const fontFiles = files.filter(f => /\.(ttf|otf|woff|woff2|ttc)$/i.test(f))

        let extracted = 0
        for (const filename of fontFiles) {
            // Per-file abort check. JSZip's async('blob') for a single font
            // is uninterruptible, but between files we honor the signal so a
            // mid-extract cancel unwinds within ~one font's worth of work.
            if (signal?.aborted) throw signal.reason || new Error('aborted')
            const blob = await zip.files[filename].async('blob')
            await this.saveFile(filename, blob)

            extracted++
            const percent = 70 + (extracted / fontFiles.length * 25)
            const fontName = filename.split('/')[0]
            onProgress(percent, `Extracting: ${fontName}`)
        }
    }

    async _loadJSZip() {
        return new Promise((resolve, reject) => {
            const script = document.createElement('script')
            script.src = 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js'
            script.onload = resolve
            script.onerror = () => reject(new Error('Failed to load JSZip'))
            document.head.appendChild(script)
        })
    }

    // =========================================================================
    // Font Access
    // =========================================================================

    /**
     * Register all fonts at once (for displaying previews in font picker)
     * @returns {Promise<number>} Number of fonts registered
     */
    async registerAllFonts() {
        const fonts = this.getAllFonts()
        let registered = 0
        for (const font of fonts) {
            const success = await this.registerFont(font.id, font.name)
            if (success) registered++
        }
        return registered
    }

    /**
     * Get all fonts
     * @returns {Array} Array of font objects
     */
    getAllFonts() {
        return this.catalog?.fonts || []
    }

    /**
     * Get a specific font by ID
     * @param {string} fontId - Font ID (e.g., '01-inter')
     * @returns {Object|null} Font object or null
     */
    getFont(fontId) {
        return this.getAllFonts().find(f => f.id === fontId) || null
    }

    /**
     * Get fonts with a specific tag
     * @param {string} tag - Tag name (e.g., 'quirky', 'monospace', 'core')
     * @returns {Array} Array of matching fonts
     */
    getFontsByTag(tag) {
        return this.getAllFonts().filter(f => f.tags.includes(tag))
    }

    /**
     * Get fonts by category
     * @param {string} category - Category (e.g., 'sans-serif', 'serif', 'monospace')
     * @returns {Array} Array of matching fonts
     */
    getFontsByCategory(category) {
        return this.getAllFonts().filter(f => f.category === category)
    }

    /**
     * Get font names suitable for dropdown options
     * @returns {Array<{value: string, text: string, id: string}>}
     */
    getFontOptions() {
        return this.getAllFonts().map(f => ({
            value: f.name,
            text: f.name,
            id: f.id
        }))
    }

    /**
     * Parse style/weight info from a font filename
     * Font files are named: FontName-Weight-Subset.woff2 (e.g., "Inter-Bold-Latin2.woff2")
     * or FontName[axes]-Subset.woff2 for variable fonts (e.g., "Inter[wght]-Latin1.woff2")
     * @param {string} filename - Font filename
     * @returns {{weight: string, style: string, isVariable: boolean, label: string, subset: string}}
     */
    parseStyleFromFilename(filename) {
        // Remove extension
        const baseName = filename.replace(/\.(woff2?|ttf|otf)$/i, '')

        // Detect italic/oblique -- 'ital' matches italic but exclude 'digital'
        const lowerName = filename.toLowerCase()
        const isItalicFile = lowerName.includes('italic')
            || lowerName.includes('oblique')
            || (lowerName.includes('ital') && !lowerName.includes('digital'))

        // Known character subsets (to be stripped from style parsing)
        const subsetPatterns = [
            'Latin1', 'Latin2', 'Latin3', 'LatinExt', 'Latin-Ext',
            'Cyrillic', 'CyrillicExt', 'Greek', 'GreekExt',
            'Vietnamese', 'Hebrew', 'Arabic', 'Thai', 'Devanagari',
            'Pi', 'Symbols', 'Math'
        ]

        // Check for variable fonts - look for bracket notation
        const variableMatch = baseName.match(/\[([\w,]+)\]/)
        if (variableMatch) {
            const axes = variableMatch[1]
            return {
                weight: 'variable',
                style: isItalicFile ? 'italic' : 'normal',
                isVariable: true,
                label: isItalicFile ? 'Variable Italic' : 'Variable',
                axes,
                subset: this._extractSubset(baseName, subsetPatterns)
            }
        }

        // Split by hyphen and look for weight/style parts
        const parts = baseName.split('-')

        // Weight mapping
        const weightMap = {
            'Thin': { weight: '100', label: 'Thin' },
            'ExtraLight': { weight: '200', label: 'ExtraLight' },
            'UltraLight': { weight: '200', label: 'ExtraLight' },
            'Light': { weight: '300', label: 'Light' },
            'Regular': { weight: '400', label: 'Regular' },
            'Normal': { weight: '400', label: 'Regular' },
            'Medium': { weight: '500', label: 'Medium' },
            'SemiBold': { weight: '600', label: 'SemiBold' },
            'DemiBold': { weight: '600', label: 'SemiBold' },
            'Bold': { weight: '700', label: 'Bold' },
            'ExtraBold': { weight: '800', label: 'ExtraBold' },
            'UltraBold': { weight: '800', label: 'ExtraBold' },
            'Black': { weight: '900', label: 'Black' },
            'Heavy': { weight: '900', label: 'Black' }
        }

        let foundWeight = '400'
        let foundLabel = 'Regular'
        let isItalic = false
        let subset = ''

        // Find weight and italic in the parts (excluding subsets)
        for (const part of parts) {
            // Check if this part is a subset - skip it for weight parsing
            const isSubset = subsetPatterns.some(s => part.toLowerCase() === s.toLowerCase())
            if (isSubset) {
                subset = part
                continue
            }

            // Check for italic
            if (/italic/i.test(part)) {
                isItalic = true
            }

            // Check for weight (remove "Italic" suffix for matching)
            const cleanPart = part.replace(/italic/i, '')
            for (const [name, info] of Object.entries(weightMap)) {
                if (cleanPart.toLowerCase() === name.toLowerCase()) {
                    foundWeight = info.weight
                    foundLabel = info.label
                    break
                }
            }
        }

        // Build label
        const displayLabel = isItalic
            ? (foundLabel === 'Regular' ? 'Italic' : `${foundLabel} Italic`)
            : foundLabel

        return {
            weight: foundWeight,
            style: isItalic ? 'italic' : 'normal',
            isVariable: false,
            label: displayLabel,
            subset
        }
    }

    /**
     * Extract subset name from filename
     * @private
     */
    _extractSubset(baseName, subsetPatterns) {
        for (const subset of subsetPatterns) {
            if (baseName.toLowerCase().includes(subset.toLowerCase())) {
                return subset
            }
        }
        return ''
    }

    /**
     * Get available styles for a font (grouped by weight/style, not subsets)
     * @param {string} fontId - Font ID
     * @returns {Array<{label: string, weight: string, style: string, isVariable: boolean, files: Array}>}
     */
    getStylesForFont(fontId) {
        const font = this.getFont(fontId)
        if (!font) return []

        // Group files by style label (combining all subsets)
        const styleMap = new Map()

        for (const file of font.files) {
            const parsed = this.parseStyleFromFilename(file.filename)
            const key = parsed.label

            if (!styleMap.has(key)) {
                styleMap.set(key, {
                    label: parsed.label,
                    weight: parsed.weight,
                    style: parsed.style,
                    isVariable: parsed.isVariable,
                    files: []
                })
            }
            styleMap.get(key).files.push(file)
        }

        // Convert to array and sort
        const styles = Array.from(styleMap.values())

        // Sort: Variable first, then by weight, then normal before italic
        styles.sort((a, b) => {
            if (a.isVariable !== b.isVariable) return a.isVariable ? -1 : 1
            const weightA = a.weight === 'variable' ? 400 : parseInt(a.weight)
            const weightB = b.weight === 'variable' ? 400 : parseInt(b.weight)
            if (weightA !== weightB) return weightA - weightB
            if (a.style !== b.style) return a.style === 'normal' ? -1 : 1
            return 0
        })

        return styles
    }

    /**
     * Get available styles for a font by name
     * @param {string} fontName - Font name (e.g., 'Inter')
     * @returns {Array<{filename: string, weight: string, style: string, label: string, isVariable: boolean}>}
     */
    getStylesForFontByName(fontName) {
        const font = this.getAllFonts().find(f => f.name === fontName)
        if (!font) return []
        return this.getStylesForFont(font.id)
    }

    /**
     * Register a font with CSS @font-face for use
     * @param {string} fontId - Font ID
     * @param {string} fontFamily - CSS font-family name to use
     * @returns {Promise<boolean>} Success
     */
    async registerFont(fontId, fontFamily = null) {
        const font = this.getFont(fontId)
        if (!font) return false

        fontFamily = fontFamily || font.name

        // Already registered?
        if (this._registeredFonts.has(fontFamily)) {
            return true
        }

        // Find best font file: prefer woff2, non-italic, variable, then any
        const file = this._pickBestFile(font.files)

        if (!file) return false

        const path = `${font.dir_name}/${file.filename}`
        const blob = await this.getFile(path)
        if (!blob) return false

        const url = URL.createObjectURL(blob)

        const ext = file.filename.split('.').pop().toLowerCase()
        const formatMap = { woff2: 'woff2', woff: 'woff', otf: 'opentype' }
        const format = formatMap[ext] || 'truetype'

        const style = document.createElement('style')
        style.textContent = `
            @font-face {
                font-family: '${fontFamily}';
                src: url('${url}') format('${format}');
                font-weight: normal;
                font-style: normal;
                font-display: swap;
            }
        `
        document.head.appendChild(style)
        this._registeredFonts.add(fontFamily)

        return true
    }

    /**
     * Pick the best file from a font's file list.
     * Prefers woff2, non-italic, variable fonts, then falls back.
     * @param {Array<{filename: string}>} files
     * @returns {object|undefined}
     * @private
     */
    _pickBestFile(files) {
        const isNonItalic = f => !/italic/i.test(f.filename)
        const isWoff2 = f => /\.woff2$/i.test(f.filename)
        const isTtfOrOtf = f => /\.(ttf|otf)$/i.test(f.filename)
        const isVariable = f => /variable/i.test(f.filename)
        const isWoff = f => /\.woff$/i.test(f.filename)

        return files.find(f => isWoff2(f) && isNonItalic(f))
            || files.find(isWoff2)
            || files.find(f => isVariable(f) && isTtfOrOtf(f) && isNonItalic(f))
            || files.find(f => isTtfOrOtf(f) && isNonItalic(f))
            || files.find(f => isWoff(f) && isNonItalic(f))
            || files[0]
    }

    /**
     * Register a font by name (looks up by name instead of ID)
     * @param {string} fontName - Font name (e.g., 'Inter', 'JetBrains Mono')
     * @returns {Promise<boolean>} Success
     */
    async registerFontByName(fontName) {
        const font = this.getAllFonts().find(f => f.name === fontName)
        if (!font) return false
        return this.registerFont(font.id, font.name)
    }

    /**
     * Clear all cached fonts and data
     */
    async clearCache() {
        const db = await this.openDB()

        await new Promise((resolve, reject) => {
            const tx = db.transaction(['meta', 'fonts', 'files'], 'readwrite')
            tx.objectStore('meta').clear()
            tx.objectStore('fonts').clear()
            tx.objectStore('files').clear()
            tx.oncomplete = () => resolve()
            tx.onerror = () => reject(tx.error)
        })

        this.installedVersion = null
        this.catalog = null
        this.fontsLoaded = false
        this._registeredFonts.clear()
    }

    /**
     * Get version info
     * @returns {Object}
     */
    getVersionInfo() {
        return {
            installed: this.installedVersion,
            totalFonts: this.catalog?.fonts?.length || 0
        }
    }
}

// Singleton instance
let fontaineLoaderInstance = null

/**
 * Get the fontaine loader instance (singleton)
 * @returns {FontaineLoader}
 */
export function getFontaineLoader() {
    if (!fontaineLoaderInstance) {
        fontaineLoaderInstance = new FontaineLoader()
    }
    return fontaineLoaderInstance
}

export { FontaineLoader, FONTAINE_BUNDLE_SIZE_MB, BASE_FONTS, BASE_FONT_NAMES }
