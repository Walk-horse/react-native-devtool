import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { DeviceInfo } from '../types'
import { ScrcpyPlayer, videoToDevice, deviceBoundsToVideo, subscribeLive, lastLiveMeta, lastLiveCfg, type LiveMetaInfo } from '../lib/scrcpyPlayer'

export interface Bounds {
  x: number
  y: number
  w: number
  h: number
}

interface Props {
  title: string
  devices: DeviceInfo[]
  activeDevice: DeviceInfo | null
  onSelectDevice: (id: string) => void
  mirroring: Record<string, boolean>
  frames: Record<string, string>
  /** Android 实时镜像（scrcpy）运行态 */
  liveMirroring: Record<string, boolean>
  overlayBounds: Bounds | null
  /** 检查元素模式：开启后点击画面才做命中定位 */
  inspectOn: boolean
  onToggleMirror: (p: 'ios' | 'android', id: string) => void
  onToggleLiveMirror: (id: string) => void
  onLiveStatus: (serial: string, on: boolean, err?: string) => void
  onScreenClick: (deviceX: number, deviceY: number) => void
}

export default function DevicePanel({
  title,
  devices,
  activeDevice,
  onSelectDevice,
  mirroring,
  frames,
  liveMirroring,
  overlayBounds,
  inspectOn,
  onToggleMirror,
  onToggleLiveMirror,
  onLiveStatus,
  onScreenClick
}: Props) {
  const active = activeDevice
  const key = active ? `${active.platform}:${active.id}` : undefined
  const frame = key ? frames[key] : undefined
  const isMirroring = key ? mirroring[key] : false
  // 实时镜像状态按 serial 存（status 事件只带 serial），仅 Android 有效
  const isLive = active?.platform === 'android' ? !!liveMirroring[active.id] : false
  const platform = active?.platform ?? 'ios'

  const available = devices.filter((d) => d.state === 'booted' || d.state === 'device')

  const [overlay, setOverlay] = useState<{ left: number; top: number; width: number; height: number } | null>(null)
  const [imgReady, setImgReady] = useState(false)
  const imgRef = useRef<HTMLImageElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const playerRef = useRef<ScrcpyPlayer | null>(null)
  const [liveMeta, setLiveMeta] = useState<LiveMetaInfo | null>(null)

  // ---- scrcpy 实时镜像：解码播放器 + 事件订阅 ----
  useEffect(() => {
    const player = new ScrcpyPlayer()
    player.onError = (msg) => onLiveStatus('', false, msg)
    playerRef.current = player
    const off = subscribeLive((e) => {
      if (e.t === 'meta') setLiveMeta({ videoW: e.videoW, videoH: e.videoH, displayW: e.displayW, displayH: e.displayH })
      if (e.t === 'status') {
        if (!e.on && e.serial) onLiveStatus(e.serial, false, e.err)
        if (!e.on) setLiveMeta(null)
      }
      player.handle(e)
    })
    return () => {
      off()
      player.destroy()
      playerRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 目标设备/画布变化时重新绑定播放器；attach 后回放缓存的一次性 meta/cfg（防竞态丢失）
  useEffect(() => {
    const serial = isLive && active?.platform === 'android' ? active.id : null
    const player = playerRef.current
    if (!player) return
    player.attach(serial, canvasRef.current)
    if (serial) {
      const m = lastLiveMeta()
      if (m && m.serial === serial) player.handle(m)
      const c = lastLiveCfg()
      if (c && c.serial === serial) player.handle(c)
    }
  }, [isLive, active?.id, active?.platform])

  // ---- 截图镜像：bounds → img 叠加矩形 ----
  useLayoutEffect(() => {
    const recompute = () => {
      const img = imgRef.current
      if (!img || !overlayBounds || !frame || !imgReady || isLive) {
        if (!isLive) setOverlay(null)
        return
      }
      const natW = img.naturalWidth
      const natH = img.naturalHeight
      const cw = img.clientWidth
      const ch = img.clientHeight
      if (!natW || !natH || !cw || !ch) {
        setOverlay(null)
        return
      }
      const sx = cw / natW
      const sy = ch / natH
      const b = overlayBounds
      setOverlay({
        left: img.offsetLeft + b.x * sx,
        top: img.offsetTop + b.y * sy,
        width: b.w * sx,
        height: b.h * sy
      })
    }
    recompute()
    window.addEventListener('resize', recompute)
    const img = imgRef.current
    const ro = img ? new ResizeObserver(recompute) : null
    if (img && ro) ro.observe(img)
    return () => {
      window.removeEventListener('resize', recompute)
      ro?.disconnect()
    }
  }, [overlayBounds, frame, imgReady, isLive])

  // ---- 实时镜像：bounds → canvas 叠加矩形（设备坐标经旋转修正映射到视频）----
  useLayoutEffect(() => {
    const recompute = () => {
      const canvas = canvasRef.current
      const player = playerRef.current
      if (!canvas || !player || !overlayBounds || !isLive || !liveMeta) {
        setOverlay(null)
        return
      }
      const cw = canvas.clientWidth
      const ch = canvas.clientHeight
      if (!cw || !ch) {
        setOverlay(null)
        return
      }
      const r = deviceBoundsToVideo(overlayBounds, liveMeta, player.frameW, player.frameH, cw, ch, canvas.offsetLeft, canvas.offsetTop)
      setOverlay(r)
    }
    recompute()
    window.addEventListener('resize', recompute)
    const canvas = canvasRef.current
    const ro = canvas ? new ResizeObserver(recompute) : null
    if (canvas && ro) ro.observe(canvas)
    return () => {
      window.removeEventListener('resize', recompute)
      ro?.disconnect()
    }
  }, [overlayBounds, isLive, liveMeta])

  // ---- 触控注入（实时镜像且非检查模式）----
  const draggingRef = useRef(false)
  const lastMoveRef = useRef(0)

  const videoCoords = (e: { clientX: number; clientY: number }) => {
    const canvas = canvasRef.current
    if (!canvas) return null
    const rect = canvas.getBoundingClientRect()
    return {
      x: Math.round(((e.clientX - rect.left) * canvas.width) / rect.width),
      y: Math.round(((e.clientY - rect.top) * canvas.height) / rect.height),
      w: canvas.width,
      h: canvas.height,
      rect
    }
  }

  const sendTouch = (action: number, c: { x: number; y: number; w: number; h: number }, pressure: number) => {
    if (!active) return
    void window.api.sendMirrorCtrl(active.id, {
      t: 'touch',
      action,
      x: c.x,
      y: c.y,
      w: c.w,
      h: c.h,
      pressure,
      actionButton: action === 0 ? 1 : 0,
      buttons: action === 1 ? 0 : pressure > 0 ? 1 : 0
    })
  }

  const onCanvasPointerDown = (e: React.PointerEvent) => {
    if (!isLive || inspectOn) return
    const c = videoCoords(e)
    if (!c) return
    draggingRef.current = true
    e.currentTarget.setPointerCapture(e.pointerId)
    sendTouch(0, c, 1)
  }
  const onCanvasPointerMove = (e: React.PointerEvent) => {
    if (!isLive || inspectOn || !draggingRef.current) return
    const now = performance.now()
    if (now - lastMoveRef.current < 33) return // ~30/s 节流
    lastMoveRef.current = now
    const c = videoCoords(e)
    if (c) sendTouch(2, c, 1)
  }
  const onCanvasPointerUp = (e: React.PointerEvent) => {
    if (!isLive || inspectOn || !draggingRef.current) return
    draggingRef.current = false
    const c = videoCoords(e)
    if (c) sendTouch(1, c, 0)
  }

  // 滚轮：scrcpy vScroll 正值 = 内容上滚；wheel 向下（deltaY>0）→ 内容下滚 → -1
  const onCanvasWheel = (e: React.WheelEvent) => {
    if (!isLive || inspectOn) return
    e.preventDefault()
    const c = videoCoords(e)
    if (!c || !active) return
    void window.api.sendMirrorCtrl(active.id, {
      t: 'scroll',
      x: c.x,
      y: c.y,
      w: c.w,
      h: c.h,
      hScroll: 0,
      vScroll: e.deltaY > 0 ? -1 : 1,
      buttons: 0
    })
  }

  // 实时镜像下的点击 = 注入触控（交互）；检查模式下 = 命中元素（不注入）
  const onCanvasClick = (e: React.MouseEvent) => {
    if (!isLive || !inspectOn) return
    const c = videoCoords(e)
    const player = playerRef.current
    if (!c || !player?.meta) return
    const dev = videoToDevice(c.x, c.y, player.meta, player.frameW, player.frameH)
    onScreenClick(dev.x, dev.y)
  }

  const sendBack = () => {
    if (!active) return
    void window.api.sendMirrorCtrl(active.id, { t: 'key', action: 0, keycode: 4, repeat: 0, metaState: 0 })
    void window.api.sendMirrorCtrl(active.id, { t: 'key', action: 1, keycode: 4, repeat: 0, metaState: 0 })
  }
  const sendHome = () => {
    if (!active) return
    void window.api.sendMirrorCtrl(active.id, { t: 'key', action: 0, keycode: 3, repeat: 0, metaState: 0 })
    void window.api.sendMirrorCtrl(active.id, { t: 'key', action: 1, keycode: 3, repeat: 0, metaState: 0 })
  }

  return (
    <section className="device-panel">
      <header>
        <h3>{title}</h3>
        {active ? (
          <span className="badge">
            <span className={`plat ${active.platform}`}>{active.platform === 'ios' ? 'iOS' : 'Android'}</span>
            {active.name}
            {active.os ? ` · ${active.os}` : ''}
            {active.real ? ' · 真机' : ''}
          </span>
        ) : (
          <span className="badge warn">无可用设备</span>
        )}
      </header>

      <div className="device-tabs">
        {available.length === 0 ? (
          <span className="dev-none">未检测到运行中的设备</span>
        ) : (
          available.map((d) => (
            <button
              key={d.id}
              className={`dev-chip ${active?.id === d.id ? 'on' : ''} ${d.platform}`}
              onClick={() => onSelectDevice(d.id)}
            >
              <span className="dot" />
              {d.name}
            </button>
          ))
        )}
      </div>

      <div className={`screen ${inspectOn ? 'inspecting' : ''}`}>
        {isLive && active?.platform === 'android' ? (
          <div className="screen-wrap">
            <canvas
              ref={canvasRef}
              className="live-canvas"
              onPointerDown={onCanvasPointerDown}
              onPointerMove={onCanvasPointerMove}
              onPointerUp={onCanvasPointerUp}
              onPointerCancel={onCanvasPointerUp}
              onWheel={onCanvasWheel}
              onClick={onCanvasClick}
              style={{ cursor: inspectOn ? 'crosshair' : 'pointer' }}
            />
            {inspectOn && <div className="screen-inspecting">⌖ 检查中 · 点击画面定位元素</div>}
            {!inspectOn && <div className="screen-hint">实时镜像 · 可直接点击 / 滑动 / 滚轮</div>}
            {overlay && (
              <div
                className="ep-overlay"
                style={{ left: overlay.left, top: overlay.top, width: overlay.width, height: overlay.height }}
              />
            )}
          </div>
        ) : frame ? (
          <div className="screen-wrap">
            <img
              ref={imgRef}
              src={`data:image/png;base64,${frame}`}
              alt="mirror"
              onLoad={() => setImgReady(true)}
              onClick={(e) => {
                if (!inspectOn) return
                const img = imgRef.current
                if (!img) return
                const rect = e.currentTarget.getBoundingClientRect()
                const px = e.clientX - rect.left
                const py = e.clientY - rect.top
                const sx = img.naturalWidth / img.clientWidth
                const sy = img.naturalHeight / img.clientHeight
                onScreenClick(px * sx, py * sy)
              }}
              style={{ cursor: inspectOn ? 'crosshair' : 'default' }}
            />
            {inspectOn && <div className="screen-inspecting">⌖ 检查中 · 点击画面定位元素</div>}
            {overlay && (
              <div
                className="ep-overlay"
                style={{ left: overlay.left, top: overlay.top, width: overlay.width, height: overlay.height }}
              />
            )}
          </div>
        ) : (
          <div className="screen-empty">
            {active
              ? platform === 'android'
                ? '点击「实时镜像」流畅投屏，或「截图镜像」查看静态画面'
                : '点击「开始镜像」查看画面'
              : '用 Xcode 启动 iOS 模拟器，或用 Android Studio 启动模拟器 / 连接真机'}
          </div>
        )}
      </div>

      <div className="controls">
        {active?.platform === 'android' && (
          <button className={`btn ${isLive ? 'primary' : ''}`} disabled={!active} onClick={() => onToggleLiveMirror(active.id)}>
            {isLive ? '停止实时' : '实时镜像'}
          </button>
        )}
        <button className="btn" disabled={!active} onClick={() => active && onToggleMirror(active.platform, active.id)}>
          {isMirroring ? '停止截图' : '截图镜像'}
        </button>
        {isLive && (
          <>
            <button className="btn ghost sm" onClick={sendBack} title="返回键">
              ← 返回
            </button>
            <button className="btn ghost sm" onClick={sendHome} title="Home 键">
              ⌂
            </button>
          </>
        )}
      </div>
    </section>
  )
}
