// Attention scheduler: is now a good moment to show a card?
//
// A simplified, deterministic take on attention-sensitive alerting (Horvitz et
// al.): weigh the cost of waiting against the cost of interrupting. Not a
// Bayesian model. "Busy" means someone was speaking nearby or the wearer was
// moving within the last few seconds. Audio is reduced to a loudness number on
// the phone and never leaves it.
//
// Delivery by tier:
//   T3            show now, whatever you're doing
//   T2 and plans  wait for a break, but never longer than T2_MAX_WAIT_MS
//   T1            wait for a break, no deadline (the terminal still works)

export type Override = 'auto' | 'busy' | 'free'

export const ATTENTION = {
  /** Normalised RMS (0..1) above which a frame counts as speech. */
  voiceRms: 0.02,
  /** How long speech or movement keeps you "busy" after it stops. */
  holdMs: 3000,
  /** Variance of acceleration magnitude (raw IMU units) that counts as moving. Untested on hardware. */
  motionVariance: 0.05,
  /** IMU samples kept for the variance window. */
  motionWindow: 20,
  t2MaxWaitMs: 60_000,
}

/** RMS of 16-bit little-endian mono PCM, normalised to 0..1. Accepts the shapes the bridge may deliver. */
export function rms16(pcm: Uint8Array | number[] | string): number {
  let bytes: Uint8Array
  if (typeof pcm === 'string') {
    const bin = atob(pcm)
    bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  } else bytes = pcm instanceof Uint8Array ? pcm : Uint8Array.from(pcm)
  const n = Math.floor(bytes.length / 2)
  if (n === 0) return 0
  let sum = 0
  for (let i = 0; i < n; i++) {
    let v = bytes[2 * i] | (bytes[2 * i + 1] << 8)
    if (v >= 0x8000) v -= 0x10000
    sum += v * v
  }
  return Math.sqrt(sum / n) / 32768
}

export type Reason = 'talking' | 'moving' | 'forced'

export class Attention {
  override: Override = 'auto'
  private lastVoiceAt = -Infinity
  private lastMotionAt = -Infinity
  private motion: number[] = []

  constructor(private config = ATTENTION) {}

  /** One frame of microphone PCM. Returns its loudness, for debugging. */
  noteAudio(pcm: Uint8Array | number[] | string, now: number): number {
    const level = rms16(pcm)
    if (level >= this.config.voiceRms) this.lastVoiceAt = now
    return level
  }

  /** One IMU sample. */
  noteImu(x: number, y: number, z: number, now: number) {
    this.motion.push(Math.sqrt(x * x + y * y + z * z))
    if (this.motion.length > this.config.motionWindow) this.motion.shift()
    if (this.motion.length < 5) return
    const mean = this.motion.reduce((a, b) => a + b, 0) / this.motion.length
    const variance = this.motion.reduce((a, b) => a + (b - mean) ** 2, 0) / this.motion.length
    if (variance >= this.config.motionVariance) this.lastMotionAt = now
  }

  /** Why you're busy right now, or null if this is a good moment. */
  busy(now: number): Reason | null {
    if (this.override === 'busy') return 'forced'
    if (this.override === 'free') return null
    if (now - this.lastVoiceAt < this.config.holdMs) return 'talking'
    if (now - this.lastMotionAt < this.config.holdMs) return 'moving'
    return null
  }
}

/** Should a card that arrived at `arrivedAt` be on screen now? */
export function due(
  card: { tier: 1 | 2 | 3; kind?: 'tool' | 'plan' },
  arrivedAt: number,
  now: number,
  busy: boolean,
  config = ATTENTION,
): boolean {
  if (card.tier === 3) return true
  if (!busy) return true
  if (card.tier === 2 || card.kind === 'plan') return now - arrivedAt >= config.t2MaxWaitMs
  return false
}
