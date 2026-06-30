/**
 * BLE 连接状态管理 - Pinia Store (v3.2)
 *
 * v3.2 — BLE Bonding 协议：
 *   - Status JSON 使用短键名 (c, enc, bdd, st, r, f, ul, lk, hy, uc, lc, mc, dn, d2, pm, pd, pce)
 *   - 安全由 BLE 链路层 Bonding 处理
 *   - 命令: NAME:, PIN:old:new, UNLOCK, LOCK, TRUNK, STATUS
 *
 *   设计参考 v3.0 双层密码版本的 UI 状态展示细节
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
  readSerialNumber,               // ★ v3.3: 读取设备序列号
} from '@/utils/ble.js'

export const useBleStore = defineStore('ble', {
  state: () => ({
    // 连接状态
    connected: false,
    deviceId: '',
    deviceName: '',

    // ★ v3.2: BLE Bonding 安全状态
    isEncrypted: false,           // 当前连接是否已加密
    hasBondedDevices: false,      // 设备是否有已绑定的设备
    pinVerified: false,           // ★ v3.5.10: 应用层 PIN 验证是否通过
    pinVerifyFail: false,         // ★ v3.5.10: 上次 VERIFY 是否失败（用于 UI 错误提示）
    pairingMode: false,           // 设备是否处于配对模式
    pinDefault: true,             // 配对 PIN 是否为出厂默认 123456
    pinChangeError: 0,            // PIN 修改错误码 (0=无,1=旧PIN错,2=格式错)
    customDeviceName: '',         // 设备自定义名称
    serialNumber: '',             // ★ v3.3: 设备序列号（永久唯一，FF04 读取）
    fingerprint: '',              // ★ v3.3: 扫描阶段指纹（MAC 后缀，来自广播包）

    // ★ v3.2 操作结果反馈（参考 v3.0 的 lr/lo 机制）
    lastOpResult: 0,              // 最近操作结果 0=idle 1=OK 2=失败
    lastOpType: 0,                // 最近操作类型 0=none 1=改PIN 2=改名

    // 扫描状态
    scanning: false,
    devices: [],

    // 设备状态（从 FF02 Notify 接收）
    deviceState: 'LOCKED',        // LOCKED / UNLOCKED / ACTION
    rssi: -999,
    filteredRssi: -999,
    unlockThreshold: -45,
    lockThreshold: -65,
    hystDb: 5,
    unlockCountRequired: 3,
    lockCountRequired: 5,
    disconnectLockDelayMs: 5000,
    manualCooldown: false,        // 手动命令冷却中

    // 连接历史（自动重连用）
    lastDeviceId: '',
  }),

  getters: {
    stateText: (state) => {
      const map = { 'LOCKED': '已锁车', 'UNLOCKED': '已解锁', 'ACTION': '执行中...' }
      return map[state.deviceState] || state.deviceState
    },

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

    rssiPercent: (state) => {
      const r = state.filteredRssi > -999 ? state.filteredRssi : state.rssi
      if (r === -999 || r === undefined) return 0
      const pct = ((r + 100) / 80) * 100
      return Math.max(0, Math.min(100, Math.round(pct)))
    },

    isUnlocked: (state) => state.connected && state.deviceState === 'UNLOCKED',
  },

  actions: {
    // ==================== 扫描 ====================

    async startScanDevices(timeout = 10) {
      if (this._coolingDown) {
        await new Promise(r => {
          const check = () => {
            if (!this._coolingDown) return r()
            setTimeout(check, 100)
          }
          check()
        })
      }

      try { uni.offBluetoothDeviceFound() } catch {}

      try { await initBluetooth() } catch {}

      // ★ 防止快速切换导致的交叉污染：递增扫描序列号
      this._scanSerial = (this._scanSerial || 0) + 1
      const mySerial = this._scanSerial

      this.scanning = true
      this.devices = []

      try {
        const devices = await startScan(
          (device) => {
            // ★ 去重：deviceId 已存在则仅更新 RSSI，不重复添加
            if (this._scanSerial !== mySerial) return
            const idx = this.devices.findIndex(d => d.deviceId === device.deviceId)
            if (idx >= 0) {
              this.devices[idx] = { ...this.devices[idx], RSSI: Math.max(this.devices[idx].RSSI, device.RSSI) }
            } else {
              this.devices.push(device)
            }
          },
          timeout
        )
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

    async stopScanDevices() {
      this.scanning = false
      await stopScan()
    },

    // ==================== 连接 ====================

    async connect(deviceId, deviceName = '') {
      try {
        await connectDevice(deviceId)
        this.deviceId = deviceId
        this.deviceName = deviceName || 'KeyGo'
        this.connected = true
        this.lastDeviceId = deviceId

        // ★ v3.3: 从扫描缓存中提取设备指纹
        const cached = this.devices.find(d => d.deviceId === deviceId)
        this.fingerprint = cached?.fingerprint || ''
        if (this.fingerprint) {
          console.log('[Store] 设备指纹（广播包）:', this.fingerprint)
        }

        // ★ 重置 BLE Bonding 状态
        this.isEncrypted = false
        this.hasBondedDevices = false
        this.pinVerified = false            // ★ v3.5.10
        this.pinVerifyFail = false          // ★ v3.5.10
        this.pinDefault = true
        this.pinChangeError = 0
        this.lastOpResult = 0
        this.lastOpType = 0

        uni.setStorageSync('ble_device_id', deviceId)

        // 监听连接断开
        onBLEConnectionStateChange((connected, devId) => {
          if (devId === deviceId && !connected) {
            console.log('[Store] 设备断开连接')
            this._stopRssiPolling()
            this.connected = false
            this.isEncrypted = false
            this.pinVerified = false         // ★ v3.5.10
            this.pinVerifyFail = false       // ★ v3.5.10
            this.deviceState = 'LOCKED'
            this.rssi = -999
            this.filteredRssi = -999
          }
        })

        await new Promise(r => setTimeout(r, 1000))

        // 启用 Status 特征值的 Notify
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

              if (!firstStatusReceived) {
                firstStatusReceived = true
                this._onFirstStatusReceived()
              }
            }, 200)
          }
        })

        // ★ v3.3: 后台非阻塞读取设备序列号（不阻塞连接流程）
        readSerialNumber(deviceId, 5000).then(sn => {
          this.serialNumber = sn
          console.log('[Store] 设备序列号（FF04）:', sn)
          // 验证：与广播包指纹比对
          if (this.fingerprint && sn.slice(-6).toUpperCase() !== this.fingerprint.toUpperCase()) {
            console.warn('[Store] ⚠ 序列号指纹不匹配！广播:', this.fingerprint, '序列号:', sn.slice(-6))
          }
        }).catch(err => {
          const msg = err?.message || String(err)
          // ★ 根据错误类型分类处理
          if (/not support|no characteristic|FF04 not in/i.test(msg)) {
            console.log('[Store] 固件不支持 FF04 序列号（需升级 v3.3）:', msg)
          } else if (/timeout/i.test(msg)) {
            console.log('[Store] 序列号读取超时:', msg)
          } else {
            console.warn('[Store] 序列号读取失败:', msg)
          }
        })

        // ★ 启动手机端 RSSI 轮询
        this._startRssiPolling()

        return true
      } catch (err) {
        console.error('[Store] 连接流程失败', err)
        this.connected = false
        throw err
      }
    },

    /**
     * ★ v3.2 / v3.5.10: 首次收到状态后的处理
     *   Just Works 配对（NimBLE）: 加密后 pinVerified=false → 需要 App 弹 PIN 框
     *   静态 PIN 配对（Bluedroid）: 加密后 pinVerified=true → 直接授权
     *   旧 bond 重连: 加密后 pinVerified=true → 免密
     */
    _onFirstStatusReceived() {
      if (this.isEncrypted) {
        if (this.pinVerified) {
          console.log('[Store] 设备已授权（加密 + PIN 验证通过）')
        } else {
          console.log('[Store] 链路已加密，等待应用层 PIN 验证...')
        }
      } else {
        console.log('[Store] 等待 BLE 加密完成...')
      }
    },

    async disconnect() {
      this._scanAborted = true
      this._stopRssiPolling()
      const targetId = this.deviceId
      if (targetId) {
        try {
          await disconnectDevice(targetId)
          // ★ 等待系统确认断开（最多等待 1.5 秒）
          await new Promise((resolve) => {
            const done = () => { clearTimeout(timer); resolve() }
            const timer = setTimeout(done, 1500)
            const handler = (connected, devId) => {
              if (devId === targetId && !connected) {
                try { uni.offBLEConnectionStateChange(handler) } catch {}
                done()
              }
            }
            try { uni.onBLEConnectionStateChange(handler) } catch { done() }
          })
        } catch (err) {
          console.error('[Store] 断开连接 API 调用失败', err)
          return false
        }
      }
      try { uni.offBLEConnectionStateChange() } catch {}
      try { uni.offBLECharacteristicValueChange() } catch {}
      this.connected = false
      this.deviceId = ''
      this.deviceName = ''
      this.scanning = false
      this.isEncrypted = false
      this.hasBondedDevices = false
      this.pinVerified = false              // ★ v3.5.10
      this.pinVerifyFail = false            // ★ v3.5.10
      this.pairingMode = false
      this.pinDefault = true
      this.pinChangeError = 0
      this.customDeviceName = ''
      this.serialNumber = ''              // ★ v3.3
      this.fingerprint = ''               // ★ v3.3
      this.lastOpResult = 0
      this.lastOpType = 0
      this.deviceState = 'LOCKED'
      this.rssi = -999
      this.filteredRssi = -999

      this._coolingDown = true
      setTimeout(() => { this._coolingDown = false }, 500)
      return true
    },

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

    // ==================== RSSI 轮询 ====================

    _rssiTimer: null,
    _rssiScanTimeout: null,
    _rssiScanListener: null,
    _scanAborted: false,

    _startRssiPolling() {
      this._stopRssiPolling()
      console.log('[Store] 手机端 RSSI 轮询已启动（每800ms）')

      this._rssiScanListener = (res) => {
        for (const device of res.devices) {
          if (device.deviceId === this.deviceId) {
            this._onPhoneRssiFound(device.RSSI)
            return
          }
        }
      }
      uni.onBluetoothDeviceFound(this._rssiScanListener)

      this._doRssiScan()
      this._rssiTimer = setInterval(() => {
        if (!this.connected || !this.deviceId) {
          this._stopRssiPolling()
          return
        }
        this._doRssiScan()
      }, 800)
    },

    _stopRssiPolling() {
      if (this._rssiTimer) {
        clearInterval(this._rssiTimer)
        this._rssiTimer = null
      }
      if (this._rssiScanTimeout) {
        clearTimeout(this._rssiScanTimeout)
        this._rssiScanTimeout = null
      }
      if (this._rssiScanListener) {
        try {
          uni.offBluetoothDeviceFound(this._rssiScanListener)
          uni.stopBluetoothDevicesDiscovery({ success: () => {}, fail: () => {} })
        } catch {}
        this._rssiScanListener = null
      }
      console.log('[Store] 手机端 RSSI 轮询已停止')
    },

    _doRssiScan() {
      uni.startBluetoothDevicesDiscovery({
        allowDuplicatesKey: true,
        interval: 0,
        success: () => {
          this._rssiScanTimeout = setTimeout(() => {
            this._rssiScanTimeout = null
            uni.stopBluetoothDevicesDiscovery({ success: () => {}, fail: () => {} })
          }, 500)
        },
        fail: (err) => {
          console.warn('[Store] RSSI 扫描启动失败:', err.errMsg)
        }
      })
    },

    async _onPhoneRssiFound(rssiValue) {
      if (!this.connected || !this.deviceId) return
      this.rssi = rssiValue
      this.filteredRssi = rssiValue
      try {
        await sendConfig(this.deviceId, { rssi: rssiValue })
      } catch {}
    },

    // ==================== 状态处理 (v3.2 短键名) ====================

    _handleStatusNotify(jsonStr) {
      const jsons = jsonStr.replace(/\}\{/g, '}\x00{').split('\x00')
      for (const item of jsons) {
        if (!item.trim()) continue
        this._parseSingleStatus(item)
      }
    },

    /**
     * ★ v3.2: 解析短键名 Status JSON
     *
     * ESP32 固件 v3.2 通过 FF02 Notify 上报格式:
     *   {"c":1,"enc":1,"bdd":1,"st":"LOCKED","r":-40,"f":-42,
     *    "ul":-45,"lk":-65,"hy":5,"uc":3,"lc":5,"mc":0,
     *    "dn":"KeyGo-71C65A","d2":"我的车","pm":0,"pd":1,"pce":0}
     *
     * 键名映射（参考 v3.0 双密码版本注释风格）：
     *   c=connected enc=encrypted bdd=hasBondedDevices
     *   st=state r=rssi f=filteredRssi
     *   ul=unlockThreshold lk=lockThreshold hy=hystDb
     *   uc=unlockCountRequired lc=lockCountRequired mc=manualCooldown
     *   dn=deviceName d2=customDeviceName sn=serialNumber(MAC后缀)
     *   pm=pairingMode pd=pinDefault pce=pinChangeError
     */
    _parseSingleStatus(jsonStr) {
      const data = tryParseJSON(jsonStr)
      if (!data) {
        console.warn('[Store] 状态解析失败:', jsonStr)
        return
      }

      // RSSI & 车辆状态
      if (data.r !== undefined && data.r > -999) this.rssi = data.r
      if (data.f !== undefined && data.f > -999) this.filteredRssi = data.f
      if (data.st !== undefined) this.deviceState = data.st

      // RSSI 阈值
      if (data.ul !== undefined) this.unlockThreshold = data.ul
      if (data.lk !== undefined) this.lockThreshold = data.lk
      if (data.hy !== undefined) this.hystDb = data.hy
      if (data.uc !== undefined) this.unlockCountRequired = data.uc
      if (data.lc !== undefined) this.lockCountRequired = data.lc
      if (data.mc !== undefined) this.manualCooldown = data.mc === 1

      // ★ BLE Bonding 状态
      if (data.c !== undefined) this.connected = data.c === 1
      if (data.enc !== undefined) this.isEncrypted = data.enc === 1
      if (data.bdd !== undefined) this.hasBondedDevices = data.bdd === 1
      if (data.pinv !== undefined) {
        const newPinVerified = data.pinv === 1
        if (this.pinVerified !== newPinVerified) {
          console.log('[Store] PIN 验证状态变化:', newPinVerified ? '已通过' : '未通过')
        }
        this.pinVerified = newPinVerified
      }
      if (data.dn !== undefined) this.deviceName = data.dn
      if (data.d2 !== undefined && data.d2 !== '') this.customDeviceName = data.d2
      if (data.pm !== undefined) this.pairingMode = data.pm === 1
      if (data.pd !== undefined) this.pinDefault = data.pd === 1
      if (data.pce !== undefined) this.pinChangeError = data.pce
      if (data.sn !== undefined && data.sn !== '') this.fingerprint = data.sn  // ★ v3.3: 状态中的 MAC 后缀
    },

    // ==================== 命令 (v3.2) ====================

    async updateConfig(config) {
      if (!this.deviceId) throw new Error('未连接设备')
      await sendConfig(this.deviceId, config)
    },

    async sendCommand(command) {
      if (!this.deviceId) throw new Error('未连接设备')
      await sendCommand(this.deviceId, command)
    },

    /**
     * ★ v3.2: 车辆控制命令（加密连接即授权）
     */
    async unlock() {
      if (!this.connected) throw new Error('未连接设备')
      await this.sendCommand('UNLOCK')
    },

    async lock() {
      if (!this.connected) throw new Error('未连接设备')
      await this.sendCommand('LOCK')
    },

    async trunk() {
      if (!this.connected) throw new Error('未连接设备')
      await this.sendCommand('TRUNK')
    },

    // ==================== v3.2: PIN 管理 ====================

    /**
     * ★ v3.2: 修改配对 PIN
     *   命令: PIN:oldPIN:newPIN
     *   设备端校验后清空所有 bond 并断开连接
     *
     * @param {string} oldPin 旧 PIN（4-6位数字）
     * @param {string} newPin 新 PIN（4-6位数字）
     * @returns {Promise<{success: boolean, errorCode: number}>}
     */
    async changePin(oldPin, newPin) {
      if (!this.connected) throw new Error('未连接设备')
      if (newPin.length < 4 || newPin.length > 6) throw new Error('新 PIN 须为 4-6 位数字')
      if (!/^\d+$/.test(newPin)) throw new Error('PIN 只能是数字')

      // ★ 重置操作状态
      this.pinChangeError = 0
      await sendCommand(this.deviceId, `PIN:${oldPin}:${newPin}`)
      console.log('[Store] PIN 修改命令已发送')

      // 等待设备 Notify 返回 pce 错误码
      return new Promise((resolve) => {
        let waited = 0
        const check = () => {
          if (!this.connected) {
            // PIN 修改成功后设备会主动断开连接
            if (this.pinChangeError === 0) {
              console.log('[Store] PIN 修改成功（设备已断连，需重新配对）')
              return resolve({ success: true, errorCode: 0 })
            }
            return resolve({ success: false, errorCode: -1 })
          }

          if (this.pinChangeError === 1) {
            console.warn('[Store] PIN 修改失败：旧 PIN 错误')
            return resolve({ success: false, errorCode: 1 })
          }
          if (this.pinChangeError === 2) {
            console.warn('[Store] PIN 修改失败：新 PIN 格式错误')
            return resolve({ success: false, errorCode: 2 })
          }

          waited += 200
          if (waited >= 5000) {
            if (this.pinChangeError === 0) {
              return resolve({ success: true, errorCode: 0 })
            }
            return resolve({ success: false, errorCode: -1 })
          }
          setTimeout(check, 200)
        }
        setTimeout(check, 500)
      })
    },

    /**
     * ★ v3.5.10: 应用层 PIN 验证 — 通过 FF03 发送 VERIFY:<pin>
     *   Just Works 配对后，用户输入 PIN，App 发送到固件验证
     * @param {string} pin 用户输入的 PIN（4-6位数字）
     * @returns {Promise<{success: boolean}>}
     */
    async verifyPin(pin) {
      if (!this.connected) throw new Error('未连接设备')
      if (!this.isEncrypted) throw new Error('连接未加密')
      if (!pin || !/^\d{4,6}$/.test(pin)) throw new Error('PIN 须为 4-6 位数字')

      this.pinVerifyFail = false
      await sendCommand(this.deviceId, `VERIFY:${pin}`)
      console.log('[Store] VERIFY 命令已发送')

      // 等待固件返回 pinv 状态变化（通过 Notify）
      return new Promise((resolve) => {
        let waited = 0
        const check = () => {
          if (!this.connected) {
            return resolve({ success: false })
          }
          if (this.pinVerified) {
            console.log('[Store] PIN 验证成功')
            return resolve({ success: true })
          }
          waited += 200
          if (waited >= 3000) {
            // 超时，固件可能拒绝了但没断开
            this.pinVerifyFail = true
            return resolve({ success: false })
          }
          setTimeout(check, 200)
        }
        setTimeout(check, 300)
      })
    },

    /**
     * ★ v3.2: 设置设备自定义名称
     * @param {string} name 名称（最长20字符，支持中文）
     * @returns {Promise<boolean>}
     */
    async setDeviceName(name) {
      if (!this.connected) throw new Error('未连接设备')
      if (name.length > 20) throw new Error('名称最长 20 字符')
      await sendCommand(this.deviceId, `NAME:${name}`)
      this.customDeviceName = name
      console.log('[Store] 设备名称已设置:', name)
      return true
    },
  }
})
