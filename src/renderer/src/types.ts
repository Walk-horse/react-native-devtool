export interface RNProject {
  id: string
  name: string
  path: string
  hasIOS: boolean
  hasAndroid: boolean
  rnVersion?: string
  packageName?: string
}

export interface DeviceInfo {
  platform: 'ios' | 'android'
  id: string
  name: string
  state: 'booted' | 'shutdown' | 'device' | 'offline' | 'unknown'
  os?: string
  avd?: string
  /** 是否为 USB 连接的物理设备（与模拟器区分，截图走不同后端） */
  real?: boolean
}

export interface MirrorFrame {
  platform: string
  id: string
  b64: string
}

/* ---- Android 实时镜像（scrcpy 桥接）---- */
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
  buf: Uint8Array
}
export interface LiveFrameEvt {
  t: 'f'
  serial: string
  key: boolean
  buf: Uint8Array
}
export interface LiveStatusEvt {
  t: 'status'
  serial: string
  on: boolean
  err?: string
}
export type LiveEvent = LiveMetaEvt | LiveCfgEvt | LiveFrameEvt | LiveStatusEvt

export interface CtrlTouch {
  t: 'touch'
  action: number // 0=down 1=up 2=move
  x: number
  y: number
  w: number
  h: number
  pressure: number
  actionButton: number
  buttons: number
}
export interface CtrlKey {
  t: 'key'
  action: number
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
  hScroll: number
  vScroll: number
  buttons: number
}
export type CtrlMsg = CtrlTouch | CtrlKey | CtrlScroll

export interface UiNode {
  key: string
  text?: string
  className?: string
  resourceId?: string
  contentDesc?: string
  clickable?: boolean
  enabled?: boolean
  bounds?: { x: number; y: number; w: number; h: number }
  index?: string
  pkg?: string
  focusable?: boolean
  focused?: boolean
  scrollable?: boolean
  checkable?: boolean
  checked?: boolean
  selected?: boolean
  longClickable?: boolean
  password?: boolean
  children: UiNode[]
}

export interface CodeHit {
  file: string
  line: number
  snippet: string
  score: number
}

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

/** 抓包方式：devtools=RN DevTools 式注入（免证书）/ proxy=本地代理 + MITM */
export type NetMode = 'devtools' | 'proxy'

/** Metro inspector 上可调试的目标（一个 RN 应用一个主 JS 运行时目标） */
export interface DevTarget {
  id: string
  label: string
  appId: string
  deviceName: string
  description: string
  wsUrl: string
  page: string
}

export interface DevStatus {
  running: boolean
  attached: boolean
  hooked: boolean
  targetId: string | null
  metroPort: number
  error: string | null
  lastInject: number
  /** 已建立过的调试通道次数（>1 说明发生过自愈重连） */
  attaches: number
}

export interface NetworkInfo {
  port: number
  lanIp: string
}

/** 应用识别状态（端口→uid→包名） */
export interface AppStats {
  device: string | null
  ports: number
  packages: number
  error: string | null
}

export type LogLevel = 'debug' | 'log' | 'info' | 'warn' | 'error'
/** app=RN 应用 console / metro=打包器 / device=设备日志 / renderer=界面 / main=主进程 / net=抓包代理 */
export type LogSource = 'app' | 'metro' | 'device' | 'renderer' | 'main' | 'net'

export interface LogEntry {
  id: number
  ts: number
  level: LogLevel
  source: LogSource
  tag?: string
  text: string
}

export interface FsEntry {
  name: string
  path: string
  isDir: boolean
}

/* ---- JS 内存 ---- */
export interface MemClassRow {
  name: string
  type: string
  count: number
  selfSize: number
}
export interface MemSnapshotSummary {
  id: string
  ts: number
  target: string
  totalSize: number
  totalCount: number
  byType: { type: string; count: number; size: number }[]
  top: MemClassRow[]
  bytes: number
  parseMs: number
}
export interface MemDiffRow {
  name: string
  countA: number
  countB: number
  sizeA: number
  sizeB: number
  dCount: number
  dSize: number
}
export interface MemSampleSite {
  fn: string
  url: string
  line: number
  selfSize: number
}
export interface MemSampleResult {
  ts: number
  target: string
  intervalMs: number
  totalSize: number
  top: MemSampleSite[]
}
export interface MemProgress {
  phase: string
  bytes?: number
  nodes?: number
}

