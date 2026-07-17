/**
 * BLE 连接状态管理 - Pinia Store (v3.11 原生广播版)
 *
 *   - Status JSON 使用短键名 (c, st, r, f, d2)
 *   - 无安全验证，连接即可控
 *   - 命令: NAME:, UNLOCK, LOCK, TRUNK
 *   - ★ v3.11: 原生 BroadcastReceiver 驱动 btState，模仿 nRF Connect
 */

/**
 * ==================== 文件分区索引 (TOC · as of 2026-07-13) ====================
 * 本 store 为单文件 God-Store (约 4121 行)，按职责分为 15 个分区。
 * 维护策略: 保持单 store 不拆分(单人维护 + 重连逻辑改动不频繁)，仅做轻量整理。
 * 重连簇(分区 4/5/6/13/14/15)最纠缠、时序敏感，改动需谨慎、改一处验全局。
 *
 *   1. 持久化配置 ........................ L337
 *   2. 全局监听器 (v3.6 单例) ............ L418
 *   3. 蓝牙适配器检测 (v3.6) ............. L598
 *   4. 断连处理 & 重连 (v3.6) ............ L1017
 *   5. 舒适模式后台轮询 (v3.23) .......... L1278
 *   6. 舒适模式亮屏触发 (v1.0.1) ......... L1424
 *   7. 设备名称本地存储 (v3.8) ........... L2095
 *   8. 扫描 .............................. L2148
 *   9. 连接 .............................. L2212
 *  10. 状态处理 (v3.2 短键名) ............ L2611
 *  11. 命令 (v3.2) ....................... L2829
 *  12. 绑定 / 授权 ....................... L2917
 *  13. 智能重连模式 (v3.23) .............. L3575
 *  14. 极速模式·地理围栏 (v3.23 P3) ...... L3649
 *  15. AlarmManager 心跳·防 Doze (v3.23.2) L3891
 * =============================================================================
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
  sendCommand as rawSendCommand,  // ★ ②: 底层写指令（store 内 sendCommand action 包一层会话鉴权）
} from '@/utils/ble.js'

// ★ ②: 绑定层密码学（与固件 crypto_sha256.c 完全对齐：SHA256/HMAC/派生）
import {
  deriveBindKey,
  derivePhoneKey,   // ★ v3.36(2026-07-17): 授权体系 v1 —— phoneKey = HMAC(gk, phoneId)[0:16]
  hmacSha256Hex,
  hexToBytes,
  bytesToHex,
} from '@/utils/crypto.js'

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

// ★ v3.27-dev: 调试面板日志（仅开发期使用）
import {
  addDebugLog,
  setDebugScreenOn,
  setDebugDeviceFound,
  setDebugReconnectResult,
  setDebugForegroundStatus,
  recordScreenEvent,
} from '@/utils/debug-panel.js'

// ★ v3.33.2 (2026-07-14): App 版本号，与固件 KEYGO_FW_VERSION = "3.33.2" 保持一致。
//   本版本新增：选项 B 首绑安全加固——首绑必须匹配当前有效码 g_curBindCode，堵住未绑定窗口任意抢绑；
//   自定义码统一走 SETCODE 通道（先 AUTH 证明持有旧码）。
//   继承 v3.33.0/3.33.1：手动模式前台自动连 + fwsec 能力协商 + T4 回推修复 + AUTH 握手互斥锁 +
//   长按恢复出厂 + FF01 长写重组 + 配置下发去重 + 重绑信任态保持 + 恢复出厂绑码核验 + 复位后回首绑。
export const APP_VERSION = 'v3.33.4'
console.log('[KeyGo] App version', APP_VERSION)

// ★ 临时止血（2026-07-09）：配对设备后触发原生前台服务导致进程崩溃。
//   先禁用原生分支，走纯 JS 兜底；定位原生根因后改回 false。
const __DISABLE_NATIVE_FG = false

// ★ v3.23 Phase 3: 地理围栏工具
import {
  GEOFENCE_RADIUS,
  GEOFENCE_BLE_LATCH_MS,
  calculateDistance,
  getCurrentPosition,
  getCurrentPositionCoarse,
  saveParkingLocation,
  getParkingLocation,
  startGeofenceMonitor,
  stopGeofenceMonitor,
  isGeofenceMonitorActive,
  getLastKnownPosition,  // ★ v3.24: watchPosition 缓存坐标（同步，消除竞态）
  getDistanceToParking,  // ★ v3.25: 同步获取缓存距离（UI 初始化用）
} from '@/utils/geofence.js'

// ★ v3.27-fix: 命令写队列 + GATT 冲突检测（提取到 utils/command-queue.js）
import { enqueueWrite, isGattConflict } from '@/utils/command-queue.js'
// ★ 用户可读错误文案集中管理（提取到 utils/readable-errors.js）
import { throwError, ERROR_MSGS } from '@/utils/readable-errors.js'
// ★ ②: 绑定层模块级状态（提取到 stores/ble-binding.js，通过 B 命名空间对象访问）
import { B, _waitFor, _resolveWaiter, _acquireBindLock, _acquireAuthLock, _waitBind } from './ble-binding.js'

export const useBleStore = defineStore('ble', {
  state: () => ({
    // 连接状态
    connected: false,
    _statusNotifyReady: false,       // ★ 2026-07-12: FF02/Battery Notify 是否已成功订阅（自动 AUTH 的前置条件）
    deviceId: '',
    deviceName: '',

    customDeviceName: '',         // 设备自定义名称
    serialNumber: '',             // ★ v3.3: 设备序列号（永久唯一，FF04 读取）
    fwVersion: '',                 // ★ 2026-07-10: 固件版本号（FF02 status 的 v 字段），用于确认设备烧录的是哪版固件
    fwSec: -1,                     // ★ v3.33: 安全协议能力版本（FF02 status 的 fwsec 字段）。-1=未连接/未收状态；0=旧固件(无此字段,裸协议)；1=当前基线(BIND/AUTH/C1/单码)；2+=授权体系。后续破坏性协议升级据此分流走旧/新路径
    fingerprint: '',              // ★ v3.3: 扫描阶段指纹（MAC 后缀，来自广播包）

    // ★ ②: 绑定/授权状态（UI 展示用）
    isBound: false,               // 本机是否已持有该设备的 bindKey（本地持久化）
    deviceBound: false,           // ★ 设备端是否已有 owner（由 status.bn 回灌，设备权威；与本地是否存 key 无关）
    sessionAuthed: false,         // 当前连接是否已通过 AUTH challenge-response
    needsRebind: false,           // ★ 设备已复位/被解绑：本机密钥失效，需弹首绑界面重新绑定
    _autoAuthState: 'idle',       // ★ 2026-07-12: 自动 AUTH 状态机 idle/running/failed（驱动 UI 文案，区分"验证中"与"需手动"）
    bindHint: '',                 // 绑定相关提示文案（如「需要验证，请重试」）

    // 扫描状态
    scanning: false,
    devices: [],

    // 设备状态（从 FF02 Notify 接收）
    deviceState: 'LOCKED',        // LOCKED / UNLOCKED / ACTION
    deviceMode: 'car',            // ★ Phase 2: 设备模式 'car' / 'ebike'（权威来自设备状态 m，本地缓存兜底）
    rssi: -999,
    filteredRssi: -999,
    displayRssi: -999,            // ★ v3.31.0 / 2026-07-13: 平滑+节流后的显示用 RSSI（UI 绑定此值，杜绝后台噪值狂跳）
    rssiEma: -999,                // ★ 内部：displayRssi 的 EMA 累加器（仅 >-900 时视为有效）
    batteryLevel: -1,             // ★ v3.14: 电池电量 0~100, -1=未知
    autoLockEnabled: -1,          // ★ v3.24-fixb: 固件自动锁使能状态(FF02 al 字段)，-1=未知/未同步，0=关闭(手动模式)，1=开启
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

    // ★ v3.31 方案B: 设备真实确认参数与实时进度（FF02 新增字段 uc/lc/ucnt/lcnt/th 同步）
    deviceUc: -1,                 // 设备真实解锁确认次数（回显验证 App 下发的 uc 是否真落到设备；-1=未同步）
    deviceLc: -1,                 // 设备真实锁车确认次数
    // ★ v3.36(2026-07-17): 设备当前「生效的」RSSI 阈值（owner 专属阈值 or 全局；FF02 status 的 ou/ol）。
    //   用于验证 per-phone 阈值跟随：不同手机鉴权后 ou/ol 应反映各自 RSSISET 设的值。-999=未同步
    deviceOu: -999,               // 设备当前生效的解锁 RSSI 阈值
    deviceOl: -999,               // 设备当前生效的锁车 RSSI 阈值
    unlockProgress: 0,            // 当前解锁进度计数（连续几次滤波 RSSI 在解锁区）
    lockProgress: 0,              // 当前锁车进度计数
    thresholdZone: 0,             // 当前区间：0 中性 / 1 解锁区 / 2 锁车区
    showProgressCard: true,       // ★ v3.31 方案B-修正: 连接页是否显示「确认进度」卡片（手机端偏好，不下发设备）

    // ★ 2026-07-15: passkey 系统配对偏好（全局，手机端保存，不入下发配置）
    //   开启=舒适进入/无 App 也能解锁（需自定义基座+原生插件）；关闭(默认)=明文最大兼容
    usePasskey: false,

    // ★ 2026-07-16: 无 App 模式（固件 SMP 加密门控，基座无关）
    //   由固件 g_encRequired 驱动：true=固件在(重)连时主动发 Slave Security Request →
    //   系统弹 passkey 窗(输系统配对码) → OS 级加密重连 → 无需 App 也能解锁。
    //   noAppMode = 用户期望态(开关显示)；_noAppModeDirty = 自上次切换后设备是否已应用。
    //   连接首包以设备 pair 为权威初始化；之后仅当 dirty 且设备未对齐时才重发 ENCRYPT 对账，
    //   避免「配对过程连接抖动导致下发被丢 → 设备仍报 pair=1 → 开关被弹回 ON」的关不掉 Bug。
    noAppMode: false,
    _noAppModeDirty: false,

    // ★ v3.27: 命令节流（防连点并发写同一特征值导致 GATT busy 丢命令）
    _cmdBusy: false,             // 命令发送中（串行化，同一时刻只允许一条）
    _lastCmdAt: 0,               // 上次命令发起时间戳(ms)，用于最小间隔节流
    _configWriteBusy: false,      // 配置写下发在途（串行化，避免并发写特征值）
    _configSyncPending: false,    // ★ v3.33.0: 配置回推待补发标志（在途时收到再次请求则落地后补发，防抢跑丢配置）
    _configPushedThisConn: false, // ★ 2026-07-14: 本连接是否已成功下发过配置（防止连接/SN/Auth 多路径重复下发第二条写→撞 GATT 瞬时态报 10007）
    _modeDebounceTimer: null,     // 模式切换防抖定时器



    // 连接历史（自动重连用）
    lastDeviceId: '',

    // ★ v3.5 / v3.12: 持久化恢复标记
    _restored: false,              // 旧版全局恢复标记（兼容）
    _restoredForSn: '',            // ★ v3.12: 已为哪个 SN 恢复了专属配置（空串=未恢复）

    _usePasskeyRestored: false,   // ★ 2026-07-15: usePasskey 偏好是否已从本地恢复（只恢复一次）

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
    _geofenceBleTriggeredAt: 0,     // ★ v3.25-fix: 触发时间戳，用于带超时的防抖闩锁

    // ★ v3.25: 极速模式实时距离显示
    geofenceDistance: -1,            // 当前到停车点的距离（米），-1=未知/不在极速模式
    geofenceDistanceAge: -1,         // 距离数据距今毫秒数（-1=无数据）
    geofenceAccuracy: -1,            // ★ v3.25.2: GPS 定位精度（米），-1=未知，999=无精度信息
    parkingLocation: null,           // 停车位置 { lat, lng, savedAt }（供 UI 显示）

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
    _bondingInProgress: false,     // ★ 2026-07-16: 配对(_triggerBond)期间断开 GATT 让 OS 配对，抑制 store 自动重连
    _deviceNames: null,            // ★ v3.8: { [SN]: { name, lastSeen } } 设备名称本地缓存，null=未加载
    /* ★ v3.15: 脏标记 — serial 未就绪时用户改了配置，等 serial 到达后自动补持久化
     *   解决：连接后用户改 kalmanR/阈值太快，序列号还没读到就写了，配置丢失 */
    _configDirty: false,
    /* ★ v3.15-#13: Status Notify 看门狗 — 超过 3s 未收到 FF02 推送则标记过期
     *   设备可能静默断开但 App 未感知，UI 可据此提示"连接可能已中断" */
    _statusStaleTimer: null,
    // ★ v3.25-fix: 假断连 RSSI 延迟清零定时器。锁屏/Doze 下 Android 可能冒虚假
    //   onBLEConnectionStateChange(false)，但底层 GATT 实际未断（固件 LED 仍按 RSSI 工作、
    //   WRITE 仍成功）。为免页面误显 "--"，断连时先不立即清零 RSSI，而是延迟 3s 确认真断连：
    //   期间若收到 FF02(c:1) 自愈则取消清零（见 _parseSingleStatus）。
    _disconnectRssiClearTimer: null,
    _connectedAtMs: 0,            // ★ 2026-07-17 诊断埋点：本次连接建立时刻（断连时算会话存活时长，区分「秒断」与「久连后掉」）
    _lastFf02Ms: 0,               // ★ v3.31.0 / 2026-07-13: 最近一次收到含 RSSI 的 FF02 时间戳（连续无包判 stale 用）
    _lastRssiDisplayMs: 0,        // ★ v3.31.0 / 2026-07-13: 最近一次写入 displayRssi 的时间（节流用）
    _rssiStaleWatchdog: null,     // ★ v3.31.0 / 2026-07-13: 连续无 FF02 看门狗定时器
    // ★ v3.25-fix2: GATT 上下文重建中标志，防止看门狗与重连逻辑并发触发多次重建
    _repairing: false,

    // ★ 方案A（2026-07-12）：未绑定连接超时强断标记。收到固件 BIND:TIMEOUT 后置 true，
    //   _handleDisconnect 据此抑制自动重连（含原生扫描），避免被踢后反复重连刷占连接槽。
    _unboundTimeoutKicked: false,

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
      const r = state.displayRssi > -999 ? state.displayRssi
        : (state.filteredRssi > -999 ? state.filteredRssi : state.rssi)
      if (r === -999 || r === undefined) return '无信号'
      if (r >= -30) return '极近 (<0.5m)'
      if (r >= -45) return '很近 (~0.5m)'
      if (r >= -55) return '近 (~1m)'
      if (r >= -65) return '中等 (~2m)'
      if (r >= -75) return '远 (~5m)'
      return '很远 (>5m)'
    },

    rssiPercent: (state) => {
      const r = state.displayRssi > -999 ? state.displayRssi
        : (state.filteredRssi > -999 ? state.filteredRssi : state.rssi)
      if (r === -999 || r === undefined) return 0
      const pct = ((r + 100) / 80) * 100
      return Math.max(0, Math.min(100, Math.round(pct)))
    },

    // ★ v3.25: 到停车点的距离文字（极速模式实时显示）
    // ★ v3.25.2: 增加 ±xxm 误差显示，基于 watchPosition 系统报告的 accuracy
    geofenceDistanceText: (state) => {
      if (state.geofenceDistance < 0) return '获取中...'
      
      // 误差后缀（仅当 accuracy 有效且无歧义时显示）
      // accuracy = 1σ ≈ 68.2% 置信区间半径，见 geofence.js watchPosition 的 coords.accuracy 定义
      // ★ DEV-ONLY: 置信度显示，量产前删除`, 1σ` →  若想显示概率，可将其替换为` , 68.2%置信`
      let errSuffix = ''
      const acc = state.geofenceAccuracy
      if (acc > 0 && acc < 999) {
        errSuffix = ` (±${Math.round(acc)}m, 1σ)` // `(±${Math.round(acc)}m)`为精度误差
      }
      
      if (state.geofenceDistance < 10) return `已到达 (<10m)${errSuffix}`
      if (state.geofenceDistance < 1000) return `${state.geofenceDistance}m${errSuffix}`
      return `${(state.geofenceDistance / 1000).toFixed(1)}km${errSuffix}`
    },

    isUnlocked: (state) => state.connected && state.deviceState === 'UNLOCKED',

    // ★ Phase 2: 双模式派生状态
    isEbike: (state) => state.deviceMode === 'ebike',
    deviceModeLabel: (state) => state.deviceMode === 'ebike' ? '电瓶车' : '汽车',

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

      // ★ 2026-07-15: 恢复「passkey 配对」偏好（全局设置，只恢复一次）
      if (!this._usePasskeyRestored) {
        this._usePasskeyRestored = true
        try {
          this.usePasskey = !!uni.getStorageSync('keygo_use_passkey')
        } catch (e) { /* 忽略 */ }
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
          // ★ v3.31 方案B-修正: 连接页进度条开关（手机端偏好）
          if (saved.showProgressCard !== undefined) this.showProgressCard = !!saved.showProgressCard
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
        if (deviceId !== this.deviceId) return
        if (!connected) {
          console.log('[Store] 设备断开连接（全局监听器）')
          this._handleDisconnect()
        } else if (!this.connected) {
          // ★ fix: 连接已建立但 store 状态未同步（如 _doReconnect guard 失效导致跳过回写）。
          //   底层 BLE 连接已活，但 store 未设置 connected=true，notify 未注册，RSSI 不会显示。
          console.log('[Store] 连接已建立（全局监听器补位），同步状态...')
          this._finalizeConnection(deviceId)
        }
      })

      // 特征值数据监听（全局唯一）
      // Notify 分包拼接缓冲区
      this._charHandler = onBLECharacteristicValueChange((res) => {
        if (res.deviceId === this.deviceId &&
            (res.characteristicId || '').toUpperCase() === BLE_CONFIG.statusCharUUID.toUpperCase()) {
          const chunk = arrayBufferToString(res.value)
          this._notifyBuffer += chunk
          // console.log('[Store] 📥 FF02 Notify 收到 (' + chunk.length + 'B): ' + (chunk.length > 80 ? chunk.slice(0, 80) + '…' : chunk)) // 这里开启控制台的FF02 Notify

          // ★ v3.28: 状态显示提速——完整包立即解析，不再无脑等 200ms 分包防抖。
          //   背景：CH582M 固件命令处理后已立即 KeyGo_NotifyStatus() 上报
          //         （见 peripheral.c CHAR3 命令分支），设备是"秒回"的；
          //         但此前 APP 每次收到 Notify 都固定 setTimeout(200) 拼包才刷新 UI，
          //         造成用户感觉"设备快、APP 慢"（最坏 +200ms 延迟）。
          //   原理：状态包是 JSON，完整时必以 '}' 结尾；多包粘连为 "}{...}"，末尾仍是 '}'。
          //         → 缓冲区 trim 后以 '}' 结尾 = 已收全：立即 flush 解析（单包场景 ~0ms 刷新）。
          //         → 否则视为分包未收全：保留 200ms 兜底定时器，等待后续分包拼接。
          //
          //   【备份】v3.27 及之前的原实现（无条件 200ms 防抖）：
          //     if (this._notifyTimer) clearTimeout(this._notifyTimer)
          //     this._notifyTimer = setTimeout(() => {
          //       const fullData = this._notifyBuffer
          //       this._notifyBuffer = ''
          //       this._handleStatusNotify(fullData)
          //     }, 200)
          if (this._notifyTimer) { clearTimeout(this._notifyTimer); this._notifyTimer = null }
          const _buf = this._notifyBuffer.trim()
          // ★ ②: 绑定层短报文（BIND:/NONCE:/AUTH:/UNBIND:/DENY:）不按 JSON 处理
          // ★ 2026-07-10 fix：短报文与状态 JSON 可能在同一次回调里粘连
          //   （如固件处理 BIND 后依次 KeyGo_SendRawNotify("BIND:OK") + KeyGo_NotifyStatus()）。
          //   若整串 "BIND:OK{...json...}" 直接传给 _handleBindingNotify，会因尾部 JSON 不匹配
          //   任何分支而被静默丢弃 → 表现为"BIND 写入成功却收不到 BIND:OK"。
          //   修复：按首字符分流；短报文前缀则先截出 'BIND:OK' 部分，剩余 JSON 单独处理。
          // ★ 2026-07-11 决定性修复：白名单必须含 'SETCODE:'！否则固件回的
          //   SETCODE:OK / SETCODE:FAIL:* 会被当"未知包"→当 JSON 解析失败丢弃→
          //   _handleBindingNotify 永远收不到 SETCODE → 改码 waiter 6s 超时。
          //   这才是"改码一直失败、回包显示陈旧 AUTH:OK/BIND:OK"的真正根因。
          const _SHORT_PREFIX = ['BIND:', 'NONCE:', 'AUTH:', 'UNBIND:', 'DENY:', 'SETCODE:', 'CMD:']
          const _isShort = _SHORT_PREFIX.some(p => _buf.startsWith(p))
          if (_isShort) {
            const _brace = _buf.indexOf('{')
            if (_brace === -1) {
              // 纯短报文
              this._notifyBuffer = ''
              this._handleBindingNotify(_buf)
            } else {
              // 短报文 + 粘连 JSON：拆分分别处理
              const _short = _buf.slice(0, _brace).trim()
              const _json = _buf.slice(_brace)
              this._notifyBuffer = ''
              this._handleBindingNotify(_short)
              console.log('[Store] 🔀 短报文与 JSON 粘连，已分离 (' + _short + ' | ' + _json.length + 'B JSON)')
              if (_json.endsWith('}')) {
                this._handleStatusNotify(_json)
              } else {
                // JSON 未收全，重新进入分包兜底
                this._notifyBuffer = _json
                this._notifyTimer = setTimeout(() => {
                  const fullData = this._notifyBuffer
                  this._notifyBuffer = ''
                  this._handleStatusNotify(fullData)
                }, 200)
              }
            }
          } else if (_buf.startsWith('{')) {
            // 纯 JSON 状态包（可能多包粘连，_handleStatusNotify 自行裁剪）
            if (_buf.endsWith('}')) {
              this._notifyBuffer = ''
              this._handleStatusNotify(_buf)
            } else {
              this._notifyTimer = setTimeout(() => {
                const fullData = this._notifyBuffer
                this._notifyBuffer = ''
                this._handleStatusNotify(fullData)
              }, 200)
            }
          } else {
            // 未知/半包 → 200ms 兜底
            this._notifyTimer = setTimeout(() => {
              const fullData = this._notifyBuffer
              this._notifyBuffer = ''
              this._handleStatusNotify(fullData)
            }, 200)
          }
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
            this._resetReconnectCounters()
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
            this._resetReconnectCounters()
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
      // ★ v3.25-fix: 取消可能残留的"假断连"延迟清零定时器（蓝牙真关闭立即清零）
      if (this._disconnectRssiClearTimer) { clearTimeout(this._disconnectRssiClearTimer); this._disconnectRssiClearTimer = null }
      this.connected = false
      this.deviceState = 'LOCKED'
      this.rssi = -999
      B._sessionSalt = null; B._cmdSeq = 0; B._lastNonce = null   // ★ P0-2: 断连重置签名会话态
      this.filteredRssi = -999
      this.displayRssi = -999
      this.rssiEma = -999
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
      addDebugLog(`_ensureForegroundService: mode=${this.autoReconnectMode} deviceId='${this.deviceId || ''}' storage='${uni.getStorageSync('ble_device_id') || ''}'`)
      if (this._foregroundServiceActive) {
        addDebugLog('_ensureForegroundService: 已在运行，跳过')
        return
      }
      // ★ v3.24: 手动模式不启动任何保活/后台扫描（完全由用户手动控制）
      if (this.autoReconnectMode === 'manual') {
        addDebugLog('_ensureForegroundService: 手动模式，跳过', 'info')
        return
      }
      if (this._foregroundServiceFailCount >= 3) {
        // 已经失败 3 次，放弃
        addDebugLog('_ensureForegroundService: 已失败3次，放弃', 'warning')
        return
      }

      const knownId = this.deviceId || uni.getStorageSync('ble_device_id')
      addDebugLog(`_ensureForegroundService: knownId='${knownId || '(空)'}'`, knownId ? 'success' : 'warning')

      // ★ v3.24: 优先原生插件（真正后台重连的核心）
      //   原生层 KeygoBleScanService 在原生 Android 进程常驻，锁屏/Doze 下仍能 BLE 扫描，
      //   扫到已知设备即回调唤醒 JS 触发 tryAutoConnect。这是纯 JS 方案做不到的。
      if (knownId && !__DISABLE_NATIVE_FG) {
        const started = startNativeBackgroundScan('', (dev) => this._onNativeDeviceFound(dev))
        addDebugLog(`_ensureForegroundService: 原生启动返回 started=${started}`)
        if (started) {
          this._foregroundServiceActive = true
          this._foregroundServiceNative = true
          this._foregroundServiceFailCount = 0
          setDebugForegroundStatus(true, true, knownId)
          console.log('[Store] 🔒 原生前台服务 + 后台扫描已启动（已知设备:', knownId, '）')
          this._registerScreenOnListener() // ★ 探针：前台服务启动即挂屏幕监听，无论连没连都能收广播
          return
        }
      } else {
        addDebugLog(`_ensureForegroundService: 原生分支${__DISABLE_NATIVE_FG ? '已禁用(止血)' : 'knownId为空'} → 走纯JS前台服务`, 'warning')
      }

      // ★ 回退：纯 JS（无已知设备 或 插件不可用）
      try {
        const result = await startForegroundService()
        addDebugLog(`_ensureForegroundService: 纯JS前台服务 result=${result}`, result ? 'success' : 'error')
        if (result === true) {
          this._foregroundServiceActive = true
          this._foregroundServiceFailCount = 0
          setDebugForegroundStatus(true, false)
          console.log('[Store] 🔒 前台服务已启动（纯 JS 回退，通知栏应可见）')
          this._registerScreenOnListener() // ★ 探针：前台服务启动即挂屏幕监听
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
      // ★ 探针解耦：无论前台服务起没起（原生 getAppContext 失败 / 纯JS 前台服务失败都不影响），
      //   都确保屏幕监听已注册（JS 兜底前台可靠），用于确认屏幕事件链路是否通。
      if (!this._screenOnReceiverActive) {
        this._registerScreenOnListener()
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
      setDebugDeviceFound(dev)
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
      // ★ fix (②): 幂等保护
      //   同一物理断连可能被多个监听器重复触发（如全局监听器 + 重连流程残留监听），
      //   导致 _reconnectGuard 被双增、并产生并行重连循环。_handleDisconnect 进入后会
      //   立刻将 connected 置 false（见下方），故第二次重入时直接返回，避免重复处理。
      if (this.connected === false) {
        console.log('[Store] 断连已处理过（幂等保护，跳过重复触发）')
        return
      }

      // ★ 2026-07-17 诊断埋点：断连即刻记录「会话画像」，配合固件串口 [DIAG]/reason 定位断连性质：
      //   - 存活极短(<数秒) + authed=false → 大概率「未鉴权 30s 强断」或 AUTH 未完成即被踢；
      //   - 存活较久后掉线 + authed=true  → 大概率监督超时(1s)/信道问题(锁屏/Doze)；
      //   - devBound=true 但 bound=false  → 本机密钥失效（被 B 覆盖/复位）→ 需重绑，佐证互踢。
      {
        const _durS = this._connectedAtMs ? ((Date.now() - this._connectedAtMs) / 1000).toFixed(1) : '?'
        const _msg = `断连: 存活${_durS}s authed=${this.sessionAuthed} bound=${this.isBound} devBound=${this.deviceBound} mode=${this.autoReconnectMode}/${this.reconnectMode}`
        console.log(`[Store][DIAG] ${_msg}`)
        try { addDebugLog(_msg, 'warning') } catch (e) {}
      }

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
      // ★ v3.25-fix: 不再立即清零 RSSI。锁屏/Doze 下 Android 可能发送虚假断连事件，
      //   但 GATT 实际未断（固件 LED 仍按 RSSI 工作、解锁 WRITE 仍成功）。立即清零会让
      //   页面在连接其实活着时误显 "--"。改为延迟 3s 确认真断连：期间若收到 FF02(c:1)
      //   自愈，_parseSingleStatus 会重设 connected/filteredRssi 并取消本定时器（见下方）。
      this.statusStale = true
      this.batteryLevel = -1        // ★ v3.14: 断连重置电量
      // ★ v3.31.0 / 2026-07-13: 清掉 RSSI 看门狗并重置显示态（避免残留 stale 显示）
      this._clearRssiStaleWatchdog()
      this.displayRssi = -999
      this.rssiEma = -999
      if (this._disconnectRssiClearTimer) clearTimeout(this._disconnectRssiClearTimer)
      this._disconnectRssiClearTimer = setTimeout(() => {
        this._disconnectRssiClearTimer = null
        // 已自愈（connected 回到 true / 收到 FF02）则不清除，避免误显 "--"
        if (!this.connected) {
          this.rssi = -999
          this.filteredRssi = -999
        }
      }, 3000)

      // ★ v3.12: 断连时重置恢复标记，确保重连时能重新加载 per-SN 配置
      this._restoredForSn = ''

      // ★ 方案A（2026-07-12）：未绑定连接超时强断 → 抑制自动重连（含原生前台扫描）
      //   固件主动踢人（BIND:TIMEOUT）后，不应像异常断连那样自动重连刷占连接槽，
      //   应等用户手动重连并在 30s 内绑定。此处拦截覆盖「断连早于通知到达」的竞态：
      //   即便 notify 晚到，断开即停原生扫描；且 notify 处理已置 reconnectMode='dormant'，
      //   挂起的定时重连在 _scheduleReconnect 内会因 dormant 而放弃。
      if (this._unboundTimeoutKicked) {
        console.log('[Store] 未绑定超时断开，抑制自动重连（等待用户手动重连绑定）')
        this._unboundTimeoutKicked = false
        if (this._foregroundServiceNative) {
          stopNativeBackgroundScan()
        }
        return  // 不启动任何重连 / 围栏 / GPS 心跳
      }

      // ★ v3.24: 极速模式下断连 → 三级后备记录停车位置 + 启动后台 GPS 围栏
      if (this.autoReconnectMode === 'speed') {
        console.log('[Store] ⚡ 极速模式断连，记录停车位置 + 启动围栏监控...')

        // 1. 确保前台服务存活（GPS 监控需要）
        this._ensureForegroundService()

        // ★ fix (①B): 同步启动 AlarmManager 心跳（抗 Doze）。
        //   原实现将 _startHeartbeat 放在 getCurrentPosition().then 异步回调里，
        //   GPS 在室内/Doze 下不回调时心跳永不启动，导致后台重连失效。
        //   现改为断连即刻同步启动；GPS 仅用于精修停车点，不作为启动心跳的前提。
        this._startHeartbeat()

        // 2. Priority 1: 尝试使用 watchPosition 缓存的最近坐标（同步，零延迟）
        const cachedPos = getLastKnownPosition()
        const MAX_CACHE_AGE = 300000  // 5 分钟

        if (cachedPos && cachedPos.age < MAX_CACHE_AGE) {
          console.log(`[Store] ⚡ 使用缓存坐标 (${(cachedPos.age / 1000).toFixed(1)}s 前，精度 ±${Math.round(cachedPos.accuracy)}m)`)
          // ★ v3.25.2: 传入缓存的 accuracy（watchPosition 低功耗定位，通常 ±30-100m）
          saveParkingLocation(cachedPos.lat, cachedPos.lng, cachedPos.accuracy)
          this._startGeofenceMonitor()

          // 异步补一次高精度 GPS，静默更新停车位置（不阻塞围栏启动/心跳）
          getCurrentPosition().then(pos => {
            if (pos) {
              saveParkingLocation(pos.lat, pos.lng, pos.accuracy)
              console.log(`[Store] ⚡ 高精度 GPS 已更新停车位置 (精度 ±${Math.round(pos.accuracy)}m)`)
            }
          })
          return
        }

        // 3. Priority 2 & 3: 缓存不可用 → 异步 GPS / 悲观启动（心跳已同步启动）
        console.log(cachedPos
          ? `[Store] ⚡ 缓存坐标过期 (${(cachedPos.age / 1000).toFixed(0)}s)，降级为异步 GPS`
          : '[Store] ⚡ 无缓存坐标，异步获取 GPS...')

        getCurrentPosition().then(pos => {
          if (pos) {
            saveParkingLocation(pos.lat, pos.lng, pos.accuracy)
            this._startGeofenceMonitor()
            console.log(`[Store] ⚡ GPS 停车位置已记录 (精度 ±${Math.round(pos.accuracy)}m)，围栏监控已启动`)
          } else {
            // Priority 3: GPS 不可用 → 用 localStorage 旧位置悲观启动围栏
            console.warn('[Store] ⚡ GPS 不可用，使用旧停车位置悲观启动围栏...')
            this._startGeofenceMonitor()  // 内部读取 localStorage 旧位置
          }
        }).catch(() => {
          console.warn('[Store] ⚡ GPS 异常，悲观启动围栏...')
          this._startGeofenceMonitor()
        })
        return
      }

      // ★ 2026-07-16: 配对(_triggerBond)期间主动断开 GATT 是故意的（让 OS 能发起系统配对）。
      //   此时必须抑制自动重连，否则 store 会立刻把 GATT 重连上 → createBond 在已连接状态下被系统拒绝、不弹窗。
      if (this._bondingInProgress) {
        console.log('[Store] 配对中断开 GATT，抑制自动重连（由 _triggerBond 接管重建）')
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

      // ★ fix (①A): 舒适模式断连 → 同步启动 AlarmManager 心跳（抗 Doze）。
      //   原 _startDormantPoll（唯一会启动心跳的函数）是死代码从未被调用，
      //   导致舒适模式后台重连完全依赖会被 Doze 冻结的 setTimeout。
      //   设备回来后，心跳每 60s 触发 tryAutoConnect（见 _onHeartbeatTick 舒适分支）。
      if (this.autoReconnectMode === 'comfort') {
        // ★ fix: 断开即刻注册亮屏监听器（不再等 10 次重连失败后才注册）。
        //   原实现把亮屏触发当作「10 次 setTimeout 重连都失败」的兜底，但后台 + Doze
        //   下 setTimeout 会被冻结、且设备常在到 10 次之前就已连回，导致整段后台窗口里
        //   亮屏监听器从未生效，用户开关屏毫无反应。现断开即注册，亮屏/解锁立刻触发扫描。
        this._startHeartbeat()
        this._registerScreenOnListener()
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
          // ★ v3.25-fix3: 系统级"已连接"只代表 GATT 链路活着，不保证 FF02 的 Notify(CCCD)
          //   订阅仍有效。Doze/后台后 CCCD 常被系统重置，导致 WRITE 仍成功（19:55:14 LOCK
          //   写入成功即证 GATT 活着）但 FF02 不再送达 → 显示 "---" 且状态过期。
          //   ① 重新武装状态看门狗：FF02 真死则 3s 后触发 _repairConnection 自动重建 GATT；
          //   ② 主动在当前 GATT 上下文重开 FF02/Battery Notify：CCCD 仅被重置时即可恢复，
          //      无需全量拆链；若 GATT 上下文本身已死，①的看门狗会兜底全量重建。
          this._resetStatusStaleTimer()
          this._enableStatusNotify()
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
          // ★ v3.25-fix3: 同上，恢复 FF02 Notify 并武装看门狗（见系统级验证分支）
          this._resetStatusStaleTimer()
          this._enableStatusNotify()
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
     * ★ 2026-07-14 修复：清除「未绑定超时被踢」的持久化抑制标记。
     *   仅当标记命中当前设备（或无具体设备时的通配 '1'）才清，避免误清
     *   其它设备的合法抑制。调用时机：AUTH:OK / BIND:OK（即本机已证明是 owner）。
     *   陌生人/未绑定连接永远到不了这两个回包 → 标记保持 → 不自动刷占连接槽（DoS 保护不破）。
     */
    _clearUnboundKicked() {
      try {
        const kicked = uni.getStorageSync('keygo_unbound_kicked')
        if (!kicked) return
        const cur = this.deviceId || uni.getStorageSync('ble_device_id') || ''
        const norm = s => String(s).replace(/:/g, '').toUpperCase()
        if (kicked === '1' || (cur && norm(kicked) === norm(cur))) {
          uni.removeStorageSync('keygo_unbound_kicked')
          console.log('[Store] 连接鉴权成功，清除「未绑定超时被踢」抑制标记，恢复自动重连')
        }
      } catch {}
    },

    /**
     * ★ 自动重连统一闸门（② 用户主动断开不自动连；① 绑定门槛预留）
     *   所有自动触发点（onShow / 亮屏 / 围栏）都应先过此闸门。
     *   注意：不含 "reconnectMode==='idle'" —— 那是 onShow 避免重入的额外约束。
     *   @returns {boolean}
     */
    // ★ ignoreKicked=true 用于「前台自动连」(App 启动/回到前台)：即使曾被写「未绑定被踢」
    //   标记也允许本次前台尝试，连上后由 AUTH:OK/BIND:OK 清除标记；否则会形成死锁：
    //   标记拦住自动连 → 连不上 → 到不了 AUTH:OK → 标记永远清不掉 → 每次都要手动连。
    //   后台被动触发(STATE_ON/心跳/亮屏/原生扫描)仍传 false，保留 DoS 抑制。
    // ★ isForeground=true 用于「前台自动连」(App 启动/回到前台 onShow)：手动模式下也允许本次
    //   前台尝试（用户需求：手动模式打开 App 也要自动连）。后台被动触发(STATE_ON/心跳/亮屏/
    //   原生扫描)传默认 false，手动模式仍被拦死 → 锁屏后台不自动重连，仅由用户点按钮或打开 App 触发。
    _shouldAutoReconnect(ignoreKicked = false, isForeground = false) {
      if (this.connected) return false
      if (this.reconnectMode === 'dormant') return false   // 用户主动断开
      if (this.autoReconnectMode === 'manual' && !isForeground) return false // ★ 手动模式：仅前台放行
      if (this.btState === 'off') return false
      if (!ignoreKicked) {
      // ★ 方案A（2026-07-12 修正②）：曾因「连上未绑定超时」被固件强断的设备 → 不自动重连。
      //   持久化兜底：即便 BIND:TIMEOUT 通知偶发丢失、或 App 重启/原生扫描回调重置了内存态，
      //   也不会反复重连刷占唯一连接槽。用户手动 connect() 会清除该标记，恢复自动重连。
      try {
        const kicked = uni.getStorageSync('keygo_unbound_kicked')
        if (kicked) {
          const cur = this.deviceId || uni.getStorageSync('ble_device_id') || ''
          const norm = s => String(s).replace(/:/g, '').toUpperCase()
          // kicked==='1' 表示当时无 deviceId，一律抑制；否则按 MAC 匹配抑制
          if (kicked === '1' || (cur && norm(kicked) === norm(cur))) return false
        }
      } catch {}
      } // end if (!ignoreKicked)
      // ① 绑定门槛预留：if (!this.isBound) return false
      return true
    },

    _onScreenOn(action) {
      // ★ 探针：无论连接/模式，先记录最近一次屏幕事件（可视化确认原生插件在收广播）
      // 注意：action 是原生透传的 type（'screen_on' / 'screen_off' / 'user_present'），
      // 不是 Android 原始意图字符串，故此处按 type 比较（旧代码误用 android.intent.action.* 比对，永远不成立）。
      const _probeLabel = action === 'screen_off' ? '锁屏'
        : action === 'user_present' ? '已解锁' : '亮屏'
      recordScreenEvent(action, _probeLabel)
      if (action === 'screen_off') {
        console.log('[Store] 📱 屏幕关闭事件（不触发重连）')
        setDebugScreenOn('屏幕关闭')
        return
      }
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
      const label = action === 'user_present' ? '\u5df2\u89e3\u9501' : '\u5c4f\u5e55\u4eae\u8d77'
      console.log(`[Store] \ud83d\udcf1 \u4eae\u5c4f\u89e6\u53d1\uff08${label}\uff09\u2192 \u542f\u52a8\u626b\u63cf`)
      setDebugScreenOn(label)
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

        const onDeviceFound = async (device) => {
          if (this._screenOnScanGuard !== guard || this.connected || connecting) return
          if (device.deviceId === targetId) {
            console.log(`[Store] \ud83d\udcf1 \u4eae\u5c4f\u626b\u63cf\u53d1\u73b0: ${device.name}, RSSI: ${device.RSSI}`)
            connecting = true
            this._repairing = true // ★ v3.25-fix2: 占住标志，避免看门狗 _repairConnection 并发重建
            // ★ v3.25-fix2: 先强制拆掉可能陈旧的 GATT 上下文。Android Doze/后台后，已建立
            //   连接的 Notify 订阅(CCCD)会静默失效；而 createBLEConnection 对已连设备是空操作，
            //   拿不到新 GATT 上下文，导致随后 notifyBLECharacteristicValueChange 在死句柄上
            //   静默失败、FF02 全丢、页面卡 "---"。强制 close 后再 connect 可拿到全新 GATT
            //   上下文，使 FF02 订阅真正恢复。未连接时 close 报错被忽略，无害。
            await new Promise((resolve) => {
              try { uni.closeBLEConnection({ deviceId: targetId, complete: () => resolve() }) } catch (e) { resolve() }
            })
            await new Promise(r => setTimeout(r, 400)) // 等 OS 真正拆链，避免与 connect 竞争
            this._connectWithResetFallback(targetId).then(() => {
              this._repairing = false
              if (this._screenOnScanGuard !== guard || this.connected) return
              console.log('[Store] \ud83d\udcf1 \u4eae\u5c4f\u8fde\u63a5\u6210\u529f\uff0c\u521d\u59cb\u5316...')
              setDebugReconnectResult(true, '\u4eae\u5c4f\u8fde\u63a5\u6210\u529f')
              this.connected = true
              this._configPushedThisConn = false   // ★ 2026-07-14: 新连接重置（防止沿用上一连接的去重标志）
              this._resetRssiDisplay()   // ★ v3.31.0 / 2026-07-13: 亮屏修复连上后重置 RSSI 显示态
              this.lastDeviceId = targetId
              if (!this.deviceName) {
                const macClean = targetId.replace(/:/g, '')
                this.deviceName = 'KeyGo-' + macClean.slice(-6).toUpperCase()
              }
              stopScan().catch(() => {})
              this.scanning = false
              this._resetReconnectCounters()
              this._stopDormantPoll()
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
              this._repairing = false
              if (this._screenOnScanGuard !== guard || this.connected) return
              connectRetries++
              connecting = false
              console.log(`[Store] \ud83d\udcf1 \u8fde\u63a5\u5931\u8d25 (${connectRetries}/2):`, err?.message || err)
              setDebugReconnectResult(false, `\u4eae\u5c4f\u8fde\u63a5\u5931\u8d25: ${err?.message || err || 'unknown'}`)
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
          this._resetReconnectCounters()
          console.log('[Store] 重连成功！')
          setDebugReconnectResult(true, '\u5b9a\u65f6\u91cd\u8fde\u6210\u529f')
        } catch (e) {
          // ★ v3.6-fixD2: SESSION_EXPIRED → 蓝牙关断穿透，立即中止，不重试
          if (e && e.message === 'SESSION_EXPIRED') {
            console.log('[Store] ⛧ 重连会话过期，放弃本轮')
            return
          }

          this.reconnectAttempt++
          setDebugReconnectResult(false, `定时重连失败 #${this.reconnectAttempt}: ${e?.message || e || 'unknown'}`)

          // ★ v3.6: 如果是蓝牙关闭导致的失败，_doReconnect 已将 mode 设为 paused
          //   不再调度下一轮，等待适配器状态变化事件来恢复
          if (this.reconnectMode === 'paused') {
            console.log('[Store] 蓝牙未开启，暂停重连，等待蓝牙恢复')
            return
          }

          if (this.reconnectAttempt >= 5) {
            // ★ v3.23: 5 次失败后根据模式分支
            this.reconnectAttempt = 0
            this.reconnectNextDelay = 0
            if (this.autoReconnectMode === 'comfort') {
              // ★ v1.0.1: 舒适模式 → 注册亮屏监听器（零后台功耗）
              this.reconnectMode = 'idle'
              console.log('[Store] 重连失败达 5 次，注册亮屏监听器（零后台功耗）')
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
     * ★ 连接成功后的统一状态同步（手动连接 / 自动重连 / 全局监听器补位共用）
     *   将底层 BLE 连接建立后的 store 状态同步、服务停止、notify 注册、序列号读取
     *   提取为公共方法，避免 connect() / _doReconnect / 全局监听器补位 三处重复。
     */
    _finalizeConnection(deviceId) {
      this.connected = true
      this._connectedAtMs = Date.now()   // ★ 2026-07-17 诊断埋点：记录会话起点，供 _handleDisconnect 算存活时长
      this._configPushedThisConn = false   // ★ 2026-07-14: 新连接重置去重标志
      this._resetRssiDisplay()     // ★ v3.31.0 / 2026-07-13: 重置 RSSI 显示态 + 启动连续无 FF02 看门狗
      this.sessionAuthed = false   // ★ ②: 新连接需重新 AUTH
      B._sessionSalt = null; B._cmdSeq = 0; B._lastNonce = null   // ★ P0-2: 新连接重置签名会话态
      this._statusNotifyReady = false  // ★ 2026-07-12: 本连接 FF02 Notify 尚未订阅，自动 AUTH 待订阅后触发
      this._autoAuthState = 'idle'   // ★ 2026-07-12: 重置自动 AUTH 状态机
      this.lastDeviceId = deviceId
      if (!this.deviceName) {
        const macClean = this.deviceId.replace(/:/g, '')
        const macSuffix = macClean.slice(-6).toUpperCase()
        this.deviceName = 'KeyGo-' + macSuffix
      }
          this._resetReconnectCounters()
          this._stopDormantPoll()
      this._stopGeofenceMonitor()
      this._stopHeartbeat()
      this._ensureForegroundService()
      this._reconnectGuard = 0

      // 读取序列号（异步，不阻塞）
      readSerialNumber(this.deviceId, 5000).then(sn => {
        this.serialNumber = sn
        this._resolveDeviceName(sn)
        this._loadConfigForDevice(sn)
        this._syncConfigToDevice()
        // ★ ②: 恢复本机已存的 bindKey（isBound 复原）。若本机曾绑定，则在 FF02 Notify
        //   订阅就绪后自动重做 AUTH 握手恢复会话（见 _maybeAutoAuth）。
        //   ★ 2026-07-12 修复（bug ①）：此前「阶段1 明文绑定」临时注释掉了连接时的自动 AUTH，
        //   导致重连后 sessionAuthed 永远 false → UI 恒显「已绑定·连接待验证」、且手动控制指令
        //   被 sendCommand 的 sessionAuthed 门控挡成「设备未绑定，请先绑定」，逼用户每次手动重验证。
        //   固件 Bonding_ConnTerminated 本就在每连接清零会话态，故重连必须重 AUTH——自动补上即可。
        if (sn) {
          this._restoreBindKey(sn)
          this._maybeAutoAuth()
        }
      }).catch(() => {})

      // 注册 notify（延迟 800ms，给 GATT 服务就绪时间）—— 抽成 _enableStatusNotify 复用
      const targetId = this.deviceId
      setTimeout(async () => {
        if (this.deviceId !== targetId || !this.connected) return
        this._enableStatusNotify()
      }, 800)

      uni.showToast({ title: '已自动连接', icon: 'success', duration: 1500 })
    },

    /**
     * ★ v3.25-fix3: 在"已连接"状态下（重新）开启 FF02/Battery 的 Notify 订阅。
     *   用途：① 连接成功后 _finalizeConnection 延迟开启；② onShow 经 _verifyConnection
     *   确认连接仍活着后主动重开（Doze/后台使 CCCD 失效时的恢复手段）。
     *   GATT 上下文健康时此调用幂等（重设 CCCD=0x0001，无害）；上下文本身已死时
     *   静默失败，由 _repairConnection 的看门狗兜底做全量重建。
     */
    async _enableStatusNotify() {
      const targetId = this.deviceId
      if (!targetId || !this.connected) return
      try {
        await notifyBLECharacteristicValueChange(targetId, BLE_CONFIG.serviceUUID, BLE_CONFIG.statusCharUUID, true)
        notifyBLECharacteristicValueChange(targetId, BATT_SERVICE.serviceUUID, BATT_SERVICE.levelCharUUID, true).catch(() => {})
        this._fetchBatteryLevel(targetId).catch(() => {})
        // ★ 2026-07-12: FF02 Notify 已订阅 → 标记就绪并触发自动 AUTH（恢复会话态）。
        //   必须在订阅之后（NONCE/AUTH 回包走 FF02），否则回包丢失会超时失败。
        this._statusNotifyReady = true
        this._maybeAutoAuth()
      } catch (_) {}
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

      this._finalizeConnection(this.deviceId)
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
          showProgressCard: this.showProgressCard,  // ★ v3.31 方案B-修正: 进度条开关（手机端偏好）
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
    async _syncConfigToDevice(force = false) {
      if (!this.deviceId || !this.connected) return
      // ★ 2026-07-14 修复：本连接已成功下发过配置 → 直接跳过，避免「连接 / SN 读取 / AUTH:OK」
      //   三路径各自触发一次 _syncConfigToDevice，导致同一条 FF01 配置被下发两次；
      //   第二条写在首条成功后 ~35ms 撞上 GATT 瞬时态 → 报 10007(property not support)。
      //   去重后每连接仅下发一次（最终态即最新阈值），彻底消除该幽灵 1007。
      //   force=true 用于「切换智能重连模式需重发 autolock」等必须重发的场景。
      //   （手动改阈值走 updateConfig，是独立的写，不受此标志影响。）
      if (this._configPushedThisConn && !force) {
        return
      }
      // ★ v3.27: 串行化——若已有配置写下发在途，跳过本次（最终态由调用方保证再触发一次）。
      //   防止模式切换/提交配置并发写同一特征值导致 GATT busy 丢命令。
      // ★ v3.33.0: 在途时不再静默丢弃，而是置 _configSyncPending，等本次写完成（finally）后补发，
      //   确保「重连抢跑失败 / 并发」场景最终态一定写下去（T4 断电重启回推不丢）。
      if (this._configWriteBusy) {
        console.log('[Store] 配置写下发中，标记待补发 _syncConfigToDevice')
        this._configSyncPending = true
        return
      }
      this._configWriteBusy = true
      try {
        // ★ v3.27-fix ②: 经写队列串行化，与手动命令共用同一 GATT 通道，避免并发写冲突
        await enqueueWrite(() => sendConfig(this.deviceId, {
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
        }))
        this._configPushedThisConn = true   // ★ 2026-07-14: 标记本连接已成功下发，后续重复调用直接跳过
        console.log('[Store] 配置已下发到设备 (unlock=' + this.unlockThreshold + ' lock=' + this.lockThreshold + ' uc=' + this.unlockCountRequired + ' lc=' + this.lockCountRequired + ' interval=' + this.rssiReadPeriodMs + ' kr=' + this.kalmanR + ' autolock=' + (this.autoReconnectMode === 'manual' ? 0 : 1) + ')')
      } catch (e) {
        console.warn('[Store] 配置下发失败:', e?.message || e)
      } finally {
        this._configWriteBusy = false
        // ★ v3.33.0: 若在途期间又来过一次回推请求，本次落地后立即补发，保证最终态一致
        if (this._configSyncPending) {
          this._configSyncPending = false
          console.log('[Store] 补发配置回推（在途期间累计请求）')
          this._syncConfigToDevice()
        }
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
      this._loadCachedDeviceMode()   // ★ Phase 2: SN 就绪即恢复模式缓存（设备 m 上报前渲染正确 UI）
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
        this._resetReconnectCounters()
        this._reconnectGuard++
        // ★ 方案A（2026-07-12 修正②）：用户主动连接即清除「未绑定超时被踢」抑制标记，
        //   恢复后续自动重连（配合 _shouldAutoReconnect 的持久化兜底）。
        this._unboundTimeoutKicked = false
        try { uni.removeStorageSync('keygo_unbound_kicked') } catch {}

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
        this._configPushedThisConn = false   // ★ 2026-07-14: 新连接重置去重标志
        this._resetRssiDisplay()   // ★ v3.31.0 / 2026-07-13: 手动连上后重置 RSSI 显示态
        this.lastDeviceId = deviceId

        // ★ v3.6: 连接成功后重置重连状态（允许后续异常断连自动重连）
          this._resetReconnectCounters()
          // ★ v3.23: 连接成功 → 停止舒适模式轮询 + 极速模式 GPS 围栏 + 心跳 + 亮屏监听器
        this._stopDormantPoll()
        this._stopGeofenceMonitor()
        this._stopHeartbeat()
        // ★ v3.17: 连接成功后启动前台服务（Android 保活）
        this._ensureForegroundService()

        // ★ v3.25: 极速模式下，连接成功 = 人就在车旁边，静默更新停车位置
        if (this.autoReconnectMode === 'speed') {
          getCurrentPosition().then(pos => {
            if (pos) {
              saveParkingLocation(pos.lat, pos.lng, pos.accuracy)
              this.parkingLocation = getParkingLocation()
              console.log(`[Store] ⚡ 连接成功 → 已更新停车位置 (精度 ±${Math.round(pos.accuracy)}m)`)
            }
          })
        }

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
        try {
          await notifyBLECharacteristicValueChange(
            deviceId,
            BLE_CONFIG.serviceUUID,
            BLE_CONFIG.statusCharUUID,
            true
          )
          console.log('[Store] ★ FF02 Notify 启用成功（CCCD 写入完成，设备应开始推送状态）')
        } catch (e) {
          console.error('[Store] ✗ FF02 Notify 启用失败（CCCD 写入失败，所有 FF02 通知将收不到）:', e?.message || e)
          console.error('[Store] ✗ 这就是为什么 BIND 没回包的根本原因！请截图此错误！')
        }

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
          // ★ v3.32.2-fix①: 手动连接路径补上「恢复绑定 + 自动 AUTH」。
          //   此前此分支（connect() 手动连接）漏掉了 _finalizeConnection（自动重连路径）已有的
          //   _restoreBindKey + _maybeAutoAuth，导致：手动模式重启 APP 后，用户手动连上设备，
          //   isBound/sessionAuthed 永远 false → UI 恒显「连接待验证」、控车被挡成「请先绑定」，
          //   逼用户每次手动重绑。固件每连接清零会话态，故重连/手动连都必须重 AUTH——自动补上。
          this._restoreBindKey(sn)
          this._maybeAutoAuth()
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
      B._sessionSalt = null; B._cmdSeq = 0; B._lastNonce = null   // ★ P0-2: 主动断开重置签名会话态
      this.scanning = false
      this.customDeviceName = ''
      this.serialNumber = ''              // ★ v3.3
      this.fingerprint = ''               // ★ v3.3
      this._configDirty = false           // ★ v3.15: 重置脏标记（新连接重新初始化）
      this.deviceState = 'LOCKED'
      // ★ v3.25-fix: 新连接前清除可能存在的"假断连"延迟清零定时器，避免其随后误清 RSSI
      if (this._disconnectRssiClearTimer) { clearTimeout(this._disconnectRssiClearTimer); this._disconnectRssiClearTimer = null }
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
        // 注：即时重连由紧随其后的 tryAutoConnect() 负责（main.vue onShow 在 prepareForAutoConnect
        //   之后立即调用）。此处不再重复触发 _startReconnect，避免与 tryAutoConnect 的 _doReconnect
        //   并发双连（前者置 reconnectMode='active' 后仍会再跑一次 _doReconnect）。
        //   tryAutoConnect 现已对前台自动连放开「未绑定被踢」标记拦截，故蓝牙已开时启动即能自动连，
        //   无需等待 60s 心跳；若蓝牙本来关闭，则由用户开启后的 STATE_ON 事件 / 原生广播驱动重连。
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
      //   前台自动连传 (ignoreKicked=true, isForeground=true)：
      //   - ignoreKicked：即使曾因「未绑定被踢」被写持久标记也允许本次尝试，以打破死锁
      //     （见 _shouldAutoReconnect 说明）——连上后由 AUTH:OK/BIND:OK 清除标记；
      //   - isForeground：手动模式也放行「前台」自动连（用户需求：打开 App 就要连），
      //     但后台被动触发不传 isForeground，手动模式仍被拦死（锁屏后不自动重连）。
      if (!this._shouldAutoReconnect(true, true)) return false
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

    // ★ v3.31.0 / 2026-07-13: 连续无 FF02 看门狗 —— 连接仍在但长时间收不到状态包（后台 Doze/CCCD 失效）
    //   → 冻结 RSSI 显示，等 FF02 恢复再解冻，使「后台真断连」及时反映为无信号。
    _startRssiStaleWatchdog() {
      this._clearRssiStaleWatchdog()
      this._rssiStaleWatchdog = setInterval(() => {
        if (!this.connected) return
        if (this._lastFf02Ms && Date.now() - this._lastFf02Ms > 4000) {
          this.displayRssi = -999
        }
      }, 1500)
    },
    _clearRssiStaleWatchdog() {
      if (this._rssiStaleWatchdog) { clearInterval(this._rssiStaleWatchdog); this._rssiStaleWatchdog = null }
    },
    // ★ v3.31.0 / 2026-07-13: 每次（重）连接时重置 RSSI 显示态 + 启动看门狗
    _resetRssiDisplay() {
      this.displayRssi = -999
      this.rssiEma = -999
      this._lastFf02Ms = 0
      this._lastRssiDisplayMs = 0
      this._startRssiStaleWatchdog()
    },

    // ★ Q3 (2026-07-14): 统一重置「重连计数三件套」，收敛 9+ 处散落的
    //   reconnectMode / reconnectAttempt / reconnectNextDelay 重置代码，避免漏改或不一致。
    //   ⚠️ 注意：_reconnectGuard（断连锁，用于使在途 _doReconnect 旧 session 失效）【不】在此处递增！
    //   只有「蓝牙恢复 / 用户主动连接」这类需要让旧重连失效的场景才递增，
    //   调用点请在 _resetReconnectCounters() 之后单独写 this._reconnectGuard++。
    _resetReconnectCounters() {
      this.reconnectMode = 'idle'
      this.reconnectAttempt = 0
      this.reconnectNextDelay = 0
    },

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
      if (data.c !== undefined) {
        // ★ v3.25-fix: 收到 FF02(c:1) 即视为已连，取消"假断连"的延迟 RSSI 清零
        if (data.c === 1 && this._disconnectRssiClearTimer) {
          clearTimeout(this._disconnectRssiClearTimer)
          this._disconnectRssiClearTimer = null
        }
        this.connected = data.c === 1
      }

      // RSSI（先更新原始值，后续校验要用）
      if (data.r !== undefined && data.r > -999) this.rssi = data.r
      // ★ v3.31.0 / 2026-07-13: 显示用 RSSI 经 EMA 平滑 + 节流写入 displayRssi。
      //   后台累积的噪值被 EMA 抹平 → 回前台不会「疯狂跳跃/回放」。
      //   raw/filteredRssi 仍保留供其他逻辑使用，仅 UI 改绑 displayRssi。
      //   ★ 节流窗口 = rssiReadPeriodMs（与固件采样间隔【同源】）：手机改 RSSI 采样间隔会同步改这里，
      //     避免显示刷新比固件采样还快（徒增跳动）。注意：FF02 通知周期(~1s)独立于此，故显示实际
      //     最多每 1s 跳一次（除非固件 FF02 周期也跟随 interval）。
      if (data.f !== undefined && data.f > -999) {
        this.filteredRssi = data.f
        this._lastFf02Ms = Date.now()
        // ★ 2026-07-13 修正: 显示 RSSI 直接用固件 Kalman 滤波值 f（与区间判定 th/ucnt/lcnt
        //   同源），**不再叠加 EMA 二次平滑**。原 EMA(0.7/0.3, 新值权重仅0.3) 让显示值严重滞后
        //   于 f：走近时 f 已过 -40 触发解锁但 EMA 仍显示 -42；走远时 f 已回中性但 EMA 仍 -39。
        //   改直接显示 f 后大数字与区间判定一致。f 本身已是 Kalman 平滑值，无需再叠一层；
        //   节流(rssiReadPeriodMs)仅控刷新率，避免高于固件采样频率的徒增跳动。
        const _now = Date.now()
        if (_now - this._lastRssiDisplayMs >= this.rssiReadPeriodMs) {
          this.displayRssi = data.f
          this._lastRssiDisplayMs = _now
        }
      }

      if (data.st !== undefined) {
        this.deviceState = data.st
        // ★ 方案A(2026-07-13): 控制命令「已确认成功」早解析。
        //   固件成功执行命令后才会下发非 ACTION 的状态(st=UNLOCKED/LOCKED/TRUNK)，
        //   失败则只回 CMD:FAIL/DENY(不发状态)。故收到终态即视为命令已落地，
        //   让 _waitCmdResult 立即 resolve（不再干等 1.2s 超时）→ toast 与车状态文字同步出现。
        //   失败回包由 _handleBindingNotify 经 B._cmdWaiter 走 reject，且先到先消费并置空 waiter，
        //   优先级高于此处，不会误判成功。
        if (data.st !== 'ACTION' && B._cmdWaiter) {
          const w = B._cmdWaiter
          B._cmdWaiter = null
          w()  // 成功确认（无 errObj → resolve）
        }
      }

      // ★ v3.8: 自定义名称 — d2 总是接收作为初始显示
      //   SN 到达后由 _resolveDeviceName() 用本地名称覆盖（本地优先）
      //   短暂闪烁可接受（仅 SN 已就绪 + 本地名与 d2 不同时才会发生）
      if (data.d2 !== undefined && data.d2 !== '') this.customDeviceName = data.d2

      // ★ Phase 2: 设备模式 m (0=car / 1=ebike)，权威覆盖本地缓存
      if (data.m !== undefined) {
        this.deviceMode = data.m ? 'ebike' : 'car'
      }

      // ★ v3.7 / v3.12: 冷却时间 ms (cd = cooldown duration)
      //   设备级参数 — 从 FF02 Notify 被动同步，确保 App 显示与设备一致
      if (data.cd !== undefined && data.cd >= 2000 && data.cd <= 30000) {
        this.manualCooldownMs = data.cd
      }

      // ★ v3.24-fixb: 自动锁使能状态 (al = auto lock enable)
      //   来自 FF02 上报；0=手动模式已禁用 RSSI 自动锁，1=启用，-1 表示尚未收到
      //   注意：必须存数值 0/1，不能写 `data.al === 1`（那会得到布尔 true/false，
      //   导致 UI 的 `=== 0 / === 1` 判断全部落空、手动模式误显"已开启"）
      if (data.al !== undefined) this.autoLockEnabled = (Number(data.al) === 0) ? 0 : 1

      // ★ 2026-07-10: 固件版本号（v 字段）—— 确认设备烧录的是哪版，便于排查"改了没生效"
      if (data.v !== undefined) this.fwVersion = String(data.v)

      // ★ v3.33: 安全协议能力版本（fwsec 字段）—— 授权体系升级总闸门。
      //   收到 status 即代表已建立通信：有 fwsec → 用其值；无 fwsec → 旧固件视为 0（裸协议）。
      //   后续「多 owner / 管理员 / 限时·限次绑定码」等破坏性协议改动，一律先判 this.fwSec
      //   再决定走旧单码路径还是新授权体系路径，避免新固件配旧 App / 旧固件配新 App 时错配。
      const _fwsec = (data.fwsec !== undefined) ? Number(data.fwsec) : 0
      if (this.fwSec !== _fwsec) {
        this.fwSec = _fwsec
        console.log('[Store] 设备安全协议能力 fwsec =', _fwsec, '(fwVersion=' + this.fwVersion + ')')
      }

      // ★ 2026-07-16: 无 App 模式（固件 SMP 加密门控，基座无关）
      //   status.pair = 固件 g_encRequired 的实时镜像。
      //   对账逻辑：未切换(dirty=false)时以设备为准初始化/同步；切换后(dirty=true)若设备未对齐则重发 ENCRYPT 自愈。
      if (data.pair !== undefined) {
        const pair = (Number(data.pair) === 1)
        if (this._noAppModeDirty) {
          if (pair !== this.noAppMode) {
            // 设备未应用期望态（如配对抖动期下发被丢）→ 重新下发校正
            console.warn('[Store] 无 App 模式设备未对齐(pair=' + pair + ',期望=' + this.noAppMode + ')，重发 ENCRYPT:' + (this.noAppMode ? '1' : '0'))
            if (this.connected && this.deviceId) {
              enqueueWrite(() => rawSendCommand(this.deviceId, this.noAppMode ? 'ENCRYPT:1' : 'ENCRYPT:0'))
                .catch((e) => console.error('[Store] 重发 ENCRYPT 失败:', e))
            }
          } else {
            this._noAppModeDirty = false   // 设备已应用，清除脏标记
            console.log('[Store] 无 App 模式已落盘 pair =', pair)
          }
        } else {
          // 未切换：以设备为权威（处理掉电/重启后设备真实状态）
          if (this.noAppMode !== pair) {
            this.noAppMode = pair
            console.log('[Store] 无 App 模式同步设备 pair =', pair, '(fwVersion=' + this.fwVersion + ')')
          }
        }
      }

      // ★ 2026-07-10: 已绑定标志（bn 字段）—— 双保险确认绑定成功。
      //   固件 BIND 后连续发 BIND:OK + 状态包，浅通知队列下 BIND:OK 可能丢弃；
      //   但 status（含 bn，可靠送达）能确证绑定成功。仅在等待 BIND 回应时生效。
      // ★ 2026-07-11: 同时把设备端真实绑定态回灌到 deviceBound（设备权威），
      //   使得「设备已绑、但本机无 key（新手机/清缓存）」时，绑定弹窗也能正确显示
      //   「已绑定」分支与『修改绑定码/解绑』入口，避免用户卡在首绑分支输自定义码反复 FAIL。
      if (data.bn !== undefined) {
        const bound = (Number(data.bn) === 1)
        this.deviceBound = bound
        // ★ 2026-07-14 修复：设备已解绑（bn=0）但本机仍持有密钥 = 设备被恢复出厂或被其他手机解绑，
        //   旧密钥已彻底失效。若不处理，App 仍显示"已绑定"→ 用户去"修改绑定码"会拿旧码 AUTH →
        //   FAIL:NOT_BOUND / AUTH_FAIL。这里彻底忘记本地密钥并回到首绑界面（BindModal 的
        //   首绑分支 isBound&&deviceBound 均为 false 会自动显示，含"或：使用默认码 123456"）。
        //   ★ 注意：App 主动解绑(unbindDevice)已在回包里先把 B._bindKey 清空，故此处 B._bindKey
        //     为 null、isBound 为 false → 不触发，不会误弹"设备已重置"。
        if (!bound && (B._bindKey !== null || this.isBound)) {
          console.log('[Store] 🔄 设备端已解绑(bn=0)但本机仍有密钥 → 判定设备被复位，忘记本地密钥')
          this._forgetDeviceKey('设备已恢复出厂或已解绑，本机密钥失效，请重新绑定')
          // ★ 2026-07-16: 设备复位会清掉 g_encRequired/系统配对码，本地期望态一并归零，避免对账时误把无 App 模式重新打开
          this.noAppMode = false
          this._noAppModeDirty = false
          // ★ 2026-07-14 修复：设备已复位(bn=0)，_finalizeConnection 的配置推送可能抢跑失败。
          //   重置去重标志，使后续重绑成功(BIND:OK/AUTH:OK)时 _syncConfigToDevice 能重新推送，
          //   避免 _configPushedThisConn 永久为 true 导致"确认次数不一致"（uc/lc 不匹配）。
          this._configPushedThisConn = false
        }
        // ★ 2026-07-11 修复：status.bn=1 仅在「未绑定→已绑定」跃迁时兜底确认 BIND 成功。
        //   设备本就绑定时，bn=1 只反映既有状态，不能证明「本次用某特定码验证成功」——
        //   否则用旧码/错误码重绑会被误判成功（用户实测：改码后旧码 123456 仍能「验证」）。
        //   已绑定场景下的成败，只看固件对这条 BIND 的真实回包（BIND:OK / BIND:FAIL:*）。
        if (bound && B._bindWaiters.BIND && B._bindConfirmByStatus) {
          console.log('[Store] 🔒 经 status.bn=1 确证绑定成功（仅首绑跃迁生效，BIND:OK 可能已被通知队列丢弃）')
          _resolveWaiter('BIND', true)
        }
      }

      // ★ v3.31 方案B: 设备真实确认参数（uc/lc）—— 回显验证 App 下发的配置是否真落到设备
      if (data.uc !== undefined) this.deviceUc = Number(data.uc)
      if (data.lc !== undefined) this.deviceLc = Number(data.lc)
      // ★ v3.36: 设备当前生效阈值（owner 专属或全局）—— 验证 per-phone RSSI 阈值跟随是否落地
      if (data.ou !== undefined) this.deviceOu = Number(data.ou)
      if (data.ol !== undefined) this.deviceOl = Number(data.ol)
      // ★ v3.31 方案B: 实时确认进度（ucnt/lcnt）与当前区间（th）
      //   注: 进区瞬间 RSSI 在阈值边缘徘徊会先 ++ 出 ucnt=1(th=1) 再抖回中性区清零(th=0),
      //   如实显示即 1→0→1→2 的轻微闪烁(边界抖动真实反映)。曾尝试 App 端区间延迟去抖,
      //   但导致进度不跟手, 故回退为直接赋值, 保持跟手; 彻底消除闪烁需固件侧区间迟滞(另议)。
      if (data.ucnt !== undefined) this.unlockProgress = Number(data.ucnt)
      if (data.lcnt !== undefined) this.lockProgress = Number(data.lcnt)
      if (data.th !== undefined) this.thresholdZone = Number(data.th)

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
          // ★ v3.25-fix2: 连接存活但 FF02 中断 → 自愈重建 GATT 上下文（见 _repairConnection）
          this._repairConnection()
        }
        this._statusStaleTimer = null
      }, 3000)  // 3s = 3 × 固件 1s 推送周期，留足余量
    },

    /**
     * ★ v3.25-fix2: "连接存活但 FF02 通知中断"自愈
     *   症状：GATT 连接活着（固件 LED 仍按距离亮灭、WRITE 仍成功），但 App 不再收到
     *   FF02 → statusStale=true 且 filteredRssi 卡在 -999（显示 "---"）。
     *   根因：Android 在 Doze/后台后，已建立的 GATT 上下文的 Notify 订阅(CCCD)会静默失效；
     *   此时 OS 层连接未真断，createBLEConnection 对已连设备是空操作，无法刷新 GATT 上下文，
     *   导致 notifyBLECharacteristicValueChange 在陈旧句柄上静默失败、FF02 全被丢弃。
     *   修复：强制 closeBLEConnection 拆掉陈旧上下文 → 再 createBLEConnection 建立全新 GATT
     *   上下文 → _finalizeConnection 重新 enable FF02 Notify。这是 Android BLE 恢复 Notify
     *   的可靠手段。用 _repairing 标志防重入。
     */
    async _repairConnection() {
      if (this._repairing) return
      const targetId = this.deviceId
      if (!targetId || !this.connected) return
      this._repairing = true
      console.warn('[Store] ⚠ 连接存活但状态过期 → 强制重建 GATT 上下文以恢复 FF02 订阅')
      try {
        // 1) 拆掉可能陈旧的 GATT 上下文（未连接时 close 报错，忽略即可）
        await new Promise((resolve) => {
          try { uni.closeBLEConnection({ deviceId: targetId, complete: () => resolve() }) } catch (e) { resolve() }
        })
        await new Promise(r => setTimeout(r, 400))
        // 2) 全新连接（获取新鲜 GATT 句柄）
        this.connected = false
        await this._connectWithResetFallback(targetId)
        // 3) 统一收尾：重新 enable FF02/Battery Notify + 读序列号等
        this._finalizeConnection(targetId)
        console.warn('[Store] ✓ GATT 上下文已重建，FF02 订阅应已恢复')
      } catch (e) {
        console.warn('[Store] ⚠ GATT 重建失败，交由常规重连处理:', e?.message || e)
        this.connected = false
        this.statusStale = true
        if (typeof this._scheduleReconnect === 'function') this._scheduleReconnect(0)
      } finally {
        this._repairing = false
      }
    },

    // ==================== 命令 (v3.2) ====================

    async updateConfig(config) {
      if (!this.deviceId) throw new Error('未连接设备')
      // ★ 2026-07-14 修复：手动改阈值保存必须走写队列，与自动回推 _syncConfigToDevice 串行，
      //   否则两者并发写同一 FF01 → GATT 通道争抢 → 一侧被系统拒 → 弹"下发失败，请检查连接"。
      await enqueueWrite(() => sendConfig(this.deviceId, config))
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
      // ★ v3.36(2026-07-17): 用户改了解锁/上锁阈值 → 同步刷新「本机 owner」的 per-phone 阈值
      //   （RSSISET）。仅在已会话鉴权 + fwsec≥2 时生效；未鉴权时固件回 FAIL:NO_AUTH（无害，
      //   下次 AUTH:OK 会再推一次）。使自动解锁/上锁按这台手机自己的阈值判定，实现阈值跟随。
      if ((config.unlock !== undefined || config.lock !== undefined) && this.sessionAuthed) {
        this._pushRssiThresholds()
      }
    },

    /**
     * ★ 等待固件对控制命令的回包（CMD:FAIL:* / DENY:NOT_BOUND / DENY:AUTH_REQ:*）。
     *   固件成功执行只刷 status（不发 CMD:OK），故超时窗口内无失败回包即视为成功。
     *   失败时 _handleBindingNotify 经 B._cmdWaiter 回调 { code, msg }。
     */
    _waitCmdResult(ms = 1200) {
      return new Promise((resolve, reject) => {
        let done = false
        const timer = setTimeout(() => {
          if (done) return
          done = true
          B._cmdWaiter = null
          resolve()  // 超时 = 成功（固件成功不发 CMD:OK）
        }, ms)
        B._cmdWaiter = (errObj) => {
          if (done) return
          done = true
          clearTimeout(timer)
          B._cmdWaiter = null
          if (errObj) reject(errObj)
          else resolve()
        }
      })
    },

    async sendCommand(command) {
      if (!this.deviceId) throwError('NO_CONN')
      // ★ 控制类指令（非 BIND/AUTH/NONCE/UNBIND/SETCODE）要求本连接已完成会话鉴权；
      //   指令本身经 C1 签名（per-command HMAC + 会话盐 + 自增序号）防重放，
      //   固件 Peripheral_HandleFF03→Bonding_VerifySignedCmd 校验；未签名一律 CMD:FAIL:NO_SIG。
      const isControl = !/^(BIND:|AUTH:|NONCE|UNBIND|SETCODE:)/.test(command)
      if (isControl && command !== 'STATUS') {
        if (!this.sessionAuthed) throwError('NOT_BOUND')
        const signed = this._signCommand(command)
        if (!signed) throwError('NO_SALT')
        command = signed
      }
      // ★ v3.27-fix ②: 经模块级写队列串行化，保证「上一条 write 落地后再发下一条」，
      //   避免与配置下发并发抢 GATT 通道（从源头降低 GATT_BUSY / write failed）。
      await enqueueWrite(() => rawSendCommand(this.deviceId, command))
      // ★ 等待固件回包确认命令真实成败：失败回 CMD:FAIL/DENY（经 B._cmdWaiter reject）；
      //   成功固件只刷 status、不发 CMD:OK，故超时窗口内无失败即视为成功。
      if (isControl && command !== 'STATUS') {
        try {
          await this._waitCmdResult(1200)
        } catch (e) {
          throwError(e.code, e.msg || ERROR_MSGS[e.code])
        }
      }
    },

    /** ★ P0-2: 对控制命令做 C1 签名，返回 "C1:<cmd>:<seq>:<hmacHex>" 或 null（缺盐/缺密钥）。
     *   签名 = HMAC-SHA256(bindKey, saltBytes || "<cmd>:<seq>")。
     *   与固件 Bonding_VerifySignedCmd 完全一致：msg = salt(16) + ascii(cmd+":"+seq)。 */
    _signCommand(cmd) {
      if (!B._bindKey || !B._sessionSalt) return null
      B._cmdSeq += 1
      const seq = String(B._cmdSeq)
      const head = cmd + ':' + seq
      const saltBytes = hexToBytes(B._sessionSalt)
      const headBytes = new Uint8Array(head.length)
      for (let i = 0; i < head.length; i++) headBytes[i] = head.charCodeAt(i) & 0xff
      const msg = new Uint8Array(saltBytes.length + headBytes.length)
      msg.set(saltBytes, 0)
      msg.set(headBytes, saltBytes.length)
      const hmac = hmacSha256Hex(msg, B._bindKey)
      return 'C1:' + head + ':' + hmac
    },

    // ==================== ★ ② 绑定 / 授权 ====================

    /**
     * ★ ②: 确保当前连接已通过 AUTH challenge-response。
     *   - 已鉴权 → 直接返回 true。
     *   - 无本地 bindKey（本机从未绑定）→ 返回 false（设备将拒绝控制）。
     *   - 有 key → NONCE → 计算 HMAC → AUTH，等待 FF02 回 AUTH:OK/FAIL。
     *   注意：仅用底层 rawSendCommand 发 NONCE/AUTH，避免与 sendCommand 的 ensureSession 递归。
     */
    async ensureSession() {
      if (this.sessionAuthed) return true
      if (!B._bindKey) return false
      // ★ 2026-07-14 修复：AUTH 握手加互斥锁，避免与绑定 AUTH 兜底(_authWithKey)并发争抢
      //   单槽 NONCE/AUTH waiter → 互相覆盖 → 假「验证失败」。锁内再判绑定进行中，主动让出通道。
      const release = await _acquireAuthLock()
      try {
        if (B._bindInProgress) return false  // ★ 绑定进行中，让出通道给 bind 的 AUTH 兜底，避免两路 AUTH 串扰
        if (this.sessionAuthed) return true
        const nonceHex = await this._requestNonce()
        if (!nonceHex) { this.sessionAuthed = false; return false }

        const hmac = hmacSha256Hex(hexToBytes(nonceHex), B._bindKey)
        const p = _waitFor('AUTH')
        let done = false
        const timer = setTimeout(() => {
          if (!done) { done = true; _resolveWaiter('AUTH', false) }
        }, 4000)
        try {
          await enqueueWrite(() => rawSendCommand(this.deviceId, this._authCmd(hmac)))
        } catch (e) {
          clearTimeout(timer)
          _resolveWaiter('AUTH', false)
          return false
        }
        const ok = await p
        done = true
        clearTimeout(timer)
        return ok === true
      } finally {
        release()
      }
    },

    /**
     * ★ 2026-07-12 修复（bug ①）：重连后自动恢复会话鉴权。
     *   仅在「本连接已订阅 FF02 Notify(_statusNotifyReady) + 本机持有 bindKey(B._bindKey)
     *   + 尚未鉴权(sessionAuthed=false) + 无 BIND 进行中 + 仍连接」时触发 ensureSession。
     *   由序列号读取完成 与 _enableStatusNotify(FF02 订阅就绪) 双路径调用，
     *   经 _statusNotifyReady 与 B._autoAuthRunning 双重闸门保证「订阅后才发 NONCE、不重复触发」。
     *   设备端 Bonding_ConnTerminated 每连接清零会话态，故重连必须重 AUTH——此方法让该过程全自动，
     *   消除「重进 APP 还得手动验证绑定」的体验问题。
     */
    _maybeAutoAuth(attempt = 1) {
      if (this.sessionAuthed) { this._autoAuthState = 'idle'; return }
      if (B._bindInProgress || !B._bindKey || !this.connected) return
      if (B._autoAuthRunning) return
      B._autoAuthRunning = true
      const MAX_TRIES = 4
      const run = async () => {
        try {
          // ★ 自愈：FF02 未订阅则先订阅（订阅成功会置 _statusNotifyReady）。
          //   原 800ms 订阅若因 GATT 未就绪静默失败，这里补订阅，避免自动 AUTH 永远不触发。
          if (!this._statusNotifyReady) {
            await this._enableStatusNotify()
            if (!this._statusNotifyReady) {
              if (attempt < MAX_TRIES) { B._autoAuthRunning = false; setTimeout(() => this._maybeAutoAuth(attempt + 1), 1500); return }
              this._autoAuthState = 'failed'
              console.warn('[BIND] FF02 订阅失败，自动会话鉴权无法进行（请手动验证）')
              return
            }
          }
          this._autoAuthState = 'running'
          const ok = await this.ensureSession()
          if (ok) {
            this._autoAuthState = 'idle'
            console.log('[BIND] 自动会话鉴权成功（重连恢复）')
          } else if (attempt < MAX_TRIES) {
            // ★ 一次性短报文被丢弃等瞬时失败 → 重试，避免永久卡"待验证"
            B._autoAuthRunning = false
            setTimeout(() => this._maybeAutoAuth(attempt + 1), 1500)
            return
          } else {
            this._autoAuthState = 'failed'
            console.warn('[BIND] 自动会话鉴权失败（设备可能已解绑/重置，请手动验证）')
          }
        } catch (e) {
          if (attempt < MAX_TRIES) { B._autoAuthRunning = false; setTimeout(() => this._maybeAutoAuth(attempt + 1), 1500); return }
          this._autoAuthState = 'failed'
          console.warn('[BIND] 自动会话鉴权异常:', e?.message || e)
        } finally {
          B._autoAuthRunning = false
        }
      }
      run()
    },

    /** 主动请求一次性 nonce，返回 32 hex 字符或 null */
    async _requestNonce() {
      const p = _waitFor('NONCE')
      let done = false
      const timer = setTimeout(() => {
        if (!done) { done = true; _resolveWaiter('NONCE', null) }
      }, 4000)
      try {
        await enqueueWrite(() => rawSendCommand(this.deviceId, 'NONCE'))
      } catch (e) {
        clearTimeout(timer)
        _resolveWaiter('NONCE', null)
        return null
      }
      const hex = await p
      done = true
      clearTimeout(timer)
      B._lastNonce = hex || null   // ★ P0-2: 记录本次 NONCE，AUTH:OK 时作为会话盐来源
      return hex || null
    },

    /**
     * ★ ②: 解析 FF02 绑定层短报文（BIND:/NONCE:/AUTH:/UNBIND:/DENY:）
     */
    _handleBindingNotify(text) {
      console.log('[BIND] notify:', text)
      B._lastBindRaw = text   // ★ 记录原件，供 bindDevice 失败兜底提示
      if (text.startsWith('NONCE:')) {
        _resolveWaiter('NONCE', text.slice(6))
      } else if (text === 'AUTH:OK') {
        this.sessionAuthed = true
        this._autoAuthState = 'idle'   // ★ 2026-07-12: 会话已建立，自动 AUTH 状态机归位
        this.bindHint = ''
        // ★ 2026-07-14 修复：AUTH 握手成功即证明本机是该设备的 owner
        //   （陌生人/未绑定连接永远到不了 AUTH:OK）。据此清除「未绑定超时被踢」的
        //   持久化抑制标记，恢复后续自动重连（含 App 重启）。否则该标记一旦写入便
        //   永久屏蔽自动重连，导致正常 owner 在重烧固件/瞬时超时后无法自动重连（舒适模式失效）。
        this._clearUnboundKicked()
        // ★ v3.33.0: AUTH 成功 = 安全通道已建立（链路加密 + 会话鉴权均就绪）。
        //   重连时 _finalizeConnection 里的 _syncConfigToDevice 可能因 FF01 加密门控在链路加密前
        //   抢跑失败，此处补发一次，确保断电重启后阈值被可靠回推（T4 核心）。
        //   会话已建立 + 串行化(_configWriteBusy/_configSyncPending)保证不重复、不竞态。
        this._syncConfigToDevice()
        // ★ v3.36(2026-07-17): AUTH 成功后下发本机 RSSI 阈值 → 固件写入「当前 owner」的
        //   rssiUnlock/rssiLock，实现 per-phone 阈值跟随（每台手机用自己的解锁/上锁阈值）。
        this._pushRssiThresholds()
        B._sessionSalt = B._lastNonce      // ★ P0-2: 用本次握手 nonce 作为 C1 会话盐
        B._cmdSeq = 0
        _resolveWaiter('AUTH', true)
      } else if (text.startsWith('AUTH:FAIL')) {
        this.sessionAuthed = false
        B._sessionSalt = null; B._cmdSeq = 0   // ★ P0-2
        /* ★ 2026-07-10 fix：移除 AUTH:FAIL:NO_PEER 误报为"固件过旧"的旧逻辑。
         *   AUTH:FAIL:NO_PEER 可能来自并发/残留的 ensureSession 流（与 BIND 无关），
         *   把 AUTH 失败误判为 BIND 失败会打断正确的 BIND:OK 响应，导致"一绑就失败"。
         *   BIND 的成功/失败仅由 BIND:OK / BIND:FAIL:* 决定。 */
        this.bindHint = '验证失败，请重试'
        _resolveWaiter('AUTH', false)
      } else if (text.startsWith('BIND:OK')) {
        this.isBound = true
        this.bindHint = '绑定成功'
        // ★ 2026-07-14 修复：绑定成功即 owner，清除被踢抑制标记（见 AUTH:OK 处说明）
        this._clearUnboundKicked()
        // ★ 2026-07-14 修复：设备按键复位后重绑，_finalizeConnection 的配置推送可能抢跑失败，
        //   但 _configPushedThisConn 被置 true 挡住后续补推 → uc/lc 不一致。
        //   此处补推配置（_configPushedThisConn 已被 bn=0 检测重置为 false，不会重复）。
        this._syncConfigToDevice()
        // ★ P0-2: BIND:OK 可能内联 C1 会话盐（BIND:OK:<32hex>），提取作为签名盐；旧固件无盐则跳过
        const _bokParts = text.split(':')
        if (_bokParts.length >= 3) B._sessionSalt = _bokParts[2]
        B._cmdSeq = 0
        _resolveWaiter('BIND', true)
        // ★ 配对(bond)已前置到 bindDevice 发 BIND 之前（见 ① 先配对再 BIND），此处不再触发。
      } else if (text.startsWith('BIND:FAIL')) {
        if (text.includes('ALREADY_BOUND')) {
          // ★ 设备已有 owner，提供的码不匹配当前有效码：必须先接管/解绑，再用『修改绑定码』切换
          this.bindHint = '该设备已绑定过。请先用「当前绑定码」(默认123456)绑定以接管，再到『修改绑定码』换成你的自定义码；或先解绑/恢复出厂。'
        } else if (text.includes('NOT_OWNER')) {
          this.bindHint = '需先由原主人绑定'
        } else if (text.includes('SHORT')) {
          this.bindHint = '绑定码长度不合法（至少 6 位）'
        } else if (text.includes('CODE')) {
          // ★ 选项 B：首绑必须匹配当前有效码（全新/恢复出厂=123456；仅解绑本机=旧自定义码）；已绑设备须用当前码接管
          this.bindHint = '绑定码错误：请使用当前有效绑定码（全新/恢复出厂设备为默认码 123456；若仅解绑本机未恢复出厂，则码未重置，需用旧自定义码）。绑定后到『修改绑定码』换自定义码'
        } else {
          this.bindHint = '绑定失败'
        }
        _resolveWaiter('BIND', false)
      } else if (text === 'UNBIND:OK') {
        this.isBound = false
        this.sessionAuthed = false
        B._sessionSalt = null; B._cmdSeq = 0   // ★ P0-2
        /* ★ 2026-07-11 防御：绑定进行中（B._bindInProgress）不在此清空 B._bindKey，
         *   避免并发场景下迟到的 UNBIND:OK 把刚设好的 key 清掉（见 _acquireBindLock）。 */
        if (!B._bindInProgress) B._bindKey = null
        this.bindHint = '已解绑'
        _resolveWaiter('UNBIND', true)
      } else if (text.startsWith('UNBIND:FAIL')) {
        this.bindHint = '解绑失败：需先绑定'
        _resolveWaiter('UNBIND', false)
      } else if (text === 'SETCODE:OK') {
        this.bindHint = '绑定码已修改'
        _resolveWaiter('SETCODE', true)
      } else if (text.startsWith('SETCODE:FAIL')) {
        this.bindHint = '修改绑定码失败' + (text.includes('NO_AUTH') ? '：需先验证' :
          text.includes('NOT_BOUND') ? '：设备未绑定' : '：码长度不合法')
        _resolveWaiter('SETCODE', false)
      } else if (text.startsWith('CMD:FAIL')) {
        // ★ 控制命令被固件拒绝：签名校验失败(NO_SIG/SIG) → 经 B._cmdWaiter 让 sendCommand reject 对应错误码
        let code = 'CMD_FAIL', msg = ERROR_MSGS.CMD_FAIL
        if (text.includes('NO_SIG')) { code = 'NO_SIG'; msg = ERROR_MSGS.NO_SIG }
        if (B._cmdWaiter) { const w = B._cmdWaiter; B._cmdWaiter = null; w({ code, msg }) }
      } else if (text === 'DENY:NOT_BOUND') {
        // 设备当前没有任何 owner（未绑定状态）
        // ★ 2026-07-11 防御：仅在非绑定进行中时清 isBound（避免 SETCODE/改码期间误清导致 UI 翻车）
        if (!B._bindInProgress) {
          this.isBound = false
          this.sessionAuthed = false
          B._sessionSalt = null; B._cmdSeq = 0   // ★ P0-2
        }
        // ★ 本次控制命令被拒（设备无 owner）→ 让 sendCommand reject 为 NOT_BOUND
        if (B._cmdWaiter) { const w = B._cmdWaiter; B._cmdWaiter = null; w({ code: 'NOT_BOUND', msg: ERROR_MSGS.NOT_BOUND }) }
      } else if (text.startsWith('DENY:AUTH_REQ:')) {
        // 控制指令被拒且内联带 nonce → 用本地 key 直接回 AUTH（下一次控制即生效）
        const nonceHex = text.slice('DENY:AUTH_REQ:'.length)
        B._lastNonce = nonceHex   // ★ P0-2: 该 nonce 即本次会话盐来源（AUTH:OK 时采用）
        if (B._bindKey) {
          const hmac = hmacSha256Hex(hexToBytes(nonceHex), B._bindKey)
          rawSendCommand(this.deviceId, this._authCmd(hmac)).catch(() => {})   // ★ v3.36: per-phone AUTH
        } else {
          this.bindHint = '设备未绑定，请先绑定'
        }
        // ★ 本次控制命令未执行（会话失效触发重认证握手）→ 让 sendCommand reject 为 AUTH_REQ，提示稍候重试
        if (B._cmdWaiter) { const w = B._cmdWaiter; B._cmdWaiter = null; w({ code: 'AUTH_REQ', msg: ERROR_MSGS.AUTH_REQ }) }
      } else if (text.startsWith('RESET:ARM')) {
        // ★ 长按恢复出厂（隐藏按键 PB22/BOOT）：开始按住累计 5s 倒计时
        uni.showToast({ title: '保持按住以恢复出厂…', icon: 'none', duration: 2000 })
        this.bindHint = '设备恢复出厂中：请保持按住'
      } else if (text.startsWith('RESET:HOLD')) {
        // 进度通知 RESET:HOLD:NN（连接态可见），仅更新状态提示，避免每跳都 toast
        const _pct = (text.split(':')[2] || '')
        this.bindHint = '恢复出厂倒计时 ' + _pct + '%'
      } else if (text === 'RESET:CANCEL') {
        // 中途松开 → 取消恢复出厂
        this.bindHint = '已取消恢复出厂'
      } else if (text === 'RESET:OK') {
        // 阈值已到，固件即将擦除全部并重启 → 本地状态回到未绑定（连接态偶发收到时即时处理；
        // 若连接已断 RESET:OK 收不到，重连后 status.bn=0 也会触发 _forgetDeviceKey，两端一致）。
        this._forgetDeviceKey('已恢复出厂，请重新绑定')
      } else if (text.startsWith('BIND:TIMEOUT')) {
        // ★ 方案A（2026-07-12）：固件侧未鉴权连接超时强断（防 DoS 占槽）
        //   设备检测到本连接连上 30s 仍未 AUTH/BIND，主动断开并提示重连绑定。
        //   收此消息即抑制自动重连（含原生前台扫描），避免被踢后反复重连刷占连接槽；
        //   用户需手动重连并在 30s 内完成绑定（手动 connect 会重置 reconnectMode 并重启前台服务）。
        this.bindHint = '连接超时未绑定，已断开；如需绑定请重连并于30秒内完成'
        uni.showToast({ title: '连接超时未绑定，已断开', icon: 'none', duration: 3000 })
        this._unboundTimeoutKicked = true
        this.reconnectMode = 'dormant'   // 抑制自动重连；手动 connect 会重置为 idle
        // ★ 2026-07-12 修正②：持久化「被踢的设备」，作为抑制自动重连的兜底。
        //   仅靠内存标记(reconnectMode='dormant'/_unboundTimeoutKicked) 在 App 重启、
        //   原生扫描回调、蓝牙状态事件等路径下可能被重置 → 又去刷占连接槽。
        //   持久化后 _shouldAutoReconnect 会据此拦截，直到用户手动 connect() 才清除。
        try { uni.setStorageSync('keygo_unbound_kicked', this.deviceId || uni.getStorageSync('ble_device_id') || '1') } catch {}
        if (this._foregroundServiceNative) {
          stopNativeBackgroundScan()     // 停止原生后台扫描，避免被踢后反复重连
        }
      }
    },

    /**
     * ★ 方案A（2026-07-12）：BIND 成功后，发起 BLE 配对（bond）。
     *
     * 原理：调用原生插件的 createBond()，触发 Just Works 配对（无需用户输入 PIN）。
     * 配对成功后 LTK 存入 Android KeyStore（手机端）和固件 SNV（设备端），
     * 此后 OS 在每次重连时自动加密链路——无需 App 进程存活。
     *
     * 非阻塞：配对失败不影响绑定已成功（仅暂时无法享受"走近自动解锁"，
     * 仍可通过 App 手动操控。配对成功后会记 log 方便排查）。
     */
    /**
     * ★ 方案A + ①(2026-07-13) + Phase2 passkey(2026-07-15)：BIND 之前先发起 BLE 配对(bond)。
     * 固件已启用 passkey/MITM，配对时系统弹「输入配对码」窗，用户输绑定码完成 MITM 认证；
     * 配对完成后 LINK_ENCRYPTED=true，OS 重连自动加密，走近即解锁（耳机体验）。
     * forceRebond=true 时原生会先 removeBond（设备恢复出厂但手机仍配对的情形），强制重弹 passkey。
     * 内部带超时（默认 30s，给用户输入配对码留时间），超时/失败均 resolve 而非 reject，由调用方决定降级。
     */
    /**
     * ★ 2026-07-15 晚 重写：原生 createBond 已改为【同步阻塞 + 单次 callback.invoke】模式
     *   （旧版异步 invokeAndKeepAlive 被 Weex 在方法 return 时自动 null 收尾，JS 永远只收到 null）。
     *   流程：① 配对前先断开 uni 的 GATT（已 GATT 连接时 OS 的 createBond() 常返回 false 不弹窗）；
     *        ② 调原生 createBond（后台阻塞等 OS 配对广播，最多 30s 给用户输入 passkey），返回单次最终结果；
     *        ③ 配对后重建 GATT 连接，使后续 BIND 写命令有链路（失败也不阻塞，store 自动重连兜底）。
     */
    async _triggerBond(forceRebond = false, timeoutMs = 35000) {
      if (!this.deviceId) return { ok: false, message: '无 deviceId' }
      const fg = uni.requireNativePlugin('Keygo-Foreground')
      if (!fg) return { ok: false, message: '原生插件不可用（标准基座不支持，请用自定义调试基座）' }

      // ★ 2026-07-16: 标记配对进行中，抑制 store 自动重连（否则会抢连 GATT，
      //   导致 createBond 在已连接状态下被系统拒绝、不弹配对窗）。
      this._bondingInProgress = true
      try {
        // ① 断开 GATT，让 OS 能发起系统配对
        try {
          await new Promise((r) => { try { uni.closeBLEConnection({ deviceId: this.deviceId, complete: () => r() }) } catch (e) { r() } })
          await new Promise((r) => setTimeout(r, 600)) // 等 OS 真正拆链，避免与 createBond 竞争
          console.log('[BOND] 已断开 GATT，准备发起系统配对')
        } catch (e) { console.warn('[BOND] 断开 GATT 异常', e) }

        // ② 调原生 createBond，等待单次最终结果（后台阻塞等 OS 配对广播，最多 30s）
        const res = await new Promise((resolve) => {
          let done = false
          const finish = (rr) => { if (!done) { done = true; resolve(rr || { ok: false, message: '无回传' }) } }
          const timer = setTimeout(() => finish({ ok: false, message: '配对超时(>' + timeoutMs + 'ms)' }), timeoutMs)
          fg.createBond({ mac: this.deviceId, forceRebond }, (rr) => {
            console.log('[BOND] 原生返回:', JSON.stringify(rr))
            clearTimeout(timer)
            finish(rr)
          })
        })

        // ③ 配对后重建 GATT 连接（后续 BIND 写命令依赖）；配对成功 OS 常自动加密重连，此处幂等
        try {
          console.log('[BOND] 配对结束，尝试重建 GATT 连接...')
          await this.connect(this.deviceId)
          console.log('[BOND] GATT 连接已重建')
        } catch (e) { console.warn('[BOND] 重建连接失败（store 会自动重连）', e) }

        return res
      } finally {
        this._bondingInProgress = false
      }
    },

    /** 从本地存储恢复 bindKey；存在则置 isBound=true */
    /**
     * UNBIND 联动删 SMP 配对：删除本机系统蓝牙里与 KeyGo 的 OS 配对（SMP bond）。
     * 由原生插件 Keygo-Foreground.removeBond 经反射调用 Android BluetoothDevice.removeBond() 实现。
     * - 设备侧 LTK 已由固件 Bonding_ClearSnvBonds 清掉；本方法补手机侧，使两端都不再认对方。
     * - 仅自定义基座 + 原生插件可用；标准基座 fg.removeBond 不存在 -> 静默跳过（仅靠固件清 LTK 兜底）。
     * - removeBond 会让 OS 主动断开 ACL 链路，故调用期间置 _bondingInProgress 抑制 store 自动重连，
     *   结束后延迟复位（等待 OS 断连事件被抑制），避免解绑后立刻被重连打断体验。
     * @returns {Promise<{ok:boolean,message:string}>}
     */
    async _removeOsBond() {
      if (!this.deviceId) return { ok: false, message: '无 deviceId' }
      const fg = uni.requireNativePlugin('Keygo-Foreground')
      if (!fg || typeof fg.removeBond !== 'function') {
        console.log('[UNBIND] 原生 removeBond 不可用（标准基座），跳过手机端删配对')
        return { ok: false, message: '原生插件不可用（标准基座）' }
      }
      this._bondingInProgress = true
      try {
        const res = await new Promise((resolve) => {
          let done = false
          const finish = (rr) => { if (!done) { done = true; resolve(rr || { ok: false, message: '无回传' }) } }
          const timer = setTimeout(() => finish({ ok: false, message: '删除系统配对超时(>15s)' }), 15000)
          fg.removeBond({ mac: this.deviceId }, (rr) => {
            console.log('[UNBIND] 原生 removeBond 返回:', JSON.stringify(rr))
            clearTimeout(timer)
            finish(rr)
          })
        })
        console.log('[UNBIND] 手机端删系统配对结果:', JSON.stringify(res))
        return res
      } finally {
        // 延迟复位，确保 removeBond 触发的 OS 断连被 store 抑制（不立即重连）
        setTimeout(() => { this._bondingInProgress = false }, 1500)
      }
    },

    _restoreBindKey(sn) {
      if (!sn) return
      try {
        const hex = uni.getStorageSync('keygo_bindkey_' + sn)
        if (hex && hex.length === 32) {
          B._bindKey = hexToBytes(hex)
          this.isBound = true
        }
      } catch (e) { /* 忽略 */ }
    },
    _saveBindKey(sn, keyBytes) {
      try { uni.setStorageSync('keygo_bindkey_' + sn, bytesToHex(keyBytes)) } catch (e) { /* 忽略 */ }
    },
    _clearBindKey(sn) {
      try { uni.removeStorageSync('keygo_bindkey_' + sn) } catch (e) { /* 忽略 */ }
    },

    /**
     * ★ v3.36(2026-07-17) 授权体系 v1：取本机稳定身份 phoneId（8 字节）。
     *   懒生成 + 持久化于 uni storage `keygo_phone_id`；同一台手机同一次装机保持不变，
     *   作为固件信任列表里的 owner 身份锚（取代不可靠的随机私有地址 RPA）。
     *   非密码级随机即可（仅唯一性要求）：用时间戳与 Math.random 混淆降低碰撞概率。
     *   @returns {{hex:string, bytes:Uint8Array}} hex=16 字符十六进制串
     */
    _getPhoneId() {
      if (B._phoneId) return B._phoneId
      let hex = ''
      try { hex = uni.getStorageSync('keygo_phone_id') || '' } catch (e) { hex = '' }
      if (!hex || hex.length !== 16) {
        const b = new Uint8Array(8)
        const t = Date.now()
        for (let i = 0; i < 8; i++) {
          b[i] = (Math.floor(Math.random() * 256) ^ ((t >>> ((i & 3) * 8)) & 0xff)) & 0xff
        }
        hex = bytesToHex(b)
        try { uni.setStorageSync('keygo_phone_id', hex) } catch (e) { /* 忽略 */ }
      }
      B._phoneId = { hex, bytes: hexToBytes(hex) }
      return B._phoneId
    },

    /**
     * ★ v3.36: 构造 AUTH 指令。
     *   fwsec≥2（新固件）：per-phone 格式 `AUTH:<phoneIdHex16>:<hmacHex64>`，
     *     hmac = HMAC-SHA256(nonce, phoneKey)，固件按 phoneId 定位 owner 并校验其 phoneKey。
     *   fwsec<2（旧固件/未知）：遗留格式 `AUTH:<hmacHex64>`（此时本机应持有 gk 而非 phoneKey，
     *     属旧 App 行为；新 App 与新固件配套，正常总走 per-phone 分支）。
     */
    _authCmd(hmac) {
      if (this.fwSec >= 2) {
        return 'AUTH:' + this._getPhoneId().hex + ':' + hmac
      }
      return 'AUTH:' + hmac
    },

    /**
     * ★ v3.36: AUTH 成功后（或配置阈值变更且已鉴权时）下发本机 RSSI 阈值，实现「per-phone 阈值跟随」。
     *   固件把当前已鉴权 owner 的 rssiUnlock/rssiLock 改写为本机配置值并落盘，
     *   之后自动解锁/上锁按「这台手机自己的阈值」判定（不同手机发射功率/天线不同，全局阈值不通用）。
     *   仅 fwsec≥2 生效；经写队列串行化，避免与配置/命令写抢 GATT 通道。回包 RSSISET:OK/FAIL:*。
     */
    _pushRssiThresholds() {
      if (this.fwSec < 2 || !this.deviceId || !this.connected) return
      const cmd = 'RSSISET:' + this.unlockThreshold + ':' + this.lockThreshold
      enqueueWrite(() => rawSendCommand(this.deviceId, cmd)).catch(() => {})
    },

    /**
     * ★ 设备端已解绑（恢复出厂 / 被其他手机解绑）：本机持有的旧密钥已彻底失效。
     *   必须忘记本地密钥并回到首绑界面，否则会拿旧码去 AUTH/SETCODE → FAIL:NOT_BOUND / AUTH_FAIL。
     *   触发来源：① status.bn=0 但本机仍有密钥（最可靠，复位瞬间连接断开 RESET:OK 多半收不到，
     *   但重连后 status 必带 bn=0）；② 收到 RESET:OK（连接态偶发收到时即时处理）。
     *   本函数幂等：已无密钥时直接返回，避免重复弹 toast。
     *   @param {string} reason 提示文案
     */
    _forgetDeviceKey(reason) {
      if (B._bindKey === null && !this.isBound) return   // 已是无密钥态，避免重复 toast
      B._bindKey = null
      this.isBound = false
      this.sessionAuthed = false
      this.deviceBound = false
      B._sessionSalt = null; B._cmdSeq = 0
      if (this.serialNumber) this._clearBindKey(this.serialNumber)
      this.needsRebind = true
      this.bindHint = reason || '设备已重置，请重新绑定'
      uni.showToast({ title: '设备已重置，请重新绑定', icon: 'none', duration: 3000 })
    },

    /**
     * ★ ②: 绑定设备（首绑用默认码；owner 重绑可改码）。
     *   @param {string} code 绑定码（如 "123456"）
     *   @returns {Promise<boolean>} true=绑定成功
     */
    async bindDevice(code) {
      const _release = await _acquireBindLock()
      try {
      if (!this.connected) throwError('NO_CONN')
      let sn = this.serialNumber
      if (!sn) {
        try { sn = await readSerialNumber(this.deviceId, 5000) } catch (e) { sn = '' }
      }
      if (!sn) throwError('NO_SERIAL')

      // ★ 2026-07-11 修复：捕获本次 BIND 前的绑定态。仅当「未绑定→已绑定」跃迁时，
      //   才允许 status.bn=1 兜底确认成功（见下方 status 解析 gating）。设备已绑时，
      //   status.bn=1 不能证明「本次用某码验证成功」，必须只看固件对这条 BIND 的真实回包。
      B._bindConfirmByStatus = !(this.isBound || this.deviceBound)

      /* ★ 2026-07-11 重写：不再只赌单个 BIND:OK 短报文（该包可能被并发写覆盖、或旧固件
       *   下被浅通知队列丢弃）。改为「BIND 写入(串行队列) → 短等 BIND:OK → 兜底走 AUTH 握手」：
       *   BIND 成功后固件 s_bondCount=1，紧接着的 AUTH 握手必然成功 → 确证绑定生效。
       *   此路径不依赖 BIND:OK 是否送达，也不依赖重烧固件，彻底解决"6 秒超时绑不上"。 */
      /* ★ 2026-07-14 方案a：已绑定设备「重绑失败」保持原信任不变。
       *   捕获重绑前的信任态与密钥/会话盐，失败且本机原已绑定时回滚，
       *   避免「输错码重绑」把 owner 的 isBound/sessionAuthed 误清成未绑定——
       *   否则 OS 配对(bond)与本地 key 仍有效，设备侧 RSSI 仍能解锁、App 重启后
       *   _restoreBindKey 又置回 true，形成「显失败却能用」的矛盾体验。 */
      const _wasBound = !!(this.isBound || this.deviceBound)
      const _prevKey = B._bindKey
      const _prevSalt = B._sessionSalt
      const _prevSeq = B._cmdSeq
      const _prevNonce = B._lastNonce

      B._bindInProgress = true
      B._bindKey = null
      this.isBound = false
      this.sessionAuthed = false
      this.bindHint = ''
      B._lastBindRaw = ''   // ★ 清空陈旧回包，使失败提示只反映本次绑定操作
      B._sessionSalt = null; B._cmdSeq = 0; B._lastNonce = null   // ★ P0-2
      _resolveWaiter('AUTH', false)  // 清掉连接时可能残留的 AUTH waiter

      // ★ v3.36(2026-07-17) 授权体系 v1：
      //   gk（组密钥）= SHA256(code||serial)[0:16]，不落盘、可随时由「码+序列号」重算；
      //   phoneKey（本机密钥）= HMAC-SHA256(gk, phoneId)[0:16]，每台手机因 phoneId 不同而不同。
      //   fwsec≥2（新固件）→ 本机存/用 phoneKey，BIND 带 phoneId；否则遗留 gk（兼容旧固件）。
      //   ⚠ 密钥与 BIND 格式必须成对匹配：若对新固件发遗留 BIND（无 phoneId），固件会把 gk 存成
      //     phoneKey，与本机 phoneKey 不一致 → 后续 AUTH 必失败。故一律按 fwSec 分流。
      const phoneId = this._getPhoneId()
      const gk = deriveBindKey(code, sn)
      const _perPhone = (this.fwSec >= 2)
      const key = _perPhone ? derivePhoneKey(gk, phoneId.bytes) : gk
      const bindCmd = _perPhone ? ('BIND:' + code + '\u0000' + phoneId.hex) : ('BIND:' + code)

      // ★ 变量分析诊断：绑定开始即打印固件版本号。
      //   若 fwVersion !== "3.30.2" → 当前烧的不是含「延迟发送 + bn 字段」的新固件，
      //   绑定必失败（旧固件短报文在写回调同步发会被丢）。需 MRS 重编译并重新烧录。
      console.log('[BIND] === 开始绑定 === fwVersion=', JSON.stringify(this.fwVersion),
                  ' sn=', sn, ' 已持有本地key=', !!B._bindKey, ' isBound=', this.isBound)

      // ★ 2026-07-15: usePasskey 偏好门控——仅当用户开启「passkey 配对(舒适进入)」才发起系统配对。
      //   关闭(默认,最大兼容)：跳过配对，绑定码以明文 BIND+AUTH 传输，全平台/标准基座可用，
      //     但无 OS 级加密重连、需 App 在前台/后台维持连接才解锁。
      //   开启：调原生 createBond 弹系统配对窗(需自定义基座+原生插件)，配对成功→OS 加密重连→无 App 也能解锁。
      if (this.usePasskey) {
        // forceRebond：设备无 owner（首绑/恢复出厂后）时强制重绑，确保手机侧旧 bond 被清除并重新弹 passkey。
        const bondRes = await this._triggerBond(!(this.deviceBound || this.isBound))
        if (bondRes && bondRes.ok) {
          console.log('[BIND] ✅ 已配对，链路加密，绑定码将以密文传输')
        } else {
          console.warn('[BIND] ⚠ 配对未完成（', (bondRes && bondRes.message) || '未知', '），绑定码将以明文传输',
            '（若设备此前已配对过则链路本身已加密，仍安全）')
        }
      } else {
        console.log('[BIND] 已关闭 passkey 配对（usePasskey=false）：跳过系统配对，绑定码以明文 + AUTH 传输（全平台可用，但需 App 在场解锁）')
      }

      // 0) ★ 先注册 BIND waiter（关键修复：消除"固件回包早于 waiter 注册"的竞态）。
      //    旧逻辑先写 BIND 再 _waitBind，若固件回包极快可能错过；提前注册 waiter 更稳。
      //    ★ 2026-07-11: 超时 1200→2500ms，吸收观察到的 FF02 通知延迟（固件回包经延迟任务
      //      + 状态通知共享通道，偶发 ~1.7s 延迟），让 BIND:OK 能直接被捕获而非走 AUTH 兜底。
      const bindWaitPromise = _waitBind(2500)

      // 1) 发 BIND（经写队列串行，避免与并发命令抢 GATT 通道导致乱序/覆盖）
      try {
        await enqueueWrite(() => rawSendCommand(this.deviceId, bindCmd))
      } catch (e) {
        _resolveWaiter('BIND', false)   // 写失败释放 waiter，避免 _authWithKey 误用残留
        B._bindInProgress = false
        throw e
      }

      // 2) 等待 BIND:OK（waiter 已在步骤0注册，回包早于此处也不会错过）
      const bindOk = await bindWaitPromise
      // ★ 2026-07-11 修复：BIND 等待结束后清掉兜底开关，避免后续状态包误用本次 BIND 的跃迁标志
      B._bindConfirmByStatus = false

      let bound = (bindOk === true)

      // 3) ★ ②(2026-07-13) 恢复 HMAC 挑战应答兜底：BIND:OK 未达时，
      //    用 NONCE→AUTH(HMAC) 确证绑定已生效，防 BIND:OK 丢包导致"绑上却显示失败"。
      if (!bound) {
        // 给固件一点时间完成 BIND 处理 + Flash 写入
        await new Promise(r => setTimeout(r, 250))
        bound = await this._authWithKey(key)
        if (bound) {
          console.log('[Store] 🔒 BIND:OK 未收到，但 AUTH 握手成功 → 确证绑定已生效（BIND:OK 可能丢包）')
        }
      }

      B._bindInProgress = false

      if (bound) {
        B._bindKey = key
        this._saveBindKey(sn, key)
        this.serialNumber = sn         // ★ 确保 serialNumber 立即可用，verifyBindCode 依赖它做本地 KDF 验证
        this.isBound = true
        this.sessionAuthed = true
        this.bindHint = '绑定成功'
      } else {
        // ★ 2026-07-14 方案a：已绑定设备本次重绑失败 → 保留原信任态，仅换提示语
        if (_wasBound) {
          B._bindKey = _prevKey
          B._sessionSalt = _prevSalt
          B._cmdSeq = _prevSeq
          B._lastNonce = _prevNonce
          this.isBound = true
          this.sessionAuthed = true
          this.bindHint = '绑定码错误，绑定关系保持不变'
        } else {
          this.bindHint = B._lastBindRaw
            ? ('绑定失败，固件回包: ' + B._lastBindRaw)
            : '绑定失败：BIND 写入后固件无回应（BIND:OK 与 AUTH 握手均未确认）'
        }
      }
      return bound
      } finally { _release() }
    },

    /**
     * ★ 2026-07-11: 用给定 key 走 AUTH 握手，确认 bond 是否已写入固件（绑定兜底）。
     *   不依赖 BIND:OK；只要 BIND 真在固件生效（s_bondCount>0 且 key 正确），AUTH 必成功。
     */
    async _authWithKey(key) {
      // ★ 2026-07-14 修复：AUTH 握手加互斥锁，与自动 AUTH(ensureSession)串行，避免争抢单槽 waiter
      const release = await _acquireAuthLock()
      try {
        const nonceHex = await this._requestNonce()
        if (!nonceHex) return false
        const hmac = hmacSha256Hex(hexToBytes(nonceHex), key)
        const p = _waitFor('AUTH')
        let done = false
        const timer = setTimeout(() => {
          if (!done) { done = true; _resolveWaiter('AUTH', false) }
        }, 4000)
        try {
          await enqueueWrite(() => rawSendCommand(this.deviceId, this._authCmd(hmac)))
        } catch (e) {
          clearTimeout(timer)
          _resolveWaiter('AUTH', false)
          return false
        }
        const ok = await p
        done = true
        clearTimeout(timer)
        return ok === true
      } finally {
        release()
      }
    },

    /**
     * ★ ②: 解绑。mode='all' 清空设备信任列表（恢复出厂），否则仅解绑本机。
     *   @returns {Promise<boolean>}
     */
    async unbindDevice(all = false) {
      const _release = await _acquireBindLock()
      try {
      if (!this.connected) throwError('NO_CONN')
      /* ★ 2026-07-11 修复：解绑前先尝试 AUTH 会话鉴权（证明持有密钥）。
       *   但「无法鉴权」有两种良性情况，不能直接报错：
       *     ① 设备端 bond 已丢失（如重启后持久化未生效、或物理恢复出厂）→ s_bondCount==0
       *        → 固件对 UNBIND 会直接回 UNBIND:OK（本就空），应放行并清本地 key。
       *     ② App 本地仍持有 key，仅设备端状态短暂不一致。
       *   故：ensureSession 失败不立即抛错，仍发出 UNBIND 由固件裁决：
       *       UNBIND:OK      → 清本地 key（含「设备已空」的良性情形）
       *       UNBIND:FAIL:NO_AUTH → 确属已绑且验证不过 → 抛错（安全：已绑设备仍需密钥才能解）
       *   安全不变：已绑设备无正确 key 时 UNBIND 仍被固件拒绝。 */
      const authed = await this.ensureSession().catch(() => false)
      const p = _waitFor('UNBIND')
      let done = false
      const timer = setTimeout(() => {
        if (!done) { done = true; _resolveWaiter('UNBIND', false) }
      }, 6000)
      try {
        await rawSendCommand(this.deviceId, all ? 'UNBIND:ALL' : 'UNBIND')
      } catch (e) {
        clearTimeout(timer)
        _resolveWaiter('UNBIND', false)
        throw e
      }
      const ok = await p
      done = true
      clearTimeout(timer)
      if (ok === true) {
        this.isBound = false
        this.sessionAuthed = false
        B._bindKey = null
        if (this.serialNumber) this._clearBindKey(this.serialNumber)
        this.bindHint = '已解绑'
        // ★ UNBIND 联动删 SMP 配对：固件已清设备侧 SNV LTK（Bonding_ClearSnvBonds），
        //   这里再让手机端删系统蓝牙配对（OS 层 SMP），两端合力彻底撤销，使其即便无App模式也无法自动解锁。
        //   标准基座无原生插件时静默跳过，仅靠固件清 LTK 兜底（安全不受影响，仅系统蓝牙列表仍残留）。
        await this._removeOsBond().catch((e) => {
          console.warn('[UNBIND] 手机端删系统配对未成功（设备侧已清 LTK，安全不受影响）', e)
        })
        return true
      }
      // UNBIND 失败：若本就没鉴权成功，说明设备已绑但验证失败（key 不匹配/需重绑）
      if (!authed) {
        const e = new Error(B._bindKey ? '设备验证失败，请重新绑定' : '设备未绑定，请先绑定')
        e.code = B._bindKey ? 'AUTH_FAIL' : 'NOT_BOUND'
        throw e
      }
      return false
      } finally { _release() }
    },

    /**
     * ★ 自定义绑定码：修改当前设备的绑定码（SETCODE 指令）。
     *   流程：先 ensureSession（证明持有旧密钥）→ 发 SETCODE:<newCode> →
     *   收到 SETCODE:OK 后用新码重派生本地 bindKey 并持久化。
     *   此后本机与新连接均用新码派生密钥；旧码（含默认 123456）在设备端失效，
     *   除非执行「恢复出厂(UNBIND:ALL)」重置回 123456。
     *   @param {string} newCode 新绑定码
     *   @returns {Promise<boolean>}
     */
    async changeBindCode(newCode) {
      const _release = await _acquireBindLock()
      try {
        if (!this.connected) throwError('NO_CONN')
        // ★ 2026-07-14 修复（用户实测「复位后改绑定码失败」根因）：
        //   复位/未绑定态本地已无密钥（B._bindKey=null），无法用旧码 AUTH 改码——
        //   固件 SETCODE 强制要求 Bonding_Count()>0（已绑定）。必须先用「绑定」功能设码。
        //   此处给出明确引导，避免神秘失败（旧版只抛通用 NOT_BOUND）。
        if (!B._bindKey) {
          const e = new Error('设备未绑定（可能已恢复出厂），无法修改绑定码，请先使用「绑定」功能设置您的绑定码')
          e.code = 'NOT_BOUND'
          throw e
        }
        // ★ ②(2026-07-13) 恢复 HMAC 前置校验：改码前先 NONCE→AUTH 证明持有当前绑定码，
        //   防止"会话已失效却仍能改码"的边界。失败即拒绝，由用户先用当前码重绑。
        const authed = await this._authWithKey(B._bindKey)
        if (!authed) {
          // ★ 2026-07-14 区分「设备已复位/被解绑」与「当前码输错」：
          //   复位态设备端已无密钥表，用任意旧码 AUTH 都失败 → 应引导「重新绑定」而非「改码」。
          if (!this.deviceBound) {
            const e = new Error('设备已恢复出厂或已解绑，当前绑定码已失效，请先使用「绑定」功能重新绑定')
            e.code = 'NOT_BOUND'
            throw e
          }
          const e = new Error('无法验证当前绑定码（当前码输入有误），请确认后重试')
          e.code = 'AUTH_FAIL'
          throw e
        }
        B._lastBindRaw = ''   // ★ 清空陈旧回包，使失败提示只反映本次操作（避免误显旧 BIND:OK）
        this.sessionAuthed = true
        const p = _waitFor('SETCODE')
        let done = false
        const timer = setTimeout(() => {
          if (!done) { done = true; _resolveWaiter('SETCODE', false) }
        }, 6000)
        try {
          await enqueueWrite(() => rawSendCommand(this.deviceId, 'SETCODE:' + newCode))
        } catch (e) {
          clearTimeout(timer)
          _resolveWaiter('SETCODE', false)
          throw e
        }
        const ok = await p
        done = true
        clearTimeout(timer)
        if (ok === true) {
          // 用新码重派生本地 bindKey 并覆盖持久化
          let sn = this.serialNumber
          if (!sn) { try { sn = await readSerialNumber(this.deviceId, 5000) } catch (e) { sn = '' } }
          if (!sn) { this.bindHint = '修改成功，但读取序列号失败，请重连以刷新密钥'; return true }
          // ★ v3.36(2026-07-17): 用新码重派生本机 phoneKey（固件 SETCODE 已用新 gk 重算所有 owner
          //   的 phoneKey=HMAC(gk,phoneId)，此处保持与之同源）。fwsec<2 遗留模式则仍用 gk。
          const gk = deriveBindKey(newCode, sn)
          const key = (this.fwSec >= 2) ? derivePhoneKey(gk, this._getPhoneId().bytes) : gk
          B._bindKey = key
          this._saveBindKey(sn, key)
          // ★ 改码后固件 s_sessionAuthed 仍=1（基于旧码 nonce 标记），但内部 s_nonceValid=0，
          //   且 slot0 key 已是新码派生。下一次 NONCE→AUTH 用新 key 才能正确通过。
          this.sessionAuthed = true
          this.isBound = true          // ★ 显式置位：防止"修改中"期间 status 抖动导致翻"未绑定"
          this.bindHint = '绑定码已修改，请牢记新码'
          // ★ 用新 key 走一次 NONCE→AUTH，让固件 s_nonceValid/s_sessionAuthed 与新 key 完全同步，
          //   避免后续控车"刚改完码就用旧 session 操作"的歧义。
          try { await this._authWithKey(key) } catch (e) { /* 忽略，保持 sessionAuthed=true */ }
          return true
        }
        this.bindHint = B._lastBindRaw
          ? ('修改失败，固件回包: ' + B._lastBindRaw)
          : '修改绑定码失败：设备未回应 SETCODE（很可能当前固件不支持「修改绑定码」，请重新烧录含 SETCODE 的最新固件）'
        return false
      } finally { _release() }
    },

    /**
     * ★ 本地验证绑定码：deriveBindKey(code,sn) === 本机持有的 B._bindKey。
     *   纯本地计算，零 BLE 往返，用于改码前"证明知道旧码"（不触发 bindDevice 的 isBound 抖动）。
     *   @param {string} code 待验证的绑定码
     *   @returns {boolean}
     */
    verifyBindCode(code) {
      if (!B._bindKey) return false
      let sn = this.serialNumber
      // ★ 防御：serialNumber 为空时主动读一次 FF04（短超时 2s，避免用户等太久）
      if (!sn && this.connected && this.deviceId) {
        return readSerialNumber(this.deviceId, 2000).then(s => {
          if (s) { this.serialNumber = s }
          return this._verifyWithSerial(code, s || sn)
        }).catch(() => false)
      }
      return this._verifyWithSerial(code, sn)
    },
    /** 纯同步 KDF 比对（提取为独立方法，避免串行读 FF04 卡住 UI）
     *  ★ v3.36(2026-07-17): B._bindKey 现为 per-phone phoneKey，故比对目标改为
     *    derivePhoneKey(deriveBindKey(code,sn), phoneId)，与绑定时的派生链一致。
     *    fwsec<2（遗留 gk 模式）时 B._bindKey=gk，直接比 deriveBindKey(code,sn)。 */
    _verifyWithSerial(code, sn) {
      if (!sn || !B._bindKey) return false
      try {
        const gk = deriveBindKey(code, sn)
        const k = (this.fwSec >= 2) ? derivePhoneKey(gk, this._getPhoneId().bytes) : gk
        if (k.length !== B._bindKey.length) return false
        for (let i = 0; i < k.length; i++) { if (k[i] !== B._bindKey[i]) return false }
        return true
      } catch (e) { return false }
    },

    /**
     * ★ v3.27: 开启手动命令冷却（固件端主导保护 + 手机端 RSSI 转发阻断）
     *   真正的保护链在固件端：sendCommand("UNLOCK") → KeyGo_HandleCommand()：
     *     ① g_manualCooldown=1 (cooldownMs 内跳过状态机)
     *     ② g_unlockCounter/g_lockCounter=0 (清零防止累积计数触发自动操作)
     *   ★ v3.7: 冷却时长使用设备同步值 manualCooldownMs，非硬编码 8s
     */
    _beginManualCooldown() {
      this.manualCooldown = true
      if (this._cooldownTimer) clearTimeout(this._cooldownTimer)
      this._cooldownTimer = setTimeout(() => {
        this.manualCooldown = false
        this._cooldownTimer = null
        console.log(`[Store] RSSI 状态机冷却结束 (${this.manualCooldownMs}ms)`)
      }, this.manualCooldownMs)
    },

    /**
     * ★ v3.27: 带节流 + 串行化的命令发送助手
     *
     *   - 未连接 → 抛 {code:'NO_CONN'}，由 UI 提示「未连接，请先连接设备」
     *   - 正在发送另一命令 → 抛 {code:'TOO_FAST'}，提示「操作太频繁，请稍候」
   *   - 连续命令间隔 < CMD_MIN_INTERVAL_MS → 自动等待到最小间隔（真正的防连发）
   *   - GATT 瞬时写冲突(如 GATT_BUSY/10008) → 抛 {code:'CONFLICT'}，提示「指令冲突，请重试」
   *   - 真正连接/其他错误 → 抛 {code:'FAIL'}，提示「发送失败，请检查连接」
     *
     * @param {string} command 命令字符串
     * @param {{cooldown?: boolean}} [opts] cooldown=true 时发起前开启手动冷却（UNLOCK/LOCK 用）
     */
    async _throttledCommand(command, opts = {}) {
      const CMD_MIN_INTERVAL_MS = 600
      if (!this.connected) throwError('NO_CONN')
      if (this._cmdBusy) throwError('TOO_FAST')
      // ★ 立即置位，避免并发 await 期间被重复放行
      this._cmdBusy = true
      try {
        const wait = CMD_MIN_INTERVAL_MS - (Date.now() - this._lastCmdAt)
        if (wait > 0) await new Promise(r => setTimeout(r, wait))
        if (opts.cooldown) this._beginManualCooldown()  // 固件端主导保护（UNLOCK/LOCK）
        await this.sendCommand(command)
        this._lastCmdAt = Date.now()
      } catch (err) {
        if (err && err.code) throw err  // 已知业务错误，直接透传
        // ★ v3.27-fix ①: 区分 GATT 瞬时写冲突 —— 连接其实没断，仅本次写被拒
        //   （快速连点 / 配置下发与命令并发时易触发）。这类不该提示「检查连接」，
        //   改为提示「指令冲突，请重试」，避免用户误以为蓝牙断了。
        if (isGattConflict(err)) throwError('CONFLICT', undefined, err)
        throwError('FAIL', undefined, err)
      } finally {
        this._cmdBusy = false
      }
    },

    /**
     * 车辆控制命令（连接即授权）
     */
    async unlock() {
      await this._throttledCommand('UNLOCK', { cooldown: true })
    },

    async lock() {
      await this._throttledCommand('LOCK', { cooldown: true })
    },

    async trunk() {
      if (!this.connected) throwError('NO_CONN')
      await this._throttledCommand('TRUNK')
    },

    async ride() {
      if (!this.connected) throwError('NO_CONN')
      // ★ Phase 2: 仅 ebike 模式有意义；car 模式提前拦截给友好提示
      //   （固件侧亦有 DENY:NOT_SUPPORTED 兜底，防止被篡改绕过）
      if (this.deviceMode !== 'ebike') throwError('NOT_SUPPORTED')
      await this._throttledCommand('RIDE')
    },

    /**
     * ★ Phase 2: 切换设备模式（汽车/电瓶车）。
     *   经 FF03 签名下发 MODE:car / MODE:ebike（受绑定 + GATT 加密门控），
     *   乐观更新 deviceMode 并写本地缓存（keygo_mode_<serial>）兜底。
     *   设备回状态包(m 字段)后会经 _parseSingleStatus 校正。
     */
    async setDeviceMode(mode) {
      if (mode !== 'car' && mode !== 'ebike') throwError('NOT_SUPPORTED')
      if (!this.connected) throwError('NO_CONN')
      if (this.deviceMode === mode) return   // 无变化，跳过下发
      await this.sendCommand('MODE:' + mode)
      this.deviceMode = mode                 // 乐观更新
      if (this.serialNumber) {
        try { uni.setStorageSync('keygo_mode_' + this.serialNumber, mode) } catch (e) {}
      }
    },

    /** ★ Phase 2: 连接时用本地缓存恢复设备模式（设备 m 上报前即可渲染正确 UI） */
    _loadCachedDeviceMode() {
      if (!this.serialNumber) return
      try {
        const cached = uni.getStorageSync('keygo_mode_' + this.serialNumber)
        if (cached === 'car' || cached === 'ebike') this.deviceMode = cached
      } catch (e) {}
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
          // ★ P0-2: 经 sendCommand 走 C1 签名（NAME:xxx 含 ':'，固件按最后一个 ':' 切分 seq/hmac，body 完整保留）
          await this.sendCommand(`NAME:${name}`)
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
     * ★ v3.27: 防抖——快速连点（comfort→speed→manual）时只保留最后一次生效，
     *   避免并发触发极速模式 GPS/围栏异步任务（孤儿任务）与并发写 BLE 配置。
     *   UI 高亮立即更新（选中态即时反馈），重量级副作用延迟 350ms 在 _applyModeSideEffects 执行。
     *
     * @param {'comfort' | 'manual' | 'speed'} mode
     */
    setAutoReconnectMode(mode) {
      if (!['comfort', 'manual', 'speed'].includes(mode)) {
        console.warn('[Store] 无效的重连模式:', mode)
        return
      }
      const prev = this.autoReconnectMode
      // ★ 立即更新 UI 高亮（卡片选中态即时反馈）
      this.autoReconnectMode = mode
      // 持久化
      try {
        uni.setStorageSync('ble_auto_reconnect_mode', mode)
      } catch {}

      // ★ 防抖：覆盖上一次的待执行副作用，仅最后一次真正执行
      if (this._modeDebounceTimer) clearTimeout(this._modeDebounceTimer)
      this._modeDebounceTimer = setTimeout(() => {
        this._modeDebounceTimer = null
        this._applyModeSideEffects(mode, prev)
      }, 350)
    },

    // ★ 2026-07-15: 设置是否启用 passkey 系统配对（舒适进入 / 无 App 也能解锁）
    //   开启：绑定设备时调起系统配对窗（需自定义基座 + 原生插件 Keygo-Foreground），配对成功即 OS 级加密重连。
    //   关闭（默认，最大兼容）：绑定走明文 BIND+AUTH，任何手机/标准基座可用，但需 App 在前台/后台维持连接才解锁。
    //   仅改 App 行为，固件零改动；持久化到 keygo_use_passkey。
    setUsePasskey(v) {
      this.usePasskey = !!v
      try { uni.setStorageSync('keygo_use_passkey', this.usePasskey) } catch (e) { /* 忽略 */ }
    },

    // ★ 2026-07-16: 设置无 App 模式（固件 SMP 加密门控，基座无关，推荐）
    //   开启：经 FF03 下发 ENCRYPT:1 → 固件 g_encRequired=1 → 配对模式切 INITIATE →
    //   (重)连时固件主动发 Slave Security Request → 系统弹 passkey 窗输系统配对码 → OS 级加密重连。
    //   关闭：下发 ENCRYPT:0 → 回到 WAIT_FOR_REQ → 明文 BIND+AUTH（需 App 维持连接）。
    //   走写队列串行化；置 _noAppModeDirty 标记，连接对账自愈（修复配对抖动期"关不掉"）。
    setNoAppMode(v) {
      const on = !!v
      this.noAppMode = on
      this._noAppModeDirty = true
      if (!this.connected || !this.deviceId) {
        console.warn('[Store] setNoAppMode: 未连接，仅记录期望态，连上后由 status.pair 对账下发')
        return
      }
      enqueueWrite(() => rawSendCommand(this.deviceId, on ? 'ENCRYPT:1' : 'ENCRYPT:0'))
        .then(() => console.log('[Store] 无 App 模式已下发 ENCRYPT:' + (on ? '1' : '0')))
        .catch((e) => console.error('[Store] 下发 ENCRYPT 失败:', e))
    },

    // ★ 方案1 扩展: 设置系统配对码(OS SMP passkey)，与绑定码独立，仅服务于无 App 模式。
    //   必须是 6 位数字；经 FF03 下发 SETPASS:<6位> → 固件存 DataFlash，下次配对时由 PasscodeCB 回传。
    //   本地也持久化一份(keygo_sys_passcode)，便于 UI 提示用户在系统弹窗输入同一码。
    setSysPasscode(code) {
      const c = String(code || '').trim()
      try { uni.setStorageSync('keygo_sys_passcode', c) } catch (e) { /* 忽略 */ }
      if (!this.connected || !this.deviceId) {
        console.warn('[Store] setSysPasscode: 未连接，仅持久化本地，连上后由启用流程下发')
        return Promise.resolve(false)
      }
      return enqueueWrite(() => rawSendCommand(this.deviceId, 'SETPASS:' + c))
        .then(() => { console.log('[Store] 系统配对码已下发 SETPASS:' + c); return true })
        .catch((e) => { console.error('[Store] 下发 SETPASS 失败:', e); return false })
    },

    /**
     * ★ v3.27: 模式切换的副作用（由 setAutoReconnectMode 防抖后调用）
     * @param {'comfort' | 'manual' | 'speed'} mode 目标模式
     * @param {'comfort' | 'manual' | 'speed'} prev 切换前的模式（用于判断是否需要清理极速资源）
     */
    _applyModeSideEffects(mode, prev) {
      console.log(`[Store] 智能重连模式生效: ${prev} → ${mode}`)

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
        this._resetReconnectCounters()
      } else if (mode === 'speed') {
        // ★ Phase 3: 切换到极速模式 → 停止后台轮询，记录当前停车位置
        this._onSpeedModeEnter()
      }

      // ★ v3.24: 模式切换影响自动锁 → 已连接时立即重新下发配置（autolock 跟随模式）
      if (this.connected) {
        this._syncConfigToDevice(true)   // ★ 2026-07-14: force，确保切模式时 autolock 一定重发（不被去重标志挡掉）
      }
    },

    // ==================== ★ v3.23 Phase 3: 极速模式（地理围栏） ====================

    /**
     * 进入极速模式
     *   - 停止所有 BLE 后台轮询
     *   - 优先使用已有停车位置（来自上次"连接成功"或"断连"时记录）
     *   - 只有当完全没有历史停车位置时，才用当前 GPS 作为初始围栏中心
     *   - 启动前台服务 + 后台 GPS 围栏监控
     */
    _onSpeedModeEnter() {
      // ★ v3.27: 可取消守卫——若已进入极速模式的异步流程中途被切走
      //   （防抖取消 / 用户切到别的模式），直接中止，避免残留 GPS/围栏任务停在错误状态
      if (this.autoReconnectMode !== 'speed') {
        console.log('[Store] ⚡ _onSpeedModeEnter 已取消（当前模式非 speed）')
        return
      }
      this._stopDormantPoll()
      if (this._reconnectTimer) {
        clearTimeout(this._reconnectTimer)
        this._reconnectTimer = null
      }
      this._resetReconnectCounters()
      this._geofenceBleTriggered = false
      // ★ v3.25: 重置实时距离状态
      this.geofenceDistance = -1
      this.geofenceDistanceAge = -1
      this.geofenceAccuracy = -1

      // ★ v3.25: 优先读取已有停车位置（来自"连接成功"或"断连"时自动记录）
      const existingParking = getParkingLocation()
      if (existingParking) {
        const ageMs = Date.now() - existingParking.savedAt
        console.log(`[Store] ⚡ 使用已有停车位置 (${(ageMs / 1000).toFixed(0)}s 前): ${existingParking.lat.toFixed(6)}, ${existingParking.lng.toFixed(6)}`)
        this.parkingLocation = existingParking
        if (!this.connected) {
          this._startGeofenceMonitor()
          this._startHeartbeat()
        }
        return
      }

      // ★ v3.25: 无历史停车位置（首次使用极速模式）→ 降级用当前 GPS
      console.log('[Store] ⚡ 无已有停车位置，使用当前 GPS 作为初始围栏中心...')
      this._saveParkingNow().then((saved) => {
        // ★ v3.27: 异步回调里再校验一次，避免在途 GPS 完成后已被切走仍启动围栏
        if (this.autoReconnectMode !== 'speed') {
          console.log('[Store] ⚡ 停车位置保存完成，但已切离极速模式，放弃启动围栏')
          return
        }
        if (saved) {
          this.parkingLocation = getParkingLocation()
          if (!this.connected) {
            this._startGeofenceMonitor()
            this._startHeartbeat()
          }
        }
      })
    },

    /**
     * ★ v3.25.1-fix: APP 重启后恢复极速模式状态
     *
     * 极速模式切换时 _onSpeedModeEnter() 会正确初始化 parkingLocation + 围栏监控，
     * 但 APP 重启时 autoReconnectMode 仅从 storage 恢复字符串值，无人调用 enter 逻辑。
     *
     * 此方法在 index.vue onShow 中调用，确保重启后：
     *   1. parkingLocation 从 localStorage 恢复 → UI 卡片正常显示
     *   2. _startGeofenceMonitor() 启动 → watchPosition 实时距离更新
     *
     * 幂等：已连接 / 已有 parkingLocation / 围栏监控已运行 → 跳过
     * 注意：心跳由 prepareForAutoConnect() 启动，此处不再重复启动
     */
    _restoreSpeedModeState() {
      if (this.autoReconnectMode !== 'speed') return
      if (this.connected) return
      if (this.parkingLocation && isGeofenceMonitorActive && isGeofenceMonitorActive()) return

      const existingParking = getParkingLocation()
      if (!existingParking) {
        console.log('[Store] ⚡ 重启恢复：无停车位置记录，跳过（需先连接一次设备记录位置）')
        return
      }

      const ageMs = Date.now() - existingParking.savedAt
      console.log(`[Store] ⚡ 重启恢复停车位置 (${(ageMs / 1000).toFixed(0)}s 前): ${existingParking.lat.toFixed(6)}, ${existingParking.lng.toFixed(6)}`)
      this.parkingLocation = existingParking
      this.geofenceDistance = -1
      this.geofenceDistanceAge = -1
      this.geofenceAccuracy = -1
      this._geofenceBleTriggered = false
      this._startGeofenceMonitor()
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
     *
     * ★ v3.25-fix: 快速响应策略
     *   1. 先用粗精度 GPS 快速获取（~2-5s），立即保存并通知用户
     *   2. 后台异步用高精度 GPS 静默更新（无需用户等待）
     *   3. 粗精度失败时降级为高精度 GPS（15s 兜底）
     *
     * @returns {Promise<boolean>} 是否保存成功
     */
    async _saveParkingNow() {
      console.log('[Store] 🅿️ 正在获取停车位置（快速模式）...')
      // ★ 第一步：粗精度快速获取（不阻塞用户操作）
      const coarsePos = await getCurrentPositionCoarse()
      if (coarsePos) {
        saveParkingLocation(coarsePos.lat, coarsePos.lng, coarsePos.accuracy)
        this.parkingLocation = getParkingLocation()
        console.log(`[Store] 🅿️ ⚡ 粗精度位置已记录: ${coarsePos.lat.toFixed(6)}, ${coarsePos.lng.toFixed(6)}`)
        uni.showToast({ title: '停车位置已记录 ✅', icon: 'success', duration: 1500 })

        // ★ 第二步：后台静默用高精度 GPS 更新（不阻塞、不显示 toast）
        getCurrentPosition().then(highPos => {
          if (highPos && !isNaN(highPos.accuracy) && highPos.accuracy < 30) {
            // 仅当精度明显更好时才更新（粗精度一般 50-200m）
            saveParkingLocation(highPos.lat, highPos.lng, highPos.accuracy)
            this.parkingLocation = getParkingLocation()
            console.log(`[Store] 🅿️ ✨ 高精度位置已静默更新 (精度 ±${Math.round(highPos.accuracy)}m)`)
          }
        })
        return true
      }

      // ★ 降级：粗精度不可用 → 高精度 GPS（15s，用户需等待但确保拿到位置）
      console.log('[Store] 🅿️ 粗精度不可用，降级为高精度 GPS...')
      const pos = await getCurrentPosition()
      if (!pos) {
        console.warn('[Store] ⚠ 停车位置获取失败（GPS 不可用）')
        uni.showToast({ title: '无法获取位置，请稍后重试', icon: 'none', duration: 2000 })
        return false
      }
      saveParkingLocation(pos.lat, pos.lng, pos.accuracy)
      this.parkingLocation = getParkingLocation()
      console.log(`[Store] 🅿️ 停车位置已记录: ${pos.lat.toFixed(6)}, ${pos.lng.toFixed(6)} (精度 ±${Math.round(pos.accuracy)}m)`)
      uni.showToast({ title: '停车位置已记录 ✅', icon: 'success', duration: 1500 })
      return true
    },

    /**
     * 手动更新停车位置（用户从配置页触发）
     * @returns {Promise<boolean>}
     */
    async saveCurrentParkingLocation() {
      if (this.autoReconnectMode !== 'speed') return false
      const ok = await this._saveParkingNow()
      // ★ v3.25-fix: 保存成功后同步更新响应式状态，确保 config/index 页面实时刷新
      if (ok) {
        this.parkingLocation = getParkingLocation()
      }
      return ok
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
     * ★ v3.25: onPosition → 实时更新 geofenceDistance（供 UI 距离显示）
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

      // ★ v3.25: 同步更新 UI 用的停车位置
      this.parkingLocation = parking

      // ★ v3.25-fix: 立即用缓存坐标初始化距离（避免 "获取中..." 长时间显示）
      const cachedDist = getDistanceToParking()
      if (cachedDist && cachedDist.distance >= 0) {
        this.geofenceDistance = cachedDist.distance
        this.geofenceDistanceAge = cachedDist.age
        console.log(`[Store] ⚡ 缓存距离已初始化: ${cachedDist.distance}m (${(cachedDist.age / 1000).toFixed(0)}s 前)`)
      }

      // 重置触发标记（新一轮监控）
      this._geofenceBleTriggered = false

      // ★ 确保前台服务存活（后台 GPS 监控需要）
      this._ensureForegroundService()

      const started = startGeofenceMonitor(
        // onEnter: 进入围栏
        (distance) => { this._onGeofenceEnter(distance) },
        // onLeave: 离开围栏
        (distance) => { this._onGeofenceLeave(distance) },
        // ★ v3.25: onPosition — 每次 GPS 更新时刷新距离显示
        // ★ v3.25.2: 同时捕获 accuracy 用于误差显示
        (posInfo) => {
          this.geofenceDistance = posInfo.distance
          this.geofenceDistanceAge = 0  // 刚刚更新，年龄为 0
          this.geofenceAccuracy = (posInfo.accuracy != null && posInfo.accuracy > 0) ? posInfo.accuracy : 999
        }
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
      // ★ v3.25: 停止围栏监控时重置距离和精度显示
      this.geofenceDistance = -1
      this.geofenceDistanceAge = -1
      this.geofenceAccuracy = -1
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
    /**
     * ★ v3.25-fix: 围栏 BLE 闩锁查询（带超时自动解锁）
     *
     * 之前 _geofenceBleTriggered 是永久闩锁：一旦在围栏内触发过重连，
     * 只要不走出围栏，心跳/_onGeofenceEnter 就永远被拦截 → 死锁「通知在、连不上」。
     * 现改为带超时的防抖：触发后 GEOFENCE_BLE_LATCH_MS 内视为已锁（防同一进入事件重复点火），
     * 超时后自动解锁，允许后续心跳再次触发重连重试。
     */
    _isGeofenceBleLatched() {
      if (!this._geofenceBleTriggered) return false
      const elapsed = Date.now() - (this._geofenceBleTriggeredAt || 0)
      if (elapsed > GEOFENCE_BLE_LATCH_MS) {
        this._geofenceBleTriggered = false
        console.log(`[Store] ⚡ 围栏 BLE 闩锁超时(${elapsed}ms)自动解锁，允许重连重试`)
        return false
      }
      return true
    },

    async _heartbeatGeofenceCheck() {
      if (this.connected) return           // 已连接，无需检测
      if (this._isGeofenceBleLatched()) return  // BLE 已触发（可能由 watchPosition 触发），未超时则跳过
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
        this._geofenceBleTriggeredAt = Date.now()
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
      if (this._isGeofenceBleLatched()) {
        console.log(`[Store] ⚡ 围栏进入（${distance}m），但 BLE 已触发过，跳过`)
        return
      }
      if (this.connected) {
        console.log('[Store] ⚡ 围栏进入，但已连接，跳过')
        return
      }

      this._geofenceBleTriggered = true
      this._geofenceBleTriggeredAt = Date.now()
      console.log(`[Store] ⚡ 🚀 围栏进入（${distance}m）→ 启动 BLE 扫描`)

      // 重置重连状态，立即启动激进扫描
      this._resetReconnectCounters()
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
      this._resetReconnectCounters()
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
      if (this._isGeofenceBleLatched()) {
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
        this._geofenceBleTriggeredAt = Date.now()
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
