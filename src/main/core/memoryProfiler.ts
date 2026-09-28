/**
 * JS 内存采集（对齐 Chrome DevTools 内存页签的核心能力）：
 * - 堆快照（HeapProfiler.takeHeapSnapshot）：Hermes 经 Metro inspector 代理输出标准 Chrome
 *   heapsnapshot 格式（snapshot.meta + nodes/edges/strings，实测 ~56MB / 100 万节点），
 *   流式 chunk 接收后聚合为「类名 → 实例数 / 浅层大小」Top 表（不保留原始大对象）；
 * - 分配采样（HeapProfiler.startSampling / stopSampling）：返回标准采样调用树，
 *   聚合为「函数 / 脚本 → 自分配大小」Top 表，用于定位分配热点；
 * - GC（HeapProfiler.collectGarbage）：拍快照前手动触发，排除可回收垃圾的干扰。
 *
 * 通道约束：Metro inspector「最近连接独占」，所有命令复用 devtoolsNetwork 的既有连接
 * （call + CDP 事件转发），不能自开 WebSocket。
 */
import { devtoolsNetwork } from './devtoolsNetwork'

export interface MemClassRow {
  name: string
  /** 节点类型（object / closure / string / array …） */
  type: string
  count: number
  selfSize: number
}

export interface MemSnapshotSummary {
  id: string
  ts: number
  /** 采集目标（appId @ deviceName） */
  target: string
  totalSize: number
  totalCount: number
  /** 按节点类型汇总 */
  byType: { type: string; count: number; size: number }[]
  /** 按类名聚合 Top（selfSize 降序，top 300） */
  top: MemClassRow[]
  /** 快照原始字节数 */
  bytes: number
  /** 解析耗时 ms */
  parseMs: number
}

export interface MemSampleSite {
  fn: string
  url: string
  line: number
  selfSize: number
}

export interface MemSampleResult {
  ts: number
  target: string
  intervalMs: number
  totalSize: number
  top: MemSampleSite[]
}

export interface MemDiffRow {
  name: string
  countA: number
  countB: number
  sizeA: number
  sizeB: number
}

const MAX_SNAPSHOTS = 8

/** 聚合结果存内存（原始快照解析完即丢弃），供对比 */
const snapshots: MemSnapshotSummary[] = []
let sampleIntervalMs = 0
let sampling = false

let progressCb: ((p: { phase: string; bytes?: number; nodes?: number }) => void) | null = null

function targetLabel(): string {
  return devtoolsNetwork.targetLabel()
}

/** 拍堆快照：流式收 chunk → JSON 解析 → 聚合（返回摘要，原始数据不保留） */
export async function takeMemSnapshot(): Promise<{ ok: boolean; error?: string; summary?: MemSnapshotSummary }> {
  const st = devtoolsNetwork.status
  if (!st.attached) return { ok: false, error: '未连接调试目标：请先在「网络」页开始抓包以建立通道' }

  const chunks: string[] = []
  let lastChunkAt = Date.now()
  let nodesSeen = 0
  const listener = (method: string, params: Record<string, unknown>) => {
    if (method === 'HeapProfiler.addHeapSnapshotChunk') {
      const c = params.chunk
      if (typeof c === 'string') {
        chunks.push(c)
        nodesSeen += Math.floor(c.length / 80)
        lastChunkAt = Date.now()
        progressCb?.({ phase: 'receiving', bytes: chunks.reduce((a, x) => a + x.length, 0) })
      }
    }
  }
  devtoolsNetwork.setCdpEventListener(listener)
  try {
    const t0 = Date.now()
    // 慢快照可能数十秒才传完 chunk，给足 90s 余量；call 内部默认 60s 兜底其他命令
    const resp = (await devtoolsNetwork.call('HeapProfiler.takeHeapSnapshot', undefined, 90000)) as { error?: { message?: string } } | undefined
    // response 返回后等 chunk 流静默（个别实现 response 先于末尾 chunk）
    while (Date.now() - lastChunkAt < 1200) {
      await new Promise((r) => setTimeout(r, 200))
    }
    devtoolsNetwork.setCdpEventListener(null)
    if (resp && typeof resp === 'object' && resp.error) {
      return { ok: false, error: `HeapProfiler.takeHeapSnapshot 失败：${resp.error.message || 'unsupported'}` }
    }
    const text = chunks.join('')
    if (!text) return { ok: false, error: '未收到快照数据' }
    progressCb?.({ phase: 'parsing' })
    const parseMs = Date.now() - t0
    const summary = parseSnapshot(text, targetLabel(), parseMs)
    snapshots.unshift(summary)
    if (snapshots.length > MAX_SNAPSHOTS) snapshots.pop()
    progressCb?.({ phase: 'done' })
    return { ok: true, summary }
  } catch (e) {
    devtoolsNetwork.setCdpEventListener(null)
    return { ok: false, error: String((e as Error).message || e) }
  }
}

