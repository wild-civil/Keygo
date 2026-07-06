/**
 * KeyGo 前台服务 JS 封装层 (v3.20.0)
 *
 * ★ v3.20.0: 完全纯 JS 实现，零原生插件依赖
 *
 * 使用 plus.android 直接调用 Android 框架 API：
 *   1. 常驻通知（Notification + NotificationChannel，IMPORTANCE_DEFAULT 确保可见）
 *   2. WakeLock（PARTIAL_WAKE_LOCK 防 CPU 休眠）
 *   3. 通知权限请求（Android 13+）+ 运行时诊断
 *
 * iOS / 鸿蒙 / 小程序 → 空操作（静默返回）
 *
 * @module foreground-service
 */

const TAG = '[ForegroundService]'

// ==================== 平台判断 ====================

/** 是否在 Android App 环境中 */
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
  } catch (e) {
    _sdkVersion = 0
  }
  return _sdkVersion
}

// ==================== 获取 Context ====================

let _mainActivity = undefined
let _mainActivityFetched = false

function getMainActivity() {
  if (_mainActivityFetched) return _mainActivity
  _mainActivityFetched = true
  try {
    _mainActivity = plus.android.runtimeMainActivity()
  } catch (e) {
    _mainActivity = null
  }
  return _mainActivity
}

// ==================== 通知常量 ====================

const CHANNEL_ID = 'keygo_foreground_channel'
const NOTIFICATION_ID = 1001

// ==================== 通知渠道创建 ====================

function createNotificationChannel() {
  try {
    if (getAndroidSdkVersion() < 26) return true  // Android 8 以下不需要

    const NotificationChannel = plus.android.importClass('android.app.NotificationChannel')
    const NotificationManager = plus.android.importClass('android.app.NotificationManager')

    // ★ v3.20: IMPORTANCE_DEFAULT 确保通知在状态栏可见（部分 ROM 上 LOW 不显示图标）
    const channel = new NotificationChannel(
      CHANNEL_ID,
      'KeyGo 后台服务',
      NotificationManager.IMPORTANCE_DEFAULT  // 状态栏显示图标，不响铃
    )
    channel.setDescription('保持蓝牙连接活跃，靠近车辆自动解锁')
    channel.setShowBadge(false)
    channel.setSound(null, null)    // 无声
    channel.enableVibration(false)  // 不振动

    const main = getMainActivity()
    if (!main) return false

    const manager = main.getSystemService('notification')
    if (manager) {
      manager.createNotificationChannel(channel)
    }
    return true
  } catch (e) {
    console.error(`${TAG} ❌ createNotificationChannel 失败:`, e?.message || e)
    return false
  }
}

// ==================== 通知构建 ====================

/**
 * 手动构建启动 Activity 的 Intent
 * 不用 getLaunchIntentForPackage（plus.android 对其支持不佳）
 */
function buildLauncherIntent(main) {
  try {
    const Intent = plus.android.importClass('android.content.Intent')
    const ComponentName = plus.android.importClass('android.content.ComponentName')

    const pkgName = plus.android.invoke(main, 'getPackageName')
    const className = plus.android.invoke(
      plus.android.invoke(main, 'getClass'),
      'getName'
    )

    const intent = new Intent(Intent.ACTION_MAIN)
    intent.addCategory(Intent.CATEGORY_LAUNCHER)
    intent.setComponent(new ComponentName(pkgName, className))
    // FLAG_ACTIVITY_NEW_TASK | FLAG_ACTIVITY_RESET_TASK_IF_NEEDED
    intent.addFlags(0x10000000 | 0x00020000)

    return intent
  } catch (e) {
    console.error(`${TAG} ❌ buildLauncherIntent 失败:`, e?.message || e)
    // 回退：PACKAGE_NAME 改为获取 pkgName
    return null
  }
}

function buildNotification() {
  try {
    const main = getMainActivity()
    if (!main) return null

    const PendingIntent = plus.android.importClass('android.app.PendingIntent')

    // 点击通知 → 打开 App（手动构建 Intent，避免 plus.android 对 getLaunchIntentForPackage 支持不佳）
    const launchIntent = buildLauncherIntent(main)

    let pendingIntent = null
    if (launchIntent) {
      const FLAG_UPDATE_CURRENT = 134217728  // 0x08000000
      const FLAG_IMMUTABLE = 67108864         // 0x04000000
      pendingIntent = PendingIntent.getActivity(
        main, 0, launchIntent,
        FLAG_UPDATE_CURRENT | FLAG_IMMUTABLE
      )
    }

    let builder
    if (getAndroidSdkVersion() >= 26) {
      const Nb = plus.android.importClass('android.app.Notification$Builder')
      builder = new Nb(main, CHANNEL_ID)
    } else {
      const Nb = plus.android.importClass('android.app.Notification$Builder')
      builder = new Nb(main)
    }

    builder.setContentTitle('KeyGo 车钥匙')
    builder.setContentText('后台运行中，靠近车辆自动解锁')
    builder.setSmallIcon(17301638)  // android.R.drawable.ic_lock_lock
    builder.setOngoing(true)
    builder.setPriority(0)  // Notification.PRIORITY_DEFAULT
    // ★ v3.20: 设置为服务类别，部分系统会给更高优先级
    builder.setCategory('service')  // Notification.CATEGORY_SERVICE

    if (pendingIntent) {
      builder.setContentIntent(pendingIntent)
    }

    return builder.build()
  } catch (e) {
    console.error(`${TAG} ❌ buildNotification 失败:`, e?.message || e)
    return null
  }
}

// ==================== 通知显示 / 隐藏 ====================

