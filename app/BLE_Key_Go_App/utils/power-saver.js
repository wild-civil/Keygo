/**
 * KeyGo 电池优化豁免工具 (v3.22.0)
 *
 * Android Doze / Deep Doze 会在熄屏 30~60 分钟后冻结后台进程，
 * 导致 BLE 断开且无法扫描重连。引导用户将 KeyGo 加入电池优化白名单
 * 是最简单有效的保活手段。
 *
 * API:
 *   isIgnoringBatteryOptimizations()   → 是否已豁免
 *   openBatteryOptimizationSettings()  → 跳转系统设置页（ROM 感知）
 *   detectRom()                        → 检测 ROM 品牌
 *   getRomGuidance()                   → 获取 ROM 特定的引导文案
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

// ==================== ROM 检测 ====================

let _romInfo = null

/**
 * 检测 ROM 品牌
 * @returns {{ manufacturer: string, brand: string, label: string }}
 */
export function detectRom() {
  if (_romInfo) return _romInfo

  if (!isAndroidApp()) {
    _romInfo = { manufacturer: 'unknown', brand: 'unknown', label: '未知' }
    return _romInfo
  }

  try {
    const Build = plus.android.importClass('android.os.Build')
    const mfr = String(Build.MANUFACTURER || '').toLowerCase()
    const brand = String(Build.BRAND || '').toLowerCase()
    const model = String(Build.MODEL || '')

    let label = '未知'
    // 注意：荣耀独立后 MANUFACTURER 是 "HONOR"，华为是 "HUAWEI"
    if (mfr === 'honor' || brand === 'honor') {
      label = '荣耀'
    } else if (mfr === 'huawei' || brand === 'huawei') {
      label = '华为'
    } else if (mfr === 'xiaomi' || brand === 'xiaomi' || mfr === 'redmi') {
      label = '小米'
    } else if (mfr === 'oppo' || brand === 'oppo') {
      label = 'OPPO'
    } else if (mfr === 'vivo' || brand === 'vivo') {
      label = 'vivo'
    } else if (mfr === 'samsung' || brand === 'samsung') {
      label = '三星'
    } else if (mfr === 'oneplus' || brand === 'oneplus') {
      label = '一加'
    } else if (mfr === 'meizu' || brand === 'meizu') {
      label = '魅族'
    } else if (mfr === 'realme' || brand === 'realme') {
      label = 'realme'
    }

    _romInfo = {
      manufacturer: mfr,
      brand: brand,
      model: model,
      label: label,
    }
  } catch (e) {
    _romInfo = { manufacturer: 'unknown', brand: 'unknown', label: '未知' }
  }

  console.log(`${TAG} ROM 检测: ${_romInfo.label} (mfr=${_romInfo.manufacturer}, brand=${_romInfo.brand}, model=${_romInfo.model})`)
  return _romInfo
}

/**
 * 获取 ROM 特定的电池优化设置引导文案
 *
 * 返回 { title, content }，content 中包含当前 ROM 的精确操作路径。
 * 调用方可以将这个文案嵌入弹窗中展示给用户。
 *
 * @returns {{ title: string, content: string }}
 */
