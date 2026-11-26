// Claude Code: PermissionRequest hook in, hookSpecificOutput out.

import { callKey } from '../key'
import type { Adapter, BreakpointRequest } from './types'

type HookInput = {
  session_id?: string
  cwd?: string
  hook_event_name?: string
  tool_name?: string
  tool_input?: Record<string, unknown>
}

const str = (v: unknown) => (typeof v === 'string' ? v : undefined)

export const claudeCode: Adapter = {
  id: 'claude-code',

  parseInput(raw) {
    const input = JSON.parse(raw) as HookInput
    const toolName = input.tool_name ?? 'unknown'
    const args = input.tool_input ?? {}
    return {
      agent: 'claude-code',
      sessionId: input.session_id,
      toolName,
      cwd: input.cwd,
      input: args,
      command: str(args.command),
      path: str(args.file_path),
      plan: toolName === 'ExitPlanMode' ? String(input.tool_input?.plan ?? '') : undefined,
      description: str(args.description) ?? '',
      // The raw tool_input, not the defaulted one, so the key matches activity events.
      key: callKey(toolName, input.tool_input),
      raw,
    }
  },

  formatVerdict({ behavior, redirect }, request: BreakpointRequest) {
    const isPlan = request.plan !== undefined
    const what = isPlan ? 'rejected the plan' : 'denied this'
    const toolInput = (JSON.parse(request.raw) as HookInput).tool_input
    return JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision:
          behavior === 'allow'
            ? // Plan approvals are ignored by Claude Code unless the input is echoed
              // back (verified on v2.1.332). Tool calls get a plain allow, because
              // updated input is re-checked against ask rules.
              isPlan
              ? { behavior: 'allow', updatedInput: toolInput }
              : { behavior: 'allow' }
            : {
                behavior: 'deny',
                message: redirect
                  ? `The user ${what} from Breakpoint and said: "${redirect}"`
                  : `The user ${what} from Breakpoint.`,
              },
      },
    })
  },

  postEventClears(raw) {
    const input = JSON.parse(raw) as HookInput
    if (!input.session_id) return null
    return input.hook_event_name === 'Stop'
      ? { session_id: input.session_id, event: 'stop' }
      : { session_id: input.session_id, event: 'tool_done', key: callKey(input.tool_name ?? '', input.tool_input) }
  },
}
