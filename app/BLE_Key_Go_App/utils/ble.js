/**
 * BLE 蓝牙管理工具类
 * 封装 uni-app 蓝牙 API，提供简洁的 Promise 接口
 * 兼容 uni-app 各版本 API 差异
 *
 * v2.2 更新：
 *   - deviceName 改为前缀 "KeyGo"，匹配所有 KeyGo-XXXXXX 设备
 *   - 扫描时指定 services 进行系统级过滤，只看到自家产品
 *   - 新增 deviceNamePrefix 用于名字前缀匹配
 */

// BLE GATT 服务 UUID（与 KeyGo 设备固件一致）
export const BLE_CONFIG = {
  deviceNamePrefix: 'KeyGo',                                    // ★ v2.2: 前缀匹配，设备名为 KeyGo-XXXXXX
  serviceUUID: '0000FF00-0000-1000-8000-00805F9B34FB',
  configCharUUID: '0000FF01-0000-1000-8000-00805F9B34FB',      // Write: 配置下发 / RSSI 注入
  statusCharUUID: '0000FF02-0000-1000-8000-00805F9B34FB',      // Read/Notify: 状态上报
  commandCharUUID: '0000FF03-0000-1000-8000-00805F9B34FB',     // Write: 手动命令 / BIND / UNBIND
  serialCharUUID: '0000FF04-0000-1000-8000-00805F9B34FB',      // ★ v3.3: Read-Only 设备序列号（永久唯一）
}

// ==================== 蓝牙适配器 ====================

/**
 * 获取蓝牙适配器状态（不打开蓝牙，仅查询）
 * @returns {Promise<{available: boolean, discovering: boolean}>}
 */
export function getBluetoothAdapterState() {
  return new Promise((resolve) => {
    uni.getBluetoothAdapterState({
      success: (res) => {
        console.log('[BLE] 适配器状态:', JSON.stringify(res))
        resolve({ available: res.available, discovering: res.discovering })
      },
      fail: (err) => {
        // 适配器未初始化时 available=false
        console.warn('[BLE] 获取适配器状态失败:', err?.errMsg || err)
        resolve({ available: false, discovering: false })
      }
    })
  })
}

// ==================== Android 运行时权限 ====================

/**
 * ★ Android 运行时权限申请（BLE 必需）
 *
 * 背景：Android 6.0+ 要求 ACCESS_FINE_LOCATION 动态申请才能使用 BLE；
 *       Android 12+ 额外要求 BLUETOOTH_SCAN / BLUETOOTH_CONNECT。
 *       仅声明在 manifest 中不够，必须在运行时调用 plus.android.requestPermissions。
 *
 * @returns {Promise<{granted: boolean, denied: string[]}>}
 */
function requestAndroidPermissions() {
  return new Promise((resolve) => {
    // ★ 纯运行时检测，不依赖 #ifdef（跨 .js 文件编译时可能失效）
    if (typeof plus === 'undefined') {
      console.warn('[BLE] plus 未就绪（非 App 环境），跳过权限申请')
      resolve({ granted: true, denied: [] })
      return
    }
    if (plus.os.name !== 'Android') {
      console.log('[BLE] 非 Android 平台，跳过权限申请')
      resolve({ granted: true, denied: [] })
      return
    }

    console.log('[BLE] ★★★ 进入 Android 权限申请 ★★★')
    console.log('[BLE] plus.os.name=' + plus.os.name + ', plus.os.version=' + plus.os.version)

    // 基础权限：定位（Android 6.0+ BLE 必需）
    const perms = [
      'android.permission.ACCESS_FINE_LOCATION',
      'android.permission.ACCESS_COARSE_LOCATION'
    ]

    // Android 12+ (API 31+) 还需要蓝牙权限
    let apiLevel = 0
    try {
      const VERSION = plus.android.importClass('android.os.Build$VERSION')
      apiLevel = VERSION.SDK_INT
      console.log('[BLE] API Level (from Build$VERSION):', apiLevel)
    } catch (e) {
      const v = parseFloat(plus.os.version || '0')
      apiLevel = v >= 12 ? 31 : 0
      console.log('[BLE] API Level (from version string):', apiLevel, 'versionStr=' + plus.os.version)
    }
    if (apiLevel >= 31) {
      perms.push('android.permission.BLUETOOTH_SCAN')
      perms.push('android.permission.BLUETOOTH_CONNECT')
    }

    console.log('[BLE] 准备申请 Android 权限:', JSON.stringify(perms), 'API=' + apiLevel)

    try {
      plus.android.requestPermissions(
        perms,
        (result) => {
          console.log('[BLE] requestPermissions 回调 - granted:', JSON.stringify(result.granted), 'deniedAlways:', JSON.stringify(result.deniedAlways), 'deniedPresent:', JSON.stringify(result.deniedPresent))
          const denied = (result.deniedAlways || []).concat(result.deniedPresent || [])
          console.log('[BLE] 权限最终结果 - 被拒绝的权限:', JSON.stringify(denied))
          resolve({ granted: denied.length === 0, denied })
        },
        (err) => {
          console.error('[BLE] requestPermissions 异常回调:', JSON.stringify(err))
          resolve({ granted: false, denied: perms })
        }
      )
    } catch (e) {
      console.error('[BLE] requestPermissions 同步抛出异常:', e)
      resolve({ granted: false, denied: perms })
    }
  })
}

