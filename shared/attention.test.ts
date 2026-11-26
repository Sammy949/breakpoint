import { describe, expect, test } from 'bun:test'
import { ATTENTION, Attention, due, rms16 } from './attention'

/** 16-bit LE PCM of a constant amplitude (fraction of full scale). */
function pcm(amplitude: number, samples = 320): Uint8Array {
  const out = new Uint8Array(samples * 2)
  const v = Math.round(amplitude * 32767)
  for (let i = 0; i < samples; i++) {
    const s = i % 2 ? v : -v // square wave, RMS = amplitude
    out[2 * i] = s & 0xff
    out[2 * i + 1] = (s >> 8) & 0xff
  }
  return out
}

describe('rms16', () => {
  test('silence is zero', () => expect(rms16(pcm(0))).toBe(0))
  test('measures amplitude', () => expect(rms16(pcm(0.5))).toBeCloseTo(0.5, 2))
  test('accepts number arrays and base64 from the bridge', () => {
    const p = pcm(0.25)
    expect(rms16(Array.from(p))).toBeCloseTo(0.25, 2)
    expect(rms16(btoa(String.fromCharCode(...p)))).toBeCloseTo(0.25, 2)
  })
  test('empty or odd input is safe', () => {
    expect(rms16(new Uint8Array(0))).toBe(0)
    expect(rms16(new Uint8Array(1))).toBe(0)
  })
})

describe('Attention', () => {
  test('quiet and still means free', () => {
    const a = new Attention()
    a.noteAudio(pcm(0.001), 1000)
    expect(a.busy(1000)).toBeNull()
  })
  test('speech makes you busy for the hold time, then free', () => {
    const a = new Attention()
    a.noteAudio(pcm(0.1), 1000)
    expect(a.busy(1000)).toBe('talking')
    expect(a.busy(1000 + ATTENTION.holdMs - 1)).toBe('talking')
    expect(a.busy(1000 + ATTENTION.holdMs)).toBeNull()
  })
  test('steady IMU readings are not movement, shaking is', () => {
    const a = new Attention()
    for (let i = 0; i < 20; i++) a.noteImu(0, 0, 1, i * 100)
    expect(a.busy(2000)).toBeNull()
    for (let i = 0; i < 20; i++) a.noteImu(i % 2 ? 2 : 0, 0, 1, 2000 + i * 100)
    expect(a.busy(4000)).toBe('moving')
  })
  test('the debug override wins both ways', () => {
    const a = new Attention()
    a.override = 'busy'
    expect(a.busy(0)).toBe('forced')
    a.noteAudio(pcm(0.5), 0)
    a.override = 'free'
    expect(a.busy(0)).toBeNull()
  })
})

describe('due', () => {
  const t3 = { tier: 3 as const }
  const t2 = { tier: 2 as const }
  const t1 = { tier: 1 as const }
  const plan = { tier: 2 as const, kind: 'plan' as const }
  test('T3 shows even when busy', () => expect(due(t3, 0, 0, true)).toBe(true))
  test('everything shows when free', () => {
    for (const c of [t1, t2, t3, plan]) expect(due(c, 0, 0, false)).toBe(true)
  })
  test('T2 and plans wait while busy, up to the deadline', () => {
    expect(due(t2, 0, ATTENTION.t2MaxWaitMs - 1, true)).toBe(false)
    expect(due(t2, 0, ATTENTION.t2MaxWaitMs, true)).toBe(true)
    expect(due(plan, 0, ATTENTION.t2MaxWaitMs, true)).toBe(true)
  })
  test('T1 waits for a break with no deadline', () => {
    expect(due(t1, 0, 10 * 60_000, true)).toBe(false)
  })
})
