import * as http from 'http'
import * as https from 'https'
import * as net from 'net'
import * as tls from 'tls'
import { URL } from 'url'
import { networkInterfaces } from 'os'
import { leafFor } from './certAuthority'
import { appResolver } from './appResolver'
import { NetEntry, MAX_BODY, urlName, guessType } from './netUtil'

// 条目类型集中在 netUtil，此处再导出以兼容既有引用
export type { NetEntry }

const MAX_ENTRIES = 2000

export function getLanIp(): string {
  const ifaces = networkInterfaces()
  for (const name of Object.keys(ifaces)) {
    for (const i of ifaces[name] || []) {
      if (i.family === 'IPv4' && !i.internal) return i.address
    }
  }
  return '127.0.0.1'
}

export class NetworkMonitor {
  private server: http.Server | null = null
  private decryptServer: http.Server | null = null
  private entries: NetEntry[] = []
  private port = 0
  private seq = 0
  private mitm = false
  private onEntryCb?: (e: NetEntry) => void

  setOnEntry(cb: (e: NetEntry) => void) {
    this.onEntryCb = cb
  }
  setMitm(enabled: boolean) {
    this.mitm = enabled
  }
  get mitmEnabled() {
    return this.mitm
  }
  get running() {
    return this.server !== null
  }
  get listenPort() {
    return this.port
  }
  list(): NetEntry[] {
    return this.entries
  }
  clear() {
    this.entries = []
  }

  start(port = 8899): Promise<number> {
    return new Promise((resolve, reject) => {
      if (this.server) return resolve(this.port)
      // 解密后的 HTTPS 请求在这里被解析（复用 http.Server 作为解析器）
      this.decryptServer = http.createServer((req, res) => this.handleProxy(req, res, 'https'))
      const server = http.createServer((req, res) => this.handleProxy(req, res, 'http'))
      server.on('connect', (req, socket, head) => this.handleConnect(req, socket, head))
      server.on('error', (e) => reject(e))
      server.listen(port, '0.0.0.0', () => {
        this.server = server
        const addr = server.address()
        this.port = typeof addr === 'object' && addr ? addr.port : port
        resolve(this.port)
      })
    })
  }

  stop() {
    if (this.server) {
      this.server.close()
      this.server = null
    }
    if (this.decryptServer) {
      this.decryptServer.close()
      this.decryptServer = null
    }
    this.port = 0
  }

  private emit(e: NetEntry) {
    this.onEntryCb?.(e)
  }
  private find(id: string) {
    return this.entries.find((x) => x.id === id)
  }
  private push(e: NetEntry) {
    this.entries.push(e)
    if (this.entries.length > MAX_ENTRIES) this.entries.shift()
  }

  /** 指定用于应用识别的 Android 设备（serial）；null 关闭识别 */
  setTargetDevice(serial: string | null) {
    appResolver.setDevice(serial)
  }
  appStats() {
    return appResolver.stats()
  }

  /** 用设备侧端口反查请求归属的应用；命中后补发一次更新 */
  private async attributeApp(id: string, port?: number) {
    if (!port) return
    const app = await appResolver.appForPort(port)
    const e = this.find(id)
    if (e && app && e.app !== app) {
      e.app = app
      this.emit(e)
    }
  }

