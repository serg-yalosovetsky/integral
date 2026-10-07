// integral (serg/tasks#1599): one HUD above the prompt, replacing context-bar-compact and mcp-doctor.
//   Row 1, context: the bar by consumer, `37%` (press: names consumers biggest first, lights each
//     run), then `>` (full legend; `<` closes), `↓` (/compact), `!` (checkpoint prompt).
//     The icons are dim text while a turn runs: a queued compaction firing after the answer,
//     unasked, is worse than a button that waits.
//   Row 2, limits + MCP: the 5h and 7d bars (color = pace, Serg's rule), flush under row 1 thanks
//     to top-aligned glyphs; MCP problems on the right with reconnect/auth buttons, the rest in +N.
//   Row 3, plan: only while a task list is open, `● <current task>  ━━━──── 2/7`. Without one,
//     the session's tracker epic (MCP `tasks`): `◆ <title>  ━━━──── 3/11  #1556`, gone once all is [x].
//     The epic: /integral plan epic N (off clears), else the last task_add's parent or task_get of an epic.
//   Each section is built in its own try/catch: one that throws is logged and left out, the rest draw.
//   /integral hides or shows it all (kept across sessions); /integral more | mcp | mcp check | plan off|on.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderElement, Timer } from 'claude-code'

import type { Board, Epic, Limit, Reading, Report } from '../types'
import { contextRow, legend, legendHead, legendParts, nextPick, toLimits, toReading } from './context'
import type { Part } from './context'
import { TASKS_PREFIX, TASKS_SERVER, epicRow, issueNumber, parseTask, textOf, withInfo } from './epic'
import type { TaskInfo } from './epic'
import { statusLayout } from './layout'
import { MCP_COLOR, MCP_GLYPH, MCP_HEAD, findUrl, isRefusal, parseSearch, parseTools, problemsOf, reconnectName, shortName, summary } from './mcp'
import type { Problem } from './mcp'
import { PLAN_TOOLS, addTask, fromTodos, planRow, updateTask } from './plan'

const PLUGIN = 'integral'
const MIN_WIDTH = 20 // narrower than this, nothing is drawn
const TICK_MS = 60_000 // limits move on once a minute; MCP is checked every second tick
const MCP_EVERY = 2
const DEBOUNCE_MS = 5_000
const PROBE_QUERY = 'select:mcp__mcpdoctor__none' // matches nothing: only the server lists are wanted

// What the checkpoint action sends. One constant, so a session-checkpoint mod can replace it.
export const CHECKPOINT_PROMPT = 'Сохрани чекпоинт сессии в memory palace (скилл save-checkpoint).'

// Held by the host, so the HUD survives a hot reload of this file.
const reading = atom({ plugin: 'integral', key: 'reading' } as const, null as Reading | null)
const isHidden = atom({ plugin: 'integral', key: 'isHidden' } as const, false)
const isExpanded = atom({ plugin: 'integral', key: 'isExpanded' } as const, false)
const limits = atom({ plugin: 'integral', key: 'limits' } as const, [] as Limit[])
const tick = atom({ plugin: 'integral', key: 'tick' } as const, 0)
const picked = atom({ plugin: 'integral', key: 'picked' } as const, null as string | null)
const report = atom({ plugin: 'integral', key: 'report' } as const, null as Report | null)
const isMcpExpanded = atom({ plugin: 'integral', key: 'isMcpExpanded' } as const, false)
const startedAt = atom({ plugin: 'integral', key: 'startedAt' } as const, 0)
const authOpened = atom({ plugin: 'integral', key: 'authOpened' } as const, [] as string[])
const board = atom({ plugin: 'integral', key: 'board' } as const, null as Board | null)
const isPlanHidden = atom({ plugin: 'integral', key: 'isPlanHidden' } as const, false)
const epic = atom({ plugin: 'integral', key: 'epic' } as const, null as Epic | null)

function errText(err: unknown) {
  return err instanceof Error ? err.message : String(err)
}

// A failure that must not break the session still leaves a line in the debug log.
function trace($: EngineInterface, what: string, err: unknown) {
  $.ui.log(`${PLUGIN}: ${what}: ${errText(err)}`, { to: 'debug' })
}

// ---------- context ----------

