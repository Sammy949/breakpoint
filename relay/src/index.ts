// Breakpoint relay: a Cloudflare Worker with two Durable Objects.
//
// Room     one per laptop. Named by sha256(agent token), so holding the token
//          is what grants laptop access. Pending requests live in memory only.
//          Stored: a hash of the paired glasses token and, if linked, the
//          Telegram user, chat and receipt channel IDs.
// Pairing  a single registry mapping short-lived 6-digit codes to rooms, and
//          linked Telegram user IDs to rooms.
//
// Laptop (hook), bearer agent token:
//   POST   /v1/pair/start                -> { code }
//   POST   /v1/requests       CardRequest -> { glasses: boolean }
//   GET    /v1/requests/:id               -> PollResult
//   DELETE /v1/requests/:id               -> cancel (hook timed out or was killed)
//   POST   /v1/activity       Activity    -> clear cards answered at the desk
// Glasses:
//   POST   /v1/pair/claim     { code }    -> { room, glassesToken }
//   GET    /v1/glasses?room=&token=       -> WebSocket (ToGlasses / FromGlasses)
// Telegram (optional, only when TELEGRAM_BOT_TOKEN is set):
//   POST   /v1/telegram/link (laptop)     -> { link } to open in Telegram
//   POST   /v1/telegram      (Telegram's webhook, checked by its secret header)

import { DurableObject } from 'cloudflare:workers'
import type { Activity, CardRequest, FromGlasses, NewRequest, PollResult, ToGlasses, Verdict } from '../../shared/protocol'
import { PAIR_CODE_TTL_MS } from '../../shared/protocol'
import type { Source } from '../../shared/telegram'
import { esc } from '../../shared/telegram'
import { HELP, HELP_LINKED, approveWord, cardMessage, matchesWord, outcomeLine, parseCallback, receipt, redirectFor, webhookSecret } from '../../shared/telegram'

interface Env {
  ROOMS: DurableObjectNamespace<Room>
  PAIRING: DurableObjectNamespace<Pairing>
  /** Optional. Without it the relay runs as before, with no Telegram. */
  TELEGRAM_BOT_TOKEN?: string
}

/** Glasses closed this long: requests go to Telegram instead. */
const FALLBACK_MS = 20_000
/** A destructive request unanswered on the glasses this long also goes to Telegram. */
const ESCALATE_MS = 3 * 60_000
const LINK_TTL_MS = 10 * 60_000

type TgUser = { id: number }
type TgChat = { id: number; type: string }
type TgMessage = {
  message_id: number
  from?: TgUser
  chat: TgChat
  text?: string
  reply_to_message?: { message_id: number }
  forward_origin?: { type: string; chat?: { id: number; title?: string } }
}
type TgUpdate = {
  message?: TgMessage
  callback_query?: { id: string; from: TgUser; data?: string; message?: { message_id: number; chat: TgChat } }
}

async function tg(env: Env, method: string, body: unknown): Promise<any> {
  if (!env.TELEGRAM_BOT_TOKEN) return null
  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).catch(() => null)
  const out: any = res ? await res.json().catch(() => null) : null
  // Log the method and Telegram's error text only: never the token or message contents.
  if (!out?.ok) console.log(`telegram ${method} failed: ${out?.description ?? 'no response'}`)
  return out
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...CORS } })

async function sha256(text: string) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('')
}

function randomToken(bytes = 24) {
  const a = crypto.getRandomValues(new Uint8Array(bytes))
  return btoa(String.fromCharCode(...a)).replace(/[+/=]/g, c => ({ '+': '-', '/': '_', '=': '' })[c]!)
}

const ID_RE = /^[a-z0-9]{4,32}$/
const MAX = { session: 80, tool: 64, preview: 600, description: 300 }

