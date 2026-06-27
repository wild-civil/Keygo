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

// BLE GATT 服务 UUID（与 ESP32 固件一致）
export const BLE_CONFIG = {
  deviceNamePrefix: 'KeyGo',                                    // ★ v2.2: 前缀匹配，设备名为 KeyGo-XXXXXX
  serviceUUID: '0000FF00-0000-1000-8000-00805F9B34FB',
  configCharUUID: '0000FF01-0000-1000-8000-00805F9B34FB',      // Write: 配置下发 / RSSI 注入
  statusCharUUID: '0000FF02-0000-1000-8000-00805F9B34FB',      // Read/Notify: 状态上报
  commandCharUUID: '0000FF03-0000-1000-8000-00805F9B34FB',     // Write: 手动命令 / BIND / UNBIND
}

// ==================== 蓝牙适配器 ====================

/**
 * 初始化蓝牙适配器（打开蓝牙）
 */
export function initBluetooth() {
  return new Promise((resolve, reject) => {
    uni.openBluetoothAdapter({
      success: () => {
        console.log('[BLE] 适配器初始化成功')
        resolve()
      },
      fail: (err) => {
        console.error('[BLE] 适配器初始化失败', err)
        reject(err)
      }
    })
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
              localName: device.localName
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

    // ★ v2.2: 开始扫描
    //   注意：不指定 services 参数做系统级过滤，因为：
    //     - NimBLE 的 128-bit UUID 广播在部分平台（Android 微信小程序）可能不被 services 过滤器识别
    //     - 用设备名前缀 "KeyGo" 做软件层过滤同样精准，没有其他设备会叫 KeyGo-XXXXXX
    //   如需启用 services 过滤，取消下面注释：
    //     services: [BLE_CONFIG.serviceUUID],
    uni.startBluetoothDevicesDiscovery({
      allowDuplicatesKey: true,
      interval: 0,
      success: () => {
        console.log('[BLE] 扫描已开始 (no service filter, using name prefix: ' + BLE_CONFIG.deviceNamePrefix + ')')
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
 * 安全地移除设备发现监听
 */
function stopDeviceFoundListener() {
  if (_deviceFoundCallback) {
    try {
      // uni-app 部分旧版本没有 offBluetoothDeviceFound
      if (typeof uni.offBluetoothDeviceFound === 'function') {
        uni.offBluetoothDeviceFound()
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
    // 连接前先停止扫描
    stopScan().then(() => {
      uni.createBLEConnection({
        deviceId,
        timeout: 10000,
        success: () => {
          console.log('[BLE] 连接成功', deviceId)
          // 请求更大的 MTU 以支持长 JSON 数据
          setTimeout(() => {
            uni.setBLEMTU({
              deviceId,
              mtu: 256,
              success: (res) => {
                console.log('[BLE] MTU 设置成功:', res.mtu)
              },
              fail: (err) => {
                console.warn('[BLE] MTU 设置失败（可能使用默认20字节）:', err.errMsg)
              },
              complete: () => {
                resolve()
              }
            })
          }, 500)
        },
        fail: (err) => {
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
  return new Promise((resolve) => {
    uni.closeBLEConnection({
      deviceId,
      success: () => resolve(),
      fail: () => resolve(),
      complete: () => resolve()
    })
  })
}

/**
 * 监听 BLE 连接状态变化
 * @param {Function} callback (connected: boolean, deviceId: string) => void
 */
export function onBLEConnectionStateChange(callback) {
  uni.onBLEConnectionStateChange((res) => {
    const connected = res.connected
    const deviceId = res.deviceId
    console.log(`[BLE] 连接状态变化: deviceId=${deviceId}, connected=${connected}`)
    if (typeof callback === 'function') {
      callback(connected, deviceId)
    }
  })
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
      fail: (err) => reject(err)
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
 * 监听特征值数据变化
 * @param {Function} callback (res) => void
 */
export function onBLECharacteristicValueChange(callback) {
  uni.onBLECharacteristicValueChange((res) => {
    if (typeof callback === 'function') {
      callback(res)
    }
  })
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
  return writeBLECharacteristicValue(
    deviceId,
    BLE_CONFIG.serviceUUID,
    BLE_CONFIG.commandCharUUID,
    command.toUpperCase()
  )
}

// ==================== 工具函数 ====================

/**
 * 字符串转 ArrayBuffer
 */
function stringToArrayBuffer(str) {
  const buffer = new ArrayBuffer(str.length)
  const dataView = new Uint8Array(buffer)
  for (let i = 0; i < str.length; i++) {
    dataView[i] = str.charCodeAt(i)
  }
  return buffer
}

/**
 * ArrayBuffer 转字符串
 */
export function arrayBufferToString(buffer) {
  if (!buffer) return ''
  const dataView = new Uint8Array(buffer)
  let str = ''
  for (let i = 0; i < dataView.byteLength; i++) {
    str += String.fromCharCode(dataView[i])
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
