import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { DeviceInfo, NetEntry, DevTarget, DevStatus, NetMode, AppStats, NetworkInfo } from '../types'

interface NetworkSettings {
  /** 抓包方式：devtools=RN DevTools 式注入（免证书）/ proxy=本地代理 + MITM */
  mode: NetMode
  /** Metro / RN 打包器端口（devtools 模式用） */
  metroPort: number
  /** 抓取响应体（devtools 模式，单条最多 20KB） */
  bodyCapture: boolean
  /** MITM 解密 HTTPS（proxy 模式，需设备信任 CA 证书） */
  mitm: boolean
  /** 应用识别：用 adb 反查设备端口归属的应用（proxy 模式，仅 Android） */
  appDetect: boolean
}

const LS = {
  mode: 'np-mode',
  metro: 'np-metro',
  body: 'np-body',
  mitm: 'np-mitm',
  app: 'np-appdetect'
}

function loadSettings(): NetworkSettings {
  return {
    mode: (localStorage.getItem(LS.mode) as NetMode) || 'devtools',
    metroPort: Number(localStorage.getItem(LS.metro) || 8081),
    bodyCapture: localStorage.getItem(LS.body) !== '0',
    mitm: localStorage.getItem(LS.mitm) === '1',
    appDetect: localStorage.getItem(LS.app) !== '0'
  }
}

/** 首连失败提示：inspector 首次握手常有时序失败，随后自动重连即可恢复 */
const CONNECT_FAIL = '未能连接到调试目标，请确认 App 已启动且为 Debug 包'

interface NetworkContextValue {
  settings: NetworkSettings
  setSetting: <K extends keyof NetworkSettings>(k: K, v: NetworkSettings[K]) => void
  // 运行时
  entries: NetEntry[]
  devStatus: DevStatus | null
  targets: DevTarget[]
  targetId: string | null
  info: NetworkInfo | null
  proxyMsg: string | null
  appStats: AppStats | null
  devMsg: string | null
  devBusy: boolean
  /** proxy 模式下用于设代理 / 推 CA 的 Android 设备（优先当前镜像设备） */
  androidDev: DeviceInfo | null
  // 当前抓包方式下的「运行中」状态与按钮文案
  running: boolean
  captureLabel: string
  captureDisabled: boolean
  // 动作
  toggleCapture: () => void
  clear: () => void
  setProxy: () => void
  clearProxy: () => void
  pushCa: () => void
  openCa: () => void
  reinject: () => void
  reloadApp: () => void
}

const Ctx = createContext<NetworkContextValue | null>(null)

export function useNetwork(): NetworkContextValue {
  const v = useContext(Ctx)
  if (!v) throw new Error('useNetwork 必须在 NetworkProvider 内使用')
  return v
}

