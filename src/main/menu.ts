import { Menu, BrowserWindow, shell, app } from 'electron'
import type { MenuItemConstructorOptions } from 'electron'
import { join } from 'path'

/**
 * 构建应用菜单。
 * 左侧工程面板已移除，这里只保留与设备镜像 / 数据目录相关的基础项。
 */
export function buildAppMenu(getWindow: () => BrowserWindow | null) {
  const isMac = process.platform === 'darwin'

  const fileMenu: MenuItemConstructorOptions = {
    label: '文件',
    submenu: [
      { label: '打开 RN Dev Tool 数据目录', click: () => shell.openPath(join(app.getPath('home'), '.rn-dev-tool')) },
      { type: 'separator' },
      isMac ? { role: 'close', label: '关闭窗口' } : { role: 'quit', label: '退出' }
    ]
  }

  const viewMenu: MenuItemConstructorOptions = {
    label: '视图',
    submenu: [
      { role: 'resetZoom', label: '实际大小' },
      { role: 'zoomIn', label: '放大' },
      { role: 'zoomOut', label: '缩小' },
      { type: 'separator' },
      { role: 'togglefullscreen', label: '全屏' },
      { role: 'toggleDevTools', label: '开发者工具' },
      { role: 'reload', label: '重新加载' }
    ]
  }

  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? ([{ role: 'appMenu' }] as MenuItemConstructorOptions[]) : []),
    fileMenu,
    { role: 'editMenu', label: '编辑' },
    viewMenu,
    { role: 'windowMenu', label: '窗口' }
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