// Asks the engine for /context's breakdown, estimated locally (no token-count calls).
async function refresh($: EngineInterface) {
  if (await read($, isHidden)) return
  const usage = await $.session.usage({ breakdown: 'summary' })
  await update($, limits, () => toLimits(usage.rateLimits ?? [])) // empty off a subscription
  const b = usage.context.breakdown
  if (!b || !(b.rawMaxTokens > 0)) return // no window to measure against: the HUD keeps its last reading
  await update($, reading, () => toReading(b))
}

// The two actions. Each is a queued call the engine runs once the session is idle; a refusal is told, not dropped.
function act($: EngineInterface, key: 'compact' | 'checkpoint') {
  const run = key === 'compact' ? $.command.run({ command: 'compact' }) : $.prompt.submit({ text: CHECKPOINT_PROMPT })
  void run.catch(err => {
    trace($, key, err)
    $.ui.toast(`integral: ${key} failed, ${errText(err)}`)
  })
}

// ---------- MCP ----------

let inflight: Promise<Report | null> | undefined

// One look at the servers; a check already running is shared, not doubled.
async function check($: EngineInterface): Promise<Report | null> {
  if (inflight) return inflight
  inflight = (async () => {
    try {
      const [search, tools, now] = await Promise.all([
        $.tool.call({ tool: 'ToolSearch', query: PROBE_QUERY, max_results: 1 } as never),
        $.tool.list(),
        $.clock.now(),
      ])
      const s = parseSearch('result' in search ? search.result : undefined)
      const t = parseTools(tools)
      const r: Report = { checkedAt: now, connected: t.connected, failed: s.failed, needsAuth: t.needsAuth, pending: s.pending }
      await update($, report, () => r)
      return r
    } catch (err) {
      trace($, 'mcp check', err) // the row keeps its last report; /integral mcp says the check failed
      return null
    } finally {
      inflight = undefined
    }
  })()
  return inflight
}

async function reconnect($: EngineInterface, name: string) {
  let text: string | undefined
  try {
    text = (await $.command.run({ command: 'mcp', args: `reconnect ${name}` } as never)).text
  } catch (err) {
    trace($, `reconnect ${name}`, err)
    text = `error: ${errText(err)}`
  }
  const r = await check($)
  const stillFailed = !!r?.failed.some(f => f.name === name)
  const hint = isRefusal(text) || stillFailed ? ` · набери /mcp reconnect ${name}` : ''
  $.ui.toast(`MCP ${name}: ${text?.trim() || 'нет ответа'}${hint}`)
}

async function authenticate($: EngineInterface, seg: string) {
  let text = ''
  try {
    const res = await $.tool.call({ tool: `mcp__${seg}__authenticate` } as never)
    text = 'deny' in res && res.deny ? res.deny : (res.text ?? JSON.stringify(res.result ?? ''))
  } catch (err) {
    trace($, `authenticate ${seg}`, err)
    $.ui.toast(`MCP ${shortName(seg)}: auth failed, ${errText(err)}`)
    return
  }
  const { url, insecure } = findUrl(text)
  if (!url) {
    $.ui.toast(`MCP ${shortName(seg)}: ${insecure ? `не https, не открываю: ${insecure}` : text.slice(0, 300) || 'пустой ответ'}`)
    return
  }
  try {
    // explorer.exe exits 1 even when it opened the browser: the exit code says nothing here.
    const r = await $.process.run(['explorer.exe', url])
    if (r.exitCode !== 0) $.ui.log(`${PLUGIN}: explorer.exe exit ${r.exitCode} for auth ${seg} (normal for explorer)`, { to: 'debug' })
  } catch (err) {
    trace($, `open browser for ${seg}`, err)
    $.ui.toast(`MCP ${shortName(seg)}: браузер не открылся, открой сам: ${url}`)
    return
  }
  await update($, authOpened, l => (l.includes(seg) ? l : [...l, seg]))
  $.ui.toast(`MCP ${shortName(seg)}: браузер открыт, после логина нажми reconnect`)
}

function press($: EngineInterface, p: Problem, action: 'reconnect' | 'auth') {
  const run = action === 'auth' ? authenticate($, p.name) : reconnect($, p.kind === 'auth' ? reconnectName(p.name) : p.name)
  void run.catch(err => trace($, `${action} ${p.name}`, err))
}

