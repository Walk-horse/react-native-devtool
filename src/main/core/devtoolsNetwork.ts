import WebSocket from 'ws'
import { NetEntry, urlName, splitUrl, guessType } from './netUtil'

/**
 * 「RN DevTools 插件式」抓包：走 Metro 的 inspector（CDP）通道，
 * 连上目标 JS 运行时后用 Runtime.addBinding + Runtime.evaluate 注入一段
 * fetch / XMLHttpRequest 拦截器，请求与响应经 binding 回传。
 *
 * 优点：免装 CA 证书、免设系统代理、天然明文（在 JS 层拦截）、自动知道所属 App。
 * 限制：只覆盖 JS 层发起的 fetch/XHR（axios 走 XHR，已覆盖）；
 *      图片加载 / 原生 SDK 请求 / WebView 内请求 / WebSocket 帧抓不到。
 *
 * 注意：RN dev-middleware 的 inspector 代理同一时刻只把 CDP 流量转发给「最近一次
 * 调度」的调试通道，且它的 connect / disconnect 事件与设备侧存在时序耦合 ——
 * 首个连接有可能被挂在一个收不到回包的通道上。因此这里用「探活 + 自动重连」兜底。
 */

export interface DevTarget {
  id: string
  /** 展示名：App 名（设备名） */
  label: string
  appId: string
  deviceName: string
  description: string
  wsUrl: string
  page: string
}

export interface DevStatus {
  /** 是否正在抓取（用户已开启） */
  running: boolean
  /** inspector WebSocket 是否已连接 */
  attached: boolean
  /** 拦截器是否已注入到 JS 运行时 */
  hooked: boolean
  targetId: string | null
  metroPort: number
  error: string | null
  lastInject: number
  /** 已建立过的调试通道次数（>1 说明发生过自愈重连） */
  attaches: number
}

