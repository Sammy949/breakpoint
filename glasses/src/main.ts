import {
  waitForEvenAppBridge,
  TextContainerProperty,
  CreateStartUpPageContainer,
  TextContainerUpgrade,
  OsEventTypeList,
  AudioInputSource,
} from '@evenrealities/even_hub_sdk'
import { Attention, due, type Override } from '../../shared/attention'
import type { CardRequest, FromGlasses, ToGlasses } from '../../shared/protocol'
import {
  feedApprove,
  feedPicker,
  redirectsFor,
  startApprove,
  type ApproveState,
  type Gesture,
  type PickerState,
  type Sequence,
} from '../../shared/confirm'
import { renderBatch, renderCard, renderIdle, renderPicker, renderPlan, type Status } from './render'

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
/** Every waiting request, most urgent first. Not all of them are due yet. */
let cards: CardRequest[] = []
/** When each card reached the phone (local clock, so relay clock skew doesn't matter). */
const arrived = new Map<string, number>()
const attention = new Attention()
let flash: string | undefined
let flashTimer: ReturnType<typeof setTimeout> | undefined

// A card ignores gestures for its first moments on screen, so a tap meant for
// something else (or a stray input) can't answer a request nobody has read.
const ARM_MS = 800
// Without a choice, the redirect picker sends a plain deny after this long.
const PICKER_MS = 20_000

type View =
  | { mode: 'approve'; id: string; state: ApproveState; variant: number }
  | { mode: 'picker'; id: string; state: PickerState }
  /** Several local (T1) requests answered together with a long press. */
  | { mode: 'batch'; id: string; ids: string[] }
let view: View | null = null
/** The wearer swiped down on a batch and is going through it one by one. */
let reviewing = false
let shownAt = 0
let lastSequence: Sequence | undefined
let pickerTimer: ReturnType<typeof setTimeout> | undefined
let cardsShown = 0

/** Cards that may be on screen now, given whether the wearer is busy. */
function dueCards(now = Date.now()) {
  const busy = attention.busy(now) !== null
  return cards.filter(c => due(c, arrived.get(c.id) ?? now, now, busy))
}

/**
 * The card to show. A card already on screen stays there (it has already
 * interrupted, and shouldn't vanish because you started talking), except that
 * a destructive card may take over one you haven't started answering.
 */
function front(): CardRequest | undefined {
  const current = view ? cards.find(c => c.id === view!.id) : undefined
  if (current && view) {
    const engaged = view.mode === 'picker' || view.mode === 'batch' || view.state.progress > 0
    if (engaged || current.tier === 3) return current
    return dueCards().find(c => c.tier === 3) ?? current
  }
  return dueCards()[0]
}

/** Keep the view in step with the card on screen. */
const isLocal = (c: CardRequest) => c.tier === 1 && c.kind !== 'plan'

function syncView() {
  const card = front()
  if (!card) {
    view = null
    reviewing = false
    return
  }
  if (!isLocal(card)) reviewing = false

  // Two or more local requests due at once: one batch card.
  const batch = isLocal(card) && !reviewing ? dueCards().filter(isLocal) : []
  if (batch.length > 1) {
    const ids = batch.map(c => c.id)
    if (view?.mode === 'batch' && view.ids.join() === ids.join()) return
    // Re-arm whenever the list changes, so "approve all" only covers what was on screen.
    view = { mode: 'batch', id: ids[0], ids }
    shownAt = Date.now()
    console.log('breakpoint: batch', ids.length)
    return
  }
  if (view?.id === card.id && view.mode !== 'batch') return
  clearTimeout(pickerTimer)
  const state = startApprove(card.tier, lastSequence)
  if (state.sequence) lastSequence = state.sequence
  view = { mode: 'approve', id: card.id, state, variant: cardsShown++ }
  shownAt = Date.now()
  console.log('breakpoint: card', `T${card.tier}`, card.label, state.sequence?.text ?? 'tap')
}

let lastContent = ''

