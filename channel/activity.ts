#!/usr/bin/env bun
// Hook for the agent's later events. Usage: activity.ts [--agent claude-code]
//
// For Claude Code: PostToolUse, PermissionDenied and Stop. Any of these firing
// means a permission dialog was answered somewhere else (usually at the desk),
// so the relay can clear the matching card from the glasses. Register it with
// "async": true so it never slows the agent down. It prints nothing and always
// exits 0.

import { loadConfig } from './config'
import { selectAdapter } from './adapters'

const adapter = selectAdapter(process.argv.slice(2))
const config = loadConfig()
if (!config) process.exit(0)

const body = adapter.postEventClears(await Bun.stdin.text())
if (!body) process.exit(0)

await fetch(`${config.relay}/v1/activity`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
  signal: AbortSignal.timeout(5000),
}).catch(() => {})
process.exit(0)
