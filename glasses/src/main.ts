import {
  waitForEvenAppBridge,
  TextContainerProperty,
  CreateStartUpPageContainer,
  TextContainerUpgrade,
  OsEventTypeList,
} from '@evenrealities/even_hub_sdk'
import type { CardRequest, FromGlasses, ToGlasses } from '../../shared/protocol'
import { renderCard, renderIdle, type Status } from './render'

type Pairing = { relay: string; room: string; token: string }

const bridge = await waitForEvenAppBridge()

// --- Display -----------------------------------------------------------------
const main = new TextContainerProperty({
  xPosition: 0,
  yPosition: 0,
  width: 576,
  height: 288,
  borderWidth: 0,
  borderColor: 5,
  paddingLength: 6,
  containerID: 1,
  containerName: 'main',
  content: renderIdle('connecting'),
  isEventCapture: 1,
})
const created = await bridge.createStartUpPageContainer(
  new CreateStartUpPageContainer({ containerTotalNum: 1, textObject: [main] }),
)
console.log('breakpoint: page created', created === 0 ? 'ok' : `failed (${created})`)

let status: Status = 'connecting'
let cards: CardRequest[] = []
let flash: string | undefined
let flashTimer: ReturnType<typeof setTimeout> | undefined

// A card ignores gestures for its first moments on screen, so a tap meant for
// something else (or a stray input) can't answer a request nobody has read.
const ARM_MS = 800
let shownId: string | undefined
let shownAt = 0

function draw() {
  if (cards[0]?.id !== shownId) {
    shownId = cards[0]?.id
    shownAt = Date.now()
  }
  const content = cards.length ? renderCard(cards[0], 0, cards.length) : renderIdle(status, flash)
  bridge.textContainerUpgrade(new TextContainerUpgrade({ containerID: 1, containerName: 'main', content }))
}

function showFlash(text: string) {
  flash = text
  clearTimeout(flashTimer)
  flashTimer = setTimeout(() => {
    flash = undefined
    draw()
  }, 2000)
}

// --- Relay connection ----------------------------------------------------------
let ws: WebSocket | null = null
let retry = 0

function connect(p: Pairing) {
  status = 'connecting'
  draw()
  const url = `${p.relay.replace(/^http/, 'ws')}/v1/glasses?room=${p.room}&token=${encodeURIComponent(p.token)}`
  const sock = new WebSocket(url)
  ws = sock
  sock.onopen = () => {
    retry = 0
    status = 'connected'
    console.log('breakpoint: relay connected')
    draw()
  }
  sock.onmessage = ev => {
    const msg = JSON.parse(String(ev.data)) as ToGlasses
    if (msg.type === 'snapshot') cards = msg.requests
    if (msg.type === 'add') cards = [...cards.filter(c => c.id !== msg.request.id), msg.request]
    if (msg.type === 'remove') {
      const wasShown = cards[0]?.id === msg.id
      cards = cards.filter(c => c.id !== msg.id)
      if (wasShown && msg.reason === 'elsewhere') showFlash('Answered at the desk')
      if (wasShown && msg.reason === 'cancelled') showFlash('Timed out. Answer in the terminal.')
    }
    console.log('breakpoint: relay', msg.type, msg.type === 'remove' ? msg.reason : '', cards.length, 'waiting')
    draw()
  }
  sock.onclose = ev => {
    if (ws !== sock) return
    ws = null
    status = 'offline'
    draw()
    if (ev.code === 4001 || ev.code === 4002) return // replaced by another pairing or client
    const delay = Math.min(30_000, 1000 * 2 ** retry++)
    setTimeout(() => connect(p), delay)
  }
}

function answer(behavior: 'allow' | 'deny') {
  const card = cards[0]
  if (!card || !ws || ws.readyState !== WebSocket.OPEN) return
  if (Date.now() - shownAt < ARM_MS) {
    console.log('breakpoint: ignored input, card not armed yet')
    return
  }
  const msg: FromGlasses = { type: 'verdict', id: card.id, behavior }
  ws.send(JSON.stringify(msg))
  cards = cards.slice(1)
  showFlash(behavior === 'allow' ? 'Allowed' : 'Denied')
  draw()
}

// --- Gestures --------------------------------------------------------------------
// CLICK_EVENT is 0 and protobuf drops zero fields, so a tap arrives with
// eventType undefined. Resolve the default only when the envelope exists.
function typeOf(envelope?: { eventType?: OsEventTypeList }): OsEventTypeList | null {
  if (!envelope) return null
  return envelope.eventType ?? OsEventTypeList.CLICK_EVENT
}

bridge.onEvenHubEvent(event => {
  const type = typeOf(event.textEvent) ?? typeOf(event.sysEvent)
  if (type === OsEventTypeList.CLICK_EVENT) answer('allow')
  else if (type === OsEventTypeList.SCROLL_BOTTOM_EVENT) answer('deny')
  // Exit gesture deliberately unbound until the confirm-gesture set is settled:
  // a stray double tap closing the app would hide every later prompt.
})

// --- Pairing (phone screen) --------------------------------------------------------
const form = document.querySelector<HTMLFormElement>('#pair')!
const note = document.querySelector<HTMLParagraphElement>('#pair-status')!

async function loadPairing(): Promise<Pairing | null> {
  try {
    const raw = await bridge.getLocalStorage('pairing')
    return raw ? (JSON.parse(raw) as Pairing) : null
  } catch {
    return null
  }
}

async function claim(relay: string, code: string): Promise<Pairing> {
  const res = await fetch(`${relay}/v1/pair/claim`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  })
  if (!res.ok) throw new Error(res.status === 404 ? 'That code is wrong or has expired.' : `Relay said ${res.status}.`)
  const { room, glassesToken } = (await res.json()) as { room: string; glassesToken: string }
  const pairing: Pairing = { relay, room, token: glassesToken }
  await bridge.setLocalStorage('pairing', JSON.stringify(pairing))
  // A pairing code is single use: drop it from the URL so a reload uses the saved pairing.
  history.replaceState(null, '', location.pathname)
  return pairing
}

form.addEventListener('submit', async e => {
  e.preventDefault()
  const data = new FormData(form)
  const relay = String(data.get('relay') ?? '').trim().replace(/\/$/, '')
  const code = String(data.get('code') ?? '').replace(/\D/g, '')
  note.textContent = 'Pairing…'
  try {
    const pairing = await claim(relay, code)
    note.textContent = 'Paired. Requests will appear on your glasses.'
    ws?.close()
    connect(pairing)
  } catch (err) {
    note.textContent = err instanceof Error && err.message ? err.message : "Couldn't reach the relay."
    // Keep using the existing pairing if there is one.
    const saved = await loadPairing()
    if (saved && !ws) connect(saved)
  }
})

// ?relay=…&code=… prefills and submits the form (simulator and demo scripts).
const params = new URLSearchParams(location.search)
const saved = await loadPairing()
if (params.get('relay') && params.get('code')) {
  ;(form.elements.namedItem('relay') as HTMLInputElement).value = params.get('relay')!
  ;(form.elements.namedItem('code') as HTMLInputElement).value = params.get('code')!
  form.requestSubmit()
} else if (saved) {
  note.textContent = 'Paired. Enter a new code to pair again.'
  connect(saved)
} else {
  status = 'unpaired'
  draw()
}
