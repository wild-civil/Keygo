/**
 * ★ v3.11-fix: 原生 Android 蓝牙状态监控
 *
 * 用 BroadcastReceiver 直连系统 BluetoothAdapter.ACTION_STATE_CHANGED 广播，
 * 绕过 Uni-APP 的 onBluetoothAdapterStateChange 封装，获得即时、精确的状态通知。
 *
 * ★ 关键修正：plus.android.implements 回调中不能直接调用 .method()，
 *   必须使用 plus.android.invoke() 来调用 Java 方法，
 *   且常量使用硬编码字符串（避免 plus.android 无法访问 Java 静态字段）。
 *
 * 状态值：
 *   BluetoothAdapter.STATE_OFF        (10) → 蓝牙已关闭
 *   BluetoothAdapter.STATE_TURNING_ON (11) → 正在开启（用户刚点"允许"）
 *   BluetoothAdapter.STATE_ON         (12) → 蓝牙已开启
 *   BluetoothAdapter.STATE_TURNING_OFF(13) → 正在关闭
 *
 * @module ble-native
 */

// ★ 硬编码字符串常量（避免 plus.android 无法访问 Java 静态字段）
const ACTION_STATE_CHANGED = 'android.bluetooth.adapter.action.STATE_CHANGED'
const EXTRA_STATE = 'android.bluetooth.adapter.extra.STATE'
const EXTRA_PREVIOUS_STATE = 'android.bluetooth.adapter.extra.PREVIOUS_STATE'

let _receiver = null
let _main = null
let _callback = null
let _currentState = -1
let _registered = false
let _receiveCount = 0        // onReceive 调用计数
let _errorCount = 0          // onReceive 异常计数
let _nativeBroken = false    // 原生广播是否已损坏（需降级到 Uni-APP）

/**
 * 启动原生蓝牙状态监控
 * @param {Function} callback (state, prevState) => void
 *   state: 10=OFF, 11=TURNING_ON, 12=ON, 13=TURNING_OFF, -1=unknown
 * @returns {number} 当前蓝牙状态值，-1 表示不可用
 */
export function startNativeBluetoothMonitor(callback) {
  if (_registered) {
    console.log('[BLE-Native] 监听器已注册，更新回调')
    _callback = callback
    return _currentState
  }

  if (typeof plus === 'undefined') {
    console.warn('[BLE-Native] plus 不可用，跳过原生监控')
    return -1
  }

  _callback = callback

  try {
    _main = plus.android.runtimeMainActivity()

    // 获取当前状态
    try {
      const adapter = plus.android.invoke(
        plus.android.importClass('android.bluetooth.BluetoothAdapter'),
        'getDefaultAdapter'
      )
      if (adapter) {
        _currentState = plus.android.invoke(adapter, 'getState')
        console.log('[BLE-Native] 当前蓝牙状态: ' + _stateName(_currentState))
      }
    } catch (e) {
      console.warn('[BLE-Native] 获取当前状态失败:', e?.message)
    }

    // ★ 创建 BroadcastReceiver — 使用 plus.android.invoke 调用所有 Java 方法
    _receiver = plus.android.implements(
      'io.dcloud.android.content.BroadcastReceiver',
      {
        onReceive: function(context, intent) {
          _receiveCount++
          try {
            // ★ 关键：使用 plus.android.invoke，不能直接 intent.getAction()
            const action = plus.android.invoke(intent, 'getAction')
            if (action !== ACTION_STATE_CHANGED) return

            const newState = plus.android.invoke(intent, 'getIntExtra', EXTRA_STATE, -1)
            const prevState = plus.android.invoke(intent, 'getIntExtra', EXTRA_PREVIOUS_STATE, -1)

            if (newState === -1) return     // 无效状态
            if (newState === _currentState) return  // 去重

            const old = _currentState
            _currentState = newState

            console.log(
              '[BLE-Native] ⚡ ' + _stateName(old) + ' → ' + _stateName(newState)
            )

            if (_callback) {
              _callback(newState, prevState)
            }
          } catch (e) {
            _errorCount++
            console.error('[BLE-Native] onReceive 异常(#%d):', _errorCount, e?.message || e)

            // ★ 如果连续失败次数过多，标记原生广播已损坏
            if (_errorCount >= 3 || (e?.message || '').includes('is not a function')) {
              _nativeBroken = true
              console.warn('[BLE-Native] ⚠ 原生广播已损坏，需降级到 Uni-APP 事件')
            }
          }
        }
      }
    )

    const IntentFilter = plus.android.importClass('android.content.IntentFilter')
    const filter = new IntentFilter(ACTION_STATE_CHANGED)
    _main.registerReceiver(_receiver, filter)
    _registered = true
    _errorCount = 0
    _receiveCount = 0
    _nativeBroken = false
    console.log('[BLE-Native] ✅ BroadcastReceiver 已注册')
  } catch (e) {
    console.error('[BLE-Native] ❌ 注册 BroadcastReceiver 失败:', e?.message || e)
    _receiver = null
    _registered = false
    _nativeBroken = true
  }

  return _currentState
}

/**
 * 停止原生蓝牙状态监控
 */
export function stopNativeBluetoothMonitor() {
  if (_registered && _receiver && _main) {
    try {
      _main.unregisterReceiver(_receiver)
      console.log('[BLE-Native] BroadcastReceiver 已注销')
    } catch (e) {
      console.warn('[BLE-Native] 注销失败:', e?.message)
    }
  }
  _receiver = null
  _main = null
  _callback = null
  _registered = false
  _currentState = -1
  _receiveCount = 0
  _errorCount = 0
  _nativeBroken = false
}

/**
 * 直接查询原生蓝牙当前状态
 * @returns {number} 10=OFF, 11=TURNING_ON, 12=ON, 13=TURNING_OFF, -1=unknown
 */
export function getNativeBluetoothState() {
  try {
    const adapter = plus.android.invoke(
      plus.android.importClass('android.bluetooth.BluetoothAdapter'),
      'getDefaultAdapter'
    )
    if (!adapter) return -1
    return plus.android.invoke(adapter, 'getState')
  } catch (e) {
    return -1
  }
}

/**
 * 原生广播是否已损坏（需降级到 Uni-APP 事件）
 */
export function isNativeBroken() {
  return _nativeBroken
}

/**
 * 广播接收器是否已注册
 */
export function isNativeMonitorActive() {
  return _registered && !_nativeBroken
}

/** @private */
function _stateName(s) {
  const map = { 10: 'OFF', 11: 'TURNING_ON', 12: 'ON', 13: 'TURNING_OFF' }
  return map[s] || 'UNKNOWN(' + s + ')'
}
