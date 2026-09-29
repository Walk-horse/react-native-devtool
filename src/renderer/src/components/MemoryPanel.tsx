/**
 * 内存页：JS 内存捕获与分析（对齐 Chrome DevTools 内存页签）
 * - 堆快照：HeapProfiler.takeHeapSnapshot（Hermes 经 Metro 代理输出 Chrome 格式），
 *   主进程聚合成「类名 → 实例数 / 浅层大小」Top 表；支持两份快照对比（泄漏排查核心入口）；
 * - 分配采样：HeapProfiler.startSampling/stopSampling，Top 自分配站点定位分配热点；
 * - 依赖 DevTools 通道（网络页开始抓包后可用），通道独占所以不能另开连接。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  MemClassRow,
  MemDiffRow,
  MemProgress,
  MemSampleResult,
  MemSnapshotSummary
} from '../types'

type Mode = 'snapshot' | 'sampling'

export default function MemoryPanel() {
  const [mode, setMode] = useState<Mode>('snapshot')
  const [snapshots, setSnapshots] = useState<MemSnapshotSummary[]>([])
  const [checked, setChecked] = useState<string[]>([])
  const [busy, setBusy] = useState('')
  const [progress, setProgress] = useState<MemProgress | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [q, setQ] = useState('')
  const [sortKey, setSortKey] = useState<'selfSize' | 'count' | 'name'>('selfSize')
  const [sample, setSample] = useState<MemSampleResult | null>(null)
  const [sampling, setSampling] = useState(false)
  const [autoStop, setAutoStop] = useState(true)
  const [durationSec, setDurationSec] = useState(30)
  const [remaining, setRemaining] = useState<number | null>(null)
  const timerRef = useRef<{ countdown?: ReturnType<typeof setInterval>; stop?: ReturnType<typeof setTimeout> }>({})
  const [channelOk, setChannelOk] = useState<boolean | null>(null)

  const refresh = async () => {
    const list = await window.api.memListSnapshots()
    setSnapshots(list)
    setChecked((c) => c.filter((id) => list.some((s) => s.id === id)))
  }
  useEffect(() => {
    void refresh()
    void window.api.devStatus().then((s) => setChannelOk(!!s.attached))
    const off = window.api.onNetworkStatus((s) => setChannelOk(!!s.attached))
    const offP = window.api.onMemProgress(setProgress)
    return () => {
      off()
      offP()
      if (timerRef.current.countdown) clearInterval(timerRef.current.countdown)
      if (timerRef.current.stop) clearTimeout(timerRef.current.stop)
    }
  }, [])

  const takeSnapshot = async () => {
    setErr(null)
    setBusy('正在拍摄堆快照…')
    setProgress({ phase: 'starting' })
    try {
      const r = await window.api.memTakeSnapshot()
      if (!r.ok) setErr(r.error || '拍摄失败')
    } finally {
      setBusy('')
      setProgress(null)
      void refresh()
    }
  }

  const doGC = async () => {
    setErr(null)
    const r = await window.api.memGC()
    if (!r.ok) setErr(r.error || 'GC 失败')
  }

  const toggleCheck = (id: string) => {
    setChecked((c) => {
      if (c.includes(id)) return c.filter((x) => x !== id)
      return [...c, id].slice(-2) // 最多选两份做对比
    })
  }

  const clearTimer = () => {
    if (timerRef.current.countdown) {
      clearInterval(timerRef.current.countdown)
      timerRef.current.countdown = undefined
    }
    if (timerRef.current.stop) {
      clearTimeout(timerRef.current.stop)
      timerRef.current.stop = undefined
    }
    setRemaining(null)
  }

  const stopSampling = async () => {
    clearTimer()
    setBusy('正在停止采样并聚合…')
    try {
      const r = await window.api.memSampleStop()
      if (!r.ok) setErr(r.error || '停止失败')
      else setSample(r.result ?? null)
      setSampling(false)
    } finally {
      setBusy('')
    }
  }

  const startSampling = async () => {
    setErr(null)
    setRemaining(null)
    const r = await window.api.memSampleStart()
    if (!r.ok) {
      setErr(r.error || '启动失败')
      return
    }
    setSampling(true)
    // 自动停止计时：到点自动调用停止采样，无需手动点
    if (autoStop && durationSec > 0) {
      let left = durationSec
      setRemaining(left)
      timerRef.current.countdown = setInterval(() => {
        left -= 1
        if (left <= 0) {
          if (timerRef.current.countdown) {
            clearInterval(timerRef.current.countdown)
            timerRef.current.countdown = undefined
          }
          setRemaining(0)
        } else {
          setRemaining(left)
        }
      }, 1000)
      timerRef.current.stop = setTimeout(() => {
        void stopSampling()
      }, durationSec * 1000)
    }
  }

  const snapA = snapshots.find((s) => s.id === checked[0])
  const snapB = snapshots.find((s) => s.id === checked[1])
  const [diffRows, setDiffRows] = useState<(MemDiffRow & { dCount: number; dSize: number })[]>([])
  useEffect(() => {
    if (snapA && snapB) {
      void window.api.memCompare(snapA.id, snapB.id).then((r) => setDiffRows(r.rows ?? []))
    } else {
      setDiffRows([])
    }
  }, [snapA?.id, snapB?.id])

  const filterRows = <T extends { name: string }>(rows: T[]) => {
    const nq = q.trim().toLowerCase()
    return nq ? rows.filter((r) => r.name.toLowerCase().includes(nq)) : rows
  }

  const detailRows = useMemo(() => {
    if (!snapA || snapB) return []
    const rows = filterRows(snapA.top)
    return [...rows].sort((a, b) =>
      sortKey === 'name' ? a.name.localeCompare(b.name) : (b[sortKey] as number) - (a[sortKey] as number)
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapA, snapB, q, sortKey])

  const sampleRows = useMemo(() => filterRows(sample?.top ?? []), [sample, q])

  return (
    <div className="mem-panel">
      {/* 分析类型 */}
      <div className="mem-modes">
        <button className={`np-mode ${mode === 'snapshot' ? 'on' : ''}`} onClick={() => setMode('snapshot')}>
          堆快照
          <span className="tag">对象/闭包</span>
        </button>
        <button className={`np-mode ${mode === 'sampling' ? 'on' : ''}`} onClick={() => setMode('sampling')}>
          分配采样
          <span className="tag">分配热点</span>
        </button>
      </div>
      {channelOk === false && (
        <div className="np-hint warn">
          未连接调试目标：堆快照 / 分配采样依赖 DevTools 通道，请先到「网络」页选择目标并「开始抓包」。
        </div>
      )}

      {mode === 'snapshot' && (
        <>
          <div className="mem-bar">
            <button className="btn sm primary" onClick={takeSnapshot} disabled={!!busy}>
              {busy === '正在拍摄堆快照…' ? '拍摄中…' : '拍摄快照'}
            </button>
            <button className="btn ghost sm" onClick={doGC} disabled={!!busy} title="先触发一次 GC，排除可回收垃圾的干扰">
              GC
            </button>
            <button className="btn ghost sm" onClick={() => void refresh()} disabled={!!busy}>
              刷新
            </button>
            {snapshots.length >= 2 && (
              <span className="np-hint inline">勾选两份快照做对比（泄漏 = 持续增长的对象）</span>
            )}
          </div>

          {snapshots.length === 0 && !busy && (
            <div className="screen-empty">
              暂无快照。点击「拍摄快照」捕获当前 JS 堆（约 10~30 秒，期间 App 可能短暂卡顿）。
            </div>
          )}

          {/* 快照列表 */}
          {snapshots.length > 0 && (
            <div className="mem-snaps">
              {snapshots.map((s, i) => (
                <div key={s.id} className={`mem-snap ${checked.includes(s.id) ? 'sel' : ''}`}>
                  <input
                    type="checkbox"
                    checked={checked.includes(s.id)}
                    onChange={() => toggleCheck(s.id)}
                    title="勾选查看 / 两份做对比"
                  />
                  <span className="mem-snap-title">
                    #{snapshots.length - i} · {fmtBytes(s.totalSize)} · {fmtInt(s.totalCount)} 对象
                  </span>
                  <span className="mem-snap-meta" title={s.target}>
                    {new Date(s.ts).toLocaleTimeString()} · {s.target.split(' @ ')[1] || s.target}
                  </span>
                </div>
              ))}
            </div>
          )}

          {busy && progress && (
            <div className="mem-progress">
              {progress.phase === 'receiving'
                ? `接收快照数据 ${fmtBytes(progress.bytes ?? 0)}…`
                : progress.phase === 'parsing'
                  ? '解析节点并聚合…'
                  : busy}
            </div>
          )}
          {err && <div className="np-hint warn">{err}</div>}

          {/* 对比视图 */}
          {snapA && snapB && (
            <div className="mem-table-wrap">
              <div className="ep-sec">
                对比：{new Date(snapB.ts).toLocaleTimeString()} 相对 {new Date(snapA.ts).toLocaleTimeString()}
                （按增量排序，红色 = 增长）
              </div>
              <table className="mem-table">
                <thead>
                  <tr>
                    <th>类名</th>
                    <th className="num" title="新快照实例数"># 对象</th>
                    <th className="num">Δ实例</th>
                    <th className="num" title="新快照浅层大小">浅层大小</th>
                    <th className="num">Δ大小</th>
                  </tr>
                </thead>
                <tbody>
                  {diffRows.map((r) => (
                    <tr key={r.name} className={r.dSize > 0 ? 'grow' : r.dSize < 0 ? 'shrink' : ''}>
                      <td className="mem-name" title={r.name}>
                        {r.name}
                      </td>
                      <td className="num">{fmtInt(r.countB)}</td>
                      <td className={`num ${r.dCount > 0 ? 'up' : r.dCount < 0 ? 'down' : ''}`}>{fmtDelta(r.dCount)}</td>
                      <td className="num">{fmtBytes(r.sizeB)}</td>
                      <td className={`num ${r.dSize > 0 ? 'up' : r.dSize < 0 ? 'down' : ''}`}>{fmtBytesDelta(r.dSize)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* 单快照详情 */}
          {snapA && !snapB && (
            <div className="mem-table-wrap">
              <div className="mem-filter">
                <input
                  className="np-input"
                  placeholder="搜索类名 / 构造函数"
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                />
                <span className="np-count">
                  {detailRows.length} / {snapA.top.length}
                </span>
              </div>
              <table className="mem-table">
                <thead>
                  <tr>
                    <th className="sortable" onClick={() => setSortKey('name')}>
                      类名 {sortKey === 'name' ? '▾' : ''}
                    </th>
                    <th className="num sortable" onClick={() => setSortKey('count')}>
                      实例数 {sortKey === 'count' ? '▾' : ''}
                    </th>
                    <th className="num sortable" onClick={() => setSortKey('selfSize')}>
                      浅层大小 {sortKey === 'selfSize' ? '▾' : ''}
                    </th>
                    <th className="num">占比</th>
                  </tr>
                </thead>
                <tbody>
                  {detailRows.map((r: MemClassRow) => (
                    <tr key={r.name}>
                      <td className="mem-name" title={r.name}>
                        {r.name}
                      </td>
                      <td className="num">{fmtInt(r.count)}</td>
                      <td className="num">{fmtBytes(r.selfSize)}</td>
                      <td className="num">
                        <span
                          className="mem-bar-pct"
                          style={{ width: `${Math.min(100, (r.selfSize / (snapA.totalSize || 1)) * 100 * 6)}%` }}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {mode === 'sampling' && (
        <>
          <div className="mem-bar">
            {!sampling ? (
              <>
                <button className="btn sm primary" onClick={startSampling} disabled={!!busy}>
                  开始采样
                </button>
                <label className="np-check" title="到点自动停止采样">
                  <input
                    type="checkbox"
                    checked={autoStop}
                    onChange={(e) => setAutoStop(e.target.checked)}
                  />
                  自动停止
                </label>
                <input
                  className="np-input num"
                  type="number"
                  min={1}
                  max={3600}
                  value={durationSec}
                  disabled={!autoStop}
                  onChange={(e) =>
                    setDurationSec(Math.max(1, Math.min(3600, Math.floor(Number(e.target.value) || 30))))
                  }
                  title="自动停止时长（秒）"
                />
                <span className="np-hint inline">秒后自动停止</span>
              </>
            ) : (
              <>
                <button className="btn sm primary" onClick={stopSampling} disabled={!!busy}>
                  停止采样
                </button>
                {autoStop && remaining !== null && (
                  <span className="np-hint inline countdown">自动停止倒计时：{remaining}s</span>
                )}
              </>
            )}
            <span className="np-hint inline">
              {sampling
                ? autoStop
                  ? '采样中：在 App 里复现操作，到点自动停止'
                  : '采样中：在 App 里复现操作，然后点「停止采样」'
                : '记录采样期间的 JS 分配热点（低开销）'}
            </span>
          </div>
          {err && <div className="np-hint warn">{err}</div>}
          {!sample && !sampling && (
            <div className="screen-empty">暂无采样结果。开始采样 → 操作 App → 停止采样，查看按函数聚合的分配热点。</div>
          )}
          {sample && (
            <div className="mem-table-wrap">
              <div className="ep-sec">
                采样 {Math.round(sample.intervalMs / 1000)}s · 总分配 {fmtBytes(sample.totalSize)} · Top 自分配站点
              </div>
              <div className="mem-filter">
                <input className="np-input" placeholder="搜索函数 / 脚本" value={q} onChange={(e) => setQ(e.target.value)} />
                <span className="np-count">{sampleRows.length} / {sample.top.length}</span>
              </div>
              <table className="mem-table">
                <thead>
                  <tr>
                    <th>函数</th>
                    <th>脚本</th>
                    <th className="num">自分配</th>
                    <th className="num">占比</th>
                  </tr>
                </thead>
                <tbody>
                  {sampleRows.map((r, i) => (
                    <tr key={i}>
                      <td className="mem-name" title={r.fn}>
                        {r.fn}
                      </td>
                      <td className="mem-name" title={r.url}>
                        {shortUrl(r.url)}
                        {r.line >= 0 ? `:${r.line + 1}` : ''}
                      </td>
                      <td className="num">{fmtBytes(r.selfSize)}</td>
                      <td className="num">
                        <span
                          className="mem-bar-pct"
                          style={{ width: `${Math.min(100, (r.selfSize / (sample.totalSize || 1)) * 100 * 3)}%` }}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  )
}

function fmtBytes(n: number): string {
  if (!Number.isFinite(n)) return '-'
  if (n >= 1048576) return `${(n / 1048576).toFixed(1)} MB`
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${n} B`
}
function fmtBytesDelta(n: number): string {
  const s = fmtBytes(Math.abs(n))
  return n > 0 ? `+${s}` : n < 0 ? `-${s}` : '0'
}
function fmtInt(n: number): string {
  return n.toLocaleString('en-US')
}
function fmtDelta(n: number): string {
  return n > 0 ? `+${fmtInt(n)}` : n < 0 ? fmtInt(n) : '0'
}
function shortUrl(u: string): string {
  if (!u) return '(inline)'
  const m = u.match(/\/([^/?]+)\.bundle/)
  if (m) return m[1]
  const p = u.split('/')
  return p[p.length - 1].slice(0, 48)
}
