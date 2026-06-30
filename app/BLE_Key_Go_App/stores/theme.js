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
    // 1. 微信小程序原生 API（最可靠）
    // #ifdef MP-WEIXIN
    if (typeof wx !== 'undefined' && wx.getSystemInfoSync) {
      const wxInfo = wx.getSystemInfoSync()
      if (wxInfo.theme) {
        console.log('[Theme] wx.getSystemInfoSync 检测:', wxInfo.theme)
        return wxInfo.theme
      }
    }
    // #endif

    // 2. uni-app 通用 API
    const info = uni.getSystemInfoSync()

    // ★ uni-app 不同平台字段名不同：
    //    - iOS/部分版本: info.theme
    //    - Android:       info.osTheme  (系统主题)
    //    - 宿主(微信等):    info.hostTheme
    // 优先级: theme > osTheme > hostTheme
    const t = info.theme || info.osTheme || info.hostTheme
    console.log('[Theme] 系统检测 theme=', info.theme,
      '| osTheme=', info.osTheme,
      '| hostTheme=', info.hostTheme,
      '→ 使用:', t)
    if (t) return t

    // 全部不可用
    console.warn('[Theme] ⚠️ 所有途径无法检测系统主题，降级为 light')
    return 'light'
  } catch (e) {
    console.error('[Theme] getSystemInfoSync 异常:', e)
    return 'light'
  }
}

export const useThemeStore = defineStore('theme', () => {
  // ---- state ----
  const mode = ref('auto')   // 'light' | 'dark' | 'auto'，默认跟随系统
  const systemTheme = ref('dark')

  // ★ auto 模式轮询定时器（用于实时检测系统主题变化）
  let pollTimer = null
  const POLL_INTERVAL = 3000  // 每 3 秒检测一次

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

  // ============================================================
  //  ★ auto 模式轮询 — 实时跟随系统主题变化
  //  原理：uni.onThemeChange() 仅小程序有效，独立 App 需要轮询 + onShow 双保险。
  //     - App 在前台且 mode='auto' → 每 3s 读 osTheme
  //     - App 进入后台 → 停止轮询省电
  //     - App 回到前台 (onShow) → 立刻检测 + 恢复轮询
  // ============================================================

  function startPoll() {
    stopPoll()
    // ★ 只在 auto 模式下启动轮询
    if (mode.value !== 'auto') return
    console.log('[Theme] 启动 auto 轮询（每', POLL_INTERVAL, 'ms）')
    pollTimer = setInterval(() => {
      const latest = getSystemTheme()
      if (latest !== systemTheme.value) {
        console.log('[Theme] 轮询检测到系统主题变化:', systemTheme.value, '→', latest)
        systemTheme.value = latest
        applyNavBar()
      }
    }, POLL_INTERVAL)
  }

  function stopPoll() {
    if (pollTimer) {
      clearInterval(pollTimer)
      pollTimer = null
      console.log('[Theme] 停止 auto 轮询')
    }
  }

  /** App 回到前台 → 立刻重新检测系统主题（覆盖"切出去换主题再回来"的场景） */
  function onAppShow() {
    console.log('[Theme] App 回到前台，重新检测系统主题')
    const latest = getSystemTheme()
    if (latest !== systemTheme.value) {
      console.log('[Theme] onShow 检测到系统主题变化:', systemTheme.value, '→', latest)
      systemTheme.value = latest
      if (mode.value === 'auto') {
        applyNavBar()
      }
    }
    // 恢复轮询（不管有没有变化都重新启动）
    startPoll()
  }

  /** App 进入后台 → 停止轮询省电 */
  function onAppHide() {
    console.log('[Theme] App 进入后台，停止轮询')
    stopPoll()
  }

  /** 切换模式并持久化 */
  function setMode(newMode) {
    if (!['light', 'dark', 'auto'].includes(newMode)) return
    mode.value = newMode
    uni.setStorageSync(STORAGE_KEY, newMode)

    // ★ 切换到 auto → 立刻重新探测系统主题 + 启动轮询
    if (newMode === 'auto') {
      systemTheme.value = getSystemTheme()
      startPoll()
    } else {
      // ★ 切换到 light/dark → 停止轮询省电
      stopPoll()
    }

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

    // 3. 应用导航栏（延迟 300ms 确保首屏页面已挂载，否则 setNavigationBarColor 无效）
    setTimeout(() => applyNavBar(), 300)

    // 4. 监听系统主题变化（小程序平台有效）
    try {
      uni.onThemeChange((res) => {
        // ★ 优先用事件携带的值，不可用时重新探测
        const newTheme = res.theme || getSystemTheme()
        console.log('[Theme] 系统主题变更:', newTheme)
        systemTheme.value = newTheme
        if (mode.value === 'auto') {
          applyNavBar()
        }
      })
    } catch { /* ignore */ }

    // 5. ★ 启动 auto 轮询（独立 App 无 onThemeChange，靠轮询检测系统主题变化）
    startPoll()
  }

  return {
    mode, systemTheme, effective,
    isDark, isLight, themeClass,
    modeLabel,
    init, setMode, cycleMode, applyNavBar,
    onAppShow, onAppHide,
  }
})