function draw() {
  syncView()
  const card = front()
  const showing = dueCards().length
  let content: string
  if (!card || !view) {
    const held = cards.length - showing
    content = renderIdle(status, flash, held > 0 ? { count: held, reason: attention.busy(Date.now()) } : undefined)
  } else if (view.mode === 'batch') {
    const ids = view.ids
    content = renderBatch(cards.filter(c => ids.includes(c.id)))
  } else if (view.mode === 'picker') content = renderPicker(card, view.state)
  else if (card.kind === 'plan') content = renderPlan(card, 0, showing)
  else content = renderCard(card, 0, showing, view.state, view.variant)
  if (content === lastContent) return // the display link is slow; skip no-op redraws
  lastContent = content
  bridge.textContainerUpgrade(new TextContainerUpgrade({ containerID: 1, containerName: 'main', content }))
}

// Cards become due as time passes or the wearer stops talking, so re-check every second.
setInterval(draw, 1000)

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
    // Destructive requests jump the queue: they interrupt now.
    const order = (list: CardRequest[]) => [...list].sort((a, b) => (b.tier === 3 ? 1 : 0) - (a.tier === 3 ? 1 : 0))
    const now = Date.now()
    if (msg.type === 'snapshot') {
      cards = order(msg.requests)
      for (const c of cards) if (!arrived.has(c.id)) arrived.set(c.id, now)
    }
    if (msg.type === 'add') {
      arrived.set(msg.request.id, now)
      const rest = cards.filter(c => c.id !== msg.request.id)
      // Never pull a card out from under the wearer mid-gesture: a new T3 goes
      // to the front only if the current card isn't being answered.
      const busy = view && (view.mode === 'picker' || (view.mode === 'approve' && view.state.progress > 0))
      cards = msg.request.tier === 3 && !busy && rest[0]?.tier !== 3 ? [msg.request, ...rest] : [...rest, msg.request]
    }
    if (msg.type === 'remove') {
      const wasShown = view?.id === msg.id
      cards = cards.filter(c => c.id !== msg.id)
      arrived.delete(msg.id)
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

function sendVerdict(card: CardRequest, behavior: 'allow' | 'deny', redirect?: string) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false
  const msg: FromGlasses = { type: 'verdict', id: card.id, behavior, ...(redirect ? { redirect } : {}) }
  ws.send(JSON.stringify(msg))
  console.log('breakpoint: verdict', behavior, redirect ?? '')
  cards = cards.filter(c => c.id !== card.id)
  arrived.delete(card.id)
  return true
}

function send(behavior: 'allow' | 'deny', redirect?: string) {
  const card = front()
  if (!card || !sendVerdict(card, behavior, redirect)) return
  clearTimeout(pickerTimer)
  const plan = card.kind === 'plan'
  showFlash(
    behavior === 'allow'
      ? plan ? 'Plan approved' : 'Allowed'
      : redirect ? (plan ? 'Feedback sent' : 'Denied, reply sent') : plan ? 'Plan rejected' : 'Denied',
  )
  draw()
}

function onGesture(g: Gesture) {
  const card = front()
  if (!card || !view) return
  if (Date.now() - shownAt < ARM_MS) {
    console.log('breakpoint: ignored input, card not armed yet')
    return
  }
  if (view.mode === 'batch') {
    if (g === 'hold') {
      const batch = cards.filter(c => view!.mode === 'batch' && view!.ids.includes(c.id))
      for (const c of batch) sendVerdict(c, 'allow')
      showFlash(`Approved ${batch.length} safe requests`)
      view = null
      draw()
    } else if (g === 'down') {
      reviewing = true
      view = null
      draw()
    }
    return
  }
  if (view.mode === 'picker') {
    const r = feedPicker(view.state, g)
    if (r.kind === 'send') send('deny', r.redirect)
    else if (r.kind === 'plain') send('deny')
    else if (r.kind === 'move') {
      view = { ...view, state: r.state }
      draw()
    }
    return
  }
  const r = feedApprove(view.state, g, Date.now())
  if (r.kind === 'approve') send('allow')
  else if (r.kind === 'deny') {
    view = { mode: 'picker', id: card.id, state: { options: redirectsFor(card, card.preview), index: 0 } }
    shownAt = Date.now()
    clearTimeout(pickerTimer)
    pickerTimer = setTimeout(() => send('deny'), PICKER_MS)
    draw()
  } else if (r.kind === 'progress' || r.kind === 'wrong') {
    if (r.kind === 'wrong') console.log('breakpoint: wrong gesture, new sequence', r.state.sequence?.text)
    if (r.state.sequence) lastSequence = r.state.sequence
    view = { ...view, state: r.state }
    draw()
  }
}

