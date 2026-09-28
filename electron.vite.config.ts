import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        // ws 被 rollup 打包后在本进程收不到数据帧（只收到控制帧），
        // 保留为运行时外部依赖，直接加载 node_modules 里的真实实现。
        external: ['ws']
      }
    }
  },
  preload: {},
  renderer: {
    plugins: [react()],
    server: {
      port: 5173
    }
  }
})
