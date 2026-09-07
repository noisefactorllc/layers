/** Run synchronous writes and resolve only after their transaction commits. */
export function writeTransaction(database, stores, write) {
    return new Promise((resolve, reject) => {
        const tx = database.transaction(stores, 'readwrite', { durability: 'strict' })
        let result
        tx.oncomplete = () => resolve(result)
        tx.onabort = () => reject(tx.error || new DOMException('Storage transaction aborted', 'AbortError'))
        try {
            result = write(tx)
        } catch (error) {
            tx.abort()
            reject(error)
        }
    })
}
