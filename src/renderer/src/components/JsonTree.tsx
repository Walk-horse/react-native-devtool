/**
 * JSON 树视图 + 接口详情搜索组件（网络页详情与日志页接口详情共用）。
 */
import { useMemo, useState } from 'react'

function typeClass(v: unknown): string {
  if (v === null) return 'null'
  switch (typeof v) {
    case 'string':
      return 'str'
    case 'number':
      return 'num'
    case 'boolean':
      return 'bool'
    default:
      return 'other'
  }
}

function shortVal(v: unknown): string {
  if (v === null) return 'null'
  if (typeof v === 'string') return JSON.stringify(v)
  if (typeof v === 'object') return Array.isArray(v) ? `Array(${v.length})` : '{…}'
  return String(v)
}

function isObj(v: unknown): v is Record<string, unknown> | unknown[] {
  return v !== null && typeof v === 'object'
}

export function JsonNode({
  k,
  v,
  depth,
  defaultOpen
}: {
  k: string | null
  v: unknown
  depth: number
  defaultOpen?: boolean
}) {
  const [open, setOpen] = useState(defaultOpen ?? depth < 1)
  const pad = { paddingLeft: 8 + depth * 14 }

  if (!isObj(v)) {
    return (
      <div className="jn-row" style={pad}>
        {k !== null && <span className="jn-key">{k}</span>}
        <span className={`jn-val ${typeClass(v)}`}>{shortVal(v)}</span>
      </div>
    )
  }

  const isArr = Array.isArray(v)
  const entries: [string, unknown][] = isArr
    ? (v as unknown[]).map((x, i) => [String(i), x])
    : Object.entries(v as Record<string, unknown>)
  const [openB, closeB] = isArr ? ['[', ']'] : ['{', '}']

  return (
    <div className="jn-node">
      <div className="jn-row jn-head" style={pad} onClick={() => setOpen((o) => !o)}>
        <span className="jn-tw">{open ? '▾' : '▸'}</span>
        {k !== null && <span className="jn-key">{k}</span>}
        {!open && (
          <span className="jn-preview">
            <span className="jn-punct">{openB}</span>
            {entries.slice(0, 4).map(([kk, vv], i) => (
              <span key={kk}>
                {i > 0 && <span className="jn-punct">, </span>}
                {!isArr && <span className="jn-key">{kk}</span>}
                <span className={`jn-val ${typeClass(vv)}`}>{shortVal(vv)}</span>
              </span>
            ))}
            {entries.length > 4 && <span className="jn-punct">, …</span>}
            <span className="jn-punct">{closeB}</span>
            <span className="jn-count">{entries.length} 项</span>
          </span>
        )}
      </div>
      {open && (
        <>
          {entries.map(([kk, vv]) => (
            <JsonNode key={kk} k={kk} v={vv} depth={depth + 1} defaultOpen={defaultOpen} />
          ))}
          <div className="jn-row" style={pad}>
            <span className="jn-punct">{closeB}</span>
          </div>
        </>
      )}
    </div>
  )
}

/**
 * 树搜索剪枝：保留「key 或值命中（大小写不敏感）」的分支，命中节点的祖先链自动保留；
 * key 命中时整个子树保留。无任何命中返回 undefined。
 */
export function pruneJson(v: unknown, q: string): unknown {
  if (!q) return v
  const needle = q.toLowerCase()
  const hit = (s: string) => s.toLowerCase().includes(needle)
  const walk = (val: unknown, key: string | null): unknown => {
    if (val !== null && typeof val === 'object') {
      const isArr = Array.isArray(val)
      const entries: [string, unknown][] = isArr
        ? (val as unknown[]).map((x, i) => [String(i), x])
        : Object.entries(val as Record<string, unknown>)
      const out: unknown[] | Record<string, unknown> = isArr ? [] : {}
      let any = false
      for (const [kk, sub] of entries) {
        const kept = walk(sub, kk)
        if (kept !== undefined) {
          if (isArr) (out as unknown[]).push(kept)
          else (out as Record<string, unknown>)[kk] = kept
          any = true
        } else if (hit(kk)) {
          // key 本身命中：整个子树保留
          if (isArr) (out as unknown[]).push(sub)
          else (out as Record<string, unknown>)[kk] = sub
          any = true
        }
      }
      return any ? out : undefined
    }
    const str = typeof val === 'string' ? val : String(val)
    return hit(str) || (key !== null && hit(key)) ? val : undefined
  }
  return walk(v, null)
}

/** 文本体内嵌高亮的转义工具 */
function escapeReg(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 带搜索的文本体：无搜索词原样渲染；有搜索词只显示命中行并高亮命中片段（大小写不敏感）。
 */
export function SearchedPre({ text, q, className }: { text: string; q: string; className?: string }) {
  const body = useMemo(() => {
    if (!q.trim()) return null
    const needle = q.trim().toLowerCase()
    const lines = text.split('\n')
    const matched = lines.filter((l) => l.toLowerCase().includes(needle))
    return { lines: matched, total: lines.length, re: new RegExp(`(${escapeReg(q.trim())})`, 'gi') }
  }, [text, q])

  if (!body) return <pre className={className}>{text}</pre>
  return (
    <pre className={className} title={`匹配 ${body.lines.length} / ${body.total} 行`}>
      {body.lines.map((l, i) => (
        <span key={i}>
          {i > 0 && '\n'}
          {l === ''
            ? ''
            : l.split(body.re).map((part, j) =>
                j % 2 === 1 ? <mark key={j}>{part}</mark> : <span key={j}>{part}</span>
              )}
        </span>
      ))}
      {body.lines.length === 0 && <span className="jn-muted">（无匹配行）</span>}
    </pre>
  )
}
