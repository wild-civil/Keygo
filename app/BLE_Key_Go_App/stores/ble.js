/**
 * BLE 连接状态管理 - Pinia Store (v3.5 精简版)
 *
 *   - Status JSON 使用短键名 (c, st, r, f, d2)
 *   - 无安全验证，连接即可控
 *   - 命令: NAME:, UNLOCK, LOCK, TRUNK
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

    customDeviceName: '',         // 设备自定义名称
    serialNumber: '',             // ★ v3.3: 设备序列号（永久唯一，FF04 读取）
    fingerprint: '',              // ★ v3.3: 扫描阶段指纹（MAC 后缀，来自广播包）

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
    rssiStateMismatch: false,     // ★ RSSI 与实际状态不一致警告（设备端阈值异常）

    // 连接历史（自动重连用）
    lastDeviceId: '',

    // ★ v3.5: 持久化恢复标记
    _restored: false,
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
    // ==================== 持久化配置 ====================

    /** 从本地存储恢复配置（每次 store 初始化时调用一次） */
    _restoreConfig() {
      if (this._restored) return
      this._restored = true
      try {
        const saved = uni.getStorageSync('ble_config_v1')
        if (saved) {
          if (saved.unlockThreshold !== undefined) this.unlockThreshold = saved.unlockThreshold
          if (saved.lockThreshold !== undefined) this.lockThreshold = saved.lockThreshold
          if (saved.unlockCountRequired !== undefined) this.unlockCountRequired = saved.unlockCountRequired
          if (saved.lockCountRequired !== undefined) this.lockCountRequired = saved.lockCountRequired
          if (saved._rssiPollInterval !== undefined) this._rssiPollInterval = saved._rssiPollInterval
          if (saved.disconnectLockDelayMs !== undefined) this.disconnectLockDelayMs = saved.disconnectLockDelayMs
          console.log('[Store] 已从本地存储恢复配置:', JSON.stringify(saved))
        }
      } catch (e) {
        console.warn('[Store] 配置恢复失败:', e)
      }
    },

    /** 持久化当前配置到本地存储 */
    _persistConfig() {
      try {
        uni.setStorageSync('ble_config_v1', {
          unlockThreshold: this.unlockThreshold,
          lockThreshold: this.lockThreshold,
          unlockCountRequired: this.unlockCountRequired,
          lockCountRequired: this.lockCountRequired,
          _rssiPollInterval: this._rssiPollInterval || 800,
          disconnectLockDelayMs: this.disconnectLockDelayMs,
        })
      } catch (e) {
        console.warn('[Store] 配置持久化失败:', e)
      }
    },

    // ==================== 扫描 ====================

    async startScanDevices(timeout = 10) {
      this._restoreConfig()  // ★ 首次进入扫描页时恢复配置
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
        this._restoreConfig()  // ★ 确保连接前配置已恢复
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

        uni.setStorageSync('ble_device_id', deviceId)

        // 监听连接断开
        onBLEConnectionStateChange((connected, devId) => {
          if (devId === deviceId && !connected) {
            console.log('[Store] 设备断开连接')
            this._stopRssiPolling()
            this.connected = false
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

        // ★ 启动手机端 RSSI 轮询（手机测 RSSI → 通过 FF01 写入设备）
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
      this.customDeviceName = ''
      this.serialNumber = ''              // ★ v3.3
      this.fingerprint = ''               // ★ v3.3
      this.deviceState = 'LOCKED'
      this.rssi = -999
      this.filteredRssi = -999
      this.rssiStateMismatch = false

      this._coolingDown = true
      this.manualCooldown = false
      if (this._cooldownTimer) { clearTimeout(this._cooldownTimer); this._cooldownTimer = null }
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
    _cooldownTimer: null,

    _startRssiPolling() {
      this._stopRssiPolling()
      const interval = this._rssiPollInterval || 800
      console.log('[Store] 手机端 RSSI 轮询已启动（每' + interval + 'ms）')

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
      }, interval)
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
      // ★ RSSI 恢复到合理范围后自动清除冲突警告
      if (this.rssiStateMismatch && rssiValue >= this.unlockThreshold) {
        this.rssiStateMismatch = false
      }
      // ★ 手动命令冷却期间暂停 RSSI 上报到设备（避免设备端状态机立即覆盖手动操作）
      if (this.manualCooldown) return
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
     * 解析 Status JSON (FF02 Notify)
     *
     *   {"c":1,"st":"LOCKED","r":-40,"f":-42,"d2":"我的车"}
     *
     * 键名映射:
     *   c=connected  st=state  r=rssi  f=filteredRssi  d2=customDeviceName
     */
    _parseSingleStatus(jsonStr) {
      const data = tryParseJSON(jsonStr)
      if (!data) {
        console.warn('[Store] 状态解析失败:', jsonStr)
        return
      }

      // 连接与车辆状态
      if (data.c !== undefined) this.connected = data.c === 1

      // RSSI（先更新，后续校验要用）
      if (data.r !== undefined && data.r > -999) this.rssi = data.r
      if (data.f !== undefined && data.f > -999) this.filteredRssi = data.f

      // ★ 客户端 RSSI 合理性校验：如果设备报告的锁状态与当前 RSSI 严重不符，
      //    说明设备端阈值没生效或比较方向错误，强制覆盖为 LOCKED
      if (data.st !== undefined) {
        const currentRssi = this.filteredRssi > -999 ? this.filteredRssi : this.rssi
        if (currentRssi > -999) {
          // UNLOCKED 但 RSSI 比锁车阈值还弱 → 设备端阈值逻辑异常，强制回退
          if (data.st === 'UNLOCKED' && currentRssi < this.lockThreshold) {
            console.warn(
              '[Store] ⚠ RSSI 冲突：设备上报 UNLOCKED 但 RSSI=' + currentRssi +
              ' < 锁车阈值=' + this.lockThreshold + '（解锁阈值=' + this.unlockThreshold + '），已强制回退为 LOCKED'
            )
            this.deviceState = 'LOCKED'   // ★ 覆盖：不显示错误状态
            this.rssiStateMismatch = true
            return
          }
          // UNLOCKED 但 RSSI 没达到解锁阈值 → 标记警告但不强制修正（可能是连续采样中）
          if (data.st === 'UNLOCKED' && currentRssi < this.unlockThreshold) {
            console.warn(
              '[Store] ⚠ RSSI 可疑：设备上报 UNLOCKED 但 RSSI=' + currentRssi +
              ' < 解锁阈值=' + this.unlockThreshold
            )
            // ★ 不再信任设备的 UNLOCKED 状态，也强制回退
            this.deviceState = 'LOCKED'
            this.rssiStateMismatch = true
          } else if (data.st === 'LOCKED') {
            this.rssiStateMismatch = false
          }
        }
        // 只有通过校验的合法状态才更新 deviceState
        if (!this.rssiStateMismatch || data.st === 'LOCKED') {
          this.deviceState = data.st
        }
      }

      // 自定义名称
      if (data.d2 !== undefined && data.d2 !== '') this.customDeviceName = data.d2
    },

    // ==================== 命令 (v3.2) ====================

    async updateConfig(config) {
      if (!this.deviceId) throw new Error('未连接设备')
      await sendConfig(this.deviceId, config)
      // ★ 同步到本地 store（控制页 UI 实时反映下发后的阈值）
      if (config.unlock !== undefined) this.unlockThreshold = config.unlock
      if (config.lock !== undefined) this.lockThreshold = config.lock
      if (config.uc !== undefined) this.unlockCountRequired = config.uc
      if (config.lc !== undefined) this.lockCountRequired = config.lc
      if (config.interval !== undefined) {
        this._rssiPollInterval = Math.max(300, config.interval)  // 下限 300ms，避免扫描过热
        // ★ 重新启动 RSSI 轮询以应用新间隔
        if (this.connected && this.deviceId) {
          this._startRssiPolling()
        }
      }
      if (config.dlock !== undefined) this.disconnectLockDelayMs = config.dlock
      // ★ 持久化到本地存储（退出应用后重新进入不丢失）
      this._persistConfig()
    },

    async sendCommand(command) {
      if (!this.deviceId) throw new Error('未连接设备')
      await sendCommand(this.deviceId, command)
    },

    /**
     * 车辆控制命令（连接即授权）
     */
    async unlock() {
      if (!this.connected) throw new Error('未连接设备')
      await this.sendCommand('UNLOCK')
      // ★ 手动解锁后 RSSI 状态机冷却 8 秒（防止设备端立即根据 RSSI 自动锁车）
      this.manualCooldown = true
      if (this._cooldownTimer) clearTimeout(this._cooldownTimer)
      this._cooldownTimer = setTimeout(() => {
        this.manualCooldown = false
        this._cooldownTimer = null
        console.log('[Store] RSSI 状态机冷却结束')
      }, 8000)
    },

    async lock() {
      if (!this.connected) throw new Error('未连接设备')
      await this.sendCommand('LOCK')
      // ★ 手动锁车后 RSSI 状态机冷却 8 秒（防止设备端立即根据 RSSI 自动解锁）
      this.manualCooldown = true
      if (this._cooldownTimer) clearTimeout(this._cooldownTimer)
      this._cooldownTimer = setTimeout(() => {
        this.manualCooldown = false
        this._cooldownTimer = null
        console.log('[Store] RSSI 状态机冷却结束')
      }, 8000)
    },

    async trunk() {
      if (!this.connected) throw new Error('未连接设备')
      await this.sendCommand('TRUNK')
    },

    /**
     * 设置设备自定义名称
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