/**
 * 初始化蓝牙适配器（打开蓝牙）
 *
 * ★ App 平台流程：
 *   1. 先申请 Android 运行时权限（定位 + 蓝牙）
 *   2. 权限通过后调 openBluetoothAdapter
 *   3. 如果蓝牙未开(code=10001) → Android 原生弹窗请求开启 → 轮询等待
 *
 * ★ v3.6: 已初始化时 "already open" 视为成功
 *
 * @param {Object} [options]
 * @param {Function} [options.onAllowing] 用户点「允许」时立即回调（不等适配器就绪）
 */
export function initBluetooth(options = {}) {
  return new Promise((resolve, reject) => {
    requestAndroidPermissions().then((permResult) => {
      if (!permResult.granted) {
        const err = new Error('PERMISSION_DENIED')
        err.deniedPermissions = permResult.denied
        err.code = 'PERMISSION_DENIED'
        reject(err)
        return
      }

      uni.openBluetoothAdapter({
        success: () => {
          console.log('[BLE] 适配器初始化成功')
          resolve()
        },
        fail: (err) => {
          const msg = String(err?.errMsg || err || '')
          const code = err?.code ?? err?.errCode

          // "already open" → 成功
          if (msg.includes('already open')) {
            console.log('[BLE] 适配器已初始化（already open），视为成功')
            resolve()
            return
          }

          // code=10001 系统蓝牙未开启
          if (code === 10001) {
            console.warn('[BLE] 系统蓝牙未开启 (code=10001)，尝试原生弹窗...')

            // #ifdef APP-PLUS
            // ★ Android：用原生 Intent 弹出系统「开启蓝牙」弹窗（和 nRF Connect 一样）
            if (typeof plus !== 'undefined' && plus.os.name === 'Android') {
              requestEnableBluetoothAndroid(options.onAllowing).then(() => {
                console.log('[BLE] 原生弹窗已确认（用户点了允许）→ 等待蓝牙适配器就绪...')
                // ★ v3.10: onActivityResult 在用户点「允许」时立即 resolve，
                //   但此时蓝牙可能还在 TURNING_ON 状态，openBluetoothAdapter 可能失败。
                //   轮询重试直到适配器可用（最多 5s，每 300ms 一次）
                let retryCount = 0
                const maxRetries = 17  // ~5s
                const retry = () => {
                  uni.openBluetoothAdapter({
                    success: () => {
                      console.log('[BLE] 适配器初始化成功')
                      resolve()
                    },
                    fail: (err2) => {
                      const msg2 = String(err2?.errMsg || err2?.message || '')
                      if (msg2.includes('already open')) {
                        console.log('[BLE] 适配器已初始化（already open）')
                        resolve()
                        return
                      }
                      // code=10001 或 "not available" → 蓝牙还在启动中，重试
                      const code2 = err2?.code ?? err2?.errCode
                      if ((code2 === 10001 || msg2.includes('not available')) && retryCount < maxRetries) {
                        retryCount++
                        setTimeout(retry, 300)
                        return
                      }
                      console.error('[BLE] 二次初始化仍失败（已重试' + retryCount + '次）', err2)
                      reject(err2)
                    }
                  })
                }
                retry()
              }).catch((reason) => {
                // 用户拒绝或超时
                console.warn('[BLE] 原生弹窗失败:', reason)
                const denyErr = new Error(String(reason) || '用户拒绝开启蓝牙')
                denyErr.code = 10001
                reject(denyErr)
              })
              return
            }
            // #endif

            // 非 Android 或非 App-Plus：直接 reject
            reject(err)
            return
          }

          console.error('[BLE] 适配器初始化失败', err)
          reject(err)
        }
      })
    })
  })
}

// ==================== Android 原生蓝牙开启弹窗 ====================

/**
 * ★ 使用 Android 原生 API 弹出系统「开启蓝牙」对话框
 *
 * 效果与 nRF Connect 完全一致：
 *   底部弹出系统对话框 "BLE车钥匙 想要开启蓝牙"
 *   用户点「允许」→ onAllowing() 立即回调 → 适配器轮询 → Promise resolve
 *   用户点「拒绝」→ Promise reject
 *
 * @param {Function} [onAllowing] 用户点「允许」时立即回调（不等适配器就绪）
 * @returns {Promise<void>}
 */
