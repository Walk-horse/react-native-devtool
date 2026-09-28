/**
 * Android 实时镜像：scrcpy server 桥接（纯 JS，无宿主原生依赖）。
 *
 * 链路（scrcpy v2.4 协议，真机实测验证）：
 *   1. adb push scrcpy-server-v2.4 → /data/local/tmp
 *   2. adb forward tcp:0 localabstract:scrcpy_<scid>（adb 返回分配的端口）
 *   3. spawn: CLASSPATH=<jar> app_process / com.genymobile.scrcpy.Server 2.4
 *      tunnel_forward=true audio=false control=true send_dummy_byte=false
 *      send_device_meta=false cleanup=false scid=<hex>
 *   4. host 依次 net.connect 两次到 forward 端口（conn1=video，conn2=control）。
 *      ⚠ server 在 DesktopConnection.open 中 accept 完全部 socket 才开始推流，
 *      两个连接必须都建立后 video 才有数据。
 *   5. video socket：12B codec meta（codecId u32 + 宽 u32 + 高 u32），随后每帧
 *      12B 帧头（bit63=config / bit62=key + 62bit pts，u32 size）+ Annex-B payload。
 *      ⚠ 读流必须用常驻缓冲（flowing 模式间歇取读会丢字节导致失步）。
 *   6. control socket：二进制消息（大端），INJECT_TOUCH_EVENT=32B、
 *      INJECT_KEYCODE=14B、INJECT_SCROLL_EVENT=21B、BACK_OR_SCREEN_ON=2B。
 *      pressure 为 u16 定点（0xFFFF=1.0），scroll 为 i16 定点（0x7FFF=1.0）。
 *   7. scid 参数是 16 进制字符串（Options.parseInt(value, 16)）。
 */
import { spawn, execFile, type ChildProcess } from 'child_process'
import net from 'net'
import path from 'path'
import fs from 'fs'
import { adbBin } from './appResolver'
import * as logBus from './logBus'

const SERVER_VERSION = '2.4'
const DEV_JAR = '/data/local/tmp/rndt_scrcpy_server.jar'

// ---- 事件（经 IPC 推给 renderer）----
export interface LiveMetaEvt {
  t: 'meta'
  serial: string
  videoW: number
  videoH: number
  displayW: number
  displayH: number
}
export interface LiveCfgEvt {
  t: 'cfg'
  serial: string
  buf: Buffer
}
export interface LiveFrameEvt {
  t: 'f'
  serial: string
  key: boolean
  buf: Buffer
}
export interface LiveStatusEvt {
  t: 'status'
  serial: string
  on: boolean
  err?: string
}
export type LiveEvt = LiveMetaEvt | LiveCfgEvt | LiveFrameEvt | LiveStatusEvt

// ---- 控制消息（renderer → 设备）----
export interface CtrlTouch {
  t: 'touch'
  action: number // 0=down 1=up 2=move
  x: number // 视频像素坐标
  y: number
  w: number // 当前视频宽高（server 按比例映射到屏幕）
  h: number
  pressure: number // 0..1
  actionButton: number
  buttons: number
}
export interface CtrlKey {
  t: 'key'
  action: number // 0=down 1=up
  keycode: number
  repeat: number
  metaState: number
}
export interface CtrlScroll {
  t: 'scroll'
  x: number
  y: number
  w: number
  h: number
  hScroll: number // 「格」，正负方向
  vScroll: number
  buttons: number
}
export type CtrlMsg = CtrlTouch | CtrlKey | CtrlScroll

interface Session {
  serial: string
  proc: ChildProcess
  port: number
  video?: net.Socket
  ctrl?: net.Socket
  ctrlQueue: Buffer[]
  vbuf: Buffer[]
  vlen: number
  phase: 'meta' | 'hdr' | 'payload'
  need: number
  hdrFlags: bigint
  displayW: number
  displayH: number
  stopped: boolean
}

const sessions = new Map<string, Session>()
let onEvt: (e: LiveEvt) => void = () => {}

export function setOnEvent(cb: (e: LiveEvt) => void) {
  onEvt = cb
}

const emit = (e: LiveEvt) => {
  try {
    onEvt(e)
  } catch {
    /* renderer 不在时不抛 */
  }
}

