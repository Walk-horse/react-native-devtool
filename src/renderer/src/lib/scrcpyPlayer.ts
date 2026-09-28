/**
 * scrcpy H.264 流 → WebCodecs 解码 → canvas。
 *
 * 流格式（真机实测）：Annex-B、无 description。首个 config 包 = SPS+PPS，
 * 从 SPS 头 3 字节（profile/constraint/level）拼 codec string 直接 configure。
 * 首 个 key 帧前拼接 config 包，保证解码器拿到参数集。
 */
import type { LiveEvent } from '../types'

export interface LiveMetaInfo {
  videoW: number
  videoH: number
  displayW: number
  displayH: number
}

/* ---- 事件总线：单订阅 + 一次性事件缓存回放 ----
 * meta/cfg 只在流启动时发一次，而播放器 attach 是 paint 后的 passive effect，
 * 直接订阅会丢掉「attach 之前」到达的一次性事件 → 缓存最近一次并在 attach 后回放。 */
type LiveListener = (e: LiveEvent) => void
const liveListeners = new Set<LiveListener>()
let liveSubscribed = false
let lastMetaEvt: Extract<LiveEvent, { t: 'meta' }> | null = null
let lastCfgEvt: Extract<LiveEvent, { t: 'cfg' }> | null = null

function ensureLiveSubscribed() {
  if (liveSubscribed) return
  liveSubscribed = true
  window.api.onMirrorLive((e) => {
    if (e.t === 'meta') lastMetaEvt = e
    if (e.t === 'cfg') lastCfgEvt = e
    for (const fn of liveListeners) fn(e)
  })
}

export function subscribeLive(l: LiveListener): () => void {
  ensureLiveSubscribed()
  liveListeners.add(l)
  return () => {
    liveListeners.delete(l)
  }
}

export function lastLiveMeta() {
  return lastMetaEvt
}
export function lastLiveCfg() {
  return lastCfgEvt
}

export class ScrcpyPlayer {
  private dec: VideoDecoder | null = null
  private cfg: Uint8Array | null = null
  private gotCfg = false
  private failed = false
  private ts = 0
  private serial: string | null = null
  private canvas: HTMLCanvasElement | null = null
  private ctx: CanvasRenderingContext2D | null = null
  /** 最近一帧的实际尺寸（旋转后 videoW/H 会变，以此为准做触控映射） */
  frameW = 0
  frameH = 0
  meta: LiveMetaInfo | null = null
  onError: ((msg: string) => void) | null = null

  constructor() {
    // 调试句柄（仅开发用）
    ;(window as unknown as { __scp?: ScrcpyPlayer }).__scp = this
  }

  attach(serial: string | null, canvas: HTMLCanvasElement | null) {
    if (this.serial !== serial || this.canvas !== canvas) {
      this.reset()
      this.serial = serial
      this.canvas = canvas
      this.ctx = canvas ? canvas.getContext('2d') : null
    }
  }

  destroy() {
    this.reset()
    this.serial = null
    this.canvas = null
    this.ctx = null
  }

  private reset() {
    if (this.dec && this.dec.state !== 'closed') this.dec.close()
    this.dec = null
    this.cfg = null
    this.gotCfg = false
    this.failed = false
    this.meta = null
    this.frameW = 0
    this.frameH = 0
  }

  handle(e: LiveEvent) {
    if (!this.serial || e.serial !== this.serial) return
    switch (e.t) {
      case 'meta':
        this.meta = { videoW: e.videoW, videoH: e.videoH, displayW: e.displayW, displayH: e.displayH }
        if (this.canvas) {
          this.canvas.width = e.videoW
          this.canvas.height = e.videoH
        }
        break
      case 'cfg':
        this.cfg = e.buf
        this.gotCfg = true
        this.ensureDecoder()
        break
      case 'f':
        this.feed(e.key, e.buf)
        break
      case 'status':
        if (!e.on && e.err) this.onError?.(e.err)
        break
    }
  }