function requestEnableBluetoothAndroid(onAllowing) {
  return new Promise((resolve, reject) => {
    try {
      const main = plus.android.runtimeMainActivity()
      const Intent = plus.android.importClass('android.content.Intent')
      const BluetoothAdapter = plus.android.importClass('android.bluetooth.BluetoothAdapter')

      // 检查 BluetoothAdapter 是否可用
      const adapter = BluetoothAdapter.getDefaultAdapter()

      if (adapter && adapter.isEnabled()) {
        console.log('[BLE] 蓝牙已经开启了，无需弹窗')
        resolve()
        return
      }

      // ★ v3.10: 用 onActivityResult 在用户点「允许」时立即 resolve
      //   这样 enableBluetooth() 的绿 banner 才能与 Android 「正在开启蓝牙」弹窗同步出现
      console.log('[BLE] 发送 ACTION_REQUEST_ENABLE Intent...')
      const intent = new Intent(BluetoothAdapter.ACTION_REQUEST_ENABLE)

      let resolved = false

      // ★ 保存并恢复原始 onActivityResult（避免破坏 uni-app 内部逻辑）
      const _origOnActivityResult = main.onActivityResult
      main.onActivityResult = function(requestCode, resultCode, data) {
        if (requestCode === 1001 && !resolved) {
          const RESULT_OK = -1  // android.app.Activity.RESULT_OK
          const RESULT_CANCELED = 0
          if (resultCode === RESULT_OK) {
            resolved = true
            console.log('[BLE] ★ onActivityResult: 用户点击了「允许」')
            // ★ 到达用户点「允许」的瞬间 → 立即通知上层亮绿 banner
            //   此时系统「正在开启蓝牙…」弹窗正在显示，绿 banner 与之同步出现
            if (typeof onAllowing === 'function') {
              onAllowing()
            }
            cleanup()
            resolve()
            return
          }
          if (resultCode === RESULT_CANCELED) {
            resolved = true
            console.warn('[BLE] ★ onActivityResult: 用户点击了「拒绝」→ reject')
            cleanup()
            reject('USER_DENIED')
            return
          }
        }
        // 非本请求的 ActivityResult → 透传给原始处理器
        if (_origOnActivityResult) {
          _origOnActivityResult.call(main, requestCode, resultCode, data)
        }
      }

      const cleanup = () => {
        main.onActivityResult = _origOnActivityResult
        clearInterval(checkInterval)
        clearTimeout(timeoutTimer)
        clearTimeout(fastRejectTimer)
      }

      main.startActivityForResult(intent, 1001)

      // ★ 轮询：兜底方案（onActivityResult 可能在某些 ROM 上不被调用）
      const checkInterval = setInterval(() => {
        if (resolved) return
        try {
          const adapter2 = BluetoothAdapter.getDefaultAdapter()
          if (adapter2 && adapter2.isEnabled()) {
            resolved = true
            clearInterval(checkInterval)
            clearTimeout(timeoutTimer)
            clearTimeout(fastRejectTimer)
            console.log('[BLE] 轮询兜底：检测到蓝牙已开启 ✅')
            // 恢复原始 onActivityResult
            if (main.onActivityResult !== _origOnActivityResult) {
              main.onActivityResult = _origOnActivityResult
            }
            // 稍等让系统稳定一下
            setTimeout(resolve, 500)
          }
        } catch (e) {
          // 忽略检查异常
        }
      }, 500)

      // ★ 快速拒绝检测 — 3 秒内蓝牙未开启则视为用户拒绝
      const fastRejectTimer = setTimeout(() => {
        if (resolved) return
        try {
          const adapter3 = BluetoothAdapter.getDefaultAdapter()
          if (adapter3 && adapter3.isEnabled()) {
            console.log('[BLE] 快速拒绝检测时发现蓝牙已开启，继续等待')
            return
          }
        } catch (e) { /* ignore */ }
        resolved = true
        clearInterval(checkInterval)
        console.warn('[BLE] 快速拒绝：用户未在 3s 内开启蓝牙')
        cleanup()
        reject('USER_DENIED_FAST')
      }, 3000)

      // ★ 绝对安全网超时 12 秒（兜底）
      const timeoutTimer = setTimeout(() => {
        if (!resolved) {
          resolved = true
          clearInterval(checkInterval)
          console.warn('[BLE] 开启蓝牙等待超时(12s)')
          cleanup()
          reject('USER_DENIED')
        }
      }, 12000)

    } catch (e) {
      console.error('[BLE] 原生弹窗异常:', e)
      // ★ 降级：弹出提示 + 轮询等待用户手动开启
      waitForBluetoothOn(12).then(resolve).catch(() => reject('TIMEOUT'))
    }
  })
}

/**
 * ★ 轮询等待蓝牙被开启（用于原生弹窗降级 或 手动引导场景）
 *
 * @param {number} timeoutSec 超时秒数
 * @returns {Promise<void>}
 */
export function waitForBluetoothOn(timeoutSec = 45) {
  return new Promise((resolve, reject) => {
    let elapsed = 0
    const interval = 800
    const maxAttempts = (timeoutSec * 1000) / interval
    let attempts = 0

    console.log('[BLE] 开始轮询等待蓝牙开启（最长 ' + timeoutSec + 's）...')

    const timer = setInterval(() => {
      attempts++
      elapsed = Math.round(attempts * interval / 1000)

      try {
        // 直接用 uni.getBluetoothAdapterState 检测
        uni.getBluetoothAdapterState({
          success: (res) => {
            if (res.available) {
              clearInterval(timer)
              console.log('[BLE] 轮询检测到蓝牙已开启 ✅ (' + elapsed + 's)')
              setTimeout(resolve, 300) // 让系统稳定一下
              return
            }
          },
          fail: () => {} // 适配器未初始化也继续等
        })

        // 也试试原生方式（更可靠）
        if (typeof plus !== 'undefined' && plus.os.name === 'Android') {
          try {
            const BluetoothAdapter = plus.android.importClass('android.bluetooth.BluetoothAdapter')
            const adapter = BluetoothAdapter.getDefaultAdapter()
            if (adapter && adapter.isEnabled()) {
              clearInterval(timer)
              console.log('[BLE] 原生检测到蓝牙已开启 ✅ (' + elapsed + 's)')
              setTimeout(resolve, 300)
              return
            }
          } catch (e) {}
        }
      } catch (e) {}

      // 超时
      if (attempts >= maxAttempts) {
        clearInterval(timer)
        console.warn('[BLE] 等待蓝牙开启超时 (' + timeoutSec + 's)')
        reject('等待超时')
      }
    }, interval)
  })
}