function checkNotifyPermission() {
  try {
    const sdk = getAndroidSdkVersion()
    if (sdk < 33) return 'not_required'
    const main = getMainActivity()
    if (!main) return 'unknown'
    const result = plus.android.invoke(main, 'checkSelfPermission', 'android.permission.POST_NOTIFICATIONS')
    return result === 0 ? 'granted' : 'denied'
  } catch (e) {
    return 'error'
  }
}

function showNotification() {
  try {
    // ★ v3.20: 先诊断权限状态
    const perm = checkNotifyPermission()
    console.log(`${TAG} ℹ 通知权限状态: ${perm}`)

    const notification = buildNotification()
    if (!notification) {
      console.error(`${TAG} ❌ 通知对象构建失败`)
      return false
    }

    const main = getMainActivity()
    if (!main) return false
    const manager = main.getSystemService('notification')
    if (!manager) return false

    manager.notify(NOTIFICATION_ID, notification)
    console.log(`${TAG} ✅ 通知已发送 (id=${NOTIFICATION_ID})`)
    return true
  } catch (e) {
    console.error(`${TAG} ❌ 通知显示失败:`, e?.message || e)
    return false
  }
}

function cancelNotification() {
  try {
    const main = getMainActivity()
    if (!main) return
    const manager = main.getSystemService('notification')
    if (manager) {
      manager.cancel(NOTIFICATION_ID)
    }
    console.log(`${TAG} ✅ 通知已取消`)
  } catch (e) {
    // 静默
  }
}

// ==================== WakeLock ====================

let _wakeLock = null
let _wakeLockPowerMgr = null

function acquireWakeLock() {
  if (_wakeLock !== null) return true  // 已持有
  try {
    const main = getMainActivity()
    if (!main) return false

    const PowerManager = plus.android.importClass('android.os.PowerManager')
    const pm = main.getSystemService('power')

    if (!pm) return false
    _wakeLockPowerMgr = pm

    const PARTIAL_FLAG = 0x00000001  // PARTIAL_WAKE_LOCK
    _wakeLock = pm.newWakeLock(PARTIAL_FLAG, 'KeyGo::BleKeepAlive')
    if (_wakeLock) {
      _wakeLock.setReferenceCounted(false)
      _wakeLock.acquire()
      console.log(`${TAG} ✅ WakeLock 已获取`)
      return true
    }
    return false
  } catch (e) {
    console.error(`${TAG} ❌ WakeLock 获取失败:`, e?.message || e)
    _wakeLock = null
    return false
  }
}

function releaseWakeLock() {
  if (_wakeLock === null) return
  try {
    if (_wakeLock.isHeld && _wakeLock.isHeld()) {
      _wakeLock.release()
      console.log(`${TAG} ✅ WakeLock 已释放`)
    }
  } catch (e) {
    // WakeLock 可能已被系统回收
  }
  _wakeLock = null
  _wakeLockPowerMgr = null
}

function isWakeLockHeld() {
  if (_wakeLock === null) return false
  try {
    return _wakeLock.isHeld()
  } catch (e) {
    return false
  }
}

// ==================== 公开 API ====================

let _serviceStarted = false

export function getPluginStatus() {
  const sdkVersion = getAndroidSdkVersion()

  return {
    mode: 'jsOnly',
    pluginLoaded: false,
    isAndroidApp: isAndroidApp(),
    sdkVersion: sdkVersion,
    mainActivity: getMainActivity() != null,
    wakeLockHeld: isWakeLockHeld(),
    notificationShown: _serviceStarted
  }
}

/**
 * 启动前台服务（v3.19.0 纯 JS 实现）
 *
 * 执行顺序:
 *   1. 创建通知渠道
 *   2. 构建并显示常驻通知
 *   3. 获取 PARTIAL_WAKE_LOCK
 *
 * @returns {Promise<boolean>}
 */
export function startForegroundService() {
  if (!isAndroidApp()) {
    return Promise.resolve(true)
  }

  return Promise.resolve(startViaPureJs())
}

/**
 * 纯 JS 实现：通知 + WakeLock
 */
function startViaPureJs() {
  try {
    const channelOk = createNotificationChannel()
    console.log(`${TAG} ${channelOk ? '✅' : '⚠'} 通知渠道: ${channelOk ? '已创建' : '失败'}`)

    const notifyOk = showNotification()
    console.log(`${TAG} ${notifyOk ? '✅' : '⚠'} 通知显示: ${notifyOk ? '已显示' : '失败'}`)

    const wlOk = acquireWakeLock()
    console.log(`${TAG} ${wlOk ? '✅' : '⚠'} WakeLock: ${wlOk ? '已获取' : '失败'}`)

    _serviceStarted = true
    console.log(`${TAG} ✅ 前台服务（纯 JS 模式）已启动 | 通知=${notifyOk} WakeLock=${wlOk}`)
    return true
  } catch (e) {
    console.error(`${TAG} ❌ 纯 JS 启动失败:`, e?.message || e)
    return false
  }
}

/**
 * 停止前台服务
 * @returns {Promise<boolean>}
 */
export function stopForegroundService() {
  if (!isAndroidApp()) {
    return Promise.resolve(true)
  }

  cancelNotification()
  releaseWakeLock()
  _serviceStarted = false

  console.log(`${TAG} ✅ 前台服务已停止`)
  return Promise.resolve(true)
}

/**
 * 查询前台服务是否正在运行
 * @returns {Promise<boolean>}
 */
export function isForegroundServiceRunning() {
  if (!isAndroidApp()) {
    return Promise.resolve(false)
  }

  return Promise.resolve(isWakeLockHeld())
}

// ==================== 通知权限 ====================

/**
 * 请求通知权限（Android 13+ 必须）
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