/** 注入到 App 运行时的拦截器（幂等 + 可卸载；所有路径 try/catch，绝不影响业务） */
const HOOK_SRC = `
(function(){
  var g = globalThis;
  // hook 完好性：bundle 重跑（RN Page.reload 不销毁 context）会重新执行 polyfill，
  // 把 globalThis.fetch / XMLHttpRequest 整个重新赋值，覆盖掉我们的替换 ——
  // 只有 __rndevHooked 标记还在不代表 hook 生效，必须验证标记函数仍挂在对象上。
  function hookIntact(){
    return !!(g.fetch && g.fetch.__rndevMarked === true &&
              g.XMLHttpRequest && g.XMLHttpRequest.prototype.send &&
              g.XMLHttpRequest.prototype.send.__rndevMarked === true);
  }
  g.__rndevIntact = hookIntact;
  if (g.__rndevHooked) {
    if (hookIntact()) return 'already:' + (g.__rndevToken || '');
    try { g.__rndevUninstall && g.__rndevUninstall(); } catch(e){}
  }
  g.__rndevHooked = true;
  g.__rndevSeq = g.__rndevSeq || 0;
  // 运行时令牌：App 重载后序号会从头开始，靠它避免与上一轮的 id 撞车
  g.__rndevToken = 't' + Math.floor(Math.random() * 1e9).toString(36);
  g.__rndevCfg = g.__rndevCfg || { body: true };
  var orig = g.__rndevOrig = g.__rndevOrig || {};
  function post(o){ try { o.token = g.__rndevToken; g.__rndevNet(JSON.stringify(o)); } catch(e){} }
  function hdict(h){
    var out = {};
    try {
      if (!h) return out;
      if (typeof Headers !== 'undefined' && h instanceof Headers) h.forEach(function(v,k){ out[k]=v; });
      else if (Array.isArray(h)) h.forEach(function(p){ out[p[0]]=p[1]; });
      else Object.keys(h).forEach(function(k){ out[k]=h[k]; });
    } catch(e){}
    return out;
  }
  function bodyOf(b){
    try {
      if (b == null) return undefined;
      if (typeof b === 'string') return g.__rndevCfg.body ? b : undefined;
      if (typeof FormData !== 'undefined' && b instanceof FormData) return '[FormData]';
      if (typeof ArrayBuffer !== 'undefined' && b instanceof ArrayBuffer) return '[ArrayBuffer '+b.byteLength+'B]';
      if (typeof Blob !== 'undefined' && b instanceof Blob) return '[Blob '+b.size+'B]';
      return '[' + (typeof b) + ']';
    } catch(e){ return undefined }
  }
  var XHR = g.XMLHttpRequest;
  if (XHR) {
    var P = XHR.prototype;
    if (!orig.open) {
      orig.open = P.open; orig.send = P.send; orig.setRequestHeader = P.setRequestHeader;
      P.open = function(m,u){ try { this.__rndev={ method:String(m||'GET'), url:String(u||''), headers:{} } } catch(e){} return orig.open.apply(this, arguments); };
      P.setRequestHeader = function(k,v){ try { if(this.__rndev) this.__rndev.headers[k]=v } catch(e){} return orig.setRequestHeader.apply(this, arguments); };
      P.send = function(b){
        if (g.__rndevSkipXhr) return orig.send.apply(this, arguments);
        var rec;
        try {
          rec = this.__rndev || { method:'GET', url:'', headers:{} };
          rec.id = 'xhr-' + (++g.__rndevSeq);
          rec.t0 = Date.now();
          post({ phase:'req', id:rec.id, channel:'xhr', method:rec.method, url:rec.url, headers:rec.headers, body:bodyOf(b) });
          var self = this;
          self.addEventListener('loadend', function(){
            var text, rh = {};
            try { rh = self.getAllResponseHeaders() ? self.getAllResponseHeaders().split(/\\r?\\n/).reduce(function(a,l){ var i=l.indexOf(':'); if(i>0) a[l.slice(0,i).trim().toLowerCase()]=l.slice(i+1).trim(); return a }, {}) : {} } catch(e){}
            try {
              var rt = self.responseType;
              if (!rt || rt === 'text') text = self.responseText;
              else if (rt === 'json') text = JSON.stringify(self.response);
            } catch(e){}
            post({ phase:'res', id:rec.id, channel:'xhr', status:self.status, statusText:self.statusText,
                   duration:Date.now()-rec.t0, headers:rh, body: g.__rndevCfg.body ? text : undefined });
          });
        } catch(e){}
        return orig.send.apply(this, arguments);
      };
      P.send.__rndevMarked = true;
    }
  }
  var of = g.fetch;
  if (of && !orig.fetch) {
    orig.fetch = of;
    g.fetch = function(input, init){
      var p;
      g.__rndevSkipXhr = true;
      try { p = of.apply(this, arguments); } finally { g.__rndevSkipXhr = false; }
      try {
        init = init || {};
        var url = typeof input === 'string' ? input : (input && input.url) || String(input);
        var method = String(init.method || (input && input.method) || 'GET').toUpperCase();
        var rec = { id:'fetch-' + (++g.__rndevSeq), t0: Date.now() };
        post({ phase:'req', id:rec.id, channel:'fetch', method:method, url:url,
               headers: hdict(init.headers || (input && input.headers)), body: bodyOf(init.body) });
        return p.then(function(res){
          var out;
          try { out = res.clone(); } catch(e) { out = res }
          var fin = function(txt){
            var rh = {};
            try { res.headers.forEach(function(v,k){ rh[k]=v }) } catch(e){}
            post({ phase:'res', id:rec.id, channel:'fetch', status:res.status, statusText:res.statusText,
                   duration:Date.now()-rec.t0, headers:rh, body: g.__rndevCfg.body ? txt : undefined });
          };
          try { out.text().then(fin, function(e){ post({ phase:'err', id:rec.id, error:String(e) }) }) } catch(e){}
          return res;
        }, function(e){ post({ phase:'err', id:rec.id, error:String(e) }); throw e });
      } catch(e){ return p }
    };
    g.fetch.__rndevMarked = true;
  }
  g.__rndevUninstall = function(){
    try {
      if (orig.fetch) g.fetch = orig.fetch;
      var Q = g.XMLHttpRequest && g.XMLHttpRequest.prototype;
      if (Q && orig.open) { Q.open = orig.open; Q.send = orig.send; Q.setRequestHeader = orig.setRequestHeader; }
      var CN = g.console;
      if (CN) {
        var cnames = ['log','info','warn','error','debug','groupCollapsed','group','groupEnd'];
        for (var ci = 0; ci < cnames.length; ci++) {
          var ofn = orig['c_' + cnames[ci]];
          if (ofn) CN[cnames[ci]] = ofn;
        }
      }
      g.__rndevOrig = {};
    } catch(e){}
    g.__rndevHooked = false;
    return 'uninstalled';
  };
  // ---- console 钩子：把 console.* 输出按真机 logcat 的渲染形态格式化后回传 ----
  // 真机实测（bridgeless/Hermes）：console.log 不进系统日志（syslog 无输出），
  // 只能经调试通道采集。格式对齐 LogConsole.parseApiLogs 的解析预期：
  // group/groupCollapsed 头行前缀 ┘、其余子行前缀 │、groupEnd 为单独 ┘、
  // 字符串参数带单引号、对象多行 inspect（未引号 key + 单引号字符串值）。
  var con = g.console;
  function cesc(s){ return String(s).replace(/\\\\/g, '\\\\\\\\').replace(/'/g, "\\'"); }
  function cfmt(v, d){
    try {
      if (v === null) return 'null';
      if (v === undefined) return 'undefined';
      var t = typeof v;
      if (t === 'string') return "'" + cesc(v) + "'";
      if (t === 'number' || t === 'boolean' || t === 'bigint') return String(v);
      if (t === 'function') return '[Function ' + (v.name || 'anonymous') + ']';
      // 深层限制放宽到 24 层 / 数组 500 项 / 对象 500 key：太浅会让深层响应对象变成 … 省略号，接口详情无法还原
      if (d > 24) return '…';
      if (Array.isArray(v)) {
        var its = [];
        for (var i = 0; i < v.length && i < 500; i++) its.push(cfmt(v[i], d + 1));
        if (v.length > 500) its.push('… ' + (v.length - 500) + ' more');
        return '[' + its.join(', ') + ']';
      }
      var ks = Object.keys(v);
      if (!ks.length) return '{}';
      var ps = [];
      for (var j = 0; j < ks.length && j < 500; j++) {
        var k = ks[j];
        var kk = /^[A-Za-z_$][\\w$]*$/.test(k) ? k : "'" + cesc(k) + "'";
        ps.push(kk + ': ' + cfmt(v[k], d + 1));
      }
      if (ks.length > 500) ps.push('…');
      return '{\\n  ' + ps.join(',\\n  ') + '\\n}';
    } catch (e) { return '[unserializable]' }
  }
  function cemit(tag, args){
    var text;
    if (args.length === 1 && typeof args[0] === 'string') {
      // 单字符串参数原样输出：group 头行（API Request: GET /path）不能带引号，
      // 否则 API_HEADER_RE 会把闭合引号吃进路径捕获组
      text = args[0];
    } else {
      var parts = [];
      for (var i = 0; i < args.length; i++) parts.push(cfmt(args[i], 0));
      text = parts.join(', ');
    }
    if (text.length > 100000) text = text.slice(0, 100000) + '…[truncated]';
    if (tag === 'group') text = '┘ ' + text.split('\\n').join('\\n│ ');
    else text = '│ ' + text.split('\\n').join('\\n│ ');
    post({ phase:'console', level: tag, text: text });
  }
  function chook(name, tag){
    if (!con || typeof con[name] !== 'function') return;
    if (orig['c_' + name]) return;
    orig['c_' + name] = con[name];
    con[name] = function(){
      try {
        if (tag === 'groupEnd') post({ phase:'console', level:'groupEnd', text:'┘' });
        else cemit(tag, arguments);
      } catch(e){}
      try { return orig['c_' + name].apply(con, arguments); } catch(e){}
    };
  }
  chook('log','log'); chook('info','info'); chook('warn','warn'); chook('error','error'); chook('debug','debug');
  chook('groupCollapsed','group'); chook('group','group'); chook('groupEnd','groupEnd');
  return 'installed:' + g.__rndevToken;
})()
`

