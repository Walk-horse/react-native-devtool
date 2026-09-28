import { DeviceInfo } from '../types'
import { useNetwork } from '../context/NetworkContext'
import NetListView, { appShort } from './NetListView'

interface Props {
  activeDevice: DeviceInfo | null
  devices: DeviceInfo[]
}

export default function NetworkPanel({ activeDevice, devices }: Props) {
  const net = useNetwork()
  const { settings, info, devStatus, devMsg, proxyMsg, androidDev, appStats, targets, targetId } = net
  const mode = settings.mode

  // 当前抓包方式对应的条目（两套后端共用 network:entry 通道，按 source 区分）
  const scoped = net.entries.filter((e) => (e.source ?? 'proxy') === mode)

  const devChip = !devStatus?.running
    ? '未开始'
    : devStatus.attached && devStatus.hooked
      ? '已注入 · 抓取中'
      : devStatus.attached
        ? '已连接 · 等待注入'
        : '连接中…'

  const appHint = !settings.appDetect
    ? '应用识别已关闭'
    : !androidDev
      ? '应用识别仅支持 Android（需连接设备）'
      : appStats?.error
        ? `应用识别异常：${appStats.error}`
        : `应用识别：${appStats?.device ?? androidDev.id} · ${appStats?.packages ?? 0} 个包 · ${appStats?.ports ?? 0} 个端口`

  return (
    <section className="network-panel">
      <div className="np-bar">
        <button
          className={`btn sm ${net.running ? '' : 'primary'}`}
          onClick={net.toggleCapture}
          disabled={net.captureDisabled}
        >
          {net.captureLabel}
        </button>
        {mode === 'devtools' ? (
          <span className={`np-chip ${devStatus?.hooked ? 'ok' : devStatus?.attached ? 'warn' : ''}`}>{devChip}</span>
        ) : (
          info && (
            <span className="np-addr" title="将设备 HTTP 代理指向此地址">
              http://{info.lanIp}:{info.port}
            </span>
          )
        )}
        {mode === 'proxy' && androidDev && (
          <>
            <button className="btn ghost sm" onClick={net.setProxy} title="将设备全局 HTTP 代理指向本机抓包端口">
              设为设备代理
            </button>
            <button className="btn ghost sm" onClick={net.clearProxy}>
              清除
            </button>
          </>
        )}
        <button className="btn ghost sm" onClick={net.clear} title="清空已抓取的网络请求">
          清空
        </button>

        <div className="np-bar-right">
          {mode === 'devtools' ? (
            <>
              <span className="np-appstats">
                {devStatus?.attached
                  ? `已连接 ${appShort(targets.find((t) => t.id === targetId)?.appId || '') || 'RN 运行时'}${devStatus.lastInject ? ` · 注入于 ${new Date(devStatus.lastInject).toLocaleTimeString('zh-CN', { hour12: false })}` : ''}`
                  : '等待连接（需 Metro 运行且 App 已启动）'}
              </span>
              <button
                className="btn ghost sm"
                onClick={net.reinject}
                disabled={!devStatus?.running}
                title="App 重载或 Fast Refresh 后可手动重注入"
              >
                重新注入
              </button>
              <button
                className="btn ghost sm"
                onClick={net.reloadApp}
                disabled={!devStatus?.attached}
                title="重载 App 的 JS：会重新执行 App 启动逻辑，便于抓到启动期请求"
              >
                重载 App
              </button>
            </>
          ) : (
            <>
              <span className="np-appstats">{appHint}</span>
              {androidDev && (
                <>
                  <button className="btn ghost sm" onClick={net.openCa} title="在访达 / 资源管理器中打开 CA 证书">
                    打开 CA 证书
                  </button>
                  <button className="btn ghost sm" onClick={net.pushCa} title="将 CA 推送到当前 Android 设备">
                    推送 CA 到设备
                  </button>
                </>
              )}
            </>
          )}
        </div>
      </div>

      {/* 抓包方式说明已移至右上角齿轮设置弹窗；此处仅保留运行状态消息 */}
      {mode === 'devtools' ? (
        devMsg && <div className="np-hint">{devMsg}</div>
      ) : (
        proxyMsg && <div className="np-hint">{proxyMsg}</div>
      )}

      <NetListView entries={scoped} mode={mode} />
    </section>
  )
}