/**
 * 关闭蓝牙适配器
 */
export function closeBluetooth() {
  return new Promise((resolve) => {
    uni.closeBluetoothAdapter({
      success: () => resolve(),
      fail: () => resolve(),
      complete: () => resolve()
    })
  })
}

/**
 * ★ v3.6: 监听系统蓝牙适配器状态变化（用户从控制中心开关蓝牙时触发）
 * @param {Function} callback (available: boolean, discovering: boolean) => void
 * @returns {Function} handler 引用，供精准 off
 */
export function onBluetoothAdapterStateChange(callback) {
  const handler = (res) => {
    console.log('[BLE] 适配器状态变化: available=' + res.available + ', discovering=' + res.discovering)
    if (typeof callback === 'function') {
      callback(res.available, res.discovering)
    }
  }
  uni.onBluetoothAdapterStateChange(handler)
  return handler
}

// ==================== 扫描相关 ====================

let _deviceFoundCallback = null   // 保存 onBluetoothDeviceFound 的回调引用
let _scanTimer = null             // 扫描超时定时器

/**
 * 开始扫描 BLE 设备
 * @param {Function} onDeviceFound 每发现一个目标设备时的回调 (device) => void
 * @param {number} timeout 扫描超时（秒），默认 10
 * @returns {Promise<Array>} 扫描到的设备列表
 */
export function startScan(onDeviceFound, timeout = 10) {
  return new Promise((resolve, reject) => {
    const devices = []
    const foundSet = new Set()

    // 先清除旧的监听
    stopDeviceFoundListener()

    // 注册设备发现回调
    _deviceFoundCallback = (res) => {
      for (const device of res.devices) {
        // ★ v2.2 Fix: NimBLE 128-bit UUID 挤占广播包，完整名(如 KeyGo-71C65A) 落入
        //   Scan Response，微信 API 的 localName/name 只能拿到截断后的短名(如 "Ke")。
        //   解决方案：三级探测 + UUID 兜底 → 确认是我们的设备后，用 deviceId 重建完整名。
        const parsedName = parseAdvertisName(device.advertisData)
        const localName  = device.localName || ''
        const devName    = device.name || ''

        // 三级取最长
        let rawName = parsedName
        if (localName.length > rawName.length) rawName = localName
        if (devName.length    > rawName.length) rawName = devName

        // UUID 匹配
        const advUUIDs = device.advertisServiceUUIDs || []
        const uuidMatch = advUUIDs.some(uuid =>
          uuid.toUpperCase() === BLE_CONFIG.serviceUUID.toUpperCase()
        )

        // 名字匹配：完整前缀 OR 截断前缀（如 "Ke" 是 "KeyGo" 的开头）
        const fullMatch    = rawName.startsWith(BLE_CONFIG.deviceNamePrefix)
        const partialMatch = BLE_CONFIG.deviceNamePrefix.startsWith(rawName) && rawName.length >= 2

        if (fullMatch || partialMatch || uuidMatch) {
          if (!foundSet.has(device.deviceId)) {
            foundSet.add(device.deviceId)
            // 显示名：有完整前缀用原名，否则用 deviceId 重建 KeyGo-XXXXXX
            //   注意：deviceId 可能是 60:55:F9:71:C6:5A 格式，需先去冒号再取后6位
            const macClean = device.deviceId.replace(/:/g, '')
            const macSuffix = macClean.slice(-6).toUpperCase()
            const displayName = rawName.startsWith(BLE_CONFIG.deviceNamePrefix)
              ? rawName
              : ('KeyGo-' + macSuffix)
            const dev = {
              deviceId: device.deviceId,
              name: displayName,
              RSSI: device.RSSI,
              advertisData: device.advertisData,
              localName: device.localName,
              fingerprint: parseManufacturerFingerprint(device.advertisData)  // ★ v3.3: 设备指纹
            }
            devices.push(dev)
            if (typeof onDeviceFound === 'function') {
              onDeviceFound(dev)
            }
          }
        }
      }
    }

    uni.onBluetoothDeviceFound(_deviceFoundCallback)

    // ★ v3.2 优化: services 硬件级过滤 + 高功率扫描，大幅加速设备发现
    uni.startBluetoothDevicesDiscovery({
      services: [BLE_CONFIG.serviceUUID],
      allowDuplicatesKey: true,
      interval: 0,
      powerLevel: 'high',
      success: () => {
        console.log('[BLE] 扫描已开始 (services filter + high power)')
      },
      fail: (err) => {
        console.error('[BLE] 扫描失败', err)
        stopDeviceFoundListener()
        reject(err)
      }
    })

    // 超时停止扫描
    _scanTimer = setTimeout(() => {
      stopScan().then(() => {
        stopDeviceFoundListener()
        resolve(devices)
      })
    }, timeout * 1000)
  })
}

