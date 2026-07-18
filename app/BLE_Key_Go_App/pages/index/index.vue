<template>
  <view class="page-index" :class="themeClass">
    <!-- ★ 蓝牙关闭横幅（模仿 nRF Connect）：系统弹窗期间保持红色 -->
    <view class="bt-off-banner" v-if="!bleStore.connected && bleStore.btState === 'off'">
      <text class="bt-off-icon">🔴</text>
      <text class="bt-off-text">蓝牙已关闭</text>
      <button class="bt-enable-btn" @tap="handleEnableBluetooth">开启</button>
    </view>
    <!-- ★ 绿色"正在开启"横幅：与底部系统弹窗同步出现/消失，模仿 nRF Connect -->
    <view class="bt-on-banner" v-if="!bleStore.connected && bleStore.btState === 'just_enabled'">
      <text class="bt-on-icon">🟢</text>
      <text class="bt-on-text">正在开启蓝牙...</text>
    </view>

    <!-- ★ 顶部状态卡片 -->
    <view class="status-card" :class="{
      connected: bleStore.connected,
      reconnecting: !bleStore.connected && (bleStore.reconnectMode === 'active' || bleStore.reconnectMode === 'paused')
    }">
      <view class="status-icon">
        <text v-if="bleStore.connected">🔗</text>
        <text v-else-if="bleStore.reconnectMode === 'active'">🔄</text>
        <text v-else-if="bleStore.reconnectMode === 'paused'">⏳</text>
        <text v-else>📡</text>
      </view>
      <view class="status-info">
        <text class="status-title">
          {{ bleStore.connected ? '已连接' : (bleStore.reconnectMode === 'active' ? '重新连接中...' : (bleStore.reconnectMode === 'paused' ? '等待重连 ' + bleStore.reconnectNextDelay + 's' : '未连接')) }}
          <text v-if="bleStore.connected && bleStore.customDeviceName" class="custom-name-display">{{ bleStore.customDeviceName }}</text>
        </text>
        <text class="status-sub" v-if="bleStore.connected">
          {{ bleStore.deviceName }} | {{ bleStore.stateText }}
        </text>
        <text class="status-sub" v-else-if="bleStore.reconnectMode === 'active'">设备已离线，正在自动重连...</text>
        <text class="status-sub" v-else-if="bleStore.reconnectMode === 'paused'">第 {{ bleStore.reconnectAttempt }} 次重连失败，稍后自动重试</text>
        <text class="status-sub" v-else>扫描下方设备进行连接</text>
      </view>
      <view class="status-rssi" v-if="bleStore.connected">
        <text class="rssi-value">{{ bleStore.displayRssi > -999 ? bleStore.displayRssi : '---' }}</text>
        <text class="rssi-unit">dBm</text>
      </view>
      <!-- ★ v3.36.1: 电池电量 — 缩小整行，置于「已连接」框(🔗)内底部；断开后 batteryLevel 重置为 -1 自动隐藏 -->
      <view class="card-batt" v-if="bleStore.batteryLevel >= 0" :class="bleStore.batteryColor">
        <text class="batt-icon">{{ bleStore.batteryIcon }}</text>
        <text class="batt-text">{{ bleStore.batteryText }}</text>
      </view>
    </view>

    <!-- ★ 信号强度条 -->
    <view class="signal-section" v-if="bleStore.connected">
      <view class="signal-header">
        <text class="signal-label">信号强度</text>
        <text class="signal-dist">{{ bleStore.rssiDistance }}</text>
      </view>
      <view class="signal-bar-bg">
        <view class="signal-bar-fill" :style="{ width: bleStore.rssiPercent + '%' }"
          :class="{ weak: bleStore.rssiPercent < 30, medium: bleStore.rssiPercent >= 30 && bleStore.rssiPercent < 60, strong: bleStore.rssiPercent >= 60 }">
        </view>
      </view>
      <view class="signal-thresholds">
        <text>锁车 {{ bleStore.lockThreshold }} dBm</text>
        <text>解锁 {{ bleStore.unlockThreshold }} dBm</text>
      </view>
    </view>

    <!-- ★ v3.36.1: 连接页补充 — 芯片温度（信号强度下方，与控制页同源）；电池已移至「已连接」框下方 -->
    <view class="conn-extra" v-if="bleStore.deviceTempC !== null">
      <view class="temp-card" v-if="bleStore.deviceTempC !== null" :class="tempClass">
        <view class="temp-head">
          <text class="temp-icon">🌡️</text>
          <text class="temp-label">芯片温度</text>
          <text class="temp-tag">{{ tempTag }}</text>
        </view>
        <view class="temp-body">
          <text class="temp-value">{{ bleStore.deviceTempC }}<text class="temp-unit">°C</text></text>
        </view>
        <view class="temp-bar">
          <view class="temp-bar-fill" :style="{ width: tempPercent + '%' }"></view>
        </view>
        <view class="temp-bar-marks">
          <text>-10</text><text>15</text><text>40</text><text>65</text><text>90</text>
        </view>
      </view>
    </view>

    <!-- ★ v3.31 方案B-修正②: 开关打开即「始终显示」进度卡片（解锁区/锁车区/中间区都显示），deviceUc<1(旧固件/未同步)不显示 -->
    <view class="progress-card" v-if="bleStore.connected && bleStore.showProgressCard && bleStore.deviceUc >= 1">
      <!-- 自动锁关闭（手动模式）→ 直接说明为什么不会自动锁车，这是「没法锁车」最常见原因 -->
      <text class="progress-tip" v-if="bleStore.autoLockEnabled === 0">
        ⚠️ 自动锁已关闭（手动模式），RSSI 不会自动解锁/锁车，请用手动按键
      </text>

      <template v-if="bleStore.autoLockEnabled !== 0">
        <!-- 中间区间：未达任一阈值 → 仅标题文字 + 灰色条，不要 RSSI 数值和提示 -->
        <template v-if="bleStore.thresholdZone === 0">
          <view class="progress-header">
            <text class="progress-label">📍 中间区间</text>
          </view>
          <view class="progress-bar-bg">
            <view class="progress-bar-fill neutral" :style="{ width: bleStore.rssiPercent + '%' }"></view>
          </view>
        </template>

        <!-- 解锁区 -->
        <template v-else-if="bleStore.thresholdZone === 1">
          <view class="progress-header">
            <text class="progress-label">🔓 解锁进度</text>
            <!-- ★ v3.33.2 P1: 已解锁后固件计数器归零(ucnt=0)导致进度从 0 重新计数，
                 但 LED 已亮、车已解锁 → 视觉矛盾。已解锁时定格 N/N 不再重计数。 -->
            <text class="progress-value">{{ bleStore.isUnlocked ? bleStore.deviceUc : Math.min(bleStore.unlockProgress, bleStore.deviceUc) }}/{{ bleStore.deviceUc }}</text>
          </view>
          <view class="progress-bar-bg">
            <view class="progress-bar-fill" :style="{ width: (bleStore.isUnlocked ? 100 : (bleStore.deviceUc > 0 ? Math.min(bleStore.unlockProgress, bleStore.deviceUc) / bleStore.deviceUc * 100 : 0)) + '%' }"></view>
          </view>
        </template>

        <!-- 锁车区 -->
        <!-- ★ v3.33.2 P1: 已锁车后固件计数器归零→进度重计，与 LED 已灭矛盾。已锁时定格 N/N。 -->
        <template v-else>
          <view class="progress-header">
            <text class="progress-label">🔒 锁车进度</text>
            <text class="progress-value lock">{{ bleStore.deviceState === 'LOCKED' ? bleStore.deviceLc : Math.min(bleStore.lockProgress, bleStore.deviceLc) }}/{{ bleStore.deviceLc }}</text>
          </view>
          <view class="progress-bar-bg">
            <view class="progress-bar-fill lock" :style="{ width: (bleStore.deviceState === 'LOCKED' ? 100 : (bleStore.deviceLc > 0 ? Math.min(bleStore.lockProgress, bleStore.deviceLc) / bleStore.deviceLc * 100 : 0)) + '%' }"></view>
          </view>
        </template>

        <!-- 配置一致性提示 -->
        <text class="progress-tip" v-if="bleStore.deviceUc >= 0 && bleStore.deviceUc !== bleStore.unlockCountRequired">
          ⚠️ 设备确认次数 uc={{ bleStore.deviceUc }} 与 App 设置 {{ bleStore.unlockCountRequired }} 不一致，配置可能未下发
        </text>
      </template>
    </view>

    <!-- ★ v3.25: 极速模式距离显示（仅 speed 模式 + 未连接 + 有停车位置时显示） -->
    <view class="geofence-card" v-if="!bleStore.connected && bleStore.autoReconnectMode === 'speed' && bleStore.parkingLocation">
      <view class="geofence-header">
        <text class="geofence-icon">🅿️</text>
        <text class="geofence-title">停车位置</text>
        <text class="geofence-time" v-if="bleStore.parkingLocation">· {{ parkingTimeAgo }}</text>
      </view>
      <view class="geofence-body">
        <view class="geofence-distance-row">
          <text class="geofence-dist-label">距停车点</text>
          <text class="geofence-dist-value" :class="{ arrived: bleStore.geofenceDistance >= 0 && bleStore.geofenceDistance < 10 }">
            {{ bleStore.geofenceDistanceText }}
          </text>
        </view>
        <!-- 距离进度条：离车越近越满 -->
        <view class="geofence-bar-bg">
          <view class="geofence-bar-fill" :style="{ width: geofenceBarPercent + '%' }"
            :class="{ far: geofenceBarPercent < 30, mid: geofenceBarPercent >= 30 && geofenceBarPercent < 60, near: geofenceBarPercent >= 60 }">
          </view>
        </view>
        <text class="geofence-hint" v-if="bleStore.geofenceDistance >= 0 && bleStore.geofenceDistance < 100">
          🟢 已进入 100m 围栏，BLE 扫描已激活
        </text>
        <text class="geofence-hint" v-else-if="bleStore.geofenceDistance >= 100 && bleStore.geofenceDistance < 500">
          正在接近中，距围栏还有 {{ bleStore.geofenceDistance - 100 }}m
        </text>
        <text class="geofence-hint dim" v-else>
          等待 GPS 定位更新...
        </text>
      </view>
    </view>

    <!-- 设备扫描区域 -->
    <view class="section" v-if="!bleStore.connected">
      <view class="section-header">
        <text class="section-title">附近设备</text>
        <button class="btn-scan" @tap="handleScanToggle">
          {{ bleStore.scanning ? '停止扫描' : '扫描设备' }}
        </button>
      </view>

      <view class="scanning-hint" v-if="bleStore.scanning">
        <view class="scanning-dot"></view>
        <text>正在搜索 KeyGo 设备 ...</text>
      </view>

      <view class="device-list" v-if="bleStore.devices.length > 0">
        <view class="device-item" v-for="device in bleStore.devices" :key="device.deviceId"
          :class="{ active: bleStore.deviceId === device.deviceId }" @tap="handleConnect(device)">
          <view class="device-info">
            <text class="device-name">{{ device.name }}</text>
            <text class="device-id">{{ device.deviceId }}</text>
            <text v-if="device.nameIsFallback" class="device-occupied-tag">⚠ 设备占用中</text>
          </view>
          <view class="device-rssi">
            <text class="device-rssi-val">{{ device.RSSI }}</text>
            <text class="device-rssi-unit">dBm</text>
          </view>
          <view class="device-arrow">›</view>
        </view>
      </view>

      <view class="empty-state" v-if="!bleStore.scanning && bleStore.devices.length === 0">
        <text class="empty-icon">🔍</text>
        <text class="empty-text">点击"扫描设备"搜索附近 KeyGo 设备</text>
        <text class="empty-sub">确保 KeyGo 设备已上电并广播中</text>
      </view>
    </view>

    <!-- ★ 设备管理 -->
    <view class="password-mgmt" v-if="bleStore.connected">
      <text class="section-title mgmt-title">⚙️ 设备管理</text>
        <view class="mgmt-rows">
          <view class="mgmt-row" @tap="showNameDialog">
            <text class="mgmt-label">设备名称 ✍ </text>
            <text class="mgmt-val" v-if="bleStore.customDeviceName">{{ bleStore.customDeviceName }}</text>
            <text class="mgmt-val name-hint" v-else>点击设置（如车牌号）</text>
            <text class="mgmt-arrow">›</text>
          </view>
          <view class="mgmt-row" @tap="openBindModal">
            <text class="mgmt-label">设备绑定 🔐 </text>
            <text class="mgmt-val" v-if="bleStore.isBound">{{ bindLabel }}</text>
            <text class="mgmt-val name-hint" v-else>未绑定·点击绑定</text>
            <text class="mgmt-arrow">›</text>
          </view>
        </view>
    </view>

    <!-- ★ 快捷操作 -->
    <view class="quick-actions" v-if="bleStore.connected">
      <button class="action-btn unlock-btn" @tap="handleUnlock">
        <text class="action-icon">🔓</text>
        <text class="action-text">解锁</text>
      </button>
      <button class="action-btn lock-btn" @tap="handleLock">
        <text class="action-icon">🔒</text>
        <text class="action-text">锁车</text>
      </button>
      <button class="action-btn" :class="thirdAction.cls" @tap="thirdAction.handler">
        <text class="action-icon">{{ thirdAction.icon }}</text>
        <text class="action-text">{{ thirdAction.text }}</text>
      </button>
    </view>

    <!-- 断开连接 -->
    <view class="disconnect-section" v-if="bleStore.connected">
      <button class="btn-disconnect" @tap="handleDisconnect">断开连接</button>
    </view>

    <!-- ★ pwModal 通用弹窗 -->
    <view class="pin-overlay" v-if="pwModal.visible" @tap.stop>
      <view class="pin-dialog" @tap.stop>
        <text class="pin-title">{{ pwModal.title }}</text>
        <text class="pin-hint">{{ pwModal.hint }}</text>
        <view class="pin-input-wrap">
          <input v-if="pwModal.mode === 'changePin'" class="pin-input" v-model="pwModal.value"
                 type="number" password :maxlength="pwModal.maxLen" :placeholder="pwModal.placeholder" />
          <input v-else-if="pwModal.mode === 'setName'" class="pin-input" v-model="pwModal.value"
                 type="text" :maxlength="pwModal.maxLen" :placeholder="pwModal.placeholder" />
          <input v-else class="pin-input" v-model="pwModal.value"
                 type="number" password :maxlength="pwModal.maxLen" :placeholder="pwModal.placeholder" />
        </view>
        <text class="pin-default-hint" v-if="pwModal.showDefaultHint">{{ pwModal.defaultHint }}</text>
        <view class="pin-actions">
          <button class="pin-btn pin-cancel" @tap="pwModal.visible = false">取消</button>
          <button class="pin-btn pin-confirm" @tap="pwModal.onConfirm">{{ pwModal.confirmText || '确定' }}</button>
        </view>
      </view>
    </view>

    <!-- ★ 设备绑定弹窗（fixed 覆盖层，脱离 swiper，input 可靠） -->
    <BindModal :visible="bindModalVisible" @close="bindModalVisible = false" />
  </view>