  private handleProxy(req: http.IncomingMessage, res: http.ServerResponse, scheme: 'http' | 'https') {
    let targetHost: string
    let targetPath: string
    let url: string

    if (scheme === 'http') {
      try {
        const u = new URL(req.url || '')
        targetHost = u.host
        targetPath = u.pathname + u.search
        url = u.toString()
      } catch {
        res.writeHead(400)
        res.end('bad request')
        return
      }
    } else {
      // 解密后的请求：req.url 为路径，host 在 Host 头 / CONNECT 主机上
      const connHost = (req.socket as unknown as { __mitmHost?: string }).__mitmHost
      targetHost = req.headers.host || connHost || ''
      targetPath = req.url || '/'
      url = `https://${targetHost}${targetPath}`
    }

    const id = String(this.seq++)
    const clientPort = req.socket.remotePort
    const entry: NetEntry = {
      id,
      method: req.method || 'GET',
      scheme,
      source: 'proxy',
      host: targetHost,
      url,
      name: urlName(url),
      type: guessType(undefined, url),
      clientPort,
      startTime: Date.now(),
      requestHeaders: this.normHeaders(req.headers)
    }
    this.push(entry)
    this.emit(entry)
    void this.attributeApp(id, clientPort)

    let reqBytes = 0
    const reqChunks: Buffer[] = []
    req.on('data', (c: Buffer) => {
      reqBytes += c.length
      if (reqBytes <= MAX_BODY) reqChunks.push(c)
    })
    req.on('end', () => {
      const e = this.find(id)
      if (e && reqChunks.length) {
        e.reqBody = Buffer.concat(reqChunks).toString('utf8').slice(0, MAX_BODY)
        e.reqBytes = reqBytes
        this.emit(e)
      }
    })

    const headers = { ...req.headers }
    delete (headers as Record<string, unknown>)['proxy-connection']
    delete (headers as Record<string, unknown>)['proxy-authorization']
    delete (headers as Record<string, unknown>)['accept-encoding'] // 便于可读的响应体

    const hostname = targetHost.split(':')[0]
    const targetPort = targetHost.includes(':')
      ? parseInt(targetHost.split(':')[1], 10)
      : scheme === 'https'
        ? 443
        : 80
    const options: https.RequestOptions = {
      method: req.method,
      headers,
      hostname,
      port: targetPort,
      path: targetPath,
      // 调试代理：忽略上游证书问题（内部/自签名证书常见）
      rejectUnauthorized: false
    }
    if (scheme === 'https') (options as tls.ConnectionOptions).servername = hostname

    const client = scheme === 'https' ? https : http
    const proxyReq = client.request(options, (proxyRes) => {
      const e = this.find(id)
      if (e) {
        e.status = proxyRes.statusCode
        e.responseHeaders = this.normHeaders(proxyRes.headers)
        e.type = guessType(proxyRes.headers['content-type'], url)
        e.endTime = Date.now()
        e.duration = e.endTime - e.startTime
      }
      let resBytes = 0
      const resChunks: Buffer[] = []
      proxyRes.on('data', (c: Buffer) => {
        resBytes += c.length
        if (resBytes <= MAX_BODY) resChunks.push(c)
      })
      proxyRes.on('end', () => {
        const e2 = this.find(id)
        if (e2) {
          if (e2.endTime == null) {
            e2.endTime = Date.now()
            e2.duration = e2.endTime - e2.startTime
          }
          e2.resBytes = resBytes
          if (resChunks.length) e2.resBody = Buffer.concat(resChunks).toString('utf8').slice(0, MAX_BODY)
          this.emit(e2)
        }
      })
      res.writeHead(proxyRes.statusCode || 502, proxyRes.headers)
      proxyRes.pipe(res)
    })
    proxyReq.on('error', (err) => {
      const e = this.find(id)
      if (e) {
        e.error = err.message
        e.endTime = Date.now()
        e.duration = e.endTime - e.startTime
        this.emit(e)
      }
      res.writeHead(502)
      res.end('proxy error')
    })
    req.pipe(proxyReq)
  }

  private handleConnect(req: http.IncomingMessage, clientSocket: net.Socket, head: Buffer) {
    const [host, portStr] = (req.url || '').split(':')
    const port = parseInt(portStr || '443', 10)
    const clientPort = clientSocket.remotePort

    // 未开启 MITM：盲隧道，仅记录主机
    if (!this.mitm) {
      const id = String(this.seq++)
      const url = `https://${host}:${port}/`
      const entry: NetEntry = {
        id,
        method: 'CONNECT',
        scheme: 'https',
        source: 'proxy',
        host: `${host}:${port}`,
        url,
        name: host,
        type: 'other',
        clientPort,
        startTime: Date.now()
      }
      this.push(entry)
      this.emit(entry)
      void this.attributeApp(id, clientPort)
      const serverSocket = net.connect(port, host, () => {
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        serverSocket.pipe(clientSocket)
        clientSocket.pipe(serverSocket)
        const e = this.find(id)
        if (e) {
          e.status = 200
          e.endTime = Date.now()
          e.duration = e.endTime - e.startTime
          this.emit(e)
        }
      })
      serverSocket.on('error', (err) => {
        const e = this.find(id)
        if (e) {
          e.error = err.message
          e.endTime = Date.now()
          e.duration = e.endTime - e.startTime
          this.emit(e)
        }
        clientSocket.destroy()
      })
      clientSocket.on('error', () => serverSocket.destroy())
      return
    }

    // MITM：用 CA 动态签发该域名的证书，解密后再解析 HTTP
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
    if (head && head.length) clientSocket.unshift(head)
    let leaf: { key: string; cert: string }
    try {
      leaf = leafFor(host)
    } catch {
      clientSocket.destroy()
      return
    }
    const tlsSocket = new tls.TLSSocket(clientSocket, {
      isServer: true,
      key: leaf.key,
      cert: leaf.cert,
      handshakeTimeout: 10000
    })
    ;(tlsSocket as unknown as { __mitmHost?: string }).__mitmHost = `${host}:${port}`
    tlsSocket.on('error', () => tlsSocket.destroy())
    tlsSocket.on('close', () => clientSocket.destroy())
    this.decryptServer?.emit('connection', tlsSocket)
  }

  private normHeaders(h: http.IncomingHttpHeaders | http.OutgoingHttpHeaders): Record<string, string> {
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(h)) {
      if (v == null) continue
      out[k] = Array.isArray(v) ? v.join(', ') : String(v)
    }
    return out
  }
}

export const networkMonitor = new NetworkMonitor()
