// Seed only the OS clipboard read boundary. PNG encoding, ClipboardItem,
// application import, selection transforms, and rendering remain real.
// Browser automation cannot grant clipboard permissions in every engine.
export async function seedClipboardRead(page, image = null) {
    await page.evaluate(async image => {
        const items = []
        if (image) {
            const canvas = document.createElement('canvas')
            canvas.width = image.width
            canvas.height = image.height
            const context = canvas.getContext('2d')
            context.fillStyle = image.color ?? 'black'
            context.fillRect(0, 0, canvas.width, canvas.height)
            const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'))
            items.push(new ClipboardItem({ 'image/png': blob }))
        }
        Object.defineProperty(navigator.clipboard, 'read', {
            configurable: true,
            value: async () => items,
        })
    }, image)
}
