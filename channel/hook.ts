#!/usr/bin/env bun
// Permission hook. Usage: hook.ts [--agent claude-code]
//
// The agent runs this when it is about to ask for permission. The adapter
// (channel/adapters) reads the agent's payload and writes its reply; the rest
// is agent-agnostic. The hook sends the request to the relay, which shows it
// on the paired glasses, then polls for a verdict. The terminal dialog stays open the whole time; if nothing
// arrives, or anything goes wrong, the hook prints nothing and the terminal
// decides. It never approves on its own.

import { writeFileSync } from 'node:fs'
import { basename } from 'node:path'
import { randomBytes } from 'node:crypto'
import { loadConfig } from './config'
import { selectAdapter } from './adapters'
import type { PollResult, Verdict } from '../shared/protocol'
import { classify } from '../shared/risk'
import { summarisePlan } from '../shared/plan'

const WAIT_MS = Number(process.env.BREAKPOINT_WAIT_MS ?? 25 * 60_000)
const POLL_MS = 1000

/** The one line that tells you what the call does: the command, or the path. */
export function previewOf(tool: string, input: Record<string, unknown> = {}): string {
  if (typeof input.command === 'string') return input.command
  if (typeof input.file_path === 'string') return `${tool} ${input.file_path}`
  if (typeof input.url === 'string') return `${tool} ${input.url}`
  return `${tool} ${JSON.stringify(input)}`
}

function decide(verdict: Verdict): never {
  const out = adapter.formatVerdict(verdict, request)
  process.stdout.write(out)
  if (process.env.BREAKPOINT_DEBUG_DIR) writeFileSync(`${process.env.BREAKPOINT_DEBUG_DIR}/${Date.now()}-decision.json`, out)
  process.exit(0)
}

// No decision: the terminal dialog handles it.
const pass = (): never => process.exit(0)

const adapter = selectAdapter(process.argv.slice(2))
const config = loadConfig()
if (!config) pass()
const { relay, token } = config!
const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }

const raw = await Bun.stdin.text()
const request = adapter.parseInput(raw)
// Debugging aid: keep a copy of what the agent sent (never set by default).
if (process.env.BREAKPOINT_DEBUG_DIR) {
  await Bun.write(`${process.env.BREAKPOINT_DEBUG_DIR}/${Date.now()}-${request.toolName}.json`, raw)
}
const tool = request.toolName
const id = randomBytes(8).toString('hex').slice(0, 10)
const plan = request.plan !== undefined ? summarisePlan(request.plan) : null
const risk = classify({ tool, input: request.input, cwd: request.cwd })

const added = await fetch(`${relay}/v1/requests`, {
  method: 'POST',
  headers,
  body: JSON.stringify({
    id,
    session: basename(request.cwd ?? ''),
    tool,
    description: request.description,
    // Lets PostToolUse / PermissionDenied / Stop hooks clear this card if it's answered at the desk.
    session_id: request.sessionId,
    key: request.key,
    agent: request.agent,
    ...(plan
      ? { kind: 'plan', preview: plan.title, steps: plan.steps, more: plan.more, tier: 2, label: 'PLAN', reason: '' }
      : {
          preview: previewOf(tool, request.input),
          tier: risk.tier,
          label: risk.label,
          reason: risk.reason,
          token: risk.token,
        }),
  }),
}).catch(() => null)
if (!added?.ok) pass()

// Claude Code kills the hook when the dialog is answered at the desk with "No"
// (the turn is interrupted). Our own deadline passing is a timeout.
const cancel = (reason: 'elsewhere' | 'timeout') =>
  fetch(`${relay}/v1/requests/${id}?reason=${reason}`, { method: 'DELETE', headers }).catch(() => {})
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
  process.on(sig, async () => {
    await cancel('elsewhere')
    process.exit(0)
  })
}

const deadline = Date.now() + WAIT_MS
while (Date.now() < deadline) {
  await Bun.sleep(POLL_MS)
  const res = (await fetch(`${relay}/v1/requests/${id}`, { headers })
    .then(r => r.json())
    .catch(() => null)) as PollResult | null
  if (!res || res.status === 'pending') continue
  if (res.status === 'decided') decide({ behavior: res.behavior, redirect: res.redirect })
  pass() // elsewhere: answered at the desk. unknown: cancelled, or the relay lost it.
}
await cancel('timeout')
pass()