/** 解析 Chrome heapsnapshot：按「类名（构造函数 / 类型）」聚合实例数与浅层大小 */
function parseSnapshot(text: string, target: string, parseMs: number): MemSnapshotSummary {
  const data = JSON.parse(text) as {
    snapshot: { meta: { node_fields: string[]; node_types: (string[] | string)[] } }
    nodes: number[]
    strings: string[]
  }
  const meta = data.snapshot.meta
  const typeNames = (meta.node_types[0] as string[]) ?? []
  const W = meta.node_fields.length // 实测 7：type,name,id,self_size,edge_count,trace_node_id,detachedness
  const nodes = data.nodes
  const strings = data.strings

  const classAgg = new Map<string, MemClassRow>()
  const typeAgg = new Map<string, { count: number; size: number }>()
  let totalSize = 0
  let totalCount = 0

  for (let i = 0; i + W <= nodes.length; i += W) {
    const ti = nodes[i]
    const type = typeNames[ti] ?? String(ti)
    const name = strings[nodes[i + 1]] ?? ''
    const selfSize = nodes[i + 3] ?? 0
    totalSize += selfSize
    totalCount++
    const ta = typeAgg.get(type) ?? { count: 0, size: 0 }
    ta.count++
    ta.size += selfSize
    typeAgg.set(type, ta)
    // 聚合名：object/closure 用构造函数名，其余用类型名；无名归 (anonymous)
    const key = type === 'object' || type === 'closure' ? name || `(${type})` : `(${type})`
    const row = classAgg.get(key) ?? { name: key, type, count: 0, selfSize: 0 }
    row.count++
    row.selfSize += selfSize
    classAgg.set(key, row)
  }

  const top = [...classAgg.values()].sort((a, b) => b.selfSize - a.selfSize).slice(0, 300)
  const byType = [...typeAgg.entries()]
    .map(([type, v]) => ({ type, count: v.count, size: v.size }))
    .sort((a, b) => b.size - a.size)

  return {
    id: `mem-${Date.now()}`,
    ts: Date.now(),
    target,
    totalSize,
    totalCount,
    byType,
    top,
    bytes: text.length,
    parseMs
  }
}

/** 两份快照按类名对比（countB/sizeB 为新快照，d* 为增量） */
export function compareSnapshots(aId: string, bId: string): { ok: boolean; error?: string; rows?: (MemDiffRow & { dCount: number; dSize: number })[] } {
  const a = snapshots.find((s) => s.id === aId)
  const b = snapshots.find((s) => s.id === bId)
  if (!a || !b) return { ok: false, error: '快照不存在（可能已被清理）' }
  const map = new Map<string, MemDiffRow>()
  for (const r of a.top) map.set(r.name, { name: r.name, countA: r.count, countB: 0, sizeA: r.selfSize, sizeB: 0 })
  for (const r of b.top) {
    const row = map.get(r.name) ?? { name: r.name, countA: 0, countB: 0, sizeA: 0, sizeB: 0 }
    row.countB += r.count
    row.sizeB += r.selfSize
    map.set(r.name, row)
  }
  const rows = [...map.values()]
    .map((r) => ({ ...r, dCount: r.countB - r.countA, dSize: r.sizeB - r.sizeA }))
    .sort((x, y) => Math.abs(y.dSize) - Math.abs(x.dSize))
    .slice(0, 300)
  return { ok: true, rows }
}

