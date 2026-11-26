// Laptop-side config: which relay to use and this laptop's agent token.
// Lives outside the repo, in the user's config directory, never committed.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export type Config = { relay: string; token: string }

export const CONFIG_PATH =
  process.env.BREAKPOINT_CONFIG ??
  join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'breakpoint', 'config.json')

export function loadConfig(): Config | null {
  try {
    const c = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'))
    if (typeof c.relay === 'string' && typeof c.token === 'string') return c
  } catch {}
  return null
}

export function saveConfig(c: Config) {
  mkdirSync(dirname(CONFIG_PATH), { recursive: true })
  writeFileSync(CONFIG_PATH, JSON.stringify(c, null, 2) + '\n', { mode: 0o600 })
}
