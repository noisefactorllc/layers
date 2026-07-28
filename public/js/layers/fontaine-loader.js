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

/** Unicode partition names the bundle appends to filenames. */
const SUBSET_NAMES = [
    'Latin1', 'Latin2', 'Latin3', 'LatinExt', 'Latin-Ext',
    'Cyrillic', 'CyrillicExt', 'Greek', 'GreekExt',
    'Vietnamese', 'Hebrew', 'Arabic', 'Thai', 'Devanagari',
    'Pi', 'Symbols', 'Math'
]

/**
 * CSS unicode-range per subset, so the subset files of one face coexist in the
 * cascade instead of overwriting each other. Symbol partitions (Pi/Symbols/
 * Math) have no standard range and are registered unranged, first, where they
 * can only be shadowed rather than shadow.
 */
const SUBSET_UNICODE_RANGES = {
    latin1: 'U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+2000-206F, U+2074, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD',
    latin2: 'U+0100-024F, U+0259, U+1E00-1EFF, U+2020, U+20A0-20AB, U+20AD-20CF, U+2113, U+2C60-2C7F, U+A720-A7FF',
    latin3: 'U+0250-02AF, U+02B0-02FF, U+0300-036F, U+1DC0-1DFF, U+2070-209F',
    latinext: 'U+0100-024F, U+0259, U+1E00-1EFF, U+2020, U+20A0-20AB, U+20AD-20CF, U+2113, U+2C60-2C7F, U+A720-A7FF',
    cyrillic: 'U+0301, U+0400-045F, U+0490-0491, U+04B0-04B1, U+2116',
    cyrillicext: 'U+0460-052F, U+1C80-1C88, U+20B4, U+2DE0-2DFF, U+A640-A69F, U+FE2E-FE2F',
    greek: 'U+0370-03FF',
    greekext: 'U+1F00-1FFF',
    vietnamese: 'U+0102-0103, U+0110-0111, U+0128-0129, U+0168-0169, U+01A0-01A1, U+01AF-01B0, U+1EA0-1EF9, U+20AB',
    hebrew: 'U+0590-05FF, U+200C-2010, U+20AA, U+25CC, U+FB1D-FB4F',
    arabic: 'U+0600-06FF, U+0750-077F, U+08A0-08FF, U+FB50-FDFF, U+FE70-FEFF',
    thai: 'U+0E01-0E5B, U+200C-200D, U+25CC',
    devanagari: 'U+0900-097F, U+1CD0-1CF9, U+200C-200D, U+20A8, U+25CC, U+A830-A839, U+A8E0-A8FF'
}

/**
 * Descriptor tokens, longest-first so greedy matching prefers "ExtraLight"
 * over "Light" and "Italic" over "It". Abbreviations ("It", "Bd", "SmBd",
 * "XBlk", "Med") are the forms Adobe and Recursive actually ship; matching only
 * full words left every one of those files parsed as plain Regular.
 */
