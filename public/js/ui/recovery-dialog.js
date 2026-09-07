/** Recovery is offered explicitly; opening the editor never discards a checkpoint. */
export function showRecoveryDialog(records, { restore, onClose }) {
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
    description.textContent = 'An unsaved copy is available. Restore it to continue editing.'
    body.append(description)
    for (const record of records) {
        const row = document.createElement('div')
        row.className = 'dialog-actions'
        const label = document.createElement('span')
        label.textContent = `${record.name || 'Untitled'} · ${new Date(record.modifiedAt).toLocaleString()}`
        const button = document.createElement('button')
        button.className = 'action-btn primary'
        button.textContent = 'Restore'
        button.addEventListener('click', async () => {
            const buttons = [...dialog.querySelectorAll('button')]
            buttons.forEach(item => { item.disabled = true })
            dialog.close()
            try {
                if (await restore(record)) dialog.remove()
            } finally {
                buttons.forEach(item => { item.disabled = false })
                if (dialog.isConnected) dialog.showModal()
            }
        })
        row.append(label, button)
        body.append(row)
    }
    const actions = document.createElement('div')
    actions.className = 'dialog-actions'
    const close = document.createElement('button')
    close.className = 'action-btn'
    close.textContent = 'Keep for later'
    const dismiss = () => { dialog.close(); dialog.remove(); onClose?.() }
    close.addEventListener('click', dismiss)
    dialog.addEventListener('cancel', event => { event.preventDefault(); dismiss() })
    actions.append(close)
    dialog.append(body, actions)
    document.body.append(dialog)
    dialog.showModal()
}