/** 分配采样：开始（间隔太大漏小对象，太小开销大；默认 512KB） */
export async function startMemSampling(samplingInterval = 512 * 1024): Promise<{ ok: boolean; error?: string }> {
  const st = devtoolsNetwork.status
  if (!st.attached) return { ok: false, error: '未连接调试目标：请先在「网络」页开始抓包以建立通道' }
  const resp = (await devtoolsNetwork.call('HeapProfiler.startSampling', { samplingInterval })) as
    | { error?: { message?: string } }
    | undefined
  if (resp && typeof resp === 'object' && resp.error) {
    return { ok: false, error: `HeapProfiler.startSampling 失败：${resp.error.message || 'unsupported'}` }
  }
  sampling = true
  sampleIntervalMs = Date.now()
  return { ok: true }
}

/** 分配采样：停止并聚合 Top 分配站点 */
export async function stopMemSampling(): Promise<{ ok: boolean; error?: string; result?: MemSampleResult }> {
  const resp = (await devtoolsNetwork.call('HeapProfiler.stopSampling')) as
    | { error?: { message?: string }; profile?: SampleProfile }
    | undefined
  sampling = false
  if (resp && typeof resp === 'object' && resp.error) {
    return { ok: false, error: `HeapProfiler.stopSampling 失败：${resp.error.message || 'unsupported'}` }
  }
  if (!resp?.profile) return { ok: false, error: '未返回采样数据' }
  const sites = new Map<string, MemSampleSite>()
  let totalSize = 0
  const walk = (node: SampleNode) => {
    const cf = node.callFrame
    if (node.selfSize > 0) {
      const key = `${cf.functionName || '(anonymous)'}@${cf.url || ''}:${cf.lineNumber}`
      const row = sites.get(key) ?? { fn: cf.functionName || '(anonymous)', url: cf.url || '', line: cf.lineNumber ?? -1, selfSize: 0 }
      row.selfSize += node.selfSize
      sites.set(key, row)
      totalSize += node.selfSize
    }
    for (const c of node.children ?? []) walk(c)
  }
  walk(resp.profile.head)
  const top = [...sites.values()].sort((a, b) => b.selfSize - a.selfSize).slice(0, 200)
  const result: MemSampleResult = {
    ts: Date.now(),
    target: targetLabel(),
    intervalMs: sampleIntervalMs ? Date.now() - sampleIntervalMs : 0,
    totalSize,
    top
  }
  return { ok: true, result }
}

interface SampleNode {
  callFrame: { functionName?: string; url?: string; lineNumber?: number; columnNumber?: number }
  selfSize?: number
  children?: SampleNode[]
}
interface SampleProfile {
  head: SampleNode
}

/** 触发 GC（拍快照前建议先执行，排除可回收垃圾） */
export async function triggerMemGC(): Promise<{ ok: boolean; error?: string }> {
  const resp = (await devtoolsNetwork.call('HeapProfiler.collectGarbage')) as { error?: { message?: string } } | undefined
  if (resp && typeof resp === 'object' && resp.error) {
    return { ok: false, error: `collectGarbage 失败：${resp.error.message || 'unsupported'}` }
  }
  return { ok: true }
}

export function listMemSnapshots(): MemSnapshotSummary[] {
  return snapshots
}

export function clearMemSnapshots(): void {
  snapshots.length = 0
}

export function setMemProgressCb(cb: (p: { phase: string; bytes?: number; nodes?: number }) => void): void {
  progressCb = cb
}

export function isMemSampling(): boolean {
  return sampling
}
