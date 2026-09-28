import fs from 'fs'
import path from 'path'
import { app } from 'electron'
import { randomUUID } from 'crypto'

export interface RNProject {
  id: string
  name: string
  path: string
  hasIOS: boolean
  hasAndroid: boolean
  rnVersion?: string
  packageName?: string
}

const storeFile = path.join(app.getPath('userData'), 'projects.json')
let projects: RNProject[] = load()

function load(): RNProject[] {
  try {
    return JSON.parse(fs.readFileSync(storeFile, 'utf8'))
  } catch {
    return []
  }
}

function save() {
  fs.writeFileSync(storeFile, JSON.stringify(projects, null, 2))
}

function scan(p: string) {
  const pkgPath = path.join(p, 'package.json')
  if (!fs.existsSync(pkgPath)) return null
  let pkg: any
  try {
    pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
  } catch {
    return null
  }
  if (!pkg.dependencies?.['react-native']) return null

  const hasIOS = fs.existsSync(path.join(p, 'ios'))
  const hasAndroid = fs.existsSync(path.join(p, 'android'))

  let packageName: string | undefined
  const gradle = path.join(p, 'android', 'app', 'build.gradle')
  if (fs.existsSync(gradle)) {
    const t = fs.readFileSync(gradle, 'utf8')
    const m = t.match(/applicationId\s+["']([^"']+)["']/)
    if (m) packageName = m[1]
  }

  return {
    name: pkg.name || path.basename(p),
    path: p,
    hasIOS,
    hasAndroid,
    rnVersion: pkg.dependencies['react-native'],
    packageName
  }
}

export function scanProject(p: string) {
  return scan(p)
}

export function listProjects(): RNProject[] {
  return projects
}

export function addProject(p: string): RNProject | { error: string } {
  const info = scan(p)
  if (!info) return { error: '不是有效的 React Native 工程（缺少含 react-native 依赖的 package.json）' }
  if (projects.find((x) => x.path === p)) return { error: '该工程已添加' }
  const proj: RNProject = { id: randomUUID(), ...info }
  projects.push(proj)
  save()
  return proj
}

export function removeProject(id: string) {
  projects = projects.filter((p) => p.id !== id)
  save()
}
