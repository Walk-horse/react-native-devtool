import { spawn, ChildProcess } from 'child_process'
import { RawLog, guessLevel } from './logBus'

const runners = new Map<string, ChildProcess>()

/**
 * 运行工程（npm run ios|android）。Metro / 构建器的 console 输出逐行回传，
 * 由 logBus 打上 source='metro' 后进入「运行日志」。
 */
export function runProject(
  platform: 'ios' | 'android',
  projectPath: string,
  onLog: (raw: RawLog) => void
): Promise<void> {
  return new Promise((resolve) => {
    const script = platform === 'ios' ? 'ios' : 'android'
    const child = spawn('npm', ['run', script], { cwd: projectPath, shell: true })

    runners.set(platform, child)

    const handle = (d: Buffer) => {
      for (const l of d.toString().split('\n')) {
        const t = l.replace(/\r/g, '').trimEnd()
        if (!t.trim()) continue
        onLog({ level: guessLevel(t), source: 'metro', text: t })
      }
    }
    child.stdout?.on('data', handle)
    child.stderr?.on('data', handle)
    child.on('close', (code) => {
      runners.delete(platform)
      onLog({
        level: code === 0 || code === null ? 'info' : 'warn',
        source: 'metro',
        text: `npm run ${script} 已退出${code === null ? '' : `（code=${code}）`}`
      })
      resolve()
    })
    child.on('error', (e) => {
      onLog({ level: 'error', source: 'metro', text: `启动失败：${e.message}` })
      resolve()
    })
  })
}

export function stopRun(platform: 'ios' | 'android') {
  const c = runners.get(platform)
  if (c) {
    c.kill('SIGTERM')
    runners.delete(platform)
  }
}
