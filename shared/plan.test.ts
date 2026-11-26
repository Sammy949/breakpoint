import { describe, expect, test } from 'bun:test'
import { plain, summarisePlan } from './plan'

// Real plans written by Claude Code in plan mode on 26 Nov 2026.
const HELLO = `# Plan: hello.txt + existence test

## Context
The repo is empty (no commits, no package.json). We need a \`hello.txt\` with a one-line greeting and a test confirming it exists.

## Steps
1. Create \`hello.txt\` at the repo root containing \`Hello, world!\` plus a trailing newline.
2. Create \`hello.test.ts\` at the repo root:
   \`\`\`ts
   import { test, expect } from "bun:test";
   test("hello.txt exists", () => {});
   \`\`\`
   The path resolves from the test file's directory.

## Verification
- Run \`bun test\`: expect 1 pass.
- Temporarily rename \`hello.txt\` and rerun: expect 1 fail.
- No commit unless asked.
`

const NOTES = `# Add notes.txt

**Context:** The user asked for a \`notes.txt\` file containing one line at the repo root. The repo is empty and its working tree is clean.

1. Create \`notes.txt\` at the repo root with one line. The user didn't give the text, so use \`Notes\` unless they specify something else.
2. Verify with \`wc -l notes.txt\` (expect \`1\`) and \`cat notes.txt\`. Do not commit unless the user asks.
`

const LONG = `# Migrate auth to sessions

## Context
Tokens live in localStorage today.

## Implementation
1. Add a sessions table and a migration.
2. Issue an httpOnly cookie on login.
   - Set SameSite=Lax
   - Rotate on privilege change
3. Replace the token check in middleware.
4. Delete the localStorage code paths.
5. Update the API docs.

## Testing
1. Run the auth test suite.
`

describe('summarisePlan', () => {
  test('takes the title without the "Plan:" prefix', () => {
    expect(summarisePlan(HELLO).title).toBe('hello.txt + existence test')
  })
  test('takes steps from the Steps section, not Verification', () => {
    const s = summarisePlan(HELLO)
    expect(s.steps).toHaveLength(2)
    expect(s.steps[0]).toStartWith('Create hello.txt at the repo root')
    expect(s.steps[1]).toStartWith('Create hello.test.ts')
  })
  test('ignores list-looking lines inside code blocks', () => {
    expect(summarisePlan(HELLO).steps.join(' ')).not.toContain('import')
  })
  test('works when the plan has no section headings', () => {
    const s = summarisePlan(NOTES)
    expect(s.title).toBe('Add notes.txt')
    expect(s.steps).toHaveLength(2)
    expect(s.steps[0]).toStartWith('Create notes.txt')
  })
  test('keeps three top-level steps, counts the rest, skips nested bullets', () => {
    const s = summarisePlan(LONG)
    expect(s.steps).toEqual([
      'Add a sessions table and a migration.',
      'Issue an httpOnly cookie on login.',
      'Replace the token check in middleware.',
    ])
    expect(s.more).toBe(2)
  })
  test('clamps long titles and steps', () => {
    const s = summarisePlan(`# ${'Very long title '.repeat(10)}\n1. ${'word '.repeat(40)}`)
    expect(s.title.length).toBeLessThanOrEqual(56)
    expect(s.steps[0].length).toBeLessThanOrEqual(64)
    expect(s.steps[0]).toEndWith('…')
  })
  test('falls back to the first line when there is no heading', () => {
    expect(summarisePlan('Refactor the parser.\n\n- Split tokens\n- Add tests').title).toBe('Refactor the parser.')
  })
  test('empty plan still gives a title', () => {
    expect(summarisePlan('').title).toBe('Plan')
  })
})

describe('plain', () => {
  test('strips markdown decoration', () => {
    expect(plain('Use **bold**, `code` and [a link](http://x)')).toBe('Use bold, code and a link')
  })
})
