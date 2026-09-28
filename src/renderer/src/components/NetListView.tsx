import { useEffect, useMemo, useState, type MouseEvent as ReactMouseEvent } from 'react'
import { NetEntry, NetMode } from '../types'
import { parseJsonFlexible as parseJson, prettyJson } from '../utils/jsonFormat'
import { JsonNode, pruneJson, SearchedPre } from './JsonTree'

/** 资源分类（精简 5 组），match 按 entry.type 判定；manifest / ws / wasm 未归类 → 其他 */
export const CATEGORIES: { key: string; label: string; types: string[] }[] = [
  { key: 'all', label: '全部', types: [] },
  { key: 'fetch', label: 'Fetch/XHR', types: ['fetch', 'xhr'] },
  { key: 'code', label: '代码', types: ['css', 'script', 'document'] },
  { key: 'file', label: '文件', types: ['img', 'media', 'font'] },
  { key: 'other', label: '其他', types: ['other'] }
]

/** 未能归属到具体应用的请求（iOS / 未开启识别 / 系统进程） */
export const UNKNOWN_APP = '__unknown'

/** 应用短名：包名取末两段，超长截断 */
export function appShort(app: string): string {
  const first = app.split('|')[0]
  if (first.startsWith('system:uid') || first.startsWith('uid')) return first
  const s = first.split('.').slice(-2).join('.')
  return s.length > 20 ? `${s.slice(0, 19)}…` : s
}

export function fmtBytes(n?: number) {
  if (n == null) return '-'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}
export function fmtTime(t: number) {
  const d = new Date(t)
  return d.toLocaleTimeString('zh-CN', { hour12: false }) + '.' + String(d.getMilliseconds()).padStart(3, '0')
}

function statusClass(e: NetEntry): string {
  if (e.error) return 'err'
  if (e.method === 'CONNECT') return 'tun'
  const s = e.status || 0
  if (s >= 200 && s < 300) return 'ok'
  if (s >= 300 && s < 400) return 'redir'
  if (s >= 400) return 'fail'
  return ''
}

/** 依据条目重建 cURL 命令（方法 / URL / 请求头 / 请求体），供「复制 cURL」使用 */
function buildCurl(e: NetEntry): string {
  const seg: string[] = [`curl -X ${e.method} '${e.url}'`]
  if (e.requestHeaders) {
    for (const [k, v] of Object.entries(e.requestHeaders)) {
      seg.push(`-H '${k}: ${String(v).replace(/'/g, "\\'")}'`)
    }
  }
  if (e.reqBody) seg.push(`--data-raw '${e.reqBody.replace(/'/g, "\\'")}'`)
  return seg.join(' \\\n  ')
}

interface Props {
  /** 已按 source 筛选好的条目（两后端合并后交给本组件） */
  entries: NetEntry[]
  /** 当前抓包方式，仅用于空状态文案与来源标识 */
  mode: NetMode
  /** 列表为空时的自定义提示（运行日志的「接口」视图用它给出引导） */
  emptyHint?: string
  /** 精简模式（运行日志 · 接口）：只留一个模糊搜索输入框，不做分类 / 应用 / 域名过滤 */
  simple?: boolean
}

/**
 * 共享的网络请求列表 + 详情视图，供「网络」页签与「运行日志 · 接口」分类复用，
 * 保证两类入口的列表样式、分类过滤与详情面板完全一致。
 */
