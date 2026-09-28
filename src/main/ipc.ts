import { ipcMain, BrowserWindow, dialog } from 'electron'
import { execFile } from 'child_process'
import { promisify } from 'util'
import * as dm from './core/deviceManager'
import * as mirror from './core/screenMirror'
import * as logger from './core/logger'
import * as inspector from './core/elementInspector'
import * as codeLocator from './core/codeLocator'
import * as fsTree from './core/fsTree'
import { networkMonitor, getLanIp } from './core/networkMonitor'
import { devtoolsNetwork } from './core/devtoolsNetwork'
import { setOnEvent as setOnLiveEvent, startLive, stopLive, sendCtrl, type CtrlMsg } from './core/scrcpyMirror'
import * as mem from './core/memoryProfiler'
import { adbBin } from './core/appResolver'
import { caCertPath, ensureCA } from './core/certAuthority'
import * as logBus from './core/logBus'
import type { LogLevel } from './core/logBus'

const execFileP = promisify(execFile)

export function registerIpc(getWindow: () => BrowserWindow | null) {
  const send = (channel: string, ...args: unknown[]) => {
    const win = getWindow()
    if (!win || win.isDestroyed()) return
    const wc = win.webContents
    if (!wc || wc.isDestroyed()) return
    try {
      wc.send(channel, ...args)
    } catch {
      /* 渲染帧已销毁（如崩溃/重载过程中），忽略，避免无限报错拖死主进程 */
    }
  }

  // ---- 运行日志（统一日志总线）----
  logBus.setSink((e) => send('log:entry', e))
  ipcMain.handle('log:history', () => logBus.recent())
  ipcMain.handle('log:clear', () => {
    logBus.clear()
    return true
  })

  // ---- 网络抓包 ----
  networkMonitor.setOnEntry((e) => send('network:entry', e))
  networkMonitor
    .start(8899)
    .catch(() => networkMonitor.start(0))
    .then(() => send('network:started', networkMonitor.listenPort))
  ipcMain.handle('network:list', () => [...devtoolsNetwork.list(), ...networkMonitor.list()])
  ipcMain.handle('network:clear', () => {
    networkMonitor.clear()
    devtoolsNetwork.clear()
    return true
  })
  ipcMain.handle('network:stop', () => {
    networkMonitor.stop()
    return true
  })
  ipcMain.handle('network:start', async (_e, port?: number) => {
    try {
      return await networkMonitor.start(port ?? 8899)
    } catch {
      return await networkMonitor.start(0)
    }
  })
  ipcMain.handle('network:info', () => ({ port: networkMonitor.listenPort, lanIp: getLanIp() }))
  // 应用识别：指定目标 Android 设备（端口→uid→包名）
  ipcMain.handle('network:setDevice', (_e, serial: string | null) => {
    networkMonitor.setTargetDevice(serial || null)
    return networkMonitor.appStats()
  })
  ipcMain.handle('network:appStats', () => networkMonitor.appStats())
  ipcMain.handle('network:setMitm', (_e, enabled: boolean) => {
    networkMonitor.setMitm(enabled)
    if (enabled) ensureCA()
    return networkMonitor.mitmEnabled
  })
  ipcMain.handle('network:getMitm', () => networkMonitor.mitmEnabled)
  ipcMain.handle('network:caPath', () => caCertPath())
  ipcMain.handle('network:openCa', async () => {
    const { shell } = await import('electron')
    shell.showItemInFolder(caCertPath())
  })
  // 推送 CA 证书到 Android 设备（用户再于「设置→安全→加密与凭据」中手动安装）
  ipcMain.handle('network:pushCa', async (_e, arg: { id: string }) => {
    const ca = caCertPath()
    const dst = '/sdcard/Download/rn-dev-tool-ca.crt'
    await execFileP(adbBin(), ['-s', arg.id, 'push', ca, dst])
    return dst
  })
  // 将 Android 设备全局代理指向本机抓包端口
  ipcMain.handle('network:setProxy', async (_e, arg: { id: string }) => {
    const proxy = `${getLanIp()}:${networkMonitor.listenPort}`
    await execFileP(adbBin(), ['-s', arg.id, 'shell', 'settings', 'put', 'global', 'http_proxy', proxy])
    return proxy
  })
  ipcMain.handle('network:clearProxy', async (_e, arg: { id: string }) => {
    await execFileP(adbBin(), ['-s', arg.id, 'shell', 'settings', 'put', 'global', 'http_proxy', ':0'])
    return true
  })

  // ---- 网络抓包：DevTools 直连（Metro inspector 注入，免证书 / 免代理）----
  devtoolsNetwork.setOnEntry((e) => send('network:entry', e))
  devtoolsNetwork.setOnStatus((s) => send('network:devStatus', s))
  devtoolsNetwork.setOnLog((level, text) =>
    logBus.push(level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'info', 'net', text)
  )
  // console 钩子回传 → 日志面板。仅 iOS 目标转发：Android 的 console 由 logcat 采集，
  // 双路转发会造成同一条日志重复。
  devtoolsNetwork.setOnConsole((c) => {
    if (!/iphone|ipad/i.test(c.deviceName)) return
    const lv = c.level === 'group' ? 'log' : c.level === 'groupEnd' ? 'debug' : c.level
    const ok: LogLevel[] = ['log', 'info', 'warn', 'error', 'debug']
    logBus.push(ok.includes(lv as LogLevel) ? (lv as LogLevel) : 'log', 'app', c.text, 'ReactNativeJS')
  })
  ipcMain.handle('network:devTargets', (_e, port?: number) => devtoolsNetwork.discover(port))
  ipcMain.handle('network:devStart', (_e, arg: { targetId: string | null; metroPort?: number }) =>
    devtoolsNetwork.start(arg?.targetId ?? null, arg?.metroPort)
  )
  ipcMain.handle('network:devStop', () => {
    devtoolsNetwork.stop()
    return true
  })
  ipcMain.handle('network:devStatus', () => devtoolsNetwork.status)
  ipcMain.handle('network:devReinject', () => {
    devtoolsNetwork.reinject()
    return true
  })
  ipcMain.handle('network:devReload', () => devtoolsNetwork.reloadApp())
  ipcMain.handle('network:devBody', (_e, enabled: boolean) => {
    devtoolsNetwork.setBodyCapture(enabled)
    return enabled
  })

  // ---- JS 内存（堆快照 / 分配采样，复用 DevTools 通道）----
  mem.setMemProgressCb((p) => send('mem:progress', p))
  ipcMain.handle('mem:takeSnapshot', () => mem.takeMemSnapshot())
  ipcMain.handle('mem:listSnapshots', () => mem.listMemSnapshots())
  ipcMain.handle('mem:clearSnapshots', () => {
    mem.clearMemSnapshots()
    return true
  })
  ipcMain.handle('mem:compare', (_e, arg: { aId: string; bId: string }) => mem.compareSnapshots(arg.aId, arg.bId))
  ipcMain.handle('mem:sampleStart', () => mem.startMemSampling())
  ipcMain.handle('mem:sampleStop', () => mem.stopMemSampling())
  ipcMain.handle('mem:gc', () => mem.triggerMemGC())

  // ---- 设备 ----
  ipcMain.handle('device:list', async () => dm.listAllDevices())
  ipcMain.handle('device:boot', async (_e, arg: { platform: 'ios' | 'android'; id: string }) => {
    if (arg.platform === 'ios') await dm.bootIOSSim(arg.id)
    else await dm.bootAndroidAvd(arg.id)
    return true
  })

  // ---- 屏幕回流 ----
  ipcMain.handle(
    'mirror:start',
    (_e, arg: { platform: 'ios' | 'android'; id: string; real?: boolean }) => {
      // fps 用默认值（3）：screencap 在真机上很重，高帧率会把手机压到卡死
      mirror.startMirror(
        arg.platform,
        arg.id,
        (b64) => send('mirror:frame', { platform: arg.platform, id: arg.id, b64 }),
        3,
        arg.real ?? false
      )
      return true
    }
  )
  ipcMain.handle('mirror:stop', (_e, arg: { platform: 'ios' | 'android'; id: string }) => {
    mirror.stopMirror(arg.platform, arg.id)
    return true
  })
  ipcMain.handle(
    'mirror:capture',
    async (_e, arg: { platform: 'ios' | 'android'; id: string; real?: boolean }) => {
      try {
        return await mirror.captureOnce(arg.platform, arg.id, arg.real ?? false)
      } catch {
        return null
      }
    }
  )
  // ---- Android 实时镜像（scrcpy 桥接，纯 JS）----
  setOnLiveEvent((e) => send('mirror:live', e))
  ipcMain.handle(
    'mirror:live:start',
    (_e, arg: { id: string; opts?: { maxSize?: number; bitRate?: number; maxFps?: number } }) =>
      startLive(arg.id, arg.opts)
  )
  ipcMain.handle('mirror:live:stop', (_e, id: string) => stopLive(id))
  ipcMain.handle('mirror:live:ctrl', (_e, arg: { id: string; msg: CtrlMsg }) => sendCtrl(arg.id, arg.msg))

  ipcMain.handle('element:inspect', async (_e, arg: { platform: 'ios' | 'android'; id: string }) => {
    return await inspector.inspect(arg.platform, arg.id)
  })
  ipcMain.handle(
    'code:locate',
    (_e, arg: { projectPath: string; node: { text?: string; className?: string; resourceId?: string; contentDesc?: string } }) => {
      return codeLocator.locate(arg.projectPath, arg.node)
    }
  )

  // ---- 平台日志 (logcat / 模拟器 log stream) ----  // ---- 平台日志 (logcat / 模拟器 log stream) ----
  // 同时只跟踪一台设备：切设备/切平台先清空旧的
  ipcMain.handle('log:start', (_e, arg: { platform: 'ios' | 'android'; id: string | null; real?: boolean }) => {
    logger.stopAllPlatformLogs()
    logBus.push('info', 'device', `开始采集设备日志：${arg.id ?? 'booted'}`)
    logger.startPlatformLog(arg.platform, arg.id, (raw) => logBus.push(raw.level, raw.source, raw.text, raw.tag), arg.real)
    return true
  })
  ipcMain.handle('log:stop', (_e, arg?: { platform?: 'ios' | 'android' }) => {
    if (arg?.platform) logger.stopPlatformLog(arg.platform)
    else logger.stopAllPlatformLogs()
    return true
  })

  // ---- 系统能力 ----
  ipcMain.handle('fs:listDir', (_e, dir: string) => fsTree.listDir(dir))
  ipcMain.handle('shell:open', async (_e, p: string) => {
    const { shell } = await import('electron')
    shell.openPath(p)
  })
  // 在访达 / 资源管理器中定位（选中）该路径
  ipcMain.handle('shell:reveal', async (_e, p: string) => {
    const { shell } = await import('electron')
    shell.showItemInFolder(p)
  })
  ipcMain.handle('dialog:openFolder', async () => {
    const r = await dialog.showOpenDialog({ properties: ['openDirectory'] })
    return r.canceled ? null : r.filePaths[0]
  })

  // ---- 设备轮询 ----
  const poll = async () => {
    const devs = await dm.listAllDevices()
    send('device:update', devs)
  }
  setInterval(poll, 4000)
  poll()
}
