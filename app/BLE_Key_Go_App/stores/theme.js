/**
 * Theme Store — light / dark / auto 主题管理
 *
 * 原理（参考 my-uniapp 验证过的方案）：
 *   - App.vue 定义 .theme-dark / .theme-light 两套 CSS 变量
 *   - 每个页面根 view 绑定 :class="themeClass"
 *   - 所有颜色通过 var(--xxx) 引用 → 切换 class 即切换整套配色
 *   - 不依赖 JS setProperty，纯 CSS class 切换，跨平台可靠
 *   - 原生导航栏通过 uni.setNavigationBarColor() 适配
 *   - CustomTabBar 是 Vue 组件，直接跟随 CSS 变量
 */

import { defineStore } from 'pinia'
import { ref, computed } from 'vue'

const STORAGE_KEY = 'app_theme_mode'

function getSystemTheme() {
  try {
    const info = uni.getSystemInfoSync()
    return info.theme || 'dark'
  } catch {
    return 'dark'
  }
}

export const useThemeStore = defineStore('theme', () => {
  // ---- state ----
  const mode = ref('auto')   // 'light' | 'dark' | 'auto'，默认跟随系统
  const systemTheme = ref('dark')

  // ---- getters ----
  const effective = computed(() => {
    if (mode.value === 'auto') return systemTheme.value
    return mode.value
  })
  const isDark = computed(() => effective.value === 'dark')
  const isLight = computed(() => effective.value === 'light')

  /** 供页面根 view :class 绑定，返回 'theme-dark' 或 'theme-light' */
  const themeClass = computed(() => 'theme-' + effective.value)

  const modeLabel = computed(() => {
    const map = { light: '亮色', dark: '暗色', auto: '自动' }
    return map[mode.value] || '自动'
  })

  // ---- actions ----

  /** 更新原生导航栏颜色 */
  function applyNavBar() {
    try {
      const dark = isDark.value
      uni.setNavigationBarColor({
        frontColor: dark ? '#ffffff' : '#000000',
        backgroundColor: dark ? '#1a1a2e' : '#ffffff',
        animation: { duration: 300, timingFunc: 'easeInOut' }
      })
    } catch { /* ignore */ }
  }

  /** 切换模式并持久化 */
  function setMode(newMode) {
    if (!['light', 'dark', 'auto'].includes(newMode)) return
    mode.value = newMode
    uni.setStorageSync(STORAGE_KEY, newMode)
    applyNavBar()
    uni.$emit('themeChange', { mode: newMode })
  }

  /** 循环切换（快捷入口用） */
  function cycleMode() {
    const order = ['dark', 'light', 'auto']
    const idx = order.indexOf(mode.value)
    setMode(order[(idx + 1) % order.length])
  }

  /** 初始化（App.vue onLaunch 中调用） */
  function init() {
    // 1. 读取持久化的模式
    try {
      const saved = uni.getStorageSync(STORAGE_KEY)
      if (saved && ['light', 'dark', 'auto'].includes(saved)) {
        mode.value = saved
      }
    } catch { /* use default 'auto' */ }

    // 2. 检测当前系统主题
    systemTheme.value = getSystemTheme()

    // 3. 应用导航栏
    applyNavBar()

    // 4. 监听系统主题变化
    try {
      uni.onThemeChange((res) => {
        systemTheme.value = res.theme || 'dark'
        if (mode.value === 'auto') {
          applyNavBar()
        }
      })
    } catch { /* ignore */ }
  }

  return {
    mode, systemTheme, effective,
    isDark, isLight, themeClass,
    modeLabel,
    init, setMode, cycleMode, applyNavBar,
  }
})
