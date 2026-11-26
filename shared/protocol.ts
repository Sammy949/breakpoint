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
  created_at: number
}

export type Verdict = { behavior: Behavior; redirect?: string }

/** What the hook gets back when it polls for its request. */
export type PollResult =
  | { status: 'pending' }
  | ({ status: 'decided' } & Verdict)
  | { status: 'unknown' }

/** Relay -> glasses. */
export type ToGlasses =
  | { type: 'snapshot'; requests: CardRequest[] }
  | { type: 'add'; request: CardRequest }
  | { type: 'remove'; id: string; reason: 'decided' | 'cancelled' }

/** Glasses -> relay. */
export type FromGlasses = { type: 'verdict'; id: string } & Verdict

export const PAIR_CODE_TTL_MS = 5 * 60_000
