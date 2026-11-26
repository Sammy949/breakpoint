#!/usr/bin/env bun
// Claude Code PermissionRequest hook.
//
// Claude Code runs this when it is about to ask for permission. The hook sends
// the request to the relay, which shows it on the paired glasses, then polls
// for a verdict. The terminal dialog stays open the whole time; if nothing
// arrives, or anything goes wrong, the hook prints nothing and the terminal
// decides. It never approves on its own.

import { writeFileSync } from 'node:fs'
import { basename } from 'node:path'
import { randomBytes } from 'node:crypto'
import { loadConfig } from './config'
import { callKey } from './key'
import type { PollResult } from '../shared/protocol'
import { classify } from '../shared/risk'
import { summarisePlan } from '../shared/plan'

const WAIT_MS = Number(process.env.BREAKPOINT_WAIT_MS ?? 25 * 60_000)
const POLL_MS = 1000

type HookInput = {
  session_id?: string
  cwd?: string
  tool_name?: string
  tool_input?: Record<string, unknown>
}

/** The one line that tells you what the call does: the command, or the path. */
export function previewOf(tool: string, input: Record<string, unknown> = {}): string {
  if (typeof input.command === 'string') return input.command
  if (typeof input.file_path === 'string') return `${tool} ${input.file_path}`
  if (typeof input.url === 'string') return `${tool} ${input.url}`
  return `${tool} ${JSON.stringify(input)}`
}

function decide(behavior: 'allow' | 'deny', redirect?: string): never {
  const what = isPlan ? 'rejected the plan' : 'denied this'
  const out = JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PermissionRequest',
      decision:
        behavior === 'allow'
          ? // Plan approvals are ignored by Claude Code unless the input is echoed
            // back (verified on v2.1.332). Tool calls get a plain allow, because
            // updated input is re-checked against ask rules.
            isPlan
            ? { behavior: 'allow', updatedInput: input.tool_input }
            : { behavior: 'allow' }
          : {
              behavior: 'deny',
              message: redirect
                ? `The user ${what} from Breakpoint and said: "${redirect}"`
                : `The user ${what} from Breakpoint.`,
            },
    },
  })
  process.stdout.write(out)
  if (process.env.BREAKPOINT_DEBUG_DIR) writeFileSync(`${process.env.BREAKPOINT_DEBUG_DIR}/${Date.now()}-decision.json`, out)
  process.exit(0)
}

// No decision: the terminal dialog handles it.
const pass = (): never => process.exit(0)

const config = loadConfig()
if (!config) pass()
const { relay, token } = config!
const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }

const raw = await Bun.stdin.text()
const input = JSON.parse(raw) as HookInput
// Debugging aid: keep a copy of what Claude Code sent (never set by default).
if (process.env.BREAKPOINT_DEBUG_DIR) {
  await Bun.write(`${process.env.BREAKPOINT_DEBUG_DIR}/${Date.now()}-${input.tool_name}.json`, raw)
}
const tool = input.tool_name ?? 'unknown'
const id = randomBytes(8).toString('hex').slice(0, 10)
const description = typeof input.tool_input?.description === 'string' ? input.tool_input.description : ''
const isPlan = tool === 'ExitPlanMode'
const plan = isPlan ? summarisePlan(String(input.tool_input?.plan ?? '')) : null
const risk = classify({ tool, input: input.tool_input ?? {}, cwd: input.cwd })

const added = await fetch(`${relay}/v1/requests`, {
  method: 'POST',
  headers,
  body: JSON.stringify({
    id,
    session: basename(input.cwd ?? ''),
    tool,
    description,
    // Lets PostToolUse / PermissionDenied / Stop hooks clear this card if it's answered at the desk.
    session_id: input.session_id,
    key: callKey(tool, input.tool_input),
    ...(plan
      ? { kind: 'plan', preview: plan.title, steps: plan.steps, more: plan.more, tier: 2, label: 'PLAN', reason: '' }
      : {
          preview: previewOf(tool, input.tool_input),
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
  if (res.status === 'decided') decide(res.behavior, res.redirect)
  pass() // elsewhere: answered at the desk. unknown: cancelled, or the relay lost it.
}
await cancel('timeout')
pass()
