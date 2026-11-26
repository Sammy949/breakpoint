#!/usr/bin/env bun
// Check the caps of a capped relay (wrangler env "judges").
// Usage: bun scripts/caps-smoke.ts <relay-url> [--idle-seconds N] [--daily N]
//
// Uses up this address's hourly pairing allowance on that relay. Pass
// --idle-seconds when the relay was started with a short ROOM_IDLE_HOURS, and
// --daily when DAILY_CAP is small enough to reach.

import { randomBytes } from 'node:crypto'

const args = process.argv.slice(2)
const relay = args.find(a => !a.startsWith('--'))?.replace(/\/$/, '')
const opt = (name: string) => {
  const i = args.indexOf(name)
  return i >= 0 ? Number(args[i + 1]) : undefined
}
if (!relay) {
  console.error('Usage: bun scripts/caps-smoke.ts <relay-url> [--idle-seconds N] [--daily N]')
  process.exit(1)
}

let failed = 0
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
  if (!ok) failed++
}

const token = () => randomBytes(24).toString('base64url')
const auth = (t: string) => ({ Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' })
const id = () => randomBytes(5).toString('hex')
const card = (cid: string, extra: object = {}) =>
  JSON.stringify({ id: cid, session: 'caps', tool: 'Bash', preview: 'npm test', tier: 1, label: 'LOCAL', ...extra })

async function pair(t: string) {
  const start = await fetch(`${relay}/v1/pair/start`, { method: 'POST', headers: auth(t) })
  if (!start.ok) return { status: start.status }
  const { code } = (await start.json()) as { code: string }
  const claim = await fetch(`${relay}/v1/pair/claim`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  })
  return { status: claim.status, ...((await claim.json()) as { room?: string; glassesToken?: string }) }
}

// 1. Request size.
const big = await fetch(`${relay}/v1/requests`, {
  method: 'POST',
  headers: auth(token()),
  body: card(id(), { description: 'x'.repeat(9000) }),
})
check('a request over 8 KB is refused', big.status === 413, `status ${big.status}`)

// 2. Pending requests per room.
const t1 = token()
const statuses: number[] = []
for (let i = 0; i < 21; i++) {
  statuses.push((await fetch(`${relay}/v1/requests`, { method: 'POST', headers: auth(t1), body: card(id()) })).status)
}
check('20 pending requests are accepted', statuses.slice(0, 20).every(s => s === 200), statuses.slice(0, 20).join(','))
check('the 21st pending request is refused', statuses[20] === 429, `status ${statuses[20]}`)
check('another room is unaffected', (await fetch(`${relay}/v1/requests`, { method: 'POST', headers: auth(token()), body: card(id()) })).status === 200)

// 3. Idle expiry (before the pairing cap uses up this address's allowance).
const idle = opt('--idle-seconds')
let pairingsUsed = 0
if (idle) {
  const t = token()
  const p = await pair(t)
  pairingsUsed++
  check('pairing works', p.status === 200 && !!p.glassesToken, `status ${p.status}`)
  const wsUrl = `${relay!.replace(/^http/, 'ws')}/v1/glasses?room=${p.room}&token=${encodeURIComponent(p.glassesToken!)}`
  const closed = await new Promise<number>(resolve => {
    const ws = new WebSocket(wsUrl)
    ws.onclose = ev => resolve(ev.code)
    setTimeout(() => resolve(-1), (idle + 30) * 1000)
  })
  check('an idle room closes the glasses with 4003', closed === 4003, `code ${closed}`)
  const again = await new Promise<string>(resolve => {
    const ws = new WebSocket(wsUrl)
    ws.onopen = () => resolve('opened')
    ws.onerror = () => resolve('refused')
    setTimeout(() => resolve('timeout'), 10_000)
  })
  check('the expired pairing no longer connects', again === 'refused', again)
}

// 4. Pairings per address per hour.
const results: number[] = []
for (let i = pairingsUsed; i < 6; i++) results.push((await fetch(`${relay}/v1/pair/start`, { method: 'POST', headers: auth(token()) })).status)
check('5 pairings per hour from one address', results.slice(0, -1).every(s => s === 200), results.join(','))
check('the 6th pairing in the hour is refused', results.at(-1) === 429, `status ${results.at(-1)}`)

// 5. Daily cap.
const daily = opt('--daily')
if (daily) {
  const t = token()
  let refused = 0
  for (let i = 0; i < daily + 5 && !refused; i++) {
    const cid = id()
    const r = await fetch(`${relay}/v1/requests`, { method: 'POST', headers: auth(t), body: card(cid) })
    if (r.status === 429) refused = i + 1
    else await fetch(`${relay}/v1/requests/${cid}`, { method: 'DELETE', headers: auth(t) })
  }
  check('the daily cap stops new requests', refused > 0, refused ? `refused at #${refused}` : 'never refused')
}

console.log(failed ? `\n${failed} failed` : '\nall passed')
process.exit(failed ? 1 : 0)
