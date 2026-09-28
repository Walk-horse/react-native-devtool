import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'
import { LogEntry, LogLevel, LogSource } from '../types'
import { parseJsonFlexible, prettyJson, repairTruncated } from '../utils/jsonFormat'
import { JsonNode, pruneJson, SearchedPre } from './JsonTree'

interface Props {
  entries: LogEntry[]
  /** 是否正在跟随当前设备采集（logcat / simctl） */
  following: boolean
  deviceLabel?: string
  onToggleFollow: () => void
  onClear: () => void
}

const LEVELS: { key: LogLevel; label: string }[] = [
  { key: 'log', label: '日志' },
  { key: 'info', label: '信息' },
  { key: 'warn', label: '警告' },
  { key: 'error', label: '错误' },
  { key: 'debug', label: '调试' }
]

const SOURCES: { key: LogSource; label: string }[] = [
  { key: 'app', label: '应用 console' },
  { key: 'metro', label: 'Metro / 运行' },
  { key: 'device', label: '设备日志' },
  { key: 'renderer', label: '界面' },
  { key: 'main', label: '主进程' },
  { key: 'net', label: '代理' }
]

const LV_LABEL: Record<LogLevel, string> = {
  debug: 'DEBG',
  log: 'LOG',
  info: 'INFO',
  warn: 'WARN',
  error: 'ERRO'
}

function pad(n: number, w = 2): string {
  return String(n).padStart(w, '0')
}

function stamp(ts: number): string {
  const d = new Date(ts)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/* ---------- 日志分组：把 groupCollapsed 块渲染成可折叠组（对标 Chrome DevTools 控制台） ---------- */

/** groupCollapsed 头行（真机实测以 `┘` 开头） */
const GRP_HEAD_RE = /^\s*┘\s*(.+)$/
/** groupEnd 结束标记：单独一个 `┘` */
const GRP_END_RE = /^\s*┘\s*$/
/** group 子行前缀：`│`（U+2502），兼容 ASCII | 与树形字符 */
const GRP_CHILD_RE = /^\s*[│┃┆┊├└▏]/
/** 子行展示时剥离的前缀 */
const GRP_PREFIX_RE = /^\s*[│┃┆┊├└▏]\s?/

type LogItem =
  | { kind: 'row'; e: LogEntry }
  | {
      kind: 'group'
      id: string
      head: LogEntry
      headText: string
      children: { e: LogEntry; text: string }[]
    }

/**
 * 把 console groupCollapsed 块解析成可折叠组：
 * - `┘ 内容` 头行开组，`│` 前缀行进入当前组，单独 `┘`（groupEnd）关组；
 * - 无归属的 `│` 行（前面没有开着的组）保持普通行原样渲染；
 * - 任何普通日志行关闭当前组（实践上 Request/Response 组是同步输出的，不会被正常日志打断）；
 * - 组内出现新的 `┘` 头行按新组处理（只做一层折叠，嵌套组拍平为兄弟组）。
 */
export function buildLogItems(entries: LogEntry[]): LogItem[] {
  const items: LogItem[] = []
  let cur: { id: string; head: LogEntry; headText: string; children: { e: LogEntry; text: string }[] } | null = null
  let openedHere = false // 当前组是否由本条 entry 的头行开出（用于异常混排时丢弃防重复）
  const flush = () => {
    if (cur) {
      items.push({ kind: 'group', id: cur.id, head: cur.head, headText: cur.headText, children: cur.children })
      cur = null
    }
    openedHere = false
  }
  for (const e of entries) {
    const lines = e.text.split('\n')
    let consumed = false // 整条 entry 被组吸收（不再渲染普通行）
    openedHere = false
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      const hm = line.match(GRP_HEAD_RE)
      if (hm && (i === 0 || cur || consumed)) {
        flush()
        cur = { id: `${e.id}:${i}`, head: e, headText: hm[1].trim(), children: [] }
        openedHere = i === 0
        consumed = true
        continue
      }
      if (GRP_END_RE.test(line)) {
        flush()
        consumed = true
        continue
      }
      if (GRP_CHILD_RE.test(line)) {
        if (cur) {
          cur.children.push({ e, text: line.replace(GRP_PREFIX_RE, '') })
          consumed = true
        }
        /* 无开组时落入普通行处理（保留原文本） */
        continue
      }
      /* 缩进续行（多行对象 inspect，真机实测组内不带 │ 前缀）：组开着时并入当前组 */
      if (cur && /^\s+\S/.test(line)) {
        cur.children.push({ e, text: line.trim() })
        consumed = true
        continue
      }
      /* 普通日志行：关闭当前组，整条 entry 渲染为普通行 */
      if (cur && openedHere) cur = null // 头行与正文混在同一条 entry：丢弃残组避免重复
      else flush()
      consumed = false
      break
    }
    if (!consumed) items.push({ kind: 'row', e })
  }
  flush()
  return items
}

/** 关键词高亮 */
function Highlight({ text, terms }: { text: string; terms: string[] }) {
  if (!terms.length) return <>{text}</>
  const re = new RegExp(`(${terms.map(escapeRe).join('|')})`, 'gi')
  const parts = text.split(re)
  return (
    <>
      {parts.map((p, i) =>
        i % 2 === 1 ? (
          <mark key={i}>{p}</mark>
        ) : (
          <span key={i}>{p}</span>
        )
      )}
    </>
  )
}

