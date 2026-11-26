#!/usr/bin/env bun
// Telegram setup. The bot itself runs inside the relay; this script only
// points the bot at a relay and links your Telegram account to this laptop.
//
//   bun scripts/telegram.ts webhook <relay-url>   Point the bot at a relay (once per relay URL).
//                                                 Reads TELEGRAM_BOT_TOKEN from .env.
//   bun scripts/telegram.ts link                  Print a link that ties your Telegram to this laptop.

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadConfig } from '../channel/config'
import { webhookSecret } from '../shared/telegram'

const [cmd, arg] = process.argv.slice(2)

if (cmd === 'webhook') {
  const token = process.env.TELEGRAM_BOT_TOKEN
  if (!token || !arg) {
    console.error(token ? 'Usage: bun scripts/telegram.ts webhook <relay-url>' : 'Set TELEGRAM_BOT_TOKEN in .env first (from @BotFather).')
    process.exit(1)
  }
  const relay = new URL(arg).origin
  const res = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      url: `${relay}/v1/telegram`,
      secret_token: await webhookSecret(token),
      allowed_updates: ['message', 'callback_query'],
      drop_pending_updates: true,
    }),
  }).then(r => r.json() as Promise<{ ok: boolean; description?: string }>)
  if (!res.ok) {
    console.error(`Telegram refused the webhook: ${res.description}`)
    process.exit(1)
  }
  console.log(`Bot now sends updates to ${relay}/v1/telegram`)

  // The relay needs the token too. Locally, wrangler reads relay/.dev.vars (gitignored).
  const devVars = join(import.meta.dir, '..', 'relay', '.dev.vars')
  const current = existsSync(devVars) ? readFileSync(devVars, 'utf8') : ''
  if (!current.includes(`TELEGRAM_BOT_TOKEN=${token}`)) {
    const rest = current.split('\n').filter(l => l && !l.startsWith('TELEGRAM_BOT_TOKEN='))
    writeFileSync(devVars, [...rest, `TELEGRAM_BOT_TOKEN=${token}`].join('\n') + '\n', { mode: 0o600 })
    console.log('Wrote the token to relay/.dev.vars for a local relay. Restart `bun run dev` in relay/ to pick it up.')
  }
  console.log('For a deployed relay: cd relay && bunx wrangler secret put TELEGRAM_BOT_TOKEN')
} else if (cmd === 'link') {
  const config = loadConfig()
  if (!config) {
    console.error('Not paired: run scripts/pair.ts first.')
    process.exit(1)
  }
  const res = await fetch(`${config.relay}/v1/telegram/link`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.token}` },
  }).catch(() => null)
  const body = (await res?.json().catch(() => null)) as { link?: string; error?: string } | null
  if (!res?.ok || !body?.link) {
    console.error(`Couldn't get a link: ${body?.error ?? res?.status ?? 'relay unreachable'}`)
    process.exit(1)
  }
  console.log(`Open this on your phone within 10 minutes and tap Start:\n  ${body.link}`)
} else {
  console.error('Usage: bun scripts/telegram.ts webhook <relay-url> | link')
  process.exit(1)
}