declare global {
  interface Window {
    api: {
      listProjects: () => Promise<RNProject[]>
      addProject: (p: string) => Promise<RNProject | { error: string }>
      removeProject: (id: string) => Promise<boolean>
      scanProject: (p: string) => Promise<unknown>
      openFolderDialog: () => Promise<string | null>
      listDevices: () => Promise<DeviceInfo[]>
      bootDevice: (platform: 'ios' | 'android', id: string) => Promise<boolean>
      startMirror: (platform: 'ios' | 'android', id: string, real?: boolean) => Promise<boolean>
      stopMirror: (platform: 'ios' | 'android', id: string) => Promise<boolean>
      captureFrame: (platform: 'ios' | 'android', id: string) => Promise<string | null>
      startLiveMirror: (
        id: string,
        opts?: { maxSize?: number; bitRate?: number; maxFps?: number }
      ) => Promise<boolean>
      stopLiveMirror: (id: string) => Promise<boolean>
      sendMirrorCtrl: (id: string, msg: CtrlMsg) => Promise<boolean>
      onMirrorLive: (cb: (e: LiveEvent) => void) => () => void
      inspectElements: (platform: 'ios' | 'android', id: string) => Promise<UiNode | { error: string }>
      locateCode: (
        projectPath: string,
        node: { text?: string; className?: string; resourceId?: string; contentDesc?: string }
      ) => Promise<CodeHit[]>
      runProject: (platform: 'ios' | 'android', projectId: string) => Promise<boolean | { error: string }>
      stopRun: (platform: 'ios' | 'android') => Promise<boolean>
      startLog: (platform: 'ios' | 'android', id: string | null, real?: boolean) => Promise<boolean>
      stopLog: (platform?: 'ios' | 'android') => Promise<boolean>
      logHistory: () => Promise<LogEntry[]>
      clearLogs: () => Promise<boolean>
      openFolder: (p: string) => Promise<void>
      revealFolder: (p: string) => Promise<void>
      listDir: (p: string) => Promise<FsEntry[] | { error: string }>
      // 网络抓包
      startNetwork: (port?: number) => Promise<number>
      stopNetwork: () => Promise<boolean>
      listNetwork: () => Promise<NetEntry[]>
      clearNetwork: () => Promise<boolean>
      networkInfo: () => Promise<NetworkInfo>
      setDeviceProxy: (id: string) => Promise<string>
      clearDeviceProxy: (id: string) => Promise<boolean>
      setMitm: (enabled: boolean) => Promise<boolean>
      getMitm: () => Promise<boolean>
      caPath: () => Promise<string>
      openCa: () => Promise<void>
      pushCa: (id: string) => Promise<string>
      setNetworkDevice: (serial: string | null) => Promise<AppStats>
      networkAppStats: () => Promise<AppStats>
      // 网络抓包：DevTools 直连（免证书 / 免代理）
      devTargets: (port?: number) => Promise<DevTarget[]>
      devStart: (targetId: string | null, metroPort?: number) => Promise<DevStatus>
      devStop: () => Promise<boolean>
      devStatus: () => Promise<DevStatus>
      devReinject: () => Promise<boolean>
      devBody: (enabled: boolean) => Promise<boolean>
      devReload: () => Promise<boolean>
      // JS 内存
      memTakeSnapshot: () => Promise<{ ok: boolean; error?: string; summary?: MemSnapshotSummary }>
      memListSnapshots: () => Promise<MemSnapshotSummary[]>
      memClearSnapshots: () => Promise<boolean>
      memCompare: (aId: string, bId: string) => Promise<{ ok: boolean; error?: string; rows?: MemDiffRow[] }>
      memSampleStart: () => Promise<{ ok: boolean; error?: string }>
      memSampleStop: () => Promise<{ ok: boolean; error?: string; result?: MemSampleResult }>
      memGC: () => Promise<{ ok: boolean; error?: string }>
      onMemProgress: (cb: (p: MemProgress) => void) => () => void
      onNetworkStatus: (cb: (s: DevStatus) => void) => () => void
      onNetwork: (cb: (e: NetEntry) => void) => () => void
      onLogEntry: (cb: (e: LogEntry) => void) => () => void
      onMirrorFrame: (cb: (d: MirrorFrame) => void) => () => void
      onDevices: (cb: (devs: DeviceInfo[]) => void) => () => void
      onMenu: (cb: (action: string) => void) => () => void
    }
  }
}
