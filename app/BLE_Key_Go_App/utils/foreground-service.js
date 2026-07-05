/**
 * KeyGo 前台服务 JS 封装层 (v3.17.2)
 *
 * ★ 改用 plus.android 直接操作 Service，不依赖 uni.requireNativePlugin
 *   只要 Java 代码被编译进 APK（自定义基座 / 云打包），即可通过标准 Intent 启动
 *
 * 设计原则：
 *   - Android → plus.android 发 Intent 启动 ForegroundService
 *   - 同时保留 uni.requireNativePlugin 作为备用路径
 *   - iOS / 鸿蒙 / 小程序 → 空操作（静默返回，不抛异常）
 *
 * @module foreground-service
 */

const TAG = '[ForegroundService]'

// ==================== 平台判断 ====================

/**
 * 是否在 Android App 环境中
 */
function isAndroidApp() {
  try {
    if (typeof plus === 'undefined') return false
    return plus.os && plus.os.name === 'Android'
  } catch (e) {
    return false
  }
}

// ==================== Android SDK 版本 ====================

let _sdkVersion = -1

function getAndroidSdkVersion() {
  if (_sdkVersion >= 0) return _sdkVersion
  try {
    if (!isAndroidApp()) { _sdkVersion = 0; return 0 }
    const Build = plus.android.importClass('android.os.Build')
    _sdkVersion = Build.VERSION.SDK_INT
    console.log(`${TAG} ℹ Android SDK: ${_sdkVersion}`)
  } catch (e) {
    _sdkVersion = 0
    console.warn(`${TAG} ⚠ 无法获取 SDK 版本:`, e?.message)
  }
  return _sdkVersion
}

// ==================== 获取 MainActivity ====================

let _mainActivity = undefined
let _mainActivityFetched = false

function getMainActivity() {
  if (_mainActivityFetched) return _mainActivity
  _mainActivityFetched = true
  try {
    _mainActivity = plus.android.runtimeMainActivity()
    if (!_mainActivity) {
      console.warn(`${TAG} ⚠ runtimeMainActivity 返回 null`)
    }
  } catch (e) {
    console.warn(`${TAG} ⚠ runtimeMainActivity 异常:`, e?.message)
    _mainActivity = null
  }
  return _mainActivity
}

// ==================== 双模 Service 调用 ====================

// 模式 1: uni.requireNativePlugin（需插件正确编译）
let _plugin = null
let _pluginChecked = false
let _pluginMode = 'unchecked'   // 'unchecked' | 'nativePlugin' | 'intentOnly'

function _checkNativePlugin() {
  if (_pluginChecked) return _pluginMode
  _pluginChecked = true

  // 非 Android 环境
  if (!isAndroidApp()) {
    _pluginMode = 'unsupported'
    return _pluginMode
  }

  // 尝试加载原生插件
  try {
    _plugin = uni.requireNativePlugin('Keygo-Foreground')
    if (_plugin && typeof _plugin.start === 'function') {
      _pluginMode = 'nativePlugin'
      console.log(`${TAG} ✅ uni.requireNativePlugin 可用（原生插件模式）`)
    } else {
      _pluginMode = 'intentOnly'
      _plugin = null
      console.warn(`${TAG} ⚠ uni.requireNativePlugin 不可用，将使用 Intent 模式`)
    }
  } catch (e) {
    _pluginMode = 'intentOnly'
    _plugin = null
    console.warn(`${TAG} ⚠ uni.requireNativePlugin 异常:`, e?.message)
  }

  return _pluginMode
}

// 模式 2: plus.android Intent 直接调用
let _serviceClass = null
let _serviceClassChecked = false

function _getServiceClass() {
  if (_serviceClassChecked) return _serviceClass
  _serviceClassChecked = true
  try {
    _serviceClass = plus.android.importClass('com.keygo.foreground.ForegroundService')
    console.log(`${TAG} ✅ ForegroundService 类已加载`)
  } catch (e) {
    console.error(`${TAG} ❌ ForegroundService 类未找到（Java 代码未编译进 APK）:`, e?.message)
    _serviceClass = null
  }
  return _serviceClass
}

// ==================== 公开 API ====================

/**
 * 诊断信息
 */
export function getPluginStatus() {
  _checkNativePlugin()
  const svcClass = isAndroidApp() ? _getServiceClass() : null

  return {
    mode: _pluginMode,
    pluginLoaded: _plugin != null,      // ★ 修复: != 同时匹配 null 和 undefined
    serviceClassFound: svcClass != null,
    isAndroidApp: isAndroidApp(),
    sdkVersion: getAndroidSdkVersion(),
    mainActivity: getMainActivity() != null,
  }
}

/**
 * 启动前台服务
 *
 * ★ v3.17.2 双模策略:
 *   1. 优先用 uni.requireNativePlugin（如果插件正确编译）
 *   2. 回退到 plus.android Intent 直接启动（不依赖插件模块系统）
 *
 * @returns {Promise<boolean>}
 */
export function startForegroundService() {
  // 非 Android → 静默成功
  if (!isAndroidApp()) {
    return Promise.resolve(true)
  }

  const mode = _checkNativePlugin()

  // ====== 路径 1: 原生插件 ======
  if (mode === 'nativePlugin' && _plugin) {
    return new Promise((resolve) => {
      try {
        _plugin.start({}, (res) => {
          if (res && res.success) {
            console.log(`${TAG} ✅ [Plugin] 前台服务已启动`)
            resolve(true)
          } else {
            console.warn(`${TAG} ⚠ [Plugin] 启动失败: ${res?.error || 'unknown'}，回退 Intent 模式`)
            _startViaIntent().then(resolve)
          }
        })
      } catch (e) {
        console.warn(`${TAG} ⚠ [Plugin] 调用异常: ${e?.message}，回退 Intent 模式`)
        _startViaIntent().then(resolve)
      }
    })
  }

  // ====== 路径 2: Intent 直接启动 ======
  return _startViaIntent()
}

