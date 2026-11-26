import { describe, expect, test } from 'bun:test'
import type { CardRequest } from './protocol'
import { approveWord, cardMessage, esc, matchesWord, outcomeLine, parseCallback, receipt, redirectFor, webhookSecret } from './telegram'

const card = (over: Partial<CardRequest> = {}): CardRequest => ({
  id: 'abc123',
  session: 'api',
  tool: 'Bash',
  preview: 'git push --force origin main',
  description: '',
  tier: 3,
  label: 'DESTRUCTIVE',
  reason: 'Rewrites history on main.',
  token: 'main',
  created_at: 0,
  ...over,
})

const datas = (k: { callback_data: string }[][]) => k.flat().map(b => b.callback_data)

describe('cardMessage', () => {
  test('T3 has no allow button and asks for the token', () => {
    const { html, keyboard } = cardMessage(card(), 'main')
    expect(datas(keyboard)).not.toContain('a:abc123')
    expect(datas(keyboard)).toContain('d:abc123')
    expect(html).toContain('To approve, send: <code>main</code>')
    expect(html).toContain('<pre>git push --force origin main</pre>')
  })

  test('T2 has an allow button, canned redirects and a plain deny', () => {
    const { html, keyboard } = cardMessage(card({ tier: 2, label: 'PUSH', preview: 'git push', token: undefined }), 'x')
    expect(datas(keyboard)).toEqual(['a:abc123', 'r:abc123:0', 'r:abc123:1', 'r:abc123:2', 'd:abc123'])
    expect(keyboard[1][0].text).toBe('↩ Use a new branch instead')
    expect(html).not.toContain('To approve')
  })

  test('plans show title and steps, and approve rather than allow', () => {
    const { html, keyboard } = cardMessage(
      card({ kind: 'plan', tier: 2, label: 'PLAN', preview: 'Add login', steps: ['Model', 'Routes'], more: 2, token: undefined }),
      'x',
    )
    expect(html).toContain('<b>Add login</b>\n1. Model\n2. Routes\n<i>+2 more</i>')
    expect(keyboard[0][0].text).toBe('Approve plan')
    expect(keyboard.at(-1)![0].text).toBe('Reject')
  })

  test('untrusted text is escaped', () => {
    const { html } = cardMessage(card({ preview: 'echo "<b>hi</b>" && x', session: '<i>', reason: 'a & b' }), 'w')
    expect(html).toContain('echo "&lt;b&gt;hi&lt;/b&gt;" &amp;&amp; x')
    expect(html).toContain('<b>&lt;i&gt; · DESTRUCTIVE</b>')
    expect(html).toContain('a &amp; b')
  })

  test('callback data fits Telegram\'s 64-byte limit with the longest id', () => {
    const { keyboard } = cardMessage(card({ id: 'a'.repeat(32), tier: 2 }), 'x')
    for (const d of datas(keyboard)) expect(new TextEncoder().encode(d).length).toBeLessThanOrEqual(64)
  })
})

describe('parseCallback', () => {
  test('reads allow, deny and redirect presses', () => {
    expect(parseCallback('a:abc123')).toEqual({ id: 'abc123', behavior: 'allow' })
    expect(parseCallback('d:abc123')).toEqual({ id: 'abc123', behavior: 'deny' })
    expect(parseCallback('r:abc123:2')).toEqual({ id: 'abc123', behavior: 'deny', redirectIndex: 2 })
  })

  test('rejects anything malformed', () => {
    for (const d of ['', 'a:', 'a:ABC123', 'x:abc123', 'a:abc123:1', 'r:abc123', 'd:abc123:0', 'a:abc123 ', 'a:ab'])
      expect(parseCallback(d)).toBeNull()
  })

  test('redirect index maps back to the same text the button showed', () => {
    const c = card({ tier: 2, label: 'PUSH', preview: 'git push' })
    expect(redirectFor(c, 0)).toBe('Use a new branch instead')
    expect(redirectFor(c, 9)).toBeUndefined()
  })
})

describe('T3 approval word', () => {
  test('uses the card token when there is one', () => {
    expect(approveWord({ token: 'main' })).toBe('main')
  })
  test('falls back to a word when there is none', () => {
    expect(approveWord({}, () => 0)).toBe('amber')
    expect(approveWord({ token: '  ' }, () => 0.99)).toBe('juniper')
  })
  test('matching ignores case and surrounding space only', () => {
    expect(matchesWord('  Main ', 'main')).toBe(true)
    expect(matchesWord('yes main', 'main')).toBe(false)
    expect(matchesWord('mai', 'main')).toBe(false)
  })
})

describe('outcomes and receipts', () => {
  test('outcome lines', () => {
    expect(outcomeLine({ behavior: 'allow', source: 'glasses' })).toBe('<b>Allowed on the glasses.</b>')
    expect(outcomeLine({ behavior: 'deny', redirect: 'a<b', source: 'telegram' })).toBe('<b>Denied on Telegram, said "a&lt;b".</b>')
    expect(outcomeLine('desk')).toContain('desk')
  })
  test('receipt names what, where and how', () => {
    const r = receipt(card(), { behavior: 'deny', redirect: 'Use a new branch instead', source: 'glasses' })
    expect(r).toContain('⛔ Denied · <b>api</b> · DESTRUCTIVE')
    expect(r).toContain('<pre>git push --force origin main</pre>')
    expect(r).toContain('From the glasses')
    expect(r).toContain('Said: "Use a new branch instead"')
  })
})

test('esc handles the three HTML specials', () => {
  expect(esc('<a href="x">&</a>')).toBe('&lt;a href="x"&gt;&amp;&lt;/a&gt;')
})

test('webhook secret is stable, hex and within Telegram\'s allowed characters', async () => {
  const a = await webhookSecret('123:abc')
  expect(a).toBe(await webhookSecret('123:abc'))
  expect(a).not.toBe(await webhookSecret('123:abd'))
  expect(a).toMatch(/^[0-9a-f]{64}$/)
})
