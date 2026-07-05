/**
 * KeyGo 前台服务 JS 封装层
 *
 * 封装 nativeplugins/Keygo-Foreground 原生插件，提供平台无关的 API。
 *
 * 设计原则：
 *   - Android → 调用原生前台 Service + WakeLock
 *   - iOS / 鸿蒙 / 小程序 → 空操作（静默返回，不抛异常）
 *   - 调用方无需关心平台差异，直接用 start() / stop() 即可
 *
 * ┌──────────────────────────────────────────────────────────┐
 * │  平台是 JS 层判断的，原生插件仅在 Android 编译            │
 * │  iOS/鸿蒙 的 HBuilderX 会跳过 nativeplugins 编译          │
 * │  但 uni.requireNativePlugin 仍需 try-catch 兜底          │
 * └──────────────────────────────────────────────────────────┘
 *
 * @module foreground-service
 */

/** @type {object|null} 原生插件实例（惰性初始化） */
let _plugin = null
let _pluginInitAttempted = false

/**
 * 获取原生插件实例（惰性 + 缓存）
 * @returns {object|null}
 */
function _getPlugin() {
  if (_pluginInitAttempted) return _plugin
  _pluginInitAttempted = true

  // 仅 Android 支持
  if (typeof plus === 'undefined') return null
  if (plus.os.name !== 'Android') return null

  try {
    _plugin = uni.requireNativePlugin('Keygo-Foreground')
  } catch (e) {
    console.warn('[ForegroundService] 原生插件加载失败:', e?.message || e)
    _plugin = null
  }
  return _plugin
}

/**
 * 启动前台服务
 *
 * 调用时机：
 *   - BLE 连接成功后
 *   - App 进入后台时（兜底，确保服务运行）
 *
 * Android 行为：
 *   - 创建通知渠道 + 显示常驻通知"KeyGo 后台运行中"
 *   - 获取 PARTIAL_WAKE_LOCK
 *   - 返回 START_STICKY（被杀后自动重建）
 *
 * 其他平台：静默返回 true
 *
 * @returns {Promise<boolean>} 是否成功启动
 */
export function startForegroundService() {
  const plugin = _getPlugin()
  if (!plugin) {
    // 非 Android → 静默成功
    return Promise.resolve(true)
  }

  return new Promise((resolve) => {
    try {
      plugin.start({}, (res) => {
        if (res && res.success) {
          console.log('[ForegroundService] ✅ 前台服务已启动')
          resolve(true)
        } else {
          console.warn('[ForegroundService] ⚠ 启动失败:', res?.error || 'unknown')
          resolve(false)
        }
      })
    } catch (e) {
      console.error('[ForegroundService] ❌ start 调用异常:', e?.message || e)
      resolve(false)
    }
  })
}

/**
 * 停止前台服务
 *
 * 调用时机：
 *   - 用户主动断开 BLE 连接
 *   - 不再需要后台保活
 *
 * Android 行为：
 *   - 移除常驻通知
 *   - 释放 WakeLock
 *   - 停止 Service
 *
 * 其他平台：静默返回 true
 *
 * @returns {Promise<boolean>} 是否成功停止
 */
export function stopForegroundService() {
  const plugin = _getPlugin()
  if (!plugin) {
    return Promise.resolve(true)
  }

  return new Promise((resolve) => {
    try {
      plugin.stop({}, (res) => {
        if (res && res.success) {
          console.log('[ForegroundService] ✅ 前台服务已停止')
          resolve(true)
        } else {
          console.warn('[ForegroundService] ⚠ 停止失败:', res?.error || 'unknown')
          resolve(false)
        }
      })
    } catch (e) {
      console.error('[ForegroundService] ❌ stop 调用异常:', e?.message || e)
      resolve(false)
    }
  })
}

/**
 * 查询前台服务是否正在运行
 * @returns {Promise<boolean>}
 */
export function isForegroundServiceRunning() {
  const plugin = _getPlugin()
  if (!plugin) {
    return Promise.resolve(false)
  }

  return new Promise((resolve) => {
    try {
      plugin.isRunning({}, (res) => {
        resolve(res && res.running === true)
      })
    } catch (e) {
      resolve(false)
    }
  })
}
