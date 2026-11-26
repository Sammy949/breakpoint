#!/usr/bin/env bun
// End-to-end check of the relay protocol, playing both the laptop and the glasses.
// Usage: bun scripts/relay-smoke.ts [relay-url]   (default http://localhost:8787)

import type { ToGlasses } from '../shared/protocol'

const RELAY = (process.argv[2] ?? 'http://localhost:8787').replace(/\/$/, '')
const agentToken = crypto.randomUUID() + crypto.randomUUID()
const auth = { Authorization: `Bearer ${agentToken}`, 'Content-Type': 'application/json' }
let failed = 0

function check(name: string, ok: boolean, detail?: unknown) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || detail === undefined ? '' : `  ${JSON.stringify(detail)}`}`)
  if (!ok) failed++
}

const post = (path: string, body: unknown, headers: Record<string, string> = auth) =>
  fetch(RELAY + path, { method: 'POST', headers, body: JSON.stringify(body) })

// Laptop starts pairing, glasses claim the code.
const noAuth = await post('/v1/requests', { id: 'aaaaa' }, { 'Content-Type': 'application/json' })
check('laptop routes need a token', noAuth.status === 401)

const { code } = (await (await post('/v1/pair/start', {})).json()) as { code: string }
check('pair/start returns a 6-digit code', /^\d{6}$/.test(code), code)

const wrongCode = String((Number(code) + 1) % 1_000_000).padStart(6, '0')
check('wrong code is rejected', (await post('/v1/pair/claim', { code: wrongCode }, {})).status === 404)

const claim = (await (await post('/v1/pair/claim', { code }, {})).json()) as { room: string; glassesToken: string }
check('claim returns room and glasses token', !!claim.room && !!claim.glassesToken)
check('code is single use', (await post('/v1/pair/claim', { code }, {})).status === 404)

const wsUrl = (token: string) =>
  `${RELAY.replace(/^http/, 'ws')}/v1/glasses?room=${claim.room}&token=${encodeURIComponent(token)}`

const badWs = new WebSocket(wsUrl('not-the-token'))
check(
  'glasses with a wrong token are refused',
  await new Promise<boolean>(r => {
    badWs.onopen = () => r(false)
    badWs.onerror = () => r(true)
    badWs.onclose = () => r(true)
  }),
)

// Glasses connect and collect messages.
const inbox: ToGlasses[] = []
const ws = new WebSocket(wsUrl(claim.glassesToken))
await new Promise<void>((resolve, reject) => {
  ws.onopen = () => resolve()
  ws.onerror = e => reject(e)
})
ws.onmessage = ev => inbox.push(JSON.parse(String(ev.data)))
const waitFor = async (pred: (m: ToGlasses) => boolean) => {
  for (let i = 0; i < 40; i++) {
    const m = inbox.find(pred)
    if (m) return m
    await Bun.sleep(50)
  }
  return null
}
check('glasses get a snapshot on connect', !!(await waitFor(m => m.type === 'snapshot')))

// Laptop adds a request; glasses see it.
const addRes = (await (
  await post('/v1/requests', {
    id: 'abcde',
    session: 'api',
    tool: 'Bash',
    preview: 'git push --force origin main\u0007‮',
    description: 'Force push',
  })
).json()) as { glasses: boolean }
check('add reports glasses connected', addRes.glasses === true)
const added = await waitFor(m => m.type === 'add')
check('glasses receive the card', added?.type === 'add' && added.request.id === 'abcde')
check(
  'control and bidi characters are stripped',
  added?.type === 'add' && added.request.preview === 'git push --force origin main',
  added,
)

const poll = async (id: string) => (await fetch(`${RELAY}/v1/requests/${id}`, { headers: auth })).json()
check('poll is pending before a verdict', (await poll('abcde')).status === 'pending')

// Glasses deny with a redirect.
ws.send(JSON.stringify({ type: 'verdict', id: 'abcde', behavior: 'deny', redirect: 'Use a new branch instead' }))
check('glasses get remove after verdict', !!(await waitFor(m => m.type === 'remove' && m.id === 'abcde')))
const decided = await poll('abcde')
check(
  'laptop receives deny + redirect',
  decided.status === 'decided' && decided.behavior === 'deny' && decided.redirect === 'Use a new branch instead',
  decided,
)
check('verdict is handed over once', (await poll('abcde')).status === 'unknown')

// Verdicts for unknown IDs are ignored.
ws.send(JSON.stringify({ type: 'verdict', id: 'zzzzz', behavior: 'allow' }))
await Bun.sleep(150)
check('verdict for unknown id is ignored', (await poll('zzzzz')).status === 'unknown')

// Laptop cancels (answered at the desk).
await post('/v1/requests', { id: 'fghij', session: 'web', tool: 'Bash', preview: 'npm install', description: '' })
await waitFor(m => m.type === 'add' && m.request.id === 'fghij')
await fetch(`${RELAY}/v1/requests/fghij`, { method: 'DELETE', headers: auth })
check(
  'cancel clears the card on the glasses',
  !!(await waitFor(m => m.type === 'remove' && m.id === 'fghij' && m.reason === 'cancelled')),
)

// A hook killed because the user answered at the desk cancels with reason=elsewhere.
await post('/v1/requests', { id: 'pqrst', session: 'web', tool: 'Bash', preview: 'rm -f x', description: '' })
await waitFor(m => m.type === 'add' && m.request.id === 'pqrst')
await fetch(`${RELAY}/v1/requests/pqrst?reason=elsewhere`, { method: 'DELETE', headers: auth })
check(
  'cancel with reason=elsewhere tells the glasses it was answered at the desk',
  !!(await waitFor(m => m.type === 'remove' && m.id === 'pqrst' && m.reason === 'elsewhere')),
)

// Another laptop cannot read this room.
const other = { Authorization: `Bearer ${crypto.randomUUID()}${crypto.randomUUID()}` }
await post('/v1/requests', { id: 'klmno', session: 'api', tool: 'Bash', preview: 'ls', description: '' })
const foreign = await (await fetch(`${RELAY}/v1/requests/klmno`, { headers: other })).json()
check("another token can't see this room's requests", foreign.status === 'unknown', foreign)

// Answered at the desk: PostToolUse / PermissionDenied (by key) and Stop (by session).
const activity = (body: unknown) => post('/v1/activity', body)
const addFor = (id: string, session_id: string, key: string) =>
  post('/v1/requests', { id, session: 'api', tool: 'Bash', preview: 'npm install', description: '', session_id, key })

await addFor('sess1a', 's1', 'key-a')
await addFor('sess1b', 's1', 'key-b')
await addFor('sess2a', 's2', 'key-a')
await waitFor(m => m.type === 'add' && m.request.id === 'sess2a')

await activity({ session_id: 's1', event: 'tool_done', key: 'key-other' })
check('tool_done with another key leaves cards alone', (await poll('sess1a')).status === 'pending')

await activity({ session_id: 's1', event: 'tool_done', key: 'key-a' })
check(
  'tool_done with the same key clears that card',
  !!(await waitFor(m => m.type === 'remove' && m.id === 'sess1a' && m.reason === 'elsewhere')),
)
check('hook is told it was answered elsewhere', (await poll('sess1a')).status === 'elsewhere')
check('the same key in another session is untouched', (await poll('sess2a')).status === 'pending')
check('another call in the same session is untouched', (await poll('sess1b')).status === 'pending')

await activity({ session_id: 's1', event: 'stop' })
check('stop clears the rest of that session', (await poll('sess1b')).status === 'elsewhere')
check('stop leaves other sessions alone', (await poll('sess2a')).status === 'pending')
check('bad activity is rejected', (await activity({ session_id: 's1', event: 'nope' })).status === 400)

ws.close()
console.log(failed ? `\n${failed} failed` : '\nall passed')
process.exit(failed ? 1 : 0)
