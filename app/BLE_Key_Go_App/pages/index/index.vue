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
        <text class="rssi-value">{{ bleStore.filteredRssi > -999 ? bleStore.filteredRssi : '---' }}</text>
        <text class="rssi-unit">dBm</text>
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
          <text class="mgmt-label">设备名称</text>
          <text class="mgmt-val" v-if="bleStore.customDeviceName">{{ bleStore.customDeviceName }}</text>
          <text class="mgmt-val name-hint" v-else>点击设置（如车牌号）</text>
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
      <button class="action-btn trunk-btn" @tap="handleTrunk">
        <text class="action-icon">🚗</text>
        <text class="action-text">后备箱</text>
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
  </view>
</template>


<script setup>
import { reactive, computed } from 'vue' // import { reactive, computed, watch } from 'vue'
import { onShow } from '@dcloudio/uni-app'
import { useBleStore } from '@/stores/ble.js'
import { useThemeStore } from '@/stores/theme.js'
import { toast } from '@/utils/toast.js'
const bleStore = useBleStore()
const themeStore = useThemeStore()
const themeClass = computed(() => themeStore.themeClass)

// // ★★★ v3.14-bug watcher 诊断：监听 connected 变化，定位 phantom 连接的来源 ★★★ 
// 在每次 connected 状态变化时，会打印：
// 前后值：false → true 或 true → false
// 关键上下文：btState、reconnectMode、deviceId、重连次数/延迟
// 完整调用栈：精确定位是哪行代码改的 connected
// watch(() => bleStore.connected, (newVal, oldVal) => {
//   console.log(`[DIAG] connected: ${oldVal} → ${newVal}`)
//   console.log(`[DIAG] btState=${bleStore.btState} mode=${bleStore.reconnectMode} deviceId=${bleStore.deviceId}`)
//   console.log(`[DIAG] reconnectAttempt=${bleStore.reconnectAttempt} reconnectNextDelay=${bleStore.reconnectNextDelay}`)
//   console.log(new Error('[DIAG] 调用栈').stack)
// }, { flush: 'sync' })

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

onShow(async () => {
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
  if (bleStore.autoReconnectMode === 'comfort') {
    // 舒适模式（亮屏触发）→ onShow 时尝试重连
    // 闸门：用户主动断开(dormant) / 已连接 / 蓝牙关 → 不自动连；idle 避免重入
    if (bleStore.reconnectMode === 'idle' && bleStore._shouldAutoReconnect()) {
      bleStore.tryAutoConnect()
    }
  } else if (bleStore.autoReconnectMode === 'manual') {
    // ★ v3.24: 手动模式 — 不自动连接（统一闸门已拦截），仅由用户点击按钮控制
  } else if (bleStore.autoReconnectMode === 'speed') {
    // ★ Phase 3: 极速模式 → GPS 围栏检测（内部已含 _shouldAutoReconnect 闸门）
    if (!bleStore.connected) {
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
  } catch {
    toast.error('发送失败')
  }
}

async function handleLock() {
  try {
    await bleStore.lock()
    toast.success('锁车指令已发送')
  } catch {
    toast.error('发送失败')
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
  margin-bottom: 30rpx;
  border: 2rpx solid var(--border);
  transition: all 0.3s;
}

.status-card.connected {
  background: var(--gradient-connected);
  border-color: var(--alpha-33);
}

.status-card.reconnecting {
  background: linear-gradient(135deg, #FFF8E1, #FFF3E0);
  border-color: #FFE082;
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
</style>
