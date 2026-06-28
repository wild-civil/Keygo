/**
 * Theme Store — light / dark / auto 主题管理
 *
 * 平台策略：
 *   H5       → document API 在 :root 上 setProperty（运行时最高优先级）
 *   APP-PLUS → plus.webview.currentWebview().setStyle() 直接设原生 webview 背景
 *              页面内容由 App.vue 的 .app-root :class 切换 CSS 变量
 *   MP       → 纯 CSS class 选择器（page.theme-light）
 */

import { defineStore } from 'pinia'
import { ref, computed } from 'vue'

const STORAGE_KEY = 'app_theme_mode'

/* =========================== CSS 变量值 =========================== */

const DARK_VARS = {
  '--bg-page':            '#0f0f1a',
  '--bg-card':            '#1a1a3e',
  '--bg-card-alt':        '#16213e',
  '--bg-darker':          '#0a0a1a',
  '--bg-tabbar':          '#12122a',
  '--bg-overlay':         'rgba(0, 0, 0, 0.7)',
  '--bg-input':           '#16213e',
  '--border':             '#2a2a5e',
  '--border-light':       '#1e2a3a',
  '--text-primary':       '#ffffff',
  '--text-secondary':     '#ccddee',
  '--text-tertiary':      '#8899aa',
  '--text-muted':         '#556677',
  '--accent':             '#00d4ff',
  '--accent-green':       '#00ff88',
  '--accent-orange':      '#ffaa00',
  '--accent-red':         '#ff4444',
  '--accent-yellow':      '#ffdd00',
  '--accent-pink':        '#ff4488',
  '--bg-warning':         '#332200',
  '--border-warning':     '#664400',
  '--bg-success':         '#003322',
  '--border-success':     '#006644',
  '--bg-connected':       '#0a1628',
  '--bg-unlocked':        '#0a2818',
  '--btn-accent-bg':      'rgba(0, 212, 255, 0.12)',
  '--btn-accent-border':  'rgba(0, 212, 255, 0.27)',
  '--btn-green-bg':       'rgba(0, 255, 136, 0.12)',
  '--btn-green-border':   'rgba(0, 255, 136, 0.27)',
  '--btn-orange-bg':      'rgba(255, 136, 0, 0.12)',
  '--btn-orange-border':  'rgba(255, 136, 0, 0.27)',
  '--btn-red-bg':         'rgba(255, 68, 68, 0.12)',
  '--btn-red-border':     'rgba(255, 68, 68, 0.27)',
  '--status-card-start':  '#1a1a3e',
  '--status-card-end':    '#16213e',
  '--car-card-start':     '#1a1a3e',
  '--car-card-end':       '#16213e',
}

const LIGHT_VARS = {
  '--bg-page':            '#f0f2f5',
  '--bg-card':            '#ffffff',
  '--bg-card-alt':        '#f5f7fa',
  '--bg-darker':          '#e8ecf0',
  '--bg-tabbar':          '#ffffff',
  '--bg-overlay':         'rgba(0, 0, 0, 0.35)',
  '--bg-input':           '#f5f7fa',
  '--border':             '#e0e4e8',
  '--border-light':       '#eceef2',
  '--text-primary':       '#1a1a2e',
  '--text-secondary':     '#2d2d44',
  '--text-tertiary':      '#667788',
  '--text-muted':         '#99aabb',
  '--accent':             '#0077cc',
  '--accent-green':       '#00aa55',
  '--accent-orange':      '#cc6600',
  '--accent-red':         '#cc2222',
  '--accent-yellow':      '#bb9900',
  '--accent-pink':        '#cc3366',
  '--bg-warning':         '#fff3e0',
  '--border-warning':     '#ffcc80',
  '--bg-success':         '#e0f5e9',
  '--border-success':     '#a0d9bb',
  '--bg-connected':       '#e0f0ff',
  '--bg-unlocked':        '#e0ffe0',
  '--btn-accent-bg':      'rgba(0, 119, 204, 0.08)',
  '--btn-accent-border':  'rgba(0, 119, 204, 0.2)',
  '--btn-green-bg':       'rgba(0, 170, 85, 0.08)',
  '--btn-green-border':   'rgba(0, 170, 85, 0.2)',
  '--btn-orange-bg':      'rgba(204, 102, 0, 0.08)',
  '--btn-orange-border':  'rgba(204, 102, 0, 0.2)',
  '--btn-red-bg':         'rgba(204, 34, 34, 0.08)',
  '--btn-red-border':     'rgba(204, 34, 34, 0.2)',
  '--status-card-start':  '#ffffff',
  '--status-card-end':    '#f5f7fa',
  '--car-card-start':     '#ffffff',
  '--car-card-end':       '#f5f7fa',
}

