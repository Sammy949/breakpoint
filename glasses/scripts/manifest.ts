#!/usr/bin/env bun
// Write build/app.json for packing: app.json plus the relay origin in the
// network allowlist. The relay URL comes from VITE_BREAKPOINT_RELAY (glasses/.env),
// so a deployment-specific URL never lands in the repo.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'

const relay = process.env.VITE_BREAKPOINT_RELAY
if (!relay) {
  console.error('Set VITE_BREAKPOINT_RELAY in glasses/.env (see .env.example).')
  process.exit(1)
}
const origin = new URL(relay).origin

const manifest = JSON.parse(readFileSync('app.json', 'utf8'))
const others = (manifest.permissions ?? []).filter((p: { name: string }) => p.name !== 'network')
manifest.permissions = [
  ...others,
  {
    name: 'network',
    desc: 'Connects to your Breakpoint relay to receive permission requests from Claude Code and send your answers back.',
    // The plugin talks to the relay over HTTPS (pairing) and a WebSocket. The
    // docs don't say whether wss needs its own entry, so list both.
    whitelist: [origin, origin.replace(/^http/, 'ws')],
  },
]
mkdirSync('build', { recursive: true })
writeFileSync('build/app.json', JSON.stringify(manifest, null, 2) + '\n')
console.log(`build/app.json: network allowlist = ${origin}`)
