// Telegram message building and parsing for the relay. Pure: no network, no
// storage. The relay owns the bot; this file decides what it says and what a
// button press or reply means.
//
// Approving over Telegram mirrors the glasses:
//   T1, T2, plans: an Allow button.
//   T3: no Allow button. You reply to the message with the thing to check
//   (the branch, path, host or package), so approving means reading it.
// Denying is always a button, with the same canned replies as the glasses.

import type { Behavior, CardRequest } from './protocol'
import { redirectsFor } from './confirm'

export type Button = { text: string; callback_data: string }
export type Keyboard = Button[][]

/** Telegram HTML needs only these three escaped. */
export const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** Words for T3 cards that carry nothing specific to check. */
const WORDS = ['amber', 'birch', 'cobalt', 'delta', 'ember', 'fjord', 'granite', 'harbor', 'indigo', 'juniper']

/** What a T3 approval must type. The card's own token when it has one. */
export function approveWord(card: Pick<CardRequest, 'token'>, random: () => number = Math.random): string {
  const t = card.token?.trim()
  if (t) return t
  return WORDS[Math.floor(random() * WORDS.length)]
}

export function cardMessage(card: CardRequest, word: string): { html: string; keyboard: Keyboard } {
  const head = `<b>${esc(card.session || 'Claude Code')} · ${esc(card.label)}</b>`
  const lines = [head]
  if (card.kind === 'plan') {
    lines.push(`<b>${esc(card.preview)}</b>`)
    ;(card.steps ?? []).forEach((s, i) => lines.push(`${i + 1}. ${esc(s)}`))
    if (card.more) lines.push(`<i>+${card.more} more</i>`)
  } else {
    // <pre> keeps the command literal: Telegram doesn't turn URLs in it into links.
    lines.push(`<pre>${esc(card.preview)}</pre>`)
    if (card.reason) lines.push(esc(card.reason))
    if (card.description) lines.push(`<i>${esc(card.description)}</i>`)
  }
  if (card.tier === 3) lines.push('', `To approve, send: <code>${esc(word)}</code>`)

  const redirects = redirectsFor({ tier: card.tier, label: card.label }, card.preview)
  const keyboard: Keyboard = []
  if (card.tier !== 3) keyboard.push([{ text: card.kind === 'plan' ? 'Approve plan' : 'Allow', callback_data: `a:${card.id}` }])
  redirects.forEach((r, i) => keyboard.push([{ text: `↩ ${r}`, callback_data: `r:${card.id}:${i}` }]))
  keyboard.push([{ text: card.kind === 'plan' ? 'Reject' : 'Deny', callback_data: `d:${card.id}` }])
  return { html: lines.join('\n'), keyboard }
}

export type Press = { id: string; behavior: Behavior; redirectIndex?: number }

export function parseCallback(data: string): Press | null {
  const m = data.match(/^([adr]):([a-z0-9]{4,32})(?::(\d))?$/)
  if (!m) return null
  const [, kind, id, n] = m
  if (kind === 'a' && n === undefined) return { id, behavior: 'allow' }
  if (kind === 'd' && n === undefined) return { id, behavior: 'deny' }
  if (kind === 'r' && n !== undefined) return { id, behavior: 'deny', redirectIndex: Number(n) }
  return null
}

/** The redirect text a press refers to, worked out again from the card. */
export function redirectFor(card: CardRequest, index: number): string | undefined {
  return redirectsFor({ tier: card.tier, label: card.label }, card.preview)[index]
}

export const matchesWord = (text: string, word: string) => text.trim().toLowerCase() === word.trim().toLowerCase()

export type Source = 'glasses' | 'telegram'

/** Appended to a card message once it's settled. Keyboard removed. */
export function outcomeLine(o: { behavior: Behavior; redirect?: string; source: Source } | 'desk' | 'withdrawn'): string {
  if (o === 'desk') return '<b>Answered at the desk.</b>'
  if (o === 'withdrawn') return '<b>Withdrawn: nobody answered in time, the terminal decides.</b>'
  const what = o.behavior === 'allow' ? 'Allowed' : 'Denied'
  const said = o.redirect ? `, said "${esc(o.redirect)}"` : ''
  return `<b>${what} on ${o.source === 'glasses' ? 'the glasses' : 'Telegram'}${said}.</b>`
}

/** Audit receipt for a destructive decision. */
export function receipt(card: CardRequest, o: { behavior: Behavior; redirect?: string; source: Source }): string {
  const what = o.behavior === 'allow' ? '✅ Allowed' : '⛔ Denied'
  const lines = [
    `${what} · <b>${esc(card.session || 'Claude Code')}</b> · ${esc(card.label)}`,
    `<pre>${esc(card.preview)}</pre>`,
    `From ${o.source === 'glasses' ? 'the glasses' : 'Telegram'}`,
  ]
  if (o.redirect) lines.push(`Said: "${esc(o.redirect)}"`)
  return lines.join('\n')
}

/**
 * The secret Telegram sends with every webhook call. Derived from the bot token
 * so there's no second secret to manage: only someone holding the token can
 * set the webhook or forge a call.
 */
export async function webhookSecret(botToken: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`breakpoint-webhook:${botToken}`))
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('')
}

export const HELP =
  'This is Breakpoint. Claude Code permission requests come here when your glasses app is closed, and destructive ones come here if nobody answers on the glasses within 3 minutes.\n\n' +
  'To link this chat, run <code>bun scripts/telegram.ts link</code> on your laptop and open the link it prints.\n' +
  'Receipts for destructive decisions go to this chat. To send them to a channel instead, add this bot to the channel as an admin and forward any post from it here. <code>/audit off</code> sends them back here. <code>/stop</code> unlinks.'

export const HELP_LINKED =
  'This chat is linked. Requests show up here when your glasses app is closed, and destructive ones also come here if nobody answers on the glasses within 3 minutes.\n\n' +
  'Normal requests have buttons. A destructive one has no Allow button: send the word it shows to approve it.\n' +
  'Receipts for destructive decisions go to this chat. To send them to a channel instead, add this bot to the channel as an admin and forward any post from it here. <code>/audit off</code> sends them back here. <code>/stop</code> unlinks.'
