import { describe, expect, mock, test } from 'claude-code/testing'

import { cells, contextRow, legend, levelColor, nextPick, share, sliceLabel, toLimits, toReading, tokens } from '../hooks/context'
import { statusLayout } from '../hooks/layout'
import { limitBars, paceColor } from '../hooks/limits'
import { findUrl, fold, isIgnored, itemWidth, parseSearch, parseTools, problemsOf, reconnectName, shortName, summary } from '../hooks/mcp'
import { addTask, fromTodos, planRow, progress, updateTask } from '../hooks/plan'
import { CHECKPOINT_PROMPT } from '../hooks/register'

const BAND = { component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns: 115 } }
const T0 = Date.parse('2026-10-07T12:00:00Z')

// /context's breakdown as the engine hands it over, for a 1M window; `messages` sets how full it is.
function breakdown(messages: number) {
  const used = 3_900 + 33_000 + 5_000 + 6_700 + 9_900 + messages
  return {
    categories: [
      { name: 'System prompt', tokens: 3_900, color: 'promptBorder', kind: 'used', isDeferred: false },
      { name: 'System tools', tokens: 33_000, color: 'inactive', kind: 'used', isDeferred: false },
      { name: 'Custom agents', tokens: 5_000, color: 'cyan_FOR_SUBAGENTS_ONLY', kind: 'used', isDeferred: false },
      { name: 'Memory files', tokens: 6_700, color: 'inactive', kind: 'used', isDeferred: false },
      { name: 'Skills', tokens: 9_900, color: 'warning', kind: 'used', isDeferred: false },
      { name: 'MCP tools (deferred)', tokens: 40_000, color: 'inactive', kind: 'deferred', isDeferred: true },
      { name: 'Messages', tokens: messages, color: 'purple_FOR_SUBAGENTS_ONLY', kind: 'used', isDeferred: false },
      { name: 'Autocompact buffer', tokens: 33_000, color: 'inactive', kind: 'buffer', isDeferred: false },
      { name: 'Free space', tokens: 1_000_000 - used - 33_000, color: 'promptBorder', kind: 'free', isDeferred: false },
    ],
    totalTokens: used,
    maxTokens: 1_000_000,
    rawMaxTokens: 1_000_000,
    percentage: Math.round(used / 10_000),
    autoCompactThreshold: 967_000,
    isAutoCompactEnabled: true,
  }
}

const SMALL = breakdown(99_000) // 158k, 16%
const BIG = breakdown(400_000) // 459k, 46%
const HOT = breakdown(700_000) // 758k of 967k: past 70% of the compaction point
// Broken data for the context section: a category kind this build does not know makes the bar throw while drawing.
const BROKEN = { ...BIG, categories: BIG.categories.map(c => (c.name === 'Skills' ? { ...c, kind: 'mystery' } : c)) }

const LIMITS = [
  { kind: 'five_hour', percentUsed: 30, resetsAt: '2026-10-07T16:00:00Z' }, // 30% one hour in: 1.5x, yellow
  { kind: 'seven_day', percentUsed: 18, resetsAt: '2026-10-10T16:00:00Z' },
]

// ToolSearch's answer as the mcp-doctor probe saw it (serg/tasks#1558).
const SEARCH_BROKEN = {
  matches: [],
  query: 'select:mcp__mcpdoctor__none',
  total_deferred_tools: 111,
  pending_mcp_servers: ['langfuse'],
  failed_mcp_servers: [
    { name: 'coord', errorCode: 'ECONNREFUSED', error: 'ECONNREFUSED: Unable to connect.' },
    { name: 'spec', errorCode: 'ETIMEDOUT' },
  ],
}
const SEARCH_OK = { matches: [], query: 'select:mcp__mcpdoctor__none', total_deferred_tools: 111, pending_mcp_servers: [], failed_mcp_servers: [] }

const TOOLS_OK = [
  { name: 'Bash', description: '', mcp: false },
  { name: 'mcp__mesh-ops__ops_exec', description: '', mcp: true },
  { name: 'mcp__tasks__task_add', description: '', mcp: true },
]
const TOOLS_AUTH = [
  ...TOOLS_OK,
  { name: 'mcp__plugin_acme_figma__authenticate', description: '', mcp: true },
  { name: 'mcp__plugin_acme_figma__complete_authentication', description: '', mcp: true },
  { name: 'mcp__plugin_acme_linear__authenticate', description: '', mcp: true },
]