export default function NetListView({ entries, mode, emptyHint, simple }: Props) {
  const [cat, setCat] = useState('all')
  const [q, setQ] = useState('')
  const [selected, setSelected] = useState<NetEntry | null>(null)
  const [detailH, setDetailH] = useState(300)
  const [curlCopied, setCurlCopied] = useState(false)

  const copyCurl = async (e: NetEntry) => {
    try {
      await navigator.clipboard.writeText(buildCurl(e))
      setCurlCopied(true)
      setTimeout(() => setCurlCopied(false), 1200)
    } catch {
      /* 剪贴板不可用时忽略 */
    }
  }

  // 列表刷新（新条目 / 更新）不打断详情；仅当选中条目已不存在（清空、切数据源）时取消选中
  useEffect(() => {
    if (selected && !entries.some((e) => e.id === selected.id)) setSelected(null)
  }, [entries, selected])

  const nq = q.trim().toLowerCase()
  const catDef = CATEGORIES.find((c) => c.key === cat) ?? CATEGORIES[0]

  const KNOWN_TYPES = CATEGORIES.filter((c) => c.key !== 'all' && c.key !== 'other').flatMap((c) => c.types)
  const bucketOf = (e: NetEntry) => {
    const t = (e.type || '').toLowerCase()
    return KNOWN_TYPES.includes(t) ? t : 'other'
  }
  const matchCat = (e: NetEntry) => catDef.key === 'all' || catDef.types.includes(bucketOf(e))
  // 单输入框模糊搜索：命中 URL / 接口名 / 域名 / 方法 / 应用任意一处
  const matchText = (e: NetEntry) =>
    !nq || `${e.url} ${e.name} ${e.host} ${e.method} ${e.app ?? ''}`.toLowerCase().includes(nq)
  const matchBase = matchText

  const counts: Record<string, number> = {}
  for (const c of CATEGORIES) {
    counts[c.key] =
      c.key === 'all' ? entries.filter(matchBase).length : entries.filter((e) => c.types.includes(bucketOf(e)) && matchBase(e)).length
  }

  const filtered = entries.filter((e) => matchCat(e) && matchBase(e))
  const hasFilter = nq !== ''
  const resetFilter = () => setQ('')

  // 拖拽调整详情面板高度（向下拖 = 列表变矮）
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

  // 搜索框内容：普通模式内联在分类行最右侧，精简模式独占一行
  const filterBox = (
    <>
      <input
        className="np-input"
        placeholder="模糊搜索：接口 / URL / 域名 / 方法"
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />
      {hasFilter && (
        <button className="btn ghost sm" onClick={resetFilter}>
          清除
        </button>
      )}
    </>
  )

  return (
    <div className="np-body">
      {!simple ? (
        <div className="np-cats">
          {CATEGORIES.map((c) => (
            <button
              key={c.key}
              className={`np-cat ${cat === c.key ? 'on' : ''}`}
              onClick={() => setCat(c.key)}
            >
              {c.label}
              <span className="n">{counts[c.key] ?? 0}</span>
            </button>
          ))}
          <div className="np-filter np-filter-inline">{filterBox}</div>
        </div>
      ) : (
        <div className="np-filter">{filterBox}</div>
      )}

      <div className="np-list">
        <div className="np-list-head">
          <span className="c-name">名称</span>
          <span className="c-method">方法</span>
          <span className="c-status">状态</span>
          <span className="c-type">类型</span>
          <span className="c-size">大小</span>
          <span className="c-time">时间</span>
        </div>
        <div className="np-list-scroll">
          {filtered.length === 0 ? (
            <div className="screen-empty">
              {entries.length === 0
                ? emptyHint ?? '暂无请求，请在设备上触发网络请求'
                : '无匹配请求，调整过滤条件试试'}
            </div>
          ) : (
            filtered.map((e) => (
              <div
                key={e.id}
                className={`np-row ${selected?.id === e.id ? 'sel' : ''} ${statusClass(e)}`}
                onClick={() => setSelected(e)}
              >
                <span className="c-name" title={`${e.app ? `[${e.app}] ` : ''}${e.url}`}>
                  {e.app && (
                    <span className="np-apptag" title={`所属应用：${e.app}`}>
                      {appShort(e.app)}
                    </span>
                  )}
                  <span className="np-name-text">{e.name}</span>
                </span>
                <span className="c-method">{e.method}</span>
                <span className="c-status">{e.error ? 'ERR' : e.method === 'CONNECT' ? 'TUN' : e.status ?? '-'}</span>
                <span className="c-type">{e.type}</span>
                <span className="c-size">{fmtBytes(e.resBytes ?? e.reqBytes)}</span>
                <span className="c-time">{fmtTime(e.startTime)}</span>
              </div>
            ))
          )}
        </div>
      </div>

      {selected && (
        <>
          <div className="np-splitter" onMouseDown={startDrag} title="拖动调整详情高度" />
          <div className="np-detail" style={{ flex: 'none', height: detailH }}>
            <div className="np-detail-title">
              <span className="dt-method">{selected.method}</span>
              <span className="dt-url" title={selected.url}>
                {selected.url}
              </span>
              <div className="np-detail-actions">
                <button className="btn ghost sm" onClick={() => copyCurl(selected)}>
                  {curlCopied ? '已复制' : '复制 cURL'}
                </button>
                <button className="np-close" onClick={() => setSelected(null)} title="关闭详情">
                  ✕
                </button>
              </div>
            </div>
            <Detail e={selected} />
          </div>
        </>
      )}
    </div>
  )
}

type DetailTab = 'headers' | 'preview' | 'response' | 'initiator' | 'timing' | 'cookies'