const STYLE_TOKENS = [
    // widths
    { token: 'SemiCondensed', kind: 'width', label: 'SemiCondensed' },
    { token: 'ExtraCondensed', kind: 'width', label: 'ExtraCondensed' },
    { token: 'SemiExpanded', kind: 'width', label: 'SemiExpanded' },
    { token: 'Condensed', kind: 'width', label: 'Condensed' },
    { token: 'Expanded', kind: 'width', label: 'Expanded' },
    { token: 'SemiWide', kind: 'width', label: 'SemiWide' },
    { token: 'Narrow', kind: 'width', label: 'Narrow' },
    { token: 'Wide', kind: 'width', label: 'Wide' },
    // weights
    { token: 'ExtraLight', kind: 'weight', weight: '200', label: 'ExtraLight' },
    { token: 'UltraLight', kind: 'weight', weight: '200', label: 'ExtraLight' },
    { token: 'ExtraBold', kind: 'weight', weight: '800', label: 'ExtraBold' },
    { token: 'UltraBold', kind: 'weight', weight: '800', label: 'ExtraBold' },
    { token: 'SemiLight', kind: 'weight', weight: '350', label: 'SemiLight' },
    { token: 'SemiBold', kind: 'weight', weight: '600', label: 'SemiBold' },
    { token: 'DemiBold', kind: 'weight', weight: '600', label: 'SemiBold' },
    { token: 'ExtraBd', kind: 'weight', weight: '800', label: 'ExtraBold' },
    { token: 'Regular', kind: 'weight', weight: '400', label: 'Regular' },
    { token: 'Normal', kind: 'weight', weight: '400', label: 'Regular' },
    { token: 'Medium', kind: 'weight', weight: '500', label: 'Medium' },
    { token: 'SemiBd', kind: 'weight', weight: '600', label: 'SemiBold' },
    // Recursive stacks XBlk above Black, so they are not the same weight.
    { token: 'XBlack', kind: 'weight', weight: '1000', label: 'ExtraBlack' },
    { token: 'XLight', kind: 'weight', weight: '200', label: 'ExtraLight' },
    { token: 'Light', kind: 'weight', weight: '300', label: 'Light' },
    { token: 'Black', kind: 'weight', weight: '900', label: 'Black' },
    { token: 'Heavy', kind: 'weight', weight: '900', label: 'Black' },
    { token: 'XBold', kind: 'weight', weight: '800', label: 'ExtraBold' },
    { token: 'ExBd', kind: 'weight', weight: '800', label: 'ExtraBold' },
    { token: 'SmBd', kind: 'weight', weight: '600', label: 'SemiBold' },
    { token: 'XBlk', kind: 'weight', weight: '1000', label: 'ExtraBlack' },
    { token: 'XBd', kind: 'weight', weight: '800', label: 'ExtraBold' },
    { token: 'Book', kind: 'weight', weight: '400', label: 'Regular' },
    { token: 'Bold', kind: 'weight', weight: '700', label: 'Bold' },
    { token: 'Text', kind: 'weight', weight: '450', label: 'Text' },
    { token: 'Thin', kind: 'weight', weight: '100', label: 'Thin' },
    { token: 'Med', kind: 'weight', weight: '500', label: 'Medium' },
    { token: 'Blk', kind: 'weight', weight: '900', label: 'Black' },
    { token: 'Bd', kind: 'weight', weight: '700', label: 'Bold' },
    { token: 'Lt', kind: 'weight', weight: '300', label: 'Light' },
    // slants
    { token: 'Oblique', kind: 'slant', label: 'Italic' },
    { token: 'Italic', kind: 'slant', label: 'Italic' },
    { token: 'Ital', kind: 'slant', label: 'Italic' },
    { token: 'It', kind: 'slant', label: 'Italic' },
    // variable-font markers, for families that ship a VF alongside statics
    { token: 'Variable', kind: 'variable', label: 'Variable' },
    { token: 'VF', kind: 'variable', label: 'Variable' }
].sort((a, b) => b.token.length - a.token.length)

/**
 * Consume known style tokens off the END of a descriptor, longest match first.
 *
 * Reading right-to-left is what makes "SemiWideMediumItalic" resolve to
 * SemiWide + Medium + Italic while leaving "CascadiaCodeNF" intact in
 * "CascadiaCodeNFItalic" — the leftover prefix is the typeface, not a style.
 *
 * @param {string} text - Descriptor (or stem tail) to parse
 * @returns {{tokens: Array<object>, residual: string}} Tokens in source order
 */
function takeTrailingStyleTokens(text) {
    let remaining = text
    const tokens = []

    for (;;) {
        const match = STYLE_TOKENS.find(entry =>
            remaining.length >= entry.token.length &&
            remaining.slice(-entry.token.length).toLowerCase() === entry.token.toLowerCase())
        if (!match) break
        tokens.unshift(match)
        remaining = remaining.slice(0, -match.token.length)
    }

    return { tokens, residual: remaining }
}

/**
 * Peel style tokens off the tail of a stem, but only when another file in the
 * same catalog entry proves the remainder is a real family name.
 *
 * "CascadiaCodeItalic" has a sibling "CascadiaCode-Regular", so Cascadia's
 * hyphen-less files can safely give up their trailing Italic. "ShadowsIntoLight"
 * has no such sibling — its name simply ends in Light — and must be left whole,
 * or a program saved as Regular comes back at weight 300.
 *
 * @param {string} stem - Stem to refine
 * @param {Set<string>|null} knownStems - Stems proven by hyphenated siblings
 * @returns {{stem: string, tokens: Array<object>}}
 */
