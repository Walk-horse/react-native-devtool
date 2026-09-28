/**
 * 响应体 / 接口体的 JSON 解析与格式化（网络页详情与日志页接口详情共用）。
 */

/**
 * 解析为对象：
 * 1. 标准 JSON；
 * 2. 双重编码（形如 "{\"a\":1}" 的字符串）逐层解包（最多 5 层）；
 * 3. 截断的 JSON（拦截器历史数据 / 大响应）补齐闭合后解析。
 * 非 JSON 返回 undefined。
 */
export function parseJsonFlexible(body?: string): unknown {
  if (!body) return undefined
  let v: unknown = body
  for (let layer = 0; layer < 5; layer++) {
    if (typeof v !== 'string') break
    const t = v.trim()
    const looksJson =
      (t.startsWith('{') && (t.endsWith('}') || t.endsWith(',') || t.endsWith('"') || t.endsWith(':'))) ||
      (t.startsWith('[') && (t.endsWith(']') || t.endsWith(',') || t.endsWith('"') || t.endsWith(':'))) ||
      (t.startsWith('"') && t.endsWith('"'))
    if (!looksJson) break
    let parsed: unknown
    try {
      parsed = JSON.parse(t)
    } catch {
      const fixed = repairTruncated(t)
      if (!fixed) break
      try {
        parsed = JSON.parse(fixed)
      } catch {
        break
      }
    }
    v = parsed
  }
  return typeof v === 'object' && v !== null ? v : undefined
}

/** 截断 JSON 修复：扫描括号/字符串状态，截到最后一个完整值边界（悬空 key 一并丢弃），再按栈序补齐闭合符；无法修复返回 null */
export function repairTruncated(t: string): string | null {
  if (!(t.startsWith('{') || t.startsWith('['))) return null
  const stack: string[] = []
  let inStr = false
  let esc = false
  let lastSafe = -1 // 最后一个完整值结束的位置（闭合引号 / 闭合括号 / 逗号 / 开括号之后）
  let keyStart = -1 // 最近一个处于 key 位置的字符串起始引号下标
  let expectKey = false // 对象内 { 或 , 之后期待 key
  for (let i = 0; i < t.length; i++) {
    const c = t[i]
    if (inStr) {
      if (esc) esc = false
      else if (c === '\\') esc = true
      else if (c === '"') {
        inStr = false
        lastSafe = i
      }
      continue
    }
    if (c === '"') {
      inStr = true
      if (expectKey) {
        keyStart = i
        expectKey = false
      }
    } else if (c === '{' || c === '[') {
      stack.push(c)
      expectKey = c === '{'
      lastSafe = i
    } else if (c === '}' || c === ']') {
      stack.pop()
      expectKey = false
      lastSafe = i
    } else if (c === ',') {
      lastSafe = i
      expectKey = stack[stack.length - 1] === '{'
    } else if (c === ':') {
      expectKey = false
    } else if (!/\s/.test(c)) {
      expectKey = false
    }
  }
  if (!inStr && !esc && stack.length === 0) return null // 未截断，原样解析失败另有原因
  // 截断点若落在「key 之后、值之前」（紧跟着冒号），整个 key 一起丢弃
  let cut = lastSafe
  let j = cut + 1
  while (j < t.length && /\s/.test(t[j])) j++
  if (j < t.length && t[j] === ':' && keyStart > 0) cut = keyStart - 1
  let s = t.slice(0, cut + 1)
  while (s.length && /[,:\s]/.test(s[s.length - 1])) s = s.slice(0, -1)
  for (let i = stack.length - 1; i >= 0; i--) s += stack[i] === '{' ? '}' : ']'
  return s.length > 1 ? s : null
}

/** JSON 格式化（2 空格缩进，任意嵌套深度）；非 JSON 返回 null，调用方回退原文。 */
export function prettyJson(body: string): string | null {
  const v = parseJsonFlexible(body)
  if (v === undefined) return null
  try {
    return JSON.stringify(v, null, 2)
  } catch {
    return null
  }
}
