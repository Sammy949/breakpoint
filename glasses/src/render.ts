// Pure text rendering for the 576x288 display. No SDK calls here.

import type { CardRequest } from '../../shared/protocol'
import type { ApproveState, PickerState } from '../../shared/confirm'

const LINE = 58 // characters of prose that fit on one line at the default font, roughly
// Commands get a narrower budget. The font is proportional and commands are
// full of wide characters (%, $, m, w), so 58 of them can run past the edge and
// the display wraps the overflow onto a stray line of its own.
export const COMMAND_LINE = 46

function oneLine(s: string, max: number) {
  const flat = s.replace(/\s+/g, ' ').trim()
  return flat.length > max ? flat.slice(0, max - 1) + '…' : flat
}

/** Wrap at spaces. A word longer than a whole line is split; nothing else is. */
function wrapWords(words: string[], width: number): string[] {
  const out: string[] = []
  let cur = ''
  for (let word of words) {
    while (word.length > width) {
      if (cur) out.push(cur), (cur = '')
      out.push(word.slice(0, width))
      word = word.slice(width)
    }
    if (!word) continue
    if (!cur) cur = word
    else if (cur.length + 1 + word.length <= width) cur += ' ' + word
    else out.push(cur), (cur = word)
  }
  if (cur) out.push(cur)
  return out
}

/**
 * Split a command over at most `lines` lines, breaking at spaces. If it doesn't
 * fit, keep the start and the last few words, with "…" between them.
 */
export function wrapPreview(s: string, lines = 2, width = COMMAND_LINE): string[] {
  const words = s.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean)
  const whole = wrapWords(words, width)
  if (whole.length <= lines) return whole

  // Tail: whole words from the end, up to about 45% of a line. If even the
  // last word is too long, its last characters.
  const tailMax = Math.floor(width * 0.45)
  let cut = words.length
  while (cut > 1 && words.slice(cut - 1).join(' ').length <= tailMax) cut--
  const tail = cut < words.length ? words.slice(cut).join(' ') : words.at(-1)!.slice(-tailMax)
  if (cut === words.length) cut--
  const end = `… ${tail}` // one piece, so it never splits across lines

  // Head: as many leading words as fit in front of it.
  for (let k = cut; k > 0; k--) {
    const out = wrapWords([...words.slice(0, k), end], width)
    if (out.length <= lines) return out
  }
  // Only one enormous word (a long path, say): cut it by characters.
  const room = lines * width - end.length - 1
  const text = `${words.join(' ').slice(0, room)} ${end}`
  return Array.from({ length: lines }, (_, i) => text.slice(i * width, (i + 1) * width)).filter(Boolean)
}

function header(card: CardRequest, index: number, total: number) {
  const head = `${oneLine(card.session || 'session', 20)} · ${card.label}`
  return total > 1 ? `${head}   ${index + 1} of ${total}` : head
}

/**
 * Approve view. On T3 cards the "CHECK" line with the key token moves between
 * two positions from card to card (`variant`), so the eye has to find it
 * instead of skipping to the gesture line.
 */
export function renderCard(card: CardRequest, index: number, total: number, state: ApproveState, variant = 0) {
  const lines = [header(card, index, total)]
  const check = card.token ? `CHECK: ${oneLine(card.token, LINE - 7)}` : ''
  const consequence = oneLine(card.reason || card.description, LINE)

  if (card.tier === 3 && state.sequence) {
    if (check && variant % 2 === 0) lines.push(check)
    lines.push(...wrapPreview(card.preview), consequence)
    if (check && variant % 2 === 1) lines.push(check)
    const done = state.progress > 0 ? `   (${state.progress} of ${state.sequence.steps.length})` : ''
    lines.push('', `APPROVE: ${state.sequence.text}${done}`, 'DENY: swipe down')
    if (state.misses > 0) lines.push('Wrong gesture, the sequence changed.')
  } else {
    lines.push(...wrapPreview(card.preview), consequence, '', 'TAP: allow', 'SWIPE DOWN: deny')
  }
  return lines.join('\n')
}

export function renderPlan(card: CardRequest, index: number, total: number) {
  const steps = (card.steps ?? []).map((s, i) => `${i + 1}. ${oneLine(s, LINE - 3)}`)
  if (card.more) steps.push(`   and ${card.more} more`)
  return [
    `${oneLine(card.session || 'session', 20)} · PLAN${total > 1 ? `   ${index + 1} of ${total}` : ''}`,
    oneLine(card.preview, LINE),
    ...steps,
    '',
    'TAP: approve plan · SWIPE DOWN: send feedback',
  ].join('\n')
}

export function renderBatch(cards: CardRequest[]) {
  const sessions = [...new Set(cards.map(c => c.session || 'session'))]
  const who = sessions.length === 1 ? oneLine(sessions[0], 20) : `${sessions.length} sessions`
  const shown = cards.slice(0, 4).map(c => `- ${oneLine(c.preview, COMMAND_LINE - 2)}`)
  if (cards.length > 4) shown.push(`  and ${cards.length - 4} more`)
  return [
    `${who} · ${cards.length} safe requests waiting`,
    ...shown,
    '',
    'HOLD: approve all · SWIPE DOWN: one by one',
  ].join('\n')
}

export function renderPicker(card: CardRequest, picker: PickerState) {
  return [
    `${oneLine(card.session || 'session', 20)} · ${card.kind === 'plan' ? 'plan feedback' : 'denying'}`,
    oneLine(card.preview, card.kind === 'plan' ? LINE : COMMAND_LINE),
    card.kind === 'plan' ? 'What should change?' : 'Tell Claude what to do instead?',
    ...picker.options.map((o, i) => `${i === picker.index ? '>' : ' '} ${oneLine(o, LINE - 2)}`),
    '',
    card.kind === 'plan' ? 'TAP: send · SWIPE: choose · DOUBLE TAP: just reject' : 'TAP: send · SWIPE: choose · DOUBLE TAP: just deny',
  ].join('\n')
}

export type Status = 'unpaired' | 'connecting' | 'connected' | 'offline'

const WHY: Record<string, string> = { talking: "you're talking", moving: "you're moving", forced: 'busy mode is on' }

export function renderIdle(status: Status, flash?: string, waiting?: { count: number; reason: string | null }) {
  const top = flash ?? 'Breakpoint'
  if (status === 'connected' && waiting && waiting.count > 0) {
    const n = waiting.count === 1 ? '1 request' : `${waiting.count} requests`
    return `${top}\n\n${n} waiting for a break${waiting.reason ? ` (${WHY[waiting.reason] ?? waiting.reason})` : ''}.\nDestructive ones still interrupt.`
  }
  switch (status) {
    case 'unpaired':
      return `${top}\n\nNot paired yet.\nOpen Breakpoint on your phone to pair.`
    case 'connecting':
      return `${top}\n\nConnecting to relay…`
    case 'offline':
      return `${top}\n\nOffline. Answer in the terminal.\nRetrying…`
    case 'connected':
      return `${top}\n\nConnected. Nothing waiting.`
  }
}
