import { writeTransaction } from './idb.js'

let databasePromise
function database() {
    if (!databasePromise) {
        databasePromise = new Promise((resolve, reject) => {
            const request = indexedDB.open('layers-recovery', 1)
            request.onupgradeneeded = () => request.result.createObjectStore('documents', { keyPath: 'id' })
            request.onerror = () => { databasePromise = null; reject(request.error) }
            request.onsuccess = () => {
                const db = request.result
                db.onversionchange = () => { db.close(); databasePromise = null }
                resolve(db)
            }
        })
    }
    return databasePromise
}

export async function listRecoveries({ ownedId } = {}) {
    if (ownedId === undefined) {
        try { ownedId = sessionStorage.getItem('layers-recovery-id') } catch {}
    }
    const db = await database()
    const records = await new Promise((resolve, reject) => {
        const request = db.transaction('documents').objectStore('documents').getAll()
        request.onsuccess = () => resolve(request.result.sort((a, b) => b.modifiedAt - a.modifiedAt))
        request.onerror = () => reject(request.error)
    })
    if (!navigator.locks?.query) return records
    const { held } = await navigator.locks.query()
    const live = new Set(held.map(lock => lock.name))
    return records.filter(record => record.id === ownedId || !live.has(`layers-recovery-${record.id}`))
}

async function removeRecovery(id) {
    return writeTransaction(await database(), 'documents', tx => {
        tx.objectStore('documents').delete(id)
    })
}

async function readRecovery(id) {
    const db = await database()
    return new Promise((resolve, reject) => {
        const request = db.transaction('documents').objectStore('documents').get(id)
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
    })
}

function rememberClaim(id) {
    try { sessionStorage.setItem('layers-recovery-id', id) } catch {}
}

// Each claim owns a release handle. Waiting for release includes the Web Lock
// request's settlement, so another tab's query can immediately see the orphan.
function requestClaim(id) {
    if (!navigator.locks) return Promise.resolve({ id, release: async () => {} })
    return new Promise((resolve, reject) => {
        let unlock
        const held = new Promise(release => { unlock = release })
        const request = navigator.locks.request(`layers-recovery-${id}`, { ifAvailable: true }, lock => {
            if (!lock) { resolve(null); return }
            resolve({ id, release: () => { unlock(); return request } })
            return held
        })
        request.catch(reject)
    })
}

// Session storage survives reload. Duplicated tabs may inherit the ID but
// must acquire a different slot if its original tab still holds the claim.
async function claimTabId({ fresh = false } = {}) {
    let id
    try { if (!fresh) id = sessionStorage.getItem('layers-recovery-id') } catch {}
    if (!navigator.locks) id = null
    let claim
    do {
        id ||= crypto.randomUUID()
        claim = await requestClaim(id)
        if (!claim) id = null
    } while (!claim)
    rememberClaim(id)
    return claim
}

/** A serialized, per-tab recovery journal, independent of explicit project saves. */
export class ProjectRecovery {
    constructor({ capture, isDirty, onError }) {
        this.capture = capture
        this.isDirty = isDirty
        this.onError = onError
        this._generation = 0
        this._timer = null
        this._tail = Promise.resolve()
        this._setClaim(claimTabId())
        this._warned = false
        window.addEventListener('beforeunload', event => {
            if (!this.isDirty()) return
            event.preventDefault()
            event.returnValue = ''
        })
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'hidden') this.flush()
        })
        window.addEventListener('pagehide', () => this.flush())
    }

    _setClaim(claim) {
        this._claim = claim
        this._id = claim.then(value => value.id)
    }

    async list() {
        return listRecoveries({ ownedId: (await this._claim).id })
    }

    schedule() {
        // A fixed deadline, rather than a trailing debounce, also checkpoints
        // during continuous editing.
        if (this._timer !== null) return
        this._timer = setTimeout(() => { this._timer = null; this.flush() }, 500)
    }

    _report(error) {
        if (!this._warned) {
            this._warned = true
            this.onError(error)
        }
    }

    flush() {
        const generation = this._generation
        const operation = this._tail.then(async () => {
            if (generation !== this._generation || !this.isDirty()) return
            const snapshot = await this.capture()
            if (!snapshot) { this.schedule(); return }
            if (generation !== this._generation || !this.isDirty()) return
            const id = await this._id
            const db = await database()
            if (generation !== this._generation) return
            await writeTransaction(db, 'documents', tx => {
                tx.objectStore('documents').put({ ...snapshot, id, modifiedAt: Date.now() })
            })
            this._warned = false
        })
        this._tail = operation.catch(error => this._report(error))
        return this._tail
    }

    clear() {
        const claim = this._claim
        this._generation++
        clearTimeout(this._timer)
        this._timer = null
        const operation = this._tail.then(async () => removeRecovery((await claim).id))
        this._tail = operation.catch(error => this._report(error))
        return this._tail
    }

    replace() {
        this.clear()
        if (this.isDirty()) this.schedule()
    }

    retain() {
        // A deferred checkpoint belongs to the previous document. Keep its
        // ownership until in-flight writes settle, then make it discoverable.
        const previous = this._claim
        this._generation++
        clearTimeout(this._timer)
        this._timer = null
        this._setClaim(claimTabId({ fresh: true }))
        const release = this._tail.then(async () => (await previous).release())
        this._tail = release.catch(error => this._report(error))
        if (this.isDirty()) this.schedule()
        return this._tail
    }

    // The caller holds the app lifecycle lease through load and adoption, so
    // an explicit Save cannot clear the previous slot between these steps.
    async restore(id, load) {
        const previous = await this._claim
        const source = id === previous.id ? previous : await requestClaim(id)
        if (!source) {
            const error = new Error('This recovery copy is open in another tab.')
            error.code = 'RECOVERY_IN_USE'
            throw error
        }
        let adopted = false
        try {
            // Discovery is only a menu snapshot. Read again while owning the
            // source so a closing owner's final write is included in restore.
            const record = await readRecovery(id)
            if (!record) {
                const error = new Error('This recovery copy is no longer available.')
                error.code = 'RECOVERY_NOT_FOUND'
                throw error
            }
            if (!await load(record)) return false
            if (source !== previous) {
                this._generation++
                clearTimeout(this._timer)
                this._timer = null
                this._setClaim(Promise.resolve(source))
                rememberClaim(source.id)
                const release = this._tail.then(() => previous.release())
                this._tail = release.catch(error => this._report(error))
                await this._tail
            }
            adopted = true
            if (this.isDirty()) this.schedule()
            return true
        } finally {
            // Failed loading never deletes or adopts the source checkpoint.
            if (!adopted && source !== previous) await source.release()
        }
    }
}
