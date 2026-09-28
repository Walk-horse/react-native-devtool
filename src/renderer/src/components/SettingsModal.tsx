import { useNetwork } from '../context/NetworkContext'
import { NetMode } from '../types'

interface Props {
  /** 当前镜像设备名（抓包设备与之对齐） */
  deviceLabel?: string
  onClose: () => void
}

export default function SettingsModal({ deviceLabel, onClose }: Props) {
  const net = useNetwork()
  const { settings, setSetting, androidDev } = net

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal settings-modal" onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <h3>网络抓包设置</h3>
          <button className="modal-close" onClick={onClose} aria-label="关闭">
            ✕
          </button>
        </header>

        <div className="modal-body">
          {/* 抓包方式 */}
          <div className="set-group">
            <div className="set-label">抓包方式</div>
            <div className="np-modes">
              <button
                className={`np-mode ${settings.mode === 'devtools' ? 'on' : ''}`}
                onClick={() => setSetting('mode', 'devtools')}
                title="通过 Metro inspector 注入拦截器抓包，无需装证书 / 设代理"
              >
                DevTools 直连
                <span className="tag">免证书</span>
              </button>
              <button
                className={`np-mode ${settings.mode === 'proxy' ? 'on' : ''}`}
                onClick={() => setSetting('mode', 'proxy')}
                title="本地代理 + MITM 解密，可抓原生 / 非 JS 请求"
              >
                代理抓包
                <span className="tag">需装证书</span>
              </button>
            </div>
            {settings.mode === 'devtools' ? (
              <div className="set-hint">
                走 Metro inspector 通道在 JS 运行时内拦截，<b>免装 CA 证书、免设系统代理</b>：
                覆盖 fetch / XMLHttpRequest（axios 走 XHR 亦覆盖），含请求响应头、响应体与耗时，HTTPS 天然明文。
                图片加载、原生 SDK 请求、WebView 内请求与 WebSocket 帧不在覆盖范围内（需要时切到「代理抓包」）。
                点击「开始抓包」后注入立即生效，无需重启 App。
              </div>
            ) : (
              <div className="set-hint">
                通过设备 HTTP 代理将流量导向本机抓包，可覆盖图片加载、原生 SDK 请求、WebView 内请求与 WebSocket 等全量流量。
                {settings.mitm
                  ? 'HTTPS 已解密：可看完整 URL / 请求头 / 请求体（首次需在设备上将 CA 安装为受信任凭据）。'
                  : '开启 MITM 前，HTTPS 仅记录主机；开启后可解密查看完整内容。'}
              </div>
            )}
          </div>

          {/* DevTools 专属设置 */}
          {settings.mode === 'devtools' && (
            <>
              <div className="set-group">
                <div className="set-label">Metro / RN 打包器端口</div>
                <input
                  className="set-input"
                  type="number"
                  value={settings.metroPort}
                  onChange={(e) => setSetting('metroPort', Number(e.target.value) || 8081)}
                />
                <div className="set-hint">RN 应用通过此端口的 Metro inspector 暴露调试目标；改了端口需点「开始抓包」重连。</div>
              </div>
              <div className="set-group">
                <label className="set-switch">
                  <input
                    type="checkbox"
                    checked={settings.bodyCapture}
                    onChange={(e) => setSetting('bodyCapture', e.target.checked)}
                  />
                  抓取响应体
                </label>
                <div className="set-hint">关闭后仅记录头部 / 状态码，降低大响应开销。</div>
              </div>
            </>
          )}

          {/* 代理抓包专属设置 */}
          {settings.mode === 'proxy' && (
            <>
              <div className="set-group">
                <label className="set-switch">
                  <input
                    type="checkbox"
                    checked={settings.mitm}
                    onChange={(e) => setSetting('mitm', e.target.checked)}
                  />
                  MITM 解密 HTTPS
                </label>
                <div className="set-hint">开启后需在设备上将 CA 安装为受信任凭据（点「推送 CA 到设备」后于系统设置中安装）。</div>
              </div>
              <div className="set-group">
                <label className="set-switch">
                  <input
                    type="checkbox"
                    checked={settings.appDetect}
                    onChange={(e) => setSetting('appDetect', e.target.checked)}
                    disabled={!androidDev}
                  />
                  识别应用（端口→应用归属）
                </label>
                <div className="set-hint">
                  {androidDev
                    ? '用 adb 反查设备端口归属的应用（仅 Android），便于在网络列表里按包名过滤。'
                    : '仅支持 Android 设备：请先在上方镜像面板选中一台已连接 Android 设备。'}
                </div>
              </div>
            </>
          )}

          {/* 设备对齐说明 */}
          <div className="set-group set-align">
            <span className="set-dot" />
            抓包设备跟随镜像设备：<b>{deviceLabel ?? '未选择设备'}</b>
            <span className="set-hint inline">无需单独选择抓包目标。</span>
          </div>
        </div>
      </div>
    </div>
  )
}
