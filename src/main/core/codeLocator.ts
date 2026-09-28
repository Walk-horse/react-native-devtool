import * as fs from 'fs'
import * as path from 'path'

export interface CodeHit {
  file: string
  line: number
  snippet: string
  score: number
}

const SRC_EXT = new Set(['.js', '.jsx', '.ts', '.tsx', '.json'])
// RN 视图类名 → 常见组件名（命中组件定义时权重更高）
const RN_CLASS_MAP: Record<string, string[]> = {
  'android.widget.TextView': ['Text'],
  'android.widget.ImageView': ['Image'],
  'android.widget.Button': ['TouchableOpacity', 'Pressable', 'Button'],
  'android.widget.EditText': ['TextInput'],
  'android.view.ViewGroup': ['View'],
  'androidx.recyclerview.widget.RecyclerView': ['FlatList', 'ScrollView', 'SectionList']
}

// 跳过这些目录，避免扫进 node_modules / 构建产物
const SKIP_DIRS = new Set(['node_modules', 'ios', 'android', 'build', 'dist', '.git', 'out', 'coverage'])

function walk(dir: string, files: string[]): void {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    if (e.name.startsWith('.') && e.name !== '.') continue
    if (SKIP_DIRS.has(e.name)) continue
    const full = path.join(dir, e.name)
    if (e.isDirectory()) {
      walk(full, files)
    } else if (SRC_EXT.has(path.extname(e.name).toLowerCase())) {
      files.push(full)
    }
  }
}

// 将待查字符串做正则转义
function esc(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 按节点属性在工程源码中定位候选代码位置。
 * 命中策略（score 越高越可能是目标）：
 *  - text / contentDesc：在源码中按文案原文匹配（带引号），最可能命中 JSX 文案
 *  - resourceId：按 id 末段匹配（android:id 通常映射到 testID / styleID）
 *  - className：按 RN 组件名匹配（如 Text/Image/View）
 */
export function locate(projectPath: string, node: {
  text?: string
  className?: string
  resourceId?: string
  contentDesc?: string
}): CodeHit[] {
  const files: string[] = []
  walk(projectPath, files)
  const hits: CodeHit[] = []
  const seen = new Set<string>()

  const queries: { re: RegExp; score: number }[] = []
  if (node.text) {
    queries.push({ re: new RegExp(esc(node.text), 'g'), score: 100 })
    // 宽松：文案可能拆成变量，按连续子串（>=3 字）匹配
    if (node.text.length >= 3) queries.push({ re: new RegExp(esc(node.text.slice(0, Math.ceil(node.text.length / 2))), 'g'), score: 40 })
  }
  if (node.contentDesc) {
    queries.push({ re: new RegExp(esc(node.contentDesc), 'g'), score: 90 })
  }
  if (node.resourceId) {
    const tail = node.resourceId.split(/[/:]/).pop() || node.resourceId
    queries.push({ re: new RegExp(esc(tail), 'g'), score: 70 })
  }
  const comps = node.className ? RN_CLASS_MAP[node.className] || [node.className.split('.').pop()!] : []
  for (const c of comps) {
    // 组件名需整体词匹配，避免 "View" 命中 "viewBox"
    queries.push({ re: new RegExp(`\\b${esc(c)}\\b`, 'g'), score: 50 })
  }
  if (queries.length === 0) return hits

  for (const f of files) {
    let content: string
    try {
      content = fs.readFileSync(f, 'utf8')
    } catch {
      continue
    }
    const lines = content.split('\n')
    for (const q of queries) {
      const re = new RegExp(q.re.source, 'g')
      for (let i = 0; i < lines.length; i++) {
        const lineText = lines[i]
        if (!re.test(lineText)) continue
        const key = `${f}:${i}`
        if (seen.has(key)) continue
        seen.add(key)
        hits.push({
          file: f,
          line: i + 1,
          snippet: lineText.trim().slice(0, 120),
          score: q.score
        })
      }
    }
  }
  // 按分数降序，最多返回 30 条
  hits.sort((a, b) => b.score - a.score || a.file.localeCompare(b.file))
  return hits.slice(0, 30)
}