/**
 * 通过 plus.android Intent 直接启动 Service
 */
function _startViaIntent() {
  return new Promise((resolve) => {
    try {
      const main = getMainActivity()
      if (!main) {
        console.error(`${TAG} ❌ [Intent] 无法获取 MainActivity`)
        resolve(false)
        return
      }

      const svcClass = _getServiceClass()
      if (!svcClass) {
        console.error(`${TAG} ❌ [Intent] ForegroundService 类未编译进 APK`)
        resolve(false)
        return
      }

      const Intent = plus.android.importClass('android.content.Intent')
      const intent = new Intent(main, svcClass)

      if (getAndroidSdkVersion() >= 26) {
        main.startForegroundService(intent)
      } else {
        main.startService(intent)
      }

      console.log(`${TAG} ✅ [Intent] startForegroundService 已调用`)
      resolve(true)
    } catch (e) {
      console.error(`${TAG} ❌ [Intent] 启动异常:`, e?.message || e)
      resolve(false)
    }
  })
}

/**
 * 停止前台服务
 * @returns {Promise<boolean>}
 */
export function stopForegroundService() {
  if (!isAndroidApp()) {
    return Promise.resolve(true)
  }

  // 先尝试原生插件
  if (_pluginMode === 'nativePlugin' && _plugin) {
    try {
      _plugin.stop({}, (res) => {
        console.log(`${TAG} ✅ [Plugin] 前台服务已停止`)
      })
    } catch (e) {
      // 忽略失败，继续 Intent 路径
    }
  }

  // Intent 路径停止
  return _stopViaIntent()
}

/**
 * 通过 plus.android Intent 直接停止 Service
 */
function _stopViaIntent() {
  return new Promise((resolve) => {
    try {
      const main = getMainActivity()
      if (!main) { resolve(true); return }

      const svcClass = _getServiceClass()
      if (!svcClass) { resolve(true); return }

      const Intent = plus.android.importClass('android.content.Intent')
      const intent = new Intent(main, svcClass)
      main.stopService(intent)

      console.log(`${TAG} ✅ [Intent] stopService 已调用`)
      resolve(true)
    } catch (e) {
      console.warn(`${TAG} ⚠ [Intent] 停止异常:`, e?.message || e)
      resolve(false)
    }
  })
}

/**
 * 查询前台服务是否正在运行
 * @returns {Promise<boolean>}
 */
export function isForegroundServiceRunning() {
  if (!isAndroidApp()) {
    return Promise.resolve(false)
  }

  // 先尝试原生插件
  if (_pluginMode === 'nativePlugin' && _plugin) {
    return new Promise((resolve) => {
      try {
        _plugin.isRunning({}, (res) => {
          if (res && typeof res.running === 'boolean') {
            resolve(res.running)
            return
          }
          _checkRunningViaActivityManager().then(resolve)
        })
      } catch (e) {
        _checkRunningViaActivityManager().then(resolve)
      }
    })
  }

  return _checkRunningViaActivityManager()
}

/**
 * 通过 ActivityManager 检查 Service 运行状态
 */
function _checkRunningViaActivityManager() {
  return new Promise((resolve) => {
    try {
      const main = getMainActivity()
      if (!main) { resolve(false); return }

      const ActivityManager = plus.android.importClass('android.app.ActivityManager')
      const am = main.getSystemService('activity')
      if (!am) { resolve(false); return }

      const services = am.getRunningServices(Number.MAX_VALUE || 2147483647)
      if (!services) { resolve(false); return }

      const targetName = 'com.keygo.foreground.ForegroundService'
      for (let i = 0; i < services.size(); i++) {
        const s = services.get(i)
        if (s && s.service && s.service.getClassName() === targetName) {
          resolve(true)
          return
        }
      }
      resolve(false)
    } catch (e) {
      resolve(false)
    }
  })
}

// ==================== 通知权限 ====================

/**
 * ★ 请求通知权限（Android 13+ 必须）
 * @returns {Promise<boolean>}
 */
export function requestNotificationPermission() {
  if (!isAndroidApp()) {
    return Promise.resolve(true)
  }

  const sdkInt = getAndroidSdkVersion()
  if (sdkInt < 33) {
    console.log(`${TAG} ℹ Android ${sdkInt}，无需请求通知权限`)
    return Promise.resolve(true)
  }

  return new Promise((resolve) => {
    try {
      const main = getMainActivity()
      if (!main) { resolve(false); return }

      // 检查是否已授权
      if (main.checkSelfPermission('android.permission.POST_NOTIFICATIONS') === 0) {
        console.log(`${TAG} ✅ 通知权限已授予`)
        resolve(true)
        return
      }

      // 请求权限
      console.log(`${TAG} 🔄 正在请求通知权限...`)
      main.requestPermissions(
        ['android.permission.POST_NOTIFICATIONS'],
        (result) => {
          const granted = result.granted || []
          const isGranted = granted.includes('android.permission.POST_NOTIFICATIONS')
          console.log(`${TAG} ${isGranted ? '✅' : '⚠'} 通知权限: ${isGranted ? '已授予' : '被拒绝'}`)
          resolve(isGranted)
        }
      )
    } catch (e) {
      console.error(`${TAG} ❌ 通知权限请求异常:`, e?.message || e)
      resolve(false)
    }
  })
}