/**
 * 停止扫描
 */
export function stopScan() {
  clearTimeoutSafe()
  return new Promise((resolve) => {
    uni.stopBluetoothDevicesDiscovery({
      success: () => {
        console.log('[BLE] 扫描已停止')
        resolve()
      },
      fail: () => resolve(),
      complete: () => resolve()
    })
  })
}

/**
 * 安全地移除设备发现监听（仅移除自己的回调，不影响其他模块的监听）
 */
function stopDeviceFoundListener() {
  if (_deviceFoundCallback) {
    try {
      // ★ 传入回调：只移除自己的，不影响 RSSI 轮询等其他监听
      if (typeof uni.offBluetoothDeviceFound === 'function') {
        uni.offBluetoothDeviceFound(_deviceFoundCallback)
      }
    } catch (e) {
      // 忽略错误
    }
    _deviceFoundCallback = null
  }
}

/**
 * 安全清除定时器
 */
function clearTimeoutSafe() {
  if (_scanTimer) {
    clearTimeout(_scanTimer)
    _scanTimer = null
  }
}

// ==================== 连接相关 ====================

/**
 * 连接到 BLE 设备
 * @param {string} deviceId 设备 ID
 * @returns {Promise}
 */
export function connectDevice(deviceId) {
  return new Promise((resolve, reject) => {
    stopScan()
      .catch(() => {})  // ★ v3.6: 防止 stopScan reject 导致 Promise 链断裂
      .then(() => {
      uni.createBLEConnection({
        deviceId,
        timeout: 10000,
        success: () => {
          console.log('[BLE] 连接成功', deviceId)
          setTimeout(() => {
            uni.setBLEMTU({
              deviceId,
              mtu: 512,
              success: (res) => {
                console.log('[BLE] MTU 设置成功:', res.mtu)
              },
              fail: (err) => {
                console.warn('[BLE] MTU 设置失败（可能使用默认20字节）:', err.errMsg)
              },
              complete: () => resolve()
            })
          }, 500)
        },
        fail: (err) => {
          const msg = String(err?.errMsg || '')
          // ★ v3.6-fixG: "already connect" → Android GATT 句柄僵死
          //   抛出让 Store 层接管适配器重置（Store 需要用 _adapterResetting 标记压制状态事件）
          if (msg.includes('already connect')) {
            console.warn('[BLE] already connect → 交 Store 层处理适配器重置')
            reject(new Error('ALREADY_CONNECT_STALE'))
            return
          }
          console.error('[BLE] 连接失败', err)
          reject(err)
        }
      })
    })
  })
}

/**
 * 断开 BLE 连接
 * @param {string} deviceId 设备 ID
 */
export function disconnectDevice(deviceId) {
  return new Promise((resolve, reject) => {
    uni.closeBLEConnection({
      deviceId,
      success: () => resolve(),
      fail: (err) => {
        console.error('[BLE] 断开连接失败', deviceId, err)
        reject(err)
      }
    })
  })
}

/**
 * 注册 BLE 连接状态变化的全局监听（单例模式）
 * @param {Function} callback (connected: boolean, deviceId: string) => void
 * @returns {Function} 返回内部 handler 引用，供 uni.offBLEConnectionStateChange 精准移除
 */
export function onBLEConnectionStateChange(callback) {
  const handler = (res) => {
    const connected = res.connected
    const deviceId = res.deviceId
    console.log(`[BLE] 连接状态变化: deviceId=${deviceId}, connected=${connected}`)
    if (typeof callback === 'function') {
      callback(connected, deviceId)
    }
  }
  uni.onBLEConnectionStateChange(handler)
  return handler
}

// ==================== GATT 操作 ====================

/**
 * 获取设备服务列表
 * @param {string} deviceId 设备 ID
 * @returns {Promise<Array>}
 */
export function getBLEDeviceServices(deviceId) {
  return new Promise((resolve, reject) => {
    uni.getBLEDeviceServices({
      deviceId,
      success: (res) => {
        resolve(res.services)
      },
      fail: (err) => reject(err)
    })
  })
}

/**
 * 获取服务的特征值列表
 * @param {string} deviceId 设备 ID
 * @param {string} serviceId 服务 UUID
 */
export function getBLEDeviceCharacteristics(deviceId, serviceId) {
  return new Promise((resolve, reject) => {
    uni.getBLEDeviceCharacteristics({
      deviceId,
      serviceId,
      success: (res) => {
        resolve(res.characteristics)
      },
      fail: (err) => reject(err)
    })
  })
}

/**
 * 向特征值写入数据
 * @param {string} deviceId 设备 ID
 * @param {string} serviceId 服务 UUID
 * @param {string} characteristicId 特征值 UUID
 * @param {string} value 要写入的值
 */
