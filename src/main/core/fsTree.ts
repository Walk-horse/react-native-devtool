import { promises as fs } from 'fs'
import { join } from 'path'

export interface FsEntry {
  name: string
  path: string
  isDir: boolean
}

/**
 * 目录树中隐藏的重型 / 无关目录。
 * 这些都是 IDE 默认不展开的内容，展开会让目录树被依赖与产物淹没。
 */
const HIDDEN = new Set([
  'node_modules',
  '.git',
  '.svn',
  '.hg',
  '.gradle',
  '.idea',
  '.expo',
  'Pods',
  'DerivedData',
  '__pycache__',
  'build',
  'dist',
  '.DS_Store'
])

const MAX_ENTRIES = 2000

/** 列举目录一层内容（懒加载用），目录优先、忽略大小写排序 */
export async function listDir(dir: string): Promise<FsEntry[] | { error: string }> {
  try {
    const items = await fs.readdir(dir, { withFileTypes: true })
    const out: FsEntry[] = []
    for (const it of items) {
      if (HIDDEN.has(it.name)) continue
      if (out.length >= MAX_ENTRIES) break
      let isDir = it.isDirectory()
      // 符号链接：判定其真实类型，避免展开报错
      if (it.isSymbolicLink()) {
        try {
          isDir = (await fs.stat(join(dir, it.name))).isDirectory()
        } catch {
          isDir = false
        }
      }
      out.push({ name: it.name, path: join(dir, it.name), isDir })
    }
    out.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
      return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
    })
    return out
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) }
  }
}

/** 判断路径是否为目录（供后续按需使用） */
export async function isDirectory(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isDirectory()
  } catch {
    return false
  }
}
