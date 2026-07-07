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
  openBluetoothAdapterOnly,       // ★ 冷启动修复：仅打开适配器（不申请权限）
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

import {
  startForegroundService,
  stopForegroundService,
  getPluginStatus,
  startHeartbeatAlarm,
  stopHeartbeatAlarm,
  registerScreenOnReceiver,
  unregisterScreenOnReceiver,
  startNativeBackgroundScan,
  stopNativeBackgroundScan,
} from '@/utils/foreground-service.js'

// ★ v3.23 Phase 3: 地理围栏工具
import {
  GEOFENCE_RADIUS,
  calculateDistance,
  getCurrentPosition,
  getCurrentPositionCoarse,
  saveParkingLocation,
  getParkingLocation,
  startGeofenceMonitor,
  stopGeofenceMonitor,
  isGeofenceMonitorActive,
  getLastKnownPosition,  // ★ v3.24: watchPosition 缓存坐标（同步，消除竞态）
} from '@/utils/geofence.js'

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
    statusStale: false,            // ★ v3.15-#13: 超时未收到 Status Notify → 连接可能已中断
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
    _adapterReady: false,         // ★ 冷启动修复：本会话是否已 openBluetoothAdapter（避免 "not init" 误判）
    reconnectMode: 'idle',        // 'idle' | 'active' | 'paused' | 'dormant'
    reconnectAttempt: 0,          // 当前重连次数
    reconnectNextDelay: 0,        // 下次重连等待秒数（UI 显示用）

    // ★ v3.23: 智能重连模式
    autoReconnectMode: 'comfort', // 'comfort' | 'manual' | 'speed'
    _dormantPollTimer: null,      // 舒适模式后台轮询定时器
    _dormantPollGuard: 0,         // 轮询会话锁
    _dormantPollCount: 0,         // ★ v3.23.2: 轮询次数（用于时间漂移日志）
    _dormantPollStartTime: 0,     // ★ v3.23.2: 轮询起始时间戳
    _heartbeatActive: false,      // ★ v3.23.2: AlarmManager 心跳是否运行
    _lastHeartbeatTime: 0,        // ★ v3.23.2: 上次心跳时间

    // ★ v3.23 Phase 3: 极速模式地理围栏
    _geofenceApproachChecked: false, // 本次 onShow 是否已触发围栏检测（防重复）
    _geofenceBleTriggered: false,    // 围栏是否已触发过 BLE 扫描（本轮监控内防重复）

    // ★ v3.17: 前台服务状态（Android 保活）
    _foregroundServiceActive: false,
    _foregroundServiceFailCount: 0,       // 失败次数（超过上限不再重试）

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
    /* ★ v3.15: 脏标记 — serial 未就绪时用户改了配置，等 serial 到达后自动补持久化
     *   解决：连接后用户改 kalmanR/阈值太快，序列号还没读到就写了，配置丢失 */
    _configDirty: false,
    /* ★ v3.15-#13: Status Notify 看门狗 — 超过 3s 未收到 FF02 推送则标记过期
     *   设备可能静默断开但 App 未感知，UI 可据此提示"连接可能已中断" */
    _statusStaleTimer: null,

    // ★ v1.0.1: 亮屏触发（舒适模式核心）
    _screenOnReceiverActive: false,
    _lastScreenOnTrigger: 0,
    _screenOnScanGuard: 0,
    _screenOnDebounce: null,
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

    /* ★ v3.15: 电池图标 — emoji 方案（默认启用）
     *   若想切换为 CSS 组件，修改 control.vue 模板中的电池区域
     *   （CSS 组件标记了 v3.15-css，注释掉 emoji 行即可启用） */
    batteryIcon: (state) => {
      if (state.batteryLevel < 0) return '❓'
      if (state.batteryLevel >= 75) return '🔋'
      if (state.batteryLevel >= 50) return '🔋'
      if (state.batteryLevel >= 25) return '🔋'
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
      // ★ v3.23: 首次调用时恢复智能重连模式（全局设置，只恢复一次）
      if (!this._autoReconnectModeRestored) {
        this._autoReconnectModeRestored = true
        try {
          let mode = uni.getStorageSync('ble_auto_reconnect_mode')
          if (mode === 'power_saver') mode = 'manual'  // ★ v3.24: 旧"省电"模式迁移为"手动"
          if (mode === 'comfort' || mode === 'manual' || mode === 'speed') {
            this.autoReconnectMode = mode
            console.log('[Store] 智能重连模式已恢复:', mode)
          }
        } catch {}
      }

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
        // ★ 冷启动修复：蓝牙开启（含 App 启动时 BT 才打开 / 手动开启）即尝试自动连，
        //   不再限定 reconnectMode==='paused'。dormant(用户主动断开)/已连接/BT 关 由闸门拦截。
        if (!this.connected && this._shouldAutoReconnect()) {
          const knownId = this.deviceId || uni.getStorageSync('ble_device_id')
          if (knownId) {
            this.deviceId = knownId
            if (this._reconnectTimer) {
              clearTimeout(this._reconnectTimer)
              this._reconnectTimer = null
            }
            this.reconnectMode = 'idle'
            this.reconnectAttempt = 0
            this.reconnectNextDelay = 0
            this._reconnectGuard++
            console.log('[Store] 蓝牙恢复（原生广播），启动自动重连')
            this._startReconnect()
          }
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

      // ★ 冷启动修复：适配器可用即尝试自动连（不限定 paused），dormant/已连接/BT 关由闸门拦截
      if (available && !this.connected && this._shouldAutoReconnect()) {
        const knownId = this.deviceId || uni.getStorageSync('ble_device_id')
        if (knownId) {
          this.deviceId = knownId
          if (this._reconnectTimer) {
            clearTimeout(this._reconnectTimer)
            this._reconnectTimer = null
          }
          this.reconnectMode = 'idle'
          this.reconnectAttempt = 0
          this.reconnectNextDelay = 0
          this._reconnectGuard++
          console.log('[Store] 蓝牙恢复（Uni-APP），启动自动重连')
          this._startReconnect()
        }
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
      // ★ v3.15-#13: 清理 Status 看门狗（已确认断开，无需标记过期）
      if (this._statusStaleTimer) {
        clearTimeout(this._statusStaleTimer)
        this._statusStaleTimer = null
      }
      // ★ v3.23: 蓝牙关闭时停止舒适模式轮询
      this._stopDormantPoll()
      /* ★ v3.16-#22: 清理 Notify 缓冲区（同 _handleDisconnect 的保护逻辑）
       *   蓝牙关闭后缓冲区残留的半截 JSON 可能在恢复后被误解析 */
      if (this._notifyTimer) {
        clearTimeout(this._notifyTimer)
        this._notifyTimer = null
      }
      this._notifyBuffer = ''
      this.connected = false
      this.deviceState = 'LOCKED'
      this.rssi = -999
      this.filteredRssi = -999
      this.statusStale = false
      this.reconnectMode = 'paused'
      this.reconnectNextDelay = 0
    },

    /**
     * ★ v3.17: 启动前台服务（Android 保活）
     *
     * 调用时机：
     *   - BLE 连接成功后
     *   - 重连成功后
     *   - App 进入后台时（兜底）
     *
     * 幂等 + 重试限制：成功后不再重试，失败最多尝试 3 次
     */
    async _ensureForegroundService() {
      if (this._foregroundServiceActive) return
      // ★ v3.24: 手动模式不启动任何保活/后台扫描（完全由用户手动控制）
      if (this.autoReconnectMode === 'manual') return
      if (this._foregroundServiceFailCount >= 3) {
        // 已经失败 3 次，放弃
        return
      }

      const knownId = this.deviceId || uni.getStorageSync('ble_device_id')

      // ★ v3.24: 优先原生插件（真正后台重连的核心）
      //   原生层 KeygoBleScanService 在原生 Android 进程常驻，锁屏/Doze 下仍能 BLE 扫描，
      //   扫到已知设备即回调唤醒 JS 触发 tryAutoConnect。这是纯 JS 方案做不到的。
      if (knownId) {
        const started = startNativeBackgroundScan('', (dev) => this._onNativeDeviceFound(dev))
        if (started) {
          this._foregroundServiceActive = true
          this._foregroundServiceNative = true
          this._foregroundServiceFailCount = 0
          console.log('[Store] 🔒 原生前台服务 + 后台扫描已启动（已知设备:', knownId, '）')
          return
        }
      }

      // ★ 回退：纯 JS（无已知设备 或 插件不可用）
      try {
        const result = await startForegroundService()
        if (result === true) {
          this._foregroundServiceActive = true
          this._foregroundServiceFailCount = 0
          console.log('[Store] 🔒 前台服务已启动（纯 JS 回退，通知栏应可见）')
        } else {
          this._foregroundServiceFailCount++
          // ★ v3.17.1: 打印诊断信息帮助定位失败原因
          const status = getPluginStatus()
          console.warn(
            `[Store] ⚠ 前台服务启动失败 (${this._foregroundServiceFailCount}/3)`,
            `\n  插件状态: ${status.status} (${status.reason})`,
            `\n  isAndroidApp: ${status.isAndroidApp}`,
            `\n  pluginLoaded: ${status.pluginLoaded}`
          )
        }
      } catch (e) {
        this._foregroundServiceFailCount++
        console.warn('[Store] 前台服务启动异常:', e?.message || e)
      }
    },

    /**
     * ★ v3.17: 停止前台服务（Android 保活）
     *
     * 调用时机：用户主动断开连接时
     * 注意：异常断连（_handleDisconnect）不停止前台服务！
     */
    async _stopForegroundService() {
      if (!this._foregroundServiceActive) return
      try {
        if (this._foregroundServiceNative) {
          stopNativeBackgroundScan()
        } else {
          await stopForegroundService()
        }
        console.log('[Store] 🔓 前台服务已停止')
      } catch (e) {
        console.warn('[Store] 前台服务停止失败:', e?.message || e)
      } finally {
        this._foregroundServiceActive = false
        this._foregroundServiceNative = false
      }
    },

    /**
     * ★ v3.24: 原生后台扫描发现设备回调
     *
     * 由 KeygoBleScanService（原生层）扫到设备后经 UniJSCallback 触发。
     * 这里只做一件事：若扫到的是「已知设备」(MAC 匹配)，且当前应自动重连、尚未连接，
     * 则调用已有的 tryAutoConnect() 完成连接（复用成熟逻辑，不在原生层重写 GATT）。
     *
     * @param {object} dev { event, mac, name, rssi }
     */
    _onNativeDeviceFound(dev) {
      if (this.connected) return
      if (!this._shouldAutoReconnect()) return
      const mac = (dev && dev.mac) || ''
      if (!mac) return
      const knownId = this.deviceId || uni.getStorageSync('ble_device_id')
      if (!knownId) return
      // MAC 比对（统一去冒号 + 大写，兼容大小写/分隔符差异）
      const a = String(mac).replace(/:/g, '').toUpperCase()
      const b = String(knownId).replace(/:/g, '').toUpperCase()
      if (a !== b) return
      // ★ 节流：原生扫描是持续的，设备持续广播会高频回调（每秒可能数次），
      //   若直接每次 tryAutoConnect 会狂连。限制 8s 内最多触发一次。
      const now = Date.now()
      if (this._lastNativeReconnect && now - this._lastNativeReconnect < 8000) return
      this._lastNativeReconnect = now
      console.log('[Store] 🔑 原生后台扫描发现已知设备，触发重连')
      this.tryAutoConnect()
    },

    /**
     * ★ 冷启动修复：以实时适配器状态校正 btState
     *
     * 仅当适配器确实可用 available=true 时置 'on'（让后续自动连/扫描正常走通）；
     * 不可用且不在 "正在开启中"(just_enabled) 时回落 'off'。
     * 用于 initBluetooth 成功后，避免 "just_enabled 绿 banner 永不流转" 等卡死问题。
     */
    async _reconcileBtState() {
      try {
        const state = await getBluetoothAdapterState()
        if (state.available) {
          if (this.btState !== 'on' && this.btState !== 'just_enabled') {
            this.btState = 'on'
          }
        } else if (this.btState !== 'just_enabled') {
          this.btState = 'off'
        }
      } catch (e) {
        // 查询失败：保持当前状态，交由监听器/重试纠正
        console.warn('[Store] _reconcileBtState 异常，保持现状:', e?.message || e)
      }
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
        this._adapterReady = true
        // ★ 冷启动修复：initBluetooth 成功 = 适配器已打开。
        //   若此时蓝牙实际可用(available=true)，直接校正为 'on'，
        //   避免「BT 早已开启、点击红banner开启时 openBluetoothAdapter 立即成功、
        //   不触发 STATE_ON 变化事件 → just_enabled 绿 banner 永远不流转」的卡死。
        await this._reconcileBtState()
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
      // ★ v3.15-#13: 清理 Status 看门狗（已确认断开）
      if (this._statusStaleTimer) {
        clearTimeout(this._statusStaleTimer)
        this._statusStaleTimer = null
      }
      /* ★ v3.16-#22: 清理 Notify 缓冲区，防止跨连接 JSON 污染
       *   断连时缓冲区残留的半截 JSON 片段可能在重连后被误解析，
       *   导致状态显示错乱（如 connected=1 但实际刚重连还未收到 Status） */
      if (this._notifyTimer) {
        clearTimeout(this._notifyTimer)
        this._notifyTimer = null
      }
      this._notifyBuffer = ''
      this.connected = false
      this.deviceState = 'LOCKED'
      this.rssi = -999
      this.filteredRssi = -999
      this.statusStale = false
      this.batteryLevel = -1        // ★ v3.14: 断连重置电量

      // ★ v3.12: 断连时重置恢复标记，确保重连时能重新加载 per-SN 配置
      this._restoredForSn = ''

      // ★ v3.24: 极速模式下断连 → 三级后备记录停车位置 + 启动后台 GPS 围栏
      if (this.autoReconnectMode === 'speed') {
        console.log('[Store] ⚡ 极速模式断连，记录停车位置 + 启动围栏监控...')

        // 1. 确保前台服务存活（GPS 监控需要）
        this._ensureForegroundService()

        // 2. Priority 1: 尝试使用 watchPosition 缓存的最近坐标（同步，零延迟）
        const cachedPos = getLastKnownPosition()
        const MAX_CACHE_AGE = 300000  // 5 分钟

        if (cachedPos && cachedPos.age < MAX_CACHE_AGE) {
          console.log(`[Store] ⚡ 使用缓存坐标 (${(cachedPos.age / 1000).toFixed(1)}s 前，精度 ±${Math.round(cachedPos.accuracy)}m)`)
          saveParkingLocation(cachedPos.lat, cachedPos.lng)
          this._startGeofenceMonitor()
          this._startHeartbeat()

          // 异步补一次高精度 GPS，静默更新停车位置（不阻塞围栏启动）
          getCurrentPosition().then(pos => {
            if (pos) {
              saveParkingLocation(pos.lat, pos.lng)
              console.log('[Store] ⚡ 高精度 GPS 已更新停车位置')
            }
          })
          return
        }

        // 3. Priority 2 & 3: 缓存不可用 → 异步 GPS / 悲观启动
        console.log(cachedPos
          ? `[Store] ⚡ 缓存坐标过期 (${(cachedPos.age / 1000).toFixed(0)}s)，降级为异步 GPS`
          : '[Store] ⚡ 无缓存坐标，异步获取 GPS...')

        getCurrentPosition().then(pos => {
          if (pos) {
            saveParkingLocation(pos.lat, pos.lng)
            this._startGeofenceMonitor()
            this._startHeartbeat()
            console.log('[Store] ⚡ GPS 停车位置已记录，围栏监控已启动')
          } else {
            // Priority 3: GPS 不可用 → 用 localStorage 旧位置悲观启动围栏
            console.warn('[Store] ⚡ GPS 不可用，使用旧停车位置悲观启动围栏...')
            this._startGeofenceMonitor()  // 内部读取 localStorage 旧位置
            this._startHeartbeat()
          }
        }).catch(() => {
          console.warn('[Store] ⚡ GPS 异常，悲观启动围栏...')
          this._startGeofenceMonitor()
          this._startHeartbeat()
        })
        return
      }

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

      // ★ v3.23 Phase 3: 极速模式下不启动 BLE 后台重连（GPS 围栏接管）
      if (this.autoReconnectMode === 'speed') {
        console.log('[Store] ⚡ 极速模式：不启动 BLE 重连，GPS 围栏监控已在运行')
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

    // ==================== ★ v3.23: 舒适模式后台轮询 ====================

    /**
     * 启动舒适模式后台轮询（每 2 分钟短扫描一次）
     *
     * 调用时机：
     *   - 10 次重连失败后（autoReconnectMode === 'comfort'）
     *   - 异常断连后（autoReconnectMode === 'comfort'）
     *   - 用户主动断开后（autoReconnectMode === 'comfort'）
     *
     * 幂等：已在轮询中则忽略
     */
    _startDormantPoll() {
      if (this.autoReconnectMode !== 'comfort') return
      if (this._dormantPollTimer) return  // 已在轮询中
      if (!this.deviceId && !this.lastDeviceId) return  // 没有可重连的设备

      // 确保 deviceId 可用
      if (!this.deviceId && this.lastDeviceId) {
        this.deviceId = this.lastDeviceId
      }

      this._dormantPollGuard++
      const guard = this._dormantPollGuard
      this._dormantPollCount = 0
      this._dormantPollStartTime = Date.now()

      const nowStr = new Date().toLocaleTimeString()
      console.log(`[Store] 🌙 舒适模式轮询启动 (guard=${guard}) @ ${nowStr}`)

      // ★ v3.23.2: 启动 AlarmManager 心跳（防 Doze 冻结 setInterval）
      this._startHeartbeat()

      // 立即执行第一次扫描
      this._dormantPollCount++
      const scanStart = Date.now()
      this._doDormantScan(guard).then(() => {
        console.log(`[Store] 🌙 扫描 #${this._dormantPollCount} 完成 (耗时 ${Date.now() - scanStart}ms)`)
      })

      // 之后每 2 分钟一次
      const pollStartTime = this._dormantPollStartTime
      this._dormantPollTimer = setInterval(() => {
        if (this._dormantPollGuard !== guard) {
          this._stopDormantPoll()
          return
        }
        if (this.connected || this.btState === 'off') {
          this._stopDormantPoll()
          return
        }
        this._dormantPollCount++
        const elapsed = Date.now() - pollStartTime
        const expected = this._dormantPollCount * 120000  // 2 分钟间隔
        const drift = elapsed - expected
        const driftSign = drift > 0 ? '+' : ''
        const driftWarn = Math.abs(drift) > 15000 ? ' ⚠️ 漂移!' : ''  // 超过 15s 告警
        console.log(`[Store] 🌙 扫描 #${this._dormantPollCount} @ ${new Date().toLocaleTimeString()} | 距启动 ${Math.round(elapsed/1000)}s | 漂移 ${driftSign}${Math.round(drift/1000)}s${driftWarn}`)
        this._doDormantScan(guard)
      }, 120000) // 2 分钟
    },

    /**
     * 加速一次轮询扫描（从外部触发，如 onShow）
     * 不清除现有定时器，额外增加一次立即扫描
     */
    _accelerateDormantPoll() {
      if (this.autoReconnectMode !== 'comfort') return
      if (this.connected) return
      if (this.btState === 'off') return
      if (!this.deviceId && !this.lastDeviceId) return

      if (!this.deviceId && this.lastDeviceId) {
        this.deviceId = this.lastDeviceId
      }

      console.log('[Store] ⚡ 加速舒适模式扫描（onShow 触发）')
      this._doDormantScan(this._dormantPollGuard)
    },

    /**
     * 停止舒适模式后台轮询
     */
    _stopDormantPoll() {
      if (this._dormantPollTimer) {
        clearInterval(this._dormantPollTimer)
        this._dormantPollTimer = null
      }
      this._dormantPollGuard++
      // ★ v3.23.2: 停止 AlarmManager 心跳
      this._stopHeartbeat()
      const totalElapsed = this._dormantPollStartTime ? Math.round((Date.now() - this._dormantPollStartTime) / 1000) : 0
      console.log(`[Store] 🌙 舒适模式轮询已停止 (共运行 ${totalElapsed}s, ${this._dormantPollCount} 次扫描)`)
    },

    /**
     * 执行一次轮询扫描（5 秒 short scan，发现设备立即连接）
     * @param {number} guard 会话锁
     */
    async _doDormantScan(guard) {
      if (this._dormantPollGuard !== guard) return
      if (this.connected) return
      if (this.btState === 'off') return

      console.log('[Store] 🌙 舒适模式扫描 (5s)...')

      try {
        const targetId = this.deviceId

        // ★ 使用 startScan 直接扫描（内部已配置 service UUID 硬件过滤）
        await startScan(
          (device) => {
            // ★ 会话检查：已连或锁过期则忽略
            if (this._dormantPollGuard !== guard || this.connected) return

            // 匹配目标设备
            if (device.deviceId === targetId) {
              console.log('[Store] 🌙 舒适模式发现设备:', device.name, 'RSSI:', device.RSSI)
              // ★ 标记发现 → 停止当前扫描后期会连接
              this._dormantFound = true
              this._dormantFoundDevice = device
            }
          },
          5 // 5 秒超时
        )

        // ★ 扫描结束后检查是否发现了目标设备
        if (this._dormantPollGuard !== guard || this.connected) return

        if (this._dormantFound && this._dormantFoundDevice) {
          this._dormantFound = false
          this._dormantFoundDevice = null

          // ★ 发现设备 → 停止轮询，启动正常重连流程
          console.log('[Store] 🌙 舒适模式发现设备，切换到自动重连')
          this._stopDormantPoll()
          this.reconnectMode = 'idle'
          this.reconnectAttempt = 0
          this._startReconnect()
        }
      } catch (e) {
        // 扫描失败（蓝牙关闭等）静默处理，不影响轮询继续
        console.log('[Store] 🌙 舒适模式扫描失败:', e?.message || e)
      }
    },

    // ==================== ★ v1.0.1: 舒适模式亮屏触发（替代定时轮询） ====================

    _registerScreenOnListener() {
      if (this._screenOnReceiverActive) return
      const ok = registerScreenOnReceiver((action) => {
        if (this._screenOnDebounce) { clearTimeout(this._screenOnDebounce) }
        this._screenOnDebounce = setTimeout(() => {
          this._screenOnDebounce = null
          this._onScreenOn(action)
        }, 2000)
      })
      if (ok) {
        this._screenOnReceiverActive = true
        console.log('[Store] \ud83d\udcf1 \u4eae\u5c4f\u76d1\u542c\u5668\u5df2\u6ce8\u518c\uff08\u8212\u9002\u6a21\u5f0f\uff09')
      } else {
        console.warn('[Store] \ud83d\udcf1 \u4eae\u5c4f\u76d1\u542c\u5668\u6ce8\u518c\u5931\u8d25\uff0c\u8212\u9002\u6a21\u5f0f\u53ef\u80fd\u5931\u6548')
      }
    },

    _unregisterScreenOnListener() {
      if (!this._screenOnReceiverActive) return
      unregisterScreenOnReceiver()
      this._screenOnReceiverActive = false
      if (this._screenOnDebounce) { clearTimeout(this._screenOnDebounce); this._screenOnDebounce = null }
      console.log('[Store] \ud83d\udcf1 \u4eae\u5c4f\u76d1\u542c\u5668\u5df2\u6ce8\u9500')
    },

    /**
     * ★ 自动重连统一闸门（② 用户主动断开不自动连；① 绑定门槛预留）
     *   所有自动触发点（onShow / 亮屏 / 围栏）都应先过此闸门。
     *   注意：不含 "reconnectMode==='idle'" —— 那是 onShow 避免重入的额外约束。
     *   @returns {boolean}
     */
    _shouldAutoReconnect() {
      if (this.connected) return false
      if (this.reconnectMode === 'dormant') return false   // 用户主动断开
      if (this.autoReconnectMode === 'manual') return false // ★ v3.24: 手动模式永不自动连接
      if (this.btState === 'off') return false
      // ① 绑定门槛预留：if (!this.isBound) return false
      return true
    },

    _onScreenOn(action) {
      if (this.autoReconnectMode !== 'comfort') return
      if (!this._shouldAutoReconnect()) return
      const now = Date.now()
      if (now - this._lastScreenOnTrigger < 30000) {
        console.log('[Store] \ud83d\udcf1 \u4eae\u5c4f\u89e6\u53d1\uff1a30s \u5185\u5df2\u626b\u63cf\u8fc7\uff0c\u8df3\u8fc7')
        return
      }
      if (!this.deviceId && this.lastDeviceId) { this.deviceId = this.lastDeviceId }
      if (!this.deviceId) {
        console.log('[Store] \ud83d\udcf1 \u4eae\u5c4f\u89e6\u53d1\uff1a\u65e0\u53ef\u91cd\u8fde\u8bbe\u5907\uff0c\u8df3\u8fc7')
        return
      }
      this._lastScreenOnTrigger = now
      const label = action === 'android.intent.action.USER_PRESENT' ? '\u5df2\u89e3\u9501' : '\u5c4f\u5e55\u4eae\u8d77'
      console.log(`[Store] \ud83d\udcf1 \u4eae\u5c4f\u89e6\u53d1\uff08${label}\uff09\u2192 \u542f\u52a8\u626b\u63cf`)
      this._doScreenOnScan()
    },

    async _doScreenOnScan() {
      this._screenOnScanGuard++
      const guard = this._screenOnScanGuard
      if (this.connected || this.btState === 'off') return
      const targetId = this.deviceId
      if (!targetId) return
      console.log(`[Store] \ud83d\udcf1 \u4eae\u5c4f\u626b\u63cf\u542f\u52a8 (8s, guard=${guard})`)

      let phase2Attempts = 0
      const doScanWithConnect = async () => {
        if (this._screenOnScanGuard !== guard || this.connected) return
        let connectRetries = 0
        let connecting = false

        const onDeviceFound = (device) => {
          if (this._screenOnScanGuard !== guard || this.connected || connecting) return
          if (device.deviceId === targetId) {
            console.log(`[Store] \ud83d\udcf1 \u4eae\u5c4f\u626b\u63cf\u53d1\u73b0: ${device.name}, RSSI: ${device.RSSI}`)
            connecting = true
            this._connectWithResetFallback(targetId).then(() => {
              if (this._screenOnScanGuard !== guard || this.connected) return
              console.log('[Store] \ud83d\udcf1 \u4eae\u5c4f\u8fde\u63a5\u6210\u529f\uff0c\u521d\u59cb\u5316...')
              this.connected = true
              this.lastDeviceId = targetId
              if (!this.deviceName) {
                const macClean = targetId.replace(/:/g, '')
                this.deviceName = 'KeyGo-' + macClean.slice(-6).toUpperCase()
              }
              stopScan().catch(() => {})
              this.scanning = false
              this.reconnectMode = 'idle'
              this.reconnectAttempt = 0
              this.reconnectNextDelay = 0
              this._stopDormantPoll()
              this._unregisterScreenOnListener()
              this._stopGeofenceMonitor()
              this._stopHeartbeat()
              this._ensureForegroundService()
              this._reconnectGuard = 0
              uni.showToast({ title: '\u5df2\u81ea\u52a8\u8fde\u63a5', icon: 'success', duration: 1500 })
              readSerialNumber(targetId, 5000).then(sn => {
                if (this.deviceId !== targetId || !this.connected) return
                this.serialNumber = sn
                this._resolveDeviceName(sn)
                this._loadConfigForDevice(sn)
                this._syncConfigToDevice()
              }).catch(() => {})
              setTimeout(async () => {
                if (this.deviceId !== targetId || !this.connected) return
                try {
                  await notifyBLECharacteristicValueChange(targetId, BLE_CONFIG.serviceUUID, BLE_CONFIG.statusCharUUID, true)
                  notifyBLECharacteristicValueChange(targetId, BATT_SERVICE.serviceUUID, BATT_SERVICE.levelCharUUID, true).catch(() => {})
                  this._fetchBatteryLevel(targetId).catch(() => {})
                } catch (_) {}
              }, 800)
            }).catch((err) => {
              if (this._screenOnScanGuard !== guard || this.connected) return
              connectRetries++
              connecting = false
              console.log(`[Store] \ud83d\udcf1 \u8fde\u63a5\u5931\u8d25 (${connectRetries}/2):`, err?.message || err)
            })
          }
        }

        try { await startScan(onDeviceFound, 8) } catch (e) {
          console.log('[Store] \ud83d\udcf1 \u626b\u63cf\u5f02\u5e38:', e?.message || e)
        }
        if (this._screenOnScanGuard !== guard) return
        this.scanning = false
        if (this.connected) { console.log('[Store] \ud83d\udcf1 \u4eae\u5c4f\u626b\u63cf\u5b8c\u6210\uff1a\u5df2\u8fde\u63a5 \u2705'); return }

        if (phase2Attempts < 3) {
          phase2Attempts++
          console.log(`[Store] \ud83d\udcf1 30s \u540e\u4e8c\u9636\u6bb5\u91cd\u8bd5 (${phase2Attempts}/3)`)
          await new Promise(r => setTimeout(r, 30000))
          if (this._screenOnScanGuard === guard && !this.connected && this.btState !== 'off') {
            await doScanWithConnect()
          }
        } else {
          console.log('[Store] \ud83d\udcf1 3 \u6b21\u91cd\u8bd5\u5747\u5931\u8d25\uff0c\u7b49\u4e0b\u6b21\u4eae\u5c4f')
        }
      }
      doScanWithConnect()
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
            // ★ v3.23: 10 次失败后根据模式分支
            this.reconnectAttempt = 0
            this.reconnectNextDelay = 0
            if (this.autoReconnectMode === 'comfort') {
              // ★ v1.0.1: 舒适模式 → 注册亮屏监听器（零后台功耗）
              this.reconnectMode = 'idle'
              console.log('[Store] 重连失败达 10 次，注册亮屏监听器（零后台功耗）')
              this._registerScreenOnListener()
            } else {
              // ★ v3.24: 手动模式（及非舒适模式）→ 彻底放弃自动重连
              this.reconnectMode = 'idle'
              console.log('[Store] 重连失败，已达最大尝试次数（手动模式，放弃重连）')
            }
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
      // ★ v3.23: 重连成功 → 停止舒适模式轮询 + 极速模式 GPS 围栏 + 心跳 + 亮屏监听器
      this._stopDormantPoll()
      this._unregisterScreenOnListener()
      this._stopGeofenceMonitor()
      this._stopHeartbeat()
      // ★ v3.17: 连接成功后启动前台服务（Android 保活）
      this._ensureForegroundService()
      this._reconnectGuard = 0   /* ★ v3.16-P1: 连接成功，所有旧重连会话已失效，归零重置
                                  *   之前的 _reconnectGuard 值（如 5, 42, 28347...）
                                  *   在日志中会让人误以为是 bug，其实它们已经没用了，
                                  *   归零后视觉干净，下次断连从 1 开始递增 */

      // ★ v3.11-fix4: 重连成功后恢复本地设备名称
      //   不能依赖内存中的 serialNumber（disconnect 会清空），必须主动读取
      readSerialNumber(this.deviceId, 5000).then(sn => {
        this.serialNumber = sn
        this._resolveDeviceName(sn)
        // ★ v3.12: 重连成功后加载设备专属配置 + 下发到固件（per-phone 个性化）
        this._loadConfigForDevice(sn)
        this._syncConfigToDevice()
      }).catch(err => {
        console.log('[Store] 重连后读取序列号失败（名称/配置恢复跳过）:', err?.message || err)
      })

      // 恢复 Notify
      await new Promise(r => setTimeout(r, 800))
      await notifyBLECharacteristicValueChange(
        this.deviceId,
        BLE_CONFIG.serviceUUID,
        BLE_CONFIG.statusCharUUID,
        true
      )
      // ★ v3.14: 启用电池电量 Notify + 非阻塞读取初始电量
      notifyBLECharacteristicValueChange(
        this.deviceId, BATT_SERVICE.serviceUUID, BATT_SERVICE.levelCharUUID, true
      ).catch(() => {})
      this._fetchBatteryLevel(this.deviceId).catch(() => {})
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
     *   ★ v3.15: key 策略对齐 _restoreConfig —— 两级回退
     *     1. serialNumber 就绪 → ble_config_v1_{SN}  （设备专属，支持多设备）
     *     2. serialNumber 为空 → ble_config_v1        （旧版通用 key 兜底）
     *     原因：部分固件未升级 v3.3，FF04 不支持 GATT Read，
     *           若 _persistConfig 因无 SN 而跳过 → 配置永久丢失（无恢复路径）
     *     _restoreConfig 已内置迁移逻辑：下次 SN 就绪时会从 ble_config_v1 迁移到专属 key
     */
    _persistConfig() {
      try {
        const config = {
          unlockThreshold: this.unlockThreshold,
          lockThreshold: this.lockThreshold,
          unlockCountRequired: this.unlockCountRequired,
          lockCountRequired: this.lockCountRequired,
          rssiReadPeriodMs: this.rssiReadPeriodMs,
          disconnectLockDelayMs: this.disconnectLockDelayMs,
          kalmanR: this.kalmanR,
          // ★ v3.12: cooldown_ms 不在这里持久化（设备级参数，由固件 DataFlash 管理）
        }
        /* ★ v3.15: 优先 SN 专属 key，无 SN 时回退通用 key
         *   - 有 SN: ble_config_v1_{SN}，每个设备独立配置（per-phone 个性化）
         *   - 无 SN: ble_config_v1，兼容未升级 v3.3 的固件（多设备会共享，属降级行为） */
        const key = this.serialNumber
          ? 'ble_config_v1_' + this.serialNumber
          : 'ble_config_v1'
        this._configDirty = false
        uni.setStorageSync(key, config)
        console.log('[Store] 配置已持久化 (' + (this.serialNumber ? key.slice(-12) : '全局KEY') + '): unlock=' + this.unlockThreshold + ' lock=' + this.lockThreshold)
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
          // ★ v3.24: 手动模式下发 autolock=0 禁用固件 RSSI 自动锁；其余模式 autolock=1 启用
          autolock: this.autoReconnectMode === 'manual' ? 0 : 1,
          // ★ v3.12: cooldown_ms 不下发 — 设备级参数，由固件 DataFlash 管理
        })
        console.log('[Store] 配置已下发到设备 (unlock=' + this.unlockThreshold + ' lock=' + this.lockThreshold + ' uc=' + this.unlockCountRequired + ' lc=' + this.lockCountRequired + ' interval=' + this.rssiReadPeriodMs + ' kr=' + this.kalmanR + ' autolock=' + (this.autoReconnectMode === 'manual' ? 0 : 1) + ')')
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
        /* ★ v3.15-#20: 销毁旧监听器后重新注册（防止跨连接残留）
         *   _destroyGlobalListeners() 会设 _listenersInited=false，
         *   随后 _ensureGlobalListeners() 重新绑定 → 每次 connect() 都是干净状态 */
        this._destroyGlobalListeners()
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
        // ★ v3.23: 连接成功 → 停止舒适模式轮询 + 极速模式 GPS 围栏 + 心跳 + 亮屏监听器
        this._stopDormantPoll()
        this._unregisterScreenOnListener()
        this._stopGeofenceMonitor()
        this._stopHeartbeat()
        // ★ v3.17: 连接成功后启动前台服务（Android 保活）
        this._ensureForegroundService()

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

        await new Promise(r => setTimeout(r, 1000))

        /* ★ v3.15-fix6: 1s GATT 就绪等待期间，用户可能断开连接
         *   此时 this.connected 已为 false/deviceId 已清空，继续操作会抛异常
         *   → 提前退出，避免在已断开的设备上调用 BLE API */
        if (!this.connected || this.deviceId !== deviceId) {
          console.log('[Store] 连接等待期间已断开，跳过 GATT 初始化')
          return false
        }

        // ★ 启用 Status 特征值的 Notify（每次连接时需重新启用）
        await notifyBLECharacteristicValueChange(
          deviceId,
          BLE_CONFIG.serviceUUID,
          BLE_CONFIG.statusCharUUID,
          true
        )

        // ★ v3.14: 启用电池电量 Notify + 非阻塞读取初始电量
        notifyBLECharacteristicValueChange(
          deviceId, BATT_SERVICE.serviceUUID, BATT_SERVICE.levelCharUUID, true
        ).catch(() => {})
        this._fetchBatteryLevel(deviceId).catch(() => {})

        // ★ v3.3: 后台非阻塞读取设备序列号（不阻塞连接流程）
        readSerialNumber(deviceId, 5000).then(sn => {
          this.serialNumber = sn
          console.log('[Store] 设备序列号（FF04）:', sn)
          // 验证：与广播包指纹比对
          if (this.fingerprint && sn.slice(-6).toUpperCase() !== this.fingerprint.toUpperCase()) {
            console.warn('[Store] ⚠ 序列号指纹不匹配！广播:', this.fingerprint, '序列号:', sn.slice(-6))
          }
          // ★ v3.8: SN 就绪 → 从本地恢复设备自定义名称
          this._resolveDeviceName(sn)
          // ★ v3.12: SN 就绪 → 加载设备专属配置 + 下发到固件（per-phone 个性化）
          this._loadConfigForDevice(sn)
          this._syncConfigToDevice()
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

        // ★ v3.13: 手机端 RSSI 转发已移除，固件 GAP 读取为主通道
        //   RSSI 显示数据来自固件 FF02 Notify (r/f 字段)

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
      // ★ v3.15-#19: 清理 Status 看门狗（用户主动断开，无需标记过期）
      if (this._statusStaleTimer) {
        clearTimeout(this._statusStaleTimer)
        this._statusStaleTimer = null
      }
      this.statusStale = false

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
      // ★ v3.17: 用户主动断开 → 停止前台服务
      this._stopForegroundService()
      this.connected = false
      this.deviceId = ''
      this.deviceName = ''
      this.scanning = false
      this.customDeviceName = ''
      this.serialNumber = ''              // ★ v3.3
      this.fingerprint = ''               // ★ v3.3
      this._configDirty = false           // ★ v3.15: 重置脏标记（新连接重新初始化）
      this.deviceState = 'LOCKED'
      this.rssi = -999
      this.filteredRssi = -999
      this._coolingDown = true
      this.manualCooldown = false
      if (this._cooldownTimer) { clearTimeout(this._cooldownTimer); this._cooldownTimer = null }
      setTimeout(() => { this._coolingDown = false }, 500)

      // ★ v1.0.1: 舒适模式 → 注册亮屏监听器（零后台功耗）
      if (this.autoReconnectMode === 'comfort') {
        this.lastDeviceId = targetId
        setTimeout(() => {
          this._registerScreenOnListener()
        }, 2000) // 2s 延迟，给系统清理旧连接的时间
      }

      return true
    },

    /**
     * ★ 冷启动修复：仅打开蓝牙适配器（申请权限前），用于 onShow 状态校正
     *
     * 冷启动时本会话尚未 openBluetoothAdapter，getBluetoothAdapterState 会返回
     * not-init → available=false，被 _forceRefreshBluetoothState / _checkBluetoothState
     * 误判成「蓝牙关闭」→ 误亮红 banner。这里只调 openBluetoothAdapter（不申请运行时权限，
     * 避免新用户一打开就弹权限框），打开后查询即返回真实 available。BT 已开则无弹窗/无提示；
     * BT 关则 openBluetoothAdapter 失败（不弹系统框），真实状态即 available=false → 正确红 banner。
     *
     * ★ 无论打开成功与否都标记 _adapterReady=true：后续查询返回真实状态而非 not-init，
     *   既避免重复弹窗，也保证误判不再发生。
     *
     * @returns {Promise<boolean>} true=当前蓝牙可用
     */
    async ensureAdapterReady() {
      if (this._adapterReady) return this.btState === 'on'
      try {
        await openBluetoothAdapterOnly()
      } catch (e) {
        console.warn('[Store] ensureAdapterReady: 打开适配器异常:', e?.message || e)
      }
      // ★ 标记本会话已触碰适配器：后续 getBluetoothAdapterState 返回真实状态（而非 not-init）
      this._adapterReady = true
      await this._reconcileBtState()
      return this.btState === 'on'
    },

    /**
     * ★ 冷启动/切回自动连准备：确保蓝牙子系统就绪
     *
     * 问题背景：手动清理 App 再打开（冷启动）时，全局监听器（原生广播/Uni 适配器监听）
     * 尚未注册，且本会话从未 openBluetoothAdapter，导致 onShow 里 getBluetoothAdapterState
     * 偶发返回 available=false → 提前 return，永不自动连（见 _forceRefreshBluetoothState）。
     *
     * 本方法：仅当存在已知设备（缓存 ble_device_id）时，注册全局监听器并打开蓝牙适配器
     * （含运行时权限申请）。打开成功后 getBluetoothAdapterState 才能可靠返回 true，
     * 后续 onShow 的状态判断与 tryAutoConnect 才能正常执行；同时启动前台服务与心跳，
     * 让「App 在后台、屏幕熄灭」时也能被心跳驱动自动连。
     *
     * @returns {Promise<boolean>} true=适配器就绪（蓝牙可扫描/连接）
     */
    async prepareForAutoConnect() {
      const knownId = this.deviceId || uni.getStorageSync('ble_device_id')
      if (!knownId) return false
      // 注册全局监听器：让后续原生广播 STATE_ON 也能驱动自动重连
      this._ensureGlobalListeners()
      // 确保前台服务存活（后台自动连需要，且已在后台时不被系统查杀）
      this._ensureForegroundService()
      try {
        await initBluetooth()   // 打开适配器 + 申请权限（仅 BT 关闭时才弹系统框）
        this._adapterReady = true
        // ★ 冷启动修复：适配器已开，用实时状态校正 btState（BT 已开→'on'，否则回落），
        //   避免 onShow 里 _forceRefreshBluetoothState 读到过期的 "not init" 误判为 off。
        await this._reconcileBtState()
        // 适配器已开 → 启动 AlarmManager 心跳，作为后台自动连的驱动（Doze 下仍能唤醒）
        this._startHeartbeat()
        return true
      } catch (e) {
        // BT 关闭/用户拒绝 → initBluetooth reject；由原生广播/状态判断处理，不强行连
        console.log('[Store] prepareForAutoConnect: 初始化失败（蓝牙未开或拒绝）:', e?.message || e)
        return false
      }
    },

    /**
     * 尝试自动连接（兼容旧版接口）
     * 内部优先直连缓存设备，失败再扫描「已知设备」里信号最强者（方案B）。
     */
    async tryAutoConnect() {
      // ★ v3.6: 蓝牙未开时不尝试，等适配器状态变化事件触发重连
      if (this.btState === 'off') {
        console.log('[Store] tryAutoConnect: 蓝牙未开启，跳过')
        return false
      }
      // ★ 方案B: 统一闸门（用户主动断开/已连接/蓝牙关 → 不自动连）
      if (!this._shouldAutoReconnect()) return false
      this._ensureGlobalListeners()

      // ★ 冷启动修复：本会话尚未 openBluetoothAdapter 时，getBluetoothAdapterState
      //   会 "not init" 误报 false → _doReconnect 抛 "蓝牙未开启"。
      //   这里先确保适配器已打开（权限已授予则不会弹窗；BT 已开则立即成功）。
      //   btState==='off' 已在上一步拦截（不会在此弹系统框）。
      if (!this._adapterReady) {
        try {
          await initBluetooth()
          this._adapterReady = true
          await this._reconcileBtState()
        } catch (e) {
          // BT 关闭/用户拒绝 → 不抛异常，等适配器状态事件恢复后重试
          console.log('[Store] tryAutoConnect: 适配器初始化失败，等待恢复:', e?.message || e)
          return false
        }
      }

      // 优先用缓存直连已知设备（最快，无需扫描）
      const knownId = this.deviceId || uni.getStorageSync('ble_device_id')
      if (knownId) {
        this.deviceId = knownId
        try {
          await this._doReconnect()
          return true
        } catch (e) {
          console.log('[Store] tryAutoConnect: 直连失败，转扫描兜底:', e?.message || e)
        }
      }
      // 直连失败 / 无缓存 → 扫描已知设备，连信号最强者（方案B）
      return await this.autoConnectBest(8)
    },

    /**
     * ★ 方案B: 扫描并自动连接「已知设备里信号最强的那个」
     *
     *   已知设备 = 缓存的 deviceId（过渡期）。后续接入 ① 绑定门槛后，
     *   扩展为受信任序列号列表：仅列表内设备才会被自动连接，避免误连陌生设备。
     *
     *   安全原则：不在已知集合内的设备绝不自动连接。
     *   多设备：集合内有多台时，按 RSSI 取最强者。
     *
     *   @param {number} timeoutSec 扫描时长（秒）
     *   @returns {Promise<boolean>} 是否成功连接
     */
    async autoConnectBest(timeoutSec = 8) {
      if (!this._shouldAutoReconnect()) return false
      if (this.scanning) {
        console.log('[Store] autoConnectBest: 已有扫描在进行，跳过')
        return false
      }
      // ★ 已知集合（过渡期：仅缓存 deviceId；① 接入点：受信任序列号列表）
      const knownId = this.deviceId || uni.getStorageSync('ble_device_id')
      if (!knownId) {
        console.log('[Store] autoConnectBest: 无已知设备，不自动连接（避免误连陌生设备）')
        return false
      }
      const knownSet = new Set([knownId])
      // TODO ①: const trustedSerials = this._trustedSerials; 改为按序列号匹配

      console.log('[Store] autoConnectBest: 扫描 ' + timeoutSec + 's，目标已知设备:', knownId)
      const found = []
      const onDeviceFound = (device) => {
        if (!knownSet.has(device.deviceId)) return
        // 同一设备可能多次上报（allowDuplicatesKey），保留最新 RSSI
        const idx = found.findIndex(d => d.deviceId === device.deviceId)
        if (idx >= 0) found[idx] = device
        else found.push(device)
        console.log('[Store] autoConnectBest 发现已知设备:', device.name, 'RSSI:', device.RSSI)
      }
      try {
        await startScan(onDeviceFound, timeoutSec)
      } catch (e) {
        console.log('[Store] autoConnectBest 扫描异常:', e?.message || e)
      }

      if (this.connected) return true
      if (found.length === 0) {
        console.log('[Store] autoConnectBest: 未发现已知设备')
        return false
      }
      // 按 RSSI 降序，取最强者
      found.sort((a, b) => (b.RSSI ?? -999) - (a.RSSI ?? -999))
      const best = found[0]
      console.log('[Store] autoConnectBest: 选择最强已知设备', best.name, 'RSSI', best.RSSI)
      try {
        await this.connect(best.deviceId, best.name)
        console.log('[Store] autoConnectBest: 已自动连接')
        return true
      } catch (e) {
        console.log('[Store] autoConnectBest: 连接失败', e?.message || e)
        return false
      }
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

      // ★ v3.15-#13: 每次收到有效 Status 后重置看门狗
      this._resetStatusStaleTimer()
    },

    /**
     * ★ v3.15-#13: 重置 Status Notify 看门狗
     *   设备每 ~1s 推送一次 FF02 Notify，超过 3s 未收到 → 标记过期
     */
    _resetStatusStaleTimer() {
      this.statusStale = false
      if (this._statusStaleTimer) {
        clearTimeout(this._statusStaleTimer)
      }
      this._statusStaleTimer = setTimeout(() => {
        // 仅在仍处于"已连接"状态且未明确断开时标记过期
        if (this.connected) {
          console.warn('[Store] Status Notify 超时，设备可能静默断连')
          this.statusStale = true
        }
        this._statusStaleTimer = null
      }, 3000)  // 3s = 3 × 固件 1s 推送周期，留足余量
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

    // ==================== ★ v3.23: 智能重连模式 ====================

    /**
     * 设置智能重连模式
     *
     * @param {'comfort' | 'manual' | 'speed'} mode
     */
    setAutoReconnectMode(mode) {
      if (!['comfort', 'manual', 'speed'].includes(mode)) {
        console.warn('[Store] 无效的重连模式:', mode)
        return
      }
      const prev = this.autoReconnectMode
      this.autoReconnectMode = mode

      // 持久化
      try {
        uni.setStorageSync('ble_auto_reconnect_mode', mode)
      } catch {}

      console.log(`[Store] 智能重连模式: ${prev} → ${mode}`)

      // ★ 模式切换时的行为调整
      if (mode === 'comfort') {
        // 退出 speed 模式 → 清理围栏相关
        if (prev === 'speed') this._onSpeedModeExit()
        // ★ v1.0.1: 亮屏监听器接管，停止旧轮询
        this._stopDormantPoll()
        if (!this.connected) {
          this._registerScreenOnListener()
        }
      } else if (mode === 'manual') {
        // 退出 speed 模式 → 清理围栏相关
        if (prev === 'speed') this._onSpeedModeExit()
        // ★ v3.24: 手动模式 → 停止所有轮询/亮屏监听/前台服务，完全由用户点击控制
        this._stopDormantPoll()
        this._unregisterScreenOnListener()
        this._stopForegroundService()
        if (this._reconnectTimer) {
          clearTimeout(this._reconnectTimer)
          this._reconnectTimer = null
        }
        this.reconnectMode = 'idle'
        this.reconnectAttempt = 0
        this.reconnectNextDelay = 0
      } else if (mode === 'speed') {
        // ★ Phase 3: 切换到极速模式 → 停止后台轮询，记录当前停车位置
        this._onSpeedModeEnter()
      }

      // ★ v3.24: 模式切换影响自动锁 → 已连接时立即重新下发配置（autolock 跟随模式）
      if (this.connected) {
        this._syncConfigToDevice()
      }
    },

    // ==================== ★ v3.23 Phase 3: 极速模式（地理围栏） ====================

    /**
     * 进入极速模式
     *   - 停止所有 BLE 后台轮询
     *   - 获取当前 GPS 位置作为停车点
     *   - 启动前台服务 + 后台 GPS 围栏监控
     */
    _onSpeedModeEnter() {
      this._stopDormantPoll()
      if (this._reconnectTimer) {
        clearTimeout(this._reconnectTimer)
        this._reconnectTimer = null
      }
      this.reconnectMode = 'idle'
      this.reconnectAttempt = 0
      this.reconnectNextDelay = 0
      this._geofenceBleTriggered = false

      // 获取当前位置保存为停车点
      this._saveParkingNow().then((saved) => {
        // ★ 停车位置保存成功后，启动后台 GPS 围栏监控
        if (saved && !this.connected) {
          this._startGeofenceMonitor()
          // ★ v3.23.2: 启动 AlarmManager 心跳（确保 watchPosition 回调不被 Doze 冻结）
          this._startHeartbeat()
        }
      })
    },

    /**
     * 退出极速模式 → 停止围栏监控 + 停止心跳 + 清理前台服务
     */
    _onSpeedModeExit() {
      this._stopGeofenceMonitor()
      this._stopHeartbeat()
      this._geofenceApproachChecked = false
      this._geofenceBleTriggered = false
    },

    /**
     * 获取当前位置并保存为停车点
     * @returns {Promise<boolean>} 是否保存成功
     */
    async _saveParkingNow() {
      console.log('[Store] 🅿️ 正在获取停车位置...')
      const pos = await getCurrentPosition()
      if (!pos) {
        console.warn('[Store] ⚠ 停车位置获取失败（GPS 不可用）')
        uni.showToast({ title: '无法获取位置，请稍后重试', icon: 'none', duration: 2000 })
        return false
      }
      saveParkingLocation(pos.lat, pos.lng)
      console.log(`[Store] 🅿️ 停车位置已记录: ${pos.lat.toFixed(6)}, ${pos.lng.toFixed(6)}`)
      uni.showToast({ title: '停车位置已记录 ✅', icon: 'success', duration: 1500 })
      return true
    },

    /**
     * 手动更新停车位置（用户从配置页触发）
     * @returns {Promise<boolean>}
     */
    async saveCurrentParkingLocation() {
      if (this.autoReconnectMode !== 'speed') return false
      return await this._saveParkingNow()
    },

    /**
     * ★ v3.23.1: 启动后台 GPS 围栏监控
     *
     * 前置条件：
     *   - autoReconnectMode === 'speed'
     *   - 有停车位置记录
     *   - 未连接
     *
     * 进入围栏 → _onGeofenceEnter() → 启动 BLE 扫描
     * 离开围栏 → _onGeofenceLeave() → 停止 BLE 扫描
     */
    _startGeofenceMonitor() {
      if (this.autoReconnectMode !== 'speed') return
      if (this.connected) return
      if (isGeofenceMonitorActive()) {
        console.log('[Store] ⚡ 围栏监控已在运行，跳过')
        return
      }

      const parking = getParkingLocation()
      if (!parking) {
        console.log('[Store] ⚡ 无停车位置，跳过围栏监控')
        return
      }

      // 重置触发标记（新一轮监控）
      this._geofenceBleTriggered = false

      // ★ 确保前台服务存活（后台 GPS 监控需要）
      this._ensureForegroundService()

      const started = startGeofenceMonitor(
        // onEnter: 进入围栏
        (distance) => { this._onGeofenceEnter(distance) },
        // onLeave: 离开围栏
        (distance) => { this._onGeofenceLeave(distance) }
      )

      if (started) {
        console.log('[Store] ⚡ 围栏监控已启动 → 零 BLE 功耗，GPS 后台静默监听')
      } else {
        console.warn('[Store] ⚡ 围栏监控启动失败')
      }
    },

    /**
     * ★ v3.23.1: 停止后台 GPS 围栏监控
     */
    _stopGeofenceMonitor() {
      stopGeofenceMonitor()
      this._geofenceBleTriggered = false
    },

    // ==================== ★ v3.23.2: AlarmManager 心跳（防 Doze） ====================

    /**
     * 启动 AlarmManager 心跳
     *
     * 每次心跳触发时，根据当前模式执行对应操作：
     *   舒适模式 → 确认 setInterval 存活，如果轮询长时间未触发则补一次 BLE 扫描
     *   极速模式 → 仅确认 JS 线程存活（watchPosition 回调需要 JS 上下文）
     *
     * 幂等：已在运行中则跳过
     */
    _startHeartbeat() {
      if (this._heartbeatActive) return
      this._heartbeatActive = true
      this._lastHeartbeatTime = Date.now()

      const ok = startHeartbeatAlarm(() => {
        this._onHeartbeatTick()
      })

      if (ok) {
        console.log('[Store] ⏰ AlarmManager 心跳已启动 (60s 间隔)')
      } else {
        console.warn('[Store] ⏰ AlarmManager 心跳启动失败，后台重连可能受 Doze 影响')
        this._heartbeatActive = false
      }
    },

    /**
     * 停止 AlarmManager 心跳
     */
    _stopHeartbeat() {
      if (!this._heartbeatActive) return
      this._heartbeatActive = false
      stopHeartbeatAlarm()
      console.log('[Store] ⏰ AlarmManager 心跳已停止')
    },

    /**
     * ★ 心跳回调：每次 AlarmManager 唤醒时执行
     *
     * 由系统 AlarmManager 广播触发，即使在 Doze 深睡模式下也能准时抵达。
     * 此回调意味着 JS 线程已被唤醒，可以做一次轻量检查。
     */
    _onHeartbeatTick() {
      const now = Date.now()
      const sinceLast = this._lastHeartbeatTime ? now - this._lastHeartbeatTime : -1
      this._lastHeartbeatTime = now

      console.log(`[Store] ⏰ 心跳 #${this._dormantPollCount || '?'} | 距上次 ${sinceLast > 0 ? Math.round(sinceLast/1000) + 's' : '?'} | 模式=${this.autoReconnectMode} | 已连=${this.connected}`)

      // 已连接 → 不需要任何操作
      if (this.connected) {
        this._stopHeartbeat()
        return
      }

      if (this.autoReconnectMode === 'comfort') {
        // ★ 后台自动连（屏幕熄灭 / App 在后台）：每次心跳尝试连已知设备。
        //   AlarmManager 心跳在 Doze 深睡下仍能唤醒，配合前台服务即可实现真正的后台自动连。
        //   tryAutoConnect 内部先直连缓存设备（快、不扫描），失败才扫描已知设备集合。
        if (!this.connected && this._shouldAutoReconnect()) {
          const knownId = this.deviceId || uni.getStorageSync('ble_device_id')
          if (knownId) {
            console.log(`[Store] ⏰ 心跳触发后台自动连（${this.autoReconnectMode}）`)
            this.tryAutoConnect()
          }
        }
        // ★ 舒适模式兜底：setInterval 漂移过大（>3min 没扫）再补一次扫描
        if (this.autoReconnectMode === 'comfort' && !this.connected) {
          const lastScanTime = this._dormantPollStartTime
            ? this._dormantPollStartTime + (this._dormantPollCount * 120000)
            : 0
          const scanDrift = now - lastScanTime
          if (scanDrift > 180000) { // 3 分钟
            console.log(`[Store] ⏰ 心跳检测到扫描漂移 ${Math.round(scanDrift/1000)}s → 补一次 BLE 扫描`)
            this._doDormantScan(this._dormantPollGuard)
          }
        }
      } else if (this.autoReconnectMode === 'speed') {
        // ★ v3.24: 极速模式心跳 → 主动围栏检测 + 自动 BLE 扫描
        //   watchPosition 回调可能被 Doze 抑制，心跳是兜底保障。
        //   每次唤醒时主动读取 GPS，若在围栏内则立刻启动 BLE 扫描。
        this._heartbeatGeofenceCheck()
      }
    },

    /**
     * ★ v3.24: 心跳触发的主动围栏检测（极速模式）
     *
     * watchPosition 回调在 Doze 深度休眠期间可能被抑制，无法实时响应位置变化。
     * 此方法借用心跳唤醒窗口主动读取 GPS，补上 watchPosition 的空白期。
     *
     * 与 checkGeofenceApproach 的区别：
     *   - checkGeofenceApproach: onShow 触发，有 _geofenceApproachChecked 单次锁
     *   - _heartbeatGeofenceCheck: 心跳触发，不设单次锁（每次唤醒都是新机会）
     *
     * 无重复扫描风险：_geofenceBleTriggered 全局防重复（watchPosition 和心跳共用）
     */
    async _heartbeatGeofenceCheck() {
      if (this.connected) return           // 已连接，无需检测
      if (this._geofenceBleTriggered) return  // BLE 已触发（可能由 watchPosition 触发）
      if (!isGeofenceMonitorActive || !isGeofenceMonitorActive()) return  // 围栏未运行

      const parking = getParkingLocation()
      if (!parking) return

      // 使用粗精度 GPS（快速，低功耗），在 Doze 维护窗口中争取快速返回
      const pos = await getCurrentPositionCoarse()
      if (!pos) {
        console.log('[Store] ⏰ 心跳围栏检测：GPS 不可用（可能室内/地下），下次心跳重试')
        return
      }

      const distance = calculateDistance(pos.lat, pos.lng, parking.lat, parking.lng)
      console.log(`[Store] ⏰ 心跳围栏检测：距停车点 ${distance}m (半径 ${GEOFENCE_RADIUS}m)`)

      if (distance <= GEOFENCE_RADIUS) {
        console.log('[Store] ⏰ 心跳检测到进入围栏！启动 BLE 扫描...')
        this._geofenceBleTriggered = true
        this.reconnectMode = 'idle'
        this.reconnectAttempt = 0
        this._startReconnect()
      }
    },

    /**
     * ★ v3.23.1: 围栏进入回调 → 启动 BLE 扫描
     *
     * 由 geofence.js 的 watchPosition 回调触发（可能在后台线程）。
     * 防重复：每轮监控期间最多触发一次 BLE 重连。
     */
    _onGeofenceEnter(distance) {
      if (this._geofenceBleTriggered) {
        console.log(`[Store] ⚡ 围栏进入（${distance}m），但 BLE 已触发过，跳过`)
        return
      }
      if (this.connected) {
        console.log('[Store] ⚡ 围栏进入，但已连接，跳过')
        return
      }

      this._geofenceBleTriggered = true
      console.log(`[Store] ⚡ 🚀 围栏进入（${distance}m）→ 启动 BLE 扫描`)

      // 重置重连状态，立即启动激进扫描
      this.reconnectMode = 'idle'
      this.reconnectAttempt = 0
      this.reconnectNextDelay = 0
      this._startReconnect()
    },

    /**
     * ★ v3.23.1: 围栏离开回调 → 停止 BLE 扫描
     *
     * 用户已远离车辆，BLE 扫描不再有意义。
     * 但保留 GPS 监控继续运行（等待下次进入）。
     */
    _onGeofenceLeave(distance) {
      if (this.connected) {
        // 已连接成功，停止 GPS 监控 + 心跳
        console.log('[Store] ⚡ 已连接，停止围栏监控 + 心跳')
        this._stopGeofenceMonitor()
        this._stopHeartbeat()
        return
      }

      this._geofenceBleTriggered = false
      console.log(`[Store] ⚡ 离开围栏（${distance}m），停止 BLE 扫描，保留 GPS 监听`)

      // 停止 BLE 扫描/重连
      this._stopDormantPoll()
      if (this._reconnectTimer) {
        clearTimeout(this._reconnectTimer)
        this._reconnectTimer = null
      }
      this.reconnectMode = 'idle'
      this.reconnectAttempt = 0
      this.reconnectNextDelay = 0
    },

    /**
     * 检测是否接近停车位置，若在围栏内则触发 BLE 扫描
     *
     * 由 index.vue 的 onShow 调用（仅 speed 模式）。
     * 每次 onShow 最多触发一次，防止重复扫描。
     *
     * ★ v3.23.1: 这是后台 GPS 监控的兜底机制。
     *   如果后台 GPS 被系统暂停，用户打开 App 时仍会检测。
     *   如果后台 GPS 正常运行，_geofenceBleTriggered 已为 true，不会重复触发。
     *
     * @returns {Promise<boolean>} true=已触发扫描，false=不需要或已处理
     */
    async checkGeofenceApproach() {
      if (this.autoReconnectMode !== 'speed') return false
      if (!this._shouldAutoReconnect()) return false
      if (this._geofenceApproachChecked) return false  // 本次已检测过
      this._geofenceApproachChecked = true

      // ★ 如果后台 GPS 围栏已经触发过 BLE，不需要前台再触发
      if (this._geofenceBleTriggered) {
        console.log('[Store] ⚡ 后台围栏已触发 BLE，前台跳过')
        return false
      }

      const parking = getParkingLocation()
      if (!parking) {
        console.log('[Store] ⚡ 极速模式：无停车位置记录，不启动扫描')
        return false
      }

      console.log('[Store] ⚡ 极速模式：获取当前位置进行围栏检测...')
      const pos = await getCurrentPositionCoarse()
      if (!pos) {
        console.warn('[Store] ⚡ GPS 不可用，跳过围栏检测')
        return false
      }

      const distance = calculateDistance(pos.lat, pos.lng, parking.lat, parking.lng)
      console.log(`[Store] ⚡ 极速模式：距停车点 ${distance}m (半径 ${GEOFENCE_RADIUS}m)`)

      if (distance <= GEOFENCE_RADIUS) {
        // ★ 在围栏内 → 立即启动 BLE 扫描
        console.log('[Store] ⚡ 进入围栏！启动 BLE 扫描...')
        this._geofenceBleTriggered = true
        this.reconnectMode = 'idle'
        this.reconnectAttempt = 0
        this._startReconnect()
        uni.showToast({ title: '已进入停车区域，正在连接...', icon: 'none', duration: 2000 })
        return true
      } else {
        console.log(`[Store] ⚡ 距停车点 ${distance}m，不在围栏内，不扫描`)
        return false
      }
    },

    /**
     * 重置围栏检测标记（app 切后台时调用）
     */
    _resetGeofenceApproachCheck() {
      this._geofenceApproachChecked = false
    },
  }
})