export function writeBLECharacteristicValue(deviceId, serviceId, characteristicId, value) {
  return new Promise((resolve, reject) => {
    // 将字符串转为 ArrayBuffer
    const buffer = stringToArrayBuffer(value)
    uni.writeBLECharacteristicValue({
      deviceId,
      serviceId,
      characteristicId,
      value: buffer,
      success: () => {
        console.log(`[BLE] 写入成功: ${value}`)
        resolve()
      },
      fail: (err) => {
        console.error('[BLE] 写入失败', err)
        reject(err)
      }
    })
  })
}

/**
 * 读取特征值
 * @param {string} deviceId 设备 ID
 * @param {string} serviceId 服务 UUID
 * @param {string} characteristicId 特征值 UUID
 */
export function readBLECharacteristicValue(deviceId, serviceId, characteristicId) {
  return new Promise((resolve, reject) => {
    uni.readBLECharacteristicValue({
      deviceId,
      serviceId,
      characteristicId,
      success: (res) => {
        resolve(res)
      },
      fail: (err) => {
        // ★ uni-app 错误对象格式不统一，包装成标准 Error
        reject(new Error(err?.errMsg || err?.message || JSON.stringify(err)))
      }
    })
  })
}

/**
 * 启用特征值的 Notify 通知
 * @param {string} deviceId 设备 ID
 * @param {string} serviceId 服务 UUID
 * @param {string} characteristicId 特征值 UUID
 * @param {boolean} enable 是否启用
 */
export function notifyBLECharacteristicValueChange(deviceId, serviceId, characteristicId, enable = true) {
  return new Promise((resolve, reject) => {
    uni.notifyBLECharacteristicValueChange({
      deviceId,
      serviceId,
      characteristicId,
      state: enable,
      success: () => {
        console.log(`[BLE] Notify ${enable ? '启用' : '关闭'} 成功`)
        resolve()
      },
      fail: (err) => {
        console.error('[BLE] Notify 操作失败', err)
        reject(err)
      }
    })
  })
}

/**
 * 注册特征值数据变化的全局监听（单例模式）
 * @param {Function} callback (res) => void
 * @returns {Function} 返回内部 handler 引用，供 uni.offBLECharacteristicValueChange 精准移除
 */
export function onBLECharacteristicValueChange(callback) {
  const handler = (res) => {
    if (typeof callback === 'function') {
      callback(res)
    }
  }
  uni.onBLECharacteristicValueChange(handler)
  return handler
}

// ==================== 业务功能 ====================

/**
 * 发送配置到设备
 * @param {string} deviceId
 * @param {object} config { unlock, lock, uc, lc, interval, dlock }
 */
export async function sendConfig(deviceId, config) {
  const parts = []
  if (config.rssi !== undefined) parts.push(`rssi=${config.rssi}`)
  if (config.unlock !== undefined) parts.push(`unlock=${config.unlock}`)
  if (config.lock !== undefined) parts.push(`lock=${config.lock}`)
  if (config.uc !== undefined) parts.push(`uc=${config.uc}`)
  if (config.lc !== undefined) parts.push(`lc=${config.lc}`)
  if (config.interval !== undefined) parts.push(`interval=${config.interval}`)
  if (config.dlock !== undefined) parts.push(`dlock=${config.dlock}`)
  // ★ v3.7: 冷却时间 cooldown_ms
  if (config.cooldown_ms !== undefined) parts.push(`cooldown_ms=${config.cooldown_ms}`)

  const value = parts.join(' ')
  if (!value) return

  return writeBLECharacteristicValue(
    deviceId,
    BLE_CONFIG.serviceUUID,
    BLE_CONFIG.configCharUUID,
    value
  )
}

/**
 * 发送手动命令到设备
 * @param {string} deviceId
 * @param {string} command 'UNLOCK' | 'LOCK' | 'TRUNK' | 'STATUS'
 */
export function sendCommand(deviceId, command) {
  // ★ v3.1: 只大写命令前缀（冒号前），保护中文参数不被 toUpperCase() 破坏
  const colonIdx = command.indexOf(':')
  const safeCommand = colonIdx > 0
    ? command.substring(0, colonIdx).toUpperCase() + command.substring(colonIdx)
    : command.toUpperCase()

  return writeBLECharacteristicValue(
    deviceId,
    BLE_CONFIG.serviceUUID,
    BLE_CONFIG.commandCharUUID,
    safeCommand
  )
}

/**
 * ★ v3.3: 读取设备序列号（FF04 特征值）
 *
 * 返回一个 Promise，收到设备响应后 resolve 为 hex 字符串。
 * 内部通过 onBLECharacteristicValueChange 捕获 FF04 响应，
 * 匹配到目标 deviceId + characteristicId 后立即移除监听。
 *
 * @param {string} deviceId - 已连接的设备 ID
 * @param {number} timeoutMs - 超时（毫秒），默认 3000
 * @returns {Promise<string>} 序列号 hex 字符串
 */
