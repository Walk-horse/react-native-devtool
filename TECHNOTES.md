# RN Dev Tool 技术归纳（Tech Notes）

> 本文档归纳本项目涉及的技术栈、核心知识点与设计思路，便于后续维护与协作。
> 维护时若发现新的平台限制或踩坑，请同步更新对应小节。

---

## 一、技术栈

| 层 | 技术 | 说明 |
|----|------|------|
| 桌面壳 | Electron + React 18 + TypeScript | electron-vite 三入口 `main/preload/renderer` 必须齐全，缺一类整包构建会被跳过 |
| 构建 | electron-vite | 改动 `src/renderer/src/styles.css` 后**必须确认没被外部编辑器回退** |
| 跨进程通信 | IPC + contextBridge | 新增接口三处同步：`src/main/ipc.ts` → `src/preload/index.ts` → `src/renderer/src/types.ts`（`Window.api` 类型） |
| 目标端 | React Native 0.81 + Hermes | mall App（`com.ehaier.zgq.shop.mall`，Android API 36 / iOS 模拟器） |
| 调试通道 | CDP over Metro inspector | WebSocket 转发设备端 inspector |
| 移动桥接 | adb / pymobiledevice3 / simctl | 真机控制与取帧 |

---

## 二、核心技术模块与知识点

### 1. 设备实时镜像

#### Android — 纯 JS scrcpy v2.4
- **协议**：server 资产 `resources/scrcpy-server-v2.4`（jar 无后缀）经 `adb push` + `app_process` 跑在设备端；`tunnel_forward=true` 时设备端监听，host 直接 `net.connect` adb forward 端口（**host 别再 listen**）。
- **连接顺序**：必须先连 `video` 再连 `control` 两个 socket，**双 socket 全连上 server 才开始推流**（先读帧后连 control 会死锁）。
- `scid` 是 **16 进制**字符串；video socket 以 12B codec meta（codecId + 宽 + 高）起始，随后每帧 12B 帧头（bit63=config / bit62=key + u32 size）+ Annex-B。
- **解码**：WebCodecs `VideoDecoder` 消费 Annex-B，codec string 从 SPS 头拼（`avc1.PPCDLL`）；WebCodecs 走 Annex-B 无 description，首 key 帧前需拼 config 包。
- **触控注入**：INJECT_TOUCH=32B（pressure u16 定点 0xFFFF=1.0）/ KEYCODE=14B / SCROLL=21B（i16 定点 0x7FFF=1.0），全大端；坐标含横竖屏旋转换算（`videoToDevice` / `deviceBoundsToVideo`）。
- **读流必须常驻缓冲**（一个持久 `data` 监听 + 累积 buffer）：flowing 模式间歇 `readN` 会在监听空窗期丢字节 → 帧失步出现诡异"前缀块"。
- **连接存活探测**：带 400ms 存活探测重试（adbd 先收 TCP、设备端还没监听会立刻关闭）。
- **一次性事件竞态**：meta/cfg 是一次性事件，`attach` 是 passive effect 会输给 IPC 事件流 → 模块级缓存最近一次 meta/cfg，`attach` 后回放。
- **MIUI/HyperOS 限制**：系统级禁止 adb 输入注入（`adb shell input` 与 scrcpy 触控同样报 INJECT_EVENTS SecurityException）；通知栏展开等非注入控制不受影响。需手机开启「开发者选项 → USB 调试（安全设置）」。scrcpyMirror 已检测 stderr 并提示。

#### iOS — 1fps 截图流
- 真机唯一可用路线：`pymobiledevice3 developer dvt screenshot --udid <udid> out.png`（~1.4s/帧，真机镜像 fps=1）。`idevicescreenshot`（screenshotr）与 CMIO/QuickTime USB 镜像在 macOS 26 均已失效。
- **注意**：`developer screenshot`（老 API）≠ `developer dvt screenshot`（DVT，可用）。前提：开发者模式开 + DDI 已挂载（Xcode 连过自动挂）。
- 模拟器：`xcrun simctl io screenshot`（3fps，更流畅）。
- **AirPlay 纯 JS 不可行**：AirPlay 镜像接收端需 FairPlay(HAP) 加密握手，纯 JS 无成熟实现（UxPlay 是 C 且 GPL-3.0）。当前沿用 simctl / 截图流。
- iOS 镜像入口与 Android 统一（DevicePanel 按 platform 分流），错误可见化（不再静默吞错）。