function refineStem(stem, knownStems) {
    if (!knownStems || knownStems.size === 0) return { stem, tokens: [] }
    const taken = takeTrailingStyleTokens(stem)
    if (taken.tokens.length === 0 || !knownStems.has(taken.residual)) return { stem, tokens: [] }
    return { stem: taken.residual, tokens: taken.tokens }
}

/** Longest common prefix of a list of strings. */
function commonPrefix(values) {
    if (!values.length) return ''
    let prefix = values[0]
    for (const value of values.slice(1)) {
        let i = 0
        while (i < prefix.length && i < value.length && prefix[i] === value[i]) i++
        prefix = prefix.slice(0, i)
        if (!prefix) break
    }
    return prefix
}

/** Longest common suffix of a list of strings. */
function commonSuffix(values) {
    if (!values.length) return ''
    let suffix = values[0]
    for (const value of values.slice(1)) {
        let i = 0
        while (i < suffix.length && i < value.length &&
               suffix[suffix.length - 1 - i] === value[value.length - 1 - i]) i++
        suffix = suffix.slice(suffix.length - i)
        if (!suffix) break
    }
    return suffix
}

/**
 * Build a stem -> sub-family label resolver for one catalog entry.
 *
 * Strips the part every stem shares, so "MonaspaceArgonFrozen" reads as
 * "Argon" and a single-typeface family resolves to '' — leaving those style
 * labels exactly as they have always been.
 *
 * @param {string[]} stems - Every file stem in the catalog entry
 * @returns {(stem: string) => string} Resolver
 */
function buildSubFamilyResolver(stems) {
    const unique = [...new Set(stems)]
    if (unique.length <= 1) return () => ''

    const prefix = commonPrefix(unique)
    const withoutPrefix = unique.map(s => s.slice(prefix.length))

    // Trim the shared tail too ("ArgonFrozen"/"NeonFrozen" -> "Argon"/"Neon"),
    // but only at a word boundary: the raw common suffix here is "onFrozen",
    // which would leave "Arg" and "Ne".
    let suffix = withoutPrefix.every(Boolean) ? commonSuffix(withoutPrefix) : ''
    while (suffix && !/^[A-Z0-9]/.test(suffix)) suffix = suffix.slice(1)

    const labels = new Map()
    for (let i = 0; i < unique.length; i++) {
        const trimmed = suffix ? withoutPrefix[i].slice(0, withoutPrefix[i].length - suffix.length) : withoutPrefix[i]
        labels.set(unique[i], trimmed)
    }

    // A prefix that cut mid-word (lowercase leftover) would produce nonsense
    // labels; fall back to the untrimmed stems, which are still distinct.
    const usable = [...labels.values()].every(label => label === '' || /^[A-Z0-9]/.test(label))
    if (!usable) return (stem) => stem

    // Distinctness is the whole point — never merge two typefaces.
    if (new Set(labels.values()).size !== unique.length) return (stem) => stem

    return (stem) => labels.get(stem) ?? stem
}

/**
 * CSS family used for picker previews.
 *
 * A preview registers one representative face at `font-weight: normal;
 * font-style: normal` with no unicode-range. Under the font's own family name
 * that is byte-identical to the descriptor a 400/upright style registration
 * uses, so whichever `<style>` element is appended last wins — and the preview
 * pass (100 fonts, driven off IndexedDB) reliably lands after the style the
 * user actually picked. Giving previews their own family removes the collision
 * instead of racing it.
 *
 * @param {string} fontName - Catalog family name
 * @returns {string} Family name to register previews under
 */
export function previewFamilyFor(fontName) {
    return `Fontaine Preview ${fontName}`
}

/** CSS `format()` keyword for a font filename. */
function fontFaceFormat(filename) {
    switch (filename.split('.').pop().toLowerCase()) {
        case 'woff2': return 'woff2'
        case 'woff': return 'woff'
        case 'otf': return 'opentype'
        default: return 'truetype'
    }
}

