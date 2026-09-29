# RN Dev Tool

一款基于 **Electron + React** 的 React Native 调试工具，把 iOS / Android 模拟器与真机的**画面、网络、内存、元素**集中回流到桌面端，配套抓包、实时镜像、堆/分配采样、UI 元素分析等能力。

> 仓库内置 `resources/scrcpy-server-v2.4`，Android 实时镜像开箱即用，无需另行下载。

## ✨ 功能一览

| 模块 | 能力 | 平台 |
|------|------|------|
| **设备镜像** | Android 实时镜像（scrcpy 协议 + WebCodecs 解码 + 触控/按键注入）；iOS 低频截图流（约 1fps） | Android / iOS |
| **网络抓包** | 双后端：① DevTools 直连（免证书，覆盖 JS 层 fetch/XHR）② 代理抓包（需装 CA，覆盖全量流量） | Android / iOS |
| **元素分析** | uiautomator dump 解析 + 镜像上元素框叠加，点击定位 | Android（iOS 走截图回退） |
| **内存分析** | 堆快照（HeapProfiler）；JS 分配采样（支持自动停止计时） | Android / iOS |
| **运行日志** | 聚合 App / Metro / 设备 / 代理多源日志 | Android / iOS |
| **代码定位** | 由日志栈帧定位到工程源码 | —— |

## 📋 环境要求

- **Node.js** 18+（开发验证环境 Node 22）
- **macOS** 开发机（部分能力依赖 macOS / Linux 工具链）
- **Android**：`adb` 已加入 PATH，设备开启「USB 调试」（真机触控注入还需开启「USB 调试（安全设置）」）
- **iOS 真机**：`pymobiledevice3`（真机截图流用）、开发者模式开启、DDI 已挂载；iOS 模拟器用 `xcrun simctl`
- **代理抓包**：需在设备/模拟器安装并信任本工具生成的 CA 证书

## 🚀 快速开始

```bash
npm install        # 安装依赖（electron / electron-vite / ws / node-forge）
npm run dev        # 启动开发模式（electron-vite 编译并拉起 Electron）
```

构建为可分发包：

```bash
npm run build      # 产出 out/（main / preload / renderer 三类入口）
npm run preview    # 预览构建产物
```

## 📖 使用指南

### 1. 设备镜像
- **Android 实时镜像**：在设备面板点「实时镜像」，工具自动 `adb push` scrcpy server 并建双 socket 通道，用 WebCodecs 解码 H.264 出画；画面支持点击 / 滑动 / 滚轮注入，以及 Home / 返回等系统键。元素分析叠加层可点击定位组件。
- **iOS 投屏**：走 `pymobiledevice3`（真机）/ `simctl`（模拟器）定时截图刷新画面，约 1fps，适合观察状态变化。

### 2. 网络抓包
- 顶部 `np-mode` 切换**直连 / 代理**两种后端：
  - **直连（DevTools）**：经 Metro inspector 注入 fetch/XHR 拦截器，**免证书、免代理**，但只覆盖 JS 层网络。
  - **代理**：需先在设备装 CA 并设代理，可抓全量流量（含图片、原生 SDK、WebView）。

### 3. 内存分析
- **堆快照**：点「拍摄快照」抓取整份 JS 堆。⚠️ 见下方「已知限制」。
- **分配采样**：点「开始采样」，可选「自动停止」（默认 30s，1–3600 可调），到点自动聚合 JS 分配热点，是**真机查泄漏的推荐方式**。

### 4. 元素分析
- 设备面板开启元素叠加后，镜像画面上的组件边界框可点击，命中后在元素面板查看层级与属性；真机走 uiautomator dump，模拟器/回退场景走截图。

## ⚠️ 已知限制与注意事项

| 限制 | 说明 | 应对 |
|------|------|------|
| **Android 真机堆快照有传输上限** | 经 Metro inspector 通道拍快照时，设备端会在约 **75MB / 7.5s** 处主动断连，最终 CDP 响应不来。大堆 App（如 >70MB）快照不可用。这是 RN 0.81 / Hermes + Metro 的**平台级硬伤**，Chrome DevTools 走同一通道同样失败。 | 真机查泄漏用**分配采样**；完整堆快照用 **iOS 模拟器**（实测 258MB 完整传完） |
| **iOS 投屏为低频截图流** | AirPlay / QuickTime USB 镜像在 iOS 26 真机已失效，纯 JS 无法走 FairPlay 加密；唯一可用路线是定时截图，**约 1fps**，非流畅视频 | 接受低频刷新；需要流畅镜像请用 Android scrcpy |
| **MIUI / HyperOS 触控注入** | 系统级禁止 adb 输入注入（`adb shell input` 与 scrcpy 触控同路受限），需开启「开发者选项 → USB 调试（安全设置）」 | 通知栏/非注入类控制不受影响 |
| **DevTools 直连抓包覆盖有限** | 只拦截 JS 层 fetch/XHR，抓不到图片、原生 SDK、WebView、WebSocket 帧 | 需全量流量请切「代理」模式并装 CA |
| **写盘式快照暂不支持** | 当前 App 未暴露 Hermes 堆写盘 API（`__rnHeapCapture` / `HeapCapture.captureHeap` 均不可用），故「先写盘再 adb pull」方案当前不可行 | 如需在 App 侧补 `HeapCapture` 实现并可重新 build，可联系维护者接入 |

## 🗂 项目结构（核心目录）

```
src/
├─ main/                      # Electron 主进程
│  ├─ index.ts                # 启动入口（固化稳定性开关）
│  ├─ ipc.ts                  # IPC 桥接（网络 / 镜像 / 内存 / 元素）
│  └─ core/
│     ├─ devtoolsNetwork.ts   # Metro inspector CDP 通道（心跳 / 调用 / 事件）
│     ├─ networkMonitor.ts    # 代理抓包后端（CA + MITM）
│     ├─ scrcpyMirror.ts      # Android scrcpy 实时镜像（纯 JS 协议）
│     ├─ screenMirror.ts      # iOS / 回退截图流
│     ├─ elementInspector.ts  # uiautomator 元素 dump
│     ├─ memoryProfiler.ts    # 堆快照 / 分配采样
│     ├─ appResolver.ts       # adb / idevice / pymobiledevice3 路径解析
│     └─ ...
└─ renderer/src/              # React 渲染进程
   ├─ App.tsx                 # 主框架 / 状态机
   ├─ components/
   │  ├─ DevicePanel.tsx      # 设备镜像 + 元素叠加
   │  ├─ NetworkPanel.tsx     # 网络抓包面板
   │  ├─ NetListView.tsx      # 请求列表 / JSON 树
   │  ├─ MemoryPanel.tsx      # 内存快照 / 采样
   │  ├─ ElementPanel.tsx     # 元素树
   │  └─ LogConsole.tsx       # 运行日志
   └─ lib/scrcpyPlayer.ts     # WebCodecs 解码与坐标换算
```

## 🛠 开发

- 三大入口（`main` / `preload` / `renderer`）由 `electron.vite.config.ts` 统一管理，缺一类构建会被跳过。
- 新增 IPC 需三处同步：`src/main/ipc.ts` → `src/preload/index.ts` → `src/renderer/src/types.ts`（`Window.api` 类型）。
- 日志统一走 `core/logBus.ts`；子进程按行产出请返回 `RawLog`。
- 启动已固化 `disable-background-networking` / `disable-dev-shm-usage` 等开关以规避沙箱/网络子进程回收导致的闪退。

## 📄 License

MIT