// ---------- plan ----------

// The main thread's plan tools, once the call has run; a refused or failed call changes nothing.
async function planFromCall($: EngineInterface, e: { tool: string; agentId?: string }, ran: { deny?: string; isError?: boolean; result?: unknown }) {
  if (e.agentId !== undefined || !PLAN_TOOLS.has(e.tool)) return // a subagent's list is its own
  if (ran.deny !== undefined || ran.isError) return
  const input = e as unknown as Record<string, unknown>
  const result = (ran.result ?? {}) as Record<string, unknown>
  if (e.tool === 'TodoWrite') {
    const todos = Array.isArray(result.newTodos) ? result.newTodos : input.todos
    await update($, board, () => fromTodos(todos))
  } else if (e.tool === 'TaskCreate') {
    const task = result.task as { id?: unknown } | undefined
    if (typeof task?.id !== 'string') return
    const made = { id: task.id, subject: String(input.subject ?? ''), activeForm: typeof input.activeForm === 'string' ? input.activeForm : undefined }
    await update($, board, b => addTask(b, made))
  } else if (result.success !== false && typeof input.taskId === 'string') {
    const change = {
      taskId: input.taskId,
      status: typeof input.status === 'string' ? input.status : undefined,
      subject: typeof input.subject === 'string' ? input.subject : undefined,
      activeForm: typeof input.activeForm === 'string' ? input.activeForm : undefined,
    }
    await update($, board, b => updateTask(b, change))
  }
}

// ---------- epic (tracker) ----------

let epicInflight: Promise<void> | undefined
let epicScheduled = false

// The epic's data from task_get. A failure is logged and the row keeps the last data it had.
async function refreshEpic($: EngineInterface): Promise<void> {
  if (epicInflight) return epicInflight
  epicInflight = (async () => {
    const cur = await read($, epic)
    if (!cur) return
    try {
      const res = await $.mcp.call(TASKS_SERVER, 'task_get', { number: cur.n, comments: 0 })
      const text = textOf(res.content)
      const info = res.isError ? null : parseTask(text)
      if (!info) {
        $.ui.log(`${PLUGIN}: epic #${cur.n}: task_get ${res.isError ? 'error' : 'unparsed'}: ${text.slice(0, 200)}`, { to: 'debug' })
        return
      }
      await update($, epic, e => (e && e.n === info.n ? withInfo(e, info) : e)) // switched meanwhile: that one fetches its own
    } catch (err) {
      trace($, `epic #${cur.n} task_get`, err) // the row keeps the last data
    }
  })().finally(() => {
    epicInflight = undefined
  })
  return epicInflight
}

// Sets the session's epic; an explicit one (the command) is not replaced by a detected one.
async function setEpic($: EngineInterface, n: number, isExplicit: boolean, info?: TaskInfo) {
  let changed = false
  await update($, epic, cur => {
    if (cur && cur.isExplicit && !isExplicit) return cur
    changed = true
    const base: Epic = cur && cur.n === n ? { ...cur, isExplicit } : { n, isExplicit, title: '', done: 0, total: 0 }
    return info && info.n === n ? withInfo(base, info) : base
  })
  if (changed && !info) await refreshEpic($)
}

// One refresh 5 s after a burst of tracker calls (a task moved, a checklist item ticked).
function scheduleEpic($: EngineInterface) {
  if (epicScheduled) return
  epicScheduled = true
  void (async () => {
    try {
      await $.clock.sleep(DEBOUNCE_MS)
    } catch (err) {
      trace($, 'epic debounce sleep', err) // no wait: the refresh runs now
    }
    epicScheduled = false
    await refreshEpic($)
  })().catch(err => trace($, 'epic refresh after tasks call', err))
}

