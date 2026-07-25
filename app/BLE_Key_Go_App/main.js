import { createSSRApp } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import App from './App.vue'

// ★ 2026-07-25 mp-weixin 多实例修复：每个 Page 加载都会调用一次 createApp()，
//   默认每次都会 new 一个新 Pinia，导致 bleStore/themeStore 在每个页面独立，
//   表现为「控制页 connected=true、连接页 connected=false」等矛盾状态
//   （已知设备卡在控制页隐藏却在连接页显示 / 红绿 banner 同步与控制 UI 矛盾）。
//   解决：把 Pinia 实例挂到 globalThis 上（uni-app 编译 mp-weixin 时 main.js 会被各 page 内联，
//   模块级变量不是真正全局；globalThis = wx 全局对象，跨 page 共享），
//   每次 createApp() 都强制 setActivePinia 到这一份。
//   副作用：所有页面的 store 必须共享同一个 Pinia（项目只有 ble 和 theme 两个，均兼容）。
const PINIA_KEY = '__keygoSharedPinia'

export function createApp() {
  let pinia = globalThis[PINIA_KEY]
  if (!pinia) {
    pinia = createPinia()
    globalThis[PINIA_KEY] = pinia
  }
  // ★ 强制激活共享 Pinia，确保各 page 内 useBleStore/useThemeStore 拿到同一份实例
  setActivePinia(pinia)
  const app = createSSRApp(App)
  app.use(pinia)
  return { app }
}