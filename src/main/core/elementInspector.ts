import { execFile } from 'child_process'
import { promisify } from 'util'
import { adbBin } from './appResolver'

const execFileP = promisify(execFile)

export interface UiNode {
  key: string
  text?: string
  className?: string
  resourceId?: string
  contentDesc?: string
  clickable?: boolean
  enabled?: boolean
  bounds?: { x: number; y: number; w: number; h: number }
  // 附加属性（uiautomator dump 可提供的状态/几何信息，用于「样式信息」展示）
  index?: string
  pkg?: string
  focusable?: boolean
  focused?: boolean
  scrollable?: boolean
  checkable?: boolean
  checked?: boolean
  selected?: boolean
  longClickable?: boolean
  password?: boolean
  children: UiNode[]
}

type InspectResult = UiNode | { error: string }

function parseAttrs(line: string): Record<string, string> {
  const out: Record<string, string> = {}
  // 允许连字符属性名（resource-id / content-desc / long-clickable）
  const re = /([\w-]+?)="([^"]*)"/g
  let m: RegExpExecArray | null
  while ((m = re.exec(line))) out[m[1]] = m[2]
  return out
}

function parseBounds(s?: string): UiNode['bounds'] {
  if (!s) return undefined
  const m = /\[(\d+),(\d+)\]\[(\d+),(\d+)\]/.exec(s)
  if (!m) return undefined
  const x = +m[1]
  const y = +m[2]
  return { x, y, w: +m[3] - x, h: +m[4] - y }
}

// uiautomator 输出为 XML（<hierarchy><node>...）。逐行 + 缩进方式在压缩成单行的
// 设备上会解析失败，这里改为标签扫描：忽略 <hierarchy>，仅匹配 <node> 开/闭标签，
// 用栈维护父子关系，与换行/缩进格式无关。
function parseUi(xml: string): UiNode | null {
  const tagRe = /<(\/?)(node)\b([^>]*?)(\/?)>/g
  const stack: UiNode[] = []
  let root: UiNode | null = null
  let counter = 0
  let m: RegExpExecArray | null

  while ((m = tagRe.exec(xml))) {
    const isClose = m[1] === '/'
    const isSelfClose = m[4] === '/'
    if (isClose) {
      if (stack.length) stack.pop()
      continue
    }
    const a = parseAttrs(m[3])
    const node: UiNode = {
      key: String(counter++),
      text: a.text || undefined,
      className: a.class || undefined,
      resourceId: a['resource-id'] || undefined,
      contentDesc: a['content-desc'] || undefined,
      clickable: a.clickable === 'true',
      enabled: a.enabled !== 'false',
      bounds: parseBounds(a.bounds),
      index: a.index || undefined,
      pkg: a.package || undefined,
      focusable: a.focusable === 'true',
      focused: a.focused === 'true',
      scrollable: a.scrollable === 'true',
      checkable: a.checkable === 'true',
      checked: a.checked === 'true',
      selected: a.selected === 'true',
      longClickable: a['long-clickable'] === 'true',
      password: a.password === 'true',
      children: []
    }
    if (stack.length === 0) {
      root = node
    } else {
      stack[stack.length - 1].children.push(node)
    }
    if (!isSelfClose) stack.push(node)
  }
  return root
}

async function inspectAndroid(serial: string): Promise<InspectResult> {
  try {
    const { stdout } = await execFileP(
      adbBin(),
      ['-s', serial, 'exec-out', 'uiautomator', 'dump', '/dev/tty'],
      { maxBuffer: 20 * 1024 * 1024 }
    )
    const root = parseUi(stdout)
    if (!root) {
      const snippet = stdout.trim().slice(0, 160).replace(/\s+/g, ' ')
      return { error: `解析视图树失败（未找到 <node> 节点）。原始输出前 160 字符：${snippet || '(空)'}` }
    }
    return root
  } catch (e) {
    return { error: `uiautomator 执行失败：${(e as Error).message}` }
  }
}

export async function inspect(
  platform: 'ios' | 'android',
  id: string
): Promise<InspectResult> {
  if (platform !== 'android') {
    return { error: '元素检查暂仅支持 Android 设备' }
  }
  return inspectAndroid(id)
}
