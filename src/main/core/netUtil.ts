import { URL } from 'url'

/**
 * 抓包条目的公共类型与工具函数。
 * 两套后端共用：
 *  - networkMonitor：本地代理 + MITM（可抓原生/非 JS 请求，需装证书）
 *  - devtoolsNetwork：inspector 注入（免证书，仅 JS 层 fetch/XHR）
 */
export interface NetEntry {
  id: string
  method: string
  scheme: 'http' | 'https'
  host: string
  url: string
  name: string
  type: string
  /** 设备侧发起连接的本地端口（用于反查所属 App，仅代理模式） */
  clientPort?: number
  /** 请求归属的应用（Android 包名 / DevTools 目标的 appId；无法识别时为空） */
  app?: string
  /** 数据来源：proxy=代理抓包 / devtools=inspector 注入 */
  source?: 'proxy' | 'devtools'
  /** devtools 模式下的发起方式 */
  channel?: 'fetch' | 'xhr'
  status?: number
  statusText?: string
  startTime: number
  endTime?: number
  duration?: number
  reqBytes?: number
  resBytes?: number
  error?: string
  requestHeaders?: Record<string, string>
  responseHeaders?: Record<string, string>
  reqBody?: string
  resBody?: string
}

export const MAX_BODY = 100 * 1024

/** 接口名：路径最后一段 + query（对齐 DevTools「名称」列） */
export function urlName(u: string): string {
  try {
    const url = new URL(u)
    const seg = url.pathname.split('/').filter(Boolean).pop()
    const base = seg || url.hostname
    return url.search ? `${base}${url.search}` : base
  } catch {
    return u
  }
}

/** 从 URL 推断 scheme/host，用于注入模式（拿不到 socket 信息） */
export function splitUrl(u: string): { scheme: 'http' | 'https'; host: string } {
  try {
    const url = new URL(u)
    const scheme = url.protocol === 'https:' ? 'https' : 'http'
    return { scheme, host: url.host || url.hostname }
  } catch {
    return { scheme: 'http', host: '' }
  }
}

/**
 * 资源类型：优先按 content-type，其次按扩展名。
 * 取值与 DevTools 分类对齐：fetch | xhr | document | css | script | font | img | media | manifest | ws | wasm | other
 */
export function guessType(contentType: string | undefined, url: string): string {
  const ct = (contentType || '').toLowerCase()
  const p = url.split('?')[0].toLowerCase()
  // 顺序敏感：manifest / wasm 的 content-type 常带 json、octet-stream 等后缀，需先判
  if (ct.includes('manifest') || p.endsWith('.webmanifest') || p.endsWith('manifest.json')) return 'manifest'
  if (ct.includes('wasm') || p.endsWith('.wasm')) return 'wasm'
  if (ct.includes('websocket') || ct.includes('socket')) return 'ws'
  if (ct.includes('json')) return 'fetch'
  if (ct.includes('javascript') || ct.includes('ecmascript')) return 'script'
  if (ct.includes('css')) return 'css'
  if (ct.includes('html')) return 'document'
  if (ct.startsWith('image/')) return 'img'
  if (ct.includes('font') || ct.includes('woff')) return 'font'
  if (ct.startsWith('video/') || ct.startsWith('audio/')) return 'media'
  if (ct.startsWith('text/') || ct.includes('xml') || ct.includes('form')) return 'xhr'
  if (ct) return 'other'
  if (p.endsWith('.json')) return 'fetch'
  if (p.endsWith('.js') || p.endsWith('.mjs') || p.endsWith('.cjs')) return 'script'
  if (p.endsWith('.css')) return 'css'
  if (p.endsWith('.html') || p.endsWith('.htm')) return 'document'
  if (/\.(png|jpe?g|gif|webp|svg|ico|bmp|avif)$/.test(p)) return 'img'
  if (/\.(woff2?|ttf|otf|eot)$/.test(p)) return 'font'
  if (/\.(mp4|webm|mp3|wav|ogg|m4a|mov)$/.test(p)) return 'media'
  return 'other'
}