/** Registration order within a style: unknown subsets, then ranged, then complete. */
function subsetRegistrationOrder(loader, filename, infoOf) {
    const info = infoOf?.get(filename) || loader.parseStyleFromFilename(filename)
    if (!info.subset) return 2
    return loader.unicodeRangeForSubset(info.subset) ? 1 : 0
}

/**
 * Keep one file per CSS slot within a style.
 *
 * Some families ship the same face more than once under names the catalog does
 * not distinguish — "CascadiaCode.woff2" beside "CascadiaCode-Regular.woff2",
 * or Recursive's variable font pre-split into GF ranges whose names have no
 * standard unicode-range. Those all declare an identical
 * family/weight/style/unicode-range, so registering every one leaves whichever
 * came last in charge. Pick deliberately instead, favouring the file most
 * likely to carry basic Latin.
 *
 * @param {FontaineLoader} loader
 * @param {Array<{filename: string}>} files - Files of one style
 * @param {Map<string, object>} [infoOf] - Pre-parsed info by filename
 * @returns {Array<{filename: string}>} One file per distinct slot
 */
function dedupeBySlot(loader, files, infoOf) {
    const bySlot = new Map()

    for (const file of files) {
        const info = infoOf?.get(file.filename) || loader.parseStyleFromFilename(file.filename)
        const slot = loader.unicodeRangeForSubset(info.subset) || `unranged:${info.subset}`
        const current = bySlot.get(slot)
        if (!current || slotPreference(file.filename) < slotPreference(current.filename)) {
            bySlot.set(slot, file)
        }
    }

    return [...bySlot.values()]
}

/** Lower sorts first: explicitly-named Latin/basic cuts beat catch-all names. */
function slotPreference(filename) {
    const lower = filename.toLowerCase()
    if (/latin[_-]?basic|basic[_-]?latin/.test(lower)) return 0
    if (/latin/.test(lower)) return 1
    // Anchored so a real "Text" weight (IBM Plex ships one) is not read as
    // an "ext" catch-all partition.
    if (/[-_](remaining|ext|symbols?)\b/.test(lower)) return 4
    // A name that spells out its weight is the deliberate static cut; a bare
    // family name is usually the variable/default drop-in beside it.
    if (/-/.test(filename)) return 2
    return 3
}

