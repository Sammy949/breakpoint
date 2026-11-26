// Identifies "the same tool call" across Claude Code hook events
// (PermissionRequest, PostToolUse, PermissionDenied) without sending the input.

import { createHash } from 'node:crypto'

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  if (value && typeof value === 'object') {
    const entries = Object.keys(value as object)
      .sort()
      .map(k => `${JSON.stringify(k)}:${stable((value as Record<string, unknown>)[k])}`)
    return `{${entries.join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

export function callKey(toolName: string, toolInput: unknown): string {
  return createHash('sha256').update(`${toolName}\n${stable(toolInput ?? {})}`).digest('hex').slice(0, 32)
}