function clean(s: unknown, max: number) {
  // Strip control characters (keep newline), cap length.
  return String(s ?? '').replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f‪-‮⁦-⁩]/g, '').slice(0, max)
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS })
    const url = new URL(req.url)
    const path = url.pathname

    if (path === '/' || path === '/v1/health') return json({ ok: true, service: 'breakpoint-relay' })

    if (path === '/v1/pair/claim' && req.method === 'POST') {
      const { code } = (await req.json().catch(() => ({}))) as { code?: string }
      if (!/^\d{6}$/.test(code ?? '')) return json({ error: 'bad code' }, 400)
      const room = await env.PAIRING.get(env.PAIRING.idFromName('registry')).claim(code!)
      if (!room) return json({ error: 'unknown or expired code' }, 404)
      const glassesToken = await env.ROOMS.get(env.ROOMS.idFromName(room)).mintGlassesToken()
      return json({ room, glassesToken })
    }

    if (path === '/v1/glasses') {
      const room = url.searchParams.get('room') ?? ''
      if (!/^[0-9a-f]{64}$/.test(room)) return json({ error: 'bad room' }, 400)
      return env.ROOMS.get(env.ROOMS.idFromName(room)).fetch(req)
    }

    if (path === '/v1/telegram' && req.method === 'POST') {
      if (!env.TELEGRAM_BOT_TOKEN) return json({ error: 'telegram not configured' }, 404)
      const secret = req.headers.get('X-Telegram-Bot-Api-Secret-Token') ?? ''
      if (secret !== (await webhookSecret(env.TELEGRAM_BOT_TOKEN))) return json({ error: 'forbidden' }, 403)
      const update = (await req.json().catch(() => null)) as TgUpdate | null
      if (update) await onTelegram(env, update)
      return json({ ok: true }) // always 200, or Telegram retries the update
    }

    // Everything below is the laptop, authenticated by its agent token.
    const token = req.headers.get('Authorization')?.replace(/^Bearer\s+/i, '') ?? ''
    if (token.length < 24) return json({ error: 'missing token' }, 401)
    const room = await sha256(token)
    const stub = env.ROOMS.get(env.ROOMS.idFromName(room))

    if (path === '/v1/pair/start' && req.method === 'POST') {
      const code = await env.PAIRING.get(env.PAIRING.idFromName('registry')).start(room)
      return json({ code, expires_in_s: PAIR_CODE_TTL_MS / 1000 })
    }

    if (path === '/v1/telegram/link' && req.method === 'POST') {
      if (!env.TELEGRAM_BOT_TOKEN) return json({ error: 'telegram not configured on this relay' }, 501)
      const me = await tg(env, 'getMe', {})
      if (!me?.ok) return json({ error: 'telegram bot unreachable' }, 502)
      const code = await env.PAIRING.get(env.PAIRING.idFromName('registry')).startTelegram(room)
      return json({ link: `https://t.me/${me.result.username}?start=${code}`, bot: me.result.username })
    }

    if (path === '/v1/requests' && req.method === 'POST') {
      const body = (await req.json().catch(() => null)) as Partial<NewRequest> | null
      if (!body || !ID_RE.test(body.id ?? '')) return json({ error: 'bad request' }, 400)
      const card: CardRequest = {
        id: body.id!,
        session: clean(body.session, MAX.session),
        tool: clean(body.tool, MAX.tool),
        preview: clean(body.preview, MAX.preview),
        description: clean(body.description, MAX.description),
        // Unknown or missing tiers are treated as T2, never as safe.
        tier: body.tier === 1 || body.tier === 3 ? body.tier : 2,
        label: clean(body.label, 24) || 'UNKNOWN',
        reason: clean(body.reason, MAX.description),
        ...(body.token ? { token: clean(body.token, 80) } : {}),
        ...(body.kind === 'plan'
          ? {
              kind: 'plan' as const,
              steps: (Array.isArray(body.steps) ? body.steps : []).slice(0, 3).map(s => clean(s, 80)),
              more: Math.max(0, Math.min(99, Number(body.more) || 0)),
            }
          : {}),
        created_at: Date.now(),
      }
      return json(await stub.add(card, clean(body.session_id, 80), clean(body.key, 64)))
    }

    if (path === '/v1/activity' && req.method === 'POST') {
      const body = (await req.json().catch(() => null)) as Partial<Activity> | null
      if (!body?.session_id || (body.event !== 'stop' && body.event !== 'tool_done')) {
        return json({ error: 'bad activity' }, 400)
      }
      return json(await stub.activity(clean(body.session_id, 80), body.event, clean(body.key, 64)))
    }

    const m = path.match(/^\/v1\/requests\/([a-z0-9]+)$/)
    if (m && ID_RE.test(m[1])) {
      if (req.method === 'GET') return json(await stub.poll(m[1]))
      if (req.method === 'DELETE') {
        const reason = url.searchParams.get('reason') === 'elsewhere' ? 'elsewhere' : 'cancelled'
        return json(await stub.cancel(m[1], reason))
      }
    }

    return json({ error: 'not found' }, 404)
  },
}