type World = { refuse?: string; breakdown: any; rateLimits: any[]; search: unknown; tools: unknown[]; now: number; authText: string; reconnectText: string }

// Stands for the engine beneath the mod; records what the mod asked of it.
function engine(on: any, w: World, store: Record<string, unknown> = {}) {
  const ran: { command: string; args: string }[] = []
  const sent: string[] = []
  const toasts: string[] = []
  const logs: string[] = []
  const opened: string[][] = []
  const called: string[] = []
  let taskId = 0
  on('session.start', (_$: any, e: any) => ({ sessionId: 's', cwd: e.cwd }))
  on('command.register', () => ({ value: undefined }))
  on('turn.complete', () => ({ text: '' }))
  on('store.get', (_$: any, e: any) => ({ value: store[e.key] }))
  on('store.set', (_$: any, e: any) => ((store[e.key] = e.value), { value: undefined }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: w.breakdown.totalTokens, window: 1_000_000, percent: w.breakdown.percentage, breakdown: w.breakdown }, rateLimits: w.rateLimits, cost: { usd: 0 } } }))
  const clock = mock.clock(on, { now: w.now }) // waits are held until a test moves the clock
  on('tool.list', () => ({ value: w.tools }))
  on('ui.toast', (_$: any, e: any) => (toasts.push(e.text), { value: undefined }))
  on('ui.log', (_$: any, e: any) => (logs.push(e.text ?? e.message ?? JSON.stringify(e)), { value: undefined }))
  on('process.run', (_$: any, e: any) => (opened.push([...e.argv]), { value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('tool.call', (_$: any, e: any) => {
    called.push(e.tool)
    if (w.refuse === e.tool) return { result: 'Task not found', text: 'Task not found', isError: true }
    if (e.tool === 'ToolSearch') return { result: w.search, text: '' }
    if (String(e.tool).endsWith('__authenticate')) return { result: w.authText, text: w.authText }
    if (e.tool === 'mcp__coord__coord_list') return { result: 'boom', text: 'boom', isError: true }
    if (e.tool === 'TodoWrite') return { result: { oldTodos: [], newTodos: e.todos }, text: 'ok' }
    if (e.tool === 'TaskCreate') return { result: { task: { id: String(++taskId), subject: e.subject } }, text: 'ok' }
    if (e.tool === 'TaskUpdate') return { result: { success: true, taskId: e.taskId, updatedFields: ['status'] }, text: 'ok' }
    return { result: 'x', text: 'x' }
  })
  on('command.run', (_$: any, e: any) => (ran.push({ command: e.command, args: e.args }), { text: w.reconnectText }))
  on('prompt.submit', (_$: any, e: any) => (sent.push(e.text), { text: e.text }))
  on('ui.render', ($: any, e: any) => $.ui.resolve(e).Text({ children: 'band below' }))
  return { store, ran, sent, toasts, logs, opened, called, clock }
}

const settle = () => new Promise(done => (globalThis as any).setTimeout(done, 20)) // background work at start

async function started($: any, on: any, w: Partial<World> = {}) {
  const world: World = { breakdown: BIG, rateLimits: [], search: SEARCH_OK, tools: TOOLS_OK, now: T0, authText: '', reconnectText: 'Reconnected to coord.', ...w }
  const rec = engine(on, world)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' } as any)
  await settle()
  return { world, ...rec }
}

const mount = ($: any, bodyColumns = 115, extra: Record<string, unknown> = {}) =>
  $.ui.mount({ plugin: 'integral', surface: 'terminal', ...BAND, props: { ...BAND.props, bodyColumns, ...extra } } as any)

// Every Text on the band, as one string per Text.
async function texts(band: any): Promise<string[]> {
  const all = (await band.findAll({ type: 'Text' })) as any[]
  return all.map(t => (typeof t.props?.children === 'string' ? t.props.children : typeof t.text === 'string' ? t.text : ''))
}

const todo = (content: string, status: 'pending' | 'in_progress' | 'completed') => ({ content, status, activeForm: `${content}…` })
const seven = (done: number) => Array.from({ length: 7 }, (_, i) => todo(`step ${i + 1}`, i < done ? 'completed' : i === done ? 'in_progress' : 'pending'))

describe('integral: context (from context-bar-compact)', () => {
  test('helpers', () => {
    expect(tokens(3_400)).toBe('3.4k')
    expect(tokens(1_000_000)).toBe('1M')
    expect(share(186_000, 1_000_000)).toBe('19%')
    const r = toReading(BIG)
    expect(r.slices.map(s => s.name)).toEqual(['system prompt', 'system tools', 'custom agents', 'memory files', 'skills', 'messages', 'free space', 'autocompact buffer'])
    expect(levelColor(r)).toBe('success')
    expect(levelColor({ ...r, total: 900_000 })).toBe('error')
    for (const width of [20, 47, 80, 200]) expect(cells(r, width).reduce((n, c) => n + c.text.length, 0)).toBe(width)
    for (const line of legend(r, 40)) expect(line.length >= 1).toBe(true)
  })

  test('row 1: the bar, the percentage, no `k/1M`; fits the width', () => {
    for (const inner of [40, 80, 115]) {
      const row = contextRow(toReading(SMALL), inner)
      const bar = row.bar.map(p => p.text).join('')
      expect(bar).toMatch(/^█+─+░*$/)
      expect(row.label).toBe('16%')
      // bar + space + widest label + icons never run past the width
      expect(bar.length + 1 + 'custom agents 0.5%'.length + 7).toBeLessThanOrEqual(inner + 4)
      expect(JSON.stringify(row)).not.toMatch(/k\/1M/)
    }
    const used = contextRow(toReading(SMALL), 115).bar.filter(p => p.text.startsWith('█')).map(p => p.color)
    expect(new Set(used).size).toBe(used.length) // each consumer keeps its own color
    expect(contextRow(toReading(BIG), 115).hot).toBeUndefined()
    expect(contextRow(toReading(HOT), 115).hot).toBe('warning')
    expect(contextRow({ ...toReading(HOT), total: 900_000 }, 115).hot).toBe('error')
  })

  test('the percentage cycles through consumers, biggest first, lighting each run; the bar keeps its width', () => {
    const r = toReading(BIG)
    expect(nextPick(r, null)).toBe('messages')
    expect(nextPick(r, 'messages')).toBe('system tools')
    let p: string | null = null
    const seen: string[] = []
    for (let i = 0; i < 10 && (p = nextPick(r, p)); i++) seen.push(p)
    expect(seen.length).toBe(6) // every used consumer once, then back to the total
    const row = contextRow(r, 115, 'messages')
    expect(row.label).toBe(sliceLabel(r, r.slices.find(s => s.name === 'messages')!))
    expect(row.label).toBe('messages 40%')
    expect(row.bar.filter(p => p.text.startsWith('█') && !p.dim).length).toBe(1)
    const width = (x: ReturnType<typeof contextRow>) => x.bar.reduce((n, p) => n + p.text.length, 0)
    for (const name of seen) expect(width(contextRow(r, 115, name))).toBe(width(contextRow(r, 115)))
  })

  test('mounted: row 1 has no k/1M, the three icons, and the percentage button', async ($, on) => {
    await started($, on)
    const band = await mount($)
    const all = (await texts(band)).join('|')
    expect(all).not.toMatch(/k\/1M/)
    expect(await band.find({ type: 'Button', label: '46%' })).toBeDefined()
    expect(await band.find({ type: 'Button', label: '>' })).toBeDefined()
    expect(await band.find({ type: 'Button', label: '↓' })).toBeDefined()
    expect(await band.find({ type: 'Button', label: '!' })).toBeDefined()
    expect(await band.find({ type: 'Text', text: /^messages $/ })).toBeUndefined() // no legend while closed
    expect(await band.find({ type: 'Text', text: 'band below' })).toBeDefined()
    await band.unmount()
  })

  test('mounted: pressing the percentage cycles names and comes back to the total', async ($, on) => {
    await started($, on)
    const band = await mount($)
    const labels: string[] = []
    for (let i = 0; i < 7; i++) {
      await band.press({ key: 'pct' })
      labels.push(((await band.find({ key: 'pct' })) as any).props.label)
    }
    expect(labels[0]).toBe('messages 40%')
    expect(labels[1]).toBe('system tools 3.3%')
    expect(labels[6]).toBe('46%')
    await band.unmount()
  })

  test('mounted: > opens the legend, < closes it', async ($, on) => {
    await started($, on)
    const band = await mount($)
    await band.press({ key: 'legend' })
    expect(await band.find({ type: 'Text', text: /^autocompact buffer $/ })).toBeDefined()
    expect(await band.find({ type: 'Button', label: '<' })).toBeDefined()
    await band.press({ key: 'legend' })
    expect(await band.find({ type: 'Text', text: /^autocompact buffer $/ })).toBeUndefined()
    await band.unmount()
  })

  test('mounted: ↓ runs the built-in /compact, ! sends the checkpoint constant', async ($, on) => {
    const { ran, sent } = await started($, on)
    const band = await mount($)
    await band.press({ key: 'compact' })
    expect(ran.map(r => r.command)).toEqual(['compact'])
    expect(sent).toEqual([])
    await band.press({ key: 'checkpoint' })
    expect(sent).toEqual([CHECKPOINT_PROMPT])
    await band.unmount()
  })

  test('mounted: while a turn runs the icons are dim text, not buttons', async ($, on) => {
    await started($, on)
    const band = await mount($, 115, { isWorking: true })
    for (const key of ['legend', 'compact', 'checkpoint']) expect(await band.find({ key })).toBeUndefined()
    expect(await band.find({ type: 'Text', text: '↓' })).toBeDefined()
    expect(await band.find({ type: 'Text', text: '!' })).toBeDefined()
    await band.unmount()
  })

  test('/integral hides and shows it all and remembers; /integral more opens the legend', async ($, on) => {
    const { store } = await started($, on)
    expect((await $.command.run({ command: 'integral', args: 'more' } as any)).text).toMatch(/legend/)
    let band = await mount($)
    expect(await band.find({ type: 'Text', text: /^free space $/ })).toBeDefined()
    await band.unmount()
    expect((await $.command.run({ command: 'integral', args: '' } as any)).text).toMatch(/hidden/)
    expect(store.isHidden).toBe(true)
    band = await mount($)
    expect(await band.find({ key: 'pct' })).toBeUndefined()
    await band.unmount()
  })
})

describe('integral: limits', () => {
  test('pace color: used against the share of the window gone', () => {
    const fiveH = (used: number, hoursLeft: number) => ({ kind: 'five_hour', percentUsed: used, resetsAt: new Date(T0 + hoursLeft * 3_600_000).toISOString() })
    expect(paceColor(fiveH(20, 4), T0)).toBe('success') // 20% in the first hour: on pace
    expect(paceColor(fiveH(30, 4), T0)).toBe('warning') // 1.5x
    expect(paceColor(fiveH(41, 4), T0)).toBe('error') // over twice the pace
    expect(paceColor(fiveH(80, 0.5), T0)).toBe('error') // 80% used, whatever the pace
    expect(paceColor(fiveH(50, 1), T0)).toBe('success') // under pace
    expect(paceColor(fiveH(5, 4.95), T0)).toBe('success') // the first 2% of the window
  })

  test('row 2 without MCP problems: only the two bars, sharing the whole width', () => {
    const lim = toLimits(LIMITS as any)
    for (const inner of [40, 80, 115]) {
      const l = statusLayout(lim, [], T0, inner)!
      const line = l.bars!.map(p => p.text).join('')
      expect(line).toMatch(/^▀+▔*   ▀+▔+$/)
      expect(line.length).toBeLessThanOrEqual(inner)
      expect(line.length).toBeGreaterThan(inner - 3)
    }
    expect(statusLayout(lim, [], T0, 80)!.bars![0]!.color).toBe('warning')
    expect(limitBars(toLimits([{ kind: 'five_hour', percentUsed: 50, resetsAt: '2026-10-07T11:00:00Z' }]), T0, 80)).toBeNull() // past its reset
    expect(statusLayout([], [], T0, 80)).toBeNull() // no subscription, no problems: no row
  })

  test('row 2 with MCP problems: bars on the left (≥12 each), MCP on the right, all within the width', () => {
    const lim = toLimits(LIMITS as any)
    const r = { checkedAt: T0, connected: ['tasks'], failed: parseSearch(SEARCH_BROKEN).failed, needsAuth: ['plugin_acme_figma'], pending: ['langfuse'] }
    const problems = problemsOf(r, T0 + 61_000, T0)
    for (const inner of [60, 80, 115, 200]) {
      const l = statusLayout(lim, problems, T0, inner)!
      const bars = l.bars!.map(p => p.text).join('')
      expect(bars).toMatch(/^▀+▔*   ▀+▔+$/)
      for (const one of bars.split('   ')) expect(one.length).toBeGreaterThanOrEqual(12)
      expect(bars.length).toBeLessThanOrEqual(Math.max(27, Math.floor(inner * 0.45)))
      expect(l.shown.length).toBeGreaterThan(0)
      expect(l.cells).toBeLessThanOrEqual(inner)
      expect(l.head).toBe(false)
    }
    expect(statusLayout(lim, problems, T0, 200)!.more).toBe(0)
    expect(statusLayout(lim, problems, T0, 60)!.more).toBeGreaterThan(0)
    const alone = statusLayout([], problems, T0, 115)! // no subscription: MCP alone, with its head
    expect(alone.bars).toBeNull()
    expect(alone.head).toBe(true)
  })

  test('mounted: limits and MCP on one row; +N opens the full list, less closes it', async ($, on) => {
    await started($, on, { rateLimits: LIMITS, search: SEARCH_BROKEN, tools: TOOLS_AUTH })
    const band = await mount($, 80)
    expect(await band.find({ type: 'Text', text: /^▀+$/ })).toBeDefined()
    expect(await band.find({ key: 'reconnect:coord' })).toBeDefined()
    expect(await band.find({ type: 'Text', text: 'MCP  ' })).toBeUndefined() // the bars stand before the items
    expect(await band.find({ key: 'mcp-more' })).toBeDefined()
    await band.press({ key: 'mcp-more' })
    expect(await band.find({ key: 'auth:plugin_acme_linear' })).toBeDefined()
    expect(await band.find({ key: 'mcp-less' })).toBeDefined()
    await band.press({ key: 'mcp-less' })
    expect(await band.find({ key: 'auth:plugin_acme_linear' })).toBeUndefined()
    await band.unmount()
  })

  test('mounted: a section that throws is left out, the others still draw', async ($, on) => {
    const { logs } = await started($, on, { breakdown: BROKEN, rateLimits: LIMITS })
    await $.tool.call({ tool: 'TodoWrite', todos: seven(2) } as any)
    const band = await mount($)
    expect(await band.find({ key: 'pct' })).toBeUndefined() // the context row threw
    expect(await band.find({ type: 'Text', text: /^▀+$/ })).toBeDefined() // limits still drawn
    expect(await band.find({ type: 'Text', text: '2/7' })).toBeDefined() // plan still drawn
    expect(await band.find({ type: 'Text', text: 'band below' })).toBeDefined()
    expect(logs.some(l => /integral: render context/.test(l))).toBe(true)
    await band.unmount()
  })
})

describe('integral: MCP (from mcp-doctor)', () => {
  test('servers of the claude.ai synced plugins are ignored, the mesh ones are not', () => {
    expect(isIgnored('plugin:design:figma')).toBe(true)
    expect(isIgnored('plugin_productivity_monday')).toBe(true)
    expect(isIgnored('plugin:common-room:common-room')).toBe(true)
    expect(isIgnored('coord')).toBe(false)
    expect(problemsOf({ connected: [], failed: [{ name: 'plugin:design:slack' }], needsAuth: ['plugin_engineering_datadog'], pending: [] } as any, 0, 0)).toEqual([])
  })

  test('parses ToolSearch and tool.list', () => {
    const s = parseSearch(SEARCH_BROKEN)
    expect(s.pending).toEqual(['langfuse'])
    expect(s.failed.map(f => f.name)).toEqual(['coord', 'spec'])
    expect(parseSearch(undefined)).toEqual({ pending: [], failed: [] })
    expect(parseSearch({ pending_mcp_servers: 'x', failed_mcp_servers: [null, { error: 'no name' }, 5] })).toEqual({ pending: [], failed: [] })
    const t = parseTools(TOOLS_AUTH)
    expect(t.connected).toEqual(['mesh-ops', 'tasks'])
    expect(t.needsAuth).toEqual(['plugin_acme_figma', 'plugin_acme_linear'])
    expect(shortName('plugin_acme_figma')).toBe('figma')
    expect(reconnectName('plugin_acme_figma')).toBe('plugin:acme:figma')
  })

  test('problems: failed, then auth, pending only after the first minute; folding into +N', () => {
    const r = { checkedAt: T0, connected: ['tasks'], failed: parseSearch(SEARCH_BROKEN).failed, needsAuth: ['plugin_acme_figma'], pending: ['langfuse'] }
    expect(problemsOf(r, T0 + 10_000, T0).map(p => `${p.kind}:${p.label}:${p.action}`)).toEqual(['failed:coord:reconnect', 'failed:spec:reconnect', 'auth:figma:auth'])
    const late = problemsOf(r, T0 + 61_000, T0)
    expect(late.map(p => p.label)).toEqual(['coord', 'spec', 'figma', 'langfuse'])
    expect(fold(late, 50).shown.map(p => p.label)).toEqual(['coord', 'spec'])
    expect(fold(late, 200).more).toBe(0)
    expect(fold(late, 5).shown.length).toBe(1)
    for (const cols of [30, 50, 80, 120]) {
      const { shown, more } = fold(late, cols)
      const used = 5 + shown.reduce((n, p) => n + itemWidth(p), 0) + (more > 0 ? 1 + String(late.length).length : 0)
      if (shown.length > 1) expect(used).toBeLessThanOrEqual(cols)
    }
  })

  test('auth URL: only https is taken; summary lists every state', () => {
    expect(findUrl('Open this URL to log in: https://www.figma.com/oauth?client_id=a&state=b.')).toEqual({ url: 'https://www.figma.com/oauth?client_id=a&state=b' })
    expect(findUrl('go to http://evil.example/login')).toEqual({ insecure: 'http://evil.example/login' })
    const s = summary({ checkedAt: T0, connected: ['tasks', 'mesh-ops'], failed: [{ name: 'coord', errorCode: 'ECONNREFUSED' }], needsAuth: ['plugin_acme_figma'], pending: ['langfuse'] }, T0 + 120_000, T0)
    expect(s).toMatch(/^MCP: 2 connected, 1 failed, 1 need auth, 1 pending/)
    expect(s).toMatch(/pending: langfuse/)
  })

  test('mounted: all fine and no limits draws no row 2', async ($, on) => {
    const { called } = await started($, on, { search: { ...SEARCH_OK, pending_mcp_servers: ['langfuse'] } })
    expect(called).toContain('ToolSearch')
    const band = await mount($)
    expect(await band.find({ type: 'Text', text: /MCP/ })).toBeUndefined()
    expect(await band.find({ type: 'Text', text: /▀/ })).toBeUndefined()
    await band.unmount()
  })

  test('mounted: reconnect runs /mcp reconnect <name>, toasts the answer and rechecks', async ($, on) => {
    const { ran, toasts, called } = await started($, on, { search: SEARCH_BROKEN })
    const before = called.filter(t => t === 'ToolSearch').length
    const band = await mount($)
    await band.press({ key: 'reconnect:coord' })
    await settle()
    expect(ran).toEqual([{ command: 'mcp', args: 'reconnect coord' }])
    expect(called.filter(t => t === 'ToolSearch').length).toBe(before + 1)
    expect(toasts[0]).toMatch(/^MCP coord: Reconnected to coord\./)
    expect(toasts[0]).toMatch(/\/mcp reconnect coord/) // still failed after the recheck: the hint stays
    await band.unmount()
  })

  test('mounted: auth opens only an https URL in the browser', async ($, on) => {
    const { opened, toasts, world } = await started($, on, { tools: TOOLS_AUTH, authText: 'Visit https://www.figma.com/oauth/authorize?x=1 to sign in' })
    const band = await mount($, 160)
    await band.press({ key: 'auth:plugin_acme_figma' })
    await settle()
    expect(opened).toEqual([['explorer.exe', 'https://www.figma.com/oauth/authorize?x=1']])
    expect(toasts.at(-1)).toMatch(/браузер открыт/)
    world.authText = 'Visit http://www.figma.com/oauth/authorize?x=1 to sign in'
    await band.press({ key: 'auth:plugin_acme_linear' })
    await settle()
    expect(opened.length).toBe(1) // nothing opened for http
    expect(toasts.at(-1)).toMatch(/не https/)
    await band.unmount()
  })

  test('an errored MCP call triggers a recheck', async ($, on) => {
    const rec = await started($, on)
    const before = rec.called.filter(t => t === 'ToolSearch').length
    await $.tool.call({ tool: 'mcp__coord__coord_list' } as any)
    await rec.clock.advance(1_000)
    expect(rec.called.filter(t => t === 'ToolSearch').length).toBe(before) // debounced
    await rec.clock.advance(5_000)
    expect(rec.called.filter(t => t === 'ToolSearch').length).toBe(before + 1)
  })

  test('the timer rechecks MCP every two minutes', async ($, on) => {
    const rec = await started($, on)
    const before = rec.called.filter(t => t === 'ToolSearch').length
    await rec.clock.advance(120_000)
    expect(rec.called.filter(t => t === 'ToolSearch').length).toBe(before + 1)
  })

  test('/integral mcp lists states, /integral mcp check rechecks', async ($, on) => {
    const { world, called } = await started($, on, { search: SEARCH_BROKEN, tools: TOOLS_AUTH })
    expect((await $.command.run({ command: 'integral', args: 'mcp' } as any)).text).toMatch(/2 connected, 2 failed, 2 need auth, 1 pending/)
    world.search = SEARCH_OK
    const n = called.filter(t => t === 'ToolSearch').length
    const again = (await $.command.run({ command: 'integral', args: 'mcp check' } as any)).text!
    expect(called.filter(t => t === 'ToolSearch').length).toBe(n + 1)
    expect(again).toMatch(/0 failed/)
  })
})

describe('integral: plan', () => {
  test('board: TodoWrite, TaskCreate/TaskUpdate, all completed is no plan', () => {
    const b = fromTodos(seven(2))!
    expect(progress(b).done).toBe(2)
    expect(progress(b).current?.active).toBe('step 3…')
    const row = planRow(b, 100)
    expect(row.count).toBe('2/7')
    expect(row.bar.map(p => p.text).join('')).toMatch(/^━+─+$/)
    expect(fromTodos(seven(7))).toBeNull()
    let t = addTask(null, { id: '1', subject: 'one' })
    t = addTask(t, { id: '2', subject: 'two', activeForm: 'doing two' })
    t = updateTask(t, { taskId: '2', status: 'in_progress' })
    expect(planRow(t!, 100).text).toBe('doing two')
    t = updateTask(t, { taskId: '1', status: 'deleted' })
    expect(t!.items.length).toBe(1)
    expect(updateTask(t, { taskId: '2', status: 'completed' })).toBeNull()
  })

  test('mounted: TodoWrite 2/7 draws the plan row; all completed removes it', async ($, on) => {
    await started($, on)
    await $.tool.call({ tool: 'TodoWrite', todos: seven(2) } as any)
    let band = await mount($)
    expect(await band.find({ type: 'Text', text: '2/7' })).toBeDefined()
    expect(await band.find({ type: 'Text', text: 'step 3…' })).toBeDefined()
    expect(await band.find({ type: 'Text', text: '● ' })).toBeDefined()
    await band.unmount()
    await $.tool.call({ tool: 'TodoWrite', todos: seven(7) } as any)
    band = await mount($)
    expect(await band.find({ type: 'Text', text: /^\d+\/\d+$/ })).toBeUndefined()
    await band.unmount()
  })

  test('mounted: TaskCreate + TaskUpdate count; subagent and refused calls are ignored', async ($, on) => {
    const { world } = await started($, on)
    await $.tool.call({ tool: 'TaskCreate', subject: 'build', activeForm: 'building' } as any)
    await $.tool.call({ tool: 'TaskCreate', subject: 'test', activeForm: 'testing' } as any)
    await $.tool.call({ tool: 'TaskUpdate', taskId: '1', status: 'completed' } as any)
    await $.tool.call({ tool: 'TaskUpdate', taskId: '2', status: 'in_progress' } as any)
    // a subagent's own list never reaches the main plan
    await $.tool.call({ tool: 'TodoWrite', todos: seven(0), agentId: 'a1' } as any)
    // a refused call changes nothing
    world.refuse = 'TaskUpdate'
    await $.tool.call({ tool: 'TaskUpdate', taskId: '2', status: 'completed' } as any)
    world.refuse = ''
    let band = await mount($)
    expect(await band.find({ type: 'Text', text: '1/2' })).toBeDefined()
    expect(await band.find({ type: 'Text', text: 'testing' })).toBeDefined()
    await band.unmount()
    // /integral plan off hides the row
    await $.command.run({ command: 'integral', args: 'plan off' } as any)
    band = await mount($)
    expect(await band.find({ type: 'Text', text: '1/2' })).toBeUndefined()
    await band.unmount()
  })
})
