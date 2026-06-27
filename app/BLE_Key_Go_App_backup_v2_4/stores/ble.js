/**
 * BLE 连接状态管理 - Pinia Store
 *
 * v2.2 更新：
 *   - 新增绑定相关状态：isBound, isAuthorized, pairingMode
 *   - 连接后自动检测绑定状态，未绑定时引导用户绑定
 *   - 新增 bind / unbind 操作
 *
 * v2.4 更新：
 *   - 新增主人分享密钥功能：generateShareKey / revokeShareKey / authWithShareKey
 *   - 客人通过分享密钥验证后跳过物理按钮 + PIN，直接 BIND 接管设备
 */

import { defineStore } from 'pinia'
import {
  BLE_CONFIG,
  initBluetooth,
  startScan,
  stopScan,
  connectDevice,
  disconnectDevice,
  sendConfig,
  sendCommand,
  onBLEConnectionStateChange,
  onBLECharacteristicValueChange,
  notifyBLECharacteristicValueChange,
  arrayBufferToString,
  tryParseJSON,
} from '@/utils/ble.js'
import { toast } from '@/utils/toast.js'

export const useBleStore = defineStore('ble', {
  state: () => ({
    // 连接状态
    connected: false,
    deviceId: '',
    deviceName: '',

    // ★ v2.2: 绑定相关状态
    isBound: false,           // 设备是否已被绑定（从 FF02 Notify 获取）
    isAuthorized: false,      // 当前连接是否已通过白名单校验
    pairingMode: false,       // 设备是否处于配对模式

    // ★ v2.3: PIN 码相关
    pinOk: false,             // 本次连接 PIN 是否已验证通过
    pinDefault: true,         // 设备 PIN 是否为出厂默认

    // ★ v2.4: 分享密钥相关
    shareActive: false,       // 设备是否有有效分享密钥
    shareExpiry: 0,           // 分享密钥剩余有效秒数
    shareVerified: false,     // 当前连接是否通过分享密钥认证
    generatedShareKey: '',    // 刚生成的分享密钥明文（一次性，用了即清）

    // 扫描状态
    scanning: false,
    devices: [],

    // 设备状态（从 FF02 Notify 接收）
    deviceState: 'LOCKED',       // LOCKED / UNLOCKED / ACTION
    rssi: -999,
    filteredRssi: -999,
    unlockThreshold: -45,
    lockThreshold: -65,
    unlockCountRequired: 5,
    lockCountRequired: 10,
    disconnectLockDelayMs: 5000,
    manualCooldown: false,       // 手动命令冷却中

    // 连接历史（自动重连用）
    lastDeviceId: '',
  }),

  getters: {
    // 状态中文映射
    stateText: (state) => {
      const map = {
        'LOCKED': '已锁车',
        'UNLOCKED': '已解锁',
        'ACTION': '执行中...'
      }
      return map[state.deviceState] || state.deviceState
    },

    // RSSI 距离估算
    rssiDistance: (state) => {
      const r = state.filteredRssi > -999 ? state.filteredRssi : state.rssi
      if (r === -999 || r === undefined) return '无信号'
      if (r >= -30) return '极近 (<0.5m)'
      if (r >= -45) return '很近 (~0.5m)'
      if (r >= -55) return '近 (~1m)'
      if (r >= -65) return '中等 (~2m)'
      if (r >= -75) return '远 (~5m)'
      return '很远 (>5m)'
    },

    // RSSI 信号强度百分比
    rssiPercent: (state) => {
      const r = state.filteredRssi > -999 ? state.filteredRssi : state.rssi
      if (r === -999 || r === undefined) return 0
      const pct = ((r + 100) / 80) * 100
      return Math.max(0, Math.min(100, Math.round(pct)))
    },

    // 已连接且状态为已解锁
    isUnlocked: (state) => state.connected && state.deviceState === 'UNLOCKED',
  },

  actions: {
    // ==================== 扫描 ====================

    /**
     * 初始化并开始扫描（连接页用）
     */
    async startScanDevices(timeout = 10) {
      // ★ 断开后冷却期内不能立即扫描，等待冷却结束
      if (this._coolingDown) {
        await new Promise(r => {
          const check = () => {
            if (!this._coolingDown) return r()
            setTimeout(check, 100)
          }
          check()
        })
      }

      // ★ 防御性清理：确保没有残留的 onBluetoothDeviceFound 监听器
      try { uni.offBluetoothDeviceFound() } catch {}

      try {
        await initBluetooth()
      } catch {
        // 可能已经初始化了
      }

      this.scanning = true
      this.devices = []

      try {
        const devices = await startScan(
          (device) => {
            this.devices.push(device)
          },
          timeout
        )
        // ★ 扫描完成时检查：如果已连接或已被中止，丢弃结果不覆盖设备列表
        //    防止断开/重连后旧扫描定时器"复活"设备列表
        if (this.connected || this._scanAborted) {
          this._scanAborted = false
          return devices
        }
        this.devices = devices
        return devices
      } catch (err) {
        console.error('[Store] 扫描失败', err)
        return []
      } finally {
        this.scanning = false
      }
    },

    /**
     * 停止扫描
     */
    async stopScanDevices() {
      this.scanning = false
      await stopScan()
    },

    // ==================== 连接 ====================

    /**
     * 连接到指定设备
     *
     * v2.2: 连接成功后检测绑定状态，未绑定时自动提示用户绑定
     */
    async connect(deviceId, deviceName = '') {
      try {
        await connectDevice(deviceId)
        this.deviceId = deviceId
        this.deviceName = deviceName || 'KeyGo'
        this.connected = true
        this.lastDeviceId = deviceId
        this.isAuthorized = false    // 先重置，等 Notify 上报确认
        this.pinOk = false           // ★ v2.3: 重置 PIN 验证状态

        // 保存设备 ID 到本地存储（用于自动重连）
        uni.setStorageSync('ble_device_id', deviceId)

        // 监听连接断开
        onBLEConnectionStateChange((connected, devId) => {
          if (devId === deviceId && !connected) {
            console.log('[Store] 设备断开连接')
            this._stopRssiPolling()
            this.connected = false
            this.isAuthorized = false
            this.pinOk = false        // ★ v2.3: 重置 PIN 验证状态
            this.shareVerified = false // ★ v2.4: 重置分享密钥认证
            this.generatedShareKey = '' // ★ v2.4: 清除一次性密钥明文
            this.deviceState = 'LOCKED'
            this.rssi = -999
            this.filteredRssi = -999
          }
        })

        // 等待连接稳定
        await new Promise(r => setTimeout(r, 1000))

        // 启用 Status 特征值的 Notify 接收设备状态上报
        await notifyBLECharacteristicValueChange(
          deviceId,
          BLE_CONFIG.serviceUUID,
          BLE_CONFIG.statusCharUUID,
          true
        )

        // Notify 分包拼接缓冲区
        let notifyBuffer = ''
        let notifyTimer = null
        let firstStatusReceived = false

        // 注册接收 Notify 数据的回调
        onBLECharacteristicValueChange((res) => {
          if (res.deviceId === deviceId &&
              res.characteristicId.toUpperCase() === BLE_CONFIG.statusCharUUID.toUpperCase()) {
            const chunk = arrayBufferToString(res.value)
            notifyBuffer += chunk

            if (notifyTimer) clearTimeout(notifyTimer)
            notifyTimer = setTimeout(() => {
              const fullData = notifyBuffer
              notifyBuffer = ''
              this._handleStatusNotify(fullData)

              // ★ 首次收到状态时检查绑定
              if (!firstStatusReceived) {
                firstStatusReceived = true
                this._onFirstStatusReceived()
              }
            }, 200)
          }
        })

        // ★ 启动手机端 RSSI 轮询（手机测 RSSI → 通过 FF01 写入 ESP32）
        this._startRssiPolling()

        return true
      } catch (err) {
        console.error('[Store] 连接流程失败', err)
        this.connected = false
        throw err
      }
    },

    /**
     * ★ v2.2: 首次收到状态后的处理
     */
    _onFirstStatusReceived() {
      if (!this.isBound && this.isAuthorized) {
        console.log('[Store] 设备未绑定，已授权，等待用户手动绑定')
        // 不再自动绑定，由用户通过按钮主动触发（避免未预期的绑定行为）
      } else if (this.isBound && !this.isAuthorized) {
        // ★ v2.4: 设备已绑定到其他手机 → 不自动断开，提供两种接管方式：
        //   方式一：按设备物理配对按钮 (PIN 9 短按)
        //   方式二：输入主人分享的密钥
        console.warn('[Store] 设备已绑定到其他手机，可按配对按钮或输入分享密钥')
        toast.info('此设备已绑定到其他手机，可按配对按钮或输入分享密钥接管')
      }
    },

    /**
     * 断开连接
     */
    async disconnect() {
      // ★ 标记任何进行中的扫描为"已中止"，防止其定时器在断开后复活设备列表
      this._scanAborted = true
      this._stopRssiPolling()
      // ★ 清空所有 BLE 监听器，避免多次连接/断开后监听器堆积导致重复回调
      try { uni.offBLEConnectionStateChange() } catch {}
      try { uni.offBLECharacteristicValueChange() } catch {}
      if (this.deviceId) {
        try {
          await disconnectDevice(this.deviceId)
        } catch {}
      }
      this.connected = false
      this.deviceId = ''
      this.deviceName = ''
      this.scanning = false        // ★ 强制复位扫描状态，避免 UI 卡在"扫描中..."
      this.isBound = false
      this.isAuthorized = false
      this.pinOk = false           // ★ v2.3: 重置 PIN 验证状态
      this.shareVerified = false   // ★ v2.4: 重置分享密钥认证
      this.generatedShareKey = ''  // ★ v2.4: 清除一次性密钥明文
      this.deviceState = 'LOCKED'
      this.rssi = -999
      this.filteredRssi = -999

      // ★ 断开后设冷却期：蓝牙协议栈释放连接需要 ~500ms，
      //    冷却期内 startScanDevices 会自动等待，避免扫描静默失败
      this._coolingDown = true
      setTimeout(() => { this._coolingDown = false }, 500)
    },

    /**
     * 尝试自动重连
     */
    async tryAutoConnect() {
      const savedDeviceId = uni.getStorageSync('ble_device_id')
      if (!savedDeviceId) return false

      try {
        await this.connect(savedDeviceId)
        return true
      } catch {
        return false
      }
    },

    // ==================== RSSI 轮询（手机端测 RSSI） ====================

    _rssiTimer: null,
    _rssiScanTimeout: null,     // ★ _doRssiScan 内部的 discovery 超时引用
    _rssiScanListener: null,
    _scanAborted: false,        // ★ 标记当前扫描结果应被丢弃（断开/重连时置 true）

    /**
     * 启动手机端 RSSI 轮询
     * 原理：连接后手机仍可扫描到 ESP32 的广播包，从中获取 RSSI，然后通过 FF01 写入给 ESP32
     * 注意：部分手机连接后无法扫描到同一设备的广播包，此时需要手动 RSSI 注入
     */
    _startRssiPolling() {
      this._stopRssiPolling()
      console.log('[Store] 手机端 RSSI 轮询已启动（每800ms）')

      // 注册一次设备发现监听（避免重复注册）
      this._rssiScanListener = (res) => {
        for (const device of res.devices) {
          if (device.deviceId === this.deviceId) {
            this._onPhoneRssiFound(device.RSSI)
            return
          }
        }
      }
      uni.onBluetoothDeviceFound(this._rssiScanListener)

      // 立即执行第一次
      this._doRssiScan()
      // 定时轮询
      this._rssiTimer = setInterval(() => {
        if (!this.connected || !this.deviceId) {
          this._stopRssiPolling()
          return
        }
        this._doRssiScan()
      }, 800)
    },

    /**
     * 停止 RSSI 轮询
     */
    _stopRssiPolling() {
      if (this._rssiTimer) {
        clearInterval(this._rssiTimer)
        this._rssiTimer = null
      }
      // ★ 清除 _doRssiScan 内部的 500ms 定时器，防止它在断开后"背刺"新扫描
      if (this._rssiScanTimeout) {
        clearTimeout(this._rssiScanTimeout)
        this._rssiScanTimeout = null
      }
      if (this._rssiScanListener) {
        try {
          // ★ 关键：必须先 off 掉监听，再停扫描，否则残留回调会串入后续新扫描
          uni.offBluetoothDeviceFound(this._rssiScanListener)
          uni.stopBluetoothDevicesDiscovery({ success: () => {}, fail: () => {} })
        } catch {}
        this._rssiScanListener = null
      }
      console.log('[Store] 手机端 RSSI 轮询已停止')
    },

    /**
     * 执行一次 RSSI 扫描
     */
    _doRssiScan() {
      uni.startBluetoothDevicesDiscovery({
        allowDuplicatesKey: true,
        interval: 0,
        success: () => {
          // ★ 保存定时器引用，方便 _stopRssiPolling 时取消
          this._rssiScanTimeout = setTimeout(() => {
            this._rssiScanTimeout = null
            uni.stopBluetoothDevicesDiscovery({
              success: () => {},
              fail: () => {}
            })
          }, 500)
        },
        fail: (err) => {
          console.warn('[Store] RSSI 扫描启动失败:', err.errMsg)
        }
      })
    },

    /**
     * 手机端扫描到目标设备的 RSSI
     */
    async _onPhoneRssiFound(rssiValue) {
      if (!this.connected || !this.deviceId) return
      // ★ 同时更新 raw RSSI 和 filtered RSSI（控制页显示的是 filteredRssi）
      this.rssi = rssiValue
      this.filteredRssi = rssiValue
      // 通过 FF01 将 RSSI 写入 ESP32，触发其状态机逻辑
      try {
        await sendConfig(this.deviceId, { rssi: rssiValue })
      } catch {}
    },

    // ==================== 状态处理 ====================

    /**
     * 处理设备通过 Notify 上报的状态数据
     * @param {string} jsonStr 已拼接完成的 JSON 字符串
     *
     * v2.2 新增字段: authorized, bound, deviceName, pairingMode
     */
    _handleStatusNotify(jsonStr) {
      // ★ 处理 BLE Notify 粘包：ESP32 可能连续发送多个 Status JSON，
      //    微信 BLE 可能在一次回调中拼接成 "{...}{...}"
      const jsons = jsonStr
        .replace(/\}\{/g, '}\x00{')   // 在 }{ 之间插入分割标记
        .split('\x00')

      for (const item of jsons) {
        if (!item.trim()) continue
        this._parseSingleStatus(item)
      }
    },

    /**
     * 解析单条 Status JSON
     */
    _parseSingleStatus(jsonStr) {
      const data = tryParseJSON(jsonStr)
      if (!data) {
        console.warn('[Store] 状态解析失败:', jsonStr)
        return
      }

      // ESP32 端通过 FF02 Notify 上报的状态
      if (data.rssi !== undefined && data.rssi > -999) {
        this.rssi = data.rssi
      }
      if (data.filtered !== undefined && data.filtered > -999) {
        this.filteredRssi = data.filtered
      }
      if (data.state !== undefined) this.deviceState = data.state
      if (data.unlock !== undefined) this.unlockThreshold = data.unlock
      if (data.lock !== undefined) this.lockThreshold = data.lock
      if (data.uc !== undefined) this.unlockCountRequired = data.uc
      if (data.lc !== undefined) this.lockCountRequired = data.lc
      if (data.disconnectLockMs !== undefined) this.disconnectLockDelayMs = data.disconnectLockMs
      if (data.manualCooldown !== undefined) this.manualCooldown = data.manualCooldown === 1

      // ★ v2.2: 绑定相关字段
      if (data.authorized !== undefined) this.isAuthorized = data.authorized === 1
      if (data.bound !== undefined) this.isBound = data.bound === 1
      if (data.deviceName !== undefined) this.deviceName = data.deviceName
      if (data.pairingMode !== undefined) this.pairingMode = data.pairingMode === 1

      // ★ v2.3: PIN 相关
      if (data.pin_ok !== undefined) this.pinOk = data.pin_ok === 1
      if (data.pin_default !== undefined) this.pinDefault = data.pin_default === 1

      // ★ v2.4: 分享密钥相关
      if (data.share_active !== undefined) this.shareActive = data.share_active === 1
      if (data.share_expiry !== undefined) this.shareExpiry = data.share_expiry
      if (data.share_verified !== undefined) this.shareVerified = data.share_verified === 1
      // 仅在 ESP32 刚生成密钥时返回明文（一次性）
      if (data.share_key && data.share_key.length > 0) {
        this.generatedShareKey = data.share_key
      }
    },

    // ==================== 命令 ====================

    /**
     * 发送配置到设备
     */
    async updateConfig(config) {
      if (!this.deviceId) throw new Error('未连接设备')
      await sendConfig(this.deviceId, config)
    },

    /**
     * 发送手动命令
     */
    async sendCommand(command) {
      if (!this.deviceId) throw new Error('未连接设备')
      await sendCommand(this.deviceId, command)
    },

    async unlock() {
      if (!this.connected) throw new Error('未连接设备')
      if (!this.isAuthorized) throw new Error('设备未授权，请先绑定')
      await this.sendCommand('UNLOCK')
    },

    async lock() {
      if (!this.connected) throw new Error('未连接设备')
      if (!this.isAuthorized) throw new Error('设备未授权，请先绑定')
      await this.sendCommand('LOCK')
    },

    async trunk() {
      if (!this.connected) throw new Error('未连接设备')
      if (!this.isAuthorized) throw new Error('设备未授权，请先绑定')
      await this.sendCommand('TRUNK')
    },

    // ★ v2.3: 绑定操作（带 PIN 验证）
    /**
     * 验证 PIN 码
     *   发送 PIN:<code> → 等待设备 Notify pin_ok=1
     * @param {string} pinCode 用户输入的 PIN
     * @returns {Promise<boolean>}
     */
    async verifyPin(pinCode) {
      if (!this.connected) throw new Error('未连接设备')
      await sendCommand(this.deviceId, `PIN:${pinCode}`)
      console.log('[Store] PIN 验证命令已发送')

      // 等待设备通过 Notify 返回 pin_ok
      return new Promise((resolve) => {
        let waited = 0
        const check = () => {
          if (!this.connected) return resolve(false)
          if (this.pinOk) {
            console.log('[Store] PIN 验证通过')
            return resolve(true)
          }
          waited += 200
          if (waited >= 3000) {
            console.warn('[Store] PIN 验证超时')
            return resolve(false)
          }
          setTimeout(check, 200)
        }
        setTimeout(check, 300) // 给 Notify 一点时间
      })
    },

    /**
     * 绑定设备（带 PIN 验证 + 确认的完整流程）
     *   v2.3: 先验证 PIN → 再 BIND → 等待确认
     * @param {string} pinCode 用户输入的 PIN
     * @returns {Promise<boolean>} true=绑定成功
     */
    async bind(pinCode) {
      if (!this.connected) throw new Error('未连接设备')
      if (!this.isAuthorized) throw new Error('设备未授权，无法绑定')
      if (!pinCode || pinCode.length < 4) throw new Error('PIN 码至少 4 位')

      // ★ Step 1: 验证 PIN
      console.log('[Store] 开始 PIN 验证...')
      this.pinOk = false  // 重置
      const pinPassed = await this.verifyPin(pinCode)
      if (!pinPassed) {
        throw new Error('PIN 码错误')
      }

      // ★ Step 2: 发送 STATUS 确认路由通畅
      try { await sendCommand(this.deviceId, 'STATUS') } catch {}
      await new Promise(r => setTimeout(r, 600))

      // ★ Step 3: 发送 BIND 命令
      await sendCommand(this.deviceId, 'BIND')
      console.log('[Store] BIND 命令已发送，等待设备确认...')

      // ★ Step 4: 等 ESP32 处理完 BIND 再发 STATUS 查询结果
      await new Promise(r => setTimeout(r, 800))
      try { await sendCommand(this.deviceId, 'STATUS') } catch {}

      // ★ Step 5: 轮询等待 isBound 变为 true，最多 8 秒
      return new Promise((resolve, reject) => {
        let elapsed = 0
        const poll = () => {
          if (!this.connected) return reject(new Error('断开连接'))
          if (this.isBound) {
            console.log('[Store] 绑定确认成功')
            return resolve(true)
          }
          elapsed += 500
          if (elapsed >= 8000) {
            console.warn('[Store] 绑定超时，设备未确认')
            return reject(new Error('绑定超时'))
          }
          if (elapsed === 2500) {
            sendCommand(this.deviceId, 'STATUS').catch(() => {})
          }
          setTimeout(poll, 500)
        }
        setTimeout(poll, 800)
      })
    },

    /**
     * ★ v2.3: 修改设备 PIN 码
     * @param {string} oldPin 旧 PIN
     * @param {string} newPin 新 PIN
     * @returns {Promise<boolean>}
     */
    async changePin(oldPin, newPin) {
      if (!this.connected) throw new Error('未连接设备')
      if (!this.isAuthorized) throw new Error('未授权，无法修改 PIN')
      if (newPin.length < 4 || newPin.length > 16) throw new Error('新 PIN 须为 4-16 位')

      await sendCommand(this.deviceId, `CHPIN:${oldPin}:${newPin}`)
      console.log('[Store] 修改 PIN 命令已发送')

      // 等待设备 Notify 确认（pin_default 变化）
      return new Promise((resolve) => {
        let oldDefault = this.pinDefault
        let waited = 0
        const check = () => {
          if (!this.connected) return resolve(false)
          // 如果 pin_default 从 true 变 false，说明修改成功
          if (!this.pinDefault && oldDefault) {
            console.log('[Store] PIN 修改确认成功')
            return resolve(true)
          }
          waited += 200
          if (waited >= 4000) {
            // 4秒超时，但可能已经成功了只是 Notify 没及时更新
            console.warn('[Store] PIN 修改确认超时，请手动检查')
            return resolve(true)  // 乐观认为成功
          }
          setTimeout(check, 200)
        }
        setTimeout(check, 500)
      })
    },

    /**
     * 发送 UNBIND 命令（解绑，需要已授权）
     */
    async unbind() {
      if (!this.connected) throw new Error('未连接设备')
      if (!this.isAuthorized) throw new Error('无权限解绑')
      await sendCommand(this.deviceId, 'UNBIND')
    },

    // ==================== v2.4: 分享密钥 ====================

    /**
     * 生成分享密钥（主人端调用）
     * @param {number} hours 有效期小时数，默认 24
     * @returns {Promise<string>} 分享密钥字符串
     */
    async generateShareKey(hours = 24) {
      if (!this.connected) throw new Error('未连接设备')
      if (!this.isAuthorized) throw new Error('无权限生成分享密钥')

      this.generatedShareKey = ''  // 先清空旧值
      const cmd = `SHARE:GEN:${hours}`
      await sendCommand(this.deviceId, cmd)
      console.log(`[Store] 分享密钥生成命令已发送 (${hours}h)`)

      // 等待 ESP32 通过 Notify 返回 share_key 明文
      return new Promise((resolve, reject) => {
        let waited = 0
        const check = () => {
          if (!this.connected) return reject(new Error('断开连接'))
          if (this.generatedShareKey && this.generatedShareKey.length > 0) {
            const key = this.generatedShareKey
            console.log(`[Store] 分享密钥已生成: ${key}`)
            return resolve(key)
          }
          waited += 300
          if (waited >= 5000) {
            return reject(new Error('生成分享密钥超时'))
          }
          setTimeout(check, 300)
        }
        setTimeout(check, 400)  // 给 Notify 和 BLE 一些延迟
      })
    },

    /**
     * 撤销分享密钥（主人端调用）
     */
    async revokeShareKey() {
      if (!this.connected) throw new Error('未连接设备')
      if (!this.isAuthorized) throw new Error('无权限撤销分享密钥')
      await sendCommand(this.deviceId, 'SHARE:REVOKE')
      this.generatedShareKey = ''
      console.log('[Store] 分享密钥已撤销')
    },

    /**
     * 验证分享密钥（客人端调用，无需已授权）
     * @param {string} key 8 位分享密钥
     * @returns {Promise<boolean>}
     */
    async authWithShareKey(key) {
      if (!this.connected) throw new Error('未连接设备')
      if (!key || key.length < 4) throw new Error('密钥格式错误')

      this.shareVerified = false  // 重置
      await sendCommand(this.deviceId, `AUTH:${key}`)
      console.log('[Store] 分享密钥验证命令已发送')

      // 等待 ESP32 Notify 返回 authorized=1
      return new Promise((resolve) => {
        let waited = 0
        const check = () => {
          if (!this.connected) return resolve(false)
          if (this.shareVerified) {
            console.log('[Store] 分享密钥验证通过')
            return resolve(true)
          }
          // 也可以用 isAuthorized 作为备选判断
          if (this.isAuthorized && waited > 1000) {
            console.log('[Store] 分享密钥验证通过 (authorized)')
            this.shareVerified = true
            return resolve(true)
          }
          waited += 300
          if (waited >= 5000) {
            console.warn('[Store] 分享密钥验证超时')
            return resolve(false)
          }
          setTimeout(check, 300)
        }
        setTimeout(check, 500)
      })
    },

    /**
     * ★ v2.4: 通过分享密钥绑定设备（客人端专用流程）
     *   验证密钥 → 直接 BIND（无需 PIN）
     * @param {string} key 8 位分享密钥
     * @returns {Promise<boolean>}
     */
    async bindWithShareKey(key) {
      if (!this.connected) throw new Error('未连接设备')
      if (!key || key.length < 4) throw new Error('密钥格式错误')

      // Step 1: 验证分享密钥
      console.log('[Store] 开始分享密钥验证...')
      const ok = await this.authWithShareKey(key)
      if (!ok) {
        throw new Error('分享密钥无效或已过期')
      }

      // Step 2: 发送 STATUS 确认路由
      try { await sendCommand(this.deviceId, 'STATUS') } catch {}
      await new Promise(r => setTimeout(r, 600))

      // Step 3: 发送 BIND 命令（shareVerified=true → 跳过 PIN 检查）
      await sendCommand(this.deviceId, 'BIND')
      console.log('[Store] BIND 命令已发送（通过分享密钥），等待确认...')

      // Step 4: 等待确认
      await new Promise(r => setTimeout(r, 800))
      try { await sendCommand(this.deviceId, 'STATUS') } catch {}

      // Step 5: 轮询等待 isBound
      return new Promise((resolve, reject) => {
        let elapsed = 0
        const poll = () => {
          if (!this.connected) return reject(new Error('断开连接'))
          if (this.isBound) {
            console.log('[Store] 通过分享密钥绑定成功')
            return resolve(true)
          }
          elapsed += 500
          if (elapsed >= 8000) {
            return reject(new Error('绑定超时'))
          }
          if (elapsed === 2500) {
            sendCommand(this.deviceId, 'STATUS').catch(() => {})
          }
          setTimeout(poll, 500)
        }
        setTimeout(poll, 800)
      })
    },
  }
})