const log = (level: 'info' | 'warn' | 'error', text: string) => logBus.push(level, 'device', `[scrcpy] ${text}`)

function serverJarPath(): string {
  const name = `scrcpy-server-v${SERVER_VERSION}`
  const candidates = [path.join(__dirname, '../../resources', name), path.join(process.cwd(), 'resources', name)]
  for (const c of candidates) if (fs.existsSync(c)) return c
  return candidates[0]
}

function adb(args: string[], timeout = 20000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(adbBin(), args, { timeout, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) =>
      err ? reject(err) : resolve(String(stdout))
    )
  })
}

/** 解析 wm size（优先 Override），返回物理像素 */
async function displaySize(serial: string): Promise<{ w: number; h: number }> {
  try {
    const out = await adb(['-s', serial, 'shell', 'wm', 'size'])
    const over = out.match(/Override size:\s*(\d+)x(\d+)/)
    const phys = out.match(/Physical size:\s*(\d+)x(\d+)/)
    const m = over ?? phys
    if (m) return { w: parseInt(m[1], 10), h: parseInt(m[2], 10) }
  } catch {
    /* 忽略，用 0 表示未知 */
  }
  return { w: 0, h: 0 }
}

/** 带存活探测的连接：adbd 会先收下 TCP，设备端尚未监听时 relay 会立刻关闭 */
function connectAlive(port: number, tries = 60): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const attempt = async (n: number) => {
      if (n <= 0) return reject(new Error('connect: 重试超限'))
      let sock: net.Socket
      try {
        sock = await new Promise<net.Socket>((res, rej) => {
          const s = net.connect(port, '127.0.0.1')
          s.once('connect', () => res(s))
          s.once('error', (e) => {
            s.destroy()
            rej(e)
          })
        })
      } catch {
        return setTimeout(() => attempt(n - 1), 200)
      }
      const alive = await new Promise<boolean>((res) => {
        let done = false
        const t = setTimeout(() => {
          if (!done) {
            done = true
            res(true)
          }
        }, 400)
        sock.once('close', () => {
          if (!done) {
            done = true
            clearTimeout(t)
            res(false)
          }
        })
        sock.once('error', () => {
          if (!done) {
            done = true
            clearTimeout(t)
            res(false)
          }
        })
      })
      if (alive) return resolve(sock)
      sock.destroy()
      setTimeout(() => attempt(n - 1), 200)
    }
    attempt(tries)
  })
}

function cleanupSession(s: Session, err?: string) {
  if (s.stopped) return
  s.stopped = true
  try {
    s.proc.kill('SIGTERM')
  } catch {
    /* 忽略 */
  }
  s.video?.destroy()
  s.ctrl?.destroy()
  adb(['-s', s.serial, 'forward', '--remove', `tcp:${s.port}`]).catch(() => {})
  sessions.delete(s.serial)
  log('warn', `镜像停止：${s.serial}${err ? `（${err}）` : ''}`)
  emit({ t: 'status', serial: s.serial, on: false, err })
}

// ---- video 流解析（常驻缓冲状态机）----
function feedVideo(s: Session) {
  for (;;) {
    if (s.phase === 'meta') {
      if (s.vlen < 12) return
      const all = concatTake(s, 12)
      const codec = all.readUInt32BE(0)
      const codecStr = String.fromCharCode((codec >> 24) & 255, (codec >> 16) & 255, (codec >> 8) & 255, codec & 255)
      if (codecStr !== 'h264') {
        cleanupSession(s, `不支持的编码：${codecStr}`)
        return
      }
      const w = all.readUInt32BE(4)
      const h = all.readUInt32BE(8)
      emit({ t: 'meta', serial: s.serial, videoW: w, videoH: h, displayW: s.displayW, displayH: s.displayH })
      s.phase = 'hdr'
    } else if (s.phase === 'hdr') {
      if (s.vlen < 12) return
      const all = concatTake(s, 12)
      const flags = all.readBigUInt64BE(0)
      s.hdrFlags = flags
      s.need = all.readUInt32BE(8)
      s.phase = 'payload'
    } else {
      if (s.vlen < s.need) return
      const payload = concatTake(s, s.need)
      const config = !!(s.hdrFlags & (1n << 63n))
      const key = !!(s.hdrFlags & (1n << 62n))
      if (config) emit({ t: 'cfg', serial: s.serial, buf: payload })
      else if (s.need > 0) emit({ t: 'f', serial: s.serial, key, buf: payload })
      s.phase = 'hdr'
    }
  }
}