const DETAIL_TABS: { key: DetailTab; label: string }[] = [
  { key: 'headers', label: '标头' },
  { key: 'preview', label: '预览' },
  { key: 'response', label: '响应' },
  { key: 'initiator', label: '启动器' },
  { key: 'timing', label: '时间' },
  { key: 'cookies', label: 'Cookie' }
]

function Detail({ e }: { e: NetEntry }) {
  const [tab, setTab] = useState<DetailTab>('headers')
  const [openAll, setOpenAll] = useState(true)
  const [treeKey, setTreeKey] = useState(0)
  const [rawRes, setRawRes] = useState(false)
  const [q, setQ] = useState('')

  useEffect(() => {
    setTab('headers')
    setOpenAll(true) // 打开详情默认全展开（恢复原 defaultOpen 硬编码 true 的行为）
    setTreeKey(0)
    setRawRes(false)
    setQ('')
  }, [e.id])

  const json = useMemo(() => parseJson(e.resBody), [e.resBody])
  const prettyRes = useMemo(() => (e.resBody ? prettyJson(e.resBody) : null), [e.resBody])
  const searchQ = q.trim()
  const pruned = useMemo(
    () => (searchQ && json !== undefined ? pruneJson(json, searchQ) : undefined),
    [json, searchQ]
  )

  const expandTree = (open: boolean) => {
    setOpenAll(open)
    setTreeKey((k) => k + 1)
  }

  return (
    <div className="np-detail-body">
      <div className="np-dtabs">
        {DETAIL_TABS.map((t) => (
          <button
            key={t.key}
            className={`np-dtab ${tab === t.key ? 'on' : ''}`}
            onClick={() => setTab(t.key)}
          >
            {t.label}
          </button>
        ))}
        <input
          className="np-dsearch"
          placeholder="搜索…"
          value={q}
          onChange={(ev) => setQ(ev.target.value)}
        />
      </div>

      <div className="np-detail-scroll">
        {tab === 'headers' && <TabHeaders e={e} />}
        {tab === 'preview' && (
          <>
            {json === undefined ? (
              <div className="screen-empty">
                {e.resBody ? '响应体不是 JSON，切到「响应」查看原文' : '暂无响应体（HTTPS 隧道需开启 MITM 解密）'}
              </div>
            ) : (
              <>
                <div className="np-json-bar">
                  <button className="btn ghost sm" onClick={() => expandTree(true)}>
                    展开全部
                  </button>
                  <button className="btn ghost sm" onClick={() => expandTree(false)}>
                    折叠全部
                  </button>
                </div>
                {searchQ && pruned === undefined ? (
                  <div className="screen-empty">无匹配项</div>
                ) : (
                  <JsonNode
                    key={`${e.id}-${treeKey}-${searchQ}-${openAll}`}
                    k={null}
                    v={searchQ ? (pruned as unknown) : json}
                    depth={0}
                    defaultOpen={openAll || !!searchQ}
                  />
                )}
              </>
            )}
          </>
        )}
        {tab === 'response' && (
          <>
            {e.resBody ? (
              <>
                {prettyRes && (
                  <div className="np-json-bar">
                    <button
                      className={`btn ghost sm ${rawRes ? '' : 'on'}`}
                      onClick={() => setRawRes(false)}
                    >
                      格式化
                    </button>
                    <button
                      className={`btn ghost sm ${rawRes ? 'on' : ''}`}
                      onClick={() => setRawRes(true)}
                    >
                      原文
                    </button>
                  </div>
                )}
                <SearchedPre
                  text={rawRes || !prettyRes ? e.resBody : prettyRes}
                  q={searchQ}
                  className="np-body-text tall"
                />
              </>
            ) : (
              <div className="screen-empty">暂无响应体（HTTPS 隧道需开启 MITM 解密）</div>
            )}
          </>
        )}
        {tab === 'initiator' && (
          <div className="screen-empty">
            启动器（调用栈）需连接 RN 运行时读取真实 JS 调用链，当前仅记录请求本身；开启 MITM 后可见完整 URL 与来源头
            {e.requestHeaders?.referer ? `（referer: ${e.requestHeaders.referer}）` : ''}
          </div>
        )}
        {tab === 'timing' && <TabTiming e={e} />}
        {tab === 'cookies' && <TabCookies e={e} />}
      </div>
    </div>
  )
}

