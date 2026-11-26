#!/usr/bin/env bun
// Pair this laptop with the Breakpoint glasses app.
// Usage: bun scripts/pair.ts <relay-url>
// Creates this laptop's agent token on first run, saves the relay URL, and
// prints a 6-digit code to enter in the Breakpoint app on your phone.

import { randomBytes } from 'node:crypto'
import { CONFIG_PATH, loadConfig, saveConfig } from '../channel/config'

const existing = loadConfig()
const relay = (process.argv[2] ?? existing?.relay ?? '').replace(/\/$/, '')
if (!/^https?:\/\//.test(relay)) {
  console.error('Usage: bun scripts/pair.ts <relay-url>')
  process.exit(1)
}

const token = existing?.token ?? randomBytes(32).toString('base64url')
saveConfig({ relay, token })

const res = await fetch(`${relay}/v1/pair/start`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}` },
}).catch(e => {
  console.error(`Can't reach the relay at ${relay}: ${e.message}`)
  process.exit(1)
})
if (!res.ok) {
  console.error(`Relay refused pairing: ${res.status} ${await res.text()}`)
  process.exit(1)
}
const { code, expires_in_s } = (await res.json()) as { code: string; expires_in_s: number }

console.log(`Config saved to ${CONFIG_PATH}`)
console.log(`\nPairing code: ${code.slice(0, 3)} ${code.slice(3)}`)
console.log(`Enter it in the Breakpoint app within ${Math.round(expires_in_s / 60)} minutes, along with the relay URL:`)
console.log(`  ${relay}`)
