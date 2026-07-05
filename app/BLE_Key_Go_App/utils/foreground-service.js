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

/** @type {'unknown'|'unsupported'|'loaded'|'failed'} */
let _status = 'unknown'
let _statusReason = ''

const TAG = '[ForegroundService]'

// ==================== 平台判断 ====================

/**
 * 是否在 Android App 环境中
 * @returns {boolean}
 */
function isAndroidApp() {
  try {
    if (typeof plus === 'undefined') return false
    return plus.os && plus.os.name === 'Android'
  } catch (e) {
    return false
  }
}

// ==================== 插件获取 ====================

/**
 * 获取原生插件实例（惰性 + 缓存）
 * @returns {object|null}
 */
function _getPlugin() {
  if (_pluginInitAttempted) return _plugin

  _pluginInitAttempted = true

  // 不在 App 环境 → 非应用
  if (typeof plus === 'undefined') {
    _status = 'unsupported'
    _statusReason = '非 App 环境（小程序/H5）'
    console.log(`${TAG} ℹ 非 App 环境，跳过原生插件`)
    return null
  }

  // 非 Android → 不支持
  if (plus.os.name !== 'Android') {
    _status = 'unsupported'
    _statusReason = `平台: ${plus.os.name}`
    console.log(`${TAG} ℹ ${plus.os.name} 平台不支持前台服务，跳过`)
    return null
  }

  // Android 环境 → 尝试加载
  try {
    console.log(`${TAG} 🔄 正在加载原生插件 Keygo-Foreground...`)
    _plugin = uni.requireNativePlugin('Keygo-Foreground')

    if (!_plugin) {
      _status = 'failed'
      _statusReason = 'uni.requireNativePlugin 返回 null/undefined（插件未编译进 APK？）'
      console.error(`${TAG} ❌ ${_statusReason}`)
      return null
    }

    // 验证插件是否提供了必要的方法
    if (typeof _plugin.start !== 'function' || typeof _plugin.stop !== 'function') {
      _status = 'failed'
      _statusReason = '插件对象存在但缺少 start/stop 方法'
      console.error(`${TAG} ❌ ${_statusReason}，可用方法:`, Object.keys(_plugin))
      _plugin = null
      return null
    }

    _status = 'loaded'
    _statusReason = '插件加载成功'
    console.log(`${TAG} ✅ 原生插件加载成功，可用方法:`, Object.keys(_plugin))
    return _plugin

  } catch (e) {
    _status = 'failed'
    _statusReason = `uni.requireNativePlugin 异常: ${e?.message || e}`
    console.error(`${TAG} ❌ ${_statusReason}`)
    _plugin = null
    return null
  }
}

// ==================== 公开 API ====================

/**
 * 获取插件状态诊断信息
 * @returns {{ status: string, reason: string, isAndroidApp: boolean, pluginLoaded: boolean }}
 */
export function getPluginStatus() {
  return {
    status: _status,
    reason: _statusReason,
    isAndroidApp: isAndroidApp(),
    pluginLoaded: _plugin !== null,
    initAttempted: _pluginInitAttempted
  }
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
 * 其他平台 / 插件未加载：返回 false
 *
 * @returns {Promise<boolean>} 是否成功启动
 */
export function startForegroundService() {
  const plugin = _getPlugin()

  if (!plugin) {
    // ★ 修复 v3.17.1: 插件不可用时返回 false，而非 true
    //   这样 ble.js 才能知道服务未启动，下次递归 _ensureForegroundService 能重试
    if (_status === 'unsupported') {
      // 非 Android → 静默，不算失败
      return Promise.resolve(true)
    }
    // Android 但插件加载失败 → 明确返回 false
    console.error(`${TAG} ❌ 无法启动: ${_statusReason}`)
    return Promise.resolve(false)
  }

  return new Promise((resolve) => {
    try {
      console.log(`${TAG} 🔄 调用 plugin.start()...`)
      plugin.start({}, (res) => {
        if (res && res.success) {
          console.log(`${TAG} ✅ 前台服务已启动（通知栏应可见）`)
          resolve(true)
        } else {
          const errMsg = res?.error || 'unknown'
          console.warn(`${TAG} ⚠ 启动失败: ${errMsg}`)
          console.warn(`${TAG}   可能原因: 通知权限未授予 / Android 14+ Service type 不匹配`)
          resolve(false)
        }
      })
    } catch (e) {
      console.error(`${TAG} ❌ start() 调用异常:`, e?.message || e)
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
          console.log(`${TAG} ✅ 前台服务已停止`)
          resolve(true)
        } else {
          console.warn(`${TAG} ⚠ 停止失败:`, res?.error || 'unknown')
          resolve(false)
        }
      })
    } catch (e) {
      console.error(`${TAG} ❌ stop() 调用异常:`, e?.message || e)
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

/**
 * ★ v3.17.1: 请求通知权限（Android 13+ 必须）
 *
 * 调用时机：App 启动后尽早调用
 *
 * 注意：uni-app 的权限请求 API:
 *   - Android: plus.android.requestPermissions
 *
 * @returns {Promise<boolean>} 权限是否已授予
 */
export function requestNotificationPermission() {
  if (!isAndroidApp()) {
    return Promise.resolve(true)
  }

  return new Promise((resolve) => {
    try {
      // Android 13 (API 33) 开始需要运行时请求通知权限
      const main = plus.android.runtimeMainActivity()
      const sdkInt = android.os.Build.VERSION.SDK_INT  // eslint-disable-line

      if (sdkInt < 33) {
        // Android 12 及以下不需要请求
        console.log(`${TAG} ℹ Android ${sdkInt}，无需请求通知权限`)
        return resolve(true)
      }

      // 检查是否已授权
      if (main.checkSelfPermission('android.permission.POST_NOTIFICATIONS') === 0) {
        // 0 = PackageManager.PERMISSION_GRANTED
        console.log(`${TAG} ✅ 通知权限已授予`)
        return resolve(true)
      }

      // 请求权限
      console.log(`${TAG} 🔄 正在请求通知权限...`)
      main.requestPermissions(
        ['android.permission.POST_NOTIFICATIONS'],
        (result) => {
          // result 格式：{ granted: ['...'], denied: ['...'], neverAskAgain: ['...'] }
          const granted = result.granted || []
          const isGranted = granted.includes('android.permission.POST_NOTIFICATIONS')
          if (isGranted) {
            console.log(`${TAG} ✅ 通知权限已授予`)
          } else {
            console.warn(`${TAG} ⚠ 通知权限被拒绝，前台服务通知可能不显示`)
          }
          resolve(isGranted)
        }
      )
    } catch (e) {
      console.error(`${TAG} ❌ 通知权限请求异常:`, e?.message || e)
      resolve(false)
    }
  })
}