export function readSerialNumber(deviceId, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    let resolved = false

    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true
        try { uni.offBLECharacteristicValueChange(handler) } catch {}
        reject(new Error('Read serial number timeout'))
      }
    }, timeoutMs)

    const handler = (res) => {
      if (resolved) return
      if (res.deviceId !== deviceId) return
      if ((res.characteristicId || '').toUpperCase() !== BLE_CONFIG.serialCharUUID.toUpperCase()) return

      resolved = true
      clearTimeout(timer)
      try { uni.offBLECharacteristicValueChange(handler) } catch {}

      const sn = arrayBufferToString(res.value)
      console.log('[BLE] 设备序列号:', sn)
      resolve(sn)
    }

    /**
     * ★ 读取前先显式做一次 GATT 特征发现，并打印设备实际暴露的特征列表。
     *    用于诊断"property not support"到底是因为固件没 FF04，还是手机端没发现。
     */
    const doRead = () => {
      readBLECharacteristicValue(deviceId, BLE_CONFIG.serviceUUID, BLE_CONFIG.serialCharUUID)
        .catch((err) => {
          if (!resolved) {
            resolved = true
            clearTimeout(timer)
            try { uni.offBLECharacteristicValueChange(handler) } catch {}
            reject(new Error(err?.errMsg || err?.message || '读序列号失败'))
          }
        })
    }

    uni.onBLECharacteristicValueChange(handler)

    // ★ 先获取设备特征列表，诊断性打印
    getBLEDeviceServices(deviceId).then(services => {
      console.log('[Serial] 服务发现完成:', services.length, '个服务')
      return getBLEDeviceCharacteristics(deviceId, BLE_CONFIG.serviceUUID)
    }).then(chars => {
      const uuidList = chars.map(c => c.uuid).join(', ')
      console.log('[Serial] FF00 特征值列表:', uuidList)
      // 检查 FF04 是否在列表中
      const hasFF04 = chars.some(c => c.uuid.toUpperCase() === BLE_CONFIG.serialCharUUID.toUpperCase())
      if (hasFF04) {
        console.log('[Serial] 已发现 FF04，准备读取...')
        // ★ 小幅延迟 150ms 再读取，让 GATT 数据库缓存就绪，防止 property not support
        setTimeout(() => doRead(), 150)
      } else {
        // ★ FF04 不在特征列表中 → 固件确实没暴露，或版本不对
        resolved = true
        clearTimeout(timer)
        try { uni.offBLECharacteristicValueChange(handler) } catch {}
        reject(new Error(`FF04 not in characteristic list. Found: [${uuidList}]`))
      }
    }).catch(err => {
      // 发现失败，仍尝试读取（降级兜底）
      console.warn('[Serial] 特征发现失败，直接尝试读取:', err?.errMsg || err?.message)
      doRead()
    })
  })
}

// ==================== 工具函数 ====================

/**
 * 字符串转 ArrayBuffer（UTF-8 编码，支持中文）
 *
 * ★ v3.1 Fix: 微信小程序不支持 TextEncoder，必须手写 UTF-8 编码。
 *   charCodeAt & 0xFF 只取低 8 位，会把中文截成乱码（"爱" → '1'）。
 */
function stringToArrayBuffer(str) {
  // TextEncoder 可用则直接使用（现代浏览器）
  if (typeof TextEncoder !== 'undefined') {
    return new TextEncoder().encode(str).buffer
  }

  // ★ 手动 UTF-8 编码（兼容微信小程序等无 TextEncoder 环境）
  const utf8 = []
  for (let i = 0; i < str.length; i++) {
    let code = str.charCodeAt(i)

    if (code < 0x80) {
      // 1 字节：0xxxxxxx
      utf8.push(code)
    } else if (code < 0x800) {
      // 2 字节：110xxxxx 10xxxxxx
      utf8.push(0xC0 | (code >> 6))
      utf8.push(0x80 | (code & 0x3F))
    } else if (code >= 0xD800 && code <= 0xDBFF) {
      // 代理对（4 字节，如 emoji）
      const next = str.charCodeAt(++i)
      code = 0x10000 + ((code - 0xD800) << 10) + (next - 0xDC00)
      utf8.push(0xF0 | (code >> 18))
      utf8.push(0x80 | ((code >> 12) & 0x3F))
      utf8.push(0x80 | ((code >> 6) & 0x3F))
      utf8.push(0x80 | (code & 0x3F))
    } else {
      // 3 字节：1110xxxx 10xxxxxx 10xxxxxx（所有 CJK 中文都在这个范围）
      utf8.push(0xE0 | (code >> 12))
      utf8.push(0x80 | ((code >> 6) & 0x3F))
      utf8.push(0x80 | (code & 0x3F))
    }
  }

  return new Uint8Array(utf8).buffer
}

/**
 * ArrayBuffer 转字符串（UTF-8 解码）
 *
 * ★ v3.1 Fix: 微信小程序不支持 TextDecoder，手写 UTF-8 解码。
 */
