// Context section, pure parts (carried over from context-bar-compact): what fills the window.
import type { Limit, Reading, Slice } from '../types'

export const SPLIT = '   '
// Theme keys, so both the dark and the light theme pick a readable shade. /context's own names
// give several rows the same grey, so each used row gets its own key, in /context's order.
const PALETTE = ['suggestion', 'remember', 'permission', 'success', 'warning', 'planMode', 'ide', 'merged', 'autoAccept']
const MESSAGES = 'claude' // the row that grows, in the accent color
const FREE = '#808080' // a mid grey thin line reads as empty on dark and light themes alike
const BUFFER = '#808080'
export const GLYPH = { used: '█', free: '─', buffer: '░' } as const
const WARN_AT = 0.7 // the compact action lights up from this share of the compaction point
// Cells the three icon buttons take after the percentage: ` >`, ` ●↓` (marker reserved), ` !`.
export const ICONS_WIDTH = 2 + 3 + 2

export type Part = { text: string; color?: string; dim?: boolean; bold?: boolean }

export type ContextRow = {
  bar: Part[] // the bar's runs, the picked one lit and the rest dim
  label: string // what the percentage button says: `37%` or `messages 31%`
  level: string // the level color (success / warning / error)
  hot?: string // the compact button's highlight once near the compaction point
}

export function toReading(b: {
  categories: { name: string; tokens: number; color: string; kind: string }[]
  totalTokens: number
  rawMaxTokens: number
  percentage: number
  autoCompactThreshold?: number
  isAutoCompactEnabled: boolean
}): Reading {
  const slices: Slice[] = b.categories
    .filter(c => c.kind !== 'deferred' && c.tokens > 0)
    .map(c => ({ name: c.name.toLowerCase(), tokens: c.tokens, color: c.color, kind: c.kind as Slice['kind'] }))
  const order = { used: 0, free: 1, buffer: 2 }
  slices.sort((x, y) => order[x.kind] - order[y.kind]) // stable: used rows keep /context's order
  let next = 0
  for (const s of slices) {
    s.color = s.kind === 'free' ? FREE : s.kind === 'buffer' ? BUFFER : s.name === 'messages' ? MESSAGES : PALETTE[next++ % PALETTE.length]!
  }
  return {
    slices,
    total: b.totalTokens,
    window: b.rawMaxTokens,
    percent: b.percentage,
    compactsAt: b.isAutoCompactEnabled ? b.autoCompactThreshold : undefined,
  }
}

export function toLimits(rateLimits: readonly Limit[]): Limit[] {
  if (!Array.isArray(rateLimits)) return [] // off a subscription, or a shape this build does not send
  return rateLimits
    .filter(w => Number.isFinite(w.percentUsed))
    .map(w => ({ kind: w.kind, percentUsed: w.percentUsed, resetsAt: w.resetsAt }))
    .sort((a, b) => rank(a.kind) - rank(b.kind))
}

const LIMIT_ORDER = ['five_hour', 'seven_day', 'spend_limit']
function rank(kind: string) {
  const i = LIMIT_ORDER.indexOf(kind)
  return i < 0 ? LIMIT_ORDER.length : i
}

// Green while there is room, yellow near compaction, red at it.
export function levelColor(r: Reading) {
  const level = r.compactsAt ? r.total / r.compactsAt : r.total / r.window
  return level >= 0.9 ? 'error' : level >= 0.7 ? 'warning' : 'success'
}

// Row 1: the bar on the rest of the width, the percentage (pressable), then the three icons.
// No `370k/1M` text (Serg, 07.10). The bar keeps its width whichever label the percentage shows.
export function contextRow(r: Reading, inner: number, pick: string | null = null): ContextRow {
  const level = levelColor(r)
  const chosen = pick ? r.slices.find(s => s.name === pick) : undefined
  const total = `${r.percent}%`
  const label = chosen ? sliceLabel(r, chosen) : total
  const width = Math.max(4, inner - 1 - labelRoom(r) - ICONS_WIDTH)
  const bar = cells(r, width).map(c => ({ text: c.text, color: c.color, dim: !!chosen && c.name !== chosen.name }))
  const ratio = r.compactsAt ? r.total / r.compactsAt : r.total / r.window
  return { bar, label, level, hot: ratio >= WARN_AT ? level : undefined }
}

