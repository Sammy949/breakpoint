#!/usr/bin/env bun
// Test tool: post a card to the relay as if Claude Code had asked, without
// running Claude. The card is classified with the same rules as the real hook.
// Nobody is waiting on the answer, so verdicts go nowhere.
//
// Usage: bun scripts/test-card.ts "<shell command>" [session-name]

import { randomBytes } from 'node:crypto'
import { loadConfig } from '../channel/config'
import { classify } from '../shared/risk'

const [command, session = 'test'] = process.argv.slice(2)
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