export function getRomGuidance() {
  const rom = detectRom()
  const label = rom.label

  // ★ 各 ROM 的电池优化设置路径
  const GUIDANCE = {
    '荣耀': {
      title: '保持后台运行',
      content: 'KeyGo 需要在后台持续运行，才能靠近车辆自动解锁。\n\n点击「去设置」后：\n① 找到「耗电详情」或「应用启动管理」\n② 将 KeyGo 设为「手动管理」\n③ 开启「允许后台运行」\n\n或者通过：\n设置 → 隐私和安全 → 权限管理 → 特殊访问权限 → 电池优化 → 关闭 KeyGo 优化',
    },
    '华为': {
      title: '保持后台运行',
      content: 'KeyGo 需要在后台持续运行，才能靠近车辆自动解锁。\n\n点击「去设置」后：\n① 找到「耗电详情」或「应用启动管理」\n② 将 KeyGo 设为「手动管理」\n③ 开启「允许后台运行」\n\n或者通过：\n设置 → 应用 → 应用启动管理 → KeyGo → 手动管理',
    },
    '小米': {
      title: '保持后台运行',
      content: 'KeyGo 需要在后台持续运行，才能靠近车辆自动解锁。\n\n点击「去设置」后：\n① 找到「省电策略」或「应用智能省电」\n② 将 KeyGo 设为「无限制」\n\n或者通过：\n设置 → 省电与电池 → 应用 → KeyGo → 无限制',
    },
    'OPPO': {
      title: '保持后台运行',
      content: 'KeyGo 需要在后台持续运行，才能靠近车辆自动解锁。\n\n点击「去设置」后：\n① 找到「耗电管理」或「后台运行」\n② 允许 KeyGo 后台运行\n\n或者通过：\n设置 → 电池 → 更多 → 优化电池使用 → 关闭 KeyGo 优化',
    },
    'vivo': {
      title: '保持后台运行',
      content: 'KeyGo 需要在后台持续运行，才能靠近车辆自动解锁。\n\n点击「去设置」后：\n① 找到「后台高耗电」或「电池管理」\n② 允许 KeyGo 后台高耗电\n\n或者通过：\n设置 → 电池 → 后台高耗电 → 开启 KeyGo',
    },
    '三星': {
      title: '保持后台运行',
      content: 'KeyGo 需要在后台持续运行，才能靠近车辆自动解锁。\n\n点击「去设置」后：\n① 找到「电池」或「后台使用限制」\n② 将 KeyGo 设为「不限制」\n\n或者通过：\n设置 → 设备维护 → 电池 → 后台使用限制 → 关闭 KeyGo 限制',
    },
    '一加': {
      title: '保持后台运行',
      content: 'KeyGo 需要在后台持续运行，才能靠近车辆自动解锁。\n\n点击「去设置」后：\n① 找到「电池优化」或「后台管理」\n② 将 KeyGo 设为「不优化」\n\n或者通过：\n设置 → 电池 → 电池优化 → 关闭 KeyGo 优化',
    },
    '魅族': {
      title: '保持后台运行',
      content: 'KeyGo 需要在后台持续运行，才能靠近车辆自动解锁。\n\n点击「去设置」后：\n① 找到「后台管理」或「电源管理」\n② 允许 KeyGo 后台运行\n\n或者通过：\n设置 → 电量管理 → 后台管理 → KeyGo → 允许后台',
    },
    'realme': {
      title: '保持后台运行',
      content: 'KeyGo 需要在后台持续运行，才能靠近车辆自动解锁。\n\n点击「去设置」后：\n① 找到「后台运行」或「电池优化」\n② 允许 KeyGo 后台运行\n\n或者通过：\n设置 → 电池 → 应用电池管理 → KeyGo → 允许后台运行',
    },
    '未知': {
      title: '保持后台运行',
      content: 'KeyGo 需要在后台持续运行，才能靠近车辆自动解锁。\n\n点击「去设置」后，请在 App 信息页里找到「耗电详情」「电池」或「后台管理」，将 KeyGo 设为允许后台运行。',
    },
  }

  return GUIDANCE[label] || GUIDANCE['未知']
}

/**
 * 获取 ROM 特定的跳转 Intent 策略
 *
 * 返回按优先级排列的 Intent 试跳方案。
 * 已知 ROM 优先尝试精确路径，未知 ROM 用通用路径。
 *
 * @param {string} pkgName 应用包名
 * @returns {Array<{action: string, data: string|null, label: string}>}
 */