  /** 从 config 包提取 SPS → avc1.PPCDLL */
  private codecFromCfg(): string | null {
    const b = this.cfg
    if (!b) return null
    // Annex-B 扫描：找 00 00 00 01 后 NAL 类型 7（SPS）
    for (let i = 0; i + 4 <= b.length; i++) {
      if (b[i] === 0 && b[i + 1] === 0 && b[i + 2] === 0 && b[i + 3] === 1) {
        const nal = b[i + 4]
        if ((nal & 0x1f) === 7 && i + 7 <= b.length) {
          const hex = (v: number) => v.toString(16).padStart(2, '0')
          return `avc1.${hex(b[i + 5])}${hex(b[i + 6])}${hex(b[i + 7])}`
        }
      }
    }
    return null
  }

  private ensureDecoder() {
    if (this.dec || this.failed || !this.cfg || !this.canvas) return
    const codec = this.codecFromCfg()
    if (!codec) return
    const dec = new VideoDecoder({
      output: (vf) => this.draw(vf),
      error: (e) => {
        this.failed = true
        this.onError?.(`WebCodecs 解码失败：${e.message}`)
      }
    })
    try {
      dec.configure({ codec, optimizeForLatency: true })
      this.dec = dec
    } catch (e) {
      this.failed = true
      this.onError?.(`WebCodecs 配置失败（${codec}）：${(e as Error).message}`)
    }
  }

  private feed(key: boolean, buf: Uint8Array) {
    this.ensureDecoder()
    if (!this.dec || this.failed) return
    if (this.dec.state !== 'configured') return
    let data = buf
    // 首个 key 帧前拼参数集，确保解码器拿到 SPS/PPS
    if (key && this.gotCfg && !this.sawKey) {
      const c = new Uint8Array(this.cfg!.length + buf.length)
      c.set(this.cfg!, 0)
      c.set(buf, this.cfg!.length)
      data = c
    }
    if (key) this.sawKey = true
    try {
      this.dec.decode(
        new EncodedVideoChunk({
          type: key ? 'key' : 'delta',
          timestamp: this.ts,
          data
        })
      )
      this.ts += 33333
    } catch {
      /* 单帧失败容忍：丢帧继续 */
    }
  }

  private sawKey = false

  private draw(vf: VideoFrame) {
    const w = vf.displayWidth
    const h = vf.displayHeight
    if (this.canvas && (this.canvas.width !== w || this.canvas.height !== h)) {
      // 旋转 / 尺寸变化：同步画布与元信息
      this.canvas.width = w
      this.canvas.height = h
      if (this.meta) {
        this.meta = { ...this.meta, videoW: w, videoH: h }
      }
    }
    this.frameW = w
    this.frameH = h
    if (this.ctx) {
      try {
        this.ctx.drawImage(vf, 0, 0, w, h)
      } catch {
        /* 帧已关闭等瞬态错误 */
      }
    }
    vf.close()
  }
}

/**
 * 设备坐标换算：视频像素 → 设备物理像素（uiautomator bounds 的坐标系）。
 * 视频方向与屏幕方向不一致（横竖屏旋转）时自动交换显示宽高。
 */
export function videoToDevice(vx: number, vy: number, meta: LiveMetaInfo, frameW: number, frameH: number) {
  const vw = frameW || meta.videoW
  const vh = frameH || meta.videoH
  let dw = meta.displayW
  let dh = meta.displayH
  if (!dw || !dh) return { x: vx, y: vy, w: vw, h: vh }
  if (vw > vh !== dw > dh) {
    ;[dw, dh] = [dh, dw]
  }
  const sx = dw / vw
  const sy = dh / vh
  return { x: vx * sx, y: vy * sy, w: dw, h: dh }
}

/** 设备 bounds → 视频画布 CSS 像素矩形（元素叠加用） */
export function deviceBoundsToVideo(
  b: { x: number; y: number; w: number; h: number },
  meta: LiveMetaInfo,
  frameW: number,
  frameH: number,
  cssW: number,
  cssH: number,
  offsetLeft: number,
  offsetTop: number
) {
  const vw = frameW || meta.videoW
  const vh = frameH || meta.videoH
  let dw = meta.displayW
  let dh = meta.displayH
  if (!dw || !dh) return null
  if (vw > vh !== dw > dh) {
    ;[dw, dh] = [dh, dw]
  }
  // bounds(设备px) → video px ×(vw/dw) → css px ×(cssW/vw)，合并即 cssW/dw
  const sx = cssW / dw
  const sy = cssH / dh
  return {
    left: offsetLeft + b.x * sx,
    top: offsetTop + b.y * sy,
    width: b.w * sx,
    height: b.h * sy
  }
}
