/**
 * Project Storage
 * IndexedDB-based storage for project data and media blobs
 *
 * @module utils/project-storage
 */

import { writeTransaction } from './idb.js'

const DB_NAME = 'layers-projects'
const DB_VERSION = 1
const STORE_PROJECTS = 'projects'
const STORE_MEDIA = 'media'

let db = null

/**
 * Initialize the database
 * @returns {Promise<IDBDatabase>}
 */
async function initDB() {
    if (db) return db

    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION)

        request.onerror = () => reject(request.error)

        request.onsuccess = () => {
            db = request.result
            resolve(db)
        }

        request.onupgradeneeded = (event) => {
            const database = event.target.result

            if (!database.objectStoreNames.contains(STORE_PROJECTS)) {
                const projectStore = database.createObjectStore(STORE_PROJECTS, { keyPath: 'id' })
                projectStore.createIndex('name', 'name', { unique: false })
                projectStore.createIndex('modifiedAt', 'modifiedAt', { unique: false })
            }

            if (!database.objectStoreNames.contains(STORE_MEDIA)) {
                database.createObjectStore(STORE_MEDIA, { keyPath: 'id' })
            }
        }
    })
}

/**
 * Generate a unique ID
 * @returns {string}
 */
function generateId() {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`
}

/**
 * Generate a media ID from file content hash
 * @param {Blob} blob - Media blob
 * @returns {Promise<string>}
 */
async function generateMediaId(blob) {
    const buffer = await blob.arrayBuffer()
    const hashBuffer = await crypto.subtle.digest('SHA-256', buffer)
    const hashArray = Array.from(new Uint8Array(hashBuffer))
    const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('')
    return hashHex.substring(0, 16)
}

/** Delete unreferenced media under the same lock used to commit projects. */
async function cleanupUnusedMedia() {
    const database = await initDB()
    return writeTransaction(database, [STORE_PROJECTS, STORE_MEDIA], tx => {
        const projects = tx.objectStore(STORE_PROJECTS).getAll()
        projects.onsuccess = () => {
            const usedIds = new Set(projects.result.flatMap(project =>
                project.layers.map(layer => layer.mediaId).filter(Boolean)))
            const cursor = tx.objectStore(STORE_MEDIA).openCursor()
            cursor.onsuccess = () => {
                if (!cursor.result) return
                if (!usedIds.has(cursor.result.key)) cursor.result.delete()
                cursor.result.continue()
            }
        }
    })
}

/**
 * Project data structure
 * @typedef {object} Project
 * @property {string} id - Unique project ID
 * @property {string} name - Project name
 * @property {number} createdAt - Creation timestamp
 * @property {number} modifiedAt - Last modified timestamp
 * @property {number} canvasWidth - Canvas width
 * @property {number} canvasHeight - Canvas height
 * @property {Array} layers - Layer array (with mediaId instead of mediaFile)
 */

/**
 * Save a project
 * @param {object} projectData - Project data
 * @param {string} projectData.name - Project name
 * @param {number} projectData.canvasWidth - Canvas width
 * @param {number} projectData.canvasHeight - Canvas height
 * @param {Array} projectData.layers - Layer array
 * @param {Map} projectData.mediaTextures - Map of layerId -> {element, type, url}
 * @param {string} [existingId] - Existing project ID (for updates)
 * @returns {Promise<string>} Project ID
 */
export async function saveProject(projectData, existingId = null) {
    const database = await initDB()
    const projectId = existingId || generateId()
    const now = Date.now()

    const processedLayers = []
    const mediaRecords = new Map()
    for (const layer of projectData.layers) {
        // drawingCanvas holds a live HTMLCanvasElement (rasterized strokes) which
        // is not structured-cloneable — IndexedDB put() would throw DataCloneError.
        // Strokes are persisted instead and re-rasterized on load.
        const processedLayer = { ...layer, mediaFile: null, drawingCanvas: null }

        if (layer.sourceType === 'media' && layer.mediaFile) {
            const mediaId = await generateMediaId(layer.mediaFile)
            mediaRecords.set(mediaId, {
                id: mediaId,
                blob: layer.mediaFile,
                name: layer.mediaFile.name,
                type: layer.mediaFile.type,
                savedAt: now,
            })
            processedLayer.mediaId = mediaId
            processedLayer.mediaFileName = layer.mediaFile.name
            processedLayer.mediaFileType = layer.mediaFile.type
        } else if (layer.sourceType === 'media' && layer.mediaId) {
            processedLayer.mediaId = layer.mediaId
            processedLayer.mediaFileName = layer.mediaFileName
            processedLayer.mediaFileType = layer.mediaFileType
        }

        processedLayers.push(processedLayer)
    }

    const project = {
        id: projectId,
        name: projectData.name,
        createdAt: existingId ? (await getProject(existingId))?.createdAt || now : now,
        modifiedAt: now,
        canvasWidth: projectData.canvasWidth,
        canvasHeight: projectData.canvasHeight,
        layers: processedLayers
    }

    return writeTransaction(database, [STORE_PROJECTS, STORE_MEDIA], (tx) => {
        const media = tx.objectStore(STORE_MEDIA)
        for (const record of mediaRecords.values()) media.put(record)
        tx.objectStore(STORE_PROJECTS).put(project)
        return projectId
    })
}

/**
 * Load a project by ID
 * @param {string} projectId - Project ID
 * @returns {Promise<Project|null>}
 */
export async function getProject(projectId) {
    const database = await initDB()

    return new Promise((resolve, reject) => {
        const tx = database.transaction(STORE_PROJECTS, 'readonly')
        const store = tx.objectStore(STORE_PROJECTS)

        const request = store.get(projectId)
        request.onsuccess = () => resolve(request.result || null)
        request.onerror = () => reject(request.error)
    })
}

/**
 * Load a project with its media files restored
 * @param {string} projectId - Project ID
 * @returns {Promise<{project: Project, mediaFiles: Map<string, File>}|null>}
 */
export async function loadProject(projectId) {
    const database = await initDB()
    return new Promise((resolve, reject) => {
        // The project and all its blobs form one read snapshot. Another tab
        // may overwrite/delete them only after this transaction completes.
        const tx = database.transaction([STORE_PROJECTS, STORE_MEDIA], 'readonly')
        let result = null
        tx.oncomplete = () => resolve(result)
        tx.onabort = () => reject(tx.error || new DOMException('Project read aborted', 'AbortError'))
        const request = tx.objectStore(STORE_PROJECTS).get(projectId)
        request.onsuccess = () => {
            if (!request.result) return
            const project = request.result
            const mediaFiles = new Map()
            result = { project, mediaFiles }
            for (const layer of project.layers) {
                if (layer.sourceType !== 'media' || !layer.mediaId) continue
                const media = tx.objectStore(STORE_MEDIA).get(layer.mediaId)
                media.onsuccess = () => {
                    if (!media.result) return
                    const { blob, name, type } = media.result
                    mediaFiles.set(layer.id, new File([blob], name, { type }))
                }
            }
        }
    })
}

/**
 * List all projects
 * @returns {Promise<Array<{id: string, name: string, modifiedAt: number}>>}
 */
export async function listProjects() {
    const database = await initDB()

    return new Promise((resolve, reject) => {
        const tx = database.transaction(STORE_PROJECTS, 'readonly')
        const store = tx.objectStore(STORE_PROJECTS)
        const index = store.index('modifiedAt')

        const projects = []
        const request = index.openCursor(null, 'prev') // Most recent first

        request.onsuccess = (event) => {
            const cursor = event.target.result
            if (cursor) {
                const { id, name, modifiedAt, createdAt } = cursor.value
                projects.push({ id, name, modifiedAt, createdAt })
                cursor.continue()
            } else {
                resolve(projects)
            }
        }
        request.onerror = () => reject(request.error)
    })
}

/**
 * Delete a project
 * @param {string} projectId - Project ID
 * @returns {Promise<void>}
 */
export async function deleteProject(projectId) {
    const database = await initDB()

    await writeTransaction(database, STORE_PROJECTS, (tx) => {
        tx.objectStore(STORE_PROJECTS).delete(projectId)
    })

    try {
        await cleanupUnusedMedia()
    } catch (e) {
        console.warn('[ProjectStorage] Media cleanup failed:', e)
    }
}

/**
 * Check if a project name already exists
 * @param {string} name - Project name to check
 * @param {string} [excludeId] - Project ID to exclude from check
 * @returns {Promise<{exists: boolean, id: string|null}>}
 */
export async function checkProjectName(name, excludeId = null) {
    const projects = await listProjects()
    const found = projects.find(p => p.name === name && p.id !== excludeId)
    return {
        exists: !!found,
        id: found?.id || null
    }
}

initDB().catch(err => {
    console.error('[ProjectStorage] Failed to initialize database:', err)
})
