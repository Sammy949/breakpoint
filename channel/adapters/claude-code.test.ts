// Proves the Claude Code adapter changed nothing. fixtures/claude-code-golden.json
// was recorded by running hook.ts and activity.ts as they were before the
// adapter refactor (commit 1c00030) against a stub relay, using the inputs in
// cases.ts. These tests run the current scripts the same way and compare bytes.

import { beforeAll, describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import golden from './fixtures/claude-code-golden.json'
import { activityInputs, permissionInputs, polls } from './cases'
import { runHook, type Run } from './harness'
import { claudeCode } from './claude-code'
import { selectAdapter } from '.'

const channel = join(import.meta.dir, '..')
const goldenHook = golden.hook as Record<string, Run>
const goldenActivity = golden.activity as Record<string, Run>

const hookRuns: Record<string, Run> = {}
const defaultRuns: Record<string, Run> = {}
const activityRuns: Record<string, Run> = {}

beforeAll(async () => {
  const jobs: Promise<void>[] = []
  for (const [i, input] of Object.entries(permissionInputs))
    for (const [p, poll] of Object.entries(polls)) {
      const stdin = JSON.stringify(input)
      jobs.push(runHook(join(channel, 'hook.ts'), stdin, poll, ['--agent', 'claude-code']).then(r => void (hookRuns[`${i}/${p}`] = r)))
      jobs.push(runHook(join(channel, 'hook.ts'), stdin, poll).then(r => void (defaultRuns[`${i}/${p}`] = r)))
    }
  for (const [i, input] of Object.entries(activityInputs))
    jobs.push(runHook(join(channel, 'activity.ts'), JSON.stringify(input), null, ['--agent', 'claude-code']).then(r => void (activityRuns[i] = r)))
  await Promise.all(jobs)
}, 30_000)

const withAgent = (posted: unknown[]) => posted.map(b => ({ ...(b as object), agent: 'claude-code' }))

describe('hook.ts output is byte-identical to before the refactor', () => {
  for (const name of Object.keys(goldenHook)) {
    test(name, () => {
      const before = goldenHook[name]
      for (const run of [hookRuns[name], defaultRuns[name]]) {
        expect(run.stdout).toBe(before.stdout)
        expect(run.code).toBe(before.code)
        // The relay message is unchanged apart from the new agent field.
        expect(run.posted).toEqual(withAgent(before.posted))
      }
    })
  }

  test('covers every output branch', () => {
    const outs = Object.values(goldenHook).map(r => r.stdout)
    expect(outs.some(o => o.includes('"updatedInput"'))).toBe(true)
    expect(outs.some(o => o.includes('rejected the plan'))).toBe(true)
    expect(outs.some(o => o.includes('and said:'))).toBe(true)
    expect(outs.some(o => o.includes('{"behavior":"allow"}'))).toBe(true)
    expect(outs.filter(o => o === '').length).toBeGreaterThan(0)
  })
})

describe('activity.ts sends the same clears as before', () => {
  for (const name of Object.keys(goldenActivity)) {
    test(name, () => {
      expect(activityRuns[name].posted).toEqual(goldenActivity[name].posted)
      expect(activityRuns[name].stdout).toBe('')
    })
  }
})

describe('claudeCode adapter', () => {
  test('formatVerdict matches the recorded stdout for every decided case', () => {
    for (const [name, before] of Object.entries(goldenHook)) {
      const [inputName, pollName] = name.split('/')
      const poll = polls[pollName]
      if (poll.status !== 'decided') continue
      const request = claudeCode.parseInput(JSON.stringify(permissionInputs[inputName]))
      const verdict = { behavior: poll.behavior as 'allow' | 'deny', redirect: poll.redirect as string | undefined }
      expect(claudeCode.formatVerdict(verdict, request)).toBe(before.stdout)
    }
  })

  test('plan approval echoes tool_input as updatedInput', () => {
    const request = claudeCode.parseInput(JSON.stringify(permissionInputs.plan))
    const out = JSON.parse(claudeCode.formatVerdict({ behavior: 'allow' }, request))
    expect(out.hookSpecificOutput.decision.updatedInput).toEqual((permissionInputs.plan as any).tool_input)
  })

  test('parseInput fills the agent-agnostic fields', () => {
    const r = claudeCode.parseInput(JSON.stringify(permissionInputs.write))
    expect(r).toMatchObject({ agent: 'claude-code', sessionId: 'sess-1', toolName: 'Write', cwd: '/work/api', path: '/work/api/.env' })
    expect(r.command).toBeUndefined()
    expect(claudeCode.parseInput(JSON.stringify(permissionInputs.bash)).command).toBe('git push --force origin main')
  })

  test('postEventClears returns null without a session', () => {
    expect(claudeCode.postEventClears(JSON.stringify(activityInputs.noSession))).toBeNull()
  })
})

describe('selectAdapter', () => {
  test('defaults to claude-code', () => expect(selectAdapter([]).id).toBe('claude-code'))
  test('reads --agent and --agent=', () => {
    expect(selectAdapter(['--agent', 'claude-code']).id).toBe('claude-code')
    expect(selectAdapter(['--agent=claude-code']).id).toBe('claude-code')
  })
  test('rejects an unknown agent', () => expect(() => selectAdapter(['--agent', 'codex'])).toThrow(/Unknown --agent/))
})
