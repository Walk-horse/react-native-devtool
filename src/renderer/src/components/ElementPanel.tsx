import { useState, type MouseEvent as ReactMouseEvent } from 'react'
import { UiNode } from '../types'

interface Props {
  tree: UiNode | null
  selectedKey: string | null
  onSelectKey: (k: string | null) => void
  onSelectedNodeChange: (n: UiNode | null) => void
  deviceName?: string
  loading: boolean
  error: string | null
  /** 检查元素开关（类 Chrome DevTools 的元素选择模式） */
  inspectOn: boolean
  onToggleInspect: (next?: boolean) => void
  onRefresh: () => void
}

function nodeLabel(n: UiNode): string {
  const short = n.className ? n.className.split('.').pop() : 'Node'
  const t = n.text || n.contentDesc || n.resourceId
  return t ? `${short} "${t}"` : short || 'Node'
}

function findNode(root: UiNode | null, key: string): UiNode | null {
  if (!root) return null
  const stack = [root]
  while (stack.length) {
    const n = stack.pop()!
    if (n.key === key) return n
    stack.push(...n.children)
  }
  return null
}

// 命中节点 + 其祖先链；命中节点保留完整子树，未命中分支仅保留含命中的路径
function filterTree(node: UiNode, q: string): UiNode | null {
  const self = nodeLabel(node).toLowerCase().includes(q)
  const kids = node.children.map((c) => filterTree(c, q)).filter(Boolean) as UiNode[]
  if (self || kids.length) {
    return { ...node, children: self ? node.children : kids }
  }
  return null
}

function countMatches(root: UiNode | null, q: string): number {
  if (!root) return 0
  let c = 0
  const stack = [root]
  while (stack.length) {
    const n = stack.pop()!
    if (nodeLabel(n).toLowerCase().includes(q)) c++
    stack.push(...n.children)
  }
  return c
}

function TreeNode({
  node,
  depth,
  selectedKey,
  onSelect,
  forceOpen
}: {
  node: UiNode
  depth: number
  selectedKey: string | null
  onSelect: (k: string) => void
  forceOpen?: boolean
}) {
  const [open, setOpen] = useState(depth < 3)
  const hasChildren = node.children.length > 0
  const isOpen = forceOpen || open
  return (
    <div className="tree-node">
      <div
        className={`tree-row ${selectedKey === node.key ? 'sel' : ''}`}
        style={{ paddingLeft: 8 + depth * 14 }}
        onClick={() => onSelect(node.key)}
      >
        {hasChildren ? (
          <span className="tw" onClick={(e) => { e.stopPropagation(); setOpen((o) => !o) }}>
            {isOpen ? '▾' : '▸'}
          </span>
        ) : (
          <span className="tw" />
        )}
        <span className="tl">{nodeLabel(node)}</span>
      </div>
      {isOpen && hasChildren && node.children.map((c) => (
        <TreeNode key={c.key} node={c} depth={depth + 1} selectedKey={selectedKey} onSelect={onSelect} forceOpen={forceOpen} />
      ))}
    </div>
  )
}