// --- Gestures --------------------------------------------------------------------
// CLICK_EVENT is 0 and protobuf drops zero fields, so a tap arrives with
// eventType undefined. Resolve the default only when the envelope exists.
function typeOf(envelope?: { eventType?: OsEventTypeList }): OsEventTypeList | null {
  if (!envelope) return null
  return envelope.eventType ?? OsEventTypeList.CLICK_EVENT
}

const GESTURES: Partial<Record<OsEventTypeList, Gesture>> = {
  [OsEventTypeList.CLICK_EVENT]: 'tap',
  [OsEventTypeList.DOUBLE_CLICK_EVENT]: 'double',
  [OsEventTypeList.SCROLL_TOP_EVENT]: 'up',
  [OsEventTypeList.SCROLL_BOTTOM_EVENT]: 'down',
  [OsEventTypeList.LONG_PRESS_EVENT]: 'hold',
}

bridge.onEvenHubEvent(event => {
  const now = Date.now()
  // Microphone frames: reduced to a loudness number here, never sent anywhere.
  if (event.audioEvent?.audioPcm) {
    attention.noteAudio(event.audioEvent.audioPcm as Uint8Array | number[] | string, now)
    return
  }
  const imu = event.sysEvent?.imuData
  if (event.sysEvent?.eventType === OsEventTypeList.IMU_DATA_REPORT && imu) {
    attention.noteImu(imu.x ?? 0, imu.y ?? 0, imu.z ?? 0, now)
    return
  }
  const type = typeOf(event.textEvent) ?? typeOf(event.sysEvent)
  const g = type === null ? undefined : GESTURES[type]
  if (g) onGesture(g)
  // No exit gesture: a stray double tap closing the app would hide every later prompt.
})

// --- Attention inputs ----------------------------------------------------------------
// The glasses mic needs the startup page to exist first (it does by now).
bridge
  .audioControl(true, AudioInputSource.Glasses)
  .then(ok => console.log('breakpoint: mic', ok ? 'on' : 'unavailable'))
  .catch(() => console.log('breakpoint: mic unavailable'))
bridge
  .imuControl(true)
  .then(ok => console.log('breakpoint: imu', ok ? 'on' : 'unavailable'))
  .catch(() => console.log('breakpoint: imu unavailable'))

// Debug toggle on the phone screen (and ?attention=busy|free) to force the
// scheduler for demos, since the simulator can't produce real movement.
function setOverride(mode: Override) {
  attention.override = mode
  const radio = document.querySelector<HTMLInputElement>(`input[name="attention"][value="${mode}"]`)
  if (radio) radio.checked = true
  console.log('breakpoint: attention override', mode)
  draw()
}
document.querySelectorAll<HTMLInputElement>('input[name="attention"]').forEach(r =>
  r.addEventListener('change', () => setOverride(r.value as Override)),
)
const forced = new URLSearchParams(location.search).get('attention')
if (forced === 'busy' || forced === 'free') setOverride(forced)

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

// The relay field defaults to the build's relay (VITE_BREAKPOINT_RELAY in glasses/.env).
const defaultRelay = import.meta.env.VITE_BREAKPOINT_RELAY as string | undefined
if (defaultRelay) (form.elements.namedItem('relay') as HTMLInputElement).value = defaultRelay

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