</template>


<script setup>
import { reactive, computed, ref, watch } from 'vue' // import { reactive, computed, watch } from 'vue'
import { onShow } from '@dcloudio/uni-app'
import { useBleStore } from '@/stores/ble.js'
import { useThemeStore } from '@/stores/theme.js'
import { toast } from '@/utils/toast.js'
import BindModal from '@/components/BindModal.vue'
const bleStore = useBleStore()
const themeStore = useThemeStore()
const themeClass = computed(() => themeStore.themeClass)

// ★ 2026-07-12: 绑定态文案——区分"已验证/自动验证中/验证失败需手动"，避免"待验证"像报错
const bindLabel = computed(() => {
  if (bleStore.sessionAuthed) return '已验证'
  if (bleStore._autoAuthState === 'running') return '已绑定·验证中…'
  if (bleStore._autoAuthState === 'failed') return '已绑定·验证失败'
  return '已绑定·待验证'
})

// ★ v3.25: 极速模式距离显示 — 停车时间相对描述
const parkingTimeAgo = computed(() => {
  const p = bleStore.parkingLocation
  if (!p || !p.savedAt) return ''
  const diff = Date.now() - p.savedAt
  if (diff < 60000) return '刚刚'
  if (diff < 3600000) return `${Math.floor(diff / 60000)}分钟前`
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}小时前`
  return `${Math.floor(diff / 86400000)}天前`
})

// ★ v3.25: 极速模式距离进度条（越近越满）
//   500m → 0%, 10m → 100%（指数映射让近距离变化更灵敏）
const geofenceBarPercent = computed(() => {
  const d = bleStore.geofenceDistance
  if (d < 0) return 0
  if (d <= 10) return 100
  if (d >= 500) return 0
  // 指数衰减：距离折半 → 进度提升 20%
  // 500m→0%, 250m→20%, 125m→40%, 60m→60%, 30m→80%, 10m→100%
  // 公式: percent = 20 * (9 - log2(d/10))，clamp [0, 100]
  const ratio = d / 10
  const pct = 20 * (9 - Math.log2(ratio))
  return Math.max(0, Math.min(100, Math.round(pct)))
})

// ★ v3.14 phantom-connected 诊断 watcher 已移除（根因修复见 commit d240db4：P1 进度条定格）。
//   若日后再出现 connected 状态异常跳变，可在此临时恢复该 sync-watch 抓调用栈。

// ★ 通用 pwModal
const pwModal = reactive({
  visible: false,
  title: '',
  hint: '',
  placeholder: '',
  value: '',
  showDefaultHint: false,
  defaultHint: '',
  maxLen: 20,
  confirmText: '确定',
  mode: '',
  onConfirm: () => {}
})

// ★ 设备绑定弹窗（fixed 覆盖层，脱离 swiper/scroll-view 文档流，input 可靠）
const bindModalVisible = ref(false)
function openBindModal() {
  if (!bleStore.connected) {
    toast.info('请先连接设备')
    return
  }
  bindModalVisible.value = true
}

// ★ 2026-07-14: 设备复位/被其他手机解绑后，store 置 needsRebind → 自动弹首绑界面
watch(() => bleStore.needsRebind, (v) => {
  if (v && bleStore.connected) {
    bleStore.needsRebind = false
    bindModalVisible.value = true
  }
})

onShow(async () => {
  // ★ v3.31.0 / 2026-07-13: 方案 B —— 回前台【保留】后台持续平滑出来的旧 RSSI 值，
  //   不再清零成 ---。原因：displayRssi 已被 EMA 平滑 + 500ms 节流（见 stores/ble.js），
  //   后台噪值「回放/狂跳」的根因已消除，保留旧值视觉更连续；下一个节流刻度（≤500ms）
  //   会静默刷新为最新平滑值，期间不跳。
  themeStore.applyNavBar()

  // ★ 冷启动修复：先确保蓝牙适配器已打开（仅 openBluetoothAdapter，不申请权限、BT 已开无弹窗），
  //   否则 getBluetoothAdapterState 返回 not-init→available=false，会误亮红 banner。
  //   有已知设备时再走 prepareForAutoConnect 注册监听器/前台服务/心跳（含权限，已授权不弹窗）。
  await bleStore.ensureAdapterReady()
  const _knownForColdStart = bleStore.deviceId || uni.getStorageSync('ble_device_id')
  if (_knownForColdStart) {
    await bleStore.prepareForAutoConnect()
  }

  // ★ v3.14-bugfix2: btState='off' 是原生广播在后台确认的状态，直接信任。
  //   _forceRefreshBluetoothState 内部调用 getBluetoothAdapterState(),
  //   在 Android 上可能误报 available=true（系统蓝牙已关但 BLE 适配器
  //   仍处于 initialized 状态），会覆盖正确的 'off' → 导致后续误判。
  //   同时，锁屏→亮屏期间 Android 可能触发 STATE_ON 广播 → 诈尸重连
  //   → connected=true（stale handle），之后的 _verifyConnection 会用
  //   getConnectedBluetoothDevices 做系统级验证来识别并清理这种假连接。
  if (bleStore.btState === 'off') {
    console.log('[UI] onShow: btState=off（原生广播确认），清理残留状态')
    if (bleStore.connected) {
      bleStore._handleDisconnect()
    }
    return
  }

  // 蓝牙状态不明确（unknown / just_enabled）→ 强制刷新获取真实状态
  const btOn = await bleStore._forceRefreshBluetoothState()

  if (!btOn) {
    console.log('[UI] onShow: 蓝牙已关闭，清理 stale 连接')
    if (bleStore.connected) {
      bleStore._handleDisconnect()
    }
    return
  }

  // 蓝牙已开启 → 验证连接或尝试重连
  if (bleStore.connected) {
    // 异步验证（不阻塞 UI），若为假连接会在 _verifyConnection 中自动清理
    bleStore._verifyConnection()
    return
  }

  // ★ v1.0.1: 根据智能重连模式决定 onShow 行为
  if (bleStore.autoReconnectMode === 'comfort' || bleStore.autoReconnectMode === 'manual') {
    // 舒适/手动模式：onShow（App 打开/回前台）即尝试「前台」自动连接。
    // 手动模式用户要求「打开 App 也要自动连」，故放行前台；但后台重连(心跳/亮屏扫描/原生扫描)
    // 仍由 _shouldAutoReconnect 的 manual&&!isForeground 拦死，不会在锁屏后刷连接。
    // 闸门：用户主动断开(dormant) / 已连接 / 蓝牙关 → 不自动连；idle 避免重入。
    if (bleStore.reconnectMode === 'idle' && bleStore._shouldAutoReconnect(true, true)) {
      bleStore.tryAutoConnect()
    }
  } else if (bleStore.autoReconnectMode === 'speed') {
    // ★ Phase 3: 极速模式 → GPS 围栏检测（内部已含 _shouldAutoReconnect 闸门）
    if (!bleStore.connected) {
      // ★ v3.25.1-fix: 重启后恢复停车位置 + 围栏监控（修复重启无距离显示的 bug）
      bleStore._restoreSpeedModeState()
      bleStore.checkGeofenceApproach()
    }
  }
})

// ==================== 扫描 & 连接 ====================

// ★ 防止用户在模拟器里死递归弹 Modal
let _enableBluetoothLocked = false

async function handleEnableBluetooth() {
  if (_enableBluetoothLocked) {
    console.log('[UI] enableBluetooth 防抖，跳过重复调用')
    return
  }

  // #ifdef APP-PLUS
  // ★ App 平台：先申请运行时权限
  if (typeof plus !== 'undefined' && plus.os.name === 'Android') {
    console.log('[UI] ★★★ App-Plus Android，先申请权限 ★★★')
    const perms = ['android.permission.ACCESS_FINE_LOCATION', 'android.permission.ACCESS_COARSE_LOCATION']
    try {
      const VERSION = plus.android.importClass('android.os.Build$VERSION')
      if (VERSION.SDK_INT >= 31) {
        perms.push('android.permission.BLUETOOTH_SCAN', 'android.permission.BLUETOOTH_CONNECT')
      }
    } catch(e) {}

    const permResult = await new Promise((resolve) => {
      plus.android.requestPermissions(perms, resolve, (err) => {
        console.error('[UI] requestPermissions 异常:', JSON.stringify(err))
        resolve({ granted: [], deniedAlways: perms, deniedPresent: [] })
      })
    })
    const denied = (permResult.deniedAlways || []).concat(permResult.deniedPresent || [])
    if (denied.length > 0) {
      uni.showModal({
        title: '需要授予权限',
        content: 'BLE车钥匙需要「位置信息」权限才能扫描蓝牙设备。\n\n请前往系统设置中开启定位权限。',
        confirmText: '去设置',
        cancelText: '取消',
        success: (res) => {
          if (res.confirm) {
            const Intent = plus.android.importClass('android.content.Intent')
            const Settings = plus.android.importClass('android.provider.Settings')
            const Uri = plus.android.importClass('android.net.Uri')
            const main = plus.android.runtimeMainActivity()
            const intent = new Intent()
            intent.setAction(Settings.ACTION_APPLICATION_DETAILS_SETTINGS)
            intent.setData(Uri.parse('package:' + main.getPackageName()))
            main.startActivity(intent)
          }
        }
      })
      return
    }
    console.log('[UI] 权限已通过 ✓')
  }
  // #endif

  // ★ 模仿 nRF Connect: 不显示 loading toast，让系统蓝牙弹窗直接弹出
  //   用户看到的是: 红色 banner → 点击"开启" → 蓝色"正在开启"banner → 系统底窗
  //   不做任何中间提示，不遮挡系统弹窗
  try {
    const ok = await bleStore.enableBluetooth()
    if (ok) {
      if (!bleStore.connected) {
        bleStore.tryAutoConnect()
      }
    } else {
      // btState 已经反映真实状态，banner 会自然切换，不额外 toast
    }
  } catch (err) {
    const msg = String(err?.errMsg || err?.message || err || '')
    const code = err?.code ?? err?.errCode

    // #ifdef APP-PLUS
    // ★ code=10001: 原生弹窗被拒绝/超时 → btState 已是 'off'，红 banner 自然保持，不弹额外 Modal
    if (code === 10001 || msg.includes('not available')) {
      // 静默：btState 已经是 'off'，红色 banner 会保持显示，不打扰用户
    } else if (msg.includes('timeout') || msg.includes('超时')) {
      toast.info('操作超时，请检查蓝牙后重试')
    } else if (code === 'PERMISSION_DENIED') {
      uni.showModal({
        title: '权限不足',
        content: 'BLE车钥匙需要「位置信息」权限。\n\n请到系统设置中授权后重新打开 App。',
        confirmText: '知道了'
      })
    } else {
      toast.error('蓝牙开启失败: ' + (msg || code))
    }
    // #endif
    // #ifndef APP-PLUS
    if (code === 10001 || msg.includes('not available')) {
      // 静默：btState 已经是 'off'，红色 banner 保持显示
    } else {
      toast.error('蓝牙开启失败')
    }
    // #endif
  }
}

async function handleScanToggle() {
  if (bleStore.scanning) {
    await bleStore.stopScanDevices()
    return
  }
  try {
    await bleStore.startScanDevices(12)
    // ★ v3.6-fixH: 扫描期间可能已自动重连成功，connected=true 时不弹出 toast
    //   bug: startScanDevices 是 12s 异步操作，后台重连成功后 devices 为空但已连接
    if (!bleStore.connected && bleStore.devices.length === 0) {
      toast.info('未发现设备，请确认 KeyGo 设备已上电')
    }
  } catch (err) {
    if (String(err?.message || err).includes('蓝牙未开启')) {
      // btState 已在 store 中设为 'off'，UI 横幅会显示引导
      toast.info('请开启手机蓝牙')
    } else {
      toast.error('扫描失败')
    }
  }
}

async function handleScan() {
  if (bleStore.scanning) return
  try {
    await bleStore.startScanDevices(12)
    // ★ v3.6-fixH: 同上，扫描期间可能已连接
    if (!bleStore.connected && bleStore.devices.length === 0) {
      toast.info('未发现设备，请确认 KeyGo 设备已上电')
    }
  } catch (err) {
    if (String(err?.message || err).includes('蓝牙未开启')) {
      toast.info('请开启手机蓝牙')
    } else {
      toast.error('扫描失败')
    }
  }
}

async function handleConnect(device) {
  uni.showLoading({ title: '连接中...', mask: true })
  try {
    await bleStore.connect(device.deviceId, device.name)
    uni.hideLoading()
    toast.success('连接成功')
    bleStore.devices = []
  } catch {
    uni.hideLoading()
    toast.error('连接失败，请重试')
  }
}

async function handleDisconnect() {
  uni.showLoading({ title: '断开中...', mask: true })
  const ok = await bleStore.disconnect()
  uni.hideLoading()
  if (ok) {
    uni.removeStorageSync('ble_device_id')
    bleStore.devices = []
    toast.info('已断开连接')
  } else {
    toast.error('断开失败，请重试')
  }
}

// ==================== 车辆控制 ====================

async function handleUnlock() {
  try {
    await bleStore.unlock()
    toast.success('解锁指令已发送')
  } catch (err) {
    toast.error((err && err.message) || '发送失败')
  }
}

async function handleLock() {
  try {
    await bleStore.lock()
    toast.success('锁车指令已发送')
  } catch (err) {
    toast.error((err && err.message) || '发送失败')
  }
}

async function handleTrunk() {
  try {
    await bleStore.trunk()
    toast.success('后备箱指令已发送')
  } catch {
    toast.error('发送失败')
  }
}

async function handleRide() {
  try {
    await bleStore.ride()
    toast.success('骑行指令已发送')
  } catch {
    toast.error('发送失败')
  }
}

// ★ Phase 2: 连接页第三键按设备模式驱动（car=后备箱 / ebike=骑行）
// ★ v3.36.1: 连接页芯片温度卡片 — 温度等级配色/标签/刻度条百分比（与控制页同源）
const TEMP_BAR_MIN = -10
const TEMP_BAR_MAX = 90
const tempClass = computed(() => {
  const t = bleStore.deviceTempC
  if (t === null) return ''
  if (t < 20) return 'temp-cold'
  if (t <= 45) return 'temp-normal'
  if (t <= 65) return 'temp-warm'
  return 'temp-hot'
})
const tempTag = computed(() => {
  const c = tempClass.value
  return c === 'temp-cold' ? '偏低' :
         c === 'temp-hot' ? '过热' :
         c === 'temp-warm' ? '偏高' : '正常'
})
const tempPercent = computed(() => {
  const t = bleStore.deviceTempC
  if (t === null) return 0
  const p = (t - TEMP_BAR_MIN) / (TEMP_BAR_MAX - TEMP_BAR_MIN) * 100
  return p < 0 ? 0 : p > 100 ? 100 : p
})

const thirdAction = computed(() => {
  if (bleStore.deviceMode === 'ebike') {
    return { icon: '🛵', text: '骑行', handler: handleRide, cls: 'ride-btn' }
  }
  return { icon: '🚗', text: '后备箱', handler: handleTrunk, cls: 'trunk-btn' }
})

// ==================== 设备名称 ====================

function showNameDialog() {
  if (!bleStore.connected) {
    toast.info('请先连接设备')
    return
  }
  pwModal.mode = 'setName'
  pwModal.title = '设置设备名称'
  pwModal.hint = '给设备起个名字，如车牌号、车型等'
  pwModal.placeholder = '设备名称（最长20字符，支持中文）'
  pwModal.value = bleStore.customDeviceName || ''
  pwModal.showDefaultHint = false
  pwModal.defaultHint = ''
  pwModal.maxLen = 20
  pwModal.confirmText = '保存'
  pwModal.onConfirm = handleSetName
  pwModal.visible = true
}

async function handleSetName() {
  const name = pwModal.value.trim()
  if (!name) {
    toast.info('请输入设备名称')
    return
  }
  pwModal.visible = false
  uni.showLoading({ title: '保存中...', mask: true })
  try {
    await bleStore.setDeviceName(name)
    uni.hideLoading()
    toast.success('设备名称已更新')
  } catch (err) {
    uni.hideLoading()
    toast.error(err.message || '保存失败')
  }
}

</script>

<style scoped>
.page-index {
  min-height: 100vh;
  background: var(--bg-page);
  color: var(--text-primary);
  padding: 30rpx 30rpx 30rpx;
  transition: background-color 0.3s, color 0.3s;
}

/* ===== 蓝牙关闭横幅（模仿 nRF Connect） ===== */
.bt-off-banner {
  background: #FFF3F3;
  border: 1rpx solid #FFCDD2;
  border-radius: 12rpx;
  padding: 20rpx 24rpx;
  display: flex;
  align-items: center;
  gap: 12rpx;
  margin-bottom: 20rpx;
  min-height: 72rpx;
  box-sizing: border-box;
}

.bt-off-icon { font-size: 28rpx; }

.bt-off-text {
  flex: 1;
  font-size: 26rpx;
  color: #D32F2F;
  font-weight: 500;
}

.bt-enable-btn {
  background: #D32F2F;
  color: #fff;
  font-size: 24rpx;
  padding: 8rpx 28rpx;
  border-radius: 20rpx;
  border: none;
}

/* 绿色成功 banner — 用户允许开启蓝牙后短暂显示，1.5s 后自动消失 */
.bt-on-banner {
  background: #E8F5E9;
  border: 1rpx solid #A5D6A7;
  border-radius: 12rpx;
  padding: 20rpx 24rpx;
  display: flex;
  align-items: center;
  gap: 12rpx;
  margin-bottom: 20rpx;
  min-height: 72rpx;
  box-sizing: border-box;
  animation: bt-on-fadein 0.3s ease;
}

@keyframes bt-on-fadein {
  from { opacity: 0; transform: translateY(-8rpx); }
  to   { opacity: 1; transform: translateY(0); }
}

.bt-on-icon { font-size: 28rpx; }

.bt-on-text {
  flex: 1;
  font-size: 26rpx;
  color: #2E7D32;
  font-weight: 600;
}

/* ===== 状态卡片 ===== */
.status-card {
  background: var(--gradient-card);
  border-radius: 24rpx;
  padding: 40rpx;
  display: flex;
  align-items: center;
  position: relative;
  margin-bottom: 30rpx;
  border: 2rpx solid var(--border);
  transition: all 0.3s;
}

.status-card.connected {
  background: var(--gradient-connected);
  border-color: var(--alpha-33);
}

.status-card.reconnecting {
  background: var(--gradient-warn-card);
  border-color: var(--border-warning);
}

.custom-name-display {
  color: var(--accent);
  font-weight: bold;
  font-size: inherit;
}

.status-icon { font-size: 48rpx; margin-right: 24rpx; }
.status-info { flex: 1; }

.status-title {
  font-size: 32rpx;
  font-weight: 600;
  color: var(--text-primary);
  display: block;
}

.status-sub {
  font-size: 24rpx;
  color: var(--text-tertiary);
  margin-top: 6rpx;
  display: block;
}

.status-rssi { text-align: center; }

.rssi-value {
  font-size: 44rpx;
  font-weight: 700;
  color: var(--accent);
  display: block;
}

.rssi-unit {
  font-size: 20rpx;
  color: var(--text-tertiary);
}

/* ===== 信号强度 ===== */
.signal-section {
  background: var(--bg-card);
  border-radius: 16rpx;
  padding: 24rpx;
  margin-bottom: 30rpx;
}

.signal-header {
  display: flex;
  justify-content: space-between;
  margin-bottom: 16rpx;
}

.signal-label { font-size: 26rpx; color: var(--text-tertiary); }
.signal-dist { font-size: 26rpx; color: var(--accent); }

.signal-bar-bg {
  height: 12rpx;
  background: var(--border);
  border-radius: 6rpx;
  overflow: hidden;
  margin-bottom: 16rpx;
}

.signal-bar-fill { height: 100%; border-radius: 6rpx; transition: width 0.5s ease; }
.signal-bar-fill.weak { background: linear-gradient(90deg, var(--accent-red), var(--accent-orange)); }
.signal-bar-fill.medium { background: linear-gradient(90deg, var(--accent-orange), var(--accent-yellow)); }
.signal-bar-fill.strong { background: linear-gradient(90deg, var(--accent), var(--accent-green)); }

.signal-thresholds {
  display: flex;
  justify-content: space-between;
  font-size: 22rpx;
  color: var(--text-muted);
}

/* ===== 连接页补充：电池 + 芯片温度（v3.36.1，与控制页同源） ===== */
.conn-extra { margin-bottom: 30rpx; }
/* 连接页电量胶囊：缩在「已连接」框(🔗)内左下角的小标签
   - position:absolute  → 脱离正常布局流，不占高度，所以整个框的高度不会因为它而变化
   - left   → 距「卡片左边框」的水平距离（单位 rpx）。想更靠左就调小；想靠右就调大。
              🔗 图标本身在内容区最左边（卡片 padding=40rpx 处），这里设 30rpx 比图标再往左贴一点。
              注意别小于 ~20rpx，否则会戳到卡片圆角外。
   - bottom → 距「卡片底边」的距离。越大越往上、越小越往下贴边。
   - 因为和 🔗 同属最左一列，视觉上就是「🔗 正下方的小电量标」
   - 其它（padding/border-radius/font-size）只控制这个小胶囊自身的胖瘦和字号，不影响框布局 */
.card-batt {
  position: absolute;
  left: 12rpx;            /* ★ 想更靠左就调小这个值（如 8rpx） */
  bottom: 14rpx;
  display: inline-flex;
  align-items: center;
  gap: 4rpx;
  padding: 2rpx 10rpx;
  border-radius: 10rpx;
  font-size: 20rpx;
  line-height: 1.2;
}
.card-batt .batt-icon { font-size: 22rpx; }
.card-batt .batt-text { font-weight: 600; }
.card-batt.batt-high   { background: rgba(52, 199, 89, 0.15); color: var(--accent-green); }
.card-batt.batt-mid    { background: rgba(255, 169, 0, 0.15);  color: var(--accent-yellow); }
.card-batt.batt-low    { background: rgba(255, 69, 58, 0.15);  color: var(--accent-red); }
.card-batt.batt-unknown { background: rgba(142, 142, 147, 0.15); color: var(--text-muted); }

.temp-card {
  background: var(--bg-card);
  border: 2rpx solid var(--border);
  border-radius: 20rpx;
  padding: 28rpx 30rpx;
  transition: all 0.3s;
}
.temp-head {
  display: flex;
  align-items: center;
  gap: 12rpx;
  margin-bottom: 14rpx;
}
.temp-icon { font-size: 32rpx; }
.temp-label { font-size: 26rpx; color: var(--text-muted); }
.temp-tag {
  margin-left: auto;
  font-size: 22rpx;
  padding: 4rpx 16rpx;
  border-radius: 20rpx;
  font-weight: 600;
}
.temp-body { text-align: center; margin: 6rpx 0 18rpx; }
.temp-value {
  font-size: 50rpx;
  font-weight: 800;
  line-height: 1;
  color: var(--text-primary);
}
.temp-unit { font-size: 32rpx; font-weight: 600; margin-left: 6rpx; color: var(--text-tertiary); }
.temp-bar {
  position: relative;
  height: 14rpx;
  border-radius: 10rpx;
  background: var(--bg-track, #e5e5ea);
  overflow: hidden;
}
.temp-bar-fill {
  position: absolute;
  left: 0; top: 0; bottom: 0;
  border-radius: 10rpx;
  transition: width 0.5s ease, background-color 0.3s;
}
.temp-bar-marks {
  display: flex;
  justify-content: space-between;
  margin-top: 10rpx;
  font-size: 22rpx;
  font-weight: 500;
  color: var(--text-tertiary);
  letter-spacing: 0.5rpx;
}
.temp-card.temp-cold .temp-bar-fill { background: #30b0c7; }
.temp-card.temp-cold .temp-tag { background: rgba(48,176,199,0.18); color: #30b0c7; }
.temp-card.temp-cold .temp-value { color: #30b0c7; }
.temp-card.temp-normal .temp-bar-fill { background: var(--accent-green); }
.temp-card.temp-normal .temp-tag { background: rgba(52,199,89,0.18); color: var(--accent-green); }
.temp-card.temp-warm .temp-bar-fill { background: var(--accent-yellow); }
.temp-card.temp-warm .temp-tag { background: rgba(255,169,0,0.18); color: var(--accent-yellow); }
.temp-card.temp-warm .temp-value { color: var(--accent-yellow); }
.temp-card.temp-hot .temp-bar-fill { background: var(--accent-red); }
.temp-card.temp-hot .temp-tag { background: rgba(255,69,58,0.18); color: var(--accent-red); }
.temp-card.temp-hot .temp-value { color: var(--accent-red); }
.temp-card.temp-hot { border-color: rgba(255,69,58,0.33); }

/* ===== v3.31 方案B: 确认进度卡片 ===== */
.progress-card {
  background: var(--bg-card);
  border-radius: 16rpx;
  padding: 20rpx 24rpx;
  margin-bottom: 24rpx;
}
.progress-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 14rpx;
}
.progress-label {
  font-size: 26rpx;
  color: var(--text-strong);
}
.progress-value {
  font-size: 30rpx;
  font-weight: 700;
  color: var(--accent, #3b82f6);
}
.progress-bar-bg {
  height: 14rpx;
  background: var(--bg-track, #e5e7eb);
  border-radius: 7rpx;
  overflow: hidden;
}
.progress-bar-fill {
  height: 100%;
  background: var(--accent, #3b82f6);
  border-radius: 7rpx;
  transition: width 0.2s ease;
}
.progress-bar-fill.lock {
  background: #ef4444;
}
.progress-bar-fill.neutral {
  background: #9ca3af;
}
.progress-value.lock {
  color: #ef4444;
}
.progress-tip {
  display: block;
  margin-top: 12rpx;
  font-size: 22rpx;
  color: #f59e0b;
}

/* ===== 设备区域 ===== */
.section {
  background: var(--bg-card);
  border-radius: 16rpx;
  padding: 24rpx;
  margin-bottom: 30rpx;
}

.section-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 20rpx;
}

.section-title {
  font-size: 28rpx;
  font-weight: 600;
  color: var(--text-primary);
}

.btn-scan {
  background: var(--alpha-12);
  color: var(--accent);
  font-size: 24rpx;
  padding: 12rpx 24rpx;
  border-radius: 20rpx;
  border: 1rpx solid var(--alpha-27);
}

.scanning-hint {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 30rpx 0;
  color: var(--text-tertiary);
  font-size: 24rpx;
}

.scanning-dot {
  width: 16rpx;
  height: 16rpx;
  background: var(--accent);
  border-radius: 50%;
  margin-right: 12rpx;
  animation: pulse 1s infinite;
}

@keyframes pulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.3; transform: scale(0.7); }
}

.device-item {
  display: flex;
  align-items: center;
  padding: 20rpx 16rpx;
  border-radius: 12rpx;
  margin-bottom: 8rpx;
  background: var(--bg-card-alt);
  transition: background 0.2s;
}

.device-item.active {
  background: var(--alpha-07);
  border: 1rpx solid var(--alpha-20);
}

.device-info { flex: 1; }

.device-name {
  font-size: 28rpx;
  color: var(--text-primary);
  display: block;
}

.device-id {
  font-size: 20rpx;
  color: var(--text-muted);
  margin-top: 4rpx;
  display: block;
}

/* ★ v3.35: 异名设备(可能已被占用)的警示徽标 */
.device-occupied-tag {
  display: inline-block;
  margin-top: 8rpx;
  padding: 2rpx 12rpx;
  font-size: 20rpx;
  line-height: 1.4;
  color: #fff;
  background: #e6a23c;
  border-radius: 8rpx;
}

.device-rssi { text-align: center; margin-right: 16rpx; }

.device-rssi-val {
  font-size: 28rpx;
  font-weight: 600;
  color: var(--accent);
  display: block;
}

.device-rssi-unit { font-size: 18rpx; color: var(--text-muted); }
.device-arrow { font-size: 36rpx; color: var(--text-muted); }

.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 60rpx 0;
}

.empty-icon { font-size: 60rpx; margin-bottom: 16rpx; }
.empty-text { font-size: 26rpx; color: var(--text-tertiary); }
.empty-sub { font-size: 22rpx; color: var(--text-muted); margin-top: 8rpx; }

/* ===== 设备管理 ===== */
.password-mgmt {
  background: var(--bg-card);
  border-radius: 16rpx;
  padding: 24rpx;
  margin-bottom: 24rpx;
}

.mgmt-title { margin-bottom: 16rpx; }

.mgmt-rows { margin-bottom: 12rpx; }

.mgmt-row {
  display: flex;
  align-items: center;
  padding: 20rpx 0;
  border-bottom: 1rpx solid var(--border);
}

.mgmt-row:last-child { border-bottom: none; }

.mgmt-label { flex: 1; font-size: 26rpx; color: var(--text-secondary); }
.mgmt-val { font-size: 24rpx; color: var(--mgmt-val); margin-right: 12rpx; }
.mgmt-val.name-hint { color: var(--text-muted); font-size: 24rpx; }
.mgmt-arrow { font-size: 28rpx; color: var(--text-muted); }

/* ===== 快捷操作 ===== */
.quick-actions {
  display: flex;
  gap: 16rpx;
  margin-bottom: 30rpx;
}

.action-btn {
  flex: 1;
  background: var(--bg-card);
  border-radius: 16rpx;
  padding: 30rpx 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  border: 1rpx solid var(--border);
}

.action-btn:active { opacity: 0.7; }
.action-icon { font-size: 44rpx; margin-bottom: 8rpx; }

.action-text {
  font-size: 24rpx;
  color: var(--text-primary);
}

.unlock-btn { border-color: var(--alpha-27); }
.lock-btn { border-color: var(--orange-alpha-27); }
.trunk-btn { border-color: var(--green-alpha-27); }
.ride-btn { border-color: var(--accent); }

/* ===== 断开连接 ===== */
.disconnect-section {
  display: flex;
  justify-content: center;
}

.btn-disconnect {
  background: transparent;
  color: var(--accent-red);
  font-size: 24rpx;
  padding: 16rpx 48rpx;
  border: 1rpx solid var(--red-alpha-27);
  border-radius: 20rpx;
}

/* ===== pwModal 弹窗 ===== */
.pin-overlay {
  position: fixed;
  top: 0; left: 0; right: 0; bottom: 0;
  background: var(--bg-overlay);
  display: flex;
  justify-content: center;
  align-items: center;
  z-index: 999;
}

.pin-dialog {
  width: 560rpx;
  background: var(--bg-card);
  border-radius: 24rpx;
  padding: 48rpx 40rpx;
  border: 1rpx solid var(--border);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 24rpx;
}

.pin-title {
  font-size: 32rpx;
  font-weight: 600;
  color: var(--text-primary);
}

.pin-hint {
  font-size: 24rpx;
  color: var(--text-tertiary);
  text-align: center;
  line-height: 1.5;
}

.pin-input-wrap { width: 100%; }

.pin-input {
  width: 100%;
  height: 80rpx;
  background: var(--bg-card-alt);
  border: 1rpx solid var(--border);
  border-radius: 12rpx;
  font-size: 28rpx;
  color: var(--text-primary);
  text-align: center;
  letter-spacing: 8rpx;
  padding: 0 24rpx;
  box-sizing: border-box;
}



.pin-default-hint {
  font-size: 22rpx;
  color: var(--accent-orange);
  margin-top: -12rpx;
}

.pin-actions {
  display: flex;
  gap: 20rpx;
  width: 100%;
  margin-top: 8rpx;
}

.pin-btn {
  flex: 1;
  height: 72rpx;
  border-radius: 12rpx;
  font-size: 26rpx;
  font-weight: 600;
  display: flex;
  align-items: center;
  justify-content: center;
}

.pin-cancel {
  background: transparent;
  color: var(--text-tertiary);
  border: 1rpx solid var(--border);
}

.pin-confirm {
  background: var(--gradient-accent);
  color: #fff;
}

/* ===== ★ v3.25: 极速模式距离显示卡片 ===== */
.geofence-card {
  background: var(--bg-card);
  border-radius: 16rpx;
  padding: 24rpx;
  margin-bottom: 30rpx;
  border: 1rpx solid var(--border);
}

.geofence-header {
  display: flex;
  align-items: center;
  margin-bottom: 16rpx;
}

.geofence-icon { font-size: 32rpx; margin-right: 8rpx; }

.geofence-title {
  font-size: 26rpx;
  font-weight: 600;
  color: var(--text-primary);
}

.geofence-time {
  font-size: 22rpx;
  color: var(--text-muted);
  margin-left: 6rpx;
}

.geofence-distance-row {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  margin-bottom: 12rpx;
}

.geofence-dist-label {
  font-size: 24rpx;
  color: var(--text-tertiary);
}

.geofence-dist-value {
  font-size: 32rpx;
  font-weight: 700;
  color: var(--accent);
  transition: color 0.3s;
}

.geofence-dist-value.arrived {
  color: var(--accent-green);
}

.geofence-bar-bg {
  height: 10rpx;
  background: var(--border);
  border-radius: 5rpx;
  overflow: hidden;
  margin-bottom: 12rpx;
}

.geofence-bar-fill {
  height: 100%;
  border-radius: 5rpx;
  transition: width 1s ease;
}

.geofence-bar-fill.far  { background: linear-gradient(90deg, #90CAF9, #42A5F5); }
.geofence-bar-fill.mid  { background: linear-gradient(90deg, #FFB74D, #FF9800); }
.geofence-bar-fill.near { background: linear-gradient(90deg, #81C784, #4CAF50); }

.geofence-hint {
  font-size: 22rpx;
  color: var(--accent-green);
}

.geofence-hint.dim {
  color: var(--text-muted);
}
</style>