/* ================================================================== */

function getSystemTheme() {
  try {
    const info = uni.getSystemInfoSync()
    return info.theme || 'dark'
  } catch {
    return 'dark'
  }
}

function resolveTheme(mode) {
  if (mode === 'light' || mode === 'dark') return mode
  return getSystemTheme()
}

export const useThemeStore = defineStore('theme', () => {
  // ---- state ----
  const mode = ref('dark')
  const resolved = ref('dark')

  // ---- getters ----
  const isDark = computed(() => resolved.value === 'dark')
  const isLight = computed(() => resolved.value === 'light')
  const modeLabel = computed(() => {
    const map = { light: '亮色', dark: '暗色', auto: '自动' }
    return map[mode.value] || '暗色'
  })
  const modeIcon = computed(() => {
    const map = { light: '☀️', dark: '🌙', auto: '🤖' }
    return map[mode.value] || '🌙'
  })
  const navBarColor = computed(() => isDark.value ? '#12122a' : '#ffffff')
  const navBarTextStyle = computed(() => isDark.value ? 'white' : 'black')

  // ---- actions ----

  /** H5: 用 document API 内联写入所有 CSS 变量到 :root */
  function _applyH5() {
    // #ifdef H5
    if (typeof document === 'undefined' || !document || !document.documentElement) return
    const vars = resolved.value === 'dark' ? DARK_VARS : LIGHT_VARS
    const root = document.documentElement
    Object.entries(vars).forEach(([key, value]) => {
      root.style.setProperty(key, value)
    })
    root.classList.remove('theme-dark', 'theme-light')
    root.classList.add('theme-' + resolved.value)
    // #endif
  }

  /** APP-PLUS: 使用 plus.webview 设置原生页面背景色 */
  function _applyAppPlus() {
    // #ifdef APP-PLUS
    try {
      const bg = resolved.value === 'dark' ? '#0f0f1a' : '#f0f2f5'
      const launch = plus.webview.getLaunchWebview()
      if (launch) {
        launch.setStyle({ background: bg })
      }
      // 同时尝试 currentWebview（当前页面可能不是 launch）
      const current = plus.webview.currentWebview()
      if (current && current !== launch) {
        current.setStyle({ background: bg })
      }
    } catch (e) {
      // plus API 可能不可用
    }
    // #endif
  }

  /** 更新导航栏颜色 */
  function setNavBar() {
    try {
      uni.setNavigationBarColor({
        frontColor: navBarTextStyle.value === 'white' ? '#ffffff' : '#000000',
        backgroundColor: navBarColor.value,
        animation: { duration: 300, timingFunc: 'easeInOut' }
      })
    } catch { /* ignore */ }
  }

  /**
   * 应用主题
   *  1. reactive 的 resolved.value 变化 → App.vue 的 :class 自动更新 .app-root
   *  2. 平台特定的页面背景设置
   *  3. 导航栏颜色
   */
  function applyTheme() {
    resolved.value = resolveTheme(mode.value)
    _applyH5()
    _applyAppPlus()
    setNavBar()
  }

  /** 初始化 */
  function init() {
    try {
      const saved = uni.getStorageSync(STORAGE_KEY)
      if (saved && ['light', 'dark', 'auto'].includes(saved)) {
        mode.value = saved
      }
    } catch { /* use default */ }

    applyTheme()

    // 系统主题变化监听
    try {
      uni.onThemeChange((res) => {
        if (mode.value === 'auto') {
          resolved.value = res.theme
          _applyH5()
          _applyAppPlus()
          setNavBar()
        }
      })
    } catch { /* ignore */ }
  }

  /** 切换模式 */
  function setMode(newMode) {
    if (!['light', 'dark', 'auto'].includes(newMode)) return
    mode.value = newMode
    uni.setStorageSync(STORAGE_KEY, newMode)
    applyTheme()
  }

  /** 循环切换 */
  function cycleMode() {
    const order = ['dark', 'light', 'auto']
    const idx = order.indexOf(mode.value)
    const next = order[(idx + 1) % order.length]
    setMode(next)
  }

  return {
    mode, resolved,
    isDark, isLight, modeLabel, modeIcon,
    navBarColor, navBarTextStyle,
    init, setMode, cycleMode, applyTheme, setNavBar,
  }
})
