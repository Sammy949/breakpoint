import { describe, expect, test } from 'bun:test'
import { COMMAND_LINE, wrapPreview } from './render'

const fits = (lines: string[], width = COMMAND_LINE) => lines.every(l => l.length <= width)

describe('wrapPreview', () => {
  test('short commands stay on one line', () => {
    expect(wrapPreview('git push --force origin main')).toEqual(['git push --force origin main'])
  })

  test('breaks at spaces, never mid-word', () => {
    const cmd = 'ts=$(date +%Y%m%d-%H%M%S); mkdir -p backup && mv build "backup/build-$ts"'
    const out = wrapPreview(cmd)
    expect(out.length).toBe(2)
    expect(fits(out)).toBe(true)
    expect(out.join(' ')).toBe(cmd)
  })

  test('long commands keep the start and the last words, around one ellipsis', () => {
    const cmd =
      'ts=$(date +%Y%m%d-%H%M%S); mkdir -p backup && mv build "backup/build-$ts" && ls -la backup "backup/build-$ts"; git status --short'
    const out = wrapPreview(cmd)
    expect(out.length).toBe(2)
    expect(fits(out)).toBe(true)
    expect(out[0].startsWith('ts=$(date')).toBe(true)
    expect(out[1].endsWith('… git status --short')).toBe(true)
    // Every word shown is a whole word from the command.
    const words = new Set(cmd.split(' '))
    for (const w of out.join(' ').split(' ')) if (w !== '…') expect(words.has(w)).toBe(true)
    expect(out.join(' ').split('…').length).toBe(2)
  })

  test('collapses whitespace and newlines', () => {
    expect(wrapPreview('npm   test\n  --watch=false')).toEqual(['npm test --watch=false'])
  })

  test('a word longer than a line is split, the rest still wraps at spaces', () => {
    const path = 'Write /home/user/projects/' + 'a'.repeat(60) + '/file.ts'
    const out = wrapPreview(path)
    expect(out.length).toBeLessThanOrEqual(2)
    expect(fits(out)).toBe(true)
    expect(out[0].startsWith('Write')).toBe(true)
  })

  test('one enormous word keeps its start and its end', () => {
    const word = 'x'.repeat(40) + 'MIDDLE' + 'y'.repeat(100) + 'END'
    const out = wrapPreview(word)
    expect(out.length).toBe(2)
    expect(fits(out)).toBe(true)
    expect(out[0].startsWith('xxxx')).toBe(true)
    expect(out[1].endsWith('END')).toBe(true)
    expect(out.join('')).not.toContain('… …')
  })

  test('respects the line count', () => {
    const cmd = Array.from({ length: 40 }, (_, i) => `word${i}`).join(' ')
    for (const n of [1, 2, 3]) {
      const out = wrapPreview(cmd, n)
      expect(out.length).toBe(n)
      expect(fits(out)).toBe(true)
      expect(out.at(-1)!.endsWith('word39')).toBe(true)
    }
  })
})
