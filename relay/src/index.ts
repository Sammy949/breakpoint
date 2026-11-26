// Breakpoint relay: a Cloudflare Worker with two Durable Objects.
//
// Room     one per laptop. Named by sha256(agent token), so holding the token
//          is what grants laptop access. Pending requests live in memory only.
//          The only thing stored is a hash of the paired glasses token.
// Pairing  a single registry mapping short-lived 6-digit codes to rooms.
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

import { DurableObject } from 'cloudflare:workers'
import type { Activity, CardRequest, FromGlasses, NewRequest, PollResult, ToGlasses, Verdict } from '../../shared/protocol'
import { PAIR_CODE_TTL_MS } from '../../shared/protocol'

interface Env {
  ROOMS: DurableObjectNamespace<Room>
  PAIRING: DurableObjectNamespace<Pairing>
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

    // Everything below is the laptop, authenticated by its agent token.
    const token = req.headers.get('Authorization')?.replace(/^Bearer\s+/i, '') ?? ''
    if (token.length < 24) return json({ error: 'missing token' }, 401)
    const room = await sha256(token)
    const stub = env.ROOMS.get(env.ROOMS.idFromName(room))

    if (path === '/v1/pair/start' && req.method === 'POST') {
      const code = await env.PAIRING.get(env.PAIRING.idFromName('registry')).start(room)
      return json({ code, expires_in_s: PAIR_CODE_TTL_MS / 1000 })
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

export class Room extends DurableObject<Env> {
  private pending = new Map<string, CardRequest>()
  private decided = new Map<string, Verdict & { at: number }>()
  /** Which session and call each pending card belongs to. Never sent to the glasses. */
  private meta = new Map<string, { session_id: string; key: string }>()
  /** Cards answered at the desk, until their hook polls once more. */
  private elsewhere = new Map<string, number>()
  private glasses: WebSocket | null = null

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
      if (this.glasses === server) this.glasses = null
    })
    this.send({ type: 'snapshot', requests: [...this.pending.values()] })
    return new Response(null, { status: 101, webSocket: client })
  }

  private send(msg: ToGlasses) {
    try {
      this.glasses?.send(JSON.stringify(msg))
    } catch {
      this.glasses = null
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
    this.pending.delete(msg.id)
    this.meta.delete(msg.id)
    this.decided.set(msg.id, { behavior: msg.behavior, redirect, at: Date.now() })
    this.send({ type: 'remove', id: msg.id, reason: 'decided' })
  }

  async add(card: CardRequest, session_id = '', key = '') {
    const cutoff = Date.now() - 10 * 60_000
    for (const [id, d] of this.decided) if (d.at < cutoff) this.decided.delete(id)
    for (const [id, at] of this.elsewhere) if (at < cutoff) this.elsewhere.delete(id)
    this.pending.set(card.id, card)
    if (session_id) this.meta.set(card.id, { session_id, key })
    this.send({ type: 'add', request: card })
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
      cleared.push(id)
    }
    return { cleared: cleared.length }
  }

  async cancel(id: string, reason: 'cancelled' | 'elsewhere' = 'cancelled') {
    const had = this.pending.delete(id)
    this.meta.delete(id)
    this.decided.delete(id)
    if (had) this.send({ type: 'remove', id, reason })
    return { cancelled: had }
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
}
