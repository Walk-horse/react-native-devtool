import { execFile } from 'child_process'
import { promisify } from 'util'
import { spawn } from 'child_process'
import { adbBin, emulatorBin, ideviceBin } from './appResolver'

const execFileP = promisify(execFile)

/** 外部命令统一超时：设备拔插瞬间可能 hang，别让轮询卡死 */
const T_FAST = 4000
const T_SLOW = 10000

export interface DeviceInfo {
  platform: 'ios' | 'android'
  id: string // iOS: udid ; Android: serial
  name: string
  state: 'booted' | 'shutdown' | 'device' | 'offline' | 'unknown'
  os?: string // iOS 系统版本
  avd?: string // Android AVD 名称
  real?: boolean // iOS 真机（USB 物理设备）为 true，模拟器为 false/省略
}

// ---------------- iOS ----------------
export async function listIOSSimulators(): Promise<DeviceInfo[]> {
  try {
    const { stdout } = await execFileP('xcrun', ['simctl', 'list', 'devices', '-j'], {
      maxBuffer: 10 * 1024 * 1024,
      timeout: T_SLOW
    })
    const data = JSON.parse(stdout) as { devices?: Record<string, Array<{ udid: string; name: string; state: string }>> }
    const out: DeviceInfo[] = []
    for (const [runtime, devs] of Object.entries(data.devices || {})) {
      const osMatch = runtime.match(/iOS\s+([\d.]+)/)
      const os = osMatch ? osMatch[1] : runtime
      for (const d of devs) {
        out.push({
          platform: 'ios',
          id: d.udid,
          name: d.name,
          os,
          state: d.state === 'Booted' ? 'booted' : d.state === 'Shutdown' ? 'shutdown' : 'unknown'
        })
      }
    }
    return out
  } catch {
    return []
  }
}

export async function bootIOSSim(udid: string): Promise<void> {
  await execFileP('xcrun', ['simctl', 'boot', udid]).catch(() => {})
  await execFileP('open', ['-a', 'Simulator']).catch(() => {})
}

// ---------------- Android ----------------
export async function listAndroidDevices(): Promise<DeviceInfo[]> {
  try {
    // 必须用 adbBin()：GUI 启动的 Electron 没有 PATH，裸 'adb' 直接 ENOENT
    const { stdout } = await execFileP(adbBin(), ['devices', '-l'], {
      maxBuffer: 1024 * 1024,
      timeout: T_FAST
    })
    const out: DeviceInfo[] = []
    for (const line of stdout.split('\n').slice(1)) {
      const m = line.match(/^(\S+)\s+(\S+)/)
      if (!m) continue
      const [, serial, state] = m
      if (['device', 'offline', 'unauthorized'].includes(state)) {
        out.push({
          platform: 'android',
          id: serial,
          name: serial,
          state: state === 'device' ? 'device' : 'offline'
        })
      }
    }
    return out
  } catch {
    return []
  }
}

export async function listAndroidAvds(): Promise<string[]> {
  try {
    const { stdout } = await execFileP(emulatorBin(), ['-list-avds'], {
      maxBuffer: 1024 * 1024,
      timeout: T_FAST
    })
    return stdout.split('\n').map((s) => s.trim()).filter(Boolean)
  } catch {
    return []
  }
}

export async function bootAndroidAvd(avd: string): Promise<void> {
  const em = spawn(emulatorBin(), ['-avd', avd], { detached: true, stdio: 'ignore' })
  em.unref()
}

// ---------------- iOS 真机（USB 物理设备）----------------
/**
 * simctl 只管模拟器，列不出 USB 真机。真机需要：
 *  - 优先 libimobiledevice 的 `idevice_id`（最快、无需 Xcode 授权）
 *  - 回退 `xcrun xctrace list devices`（Xcode 自带，但慢且可能弹授权）
 */
function parseXctraceDevices(stdout: string): DeviceInfo[] {
  const out: DeviceInfo[] = []
  let inDevices = false
  for (const line of stdout.split('\n')) {
    const t = line.trim()
    // 段头可能是 `== Devices ==` 或 `-- Devices --`（不同 Xcode 版本/语言）
    const head = t.match(/^([=\-])\1+\s*(.+?)\s*\1\1+$/)
    if (head) {
      const name = head[2].toLowerCase()
      if (name.startsWith('simul')) inDevices = false
      else if (name === 'devices') inDevices = true
      else inDevices = false
      continue
    }
    if (!inDevices || !t) continue
    // 实际格式：`<Name> (<os>) (<udid>)`，udid 在行尾括号；Mac 机器则只有 `(<uuid>)`
    const tail = t.match(/\(([0-9A-Fa-f][0-9A-Fa-f-]{7,})\)$/)
    if (!tail) continue
    // 过滤 Mac 主机自身（不在 Devices 段出现的 UUID 也可能混入）
    const rest = t.slice(0, tail.index).trim()
    if (/mac\s*(book|mini|studio|pro)/i.test(rest)) continue
    const info = rest.match(/^(.+?)(?:\s+\(([\d.]+)\))?$/)
    if (!info) continue
    out.push({
      platform: 'ios',
      id: tail[1],
      name: info[1].trim(),
      os: info[2],
      state: 'device',
      real: true
    })
  }
  return out
}

export async function listIOSRealDevices(): Promise<DeviceInfo[]> {
  // 方案 1：libimobiledevice（需 brew install libimobiledevice，设备已信任）
  // 注意：命令存在但返回空（未连真机）时必须直接返回 []，
  // 不能穿透到 xctrace —— xctrace ~2.4s，每 4s 轮询会把设备列表拖死。
  try {
    const { stdout } = await execFileP(ideviceBin('idevice_id'), ['-l'], {
      maxBuffer: 1024 * 1024,
      timeout: T_FAST
    })
    const ids = stdout
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
    if (!ids.length) return []
    return await Promise.all(
      ids.map(async (id) => {
        let name = id
        let os: string | undefined
        try {
          name = (
            await execFileP(ideviceBin('ideviceinfo'), ['-u', id, '-k', 'DeviceName'], {
              maxBuffer: 1024 * 1024,
              timeout: T_FAST
            })
          ).stdout.trim()
        } catch {
          /* 忽略，回退 udid */
        }
        try {
          os = (
            await execFileP(ideviceBin('ideviceinfo'), ['-u', id, '-k', 'ProductVersion'], {
              maxBuffer: 1024 * 1024,
              timeout: T_FAST
            })
          ).stdout.trim()
        } catch {
          /* 忽略 */
        }
        return {
          platform: 'ios' as const,
          id,
          name: name || id,
          os,
          state: 'device' as const,
          real: true
        }
      })
    )
  } catch (e) {
    // 仅当 idevice_id 本身不可用（未装 libimobiledevice）才回退 xctrace
    const err = e as { code?: string }
    if (err?.code !== 'ENOENT') return []
  }
  // 方案 2：xctrace（Xcode 自带，但慢，加超时防 hang）
  try {
    const { stdout } = await execFileP('xcrun', ['xctrace', 'list', 'devices'], {
      maxBuffer: 10 * 1024 * 1024,
      timeout: T_SLOW
    })
    return parseXctraceDevices(stdout)
  } catch {
    return []
  }
}

// ---------------- 汇总 ----------------
export async function listAllDevices(): Promise<DeviceInfo[]> {
  const [iosSim, iosReal, android] = await Promise.all([
    listIOSSimulators(),
    listIOSRealDevices(),
    listAndroidDevices()
  ])
  return [...iosSim, ...iosReal, ...android]
}
