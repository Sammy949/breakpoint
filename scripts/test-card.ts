#!/usr/bin/env bun
// Test tool: post a card to the relay as if Claude Code had asked, without
// running Claude. The card is classified with the same rules as the real hook.
// Without --wait nobody is waiting on the answer, so verdicts go nowhere, and
// the relay may drop the card once it's idle (a local relay does after ~10 s).
// --wait polls like the real hook until the card is answered, then prints how.
//
// Usage: bun scripts/test-card.ts "<shell command>" [session-name] [--wait]

import { randomBytes } from 'node:crypto'
import { loadConfig } from '../channel/config'
import { classify } from '../shared/risk'

const args = process.argv.slice(2)
const wait = args.includes('--wait')
const [command, session = 'test'] = args.filter(a => a !== '--wait')
const config = loadConfig()
if (!command || !config) {
  console.error(config ? 'Usage: bun scripts/test-card.ts "<shell command>" [session]' : 'Not paired: run scripts/pair.ts first.')
  process.exit(1)
}

const risk = classify({ tool: 'Bash', input: { command }, cwd: `/test/${session}` })
const id = randomBytes(5).toString('hex')
const res = await fetch(`${config.relay}/v1/requests`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    id,
    session,
    tool: 'Bash',
    preview: command,
    description: '',
    tier: risk.tier,
    label: risk.label,
    reason: risk.reason,
    token: risk.token,
  }),
})
console.log(`${res.status} T${risk.tier} ${risk.label} id=${id} glasses=${(await res.json()).glasses}`)

if (wait && res.ok) {
  const headers = { Authorization: `Bearer ${config.token}` }
  const deadline = Date.now() + 25 * 60_000
  while (Date.now() < deadline) {
    await Bun.sleep(1000)
    const r = (await fetch(`${config.relay}/v1/requests/${id}`, { headers }).then(r => r.json()).catch(() => null)) as
      | { status: string; behavior?: string; redirect?: string }
      | null
    if (!r || r.status === 'pending') continue
    const said = r.redirect ? ` ("${r.redirect}")` : ''
    console.log(`${id} ${command}: ${r.status === 'decided' ? r.behavior + said : r.status}`)
    process.exit(0)
  }
  await fetch(`${config.relay}/v1/requests/${id}`, { method: 'DELETE', headers }).catch(() => {})
  console.log(`${id}: nobody answered`)
}