/** Route a Telegram update to the room its sender linked. Private chats only. */
async function onTelegram(env: Env, u: TgUpdate) {
  const registry = env.PAIRING.get(env.PAIRING.idFromName('registry'))
  const from = u.message?.from ?? u.callback_query?.from
  if (!from) return
  if (u.message && u.message.chat.type !== 'private') return

  const start = u.message?.text?.match(/^\/start(?:\s+([A-Za-z0-9_-]{8,64}))?\s*$/)
  if (start?.[1]) {
    const room = await registry.claimTelegram(start[1])
    if (!room) {
      await tg(env, 'sendMessage', { chat_id: u.message!.chat.id, text: 'That link has expired or was already used. Run the link command again.' })
      return
    }
    const previous = await registry.linkTelegram(from.id, room)
    if (previous && previous !== room) await env.ROOMS.get(env.ROOMS.idFromName(previous)).unlinkTelegram(from.id, false)
    await env.ROOMS.get(env.ROOMS.idFromName(room)).linkTelegram(from.id, u.message!.chat.id)
    return
  }

  const room = await registry.roomForTelegram(from.id)
  if (!room) {
    if (u.callback_query) await tg(env, 'answerCallbackQuery', { callback_query_id: u.callback_query.id, text: 'Not linked.' })
    else await tg(env, 'sendMessage', { chat_id: u.message!.chat.id, text: HELP, parse_mode: 'HTML' })
    return
  }
  const unlinked = await env.ROOMS.get(env.ROOMS.idFromName(room)).telegramUpdate(u)
  if (unlinked) await registry.unlinkTelegram(from.id)
}

