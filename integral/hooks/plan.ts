// Plan section, pure parts: the open task list, built from the calls the model already makes.
//   TodoWrite sends the whole list each time; TaskCreate and TaskUpdate one task a call.
//   A list whose items are all completed is no plan any more: null, and the row goes.
// Adapted from hoobnn/todo-bar hooks/board.ts (MIT, Copyright (c) 2026 hoobnn), cut down to
// what the one-line plan row needs (no timings, call counts or subagent rows).
import type { Board, Item, ItemStatus } from '../types'
import type { Part } from './context'

type Todo = { content?: unknown; status?: unknown; activeForm?: unknown }

const STATUSES: readonly ItemStatus[] = ['pending', 'in_progress', 'completed']
export const PLAN_TOOLS = new Set(['TodoWrite', 'TaskCreate', 'TaskUpdate'])

const str = (v: unknown) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '')
const statusOf = (v: unknown): ItemStatus => STATUSES.find(s => s === v) ?? 'pending'

function settle(source: Board['source'], items: Item[]): Board | null {
  if (items.length === 0 || items.every(i => i.status === 'completed')) return null
  return { source, items }
}

/** TodoWrite's list (its `newTodos`, else the input's `todos`) as the board. */
export function fromTodos(todos: unknown): Board | null {
  const list = (Array.isArray(todos) ? todos : []) as Todo[]
  const items = list
    .map((t, i): Item => {
      const title = str(t?.content)
      return { id: String(i), title, active: str(t?.activeForm) || title, status: statusOf(t?.status) }
    })
    .filter(i => i.title)
  return settle('todo', items)
}

/** A task TaskCreate made, added to the task board (a todo board makes way). */
export function addTask(prev: Board | null, task: { id: string; subject: string; activeForm?: string }): Board | null {
  const title = str(task.subject)
  if (!title) return prev
  const kept = prev && prev.source === 'task' ? prev.items : []
  return settle('task', [...kept.filter(i => i.id !== task.id), { id: task.id, title, active: str(task.activeForm) || title, status: 'pending' }])
}

/** What TaskUpdate changed on a task the board holds; `deleted` drops it. */
export function updateTask(prev: Board | null, change: { taskId: string; status?: string; subject?: string; activeForm?: string }): Board | null {
  if (!prev || prev.source !== 'task' || !prev.items.some(i => i.id === change.taskId)) return prev
  const items =
    change.status === 'deleted'
      ? prev.items.filter(i => i.id !== change.taskId)
      : prev.items.map(i => {
          if (i.id !== change.taskId) return i
          const title = str(change.subject) || i.title
          const status = change.status === undefined ? i.status : statusOf(change.status)
          return { ...i, title, active: str(change.activeForm) || (str(change.subject) ? title : i.active), status }
        })
  return settle('task', items)
}

/** Where the board stands: done and total, the running item (else the first open one). */
export function progress(board: Board): { done: number; total: number; current: Item | null; isRunning: boolean } {
  const done = board.items.filter(i => i.status === 'completed').length
  const running = board.items.find(i => i.status === 'in_progress') ?? null
  const current = running ?? board.items.find(i => i.status === 'pending') ?? null
  return { done, total: board.items.length, current, isRunning: running !== null }
}

export type PlanRow = { mark: string; text: string; isRunning: boolean; bar: Part[]; count: string }

// Row 3: `● <activeForm>  ━━━━──── 2/7`; the text is truncated by the drawing, the bar is fixed.
export function planRow(board: Board, inner: number): PlanRow {
  const { done, total, current, isRunning } = progress(board)
  const width = Math.max(6, Math.min(30, Math.floor(inner * 0.25)))
  const n = total === 0 ? 0 : Math.round((done / total) * width)
  const bar: Part[] = [{ text: '━'.repeat(n), color: 'success' }, { text: '─'.repeat(width - n), dim: true }].filter(p => p.text !== '')
  const text = current ? (isRunning ? current.active : current.title) : ''
  return { mark: isRunning ? '●' : '○', text, isRunning, bar, count: `${done}/${total}` }
}
