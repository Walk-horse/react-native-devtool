import { execFile } from 'child_process'
import { promisify } from 'util'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { ideviceBin, pmPythonBin, adbBin } from './appResolver'

const execFileP = promisify(execFile)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

interface Session {
  stopped: boolean
  paused: boolean
  fps: number
  real: boolean
}

const sessions = new Map<string, Session>()
/** 窗口最小化/隐藏时暂停全部采集（避免后台持续 screencap 烤设备） */
let pausedAll = false

/** 默认 3fps：screencap 在低端机上很重，6fps 容易把设备压到卡死 */
const DEFAULT_FPS = 3

async function captureIOS(udid: string, real: boolean): Promise<Buffer> {
  const tmp = path.join(os.tmpdir(), `rn-mirror-ios-${udid}.png`)
  if (real) {
    // 真机（iOS 17+）：screenshotr/idevicescreenshot 已被 Apple 废除，
    // 走 pymobiledevice3 的 DVT 截图（Instruments 同款，userspace 隧道免 root）。
    // 实测约 1.4s/帧，故真机会话 fps 压到 1。
    // 前提：开发者模式开启 + DDI 已挂载（Xcode 连过一次即自动挂载）
    await execFileP(
      pmPythonBin(),
      ['-m', 'pymobiledevice3', 'developer', 'dvt', 'screenshot', '--udid', udid, tmp],
      { env: { ...process.env, PYMOBILEDEVICE3_USERSPACE: '1' }, maxBuffer: 10 * 1024 * 1024 }
    )
  } else {
    // 模拟器
    await execFileP('xcrun', ['simctl', 'io', udid, 'screenshot', tmp])
  }
  return fs.readFileSync(tmp)
}

async function captureAndroid(serial: string): Promise<Buffer> {
  // 必须用 adbBin()：GUI 启动的 Electron 没有 PATH，裸 'adb' 直接 ENOENT
  const { stdout } = await execFileP(
    adbBin(),
    ['-s', serial, 'exec-out', 'screencap', '-p'],
    { encoding: 'buffer', maxBuffer: 30 * 1024 * 1024 }
  )
  return stdout as Buffer
}

/**
 * 串行采集：上一帧完成后才排下一帧（原 setInterval 会在慢帧时堆叠 adb 进程，
 * 设备侧 screencap 排队 → 手机内存/CPU 飙升）。
 */
async function loop(
  platform: 'ios' | 'android',
  id: string,
  onFrame: (b64: string) => void,
  s: Session
): Promise<void> {
  while (!s.stopped) {
    if (s.paused || pausedAll) {
      await sleep(300)
      continue
    }
    const t0 = Date.now()
    try {
      const buf = platform === 'ios' ? await captureIOS(id, s.real) : await captureAndroid(id)
      if (s.stopped) return
      onFrame(buf.toString('base64'))
    } catch {
      /* 设备未就绪 / 真机未装 libimobiledevice 时静默跳过 */
    }
    const rest = 1000 / s.fps - (Date.now() - t0)
    await sleep(rest > 0 ? rest : 80)
  }
}

export function startMirror(
  platform: 'ios' | 'android',
  id: string,
  onFrame: (b64: string) => void,
  fps = DEFAULT_FPS,
  real = false
) {
  stopMirror(platform, id)
  // iOS 真机截图（pymobiledevice3 DVT）约 1.4s/帧，强制 1fps，避免进程堆叠
  const effFps = platform === 'ios' && real ? Math.min(fps, 1) : fps
  const s: Session = { stopped: false, paused: false, fps: effFps, real }
  sessions.set(`${platform}:${id}`, s)
  void loop(platform, id, onFrame, s)
}

export function stopMirror(platform: 'ios' | 'android', id: string) {
  const key = `${platform}:${id}`
  const s = sessions.get(key)
  if (s) {
    s.stopped = true
    sessions.delete(key)
  }
}

export function stopAllMirrors() {
  for (const key of Array.from(sessions.keys())) {
    const s = sessions.get(key)!
    s.stopped = true
    sessions.delete(key)
  }
}

/** 窗口不可见时暂停（不销毁会话，恢复后继续） */
export function pauseAllMirrors(paused: boolean) {
  pausedAll = paused
}

export function mirrorStats() {
  return { sessions: sessions.size, paused: pausedAll }
}

export async function captureOnce(
  platform: 'ios' | 'android',
  id: string,
  real = false
): Promise<string> {
  const buf = platform === 'ios' ? await captureIOS(id, real) : await captureAndroid(id)
  return buf.toString('base64')
}
