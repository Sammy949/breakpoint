// Pure text rendering for the 576x288 display. No SDK calls here.

import type { CardRequest } from '../../shared/protocol'
import type { ApproveState, PickerState } from '../../shared/confirm'

const LINE = 58 // characters that fit on one line at the default font, roughly

function oneLine(s: string, max: number) {
  const flat = s.replace(/\s+/g, ' ').trim()
  return flat.length > max ? flat.slice(0, max - 1) + '…' : flat
}

/** Split a command over at most `lines` lines, eliding the middle if too long. */
export function wrapPreview(s: string, lines = 2) {
  const flat = s.replace(/\s+/g, ' ').trim()
  const room = LINE * lines
  const text = flat.length > room ? flat.slice(0, room - 12) + ' … ' + flat.slice(-9) : flat
  const out: string[] = []
  for (let i = 0; i < text.length && out.length < lines; i += LINE) out.push(text.slice(i, i + LINE))
  return out
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
  const shown = cards.slice(0, 4).map(c => `- ${oneLine(c.preview, LINE - 2)}`)
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
    oneLine(card.preview, LINE),
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
