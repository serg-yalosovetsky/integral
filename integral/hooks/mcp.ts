// MCP section, pure parts (carried over from mcp-doctor): which servers are broken.
//   Status comes from ToolSearch (`pending_mcp_servers`, `failed_mcp_servers`, any query, no prompt)
//   and tool.list (a server needing OAuth exposes `mcp__<srv>__authenticate`).
import type { Failed, Report } from '../types'

export const GRACE_MS = 60_000 // pending is not a problem this long after session start
export const MCP_HEAD = 'MCP  ' // the row's head when no limit bars stand before the items

export type Kind = 'failed' | 'auth' | 'pending'
export type Problem = {
  kind: Kind
  name: string // what /mcp reconnect takes (failed, pending) or the tool-name segment (auth)
  label: string // what the row shows
  action: 'reconnect' | 'auth'
  detail?: string
}

export const MCP_GLYPH: Record<Kind, string> = { failed: '✕', auth: '🔑', pending: '…' }
export const MCP_COLOR: Record<Kind, string> = { failed: 'error', auth: 'warning', pending: 'warning' }

// ToolSearch's `result`: the two server lists, whatever else it carries.
export function parseSearch(result: unknown): { pending: string[]; failed: Failed[] } {
  const r = (result ?? {}) as { pending_mcp_servers?: unknown; failed_mcp_servers?: unknown }
  const pending = Array.isArray(r.pending_mcp_servers) ? r.pending_mcp_servers.filter((s): s is string => typeof s === 'string') : []
  const failed: Failed[] = []
  if (Array.isArray(r.failed_mcp_servers)) {
    for (const f of r.failed_mcp_servers) {
      if (f && typeof f === 'object' && typeof (f as Failed).name === 'string') {
        const x = f as Failed
        failed.push({ name: x.name, ...(typeof x.errorCode === 'string' ? { errorCode: x.errorCode } : {}), ...(typeof x.error === 'string' ? { error: x.error } : {}) })
      }
    }
  }
  return { pending, failed }
}

// tool.list: servers with tools, and those whose `authenticate` tool says they wait for a login.
export function parseTools(tools: readonly { name: string; mcp: boolean }[]): { connected: string[]; needsAuth: string[] } {
  const servers = new Set<string>()
  const auth = new Set<string>()
  for (const t of tools) {
    const m = /^mcp__(.+?)__(.+)$/.exec(t.name)
    if (!t.mcp || !m) continue
    servers.add(m[1]!)
    if (m[2] === 'authenticate') auth.add(m[1]!)
  }
  return { connected: [...servers].filter(s => !auth.has(s)).sort(), needsAuth: [...auth].sort() }
}

// The tool-name segment for a configured name: `claude.ai Gmail` -> `claude_ai_Gmail`.
export function segment(name: string) {
  return name.replace(/[^A-Za-z0-9_-]/g, '_')
}

// What the row calls a server: `plugin_design_figma` -> `figma`.
export function shortName(name: string) {
  const m = /^plugin_[^_]+_(.+)$/.exec(name)
  return m ? m[1]! : name
}

// A tool-name segment back to a name /mcp reconnect may know: `plugin_design_figma` -> `plugin:design:figma`.
export function reconnectName(seg: string) {
  const m = /^plugin_([^_]+)_(.+)$/.exec(seg)
  return m ? `plugin:${m[1]}:${m[2]}` : seg
}

// Servers bundled by plugins synced from claude.ai (design, engineering, productivity, common-room):
// OAuth connectors to SaaS Serg does not use, forever "needs authentication". Not his problems to show.
const IGNORED = /^plugin[_:](design|engineering|productivity|common-room)[_:]/

export function isIgnored(name: string) {
  return IGNORED.test(name)
}

export function problemsOf(r: Report | null, now: number, started: number): Problem[] {
  if (!r) return []
  r = { ...r, failed: r.failed.filter(f => !isIgnored(f.name)), needsAuth: r.needsAuth.filter(s => !isIgnored(s)), pending: r.pending.filter(p => !isIgnored(p)) }
  const out: Problem[] = []
  const failedSeg = new Set(r.failed.map(f => segment(f.name)))
  for (const f of r.failed) out.push({ kind: 'failed', name: f.name, label: f.name, action: 'reconnect', detail: [f.errorCode, f.error].filter(Boolean).join(': ') || undefined })
  for (const s of r.needsAuth) if (!failedSeg.has(s)) out.push({ kind: 'auth', name: s, label: shortName(s), action: 'auth' })
  if (now - started >= GRACE_MS) for (const p of r.pending) out.push({ kind: 'pending', name: p, label: p, action: 'reconnect', detail: 'still connecting' })
  return out
}

// Cells one row item takes: glyph (🔑 draws two cells), name, action, an armed reconnect, the gap after it.
export function itemWidth(p: Problem, opened: readonly string[] = []) {
  const glyph = p.kind === 'auth' ? 2 : 1
  const again = p.kind === 'auth' && opened.includes(p.name) ? 1 + 'reconnect'.length : 0
  return glyph + 1 + p.label.length + 1 + p.action.length + again + 3
}

// The items fill `columns` after `head` cells: as many problems as fit, the rest fold into +N.
// The first one always shows, however narrow.
export function fold(problems: readonly Problem[], columns = 80, opened: readonly string[] = [], head = MCP_HEAD.length): { shown: Problem[]; more: number } {
  const tail = 1 + String(problems.length).length // the +N button
  let used = head
  let n = 0
  for (const p of problems) {
    const w = itemWidth(p, opened)
    const room = n + 1 < problems.length ? columns - tail : columns // the last one needs no +N after it
    if (n > 0 && used + w > room) break
    used += w
    n++
  }
  return { shown: problems.slice(0, n), more: problems.length - n }
}

// The first https:// URL in an authenticate answer, or what was found instead.
export function findUrl(text: string): { url?: string; insecure?: string } {
  const m = /\bhttps?:\/\/[^\s"'<>`)\]]+/i.exec(text)
  if (!m) return {}
  const url = m[0].replace(/[.,;]+$/, '')
  return /^https:\/\//i.test(url) ? { url } : { insecure: url }
}

// A reconnect answer that says it did not run.
export function isRefusal(text: string | undefined) {
  if (!text || !text.trim()) return true
  return /not (available|supported)|unknown command|isn't available|cannot|can't|only in|interactive|failed|error/i.test(text)
}

export function summary(r: Report | null, now: number, started: number): string {
  if (!r) return 'MCP: no check yet. /integral mcp check checks now.'
  const t = new Date(r.checkedAt).toTimeString().slice(0, 8)
  const inGrace = now - started < GRACE_MS
  const auth = r.needsAuth
  const lines = [`MCP: ${r.connected.length} connected, ${r.failed.length} failed, ${auth.length} need auth, ${r.pending.length} pending (checked ${t})`]
  for (const f of r.failed) lines.push(`  ✕ ${f.name}${f.errorCode ? `  [${f.errorCode}]` : ''}${f.error ? `  ${f.error}` : ''}`)
  for (const s of auth) lines.push(`  🔑 ${shortName(s)}  (${s}) needs a login: press auth in the row`)
  if (r.pending.length) lines.push(`  … pending${inGrace ? ' (session start, not counted yet)' : ''}: ${r.pending.join(', ')}`)
  if (r.connected.length) lines.push(`  ✓ ${r.connected.join(', ')}`)
  return lines.join('\n')
}
