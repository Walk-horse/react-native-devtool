import { execFile } from 'child_process'
import { promisify } from 'util'
import { existsSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

const execFileP = promisify(execFile)

/** adb 可执行文件：优先 PATH（裸名），其次 Android SDK 默认位置 */
let cachedAdb: string | null = null
export function adbBin(): string {
  if (cachedAdb) return cachedAdb
  const candidates = [
    join(homedir(), 'Library/Android/sdk/platform-tools/adb'),
    '/usr/local/bin/adb',
    '/opt/homebrew/bin/adb'
  ]
  cachedAdb = candidates.find((p) => existsSync(p)) ?? 'adb'
  return cachedAdb
}

/** Android 模拟器可执行文件（与 adb 同理：GUI 启动无 PATH） */
let cachedEmu: string | null = null
export function emulatorBin(): string {
  if (cachedEmu) return cachedEmu
  const candidates = [
    join(homedir(), 'Library/Android/sdk/emulator/emulator'),
    '/usr/local/bin/emulator',
    '/opt/homebrew/bin/emulator'
  ]
  cachedEmu = candidates.find((p) => existsSync(p)) ?? 'emulator'
  return cachedEmu
}

/**
 * libimobiledevice 工具（idevice_id/ideviceinfo/idevicescreenshot 等）：
 * GUI 启动的 Electron 没有 brew PATH，必须显式解析绝对路径。
 */
const IDEVICE_DIRS = ['/opt/homebrew/bin', '/usr/local/bin']
const ideviceCache = new Map<string, string>()
export function ideviceBin(name: string): string {
  const hit = ideviceCache.get(name)
  if (hit) return hit
  const resolved =
    IDEVICE_DIRS.map((d) => join(d, name)).find((p) => existsSync(p)) ?? name
  ideviceCache.set(name, resolved)
  return resolved
}

/**
 * pymobiledevice3 的 Python 解释器：iOS 17+ 真机截图依赖
 * `python -m pymobiledevice3 developer dvt screenshot`（userspace 隧道，免 root）。
 * 优先 WorkBuddy 托管 venv（pymobiledevice3 已装），回退 PATH 里的 python3。
 */
let cachedPm: string | null = null
export function pmPythonBin(): string {
  if (cachedPm) return cachedPm
  const candidates = [
    join(homedir(), '.workbuddy/binaries/python/envs/default/bin/python'),
    '/usr/local/bin/python3',
    '/opt/homebrew/bin/python3'
  ]
  cachedPm = candidates.find((p) => existsSync(p)) ?? 'python3'
  return cachedPm
}

const MAX_BUF = 8 * 1024 * 1024
const SOCK_POLL_MS = 1500
const ON_DEMAND_THROTTLE_MS = 400
const PKG_TTL_MS = 60_000

/** 解析 /proc/net/tcp / tcp6：本地端口(hex) → uid */
export function parseSocketTable(text: string): Map<number, number> {
  const out = new Map<number, number>()
  for (const line of text.split('\n')) {
    const parts = line.trim().split(/\s+/)
    if (parts.length < 8) continue
    const local = parts[1]
    // 形如 0100007F:4E31 或 0000...0000:1F91（IPv6 32 位十六进制）
    if (!/^[0-9A-Fa-f]{8,32}:[0-9A-Fa-f]{4}$/.test(local)) continue
    const port = parseInt(local.split(':')[1], 16)
    const uid = parseInt(parts[7], 10)
    if (!Number.isFinite(port) || !Number.isFinite(uid)) continue
    out.set(port, uid)
  }
  return out
}

/** 解析 `pm list packages -U`：uid → 包名（同 uid 可多包） */
export function parsePackageUids(text: string): Map<number, string[]> {
  const out = new Map<number, string[]>()
  for (const line of text.split('\n')) {
    const m =
      line.match(/^package:(\S+)\s+uid:(\d+)/) ?? line.match(/^uid:(\d+)\s+package:(\S+)/)
    if (!m) continue
    const pkgFirst = line.startsWith('package:')
    const pkg = pkgFirst ? m[1] : m[2]
    const uid = parseInt(pkgFirst ? m[2] : m[1], 10)
    if (!Number.isFinite(uid) || !pkg) continue
    const arr = out.get(uid)
    if (arr) {
      if (!arr.includes(pkg)) arr.push(pkg)
    } else {
      out.set(uid, [pkg])
    }
  }
  return out
}

/**
 * 应用识别（仅 Android）：抓包代理收到请求时，用「设备侧本地端口」反查 uid，
 * 再由 uid 映射到包名，从而把请求归属到具体 App。
 * 端口表通过 adb 轮询 /proc/net/tcp(|6) 维护；包名表来自 pm list packages -U。
 */
export class AppResolver {
  private serial: string | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private portUid = new Map<number, number>()
  private uidPkg = new Map<number, string[]>()
  private pkgAt = 0
  private sockBusy = false
  private sockPending = false
  private pkgBusy = false
  private onDemandAt = 0
  private onDemand: Promise<void> | null = null
  private lastError: string | null = null

  get device() {
    return this.serial
  }

  /** 设置/清空目标设备（serial）。为空则停止轮询 */
  setDevice(serial: string | null) {
    if (serial === this.serial) return
    this.serial = serial
    this.portUid.clear()
    this.uidPkg.clear()
    this.pkgAt = 0
    this.lastError = null
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    if (serial) {
      this.timer = setInterval(() => void this.refreshSockets(), SOCK_POLL_MS)
      void this.refreshSockets()
      void this.refreshPackages()
    }
  }

  /** 供 UI 显示识别状态 */
  stats() {
    return {
      device: this.serial,
      ports: this.portUid.size,
      packages: this.uidPkg.size,
      error: this.lastError
    }
  }

  /** 端口 → 应用名（缓存未命中时立即拉一次端口表） */
  async appForPort(port: number): Promise<string | undefined> {
    const hit = this.lookup(port)
    if (hit) return hit
    if (!this.serial) return undefined
    // 新连接可能晚于上一次轮询：按需补一次（节流 + 合并并发）
    const now = Date.now()
    if (!this.onDemand && now - this.onDemandAt > ON_DEMAND_THROTTLE_MS) {
      this.onDemandAt = now
      this.onDemand = this.refreshSockets().finally(() => {
        this.onDemand = null
      })
    }
    if (this.onDemand) await this.onDemand
    return this.lookup(port)
  }

  private lookup(port: number): string | undefined {
    const uid = this.portUid.get(port)
    if (uid == null) return undefined
    return this.labelForUid(uid)
  }

  private labelForUid(uid: number): string {
    const pkgs = this.uidPkg.get(uid)
    if (pkgs && pkgs.length) return pkgs.length > 1 ? pkgs.slice(0, 2).join('|') : pkgs[0]
    // 系统 uid（<10000）没有包名映射，标记出来便于区分
    if (uid < 10000) return `system:uid${uid}`
    return `uid${uid}`
  }

  private async refreshSockets() {
    if (!this.serial) return
    if (this.sockBusy) {
      this.sockPending = true
      return
    }
    this.sockBusy = true
    try {
      const { stdout } = await execFileP(
        adbBin(),
        ['-s', this.serial, 'shell', 'cat /proc/net/tcp /proc/net/tcp6'],
        { maxBuffer: MAX_BUF }
      )
      const table = parseSocketTable(stdout)
      if (table.size) {
        this.portUid = table
        this.lastError = null
      }
    } catch (err) {
      this.lastError = (err as Error).message
    } finally {
      this.sockBusy = false
      if (this.sockPending) {
        this.sockPending = false
        void this.refreshSockets()
      }
      if (this.uidPkg.size === 0 || Date.now() - this.pkgAt > PKG_TTL_MS) void this.refreshPackages()
    }
  }

  private async refreshPackages() {
    if (!this.serial || this.pkgBusy) return
    this.pkgBusy = true
    try {
      const { stdout } = await execFileP(adbBin(), ['-s', this.serial, 'shell', 'pm list packages -U'], {
        maxBuffer: MAX_BUF
      })
      const map = parsePackageUids(stdout)
      if (map.size) {
        this.uidPkg = map
        this.pkgAt = Date.now()
      }
    } catch (err) {
      this.lastError = (err as Error).message
    } finally {
      this.pkgBusy = false
    }
  }
}

export const appResolver = new AppResolver()