/* ---------- 接口视图：解析 console 里的 API Request / API Response ---------- */

interface ApiCall {
  id: string
  ts: number
  method: string
  path: string
  status?: number
  duration?: string
  /** 请求详情块（关键字行之后吸收的后续日志行） */
  req: string[]
  /** 响应详情块 */
  res: string[]
}

const API_HEADER_RE = /API\s+(Request|Response)\s*[:：]\s*([A-Za-z]+)\s+(\S+)(.*)/

/**
 * groupCollapsed 子行前缀：真机 logcat 实测为 Unicode 制表符 `│`（U+2502），
 * 兼容 ASCII '|'、树形符号（┃┆┊├└）与缩进形式。
 */
const API_BOX_RE = /^\s*[|│┃┆┊├└▏]/
/** 多行对象 / 参数的缩进续行（RN console 对 Body/Data 等 pretty-print 出几百行） */
const API_INDENT_RE = /^\s+\S/
/** groupEnd 空标记行（真机实测为单独一个 `┘`） */
const API_GROUP_END_RE = /^\s*[│┃┆┊├└┘▏]?\s*$/
/**
 * 关键字行（可带 [TAG] 前缀或 'Key' 引号形式）：
 * 真机实测形如 `│ 'URL:', 'https://…'`、`│ 'Status:', 200`、`│ cURL Command:`
 */
const API_CHILD_KEY_RE =
  /^(?:\[[^\]]*\]\s*)?['"]?(?:Status|Data|Time|Duration|Body|Params|Query|Headers|URL|cURL[^:'"]*|Request|Response|Error|Message)['"]?\s*[:：]/i

/**
 * 从详情块中兜底提取状态码 / 耗时。
 * 真机实测：console.log('Status:', 200) 渲染为 `'Status:', 200`（冒号在引号内，值前有 `', ` 分隔），
 * 因此冒号与数值之间允许跳过少量非数字字符（`', '`）。
 */
