import { inspect } from 'util'

export type LogLevel = 'debug' | 'log' | 'info' | 'warn' | 'error'
/** app=RN 应用 console / metro=打包器 / device=设备日志 / renderer=界面 / main=主进程 / net=抓包代理 */
export type LogSource = 'app' | 'metro' | 'device' | 'renderer' | 'main' | 'net'

export interface LogEntry {
  id: number
  ts: number
  level: LogLevel
  source: LogSource
  tag?: string
  text: string
}

/** 各采集器产出的单行数据，统一交给 logBus 入库 + 广播 */
export type RawLog = Omit<LogEntry, 'id' | 'ts'>

const MAX = 3000
const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g

let seq = 1
const entries: LogEntry[] = []
let sink: ((e: LogEntry) => void) | null = null
let installed = false

export function stripAnsi(s: string): string {
  return s.replace(ANSI, '')
}

/** 从纯文本推断级别（子进程 / 设备日志用） */
export function guessLevel(text: string): LogLevel {
  const t = stripAnsi(text)
  if (
    /(^|[\s[(])(E|ERROR|FATAL)\b/.test(t) ||
    /(Error:|Exception\b|❌|Unhandled (promise|rejection)|SyntaxError|TypeError|ReferenceError|FAILED|Failed to)/i.test(
      t
    )
  ) {
    return 'error'
  }
  if (/(^|[\s[(])(W|WARN|WARNING)\b/i.test(t) || /(Warning:|⚠)/i.test(t)) return 'warn'
  if (/\bINFO\b/i.test(t)) return 'info'
  return 'log'
}

/** 入库并广播。sink 未挂载时仅入库（历史可回放） */
export function push(level: LogLevel, source: LogSource, text: string, tag?: string): LogEntry {
  const clean = stripAnsi(text).replace(/\r/g, '')
  const e: LogEntry = { id: seq++, ts: Date.now(), level, source, text: clean }
  if (tag) e.tag = tag
  entries.push(e)
  if (entries.length > MAX) entries.splice(0, entries.length - MAX)
  try {
    sink?.(e)
  } catch {
    /* 渲染进程未就绪/已销毁，忽略 */
  }
  return e
}

/** 多行文本 → 多条日志（空行丢弃） */
export function pushBlock(text: string, source: LogSource, level?: LogLevel): LogEntry[] {
  const out: LogEntry[] = []
  for (const line of stripAnsi(text).split('\n')) {
    const t = line.replace(/\r/g, '').trimEnd()
    if (!t.trim()) continue
    out.push(push(level ?? guessLevel(t), source, t))
  }
  return out
}

export function recent(): LogEntry[] {
  return entries.slice()
}

export function clear(): void {
  entries.length = 0
}

export function setSink(cb: ((e: LogEntry) => void) | null): void {
  sink = cb
}

function fmtArg(a: unknown): string {
  if (typeof a === 'string') return a
  if (a instanceof Error) return a.stack ?? `${a.name}: ${a.message}`
  if (typeof a === 'object' && a !== null) {
    try {
      return inspect(a, { depth: 3, breakLength: 160 })
    } catch {
      return String(a)
    }
  }
  return String(a)
}

/**
 * 接管主进程 console：原始输出照旧打到终端，同时汇入 logBus。
 * 在 app ready 之前调用，才能覆盖启动阶段的日志。
 */
export function installConsoleCapture(): void {
  if (installed) return
  installed = true
  const levels: LogLevel[] = ['debug', 'log', 'info', 'warn', 'error']
  for (const lv of levels) {
    const orig = console[lv].bind(console)
    console[lv] = (...args: unknown[]): void => {
      // 开远程调试时原生 console 会被路由到 webFrameMain，渲染帧销毁后它会抛
      // "Render frame was disposed"；必须吞掉，否则会触发 uncaughtException 级联成死循环。
      try {
        orig(...args)
      } catch {
        /* 渲染帧已销毁，忽略 */
      }
      try {
        push(lv, 'main', args.map(fmtArg).join(' '))
      } catch {
        /* 同上 */
      }
    }
  }
  // 兜底：未捕获异常
  process.on('uncaughtException', (err) => {
    push('error', 'main', `uncaughtException: ${err?.stack ?? err}`)
  })
  process.on('unhandledRejection', (reason) => {
    push('error', 'main', `unhandledRejection: ${fmtArg(reason)}`)
  })
}