/** Preview preference: a complete file, else Latin, else anything legible. */
function subsetPreviewOrder(loader, subset) {
    if (!subset) return 0
    if (/^latin/i.test(subset)) return 1
    return loader.unicodeRangeForSubset(subset) ? 2 : 3
}

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

        /** @type {Map<string, {files: Array, parsed: Array}>} */
        this._parseCache = new Map()
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
            const success = await this.registerFont(font.id, previewFamilyFor(font.name))
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
     * Parse style/weight info from a font filename.
     *
     * The catalog is not one font per entry. "Monaspace" is five typefaces
     * (Argon/Krypton/Neon/Radon/Xenon) in three widths; "Inter" ships Inter and
     * InterDisplay; "Roboto" ships Roboto and RobotoCondensed; IBM Plex splits
     * every face across unicode subsets. So a filename carries four independent
     * facts and all of them matter:
     *
     *   stem   — the typeface, e.g. "MonaspaceArgonFrozen", "RobotoCondensed"
     *   width  — "SemiWide", "Condensed", … (may live in the descriptor)
     *   weight/style — the CSS weight and slant
     *   subset — the unicode partition, e.g. "Latin1", "Cyrillic"
     *
     * `face` combines stem and width: two files with the same face are the same
     * typeface and may share a CSS font-family/weight/style slot. Two files with
     * different faces must never share one, or the later @font-face silently
     * replaces the earlier and the rendered typeface changes.
     *
     * @param {string} filename - Font filename
     * @param {Set<string>} [knownStems] - Stems seen elsewhere in the same
     *   catalog entry. Only with this corroboration will style tokens be peeled
     *   off a stem, so "CascadiaCodeItalic" resolves to italic (its sibling
     *   "CascadiaCode-Regular" proves the stem) while "ShadowsIntoLight" — a
     *   font whose NAME ends in Light — is left alone.
     * @returns {{face: string, stem: string, width: string, weight: string,
     *            style: string, isVariable: boolean, weightLabel: string,
     *            label: string, subset: string, axes?: string}}
     */
    parseStyleFromFilename(filename, knownStems = null) {
        const baseName = filename.replace(/\.(woff2?|ttf|otf)$/i, '')

        // Peel the unicode subset off the end first so it never reads as style.
        let working = baseName
        let subset = ''

        // Google-Fonts-style split markers ("Recursive_VF--subset_range_latin_1")
        // name their partition inline rather than as a trailing hyphen part.
        const splitSubset = working.match(/--subset[-_](.+)$/i)
        if (splitSubset) {
            subset = splitSubset[1]
            working = working.slice(0, splitSubset.index)
        } else {
            const parts = working.split('-')
            for (let i = parts.length - 1; i >= 1; i--) {
                const match = SUBSET_NAMES.find(s => s.toLowerCase() === parts[i].toLowerCase())
                if (match) {
                    subset = match
                    parts.splice(i, 1)
                    break
                }
            }
            working = parts.join('-')
        }

        // Variable fonts use bracketed axis notation: "Inter[wght]". The axis
        // list is not the whole descriptor — "NotoSans-Italic[wdth,wght]" still
        // carries its slant in front of the brackets.
        const variableMatch = working.match(/\[([\w,]+)\]/)
        const axes = variableMatch ? variableMatch[1] : undefined
        if (variableMatch) working = working.replace(/\[[\w,]+\]/, '')

        // "Stem-Descriptor": the descriptor holds width/weight/slant tokens.
        // Files with no hyphen ("CascadiaCodeNFItalic") carry those tokens on
        // the tail of the stem instead, so parse whichever we have.
        const hyphen = working.indexOf('-')
        const rawStem = hyphen === -1 ? working : working.slice(0, hyphen)
        const descriptor = hyphen === -1 ? '' : working.slice(hyphen + 1).replace(/-/g, '')

        const fromDescriptor = descriptor ? takeTrailingStyleTokens(descriptor) : { tokens: [], residual: '' }
        // Anything we could not classify stays part of the face identity.
        // Discarding it would let two unrelated cuts collapse into the same
        // family/weight/style slot, which is the failure this whole parse
        // exists to prevent — better an odd label than a swapped typeface.
        const stemCandidate = fromDescriptor.residual ? `${rawStem}${fromDescriptor.residual}` : rawStem
        const fromStem = refineStem(stemCandidate, knownStems)
        const stem = fromStem.stem
        const tokens = [...fromStem.tokens, ...fromDescriptor.tokens]

        let width = ''
        let weight = '400'
        let weightLabel = 'Regular'
        let italic = false
        let isVariable = !!variableMatch
        let sawWeight = false
        for (const token of tokens) {
            if (token.kind === 'width') width = token.label
            else if (token.kind === 'weight') { weight = token.weight; weightLabel = token.label; sawWeight = true }
            else if (token.kind === 'slant') italic = true
            else if (token.kind === 'variable') isVariable = true
        }

        // A variable file spans the weight axis; only let an explicit weight
        // token pin it (e.g. "InterVariable-Italic" stays variable).
        if (isVariable && !sawWeight) {
            weight = 'variable'
            weightLabel = 'Variable'
        }

        const label = italic
            ? (weightLabel === 'Regular' ? 'Italic' : `${weightLabel} Italic`)
            : weightLabel

        return {
            face: width ? `${stem} ${width}` : stem,
            stem,
            width,
            weight,
            style: italic ? 'italic' : 'normal',
            isVariable,
            weightLabel,
            label,
            subset,
            ...(axes ? { axes } : {})
        }
    }

    /**
     * Parse every file of a catalog entry, with stem corroboration.
     *
     * Two passes: hyphenated filenames state their stem unambiguously, and that
     * set is what licenses peeling style tokens off the hyphen-less ones.
     * Cached per entry — the style list, the preview pick and every style
     * registration all walk the same files.
     *
     * @param {object} font - Catalog entry
     * @returns {Array<{file: object, info: object}>}
     * @private
     */
    _parseFontFiles(font) {
        const cached = this._parseCache.get(font.id)
        if (cached && cached.files === font.files) return cached.parsed

        const knownStems = new Set()
        for (const file of font.files) {
            const base = file.filename.replace(/\.(woff2?|ttf|otf)$/i, '').replace(/\[[\w,]+\]/, '')
            const hyphen = base.indexOf('-')
            if (hyphen > 0) knownStems.add(base.slice(0, hyphen))
        }

        const parsed = font.files.map(file => ({
            file,
            info: this.parseStyleFromFilename(file.filename, knownStems)
        }))
        this._parseCache.set(font.id, { files: font.files, parsed })
        return parsed
    }

    /**
     * CSS unicode-range for a known subset name, or null when unknown.
     *
     * Subset files of one face all claim the same family/weight/style, so
     * without a range only the last one declared survives — which is how
     * picking "Regular" could leave you rendering a Greek- or symbols-only
     * cut with no Latin glyphs at all.
     *
     * @param {string} subset - Subset name from the filename
     * @returns {string|null} CSS unicode-range value
     */
    unicodeRangeForSubset(subset) {
        if (!subset) return null
        const key = subset.toLowerCase().replace(/-/g, '')
        return SUBSET_UNICODE_RANGES[key] || null
    }

    /**
     * Get available styles for a font, one entry per real typeface.
     *
     * Every returned style maps to exactly one face; its `files` differ only by
     * unicode subset, ordered so they can be registered without clobbering each
     * other (see registerFontWithStyle).
     *
     * @param {string} fontId - Font ID
     * @returns {Array<{label: string, weight: string, style: string, isVariable: boolean, files: Array}>}
     */
    getStylesForFont(fontId) {
        const font = this.getFont(fontId)
        if (!font) return []

        const parsed = this._parseFontFiles(font)
        const infoOf = new Map(parsed.map(p => [p.file.filename, p.info]))
        const subFamilyOf = buildSubFamilyResolver(parsed.map(p => p.info.stem))

        const styleMap = new Map()
        for (const { file, info } of parsed) {
            const subFamily = subFamilyOf(info.stem)
            const key = `${subFamily}|${info.width}|${info.weight}|${info.style}|${info.isVariable}`

            if (!styleMap.has(key)) {
                styleMap.set(key, {
                    label: [subFamily, info.width, info.label].filter(Boolean).join(' '),
                    subFamily,
                    width: info.width,
                    weight: info.weight,
                    style: info.style,
                    isVariable: info.isVariable,
                    files: []
                })
            }
            styleMap.get(key).files.push(file)
        }

        for (const style of styleMap.values()) {
            style.files = dedupeBySlot(this, style.files, infoOf)
            style.files.sort((a, b) => (
                subsetRegistrationOrder(this, a.filename, infoOf) -
                subsetRegistrationOrder(this, b.filename, infoOf)
            ))
        }

        const styles = Array.from(styleMap.values())

        // Variable first, then sub-family, width, weight, upright before italic.
        styles.sort((a, b) => {
            if (a.isVariable !== b.isVariable) return a.isVariable ? -1 : 1
            if (a.subFamily !== b.subFamily) return a.subFamily.localeCompare(b.subFamily)
            if (a.width !== b.width) return a.width.localeCompare(b.width)
            const weightA = a.weight === 'variable' ? 400 : parseInt(a.weight)
            const weightB = b.weight === 'variable' ? 400 : parseInt(b.weight)
            if (weightA !== weightB) return weightA - weightB
            if (a.style !== b.style) return a.style === 'normal' ? -1 : 1
            return 0
        })

        return styles
    }

    /**
     * Choose the file that best represents a font in the picker.
     *
     * Picking "the first non-italic woff2" meant an arbitrary member of the
     * catalog entry: Monaspace previewed as Krypton Wide ExtraLight, and any
     * IBM Plex preview could land on a symbols-only subset with no letters.
     *
     * @param {object} font - Catalog entry
     * @returns {object|null} The chosen file record
     */
    pickPreviewFile(font) {
        if (!font?.files?.length) return null

        const parsed = this._parseFontFiles(font)
        const subFamilyOf = buildSubFamilyResolver(parsed.map(p => p.info.stem))

        const rank = ({ file, info }) => [
            subFamilyOf(info.stem) === '' ? 0 : 1,          // base sub-family
            info.width === '' ? 0 : 1,                       // default width
            info.style === 'normal' ? 0 : 1,                 // upright
            info.isVariable ? 1 : 0,                         // static over variable
            Math.abs((info.weight === 'variable' ? 400 : parseInt(info.weight)) - 400),
            subsetPreviewOrder(this, info.subset),           // complete > Latin > other
            /\.woff2$/i.test(file.filename) ? 0 : 1,
            subFamilyOf(info.stem),
            file.filename
        ]

        return parsed.slice().sort((a, b) => {
            const ra = rank(a)
            const rb = rank(b)
            for (let i = 0; i < ra.length; i++) {
                if (ra[i] < rb[i]) return -1
                if (ra[i] > rb[i]) return 1
            }
            return 0
        })[0].file
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
     * Register a font's representative face under its family name.
     *
     * Used for picker previews, so it registers exactly one file at
     * weight 400 / normal. registerFontWithStyle() adds the specific
     * weight/slant slots on top when a style is actually selected.
     *
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

        const file = this.pickPreviewFile(font)
        if (!file) return false

        const path = `${font.dir_name}/${file.filename}`
        const blob = await this.getFile(path)
        if (!blob) return false

        const url = URL.createObjectURL(blob)

        const style = document.createElement('style')
        style.textContent = `
            @font-face {
                font-family: '${fontFamily}';
                src: url('${url}') format('${fontFaceFormat(file.filename)}');
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
     * Resolve a stored style label to a style of this font.
     *
     * Programs persist the label they were saved with. Splitting a catalog
     * entry into per-typeface styles renamed those labels ("Regular" ->
     * "Argon Regular"), so a saved program would otherwise fall through to
     * whatever sorts first and come back in the wrong weight. Fall back to the
     * base sub-family at the same weight and slant, which is what the old label
     * was trying to mean.
     *
     * @param {string} fontId - Font ID
     * @param {string} styleLabel - Stored or current style label
     * @returns {object|null} The matching style, or null when the font is unknown
     */
    resolveStyle(fontId, styleLabel) {
        const styles = this.getStylesForFont(fontId)
        if (styles.length === 0) return null

        const exact = styles.find(s => s.label === styleLabel)
        if (exact) return exact
        if (!styleLabel) return styles[0]

        // Legacy labels are bare weight/slant, e.g. "Regular", "Bold Italic".
        const wantItalic = /italic/i.test(styleLabel)
        const wantWeightLabel = styleLabel.replace(/\s*italic\s*/i, '').trim() || 'Regular'
        const token = STYLE_TOKENS.find(t => t.kind === 'weight' &&
            t.label.toLowerCase() === wantWeightLabel.toLowerCase())
        const wantWeight = wantWeightLabel.toLowerCase() === 'variable'
            ? 400
            : parseInt(token?.weight ?? '400')

        // Match the slant first; a font that simply has no italic is better
        // served by its upright than by an unrelated weight.
        const slantMatched = styles.filter(s => (s.style === 'italic') === wantItalic)
        const pool = slantMatched.length ? slantMatched : styles

        // Prefer the base sub-family at the default width — the cut a bare
        // weight label would have meant before the entry was split up — and the
        // nearest weight available. Falling back to "first style" instead put
        // e.g. Roboto's missing SemiBold on Thin.
        const distance = (s) => (s.isVariable || s.weight === 'variable')
            ? 25                                   // spans the axis: close, but a real match wins
            : Math.abs(parseInt(s.weight) - wantWeight)

        const ranked = pool.slice().sort((a, b) => {
            const da = distance(a)
            const db = distance(b)
            if (da !== db) return da - db
            if ((a.subFamily === '') !== (b.subFamily === '')) return a.subFamily === '' ? -1 : 1
            if ((a.width === '') !== (b.width === '')) return a.width === '' ? -1 : 1
            return a.label.localeCompare(b.label)
        })
        return ranked[0]
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