/** 通道建立后多久没回包就判定失效（App 断点暂停 / 重载 / 代理异常时兜底重连） */
const WATCHDOG_MS = 3000
/** 心跳间隔：探活 + 按需重注入（App 重载 / Fast Refresh 会丢掉注入） */
const HEARTBEAT_MS = 4000
const RECONNECT_INTERVAL = 2000
const MAX_ENTRIES = 2000

interface DevRecord {
  phase: 'req' | 'res' | 'err' | 'console'
  id: string
  /** 运行时令牌（App 重载会换新的） */
  token?: string
  channel?: 'fetch' | 'xhr'
  method?: string
  url?: string
  headers?: Record<string, string>
  body?: string
  status?: number
  statusText?: string
  duration?: number
  error?: string
  /** phase='console'：console 级别（log/info/warn/error/debug/group/groupEnd）与格式化文本 */
  level?: string
  text?: string
}

export interface ConsoleRecord {
  level: string
  text: string
  deviceName: string
}

export class DevtoolsNetwork {
  private ws: WebSocket | null = null
  private entries: NetEntry[] = []
  private running = false
  private targetId: string | null = null
  /** 记住上一轮目标的 App / 设备，重连时优先回到同一个目标（避免漂到别的设备） */
  private targetApp = ''
  private targetDevice = ''
  private targets: DevTarget[] = []
  private hooked = false
  private lastInject = 0
  private attaches = 0
  private connectErr: string | null = null
  private metroPort = 8081
  private heartbeatTimer?: NodeJS.Timeout
  private burstTimer?: NodeJS.Timeout
  private reconnectTimer?: NodeJS.Timeout
  private cmdSeq = 1
  private waiting = new Map<number, (r: unknown) => void>()
  /** 一次性 socket 关闭回调（堆快照等流式命令以「chunk 推完后 Metro 主动关连接」作为完成信号） */
  private closeCbs = new Set<() => void>()
  private openedAt = 0
  private lastReplyAt = 0
  /** 最近一次注入得到的运行时令牌（用于识别 App 是否已重载） */
  private lastToken = ''

