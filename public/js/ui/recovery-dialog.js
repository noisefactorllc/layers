/** Recovery is offered explicitly; opening the editor never discards a checkpoint. */
export function showRecoveryDialog(records, { restore, discard, onClose }) {
    const dialog = document.createElement('dialog')
    dialog.className = 'recovery-dialog confirm-dialog'
    dialog.setAttribute('aria-label', 'Recover unsaved work')
    dialog.style.maxHeight = '80vh'
    dialog.style.overflow = 'auto'
    const body = document.createElement('div')
    body.className = 'dialog-body'
    const heading = document.createElement('h2')
    heading.textContent = 'Recover unsaved work'
    body.append(heading)
    const description = document.createElement('p')
    description.textContent = 'An unsaved copy is available. Restore it to continue editing, or discard it.'
    body.append(description)
    const dismiss = () => { dialog.close(); dialog.remove(); onClose?.() }
    const rows = new Map()

    // Nested prompts are not in the top layer, so the modal steps aside while
    // one runs and returns unless the action consumed it.
    async function run(action) {
        const buttons = [...dialog.querySelectorAll('button')]
        buttons.forEach(item => { item.disabled = true })
        dialog.close()
        try {
            await action()
        } finally {
            buttons.forEach(item => { item.disabled = false })
            if (dialog.isConnected) dialog.showModal()
        }
    }

    async function discardRecords(targets) {
        const discarded = await discard(targets)
        for (const record of discarded) {
            rows.get(record.id)?.remove()
            rows.delete(record.id)
        }
        if (rows.size === 0) dismiss()
    }

    for (const record of records) {
        const row = document.createElement('div')
        row.className = 'dialog-actions'
        const label = document.createElement('span')
        label.textContent = `${record.name || 'Untitled'} · ${new Date(record.modifiedAt).toLocaleString()}`
        const discardButton = document.createElement('button')
        discardButton.className = 'action-btn'
        discardButton.textContent = 'Discard'
        discardButton.addEventListener('click', () => run(() => discardRecords([record])))
        const button = document.createElement('button')
        button.className = 'action-btn primary'
        button.textContent = 'Restore'
        button.addEventListener('click', () => run(async () => {
            if (await restore(record)) dialog.remove()
        }))
        row.append(label, discardButton, button)
        body.append(row)
        rows.set(record.id, row)
    }
    const actions = document.createElement('div')
    actions.className = 'dialog-actions'
    const discardAll = document.createElement('button')
    discardAll.className = 'action-btn danger'
    discardAll.textContent = 'Discard all'
    discardAll.addEventListener('click', () => run(() => discardRecords(records.filter(record => rows.has(record.id)))))
    const close = document.createElement('button')
    close.className = 'action-btn'
    close.textContent = 'Keep for later'
    close.addEventListener('click', dismiss)
    dialog.addEventListener('cancel', event => { event.preventDefault(); dismiss() })
    actions.append(discardAll, close)
    dialog.append(body, actions)
    document.body.append(dialog)
    dialog.showModal()
}
