// Plan limits, pure parts: two bars (5h, 7d), no letters or numbers; the color carries the pace.
import type { Limit } from '../types'
import { SPLIT } from './context'
import type { Part } from './context'

// Top-aligned glyphs, so the bars sit flush under the context bar with no visible gap.
export const LIMIT = { full: '▀', empty: '▔' } as const
export const MIN_BAR = 12 // each bar at least this wide when MCP items share the row
export const BARS_SHARE = 0.45 // the bars' part of the row when MCP items share it

// How long each window runs, to tell how much of it has passed.
const WINDOW_MS: Record<string, number> = { five_hour: 5 * 3_600_000, seven_day: 7 * 24 * 3_600_000 }

export function resetMs(w: Limit) {
  const ms = w.resetsAt ? Date.parse(w.resetsAt) : NaN
  return Number.isFinite(ms) ? ms : 0
}

// The windows still worth drawing: one past its reset waits for a fresh reading.
export function liveLimits(list: readonly Limit[], now: number) {
  return list.filter(w => !(resetMs(w) > 0 && resetMs(w) <= now))
}

// Serg's rule (07.10): the pace is the share used against the share of the window gone, to hundredths.
// ≤1 green, >1 yellow, >2 red, and red once 80% is used; the first 2% of a window reads green.
export function paceColor(w: Limit, now: number): string {
  const used = w.percentUsed
  if (used >= 80) return 'error'
  const span = WINDOW_MS[w.kind]
  const reset = resetMs(w)
  if (!span || reset <= 0) return 'success' // no reset time: only the 80% rule applies
  const gone = 1 - Math.min(Math.max((reset - now) / span, 0), 1)
  if (gone < 0.02) return 'success' // the first minutes: any use reads as a huge pace
  const pace = Math.round((used / (gone * 100)) * 100) / 100
  return pace > 2 ? 'error' : pace > 1 ? 'warning' : 'success'
}

// How wide the bars run in all: the whole row alone, ~45% of it (each at least MIN_BAR) beside MCP items.
export function barsWidth(n: number, inner: number, withMcp: boolean) {
  if (n === 0) return 0
  if (!withMcp) return inner
  return Math.min(inner, Math.max(n * MIN_BAR + SPLIT.length * (n - 1), Math.floor(inner * BARS_SHARE)))
}

// The bars as parts, `total` cells wide at most; null with no live window.
export function limitBars(list: readonly Limit[], now: number, total: number): Part[] | null {
  const live = liveLimits(list, now)
  if (live.length === 0) return null
  const width = Math.max(1, Math.floor((total - SPLIT.length * (live.length - 1)) / live.length))
  const parts: Part[] = []
  live.forEach((w, i) => {
    const full = Math.min(width, Math.round((Math.min(Math.max(w.percentUsed, 0), 100) / 100) * width))
    if (i > 0) parts.push({ text: SPLIT })
    parts.push({ text: LIMIT.full.repeat(full), color: paceColor(w, now) }, { text: LIMIT.empty.repeat(width - full), dim: true })
  })
  return parts.filter(p => p.text !== '')
}
