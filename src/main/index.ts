import { app, BrowserWindow } from 'electron'
import { join } from 'path'
import { appendFileSync, mkdirSync } from 'fs'
import { registerIpc } from './ipc'
import { buildAppMenu } from './menu'
import { installConsoleCapture, push } from './core/logBus'
import { pauseAllMirrors } from './core/screenMirror'

// 稳定性开关：受限/容器环境下，网络子进程的后台联网（遥测、组件更新等）会失败并
// 连带 abort 整个进程。这些开关让其不再发起这类请求，避免在受限环境中「打开即闪退」。
// 在普通桌面环境上同样无害（仅禁用后台网络行为）。必须在 app ready 前设置。
app.commandLine.appendSwitch('disable-dev-shm-usage')
app.commandLine.appendSwitch('disable-background-networking')
app.commandLine.appendSwitch('disable-component-update')
app.commandLine.appendSwitch('no-first-run')
app.commandLine.appendSwitch('disable-features', 'NetworkPrediction,DialMediaRouteProvider')
app.commandLine.appendSwitch('disable-software-rasterizer')

/** 崩溃 / 异常保命日志：窗口关闭后仍落盘，便于定位「打开即闪退」类问题 */
function crashLog(line: string) {
  try {
    const dir = app.getPath('logs')
    mkdirSync(dir, { recursive: true })
    appendFileSync(join(dir, 'rn-dev-tool-crash.log'), `[${new Date().toISOString()}] ${line}\n`)
  } catch {
    /* 日志目录都写不了就放弃 */
  }
}

// 尽早接管主进程 console，启动阶段的日志也能进「运行日志」
installConsoleCapture()

// 进程级崩溃钩子（窗口关了也能留痕）
app.on('render-process-gone', (_e, _wc, details) => {
  crashLog(`[render-process-gone] reason=${details.reason} exitCode=${details.exitCode}`)
})
app.on('child-process-gone', (_e, details) => {
  crashLog(
    `[child-process-gone] type=${details.type} reason=${details.reason} exitCode=${details.exitCode} serviceName=${details.serviceName ?? ''}`
  )
})
process.on('uncaughtException', (e) => {
  crashLog(`[uncaughtException] ${e?.stack ?? e}`)
})
process.on('unhandledRejection', (r) => {
  crashLog(`[unhandledRejection] ${r instanceof Error ? r.stack ?? r.message : String(r)}`)
})

let mainWindow: BrowserWindow | null = null

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    title: 'RN Dev Tool',
    backgroundColor: '#0f1115',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  mainWindow.webContents.on('did-finish-load', () => {
    console.log('[main] renderer did-finish-load OK')
    push('info', 'main', '界面已就绪')
  })
  mainWindow.webContents.on('did-fail-load', (_e, errorCode, errorDescription) => {
    crashLog(`[did-fail-load] code=${errorCode} desc=${errorDescription}`)
  })
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    push('error', 'main', `渲染进程异常退出：${details.reason}`)
    crashLog(`[render-process-gone/win] reason=${details.reason} exitCode=${details.exitCode}`)
  })
  // 渲染进程（页面）自身的 console 也会走这里；error 级直接落盘
  mainWindow.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    const lv = level === 0 ? 'debug' : level === 1 ? 'info' : level === 2 ? 'warn' : 'error'
    if (lv === 'error') crashLog(`[renderer-error] ${message}${sourceId ? ` (${sourceId}:${line})` : ''}`)
    push(lv, 'renderer', `${message}${sourceId ? `（${sourceId}:${line}）` : ''}`)
  })
  // 渲染进程（页面）自身的 console 也会走这里
  mainWindow.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    const lv = level === 0 ? 'debug' : level === 1 ? 'info' : level === 2 ? 'warn' : 'error'
    push(lv, 'renderer', `${message}${sourceId ? `（${sourceId}:${line}）` : ''}`)
  })
  // 窗口不可见时暂停镜像采集：后台高频 screencap 会让设备内存/CPU 飙升
  const pause = () => {
    pauseAllMirrors(true)
    push('info', 'main', '窗口不可见，已暂停镜像采集（降低设备负载）')
  }
  const resume = () => {
    pauseAllMirrors(false)
    push('info', 'main', '窗口恢复，继续镜像采集')
  }
  mainWindow.on('minimize', pause)
  mainWindow.on('hide', pause)
  mainWindow.on('restore', resume)
  mainWindow.on('show', resume)

  console.log('[main] window created')
}

app.whenReady().then(() => {
  createWindow()
  registerIpc(() => mainWindow)
  buildAppMenu(() => mainWindow)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