function getRomIntentStrategy(pkgName) {
  const rom = detectRom()
  const mfr = rom.manufacturer

  // 通用电池优化列表 Intent（AOSP 标准，多数 ROM 支持）
  const IGNORE_LIST = {
    action: null,  // 运行时填充 Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS
    data: null,
    label: '电池优化列表',
  }

  // App 详情页（100% 兼容所有 ROM）
  const APP_DETAILS = {
    action: null,  // 运行时填充 Settings.ACTION_APPLICATION_DETAILS_SETTINGS
    data: `package:${pkgName}`,
    label: '应用详情页',
  }

  // 直达豁免页（仅原生 Android 支持，国产 ROM 基本拦截）
  const DIRECT_REQUEST = {
    action: null,  // 运行时填充 Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS
    data: `package:${pkgName}`,
    label: '直达豁免页',
  }

  // ★ ROM 特定策略（v3.22-fix2）：
  //   荣耀 → AOSP IGNORE_BATTERY_OPTIMIZATION_SETTINGS 实测可用
  //   华为 → 优先电池优化列表（若失败则回退 App 详情）
  //   小米 → 优先 App 详情（拦截 AOSP 电池优化页）
  //   OPPO/vivo/realme/一加/三星/魅族/原生 → 优先电池优化列表

  const xiaomiLike = ['xiaomi', 'redmi']
  const bBkLike = ['oppo', 'vivo', 'realme']

  if (mfr === 'honor') {
    // ★ 荣耀实测：AOSP 电池优化列表可跳转
    return [IGNORE_LIST, APP_DETAILS, DIRECT_REQUEST]
  }

  if (mfr === 'huawei') {
    // 华为：先试电池优化列表
    return [IGNORE_LIST, APP_DETAILS, DIRECT_REQUEST]
  }

  if (xiaomiLike.includes(mfr)) {
    // 小米：APP_DETAILS 优先（拦截电池优化列表）
    return [APP_DETAILS, IGNORE_LIST, DIRECT_REQUEST]
  }

  if (bBkLike.includes(mfr)) {
    // OPPO/vivo/realme：先试通用电池优化列表
    return [IGNORE_LIST, APP_DETAILS, DIRECT_REQUEST]
  }

  if (mfr === 'oneplus') {
    // 一加：AOSP 兼容性好，电池优化列表优先
    return [IGNORE_LIST, APP_DETAILS, DIRECT_REQUEST]
  }

  // 三星/魅族/未知 → 先试电池优化列表（AOSP 兼容性好）
  return [IGNORE_LIST, APP_DETAILS, DIRECT_REQUEST]
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
    console.log(`${TAG} packageName = ${pkgName}`)

    // ★ 方案 A: Context.POWER_SERVICE 常量
    try {
      const Context = plus.android.importClass('android.content.Context')
      const pm = plus.android.invoke(main, 'getSystemService', Context.POWER_SERVICE)
      console.log(`${TAG} 方案A pm = ${pm ? 'object' : 'NULL'}`)
      if (pm) {
        const result = plus.android.invoke(pm, 'isIgnoringBatteryOptimizations', pkgName)
        const typeStr = result === true ? '✅ true' : result === false ? '❌ false' : '⚠ ' + typeof result + '=' + String(result)
        console.log(`${TAG} isIgnoring[方案A]: ${typeStr}`)
        return !!result
      }
    } catch (e) {
      console.warn(`${TAG} 方案A 异常: ${e?.message || e}`)
    }

    // ★ 方案 B: 字符串 'power'
    try {
      const pm = plus.android.invoke(main, 'getSystemService', 'power')
      console.log(`${TAG} 方案B pm = ${pm ? 'object' : 'NULL'}`)
      if (pm) {
        const result = plus.android.invoke(pm, 'isIgnoringBatteryOptimizations', pkgName)
        const typeStr = result === true ? '✅ true' : result === false ? '❌ false' : '⚠ ' + typeof result + '=' + String(result)
        console.log(`${TAG} isIgnoring[方案B]: ${typeStr}`)
        return !!result
      }
    } catch (e) {
      console.warn(`${TAG} 方案B 异常: ${e?.message || e}`)
    }

    console.warn(`${TAG} ⚠ 无法获取 PowerManager，假定已豁免`)
    return true
  } catch (e) {
    console.error(`${TAG} ❌ 检查失败:`, e?.message || e)
    return true
  }
}

