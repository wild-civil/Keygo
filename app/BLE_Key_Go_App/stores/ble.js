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
  getBluetoothAdapterState,
  onBluetoothAdapterStateChange,
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


    // 连接历史（自动重连用）
    lastDeviceId: '',

    // ★ v3.5: 持久化恢复标记
    _restored: false,

    // ★ v3.6: 蓝牙适配器 & 重连状态
    btState: 'unknown',           // 'on' | 'off' | 'enabling' | 'unknown'
    reconnectMode: 'idle',        // 'idle' | 'active' | 'paused' | 'dormant'
    reconnectAttempt: 0,          // 当前重连次数
    reconnectNextDelay: 0,        // 下次重连等待秒数（UI 显示用）

    // ★ v3.6: 全局单例监听器（只在 store 初始化时注册一次）
    _listenersInited: false,
    _connHandler: null,
    _charHandler: null,
    _btAdapterHandler: null,       // ★ v3.6: 适配器状态监听引用
    _notifyBuffer: '',
    _notifyTimer: null,
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

    // ==================== 全局监听器（v3.6 单例模式） ====================

    /** 惰性初始化全局监听器（只注册一次，所有 action 入口调用确保已注册） */
    _ensureGlobalListeners() {
      if (this._listenersInited) return
      this._listenersInited = true

      // 连接状态监听（全局唯一）
      this._connHandler = onBLEConnectionStateChange((connected, deviceId) => {
        // 过滤：只处理当前设备
        if (deviceId !== this.deviceId) return

        if (!connected) {
          console.log('[Store] 设备断开连接（全局监听器）')
          this._handleDisconnect()
        }
      })

      // 特征值数据监听（全局唯一）
      // Notify 分包拼接缓冲区
      this._charHandler = onBLECharacteristicValueChange((res) => {
        if (res.deviceId === this.deviceId &&
            (res.characteristicId || '').toUpperCase() === BLE_CONFIG.statusCharUUID.toUpperCase()) {
          const chunk = arrayBufferToString(res.value)
          this._notifyBuffer += chunk

          if (this._notifyTimer) clearTimeout(this._notifyTimer)
          this._notifyTimer = setTimeout(() => {
            const fullData = this._notifyBuffer
            this._notifyBuffer = ''
            this._handleStatusNotify(fullData)
          }, 200)
        }
      })

      // ★ v3.6: 适配器状态变化监听（用户从控制中心开关蓝牙） */
      this._btAdapterHandler = onBluetoothAdapterStateChange((available, discovering) => {
        this._onBtAdapterStateChange(available, discovering)
      })

      console.log('[Store] 全局监听器已初始化（单例模式）')
    },

    /** 销毁全局监听器（仅在用户主动断开时调用） */
    _destroyGlobalListeners() {
      if (this._connHandler) {
        try { uni.offBLEConnectionStateChange(this._connHandler) } catch {}
        this._connHandler = null
      }
      if (this._charHandler) {
        try { uni.offBLECharacteristicValueChange(this._charHandler) } catch {}
        this._charHandler = null
      }
      if (this._btAdapterHandler) {
        try { uni.offBluetoothAdapterStateChange(this._btAdapterHandler) } catch {}
        this._btAdapterHandler = null
      }
      if (this._notifyTimer) {
        clearTimeout(this._notifyTimer)
        this._notifyTimer = null
      }
      this._notifyBuffer = ''
      this._listenersInited = false
      console.log('[Store] 全局监听器已销毁')
    },

    // ==================== 蓝牙适配器检测（v3.6） ====================

    /**
     * 检查蓝牙适配器是否已开启
     * @returns {Promise<boolean>} true=已开启，false=未开启
     */
    async _checkBluetoothState() {
      const state = await getBluetoothAdapterState()
      if (state.available) {
        this.btState = 'on'
        return true
      }
      this.btState = 'off'
      return false
    },

    /**
     * 确保蓝牙适配器已开启，否则设置状态以便 UI 显示引导
     * @returns {Promise<boolean>} true=已就绪，false=蓝牙未开
     */
    async ensureBluetooth() {
      const isOn = await this._checkBluetoothState()
      if (!isOn) {
        console.log('[Store] 蓝牙未开启，等待用户手动开启')
      }
      return isOn
    },

    /**
     * ★ v3.6: 系统蓝牙适配器状态变化回调（用户从控制中心开关蓝牙时触发）
     *
     *   ★ 关键：discovering 变化（由 RSSI 轮询触发）不应驱动业务逻辑，
     *      仅 available 的实质性变化才处理。
     *
     *   ★ 不对称防抖：关闭立即执行（防止 _handleDisconnect 误判蓝牙开着而启动无效重连），
     *      开启则防抖 300ms（防止短暂振荡触发过早重连）。
     */
    _onBtAdapterStateChange(available, _discovering) {
      // ★ 防抖1：仅 available 真正变化时才处理，忽略 discovering-only 事件
      const expectedState = available ? 'on' : 'off'
      if (this.btState === expectedState) {
        // RSSI 扫描触发的 discovering 变化 → 忽略
        return
      }

      if (!available) {
        // 蓝牙关闭 → 立即执行，不等防抖（避免 _handleDisconnect 误判）
        this._applyBtAdapterState(false)
        return
      }

      // 蓝牙开启 → 防抖 300ms（防止短暂振荡触发过早重连）
      const now = Date.now()
      if (this._lastBtAdapterEvent && (now - this._lastBtAdapterEvent) < 600) {
        console.log('[Store] 适配器开启事件抖动，防抖中...')
      }
      this._lastBtAdapterEvent = now

      if (this._btDebounceTimer) clearTimeout(this._btDebounceTimer)
      this._btDebounceTimer = setTimeout(() => {
        this._btDebounceTimer = null
        this._applyBtAdapterState(true)
      }, 300)
    },

    /**
     * ★ v3.6: 实际应用适配器状态（经防抖后执行）
     */
    _applyBtAdapterState(available) {
      const expectedState = available ? 'on' : 'off'
      if (this.btState === expectedState) return  // 二次检查

      if (available) {
        // 蓝牙已开启
        console.log('[Store] 系统蓝牙已开启')
        this.btState = 'on'

        // 如果之前因为蓝牙关闭被暂停的重连，立即恢复
        if (!this.connected && this.deviceId && this.reconnectMode === 'paused') {
          console.log('[Store] 蓝牙恢复，重启重连流程')
          this.reconnectAttempt = 0
          this.reconnectNextDelay = 0
          this._startReconnect()
        }
      } else {
        // 蓝牙已关闭
        console.log('[Store] 系统蓝牙已关闭')
        this.btState = 'off'

        // ★ 清除所有定时器（包括防抖定时器，防止蓝牙关闭后触发虚假开启回调）
        if (this._btDebounceTimer) {
          clearTimeout(this._btDebounceTimer)
          this._btDebounceTimer = null
        }

        // 停止所有重连
        if (this._reconnectTimer) {
          clearTimeout(this._reconnectTimer)
          this._reconnectTimer = null
        }
        this._stopRssiPolling()
        this.connected = false
        this.deviceState = 'LOCKED'
        this.rssi = -999
        this.filteredRssi = -999

        // 蓝牙关闭时暂停重连，不清 deviceId/deviceName → 重开蓝牙可恢复
        this.reconnectMode = 'paused'
        this.reconnectNextDelay = 0
      }
    },

    /**
     * 尝试开启蓝牙适配器（由用户点击 UI 按钮触发）
     * 成功后自动触发重连或扫描
     * @returns {Promise<boolean>}
     */
    async enableBluetooth() {
      this.btState = 'enabling'
      try {
        await initBluetooth()
        // ★ v3.6: 确认蓝牙实际状态（适配器可能已开但我们的状态不同步）
        await this._checkBluetoothState()
        console.log('[Store] 蓝牙已开启，btState=' + this.btState)

        // 蓝牙已开：有设备ID且不是主动断开 → 自动重连
        if (!this.connected && this.deviceId && this.reconnectMode !== 'dormant') {
          this.tryReconnect()
        }
        return this.btState === 'on'
      } catch (err) {
        this.btState = 'off'
        this.reconnectMode = 'idle'  // ★ v3.6: 开启失败时重置重连状态
        // ★ 把错误抛出让 UI 层决定如何提示
        throw err
      }
    },

    // ==================== 断连处理 & 重连（v3.6） ====================

    /** 统一断连处理入口（由全局 _connHandler 触发） */
    _handleDisconnect() {
      // ★ v3.6: 清除所有定时器防止竞态
      if (this._reconnectTimer) {
        clearTimeout(this._reconnectTimer)
        this._reconnectTimer = null
      }
      if (this._btDebounceTimer) {
        clearTimeout(this._btDebounceTimer)
        this._btDebounceTimer = null
      }
      this._stopRssiPolling()
      this.connected = false
      this.deviceState = 'LOCKED'
      this.rssi = -999
      this.filteredRssi = -999

      // 用户主动断开 → 不重连
      if (this.reconnectMode === 'dormant') {
        console.log('[Store] 用户主动断开，不启动重连')
        return
      }

      // ★ v3.6: 如果蓝牙已关闭，不启动重连（由适配器状态变化事件接管）
      if (this.btState === 'off') {
        console.log('[Store] 蓝牙已关闭，暂停重连，等待蓝牙恢复')
        this.reconnectMode = 'paused'
        return
      }

      // 异常断连 → 启动重连循环
      console.log('[Store] 异常断连，启动重连...')
      this._startReconnect()
    },

    /** 启动重连循环（v3.6 指数退避） */
    _startReconnect() {
      if (this.reconnectMode === 'dormant' || this.reconnectMode === 'active') return
      if (!this.deviceId) return
      if (this.btState === 'off') return  // ★ v3.6: 蓝牙关闭时不启动
      if (this.connected) return           // ★ v3.6: 已连接时不启动

      this.reconnectMode = 'active'
      this.reconnectAttempt = 0
      this._scheduleReconnect(0)  // 第1次立即尝试
    },

    /** 安排下一次重连 */
    _scheduleReconnect(delayMs) {
      if (this._reconnectTimer) {
        clearTimeout(this._reconnectTimer)
        this._reconnectTimer = null
      }

      this.reconnectNextDelay = Math.round(delayMs / 1000)

      this._reconnectTimer = setTimeout(async () => {
        this._reconnectTimer = null
        // ★ v3.6: 检查前置条件：dormant / 已连接 / 蓝牙关闭 → 不执行
        if (this.reconnectMode === 'dormant' || this.connected) return
        if (this.btState === 'off') {
          // 蓝牙未开，保持 paused 等待适配器状态变化恢复
          this.reconnectMode = 'paused'
          return
        }

        this.reconnectMode = 'active'
        console.log(`[Store] 重连尝试 #${this.reconnectAttempt + 1}...`)

        try {
          await this._doReconnect()
          // 成功！
          this.reconnectMode = 'idle'
          this.reconnectAttempt = 0
          this.reconnectNextDelay = 0
          console.log('[Store] 重连成功！')
        } catch {
          this.reconnectAttempt++

          // ★ v3.6: 如果是蓝牙关闭导致的失败，_doReconnect 已将 mode 设为 paused
          //   不再调度下一轮，等待适配器状态变化事件来恢复
          if (this.reconnectMode === 'paused') {
            console.log('[Store] 蓝牙未开启，暂停重连，等待蓝牙恢复')
            return
          }

          if (this.reconnectAttempt >= 10) {
            // 放弃：10 次均失败
            this.reconnectMode = 'idle'
            this.reconnectAttempt = 0
            this.reconnectNextDelay = 0
            console.log('[Store] 重连失败，已达最大尝试次数')
            return
          }

          // 指数退避：2^1=2s, 2^2=4s, 2^3=8s, ..., 上限 30s
          const delay = Math.min(Math.pow(2, this.reconnectAttempt) * 1000, 30000)
          this.reconnectMode = 'paused'
          this._scheduleReconnect(delay)
        }
      }, delayMs)
    },

    /**
     * 执行一次重连尝试
     * 重连前先短暂扫描确认设备在附近，避免盲连失败
     */
    async _doReconnect() {
      // ★ 重连前确认蓝牙已开
      const btOn = await this._checkBluetoothState()
      if (!btOn) {
        // 蓝牙未开 → 暂停重连，等待适配器状态变化事件恢复
        this.reconnectMode = 'paused'
        this.reconnectNextDelay = 0
        throw new Error('蓝牙未开启')
      }

      // 如果处于 dormant（用户主动断开），不重连
      if (this.reconnectMode === 'dormant') {
        throw new Error('用户主动断开')
      }

      // 暂停当前 RSSI 轮询的残留
      this._stopRssiPolling()

      // 直接尝试连接（already connect 已在 utils/ble.js 中视为成功）
      await connectDevice(this.deviceId)

      this.connected = true
      this.lastDeviceId = this.deviceId

      // ★ v3.6: 恢复设备名（重连路径没有 connect() 调用，需手动恢复）
      if (!this.deviceName) {
        const macClean = this.deviceId.replace(/:/g, '')
        const macSuffix = macClean.slice(-6).toUpperCase()
        this.deviceName = 'KeyGo-' + macSuffix
      }

      // ★ v3.6: 重连成功 → 重置为 idle（覆盖 tryReconnect 和 _scheduleReconnect 两条路径）
      this.reconnectMode = 'idle'
      this.reconnectAttempt = 0
      this.reconnectNextDelay = 0

      // 恢复 Notify 和 RSSI 轮询
      await new Promise(r => setTimeout(r, 800))
      await notifyBLECharacteristicValueChange(
        this.deviceId,
        BLE_CONFIG.serviceUUID,
        BLE_CONFIG.statusCharUUID,
        true
      )
      this._startRssiPolling()
    },

    /**
     * 外部调用：尝试重连已保存的设备
     * 先检查蓝牙，再走重连流程
     */
    async tryReconnect() {
      const btOn = await this._checkBluetoothState()
      if (!btOn) return false

      this._ensureGlobalListeners()

      if (!this.deviceId) {
        const savedId = uni.getStorageSync('ble_device_id')
        if (savedId) {
          this.deviceId = savedId
        } else {
          return false
        }
      }

      if (this.reconnectMode === 'dormant') {
        console.log('[Store] tryReconnect: 用户已主动断开，不重连')
        return false
      }

      try {
        await this._doReconnect()
        return true
      } catch {
        this._startReconnect()
        return false
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
      this._ensureGlobalListeners()  // ★ v3.6: 确保全局监听器已注册

      // ★ v3.6: 先检查蓝牙状态
      const btOn = await this._checkBluetoothState()
      if (!btOn) throw new Error('蓝牙未开启')

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
        this._ensureGlobalListeners()  // ★ v3.6: 确保全局监听器已注册

        await connectDevice(deviceId)
        this.deviceId = deviceId
        this.deviceName = deviceName || 'KeyGo'
        this.connected = true
        this.lastDeviceId = deviceId

        // ★ v3.6: 连接成功后重置重连状态（允许后续异常断连自动重连）
        this.reconnectMode = 'idle'
        this.reconnectAttempt = 0
        this.reconnectNextDelay = 0

        // ★ v3.3: 从扫描缓存中提取设备指纹
        const cached = this.devices.find(d => d.deviceId === deviceId)
        this.fingerprint = cached?.fingerprint || ''
        if (this.fingerprint) {
          console.log('[Store] 设备指纹（广播包）:', this.fingerprint)
        }

        uni.setStorageSync('ble_device_id', deviceId)

        // ★ v3.6: 全局监听器已处理连接状态变化和特征值数据（不再重复注册）

        await new Promise(r => setTimeout(r, 1000))

        // ★ 启用 Status 特征值的 Notify（每次连接时需重新启用）
        await notifyBLECharacteristicValueChange(
          deviceId,
          BLE_CONFIG.serviceUUID,
          BLE_CONFIG.statusCharUUID,
          true
        )

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
      // ★ v3.6: 标记为用户主动断开，停止所有重连
      this.reconnectMode = 'dormant'
      this.reconnectAttempt = 0
      this.reconnectNextDelay = 0
      if (this._reconnectTimer) {
        clearTimeout(this._reconnectTimer)
        this._reconnectTimer = null
      }

      this._scanAborted = true
      this._stopRssiPolling()
      const targetId = this.deviceId
      if (targetId) {
        try {
          await disconnectDevice(targetId)
          // ★ 等待系统确认断开（最多等待 1.5 秒）
          await new Promise((resolve) => {
            const timer = setTimeout(() => {
              try { uni.offBLEConnectionStateChange(handler) } catch {}
              resolve()
            }, 1500)
            const done = () => { clearTimeout(timer); resolve() }
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
      // ★ v3.6: 精准清理全局监听器，避免泄残留 listener
      this._destroyGlobalListeners()
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
      this._coolingDown = true
      this.manualCooldown = false
      if (this._cooldownTimer) { clearTimeout(this._cooldownTimer); this._cooldownTimer = null }
      setTimeout(() => { this._coolingDown = false }, 500)
      return true
    },

    /**
     * 尝试自动连接（兼容旧版接口）
     * 内部委托给 tryReconnect()
     */
    async tryAutoConnect() {
      // ★ v3.6: 蓝牙未开时不尝试，等适配器状态变化事件触发重连
      if (this.btState === 'off') {
        console.log('[Store] tryAutoConnect: 蓝牙未开启，跳过')
        return false
      }
      this._ensureGlobalListeners()
      return this.tryReconnect()
    },

    // ==================== RSSI 轮询 ====================

    _rssiTimer: null,
    _rssiScanTimeout: null,
    _rssiScanListener: null,
    _scanAborted: false,
    _cooldownTimer: null,
    _reconnectTimer: null,      // ★ v3.6: 重连定时器
    _btDebounceTimer: null,     // ★ v3.6: 适配器状态防抖定时器
    _lastBtAdapterEvent: 0,     // ★ v3.6: 上次适配器事件时间戳

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

      if (data.st !== undefined) {
        this.deviceState = data.st
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
      // ★ 必须在 sendCommand 之前设置冷却标记！
      //   因为设备收到 UNLOCK 后会立即回报 {"st":"UNLOCKED"} Notify，
      //   该 Notify 在 await 期间即可通过事件回调触发 _parseSingleStatus()，
      //   若此时 manualCooldown 仍为 false，RSSI 防御会立即将状态强制回退 LOCKED。
      this.manualCooldown = true
      if (this._cooldownTimer) clearTimeout(this._cooldownTimer)
      this._cooldownTimer = setTimeout(() => {
        this.manualCooldown = false
        this._cooldownTimer = null
        console.log('[Store] RSSI 状态机冷却结束')
      }, 8000)
      await this.sendCommand('UNLOCK')
    },

    async lock() {
      if (!this.connected) throw new Error('未连接设备')
      // ★ 同上，必须在发送命令前设置冷却标记
      this.manualCooldown = true
      if (this._cooldownTimer) clearTimeout(this._cooldownTimer)
      this._cooldownTimer = setTimeout(() => {
        this.manualCooldown = false
        this._cooldownTimer = null
        console.log('[Store] RSSI 状态机冷却结束')
      }, 8000)
      await this.sendCommand('LOCK')
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