  private onEntryCb?: (e: NetEntry) => void
  private onStatusCb?: (s: DevStatus) => void
  private onLogCb?: (level: 'info' | 'warn' | 'error', text: string) => void
  private onConsoleCb?: (c: ConsoleRecord) => void
  private cdpEventCb?: (method: string, params: Record<string, unknown>) => void

  setOnEntry(cb: (e: NetEntry) => void) {
    this.onEntryCb = cb
  }
  setOnStatus(cb: (s: DevStatus) => void) {
    this.onStatusCb = cb
  }
  setOnLog(cb: (level: 'info' | 'warn' | 'error', text: string) => void) {
    this.onLogCb = cb
  }
  /** console 钩子回传（经 inspector 通道；是否入日志面板由调用方按设备门控） */
  setOnConsole(cb: (c: ConsoleRecord) => void) {
    this.onConsoleCb = cb
  }
  /** CDP 事件转发（HeapProfiler.addHeapSnapshotChunk 等流式事件），内存采集等模块订阅 */
  setCdpEventListener(cb: ((method: string, params: Record<string, unknown>) => void) | null) {
    this.cdpEventCb = cb
  }

  /**
   * 订阅当前调试连接的关闭（一次性），返回取消订阅函数。
   * 实测（RN 0.81 / Hermes + Metro inspector）：HeapProfiler.takeHeapSnapshot 把 chunk
   * 全部推完后 Metro 会以 code 1000 主动关闭连接，最终的 CDP response 常来不及送达 ——
   * 堆快照等流式命令必须把「连接关闭」也当作完成信号，否则永远等不到响应。
   */
  onceSocketClose(cb: () => void): () => void {
    this.closeCbs.add(cb)
    return () => {
      this.closeCbs.delete(cb)
    }
  }

  /** 内存页等外部模块用：当前目标的可读标签（appId @ deviceName） */
  targetLabel(): string {
    const t = this.targets.find((x) => x.id === this.targetId)
    return t ? `${t.appId || '?'} @ ${t.deviceName || '?'}` : this.targetId || '未连接'
  }

