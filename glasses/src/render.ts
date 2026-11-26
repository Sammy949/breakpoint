// Pure text rendering for the 576x288 display. No SDK calls here.

import type { CardRequest } from '../../shared/protocol'

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

export function renderCard(card: CardRequest, index: number, total: number) {
  const head = `${oneLine(card.session || 'session', 24)} · ${card.tool}`
  const counter = total > 1 ? `${index + 1} of ${total}` : ''
  const lines = [
    counter ? `${head}   ${counter}` : head,
    ...wrapPreview(card.preview),
    card.description ? oneLine(card.description, LINE) : '',
    '',
    'TAP: allow',
    'SWIPE DOWN: deny',
  ]
  return lines.filter((l, i) => l !== '' || i === lines.length - 3).join('\n')
}

export type Status = 'unpaired' | 'connecting' | 'connected' | 'offline'

export function renderIdle(status: Status, flash?: string) {
  const top = flash ?? 'Breakpoint'
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
