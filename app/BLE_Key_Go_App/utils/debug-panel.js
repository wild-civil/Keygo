/**
 * ★ 开发调试面板状态 / 日志收集（v3.27-dev）
 *
 * 仅用于开发期真机调试，正式发版前建议移除 App.vue 中的 <DebugFloatPanel /> 引用。
 * 面板状态持久化：用户点「×」关闭后，重启 App 也不会再出现（除非手动清除 storage）。
 */
import { reactive } from 'vue'

export const debugState = reactive({
  // 总开关：false 时完全不收集
  enabled: true,
  // 是否展开（收起后只显示一个小圆点）
  visible: true,
  // 用户是否已手动关闭（关闭后不再显示，写 storage）
  closed: false,
  // 最近日志（最多 30 条，新的在前）
  logs: [],
  // 最后亮屏时间戳
  lastScreenOnTime: null,
  // 最后发现的设备 { name, mac, rssi, time }
  lastDeviceFound: null,
  // 最后重连结果 { ok, text, time }
  lastReconnectResult: null,
  // 前台服务状态 { active: boolean, native: boolean, time: number }
  foregroundStatus: null,
  // 原生插件状态 { pluginLoaded, isAndroidApp }
  pluginStatus: null,
})

const STORAGE_KEY = 'keygo_debug_panel_closed'

/** 初始化：读取用户是否关闭过 */
export function initDebugPanel() {
  try {
    const saved = uni.getStorageSync(STORAGE_KEY)
    if (saved === true || saved === 'true' || saved === 1) {
      debugState.closed = true
      debugState.visible = false
    }
  } catch (_) {}
}

/** 展开/收起 */
export function toggleDebugPanel() {
  if (debugState.closed) return
  debugState.visible = !debugState.visible
}

/** 用户关闭面板（持久化） */
export function closeDebugPanel() {
  debugState.closed = true
  debugState.visible = false
  try {
    uni.setStorageSync(STORAGE_KEY, true)
  } catch (_) {}
}

/** 重新打开（调试用） */
export function openDebugPanel() {
  debugState.closed = false
  debugState.visible = true
  try {
    uni.removeStorageSync(STORAGE_KEY)
  } catch (_) {}
}

/** 添加一条日志 */
export function addDebugLog(text, type = 'info') {
  if (!debugState.enabled) return
  const now = new Date()
  const time = now.toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })
  debugState.logs.unshift({ time, text, type })
  if (debugState.logs.length > 30) debugState.logs.pop()
  // 同时打印到 console，方便连电脑时也能看到
  console.log(`[DebugPanel] ${text}`)
}

/** 记录亮屏事件 */
export function setDebugScreenOn(label = '亮屏/解锁') {
  if (!debugState.enabled) return
  debugState.lastScreenOnTime = Date.now()
  addDebugLog(`${label} → 触发扫描`, 'screen')
}

/** 记录发现设备 */
export function setDebugDeviceFound(dev) {
  if (!debugState.enabled || !dev) return
  debugState.lastDeviceFound = {
    name: dev.name || '?',
    mac: dev.mac || '',
    rssi: dev.rssi ?? -999,
    time: Date.now(),
  }
  addDebugLog(`发现: ${dev.name || '?'} ${dev.mac || ''} rssi=${dev.rssi ?? '?'}`, 'device')
}

/** 记录重连结果 */
export function setDebugReconnectResult(ok, text) {
  if (!debugState.enabled) return
  debugState.lastReconnectResult = {
    ok: Boolean(ok),
    text: String(text),
    time: Date.now(),
  }
  addDebugLog(`重连: ${text}`, ok ? 'success' : 'error')
}

/** 更新前台服务状态 */
export function setDebugForegroundStatus(active, isNative, extra = '') {
  if (!debugState.enabled) return
  debugState.foregroundStatus = {
    active: Boolean(active),
    native: Boolean(isNative),
    extra: String(extra),
    time: Date.now(),
  }
  const mode = isNative ? '原生' : (active ? 'JS' : '未启动')
  addDebugLog(`前台服务: ${mode}${extra ? ' ' + extra : ''}`, active ? 'success' : 'info')
}

/** 设置原生插件状态 */
export function setDebugPluginStatus(status) {
  if (!debugState.enabled || !status) return
  debugState.pluginStatus = { ...status, time: Date.now() }
  addDebugLog(`插件: ${status.pluginLoaded ? '已加载' : '未加载'}`, status.pluginLoaded ? 'success' : 'warning')
}

/** 格式化时间戳为 mm:ss */
export function fmtTime(ts) {
  if (!ts) return '--'
  const d = new Date(ts)
  return d.toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

/** 格式化相对时间 */
export function fmtAgo(ts) {
  if (!ts) return '--'
  const sec = Math.round((Date.now() - ts) / 1000)
  if (sec < 60) return `${sec}s 前`
  if (sec < 3600) return `${Math.floor(sec / 60)}m 前`
  return `${Math.floor(sec / 3600)}h 前`
}
