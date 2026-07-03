/**
 * BLE 连接状态管理 - Pinia Store (v3.11 原生广播版)
 *
 *   - Status JSON 使用短键名 (c, st, r, f, d2)
 *   - 无安全验证，连接即可控
 *   - 命令: NAME:, UNLOCK, LOCK, TRUNK
 *   - ★ v3.11: 原生 BroadcastReceiver 驱动 btState，模仿 nRF Connect
 */

import { defineStore } from 'pinia'
import {
  BLE_CONFIG,
  BATT_SERVICE,                   // ★ v3.14: 电池服务 UUID
  initBluetooth,
  getBluetoothAdapterState,
  getBLEDeviceServices,          // ★ used by _verifyConnection
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
  readBatteryLevel,               // ★ v3.14: 读取电池电量 (GATT Read)
} from '@/utils/ble.js'

import {
  startNativeBluetoothMonitor,
  stopNativeBluetoothMonitor,
  isNativeBroken,
} from '@/utils/ble-native.js'

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
    batteryLevel: -1,             // ★ v3.14: 电池电量 0~100, -1=未知
    unlockThreshold: -45,
    lockThreshold: -65,
    hystDb: 5,
    unlockCountRequired: 3,
    lockCountRequired: 5,
    rssiReadPeriodMs: 500,         // ★ v3.13: 固件 RSSI 读取间隔 ms（设备侧 GAP 读取周期）
    disconnectLockDelayMs: 5000,
    kalmanR: 15,                    // ★ 与 CH582M / ESP32C3 默认 kf_r=15.0 一致
    manualCooldown: false,        // 手动命令冷却中
    manualCooldownMs: 8000,      // ★ v3.7 / v3.12: 初始默认值（设备连接后由 FF02 同步覆盖，设备级参数）


    // 连接历史（自动重连用）
    lastDeviceId: '',

    // ★ v3.5 / v3.12: 持久化恢复标记
    _restored: false,              // 旧版全局恢复标记（兼容）
    _restoredForSn: '',            // ★ v3.12: 已为哪个 SN 恢复了专属配置（空串=未恢复）

    // ★ v3.11: 蓝牙适配器 & 重连状态（原生广播驱动）
    btState: 'unknown',           // 'on' | 'off' | 'just_enabled' | 'unknown'
    reconnectMode: 'idle',        // 'idle' | 'active' | 'paused' | 'dormant'
    reconnectAttempt: 0,          // 当前重连次数
    reconnectNextDelay: 0,        // 下次重连等待秒数（UI 显示用）

    // ★ v3.11: 全局单例监听器（只在 store 初始化时注册一次）
    _listenersInited: false,
    _nativeBtMonitorActive: false,   // ★ v3.11: 原生广播是否已注册
    _connHandler: null,
    _charHandler: null,
    _btAdapterHandler: null,       // ★ v3.11: Uni-APP 适配器监听（iOS 主驱 / Android 降级）
    _notifyBuffer: '',
    _notifyTimer: null,
    _reconnectGuard: 0,            // 重连会话锁，蓝牙关闭时递增
    _deviceNames: null,            // ★ v3.8: { [SN]: { name, lastSeen } } 设备名称本地缓存，null=未加载
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

    // ★ v3.14: 电池图标（四档 + 未知）
    batteryIcon: (state) => {
      if (state.batteryLevel < 0) return '❓'
      if (state.batteryLevel >= 75) return '🔋'
      if (state.batteryLevel >= 50) return '🛜'
      if (state.batteryLevel >= 25) return '🛜'
      return '🪫'
    },

    // ★ v3.14: 电池颜色 class（用于 CSS 动态色）
    batteryColor: (state) => {
      if (state.batteryLevel < 0) return 'batt-unknown'
      if (state.batteryLevel >= 75) return 'batt-high'
      if (state.batteryLevel >= 25) return 'batt-mid'
      return 'batt-low'
    },

    // ★ v3.14: 电池文字（百分比或 "---"）
    batteryText: (state) => {
      if (state.batteryLevel < 0) return '---'
      return state.batteryLevel + '%'
    },
  },

  actions: {
    // ==================== 持久化配置 ====================

    /**
     * 从本地存储恢复配置（每次 store 初始化 / 切换设备时调用）
     *
     * ★ v3.12: 配置按设备序列号独立存储（per-phone 个性化）
     *
     * 恢复优先级：
     *   1. 无 SN 时：尝试读取旧版全局 key `ble_config_v1` 作为一次性迁移
     *   2. 有 SN 时：读取 `ble_config_v1_{SN}`（设备专属配置）
     *   3. 都没有 → 使用代码默认值（unlock=-45, lock=-65, uc=3, lc=5, interval=800…）
     *
     * @param {string} [sn] 设备序列号，不传则仅尝试旧版迁移
     */
    _restoreConfig(sn) {
      // ★ 如果传了 SN 且已针对该 SN 恢复过，跳过
      if (sn && this._restoredForSn === sn) return

      let saved = null
      let source = ''

      try {
        if (sn) {
          // ★ v3.12: 优先读设备专属配置
          saved = uni.getStorageSync('ble_config_v1_' + sn)
          if (saved) {
            source = '设备专属 (' + sn.slice(-6) + ')'
          } else {
            // 该设备无专属配置 → 尝试旧版全局配置作为初始值
            saved = uni.getStorageSync('ble_config_v1')
            if (saved) {
              source = '旧版全局 → 迁移至设备 ' + sn.slice(-6)
              // ★ 静默迁移：将旧版配置立即保存为设备专属
              uni.setStorageSync('ble_config_v1_' + sn, saved)
            }
          }
        } else {
          // ★ 无 SN（初始启动）：仅尝试旧版全局配置
          saved = uni.getStorageSync('ble_config_v1')
          if (saved) source = '旧版全局'
        }

        if (saved) {
          if (saved.unlockThreshold !== undefined) this.unlockThreshold = saved.unlockThreshold
          if (saved.lockThreshold !== undefined) this.lockThreshold = saved.lockThreshold
          if (saved.unlockCountRequired !== undefined) this.unlockCountRequired = saved.unlockCountRequired
          if (saved.lockCountRequired !== undefined) this.lockCountRequired = saved.lockCountRequired
          if (saved.rssiReadPeriodMs !== undefined) this.rssiReadPeriodMs = saved.rssiReadPeriodMs
          if (saved.disconnectLockDelayMs !== undefined) this.disconnectLockDelayMs = saved.disconnectLockDelayMs
          if (saved.kalmanR !== undefined) this.kalmanR = saved.kalmanR
          // ★ v3.12: cooldown_ms 是设备级参数，不从本地存储恢复
          //   设备通过 FF02 Notify 上报当前冷却时间，App 被动同步
          //   old: manualCooldownMs 本地持久化 → 多个手机可能不一致
          //   new: 仅从设备 FF02 同步 → 所有手机看到同一值
          console.log('[Store] 配置已恢复 (' + source + '):', JSON.stringify(saved))
        } else {
          console.log('[Store] 使用默认配置 (unlock=-45 lock=-65 uc=3 lc=5 interval=800)')
        }

        if (sn) this._restoredForSn = sn
      } catch (e) {
        console.warn('[Store] 配置恢复失败:', e)
        if (sn) this._restoredForSn = sn
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

        // ★ v3.14: 电池电量 Notify (0x2A19) — 固件电压变化时实时推送
        if (res.deviceId === this.deviceId &&
            (res.characteristicId || '').toUpperCase() === BATT_SERVICE.levelCharUUID.toUpperCase()) {
          try {
            const level = new Uint8Array(res.value)[0]
            if (level <= 100) {
              this.batteryLevel = level
              console.log('[Store] 电池电量更新 (Notify):', level + '%')
            }
          } catch {} // 字节解析失败，忽略
        }
      })

      // ★ v3.11: 原生 Android 广播 — 蓝牙状态变化的主驱动力
      //   返回当前状态用于初始化 btState
      const nativeState = startNativeBluetoothMonitor((state, prevState) => {
        this._onNativeBtStateChange(state, prevState)
      })
      this._nativeBtMonitorActive = nativeState >= 0
      
      if (this._nativeBtMonitorActive) {
        // 初始化 btState 为当前系统真实状态
        this.btState = this._mapNativeState(nativeState)
        console.log('[Store] 原生广播已注册，初始 btState=' + this.btState)
      }

      // ★ v3.11-fix: Uni-APP 适配器监听
      //   - iOS: 唯一驱动
      //   - Android: 原生广播失效时的降级路径
      this._btAdapterHandler = onBluetoothAdapterStateChange((available, discovering) => {
        const useNative = this._nativeBtMonitorActive && !isNativeBroken()
        if (!useNative) {
          if (isNativeBroken() && this._nativeBtMonitorActive) {
            // 原生广播已损坏，切换标记让后续事件直接走 Uni-APP
            this._nativeBtMonitorActive = false
            console.warn('[Store] ⚠ 原生广播已损坏，降级到 Uni-APP 事件')
          }
          this._onUniBtAdapterStateChange(available, discovering)
        }
        // 原生广播正常 → 忽略 Uni-APP 事件（避免重复/冲突）
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
      // ★ v3.11: 停止原生广播
      if (this._nativeBtMonitorActive) {
        stopNativeBluetoothMonitor()
        this._nativeBtMonitorActive = false
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
     * ★ v3.11: 将原生蓝牙状态码映射到 btState 字符串
     */
    _mapNativeState(state) {
      switch (state) {
        case 12: return 'on'           // STATE_ON
        case 11: return 'just_enabled' // STATE_TURNING_ON
        case 10: return 'off'          // STATE_OFF
        case 13: return 'off'          // STATE_TURNING_OFF
        default: return 'unknown'
      }
    },

    /**
     * ★ v3.11: 原生 BroadcastReceiver 回调 — 蓝牙状态变化的主驱动力
     * @param {number} state  10=OFF, 11=TURNING_ON, 12=ON, 13=TURNING_OFF
     * @param {number} prevState
     */
    _onNativeBtStateChange(state, prevState) {
      const next = this._mapNativeState(state)
      if (this.btState === next) return  // 去重

      // ★ 标记：原生广播已收到，btState 从此由原生广播驱动。用于 _checkBluetoothState 保护判断
      this._nativeBtFired = true

      console.log(`[Store] ⚡ 原生广播: ${this.btState} → ${next} (state=${state})`)

      if (state === 11) {
        // ★ STATE_TURNING_ON: 用户刚点"允许"，系统正在开启蓝牙 → 绿色 banner
        this.btState = 'just_enabled'
      } else if (state === 12) {
        // ★ STATE_ON: 蓝牙完全开启 → 无 banner，尝试重连
        this.btState = 'on'
        if (!this.connected && this.deviceId && this.reconnectMode === 'paused') {
          console.log('[Store] 蓝牙恢复（原生广播），重启重连流程')
          if (this._reconnectTimer) {
            clearTimeout(this._reconnectTimer)
            this._reconnectTimer = null
          }
          this.reconnectMode = 'idle'
          this.reconnectAttempt = 0
          this.reconnectNextDelay = 0
          this._reconnectGuard++
          this._startReconnect()
        }
      } else if (state === 10 || state === 13) {
        // ★ STATE_OFF / STATE_TURNING_OFF: 蓝牙关闭 → 红色 banner
        this.btState = 'off'
        this._handleBtOff()
      }
    },

    /**
     * ★ v3.11: Uni-APP 适配器状态回调（iOS 主驱 / Android 不会调用）
     */
    _onUniBtAdapterStateChange(available, _discovering) {
      const next = available ? 'on' : 'off'
      if (this.btState === next) return

      // ★ 修复：just_enabled 表示"正在开启中"，此时 available=false 是正常的过渡状态
      //   原生广播已设 just_enabled，不能因 Uni-APP 的延迟事件覆盖回 off
      if (!available && this.btState === 'just_enabled') {
        console.log('[Store] Uni-APP available=false 但 btState=just_enabled → 忽略（正在开启中）')
        return
      }

      console.log(`[Store] Uni-APP 适配器变化: available=${available} → btState=${next}`)
      this.btState = next

      if (available && !this.connected && this.deviceId && this.reconnectMode === 'paused') {
        console.log('[Store] 蓝牙恢复（Uni-APP），重启重连流程')
        if (this._reconnectTimer) {
          clearTimeout(this._reconnectTimer)
          this._reconnectTimer = null
        }
        this.reconnectMode = 'idle'
        this.reconnectAttempt = 0
        this.reconnectNextDelay = 0
        this._reconnectGuard++
        this._startReconnect()
      } else if (!available) {
        this._handleBtOff()
      }
    },

    /**
     * ★ v3.11: 蓝牙关闭时的统一处理
     */
    _handleBtOff() {
      this._reconnectGuard++
      console.log(`[Store] ⛧ 重连锁递增 → ${this._reconnectGuard}`)

      if (this._reconnectTimer) {
        clearTimeout(this._reconnectTimer)
        this._reconnectTimer = null
      }
      this.connected = false
      this.deviceState = 'LOCKED'
      this.rssi = -999
      this.filteredRssi = -999
      this.reconnectMode = 'paused'
      this.reconnectNextDelay = 0
    },

    /**
     * ★ v3.11-fix: 检查蓝牙适配器是否已开启
     *
     *   ★ 核心保护：getBluetoothAdapterState() 在 Android 上有延迟，
     *     可能返回 available=true 但原生广播已报告 STATE_OFF。
     *     绝不允许用延迟的 available=true 覆盖已确认的 btState='off'。
     *
     * @returns {Promise<boolean>} true=已开启，false=未开启
     */
    async _checkBluetoothState() {
      const state = await getBluetoothAdapterState()
      if (state.available) {
        // ★ 若原生广播已确认蓝牙关闭，拒绝用延迟数据反转
        //   关键：只有 _nativeBtFired 时 btState='off' 才是原生广播确认的，
        //   否则可能是早期 "not init" 调用误设的，应当允许覆盖
        if (this.btState === 'off' && this._nativeBtFired) {
          console.log('[Store] ⛧ _checkBluetoothState: 拒绝用延迟 available=true 覆盖 off（原生已确认）')
          return false
        }
        if (this.btState !== 'on' && this.btState !== 'just_enabled') {
          this.btState = 'on'
        }
        return true
      }
      // ★ 原生广播优先：getBluetoothAdapterState 可能因 "not init" / 延迟等原因返回 false，
      //   但原生广播已确认蓝牙为 on/just_enabled → 信任原生广播，不覆盖
      if (this.btState === 'on' || this.btState === 'just_enabled') {
        console.log('[Store] ⛧ _checkBluetoothState: available=false 但 btState=' + this.btState + ' → 信任原生广播')
        return true
      }
      if (this.btState !== 'off') {
        this.btState = 'off'
      }
      return false
    },

    /**
     * ★ v3.14-bugfix: 强制刷新蓝牙适配器状态（用于 onShow 等从后台切回的场景）
     *
     *   与 _checkBluetoothState 的核心区别：
     *     _checkBluetoothState:  信任原生广播缓存 → 避免 Android 初始化延迟误判
     *     _forceRefreshBluetoothState: 不信任缓存 → 直接以 getBluetoothAdapterState 为准
     *
     *   场景：App 从后台切回时，原生广播可能错过了 STATE_OFF 事件，
     *   btState 为 stale 'on' 而蓝牙实际已关。此时必须强制以实时查询结果为准，
     *   否则会触发"信任原生广播"保护线 → btState 永远无法修正 → 重连死循环。
     *
     * @returns {Promise<boolean>} true=蓝牙已开启，false=蓝牙已关闭
     */
    async _forceRefreshBluetoothState() {
      try {
        const state = await getBluetoothAdapterState()
        if (state.available) {
          this.btState = 'on'
          console.log('[Store] _forceRefreshBluetoothState: 蓝牙已开启')
          return true
        } else {
          this.btState = 'off'
          console.log('[Store] _forceRefreshBluetoothState: 蓝牙已关闭')
          return false
        }
      } catch (e) {
        // API 调用异常 → 保守回退到当前缓存值
        console.warn('[Store] _forceRefreshBluetoothState 异常，回退缓存:', e)
        return this.btState === 'on'
      }
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

    // ★ v3.11: _onBtAdapterStateChange 已移除（由原生广播 _onNativeBtStateChange 替代）

    // ★ v3.11: _scheduleCooldownDefer, _recoverAdapter, _applyBtAdapterState 已全部移除

    /**
     * ★ v3.11-fix2: 尝试开启蓝牙适配器（由用户点击 UI 按钮触发）
     *
     *   绿 banner 时机 = 用户点「允许」的瞬间（onActivityResult），
     *   不等 initBluetooth 轮询完成。与 nRF Connect 行为完全一致。
     *
     * @returns {Promise<boolean>}
     */
    async enableBluetooth() {
      try {
        await initBluetooth({
          onAllowing: () => {
            // ★★ 用户点「允许」的瞬间 → 立即亮绿 banner
            //   此时系统「正在开启蓝牙…」弹窗也在显示，二者同步
            this.btState = 'just_enabled'
            console.log('[Store] ⚡ onAllowing → 绿 banner（与系统弹窗同步）')
          }
        })
        // initBluetooth 轮询完成 → 此时蓝牙已完全开启
        // 兜底：如果绿 banner 还没亮过（btState 仍是 off/unknown），手动设
        if (this.btState === 'off' || this.btState === 'unknown') {
          this.btState = 'just_enabled'
          console.log('[Store] ⚡ 兜底设 just_enabled')
        }
        console.log('[Store] initBluetooth 完成 → btState=' + this.btState)

        // 蓝牙已开，尝试重连。connected=true 时 banner 自然消失
        if (!this.connected && this.deviceId && this.reconnectMode !== 'dormant') {
          this.tryReconnect()
        }

        return true
      } catch (err) {
        // ★ 用户点「拒绝」或超时 → btState 保持 'off'（红色 banner 继续）
        console.warn('[Store] enableBluetooth 失败:', err)
        this.btState = 'off'
        this.reconnectMode = 'idle'
        throw err
      }
    },

    // ==================== 断连处理 & 重连（v3.6） ====================

    /** 统一断连处理入口（由全局 _connHandler 触发） */
    _handleDisconnect() {
      // ★ v3.11: 清除所有定时器防止竞态
      if (this._reconnectTimer) {
        clearTimeout(this._reconnectTimer)
        this._reconnectTimer = null
      }
      this.connected = false
      this.deviceState = 'LOCKED'
      this.rssi = -999
      this.filteredRssi = -999
      this.batteryLevel = -1        // ★ v3.14: 断连重置电量

      // ★ v3.12: 断连时重置恢复标记，确保重连时能重新加载 per-SN 配置
      this._restoredForSn = ''

      // ★ v3.6-fixD2: 递增重连锁，过期任何已在执行的 _doReconnect
      //   当 _handleDisconnect 领先于适配器事件到达时，旧 session 立刻失效，
      //   防止 _checkBluetoothState 用 Android 延迟的 available=true 写回 btState='on'
      this._reconnectGuard++
      console.log(`[Store] ⛧ 断连触发锁递增 → ${this._reconnectGuard}`)

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

      // 异常断连 → 启动重连循环（以新 guard 值启动）
      // ★ v3.9.1: _doReconnect 成功时（connected=true）会二次确认 btState，
      //   若 btState 已为 'off' 则立即回滚，防止关蓝牙时闪现"已连接"。
      console.log('[Store] 异常断连，启动重连...')
      this._startReconnect()
    },

    /**
     * ★ v3.14-bugfix: 轻量连接验证（App 从后台切回时使用）
     *
     *   通过 getBLEDeviceServices 做一次真实的 GATT 交互验证 BLE 连接是否仍然存活。
     *   如果连接已丢失（设备走远、系统回收、蓝牙被关闭），此方法会超时失败。
     *
     *   场景：
     *     - App 挂后台很久，BLE 物理断开但 _connHandler 未被触发
     *     - 用户从控制中心关闭蓝牙后切回 App
     *
     *   超时设计：
     *     - 正常连接：~200ms 内返回
     *     - 连接已断：uni.getBLEDeviceServices 约 3-5 秒超时
     *     - 额外 3000ms 兜底超时防止永久阻塞
     *
     * @returns {Promise<boolean>} true=连接正常，false=连接已失效
     */
    async _verifyConnection() {
      if (!this.connected || !this.deviceId) return false

      // ★ v3.14-bugfix: 如果蓝牙已确认关闭，无需验证，直接清理
      if (this.btState === 'off') {
        console.log('[Store] _verifyConnection: btState=off，直接清理')
        this._handleDisconnect()
        return false
      }

      // ★ v3.14-bugfix2: 优先使用 getConnectedBluetoothDevices 做系统级验证
      //   getBLEDeviceServices 在 Android 上可能返回缓存数据（屏显唤醒时
      //   Android 通过 stale handle "重连"成功，GATT services 被缓存），
      //   导致虚假的"连接正常"。getConnectedBluetoothDevices 直接查询系统
      //   蓝牙管理器，结果无法被缓存伪造。
      try {
        const devices = await new Promise((resolve, reject) => {
          uni.getConnectedBluetoothDevices({
            services: [BLE_CONFIG.serviceUUID],
            success: (res) => resolve(res.devices || []),
            fail: (err) => reject(err)
          })
        })
        const found = devices.some(d => d.deviceId === this.deviceId)
        if (found) {
          console.log('[Store] _verifyConnection: 连接正常（系统级验证）')
          return true
        }
        // 设备不在系统已连接列表 → 连接已失效
        console.log('[Store] _verifyConnection: 设备不在已连接列表，连接已失效')
        this._handleDisconnect()
        return false
      } catch (e) {
        // ★ getConnectedBluetoothDevices 失败 → 回退到 GATT services 验证
        console.warn('[Store] _verifyConnection: getConnectedBluetoothDevices 失败，回退 GATT:', e?.message || e)
        try {
          await Promise.race([
            getBLEDeviceServices(this.deviceId),
            new Promise((_, reject) => setTimeout(() => reject(new Error('VERIFY_TIMEOUT')), 3000))
          ])
          console.log('[Store] _verifyConnection: 连接正常（GATT 回退验证）')
          return true
        } catch (e2) {
          const msg = e2?.message || String(e2)
          console.log('[Store] _verifyConnection: 连接已失效 —', msg)
          this._handleDisconnect()
          return false
        }
      }
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
        } catch (e) {
          // ★ v3.6-fixD2: SESSION_EXPIRED → 蓝牙关断穿透，立即中止，不重试
          if (e && e.message === 'SESSION_EXPIRED') {
            console.log('[Store] ⛧ 重连会话过期，放弃本轮')
            return
          }

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
     * ★ 统一入口：确保全局监听器 + 蓝牙适配器均已初始化
     * ★ v3.6-fixD: 会话锁机制，防止蓝牙关闭后仍在执行的 _doReconnect 覆盖状态
     */
    async _doReconnect() {
      // ★ v3.6-fixD: 记录此轮重连的会话锁版本号
      const guard = this._reconnectGuard
      /** 检查会话锁是否失效（蓝牙是否在此期间被关闭） */
      const guardValid = () => this._reconnectGuard === guard
      const guardAbort = (reason) => {
        console.log(`[Store] ⛧ _doReconnect 中止: ${reason}`)
        throw new Error('SESSION_EXPIRED')
      }

      // ★ v3.6-fix1: 确保全局监听器已注册（所有重连路径均经过此处）
      this._ensureGlobalListeners()

      // ★ v3.6-fix1C: 确保蓝牙适配器已初始化（轻量版，不弹窗）
      if (this.btState !== 'enabling') {
        try {
          await new Promise((resolve) => {
            uni.openBluetoothAdapter({
              success: () => resolve(),
              fail: (err) => {
                const msg = String(err?.errMsg || '')
                if (msg.includes('already open')) { resolve(); return }
                console.warn('[Store] _doReconnect: 适配器初始化跳过', msg)
                resolve()
              }
            })
          })
        } catch (e) {
          // ignore
        }

        // ★ v3.6-fixD: 检查锁 — openBluetoothAdapter 期间蓝牙可能已被关闭
        if (!guardValid()) guardAbort('openBluetoothAdapter 期间锁失效')
      }

      // ★ v3.11-fix: 重连前确认蓝牙已开（原生广播优先，_checkBluetoothState 作兜底确认）
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

      // ★ v3.6-fixB: 重连前先断开可能残留的旧连接句柄
      try {
        uni.closeBLEConnection({ deviceId: this.deviceId })
        console.log('[Store] _doReconnect: 已清理旧连接句柄')
      } catch (e) {
        // 断开失败无所谓
      }

      // 等待系统处理断开
      await new Promise(r => setTimeout(r, 300))
      if (!guardValid()) guardAbort('closeBLEConnection 等待期间锁失效')

      // ★ v3.6-fixD: 连接前最后确认锁 — 若已失效立即中止
      if (!guardValid()) guardAbort('connectDevice 前锁失效')

      // 连接（★ v3.6-fixG: 捕获僵死句柄 → 重置适配器后重试一次）
      await this._connectWithResetFallback()

      // ★ v3.6-fixD: 连接成功后的最终锁检查
      //   防止蓝牙关闭瞬间 connectDevice 意外 resolve（例如 already connect）
      if (!guardValid()) {
        console.warn('[Store] ⛧ _doReconnect: connectDevice 成功但锁已失效，不回写状态')
        throw new Error('SESSION_EXPIRED')
      }

      // ★ v3.9.1 TOCTOU 修复：connectDevice 成功后再次查询真实适配器状态。
      //   this.btState 是响应式变量，依赖适配器事件回调异步更新。当断连事件
      //   领先适配器事件到达时，_doReconnect 全程看到的 btState 都是过时的 'on'，
      //   必须通过 getBluetoothAdapterState() 直接查询系统真实状态。
      //   ★ 在设 connected=true 之前执行，避免红→绿→红的 UI 闪烁。
      try {
        const realState = await getBluetoothAdapterState()
        if (!realState.available) {
          console.warn('[Store] ⛧ _doReconnect: 连接后确认适配器实际已关闭，放弃')
          this.reconnectMode = 'paused'
          throw new Error('SESSION_EXPIRED')
        }
      } catch (e) {
        if (e && e.message === 'SESSION_EXPIRED') throw e
        // 查询失败保守处理：不阻断（偶尔 API 本身失败不是蓝牙关闭）
        console.warn('[Store] ⛧ _doReconnect: 适配器状态查询失败，放行')
      }
      // ★ 二次锁检查（getBluetoothAdapterState 是异步的，期间锁可能失效）
      if (!guardValid()) guardAbort('最终适配器确认后锁失效')

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

      /* ★ v3.15: 统一后处理（Notify + 电池 + 序列号 + 配置恢复）
       *   _onDidConnect 封装了重连 & 手动连接共同的 80% 初始化逻辑
       *   任何步骤失败都不阻塞流程（均为 .catch 静默降级） */
      await this._onDidConnect('reconnect')
    },

    /**
     * ★ v3.14: GATT Read 读取电池电量（独立数据源，不依赖扫描缓存）
     *   连接建立后非阻塞调用，覆盖手动连接 + 自动重连两条路径。
     */
    async _fetchBatteryLevel(deviceId) {
      if (!deviceId) return
      try {
        await new Promise(r => setTimeout(r, 1200)) // 等待 GATT 数据库就绪
        const level = await readBatteryLevel(deviceId, 5000)
        if (level >= 0 && level <= 100) {
          this.batteryLevel = level
          console.log('[Store] GATT 电池电量:', level + '%')
        }
      } catch (e) {
        console.log('[Store] GATT 读取电池电量失败（设备可能未注册 Battery Service）:', e.message)
      }
    },

    /**
     * ★ v3.15: 连接建立后的统一后处理
     *   _doReconnect 和 connect 共用，消除 ~40 行重复代码。
     *   负责：GATT 延迟等待 → Notify 启用 → 电池读取 → 序列号恢复
     *
     * @param {'connect'|'reconnect'} source - 连接来源
     */
    async _onDidConnect(source = 'reconnect') {
      const deviceId = this.deviceId
      const label = source === 'reconnect' ? '重连' : '手动连接'

      // 1. 延迟等待 GATT 数据库就绪
      const delayMs = source === 'reconnect' ? 800 : 1000
      await new Promise(r => setTimeout(r, delayMs))

      // 2. Status Notify（非致命：连接已建立，失败不中断）
      notifyBLECharacteristicValueChange(
        deviceId, BLE_CONFIG.serviceUUID, BLE_CONFIG.statusCharUUID, true
      ).catch(err => {
        console.warn(`[Store] ${label}后 Status Notify 失败（连接仍有效）:`, err?.errMsg || err?.message)
      })

      // 3. Battery Notify + 非阻塞读取电量
      notifyBLECharacteristicValueChange(
        deviceId, BATT_SERVICE.serviceUUID, BATT_SERVICE.levelCharUUID, true
      ).catch(() => {})
      this._fetchBatteryLevel(deviceId).catch(() => {})

      // 4. 序列号读取 + 设备名/配置恢复（非阻塞）
      readSerialNumber(deviceId, 5000).then(sn => {
        this.serialNumber = sn
        console.log('[Store] 设备序列号（FF04）:', sn)

        // 手动连接时与广播包指纹比对
        if (source === 'connect' && this.fingerprint &&
            sn.slice(-6).toUpperCase() !== this.fingerprint.toUpperCase()) {
          console.warn('[Store] ⚠ 序列号指纹不匹配！广播:', this.fingerprint, '序列号:', sn.slice(-6))
        }

        this._resolveDeviceName(sn)
        this._loadConfigForDevice(sn)
        this._syncConfigToDevice()
      }).catch(err => {
        const msg = err?.message || String(err)
        if (/not support|no characteristic|FF04 not in/i.test(msg)) {
          console.log(`[Store] 固件不支持 FF04 序列号（需升级 v3.3）:`, msg)
        } else if (/timeout/i.test(msg)) {
          console.log(`[Store] 序列号读取超时:`, msg)
        } else {
          console.warn(`[Store] ${label}后序列号读取失败:`, msg)
        }
      })
    },

    /**
     * ★ v3.6-fixG: 连接设备 + 僵死句柄自动恢复
     *   当 connectDevice 抛出 ALREADY_CONNECT_STALE 时，重置适配器并重试一次
     *   @param {string} [deviceId] 设备 ID，不传则用 this.deviceId
     */
    async _connectWithResetFallback(deviceId) {
      const targetId = deviceId || this.deviceId
      try {
        await connectDevice(targetId)
      } catch (e) {
        if (e && e.message === 'ALREADY_CONNECT_STALE') {
          // ★ v3.6-fixG v3: 若 btState 已为 off，说明适配器事件已到达，系统蓝牙确实关了
          //   此时重置适配器只会强行 btState='on' 造成错误 → 直接抛出让上层暂停重连
          if (this.btState === 'off') {
            console.log('[Store] ⛧ btState 已为 off，跳过适配器重置（系统蓝牙已关）')
            throw e
          }
          console.log('[Store] ⛧ GATT 僵死，重置适配器...')
          await this._resetBluetoothAdapter()
          console.log('[Store] 适配器重置完成，重试连接...')
          await connectDevice(targetId)
        } else {
          throw e
        }
      }
    },

    /**
     * ★ v3.6-fixG: 重置蓝牙适配器（close → wait → open）
     *   全程 _adapterResetting=true 压制 Store 适配器事件处理
     */
    async _resetBluetoothAdapter() {
      this._adapterResetting = true
      try {
        await new Promise((resolve) => {
          uni.closeBluetoothAdapter({ complete: () => resolve() })
        })
        console.log('[Store] 适配器已关闭，等待系统释放资源...')
        await new Promise(r => setTimeout(r, 800))

        await new Promise((resolve, reject) => {
          uni.openBluetoothAdapter({
            success: () => {
              console.log('[Store] 适配器重新打开成功')
              resolve()
            },
            fail: (err) => {
              console.error('[Store] 适配器重新打开失败', err?.errMsg)
              reject(err)
            }
          })
        })
        // ★ v3.9.1: 验证适配器真实状态后再同步 btState。
        //   _adapterResetting=true 期间适配器事件被全部丢弃（包括用户关闭蓝牙事件）。
        //   若用户在 800ms 等待窗口内关闭了系统蓝牙，openBluetoothAdapter 会强行
        //   重开适配器。此时必须通过 getBluetoothAdapterState 确认真实状态，
        //   避免盲设 btState='on' 导致后续连接成功 → connected=true 闪现。
        try {
          const realState = await getBluetoothAdapterState()
          if (!realState.available) {
            console.warn('[Store] ⛧ 适配器重置后确认蓝牙仍不可用，放弃')
            this.btState = 'off'
            this.reconnectMode = 'paused'
            throw new Error('SESSION_EXPIRED')
          }
        } catch (e) {
          if (e && e.message === 'SESSION_EXPIRED') throw e
          // getBluetoothAdapterState 自身异常 → 保守放行
          console.warn('[Store] ⛧ 适配器状态查询异常，保守继续')
        }
        // 适配器状态手动同步（确认可用后才设）
        this.btState = 'on'
        // 等适配器完全就绪
        await new Promise(r => setTimeout(r, 500))
      } finally {
        this._adapterResetting = false
      }
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

    /**
     * ★ v3.12: 持久化当前配置到本地存储（按设备序列号分 key）
     *
     *   存储 key: ble_config_v1_{SN}
     *   每个手机对每个 KeyGo 设备有独立的阈值配置
     *   设备固件不持久化阈值（RAM-only），由手机连接后自动下发
     */
    _persistConfig() {
      if (!this.serialNumber) {
        console.warn('[Store] _persistConfig: 序列号未就绪，跳过持久化')
        return
      }
      try {
        const key = 'ble_config_v1_' + this.serialNumber
        uni.setStorageSync(key, {
          unlockThreshold: this.unlockThreshold,
          lockThreshold: this.lockThreshold,
          unlockCountRequired: this.unlockCountRequired,
          lockCountRequired: this.lockCountRequired,
          rssiReadPeriodMs: this.rssiReadPeriodMs,
          disconnectLockDelayMs: this.disconnectLockDelayMs,
          kalmanR: this.kalmanR,
          // ★ v3.12: cooldown_ms 不在这里持久化（设备级参数，由固件 DataFlash 管理）
        })
        console.log('[Store] 配置已持久化 (' + key.slice(-12) + '): unlock=' + this.unlockThreshold + ' lock=' + this.lockThreshold)
      } catch (e) {
        console.warn('[Store] 配置持久化失败:', e)
      }
    },

    /**
     * ★ v3.12: 加载指定设备的专属配置（per-phone 个性化）
     *
     *   连接成功后、SN 就绪时调用。
     *   如果该设备有专属配置 → 覆盖当前阈值
     *   如果没有 → 保持 _restoreConfig 加载的旧版全局值（或默认值）
     *
     *   与 _restoreConfig 的关系：
     *     _restoreConfig() → 初始加载（旧版全局 / 默认值）→ 保证 UI 有值
     *     _loadConfigForDevice(sn) → SN 就绪后覆盖为设备专属值 → 精确匹配
     *
     * @param {string} sn 设备序列号
     */
    _loadConfigForDevice(sn) {
      this._restoreConfig(sn)  // ← 内部有 _restoredForSn 防重复，新 SN 会触发重新加载
    },

    /**
     * ★ v3.13: 将当前手机端的阈值配置下发到 BLE 设备固件
     *
     *   设计原则：
     *     - 设备固件阈值存 RAM（不写 DataFlash），断电即丢失
     *     - 手机每次连接成功后自动下发，确保设备运行时阈值与当前手机一致
     *     - 不同手机连同一个 KeyGo → 设备使用各自手机的阈值 → per-phone 个性化
     *
     * ★ v3.12: cooldown_ms 不在此处下发（设备级参数，由固件 DataFlash 管理）
     *   - 连接时不下发 → 设备保持自己的冷却时间
     *   - 用户手动修改 → updateConfig() 单独下发 → 固件保存到 Flash
     *   - 连接后 App 从 FF02 同步冷却时间 → 确保 UI 显示与设备一致
     *
     *   调用时机：
     *     connect() 成功后（SN 就绪时）
     *     _doReconnect() 成功后（SN 就绪时）
     *
     * ★ v3.13: 下发内容更新
     *   interval 改为控制固件 RSSI 读取周期（原为手机端轮询间隔，已移除）
     *   新增 kr 控制卡尔曼滤波器响应速度
     *   移除手机端 RSSI 实时转发（冗余通道，固件 GAP 读取为主通道）
     */
    async _syncConfigToDevice() {
      if (!this.deviceId || !this.connected) return
      try {
        await sendConfig(this.deviceId, {
          unlock: this.unlockThreshold,
          lock: this.lockThreshold,
          uc: this.unlockCountRequired,
          lc: this.lockCountRequired,
          interval: this.rssiReadPeriodMs,
          dlock: this.disconnectLockDelayMs,
          kr: this.kalmanR,
          // ★ v3.12: cooldown_ms 不下发 — 设备级参数，由固件 DataFlash 管理
        })
        console.log('[Store] 配置已下发到设备 (unlock=' + this.unlockThreshold + ' lock=' + this.lockThreshold + ' uc=' + this.unlockCountRequired + ' lc=' + this.lockCountRequired + ' interval=' + this.rssiReadPeriodMs + ' kr=' + this.kalmanR + ')')
      } catch (e) {
        console.warn('[Store] 配置下发失败:', e?.message || e)
      }
    },

    // ==================== ★ v3.8: 设备名称本地存储（按序列号索引） ====================

    /**
     * 从本地存储加载设备名称缓存
     * 存储结构: { "SN_A1B2C3": { name: "粤B·12345", lastSeen: 1719840000 }, ... }
     */
    _loadDeviceNames() {
      if (this._deviceNames) return  // 已加载
      try {
        const saved = uni.getStorageSync('ble_device_names')
        this._deviceNames = saved ? { ...saved } : {}
        console.log('[Store] 设备名称缓存已加载:', Object.keys(this._deviceNames).length, '个设备')
      } catch (e) {
        this._deviceNames = {}
      }
    },

    /**
     * 持久化设备名称缓存到本地存储
     */
    _saveDeviceNames() {
      try {
        uni.setStorageSync('ble_device_names', this._deviceNames || {})
      } catch (e) {
        console.warn('[Store] 设备名称持久化失败:', e)
      }
    },

    /**
     * ★ v3.8: 根据序列号恢复设备自定义名称
     * 连接成功后调用（SN 读取完成时 / 重连成功时）
     * @param {string} sn 设备序列号（FF04）
     */
    _resolveDeviceName(sn) {
      if (!sn) return
      this._loadDeviceNames()
      const entry = this._deviceNames[sn]

      if (entry && entry.name) {
        // 本地有记录 → 使用本地名（覆盖 d2）
        this.customDeviceName = entry.name
        entry.lastSeen = Date.now()
        this._saveDeviceNames()
        console.log('[Store] 设备名称已从本地恢复:', entry.name, '(SN:', sn, ')')
      } else if (this.customDeviceName) {
        // 本地无记录，但 d2 已从 NotifyStatus 读回 → 用 d2 作为初始名并记录
        this._deviceNames[sn] = { name: this.customDeviceName, lastSeen: Date.now() }
        this._saveDeviceNames()
        console.log('[Store] 首次记录设备名称（来自固件 d2）:', this.customDeviceName, '(SN:', sn, ')')
      }
      // else: 本地无记录 + 无 d2 → 保持默认名（KeyGo-XXXXXX）
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

        // ★ v3.6-fixE: 用户手动连接时，清除所有自动重连状态（防止冲突）
        if (this._reconnectTimer) {
          clearTimeout(this._reconnectTimer)
          this._reconnectTimer = null
        }
        this.reconnectMode = 'idle'
        this.reconnectAttempt = 0
        this.reconnectNextDelay = 0
        this._reconnectGuard++

        // ★ 预清理旧连接句柄（和 _doReconnect 同样的保护）
        try {
          uni.closeBLEConnection({ deviceId })
          console.log('[Store] connect: 已预清理旧连接句柄')
        } catch (e) { /* ignore */ }
        await new Promise(r => setTimeout(r, 300))

        await this._connectWithResetFallback(deviceId)
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

        // ★ v3.14: 从扫描缓存中提取电池电量（广播包 Service Data）
        if (cached && cached.batteryLevel >= 0) {
          this.batteryLevel = cached.batteryLevel
          console.log('[Store] 电池电量（广播包）:', this.batteryLevel + '%')
        }

        uni.setStorageSync('ble_device_id', deviceId)

        // ★ v3.6: 全局监听器已处理连接状态变化和特征值数据（不再重复注册）

        /* ★ v3.15: 统一后处理（Notify + 电池 + 序列号 + 配置恢复）
         *   _onDidConnect 封装了重连 & 手动连接共同的 80% 初始化逻辑
         *   任何步骤失败都不阻塞流程（均为 .catch 静默降级） */
        await this._onDidConnect('connect')

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


    // ★ v3.13: 手机端 RSSI 转发已移除（冗余通道，固件 GAP 读取为主通道）
    //   RSSI 显示数据来自固件 FF02 Notify (r/f 字段)

    _scanAborted: false,
    _cooldownTimer: null,        // RSSI 手动命令冷却定时器
    _reconnectTimer: null,       // 重连定时器
    _adapterResetting: false,    // ★ v3.11: 适配器重置中标记（用于 _resetBluetoothAdapter）

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

      // ★ v3.14-bugfix3: 蓝牙已关闭或正在关闭时，忽略设备推送的 stale 状态包。
      //   _handleBtOff 先设 connected=false，但 TURNING_OFF → OFF 之间有 ~300ms，
      //   期间 Notify 回调仍可能投递已排队的 FF02 包（c=1）→ 导致 connected 诈尸。
      if (this.btState === 'off' || this.btState === 'turning_off') {
        console.log('[Store] btState=' + this.btState + '，丢弃 stale FF02 status')
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

      // ★ v3.8: 自定义名称 — d2 总是接收作为初始显示
      //   SN 到达后由 _resolveDeviceName() 用本地名称覆盖（本地优先）
      //   短暂闪烁可接受（仅 SN 已就绪 + 本地名与 d2 不同时才会发生）
      if (data.d2 !== undefined && data.d2 !== '') this.customDeviceName = data.d2

      // ★ v3.7 / v3.12: 冷却时间 ms (cd = cooldown duration)
      //   设备级参数 — 从 FF02 Notify 被动同步，确保 App 显示与设备一致
      if (data.cd !== undefined && data.cd >= 2000 && data.cd <= 30000) {
        this.manualCooldownMs = data.cd
      }
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
      if (config.interval !== undefined) this.rssiReadPeriodMs = Math.max(100, Math.min(2000, config.interval))
      if (config.dlock !== undefined) this.disconnectLockDelayMs = config.dlock
      if (config.kr !== undefined) this.kalmanR = Math.max(1, Math.min(50, config.kr))
      // ★ v3.7: 冷却时间
      if (config.cooldown_ms !== undefined) this.manualCooldownMs = config.cooldown_ms
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
      // ★ v3.6-fixH: manualCooldown 阻断手机→设备 RSSI 转发（备用通道，非主力）
      //   真正的保护链在固件端：sendCommand("UNLOCK") → KeyGo_HandleCommand():
      //     ① g_manualCooldown=1 (cooldownMs 内跳过状态机)
      //     ② g_unlockCounter/g_lockCounter=0 (清零防止累积计数触发自动操作)
      // ★ v3.7: 冷却时长使用设备同步值 manualCooldownMs，非硬编码 8s
      this.manualCooldown = true
      if (this._cooldownTimer) clearTimeout(this._cooldownTimer)
      this._cooldownTimer = setTimeout(() => {
        this.manualCooldown = false
        this._cooldownTimer = null
        console.log(`[Store] RSSI 状态机冷却结束 (${this.manualCooldownMs}ms)`)
      }, this.manualCooldownMs)
      await this.sendCommand('UNLOCK')
    },

    async lock() {
      if (!this.connected) throw new Error('未连接设备')
      // ★ v3.6-fixH: 同上，固件端主导保护
      // ★ v3.7: 使用设备同步的 manualCooldownMs
      this.manualCooldown = true
      if (this._cooldownTimer) clearTimeout(this._cooldownTimer)
      this._cooldownTimer = setTimeout(() => {
        this.manualCooldown = false
        this._cooldownTimer = null
        console.log(`[Store] RSSI 状态机冷却结束 (${this.manualCooldownMs}ms)`)
      }, this.manualCooldownMs)
      await this.sendCommand('LOCK')
    },

    async trunk() {
      if (!this.connected) throw new Error('未连接设备')
      await this.sendCommand('TRUNK')
    },

    /**
     * ★ v3.8: 设置设备自定义名称（本地存储为主）
     *
     * 名称按设备序列号（FF04）存储在手机本地，不同手机对同一台
     * KeyGo 可以起不同的名字；同一台手机连不同 KeyGo 也能记住各自的名字。
     *
     * @param {string} name 名称（最长20字符，支持中文）
     * @param {boolean} [syncToDevice=false] 是否同步写入固件 DataFlash（d2 字段）
     * @returns {Promise<boolean>}
     */
    async setDeviceName(name, syncToDevice = false) {
      if (!this.connected) throw new Error('未连接设备')
      if (name.length > 20) throw new Error('名称最长 20 字符')

      this.customDeviceName = name

      // ★ 本地存储（按序列号索引）
      if (this.serialNumber) {
        this._loadDeviceNames()
        this._deviceNames[this.serialNumber] = {
          name: name,
          lastSeen: Date.now()
        }
        this._saveDeviceNames()
        console.log('[Store] 设备名称已保存到本地 (SN:', this.serialNumber, '):', name)
      } else {
        console.warn('[Store] 设备序列号尚未就绪，名称仅暂存内存，断开后将丢失')
      }

      // ★ 可选：同步写入固件（供无本地记录的手机作为初始默认名）
      if (syncToDevice) {
        try {
          await sendCommand(this.deviceId, `NAME:${name}`)
          console.log('[Store] 设备名称已同步到固件 DataFlash d2:', name)
        } catch (e) {
          console.warn('[Store] 同步名称到固件失败:', e?.message || e)
        }
      }

      return true
    },
  }
})
