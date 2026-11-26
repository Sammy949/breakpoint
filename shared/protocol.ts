// Wire types shared by the hook (laptop), the relay and the glasses plugin.

export type Behavior = 'allow' | 'deny'

/** A permission request as the glasses see it. Every string is untrusted. */
export type CardRequest = {
  id: string
  /** Project folder name of the Claude Code session. */
  session: string
  /** Claude Code tool, e.g. Bash, Write, Edit. */
  tool: string
  /** The command or path, already shortened by the hook. */
  preview: string
  /** Claude's own description of the call, if it gave one. */
  description: string
  /** Risk tier from shared/risk.ts, worked out on the laptop. */
  tier: 1 | 2 | 3
  label: string
  /** One-line consequence, e.g. "Rewrites history on main." */
  reason: string
  /** What to check: branch, path, host or package. */
  token?: string
  /** 'plan' for a plan approval (ExitPlanMode); tool calls otherwise. */
  kind?: 'tool' | 'plan'
  /** Plan cards: up to three key steps, and how many more there are. */
  steps?: string[]
  more?: number
  /** Which coding agent asked, e.g. 'claude-code'. Set by the hook's adapter. */
  agent?: string
  created_at: number
}

export type Verdict = { behavior: Behavior; redirect?: string }

/** What the hook gets back when it polls for its request. */
export type PollResult =
  | { status: 'pending' }
  | ({ status: 'decided' } & Verdict)
  /** Answered at the desk (or the turn ended): the hook should step aside. */
  | { status: 'elsewhere' }
  | { status: 'unknown' }

/** Relay -> glasses. */
export type ToGlasses =
  | { type: 'snapshot'; requests: CardRequest[] }
  | { type: 'add'; request: CardRequest }
  | { type: 'remove'; id: string; reason: 'decided' | 'cancelled' | 'elsewhere' }

/** Laptop -> relay when a request is created. session_id and key stay on the relay. */
export type NewRequest = Omit<CardRequest, 'created_at'> & { session_id?: string; key?: string }

/** Laptop -> relay from PostToolUse / PermissionDenied (key) or Stop (whole session). */
export type Activity = { session_id: string; event: 'tool_done' | 'stop'; key?: string }

/** Glasses -> relay. */
export type FromGlasses = { type: 'verdict'; id: string } & Verdict

export const PAIR_CODE_TTL_MS = 5 * 60_000