function extractMeta(lines: string[]): { status?: number; duration?: string } {
  let status: number | undefined
  let duration: string | undefined
  for (const l of lines) {
    if (status == null) {
      const s = l.match(/Status['"]?\s*[:：][^0-9]{0,8}(\d{3})/i)
      if (s) status = Number(s[1])
    }
    if (!duration) {
      const d = l.match(/Duration['"]?\s*[:：][^0-9]{0,8}(\d+(?:\.\d+)?)\s*ms/i)
      if (d) duration = `${d[1]}ms`
    }
    if (status != null && duration) break
  }
  return { status, duration }
}

/**
 * 从运行日志中解析接口调用：
 * - 命中「API Request: METHOD /path」开一条记录，命中「API Response: METHOD /path」按 方法+路径 配对到最近的未响应请求；
 * - 真机 logcat 实测格式：groupCollapsed 头行以 `┘` 开头，子行以 `│` 开头（'URL:'/'Body:'/'Headers:'/'Status:'/'Data:'/
 *   'Time:'/'cURL Command:' 等），Body/Data 对象被 RN console pretty-print 成多行缩进续行；
 * - 吸收规则：制表符前缀行、缩进续行、关键字行进入当前详情块；单独 `┘` 为 groupEnd 关闭块；
 *   穿插的系统日志（device 源，如 SDM/HWUI）跳过不打断；其它应用日志结束块；
 * - 状态码优先从关键字行括号尾注取，取不到再从详情块里的 Status 行兜底，耗时从 Duration 行兜底。
 */
export function parseApiLogs(entries: LogEntry[]): ApiCall[] {
  const calls: ApiCall[] = []
  const pending: ApiCall[] = []
  let cur: { call: ApiCall; part: 'req' | 'res' } | null = null
  let seq = 0

  for (const e of entries) {
    const lines = e.text.split('\n')
    for (let li = 0; li < lines.length; li++) {
      const line = lines[li]
      const m = line.match(API_HEADER_RE)
      if (m) {
        const kind = m[1].toLowerCase()
        const method = m[2].toUpperCase()
        const path = m[3]
        const tail = m[4] || ''
        const paren = tail.match(/\(([^)]*)\)/)?.[1] ?? ''
        const sm = paren.match(/\b(\d{3})\b/)
        const status = sm ? Number(sm[1]) : undefined
        const dm = paren.match(/(\d+(?:\.\d+)?)\s*m?s\b/i)
        const duration = dm ? dm[0].trim() : undefined

        if (kind === 'request') {
          const call: ApiCall = { id: `api-${seq++}`, ts: e.ts, method, path, req: [], res: [] }
          pending.push(call)
          calls.push(call)
          cur = { call, part: 'req' }
        } else {
          let target: ApiCall | undefined
          for (let i = pending.length - 1; i >= 0; i--) {
            if (pending[i].method === method && pending[i].path === path && pending[i].res.length === 0) {
              target = pending[i]
              break
            }
          }
          if (target) {
            target.status = status ?? target.status
            target.duration = duration ?? target.duration
            cur = { call: target, part: 'res' }
          } else {
            const call: ApiCall = { id: `api-${seq++}`, ts: e.ts, method, path, status, duration, req: [], res: [] }
            calls.push(call)
            cur = { call, part: 'res' }
          }
        }
        continue
      }
      // 详情行吸收：制表符前缀 / 缩进续行（多行对象）/ 关键字行
      if (cur) {
        const bare = line.trim()
        const arr = cur.call[cur.part]
        if (!bare) {
          /* 空行忽略 */
        } else if (API_BOX_RE.test(line) || API_INDENT_RE.test(line) || API_CHILD_KEY_RE.test(line)) {
          if (arr.length < 2000) arr.push(line)
          else cur = null
        } else if (API_GROUP_END_RE.test(line) && !API_BOX_RE.test(line)) {
          cur = null // groupEnd 空标记（单独 `┘`）
        } else if (e.source === 'device') {
          /* 穿插的系统日志（SDM / HWUI 等）：跳过不打断块 */
        } else {
          cur = null // 其它应用日志：详情块结束
        }
      }
    }
  }

  // 块内兜底提取 Status / Duration（关键字行括号尾注缺省时）
  for (const c of calls) {
    const meta = extractMeta([...c.res, ...c.req])
    if (c.status == null && meta.status != null) c.status = meta.status
    if (!c.duration && meta.duration) c.duration = meta.duration
  }
  return calls
}

function apiStatusClass(c: ApiCall): string {
  if (c.res.length === 0) return 'pend'
  const s = c.status ?? 0
  if (s >= 200 && s < 300) return 'ok'
  if (s >= 300 && s < 400) return 'redir'
  if (s >= 400 || s === 0) return 'fail'
  return ''
}

/* ---------- 接口详情：将原始日志块解析成结构化字段（对齐网络页详情样式） ---------- */

interface ApiField {
  key: string
  text: string
}

/** 识别日志块内的字段行（如 `│ 'URL:', '...'` / `│ 'Headers:', {...}`）；
 *  key 必须命中已知字段集合：API 日志库只输出这些 key，对象 inspect 续行（每行也带 │ 前缀、
 *  形如 `│ 'tagId': 47,`）不会误判为新字段，而是作为当前字段的续行被完整吸收 */
const API_FIELD_KEYS_RE =
  /^(?:url|headers?|body|data|status|time|duration|params|query|curl[^:]*|request|response|error|message)$/i
const API_FIELD_RE = /^\s*[|│┃┆┊├└▏]\s*['"]?([A-Za-z][\w ]*?)['"]?\s*[:：]/
/** 避免把 `true:` / `false:` / `123:` 这类值行误判为字段头 */
const API_FIELD_VAL_RE = /^\s*[|│┃┆┊├└▏]?\s*['"]?(?:true|false|null|-?\d)['"]?\s*[:：]/

function parseApiBlock(lines: string[]): ApiField[] {
  const fields: ApiField[] = []
  let cur: ApiField | null = null
  // 括号深度 / 字符串状态跨行维持：响应对象内部可能也有 data / message 等同名属性
  // （如 `│ 'data': {` 出现在 Data 值对象内部），只有深度为 0 时的已知 key 行才是真正的字段头
  let depth = 0
  let inStr = false
  let esc = false
  for (const line of lines) {
    const m = line.match(API_FIELD_RE)
    const isField =
      !!m && !API_FIELD_VAL_RE.test(line) && API_FIELD_KEYS_RE.test(m[1].trim()) && depth === 0 && !inStr
    if (isField) {
      cur = { key: m[1].trim(), text: line }
      fields.push(cur)
    } else if (cur) {
      cur.text += '\n' + line
    }
    for (const c of line) {
      if (inStr) {
        if (esc) esc = false
        else if (c === '\\') esc = true
        else if (c === "'" || c === '"') inStr = false
        continue
      }
      if (c === "'" || c === '"') inStr = true
      else if (c === '{' || c === '[') depth++
      else if (c === '}' || c === ']') depth = Math.max(0, depth - 1)
    }
  }
  return fields
}

/** 取字段值：去掉首行的 `│` 前缀与 `'Key:'` 头部（冒号在引号内；含紧随其后的逗号，如 `'Body':, {`），仅保留续行的值部分 */
function fieldValue(text: string): string {
  return text
    .split('\n')
    .map((l, i) => {
      const s = l.replace(/^\s*[|│┃┆┊├└▏]?\s*/, '')
      return i === 0 ? s.replace(/^[^:：]*[:：]'?\s*,?\s*/, '') : s
    })
    .join('\n')
    .trim()
}

/** 把 Headers 对象（JS 字面量，单引号）解析成 key-value 行，去掉引号 */
function parseHeadersObject(text: string): { key: string; value: string }[] {
  const inner = text
    .split('\n')
    .map((l) => l.replace(/^\s*[|│┃┆┊├└▏]?\s*/, ''))
    .join('\n')
    .replace(/^\s*\{/, '')
    .replace(/\}\s*$/, '')
  const out: { key: string; value: string }[] = []
  // 形如：key: 'value' 或 'key': 'value'（含单/双引号）
  const re = /(['"]?)([\w.\-\/ ]+?)\1\s*:\s*(?:'([^']*)'|"([^"]*)"|([^\n,]+))(?:,|\s*$)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(inner)) !== null) {
    const key = m[2].trim()
    const value = (m[3] ?? m[4] ?? m[5] ?? '').trim()
    if (key) out.push({ key, value })
  }
  return out
}

/**
 * 把 JS 对象字面量（单引号字符串 + 不引号 key）转成规范 JSON（双引号）。
 * 用于请求体 / 响应体的「单双引号转化」展示；解析失败返回 null，调用方回退到原文。
 * 兼容 console inspect 的省略号截断标记（… / … N more）：按对象/数组上下文替换为可解析的占位值，
 * 末尾再走截断修复（console 文本超上限被截断时补齐闭合）。
 */
function jsObjToJson(text: string): string | null {
  let s = text.trim()
  try {
    // 1. 单引号字符串 -> 双引号 JSON 字符串（逆向转义内部单引号）
    s = s.replace(/'((?:[^'\\]|\\.)*)'/g, (_m, inner: string) => JSON.stringify(inner.replace(/\\'/g, "'")))
    // 2. 未加引号的 key 补双引号：{, 之后、冒号之前的标识符
    s = s.replace(/([{,]\s*)([A-Za-z_$][\w$.\- ]*?)(\s*):/g, '$1"$2"$3:')
    // 3. JS 特有字面量（undefined / NaN / Infinity）不是合法 JSON，置为 null
    s = s.replace(/:\s*undefined\b/g, ': null').replace(/:\s*NaN\b/g, ': null').replace(/:\s*Infinity\b/g, ': null')
    // 4. inspect 省略号标记：… N more → null（数组截断）；其余 … 按所在容器是对象/数组分别处理
    s = sanitizeEllipsis(s)
    // 5. 解析；失败尝试截断修复（console 文本超上限被硬截断的场景）
    try {
      const obj = JSON.parse(s)
      return JSON.stringify(obj, null, 2)
    } catch {
      const fixed = repairTruncated(s)
      if (!fixed) return null
      const obj = JSON.parse(fixed)
      return JSON.stringify(obj, null, 2)
    }
  } catch {
    return null
  }
}

/** 上下文感知地替换 inspect 省略号：对象内条目位置 → "…": null，数组元素 / 值位置 → null */
function sanitizeEllipsis(s: string): string {
  const stack: ('obj' | 'arr')[] = []
  let inStr = false
  let esc = false
  let out = ''
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (inStr) {
      out += c
      if (esc) esc = false
      else if (c === '\\') esc = true
      else if (c === '"') inStr = false
      continue
    }
    if (c === '"') {
      inStr = true
      out += c
      continue
    }
    if (c === '{' || c === '[') {
      stack.push(c === '{' ? 'obj' : 'arr')
      out += c
      continue
    }
    if (c === '}' || c === ']') {
      stack.pop()
      out += c
      continue
    }
    if (c === '…') {
      // 向后看是否带 "N more" 计数
      const rest = s.slice(i)
      const more = rest.match(/^…\s*\d+\s*more/)
      // 向前看容器类型：最近一个未闭合容器
      const ctx = stack[stack.length - 1]
      if (more) {
        out += 'null'
        i += more[0].length - 1
        continue
      }
      if (ctx === 'arr') {
        out += 'null'
        continue
      }
      // 对象内：条目位置（后随 , 或 }）→ "…": null；值位置（前有冒号）→ null
      const prev = out.replace(/\s+$/, '')
      const next = s.slice(i + 1).replace(/^\s+/, '')
      if (prev.endsWith(':')) out += 'null'
      else out += '"…": null'
      continue
    }
    out += c
  }
  return out
}

/** 从请求块抽取 cURL 命令（日志里 `cURL Command:` 行），找不到则依据 URL/请求头/请求体重建 */
function extractCurl(call: ApiCall): string | null {
  const reqFields = parseApiBlock(call.req)
  const curlField = reqFields.find((f) => /^cURL\s*command$/i.test(f.key))
  if (curlField) {
    const v = fieldValue(curlField.text).trim()
    const m = v.match(/^['"]?(.*?)['"]?$/s)
    if (m && m[1].trim()) return m[1].trim()
  }
  const urlField = reqFields.find((f) => /^url$/i.test(f.key))
  const url = urlField
    ? fieldValue(urlField.text).replace(/^['"]|['"]$/g, '')
    : call.path.startsWith('http')
      ? call.path
      : ''
  if (!url) return null
  const seg: string[] = [`curl -X ${call.method} '${url}'`]
  const hdrField = reqFields.find((f) => /^headers?$/i.test(f.key))
  if (hdrField) {
    try {
      const obj = JSON.parse(fieldValue(hdrField.text))
      for (const [k, v] of Object.entries(obj)) seg.push(`-H '${k}: ${String(v).replace(/'/g, "\\'")}'`)
    } catch {
      /* 非 JSON 头则跳过 */
    }
  }
  for (const k of ['body', 'params', 'query']) {
    const bf = reqFields.find((f) => new RegExp(`^${k}$`, 'i').test(f.key))
    if (bf) seg.push(`--data-raw '${fieldValue(bf.text).replace(/'/g, "\\'")}'`)
  }
  return seg.join(' \\\n  ')
}

function fmtDuration(d?: string): string {
  return d ?? '-'
}

/** 普通日志行（分组视图与平铺视图共用） */
function LogRow({ e, terms }: { e: LogEntry; terms: string[] }) {
  return (
    <div className={`lg-row lv-${e.level}`}>
      <span className="lg-time">{stamp(e.ts)}</span>
      <span className={`lg-lv lv-${e.level}`}>{LV_LABEL[e.level]}</span>
      <span className={`lg-src src-${e.source}`} title={e.tag ? `tag: ${e.tag}` : e.source}>
        {e.tag ?? e.source}
      </span>
      <span className="lg-text">
        <Highlight text={e.text} terms={terms} />
      </span>
    </div>
  )
}

export default function LogConsole({ entries, following, deviceLabel, onToggleFollow, onClear }: Props) {
  /**
   * view 同时承担「级别过滤」与「接口视图」：全部 / 各级别 / 接口 为同一组单选 pill，
   * 互斥不可同时选中；接口是全部的子集（解析自全部日志里的 API Request / API Response）。
   */
  const [view, setView] = useState<'all' | LogLevel | 'api'>('all')
  const showApi = view === 'api'
  const level: 'all' | LogLevel = showApi ? 'all' : view
  const [source, setSource] = useState<'all' | LogSource>('all')
  const [q, setQ] = useState('')
  const [autoScroll, setAutoScroll] = useState(() => localStorage.getItem('logAutoScroll') !== '0')
  const [wrap, setWrap] = useState(() => localStorage.getItem('logWrap') !== '0')
  const [copied, setCopied] = useState(false)
  /** 展开的分组（groupCollapsed 默认折叠，点击头行切换） */
  const [openGroups, setOpenGroups] = useState<Set<string>>(() => new Set())
  const bodyRef = useRef<HTMLDivElement>(null)
  const stickRef = useRef(true)

  const toggleGroup = (id: string) =>
    setOpenGroups((s) => {
      const n = new Set(s)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      return n
    })

  const terms = useMemo(
    () =>
      q
        .trim()
        .split(/\s+/)
        .filter(Boolean),
    [q]
  )

  // 关键词命中（多关键词为 AND）
  const byKeyword = useMemo(() => {
    if (!terms.length) return entries
    const lower = terms.map((t) => t.toLowerCase())
    return entries.filter((e) => {
      const hay = `${e.text} ${e.tag ?? ''} ${e.source}`.toLowerCase()
      return lower.every((t) => hay.includes(t))
    })
  }, [entries, terms])

  // 各自维度计数不受自身过滤影响（便于发现被滤掉的内容）
  const levelCounts = useMemo(() => {
    const m: Record<string, number> = { all: byKeyword.length }
    for (const e of byKeyword) m[e.level] = (m[e.level] ?? 0) + 1
    return m
  }, [byKeyword])

  const sourceCounts = useMemo(() => {
    const m: Record<string, number> = { all: byKeyword.length }
    for (const e of byKeyword) m[e.source] = (m[e.source] ?? 0) + 1
    return m
  }, [byKeyword])

  const visible = useMemo(
    () =>
      byKeyword.filter(
        (e) => (level === 'all' || e.level === level) && (source === 'all' || e.source === source)
      ),
    [byKeyword, level, source]
  )

  const errorCount = levelCounts.error ?? 0

  // 分组视图：无关键词搜索时把 groupCollapsed 块折叠成组；
  // 关键词搜索退回平铺（避免命中内容藏在折叠组里看不到）
  const logItems = useMemo(() => (terms.length ? null : buildLogItems(visible)), [visible, terms])

  // 接口视图数据：只解析含 API Request / API Response 关键字的日志（与网络页抓包逻辑独立）
  const apiCalls = useMemo(() => (showApi ? parseApiLogs(entries) : []), [entries, showApi])

  useEffect(() => {
    if (!autoScroll || !stickRef.current) return
    const el = bodyRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [visible, autoScroll])

  useEffect(() => localStorage.setItem('logAutoScroll', autoScroll ? '1' : '0'), [autoScroll])
  useEffect(() => localStorage.setItem('logWrap', wrap ? '1' : '0'), [wrap])

  const onScroll = () => {
    const el = bodyRef.current
    if (!el) return
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24
    stickRef.current = atBottom
    if (atBottom !== autoScroll) setAutoScroll(atBottom)
  }

  const resetFilter = () => {
    setView('all')
    setSource('all')
    setQ('')
  }

  const hasFilter = level !== 'all' || source !== 'all' || !!q.trim()

  const copyVisible = async () => {
    const txt = visible.map((e) => `${stamp(e.ts)} ${LV_LABEL[e.level]} [${e.source}] ${e.text}`).join('\n')
    try {
      await navigator.clipboard.writeText(txt)
      setCopied(true)
      setTimeout(() => setCopied(false), 1200)
    } catch {
      /* 剪贴板不可用时忽略 */
    }
  }

  return (
    <div className="log">
      <div className="lg-bar">
        <div className="lg-pills">
          <button className={`lg-pill ${view === 'all' ? 'on' : ''}`} onClick={() => setView('all')}>
            全部<span className="n">{levelCounts.all ?? 0}</span>
          </button>
          {LEVELS.map((l) => (
            <button
              key={l.key}
              className={`lg-pill lv-${l.key} ${view === l.key ? 'on' : ''}`}
              onClick={() => setView(l.key)}
            >
              {l.label}
              <span className="n">{levelCounts[l.key] ?? 0}</span>
            </button>
          ))}
          <button className={`lg-pill ${view === 'api' ? 'on' : ''}`} onClick={() => setView('api')}>
            接口<span className="n">{showApi ? apiCalls.length : ''}</span>
          </button>
        </div>
        {!showApi ? (
          <span className="lg-count">
            {visible.length} / {entries.length}
            {errorCount > 0 && <span className="lg-errn"> · 错误 {errorCount}</span>}
          </span>
        ) : (
          <span className="lg-count">{apiCalls.length} 条接口调用（来自日志 API Request / Response）</span>
        )}
      </div>

      {!showApi ? (
        <>
          <div className="lg-bar">
            <select
              className="lg-input lg-select"
              value={source}
              onChange={(e) => setSource(e.target.value as 'all' | LogSource)}
              title="按来源过滤"
            >
              <option value="all">来源：全部</option>
              {SOURCES.map((s) => (
                <option key={s.key} value={s.key}>
                  {s.label} ({sourceCounts[s.key] ?? 0})
                </option>
              ))}
            </select>
            <input
              className="lg-input"
              placeholder="关键词过滤（空格分隔，多个为同时命中）"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
            {hasFilter && (
              <button className="btn ghost sm" onClick={resetFilter}>
                清除过滤
              </button>
            )}
            <button
              className={`lg-toggle ${following ? 'on' : ''}`}
              onClick={onToggleFollow}
              title="跟随当前设备采集 RN 应用 console / 设备日志"
            >
              <span className="dot" />
              跟随设备
            </button>
            <button className={`lg-toggle ${autoScroll ? 'on' : ''}`} onClick={() => setAutoScroll((v) => !v)}>
              自动滚动
            </button>
            <button className={`lg-toggle ${wrap ? 'on' : ''}`} onClick={() => setWrap((v) => !v)}>
              换行
            </button>
            <button className="lg-toggle" onClick={copyVisible} disabled={!visible.length}>
              {copied ? '已复制' : '复制'}
            </button>
            <button className="lg-toggle danger" onClick={onClear} disabled={!entries.length}>
              清空
            </button>
          </div>

          <div className="lg-hint">
            {following
              ? `正在采集${deviceLabel ? ` ${deviceLabel} ` : ' '}的应用 console / 设备日志（切走也继续），运行工程会额外汇入 Metro 输出。`
              : '未采集设备日志：打开「跟随设备」可实时抓取 RN 应用 console 输出（logcat / simctl）。'}
          </div>

          <div className={`lg-body ${wrap ? '' : 'nowrap'}`} ref={bodyRef} onScroll={onScroll}>
            {visible.length === 0 ? (
              <div className="lg-empty">
                {entries.length === 0 ? '暂无日志' : '当前过滤条件下没有日志'}
              </div>
            ) : logItems ? (
              logItems.map((it) =>
                it.kind === 'row' ? (
                  <LogRow e={it.e} terms={terms} key={it.e.id} />
                ) : (
                  <div className="lg-grp" key={it.id}>
                    <div
                      className={`lg-row lg-head lv-${it.head.level}`}
                      onClick={() => toggleGroup(it.id)}
                      title={openGroups.has(it.id) ? '点击折叠分组' : '点击展开分组'}
                    >
                      <span className="lg-time">{stamp(it.head.ts)}</span>
                      <span className={`lg-lv lv-${it.head.level}`}>{LV_LABEL[it.head.level]}</span>
                      <span
                        className={`lg-src src-${it.head.source}`}
                        title={it.head.tag ? `tag: ${it.head.tag}` : it.head.source}
                      >
                        {it.head.tag ?? it.head.source}
                      </span>
                      <span className="lg-text">
                        <span className="lg-tri">{openGroups.has(it.id) ? '▾' : '▸'}</span>
                        {it.headText}
                      </span>
                    </div>
                    {openGroups.has(it.id) &&
                      it.children.map((c, ci) => (
                        <div className={`lg-row lg-child lv-${c.e.level}`} key={ci}>
                          <span className="lg-time">{stamp(c.e.ts)}</span>
                          <span className={`lg-lv lv-${c.e.level}`}>{LV_LABEL[c.e.level]}</span>
                          <span
                            className={`lg-src src-${c.e.source}`}
                            title={c.e.tag ? `tag: ${c.e.tag}` : c.e.source}
                          >
                            {c.e.tag ?? c.e.source}
                          </span>
                          <span className="lg-text">{c.text}</span>
                        </div>
                      ))}
                  </div>
                )
              )
            ) : (
              visible.map((e) => <LogRow e={e} terms={terms} key={e.id} />)
            )}
          </div>
        </>
      ) : (
        <ApiView calls={apiCalls} totalLogs={entries.length} />
      )}
    </div>
  )
}

/* ---------- 接口视图 UI：列表 + 可拖拽详情 ---------- */

function ApiView({ calls, totalLogs }: { calls: ApiCall[]; totalLogs: number }) {
  const [q, setQ] = useState('')
  const [selected, setSelected] = useState<ApiCall | null>(null)
  const [detailH, setDetailH] = useState(300)
  const [curlCopied, setCurlCopied] = useState(false)

  const curl = useMemo(() => (selected ? extractCurl(selected) : null), [selected])

  const copyCurl = async () => {
    if (!curl) return
    try {
      await navigator.clipboard.writeText(curl)
      setCurlCopied(true)
      setTimeout(() => setCurlCopied(false), 1200)
    } catch {
      /* 剪贴板不可用时忽略 */
    }
  }

  const nq = q.trim().toLowerCase()
  const filtered = useMemo(
    () => (!nq ? calls : calls.filter((c) => `${c.method} ${c.path}`.toLowerCase().includes(nq))),
    [calls, nq]
  )

  // 数据刷新后若选中记录已不存在则取消选中
  useEffect(() => {
    if (selected && !calls.some((c) => c.id === selected.id)) setSelected(null)
  }, [calls, selected])

  const startDrag = (e: ReactMouseEvent<HTMLDivElement>) => {
    e.preventDefault()
    const startY = e.clientY
    const startH = detailH
    const move = (ev: MouseEvent) => {
      const max = Math.max(160, window.innerHeight - 300)
      setDetailH(Math.min(Math.max(120, startH + (startY - ev.clientY)), max))
    }
    const up = () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  return (
    <div className="np-body lc-api">
      <div className="np-filter">
        <input
          className="np-input"
          placeholder="模糊搜索：接口路径 / 方法"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        {nq !== '' && (
          <button className="btn ghost sm" onClick={() => setQ('')}>
            清除
          </button>
        )}
        <span className="np-count">
          {filtered.length} / {calls.length}
        </span>
      </div>

      <div className="ap-list">
        {filtered.length === 0 ? (
          <div className="screen-empty">
            {calls.length === 0
              ? totalLogs === 0
                ? '暂无日志'
                : '暂无接口调用：日志中未发现包含 API Request / API Response 关键字的输出'
              : '无匹配接口，调整搜索条件试试'}
          </div>
        ) : (
          filtered.map((c) => (
            <div
              key={c.id}
              className={`ap-row ${selected?.id === c.id ? 'sel' : ''} ${apiStatusClass(c)}`}
              onClick={() => setSelected(c)}
              title={`${c.method} ${c.path}`}
            >
              <span className="ap-icon">{c.res.length > 0 ? '✅' : '➡️'}</span>
              <span className="ap-path">{c.path}</span>
              <span className="c-method">{c.method}</span>
              <span className="c-status">{c.res.length > 0 ? c.status ?? '-' : '…'}</span>
              <span className="ap-dur">{fmtDuration(c.duration)}</span>
              <span className="ap-time">{stamp(c.ts)}</span>
            </div>
          ))
        )}
      </div>

      {selected && (
        <>
          <div className="np-splitter" onMouseDown={startDrag} title="拖动调整详情高度" />
          <div className="np-detail" style={{ flex: 'none', height: detailH }}>
            <div className="np-detail-title">
              <span className="dt-method">{selected.method}</span>
              <span className="dt-url" title={selected.path}>
                {selected.path}
              </span>
              <span className={`dt-meta ${apiStatusClass(selected)}`}>
                {selected.res.length > 0 ? (selected.status ?? '-') : '待响应'} · {fmtDuration(selected.duration)}
              </span>
              <div className="np-detail-actions">
                {curl && (
                  <button className="btn ghost sm" onClick={copyCurl}>
                    {curlCopied ? '已复制' : '复制 cURL'}
                  </button>
                )}
                <button className="np-close" onClick={() => setSelected(null)} title="关闭详情">
                  ✕
                </button>
              </div>
            </div>
            <LogDetail call={selected} />
          </div>
        </>
      )}
    </div>
  )
}

/* ---------- 接口详情：请求 / 预览 / 响应（对齐网络页详情面板） ---------- */

type LogDetailTab = 'request' | 'preview' | 'response'

function LogDetail({ call }: { call: ApiCall }) {
  const [tab, setTab] = useState<LogDetailTab>('request')
  const [q, setQ] = useState('')
  useEffect(() => {
    setTab('request')
    setQ('')
  }, [call.id])

  const reqFields = useMemo(() => parseApiBlock(call.req), [call.req])
  const resFields = useMemo(() => parseApiBlock(call.res), [call.res])
  const searchQ = q.trim()

  return (
    <div className="np-detail-body">
      <div className="np-dtabs">
        <button className={`np-dtab ${tab === 'request' ? 'on' : ''}`} onClick={() => setTab('request')}>
          请求
        </button>
        <button className={`np-dtab ${tab === 'preview' ? 'on' : ''}`} onClick={() => setTab('preview')}>
          预览
        </button>
        <button className={`np-dtab ${tab === 'response' ? 'on' : ''}`} onClick={() => setTab('response')}>
          响应
        </button>
        <input
          className="np-dsearch"
          placeholder="搜索…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>
      <div className="np-detail-scroll">
        {tab === 'request' && <LogRequest reqFields={reqFields} q={searchQ} />}
        {tab === 'preview' && <LogPreview resFields={resFields} reqFields={reqFields} q={searchQ} />}
        {tab === 'response' && <LogResponse resFields={resFields} q={searchQ} />}
      </div>
    </div>
  )
}

/** 请求体 / 响应体格式化：标准 JSON（含截断修复 / 双重编码解包）优先直解，失败再走单引号字面量转换（console inspect 形态），都失败回退原文 */
function formatBody(text: string): string | null {
  return prettyJson(text) ?? jsObjToJson(text)
}

/** 请求体 / 响应体解析为对象：标准 JSON（含截断修复 / 双重编码解包）优先，失败再走单引号字面量转换（console inspect 形态） */
function parseBodyObject(text: string): unknown {
  const direct = parseJsonFlexible(text)
  if (direct !== undefined) return direct
  const conv = jsObjToJson(text)
  if (conv) {
    try {
      return JSON.parse(conv)
    } catch {
      /* 忽略，返回 undefined */
    }
  }
  return undefined
}

/** 请求 tab：请求头（解析每行）+ 请求体（body / params / query）；cURL Command 不展示，复制按钮直接拿该值 */
function LogRequest({ reqFields, q }: { reqFields: ApiField[]; q: string }) {
  const [rawView, setRawView] = useState(false)
  const headerFields = reqFields.filter((f) => /^headers?$/i.test(f.key))
  const bodyFields = reqFields.filter((f) => /^(body|params|query)$/i.test(f.key))

  return (
    <>
      {headerFields.length > 0 && (
        <>
          <div className="ep-sec">请求头</div>
          {headerFields.map((f) => {
            const rows = parseHeadersObject(fieldValue(f.text))
            if (rows.length === 0) {
              return (
                <pre className="np-body-text" key={f.key}>
                  {fieldValue(f.text)}
                </pre>
              )
            }
            return (
              <div className="np-headers" key={f.key}>
                {rows.map((r, i) => (
                  <div className="np-hrow" key={i}>
                    <span className="hk">{r.key}</span>
                    <span className="hv">{r.value}</span>
                  </div>
                ))}
              </div>
            )
          })}
        </>
      )}

      {bodyFields.length > 0 && (
        <>
          <div className="ep-sec">请求体</div>
          {bodyFields.some((f) => formatBody(fieldValue(f.text))) && (
            <div className="np-json-bar">
              <button className={`btn ghost sm ${rawView ? '' : 'on'}`} onClick={() => setRawView(false)}>
                格式化
              </button>
              <button className={`btn ghost sm ${rawView ? 'on' : ''}`} onClick={() => setRawView(true)}>
                原文
              </button>
            </div>
          )}
          {bodyFields.map((f) => {
            const raw = fieldValue(f.text)
            const json = formatBody(raw)
            return (
              <SearchedPre
                text={rawView || !json ? raw : json}
                q={q}
                className="np-body-text tall"
                key={f.key}
              />
            )
          })}
        </>
      )}

      {headerFields.length === 0 && bodyFields.length === 0 && (
        <div className="screen-empty">无请求头 / 请求体详情</div>
      )}
    </>
  )
}

/** 预览 tab：响应体 JSON 树视图（对齐网络页「预览」；请求体兜底），支持搜索剪枝 */
function LogPreview({
  resFields,
  reqFields,
  q
}: {
  resFields: ApiField[]
  reqFields: ApiField[]
  q: string
}) {
  const [openAll, setOpenAll] = useState(false)
  const [treeKey, setTreeKey] = useState(0)

  const bodyFields = resFields.filter((f) => /^(data|body|result|error|message)$/i.test(f.key))
  const reqBodyFields = reqFields.filter((f) => /^(body|params|query)$/i.test(f.key))
  const src = bodyFields[0] ?? reqBodyFields[0]

  const json = useMemo(() => (src ? parseBodyObject(fieldValue(src.text)) : undefined), [src])
  const pruned = useMemo(() => (q && json !== undefined ? pruneJson(json, q) : undefined), [json, q])

  if (json === undefined) {
    return (
      <div className="screen-empty">
        {bodyFields.length > 0 ? '响应体不是 JSON，切到「响应」查看原文' : '暂无响应体（尚未收到对应的 API Response 数据）'}
      </div>
    )
  }

  const expandTree = (open: boolean) => {
    setOpenAll(open)
    setTreeKey((k) => k + 1)
  }

  return (
    <>
      <div className="np-json-bar">
        <button className="btn ghost sm" onClick={() => expandTree(true)}>
          展开全部
        </button>
        <button className="btn ghost sm" onClick={() => expandTree(false)}>
          折叠全部
        </button>
      </div>
      {q && pruned === undefined ? (
        <div className="screen-empty">无匹配项</div>
      ) : (
        <JsonNode
          key={`${treeKey}-${q}-${openAll}`}
          k={null}
          v={q ? (pruned as unknown) : json}
          depth={0}
          defaultOpen={openAll || !!q}
        />
      )}
    </>
  )
}

/** 响应 tab：响应体数据（标准 JSON / 单引号对象 → 规范格式化，支持格式化 / 原文切换） */
function LogResponse({ resFields, q }: { resFields: ApiField[]; q: string }) {
  const [rawView, setRawView] = useState(false)
  const bodyFields = resFields.filter((f) => /^(data|body|result|error|message)$/i.test(f.key))
  if (bodyFields.length === 0) {
    return <div className="screen-empty">尚未收到对应的 API Response 数据</div>
  }
  return (
    <>
      <div className="ep-sec">响应体</div>
      {bodyFields.some((f) => formatBody(fieldValue(f.text))) && (
        <div className="np-json-bar">
          <button className={`btn ghost sm ${rawView ? '' : 'on'}`} onClick={() => setRawView(false)}>
            格式化
          </button>
          <button className={`btn ghost sm ${rawView ? 'on' : ''}`} onClick={() => setRawView(true)}>
            原文
          </button>
        </div>
      )}
      {bodyFields.map((f) => {
        const raw = fieldValue(f.text)
        const json = formatBody(raw)
        return (
          <SearchedPre
            text={rawView || !json ? raw : json}
            q={q}
            className="np-body-text tall"
            key={f.key}
          />
        )
      })}
    </>
  )
}
