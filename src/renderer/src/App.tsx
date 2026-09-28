import { useCallback, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'
import DevicePanel, { Bounds } from './components/DevicePanel'
import ElementPanel from './components/ElementPanel'
import NetworkPanel from './components/NetworkPanel'
import LogConsole from './components/LogConsole'
import SettingsModal from './components/SettingsModal'
import MemoryPanel from './components/MemoryPanel'
import { NetworkProvider } from './context/NetworkContext'
import { DeviceInfo, LogEntry, MirrorFrame, UiNode } from './types'

const MAX_LOGS = 3000

/** 合并历史与实时日志（按 id 去重，保持时序） */
function mergeEntries(a: LogEntry[], b: LogEntry[]): LogEntry[] {
  const map = new Map<number, LogEntry>()
  for (const e of a) map.set(e.id, e)
  for (const e of b) map.set(e.id, e)
  return Array.from(map.values())
    .sort((x, y) => x.id - y.id)
    .slice(-MAX_LOGS)
}

export default function App() {
  const [devices, setDevices] = useState<DeviceInfo[]>([])
  const [frames, setFrames] = useState<Record<string, string>>({})
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [logFollow, setLogFollow] = useState(true)
  const [mirroring, setMirroring] = useState<Record<string, boolean>>({})
  /** Android 实时镜像（scrcpy）运行态，key=serial */
  const [liveMirroring, setLiveMirroring] = useState<Record<string, boolean>>({})
  const [activeDeviceId, setActiveDeviceId] = useState<string | null>(null)
  const [rightTab, setRightTab] = useState<'elements' | 'logs' | 'network' | 'memory'>('elements')
  /** 内存页代数：切设备时 +1 强制重挂 MemoryPanel（清空本地状态） */
  const [memGen, setMemGen] = useState(0)
  const [showSettings, setShowSettings] = useState(false)
  const [overlayBounds, setOverlayBounds] = useState<Bounds | null>(null)
  const [uiTree, setUiTree] = useState<UiNode | null>(null)
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [treeLoading, setTreeLoading] = useState(false)
  const [treeError, setTreeError] = useState<string | null>(null)
  // 检查元素开关（类 Chrome DevTools 的元素选择模式）：默认关，避免无谓地 dump 设备层级
  const [inspectOn, setInspectOn] = useState(() => localStorage.getItem('inspectMode') === '1')
  const autoInspectedRef = useRef<string>('')
  const [mirrorW, setMirrorW] = useState(() => {
    const saved = Number(localStorage.getItem('mirrorPanelWidth'))
    return saved >= 300 ? saved : 430
  })
  const colsRef = useRef<HTMLDivElement>(null)

  // 点击镜像的像素坐标 → 反算设备坐标 → 命中测试视图树最深节点
  // 仅在「检查元素」开关打开时生效（否则画面点击不应触发任何设备交互）
  const handleScreenClick = useCallback(
    (deviceX: number, deviceY: number) => {
      if (!inspectOn) return
      if (!uiTree) return
      const stack = [uiTree]
      let best: UiNode | null = null
      while (stack.length) {
        const n = stack.pop()!
        const b = n.bounds
        if (b && deviceX >= b.x && deviceX <= b.x + b.w && deviceY >= b.y && deviceY <= b.y + b.h) {
          best = n
        }
        stack.push(...n.children)
      }
      if (!best) return
      setSelectedKey(best.key)
      setOverlayBounds(best.bounds ?? null)
    },
    [uiTree, inspectOn]
  )


  useEffect(() => {
    window.api.listDevices().then(setDevices)
  }, [])

  useEffect(() => {
    let alive = true
    // 实时日志
    const offLog = window.api.onLogEntry((e: LogEntry) => {
      setLogs((l) =>
        l.length && l[l.length - 1].id === e.id ? l : [...l.slice(-(MAX_LOGS - 1)), e]
      )
    })
    // 回放启动阶段（订阅之前）已产生的日志
    window.api.logHistory().then((h) => {
      if (alive) setLogs((l) => mergeEntries(h ?? [], l))
    })
    const offFrame = window.api.onMirrorFrame((d: MirrorFrame) =>
      setFrames((f) => ({ ...f, [`${d.platform}:${d.id}`]: d.b64 }))
    )
    const offLive = window.api.onMirrorLive((e) => {
      if (e.t === 'status') {
        setLiveMirroring((m) => ({ ...m, [e.serial]: e.on }))
        if (!e.on && e.err) console.warn('[live-mirror]', e.serial, e.err)
      }
    })
    const offDev = window.api.onDevices((d: DeviceInfo[]) => setDevices(d))
    return () => {
      alive = false
      offLog()
      offFrame()
      offLive()
      offDev()
    }
  }, [])

  const available = devices.filter((d) => d.state === 'booted' || d.state === 'device')
  const activeDevice = available.find((d) => d.id === activeDeviceId) || available[0] || null
  const activeDeviceKey = activeDevice ? `${activeDevice.platform}:${activeDevice.id}` : ''

  // 镜像运行态 / 当前设备 key 的 ref：供「切设备清理」副作用读到最新值
  const mirroringRef = useRef(mirroring)
  const liveMirroringRef = useRef(liveMirroring)
  const activeDevKeyRef = useRef('')
  useEffect(() => {
    mirroringRef.current = mirroring
    liveMirroringRef.current = liveMirroring
  }, [mirroring, liveMirroring])
  useEffect(() => {
    activeDevKeyRef.current = activeDeviceKey
  }, [activeDeviceKey])

  const prevDevKeyRef = useRef<string | null>(null)
  // 切换设备（手动点选或设备掉线自动回落）：
  // 停镜像 + 元素页清空停止捕获 + 日志清空 + （NetworkContext 内）网络抓包停止并清空
  useEffect(() => {
    const prev = prevDevKeyRef.current
    prevDevKeyRef.current = activeDeviceKey
    if (!prev || prev === activeDeviceKey) return
    // 1) 停掉所有进行中的镜像，清帧缓存避免残留旧设备画面
    for (const [key, on] of Object.entries(mirroringRef.current)) {
      if (!on) continue
      const i = key.indexOf(':')
      void window.api.stopMirror(key.slice(0, i) as 'ios' | 'android', key.slice(i + 1)).catch(() => {})
    }
    // 实时镜像按 serial 停止（仅 Android）
    for (const [serial, on] of Object.entries(liveMirroringRef.current)) {
      if (on) void window.api.stopLiveMirror(serial).catch(() => {})
    }
    if (Object.values(mirroringRef.current).some(Boolean)) setMirroring({})
    if (Object.values(liveMirroringRef.current).some(Boolean)) setLiveMirroring({})
    setFrames({})
    setLiveMirroring({})
    // 2) 元素页：清空并停止捕获（在途抓取结果由 inspect 内 devKey 守卫丢弃）
    setUiTree(null)
    setSelectedKey(null)
    setOverlayBounds(null)
    setTreeError(null)
    autoInspectedRef.current = ''
    // 3) 日志页：清空本地与主进程缓冲；日志流随 logDeviceKey 副作用自动切到新设备
    setLogs([])
    void window.api.clearLogs().catch(() => {})
    // 4) 内存页：快照/采样结果属于具体 JS VM，切设备清空避免跨目标对比误导
    void window.api.memClearSnapshots().catch(() => {})
    setMemGen((g) => g + 1)
  }, [activeDeviceKey])

  // ---- 运行日志：跟随设备采集（logcat / simctl log stream）----
  // 不绑定页签：切走也继续采集，回到日志页能看到完整历史
  const logDeviceKey = activeDevice ? `${activeDevice.platform}:${activeDevice.id}` : ''
  const logLive = logFollow && !!activeDevice
  useEffect(() => {
    if (logFollow && activeDevice) {
      window.api.startLog(activeDevice.platform, activeDevice.id, activeDevice.real).catch(() => {})
      return () => {
        window.api.stopLog().catch(() => {})
      }
    }
    window.api.stopLog().catch(() => {})
    return undefined
    // 只跟随设备身份变化，避免 4s 设备轮询导致反复重启日志流
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [logFollow, logDeviceKey])

  const clearLogs = useCallback(async () => {
    await window.api.clearLogs()
    setLogs([])
  }, [])

  const toggleMirror = async (platform: 'ios' | 'android', id: string) => {
    const key = `${platform}:${id}`
    const dev = devices.find((d) => d.id === id && d.platform === platform)
    const real = dev?.real ?? false
    if (mirroring[key]) {
      await window.api.stopMirror(platform, id)
      setMirroring((m) => ({ ...m, [key]: false }))
      // 停止镜像后清掉最后一帧，避免画面残留在面板上
      setFrames((f) => {
        if (!(key in f)) return f
        const next = { ...f }
        delete next[key]
        return next
      })
    } else {
      await window.api.startMirror(platform, id, real)
      setMirroring((m) => ({ ...m, [key]: true }))
    }
  }

  const toggleLiveMirror = async (serial: string) => {
    if (liveMirroring[serial]) {
      await window.api.stopLiveMirror(serial).catch(() => {})
      setLiveMirroring((m) => ({ ...m, [serial]: false }))
    } else {
      try {
        await window.api.startLiveMirror(serial)
        setLiveMirroring((m) => ({ ...m, [serial]: true }))
      } catch (e) {
        console.error('[live-mirror] 启动失败', e)
      }
    }
  }

  const onLiveStatus = (serial: string, on: boolean, err?: string) => {
    setLiveMirroring((m) => ({ ...m, [serial]: on }))
    if (err) console.warn('[live-mirror]', serial, err)
  }

  const onSelectedNodeChange = useCallback((n: UiNode | null) => {
    setSelectedKey(n?.key ?? null)
    setOverlayBounds(n?.bounds ?? null)
  }, [])

  // 抓取视图树（上提到 App，供「切 tab / 切设备」自动触发）
  const inspect = useCallback(async () => {
    if (!activeDevice) return
    const devKey = `${activeDevice.platform}:${activeDevice.id}`
    setTreeLoading(true)
    setTreeError(null)
    const res = await window.api.inspectElements(activeDevice.platform, activeDevice.id)
    // 抓取期间已切换设备：丢弃结果，避免旧设备的层级污染新设备
    if (activeDevKeyRef.current !== devKey) {
      setTreeLoading(false)
      return
    }
    if ('error' in res) {
      setTreeError((res as { error: string }).error)
      setUiTree(null)
      setSelectedKey(null)
      setOverlayBounds(null)
    } else {
      setUiTree(res)
      setSelectedKey(null)
      setOverlayBounds(null)
    }
    setTreeLoading(false)
  }, [activeDevice])

  // 自动抓取：仅在「检查元素」开启 + 切到元素 tab + 该设备本次会话还没试过时抓一次。
  // 用 autoInspectedRef 记录已尝试的设备，避免抓取失败（如 iOS 不支持）时无限重试、
  // 反复在设备上跑 uiautomator dump 把手机压死。
  useEffect(() => {
    if (!inspectOn || rightTab !== 'elements' || !activeDevice) return
    if (uiTree || treeLoading) return
    const key = `${activeDevice.platform}:${activeDevice.id}`
    if (autoInspectedRef.current === key) return
    autoInspectedRef.current = key
    inspect()
  }, [inspectOn, rightTab, activeDevice, uiTree, treeLoading, inspect])

  // 检查元素开关：开启 = 开一次新的检查会话（重新抓层级）；关闭 = 清选中与高亮
  const toggleInspect = useCallback((next?: boolean) => {
    setSelectedKey(null)
    setOverlayBounds(null)
    setInspectOn((v) => {
      const nv = next ?? !v
      if (nv) {
        autoInspectedRef.current = ''
        setUiTree(null)
        setTreeError(null)
      }
      return nv
    })
  }, [])

  useEffect(() => localStorage.setItem('inspectMode', inspectOn ? '1' : '0'), [inspectOn])

  const switchRightTab = (t: 'elements' | 'logs' | 'network') => {
    setRightTab(t)
    if (t !== 'elements') setOverlayBounds(null)
  }

  const selectDevice = (id: string) => {
    setActiveDeviceId(id)
    setOverlayBounds(null)
    setSelectedKey(null)
    setUiTree(null)
    setTreeError(null)
  }

  // ---- 设备镜像面板宽度拖拽 ----
  const resetMirrorWidth = () => {
    setMirrorW(430)
    localStorage.setItem('mirrorPanelWidth', '430')
  }

  const startSplitDrag = (e: ReactMouseEvent) => {
    e.preventDefault()
    const cols = colsRef.current
    if (!cols) return
    const startX = e.clientX
    const startW = mirrorW
    const total = cols.clientWidth
    const maxW = Math.max(360, total - 440)
    let latest = startW

    const onMove = (ev: MouseEvent) => {
      latest = Math.min(Math.max(startW + (ev.clientX - startX), 300), maxW)
      setMirrorW(latest)
    }
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      document.body.classList.remove('col-resizing')
      localStorage.setItem('mirrorPanelWidth', String(Math.round(latest)))
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    document.body.classList.add('col-resizing')
  }

  return (
    <div className="app">
      <div className="main">
        <NetworkProvider activeDevice={activeDevice} devices={devices}>
          <div className="columns" ref={colsRef}>
            <div className="col-mirror" style={{ width: mirrorW }}>
              <DevicePanel
                title="设备镜像"
                devices={devices}
                activeDevice={activeDevice}
                onSelectDevice={selectDevice}
                mirroring={mirroring}
                frames={frames}
                liveMirroring={liveMirroring}
                overlayBounds={inspectOn ? overlayBounds : null}
                inspectOn={inspectOn}
                onToggleMirror={toggleMirror}
                onToggleLiveMirror={toggleLiveMirror}
                onLiveStatus={onLiveStatus}
                onScreenClick={handleScreenClick}
              />
            </div>
            <div
              className="splitter"
              onMouseDown={startSplitDrag}
              onDoubleClick={resetMirrorWidth}
              title="拖动调整宽度 · 双击复位"
            />
            <section className="right-panel">
              <div className="rp-head">
                <div className="tabs">
                  <button
                    className={`tab ${rightTab === 'elements' ? 'on' : ''}`}
                    onClick={() => switchRightTab('elements')}
                  >
                    元素
                  </button>
                  <button
                    className={`tab ${rightTab === 'logs' ? 'on' : ''}`}
                    onClick={() => switchRightTab('logs')}
                  >
                    日志
                  </button>
                  <button
                    className={`tab ${rightTab === 'network' ? 'on' : ''}`}
                    onClick={() => switchRightTab('network')}
                  >
                    网络
                  </button>
                  <button
                    className={`tab ${rightTab === 'memory' ? 'on' : ''}`}
                    onClick={() => switchRightTab('memory')}
                  >
                    内存
                  </button>
                </div>
                <button
                  className="rp-gear"
                  onClick={() => setShowSettings(true)}
                  title="网络抓包设置（抓包方式 / 端口 / MITM / 应用识别）"
                >
                  ⚙
                </button>
              </div>
              <div className={`rp-content ${rightTab === 'elements' ? 'show' : 'hide'}`}>
                <ElementPanel
                  tree={uiTree}
                  selectedKey={selectedKey}
                  onSelectKey={setSelectedKey}
                  onSelectedNodeChange={onSelectedNodeChange}
                  deviceName={activeDevice?.name}
                  loading={treeLoading}
                  error={treeError}
                  inspectOn={inspectOn}
                  onToggleInspect={toggleInspect}
                  onRefresh={inspect}
                />
              </div>
              <div className={`rp-content ${rightTab === 'logs' ? 'show' : 'hide'}`}>
                <LogConsole
                  entries={logs}
                  following={logLive}
                  deviceLabel={activeDevice?.name}
                  onToggleFollow={() => setLogFollow((v) => !v)}
                  onClear={clearLogs}
                />
              </div>
              <div className={`rp-content ${rightTab === 'network' ? 'show' : 'hide'}`}>
                <NetworkPanel activeDevice={activeDevice} devices={devices} />
              </div>
              <div className={`rp-content ${rightTab === 'memory' ? 'show' : 'hide'}`}>
                <MemoryPanel key={memGen} />
              </div>
            </section>
          </div>
          {showSettings && (
            <SettingsModal deviceLabel={activeDevice?.name} onClose={() => setShowSettings(false)} />
          )}
        </NetworkProvider>
      </div>
    </div>
  )
}
