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
  getBLEDeviceRSSI,               // ★ 2026-07-30: 无线电层实时探活（假断连判定）
  onBluetoothAdapterStateChange,
  startScan,
  stopScan,
  connectDevice,
  disconnectDevice,
  sendConfig,
  sendCommand,
  onBLEConnectionStateChange,
  registerNotifyWaiter,
  notifyBLECharacteristicValueChange,
  arrayBufferToString,
  tryParseJSON,
  extendConnectGrace,
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
// ★ v3.36.3fix11.4 (2026-07-25) —— Problem B 修正
//   死滚动根因：4 个 tab 页根原 min-height:100vh，但真实滚动容器 main.vue 的 scroll-view
//   高度 = 100vh − 顶部 BtStateBanner − 底部 custom-tabbar，页内容永远比可视区高
//   banner+tabbar≈100~150px 的“可滚动空白”（未连接时内容短，用户下滑滑的就是这段背景）。
//   fix11.3 把 banner 从 index.vue 内联提到 main.vue 固定头后，banner≈50px 不再参与滚动，
//   反而使该空白翻倍（≈100px+），连/控两页下滑空白感更明显（属 fix11.3 回归，本提交补回）。
//   修法：index/control/config/help 4 个页根 min-height:100vh → 100%，并设 box-sizing:border-box 使 100% 已含纵向 padding，
//   可视区：内容短=零死滚，内容长=正常滚；不动 scroll-y、不动 swiper 手势，低风险。
// ★ ② 诊断日志保留 v3.36.3fix11.4-DIAG（用户决策：不随本次顺延，仅作 ② 复现定位用）。
//   命名规则：fix 系列按 v3.36.3fix11.(x+1) 递增。fix11.5 预留给未做的 ② reconcile(btState on→off 被覆盖)。
//   fix11.6 (2026-07-25, 未commit): P0+A1 红绿 banner 同显 ①+② 运行时门控 + A2 已知设备卡 v-show→v-if +
//   B1 设备绑定验证失败红色徽章。纯 JS/CSS 改动，未升 manifest versionCode。
export const APP_VERSION = 'v3.36.3fix11.6'   // ★ v3.36.3fix11.6 (2026-07-25)
console.log('[KeyGo] App version', APP_VERSION)

// ★ 原生前台服务 kill-switch（长期安全开关，非临时止血）：
//   false（默认）= 启用原生 Keygo-Foreground 前台服务（后台重连主路径，见 _ensureForegroundService :812）；
//   true  = 强制回退纯 JS 前台服务，用于某 ROM 上原生插件崩溃时的兜底/调试。
//   历史：2026-07-09 曾因配对后原生服务崩溃临时置 true 止血，根因修复后恢复 false，并保留为常驻开关。
const __DISABLE_NATIVE_FG = false

// ★ 2026-08-13 绑定验证热身延时(ms): 连接成功后、发首帧 NONCE(FF03 写)前的固定等待。
//   深度修正（最终版）：实测证明"固定热身"会拖慢首连——首连链路本身已慢(readSerialNumber 真实读
//   + 800ms 订阅延时)，底层写属性在 T+0~400ms 早已热透，再等 800ms 纯属白等。
//   故此处设 0：NONCE 尽早发射。首连首枪即中（零影响）；重连因链路紧凑、属性冷会首枪 10007，
//   改由 _requestNonce 内部的【递增退避】(0/400/800/1200/1600ms)跨过 ~1.6s 冷窗口，且每轮之间
//   写链空闲(电池/配置读可插入,不霸链)。_enableStatusNotify 与 _finalizeConnection 共用此值。
const AUTH_WARMUP_MS = 0

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
import { enqueueWrite, enqueueRead, isGattConflict } from '@/utils/command-queue.js'
// ★ 用户可读错误文案集中管理（提取到 utils/readable-errors.js）
import { throwError, ERROR_MSGS } from '@/utils/readable-errors.js'
// ★ ②: 绑定层模块级状态（提取到 stores/ble-binding.js，通过 B 命名空间对象访问）
import { B, _waitFor, _resolveWaiter, _acquireBindLock, _acquireAuthLock, _waitBind, BIND_DISCONNECTED, _flushBindWaiters } from './ble-binding.js'