/**
 * ★ v3.22-fix1: 检查用户是否已手动确认豁免
 *
 * 当 AOSP API 无法检测豁免状态时（如荣耀的私有电源管理），
 * 提供「手动确认」机制：用户设置完成 → 本地标记 → 不再骚扰。
 *
 * @returns {boolean} 用户是否已手动确认
 */
export function isManualExempted() {
  try {
    // 优先用 uni（uni-app 环境），回退 plus.storage（纯 5p+ 环境）
    const storage = typeof uni !== 'undefined' ? uni : plus.storage
    const val = storage.getStorageSync('battery_opt_manual_confirmed')
    console.log(`${TAG} isManualExempted: storageRead = ${JSON.stringify(val)}, !! = ${!!val}`)
    return !!val
  } catch (e) {
    console.error(`${TAG} isManualExempted 异常: ${e?.message || e}`)
    return false
  }
}

/**
 * 标记用户已手动完成电池优化设置
 * 写入本地标记，后续 isManualExempted() 返回 true
 */
export function markManualExempted() {
  try {
    const storage = typeof uni !== 'undefined' ? uni : plus.storage
    storage.setStorageSync('battery_opt_manual_confirmed', 1)
    console.log(`${TAG} ✅ 已写入 battery_opt_manual_confirmed = 1`)
    // 立即验证写入
    const verify = storage.getStorageSync('battery_opt_manual_confirmed')
    console.log(`${TAG} ✅ 验证读取: ${JSON.stringify(verify)}`)
  } catch (e) {
    console.error(`${TAG} ❌ 写入手动确认标记失败:`, e?.message || e)
  }
}

/**
 * ★ 综合判断：AOSP API 豁免 || 用户手动确认豁免
 *
 * 调用方应使用此函数替代 isIgnoringBatteryOptimizations() 做决策。
 *
 * @returns {boolean} true = 可以跳过电池优化引导
 */
export function isBatteryExempted() {
  const aosp = isIgnoringBatteryOptimizations()
  console.log(`${TAG} isBatteryExempted: aosp=${aosp}`)
  if (aosp) return true

  const manual = isManualExempted()
  console.log(`${TAG} isBatteryExempted: manual=${manual}`)
  if (manual) return true

  console.log(`${TAG} isBatteryExempted: ❌ 未豁免（AOSP 和手动均未确认）`)
  return false
}

/**
 * 打开系统电池优化豁免设置页（ROM 感知）
 *
 * 根据 ROM 品牌选择最优跳转策略：
 *   华为/荣耀/小米 → 优先 App 详情页（最可靠）
 *   OPPO/vivo/一加  → 优先电池优化列表（可能支持）
 *   三星/魅族/未知  → 优先电池优化列表（AOSP 兼容性好）
 *
 * @returns {boolean} 是否成功打开设置页
 */
export function openBatteryOptimizationSettings() {
  if (!isAndroidApp()) return false

  const main = getMainActivity()
  if (!main) return false

  // ★ 确保 ROM 已检测（内部缓存，不会重复请求）
  detectRom()

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
      return true
    } catch (e) {
      console.warn(`${TAG} ⚠ startActivity 异常:`, e?.message)
      return false
    }
  }

  try {
    const pkgName = plus.android.invoke(main, 'getPackageName')
    const Settings = plus.android.importClass('android.provider.Settings')

    // ★ ROM 感知的跳转策略
    const strategies = getRomIntentStrategy(pkgName)

    for (const strat of strategies) {
      // 填充 action（运行时从 Settings 类获取）
      if (strat.action === null) {
        if (strat.label === '电池优化列表') {
          strat.action = Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS
        } else if (strat.label === '应用详情页') {
          strat.action = Settings.ACTION_APPLICATION_DETAILS_SETTINGS
        } else if (strat.label === '直达豁免页') {
          strat.action = Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS
        }
      }

      if (tryIntent(strat.action, strat.data)) {
        console.log(`${TAG} ✅ 已打开${strat.label}`)
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