### 2. 网络抓包（双后端并存）
- 两种模式并存，UI 用 `np-mode` 切换，条目靠 `source` 字段区分（`'devtools' | 'proxy'`）：
  - **DevTools 直连**（`core/devtoolsNetwork.ts`，免证书/免代理）：Metro inspector 通道 + `Runtime.addBinding` + 注入 fetch/XHR 拦截器。**只覆盖 JS 层 fetch/XHR**，抓不到图片/原生 SDK/WebView/WebSocket 帧。RN 0.81 **不支持** CDP `Network` 域（报 -32601），别试官方 Network 面板。
  - **代理抓包**（`core/networkMonitor.ts`，需装 CA + 设代理）：覆盖全量流量。
- 两后端共用类型/工具在 `core/netUtil.ts`（`NetEntry` / `MAX_BODY` / `splitUrl` / `guessType`），改字段只改一处。
- 注入抓包条目 id 必须带运行时令牌（`D<token>-<id>`），否则 App 重载后序号归零会撞 id。
- 重连记忆目标用 `appId + deviceName`，否则会漂到另一台设备。

### 3. 内存分析

#### 堆快照（CDP `HeapProfiler.takeHeapSnapshot` + `addHeapSnapshotChunk` 流式）
- **平台硬伤（已实测钉死）**：Android 真机经 Metro 通道，堆 >~75MB 时 **~7.5s / ~75MB 处设备端必 `close 1000`**，reason `Connection lost to corresponding device`，数据在数字中间截断（如 `...,84`），JSON 解析必失败；最终 CDP 响应永远不来。
- 排除项：
  - USB/adb 隧道无辜（`dd 200MB / 5.9s ≈ 35MB/s` 稳定）
  - 与连接竞争无关（杀掉本工具进程后单连接复现）
  - GC 后仍复现（72.7MB 照样断）
  - Metro 源码搜不到该关闭逻辑（信号来自**设备端 Hermes inspector 自身**）
  - 判定为**时间型上限（~7.5s）**而非字节型
- **iOS 模拟器对照**：258MB / 1326 万节点 / 76s **完整传完**，response 正常到达 ✅。
- **修复**（`memoryProfiler.ts` / `devtoolsNetwork.ts`）：
  - `devtoolsNetwork.onceSocketClose(cb)`：一次性订阅当前 socket 关闭（close 事件触发所有回调）。
  - `takeMemSnapshot` 改 `Promise.race(call(300s), closedP)`：**response 到达或连接关闭任一即完成**；超时提到 300s 兼容 iOS 慢快照。
  - JSON 解析失败且收到过 chunk → 返回可读错误（说明 ~75MB/7.5s 平台硬上限 + 建议改用分配采样 / GC 减堆重试 / iOS 模拟器不受限）。
- **兜底**：`devtoolsNetwork.call` 加超时（默认 60s），根治"永久 pending"卡死（原 `call` 只等响应、无超时）。

#### 写盘 + pull 方案（用户提议，技术正确但当前 App 不可行）
- 思路：让 App 把快照写沙盒文件 → `adb pull` 走 USB（35MB/s 稳），绕开 75MB 上限。
- 实测否定：App 未暴露任何写盘 API —— `__rnHeapCapture` undefined、`nativeModuleProxy.HeapCapture` 存在但 `captureHeap` 为 **null**（空壳）、`HermesInternal` 无 snapshot 方法。需 App 侧启用 RN `HeapCapture` 并重 build dev 包才能成立。

#### 分配采样（真机可用方案）
- `HeapProfiler.startSampling` / `stopSampling` 聚合，走采样不传全量堆，真机实测可用。
- **自动停止计时**（渲染端 `MemoryPanel.tsx`）：`useRef` 计时器（默认 30s，1–3600 可调），到点调 `stopSampling` 聚合；手动停止会清计时器；主进程零改动。

### 4. 元素分析
- Android：uiautomator dump（bounds + 状态位，**不暴露真实视觉样式**：颜色/字体/内边距）。元素面板只能给 bounds + 状态位。
- 元素叠加 overlay 命中检测复用镜像 canvas 坐标（`DevicePanel`）。