export function arrayBufferToString(buffer) {
  if (!buffer) return ''
  // TextDecoder 可用则直接使用
  if (typeof TextDecoder !== 'undefined') {
    return new TextDecoder('utf-8').decode(new Uint8Array(buffer))
  }

  // ★ 手动 UTF-8 解码（兼容微信小程序等无 TextDecoder 环境）
  const bytes = new Uint8Array(buffer)
  let str = ''
  let i = 0

  while (i < bytes.length) {
    const b0 = bytes[i]

    if (b0 < 0x80) {
      // 1 字节
      str += String.fromCharCode(b0)
      i += 1
    } else if ((b0 & 0xE0) === 0xC0) {
      // 2 字节
      const code = ((b0 & 0x1F) << 6) | (bytes[i + 1] & 0x3F)
      str += String.fromCharCode(code)
      i += 2
    } else if ((b0 & 0xF0) === 0xE0) {
      // 3 字节（中文主要在此）
      const code = ((b0 & 0x0F) << 12) | ((bytes[i + 1] & 0x3F) << 6) | (bytes[i + 2] & 0x3F)
      str += String.fromCharCode(code)
      i += 3
    } else if ((b0 & 0xF8) === 0xF0) {
      // 4 字节（emoji 等）
      const code = ((b0 & 0x07) << 18)
        | ((bytes[i + 1] & 0x3F) << 12)
        | ((bytes[i + 2] & 0x3F) << 6)
        | (bytes[i + 3] & 0x3F)
      str += String.fromCharCode(code)
      i += 4
    } else {
      // 无效字节，跳过
      i += 1
    }
  }

  return str
}

/**
 * 判断是否为有效的 JSON 字符串
 */
export function tryParseJSON(str) {
  try {
    return JSON.parse(str)
  } catch {
    return null
  }
}

/**
 * ★ v2.2 Fix: 从 BLE 广播原始数据中解析设备完整名称
 *
 * BLE Advertising Data 格式（TLV: Type-Length-Value）:
 *   Byte 0: AD Length (不包含自身)
 *   Byte 1: AD Type
 *   Byte 2..Length: AD Data
 *
 * 相关 AD Type:
 *   0x09 = Complete Local Name（完整设备名）
 *   0x08 = Shortened Local Name（缩短名，备用）
 *
 * @param {ArrayBuffer} advBuffer - device.advertisData 原始数据
 * @returns {string} 解析出的设备名，失败返回空串
 */
function parseAdvertisName(advBuffer) {
  if (!advBuffer || advBuffer.byteLength === 0) return ''

  try {
    const data = new Uint8Array(advBuffer)
    let i = 0

    while (i < data.length - 1) {
      const length = data[i]
      const type   = data[i + 1]

      if (length === 0) break  // 无效段

      const valueStart = i + 2
      const valueEnd   = valueStart + (length - 1)  // length 包含 type 字段占的1字节

      if (valueEnd > data.length) break  // 越界保护

      if (type === 0x09 || type === 0x08) {
        // Complete / Shortened Local Name → 提取 UTF-8 字符串
        let name = ''
        for (let j = valueStart; j < valueEnd; j++) {
          name += String.fromCharCode(data[j])
        }
        return name  // 0x09 优先级最高，直接返回
      }

      i = valueEnd
    }
  } catch (e) {
    // 字节级解析失败，安全降级
  }

  return ''
}

/**
 * ★ v3.3: 从广播原始数据中解析 Manufacturer Specific Data，提取设备指纹
 *
 * BLE AD Structure (TLV):
 *   Type 0xFF = Manufacturer Specific Data
 *   Format: [Company ID LSB][Company ID MSB][Data...]
 *
 * KeyGo 协议:
 *   Company ID: 0xFFFF (测试/保留)
 *   Data: "KG" (0x4B 0x47) + 3-byte MAC suffix
 *   旧版 (v3.2): 仅有 "KG"→ 7 字节 → null（无指纹）
 *   新版 (v3.3): "KG" + MAC[3-5] → 10 字节 → "71C65A"
 *
 * @param {ArrayBuffer} advBuffer - device.advertisData 原始数据
 * @returns {string|null} MAC 后缀 6 位大写 hex，解析失败返回 null
 */
export function parseManufacturerFingerprint(advBuffer) {
  if (!advBuffer || advBuffer.byteLength === 0) return null
  try {
    const data = new Uint8Array(advBuffer)
    let i = 0

    while (i < data.length - 1) {
      const len = data[i]
      const type = data[i + 1]
      if (len === 0) break

      const valStart = i + 2
      const valEnd = valStart + (len - 1)
      if (valEnd > data.length) break

      // AD Type 0xFF = Manufacturer Specific Data
      if (type === 0xFF && len >= 5) {
        // 校验 Company ID = 0xFFFF
        const companyId = data[valStart] | (data[valStart + 1] << 8)
        if (companyId !== 0xFFFF) {
          i = valEnd
          continue
        }

        // 校验 "KG" 协议标记
        const hasKG = data[valStart + 2] === 0x4B && data[valStart + 3] === 0x47
        if (!hasKG) {
          i = valEnd
          continue
        }

        // ★ v3.3+: "KG" 后有 3 字节 MAC 后缀
        if (valEnd - valStart >= 7) {
          const mac = [
            data[valStart + 4],
            data[valStart + 5],
            data[valStart + 6]
          ]
          return mac.map(b => b.toString(16).padStart(2, '0').toUpperCase()).join('')
        }
        // v3.2: 无后缀 → 返回 null
        return null
      }

      i = valEnd
    }
  } catch (e) {
    // 字节解析失败，安全降级
  }
  return null
}