// The main thread's tracker calls: task_add with a parent and task_get of an epic name the epic;
// any other tracker call refreshes it (debounced).
async function epicFromCall($: EngineInterface, e: { tool: string; agentId?: string }, ran: { deny?: string; isError?: boolean; text?: string; result?: unknown }) {
  if (e.agentId !== undefined || !e.tool.startsWith(TASKS_PREFIX)) return
  if (ran.deny !== undefined || ran.isError) return
  const input = e as unknown as Record<string, unknown>
  if (e.tool === `${TASKS_PREFIX}task_add`) {
    const parent = issueNumber(input.parent)
    const cur = await read($, epic)
    if (parent !== null && (!cur || cur.n !== parent)) return setEpic($, parent, false)
  } else if (e.tool === `${TASKS_PREFIX}task_get`) {
    const info = parseTask(typeof ran.text === 'string' && ran.text ? ran.text : textOf(ran.result))
    if (info && info.kind === 'epic') return setEpic($, info.n, false, info)
  }
  if (await read($, epic)) scheduleEpic($)
}

// ---------- the module ----------

const HELP = '/integral: show or hide the HUD · more: full legend · mcp: MCP report · mcp check: recheck · plan off|on: the plan row · plan epic N|off: the tracker epic'

export const register: Register = on => {
  let timer: Timer | undefined // one timer, even when session.start fires again on a reload
  let scheduled = false

  on('session.start', async ($, e, next) => {
    const r = await next(e)
    const now = await $.clock.now()
    await update($, startedAt, v => v || now) // a hot reload keeps the session's own start
    timer?.cancel()
    try {
      let n = 0
      timer = $.clock.every(TICK_MS, () => {
        void update($, tick, k => k + 1).catch(err => trace($, 'tick', err))
        if (++n % MCP_EVERY === 0) {
          void check($)
          void refreshEpic($)
        }
      })
    } catch (err) {
      trace($, 'clock.every', err) // no timer: limits move on with each response, MCP is checked at start, after MCP errors and on /integral mcp check
    }
    // A name Claude Code already has is refused: the HUD still works, only the command is missing.
    await $.command.register({ name: 'integral', description: 'HUD: show/hide; more | mcp | mcp check | plan off|on | plan epic N|off' }).catch(err => trace($, 'command.register', err))
    const hidden = (await $.store.get('isHidden').catch(err => (trace($, 'store.get isHidden', err), undefined))) === true
    await update($, isHidden, () => hidden)
    const planHidden = (await $.store.get('isPlanHidden').catch(err => (trace($, 'store.get isPlanHidden', err), undefined))) === true
    await update($, isPlanHidden, () => planHidden)
    void refresh($).catch(err => trace($, 'refresh at start', err))
    void check($) // never holds the session's start; errors are traced inside
    return r
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (!e.agentId) await refresh($).catch(err => trace($, 'refresh after turn', err)) // a subagent's turn fills its own window
    return r
  })

  on('session.compact', async ($, e, next) => {
    const r = await next(e)
    if (!e.agentId && 'messages' in r) void refresh($).catch(err => trace($, 'refresh after compact', err))
    return r
  })

  // The engine measures after each response; a limits window that moved a point redraws the row.
  on('session.measure', async ($, e, next) => {
    const r = await next(e)
    await update($, limits, () => toLimits(e.rateLimits ?? [])).catch(err => trace($, 'limits from measure', err))
    return r
  })

  on('tool.call', async ($, e, next) => {
    const res = await next(e)
    // An MCP call that errored: recheck 5 s later, one recheck per burst.
    try {
      const tool = String(e.tool)
      if (tool.startsWith('mcp__') && !tool.endsWith('__authenticate') && 'isError' in res && res.isError && !scheduled) {
        scheduled = true
        void (async () => {
          try {
            await $.clock.sleep(DEBOUNCE_MS)
          } catch (err) {
            trace($, 'debounce sleep', err) // no wait: the recheck runs now
          }
          scheduled = false
          await check($)
        })().catch(err => trace($, 'recheck after MCP error', err))
      }
    } catch (err) {
      trace($, 'mcp after tool.call', err)
    }
    try {
      await planFromCall($, e as never, res as never)
    } catch (err) {
      trace($, `plan from ${String(e.tool)}`, err) // the plan row keeps its last state
    }
    try {
      await epicFromCall($, e as never, res as never)
    } catch (err) {
      trace($, `epic from ${String(e.tool)}`, err) // the epic stays as it was
    }
    return res
  })

  on('command.run', { command: 'integral' }, async ($, e) => {
    const args = e.args.trim().toLowerCase().split(/\s+/).filter(Boolean)
    const [cmd, arg, arg2] = args
    if (!cmd) {
      const hidden = await update($, isHidden, h => !h)
      await $.store.set('isHidden', hidden).catch(err => trace($, 'store.set isHidden', err))
      if (!hidden) await refresh($).catch(err => trace($, 'refresh after show', err))
      return { text: hidden ? 'integral hidden. /integral shows it again' : 'integral on' }
    }
    if (cmd === 'more') {
      const open = await update($, isExpanded, x => !x)
      return { text: open ? 'integral: full legend' : 'integral: compact' }
    }
    if (cmd === 'mcp') {
      const fresh = arg === 'check' || !(await read($, report))
      const ok = fresh ? await check($) : true
      const text = summary(await read($, report), await $.clock.now(), await read($, startedAt))
      return { text: ok ? text : `MCP: check failed (see claude --debug).\n${text}` }
    }
    if (cmd === 'plan' && (arg === 'off' || arg === 'on')) {
      const off = arg === 'off'
      await update($, isPlanHidden, () => off)
      await $.store.set('isPlanHidden', off).catch(err => trace($, 'store.set isPlanHidden', err))
      return { text: off ? 'integral: plan row hidden' : 'integral: plan row on' }
    }
    if (cmd === 'plan' && arg === 'epic') {
      if (arg2 === 'off') {
        await update($, epic, () => null)
        return { text: 'integral: epic cleared; task_add with a parent or task_get of an epic sets one again' }
      }
      const n = issueNumber(arg2)
      if (n === null) return { text: 'integral: /integral plan epic <N> | off' }
      await setEpic($, n, true)
      const cur = await read($, epic)
      return { text: cur && cur.total > 0 ? `integral: epic #${n} — ${cur.title} (${cur.done}/${cur.total})` : `integral: epic #${n}, no data yet (see claude --debug if it stays so)` }
    }
    return { text: HELP }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const rest = await next(e) // what other mods and Claude Code draw here stays
    if (e.props.hasSurvey || (await read($, isHidden))) return rest
    const inner = e.props.bodyColumns
    if (inner < MIN_WIDTH) return rest
    const { Box, Button, Text } = $.ui.resolve(e)
    const isWorking = e.props.isWorking
    const rows: RenderElement[] = []
    const line = (parts: Part[]) => parts.map(p => <Text color={p.color} dimColor={p.dim} bold={p.bold}>{p.text}</Text>)

    // Row 1: context.
    const r = await read($, reading)
    const open = await read($, isExpanded)
    try {
      if (r) {
        const row = contextRow(r, inner, await read($, picked))
        const icon = (key: string, label: string, onPress: () => void, hot?: string) =>
          isWorking ? <Text dimColor>{label}</Text> : <Button key={key} plain dimColor={!hot} label={label} onPress={onPress} />
        rows.push(
          <Box flexDirection="row">
            <Box flexShrink={1}>
              <Text wrap="truncate-end">{line(row.bar)}</Text>
            </Box>
            <Box flexShrink={0} marginLeft={1}>
              <Button key="pct" plain label={row.label} hover={{ scope: 'integral-pct', color: row.level, bold: true }} onPress={() => update($, picked, cur => nextPick(r, cur))} />
            </Box>
            <Box flexShrink={0} marginLeft={1}>
              {icon('legend', open ? '<' : '>', () => void update($, isExpanded, x => !x).catch(err => trace($, 'legend toggle', err)))}
            </Box>
            <Box flexShrink={0} marginLeft={1} flexDirection="row">
              {row.hot && <Text color={row.hot} bold>●</Text>}
              {icon('compact', '↓', () => act($, 'compact'), row.hot)}
            </Box>
            <Box flexShrink={0} marginLeft={1}>
              {icon('checkpoint', '!', () => act($, 'checkpoint'))}
            </Box>
          </Box>,
        )
      }
    } catch (err) {
      trace($, 'render context', err)
    }

    // Row 2: limits + MCP; the full MCP list under it when opened.
    try {
      await read($, tick) // redraws on each countdown tick
      const now = await $.clock.now()
      let problems: Problem[] = []
      try {
        problems = problemsOf(await read($, report), now, await read($, startedAt))
      } catch (err) {
        trace($, 'render mcp', err) // the row keeps its limit bars
      }
      const opened = await read($, authOpened)
      const layout = statusLayout(await read($, limits), problems, now, inner, opened)
      const mcpOpen = await read($, isMcpExpanded)
      const toggle = () => void update($, isMcpExpanded, x => !x).catch(err => trace($, 'mcp toggle', err))
      const item = (p: Problem, withDetail: boolean) => (
        <Box flexDirection="row" marginRight={3}>
          <Text color={MCP_COLOR[p.kind]}>{`${MCP_GLYPH[p.kind]} `}</Text>
          <Text>{`${p.label} `}</Text>
          <Button key={`${p.action}:${p.name}`} plain label={p.action} onPress={() => press($, p, p.action)} />
          {p.kind === 'auth' && opened.includes(p.name) && (
            <Box marginLeft={1}>
              <Button key={`reconnect:${p.name}`} plain dimColor label="reconnect" onPress={() => press($, p, 'reconnect')} />
            </Box>
          )}
          {withDetail && p.detail && <Text dimColor wrap="truncate-end">{`  ${p.detail}`}</Text>}
        </Box>
      )
      if (layout) {
        rows.push(
          <Box flexDirection="row">
            {layout.bars && (
              <Box flexShrink={0}>
                <Text>{line(layout.bars)}</Text>
              </Box>
            )}
            {problems.length > 0 && (
              <Box flexDirection="row" flexShrink={0} marginLeft={layout.bars ? 3 : 0}>
                {layout.head && <Text bold>{MCP_HEAD}</Text>}
                {(mcpOpen ? [] : layout.shown).map(p => item(p, false))}
                {mcpOpen ? <Button key="mcp-less" plain dimColor label="less" onPress={toggle} /> : layout.more > 0 && <Button key="mcp-more" plain dimColor label={`+${layout.more}`} onPress={toggle} />}
              </Box>
            )}
          </Box>,
        )
        if (mcpOpen && problems.length > 0) for (const p of problems) rows.push(item(p, true))
      }
    } catch (err) {
      trace($, 'render limits', err)
    }

    // The full legend, under the limits so they stay flush with the bar.
    try {
      if (r && open) {
        rows.push(<Text dimColor>{legendHead(r)}</Text>)
        for (const l of legend(r, inner)) rows.push(<Text wrap="truncate-end">{line(legendParts(r, l))}</Text>)
      }
    } catch (err) {
      trace($, 'render legend', err)
    }

    // Row 3: plan. An open task list first, else the epic.
    let hasPlan = false
    try {
      const b = await read($, board)
      if (b && !(await read($, isPlanHidden))) {
        hasPlan = true
        const p = planRow(b, inner)
        rows.push(
          <Box flexDirection="row">
            <Box flexShrink={0}>
              <Text color={p.isRunning ? 'success' : undefined} dimColor={!p.isRunning}>{`${p.mark} `}</Text>
            </Box>
            <Box flexGrow={1} flexShrink={1}>
              <Text wrap="truncate-end" dimColor={!p.isRunning}>{p.text}</Text>
            </Box>
            <Box flexShrink={0} marginLeft={2}>
              <Text>{line(p.bar)}</Text>
            </Box>
            <Box flexShrink={0} marginLeft={1}>
              <Text>{p.count}</Text>
            </Box>
          </Box>,
        )
      }
    } catch (err) {
      trace($, 'render plan', err)
    }
    try {
      const ep = await read($, epic)
      const p = !hasPlan && ep && !(await read($, isPlanHidden)) ? epicRow(ep, inner) : null
      if (p) {
        rows.push(
          <Box flexDirection="row">
            <Text>{p.mark}</Text>
            <Text>{p.title}</Text>
            <Box flexShrink={0} marginLeft={2}>
              <Text>{line(p.bar)}</Text>
            </Box>
            <Box flexShrink={0} marginLeft={1}>
              <Text>{p.count}</Text>
            </Box>
            {p.ref && (
              <Box flexShrink={0} marginLeft={2}>
                <Text dimColor>{p.ref}</Text>
              </Box>
            )}
          </Box>,
        )
      }
    } catch (err) {
      trace($, 'render epic', err)
    }

    if (rows.length === 0) return rest
    return (
      <Box flexDirection="column">
        {rows}
        {rest}
      </Box>
    )
  })
}
