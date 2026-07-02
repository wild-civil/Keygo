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
    unlockThreshold: -45,
    lockThreshold: -65,
    hystDb: 5,
    unlockCountRequired: 3,
    lockCountRequired: 5,
    disconnectLockDelayMs: 5000,
    manualCooldown: false,        // 手动命令冷却中
    manualCooldownMs: 8000,      // ★ v3.7: 冷却时长 ms（可从设备同步，App本地持久化）


    // 连接历史（自动重连用）
    lastDeviceId: '',

    // ★ v3.5: 持久化恢复标记
    _restored: false,

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
          // ★ v3.7: 恢复冷却时间
          if (saved.manualCooldownMs !== undefined && saved.manualCooldownMs >= 2000 && saved.manualCooldownMs <= 30000) {
            this.manualCooldownMs = saved.manualCooldownMs
          }
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
      this._stopRssiPolling()
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
      this._stopRssiPolling()
      this.connected = false
      this.deviceState = 'LOCKED'
      this.rssi = -999
      this.filteredRssi = -999

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

      // 暂停当前 RSSI 轮询的残留
      this._stopRssiPolling()

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

      // ★ v3.11-fix4: 重连成功后恢复本地设备名称
      //   不能依赖内存中的 serialNumber（disconnect 会清空），必须主动读取
      readSerialNumber(this.deviceId, 5000).then(sn => {
        this.serialNumber = sn
        this._resolveDeviceName(sn)
      }).catch(err => {
        console.log('[Store] 重连后读取序列号失败（名称恢复跳过）:', err?.message || err)
      })

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
          // ★ v3.7: 冷却时间
          manualCooldownMs: this.manualCooldownMs,
        })
      } catch (e) {
        console.warn('[Store] 配置持久化失败:', e)
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
          // ★ v3.8: SN 就绪 → 从本地恢复设备自定义名称
          this._resolveDeviceName(sn)
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
    _rssiDiscovering: false,     // ★ v3.11-fix5: 持续发现状态标记
    _rssiScanTimeout: null,
    _rssiScanListener: null,
    _scanAborted: false,
    _cooldownTimer: null,        // RSSI 手动命令冷却定时器
    _reconnectTimer: null,       // 重连定时器
    _adapterResetting: false,    // ★ v3.11: 适配器重置中标记（用于 _resetBluetoothAdapter）

    _startRssiPolling() {
      this._stopRssiPolling()
      console.log('[Store] 手机端 RSSI 轮询已启动（持续发现模式）')

      this._rssiScanListener = (res) => {
        for (const device of res.devices) {
          if (device.deviceId === this.deviceId) {
            this._onPhoneRssiFound(device.RSSI)
            return
          }
        }
      }
      uni.onBluetoothDeviceFound(this._rssiScanListener)

      // ★ v3.11-fix5: 持续发现模式 — 只启动一次，不再每轮 start/stop
      //   频繁切换 discovering 状态在 Honor Power 等机型上会导致 BLE 断连
      uni.startBluetoothDevicesDiscovery({
        allowDuplicatesKey: true,
        interval: 0,
        success: () => {
          this._rssiDiscovering = true
        },
        fail: (err) => {
          console.warn('[Store] RSSI 扫描启动失败:', err.errMsg)
        }
      })

      // 健康检查：若发现意外停止则重启
      this._rssiTimer = setInterval(() => {
        if (!this.connected || !this.deviceId) {
          this._stopRssiPolling()
          return
        }
        if (!this._rssiDiscovering) {
          uni.startBluetoothDevicesDiscovery({
            allowDuplicatesKey: true,
            interval: 0,
            success: () => { this._rssiDiscovering = true },
            fail: () => {}
          })
        }
      }, 3000)
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
      if (this._rssiDiscovering) {
        this._rssiDiscovering = false
        uni.stopBluetoothDevicesDiscovery({ success: () => {}, fail: () => {} })
      }
      if (this._rssiScanListener) {
        try {
          uni.offBluetoothDeviceFound(this._rssiScanListener)
        } catch {}
        this._rssiScanListener = null
      }
      console.log('[Store] 手机端 RSSI 轮询已停止')
    },

    _doRssiScan() {
      // ★ v3.11-fix5: 已废弃 start/stop 循环，改为 _startRssiPolling 中的持续发现
    },

    async _onPhoneRssiFound(rssiValue) {
      if (!this.connected || !this.deviceId) return
      this.rssi = rssiValue
      this.filteredRssi = rssiValue
      // ★ v3.6-fixH: manualCooldown 阻止手机转发 RSSI 到设备（备用通道）
      //   设备主 RSSI 通道是原生 BLE GAP 读取 (GAPRole_ReadRssiCmd)，不依赖手机转发。
      //   真正阻止设备自动锁/解锁的是固件端 g_manualCooldown (8s) + 计数器清零。
      //   此处仅为减少不必要的 BLE 写操作。
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

      // ★ v3.8: 自定义名称 — d2 总是接收作为初始显示
      //   SN 到达后由 _resolveDeviceName() 用本地名称覆盖（本地优先）
      //   短暂闪烁可接受（仅 SN 已就绪 + 本地名与 d2 不同时才会发生）
      if (data.d2 !== undefined && data.d2 !== '') this.customDeviceName = data.d2

      // ★ v3.7: 冷却时间 ms (cd = cooldown duration)
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
      if (config.interval !== undefined) {
        this._rssiPollInterval = Math.max(300, config.interval)  // 下限 300ms，避免扫描过热
        // ★ 重新启动 RSSI 轮询以应用新间隔
        if (this.connected && this.deviceId) {
          this._startRssiPolling()
        }
      }
      if (config.dlock !== undefined) this.disconnectLockDelayMs = config.dlock
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
