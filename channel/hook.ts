#!/usr/bin/env bun
// Plan B: Claude Code PermissionRequest hook.
// Claude Code runs this when it is about to ask for permission. It parks the
// request and waits for a verdict. Returning no decision leaves the normal
// terminal dialog in charge.
//
// Kill-point version: file-based handoff in BREAKPOINT_DIR. The relay client
// replaces the polling loop later.

import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { join, basename } from 'node:path'
import { randomBytes } from 'node:crypto'

const DIR = process.env.BREAKPOINT_DIR ?? '/tmp/breakpoint'
const WAIT_MS = Number(process.env.BREAKPOINT_WAIT_MS ?? 300_000)

const input = JSON.parse(await Bun.stdin.text())
const id = randomBytes(3).toString('hex').slice(0, 5)
mkdirSync(join(DIR, 'pending'), { recursive: true })
mkdirSync(join(DIR, 'verdict'), { recursive: true })

const pendingPath = join(DIR, 'pending', `${id}.json`)
writeFileSync(
  pendingPath,
  JSON.stringify({
    id,
    session: basename(input.cwd ?? ''),
    tool_name: input.tool_name,
    tool_input: input.tool_input,
    permission_mode: input.permission_mode,
    received_at: Date.now(),
  }),
)

const verdictPath = join(DIR, 'verdict', id)
const deadline = Date.now() + WAIT_MS
// Verdict file: first line allow|deny, optional second line = redirect for Claude.
let behavior: string | null = null
let redirect = ''
while (Date.now() < deadline) {
  if (existsSync(verdictPath)) {
    const [b, ...rest] = readFileSync(verdictPath, 'utf8').split('\n')
    behavior = b.trim()
    redirect = rest.join(' ').trim()
    break
  }
  await Bun.sleep(250)
}
rmSync(pendingPath, { force: true })
rmSync(verdictPath, { force: true })

if (behavior === 'allow' || behavior === 'deny') {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision:
          behavior === 'allow'
            ? { behavior: 'allow' }
            : {
                behavior: 'deny',
                message: redirect
                  ? `The user denied this from Breakpoint and said: "${redirect}"`
                  : 'The user denied this from Breakpoint (Even G2).',
              },
      },
    }),
  )
}
// No verdict: print nothing, exit 0, terminal dialog decides.