### 5. 工程稳定性
- **启动开关固化**（`src/main/index.ts` 早期 `app.commandLine.appendSwitch`）：
  `disable-background-networking` / `disable-dev-shm-usage` / `disable-component-update` / `--no-first-run` / `disable-features=NetworkPrediction,DialMediaRouteProvider` / `disable-software-rasterizer`。
- **闪退根因**：沙箱里 `--remote-debugging-port` 让网络子进程秒崩（SIGABRT）→ 渲染帧销毁 → console 捕获器路由 webFrameMain 抛错级联。去掉调试端口 + 固化上述开关后稳过 120s。
- **防护**：`logBus` / `ipc.send` 包 try/catch 阻断级联；`render-process-gone` 崩溃落盘到 `~/Library/Logs/rn-dev-tool/rn-dev-tool-crash.log`。
- **日志**：`core/logBus.ts` 统一总线，source ∈ `app`(应用 console) / `metro`(打包器) / `device`(设备) / `renderer`(界面) / `main`(主进程) / `net`(代理)。主进程 console 已被 `installConsoleCapture()` 接管；渲染进程 console 由 main 侧 `webContents 'console-message'` 捕获。

---

## 三、思路与方法论

1. **探查优先，不臆断**：写独立 ws 探针直连 Metro（node + 项目 `node_modules/ws`），逐步排除——命令支持 → chunk 流 → close code/reason → JSON 截断位置 → 对照组（杀竞争进程 / GC / 其他目标）。这是定位 75MB 硬伤的关键路径。
2. **平台限制诚实化**：不强行突破无解的墙，给明确替代路径（真机查泄漏 → 分配采样；完整堆 → iOS 模拟器）。
3. **纯 JS 优先**：能用 JS 实现的绝不动 native（scrcpy host 侧、CDP 调用全 JS；iOS 投屏因平台加密才放弃）。
4. **渐进式兼容**：实时镜像保留截图流作回退；抓包双后端并存按 UI 切换。
5. **风险隔离**：主进程崩 → 渲染帧销毁 → 钩子级联，逐层 try/catch + 崩溃落盘，阻断雪崩。
6. **一次性事件缓存回放**：meta/cfg 竞态用模块级缓存 + attach 后回放解决。

---

## 四、关键坑速查

| 坑 | 现象 | 解决 / 规避 |
|----|------|------------|
| scrcpy 双 socket | 先读帧后连 control → server 不推流死锁 | 先连 video 再连 control，全连才读 |
| scid 格式 | 当十进制解析 → 连接失败 | 按 **16 进制**解析 |
| 读流失步 | 间歇 `readN` 丢字节 → 帧错位"前缀块" | 常驻 `data` 监听 + 累积 buffer |
| Android 堆快照断连 | ~75MB/7.5s 设备端 close 1000 | 诚实失败 + 指引（分配采样 / iOS 模拟器） |
| iOS 26 真机取帧 | AirPlay/QuickTime/CMIO 失效 | `pymobiledevice3 developer dvt screenshot` |
| MIUI/HyperOS 输入 | adb 输入注入被系统禁 | 开「USB 调试（安全设置）」 |
| rollup 打包 `ws` | 主进程收不到数据帧（连上空白只收 ping） | `electron.vite.config.ts` 的 `main.build.rollupOptions.external` 含 `'ws'` |
| 沙箱 `--remote-debugging-port` | 网络子进程秒崩 → 闪退 | 去掉调试端口 + 固化稳定性开关 |
| `devtoolsNetwork.call` 无超时 | CDP 命令永久 pending → 界面卡死 | 加超时兜底（默认 60s） |
| 真机 logcat console 格式 | groupCollapsed 头行 `┘`、子行 `│`(U+2502) | 解析依赖这些格式，改动前先 `adb logcat -d` 抓样本 |
| adb reverse tcp: | host 侧只看到 adb 源端口，端口→应用归属失效 | 归属/识别验证走真实局域网 IP |
| `adb logcat -v time` 真实格式 | `09-21 19:02:19.080 I/ReactNativeJS( 1824): msg`（时间戳+brief 混合） | 解析失败会静默丢行 → 界面空白 |