export default function ElementPanel({
  tree,
  selectedKey,
  onSelectKey,
  onSelectedNodeChange,
  deviceName,
  loading,
  error,
  inspectOn,
  onToggleInspect,
  onRefresh
}: Props) {
  const [search, setSearch] = useState('')
  const [propsW, setPropsW] = useState(340)

  // 拖拽调整属性面板宽度（向左拖 = 变宽）
  const startDrag = (e: ReactMouseEvent<HTMLDivElement>) => {
    e.preventDefault()
    const startX = e.clientX
    const startW = propsW
    const move = (ev: MouseEvent) => {
      const max = Math.max(280, window.innerWidth - 460)
      setPropsW(Math.min(Math.max(220, startW + (startX - ev.clientX)), max))
    }
    const up = () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  const q = search.trim().toLowerCase()
  const view = q ? filterTree(tree, q) : tree
  const matchCount = q ? countMatches(tree, q) : 0
  const selected = selectedKey ? findNode(tree, selectedKey) : null

  const select = (key: string) => {
    onSelectedNodeChange(findNode(tree, key))
  }

  // 布尔属性 → 显示 true/false（缺省则不显示该行）
  const yn = (v?: boolean) => (v === undefined ? undefined : v ? 'true' : 'false')
  const b = selected?.bounds

  return (
    <section className="element-panel">
      <div className="ep-bar">
        <button
          className={`ep-inspect ${inspectOn ? 'on' : ''}`}
          onClick={() => onToggleInspect()}
          title={
            inspectOn
              ? '关闭元素：画面点击不再定位（减少设备负载）'
              : '开启后才能点击镜像定位元素并自动抓取层级'
          }
        >
          <span className="ico">⌖</span>
          <span>元素</span>
          <span className="st">{inspectOn ? 'ON' : 'OFF'}</span>
        </button>
        <span className="ep-dev-note">
          {deviceName ? `目标设备：${deviceName}` : '未选择设备，请在上方设备镜像面板选中设备'}
        </span>
        <div className="ep-actions">
          <button
            className={`ep-refresh ${loading ? 'spin' : ''}`}
            onClick={onRefresh}
            disabled={loading || !deviceName}
            title={inspectOn ? '刷新层级' : '刷新层级（需在设备上跑 uiautomator dump，建议先开启检查元素）'}
          >
            ↻
          </button>
          <input
            className="ep-search"
            placeholder="搜索节点（名称/文本/ID）…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
      </div>

      {error && <div className="hint ep-error">{error}</div>}

      <div className="ep-body">
        <div className="ep-tree">
          <div className="ep-tree-head">
            <span>视图树</span>
            {q && <span className="ep-match">匹配 {matchCount} 个</span>}
          </div>
          <div className="ep-tree-scroll">
            {view ? (
              <TreeNode node={view} depth={0} selectedKey={selectedKey} onSelect={select} forceOpen={!!q} />
            ) : (
              <div className="screen-empty">
                {loading
                  ? '抓取中…'
                  : inspectOn
                    ? '暂无层级数据，点右上角 ↻ 抓取'
                    : '「元素」未开启\n开启后可点击镜像定位元素并抓取层级'}
              </div>
            )}
          </div>
        </div>

        {selected && (
          <>
            <div className="ep-splitter" onMouseDown={startDrag} title="拖动调整属性面板宽度" />
            <div className="ep-props" style={{ flex: 'none', width: propsW }}>
              <div className="ep-props-title">
                属性
              </div>
              <div className="prop-list">
                <div className="ep-sec">基础</div>
                <Row k="class" v={selected.className} />
                <Row k="text" v={selected.text} />
                <Row k="resource_id" v={selected.resourceId} />
                <Row k="content_desc" v={selected.contentDesc} />
                <Row k="package" v={selected.pkg} />
                <Row k="index" v={selected.index} />

                <div className="ep-sec">样式信息</div>
                <Row k="位置" v={b ? `x=${b.x}, y=${b.y}` : undefined} />
                <Row k="尺寸" v={b ? `${b.w} × ${b.h}` : undefined} />
                <Row k="clickable" v={yn(selected.clickable)} />
                <Row k="enabled" v={yn(selected.enabled)} />
                <Row k="focusable" v={yn(selected.focusable)} />
                <Row k="focused" v={yn(selected.focused)} />
                <Row k="scrollable" v={yn(selected.scrollable)} />
                <Row k="checkable" v={yn(selected.checkable)} />
                <Row k="checked" v={yn(selected.checked)} />
                <Row k="selected" v={yn(selected.selected)} />
                <Row k="long-clickable" v={yn(selected.longClickable)} />
                <Row k="password" v={yn(selected.password)} />
              </div>
            </div>
          </>
        )}
      </div>
    </section>
  )
}

function Row({ k, v }: { k: string; v?: string }) {
  if (v === undefined || v === '') return null
  const cls = v === 'true' ? 'on' : v === 'false' ? 'off' : ''
  return (
    <div className="prop-row">
      <span className="pk">{k}</span>
      <span className={`pv ${cls}`}>{v}</span>
    </div>
  )
}
