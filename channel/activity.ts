#!/usr/bin/env bun
// Claude Code hook for PostToolUse, PermissionDenied and Stop.
//
// Any of these firing means a permission dialog was answered somewhere else
// (usually at the desk), so the relay can clear the matching card from the
// glasses. Register it with "async": true so it never slows Claude down. It
// prints nothing and always exits 0.

import { loadConfig } from './config'
import { callKey } from './key'

type HookInput = {
  session_id?: string
  hook_event_name?: string
  tool_name?: string
  tool_input?: unknown
}

const config = loadConfig()
if (!config) process.exit(0)

const input = JSON.parse(await Bun.stdin.text()) as HookInput
if (!input.session_id) process.exit(0)

const event = input.hook_event_name === 'Stop' ? 'stop' : 'tool_done'
const body =
  event === 'stop'
    ? { session_id: input.session_id, event }
    : { session_id: input.session_id, event, key: callKey(input.tool_name ?? '', input.tool_input) }

await fetch(`${config.relay}/v1/activity`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
  signal: AbortSignal.timeout(5000),
}).catch(() => {})
process.exit(0)
