// Picks the adapter from an explicit --agent flag in the hook command, never
// by sniffing the payload. scripts/setup.ts writes the flag.

import { claudeCode } from './claude-code'
import type { Adapter } from './types'

const ADAPTERS: Record<string, Adapter> = { 'claude-code': claudeCode }

export function selectAdapter(argv: string[]): Adapter {
  const i = argv.indexOf('--agent')
  const flag = argv.find(a => a.startsWith('--agent='))?.slice('--agent='.length)
  const name = flag ?? (i >= 0 ? argv[i + 1] : undefined) ?? 'claude-code'
  const adapter = ADAPTERS[name]
  if (!adapter) throw new Error(`Unknown --agent "${name}". Known: ${Object.keys(ADAPTERS).join(', ')}`)
  return adapter
}
