/**
 * KeyGo 前台服务 JS 封装层 (v3.20.1)
 *
 * ★ v3.20.1: 修复通知不显示问题
 *   修复点:
 *     1. 渠道 ID 升级为 keygo_fg_v2（绕过系统缓存的旧 IMPORTANCE_LOW 配置）
 *     2. setSmallIcon 改用 app 自身图标资源，不再依赖系统 drawable
 *     3. 通知构建后注入 FLAG_FOREGROUND_SERVICE 标志
 *     4. 创建渠道前先删除旧渠道
 *     5. 全链路诊断日志
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

// ★ v3.20.1: 换 ID 强制重建渠道（旧 LOW 级别被系统缓存，同 ID 无法升级）
const CHANNEL_ID = 'keygo_fg_v2'
const OLD_CHANNEL_ID = 'keygo_foreground_channel'
const NOTIFICATION_ID = 1001

// ==================== 通知渠道创建 ====================

function createNotificationChannel() {
  try {
    if (getAndroidSdkVersion() < 26) return true  // Android 8 以下不需要

    const NotificationChannel = plus.android.importClass('android.app.NotificationChannel')
    const NotificationManager = plus.android.importClass('android.app.NotificationManager')

    const main = getMainActivity()
    if (!main) return false

    const manager = main.getSystemService('notification')
    if (!manager) return false

    // ★ v3.20.1: 先删除旧渠道（绕过系统缓存的 LOW 级别）
    try {
      manager.deleteNotificationChannel(OLD_CHANNEL_ID)
      console.log(`${TAG} ℹ 已删除旧渠道: ${OLD_CHANNEL_ID}`)
    } catch (e) {
      // 旧渠道可能不存在，忽略
    }

    // ★ v3.20.1: IMPORTANCE_DEFAULT + 新渠道 ID，确保状态栏图标可见
    const channel = new NotificationChannel(
      CHANNEL_ID,
      'KeyGo 后台服务',
      NotificationManager.IMPORTANCE_DEFAULT
    )
    channel.setDescription('保持蓝牙连接活跃，靠近车辆自动解锁')
    channel.setShowBadge(true)    // ★ v3.20.1: 状态栏图标可见
    channel.setSound(null, null)   // 无声
    channel.enableVibration(false) // 不振动
    channel.setLockscreenVisibility(0) // Notification.VISIBILITY_PUBLIC

    manager.createNotificationChannel(channel)
    console.log(`${TAG} ✅ 渠道已创建: ${CHANNEL_ID} (IMPORTANCE_DEFAULT)`)
    return true
  } catch (e) {
    console.error(`${TAG} ❌ createNotificationChannel 失败:`, e?.message || e)
    return false
  }
}

// ==================== 通知构建 ====================

/**
 * 获取 app 自身的通知图标资源 ID
 *
 * ★ v3.20.1 核心修复：不再使用硬编码的 android.R.drawable.xxx
 *   部分国产 ROM（Honor/MagicOS）的系统资源 ID 可能不存在或渲染为空白
 *
 * 回退链:
 *   1. app drawable icon → 2. app mipmap ic_launcher → 3. 通用系统图标
 */
function getAppIconResId(main, pkgName) {
  try {
    const resources = plus.android.invoke(main, 'getResources')
    if (!resources) return 0

    // 尝试 app 自身的 drawable icon
    const candidates = [
      { name: 'icon', type: 'drawable' },
      { name: 'ic_launcher', type: 'mipmap' },
      { name: 'ic_notification', type: 'drawable' },
    ]

    for (const c of candidates) {
      try {
        const id = plus.android.invoke(resources, 'getIdentifier', c.name, c.type, pkgName)
        if (id !== 0) {
          console.log(`${TAG} ℹ app 图标资源: ${pkgName}.${c.type}.${c.name} = ${id}`)
          return id
        }
      } catch (_) { /* next */ }
    }

    // ★ v3.20.1-fix: 回退到 ic_lock_lock (17301638)，与 v3.20.0 一致
    //   17301631 (stat_notify_more) 在 API 22 已废弃，现代设备上可能不存在
    const fallback = 17301638
    console.log(`${TAG} ⚠ 未找到 app 图标，使用系统图标 ic_lock_lock: ${fallback}`)
    return fallback
  } catch (e) {
    console.error(`${TAG} ❌ getAppIconResId 失败:`, e?.message || e)
    return 17301638 // ★ 与 v3.20.0 一致的最后回退
  }
}

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
    intent.addFlags(0x10000000 | 0x00020000)  // FLAG_ACTIVITY_NEW_TASK | FLAG_ACTIVITY_RESET_TASK_IF_NEEDED

    return intent
  } catch (e) {
    console.error(`${TAG} ❌ buildLauncherIntent 失败:`, e?.message || e)
    return null
  }
}

