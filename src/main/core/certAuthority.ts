import * as forge from 'node-forge'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

const DIR = path.join(os.homedir(), '.rn-dev-tool')
const CA_KEY_FILE = path.join(DIR, 'mitm-ca.key')
const CA_CRT_FILE = path.join(DIR, 'mitm-ca.crt')

let caCache: { key: string; cert: string } | null = null
const leafCache = new Map<string, { key: string; cert: string }>()

function isIp(h: string) {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(h)
}

function ensureDir() {
  if (!fs.existsSync(DIR)) fs.mkdirSync(DIR, { recursive: true })
}

/** 载入或生成根 CA（持久化到 ~/.rn-dev-tool，便于一次性安装到设备） */
export function ensureCA(): { key: string; cert: string } {
  if (caCache) return caCache
  ensureDir()
  if (fs.existsSync(CA_KEY_FILE) && fs.existsSync(CA_CRT_FILE)) {
    caCache = { key: fs.readFileSync(CA_KEY_FILE, 'utf8'), cert: fs.readFileSync(CA_CRT_FILE, 'utf8') }
    return caCache
  }
  const keys = forge.pki.rsa.generateKeyPair(2048)
  const cert = forge.pki.createCertificate()
  cert.publicKey = keys.publicKey
  cert.serialNumber = '01' + Date.now().toString(16)
  cert.validity.notBefore = new Date(Date.now() - 24 * 3600 * 1000)
  cert.validity.notAfter = new Date(Date.now() + 10 * 365 * 24 * 3600 * 1000)
  const attrs = [
    { name: 'commonName', value: 'RN Dev Tool CA' },
    { name: 'organizationName', value: 'RN Dev Tool' },
    { name: 'countryName', value: 'CN' }
  ]
  cert.setSubject(attrs)
  cert.setIssuer(attrs)
  cert.setExtensions([
    { name: 'basicConstraints', cA: true, critical: true },
    { name: 'keyUsage', keyCertSign: true, cRLSign: true, digitalSignature: true, critical: true },
    { name: 'subjectKeyIdentifier' }
  ])
  cert.sign(keys.privateKey, forge.md.sha256.create())
  const keyPem = forge.pki.privateKeyToPem(keys.privateKey)
  const certPem = forge.pki.certificateToPem(cert)
  fs.writeFileSync(CA_KEY_FILE, keyPem, { mode: 0o600 })
  fs.writeFileSync(CA_CRT_FILE, certPem)
  caCache = { key: keyPem, cert: certPem }
  return caCache
}

/** 根 CA 证书文件路径（供安装/推送） */
export function caCertPath(): string {
  ensureCA()
  return CA_CRT_FILE
}

/** 为指定域名签发叶证书（内存缓存，避免重复生成 RSA 密钥） */
export function leafFor(host: string): { key: string; cert: string } {
  const hit = leafCache.get(host)
  if (hit) return hit
  const ca = ensureCA()
  const caKey = forge.pki.privateKeyFromPem(ca.key)
  const caCert = forge.pki.certificateFromPem(ca.cert)

  const keys = forge.pki.rsa.generateKeyPair(2048)
  const cert = forge.pki.createCertificate()
  cert.publicKey = keys.publicKey
  cert.serialNumber = '02' + Date.now().toString(16) + Math.floor(Math.random() * 1e6).toString(16)
  cert.validity.notBefore = new Date(Date.now() - 24 * 3600 * 1000)
  cert.validity.notAfter = new Date(Date.now() + 2 * 365 * 24 * 3600 * 1000)
  cert.setSubject([{ name: 'commonName', value: host }])
  cert.setIssuer(caCert.subject.attributes)
  const altName = isIp(host) ? { type: 7, ip: host } : { type: 2, value: host }
  cert.setExtensions([
    { name: 'basicConstraints', cA: false },
    { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, critical: true },
    { name: 'extKeyUsage', serverAuth: true },
    { name: 'subjectAltName', altNames: [altName] }
  ])
  cert.sign(caKey, forge.md.sha256.create())

  const leaf = { key: forge.pki.privateKeyToPem(keys.privateKey), cert: forge.pki.certificateToPem(cert) }
  leafCache.set(host, leaf)
  return leaf
}