function TabHeaders({ e }: { e: NetEntry }) {
  const query: [string, string][] = []
  try {
    const u = new URL(e.url)
    u.searchParams.forEach((v, k) => query.push([k, v]))
  } catch {
    /* 忽略非法 URL */
  }
  return (
    <>
      <div className="ep-sec">常规</div>
      <div className="np-hrow">
        <span className="hk">请求 URL</span>
        <span className="hv">{e.url}</span>
      </div>
      <div className="np-hrow">
        <span className="hk">请求方法</span>
        <span className="hv">
          {e.method}
          {e.scheme === 'https' ? ' · HTTPS' : ''}
        </span>
      </div>
      <div className="np-hrow">
        <span className="hk">状态代码</span>
        <span className="hv">{e.error ? `错误：${e.error}` : e.status ?? '-'}</span>
      </div>
      <div className="np-hrow">
        <span className="hk">远程主机</span>
        <span className="hv">{e.host}</span>
      </div>
      <div className="np-hrow">
        <span className="hk">所属应用</span>
        <span className="hv">
          {e.app ? e.app : '未识别'}
          {e.clientPort ? ` · 源端口 ${e.clientPort}` : ''}
        </span>
      </div>

      {query.length > 0 && (
        <>
          <div className="ep-sec">查询字符串参数</div>
          {query.map(([k, v]) => (
            <div className="np-hrow" key={k}>
              <span className="hk">{k}</span>
              <span className="hv">{v}</span>
            </div>
          ))}
        </>
      )}

      <div className="ep-sec">请求头</div>
      <Headers headers={e.requestHeaders} />

      <div className="ep-sec">响应头</div>
      {e.scheme === 'https' && !e.responseHeaders ? (
        <div className="screen-empty">HTTPS 隧道无法读取响应头（需开启 MITM）</div>
      ) : (
        <Headers headers={e.responseHeaders} />
      )}

      {e.reqBody && (
        <>
          <div className="ep-sec">请求体</div>
          <pre className="np-body-text">{e.reqBody}</pre>
        </>
      )}
    </>
  )
}

function TabTiming({ e }: { e: NetEntry }) {
  const total = e.duration ?? 0
  if (!e.startTime) return <div className="screen-empty">无时间信息</div>
  return (
    <>
      <div className="ep-sec">总耗时</div>
      <div className="np-hrow">
        <span className="hk">总时长</span>
        <span className="hv">{e.duration != null ? `${e.duration} ms` : '进行中…'}</span>
      </div>
      <div className="np-hrow">
        <span className="hk">开始时间</span>
        <span className="hv">{new Date(e.startTime).toLocaleString('zh-CN', { hour12: false })}</span>
      </div>
      {e.endTime && (
        <div className="np-hrow">
          <span className="hk">结束时间</span>
          <span className="hv">{new Date(e.endTime).toLocaleString('zh-CN', { hour12: false })}</span>
        </div>
      )}
      <div className="ep-sec">阶段</div>
      <div className="np-timeline">
        <div className="np-tl-row">
          <span className="tl-label">请求 → 响应</span>
          <span className="tl-track">
            <span className="tl-bar" style={{ width: '100%' }} />
          </span>
          <span className="tl-val">{total} ms</span>
        </div>
      </div>
      <div className="np-note">
        代理层只能观测到整体往返耗时；DNS / TCP / TLS / TTFB 的细分阶段需设备端运行时埋点。
      </div>
    </>
  )
}

function TabCookies({ e }: { e: NetEntry }) {
  const reqRaw = e.requestHeaders?.cookie || ''
  const resRaw = e.responseHeaders?.['set-cookie'] || ''
  const reqCookies = reqRaw
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const i = s.indexOf('=')
      return i < 0 ? [s, ''] : [s.slice(0, i), s.slice(i + 1)]
    }) as [string, string][]

  return (
    <>
      <div className="ep-sec">请求 Cookie</div>
      {reqCookies.length === 0 ? (
        <div className="screen-empty">无</div>
      ) : (
        reqCookies.map(([k, v]) => (
          <div className="np-hrow" key={k}>
            <span className="hk">{k}</span>
            <span className="hv">{v}</span>
          </div>
        ))
      )}
      <div className="ep-sec">响应 Set-Cookie</div>
      {resRaw ? <pre className="np-body-text">{resRaw}</pre> : <div className="screen-empty">无</div>}
    </>
  )
}


function Headers({ headers }: { headers?: Record<string, string> }) {
  if (!headers || Object.keys(headers).length === 0) return <div className="screen-empty">无</div>
  return (
    <div className="np-headers">
      {Object.entries(headers).map(([k, v]) => (
        <div className="np-hrow" key={k}>
          <span className="hk">{k}</span>
          <span className="hv">{v}</span>
        </div>
      ))}
    </div>
  )
}
