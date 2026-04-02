import { AboutDialog } from 'handfish'

const APP_VERSION = '0.9.0-SNAPSHOT'

const about = new AboutDialog({
    name: 'Layers',
    version: APP_VERSION,
    logo: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 600" fill="currentColor"><g transform="translate(0,600) scale(0.1,-0.1)"><path d="M840 5478 c-10 -18 -120 -204 -244 -413 l-225 -380 1314 -3 c723 -1 1907 -1 2630 0 l1315 3 -236 390 c-130 215 -241 400 -247 413 l-10 22 -2139 0 -2139 0 -19 -32z"/><path d="M659 4118 c-111 -189 -222 -376 -246 -415 l-43 -73 2630 0 2630 0 -249 413 -249 412 -2135 3 -2135 2 -203 -342z"/><path d="M858 3403 c-8 -10 -90 -146 -183 -303 -92 -157 -199 -337 -237 -400 l-68 -115 1315 -3 c723 -1 1907 -1 2630 0 l1314 3 -251 418 -251 417 -2127 0 c-2013 0 -2128 -1 -2142 -17z"/><path d="M619 1959 c-134 -226 -245 -414 -247 -418 -1 -3 1179 -6 2623 -6 1743 0 2625 3 2625 10 0 6 -110 192 -244 415 l-244 405 -2135 3 -2134 2 -244 -411z"/><path d="M714 1073 c-81 -137 -191 -322 -245 -413 l-99 -165 1315 -3 c723 -1 1906 -1 2629 0 l1315 3 -248 410 -247 410 -2137 3 -2136 2 -147 -247z"/></g></svg>`,
    titleFont: "'Cormorant Upright', 'Cormorant Upright Block'",
    repo: 'noisefactorllc/layers',
    ecosystem: 'Layers is a free tool by <a href="https://noisefactor.io/" target="_blank" rel="noopener">Noise Factor</a>, powered by the <a href="https://noisemaker.app/" target="_blank" rel="noopener">Noisemaker</a> open source engine. <a href="https://noisedeck.app/" target="_blank" rel="noopener">Noisedeck</a> is our video synth. Free to use, with a $4/mo subscription for pro features.',
})

fetch('./deployment-meta.json', { cache: 'no-store' }).then(async (res) => {
    if (!res.ok) return
    const data = await res.json()
    const hash = data.git_hash?.trim().slice(0, 8) || 'LOCAL'
    let deployed = 'n/a'
    if (data.date) {
        const d = new Date(data.date * 1000)
        const pad = (n) => String(n).padStart(2, '0')
        deployed = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
    }
    about.setBuild({ hash, deployed })
}).catch(() => {})

fetch('https://shaders.noisedeck.app/0.9.0/noisemaker-shaders-core.esm.js', { cache: 'no-store' }).then(async (res) => {
    if (!res.ok) return
    const reader = res.body.getReader()
    const { value } = await reader.read()
    reader.cancel()
    const match = new TextDecoder().decode(value).slice(0, 500).match(/^\s*\*\s*Build:\s*(\S+)/m)
    if (match) about.setNoisemaker(match[1])
}).catch(() => {})

export { about as aboutDialog }