function buildNotification() {
  try {
    const main = getMainActivity()
    if (!main) {
      console.error(`${TAG} ❌ buildNotification: getMainActivity() = null`)
      return null
    }

    const pkgName = plus.android.invoke(main, 'getPackageName')
    console.log(`${TAG} ℹ 构建通知... pkg=${pkgName}`)

    // PendingIntent：点击通知打开 App
    const PendingIntent = plus.android.importClass('android.app.PendingIntent')
    const launchIntent = buildLauncherIntent(main)

    let pendingIntent = null
    if (launchIntent) {
      const FLAG_UPDATE_CURRENT = 134217728
      const FLAG_IMMUTABLE = 67108864
      pendingIntent = PendingIntent.getActivity(
        main, 0, launchIntent,
        FLAG_UPDATE_CURRENT | FLAG_IMMUTABLE
      )
      console.log(`${TAG} ℹ PendingIntent: ${pendingIntent ? 'OK' : 'FAIL'}`)
    } else {
      console.log(`${TAG} ⚠ buildLauncherIntent 返回 null，无点击跳转`)
    }

    // Builder
    const Nb = plus.android.importClass('android.app.Notification$Builder')
    let builder
    if (getAndroidSdkVersion() >= 26) {
      builder = new Nb(main, CHANNEL_ID)
    } else {
      builder = new Nb(main)
    }

    // ★ v3.20.1: 用 app 自身图标，不再依赖系统 drawable
    const smallIconId = getAppIconResId(main, pkgName)
    builder.setSmallIcon(smallIconId)
    console.log(`${TAG} ℹ setSmallIcon(${smallIconId})`)

    builder.setContentTitle('KeyGo 车钥匙')
    builder.setContentText('后台运行中，靠近车辆自动解锁')
    builder.setOngoing(true)
    builder.setPriority(0)  // PRIORITY_DEFAULT
    builder.setCategory('service')  // CATEGORY_SERVICE

    if (pendingIntent) {
      builder.setContentIntent(pendingIntent)
    }

    // build
    const notification = builder.build()
    if (!notification) {
      console.error(`${TAG} ❌ builder.build() 返回 null`)
      return null
    }

    // ★ v3.20.1: 注入 FLAG_FOREGROUND_SERVICE
    //   在 notification 对象上直接设置 flags 字段
    const FLAG_FOREGROUND_SERVICE = 0x00000040  // 64
    const FLAG_NO_CLEAR = 0x00000020            // 32
    try {
      const flagsField = notification.getClass().getField('flags')
      const currentFlags = flagsField.getInt(notification)
      flagsField.setInt(notification, currentFlags | FLAG_FOREGROUND_SERVICE | FLAG_NO_CLEAR)
      console.log(`${TAG} ℹ FLAG_FOREGROUND_SERVICE 已设置`)
    } catch (e) {
      console.warn(`${TAG} ⚠ 无法设置 FLAG_FOREGROUND_SERVICE:`, e?.message)
      // 不影响主流程，通知仍然会尝试显示
    }

    console.log(`${TAG} ✅ 通知对象构建完成`)
    return notification
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

// ==================== ★ v3.23.2: AlarmManager 心跳（防 Doze 冻结 JS） ====================

/**
 * Android Doze 模式下，JS 执行上下文会被系统冻结，导致：
 *   - setInterval 停止触发（舒适模式 BLE 轮询失效）
 *   - plus.geolocation.watchPosition 回调无法执行（极速模式 GPS 围栏失效）
 *
 * 解决方案：利用系统级 AlarmManager.setExactAndAllowWhileIdle()
 * 每 60 秒触发一次广播 → 唤醒 JS 线程 → 回调通知 bleStore 执行一次检查。
 *
 * 与 WakeLock 的区别：
 *   WakeLock  → 防止 CPU 休眠（Doze phase 1 有效）
 *   AlarmManager → 即使在 Deep Doze（phase 2+）也能准时唤醒进程
 *
 * 兼容性：
 *   - setExactAndAllowWhileIdle: API 23+ (Android 6+)
 *   - BroadcastReceiver 动态注册: API 1+
 *   - plus.android.implements: DCloud 内部桥接
 */

/** 心跳间隔（毫秒） */
const HEARTBEAT_INTERVAL_MS = 60000 // 60 秒

let _alarmReceiver = null
let _alarmCallback = null
let _alarmActive = false

/**
 * 启动 AlarmManager 心跳
 *
 * @param {Function} callback  每次心跳触发时的回调（无参数）
 * @returns {boolean} 是否成功启动
 */
export function startHeartbeatAlarm(callback) {
  if (!isAndroidApp()) {
    console.log(`${TAG} ⏰ 非 Android 环境，跳过心跳`)
    return false
  }

  if (_alarmActive) {
    console.log(`${TAG} ⏰ 心跳已在运行，更新回调`)
    _alarmCallback = callback
    return true
  }

  _alarmCallback = callback

  try {
    const main = getMainActivity()
    if (!main) {
      console.warn(`${TAG} ⏰ 无法获取 Activity，心跳启动失败`)
      return false
    }

    const pkgName = plus.android.invoke(main, 'getPackageName')
    const Context = plus.android.importClass('android.content.Context')
    const Intent = plus.android.importClass('android.content.Intent')
    const IntentFilter = plus.android.importClass('android.content.IntentFilter')
    const PendingIntent = plus.android.importClass('android.app.PendingIntent')

    // ★ 动态注册 BroadcastReceiver
    const ReceiverImpl = plus.android.implements(
      'io.dcloud.feature.internal.reflect.BroadcastReceiver',
      {
        onReceive: function(ctx, intent) {
          const action = intent.getAction()
          if (action === 'com.keygo.HEARTBEAT_ALARM') {
            console.log(`${TAG} ⏰ AlarmManager 心跳触发`)

            // ★ 重新调度下一次心跳（用 setExact 而非 setRepeating，每次自续）
            _rescheduleHeartbeatAlarm()

            // ★ 触发 JS 回调
            if (_alarmCallback) {
              try { _alarmCallback() } catch (e) {
                console.error(`${TAG} ⏰ 心跳回调异常:`, e?.message || e)
              }
            }
          }
        }
      }
    )

    _alarmReceiver = ReceiverImpl
    const filter = new IntentFilter('com.keygo.HEARTBEAT_ALARM')
    main.registerReceiver(_alarmReceiver, filter)

    _alarmActive = true

    // ★ 调度第一次心跳
    _rescheduleHeartbeatAlarm()

    console.log(`${TAG} ⏰ AlarmManager 心跳已启动 (间隔 ${HEARTBEAT_INTERVAL_MS / 1000}s)`)
    return true
  } catch (e) {
    console.error(`${TAG} ⏰ 心跳启动失败:`, e?.message || e)
    _alarmReceiver = null
    _alarmActive = false
    return false
  }
}

/**
 * 重新调度下一次 AlarmManager 心跳
 * 每次心跳触发后自续（不自续则只触发一次）
 */
function _rescheduleHeartbeatAlarm() {
  try {
    const main = getMainActivity()
    if (!main) return

    const Context = plus.android.importClass('android.content.Context')
    const Intent = plus.android.importClass('android.content.Intent')
    const PendingIntent = plus.android.importClass('android.app.PendingIntent')

    const pkgName = plus.android.invoke(main, 'getPackageName')
    const intent = new Intent('com.keygo.HEARTBEAT_ALARM')
    intent.setPackage(pkgName) // ★ 显式指定包名（Android 8+ 要求）

    const FLAG_IMMUTABLE = 67108864 // PendingIntent.FLAG_IMMUTABLE
    const pi = PendingIntent.getBroadcast(main, 9998, intent, FLAG_IMMUTABLE)

    const AlarmManager = plus.android.importClass('android.app.AlarmManager')
    const alarmMgr = main.getSystemService(Context.ALARM_SERVICE)

    // ★ setExactAndAllowWhileIdle: Doze 模式下也能准时触发
    // 参数: type=0 (RTC_WAKEUP), triggerAt=epoch ms, operation=PendingIntent
    const SystemCls = plus.android.importClass('java.lang.System')
    const triggerTime = SystemCls.currentTimeMillis() + HEARTBEAT_INTERVAL_MS

    alarmMgr.setExactAndAllowWhileIdle(0, triggerTime, pi)
  } catch (e) {
    console.error(`${TAG} ⏰ 重新调度心跳失败:`, e?.message || e)
  }
}

/**
 * 停止 AlarmManager 心跳
 */
export function stopHeartbeatAlarm() {
  if (!_alarmActive) return

  try {
    const main = getMainActivity()
    if (!main) return

    const Context = plus.android.importClass('android.content.Context')
    const Intent = plus.android.importClass('android.content.Intent')
    const PendingIntent = plus.android.importClass('android.app.PendingIntent')

    const pkgName = plus.android.invoke(main, 'getPackageName')
    const intent = new Intent('com.keygo.HEARTBEAT_ALARM')
    intent.setPackage(pkgName)

    // ★ 先用 FLAG_NO_CREATE 获取已存在的 PendingIntent
    const FLAG_NO_CREATE = 536870912
    const FLAG_IMMUTABLE = 67108864
    const pi = PendingIntent.getBroadcast(main, 9998, intent, FLAG_NO_CREATE | FLAG_IMMUTABLE)

    if (pi) {
      const AlarmManager = plus.android.importClass('android.app.AlarmManager')
      const alarmMgr = main.getSystemService(Context.ALARM_SERVICE)
      alarmMgr.cancel(pi)
      pi.cancel()
    }

    // ★ 注销 BroadcastReceiver
    if (_alarmReceiver) {
      try { main.unregisterReceiver(_alarmReceiver) } catch (_) { /* 可能已注销 */ }
      _alarmReceiver = null
    }
  } catch (e) {
    console.warn(`${TAG} ⏰ 停止心跳异常:`, e?.message || e)
  }

  _alarmActive = false
  _alarmCallback = null
  console.log(`${TAG} ⏰ AlarmManager 心跳已停止`)
}

/**
 * 查询心跳是否在运行
 * @returns {boolean}
 */
export function isHeartbeatAlarmActive() {
  return _alarmActive
}

// ==================== ★ v3.23.1: 亮屏广播接收器（舒适模式驱动） ====================

/**
 * 亮屏 BroadcastReceiver
 *
 * 舒适模式的核心触发器：用户亮屏/解锁的瞬间 → 回调通知 bleStore 执行一次 BLE 扫描。
 * 零后台额外功耗、零额外权限，系统管家找不到标记"高耗电应用"的理由。
 *
 * 注册两个 Intent Action：
 *   - ACTION_SCREEN_ON: 屏幕亮了（含仅看时间、未解锁）
 *   - ACTION_USER_PRESENT: 用户已解锁（有锁屏密码时更精准）
 * 两者都注册，由回调方做 2s 内去重（防止同一次亮屏触发两次扫描）。
 */

let _screenReceiver = null
let _screenCallback = null

/**
 * 注册亮屏广播接收器
 *
 * @param {Function} callback 亮屏时的回调 (action: string) => void
 * @returns {boolean} 是否成功注册
 */
export function registerScreenOnReceiver(callback) {
  if (!isAndroidApp()) {
    console.log(`${TAG} 📱 非 Android 环境，跳过亮屏广播`)
    return false
  }

  if (_screenReceiver) {
    // 已注册，仅更新回调
    _screenCallback = callback
    console.log(`${TAG} 📱 亮屏广播已注册，仅更新回调`)
    return true
  }

  _screenCallback = callback

  try {
    const main = getMainActivity()
    if (!main) {
      console.warn(`${TAG} 📱 无法获取 Activity，亮屏广播注册失败`)
      return false
    }

    const Intent = plus.android.importClass('android.content.Intent')
    const IntentFilter = plus.android.importClass('android.content.IntentFilter')

    const ReceiverImpl = plus.android.implements(
      'io.dcloud.feature.internal.reflect.BroadcastReceiver',
      {
        onReceive: function(ctx, intent) {
          const action = intent.getAction()
          if (action === Intent.ACTION_SCREEN_ON || action === Intent.ACTION_USER_PRESENT) {
            const label = action === Intent.ACTION_USER_PRESENT ? 'USER_PRESENT(已解锁)' : 'SCREEN_ON'
            console.log(`${TAG} 📱 亮屏事件: ${label}`)
            if (_screenCallback) {
              try {
                _screenCallback(action)
              } catch (e) {
                console.error(`${TAG} 📱 亮屏回调异常:`, e?.message || e)
              }
            }
          }
        }
      }
    )

    _screenReceiver = ReceiverImpl
    const filter = new IntentFilter()
    filter.addAction(Intent.ACTION_SCREEN_ON)
    filter.addAction(Intent.ACTION_USER_PRESENT)
    main.registerReceiver(_screenReceiver, filter)

    console.log(`${TAG} 📱 亮屏广播已注册 (SCREEN_ON + USER_PRESENT)`)
    return true
  } catch (e) {
    console.error(`${TAG} 📱 亮屏广播注册失败:`, e?.message || e)
    _screenReceiver = null
    _screenCallback = null
    return false
  }
}

/**
 * 注销亮屏广播接收器
 */
export function unregisterScreenOnReceiver() {
  if (!_screenReceiver) return
  try {
    const main = getMainActivity()
    if (main) {
      main.unregisterReceiver(_screenReceiver)
    }
  } catch (e) {
    // 可能已被系统注销
  }
  _screenReceiver = null
  _screenCallback = null
  console.log(`${TAG} 📱 亮屏广播已注销`)
}

// ==================== ★ v3.24: 原生后台扫描（真正后台重连的核心） ====================

let _nativePlugin = null
let _nativeScanActive = false

/**
 * 获取原生插件实例（Keygo-Foreground）。
 * 仅在自定义基座 / 云端打包 / 离线工程下可用；标准基座返回 null（走纯 JS 回退）。
 * @returns {object|null}
 */
export function getNativePlugin() {
  if (_nativePlugin === null) {
    try {
      _nativePlugin = uni.requireNativePlugin('Keygo-Foreground')
    } catch (e) {
      _nativePlugin = false
    }
  }
  return _nativePlugin || null
}

/**
 * 启动原生前台服务 + 后台 BLE 扫描。
 *
 * 原生层（KeygoBleScanService）在原生 Android 进程内常驻，不受 JS 冻结影响，
 * 扫到设备后通过 UniJSCallback 把 { event:'devicefound', mac, name, rssi } 推回本回调。
 *
 * @param {string} targetName     可选，扫描过滤的设备名（为空则扫描全部，更稳妥）
 * @param {Function} onDeviceFound 回调 (dev:{event,mac,name,rssi}) => void
 * @returns {boolean} 是否已成功发起（插件可用且调用成功）
 */
export function startNativeBackgroundScan(targetName, onDeviceFound) {
  const plugin = getNativePlugin()
  if (!plugin) {
    console.warn(`${TAG} ⚠ 原生插件不可用，后台扫描回退纯 JS`)
    return false
  }
  if (_nativeScanActive) {
    console.log(`${TAG} ℹ 原生后台扫描已在运行`)
    return true
  }
  try {
    _nativeScanActive = true  // 已发起，防止重复调用
    plugin.startScan({ targetName: targetName || '' }, (res) => {
      if (!res || typeof res !== 'object') return
      if (res.event === 'started') {
        console.log(`${TAG} ✅ 原生前台服务 + 后台扫描已启动`)
      } else if (res.event === 'devicefound') {
        if (onDeviceFound) {
          try { onDeviceFound(res) } catch (e) {
            console.error(`${TAG} ❌ 原生设备回调异常:`, e?.message || e)
          }
        }
      } else if (res.event === 'error') {
        console.error(`${TAG} ❌ 原生后台扫描错误:`, res.message)
        _nativeScanActive = false
      }
    })
    return true
  } catch (e) {
    console.error(`${TAG} ❌ 调用原生 startScan 失败:`, e?.message || e)
    _nativeScanActive = false
    return false
  }
}

/**
 * 停止原生前台服务 + 后台 BLE 扫描。
 */
export function stopNativeBackgroundScan() {
  const plugin = getNativePlugin()
  if (plugin) {
    try { plugin.stopScan() } catch (e) { /* ignore */ }
  }
  _nativeScanActive = false
  console.log(`${TAG} ✅ 原生后台扫描已停止`)
}

/**
 * 查询原生后台扫描是否在运行
 * @returns {boolean}
 */
export function isNativeBackgroundScanActive() {
  return _nativeScanActive
}

