import { spawn, ChildProcess } from 'child_process'
import { adbBin } from './appResolver'
import { RawLog, LogLevel, stripAnsi, guessLevel } from './logBus'

type Platform = 'ios' | 'android'

const procs = new Map<Platform, ChildProcess>()

/** 采集范围：RN 应用 console / 桥 + 引擎日志；其余 tag 静音 */
const LOGCAT_ARGS = [
  'ReactNative:V',
  'ReactNativeJS:V',
  'ReactNativeJSI:V',
  'ReactNativeBridgeless:V',
  'Hermes:V',
  '*:S'
]

/**
 * logcat 行格式随设备/版本不同，三种都认：
 *  - threadtime： 09-21 18:00:00.123  1234  5678 I ReactNativeJS: message
 *  - time+brief： 09-21 18:00:00.123 I/ReactNativeJS( 1234): message   ← 真机常见
 *  - brief：      I/ReactNativeJS( 1234): message
 * 捕获组顺序统一为 (级别, tag, 正文)
 */
const RE_THREADTIME = /^\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\.\d+\s+\d+\s+\d+\s+([VDIWEF])\s+([^:\s]+)\s*:\s?([\s\S]*)$/
const RE_TIME_BRIEF = /^\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\.\d+\s+([VDIWEF])\/([^(\s]+)\s*\(\s*\d+\):\s?([\s\S]*)$/
const RE_BRIEF = /^([VDIWEF])\/([^(\s]+)\s*\(\s*\d+\):\s?([\s\S]*)$/

const LV: Record<string, LogLevel> = { V: 'debug', D: 'log', I: 'info', W: 'warn', E: 'error', F: 'error' }

/** RN 的 JS console 输出走 ReactNativeJS 这个 tag */
function isJsTag(tag: string, line: string): boolean {
  return (
    /^ReactNative(JS|JSI|Bridgeless)?$/i.test(tag) ||
    /Hermes/i.test(tag) ||
    /console\.|^\s*(LOG|WARN|ERROR)\s/.test(line)
  )
}

/** 解析一行 Android logcat，识别级别 / tag / 来源 */
export function parseLogcatLine(line: string): RawLog | null {
  const raw = stripAnsi(line).replace(/\r/g, '')
  const t = raw.trimEnd()
  if (!t.trim() || t.startsWith('---------')) return null
  const m = t.match(RE_THREADTIME) ?? t.match(RE_TIME_BRIEF) ?? t.match(RE_BRIEF)
  if (!m) {
    // 非标准行（如 adb 报错）也保留，避免"日志流活着但看不到东西"
    return { level: guessLevel(t), source: 'device', text: t }
  }
  const lv = m[1]
  const tag = m[2].trim()
  const text = (m[3] ?? '').trimEnd()
  return {
    level: LV[lv] ?? 'log',
    source: isJsTag(tag, text) ? 'app' : 'device',
    tag,
    text
  }
}

/** iOS 模拟器 log stream 一行（compact 风格），仅做级别/来源归类 */
function parseIosLine(line: string): RawLog | null {
  const raw = stripAnsi(line).replace(/\r/g, '')
  if (!raw.trim()) return null
  const isJs = /ReactNativeJS|RCTLog|\bLOG\b|\bjs::/.test(raw)
  return {
    level: guessLevel(raw),
    source: isJs ? 'app' : 'device',
    tag: isJs ? 'ReactNativeJS' : 'ios',
    text: raw
  }
}

/**
 * 开始采集平台日志：Android = adb logcat（RN console），iOS = simctl log stream。
 * iOS 真机（real）特殊：bridgeless/Hermes 的 console 不进系统日志（syslog 实测无输出），
 * console 输出经 Metro inspector 调试通道采集（devtoolsNetwork 注入 console 钩子转发）。
 * 同一平台重复调用会先停旧的；跨平台互斥由 ipc 层 stopAll 保证。
 */
export function startPlatformLog(
  platform: Platform,
  id: string | null,
  onLog: (raw: RawLog) => void,
  real = false
): void {
  stopPlatformLog(platform)

  let child: ChildProcess
  if (platform === 'android') {
    if (!id) {
      onLog({ level: 'error', source: 'device', text: '未指定设备序列号，无法采集 logcat' })
      return
    }
    child = spawn(adbBin(), ['-s', id, 'logcat', '-v', 'time', ...LOGCAT_ARGS])
  } else if (real) {
    // iOS 真机：simctl 只认模拟器；syslog 又抓不到 console。提示走调试通道。
    onLog({
      level: 'info',
      source: 'device',
      text: 'iOS 真机：console 日志经 Metro 调试通道采集，请开启网络页的 DevTools 抓包（两者共用同一条连接）'
    })
    return
  } else {
    const args = id
      ? ['simctl', 'spawn', id, 'log', 'stream', '--style', 'compact']
      : ['simctl', 'spawn', 'booted', 'log', 'stream', '--style', 'compact']
    child = spawn('xcrun', args)
  }

  const handle = (d: Buffer) => {
    for (const line of d.toString().split('\n')) {
      if (!line.trim()) continue
      const raw = platform === 'android' ? parseLogcatLine(line) : parseIosLine(line)
      if (raw) onLog(raw)
    }
  }
  child.stdout?.on('data', handle)
  child.stderr?.on('data', handle)
  child.on('error', (e) => {
    onLog({ level: 'error', source: 'device', text: `日志流启动失败（${platform}）：${e.message}` })
  })
  child.on('close', (code) => {
    if (procs.get(platform) === child) {
      procs.delete(platform)
      if (code !== 0 && code !== null) {
        onLog({ level: 'warn', source: 'device', text: `日志流已退出（code=${code}）` })
      }
    }
  })
  procs.set(platform, child)
}

export function stopPlatformLog(platform: Platform): void {
  const c = procs.get(platform)
  if (c) {
    c.kill('SIGTERM')
    procs.delete(platform)
  }
}

/** 停止全部平台日志（切设备 / 离开日志页时用） */
export function stopAllPlatformLogs(): void {
  for (const p of Array.from(procs.keys())) stopPlatformLog(p)
}

export function activePlatforms(): Platform[] {
  return Array.from(procs.keys())
}