// The widest label the percentage button can show: the bar is sized against it.
export function labelRoom(r: Reading) {
  return Math.max(`${r.percent}%`.length, ...usedOf(r).map(s => sliceLabel(r, s).length))
}

// `messages 31%`: what the percentage button says for one consumer.
export function sliceLabel(r: Reading, s: Slice) {
  return `${s.name} ${share(s.tokens, r.window)}`
}

// The next pick: the used consumers, biggest first, then back to none (the total).
export function nextPick(r: Reading, current: string | null): string | null {
  const order = usedOf(r).map(s => s.name)
  const i = current ? order.indexOf(current) : -1
  return i + 1 < order.length ? order[i + 1]! : null
}

export function usedOf(r: Reading) {
  return r.slices.filter(s => s.kind === 'used').sort((a, b) => b.tokens - a.tokens)
}

// One legend line's parts.
export function legendParts(r: Reading, line: Slice[]): Part[] {
  return line.flatMap((s, i) => [
    ...(i > 0 ? [{ text: SPLIT }] : []),
    { text: s.kind === 'used' ? '■ ' : `${GLYPH[s.kind]} `, color: s.color },
    { text: `${s.name} `, dim: s.kind !== 'used' },
    { text: tokens(s.tokens), bold: s.kind === 'used' },
    ...(s.kind === 'used' ? [{ text: ` ${share(s.tokens, r.window)}`, dim: true }] : []),
  ])
}

// The headline of the open legend: totals and where compaction runs.
export function legendHead(r: Reading) {
  return `${tokens(r.total)} of ${tokens(r.window)}${r.compactsAt ? `, compacts at ${tokens(r.compactsAt)}` : ''}`
}

// The bar as runs of cells: each slice gets its share of `width`, a used one at least one cell.
export function cells(r: Reading, width: number) {
  const sizes = r.slices.map(s => Math.max(s.kind === 'used' ? 1 : 0, Math.round((s.tokens / r.window) * width)))
  // Rounding leaves the sum a few cells off: free space takes the difference first, then the largest slices.
  let diff = width - sizes.reduce((a, n) => a + n, 0)
  const isUsed = (i: number) => r.slices[i]!.kind === 'used'
  const order = r.slices.map((_, i) => i).sort((a, b) => Number(isUsed(a)) - Number(isUsed(b)) || sizes[b]! - sizes[a]!)
  for (const i of order) {
    if (diff === 0) break
    const size = Math.max(isUsed(i) ? 1 : 0, sizes[i]! + diff)
    diff -= size - sizes[i]!
    sizes[i] = size
  }
  return r.slices.map((s, i) => ({ name: s.name, color: s.color, kind: s.kind, text: GLYPH[s.kind].repeat(sizes[i]!) })).filter(c => c.text !== '')
}

// The legend, packed into lines no wider than `width`.
export function legend(r: Reading, width: number) {
  const lines: Slice[][] = [[]]
  let used = 0
  for (const s of r.slices) {
    const size = 2 + s.name.length + 1 + tokens(s.tokens).length + (s.kind === 'used' ? 1 + share(s.tokens, r.window).length : 0)
    const line = lines.at(-1)!
    if (line.length > 0 && used + SPLIT.length + size > width) {
      lines.push([s])
      used = size
    } else {
      used += (line.length > 0 ? SPLIT.length : 0) + size
      line.push(s)
    }
  }
  return lines.filter(l => l.length > 0)
}

export function tokens(n: number) {
  if (n >= 1_000_000) return `${+(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`
  if (n >= 10_000) return `${Math.round(n / 1000)}k`
  if (n >= 1000) return `${+(n / 1000).toFixed(1)}k`
  return String(n)
}

export function share(n: number, window: number) {
  const p = (n / window) * 100
  if (p > 0 && p < 0.1) return '<0.1%'
  return `${p >= 10 ? Math.round(p) : +p.toFixed(1)}%`
}
