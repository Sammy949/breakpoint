// Gesture state machines for a card. Pure: no SDK, no timers, time is passed in.
//
// Approve
//   T1, T2: a single tap.
//   T3: one of several multi-step sequences, picked at random and never the
//   same twice in a row, so approving can't become muscle memory. A wrong
//   gesture cancels and re-shows with a different sequence.
// Deny
//   Always swipe down, on every tier. It never appears in an approve sequence.
//   Denying opens a redirect picker: swipe to choose a reply for Claude, tap to
//   send it, double tap to deny without one.

import type { Risk, Tier } from './risk'

export type Gesture = 'tap' | 'double' | 'up' | 'down' | 'hold'
type Step = 'tap' | 'up'

export type Sequence = { steps: Step[]; text: string }

export const T3_SEQUENCES: Sequence[] = [
  { steps: ['up', 'tap'], text: 'swipe up, then tap' },
  { steps: ['tap', 'tap', 'tap'], text: 'tap three times' },
  { steps: ['up', 'up'], text: 'swipe up twice' },
  { steps: ['up', 'tap', 'up'], text: 'swipe up, tap, swipe up' },
]

/** Steps must follow each other within this window, or progress resets. */
export const STEP_WINDOW_MS = 5000

export function pickSequence(previous: Sequence | undefined, random: () => number = Math.random): Sequence {
  const options = T3_SEQUENCES.filter(s => s !== previous)
  return options[Math.floor(random() * options.length) % options.length]
}

export type ApproveState = {
  tier: Tier
  sequence?: Sequence // T3 only
  progress: number
  lastStepAt: number
  /** Wrong attempts so far, shown on the card. */
  misses: number
}

export type ApproveResult =
  | { kind: 'approve' }
  | { kind: 'deny' }
  | { kind: 'progress'; state: ApproveState }
  | { kind: 'wrong'; state: ApproveState }
  | { kind: 'ignore' }

export function startApprove(tier: Tier, previous?: Sequence, random?: () => number): ApproveState {
  return {
    tier,
    sequence: tier === 3 ? pickSequence(previous, random) : undefined,
    progress: 0,
    lastStepAt: 0,
    misses: 0,
  }
}

export function feedApprove(
  state: ApproveState,
  gesture: Gesture,
  now: number,
  random?: () => number,
): ApproveResult {
  if (gesture === 'down') return { kind: 'deny' }

  if (state.tier !== 3 || !state.sequence) {
    return gesture === 'tap' ? { kind: 'approve' } : { kind: 'ignore' }
  }

  const seq = state.sequence
  let progress = now - state.lastStepAt > STEP_WINDOW_MS ? 0 : state.progress

  // The glasses may merge two quick taps into one double tap. Count it as two
  // taps, but only where the sequence expects two taps in a row.
  const steps: Step[] | null =
    gesture === 'tap' ? ['tap'] : gesture === 'up' ? ['up'] : gesture === 'double' ? ['tap', 'tap'] : null
  if (!steps) return { kind: 'ignore' } // long press means nothing on a T3 card

  for (const step of steps) {
    if (seq.steps[progress] !== step) {
      const next: ApproveState = {
        ...state,
        sequence: pickSequence(seq, random),
        progress: 0,
        lastStepAt: 0,
        misses: state.misses + 1,
      }
      return { kind: 'wrong', state: next }
    }
    progress++
  }
  if (progress >= seq.steps.length) return { kind: 'approve' }
  return { kind: 'progress', state: { ...state, progress, lastStepAt: now } }
}

// --- Redirect picker -----------------------------------------------------------

export type PickerState = { options: string[]; index: number }
export type PickerResult =
  | { kind: 'send'; redirect: string }
  | { kind: 'plain' }
  | { kind: 'move'; state: PickerState }
  | { kind: 'ignore' }

export function feedPicker(state: PickerState, gesture: Gesture): PickerResult {
  const n = state.options.length
  switch (gesture) {
    case 'tap':
      return { kind: 'send', redirect: state.options[state.index] }
    case 'double':
      return { kind: 'plain' }
    case 'down':
      return { kind: 'move', state: { ...state, index: (state.index + 1) % n } }
    case 'up':
      return { kind: 'move', state: { ...state, index: (state.index - 1 + n) % n } }
    default:
      return { kind: 'ignore' }
  }
}

/** Fixed redirect replies, picked by what the command was doing. */
export function redirectsFor(risk: { tier: Tier; label: Risk['label'] | string }, preview: string): string[] {
  const p = preview.toLowerCase()
  const desk = "Wait, I'll do it at my desk"
  if (risk.label === 'PLAN') return ['Smaller first', 'Tests first', 'Ask me at my desk']
  if (/\bgit\s+push\b/.test(p)) return ['Use a new branch instead', 'Run the tests first', desk]
  if (/\bgit\s+(reset|clean|checkout|restore)\b/.test(p)) return ['Stash the changes first', 'Show me the diff first', desk]
  if (/\brm\b|\bshred\b|\bunlink\b/.test(p)) return ['Move it to a backup folder instead', 'List what would be deleted first', desk]
  if (/\b(publish|deploy|release)\b|--prod/.test(p)) return ['Do a dry run first', 'Run the tests first', desk]
  if (risk.label === 'INSTALL') return ["Don't add dependencies, use what we have", 'Explain why we need it first', desk]
  if (risk.label === 'NETWORK') return ['Explain why first', 'Try it offline instead', desk]
  if (/\.env|secret|key|credential/.test(p)) return ["Don't touch secrets, ask me", 'Use an example file instead', desk]
  return ['Explain why first', 'Run the tests first', desk]
}