  /**
   * 通用 CDP 命令（复用 Metro inspector 通道 —— 通道「最近连接独占」，外部模块不能另开连接）。
   * 未连接时返回 undefined。注意：不要用于高频轮询，心跳/抓包逻辑仍由本类管理。
   */
  /**
   * 通用 CDP 命令（复用 Metro inspector 通道 —— 通道「最近连接独占」，外部模块不能另开连接）。
   * 未连接时返回 undefined。注意：不要用于高频轮询，心跳/抓包逻辑仍由本类管理。
   *
   * ⚠ 必须带超时：Metro 的 inspector 代理「首个连接可能落在收不到回包的通道上」（见类注释），
   * 若命令的 response 迟迟不来，Promise 会永久 pending，导致调用方（如内存快照）UI 永远卡在「进行中」。
   * 超时后按 CDP error 形式 resolve，让上层能正常清理并提示用户，而非无响应挂死。
   */
  call(method: string, params?: Record<string, unknown>, timeoutMs = 60000): Promise<unknown> {
    return new Promise((resolve) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return resolve(undefined)
      const id = this.cmd(method, params)
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        this.waiting.delete(id)
        this.log('warn', `devtools 命令超时（${Math.round(timeoutMs / 1000)}s 无响应）：${method}（通道可能已失活 / App 已暂停 / 落在无回包通道）`)
        resolve({ error: { message: `CDP 命令超时无响应：${method}` } })
      }, timeoutMs)
      this.waiting.set(id, (r) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(r)
      })
    })
  }

  get status(): DevStatus {
    return {
      running: this.running,
      attached: this.ws?.readyState === WebSocket.OPEN,
      hooked: this.hooked,
      targetId: this.targetId,
      metroPort: this.metroPort,
      error: this.connectErr,
      lastInject: this.lastInject,
      attaches: this.attaches
    }
  }
  private emitStatus() {
    this.onStatusCb?.(this.status)
  }
  private log(level: 'info' | 'warn' | 'error', text: string) {
    this.onLogCb?.(level, text)
  }

  list(): NetEntry[] {
    return this.entries
  }
  clear() {
    this.entries = []
  }

  /** 列出 Metro 上可调试的目标（取主 JS 运行时，即 Bridgeless 主 bundle） */
  async discover(metroPort = this.metroPort): Promise<DevTarget[]> {
    this.metroPort = metroPort
    let raw: unknown
    try {
      const res = await fetch(`http://127.0.0.1:${metroPort}/json/list`, {
        signal: AbortSignal.timeout(2500)
      })
      raw = await res.json()
    } catch (e) {
      this.connectErr = `Metro(${metroPort}) 不可达：${e instanceof Error ? e.message : String(e)}`
      this.targets = []
      this.emitStatus()
      return []
    }
    const arr = Array.isArray(raw) ? (raw as Record<string, unknown>[]) : []
    const list: DevTarget[] = []
    for (const t of arr) {
      const desc = String(t.description ?? '')
      // 只要主 JS 运行时：排除 Reanimated / UI runtime 这类辅助运行时
      if (!/Bridgeless/i.test(desc)) continue
      const wsUrl = String(t.webSocketDebuggerUrl ?? '')
      if (!wsUrl) continue
      const page = (() => {
        try {
          return new URL(wsUrl.replace(/^ws/, 'http')).searchParams.get('page') ?? ''
        } catch {
          return ''
        }
      })()
      const appId = String(t.appId ?? '')
      const deviceName = String(t.deviceName ?? '')
      list.push({
        id: String(t.id ?? `${appId}-${page}`),
        label: `${String(t.title ?? appId)}${deviceName ? ` — ${deviceName}` : ''}`,
        appId,
        deviceName,
        description: desc,
        wsUrl: wsUrl.replace(/localhost|127\.0\.0\.1/, '127.0.0.1'),
        page
      })
    }
    this.targets = list
    if (list.length) this.connectErr = null
    else if (!this.connectErr)
      this.connectErr = 'Metro 已连接，但没有可调试的 RN 应用（请在设备上打开 App 或确认是 Debug 包）'
    this.emitStatus()
    return list
  }

  listTargets(): DevTarget[] {
    return this.targets
  }

  async start(targetId: string | null, metroPort?: number): Promise<DevStatus> {
    if (metroPort) this.metroPort = metroPort
    this.running = true
    this.attaches = 0
    const list = await this.discover(this.metroPort)
    const t = (targetId && list.find((x) => x.id === targetId)) || list[0] || null
    if (!t) {
      this.connectErr = this.connectErr || '未找到可调试目标'
      this.emitStatus()
      this.scheduleReconnect()
      return this.status
    }
    this.attach(t)
    return this.status
  }

  stop(): void {
    this.running = false
    this.stopBurst()
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.heartbeatTimer = undefined
    this.reconnectTimer = undefined
    const ws = this.ws
    this.ws = null
    if (ws && ws.readyState === WebSocket.OPEN) {
      // 尽力卸载注入（失败也无妨，App 重启即恢复）
      try {
        ws.send(
          JSON.stringify({
            id: this.cmdSeq++,
            method: 'Runtime.evaluate',
            params: {
              expression: 'globalThis.__rndevUninstall && globalThis.__rndevUninstall()',
              returnByValue: true
            }
          })
        )
      } catch {
        /* ignore */
      }
      setTimeout(() => {
        try {
          ws.close()
        } catch {
          /* ignore */
        }
      }, 120)
    } else if (ws) {
      try {
        ws.close()
      } catch {
        /* ignore */
      }
    }
    this.hooked = false
    this.targetId = null
    this.emitStatus()
  }

  /** 手动重新注入（App 重载或 Fast Refresh 后可点） */
  reinject(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      void this.start(this.targetId, this.metroPort)
      return
    }
    this.hooked = false
    this.injectHook()
  }

  /** 是否抓取响应体（关闭可显著降低大响应带来的开销） */
  setBodyCapture(enabled: boolean): void {
    this.eval(
      `(function(){ globalThis.__rndevCfg = Object.assign({ body: true }, globalThis.__rndevCfg, { body: ${
        enabled ? 'true' : 'false'
      } }); return globalThis.__rndevCfg.body })()`
    )
  }

  /**
   * 重载 App 的 JS（CDP Page.reload）。注入后重载可抓到 App 启动阶段的请求 ——
   * 否则启动请求会早于注入发生。重载后拦截器需要重新注入，心跳会自动补上。
   */
  reloadApp(): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false
    this.send('Page.reload', { ignoreCache: false })
    this.hooked = false
    this.emitStatus()
    this.log('info', 'devtools 抓包：已触发 App 重载，正在抢装拦截器以捕获启动请求')
    this.startBurst()
    return true
  }

  private scheduleReconnect() {
    if (!this.running || this.reconnectTimer) return
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = undefined
      if (!this.running) return
      const list = await this.discover(this.metroPort)
      if (!list.length) {
        this.scheduleReconnect()
        return
      }
      // 优先回到同一个目标；实在找不到才退到「同 App 的其它设备」，最后才取第一个
      const t =
        (this.targetId && list.find((x) => x.id === this.targetId)) ||
        (this.targetApp && this.targetDevice && list.find((x) => x.appId === this.targetApp && x.deviceName === this.targetDevice)) ||
        (this.targetApp && list.find((x) => x.appId === this.targetApp)) ||
        list[0]
      this.attach(t)
    }, RECONNECT_INTERVAL)
  }

  private attach(t: DevTarget) {
    try {
      this.ws?.removeAllListeners()
      this.ws?.close()
    } catch {
      /* ignore */
    }
    const switched = !!this.targetId && this.targetId !== t.id
    this.targetId = t.id
    this.targetApp = t.appId
    this.targetDevice = t.deviceName
    this.hooked = false
    this.connectErr = null
    this.attaches += 1
    this.emitStatus()
    this.log('info', `devtools 抓包：正在连接 ${t.label}`)
    if (switched) this.log('warn', `devtools 抓包：原目标已消失，已切到 ${t.appId} @ ${t.deviceName}`)

    const ws = new WebSocket(t.wsUrl, { perMessageDeflate: false, handshakeTimeout: 8000 })
    this.ws = ws

    ws.on('open', () => {
      this.connectErr = null
      this.openedAt = Date.now()
      this.lastReplyAt = 0
      this.emitStatus()
      this.log('info', `devtools 抓包：已连接 ${t.label}（${t.appId || 'unknown'}）`)
      this.send('Runtime.addBinding', { name: '__rndevNet' })
      this.injectHook()
      if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = setInterval(() => this.heartbeat(), HEARTBEAT_MS)
    })
    ws.on('message', (data: Buffer | string) => this.handleMessage(data))
    ws.on('error', (e: Error) => {
      this.connectErr = e.message
      this.emitStatus()
    })
    ws.on('close', () => {
      this.hooked = false
      this.stopBurst()
      if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = undefined
      this.emitStatus()
      const cbs = [...this.closeCbs]
      this.closeCbs.clear()
      for (const cb of cbs) {
        try {
          cb()
        } catch {
          /* ignore */
        }
      }
      if (this.running) {
        this.log('warn', 'devtools 抓包：连接已断开，等待重连…')
        this.scheduleReconnect()
      }
    })
  }

  private cmd(method: string, params?: Record<string, unknown>): number {
    const id = this.cmdSeq++
    try {
      this.ws?.send(JSON.stringify({ id, method, params }))
    } catch {
      /* ignore */
    }
    return id
  }
  private send(method: string, params?: Record<string, unknown>) {
    this.cmd(method, params)
  }

  private eval(expression: string, awaitPromise = false): number {
    return this.cmd('Runtime.evaluate', { expression, returnByValue: true, awaitPromise })
  }

  private injectHook(burst = false) {
    // burst 场景：token 未变（context 未销毁，如 iOS reload 重跑 bundle）但 hook 被新
    // polyfill 覆盖时不能短路 —— 必须继续重注入
    const expr =
      burst && this.lastToken
        ? `(function(){ var g = globalThis; if (g.__rndevToken === ${JSON.stringify(this.lastToken)} && typeof g.__rndevIntact === 'function' && g.__rndevIntact()) return 'old-runtime'; return String(${HOOK_SRC}) })()`
        : HOOK_SRC
    const id = this.eval(expr)
    this.waiting.set(id, (r) => {
      const res = r as { result?: { value?: string } } | undefined
      const val = String(res?.result?.value ?? '')
      if (val.startsWith('installed:') || val.startsWith('already:')) {
        const token = val.slice(val.indexOf(':') + 1)
        const first = !this.hooked
        this.hooked = true
        if (token) this.lastToken = token
        this.lastInject = Date.now()
        this.stopBurst()
        this.emitStatus()
        if (first) this.log('info', 'devtools 抓包：拦截器已注入，开始捕获 fetch / XHR')
      } else if (val === 'old-runtime') {
        // 还在旧运行时上，等待重启完成
      } else if (!burst) {
        this.log('warn', `devtools 抓包：注入返回 ${val}`)
      }
    })
  }

  /** 重载 App 后短时间内高频重注入，尽量抢在 App 启动请求之前把拦截器装上 */
  private startBurst() {
    this.stopBurst()
    const until = Date.now() + 9000
    this.burstTimer = setInterval(() => {
      if (Date.now() > until || !this.running || this.ws?.readyState !== WebSocket.OPEN) {
        this.stopBurst()
        return
      }
      if (!this.hooked) this.injectHook(true)
    }, 250)
  }
  private stopBurst() {
    if (this.burstTimer) clearInterval(this.burstTimer)
    this.burstTimer = undefined
  }

  /**
   * 心跳：既判断「拦截器是否还在」（App 重载 / Fast Refresh 会丢掉注入），
   * 也做通道探活。RN 的 inspector 代理只把 CDP 流量转发给最近一次调度的
   * 调试通道，首连有可能落在一个收不到回包的通道上 —— 主动断开重连即可自愈。
   */
  private heartbeat() {
    if (!this.running) return
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return
    if (this.openedAt && Date.now() - this.openedAt > WATCHDOG_MS && this.lastReplyAt < this.openedAt) {
      this.log('warn', 'devtools 抓包：调试通道无响应，正在重连…')
      this.forceReconnect()
      return
    }
    // 完整性检测：标记 + 两个 hook 是否仍挂在（可能被 App 重载重赋值的）对象上
    const id = this.eval(
      `(function(){ var g = globalThis; return typeof g.__rndevIntact === 'function' ? g.__rndevIntact() : (g.__rndevHooked === true) })()`
    )
    this.waiting.set(id, (r) => {
      const res = r as { result?: { value?: boolean } } | undefined
      if (res?.result?.value !== true) {
        this.hooked = false
        this.emitStatus()
        this.log('info', 'devtools 抓包：注入已失效（App 重载），自动重新注入')
        this.injectHook()
      } else if (!this.hooked) {
        this.hooked = true
        this.emitStatus()
      }
    })
  }

  /** 通道失活：断开让 close 处理器走重连（相当于重新向设备注册调试通道） */
  private forceReconnect() {
    this.hooked = false
    this.stopBurst()
    this.openedAt = 0
    this.lastReplyAt = 0
    const ws = this.ws
    this.ws = null
    try {
      ws?.terminate()
    } catch {
      try {
        ws?.close()
      } catch {
        /* ignore */
      }
    }
    this.emitStatus()
    if (this.running) this.scheduleReconnect()
  }

  private handleMessage(data: Buffer | string) {
    this.lastReplyAt = Date.now()
    let msg: {
      id?: number
      method?: string
      params?: Record<string, unknown>
      result?: unknown
      error?: unknown
    }
    try {
      msg = JSON.parse(typeof data === 'string' ? data : data.toString('utf8'))
    } catch {
      return
    }
    if (msg.id != null && this.waiting.has(msg.id)) {
      const cb = this.waiting.get(msg.id)
      this.waiting.delete(msg.id)
      cb?.(msg.result ?? msg.error)
      return
    }
    if (msg.method) {
      this.cdpEventCb?.(msg.method, (msg.params ?? {}) as Record<string, unknown>)
    }
    if (msg.method === 'Runtime.bindingCalled') {
      const p = msg.params as { name?: string; payload?: string } | undefined
      if (p?.name !== '__rndevNet' || typeof p.payload !== 'string') return
      let rec: DevRecord
      try {
        rec = JSON.parse(p.payload)
      } catch {
        return
      }
      this.applyRecord(rec)
    }
  }

  private find(id: string) {
    return this.entries.find((x) => x.id === id)
  }
  private emit(e: NetEntry) {
    this.onEntryCb?.(e)
  }

  private applyRecord(rec: DevRecord) {
    if (!rec || typeof rec !== 'object') return
    const target = this.targets.find((t) => t.id === this.targetId)
    const app = target?.appId || undefined

    if (rec.phase === 'console') {
      this.onConsoleCb?.({
        level: String(rec.level || 'log'),
        text: String(rec.text ?? ''),
        deviceName: target?.deviceName || this.targetDevice || ''
      })
      return
    }
    // 带上运行时令牌：App 重载后序号会重头开始，避免覆盖上一轮的条目
    const id = `D${rec.token || 'x'}-${String(rec.id ?? '')}`

    if (rec.phase === 'req') {
      const url = String(rec.url || '')
      if (!url) return
      const { scheme, host } = splitUrl(url)
      const entry: NetEntry = {
        id,
        method: String(rec.method || 'GET').toUpperCase(),
        scheme,
        host,
        url,
        name: urlName(url),
        type: guessType(undefined, url),
        app,
        source: 'devtools',
        channel: rec.channel,
        startTime: Date.now(),
        requestHeaders: rec.headers || {},
        reqBody: rec.body,
        reqBytes: rec.body ? rec.body.length : undefined
      }
      if (!this.find(id)) {
        this.entries.unshift(entry)
        if (this.entries.length > MAX_ENTRIES) this.entries.pop()
      }
      this.emit(entry)
      return
    }

    const e = this.find(id)
    if (rec.phase === 'res') {
      const ct = rec.headers?.['content-type'] || rec.headers?.['Content-Type']
      const duration = typeof rec.duration === 'number' ? rec.duration : undefined
      const patch: Partial<NetEntry> = {
        status: typeof rec.status === 'number' ? rec.status : e?.status,
        statusText: rec.statusText,
        responseHeaders: rec.headers || {},
        resBody: rec.body,
        resBytes: rec.body ? rec.body.length : undefined,
        duration,
        type: guessType(ct, e?.url || '')
      }
      if (e) {
        Object.assign(e, patch)
        e.endTime = e.startTime + (duration ?? 0)
        this.emit(e)
      } else {
        const url = ''
        const { scheme, host } = splitUrl(url)
        const fallback: NetEntry = {
          id,
          method: 'GET',
          scheme,
          host,
          url,
          name: urlName(url),
          type: guessType(ct, url),
          app,
          source: 'devtools',
          channel: rec.channel,
          startTime: Date.now(),
          ...patch
        }
        this.entries.unshift(fallback)
        this.emit(fallback)
      }
      return
    }

    if (rec.phase === 'err' && e) {
      e.error = rec.error || 'failed'
      e.endTime = Date.now()
      this.emit(e)
    }
  }
}

export const devtoolsNetwork = new DevtoolsNetwork()
