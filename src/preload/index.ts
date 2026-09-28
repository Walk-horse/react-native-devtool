import { contextBridge, ipcRenderer } from 'electron'

const api = {
  // 工程管理
  listProjects: () => ipcRenderer.invoke('project:list'),
  addProject: (p: string) => ipcRenderer.invoke('project:add', p),
  removeProject: (id: string) => ipcRenderer.invoke('project:remove', id),
  scanProject: (p: string) => ipcRenderer.invoke('project:scan', p),
  openFolderDialog: () => ipcRenderer.invoke('dialog:openFolder'),

  // 设备
  listDevices: () => ipcRenderer.invoke('device:list'),
  bootDevice: (platform: 'ios' | 'android', id: string) =>
    ipcRenderer.invoke('device:boot', { platform, id }),

  // 屏幕回流
  startMirror: (platform: 'ios' | 'android', id: string, real = false) =>
    ipcRenderer.invoke('mirror:start', { platform, id, real }),
  stopMirror: (platform: 'ios' | 'android', id: string) =>
    ipcRenderer.invoke('mirror:stop', { platform, id }),
  captureFrame: (platform: 'ios' | 'android', id: string, real = false) =>
    ipcRenderer.invoke('mirror:capture', { platform, id, real }),

  // Android 实时镜像（scrcpy 桥接）
  startLiveMirror: (id: string, opts?: { maxSize?: number; bitRate?: number; maxFps?: number }) =>
    ipcRenderer.invoke('mirror:live:start', { id, opts }),
  stopLiveMirror: (id: string) => ipcRenderer.invoke('mirror:live:stop', id),
  sendMirrorCtrl: (id: string, msg: unknown) => ipcRenderer.invoke('mirror:live:ctrl', { id, msg }),
  onMirrorLive: (cb: (e: unknown) => void) => {
    const h = (_e: unknown, e: unknown) => cb(e)
    ipcRenderer.on('mirror:live', h)
    return () => ipcRenderer.removeListener('mirror:live', h)
  },
  inspectElements: (platform: 'ios' | 'android', id: string) =>
    ipcRenderer.invoke('element:inspect', { platform, id }),
  locateCode: (
    projectPath: string,
    node: { text?: string; className?: string; resourceId?: string; contentDesc?: string }
  ) => ipcRenderer.invoke('code:locate', { projectPath, node }),

  // 运行 RN
  runProject: (platform: 'ios' | 'android', projectId: string) =>
    ipcRenderer.invoke('run:start', { platform, projectId }),
  stopRun: (platform: 'ios' | 'android') => ipcRenderer.invoke('run:stop', { platform }),

  // 运行日志（统一日志总线）
  startLog: (platform: 'ios' | 'android', id: string | null, real?: boolean) =>
    ipcRenderer.invoke('log:start', { platform, id, real }),
  // 不传 platform = 停止所有采集
  stopLog: (platform?: 'ios' | 'android') => ipcRenderer.invoke('log:stop', { platform }),
  logHistory: () => ipcRenderer.invoke('log:history'),
  clearLogs: () => ipcRenderer.invoke('log:clear'),

  // 系统
  openFolder: (p: string) => ipcRenderer.invoke('shell:open', p),
  revealFolder: (p: string) => ipcRenderer.invoke('shell:reveal', p),
  // 目录树
  listDir: (p: string) => ipcRenderer.invoke('fs:listDir', p),

  // 网络抓包
  startNetwork: (port?: number) => ipcRenderer.invoke('network:start', port),
  stopNetwork: () => ipcRenderer.invoke('network:stop'),
  listNetwork: () => ipcRenderer.invoke('network:list'),
  clearNetwork: () => ipcRenderer.invoke('network:clear'),
  networkInfo: () => ipcRenderer.invoke('network:info'),
  setDeviceProxy: (id: string) => ipcRenderer.invoke('network:setProxy', { id }),
  clearDeviceProxy: (id: string) => ipcRenderer.invoke('network:clearProxy', { id }),
  setMitm: (enabled: boolean) => ipcRenderer.invoke('network:setMitm', enabled),
  getMitm: () => ipcRenderer.invoke('network:getMitm'),
  caPath: () => ipcRenderer.invoke('network:caPath'),
  openCa: () => ipcRenderer.invoke('network:openCa'),
  pushCa: (id: string) => ipcRenderer.invoke('network:pushCa', { id }),
  setNetworkDevice: (serial: string | null) => ipcRenderer.invoke('network:setDevice', serial),
  networkAppStats: () => ipcRenderer.invoke('network:appStats'),

  // 网络抓包：DevTools 直连（免证书 / 免代理）
  devTargets: (port?: number) => ipcRenderer.invoke('network:devTargets', port),
  devStart: (targetId: string | null, metroPort?: number) =>
    ipcRenderer.invoke('network:devStart', { targetId, metroPort }),
  devStop: () => ipcRenderer.invoke('network:devStop'),
  devStatus: () => ipcRenderer.invoke('network:devStatus'),
  devReinject: () => ipcRenderer.invoke('network:devReinject'),
  devBody: (enabled: boolean) => ipcRenderer.invoke('network:devBody', enabled),
  devReload: () => ipcRenderer.invoke('network:devReload'),

  // JS 内存（堆快照 / 分配采样，复用 DevTools 通道）
  memTakeSnapshot: () => ipcRenderer.invoke('mem:takeSnapshot'),
  memListSnapshots: () => ipcRenderer.invoke('mem:listSnapshots'),
  memClearSnapshots: () => ipcRenderer.invoke('mem:clearSnapshots'),
  memCompare: (aId: string, bId: string) => ipcRenderer.invoke('mem:compare', { aId, bId }),
  memSampleStart: () => ipcRenderer.invoke('mem:sampleStart'),
  memSampleStop: () => ipcRenderer.invoke('mem:sampleStop'),
  memGC: () => ipcRenderer.invoke('mem:gc'),
  onMemProgress: (cb: (p: unknown) => void) => {
    const h = (_e: unknown, p: unknown) => cb(p)
    ipcRenderer.on('mem:progress', h)
    return () => ipcRenderer.removeListener('mem:progress', h)
  },
  onNetworkStatus: (cb: (s: unknown) => void) => {
    const h = (_e: unknown, s: unknown) => cb(s)
    ipcRenderer.on('network:devStatus', h)
    return () => ipcRenderer.removeListener('network:devStatus', h)
  },

  // 事件订阅
  onNetwork: (cb: (e: unknown) => void) => {
    const h = (_e: unknown, e: unknown) => cb(e)
    ipcRenderer.on('network:entry', h)
    return () => ipcRenderer.removeListener('network:entry', h)
  },
  onLogEntry: (cb: (e: unknown) => void) => {
    const h = (_e: unknown, e: unknown) => cb(e)
    ipcRenderer.on('log:entry', h)
    return () => ipcRenderer.removeListener('log:entry', h)
  },
  onMirrorFrame: (cb: (d: { platform: string; id: string; b64: string }) => void) => {
    const h = (_e: unknown, d: { platform: string; id: string; b64: string }) => cb(d)
    ipcRenderer.on('mirror:frame', h)
    return () => ipcRenderer.removeListener('mirror:frame', h)
  },
  onDevices: (cb: (devs: unknown) => void) => {
    const h = (_e: unknown, devs: unknown) => cb(devs)
    ipcRenderer.on('device:update', h)
    return () => ipcRenderer.removeListener('device:update', h)
  },
  // 应用菜单动作
  onMenu: (cb: (action: string) => void) => {
    const actions = [
      'add-project',
      'open-project-folder',
      'reveal-project',
      'refresh-tree',
      'remove-project',
      'toggle-sidebar'
    ]
    const offs = actions.map((a) => {
      const ch = `menu:${a}`
      const h = () => cb(a)
      ipcRenderer.on(ch, h)
      return () => ipcRenderer.removeListener(ch, h)
    })
    return () => offs.forEach((f) => f())
  }
}

contextBridge.exposeInMainWorld('api', api)
console.log('[preload] api exposed, contextBridge OK')
