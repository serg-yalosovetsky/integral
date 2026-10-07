// ---- context ----
export type Slice = { name: string; tokens: number; color: string; kind: 'used' | 'free' | 'buffer' }

// One plan window, as $.session.usage() and session.measure report it.
export type Limit = { kind: string; percentUsed: number; resetsAt?: string }

export type Reading = {
  slices: Slice[]
  total: number // tokens in use
  window: number // the window measured against
  percent: number
  compactsAt?: number // where auto-compaction runs, when it is on
}

// ---- MCP ----
// A server that failed to connect, as ToolSearch reports it in `failed_mcp_servers`.
export type Failed = { name: string; errorCode?: string; error?: string }

// One look at the MCP servers.
export type Report = {
  checkedAt: number // clock.now() of the check
  connected: string[] // servers with tools, by their tool-name segment (`mesh-ops`, `claude_ai_Gmail`)
  failed: Failed[] // by their configured name (`coord`)
  needsAuth: string[] // tool-name segment of servers that expose only `authenticate` (`plugin_design_figma`)
  pending: string[] // still connecting, by configured name
}

// ---- plan ----
export type ItemStatus = 'pending' | 'in_progress' | 'completed'

// One task of the plan: its title, the words it shows while it runs, where it stands.
export type Item = { id: string; title: string; active: string; status: ItemStatus }

// The open plan: from TodoWrite (the whole list each call) or TaskCreate/TaskUpdate (one task a call).
export type Board = { source: 'todo' | 'task'; items: Item[] }

declare module 'claude-code' {
  interface PluginState {
    integral: {
      reading: Reading | null
      isHidden: boolean
      isExpanded: boolean
      limits: Limit[]
      tick: number
      picked: string | null
      report: Report | null
      isMcpExpanded: boolean
      startedAt: number
      authOpened: string[]
      board: Board | null
      isPlanHidden: boolean
    }
  }
}