export class Room extends DurableObject<Env> {
  private pending = new Map<string, CardRequest>()
  private decided = new Map<string, Verdict & { at: number }>()
  /** Which session and call each pending card belongs to. Never sent to the glasses. */
  private meta = new Map<string, { session_id: string; key: string }>()
  /** Cards answered at the desk, until their hook polls once more. */
  private elsewhere = new Map<string, number>()
  private glasses: WebSocket | null = null
  /** When the glasses last went away. Starts as "now": a fresh room has no glasses yet. */
  private glassesGoneAt = Date.now()
  /** Linked Telegram account. Stored, because it outlives any one request. */
  private telegram: { user: number; chat: number; audit?: number } | null = null
  /** Telegram messages sent for pending cards, so they can be settled later. */
  private tgMsgs = new Map<string, { chat: number; message_id: number; html: string; word: string }>()

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    ctx.blockConcurrencyWhile(async () => {
      this.telegram = (await ctx.storage.get<Room['telegram']>('telegram')) ?? null
    })
  }

  async mintGlassesToken() {
    const t = randomToken()
    // One glasses client per laptop: a new pairing replaces the old one.
    await this.ctx.storage.put('glassesTokenHash', await sha256(t))
    this.glasses?.close(4001, 'replaced by a new pairing')
    this.glasses = null
    return t
  }

  async fetch(req: Request) {
    if (req.headers.get('Upgrade') !== 'websocket') return json({ error: 'expected websocket' }, 426)
    const token = new URL(req.url).searchParams.get('token') ?? ''
    const stored = await this.ctx.storage.get<string>('glassesTokenHash')
    if (!stored || (await sha256(token)) !== stored) return json({ error: 'not paired' }, 403)

    const [client, server] = Object.values(new WebSocketPair())
    server.accept()
    this.glasses?.close(4002, 'another glasses client connected')
    this.glasses = server
    server.addEventListener('message', ev => this.onGlassesMessage(server, ev.data))
    server.addEventListener('close', () => {
      if (this.glasses !== server) return
      this.glasses = null
      this.glassesGoneAt = Date.now()
      this.scheduleTelegram()
    })
    this.send({ type: 'snapshot', requests: [...this.pending.values()] })
    return new Response(null, { status: 101, webSocket: client })
  }

  private send(msg: ToGlasses) {
    try {
      this.glasses?.send(JSON.stringify(msg))
    } catch {
      this.glasses = null
      this.glassesGoneAt = Date.now()
    }
  }

  private onGlassesMessage(ws: WebSocket, data: unknown) {
    if (ws !== this.glasses || typeof data !== 'string') return
    let msg: FromGlasses
    try {
      msg = JSON.parse(data)
    } catch {
      return
    }
    if (msg.type !== 'verdict' || !this.pending.has(msg.id)) return
    if (msg.behavior !== 'allow' && msg.behavior !== 'deny') return
    const redirect = msg.behavior === 'deny' && msg.redirect ? clean(msg.redirect, 200) : undefined
    this.settle(msg.id, msg.behavior, redirect, 'glasses')
  }

  /** The one place a verdict is recorded. First answer wins: later ones find nothing pending. */
  private settle(id: string, behavior: Verdict['behavior'], redirect: string | undefined, source: Source) {
    const card = this.pending.get(id)
    if (!card) return
    this.pending.delete(id)
    this.meta.delete(id)
    this.decided.set(id, { behavior, redirect, at: Date.now() })
    this.send({ type: 'remove', id, reason: 'decided' })
    const outcome = { behavior, redirect, source }
    this.closeTelegram(id, outcomeLine(outcome))
    if (card.tier === 3 && this.telegram) {
      void tg(this.env, 'sendMessage', {
        chat_id: this.telegram.audit ?? this.telegram.chat,
        text: receipt(card, outcome),
        parse_mode: 'HTML',
      })
    }
  }

  async add(card: CardRequest, session_id = '', key = '') {
    const cutoff = Date.now() - 10 * 60_000
    for (const [id, d] of this.decided) if (d.at < cutoff) this.decided.delete(id)
    for (const [id, at] of this.elsewhere) if (at < cutoff) this.elsewhere.delete(id)
    this.pending.set(card.id, card)
    if (session_id) this.meta.set(card.id, { session_id, key })
    this.send({ type: 'add', request: card })
    await this.checkTelegram()
    return { glasses: this.glasses !== null }
  }

  async poll(id: string): Promise<PollResult> {
    const d = this.decided.get(id)
    if (d) {
      this.decided.delete(id) // hand the verdict over once
      return { status: 'decided', behavior: d.behavior, ...(d.redirect ? { redirect: d.redirect } : {}) }
    }
    if (this.elsewhere.delete(id)) return { status: 'elsewhere' }
    return this.pending.has(id) ? { status: 'pending' } : { status: 'unknown' }
  }

  /**
   * A later hook event from the same session means a dialog was answered at the
   * desk. PostToolUse / PermissionDenied clear only the card for that exact call
   * (Claude may run other tools in parallel); Stop clears the whole session.
   */
  async activity(session_id: string, event: 'tool_done' | 'stop', key = '') {
    const cleared: string[] = []
    for (const [id, m] of this.meta) {
      if (m.session_id !== session_id) continue
      if (event === 'tool_done' && (!key || m.key !== key)) continue
      if (!this.pending.delete(id)) continue
      this.meta.delete(id)
      this.elsewhere.set(id, Date.now())
      this.send({ type: 'remove', id, reason: 'elsewhere' })
      this.closeTelegram(id, outcomeLine('desk'))
      cleared.push(id)
    }
    return { cleared: cleared.length }
  }

  async cancel(id: string, reason: 'cancelled' | 'elsewhere' = 'cancelled') {
    const had = this.pending.delete(id)
    this.meta.delete(id)
    this.decided.delete(id)
    if (had) this.send({ type: 'remove', id, reason })
    this.closeTelegram(id, outcomeLine(reason === 'elsewhere' ? 'desk' : 'withdrawn'))
    return { cancelled: had }
  }

  // --- Telegram ------------------------------------------------------------------

  async linkTelegram(user: number, chat: number) {
    this.telegram = { user, chat }
    await this.ctx.storage.put('telegram', this.telegram)
    await tg(this.env, 'sendMessage', {
      chat_id: chat,
      parse_mode: 'HTML',
      text: 'Linked. Requests come here when your glasses app is closed, and destructive ones come here too if nobody answers on the glasses within 3 minutes. Receipts for destructive decisions also land here.\n\nTo send receipts to a channel instead, add this bot to the channel as an admin and forward any post from it here. <code>/stop</code> unlinks.',
    })
    await this.checkTelegram()
  }

  async unlinkTelegram(user: number, notify = true) {
    if (this.telegram?.user !== user) return
    const chat = this.telegram.chat
    this.telegram = null
    await this.ctx.storage.delete('telegram')
    for (const id of [...this.tgMsgs.keys()]) this.closeTelegram(id, '<b>Unlinked.</b>')
    if (notify) await tg(this.env, 'sendMessage', { chat_id: chat, text: 'Unlinked. Nothing more will come here.' })
  }

  /** Handle an update from the linked user. Returns true if they unlinked. */
  async telegramUpdate(u: TgUpdate): Promise<boolean> {
    const t = this.telegram
    const from = u.message?.from?.id ?? u.callback_query?.from.id
    if (!t || from !== t.user) return false

    const q = u.callback_query
    if (q) {
      const press = parseCallback(q.data ?? '')
      const card = press && this.pending.get(press.id)
      let note = 'Already answered.'
      if (press && card) {
        if (press.behavior === 'allow' && card.tier === 3) note = 'Reply with the word to approve this one.'
        else {
          const redirect = press.redirectIndex === undefined ? undefined : redirectFor(card, press.redirectIndex)
          this.settle(card.id, press.behavior, redirect, 'telegram')
          note = press.behavior === 'allow' ? 'Allowed.' : 'Denied.'
        }
      }
      await tg(this.env, 'answerCallbackQuery', { callback_query_id: q.id, text: note })
      return false
    }

    const m = u.message!
    const text = m.text?.trim() ?? ''
    if (text === '/stop') {
      await this.unlinkTelegram(t.user)
      return true
    }
    if (text === '/audit off') {
      delete t.audit
      await this.ctx.storage.put('telegram', t)
      await tg(this.env, 'sendMessage', { chat_id: m.chat.id, text: 'Receipts will come to this chat.' })
      return false
    }
    const channel = m.forward_origin?.type === 'channel' ? m.forward_origin.chat : undefined
    if (channel) {
      const ok = await tg(this.env, 'sendMessage', { chat_id: channel.id, text: 'Breakpoint receipts for destructive decisions will be posted here.' })
      if (ok?.ok) {
        t.audit = channel.id
        await this.ctx.storage.put('telegram', t)
      }
      await tg(this.env, 'sendMessage', {
        chat_id: m.chat.id,
        text: ok?.ok
          ? `Receipts will go to ${channel.title ?? 'that channel'}.`
          : "I can't post there. Add this bot to the channel as an admin, then forward a post again.",
      })
      return false
    }
    // Destructive cards on Telegram, waiting for their word. A reply targets one;
    // a plain message approves only if exactly one waiting card has that word.
    const waiting = [...this.tgMsgs.entries()]
      .map(([id, v]) => ({ id, ...v, card: this.pending.get(id) }))
      .filter(w => w.card?.tier === 3 && w.message_id)
    const say = (html: string, reply_to?: number) =>
      tg(this.env, 'sendMessage', {
        chat_id: m.chat.id,
        text: html,
        parse_mode: 'HTML',
        ...(reply_to ? { reply_parameters: { message_id: reply_to } } : {}),
      })
    const ask = (w: (typeof waiting)[number]) =>
      `Not approved. To approve <code>${esc(w.card!.preview.slice(0, 60))}</code>, send: <code>${esc(w.word)}</code>`

    if (m.reply_to_message) {
      const target = m.reply_to_message.message_id
      const w = waiting.find(x => x.message_id === target)
      if (w) {
        if (matchesWord(text, w.word)) this.settle(w.id, 'allow', undefined, 'telegram')
        else await say(ask(w), w.message_id)
      } else if ([...this.tgMsgs.values()].some(v => v.message_id === target)) {
        await say('Use the buttons for this one.')
      } else {
        await say('That request is already settled.')
      }
      return false
    }
    const matches = waiting.filter(w => matchesWord(text, w.word))
    if (matches.length === 1) this.settle(matches[0].id, 'allow', undefined, 'telegram')
    else if (matches.length > 1) await say('More than one request is waiting for that word. Reply to the one you mean.')
    else if (waiting.length) for (const w of waiting) await say(ask(w), w.message_id)
    else await say(HELP_LINKED)
    return false
  }

  /** When a pending card should go to Telegram, or Infinity if it shouldn't (yet). */
  private telegramDue(card: CardRequest): number {
    if (!this.telegram || this.tgMsgs.has(card.id)) return Infinity
    const fallback = this.glasses === null ? this.glassesGoneAt + FALLBACK_MS : Infinity
    const escalate = card.tier === 3 ? card.created_at + ESCALATE_MS : Infinity
    return Math.min(fallback, escalate)
  }

  /** Send every card that's due, then wake up again for the next one. */
  private async checkTelegram() {
    const now = Date.now()
    for (const card of this.pending.values()) {
      if (this.telegramDue(card) <= now) await this.sendTelegram(card)
    }
    this.scheduleTelegram()
  }

  private scheduleTelegram() {
    let next = Infinity
    for (const card of this.pending.values()) next = Math.min(next, this.telegramDue(card))
    if (next < Infinity) void this.ctx.storage.setAlarm(Math.max(next, Date.now() + 250))
  }

  async alarm() {
    await this.checkTelegram()
  }

  private async sendTelegram(card: CardRequest) {
    const t = this.telegram
    if (!t) return
    const word = approveWord(card)
    const { html, keyboard } = cardMessage(card, word)
    // Reserve the slot first so a second check can't send the same card twice.
    this.tgMsgs.set(card.id, { chat: t.chat, message_id: 0, html, word })
    const res = await tg(this.env, 'sendMessage', {
      chat_id: t.chat,
      text: html,
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: keyboard },
    })
    if (!res?.ok) return // leave it reserved: one attempt per card, the glasses and terminal still work
    const entry = this.tgMsgs.get(card.id)
    if (entry) entry.message_id = res.result.message_id
    else void tg(this.env, 'editMessageText', { chat_id: t.chat, message_id: res.result.message_id, text: html, parse_mode: 'HTML' }) // settled meanwhile
  }

  /** Settle the Telegram copy of a card: say how it ended and drop the buttons. */
  private closeTelegram(id: string, line: string) {
    const m = this.tgMsgs.get(id)
    if (!m) return
    this.tgMsgs.delete(id)
    if (!m.message_id) return
    void tg(this.env, 'editMessageText', {
      chat_id: m.chat,
      message_id: m.message_id,
      text: `${m.html}\n\n${line}`,
      parse_mode: 'HTML',
    })
  }
}