function concatTake(s: Session, n: number): Buffer {
  const all = Buffer.concat(s.vbuf)
  const out = all.subarray(0, n)
  const rest = all.subarray(n)
  s.vbuf = rest.length ? [rest] : []
  s.vlen = rest.length
  return out
}

// ---- control 消息序列化（大端，见 ControlMessageReader.java v2.4）----
function serializeCtrl(m: CtrlMsg): Buffer {
  if (m.t === 'touch') {
    // TYPE_INJECT_TOUCH_EVENT=2，payload 31B：action u8, pointerId i64, x u32, y u32,
    // w u16, h u16, pressure u16(定点 0xFFFF=1.0), actionButton u32, buttons u32
    const b = Buffer.alloc(32)
    b.writeUInt8(2, 0)
    b.writeUInt8(m.action, 1)
    b.writeBigInt64BE(-1n, 2) // POINTER_ID_MOUSE
    b.writeUInt32BE(m.x >>> 0, 10)
    b.writeUInt32BE(m.y >>> 0, 14)
    b.writeUInt16BE(Math.min(m.w, 0xffff), 18)
    b.writeUInt16BE(Math.min(m.h, 0xffff), 20)
    b.writeUInt16BE(Math.max(0, Math.min(0xffff, Math.round(m.pressure * 0xffff))), 22)
    b.writeUInt32BE(m.actionButton >>> 0, 24)
    b.writeUInt32BE(m.buttons >>> 0, 28)
    return b
  }
  if (m.t === 'key') {
    // TYPE_INJECT_KEYCODE=0，payload 13B：action u8, keycode i32, repeat i32, metaState i32
    const b = Buffer.alloc(14)
    b.writeUInt8(0, 0)
    b.writeUInt8(m.action, 1)
    b.writeInt32BE(m.keycode | 0, 2)
    b.writeInt32BE(m.repeat | 0, 6)
    b.writeInt32BE(m.metaState | 0, 10)
    return b
  }
  // TYPE_INJECT_SCROLL_EVENT=3，payload 20B：x u32, y u32, w u16, h u16, hScroll i16(定点), vScroll i16, buttons u32
  const b = Buffer.alloc(21)
  b.writeUInt8(3, 0)
  b.writeUInt32BE(m.x >>> 0, 1)
  b.writeUInt32BE(m.y >>> 0, 5)
  b.writeUInt16BE(Math.min(m.w, 0xffff), 9)
  b.writeUInt16BE(Math.min(m.h, 0xffff), 11)
  const clamp16 = (v: number) => Math.max(-1, Math.min(1, v))
  b.writeInt16BE(Math.round(clamp16(m.hScroll) * 0x7fff), 13)
  b.writeInt16BE(Math.round(clamp16(m.vScroll) * 0x7fff), 15)
  b.writeUInt32BE(m.buttons >>> 0, 17)
  return b
}

function sendCtrlRaw(s: Session, buf: Buffer) {
  if (s.ctrl && !s.ctrl.destroyed) {
    s.ctrl.write(buf)
  } else {
    // control socket 尚未就绪：排队（上限防膨胀）
    if (s.ctrlQueue.length < 64) s.ctrlQueue.push(buf)
  }
}

// ---- 对外 API ----
export interface LiveOpts {
  maxSize?: number
  bitRate?: number
  maxFps?: number
  videoEncoder?: string
}

