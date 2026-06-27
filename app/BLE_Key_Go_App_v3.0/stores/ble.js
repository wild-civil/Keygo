/**
 * BLE 连接状态管理 - Pinia Store
 *
 * v3.0 重构：
 *   - 双层密码：连接密码 (connPassword) + 绑定密码 (bindPassword)
 *   - 信任列表：通过连接密码验证的 MAC 永久记忆，下次免密
 *   - 移除分享密钥整套机制
 *   - 新增: verifyConnPassword / verifyBindPassword / changeConnPassword / changeBindPassword
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

    // ★ v3.0: 双层密码状态
    isBound: false,            // 绑定密码是否已自定义（!bind_default）
    isAuthorized: false,       // 完全授权（通过 conn + bind 验证）
    pairingMode: false,        // 设备是否处于物理配对模式

    // ★ v3.0: 分步验证状态
    connVerified: false,       // 连接密码已通过
    connNeeded: false,         // 需要输入连接密码
    bindNeeded: false,         // 需要输入绑定密码
    bindVerified: false,       // 绑定密码已通过
    connLocked: false,         // 连接密码锁定中
    connLockSec: 0,            // 锁定剩余秒数
    connDefault: true,         // 连接密码是否为出厂默认
    bindDefault: true,         // 绑定密码是否为出厂默认
    trustCount: 0,             // 信任设备数量

    // ★ v3.1: 设备自定义名称
    customName: '',            // 用户为设备设置的名字
    lastOpResult: 0,           // 最近操作结果: 0=idle 1=OK 2=旧密码错 3=格式错
    lastOpType: 0,             // 最近操作类型: 0=none 1=conn改密 2=bind改密 3=改名

    // 扫描状态
    scanning: false,
    devices: [],

    // 设备状态（从 FF02 Notify 接收）
    deviceState: 'LOCKED',
    rssi: -999,
    filteredRssi: -999,
    unlockThreshold: -45,
    lockThreshold: -65,
    unlockCountRequired: 5,
    lockCountRequired: 10,
    disconnectLockDelayMs: 5000,
    manualCooldown: false,

    // 连接历史（自动重连用）
    lastDeviceId: '',
  }),

  getters: {
    stateText: (state) => {
      const map = {
        'LOCKED': '已锁车',
        'UNLOCKED': '已解锁',
        'ACTION': '执行中...'
      }
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

    // ★ v3.0: 验证步骤文本
    authStep: (state) => {
      if (state.isAuthorized) return 'authorized'
      if (state.connLocked) return 'locked'
      if (state.connNeeded || !state.connVerified) return 'needConn'
      if (state.bindNeeded || !state.bindVerified) return 'needBind'
      return 'unknown'
    }
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

      try {
        await initBluetooth()
      } catch {
        // 可能已经初始化
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
        // ★ v3.0: 重置所有验证状态，等 Notify 上报
        this.isAuthorized = false
        this.connVerified = false
        this.connNeeded = false
        this.bindNeeded = false
        this.bindVerified = false
        this.connLocked = false
        this.connLockSec = 0

        uni.setStorageSync('ble_device_id', deviceId)

        onBLEConnectionStateChange((connected, devId) => {
          if (devId === deviceId && !connected) {
            console.log('[Store] 设备断开连接')
            this._stopRssiPolling()
            this.connected = false
            this.isAuthorized = false
            this.connVerified = false
            this.connNeeded = false
            this.bindNeeded = false
            this.bindVerified = false
            this.connLocked = false
            this.deviceState = 'LOCKED'
            this.rssi = -999
            this.filteredRssi = -999
          }
        })

        await new Promise(r => setTimeout(r, 1000))

        await notifyBLECharacteristicValueChange(
          deviceId,
          BLE_CONFIG.serviceUUID,
          BLE_CONFIG.statusCharUUID,
          true
        )

        let notifyBuffer = ''
        let notifyTimer = null

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
            }, 200)
          }
        })

        this._startRssiPolling()

        return true
      } catch (err) {
        console.error('[Store] 连接流程失败', err)
        this.connected = false
        throw err
      }
    },

    async disconnect() {
      this._scanAborted = true
      this._stopRssiPolling()
      try { uni.offBLEConnectionStateChange() } catch {}
      try { uni.offBLECharacteristicValueChange() } catch {}
      if (this.deviceId) {
        try { await disconnectDevice(this.deviceId) } catch {}
      }
      this.connected = false
      this.deviceId = ''
      this.deviceName = ''
      this.scanning = false
      this.isBound = false
      this.isAuthorized = false
      this.connVerified = false
      this.connNeeded = false
      this.bindNeeded = false
      this.bindVerified = false
      this.connLocked = false
      this.deviceState = 'LOCKED'
      this.rssi = -999
      this.filteredRssi = -999

      this._coolingDown = true
      setTimeout(() => { this._coolingDown = false }, 500)
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

    // ==================== 状态处理 ====================

    _handleStatusNotify(jsonStr) {
      const jsons = jsonStr
        .replace(/\}\{/g, '}\x00{')
        .split('\x00')

      for (const item of jsons) {
        if (!item.trim()) continue
        this._parseSingleStatus(item)
      }
    },

    _parseSingleStatus(jsonStr) {
      const data = tryParseJSON(jsonStr)
      if (!data) {
        console.warn('[Store] 状态解析失败(截断?):', jsonStr)
        return
      }

      // ★ v3.0 短键映射：固件端用 1-2 字符键名压缩 JSON 避免 MTU 截断
      // c=connected a=authorized b=bound st=state r=rssi f=filtered
      // ul=unlock lk=lock hy=hyst uc/lc 不变, mc=manualCooldown
      // dn=deviceName d2=customName pm=pairingMode cv/cn/bn/bv=密码 cl/cs=锁定 cd/bd=默认 tc=信任数
      // lr=lastOpResult lo=lastOpType
      if (data.r !== undefined && data.r > -999) this.rssi = data.r
      if (data.f !== undefined && data.f > -999) this.filteredRssi = data.f
      if (data.st !== undefined) this.deviceState = data.st
      if (data.ul !== undefined) this.unlockThreshold = data.ul
      if (data.lk !== undefined) this.lockThreshold = data.lk
      if (data.uc !== undefined) this.unlockCountRequired = data.uc
      if (data.lc !== undefined) this.lockCountRequired = data.lc
      if (data.mc !== undefined) this.manualCooldown = data.mc === 1

      if (data.a !== undefined) this.isAuthorized = data.a === 1
      if (data.b !== undefined) this.isBound = data.b === 1
      if (data.dn !== undefined) this.deviceName = data.dn
      if (data.d2 !== undefined && data.d2 !== '') this.customName = data.d2   // ★ v3.1
      if (data.pm !== undefined) this.pairingMode = data.pm === 1

      if (data.cv !== undefined) this.connVerified = data.cv === 1
      if (data.cn !== undefined) this.connNeeded = data.cn === 1
      if (data.bn !== undefined) this.bindNeeded = data.bn === 1
      if (data.bv !== undefined) this.bindVerified = data.bv === 1
      if (data.cl !== undefined) this.connLocked = data.cl === 1
      if (data.cs !== undefined) this.connLockSec = data.cs
      if (data.cd !== undefined) this.connDefault = data.cd === 1
      if (data.bd !== undefined) this.bindDefault = data.bd === 1
      if (data.tc !== undefined) this.trustCount = data.tc

      // ★ v3.1: 操作结果反馈（固件通知后自动重置为 0）
      if (data.lr !== undefined) this.lastOpResult = data.lr
      if (data.lo !== undefined) this.lastOpType = data.lo
    },

    // ==================== 命令 ====================

    async updateConfig(config) {
      if (!this.deviceId) throw new Error('未连接设备')
      await sendConfig(this.deviceId, config)
    },

    async sendCommand(command) {
      if (!this.deviceId) throw new Error('未连接设备')
      await sendCommand(this.deviceId, command)
    },

    async unlock() {
      if (!this.connected) throw new Error('未连接设备')
      if (!this.isAuthorized) throw new Error('设备未授权，请先验证密码')
      await this.sendCommand('UNLOCK')
    },

    async lock() {
      if (!this.connected) throw new Error('未连接设备')
      if (!this.isAuthorized) throw new Error('设备未授权，请先验证密码')
      await this.sendCommand('LOCK')
    },

    async trunk() {
      if (!this.connected) throw new Error('未连接设备')
      if (!this.isAuthorized) throw new Error('设备未授权，请先验证密码')
      await this.sendCommand('TRUNK')
    },

    // ==================== v3.0: 双层密码验证 ====================

    /**
     * 验证连接密码
     * @param {string} password 连接密码（默认 1234）
     * @returns {Promise<boolean>}
     */
    async verifyConnPassword(password) {
      if (!this.connected) throw new Error('未连接设备')

      this.connVerified = false  // 重置
      await sendCommand(this.deviceId, `CONN:${password}`)
      console.log('[Store] CONN 密码验证命令已发送')

      // 等待设备 Notify 返回 conn_verified=1
      return new Promise((resolve) => {
        let waited = 0
        const check = () => {
          if (!this.connected) return resolve(false)
          if (this.connVerified) {
            console.log('[Store] 连接密码验证通过')
            return resolve(true)
          }
          if (this.connLocked) {
            console.warn('[Store] 连接密码已锁定')
            return resolve(false)
          }
          waited += 300
          if (waited >= 4000) {
            console.warn('[Store] 连接密码验证超时')
            return resolve(false)
          }
          setTimeout(check, 300)
        }
        setTimeout(check, 500)
      })
    },

    /**
     * 验证绑定密码
     * @param {string} password 绑定密码（默认 123456）
     * @returns {Promise<boolean>}
     */
    async verifyBindPassword(password) {
      if (!this.connected) throw new Error('未连接设备')

      this.bindVerified = false   // ★ 重置
      this.isAuthorized = false   // ★ 防止上次 notify 残留 authorized 状态
      await sendCommand(this.deviceId, `BIND:${password}`)
      console.log('[Store] BIND 密码验证命令已发送')

      // 等待设备 Notify 返回 authorized=1
      return new Promise((resolve) => {
        let waited = 0
        const check = () => {
          if (!this.connected) return resolve(false)
          if (this.isAuthorized || this.bindVerified) {
            console.log('[Store] 绑定密码验证通过')
            return resolve(true)
          }
          waited += 300
          if (waited >= 4000) {
            console.warn('[Store] 绑定密码验证超时')
            return resolve(false)
          }
          setTimeout(check, 300)
        }
        setTimeout(check, 500)
      })
    },

    /**
     * ★ v3.0: 完整两步验证流程
     *   Step 1: 验证连接密码
     *   Step 2: 验证绑定密码
     * @param {string} connPwd 连接密码
     * @param {string} bindPwd 绑定密码
     * @returns {Promise<{connOk: boolean, bindOk: boolean}>}
     */
    async fullAuth(connPwd, bindPwd) {
      // Step 1: 连接密码
      const connOk = await this.verifyConnPassword(connPwd)
      if (!connOk) {
        if (this.connLocked) {
          throw new Error(`密码错误次数过多，设备已锁定 ${this.connLockSec} 秒`)
        }
        throw new Error('连接密码错误')
      }

      // Step 2: 绑定密码
      const bindOk = await this.verifyBindPassword(bindPwd)
      if (!bindOk) {
        throw new Error('绑定密码错误，连接已断开')
      }

      return { connOk: true, bindOk: true }
    },

    /**
     * 修改连接密码（改后清空信任列表）
     * @param {string} oldPwd 旧密码
     * @param {string} newPwd 新密码 (4-6位)
     * @returns {Promise<boolean>}
     */
    async changeConnPassword(oldPwd, newPwd) {
      if (!this.connected) throw new Error('未连接设备')
      if (!this.isAuthorized) throw new Error('未授权')
      if (!newPwd || newPwd.length < 4 || newPwd.length > 6) {
        throw new Error('连接密码须为 4-6 位数字')
      }

      // ★ v3.1: 重置操作状态
      this.lastOpResult = 0
      this.lastOpType = 0
      await sendCommand(this.deviceId, `CHCONN:${oldPwd}:${newPwd}`)
      console.log('[Store] 修改连接密码命令已发送')

      // ★ v3.1: 等待固件 lr/lo 反馈
      return new Promise((resolve, reject) => {
        let waited = 0
        const check = () => {
          if (!this.connected) return reject(new Error('设备已断开'))
          if (this.lastOpType === 1) {
            if (this.lastOpResult === 1) return resolve(true)
            if (this.lastOpResult === 2) return reject(new Error('当前连接密码不正确'))
            if (this.lastOpResult === 3) return reject(new Error('新密码格式不正确（须 4-6 位数字）'))
            return reject(new Error('密码修改失败'))
          }
          waited += 200
          if (waited >= 4000) return reject(new Error('设备响应超时'))
          setTimeout(check, 200)
        }
        setTimeout(check, 300)
      })
    },

    /**
     * 修改绑定密码
     * @param {string} oldPwd 旧密码
     * @param {string} newPwd 新密码 (4-12字符，支持中文)
     * @returns {Promise<boolean>}
     */
    async changeBindPassword(oldPwd, newPwd) {
      if (!this.connected) throw new Error('未连接设备')
      if (!this.isAuthorized) throw new Error('未授权')
      if (!newPwd || newPwd.length < 4) {
        throw new Error('绑定密码至少 4 个字符')
      }

      this.lastOpResult = 0
      this.lastOpType = 0
      await sendCommand(this.deviceId, `CHBIND:${oldPwd}:${newPwd}`)
      console.log('[Store] 修改绑定密码命令已发送')

      return new Promise((resolve, reject) => {
        let waited = 0
        const check = () => {
          if (!this.connected) return reject(new Error('设备已断开'))
          if (this.lastOpType === 2) {
            if (this.lastOpResult === 1) return resolve(true)
            if (this.lastOpResult === 2) return reject(new Error('当前绑定密码不正确'))
            if (this.lastOpResult === 3) return reject(new Error('新密码格式不正确（须 4-12 字符）'))
            return reject(new Error('密码修改失败'))
          }
          waited += 200
          if (waited >= 4000) return reject(new Error('设备响应超时'))
          setTimeout(check, 200)
        }
        setTimeout(check, 300)
      })
    },

    /**
     * ★ v3.1: 设置设备自定义名称
     * @param {string} name 设备名称 (最长20字符，支持中文)
     * @returns {Promise<boolean>}
     */
    async setDeviceName(name) {
      if (!this.connected) throw new Error('未连接设备')
      if (!this.isAuthorized) throw new Error('未授权')
      if (!name || name.length > 20) {
        throw new Error('名称最长 20 个字符')
      }

      this.lastOpResult = 0
      this.lastOpType = 0
      await sendCommand(this.deviceId, `NAME:${name}`)
      console.log('[Store] 设备改名命令已发送:', name)

      return new Promise((resolve, reject) => {
        let waited = 0
        const check = () => {
          if (!this.connected) return reject(new Error('设备已断开'))
          if (this.lastOpType === 3) {
            if (this.lastOpResult === 1) {
              this.customName = name
              return resolve(true)
            }
            return reject(new Error('名称设置失败'))
          }
          waited += 200
          if (waited >= 4000) return reject(new Error('设备响应超时'))
          setTimeout(check, 200)
        }
        setTimeout(check, 300)
      })
    },
  }
})
