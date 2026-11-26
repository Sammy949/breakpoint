#!/usr/bin/env bun
// Add Breakpoint's hooks to a project's Claude Code settings.
// Usage: bun scripts/setup.ts <project-dir> [--ask]
//
// Writes <project>/.claude/settings.local.json (machine-specific, not shared
// with your team). Running it again replaces Breakpoint's entries rather than
// duplicating them. --ask also adds `ask` rules so risky commands always
// prompt, even in auto mode (useful for trying it out and for demos).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { CONFIG_PATH, loadConfig } from '../channel/config'

const args = process.argv.slice(2)
const project = args.find(a => !a.startsWith('--'))
if (!project || !existsSync(project)) {
  console.error('Usage: bun scripts/setup.ts <project-dir> [--ask]')
  process.exit(1)
}

const repo = resolve(import.meta.dir, '..')
const bun = process.execPath
const MARK = join(repo, 'channel') // identifies our entries on re-runs
// A non-default config path (BREAKPOINT_CONFIG) is baked into the hook commands.
const env = process.env.BREAKPOINT_CONFIG ? `BREAKPOINT_CONFIG="${resolve(process.env.BREAKPOINT_CONFIG)}" ` : ''
// The adapter is named explicitly; the hooks never guess the agent from the payload.
const cmd = (file: string) => `${env}"${bun}" "${join(repo, 'channel', file)}" --agent claude-code`

type HookEntry = { matcher?: string; hooks: { type: string; command: string; [k: string]: unknown }[] }
type Settings = { permissions?: { ask?: string[]; [k: string]: unknown }; hooks?: Record<string, HookEntry[]>; [k: string]: unknown }

const ASK_RULES = [
  'Bash(rm:*)',
  'Bash(git push:*)',
  'Bash(git reset:*)',
  'Bash(npm install:*)',
  'Bash(npm publish:*)',
  'Bash(curl:*)',
  'Bash(chmod:*)',
]

const file = join(project, '.claude', 'settings.local.json')
const settings: Settings = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {}
settings.hooks ??= {}

// When Claude Code's hook timeout expires it kills the hook and the terminal
// dialog stays open (verified). A killed hook can't tell that apart from a
// "No" at the desk, so the hook's own deadline is set 60 s earlier: it then
// always times out on its own, and a kill means the user answered at the desk.
const TIMEOUT_S = 1800
const waitEnv = `BREAKPOINT_WAIT_MS=${(TIMEOUT_S - 60) * 1000} `

const ours: Record<string, HookEntry> = {
  PermissionRequest: {
    matcher: '.*',
    hooks: [{ type: 'command', command: waitEnv + cmd('hook.ts'), timeout: TIMEOUT_S }],
  },
  // These clear a card when the dialog was answered at the desk.
  PostToolUse: { matcher: '.*', hooks: [{ type: 'command', command: cmd('activity.ts'), async: true, timeout: 10 }] },
  PermissionDenied: { matcher: '.*', hooks: [{ type: 'command', command: cmd('activity.ts'), async: true, timeout: 10 }] },
  Stop: { hooks: [{ type: 'command', command: cmd('activity.ts'), async: true, timeout: 10 }] },
}

for (const [event, entry] of Object.entries(ours)) {
  const kept = (settings.hooks[event] ?? []).filter(e => !e.hooks.some(h => h.command.includes(MARK)))
  settings.hooks[event] = [...kept, entry]
}

if (args.includes('--ask')) {
  settings.permissions ??= {}
  settings.permissions.ask = [...new Set([...(settings.permissions.ask ?? []), ...ASK_RULES])]
}

mkdirSync(join(project, '.claude'), { recursive: true })
writeFileSync(file, JSON.stringify(settings, null, 2) + '\n')

console.log(`Breakpoint hooks written to ${file}`)
if (args.includes('--ask')) console.log(`Added ask rules: ${ASK_RULES.join(', ')}`)
console.log(
  loadConfig()
    ? `Using the relay in ${CONFIG_PATH}. Start Claude Code in that project as usual.`
    : `Not paired yet. Run: bun scripts/pair.ts <relay-url>`,
)
