#!/usr/bin/env bun
// A stand-in for the glasses, for testing without the simulator.
// Claims a pairing code, waits for the next card, prints it, then answers it.
//
// Usage: bun scripts/fake-glasses.ts <relay-url> <pair-code> <allow|deny> [redirect]
// Note: pairing replaces whichever glasses client was paired before.

import type { FromGlasses, ToGlasses } from '../shared/protocol'

const [relayArg, code, behavior, ...rest] = process.argv.slice(2)
if (!relayArg || !code || (behavior !== 'allow' && behavior !== 'deny')) {
  console.error('Usage: bun scripts/fake-glasses.ts <relay-url> <pair-code> <allow|deny> [redirect]')
  process.exit(1)
}
const relay = relayArg.replace(/\/$/, '')
const redirect = rest.join(' ') || undefined

const res = await fetch(`${relay}/v1/pair/claim`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ code: code.replace(/\D/g, '') }),
})
if (!res.ok) {
  console.error(`Pairing failed: ${res.status}`)
  process.exit(1)
}
const { room, glassesToken } = (await res.json()) as { room: string; glassesToken: string }
const ws = new WebSocket(`${relay.replace(/^http/, 'ws')}/v1/glasses?room=${room}&token=${encodeURIComponent(glassesToken)}`)

ws.onmessage = ev => {
  const msg = JSON.parse(String(ev.data)) as ToGlasses
  const card = msg.type === 'add' ? msg.request : msg.type === 'snapshot' ? msg.requests[0] : undefined
  if (!card) return
  console.log(JSON.stringify(card, null, 2))
  const verdict: FromGlasses = { type: 'verdict', id: card.id, behavior, ...(redirect ? { redirect } : {}) }
  ws.send(JSON.stringify(verdict))
  console.log(`sent ${behavior}${redirect ? `: ${redirect}` : ''}`)
  setTimeout(() => process.exit(0), 500)
}
console.log('paired, waiting for a card…')
