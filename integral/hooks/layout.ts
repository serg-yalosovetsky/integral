// Row 2's layout, pure: the limit bars and the MCP items sharing one row of `inner` cells.
import type { Limit } from '../types'
import { SPLIT } from './context'
import type { Part } from './context'
import { barsWidth, limitBars, liveLimits } from './limits'
import { MCP_HEAD, fold, itemWidth } from './mcp'
import type { Problem } from './mcp'

export type StatusLayout = {
  bars: Part[] | null // the limit bars; null off a subscription
  shown: Problem[] // MCP items named in the row
  more: number // MCP items folded into +N
  head: boolean // `MCP  ` before the items (no bars before them)
  cells: number // the cells the row takes, for the width check
}

// No MCP problems: the bars share the whole row. Problems: the bars take ~45% on the left
// (each at least MIN_BAR), the items fill the rest and fold into +N. No bars: the items alone.
export function statusLayout(limits: readonly Limit[], problems: readonly Problem[], now: number, inner: number, opened: readonly string[] = []): StatusLayout | null {
  const hasMcp = problems.length > 0
  const n = liveLimits(limits, now).length
  const bars = limitBars(limits, now, barsWidth(n, inner, hasMcp))
  if (!bars && !hasMcp) return null
  const barCells = bars ? bars.reduce((k, p) => k + p.text.length, 0) : 0
  if (!hasMcp) return { bars, shown: [], more: 0, head: false, cells: barCells }
  const head = !bars
  const offset = bars ? barCells + SPLIT.length : 0
  const { shown, more } = fold(problems, inner - offset, opened, head ? MCP_HEAD.length : 0)
  const cells = offset + (head ? MCP_HEAD.length : 0) + shown.reduce((k, p) => k + itemWidth(p, opened), 0) + (more > 0 ? 1 + String(more).length : 0)
  return { bars, shown, more, head, cells }
}
