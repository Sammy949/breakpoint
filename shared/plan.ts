// Summarise a Claude Code plan (ExitPlanMode's markdown) for a 576x288 card:
// a title and up to three key steps. Deterministic, no model.

export type PlanSummary = { title: string; steps: string[]; more: number }

const MAX_TITLE = 56
const MAX_STEP = 64

/** Drop markdown decoration so the text reads plainly on the glasses. */
export function plain(s: string): string {
  return s
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1') // links and images -> text
    .replace(/`([^`]*)`/g, '$1')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/(^|\W)[*_]([^*_\n]+)[*_](?=\W|$)/g, '$1$2')
    .replace(/\s+/g, ' ')
    .trim()
}

function clamp(s: string, max: number) {
  return s.length > max ? s.slice(0, max - 1).trimEnd() + '…' : s
}

const STEP_HEADING = /\b(steps?|changes?|implementation|approach|plan|what i'?ll do|tasks?)\b/i
const SKIP_HEADING = /\b(context|background|verification|verify|testing|tests?|notes?|risks?|out of scope|summary|why)\b/i

export function summarisePlan(markdown: string): PlanSummary {
  const lines = markdown.replace(/\r/g, '').split('\n')
  let title = ''
  type Item = { text: string; numbered: boolean; section: 'steps' | 'skip' | 'other'; indent: number }
  const items: Item[] = []
  let section: Item['section'] = 'other'
  let inCode = false

  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      inCode = !inCode
      continue
    }
    if (inCode) continue
    const heading = line.match(/^\s*#{1,6}\s+(.*)$/)
    if (heading) {
      const text = plain(heading[1])
      if (!title) title = text.replace(/^plan\s*[:\-–]\s*/i, '')
      else section = SKIP_HEADING.test(text) ? 'skip' : STEP_HEADING.test(text) ? 'steps' : 'other'
      continue
    }
    const item = line.match(/^(\s*)(\d+[.)]|[-*+])\s+(.*)$/)
    if (item) {
      const text = plain(item[3])
      if (text) items.push({ text, numbered: /\d/.test(item[2]), section, indent: item[1].length })
    }
  }

  // Top-level items only. Prefer a steps section, then any non-skipped
  // section, then whatever there is. Within that, numbered items win.
  const top = items.filter(i => i.indent === 0)
  const pools = [top.filter(i => i.section === 'steps'), top.filter(i => i.section !== 'skip'), top]
  const pool = pools.find(p => p.length) ?? []
  const numbered = pool.filter(i => i.numbered)
  const chosen = numbered.length ? numbered : pool

  if (!title) {
    const firstText = lines.map(l => plain(l)).find(l => l && !/^(\d+[.)]|[-*+])\s/.test(l))
    title = firstText ?? 'Plan'
  }

  return {
    title: clamp(title, MAX_TITLE),
    steps: chosen.slice(0, 3).map(i => clamp(i.text.replace(/^step\s*\d+\s*[:.\-–]\s*/i, ''), MAX_STEP)),
    more: Math.max(0, chosen.length - 3),
  }
}
