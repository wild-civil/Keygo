/**
 * KeyGo 电池优化豁免工具 (v3.21.0)
 *
 * Android Doze / Deep Doze 会在熄屏 30~60 分钟后冻结后台进程，
 * 导致 BLE 断开且无法扫描重连。引导用户将 KeyGo 加入电池优化白名单
 * 是最简单有效的保活手段。
 *
 * API:
 *   isIgnoringBatteryOptimizations()   → 是否已豁免
 *   openBatteryOptimizationSettings()  → 跳转系统设置页
 *
 * iOS / 鸿蒙 / 小程序 → 静默返回 true（不阻塞）
 *
 * @module power-saver
 */

const TAG = '[PowerSaver]'

// ==================== 平台判断 ====================

function isAndroidApp() {
  try {
    if (typeof plus === 'undefined') return false
    return plus.os && plus.os.name === 'Android'
  } catch (e) {
    return false
  }
}

// ==================== 获取 Context ====================

let _mainActivity = null
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

// ==================== 公开 API ====================

/**
 * 检查 App 是否已豁免电池优化
 *
 * Android: 调用 PowerManager.isIgnoringBatteryOptimizations(packageName)
 * 其他平台: 返回 true（不阻塞流程）
 *
 * @returns {boolean} true = 已豁免 / 非 Android 平台
 */
export function isIgnoringBatteryOptimizations() {
  if (!isAndroidApp()) return true

  try {
    const main = getMainActivity()
    if (!main) {
      console.warn(`${TAG} ⚠ getMainActivity() = null，假定已豁免`)
      return true
    }

    const pkgName = plus.android.invoke(main, 'getPackageName')

    // ★ 关键：plus.android 桥不能直接用 `.method()` 调用 Java 方法，
    //         必须用 plus.android.invoke()，否则报 "is not a function"
    const pm = plus.android.invoke(main, 'getSystemService', 'power')
    if (!pm) {
      console.warn(`${TAG} ⚠ getSystemService('power') = null，假定已豁免`)
      return true
    }

    const result = plus.android.invoke(pm, 'isIgnoringBatteryOptimizations', pkgName)
    console.log(`${TAG} 电池豁免状态: ${result ? '✅ 已豁免' : '❌ 未豁免'}`)
    return result
  } catch (e) {
    console.error(`${TAG} ❌ 检查失败:`, e?.message || e)
    return true // 异常时不阻塞
  }
}

/**
 * 打开系统电池优化豁免设置页
 *
 * 跳转到系统设置 → 电池优化 → 已列出本 App，用户勾选「不优化」即可。
 * Android 原生提供直达路径：Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS
 *
 * @returns {boolean} 是否成功打开设置页
 */
export function openBatteryOptimizationSettings() {
  if (!isAndroidApp()) return false

  const main = getMainActivity()
  if (!main) return false

  // ★ startActivity 通过 plus.android 桥时，国产 ROM 可能静默丢弃
  //   IGNORE_BATTERY_OPTIMIZATION 系列 Intent。
  //   改用 APPLICATION_DETAILS_SETTINGS（App 信息页）→ 100% 兼容所有 ROM，
  //   用户进入后在页面里找「电池」「耗电」入口即可。
  const tryIntent = (action, dataUri) => {
    try {
      const Uri = plus.android.importClass('android.net.Uri')
      // ★ 用 newObject + 双参构造一步创建 Intent，确保 Java 层正确初始化
      const intent = dataUri
        ? plus.android.newObject('android.content.Intent', action, Uri.parse(dataUri))
        : plus.android.newObject('android.content.Intent', action)

      // FLAG_ACTIVITY_NEW_TASK = 0x10000000
      // FLAG_ACTIVITY_CLEAR_TOP  = 0x04000000
      plus.android.invoke(intent, 'addFlags', 0x14000000)

      plus.android.invoke(main, 'startActivity', intent)
      console.log(`${TAG} ✅ startActivity 已发送: ${action}`)
      return true
    } catch (e) {
      console.warn(`${TAG} ⚠ startActivity 异常:`, e?.message)
      return false
    }
  }

  try {
    const pkgName = plus.android.invoke(main, 'getPackageName')
    const Settings = plus.android.importClass('android.provider.Settings')

    // 策略：从最可靠到最直接逐级尝试
    // 1. App 详情页（100% 兼容，用户需手动找电池入口）
    // 2. 通用电池优化列表（多数 ROM 支持）
    // 3. 直达豁免页（仅原生 Android 支持）

    const attempts = [
      { action: Settings.ACTION_APPLICATION_DETAILS_SETTINGS,     data: `package:${pkgName}`, label: '应用详情页' },
      { action: Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS, data: null,         label: '电池优化列表' },
      { action: Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, data: `package:${pkgName}`, label: '直达豁免页' },
    ]

    for (const { action, data, label } of attempts) {
      if (tryIntent(action, data)) {
        console.log(`${TAG} ✅ 已打开${label}`)
        return true
      }
    }

    console.warn(`${TAG} ❌ 所有打开方式均失败`)
    return false
  } catch (e) {
    console.error(`${TAG} ❌ 打开设置页失败:`, e?.message || e)
    return false
  }
}