export function NetworkProvider({
  activeDevice,
  devices,
  children
}: {
  activeDevice: DeviceInfo | null
  devices: DeviceInfo[]
  children: ReactNode
}) {
  const [settings, setSettingsState] = useState<NetworkSettings>(loadSettings)
  const [entries, setEntries] = useState<NetEntry[]>([])
  const [info, setInfo] = useState<NetworkInfo | null>(null)
  const [targets, setTargets] = useState<DevTarget[]>([])
  const [targetId, setTargetId] = useState<string | null>(null)
  const [devStatus, setDevStatus] = useState<DevStatus | null>(null)
  const [devMsg, setDevMsg] = useState<string | null>(null)
  const [devBusy, setDevBusy] = useState(false)
  const [proxyRunning, setProxyRunning] = useState(true)
  const [proxyMsg, setProxyMsg] = useState<string | null>(null)
  const [appStats, setAppStats] = useState<AppStats | null>(null)

  const { mode, metroPort, bodyCapture, mitm, appDetect } = settings

  const setSetting = <K extends keyof NetworkSettings>(k: K, v: NetworkSettings[K]) => {
    setSettingsState((s) => {
      const next = { ...s, [k]: v }
      switch (k) {
        case 'mode':
          localStorage.setItem(LS.mode, next.mode)
          break
        case 'metroPort':
          localStorage.setItem(LS.metro, String(next.metroPort))
          break
        case 'bodyCapture':
          localStorage.setItem(LS.body, next.bodyCapture ? '1' : '0')
          break
        case 'mitm':
          localStorage.setItem(LS.mitm, next.mitm ? '1' : '0')
          break
        case 'appDetect':
          localStorage.setItem(LS.app, next.appDetect ? '1' : '0')
          break
      }
      return next
    })
  }

  // 应用识别目标设备：优先当前镜像设备，否则取第一个已连接 Android 设备（与镜像面板对齐）
  const androidDev =
    activeDevice?.platform === 'android'
      ? activeDevice
      : devices.find((d) => d.platform === 'android' && (d.state === 'device' || d.state === 'booted')) ?? null
  const appSerial = appDetect && androidDev ? androidDev.id : null

  // 初始加载 + 订阅网络条目
  useEffect(() => {
    window.api.listNetwork().then(setEntries)
    window.api.networkInfo().then(setInfo)
    const off = window.api.onNetwork((e: NetEntry) => {
      setEntries((prev) => {
        const idx = prev.findIndex((x) => x.id === e.id)
        if (idx >= 0) {
          const next = prev.slice()
          next[idx] = e
          return next
        }
        return [e, ...prev]
      })
    })
    return off
  }, [])

  // DevTools 连接状态订阅
  useEffect(() => {
    const sync = (s: DevStatus) => {
      setDevStatus(s)
      if (s.attached) setDevMsg((m) => (m === CONNECT_FAIL ? null : m))
    }
    window.api.devStatus().then(sync)
    return window.api.onNetworkStatus(sync)
  }, [])

  // 应用识别：把设备交给主进程做「端口→uid→包名」反查
  useEffect(() => {
    window.api.setNetworkDevice(appSerial).then(setAppStats)
    if (!appSerial) return
    const t = setInterval(() => window.api.networkAppStats().then(setAppStats), 3000)
    return () => clearInterval(t)
  }, [appSerial])

  // 切换设备：停止抓包（devtools 注入 + proxy 代理）并清空条目。
  // 抓包会话跟随设备，旧设备的请求数据不应带到新设备视图里。
  const devKey = activeDevice ? `${activeDevice.platform}:${activeDevice.id}` : ''
  const prevNetDevRef = useRef<string | null>(null)
  useEffect(() => {
    const prev = prevNetDevRef.current
    prevNetDevRef.current = devKey
    if (!prev || prev === devKey) return
    // 先停干净（串行），再清空，避免 proxy 停止前的尾巴请求在清空后又进列表
    void (async () => {
      await window.api.devStop().catch(() => {})
      await window.api.stopNetwork().catch(() => {})
      setProxyRunning(false)
      setDevStatus(null)
      setDevMsg(null)
      // 调试目标跟着设备走：不重置的话 targetId 仍指向旧设备（如 iOS），
      // 下次「开始抓包」会连回旧设备
      setTargetId(null)
      setTargets([])
      await window.api
        .clearNetwork()
        .then(() => setEntries([]))
        .catch(() => setEntries([]))
    })()
  }, [devKey])

  // 设置实时生效：MITM（proxy 模式）——挂载即对齐一次
  useEffect(() => {
    window.api.setMitm(mitm)
  }, [mitm])

  // 设置实时生效：响应体抓取（devtools，运行中才下发）
  useEffect(() => {
    if (devStatus?.running) window.api.devBody(bodyCapture)
  }, [bodyCapture, devStatus?.running])

  // 设置实时生效：切到 proxy 且 devtools 在跑则停掉注入
  useEffect(() => {
    if (mode === 'proxy' && devStatus?.running) {
      window.api.devStop()
      setDevMsg(null)
    }
  }, [mode, devStatus?.running])

  // DevTools 模式：轮询 Metro 上的可调试目标（未连接时刷新更勤，App 一启动即可选中）
  // 目标平台优先跟随当前镜像设备：设备切到 Android 后不能再沿用 iOS 的调试目标
  const pickTarget = (list: DevTarget[], cur: string | null): string | null => {
    const pref = activeDevice?.platform
    const matches = (t: DevTarget) => (pref ? (pref === 'ios') === /iphone|ipad/i.test(t.deviceName) : true)
    const curT = cur ? list.find((t) => t.id === cur) : undefined
    // 当前目标与镜像设备同平台 → 保留；平台不符则优先切到同平台目标
    if (curT && matches(curT)) return cur
    const sameOs = pref ? list.find(matches) : undefined
    return (sameOs ?? curT ?? list[0])?.id ?? null
  }
  useEffect(() => {
    if (mode !== 'devtools') return
    let alive = true
    const tick = async () => {
      const list = await window.api.devTargets(metroPort)
      if (!alive) return
      setTargets(list)
      setTargetId((cur) => pickTarget(list, cur))
    }
    void tick()
    const t = setInterval(tick, devStatus?.attached ? 6000 : 3000)
    return () => {
      alive = false
      clearInterval(t)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, metroPort, devStatus?.attached, activeDevice?.id, activeDevice?.platform])

  // ---- 动作 ----
  const toggleCapture = async () => {
    if (mode === 'devtools') {
      if (devStatus?.running) {
        await window.api.devStop()
        setDevMsg(null)
      } else {
        setDevBusy(true)
        const s = await window.api.devStart(targetId, metroPort)
        setDevStatus(s)
        setDevBusy(false)
        setDevMsg(s.attached ? null : s.error || CONNECT_FAIL)
      }
    } else {
      if (proxyRunning) {
        await window.api.stopNetwork()
        setProxyRunning(false)
      } else {
        await window.api.startNetwork()
        setProxyRunning(true)
        window.api.networkInfo().then(setInfo)
      }
    }
  }
  const clear = async () => {
    await window.api.clearNetwork()
    setEntries([])
  }
  const setProxy = async () => {
    if (!androidDev) return
    const p = await window.api.setDeviceProxy(androidDev.id)
    setProxyMsg(`已为 ${androidDev.name} 设置代理 ${p}`)
  }
  const clearProxy = async () => {
    if (!androidDev) return
    await window.api.clearDeviceProxy(androidDev.id)
    setProxyMsg(`已清除 ${androidDev.name} 的代理设置`)
  }
  const pushCa = async () => {
    if (!androidDev) return
    const dst = await window.api.pushCa(androidDev.id)
    setProxyMsg(`CA 已推送到设备 ${dst}，请在「设置→安全→加密与凭据→安装证书」中安装并信任`)
  }
  const openCa = () => window.api.openCa()
  const reinject = async () => {
    await window.api.devReinject()
    setDevMsg('已请求重新注入拦截器')
  }
  const reloadApp = async () => {
    const ok = await window.api.devReload()
    setDevMsg(
      ok
        ? '已触发 App 重载：拦截器会立刻抢装，App 启动期的请求也会被记录下来'
        : '重载失败：尚未连接到调试目标'
    )
  }

  const running = mode === 'devtools' ? !!devStatus?.running : proxyRunning
  const captureLabel = devBusy ? '连接中…' : running ? '停止抓包' : '开始抓包'
  const captureDisabled = mode === 'devtools' && devBusy

  const value: NetworkContextValue = {
    settings,
    setSetting,
    entries,
    devStatus,
    targets,
    targetId,
    info,
    proxyMsg,
    appStats,
    devMsg,
    devBusy,
    androidDev,
    running,
    captureLabel,
    captureDisabled,
    toggleCapture,
    clear,
    setProxy,
    clearProxy,
    pushCa,
    openCa,
    reinject,
    reloadApp
  }

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}
