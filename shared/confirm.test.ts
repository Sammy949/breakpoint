import { describe, expect, test } from 'bun:test'
import {
  STEP_WINDOW_MS,
  T3_SEQUENCES,
  feedApprove,
  feedPicker,
  pickSequence,
  redirectsFor,
  startApprove,
  type ApproveState,
  type Gesture,
} from './confirm'

/** Feed gestures 500 ms apart; return the final result kind. */
function run(state: ApproveState, gestures: Gesture[], gap = 500) {
  let s = state
  let t = 10_000
  let last: ReturnType<typeof feedApprove> = { kind: 'ignore' }
  for (const g of gestures) {
    last = feedApprove(s, g, (t += gap))
    if (last.kind === 'progress' || last.kind === 'wrong') s = last.state
    if (last.kind === 'approve' || last.kind === 'deny') break
  }
  return { last, state: s }
}

const t3With = (index: number): ApproveState => ({ ...startApprove(3), sequence: T3_SEQUENCES[index] })

describe('T3 set', () => {
  test('every sequence has at least two steps and never uses swipe down', () => {
    for (const s of T3_SEQUENCES) {
      expect(s.steps.length).toBeGreaterThanOrEqual(2)
      expect(s.steps as string[]).not.toContain('down')
    }
  })
  test('no single gesture approves any T3 sequence', () => {
    for (let i = 0; i < T3_SEQUENCES.length; i++) {
      for (const g of ['tap', 'double', 'up', 'hold'] as Gesture[]) {
        expect(feedApprove(t3With(i), g, 1000).kind).not.toBe('approve')
      }
    }
  })
  test('pickSequence never repeats the previous one', () => {
    for (const prev of T3_SEQUENCES) {
      for (let r = 0; r < 1; r += 0.05) expect(pickSequence(prev, () => r)).not.toBe(prev)
    }
  })
})

describe('approve', () => {
  test('T1 and T2 approve on a tap', () => {
    expect(feedApprove(startApprove(1), 'tap', 0).kind).toBe('approve')
    expect(feedApprove(startApprove(2), 'tap', 0).kind).toBe('approve')
  })
  test('T2 ignores other gestures except deny', () => {
    expect(feedApprove(startApprove(2), 'up', 0).kind).toBe('ignore')
    expect(feedApprove(startApprove(2), 'double', 0).kind).toBe('ignore')
    expect(feedApprove(startApprove(2), 'down', 0).kind).toBe('deny')
  })
  test('swipe down denies a T3 card at any point in the sequence', () => {
    expect(run(t3With(3), ['up', 'tap', 'down']).last.kind).toBe('deny')
  })

  test.each(T3_SEQUENCES.map((s, i) => [s.text, i] as const))('"%s" approves when done right', (_, i) => {
    expect(run(t3With(i), T3_SEQUENCES[i].steps).last.kind).toBe('approve')
  })

  test('swipe up, then tap: partial progress does not approve', () => {
    const r = run(t3With(0), ['up'])
    expect(r.last.kind).toBe('progress')
  })
  test('a wrong step cancels, picks a different sequence and counts a miss', () => {
    const r = run(t3With(0), ['tap'])
    expect(r.last.kind).toBe('wrong')
    expect(r.state.sequence).not.toBe(T3_SEQUENCES[0])
    expect(r.state.progress).toBe(0)
    expect(r.state.misses).toBe(1)
  })
  test('the old sequence no longer works after a miss', () => {
    const after = run(t3With(0), ['tap']).state
    const old = T3_SEQUENCES[0].steps
    expect(run(after, old).last.kind).not.toBe('approve')
  })
  test('a long pause between steps starts over', () => {
    const r = run(t3With(2), ['up', 'up'], STEP_WINDOW_MS + 1)
    expect(r.last.kind).toBe('progress')
  })
  test('double tap counts as two taps where two taps are expected', () => {
    expect(run(t3With(1), ['double', 'tap']).last.kind).toBe('approve')
    expect(run(t3With(1), ['tap', 'double']).last.kind).toBe('approve')
  })
  test('double tap alone is not enough for tap three times', () => {
    expect(run(t3With(1), ['double']).last.kind).toBe('progress')
  })
  test('double tap where one tap is expected is wrong', () => {
    expect(run(t3With(0), ['up', 'double']).last.kind).toBe('wrong')
  })
  test('long press does nothing on a T3 card', () => {
    expect(feedApprove(t3With(0), 'hold', 0).kind).toBe('ignore')
  })
})

describe('redirect picker', () => {
  const state = { options: ['a', 'b', 'c'], index: 0 }
  test('tap sends the highlighted reply', () => {
    expect(feedPicker(state, 'tap')).toEqual({ kind: 'send', redirect: 'a' })
  })
  test('double tap denies without a reply', () => {
    expect(feedPicker(state, 'double').kind).toBe('plain')
  })
  test('swipes move and wrap', () => {
    const down = feedPicker(state, 'down')
    expect(down.kind === 'move' && down.state.index).toBe(1)
    const up = feedPicker(state, 'up')
    expect(up.kind === 'move' && up.state.index).toBe(2)
  })
})

describe('redirects', () => {
  const t3 = { tier: 3 as const, label: 'DESTRUCTIVE' as const, reason: '' }
  test('force push offers a new branch first', () => {
    expect(redirectsFor(t3, 'git push --force origin main')[0]).toBe('Use a new branch instead')
  })
  test('rm offers a backup', () => {
    expect(redirectsFor(t3, 'rm -rf build')[0]).toContain('backup')
  })
  test('every set has three replies and ends with the desk option', () => {
    for (const p of ['git push -f', 'rm -rf x', 'npm publish', 'curl x', 'frobnicate', 'git reset --hard']) {
      const r = redirectsFor(t3, p)
      expect(r).toHaveLength(3)
      expect(r[2]).toBe("Wait, I'll do it at my desk")
    }
  })
})
