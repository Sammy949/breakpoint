// The boundary between Breakpoint and a coding agent's hook system.
//
// The relay, the glasses and the risk tiers only see a BreakpointRequest. An
// adapter turns one agent's hook payload into that, and turns a verdict from
// the glasses back into whatever that agent expects on stdout.

import type { Activity, Verdict } from '../../shared/protocol'

export type AgentId = 'claude-code'

export type BreakpointRequest = {
  agent: AgentId
  sessionId?: string
  /** The agent's own tool name, e.g. Bash, Write, ExitPlanMode. */
  toolName: string
  /** Project directory the agent is running in. */
  cwd?: string
  /** The tool's arguments, as the agent sent them. */
  input: Record<string, unknown>
  /** Set when the call runs a shell command. */
  command?: string
  /** Set when the call touches a file. */
  path?: string
  /** Set when the call asks to approve a plan: the plan's markdown. */
  plan?: string
  /** The agent's own description of the call, if it gave one. */
  description: string
  /** Matches this call to the agent's later events (see postEventClears). */
  key: string
  /** The agent's payload exactly as it arrived on stdin. */
  raw: string
}

export interface Adapter {
  id: AgentId
  /** Agent hook payload (stdin) to a request. */
  parseInput(stdin: string): BreakpointRequest
  /** A verdict from the glasses to the agent's stdout. */
  formatVerdict(verdict: Verdict, request: BreakpointRequest): string
  /**
   * A later agent event (tool ran, permission denied, turn stopped) to what the
   * relay should clear as "answered at the desk": one call by key, or the whole
   * session on stop. Null when there is nothing to clear.
   */
  postEventClears(stdin: string): Activity | null
}
