// A minimal software agent in a Seance session, written from the relay frame
// shapes in public/js/agent/relay.js. It joins the session as a participant,
// sends agent requests to the person's tab, and moves images as bytes over
// the session's image endpoints, the way an agent tool does.
import { randomUUID } from 'node:crypto'

export const RELAY = 'nf-agent/1'

const SEND_INTERVAL_MS = 260

export async function joinAgentSession({ server, code, origin }) {
    const socket = new WebSocket(
        `${server.replace(/^http/, 'ws')}/v1/sessions/${encodeURIComponent(code)}/ws`,
        { headers: { Origin: origin } })
    const frames = []
    const listeners = new Set()
    const partial = new Map()
    let welcome = null
    let owner = null
    let lastSend = 0
    let sendChain = Promise.resolve()

    // Bodies too large for one frame arrive as JSON text slices.
    function assemble(frame) {
        if (frame.body !== undefined) return { done: true, body: frame.body }
        const key = `${frame.kind}:${frame.id}:${frame.connection_id}`
        const entry = partial.get(key) || { slices: new Array(frame.parts), count: 0 }
        if (entry.slices[frame.part] === undefined) entry.count += 1
        entry.slices[frame.part] = frame.chunk
        partial.set(key, entry)
        if (entry.count < frame.parts) return { done: false }
        partial.delete(key)
        return { done: true, body: JSON.parse(entry.slices.join('')) }
    }

    await new Promise((resolve, reject) => {
        socket.addEventListener('open', () => {
            socket.send(JSON.stringify({ type: 'hello', protocol: 1, dialects: ['layers'] }))
        })
        socket.addEventListener('message', (event) => {
            if (typeof event.data !== 'string') return
            const frame = JSON.parse(event.data)
            frames.push(frame)
            if (frame.type === 'welcome') {
                welcome = frame
                owner = frame.owner?.user_id || null
            } else if (frame.type === 'owner-changed') {
                owner = frame.user_id
            } else if (frame.type === 'session-snapshot') {
                resolve()
            }
            for (const listener of listeners) listener(frame)
        })
        socket.addEventListener('close', (event) => reject(new Error(`the agent's connection closed (${event.code})`)))
    })

    function send(frame) {
        sendChain = sendChain.then(async () => {
            const wait = lastSend + SEND_INTERVAL_MS - Date.now()
            if (wait > 0) await new Promise(done => setTimeout(done, wait))
            lastSend = Date.now()
            socket.send(JSON.stringify(frame))
        })
        return sendChain
    }

    // Replies to one request, from the session owner only: the server stamps
    // every frame with its sender.
    function replies(id, { collectMs = 0, timeoutMs = 45000 } = {}) {
        return new Promise((resolve, reject) => {
            const found = []
            const finish = () => {
                listeners.delete(listener)
                clearTimeout(timer)
                resolve(found)
            }
            const listener = (frame) => {
                if (frame.type !== 'clicked-button' || frame.relay !== RELAY) return
                if (frame.kind !== 'response' || frame.id !== id || frame.user_id !== owner) return
                const assembled = assemble(frame)
                if (!assembled.done) return
                found.push({ tab: frame.from, app: frame.app, envelope: assembled.body })
                if (!collectMs) finish()
            }
            listeners.add(listener)
            const timer = setTimeout(() => {
                if (collectMs) finish()
                else {
                    listeners.delete(listener)
                    reject(new Error(`no answer to request ${id} within ${timeoutMs} ms`))
                }
            }, collectMs || timeoutMs)
        })
    }

    async function request(to, command, args = {}, options = {}) {
        const id = randomUUID()
        const answered = replies(id, options)
        await send({ type: 'clicked-button', relay: RELAY, kind: 'request', id, to, body: { command, args } })
        return answered
    }

    const imageHeaders = (extra = {}) => ({
        Origin: origin,
        ...(welcome?.anon_token ? { 'X-Seance-Anon': welcome.anon_token } : {}),
        ...extra,
    })
    const sessionId = () => welcome?.session || code

    return {
        frames,
        get owner() { return owner },
        get you() { return welcome?.you || null },
        /** Every tab that answers agents in the session. */
        async describe() {
            return request('*', 'describe', {}, { collectMs: 2500 })
        },
        /** Run one command in a tab; resolves with its envelope. */
        async call(tab, command, args = {}, options = {}) {
            const [reply] = await request(tab, command, args, options)
            return reply
        },
        async getImage(id) {
            const response = await fetch(`${server}/v1/sessions/${encodeURIComponent(sessionId())}/images/${id}`,
                { headers: imageHeaders() })
            if (!response.ok) throw new Error(`image ${id}: ${response.status}`)
            return {
                bytes: Buffer.from(await response.arrayBuffer()),
                mimeType: (response.headers.get('content-type') || '').split(';')[0],
            }
        },
        async putImage(bytes, mimeType) {
            const response = await fetch(`${server}/v1/sessions/${encodeURIComponent(sessionId())}/images`, {
                method: 'POST', headers: imageHeaders({ 'Content-Type': mimeType }), body: bytes,
            })
            if (!response.ok) throw new Error(`image upload: ${response.status} ${await response.text()}`)
            return response.json()
        },
        close() {
            socket.close()
        },
    }
}