export class Pairing extends DurableObject<Env> {
  // A 6-digit code is guessable without a limit. Cap failed claims globally.
  private failures: number[] = []

  async start(room: string) {
    const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000).padStart(6, '0')
    await this.ctx.storage.put(`code:${code}`, { room, expires: Date.now() + PAIR_CODE_TTL_MS })
    return code
  }

  async claim(code: string): Promise<string | null> {
    const now = Date.now()
    this.failures = this.failures.filter(t => now - t < 60_000)
    if (this.failures.length >= 20) return null
    const key = `code:${code}`
    const entry = await this.ctx.storage.get<{ room: string; expires: number }>(key)
    await this.ctx.storage.delete(key) // single use
    if (!entry || entry.expires < now) {
      this.failures.push(now)
      return null
    }
    return entry.room
  }

  // Telegram links use long random codes, so they don't need the failure cap.
  async startTelegram(room: string) {
    const code = randomToken(12)
    await this.ctx.storage.put(`tg:${code}`, { room, expires: Date.now() + LINK_TTL_MS })
    return code
  }

  async claimTelegram(code: string): Promise<string | null> {
    const key = `tg:${code}`
    const entry = await this.ctx.storage.get<{ room: string; expires: number }>(key)
    await this.ctx.storage.delete(key)
    return entry && entry.expires >= Date.now() ? entry.room : null
  }

  /** Link a Telegram user to a room. Returns the room they were linked to before, if any. */
  async linkTelegram(user: number, room: string) {
    const previous = await this.ctx.storage.get<string>(`tguser:${user}`)
    await this.ctx.storage.put(`tguser:${user}`, room)
    return previous ?? null
  }

  async roomForTelegram(user: number) {
    return (await this.ctx.storage.get<string>(`tguser:${user}`)) ?? null
  }

  async unlinkTelegram(user: number) {
    await this.ctx.storage.delete(`tguser:${user}`)
  }
}