export async function startLive(serial: string, opts: LiveOpts = {}): Promise<boolean> {
  const old = sessions.get(serial)
  if (old) cleanupSession(old)

  const jar = serverJarPath()
  const maxSize = opts.maxSize ?? 1600
  const bitRate = opts.bitRate ?? 8_000_000
  const maxFps = opts.maxFps ?? 60

  const disp = await displaySize(serial)
  log('info', `开始实时镜像：${serial}（屏幕 ${disp.w}x${disp.h}）`)

  // 1. push server jar
  await adb(['-s', serial, 'push', jar, DEV_JAR])

  // 2. forward（tcp:0 由 adb 分配端口，输出即端口号）
  const scid = (Date.now() % 0x7fffffff).toString(16)
  const sockName = `localabstract:scrcpy_${scid}`
  const fwdOut = (await adb(['-s', serial, 'forward', 'tcp:0', sockName])).trim()
  let port = parseInt(fwdOut, 10)
  if (!port || Number.isNaN(port)) {
    // 兜底：从 forward --list 解析
    const list = await adb(['-s', serial, 'forward', '--list'])
    const line = list.split('\n').find((l) => l.includes(sockName))
    port = line ? parseInt(line.trim().split(/\s+/)[1].replace('tcp:', ''), 10) : 0
  }
  if (!port) throw new Error('adb forward 分配端口失败')

  // 3. spawn server
  const args = [
    'log_level=warn',
    `max_size=${maxSize}`,
    `video_bit_rate=${bitRate}`,
    `max_fps=${maxFps}`,
    'audio=false',
    'tunnel_forward=true',
    'cleanup=false',
    'send_dummy_byte=false',
    'send_device_meta=false',
    `scid=${scid}`
  ]
  if (opts.videoEncoder) args.push(`video_encoder=${opts.videoEncoder}`)
  const proc = spawn(adbBin(), [
    '-s',
    serial,
    'shell',
    `CLASSPATH=${DEV_JAR} app_process / com.genymobile.scrcpy.Server ${SERVER_VERSION} ${args.join(' ')} control=true`
  ])
  const session: Session = {
    serial,
    proc,
    port,
    ctrlQueue: [],
    vbuf: [],
    vlen: 0,
    phase: 'meta',
    need: 0,
    hdrFlags: 0n,
    displayW: disp.w,
    displayH: disp.h,
    stopped: false
  }
  sessions.set(serial, session)

  proc.stdout?.on('data', (d: Buffer) => {
    const text = d.toString().trim()
    if (text) log('info', text)
  })
  let injectWarned = false
  proc.stderr?.on('data', (d: Buffer) => {
    const text = d.toString().trim()
    if (!text) return
    log('warn', text)
    // MIUI/HyperOS 需开启「USB 调试（安全设置）」才允许注入输入事件
    if (!injectWarned && text.includes('INJECT_EVENTS')) {
      injectWarned = true
      log(
        'warn',
        '检测到设备拒绝注入输入事件（INJECT_EVENTS）。请在手机「开发者选项 → USB 调试（安全设置）」开启后重试；' +
          '在此之前实时镜像仍可观看，但点击 / 滑动 / 按键不会作用到设备。'
      )
    }
  })
  proc.on('exit', (code) => {
    if (!session.stopped) cleanupSession(session, code ? `server 退出（${code}）` : undefined)
  })

  try {
    // 4. 连 video（conn1）→ 连 control（conn2），都建立后 server 才开始推流
    const video = await connectAlive(port)
    session.video = video
    video.on('data', (d: Buffer) => {
      session.vbuf.push(d)
      session.vlen += d.length
      feedVideo(session)
    })
    video.on('error', (e) => cleanupSession(session, `video: ${e.message}`))
    video.on('close', () => cleanupSession(session))

    const ctrl = await connectAlive(port)
    session.ctrl = ctrl
    ctrl.on('error', (e) => log('warn', `control: ${e.message}`))
    // control socket 有 device message 回传（剪贴板等），读取并丢弃以防缓冲堆积
    ctrl.on('data', () => {})
    if (session.ctrlQueue.length) {
      for (const q of session.ctrlQueue) ctrl.write(q)
      session.ctrlQueue = []
    }

    emit({ t: 'status', serial, on: true })
    log('info', `实时镜像已连接：${serial}`)
    return true
  } catch (e) {
    cleanupSession(session, (e as Error).message)
    throw e
  }
}

export function stopLive(serial: string): boolean {
  const s = sessions.get(serial)
  if (s) cleanupSession(s)
  return !!s
}

export function sendCtrl(serial: string, msg: CtrlMsg): boolean {
  const s = sessions.get(serial)
  if (!s) return false
  sendCtrlRaw(s, serializeCtrl(msg))
  return true
}

export function isLive(serial: string): boolean {
  return sessions.has(serial)
}

export function liveSerials(): string[] {
  return [...sessions.keys()]
}