// ★ 2026-07-24: 显示流合并（staging）——非响应式暂存，避免后台/重连 burst 逐包直写导致回放/狂跳。
//   仅「显示字段」暂存；连接态/命令确认/绑定对账/无App模式/电量等控制流副作用仍即时（见 _parseSingleStatus）。
let _stagedDisplay = null        // 最新一包解析出的显示字段（last-value-wins 覆盖）
const _DISPLAY_COMMIT_TICK = 100 // 合并提交节拍(ms)：≤100ms 内提交最新值 → burst 自动合并为 1 次渲染
let _displayCoalescer = null     // setInterval 句柄（懒启动，常驻，无包时 no-op）

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
    deviceState: 'LOCKED',        // LOCKED / UNLOCKED / RIDE / ACTION
    deviceMode: 'car',            // ★ Phase 2: 设备模式 'car' / 'ebike'（权威来自设备状态 m，本地缓存兜底）
    rssi: -999,
    filteredRssi: -999,
    displayRssi: -999,            // ★ v3.31.0 / 2026-07-13: 平滑+节流后的显示用 RSSI（UI 绑定此值，杜绝后台噪值狂跳）
    rawRssiDisplay: -999,         // ★ 2026-07-24: 受节流的「原始 RSSI」展示副本（=固件上报 r），与 displayRssi 同节流窗口。
                                    //   仅用于 info-grid 诊断展示，避免每条 FF02 直写导致控制页高频重渲染、destabilize swiper 手势（晃动）。
    rssiEma: -999,                // ★ 内部：displayRssi 的 EMA 累加器（仅 >-900 时视为有效）
    batteryLevel: -1,             // ★ v3.14: 电池电量 0~100, -1=未知
    autoLockEnabled: -1,          // ★ v3.24-fixb: 固件自动锁使能状态(FF02 al 字段)，-1=未知/未同步，0=关闭(手动模式)，1=开启
    keyPowerMode: -1,             // ★ 2026-08-14: 钥匙供电策略(FF02 kpm 字段), -1=未同步, 0=TIMEOUT(15s), 1=HOLD_UNTIL_LOCK(默认)
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
    // ★ v3.36.1: 内部芯片温度（摄氏度整数），固件 TSENSE 采样经 FF02 status "t" 字段上报；
    //   null = 尚未收到（旧固件无此字段），UI 据此决定是否显示温度。
    deviceTempC: null,
    unlockProgress: 0,            // 当前解锁进度计数（连续几次滤波 RSSI 在解锁区）
    lockProgress: 0,              // 当前锁车进度计数
    thresholdZone: 0,             // 当前区间：0 中性 / 1 解锁区 / 2 锁车区
    showProgressCard: false,      // ★ v3.31 方案B-修正: 连接页是否显示「确认进度」卡片（手机端偏好，不下发设备）
                                     //   2026-07-24 改为默认 false：首次安装/清存储的用户默认【不显示】进度卡片，
                                     //   避免一进连接页就被进度条/诊断信息占据。已手动开启过的用户由
                                     //   ble.js:564（saved.showProgressCard !== undefined）恢复其偏好，不受影响。

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

    // ★ 2026-07-19: 电瓶车「靠近直接进入骑行模式」偏好（固件 g_ebikeProxMode 镜像）
    //   ebikeProxMode = 用户期望态/设备实时态(0=仅解锁[默认] / 1=骑行)；_ebikeProxDirty = 自上次切换后设备是否已应用(对账自愈用)。
    //   仅为控制面板：真正执行「靠近解锁/骑行」的是固件 RSSI 状态机，故偏好须下发并持久化到固件。
      ebikeProxMode: 0,
      _ebikeProxDirty: false,
      // ★ 2026-07-19 P1: RSSISET 去重缓存——记录上次成功下发的 per-phone 阈值(unlock/lock)。
      //   阈值已持久化于设备 Flash，未变化时跳过重复写（省一次 GATT 写 + 消除 AUTH 宽限期内 10007 瞬时窗口日志）。
      //   仅在设备复位(_forgetDeviceKey / bn=0)时清零，强制重绑后首推；重连不重置(per-phone 存 Flash 不丢)。
      _lastPushedUnlock: null,
      _lastPushedLock: null,
      // ★ 2026-08-12 合并版: GATT 写就绪标志 + AUTH:OK 后挂起写队列。
      //   加密握手刚完成时 OS 对 FF01/FF03 的 WRITE 属性缓存可能尚未就绪（瞬时窗口），
      //   此刻硬写必撞 10007 并触发无效重试。正确做法是「等 AUTH:OK 后首帧 FF02 到达」再写——
      //   FF02 能送达 = GATT 通道完全可用 = OS 属性缓存已刷新，10007 概率趋零。
      //   _gattWriteReady=false 表示尚未收到首帧 FF02；_postAuthWritesPending 表示 AUTH:OK 后
      //   有配置/RSSI 写挂起待发；_postAuthWriteTimer 是 800ms 超时兜底（首帧 FF02 不来也强制发）。
      _gattWriteReady: false,
      _postAuthWritesPending: false,
      _postAuthWriteTimer: null,
      // ★ 2026-08-13 第七刀: 「AUTH:OK 后下发链」是否仍在进行中（含 FF01 写完后 250ms 才发的 FF03 尾巴）。
      //   _postAuthWritesPending 在 flush 一开始就置 false，不足以表达「整条链收尾」，故独立此标志。
      //   电池兜底读取(_fetchBatteryLevel) 据此让位，避免 read 抢占 Android 单一 GATT 事务槽。
      _postAuthWritesInFlight: false,

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
    _charUnregister: null,         // ★ 2026-07-19: FF02 状态 waiter 的取消注册函数（不再直接 uni.offBLECharacteristicValueChange）
    _btAdapterHandler: null,       // ★ v3.11: Uni-APP 适配器监听（iOS 主驱 / Android 降级）
    _notifyBuffer: '',
    _notifyTimer: null,
    _reconnectGuard: 0,            // 重连会话锁，蓝牙关闭时递增
    _reconnecting: false,          // ★ 2026-07-30: 重连并发守卫，防止多条重连路径同时进入踩状态
    _reconnectPromise: null,       // ★ 2026-07-30: 进行中的重连 Promise（重入时复用，避免假成功/重复连接）
    _bondingInProgress: false,     // ★ 2026-07-16: 配对(_triggerBond)期间断开 GATT 让 OS 配对，抑制 store 自动重连
    _deviceNames: null,            // ★ v3.8: { [SN]: { name, lastSeen } } 设备名称本地缓存，null=未加载
    _customNamesByMac: (() => { try { return uni.getStorageSync('ble_device_custom_names') || {} } catch (e) { return {} } })(), // ★ v3.36.3-fix5: 按 MAC 索引的本机自定义名副本(由 customDeviceName 持久化而来)，供断连后的扫描列表/重连卡统一显示
    _advertisedNames: (() => { try { return uni.getStorageSync('ble_advertised_names') || {} } catch (e) { return {} } })(), // ★ 2026-07-23: 设备真实广播名(扫描拿到)按 MAC 持久化，作为出厂名"真相"(与手机蓝牙列表一致)
    knownDevices: (() => {  // ★ 2026-07-23 ②: 所有连过的设备集合 { [cleanMac]: { mac, lastConnectedAt } }，持久化 ble_known_devices
      try {
        const map = uni.getStorageSync('ble_known_devices') || {}
        // 兼容旧数据：升级前只记了单值 ble_last_device_id，补入集合，避免老用户"已知设备"空列表
        const legacy = uni.getStorageSync('ble_last_device_id') || ''
        if (legacy) {
          const k = legacy.replace(/:/g, '').toUpperCase()
          if (!map[k]) map[k] = { mac: legacy, lastConnectedAt: 0 }
        }
        return map
      } catch (e) { return {} }
    })(),
    defaultDeviceId: (() => { try { return uni.getStorageSync('ble_default_device_id') || '' } catch (e) { return '' } })(), // ★ 2026-07-23 ④: 用户标记默认设备(cleanMac)，持久化 ble_default_device_id
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
    _lastFf02AnyMs: 0,            // ★ v3.31.0 / 2026-07-13(2026-07-30 改名): 最近一次收到任意 FF02 包的时间戳（连续无包判 stale / 断连活性判别用，每包刷新）
    _lastRssiDisplayMs: 0,        // ★ v3.31.0 / 2026-07-13: 最近一次写入 displayRssi 的时间（节流用）
    _rssiStaleWatchdog: null,     // ★ v3.31.0 / 2026-07-13: 连续无 FF02 看门狗定时器
    // ★ v3.25-fix2: GATT 上下文重建中标志，防止看门狗与重连逻辑并发触发多次重建
    _repairing: false,
    // ★ 2026-08-17 (P-FF02): FF02 到达验证看门狗（订阅成功后 3s 探测 → 重订阅 → 拆链重建）
    _ff02ArrivalTimer: null,
    _ff02ProbeRunning: false,
    _ff02SilentRepairs: 0,   // 连续"订阅/重订阅后仍无 FF02"次数，收到 FF02 清零
    _disconnectProbing: false,     // ★ 2026-07-30: 断连事件后「FF02 活性缓刑」进行中
    _disconnectProbeTimer: null,   // ★ 2026-07-30: 活性缓刑定时器

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
      const map = { 'LOCKED': '已锁车', 'UNLOCKED': '已解锁', 'RIDE': '骑行模式', 'ACTION': '执行中...' }
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

    // ★ 2026-07-22: 已知设备持久记忆，仅用于"重新连接"按钮/系统连接复用依据。
    //   与 ble_device_id（自动重连记忆）刻意分离：手动断开只删 ble_device_id（不自动冷启重连），
    //   本 key 始终保留 → 断连后/杀App后仍可一键接管，且绝不被自动重连路径读取（自动路径只读 ble_device_id）。
    knownDeviceId() {
      return this.lastDeviceId || uni.getStorageSync('ble_last_device_id') || ''
    },

    // ★ 2026-07-23 ②: 已知设备列表（用于"重新连接"卡片，多设备展开为列表）。
    //   排序：默认设备置顶(④) > 最近连接时间倒序。每项含展示名/自定义名/MAC/是否默认。
    //   单设备时返回长度为 1，UI 退化为单卡(与现状一致)；≥2 台展开为可滚动列表。
    knownDevicesList() {
      const arr = Object.keys(this.knownDevices || {}).map(k => {
        const d = this.knownDevices[k]
        const custom = this.customNameForMac(d.mac)
        const factory = this._resolveFactoryName(d.mac)
        return {
          mac: d.mac,
          customName: custom,
          displayName: custom || factory,
          lastConnectedAt: d.lastConnectedAt || 0,
          isDefault: (this.defaultDeviceId || '').replace(/:/g, '').toUpperCase() === k,
        }
      })
      const def = (this.defaultDeviceId || '').replace(/:/g, '').toUpperCase()
      arr.sort((a, b) => {
        if (a.mac.replace(/:/g, '').toUpperCase() === def) return -1
        if (b.mac.replace(/:/g, '').toUpperCase() === def) return 1
        return b.lastConnectedAt - a.lastConnectedAt
      })
      return arr
    },

    // ==================== 2026-07-23 设备命名 / 出厂名 / 已配对 功能组 ====================
    // 【背景】固件 peripheral.c 用 g_deviceMac[3..5] 生成广播名 "KeyGo-XXXXXX"，而 GetMACAddress 从
    //   WCH ROM 读出的是【小端】MAC（[0]=末字节 … [5]=首字节），故 [3][4][5] = 公网 MAC 前 3 字节反转。
    //   例: 公网 MAC 0C:3D:5E:A6:5F:90 → 广播名 KeyGo-5E3D0C（与手机蓝牙列表一致）。
    //   旧代码用 macClean.slice(-6)（末 3 字节）得到 A65F90，与固件/手机蓝牙列表错位，本次修正。
    // 【本组包含】
    //   ① knownDeviceName / connectedDisplayName —— 重连卡/连接态展示名，格式「自定义名 ( 出厂名 )」
    //   ② controlTopName —— 控制页车辆大卡顶部专用，只显示自定义名(不带括号)，未命名回退出厂名
    //   ③ _factoryNameForMac / _resolveFactoryName —— 由 MAC 推算/解析出厂名，与固件公式一致
    //   ④ _advertisedNames + _rememberAdvertisedName —— 扫描时记忆真实广播名(按 MAC 持久化)
    //   ⑤ _formatDisplayName —— 组合「自定义名 ( 出厂名 )」
    //   ⑥ isPairedDevice —— 本机已配对(连过)设备判定，供扫描列表「✓ 已配对」徽章

    // 已知设备展示名：优先自定义名 > 出厂名，组合为「自定义名 ( 出厂名 )」（用于重连卡）
    knownDeviceName() {
      const id = this.knownDeviceId
      if (!id) return ''
      const custom = this.customNameForMac(id)
      const factory = this._resolveFactoryName(id)
      return this._formatDisplayName(custom, factory)
    },

    // 按 MAC 查本机自定义名(由 customDeviceName 持久化而来)；返回函数供模板传参，供扫描列表/重连卡/"已命名"徽章统一使用
    customNameForMac: (state) => (mac) => {
      if (!mac) return ''
      const key = mac.replace(/:/g, '').toUpperCase()
      return state._customNamesByMac[key] || ''
    },

    // 本机已配对(曾连接/使用)设备判定，供扫描列表「✓ 已配对」徽章。
    // 以 knownDeviceId(本机连过的设备) 为准——与 OS 绑定意涵一致，且避免把扫到的陌生设备误标。
    // ★ 优化：复用 knownDeviceId getter，避免重复读 storage。
    isPairedDevice: (state) => (mac) => {
      if (!mac) return false
      const key = String(mac).replace(/:/g, '').toUpperCase()
      const known = (state.knownDeviceId || '').replace(/:/g, '').toUpperCase()
      return !!known && key === known
    },

    // 连接态展示名：有自定义名 → 「自定义名 ( 出厂名 )」；否则出厂名（用于连接态顶部/扫描列表等）
    connectedDisplayName() {
      if (this.customDeviceName) {
        const factory = this.deviceName || (this.deviceId ? this._resolveFactoryName(this.deviceId) : '')
        return this._formatDisplayName(this.customDeviceName, factory)
      }
      if (this.deviceName) return this.deviceName
      if (this.deviceId) return this._resolveFactoryName(this.deviceId)
      return ''
    },

    // 控制页车辆大卡顶部专用名：只显示自定义名(不带「( 出厂名 )」后缀)，未命名时回退出厂名。
    // 与 connectedDisplayName 的区别：大卡顶部空间紧凑，不重复展示出厂名，避免信息冗余。
    controlTopName() {
      if (this.customDeviceName) return this.customDeviceName
      return this.connectedDisplayName
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

    isUnlocked: (state) => state.connected && (state.deviceState === 'UNLOCKED' || state.deviceState === 'RIDE'),

    // ★ Phase 2: 双模式派生状态
    isEbike: (state) => state.deviceMode === 'ebike',
    deviceModeLabel: (state) => state.deviceMode === 'ebike' ? '电瓶车' : '汽车',

    /* ★ v3.15: 电池图标 — emoji 方案（默认启用）
     *   若想切换为 CSS 组件，修改 control.vue 模板中的电池区域
     *   （CSS 组件标记了 v3.15-css，注释掉 emoji 行即可启用） */
    batteryIcon: (state) => {
      if (state.batteryLevel < 0) return '❓'   // 未知（连接重置后 / 超时未取）
      if (state.batteryLevel === 255) return '🔋' // 固件声明不支持电量（如 V03 无 ADC），用电池图标 + "不支持"文案表达，比 🚫 更明确
      if (state.batteryLevel >= 75) return '🔋'
      if (state.batteryLevel >= 50) return '🔋'
      if (state.batteryLevel >= 25) return '🔋'
      return '🪫'
    },

    // ★ v3.14: 电池颜色 class（用于 CSS 动态色）
    batteryColor: (state) => {
      if (state.batteryLevel < 0) return 'batt-unknown'
      if (state.batteryLevel === 255) return 'batt-unsupported' // V03 无 ADC：不支持电量
      if (state.batteryLevel >= 75) return 'batt-high'
      if (state.batteryLevel >= 25) return 'batt-mid'
      return 'batt-low'
    },

    // ★ v3.14: 电池文字（百分比 / "---" 未知 / "不支持"）
    batteryText: (state) => {
      if (state.batteryLevel < 0) return '---'
      if (state.batteryLevel === 255) return '不支持' // 固件明确无电量采集能力
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
          //   ★ 2026-07-25 收敛日志：旧版全局配置在每次进出配置页都会恢复（active 翻转触发），
          //     重复打印无意义且会淹没真实日志；仅首次打印，后续静默恢复。
          if (source !== '旧版全局' || !this._globalRestoreLogged) {
            console.log('[Store] 配置已恢复 (' + source + '):', JSON.stringify(saved))
            if (source === '旧版全局') this._globalRestoreLogged = true
          }
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
          // ★ 2026-08-16 关键修复（来自 23:56:43~23:57:26 循环复盘）：
          //   _repairConnection 主动 closeBLEConnection 重建 GATT 时，会触发本断连事件。
          //   旧逻辑把它当"真断连"→ 缓刑→ 真断→ 重连→ 又连上→ 又被 _repairConnection 拆→
          //   死循环（连接其实好的，是被自己拆坏的）。此处：_repairing 期间豁免，不进断连判定。
          if (this._repairing) {
            console.log('[Store] 收到断连事件但 _repairing 中（_repairConnection 自伤拆链），豁免')
            return
          }
          console.log('[Store] 收到断连事件（全局监听器），系统级确认是否真断连')
          // ★ 2026-07-25 修复（MP/Android 假断连）：BLE 栈在连上后/锁屏后可能多发一次 false 事件，
          //   但 GATT 实际仍活（控件仍可用、RSSI 仍显示）。若直接 _handleDisconnect 会立即把
          //   connected 翻 false → 控制页"已知设备"卡重现、deviceState 被误复位、状态错乱。
          //   故先系统级确认设备真不在已连接列表，才执行真正断连；否则判定为假断连忽略。
          this._verifyThenDisconnect(deviceId)
        } else if (!this.connected) {
          // ★ fix: 连接已建立但 store 状态未同步（如 _doReconnect guard 失效导致跳过回写）。
          //   底层 BLE 连接已活，但 store 未设置 connected=true，notify 未注册，RSSI 不会显示。
          console.log('[Store] 连接已建立（全局监听器补位），同步状态...')
          // ★ 2026-08-16 紧急修复（来自 23:26:36 日志复盘）：
          //   设备重启后重连，底层 connected=true 经"全局监听器补位"路径到达，但 _finalizeConnection
          //   的 _connFinalizedFor 幂等守卫(上一轮 deviceId)会拦截 → 初始化被跳过 → 不读SN/不订阅FF02/
          //   不AUTH → 连接空壳 → 固件立即踢 → 连上即断、永久连不上。
          //   _doReconnect 路径已清守卫(见 L2394)，但本补位路径没清 → 漏了。此处 store 认为未连接
          //   (connected=false) 即代表这是新会话，必须清守卫放行重新初始化。
          this._connFinalizedFor = null
          this._finalizeConnection(deviceId)
        }
      })

      // ★ 2026-07-19: 改用单一全局 notify handler + waiter 分发（见 utils/ble.js），
      //   不再直接 uni.on/offBLECharacteristicValueChange，避免微信小程序里误删 FF02 主 handler。
      // Notify 分包拼接缓冲区
      this._charUnregister = registerNotifyWaiter(BLE_CONFIG.statusCharUUID, (res) => {
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
          const _SHORT_PREFIX = ['BIND:', 'NONCE:', 'AUTH:', 'UNBIND:', 'DENY:', 'SETCODE:', 'CMD:', 'SETPASS:', 'ENCRYPT:']
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
        // ★ 2026-08-09 (P0-①): 扩展合法值域 — 255=固件声明不支持电量(V03无ADC)，需单独识别，不能走 <=100 分支
        if (res.deviceId === this.deviceId &&
            (res.characteristicId || '').toUpperCase() === BATT_SERVICE.levelCharUUID.toUpperCase()) {
          try {
            const level = new Uint8Array(res.value)[0]
            if (level === 255) {
              this.batteryLevel = 255
              console.log('[Store] 电池电量: 固件不支持 (255)')
            } else if (level <= 100) {
              this.batteryLevel = level
              console.log('[Store] 电池电量更新 (Notify):', level + '%')
            }
            // level 为 101~254 之间非法值 → 忽略，保持当前态（连接重置后为 -1 → 显示 ---）
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
        // ★ [A1-DIAG] 诊断：确认 MP 上 _nativeBtMonitorActive 是否意外为 true（nativeState=11→just_enabled）
        console.log('[A1-DIAG] 原生广播初始化 btState | nativeState=' + nativeState + ' → ' + this.btState + ' | plus=' + (typeof plus))
        if (this.btState === 'just_enabled') console.log('[A1-DIAG][STACK] 739 设 just_enabled\n' + new Error().stack)
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
      if (this._charUnregister) {
        try { this._charUnregister() } catch {}
        this._charUnregister = null
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
        // ★ [A1-DIAG] 诊断：坐实 state=11 是否在真机被触发、plus 是否存在
        console.log('[A1-DIAG] _onNativeBtStateChange state=11 触发 | plus=' + (typeof plus) + ' os=' + (typeof plus!=='undefined'&&plus.os?plus.os.name:'?'))
        // ★ STATE_TURNING_ON: 用户刚点"允许"，系统正在开启蓝牙 → 绿色 banner
        // ★ MP/非 Android 纵深防御：此回调仅 Android 原生广播可达，纯小程序(iOS/微信)
        //   理论上不会进入；但真机 MP 曾误触发导致绿 banner 与红 banner 同显。
        //   运行时门控：非 Android 环境直接 return，绝不设置 just_enabled。
        if (typeof plus === 'undefined' || plus.os.name !== 'Android') return
        this.btState = 'just_enabled'
        console.log('[A1-DIAG][STACK] 829 设 just_enabled\n' + new Error().stack)
      } else if (state === 12) {
        // ★ STATE_ON: 蓝牙完全开启 → 无 banner，尝试重连
        this.btState = 'on'
        // ★ 冷启动修复：蓝牙开启（含 App 启动时 BT 才打开 / 手动开启）即尝试自动连，
        //   不再限定 reconnectMode==='paused'。dormant(用户主动断开)/已连接/BT 关 由闸门拦截。
        if (!this.connected && this._shouldAutoReconnect(true)) {
          // ★ 2026-08-16 关键修复：蓝牙恢复唤醒路径忽略 keygo_unbound_kicked 持久化拦截。
          //   该标记只应阻止「首次自动发起」(见 connect()/异常断连路径)，绝不可拦截「已在进行中、
          //   因蓝牙瞬时抖动而 paused 的重连会话恢复」——否则 paused + kicked 互斥 = 重连永久卡死
          //   （即 23:36:53 status:22 后连接彻底停摆的真凶）。
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
      // ★ [A1-DIAG] 诊断：坐实 MP 上真正的 btState 驱动路径（Uni 事件）及其 available 值
      console.log('[A1-DIAG] Uni 适配器事件 | available=' + available + ' 当前btState=' + this.btState + ' | plus=' + (typeof plus))
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
      // ★ 2026-08-16：唤醒路径忽略 keygo_unbound_kicked，避免 paused 会话永久卡死
      if (available && !this.connected && this._shouldAutoReconnect(true)) {
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
      // ★ 2026-07-30: 防御性收起可能残留的"连接中..." loading——蓝牙关闭瞬间若正有连接进行中，
      //   createBLEConnection 可能长时间不回调，手动连接页的 showLoading 会卡住。由 connectDevice
      //   的硬超时(12s)最终也会 reject 收口，这里立即清掉避免视觉卡死。
      try { uni.hideLoading() } catch (e) {}
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
      this._connFinalizedFor = null   // ★ 方案A (2026-07-18): 断连重置初始化幂等守卫，允许重连重新初始化一次
      this.deviceState = 'LOCKED'
      this.batteryLevel = -1           // ★ 对称性修复：蓝牙关闭时也要清零电量（_handleDisconnect 已重置，此处补齐，避免未连接仍显示旧电量）
      this.deviceTempC = null          // ★ 对称性修复：同步清零芯片温度（与 _handleDisconnect 对齐）
      this.rssi = -999
      B._sessionSalt = null; B._cmdSeq = 0; B._lastNonce = null   // ★ P0-2: 断连重置签名会话态
      this.filteredRssi = -999
      this.displayRssi = -999
      this.rawRssiDisplay = -999   // ★ 2026-07-24: 断连同步清零受节流展示副本
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
        addDebugLog(`_ensureForegroundService: 原生分支${__DISABLE_NATIVE_FG ? '已禁用(回退JS)' : 'knownId为空'} → 走纯JS前台服务`, 'warning')
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
          // ★★★ v3.36.3fix11.4 临时诊断日志（待②复现确认后删除）★★★
          // 目的：坐实 ② 根因——available=false 把原生 STATE_ON 已置的 'on' 盖回 'off'（红 banner 误复现）。
          // 若真机红 banner 误复现且此日志打印 → 100% 确认走此路径。
          // 后续修复（v3.36.3fix11.4）：在下面 this.btState='off' 之前加一行
          //   if (this.btState === 'on' && this._nativeBtFired) return   // 信任原生广播开启态，不被延迟 available=false 覆盖
          // 删除本段（含下方 console.warn）即可落地修复；本次仅加日志，不改行为。
          if (this.btState === 'on') {
            console.warn('[Store][v3.36.3fix11.4-DIAG] ⚠ btState on→off 翻转！available=' + state.available +
              ' _nativeBtFired=' + this._nativeBtFired +
              ' → 疑似②(延迟 available=false 覆盖原生 on)。若同时红 banner 误复现即坐实')
          }
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
            // ★ [A1-DIAG] 诊断：坐实 onAllowing 是否在真机被触发、plus 是否存在
            console.log('[A1-DIAG] onAllowing 回调触发 | plus=' + (typeof plus) + ' os=' + (typeof plus!=='undefined'&&plus.os?plus.os.name:'?'))
            // ★ MP/非 Android 纵深防御：onAllowing 仅应由 Android 原生
            //   requestEnableBluetoothAndroid(#ifdef APP-PLUS)触发；但真机 MP 曾误触发
            //   导致绿 banner 与红 banner 同显。运行时门控杜绝此路径。
            if (typeof plus === 'undefined' || plus.os.name !== 'Android') return
            // ★★ 用户点「允许」的瞬间 → 立即亮绿 banner
            console.log('[A1-DIAG][STACK] 1207 设 just_enabled\n' + new Error().stack)
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

      // ★ 2026-08-12 合并版: 断连时清掉挂起写定时器与标记，避免掉线后还向旧连接发 FF01/FF03 写。
      this._postAuthWritesPending = false
      this._gattWriteReady = false
      this._postAuthWritesInFlight = false   // ★ 第七刀: 断连复位，避免电池读被永久卡住
      if (this._postAuthWriteTimer) { clearTimeout(this._postAuthWriteTimer); this._postAuthWriteTimer = null }

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
      // ★ 2026-07-30: 僵尸连接兜底——Android 在 GATT 实际已死时仍可能把设备留在系统"已连接"列表，
      //   主动 close 拆掉 stale ACL handle，确保后续自动/手动重连能建立全新 GATT（否则须重启 App）。
      //   已真断连时 close 报错被忽略，无害。
      if (this.deviceId) {
        try { uni.closeBLEConnection({ deviceId: this.deviceId, complete: () => {} }) } catch (e) {}
      }
      // ★ 2026-07-19: 断连时立即 flush 所有 binding waiter（BIND/NONCE/AUTH 等），
      //   让 bindDevice 秒级失败，不再卡在 2500ms + 4000ms 等超时。
      _flushBindWaiters(false)
      this._connFinalizedFor = null   // ★ 方案A (2026-07-18): 断连重置初始化幂等守卫，允许重连重新初始化一次
      this.deviceState = 'LOCKED'
      // ★ v3.25-fix: 不再立即清零 RSSI。锁屏/Doze 下 Android 可能发送虚假断连事件，
      //   但 GATT 实际未断（固件 LED 仍按 RSSI 工作、解锁 WRITE 仍成功）。立即清零会让
      //   页面在连接其实活着时误显 "--"。改为延迟 3s 确认真断连：期间若收到 FF02(c:1)
      //   自愈，_parseSingleStatus 会重设 connected/filteredRssi 并取消本定时器（见下方）。
      this.statusStale = true
      this.batteryLevel = -1        // ★ v3.14: 断连重置电量
      this.deviceTempC = null       // ★ v3.36.1: 断连重置芯片温度，避免连接页残留旧值
      // ★ v3.31.0 / 2026-07-13: 清掉 RSSI 看门狗并重置显示态（避免残留 stale 显示）
      this._clearRssiStaleWatchdog()
      this.displayRssi = -999
      this.rawRssiDisplay = -999   // ★ 2026-07-24: 重置同步清零受节流展示副本
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
     * ★ 2026-07-25: 断连事件二次确认（防假断连误翻状态）
     *
     * 背景：微信小程序 / Android 的 BLE 栈在「连上后瞬间」「锁屏 / Doze」时，可能多发一次
     * onBLEConnectionStateChange(false) 事件，但 GATT 实际仍活（WRITE 仍成功、FF02 仍送达、
     * RSSI 仍显示）。若此时直接 _handleDisconnect() 会立即把 connected 置 false，副作用极大：
     *   ① 控制页"已知设备"卡（v-if="!connected && 已知设备"）重现；
     *   ② deviceState 被误复位为 LOCKED、displayRssi 立即清零；
     *   ③ _flushBindWaiters(false) 误杀正在进行的鉴权。
     * 故在真正断连前做系统级确认真断连。
     *
     * ★ 2026-07-25 修复(MP 假断连误判): 原仅用 uni.getConnectedBluetoothDevices 系统级确认。
     *   该 API 在微信小程序(mp-weixin)上极不可靠——已连接的设备常返回空列表(漏报)，
     *   使"假断连保护"反而把 GATT 仍活的设备判成真断连 → connected 翻 false → 控制页卡重现，
     *   与本意(挡掉假断连)完全相反。修复策略：
     *   - getConnectedBluetoothDevices 命中(Android 可靠) → 立判假断连，忽略（快速路径）；
     *   - 查不到 / 查询失败 → 不据此判连，进入「FF02 活性缓刑」(_startDisconnectProbation)二次确认：
     *       缓刑窗口(3s)内收到 FF02(链接真活) → 假断连，忽略；窗口内无 FF02(真断连) → _handleDisconnect。
     *   副作用：真断连检测延迟 ≈ 缓刑窗口(3s)，可接受（优先避免误判，且远小于旧 24s）。
     *   ★ 2026-07-30: 二次确认由 RSSI 探针改为 FF02 流量判别。原因：实测设备重启后，Android 对
     *     陈旧 GATT 会让 getBLEDeviceRSSI / getBLEDeviceServices 从缓存秒回成功(链路实际已死)，
     *     RSSI 探针误判"仍活" → 真断连被忽略 20s+(用户两次复现)。FF02 是固件每 ~1s 的实时推送，
     *     链接真活才持续到达，是最可靠的"链接真活"证据，且绝不走缓存。
     *
     * 仅用于全局监听器路径；用户主动断开 / _verifyConnection 已验真失效等路径仍直接走 _handleDisconnect。
     *
     * @param {string} deviceId 触发事件的设备 id（已通过 deviceId===this.deviceId 过滤）
     */
    async _verifyThenDisconnect(deviceId, opts = {}) {
      const forceStale = !!opts.forceStale
      // ★ forceStale（FF02 静默>20s 看门狗）：链接对 App 已不可用，直接按真断连清理，
      //   不再依赖 RSSI/GATT 探针（Android 缓存会误判"仍活"，见下方 ②）。
      if (forceStale) {
        console.log('[Store] forceStale：FF02 静默>20s，强制清理僵尸连接')
        this._handleDisconnect()
        return
      }
      // ① 系统级确认（Android 可靠；mp-weixin 可能漏报，仅作快速放行信号）
      try {
        const devices = await new Promise((resolve, reject) => {
          uni.getConnectedBluetoothDevices({
            services: [BLE_CONFIG.serviceUUID],
            success: (res) => resolve(res.devices || []),
            fail: (err) => reject(err)
          })
        })
        if (devices.some(d => d.deviceId === deviceId)) {
          // 设备仍在系统已连接列表 → 链接真活 → 假断连，忽略（不翻 connected）
          console.log('[Store] ⚠ 断连事件但设备仍在系统已连接列表 → 假断连（链接真活），忽略（不翻 connected）')
          return
        }
      } catch (e) {
        // 查询失败：不据此判连，转 FF02 活性缓刑兜底
        console.warn('[Store] _verifyThenDisconnect: 系统级确认失败，转 FF02 活性缓刑:', e?.message || e)
      }
      // ② 系统列表查不到：可能真断连，也可能是锁屏/系统误报（链接真活且 FF02 持续推送）。
      //   ★ 关键修正(2026-07-30)：Android 对"重启设备的陈旧 GATT"会让 getBLEDeviceRSSI /
      //     getBLEDeviceServices 从缓存秒回(链路实际已死) → 探针误判"仍活" → 真断连被当假断连
      //     忽略 20s+(用户两次复现)。故【不再用任何 GATT 缓存查询做活性判别】，改用最可靠的
      //     "链接真活"证据——【FF02 实时流量】：固件每 ~1s 推一次 FF02，链接真活则持续到达。
      //   进入「活性缓刑」窗口：期间收到 FF02 → 链接真活(假断连)忽略；窗口内无 FF02 → 真断连。
      //   缓刑 3s(>固件 1s 推送周期，含 >30% 余量应对偶发丢包)确保观察到断连事件「之后」是否有 FF02 续流，
      //   既覆盖边界情况，又把真断连检出延迟压到 ~2s（远低于旧 20s+）。
      this._startDisconnectProbation(deviceId)
    },

    /**
     * ★ 2026-07-30: 断连事件后的「FF02 活性缓刑」。
     *   系统已报 connected=false 且设备不在系统已连接列表，但链接仍可能真活
     *   （锁屏/系统误报，FF02 仍在持续推送）。
     *   不读 RSSI/GATT 缓存（Android 对重启设备的陈旧 GATT 会缓存秒回 → 误判"仍活"），
     *   而是观察【断连事件之后】是否有 FF02 续流：
     *     - 缓刑窗口(3s)内收到 FF02 → 链接真活 → 假断连，忽略本次事件（不翻 connected）；
     *     - 窗口内无 FF02 → 链接确已死 → 真断连，执行清理。
     *   窗口 > 固件 1s 推送周期，确保能观察到事件后的续流，覆盖"FF02 恰好在事件前到达"的边界。
     */
    _startDisconnectProbation(deviceId) {
      if (this._disconnectProbing) return   // 已有缓刑在跑，避免重复定时器
      this._disconnectProbing = true
      console.log('[Store] 系统列表无设备 → 进入 FF02 活性缓刑(3s) 判定真/假断连...')
      this._disconnectProbeTimer = setTimeout(() => {
        this._disconnectProbing = false
        this._disconnectProbeTimer = null
        if (deviceId !== this.deviceId) {
          console.log('[Store] 活性缓刑超时，但当前设备已切换，跳过清理')
          return
        }
        if (!this.connected) {
          console.log('[Store] 活性缓刑超时，但已处于断开态，跳过')
          return
        }
        console.log('[Store] 活性缓刑超时且无 FF02 续流 → 真断连，执行清理')
        this._handleDisconnect()
      }, 3000)
    },

    /**
     * ★ 2026-07-30: 无线电层活性探针。对已连接设备做 getBLEDeviceRSSI（readRemoteRssi），
     *   强制走空口、不读 GATT 缓存：链路真活 → 秒回；链路已死（设备走远/干净断开）→ 立即失败。
     *   替代旧的 _isGattAlive(getBLEDeviceServices)：后者在 Android 上对「重启设备的陈旧 GATT」
     *   会从缓存秒回 services → 误判"仍活"。
     *   ⚠ 注意：本探针仍不可靠于「设备重启」场景——实测重启后 stale GATT 的 readRemoteRssi 也会
     *   从缓存秒回成功（用户 2026-07-30 两次复现）。故前台断连判定已改用 FF02 活性缓刑
     *   （_startDisconnectProbation），本探针仅保留给 _verifyConnection（App 从后台切回，
     *   那时 stale handle 通常已被系统清理，RSSI 较能反映真实链路）。
     *   @returns {Promise<boolean>} true=无线电层仍活
     */
    async _isRadioAlive(deviceId) {
      if (!deviceId) return false
      let timer
      try {
        // ★ 给探针加 .catch 吞掉其"最终"的 rejection（真断连时 getBLEDeviceRSSI 会 reject），
        //   避免 Promise.race 孤儿 promise 变成 UnhandledPromiseRejection 噪声；
        //   同时在 finally 清定时器，避免超时 reject 落到已 settle 的 race 上。
        const rssiProbe = getBLEDeviceRSSI(deviceId).catch(() => {})
        const timeout = new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('RSSI_PROBE_TIMEOUT')), 1500)
        })
        await Promise.race([rssiProbe, timeout])
        return true
      } catch (e) {
        return false
      } finally {
        clearTimeout(timer)
      }
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
    async _verifyConnection(timeoutMs = 3000) {
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
      // ★ 2026-08-17 硬超时补丁：uni.getConnectedBluetoothDevices 在 Android 上
      //   曾出现"既不 success 也不 fail"静默挂起（与 openBluetoothAdapter/
      //   closeBLEConnection 同类问题）→ _verifyConnection 永久 pending →
      //   _repairConnection 卡死在 await → 8s 看门狗自愈链断裂 → 连接永远
      //   停留在"已连接但状态过期/一直连接中"。加硬超时强制收口，超时按
      //   "系统列表漏报"处理转 RSSI 探针二次确认，绝不永久挂起。
      try {
        const devices = await Promise.race([
          new Promise((resolve, reject) => {
            uni.getConnectedBluetoothDevices({
              services: [BLE_CONFIG.serviceUUID],
              success: (res) => resolve(res.devices || []),
              fail: (err) => reject(err)
            })
          }),
          new Promise((_, reject) => setTimeout(() => reject(new Error('SYS_VERIFY_TIMEOUT')), timeoutMs))
        ])
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
        // ★ 2026-07-30 修复: 系统列表查不到，可能 mp-weixin getConnectedBluetoothDevices 漏报。
        //   先用 RSSI 无线电探针二次确认（强制走空口，不读缓存），避免把"陈旧 GATT 仍活"的设备误判失效。
        console.log('[Store] _verifyConnection: 系统列表漏报，转 RSSI 探针确认...')
        const alive = await this._isRadioAlive(this.deviceId)
        if (alive) {
          console.log('[Store] _verifyConnection: RSSI 仍活，连接正常')
          this._resetStatusStaleTimer()
          this._enableStatusNotify()
          return true
        }
        // 设备不在系统已连接列表且 RSSI 已死 → 连接已失效
        console.log('[Store] _verifyConnection: 设备不在已连接列表且 RSSI 已死，连接已失效')
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
              this._rememberAdvertisedName(device.deviceId, device.name)
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
            await new Promise(r => setTimeout(r, 700)) // ★ 2026-08-16 (B-1): 400→700ms, 与 _doReconnect 统一, 确保 OS 真正拆链后强制新建 GATT(首连路径)
            this._connectWithResetFallback(targetId).then(() => {
              this._repairing = false
              if (this._screenOnScanGuard !== guard || this.connected) return
              console.log('[Store] \ud83d\udcf1 \u4eae\u5c4f\u8fde\u63a5\u6210\u529f\uff0c\u521d\u59cb\u5316...')
              setDebugReconnectResult(true, '\u4eae\u5c4f\u8fde\u63a5\u6210\u529f')
              this.connected = true
              this._configPushedThisConn = false   // ★ 2026-07-14: 新连接重置（防止沿用上一连接的去重标志）
              this._gattWriteReady = false; this._postAuthWritesPending = false; this._postAuthWritesInFlight = false   // ★ 2026-08-12 合并版 + 第七刀: 新连接重置挂起写标志
              if (this._postAuthWriteTimer) { clearTimeout(this._postAuthWriteTimer); this._postAuthWriteTimer = null }
              this._resetRssiDisplay()   // ★ v3.31.0 / 2026-07-13: 亮屏修复连上后重置 RSSI 显示态
              this.lastDeviceId = targetId
              this._rememberAdvertisedName(targetId, device.name)
              if (!this.deviceName) {
                this.deviceName = this._resolveFactoryName(targetId, device.name)
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
                this._restoreBindKey(sn)   // ★ 2026-07-18: 提前恢复本机密钥，用于下方门控
                if (!this.isBound) {
                  this._syncConfigToDevice()
                }
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

          // ★ 2026-08-16 关键修复（来自 23:36:53 status:22 日志复盘）：
          //   旧逻辑把"任何失败"都当成"蓝牙关"→ 一旦进入 paused 就 return，且无唤醒入口 → 重连永久卡死。
          //   现分流：
          //   ① 真正"蓝牙适配器不可用"（_doReconnect 探到 btOn=false 并已设 paused）→ 等蓝牙恢复事件唤醒，return。
          //   ② 连接级错误（status:22 / CONNECT_HARD_TIMEOUT / ALREADY_CONNECT_STALE / GATT 冲突等）→
          //      这些**不是**蓝牙关，必须继续走指数退避，绝不在此 return 卡死。
          //   用错误类型区分，而非用 reconnectMode==='paused' 这个会被多种失败共用的状态判断。
          const isBtOff = (e && e.message === '蓝牙未开启')
          if (isBtOff) {
            console.log('[Store] 蓝牙未开启，暂停重连，等待蓝牙恢复事件唤醒')
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
      // ★ 方案A 幂等守卫 (2026-07-18): connect() 手动路径与全局监听器补位路径可能都触发本方法，
      //   同一连接只初始化一次，避免重复「服务发现 + FF04 序列号读取 + 配置下发」的双份 GATT 流量与噪声日志。
      //   守卫在 _handleDisconnect（断连）与 connect() 起点重置为 null，故重连/重新手动连接不受影响。
      // ★ 2026-08-16 加强：仅当"本连接确实已初始化完成"(connected===true)才拦截。若 connected===false
      //   （初始化被中断/上一轮已清理），即使 _connFinalizedFor===deviceId 也放行重新初始化——
      //   否则设备重启后重连若底层连上但 store 状态未同步，会被错误拦截→永不初始化→永久连不上。
      if (this._connFinalizedFor === deviceId && this.connected === true) {
        console.log('[Store] _finalizeConnection: 本连接已初始化，跳过重复调用（幂等守卫）')
        return
      }
      this._connFinalizedFor = deviceId
      this.connected = true
      this._connectedAtMs = Date.now()   // ★ 2026-07-17 诊断埋点：记录会话起点，供 _handleDisconnect 算存活时长
      this._configPushedThisConn = false   // ★ 2026-07-14: 新连接重置去重标志
      this._gattWriteReady = false; this._postAuthWritesPending = false; this._postAuthWritesInFlight = false   // ★ 2026-08-12 合并版 + 第七刀: 新连接重置挂起写标志
      if (this._postAuthWriteTimer) { clearTimeout(this._postAuthWriteTimer); this._postAuthWriteTimer = null }
      this._resetRssiDisplay()     // ★ v3.31.0 / 2026-07-13: 重置 RSSI 显示态 + 启动连续无 FF02 看门狗
      // ★ 2026-08-17 (P-FF02): 连接时立即武装 8s 状态看门狗。
      //   旧逻辑 _resetStatusStaleTimer 只在收到 FF02 后(_parseSingleStatus)或 _verifyConnection 时被调用——
      //   若 FF02 因 CCCD 未生效而从未到达，看门狗永不启动，_repairConnection 永不触发，
      //   AUTH 4 轮失败后只能干等固件 30s 强断。现在连接即武装：8s 无 FF02 → _repairConnection
      //   (轻量重订阅→失败则拆链重建 GATT)，让"FF02 静默"也能自愈。
      this._resetStatusStaleTimer()
      this.sessionAuthed = false   // ★ ②: 新连接需重新 AUTH
      B._sessionSalt = null; B._cmdSeq = 0; B._lastNonce = null   // ★ P0-2: 新连接重置签名会话态
      this.batteryLevel = -1   // ★ 2026-08-09 (P0-①): 连接起点重置电量→未知(---)，杜绝跨板粘连(V04 6% 残留到 V03)
      this._statusNotifyReady = false  // ★ 2026-07-12: 本连接 FF02 Notify 尚未订阅，自动 AUTH 待订阅后触发
      this._autoAuthState = 'idle'   // ★ 2026-07-12: 重置自动 AUTH 状态机
      this.lastDeviceId = deviceId
      // ★ 2026-08-09 P1-①: 不再在连接成功时无条件记录已知设备。
      //   已知设备 = 本机通过 AUTH/BIND 鉴权的设备（真 owner），见 AUTH:OK / BIND:OK 处 _touchKnownDevice。
      //   否则任何连过的陌生设备都会污染"重新连接"卡片。
      if (!this.deviceName) {
        this.deviceName = this._resolveFactoryName(this.deviceId)
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
        this._restoreBindKey(sn)   // ★ 2026-07-18: 提前恢复本机密钥，用于下方门控
        // ★ 2026-07-18: 已绑定设备由 AUTH:OK 可靠补发配置(见 3250)；此处抢跑会在「连接后加密握手窗口」
        //   被 OS 拒(10007)产生无效写与噪声。仅未绑定(访客/首连)设备立即下发。
        if (!this.isBound) {
          this._syncConfigToDevice()
        }
        // ★ ②: 恢复本机已存的 bindKey（isBound 复原）。
        //   ★ 2026-08-16 修复：AUTH 触发**只**由下方 _enableStatusNotify（FF02 Notify 订阅就绪后）
        //   驱动，此处【不再】触发 _maybeAutoAuth。
        //   旧逻辑在 readSerialNumber(5000ms 超时).then 里触发 AUTH——但 SN 读一旦慢（撞 10007 /
        //   服务发现慢）会延迟到 5s 之后，而固件「未 AUTH 踢窗」仅 ~3.1s（见日志存活 3.1s authed=false），
        //   导致重连 AUTH 永远赶不上、连上即被踢。Notify 订阅在 800ms 后即就绪，AUTH 立即发出，
        //   不依赖 SN，必能命中 3.1s 窗。删除冗余 SN 路径触发，杜绝延迟。
        if (sn) {
          this._restoreBindKey(sn)
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
        // ★ 2026-08-17 (P-FF02): 订阅成功即启动 FF02 到达验证——uni 的 success 回调只代表
        //   CCCD 写请求已提交，不代表设备端真收到 0x0001；3s 无 FF02 将自动重订阅/拆链自愈。
        this._armFf02ArrivalProbe(targetId)
        // ★ 2026-08-13 修订: 订阅成功后即触发首次 AUTH。NONCE 已回退基线行为（走底层 2×400ms 兜底，
        //   仅单次轻量重试双保险），首连一枪过、零额外开销；重连冷窗口由底层静默救回。
        const _targetId = targetId
        setTimeout(() => {
          if (this.deviceId !== _targetId || !this.connected) return
          this._maybeAutoAuth()
        }, AUTH_WARMUP_MS)
      } catch (_) {}
    },

    /**
     * ★ 2026-08-17 (P-FF02): FF02 到达验证看门狗。
     *   uni.notifyBLECharacteristicValueChange 的 success 回调只代表「CCCD 写请求已提交」，
     *   不代表设备端真的收到了 0x0001（Android 底层若 descriptor 列表为空，可能只调
     *   setCharacteristicNotification(true) 而不写 CCCD → 设备端不推送 → FF02 全静默，
     *   NONCE 挑战也走 FF02 → 收不到 → AUTH 永远失败 → 固件 30s 强断，死循环）。
     *   订阅成功后 3s 内未收到真实 FF02(_lastFf02At 未前移) → 重订阅一次（部分 ROM 第二次能命中）；
     *   再等 3s 仍无 → 连续静默计数+触发 _repairConnection 拆链重建（Android 恢复 CCCD 的可靠手段）。
     *   _handleStatusNotify 收到 FF02 会取消探测并清零计数。
     */
    _armFf02ArrivalProbe(targetId) {
      if (this._ff02ArrivalTimer) { clearTimeout(this._ff02ArrivalTimer); this._ff02ArrivalTimer = null }
      if (this._ff02ProbeRunning) return   // 已有探测在跑，防重入
      this._ff02ProbeRunning = true
      const probeStart = this._lastFf02At || 0
      this._ff02ArrivalTimer = setTimeout(async () => {
        this._ff02ArrivalTimer = null
        this._ff02ProbeRunning = false
        if (this.deviceId !== targetId || !this.connected) return
        if ((this._lastFf02At || 0) > probeStart) return  // FF02 已到达，链路正常
        // 3s 无 FF02 → 重订阅一次（部分 ROM 第一次订阅静默失败、第二次成功）
        this._ff02SilentRepairs = (this._ff02SilentRepairs || 0) + 1
        console.warn(`[FF02] ⚠ 订阅成功但 3s 无 FF02 数据（CCCD 可能未生效，第 ${this._ff02SilentRepairs} 次静默），尝试重新订阅`)
        try {
          await notifyBLECharacteristicValueChange(targetId, BLE_CONFIG.serviceUUID, BLE_CONFIG.statusCharUUID, true)
        } catch (_) {}
        const probeStart2 = this._lastFf02At || 0
        this._ff02ProbeRunning = true
        this._ff02ArrivalTimer = setTimeout(() => {
          this._ff02ArrivalTimer = null
          this._ff02ProbeRunning = false
          if (this.deviceId !== targetId || !this.connected) return
          if ((this._lastFf02At || 0) > probeStart2) {
            console.log('[FF02] ✓ 重新订阅后 FF02 已恢复')
            return
          }
          // 重订阅仍无 → 按连续静默次数决定自愈强度
          if (this._ff02SilentRepairs >= 3) {
            console.error('[FF02] ❌ 连续 3 次订阅/重订阅均无 FF02，停止拆链循环（可能固件未推送或 ROM 底层问题），等待断连/重连兜底')
            return
          }
          console.error('[FF02] ❌ 重新订阅后仍无 FF02，CCCD 未生效 → 拆链重建 GATT 上下文')
          this._repairConnection()
        }, 3000)
      }, 3000)
    },

    /**
     * 执行一次重连尝试
     * ★ 统一入口：确保全局监听器 + 蓝牙适配器均已初始化
     * ★ v3.6-fixD: 会话锁机制，防止蓝牙关闭后仍在执行的 _doReconnect 覆盖状态
     */
    /**
     * ★ 2026-08-16 (B-1 重连=首连): 把连接会话态复位成"首连初值"。
     * 在 _doReconnect 的 closeBLEConnection 之后、connectDevice 之前调用,
     * 让"重连"在 App 侧等价于"重启 APP 后的首连", 从而:
     *   ① 消除"首次绑定快、之后绑定慢"(重连走新建 GATT, 写就绪回到 0.4s);
     *   ② 消除重连冷窗口导致的 A 类 10007 "蓝牙缓存可能过期" 弹窗;
     *   ③ 解决"设备重启后连不上、必须重启 APP"(不再复用陈旧 GATT 上下文)。
     * 注意: 本函数只复位"连接层会话态", 不碰持久化数据(knownDevice/绑定/命名)。
     * _finalizeConnection 里也有部分复位(连接成功后), 此处是前置兜底, 二者互补不冲突。
     */
    _resetConnectionStateLikeAppRestart() {
      this._gattWriteReady = false
      this._postAuthWritesPending = false
      this._postAuthWritesInFlight = false
      if (this._postAuthWriteTimer) { clearTimeout(this._postAuthWriteTimer); this._postAuthWriteTimer = null }
      this._statusNotifyReady = false
      this.sessionAuthed = false
      this._autoAuthState = 'idle'
      B._sessionSalt = null; B._cmdSeq = 0; B._lastNonce = null
      // 不清 batteryLevel / deviceName / _configPushedThisConn —— 这些由 _finalizeConnection 在连接成功后处理
      console.log('[Store] _resetConnectionStateLikeAppRestart: 会话态已复位为首连初值')
    },

    async _doReconnect() {
      // ★ 2026-07-30: 重连并发守卫——防止 forceStale 触发 + 心跳 tryAutoConnect + 舒适模式扫描
      //   同时进入，导致两个 connectDevice / 适配器重置并发、状态互相踩。
      //   关键：重入时不再"裸 return"（会被调用方误判为成功），而是返回【进行中的同一次重连
      //   Promise】，让所有入口(异常断连 / 心跳 / 扫描 / 手动点击)都 await 真实结果，避免
      //   "重连成功！"的假成功，也避免重复发起连接互相踩。
      if (this._reconnecting && this._reconnectPromise) {
        console.log('[Store] ⚠ _doReconnect 重入：复用进行中的重连 Promise（避免假成功/重复连接）')
        return this._reconnectPromise
      }
      this._reconnecting = true
      this._connectSucceededThisSession = false
      this._reconnectPromise = (async () => {
      try {
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
          // ★ 2026-07-30: 硬超时兜底，防止 openBluetoothAdapter 在异常栈上挂起（同 _resetBluetoothAdapter）。
          //   超时则保守 resolve（不强求打开，后续 _checkBluetoothState 会兜底判断）。
          await new Promise((resolve) => {
            let settled = false
            const t = setTimeout(() => {
              if (settled) return
              settled = true
              console.warn('[Store] ⛧ _doReconnect openBluetoothAdapter 超时(5s)，保守放行')
              resolve()
            }, 5000)
            uni.openBluetoothAdapter({
              success: () => { if (settled) return; settled = true; clearTimeout(t); resolve() },
              fail: (err) => {
                const msg = String(err?.errMsg || '')
                if (settled) return
                settled = true; clearTimeout(t)
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
        // ★ 2026-08-16 关键修正（来自 23:36:53 status:22 日志复盘）：
        //   仅当"蓝牙适配器确实不可用"才设 paused。连接级错误（status:22 / ALREADY_CONNECT_STALE /
        //   CONNECT_HARD_TIMEOUT 等）一律**不要**在此设 paused——它们由下方 _connectWithResetFallback
        //   抛出后冒泡到 _scheduleReconnect，应走正常指数退避，而非永久暂停。
        //   旧逻辑把"任何失败"都归到 paused 分支，导致蓝牙瞬时抖动（Android 连续 createBLEConnection
        //   失败后偶发探到 unavailable）误判"蓝牙关"→ paused → 无唤醒入口 → 重连永久卡死。
        this.reconnectMode = 'paused'
        this.reconnectNextDelay = 0
        console.log('[Store] 蓝牙适配器不可用，暂停重连，等待蓝牙恢复事件')
        throw new Error('蓝牙未开启')
      }

      // 如果处于 dormant（用户主动断开），不重连
      if (this.reconnectMode === 'dormant') {
        throw new Error('用户主动断开')
      }

      // ★ v3.6-fixB: 重连前先断开可能残留的旧连接句柄
      // ★ 2026-07-25: uni.closeBLEConnection 无 success/fail 回调时返回 Promise，
      //   未连接报错(errCode 10006 no connection)会 reject 成 UnhandledPromiseRejection；
      //   外层 try/catch 只抓同步异常、抓不到异步 reject，故用 complete 回调收口（与 1852/3428/3863 一致）。
      try {
        // ★ 2026-08-17 硬超时：uni.closeBLEConnection 的 complete 在 Android 上可能不回调
        //   （与 openBluetoothAdapter 同类静默挂起）→ 本 await 永久 pending → _doReconnect 卡死 →
        //   _reconnectPromise 永不 settle → 自动重连/手动 connect 卡在"连接中"。加 2s 超时兜底，
        //   宁可放行继续（connectDevice 自带 18s 硬超时兜底），不可卡死。
        await Promise.race([
          new Promise((resolve) => {
            uni.closeBLEConnection({ deviceId: this.deviceId, complete: () => resolve() })
          }),
          new Promise((resolve) => setTimeout(() => {
            console.warn('[Store] _doReconnect: closeBLEConnection 硬超时(2s)，强制放行')
            resolve()
          }, 2000))
        ])
        console.log('[Store] _doReconnect: 已清理旧连接句柄')
      } catch (e) {
        // 断开失败无所谓
      }

      // 等待系统处理断开
      // ★ 2026-08-16 (B-1 重连=首连): 等待从 300ms 提到 700ms。300ms 太短, Android 未必真拆链,
      //   陈旧 GATT 上下文可能残留 → 下次 connect 复用旧 GATT → 写属性就绪慢(1.6s)→ 10007 弹窗 +
      //   设备重启后连不上(必须重启APP)。加长到 700ms 确保 OS 真正销毁旧 GATT, 下次 connect 强制
      //   新建 GATT(首连路径, 写就绪 0.4s)。亮屏路径 _tryAutoConnect 用 400ms, 此处统一为 700ms 更稳。
      // ★ 2026-08-16 提速: 仅当 store 仍认为"已连接"(连接其实还活着, 例如设备侧复位但 ACL 未拆)时才等
      //   700ms 保拆链; 异常断连已同步 connected=false 时, OS 侧连接早已释放, 无需空等 700ms → 省约 0.7s。
      const _needWaitTearDown = this.connected
      if (_needWaitTearDown) {
        await new Promise(r => setTimeout(r, 700))
      }
      if (!guardValid()) guardAbort('closeBLEConnection 等待期间锁失效')

      // ★ 2026-08-16 (B-1 重连=首连): close 之后、connect 之前, 把连接会话态复位成"首连初值"。
      //   否则旧连接的 _gattWriteReady=true 会让首笔写误判 GATT 已就绪而直接发 → 撞 10007;
      //   且 _postAuthWritesInFlight 等残留会干扰新连接。这与亮屏路径 L2012 的复位对齐,
      //   让"重连"在 App 侧等价于"重启 APP 后的首连"。
      this._resetConnectionStateLikeAppRestart()

      // ★ 2026-08-16 (B-1 关键补丁): 强制清除连接初始化幂等守卫 _connFinalizedFor。
      //   根因: _doReconnect 的 closeBLEConnection 是 uni 直接调用, 当系统认为"本来就没真连"(stale ACL)
      //   时不会回调 onBLEConnectionStateChange → _handleDisconnect 不被触发 → _connFinalizedFor 残留为
      //   上一轮 deviceId。随后 _finalizeConnection 在 L2158 因 _connFinalizedFor===deviceId 直接 return,
      //   整条初始化(读 SN / 订阅 FF02 / 触发 _maybeAutoAuth)被跳过 → sessionAuthed 永远 false →
      //   固件 30s 未 AUTH 强断 → 又重连 → 又跳过 → 死循环(连上→显示---→断→连上→---)。
      //   重启 APP 后 _connFinalizedFor 为初始 undefined 故一次成功。此处主动清空, 让每轮重连都走完整
      //   初始化, 与 connect() 手动路径(L3090)、全局监听器补位(L3046)保持一致。
      this._connFinalizedFor = null

      // ★ v3.6-fixD: 连接前最后确认锁 — 若已失效立即中止
      if (!guardValid()) guardAbort('connectDevice 前锁失效')

      // 连接（★ v3.6-fixG: 捕获僵死句柄 → 重置适配器后重试一次）
      await this._connectWithResetFallback()
      // ★ 2026-08-16：connectDevice 已成功 resolve ⇒ 底层物理连接已建立，标记会话级成功。
      //   后续任何 guard 异步失效都【绝不】因此丢弃已建立的连接（见下方 L2449 修复同理）。
      this._connectSucceededThisSession = true

      // ★ v3.6-fixD: 连接成功后的最终锁检查
      //   防止蓝牙关闭瞬间 connectDevice 意外 resolve（例如 already connect）
      if (!guardValid()) {
        // ★ 2026-08-16 修正：连接已成功，不再因 guard 异步失效而丢弃连接（会留下僵尸连接）。
        //   仅当适配器确实已关闭才放弃（由下方 getBluetoothAdapterState 兜底）。
        console.warn('[Store] ⛧ _doReconnect: connectDevice 成功但锁已失效，保留连接（交由 finalize）')
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
      // ★ 2026-08-16 致命修复（来自 23:44:20 日志复盘）：
      //   旧逻辑在 connectDevice 成功、AUTH 即将完成的收尾阶段，用 guardValid() 二次检查，
      //   一旦「期间有另一轮重连推进导致 _reconnectGuard 自增」就抛 SESSION_EXPIRED 自杀。
      //   但此时【物理连接已经建立、connected 已为 true、AUTH 流程正在跑】，自杀会把刚连上的
      //   连接当「过期会话」丢弃，留下 connected=true 却无人管理的僵尸连接 → 后续 42s 才被固件踢。
      //   日志铁证：23:44:20.587 连接成功 → 20.672「最终适配器确认后锁失效」→ 20.672「重连会话过期
      //   放弃本轮」→ 但 22.2 仍打出 AUTH:OK（旧回调跑完）→ 连接游离到 42.4 才真正断。
      //   修正：connectDevice 已成功 ⇒ 这是本轮权威成功点，**绝不再因 guard 异步失效而自杀**。
      //   仅当用户主动发起新连接（_connEpoch 递增）或蓝牙确已关闭（realState.available=false 已拦）
      //   才应放弃。此处删除 guardAbort，改为「若已有更新的连接会话接管且当前已非本连接，则只是
      //   不再重复 _finalizeConnection（避免重复初始化），但不抛错、不丢已有连接」。
      if (!guardValid()) {
        // ★ 2026-08-16 兜底：connectDevice 已成功建立物理连接 ⇒ 任何 guard 异步失效都【不自杀】。
        //   这是本轮权威成功点，绝不让在途的并发重连/断连事件把它丢弃成僵尸连接。
        if (this._connectSucceededThisSession) {
          console.log('[Store] ⚠ 重连 guard 已推进，但 connectDevice 已成功建立连接，保留连接（不自杀）')
        } else if (this.connected) {
          console.log('[Store] ⚠ 重连 guard 已推进，但物理连接已建立，交由接管轮次 finalize（不自杀）')
        } else {
          // 真的没连上且 guard 失效 → 这才是该放弃的场景
          guardAbort('最终适配器确认后锁失效（未连接）')
        }
      }

      this._finalizeConnection(this.deviceId)
      } finally {
        this._reconnecting = false
        this._reconnectPromise = null
      }
      })()
      return this._reconnectPromise
    },

    /**
     * ★ v3.14: GATT Read 读取电池电量（独立数据源，不依赖扫描缓存）
     *   连接建立后非阻塞调用，覆盖手动连接 + 自动重连两条路径。
     * ★ 2026-07-24 (v3.36.3-fixApp-batt): 读取改为「重试 3 次退避」，消除「一次性读失败就永久 ---」的脆弱。
     */
    async _fetchBatteryLevel(deviceId) {
      if (!deviceId) return
      // ★ 2026-07-18: 固件 Battery Service(0x180F) 的 0x2A19 同时带 READ+NOTIFY（见 Profile/battery_service.c），
      //   且 peripheral.c 广播里带电池 Service Data —— 故系统蓝牙列表能直接显示 100%（走系统 Battery Service
      //   路径，与 App 无关）。App 侧 readBLECharacteristicValue 偶发 property not support，疑似手机 GATT 缓存
      //   对该特征缺 READ 位（同「缓存过期」类），故改为「仅当 Notify/广播未送达电量时」才兜底读取。
      //   ★ 注意：电量并不在 FF02 status JSON 里（该 JSON 无电池字段），不要误以为来自 FF02 Notify。
      //   ★ 2026-07-24 修复策略（开发修复指南）：
      //     当前在「先扫后连」场景靠扫描缓存拿到电量；但前台服务/已知设备直接重连无新鲜扫描时，
      //     若本次 GATT Read 失败则 batteryLevel 恒为 -1 → 控制页永久显示 "---"。故此处加重试。
      //     ⚠ 固件侧「连接建立即主动推送当前电量 (Battery_UpdateLevel()+Battery_Notify())」的修复
      //       【刻意推迟到「外部 ADC 采集真实电池」那一轮固件改动一起 bump】（避免同一 battery_service.c 刷两次固件）。
      //       届时外部 ADC 电平会变化 → 变化 Notify 才生效；但重连后电平≈上次值仍会长时间不推，
      //       故那轮务必把连接即推送一并做掉。详见 docs/03-复盘与问题分析/4-硬件与专项分析/
      //       KeyGo_电量长时间不显示_根因分析.md §3.1。
      // ★ 2026-08-13 第七刀: 电池兜底读取必须让位给「AUTH:OK 后配置下发(FF01/FF03)」。
      //   实测根因: Android GATT 事务槽读写共用，本函数的 read 与配置下发的 write 并发
      //   → 后提交者被框架拒 → uni-app 映射成 10007 property not support（误导性错误码）。
      //   日志铁证: 每次 10007 都精确落在一次电池 read 的飞行窗口内；read 一结束写立刻成功。
      //   双保险: ① 下方所有 read 已改走 enqueueRead 与写共用同一串行链（治本）；
      //          ② 此处再等 _postAuthWritesPending 落幕，避免电池读长期占用事务槽把
      //             配置下发挤到后面排队（治时序，保证「绑定验证 → 配置下发」这条主链最快）。
      await new Promise(r => setTimeout(r, 2500)) // 先等状态 Notify 把电量送上来
      if (this.deviceId !== deviceId || !this.connected) return
      // 等待 AUTH:OK 后的挂起写全部下发完毕（最多再等 4s，防极端情况饿死电池读取）
      // _postAuthWritesPending = 还没开始 flush；_postAuthWritesInFlight = flush 中(含 FF03 尾巴)
      {
        const _waitStart = Date.now()
        while ((this._postAuthWritesPending || this._postAuthWritesInFlight)
               && Date.now() - _waitStart < 4000) {
          await new Promise(r => setTimeout(r, 150))
          if (this.deviceId !== deviceId || !this.connected) return
        }
      }
      // ★ 2026-08-09 (P0-①): 仅当已拿到合法百分比(0~100)才跳过读取；
      //   -1(未知)=需继续尝试；255(不支持)=固件已声明，无需再读但也不覆盖
      if (this.batteryLevel >= 0 && this.batteryLevel <= 100) return

      // ★ 2026-07-24: 重试 3 次（退避 800ms），覆盖手机 GATT 缓存瞬态缺 READ 位导致的偶发失败
      // ★ 2026-08-09 (P0-①): 兜底读取也识别 255(不支持)，避免只支持 Read 的固件(如 V03)卡在 ---
      const MAX_RETRY = 3
      for (let attempt = 1; attempt <= MAX_RETRY; attempt++) {
        if (this.batteryLevel >= 0 && this.batteryLevel <= 100) break // 重试途中被 Notify/广播补到合法值，提前退出
        try {
          // ★ 2026-08-13 第七刀: 经 GATT 事务队列排队（与 FF01/FF03 写共用同一条链），
          //   杜绝 read/write 并发抢 Android 单一事务槽 → 消除 10007 property not support。
          const level = await enqueueRead(() => readBatteryLevel(deviceId, 5000))
          if (level === 255) {
            this.batteryLevel = 255
            console.log('[Store] GATT 电池电量: 固件不支持 (255, 第' + attempt + '次兜底)')
            break
          } else if (level >= 0 && level <= 100) {
            this.batteryLevel = level
            console.log('[Store] GATT 电池电量(兜底, 第' + attempt + '次):', level + '%')
            break
          }
        } catch (e) {
          console.log('[Store] GATT 电池电量兜底读取失败(第' + attempt + '/' + MAX_RETRY + '次):', e.message)
          if (attempt < MAX_RETRY) {
            await new Promise(r => setTimeout(r, 800)) // 退避后重试
          }
        }
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
        // ★ 2026-07-30: ALREADY_CONNECT_STALE(GATT 僵死) 或 CONNECT_HARD_TIMEOUT(蓝牙开关循环后
        //   createBLEConnection 平台超时失效、Promise 永久挂起) → 重置适配器并重试一次。
        //   这等价于"重启 App"对适配器的重绑效果，免去用户手动重启。
        if (e && (e.message === 'ALREADY_CONNECT_STALE' || e.message === 'CONNECT_HARD_TIMEOUT')) {
          // ★ v3.6-fixG v3: 若 btState 已为 off，说明适配器事件已到达，系统蓝牙确实关了
          //   此时重置适配器只会强行 btState='on' 造成错误 → 直接抛出让上层暂停重连
          if (this.btState === 'off') {
            console.log('[Store] ⛧ btState 已为 off，跳过适配器重置（系统蓝牙已关）')
            throw e
          }
          // ★ 2026-08-16 修正（来自日志 23:21:47~23:22:03 复盘）:
          //   CONNECT_HARD_TIMEOUT 不再无脑重置适配器。实测 createBLEConnection 的 Promise 在部分
          //   Android 上卡住不 resolve，但底层连接其实在进行（23:22:03 最终连上）。若在此硬超时后
          //   再 _resetBluetoothAdapter（关/开适配器），会【打断底层正在进行的 connect】→ 下一轮更慢
          //   → 又超时 → 又重置 → 恶性循环（日志里连烧 3 轮、耗时 16s）。
          //   故 CONNECT_HARD_TIMEOUT 仅抛错让上层走指数退避；下一轮 _doReconnect 本身会先
          //   closeBLEConnection（软重置）再连，已足够。只有 ALREADY_CONNECT_STALE（GATT 僵死）
          //   才需要硬重置适配器。
          if (e.message === 'ALREADY_CONNECT_STALE') {
            console.log('[Store] ⛧ GATT 僵死，重置适配器...')
            await this._resetBluetoothAdapter()
            console.log('[Store] 适配器重置完成，重试连接...')
            await connectDevice(targetId)
          } else {
            console.log('[Store] ⛧ 连接硬超时（CONNECT_HARD_TIMEOUT），不重置适配器（避免打断底层 connect），交由上层指数退避重试')
            throw e
          }
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

        // ★ 2026-07-30: 硬超时兜底——异常路径（设备重启/僵尸清理后 close 再 open）下，
        //   Android 的 openBluetoothAdapter 可能既不 success 也不 fail → Promise 永久不 settle →
        //   _resetBluetoothAdapter 永远挂着 → _connectWithResetFallback → _doReconnect 永远不返回 →
        //   外层 _scheduleReconnect 拿不到结果、永远排不出 #2 → 现象就是"一直连接中..."连不上。
        //   强制 6s 收口并 reject，让调度器走指数退避。
        await new Promise((resolve, reject) => {
          let settled = false
          const done = (fn) => { if (!settled) { settled = true; clearTimeout(hardT); fn() } }
          const hardT = setTimeout(() => {
            console.warn('[Store] ⛧ openBluetoothAdapter 硬超时(6s)，强制收口')
            done(() => reject(new Error('ADAPTER_OPEN_TIMEOUT')))
          }, 6000)
          uni.openBluetoothAdapter({
            success: () => { console.log('[Store] 适配器重新打开成功'); done(() => resolve()) },
            fail: (err) => { console.error('[Store] 适配器重新打开失败', err?.errMsg); done(() => reject(err)) }
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
     * ★ v3.36.3-fix5: 把自定义名按 MAC 持久化一份，供断连后的扫描列表/重连卡/"已命名"徽章显示
     * @param {string} mac 设备 MAC
     * @param {string} name 自定义名
     */
    _seedCustomNameByMac(mac, name) {
      if (!mac) return
      const key = mac.replace(/:/g, '').toUpperCase()
      const next = { ...this._customNamesByMac }
      // ★ 恢复默认名：空名 = 删除 MAC 副本（而非跳过），否则断连态仍显旧名 + 「已命名」徽章
      if (name) {
        if (next[key] === name) return
        next[key] = name
      } else {
        if (!(key in next)) return
        delete next[key]
      }
      this._customNamesByMac = next
      try {
        uni.setStorageSync('ble_device_custom_names', next)
      } catch (e) {
        console.warn('[Store] 按 MAC 持久化设备名失败:', e)
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
        this._seedCustomNameByMac(this.deviceId, entry.name) // ★ v3.36.3-fix5: 同步到 MAC 索引，供断连后展示
        console.log('[Store] 设备名称已从本地恢复:', entry.name, '(SN:', sn, ')')
      } else if (this.customDeviceName) {
        // 本地无记录，但 d2 已从 NotifyStatus 读回 → 用 d2 作为初始名并记录
        this._deviceNames[sn] = { name: this.customDeviceName, lastSeen: Date.now() }
        this._saveDeviceNames()
        this._seedCustomNameByMac(this.deviceId, this.customDeviceName) // ★ v3.36.3-fix5
        console.log('[Store] 首次记录设备名称（来自固件 d2）:', this.customDeviceName, '(SN:', sn, ')')
      }
        // else: 本地无记录 + 无 d2 → 保持默认名（KeyGo-XXXXXX）
      },

      // 由 MAC 推算出厂广播名，与固件 peripheral.c 完全一致。
      //   固件: snprintf("KeyGo-%02X%02X%02X", g_deviceMac[3], g_deviceMac[4], g_deviceMac[5])
      //   其中 g_deviceMac 为 ROM MAC 的【小端】存储([0]=末字节…[5]=首字节)，故 [3][4][5] = 公网 MAC 前 3 字节反转。
      //   例: 公网 MAC 0C:3D:5E:A6:5F:90 → 广播名 KeyGo-5E3D0C（与手机蓝牙列表一致）。
      //   ★ 兼容性：MAC 不足 12 位(旧数据/截断)时退化为旧逻辑 slice(-6)，避免崩溃。
      _factoryNameForMac(mac) {
        const clean = String(mac || '').replace(/:/g, '').toUpperCase()
        if (clean.length < 12) return 'KeyGo-' + clean.slice(-6)
        const first3 = clean.slice(0, 6)            // 公网 MAC 前 3 字节 M0M1M2
        const reversed = first3.slice(4, 6) + first3.slice(2, 4) + first3.slice(0, 2) // M2M1M0
        return 'KeyGo-' + reversed
      },

      // 解析出厂展示名：优先级 真实广播名(扫描拿到的 device.name) > 持久化广播名(_advertisedNames) > MAC 推导。
      //   这样即使某次扫描没拿到 name，也能用历史记忆或 MAC 推算出正确出厂名，始终与手机蓝牙列表一致。
      _resolveFactoryName(mac, scanName) {
        if (scanName && String(scanName).startsWith('KeyGo')) return scanName
        const key = String(mac || '').replace(/:/g, '').toUpperCase()
        const adv = this._advertisedNames && this._advertisedNames[key]
        if (adv) return adv
        return this._factoryNameForMac(mac)
      },

      // 扫描时记忆设备真实广播名，按 MAC 持久化，作为出厂名"真相"(与手机蓝牙列表一致)。
      //   仅接受以 "KeyGo" 开头的名(过滤脏数据)；值未变则跳过写 storage(减少无意义 IO)。
      _rememberAdvertisedName(mac, name) {
        if (!mac || !name || !String(name).startsWith('KeyGo')) return
        const key = String(mac).replace(/:/g, '').toUpperCase()
        if (this._advertisedNames && this._advertisedNames[key] === name) return
        if (!this._advertisedNames) this._advertisedNames = {}
        this._advertisedNames[key] = name
        try { uni.setStorageSync('ble_advertised_names', this._advertisedNames) } catch (e) {}
      },

      // ★ 2026-08-09 P1-①: 记录"已知设备"——本机已通过 AUTH 鉴权 / BIND 绑定的设备(真 owner)。
      //   仅在 AUTH:OK / BIND:OK 时调用(见对应解析分支)；连接成功(_finalizeConnection)不再无条件记录，
      //   避免陌生/未绑定设备污染 knownDevices → "重新连接"卡片。
      //   ★ 反向清理: 设备复位/主动解绑时由 _forgetDeviceKey / UNBIND:OK 调 _removeKnownDevice 移除。
      _touchKnownDevice(mac) {
        if (!mac) return
        const key = String(mac).replace(/:/g, '').toUpperCase()
        const next = { ...(this.knownDevices || {}) }
        next[key] = { mac, lastConnectedAt: Date.now() }
        this.knownDevices = next
        try { uni.setStorageSync('ble_known_devices', next) } catch (e) {}
      },

      // ★ 2026-08-09 P1-①: 从已知设备集合移除(设备复位/主动解绑后不再是有效 owner)。
      _removeKnownDevice(mac) {
        if (!mac) return
        const key = String(mac).replace(/:/g, '').toUpperCase()
        const next = { ...(this.knownDevices || {}) }
        if (!next[key]) return
        delete next[key]
        this.knownDevices = next
        try { uni.setStorageSync('ble_known_devices', next) } catch (e) {}
      },

      /**
       * ★ 2026-08-09 P1-②: 用户在「已知设备」列表主动删除一台 KeyGo。
       *   与自动失效(_removeKnownDevice 仅清 knownDevices)不同，这里要把一台设备
       *   在手机本地的全部痕迹彻底清理，避免「删了还残留自定义名/默认标记/重连锚点」：
       *   ① knownDevices / ble_known_devices（已知集合）
       *   ② _customNamesByMac / ble_device_custom_names（按 MAC 的自定义名）
       *   ③ 若删的是默认设备 → defaultDeviceId / ble_default_device_id（回退到其余设备首项，无则清空）
       *   ④ 若删的是当前重连锚点(knownDeviceId/lastDeviceId) → 清 ble_last_device_id / lastDeviceId
       *   @param {string} mac 设备 MAC（含冒号或去冒号皆可）
       *   @returns {boolean} true=确实删掉了（以前在已知集合里）
       */
      removeKnownDevice(mac) {
        if (!mac) return false
        const key = String(mac).replace(/:/g, '').toUpperCase()
        const existed = !!(this.knownDevices && this.knownDevices[key])
        // ① 移出已知集合
        this._removeKnownDevice(key)

        // ② 清按 MAC 的自定义名
        if (this._customNamesByMac && this._customNamesByMac[key]) {
          const names = { ...(this._customNamesByMac || {}) }
          delete names[key]
          this._customNamesByMac = names
          try { uni.setStorageSync('ble_device_custom_names', names) } catch (e) {}
        }

        // ③ 清默认设备标记（删的是默认 → 回退到其余设备首项，无则清空）
        if (this.defaultDeviceId === key) {
          const rest = Object.keys(this.knownDevices || {})
          if (rest.length) {
            this.defaultDeviceId = rest[0]
            try { uni.setStorageSync('ble_default_device_id', rest[0]) } catch (e) {}
          } else {
            this.defaultDeviceId = ''
            try { uni.removeStorageSync('ble_default_device_id') } catch (e) {}
          }
        }

        // ④ 清重连锚点（删的是当前已知/最近设备 → 不再自动重连它）
        if (this.knownDeviceId === key || this.lastDeviceId === key) {
          this.lastDeviceId = ''
          try { uni.removeStorageSync('ble_last_device_id') } catch (e) {}
        }

        return existed
      },

      // ★ 2026-07-23 ④: 把某台设为默认设备(在重连列表中置顶)。
      setDefaultDevice(mac) {
        if (!mac) return
        const key = String(mac).replace(/:/g, '').toUpperCase()
        this.defaultDeviceId = key
        try { uni.setStorageSync('ble_default_device_id', key) } catch (e) {}
      },

      // ★ 2026-08-09 P1-②(改): 取消默认(回到「无默认设备」状态)。
      //   用于已默认设备的「取消默认」入口；清空 defaultDeviceId 即不置顶任何一台。
      clearDefaultDevice() {
        this.defaultDeviceId = ''
        try { uni.removeStorageSync('ble_default_device_id') } catch (e) {}
      },

      // 自定义名 + 出厂名组合显示，例如「爱车 ( KeyGo-5E3D0C )」。
      //   仅当两者都存在且不同才加括号；否则回退单个值(避免「爱车 ( 爱车 )」这类冗余)。
      _formatDisplayName(custom, factory) {
        if (custom && factory && custom !== factory) return custom + ' ( ' + factory + ' )'
        return custom || factory || ''
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

      // ★ 2026-07-22 问题①: 已配对设备在无App模式被 OS 自动重连占用时停广播, BLE 扫描扫不到。
      //   进扫描页先查系统级已连接列表, 命中已知设备(MAC)直接复用 GATT 连接, 跳过扫描。
      //   无已知设备 / 系统未占用 / 查询失败 → 照常扫描（_reuseSystemConnectedDevice 内部已兜底）。
      if (await this._reuseSystemConnectedDevice()) {
        this.scanning = false
        return []
      }

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
              this._rememberAdvertisedName(device.deviceId, device.name)
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

    /**
     * ★ 2026-07-22 (问题① — 扫描页扫不到已配对设备)：扫描页进入时，先查系统级已连接列表。
     *   无App模式下，已配对手机 OS 会在设备进范围时自动加密重连 → 固件作为单连接从机停广播
     *   → App 的 BLE 扫描扫不到（这是 BLE 单连接物理事实，非 bug）。此时系统蓝牙管理器里
     *   本设备其实已处于 connected，直接复用该 GATT 连接即可，跳过扫描，避免"已配对却扫不到"
     *   的体验问题（与蓝牙耳机/手表进范围自动重连同理）。
     *   @returns {Promise<boolean>} true=已复用系统连接（调用方应跳过扫描）
     */
    async _reuseSystemConnectedDevice() {
      if (this.connected) return false                  // 已连则无需复用
      if (this.reconnectMode === 'dormant') return false // ★ 2026-07-22: 用户手动断开后不自动复用系统连接，需其主动点"重新连接"按钮
      const knownId = this.deviceId || this.lastDeviceId
      if (!knownId) return false                         // 无已知设备 → 照常扫描
      try {
        const list = await new Promise((resolve, reject) => {
          uni.getConnectedBluetoothDevices({
            services: [BLE_CONFIG.serviceUUID],
            success: (res) => resolve(res.devices || []),
            fail: (err) => reject(err)
          })
        })
        const hit = (list || []).find(d => d.deviceId === knownId)
        if (!hit) return false
        console.log('[Store] 系统已连接命中本设备(无App OS重连占用), 直接复用跳过扫描:', knownId)
        this.deviceId = knownId
        this.deviceName = hit.name || this.deviceName || 'KeyGo'
        this._connFinalizedFor = null                   // 允许本连接经 _finalizeConnection 重新初始化一次
        // 复用系统 GATT 链路：重订阅 FF02 + 读序列号 + 自动 AUTH（_finalizeConnection 幂等且自愈）
        this._finalizeConnection(knownId)
        return true
      } catch (e) {
        console.warn('[Store] 系统连接复用查询失败，回退普通扫描:', e?.message || e)
        return false
      }
    },

    // ==================== 连接 ====================

    async connect(deviceId, deviceName = '') {
      try {
        // ★ 2026-08-16 并发互斥修复（来自 23:52:32 status:8 日志复盘）：
        //   手动 connect() 与自动 _doReconnect 是两条平行入口，旧逻辑只有 _doReconnect 内部
        //   有 _reconnecting 守卫，connect() 完全绕过 → 两者并发各发一个 createBLEConnection →
        //   系统先建一个(补位 connected=true) 又把重复连接的那条踢掉 → status:8
        //   (GATT_CONN_FAIL_ESTABLISH)。此处：若已有重连进行中，先 await 其 Promise 收口
        //   （成功则直接复用已建连接，失败再自己连），杜绝双 createBLEConnection 并发。
        // ★ 2026-08-17 致命修复（来自 00:01:04~00:01:53 日志复盘）：
        //   旧逻辑 `await this._reconnectPromise` 无超时——若 _doReconnect 卡在 18s 硬超时/
        //   _repairConnection 重建循环，Promise 永不 settle → connect() 永久阻塞 → 用户点
        //   "重新扫描连接"也卡死（日志三次 connect 全被"复用其 Promise"卡住）。修复：加 3s 超时，
        //   超时即强制接管（清 _reconnecting 令牌自己连），用户手动意图必须优先于卡死的自动重连。
        if (this._reconnecting && this._reconnectPromise) {
          console.log('[Store] connect: 检测到进行中的重连，最多等 3s 收口')
          try {
            await Promise.race([
              this._reconnectPromise,
              new Promise((_, reject) => setTimeout(() => reject(new Error('RECONNECT_TIMEOUT')), 3000))
            ])
            if (this.connected && this.deviceId === deviceId) {
              console.log('[Store] connect: 进行中的重连已连上本设备，直接复用')
              return
            }
          } catch (e) {
            // 超时或重连失败：强制接管，自己重新连
            console.log('[Store] connect: 重连未及时收口(' + (e?.message || 'fail') + ')，强制接管重新连')
          }
          // ★ 强制接管：清掉卡死的重连令牌，让本次 connect 自己发起 createBLEConnection
          this._reconnecting = false
          this._reconnectPromise = null
        }

        this._restoreConfig()  // ★ 确保连接前配置已恢复
        /* ★ v3.15-#20: 销毁旧监听器后重新注册（防止跨连接残留）
         *   _destroyGlobalListeners() 会设 _listenersInited=false，
         *   随后 _ensureGlobalListeners() 重新绑定 → 每次 connect() 都是干净状态 */
        this._destroyGlobalListeners()
        this._ensureGlobalListeners()  // ★ v3.6: 确保全局监听器已注册

        // ★ 2026-08-16：手动 connect 视为「接管」重连令牌，先把 _reconnecting 置真，
        //   防止 connect() 与 _doReconnect 后续再并发（connect() 自身也会 await 长连接）
        this._reconnecting = true
        this._reconnectGuard++

        // ★ v3.6-fixE: 用户手动连接时，清除所有自动重连状态（防止冲突）
        if (this._reconnectTimer) {
          clearTimeout(this._reconnectTimer)
          this._reconnectTimer = null
        }
        this._resetReconnectCounters()
        // ★ 方案A（2026-07-12 修正②）：用户主动连接即清除「未绑定超时被踢」抑制标记，
        //   恢复后续自动重连（配合 _shouldAutoReconnect 的持久化兜底）。
        this._unboundTimeoutKicked = false
        try { uni.removeStorageSync('keygo_unbound_kicked') } catch {}

        // ★ 预清理旧连接句柄（和 _doReconnect 同样的保护）
        // ★ 2026-07-25: 同上，用 complete 回调收口避免 UnhandledPromiseRejection(10006 no connection)
        try {
          await new Promise((resolve) => {
            uni.closeBLEConnection({ deviceId, complete: () => resolve() })
          })
          console.log('[Store] connect: 已预清理旧连接句柄')
        } catch (e) { /* ignore */ }
        await new Promise(r => setTimeout(r, 300))

        // ★ 方案A (2026-07-18): 重置本连接初始化幂等守卫，允许本次连接由 _finalizeConnection 初始化一次。
        this._connFinalizedFor = null

        await this._connectWithResetFallback(deviceId)
        this.deviceId = deviceId
        this.deviceName = this._resolveFactoryName(deviceId, deviceName)
        this.connected = true
        this._configPushedThisConn = false   // ★ 2026-07-14: 新连接重置去重标志
        this._gattWriteReady = false; this._postAuthWritesPending = false; this._postAuthWritesInFlight = false   // ★ 2026-08-12 合并版 + 第七刀: 新连接重置挂起写标志
        if (this._postAuthWriteTimer) { clearTimeout(this._postAuthWriteTimer); this._postAuthWriteTimer = null }
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

        // ★ v3.14/v3.36.3: 扫描缓存电量曾用于预填充，但会导致跨板粘连
        //   (V04 6% 残留到 V03) 与过期值误显。2026-08-09 (P0-①): 连接起点已在
        //   _finalizeConnection 重置 batteryLevel=-1，此处不再用扫描缓存覆盖，
        //   改由 _fetchBatteryLevel(2.5s 兜底) + Notify 给出权威值。
        //   （扫描缓存电量仅作历史记录保留，不参与本次显示）

        uni.setStorageSync('ble_device_id', deviceId)
        // ★ 2026-07-22: 同步持久化"已知设备"记忆（手动断开时保留，用于"重新连接"按钮）
        uni.setStorageSync('ble_last_device_id', deviceId)

        // ★ v3.6: 全局监听器已处理连接状态变化和特征值数据（不再重复注册）

        await new Promise(r => setTimeout(r, 1000))

        /* ★ v3.15-fix6: 1s GATT 就绪等待期间，用户可能断开连接
         *   此时 this.connected 已为 false/deviceId 已清空，继续操作会抛异常
         *   → 提前退出，避免在已断开的设备上调用 BLE API */
        if (!this.connected || this.deviceId !== deviceId) {
          console.log('[Store] 连接等待期间已断开，跳过 GATT 初始化')
          return false
        }

        // ★ 方案A (2026-07-18): GATT 初始化（FF02/电池 Notify、FF04 序列号读取、per-SN 配置下发、
        //   自动 AUTH）统一交给 _finalizeConnection，消除「connect() 手动路径」与「全局监听器补位
        //   路径」各跑一遍「服务发现 + 序列号读取」的双份 GATT 流量与噪声日志。connectDevice await
        //   期间全局监听器（!this.connected 补位）可能已触发它；此处兜底显式再调一次，由其内部
        //   幂等守卫（_connFinalizedFor）保证同一连接只初始化一遍。
        this._finalizeConnection(deviceId)

        // ★ 2026-08-16：手动 connect 成功，复位 _reconnecting 令牌，允许后续异常断连自动重连
        this._reconnecting = false
        return true
      } catch (err) {
        console.error('[Store] 连接流程失败', err)
        this.connected = false
        // ★ 2026-08-16：失败也复位令牌，避免永久阻塞自动重连
        this._reconnecting = false
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
      // ★ P0-② (2026-08-09): 重连锚点——断开前先保留 lastDeviceId，确保「断开后必能重连」
      //   即使后续 deviceId 被清空、重连按钮也能凭 lastDeviceId / ble_last_device_id 直连。
      if (targetId) this.lastDeviceId = targetId
      // ★ P0-②: disconnectDevice API 无论成败都必须完成状态清理（见下方 finally 语义），
      //   否则 API 抛错直接 return 会残留半连接态（connected=true / deviceId 残留 / 监听器未销毁）
      //   → UI 卡「连接中」且无法重连。这里仅做 GATT 断开尝试，失败仅告警，不阻断清理。
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
          // ★ P0-②: API 失败也不 return，继续做状态清理，保证断开后状态确定一致、可重连
          console.error('[Store] 断开连接 API 调用失败（仍继续清理状态）', err)
        }
      }
      // ★ v3.6: 精准清理全局监听器，避免泄残留 listener
      this._destroyGlobalListeners()
      // ★ v3.17: 用户主动断开 → 停止前台服务
      this._stopForegroundService()
      this.connected = false
      // ★ P0-②: 保留 lastDeviceId（重连直连锚点）；清空 deviceId 仅表示「当前无活动连接」，
      //   不破坏重连能力（重连入口用 lastDeviceId）。
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
     * ★ P0-② (2026-08-09): 用户主动「重新连接」统一入口。
     *
     * 场景：用户先点「断开连接」(disconnect → reconnectMode='dormant' + deviceId='')，
     * 再点「重新连接」。此时：
     *   - reconnectMode 仍是 'dormant'（用户主动断开的语义），本方法需显式清除，
     *     恢复后续异常断连的自动重连能力（避免连上后再次掉线却因 dormant 不自动重连）。
     *   - deviceId 已清空，但 lastDeviceId（断开时保留）/ ble_last_device_id 仍在，
     *     作为重连直连锚点。
     *
     * 流程：清 dormant + 递增 guard（使在途旧 session 失效）→ 预清理旧句柄 → connect(lastDeviceId)。
     *
     * @returns {Promise<boolean>} true=重连成功
     */
    async reconnectDisconnected() {
      const targetId = this.lastDeviceId || uni.getStorageSync('ble_last_device_id') || this.deviceId
      if (!targetId) {
        console.warn('[Store] 重新连接失败：无已知设备锚点（lastDeviceId 为空）')
        return false
      }
      // ★ 清除「用户主动断开」抑制，恢复自动重连能力
      this.reconnectMode = 'idle'
      this._reconnectGuard++
      // ★ 预清理可能残留的系统连接句柄，避免「已连接却连不上」假死
      try {
        await new Promise((resolve) => {
          uni.closeBLEConnection({ deviceId: targetId, complete: () => resolve() })
        })
      } catch (e) { /* ignore */ }
      try {
        console.log('[Store] 用户主动重新连接:', targetId)
        const ok = await this.connect(targetId, this.deviceName)
        if (ok) {
          console.log('[Store] 重新连接成功')
          return true
        }
        return false
      } catch (e) {
        console.error('[Store] 重新连接失败', e?.message || e)
        // ★ 失败也保留 lastDeviceId，允许再次点击「重新连接」
        this.connected = false
        return false
      }
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
        // ★ fix11.1: 自动连准备路径传 autoEnable:false → BT 关时不弹系统框（由红 banner 引导），避免冷启动双弹
        await initBluetooth({ autoEnable: false })   // 打开适配器 + 申请权限
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
        this._rememberAdvertisedName(device.deviceId, device.name)
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
      this._staleSinceMs = 0
      this._rssiStaleWatchdog = setInterval(() => {
        if (!this.connected) return
        if (this._lastFf02AnyMs && Date.now() - this._lastFf02AnyMs > 4000) {
          this.displayRssi = -999
          // ★ 僵尸连接探测：FF02 长时间缺失，可能底层 GATT 已死(Android 未上报断连)。
          //   累计 20s 后主动做 GATT 探针(_verifyThenDisconnect 会先系统级+GATT 双重确认，
          //   还活着=Doze 节流转前台则忽略，真死才清理)，避免一直卡在"信号--且连着"。
          if (!this._staleSinceMs) this._staleSinceMs = Date.now()
          else if (Date.now() - this._staleSinceMs > 20000 && this.deviceId) {
            console.warn('[Store] FF02 静默 >20s，主动探测 GATT 是否为僵尸连接')
            this._verifyThenDisconnect(this.deviceId, { forceStale: true })
          }
        } else {
          this._staleSinceMs = 0
        }
      }, 1500)
    },
    _clearRssiStaleWatchdog() {
      if (this._rssiStaleWatchdog) { clearInterval(this._rssiStaleWatchdog); this._rssiStaleWatchdog = null }
    },
    // ★ 2026-07-24: 显示流合并（staging）相关 action
    startDisplayCoalescer() {
      // 懒启动：首次连接时调用一次，之后常驻（无包时 no-op，开销可忽略）
      if (_displayCoalescer) return
      const store = this
      _displayCoalescer = setInterval(() => {
        if (_stagedDisplay) store._commitStagedDisplay()
      }, _DISPLAY_COMMIT_TICK)
    },
    _commitStagedDisplay() {
      if (!_stagedDisplay) return
      // ★ 断连后丢弃暂存，避免显示陈旧值（disconnect 已将 rssi/deviceTempC 重置为 -999/null）
      if (!this.connected) { _stagedDisplay = null; return }
      const s = _stagedDisplay
      _stagedDisplay = null
      if (s.r !== undefined) {
        this.rssi = s.r
        this.rawRssiDisplay = s.r   // ★ 原始 RSSI 展示副本随合并提交（不再每条重渲染）
      }
      if (s.f !== undefined) {
        this.filteredRssi = s.f
        this.displayRssi = s.f      // 显示用 Kalman 滤波值（与区间判定同源，不二次平滑）
      }
      if (s.t !== undefined) this.deviceTempC = s.t
    },
    // ★ 回前台立即提交最新暂存，保证第一帧即显示当前真实态（不回放历史）
    flushStagedDisplay() {
      this._commitStagedDisplay()
    },
    // ★ v3.31.0 / 2026-07-13: 每次（重）连接时重置 RSSI 显示态 + 启动看门狗
    _resetRssiDisplay() {
      this.displayRssi = -999
      this.rawRssiDisplay = -999   // ★ 2026-07-24: 重连重置同步清零
      this.rssiEma = -999
      this._lastFf02AnyMs = 0
      this._lastRssiDisplayMs = 0
      this._staleSinceMs = 0
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
      // ★ 2026-08-17: 记录最近一次真实 FF02 到达时间戳，供 _repairConnection 轻量恢复
      //   探测"FF02 是否真恢复"使用。不能用 statusStale（会被 _resetStatusStaleTimer 清掉，
      //   导致探测恒为假阳性）。此时间戳是"链接真活"的权威证据，与 FF02 实时流量同源。
      this._lastFf02At = Date.now()
      // ★ 2026-08-17 (P-FF02): FF02 已真实到达 → 取消到达验证看门狗并清零连续静默计数
      if (this._ff02ArrivalTimer) { clearTimeout(this._ff02ArrivalTimer); this._ff02ArrivalTimer = null }
      this._ff02ProbeRunning = false
      this._ff02SilentRepairs = 0
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
      // ★ 2026-08-12: 固件有时把命令回执(RSSISET:OK 等)经 FF02 Notify 通道透传下来，
      //   这类串无 '{' 会被下方 tryParseJSON 判为解析失败并刷噪声。先按前缀过滤，直接忽略。
      if (typeof jsonStr === 'string' && jsonStr.indexOf('RSSISET:') === 0) return
      // ★ 2026-07-18: 固件把命令回执前缀(SETPASS:OK / ENCRYPT:OK / ENCRYPT:OFF)拼在同一 Notify 的
      //   status JSON 前；若 _charHandler 未识别(白名单漏配)而整串透传下来，这里兜底再截一次首 '{'。
      let _ps = jsonStr
      const _pb = _ps.indexOf('{')
      if (_pb > 0) _ps = _ps.slice(_pb)
      const data = tryParseJSON(_ps)
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

      // ★ 2026-07-30: 每收到一包 FF02 即刷新「心跳」时间戳（用于断连活性判别）。
      //   较旧实现(仅含 f 字段时刷新) 更稳——部分状态包无 f 会漏判。
      this._lastFf02AnyMs = Date.now()
      // ★ 2026-08-13 第六刀: AUTH:OK 包已自带「短延时 120ms」flush(见 _armPostAuthWrites)，此处
      //   首帧加速仅作「更快」优化——若下一包 FF02 在 120ms 内先到，则提前 flush。FF02 是 notify
      //   (只读属性)，不能单独证明 FF01/FF03(write 属性)缓存已就绪，但作为加速信号无害(触发后仍有
      //   utils/ble.js 重试自愈)。主路径已由 _armPostAuthWrites 的 120ms 短延时保证确定性。
      if (this.sessionAuthed && this._postAuthWritesPending && !this._gattWriteReady) {
        console.log('[Store] 首帧 FF02 到达(加速触发)，下发 AUTH:OK 后挂起写')
        this._flushPostAuthWrites()
      }
      // 若正处于「断连事件后的活性缓刑」中，收到 FF02 即证明链接真活 → 假断连，撤销缓刑。
      if (this._disconnectProbing) {
        this._disconnectProbing = false
        if (this._disconnectProbeTimer) { clearTimeout(this._disconnectProbeTimer); this._disconnectProbeTimer = null }
        console.log('[Store] 活性缓刑期间收到 FF02 → 链接真活，判定为假断连，忽略')
      }

      // 连接与车辆状态
      if (data.c !== undefined) {
        // ★ v3.25-fix: 收到 FF02(c:1) 即视为已连，取消"假断连"的延迟 RSSI 清零
        if (data.c === 1 && this._disconnectRssiClearTimer) {
          clearTimeout(this._disconnectRssiClearTimer)
          this._disconnectRssiClearTimer = null
        }
        this.connected = data.c === 1
        if (this.connected) this.startDisplayCoalescer()   // ★ 懒启动合并提交（仅启动一次，常驻）
      }

      // ★ 2026-07-24: 显示字段走「非响应式暂存 + 合并提交」(staging)，根治后台/重连 burst 回放/狂跳。
      //   每条包只覆盖 _stagedDisplay（last-value-wins），由 _displayCoalescer 每 ~100ms 提交最新值一次
      //   → N 条积压包合并为 1 次渲染，显示延迟 ≤100ms。控制流副作用(connected/st/绑定/无App模式/电量)即时，不走暂存。
      if (data.r !== undefined && data.r > -999) {
        if (!_stagedDisplay) _stagedDisplay = {}
        _stagedDisplay.r = data.r
      }
      if (data.f !== undefined && data.f > -999) {
        if (!_stagedDisplay) _stagedDisplay = {}
        _stagedDisplay.f = data.f
        this._lastFf02AnyMs = Date.now()   // ★ 看门狗用「真实包到达时刻」，保持即时（不随提交延迟）
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
        const resolvedMode = data.m ? 'ebike' : 'car'
        this.deviceMode = resolvedMode
        // ★ 回写权威值到本地缓存：防止此前「乐观更新写缓存但设备未真正切换」造成缓存脏，
        //   导致下次启动经历 设备真实值 ↔ 缓存值 来回跳变（2026-07-18 用户反馈的重启闪烁）。
        //   设备主动下发的 m 即真实状态，以它为准固化缓存，保证下次启动与设备一致。
        if (this.serialNumber) {
          try { uni.setStorageSync('keygo_mode_' + this.serialNumber, resolvedMode) } catch (e) {}
        }
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
      // ★ 2026-08-14: 钥匙供电策略 (kpm = key power mode)
      //   来自 FF02 上报；0=TIMEOUT(15s 限时通电), 1=HOLD_UNTIL_LOCK(解锁后保持到锁车/断连)
      if (data.kpm !== undefined) this.keyPowerMode = (Number(data.kpm) === 0) ? 0 : 1

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

      // ★ 2026-07-19: 电瓶车靠近骑行偏好 (er 字段) — 固件 g_ebikeProxMode 实时镜像。
      //   仅 ebike 模式有意义; 对账逻辑同 noAppMode: 脏标记时若设备未对齐则重发 EPRX 自愈。
      if (data.er !== undefined) {
        const ep = (Number(data.er) === 1) ? 1 : 0
        if (this._ebikeProxDirty) {
          if (ep !== this.ebikeProxMode) {
            console.warn('[Store] 电瓶车靠近骑行设备未对齐(er=' + ep + ',期望=' + this.ebikeProxMode + ')，重发 EPRX:' + (this.ebikeProxMode ? '1' : '0'))
            if (this.connected && this.deviceId) {
              // ★ 修正 2026-07-19: 对账重发也必须带 C1 签名(同 setEbikeProxMode)，否则固件 NO_SIG 拒绝 → 死循环重发。
              this.sendCommand(this.ebikeProxMode ? 'EPRX:1' : 'EPRX:0')
                .catch((e) => console.error('[Store] 重发 EPRX 失败:', e))
            }
          } else {
            this._ebikeProxDirty = false
            console.log('[Store] 电瓶车靠近骑行已落盘 er =', ep)
          }
        } else if (this.ebikeProxMode !== ep) {
          this.ebikeProxMode = ep
          console.log('[Store] 电瓶车靠近骑行同步设备 er =', ep, '(fwVersion=' + this.fwVersion + ')')
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
          // ★ 2026-07-19: 设备复位同样清掉 g_ebikeProxMode → 本地期望态一并归零，避免对账误重开骑行偏好
          this.ebikeProxMode = 0
          this._ebikeProxDirty = false
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

      // ★ v3.36.1: 内部芯片温度遥测（t 字段，摄氏度整数，固件 TSENSE 采样，5s 节流）。
      //   固件 v3.36.1 起上报；旧固件无此字段 → deviceTempC 保持 null，UI 不显示温度。
      // ★ 2026-07-24: 温度同样进暂存（5s 才变一次，burst 内同值，合并不影响精度）
      if (data.t !== undefined) {
        if (!_stagedDisplay) _stagedDisplay = {}
        _stagedDisplay.t = Number(data.t)
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
          // ★ v3.25-fix2: 连接存活但 FF02 中断 → 自愈重建 GATT 上下文（见 _repairConnection）
          this._repairConnection()
        }
        this._statusStaleTimer = null
      }, 8000)  // ★ 2026-08-16: 3s→8s。3s 太激进——固件在 AUTH/配置下发/命令处理期间会暂停 FF02
      //   推送（日志 23:56:36 AUTH:OK → 43.6 超时，~7s 没 FF02 但连接完全正常），3s 超时把"固件忙"
      //   误判成"链接死"→ _repairConnection 误拆好链 → 断连循环。8s 给固件充足处理窗口，
      //   仍 < 固件 30s 未-AUTH 强断窗，且 _repairConnection 有 _repairing 豁免自伤。
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
      if (!targetId) return
      // ★ 2026-08-09: 先复核系统真实连接状态（getBLEDeviceServices 探活）。
      //   日志曾出现「系统已确认断连(connected=false) 后 _statusStaleTimer 仍触发本函数」
      //   对已死连接强行 closeBLEConnection+重建 GATT，制造混乱且打断在途 AUTH 握手。
      //   若系统已真断，直接转常规重连，不再走 GATT 重建路径。
      const alive = await this._verifyConnection(targetId, 1500).catch(() => false)
      if (!alive) {
        console.warn('[Store] ⚠ 状态过期但系统已真断 → 放弃 GATT 重建，转常规重连')
        this.connected = false
        this.statusStale = true
        if (typeof this._scheduleReconnect === 'function') this._scheduleReconnect(0)
        return
      }
      // ★ 2026-08-17 (P-FF02): await _verifyConnection 期间另一路 _repairConnection 可能已接管
      //   （探测看门狗 与 8s 状态看门狗 都可能触发，两路都能通过入口 _repairing 检查），
      //   这里二次检查防"双重建并发"。
      if (this._repairing) {
        console.log('[Store] _repairConnection: 检测到并发重建进行中，本次跳过')
        return
      }
      this._repairing = true
      console.warn('[Store] ⚠ 连接存活但状态过期 → 先尝试轻量恢复 FF02 订阅（不拆链）')
      try {
        // ★ 2026-08-17 关键修复（来自 00:00:50 日志复盘）：
        //   旧逻辑直接 closeBLEConnection 拆链重建——但"FF02 超时"大多数时候不是链接死，而是
        //   固件忙(AUTH/命令处理)暂停推送，或 CCCD 被 Doze 重置。拆链重建风险极高：重建失败
        //   (status:8)会把好连接拆成断连且无法恢复。改为两阶段：
        //   ① 轻量恢复：不拆链，只重新 enableStatusNotify（重设 CCCD=0x0001）+ 重武装看门狗，
        //      等 3s 看 FF02 是否恢复。大多数场景这一步就够（CCCD 重置后 FF02 立即恢复）。
        //   ② 仅当轻量恢复失败（3s 后仍无 FF02）才拆链重建（高风险手段，最后才用）。
        this._resetStatusStaleTimer()  // 重武装 8s 看门狗
        await this._enableStatusNotify()
        // 等 3s 看 FF02 是否真恢复
        // ★ 2026-08-17 修正：改用 _lastFf02At 时间戳判断，而非 statusStale。
        //   旧探测用 `if (!this.statusStale)`——但 statusStale 在上一行 _resetStatusStaleTimer()
        //   已被清成 false，导致探测循环 200ms 后恒判"恢复成功"，FF02 实际根本没恢复 →
        //   假阳性 → 跳过拆链 → 8s 后又超时 → 真断连。现记录探测起点 _lastFf02At，若期间
        //   收到新的 FF02（时间戳前移）才判真恢复。
        const _probeStart = this._lastFf02At || 0
        await new Promise((resolve) => {
          const _t = setTimeout(() => { resolve() }, 3000)
          const _probe = setInterval(() => {
            if (!this.connected) { clearInterval(_probe); clearTimeout(_t); resolve(); return }
            if ((this._lastFf02At || 0) > _probeStart) {
              clearInterval(_probe); clearTimeout(_t); resolve()
            }
          }, 200)
          setTimeout(() => clearInterval(_probe), 3500)
        })
        if (!this.connected) {
          console.warn('[Store] 轻量恢复期间连接已断，跳过拆链重建（交由断连流程）')
          return
        }
        if ((this._lastFf02At || 0) > _probeStart) {
          console.warn('[Store] ✓ 轻量恢复成功（FF02 已恢复），跳过拆链重建')
          return
        }
        // 轻量恢复失败：FF02 仍死，才走高风险拆链重建
        // ★ 2026-08-17 (P-FF02): 连续多次拆链重建仍无 FF02 → 停止暴力拆链（耗电且无效），
        //   交给常规断连/重连兜底，日志明确提示方向（固件未推送 / ROM 底层问题）。
        if (this._ff02SilentRepairs >= 3) {
          console.error('[FF02] ❌ 连续多次拆链重建仍无 FF02，停止自愈拆链（等待固件超时断连 / 手动重连，需抓固件串口定界）')
          return
        }
        console.warn('[Store] ⚠ 轻量恢复失败（3s 仍无 FF02），拆链重建 GATT 上下文')
        // 1) 拆掉可能陈旧的 GATT 上下文（未连接时 close 报错，忽略即可）
        // ★ 2026-08-16: _repairing=true 已让全局监听器豁免本次 close 触发的断连事件（见 L650），
        //   避免"自己拆链→被自己当故障→重连→又拆"的循环。
        // ★ 2026-08-17 硬超时：complete 在 Android 上可能不回调 → 本 await 永久 pending →
        //   _repairConnection 卡死在拆链 → _repairing 永不释放 → 后续所有自愈被挡。加 2s 超时。
        await Promise.race([
          new Promise((resolve) => {
            try { uni.closeBLEConnection({ deviceId: targetId, complete: () => resolve() }) } catch (e) { resolve() }
          }),
          new Promise((resolve) => setTimeout(() => {
            console.warn('[Store] _repairConnection: closeBLEConnection 硬超时(2s)，强制放行拆链')
            resolve()
          }, 2000))
        ])
        await new Promise(r => setTimeout(r, 400))
        // 2) 全新连接（获取新鲜 GATT 句柄）
        this.connected = false
        // ★ 2026-08-16: 清幂等守卫，允许 _finalizeConnection 重新初始化（重建 = 新会话）
        this._connFinalizedFor = null
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
      // ★ 2026-08-14: 钥匙供电策略（用户改了即时更新 UI 状态；真实值仍以 FF02 回显为准）
      if (config.kpm !== undefined) this.keyPowerMode = (Number(config.kpm) === 0) ? 0 : 1
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
      // ★ 2026-08-09 修复：!B._bindKey（本机无该设备绑定密钥）原静默 return，无任何提示。
      //   后果：连上后 authed 永远 false → 固件 30s 超时强断，用户只看到"连上又被踢"，
      //   完全不知道是"本机未绑定"导致。改为显式置 need-bind 状态 + bindHint，让 UI 立即告知用户。
      if (!B._bindKey) {
        if (!B._bindInProgress) {
          this._autoAuthState = 'need-bind'
          this.bindHint = '设备未绑定，请先绑定'
          console.warn('[BIND] 本机无绑定密钥，无法自动鉴权 → 需用户手动绑定（否则固件 30s 超时强断）')
        }
        return
      }
      if (B._bindInProgress || !this.connected) return
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
        // ★ 2026-08-13 深度修正（回退基线 + 轻量兜底）:
        //   之前三刀（12×150ms 密集 / 800ms 固定热身 / 递增退避 + retries:0）实测反而拖慢首连——
        //   retries:0 关掉了底层 2×400ms 兜底，把任何微小抖动都放大成"显式失败→上层重试"的可见慢。
        //   回退到基线行为：NONCE 走底层默认 _WRITE_10007_RETRIES(2)+400ms 重试兜底（首连一枪过、
        //   零影响；重连偶发冷窗口由底层静默救回）。仅保留【单次】10007 轻量重试作为双保险，
        //   不循环、不霸占 enqueueWrite 写链，绝不拖首连。
        try {
          await enqueueWrite(() => rawSendCommand(this.deviceId, 'NONCE'))
        } catch (e) {
          if (isGattConflict(e)) {
            console.warn('[BIND] NONCE 首写 10007，轻量重试一次…')
            await new Promise((r) => setTimeout(r, 300))
            await enqueueWrite(() => rawSendCommand(this.deviceId, 'NONCE'))
          } else {
            throw e
          }
        }
      } catch (e) {
        clearTimeout(timer)
        _resolveWaiter('NONCE', null)
        return null
      }
      const hex = await p
      done = true
      clearTimeout(timer)
      // ★ 2026-07-19: BIND_DISCONNECTED 表示断连——_flushBindWaiters 在 _handleDisconnect 中 resolve 了 waiter
      if (hex === BIND_DISCONNECTED) return null
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
        extendConnectGrace()   // ★ 2026-07-18: 加密握手刚完成，其后 FF03 写(RSSISET 等)仍在瞬时窗口，
                               //   延伸宽限期避免被误判"蓝牙缓存过期"弹窗
        this._autoAuthState = 'idle'   // ★ 2026-07-12: 会话已建立，自动 AUTH 状态机归位
        this.bindHint = ''
        // ★ 2026-07-14 修复：AUTH 握手成功即证明本机是该设备的 owner
        //   （陌生人/未绑定连接永远到不了 AUTH:OK）。据此清除「未绑定超时被踢」的
        //   持久化抑制标记，恢复后续自动重连（含 App 重启）。否则该标记一旦写入便
        //   永久屏蔽自动重连，导致正常 owner 在重烧固件/瞬时超时后无法自动重连（舒适模式失效）。
        this._clearUnboundKicked()
        // ★ 2026-08-09 P1-①: AUTH:OK = 本机已通过该设备鉴权（真 owner），记为已知设备。
        //   陌生人/未绑定连接永远到不了 AUTH:OK，故不会污染 knownDevices。
        this._touchKnownDevice(this.deviceId)
        // ★ 2026-08-12 合并版: AUTH 成功后需要下发「配置(FF01) + 本机 RSSI 阈值(FF03)」，
        //   但加密握手刚完成、OS 对 GATT WRITE 属性缓存可能尚未就绪，此刻硬写必撞 10007。
        //   不再立即写，而是「挂起等 AUTH:OK 后首帧 FF02 到达」(FF02 能送达=通道完全可用)再发；
        //   同时挂 800ms 超时兜底(首帧 FF02 不来也强制发)。详见 _armPostAuthWrites / _flushPostAuthWrites。
        this._armPostAuthWrites()
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
        // ★ 2026-08-09 P1-①: BIND:OK = 首绑/接管成功（新 owner），记为已知设备。
        this._touchKnownDevice(this.deviceId)
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
        // ★ 2026-08-09 P1-①: 用户主动解绑 → 不再是有效 owner → 移出已知设备集合
        this._removeKnownDevice(this.deviceId)
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
      } else if (text.startsWith('DENY:')) {
        // ★ 2026-07-19 P2: 通用 DENY 兜底(如 EPRX 在 car 模式回 DENY:NOT_SUPPORTED)。
        //   此前无此分支 → DENY 被静默吞掉、B._cmdWaiter 不触发 → sendCommand 走超时误判成功。
        //   现让本次控制命令 reject，使调用方(如 setEbikeProxMode)能感知 DENY 并停止重发/回退 UI。
        const reason = (text.slice('DENY:'.length).replace(/[^A-Z0-9_]/g, '') || 'DENIED')
        if (B._cmdWaiter) { const w = B._cmdWaiter; B._cmdWaiter = null; w({ code: reason, msg: ERROR_MSGS[reason] || ('命令被拒绝: ' + reason) }) }
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
        // ★ 2026-07-22: 重发 ENCRYPT:1 重新拉开配对窗口(30s)，避免「开启无App模式」
        //   到真正 createBond 之间窗口已过期 → 固件 PasscodeCB 返回 FAILURE 拒配对 →
        //   Android 进入“幽灵配对”状态(现象: 配对失败 + 之后扫描不到设备, 需重启App才恢复)。
        //   无App模式已开时重发幂等(仅重置 encRequired/配对模式/开窗)。
        try {
          await enqueueWrite(() => rawSendCommand(this.deviceId, 'ENCRYPT:1'))
          await new Promise((r) => setTimeout(r, 150))
          console.log('[BOND] 已重发 ENCRYPT:1 确保配对窗口开启')
        } catch (e) { console.warn('[BOND] 重发 ENCRYPT:1 失败(忽略, 继续尝试配对)', e) }

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
    /**
     * ★ 2026-08-12 合并版: AUTH:OK 后挂起「配置 + RSSI 阈值」写。
     *   加密握手刚完成时 OS 对 GATT WRITE 属性缓存可能尚未就绪，此刻硬写 FF01/FF03 必撞 10007。
     *   挂起标记 + 启 800ms 超时兜底；等 AUTH:OK 后首帧 FF02 到达(_parseSingleStatus 触发 _flushPostAuthWrites)
     *   再真正下发——FF02 能送达即证明 GATT 通道完全可用、OS 缓存已刷新，10007 概率趋零。
     */
    _armPostAuthWrites() {
      this._gattWriteReady = false
      this._postAuthWritesPending = true
      if (this._postAuthWriteTimer) { clearTimeout(this._postAuthWriteTimer); this._postAuthWriteTimer = null }
      // ★ 2026-08-13 第六刀(决定性): AUTH:OK 包本身就是 FF02 实时 notify，已证明 FF02 通道通。
      //   之前依赖「下一包 FF02 到达(3541 首帧加速)」触发 flush——但 AUTH:OK 解析时 _postAuthWritesPending
      //   还 false(4074 行在解析后才设)，AUTH:OK 这包错过自我触发；之后下一包 FF02 时机不可控(实测重连
      //   有 ~480ms 空窗)→ fallback 1000ms 保底，慢。
      //   正解: 既然 AUTH:OK 已到(FF02 实时包)，直接启「短延时 120ms」flush——既留热身窗口(避 10007)，
      //   又不等不确定的下一包。每次 AUTH:OK 都走此路径，与第一次(首帧加速)一样快且确定。
      //   - 快系统: 3541 首帧加速若更早到则提前 flush(更快)；否则 120ms 短延时兜底。
      //   - 慢系统: 120ms 短延时必触发，不再等 480ms+ 空窗 → 快 ~880ms。
      //   - 1000ms 保底保留作双保险(防极端情况 120ms 内也崩)。
      //   触发后若仍偶发 10007，由 utils/ble.js 既有 400ms×2 重试自愈，功能无损。
      const _targetId = this.deviceId
      setTimeout(() => {
        if (this.deviceId !== _targetId || !this.connected) return
        if (this._postAuthWritesPending) {
          console.log('[Store] AUTH:OK 后短延时(120ms)下发挂起写（FF02 已验证，不等下一包）')
          this._flushPostAuthWrites()
        }
      }, 120)
      this._postAuthWriteTimer = setTimeout(() => {
        this._postAuthWriteTimer = null
        if (this._postAuthWritesPending) {
          console.log('[Store] 1000ms 延时保底，下发挂起写（FF02 未提前触发或不可靠）')
          this._flushPostAuthWrites()
        }
      }, 1000)
      console.log('[Store] AUTH:OK 后写已挂起（AUTH:OK 即 FF02 已验证 + 120ms 短延时 / 首帧加速 / 1000ms 保底）')
    },

    /**
     * ★ 2026-08-12 合并版: 首帧 FF02 到达 / 超时兜底时，执行 AUTH:OK 后的挂起写。
     *   仅下发一次（_postAuthWritesPending 幂等），且下发前再校验连接态。
     */
    async _flushPostAuthWrites() {
      if (!this._postAuthWritesPending) return
      this._postAuthWritesPending = false
      this._gattWriteReady = true
      // ★ 2026-08-13 第七刀: _postAuthWritesPending 在此刻即置 false，但 FF03 还要等
      //   「FF01 落地 + 250ms」才发，整条链尚未收尾。故另立 _postAuthWritesInFlight，
      //   供电池兜底读取(_fetchBatteryLevel)判断「配置下发主链是否真正结束」，
      //   避免电池 read 抢占 GATT 事务槽把 FF03 挤掉（10007 根因）。
      this._postAuthWritesInFlight = true
      if (this._postAuthWriteTimer) { clearTimeout(this._postAuthWriteTimer); this._postAuthWriteTimer = null }
      if (!this.connected || !this.deviceId) {
        console.log('[Store] 挂起写跳过（已掉线/无设备）')
        this._postAuthWritesInFlight = false
        return
      }
      console.log('[Store] GATT 写就绪，下发 AUTH:OK 后挂起写')
      // ① 配置补发（FF01）：AUTH 成功 = 安全通道已建立，重连时 _finalizeConnection 的抢跑写可能失败，
      //    此处可靠补发；串行化(_configWriteBusy/_configSyncPending)保证不重复、不竞态。
      //    await 等其真正写入完成（成功/失败都算落地），再发 FF03。
      await this._syncConfigToDevice()
      // ② 本机 RSSI 阈值（FF03）：per-phone 阈值跟随，best-effort。
      //    ★ 2026-08-12 关键修订(第三刀修正): FF01 与 FF03 是两条不同 write 特征，Android 对它们的
      //      WRITE 属性缓存分别刷新、不同步。固定延时(300ms)不可靠——系统热身慢时 FF01 自己都撞 10007
      //      重试到 ~400ms 才成，FF03 的 300ms 定时反而比 FF01 成功更早发 → 仍撞窗。
      //      正解: 事件驱动串行——等 FF01 真正落地后再延 250ms 发 FF03，FF03 永远在 FF01 写完后发，
      //      绝不抢窗口，与系统热身速度无关。
      const _targetId = this.deviceId
      setTimeout(async () => {
        if (this.deviceId !== _targetId || !this.connected) {
          this._postAuthWritesInFlight = false
          return
        }
        try {
          await this._pushRssiThresholds()
        } finally {
          // ★ 第七刀: FF03 落地(成功/失败均算) → 整条 AUTH:OK 后下发链收尾，
          //   放行电池兜底读取去占用 GATT 事务槽。
          this._postAuthWritesInFlight = false
        }
      }, 250)
    },

    // ★ 2026-08-13 第七刀: 返回 Promise（跳过时返回已 resolve），使 _flushPostAuthWrites 可 await 到落地。
    _pushRssiThresholds() {
      if (this.fwSec < 2 || !this.deviceId || !this.connected) return Promise.resolve()
      const u = this.unlockThreshold, l = this.lockThreshold
      // ★ 2026-07-19 P1: 去重——与上次成功下发的 per-phone 阈值相同则跳过。
      //   阈值已存于设备 Flash(g_cfg)，无需重复写；既省一次 GATT 写，也消除噪声。
      //   （注：App 侧 _lastPushed* 是运行时 RAM 标记，重连保留、App 冷启才清空，非来自设备 Flash。）
      if (this._lastPushedUnlock === u && this._lastPushedLock === l) {
        console.log('[Store] RSSISET 跳过(阈值未变): ' + u + ':' + l)
        return Promise.resolve()
      }
      return this._doPushRssi(u, l)
    },

    // ★ 2026-08-12: RSSISET 实际下发（抽出便于挂起/即时两路复用）
    // ★ 2026-08-13 第七刀: 返回 Promise（原为 fire-and-forget），使调用方能 await 到「FF03 真正落地」。
    //   _flushPostAuthWrites 依赖此以准确清除 _postAuthWritesInFlight，否则电池读会在 FF03 落地前
    //   被放行 → 又抢 GATT 事务槽 → 10007 重现。仍不向外抛错（best-effort 语义不变）。
    _doPushRssi(u, l) {
      const cmd = 'RSSISET:' + u + ':' + l
      return enqueueWrite(() => rawSendCommand(this.deviceId, cmd))
        .then(() => { this._lastPushedUnlock = u; this._lastPushedLock = l })
        .catch(() => {})
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
      this._lastPushedUnlock = null   // ★ 2026-07-19 P1: 设备已复位，per-phone 阈值失效，下次 AUTH:OK 强制重推 RSSISET
      this._lastPushedLock = null
      this.deviceBound = false
      B._sessionSalt = null; B._cmdSeq = 0
      if (this.serialNumber) this._clearBindKey(this.serialNumber)
      this.needsRebind = true
      this.bindHint = reason || '设备已重置，请重新绑定'
      // ★ 2026-08-09 P1-①: 设备已失效(复位/解绑)，不再是有效 owner → 移出已知设备集合
      this._removeKnownDevice(this.deviceId)
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

      // ★ 2026-07-19: 绑定前诊断——连接已断或 fwVersion 为空则提前退出。
      //   fwVersion 为空说明 FF02 状态通知从未到达，设备端 Notify 可能不通——继续走绑定大概率也收不到 BIND:OK。
      if (!this.connected) {
        B._bindInProgress = false
        this.bindHint = '设备未连接，请先连接设备后再绑定'
        return false
      }
      if (!this.fwVersion) {
        console.warn('[BIND] ⚠ fwVersion 为空——FF02 状态通知可能未到达。绑定将继续进行，但若收不到 BIND:OK 可能是 Notify 通道不通。')
      }

      // ★ 2026-07-15: usePasskey 偏好门控——仅当用户开启「passkey 配对(舒适进入)」才发起系统配对。
      //   关闭(默认,最大兼容)：跳过配对，绑定码以明文 BIND+AUTH 传输，全平台/标准基座可用，
      //     但无 OS 级加密重连、需 App 在前台/后台维持连接才解锁。
      //   开启：调原生 createBond 弹系统配对窗(需自定义基座+原生插件)，配对成功→OS 加密重连→无 App 也能解锁。
      if (this.usePasskey) {
        // ★ 2026-07-22 修正：主动绑定一律 forceRebond=true，清掉 Android 可能残留的
        //   陈旧/幽灵 bond（B 之前配对失败常留「已配对」假状态）→ 否则 createBond 不强制重绑、
        //   配对静默失败。清掉后重新弹系统配对窗，配合固件 60s 配对窗即可稳定配对。
        const bondRes = await this._triggerBond(true)
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
      // ★ 2026-07-19: BIND_DISCONNECTED 表示设备在 BIND 写入后断连
      if (bindOk === BIND_DISCONNECTED) {
        B._bindConfirmByStatus = false
        B._bindInProgress = false
        this.bindHint = '设备连接已断开，请重新连接后重试绑定'
        return false
      }
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
          // ★ 2026-07-19: 优先检查设备是否已断连——若连接已断，提示重连而非"固件无回应"
          this.bindHint = this.connected
            ? (B._lastBindRaw
              ? ('绑定失败，固件回包: ' + B._lastBindRaw)
              : '绑定失败：BIND 写入后固件无回应（BIND:OK 与 AUTH 握手均未确认）')
            : '设备连接已断开，请重新连接后重试绑定'
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
        // ★ 解绑/恢复出厂 联动关闭「无 App 模式」：设备端加密配对上下文会被清除，
        //   本地期望态一并归零并尽力下发 ENCRYPT:0（未连接/链路被删配对打断时，
        //   由 status.pair 对账在下次连接自愈）。按钮即随之关闭。
        console.log('[UNBIND] 联动关闭无 App 模式 setNoAppMode(false)，当前 noAppMode=' + this.noAppMode)
        this.setNoAppMode(false)
        console.log('[UNBIND] 关闭后 noAppMode=' + this.noAppMode)
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

      // ★ v3.36.3-fix5: 同时按 MAC 持久化一份自定义名，供断连后的扫描列表/重连卡统一显示
      if (this.deviceId) {
        this._seedCustomNameByMac(this.deviceId, name)
      }

      // ★ 本地存储（按序列号索引）；恢复默认名时删除条目而非存空串
      if (this.serialNumber) {
        this._loadDeviceNames()
        if (name) {
          this._deviceNames[this.serialNumber] = {
            name: name,
            lastSeen: Date.now()
          }
        } else {
          delete this._deviceNames[this.serialNumber]
        }
        this._saveDeviceNames()
        console.log('[Store] 设备名称已保存到本地 (SN:', this.serialNumber, '):', name || '(已恢复默认名)')
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

    // ★ 2026-07-19: 设置电瓶车「靠近直接进入骑行模式」(固件侧持久化, 仅 ebike 模式有效)。
    //   开启: 经写队列串行化下发 EPRX:1 → 固件 g_ebikeProxMode=1 → 靠近时状态机调 KeyGo_Ride()。
    //   关闭: 下发 EPRX:0 → 回到仅解锁(=现状=安全默认)。
    //   置 _ebikeProxDirty 标记, 连接对账自愈(仿 noAppMode); car 模式 UI 隐藏且下发会被固件 DENY 兜底。
    setEbikeProxMode(v) {
      const on = !!v
      this.ebikeProxMode = on ? 1 : 0
      this._ebikeProxDirty = true
      if (!this.connected || !this.deviceId) {
        console.warn('[Store] setEbikeProxMode: 未连接，仅记录期望态，连上后由 status.er 对账下发')
        return
      }
      // ★ 修正 2026-07-19: EPRX 走 KeyGo_HandleCommand(签名校验之后)，必须带 C1 签名，
      //   故走 sendCommand(自动 _signCommand) 而非 rawSendCommand(裸发会被固件 CMD:FAIL:NO_SIG 拒绝)。
      //   与 setDeviceMode('MODE:ebike') 同源；未鉴权会 throw NOT_BOUND，由 .catch 兜底、对账自愈。
      this.sendCommand(on ? 'EPRX:1' : 'EPRX:0')
        .then(() => console.log('[Store] 电瓶车靠近骑行已下发 EPRX:' + (on ? '1' : '0')))
        .catch((e) => {
          // ★ 2026-07-19 P2: 固件 DENY(如 car 模式回 NOT_SUPPORTED) → 命令未执行。
          //   清 _ebikeProxDirty 终止对账重发；随后 status.er 对账的 else-if 分支会把 UI 回退到设备真实态。
          if (e && e.code && (e.code === 'NOT_SUPPORTED' || String(e.code).indexOf('NOT_SUPPORT') >= 0)) {
            this._ebikeProxDirty = false
            console.warn('[Store] 电瓶车靠近骑行被固件 DENY(不支持)，停止重发并回退 UI 到设备真实状态')
          } else {
            console.error('[Store] 下发 EPRX 失败:', e)
          }
        })
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
