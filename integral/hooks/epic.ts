// Plan row's second source, pure parts: an epic of the mesh tracker (MCP `tasks`, task_get).
//   task_get answers JSON in a text block: {"n":1556,"title":"…","kind":"epic","body":"…- [ ] #1599 …- [x] #1590 …"}.
//   Progress = the `- [x]` items over all checklist items of the body.
import type { Epic } from '../types'
import type { Part } from './context'

export const TASKS_SERVER = 'tasks'
export const TASKS_PREFIX = 'mcp__tasks__'

/** `- [x]` and `- [ ]` items of a body: done and total; no checklist is 0/0. */
export function checklist(body: unknown): { done: number; total: number } {
  const text = typeof body === 'string' ? body : ''
  let done = 0
  let total = 0
  for (const m of text.matchAll(/^\s*[-*] \[([ xX])\]/gm)) {
    total++
    if (m[1] !== ' ') done++
  }
  return { done, total }
}

/** The text of an MCP result: its text blocks joined; a string as is. */
export function textOf(v: unknown): string {
  if (typeof v === 'string') return v
  const blocks = Array.isArray(v) ? v : Array.isArray((v as { content?: unknown })?.content) ? (v as { content: unknown[] }).content : []
  return blocks.map(b => (typeof (b as { text?: unknown })?.text === 'string' ? (b as { text: string }).text : '')).join('')
}

export type TaskInfo = { n: number; title: string; kind: string; done: number; total: number }

/** task_get's answer, parsed; null when it is not a task (an error text, broken JSON). */
export function parseTask(text: string): TaskInfo | null {
  let o: Record<string, unknown>
  try {
    o = JSON.parse(text) as Record<string, unknown>
  } catch {
    return null // not JSON: an error message from the server; the caller logs what it asked for
  }
  const n = typeof o?.n === 'number' ? o.n : NaN
  if (!Number.isInteger(n) || n <= 0) return null
  const title = typeof o.title === 'string' ? o.title.replace(/\s+/g, ' ').trim() : ''
  return { n, title, kind: typeof o.kind === 'string' ? o.kind : '', ...checklist(o.body) }
}

/** `#1556`, `1556` or 1556 as an issue number; anything else is null. */
export function issueNumber(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^#?\d+$/.test(v.trim()) ? Number(v.trim().replace('#', '')) : NaN
  return Number.isInteger(n) && n > 0 ? n : null
}

/** The epic with fresh data from task_get, keeping who set it. */
export function withInfo(epic: Epic, info: TaskInfo): Epic {
  return { ...epic, title: info.title, done: info.done, total: info.total }
}

export type EpicRow = { mark: string; title: string; bar: Part[]; count: string; ref: string; cells: number }

const GAP = 2

// Row 3 from the epic: `◆ <title>  ━━━━──── 3/11  #1556`, the title cut so the row fits `inner`.
// null when there is nothing to show: no checklist, or every item done.
export function epicRow(epic: Epic, inner: number): EpicRow | null {
  if (!(epic.total > 0) || epic.done >= epic.total) return null
  const mark = '◆ '
  const count = `${epic.done}/${epic.total}`
  let ref = `#${epic.n}`
  let width = Math.max(6, Math.min(30, Math.floor(inner * 0.25)))
  const fixed = () => mark.length + GAP + width + 1 + count.length + (ref ? GAP + ref.length : 0)
  while (fixed() > inner && width > 3) width--
  if (fixed() > inner) ref = ''
  if (fixed() > inner) return null // narrower than the bar and the count
  const room = inner - fixed()
  const full = epic.title || ''
  const title = full.length <= room ? full : room <= 1 ? '' : `${full.slice(0, room - 1)}…`
  const n = Math.round((epic.done / epic.total) * width)
  const bar: Part[] = [{ text: '━'.repeat(n), color: 'success' }, { text: '─'.repeat(width - n), dim: true }].filter(p => p.text !== '')
  // the gap after the title stays even when the title is cut to nothing: the bar never touches the mark
  const cells = mark.length + title.length + GAP + width + 1 + count.length + (ref ? GAP + ref.length : 0)
  return { mark, title, bar, count, ref, cells }
}
