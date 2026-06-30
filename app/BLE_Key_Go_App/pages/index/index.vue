<template>
  <view class="page-index" :class="themeClass">
    <!-- ★ 顶部状态卡片 -->
    <view class="status-card" :class="{ connected: bleStore.connected, bonded: bleStore.hasBondedDevices }">
      <view class="status-icon">
        <text v-if="bleStore.connected">🔗</text>
        <text v-else>📡</text>
      </view>
      <view class="status-info">
        <text class="status-title">
          {{ bleStore.connected ? '已连接' : '未连接' }}
          <text v-if="bleStore.connected && bleStore.customDeviceName" class="custom-name-display">{{ bleStore.customDeviceName }}</text>
        </text>
        <text class="status-sub" v-if="bleStore.connected">
          {{ bleStore.deviceName }}
          <text v-if="bleStore.hasBondedDevices" class="badge-bound">已绑定</text>
          <text v-else class="badge-unbound">未配对</text>
          | {{ bleStore.stateText }}
        </text>
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

    <!-- ★ v3.5.10: Just Works 加密后 PIN 验证提示（新配对 / bond 失效后重连） -->
    <view class="bind-hint" v-if="bleStore.connected && bleStore.isEncrypted && !bleStore.pinVerified">
      <text class="bind-hint-text">🔐 请输入设备 PIN 完成验证</text>
      <text class="takeover-sub">输入正确的 PIN 后才能控制车辆</text>
      <view class="verify-pin-row">
        <input class="verify-pin-input" v-model="verifyPinInput" type="number" password
               :maxlength="6" placeholder="设备 PIN（默认 123456）" />
        <button class="verify-pin-btn" @tap="handleVerifyPin">验证</button>
      </view>
      <text class="verify-error" v-if="bleStore.pinVerifyFail">❌ PIN 错误，请重试</text>
      <text class="takeover-sub" v-if="bleStore.pinDefault">💡 出厂默认 PIN: <text class="highlight">123456</text></text>
    </view>

    <!-- ★ 等待加密提示 -->
    <view class="bind-hint" v-if="bleStore.connected && !bleStore.isEncrypted">
      <text class="bind-hint-text">⏳ 正在建立加密连接，请稍候...</text>
      <text class="takeover-sub">首次使用 Just Works 静默加密，无需手动配对</text>
    </view>

    <!-- ★ 配对模式提示 -->
    <view class="bind-hint takeover-active" v-if="bleStore.pairingMode">
      <text class="bind-hint-text">🟢 配对模式已开启（30秒窗口）</text>
      <text class="takeover-sub">任何手机现在都可以配对连接此设备</text>
    </view>

    <!-- ★ 默认 PIN 警告 -->
    <view class="default-pin-warn" v-if="bleStore.connected && bleStore.pinDefault">
      <view class="warn-icon">⚠️</view>
      <view class="warn-body">
        <text class="warn-title">建议修改默认 PIN</text>
        <text class="warn-desc">当前仍使用出厂 PIN <text class="highlight">123456</text>，安全性较低</text>
      </view>
      <text class="warn-arrow" @tap="showChangePinDialog">修改 ›</text>
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
        <text class="empty-sub">确保 ESP32-C3 已上电并广播中（LED 闪烁）</text>
      </view>
    </view>

    <!-- ★ 设备管理（需 PIN 验证通过） -->
    <view class="password-mgmt" v-if="bleStore.connected && bleStore.isEncrypted && bleStore.pinVerified">
      <text class="section-title mgmt-title">🔐 设备管理</text>
      <view class="mgmt-rows">
        <view class="mgmt-row" @tap="showNameDialog">
          <text class="mgmt-label">设备名称</text>
          <text class="mgmt-val" v-if="bleStore.customDeviceName">{{ bleStore.customDeviceName }}</text>
          <text class="mgmt-val name-hint" v-else>点击设置（如车牌号）</text>
          <text class="mgmt-arrow">›</text>
        </view>
        <view class="mgmt-row" @tap="showChangePinDialog">
          <text class="mgmt-label">修改配对 PIN</text>
          <text class="mgmt-val" v-if="bleStore.pinDefault">默认 123456</text>
          <text class="mgmt-val" v-else>已自定义</text>
          <text class="mgmt-arrow">›</text>
        </view>
      </view>
      <view class="mgmt-hint">
        <text>修改 PIN 后将清空所有配对记录，所有手机需重新配对</text>
      </view>
    </view>

    <!-- ★ 快捷操作（需 PIN 验证通过） -->
    <view class="quick-actions" v-if="bleStore.connected && bleStore.isEncrypted && bleStore.pinVerified">
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
import { reactive, ref, computed } from 'vue'
import { onShow } from '@dcloudio/uni-app'
import { useBleStore } from '@/stores/ble.js'
import { useThemeStore } from '@/stores/theme.js'
import { toast } from '@/utils/toast.js'
const bleStore = useBleStore()
const themeStore = useThemeStore()
const themeClass = computed(() => themeStore.themeClass)
let _autoScanDone = false

// ★ v3.5.10: PIN 验证输入
const verifyPinInput = ref('')

// ★ 通用 pwModal
const pwModal = reactive({
  visible: false,
  title: '',
  hint: '',
  placeholder: '',
  value: '',
  showDefaultHint: false,
  defaultHint: '',
  maxLen: 6,
  confirmText: '确定',
  mode: '',
  oldPin: '',
  onConfirm: () => {}
})

onShow(() => {
  if (bleStore.connected) return
  if (_autoScanDone) return
  _autoScanDone = true

  const savedId = uni.getStorageSync('ble_device_id')
  if (savedId) {
    bleStore.tryAutoConnect().then(connected => {
      if (!connected) handleScan()
    })
  } else {
    handleScan()
  }
})

// ==================== 扫描 & 连接 ====================

async function handleScanToggle() {
  if (bleStore.scanning) {
    await bleStore.stopScanDevices()
    return
  }
  try {
    await bleStore.startScanDevices(12)
    if (bleStore.devices.length === 0) {
      toast.info('未发现设备，请确认 ESP32 已上电')
    }
  } catch {
    toast.error('请先打开手机蓝牙')
  }
}

async function handleScan() {
  if (bleStore.scanning) return
  try {
    await bleStore.startScanDevices(12)
    if (bleStore.devices.length === 0) {
      toast.info('未发现设备，请确认 ESP32 已上电')
    }
  } catch {
    toast.error('请先打开手机蓝牙')
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
    _autoScanDone = false
    toast.info('已断开连接')
  } else {
    toast.error('断开失败，请重试')
  }
}

// ★ v3.5.10: PIN 验证
async function handleVerifyPin() {
  const pin = verifyPinInput.value.trim()
  if (!pin || !/^\d{4,6}$/.test(pin)) {
    toast.info('请输入 4-6 位数字 PIN')
    return
  }
  uni.showLoading({ title: '验证中...', mask: true })
  try {
    const result = await bleStore.verifyPin(pin)
    uni.hideLoading()
    if (result.success) {
      verifyPinInput.value = ''
      toast.success('验证成功，设备已授权')
    } else {
      verifyPinInput.value = ''
      toast.error('PIN 错误，请重试')
    }
  } catch (err) {
    uni.hideLoading()
    toast.error(err.message || '验证失败')
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
  if (!bleStore.connected || !bleStore.isEncrypted) {
    toast.info('请先连接并配对设备')
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

// ==================== PIN 修改 ====================

function showChangePinDialog() {
  if (!bleStore.connected || !bleStore.isEncrypted) {
    toast.info('请先连接并配对设备')
    return
  }
  pwModal.mode = 'changePinStep1'
  pwModal.title = '输入当前 PIN'
  pwModal.hint = '请输入设备当前的配对 PIN'
  pwModal.placeholder = '当前 PIN'
  pwModal.value = ''
  pwModal.showDefaultHint = bleStore.pinDefault
  pwModal.defaultHint = '出厂默认: 123456'
  pwModal.maxLen = 6
  pwModal.confirmText = '下一步'
  pwModal.onConfirm = onPinStep1
  pwModal.visible = true
}

function onPinStep1() {
  const pin = pwModal.value.trim()
  if (!pin || !/^\d{4,6}$/.test(pin)) {
    toast.info('请输入 4-6 位数字 PIN')
    return
  }
  pwModal.oldPin = pin
  pwModal.mode = 'changePinStep2'
  pwModal.title = '设置新 PIN'
  pwModal.hint = '4-6 位数字，修改后将清空所有配对记录'
  pwModal.placeholder = '新 PIN（4-6位数字）'
  pwModal.value = ''
  pwModal.showDefaultHint = false
  pwModal.defaultHint = ''
  pwModal.maxLen = 6
  pwModal.confirmText = '确认修改'
  pwModal.onConfirm = onPinStep2
}

async function onPinStep2() {
  const newPin = pwModal.value.trim()
  if (!newPin || !/^\d{4,6}$/.test(newPin)) {
    toast.info('新 PIN 须为 4-6 位数字')
    return
  }
  pwModal.visible = false
  uni.showLoading({ title: '修改中...', mask: true })
  try {
    const result = await bleStore.changePin(pwModal.oldPin, newPin)
    uni.hideLoading()
    if (result.success) {
      toast.success('PIN 修改成功！设备已断连，请重新扫描配对')
    } else if (result.errorCode === 1) {
      toast.error('旧 PIN 错误，请重试')
    } else if (result.errorCode === 2) {
      toast.error('新 PIN 格式错误，须为 4-6 位数字')
    } else {
      toast.error('修改失败，请重试')
    }
  } catch (err) {
    uni.hideLoading()
    toast.error(err.message || '修改失败')
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

.status-card.bonded {
  border-color: var(--green-alpha-33);
}

.badge-bound {
  background: var(--green-alpha-33);
  color: var(--accent-green);
  font-size: 20rpx;
  padding: 2rpx 10rpx;
  border-radius: 8rpx;
  margin-left: 8rpx;
}

.badge-unbound {
  background: var(--orange-alpha-33);
  color: var(--accent-orange);
  font-size: 20rpx;
  padding: 2rpx 10rpx;
  border-radius: 8rpx;
  margin-left: 8rpx;
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

/* ===== 配对提示 ===== */
.bind-hint {
  background: var(--bg-warning);
  border: 1rpx solid var(--border-warning);
  border-radius: 16rpx;
  padding: 24rpx;
  margin-bottom: 30rpx;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 16rpx;
}

.bind-hint.takeover-active {
  background: var(--bg-success);
  border-color: var(--green-alpha-40);
}

.bind-hint.takeover-active .bind-hint-text {
  color: var(--accent-green);
}

.bind-hint-text {
  color: var(--accent-orange);
  font-size: 24rpx;
  text-align: center;
}

.takeover-sub {
  color: var(--text-tertiary);
  font-size: 22rpx;
  text-align: center;
  line-height: 1.6;
}

.highlight { color: var(--accent); font-weight: 700; }

/* ===== v3.5.10: PIN 验证输入行 ===== */
.verify-pin-row {
  display: flex;
  gap: 16rpx;
  width: 100%;
  align-items: center;
}

.verify-pin-input {
  flex: 1;
  height: 72rpx;
  background: var(--bg-card);
  border: 1rpx solid var(--border);
  border-radius: 12rpx;
  font-size: 26rpx;
  color: var(--text-primary);
  text-align: center;
  letter-spacing: 6rpx;
  padding: 0 20rpx;
  box-sizing: border-box;
}

.verify-pin-btn {
  width: 140rpx;
  height: 72rpx;
  background: var(--gradient-accent);
  color: #fff;
  font-size: 26rpx;
  font-weight: 600;
  border-radius: 12rpx;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
}

.verify-error {
  color: var(--accent-red);
  font-size: 22rpx;
  text-align: center;
  margin-top: 4rpx;
}

/* ===== 默认 PIN 警告卡片 ===== */
.default-pin-warn {
  background: var(--gradient-warn-card);
  border: 1rpx solid var(--orange-alpha-27);
  border-radius: 16rpx;
  padding: 24rpx;
  margin-bottom: 30rpx;
  display: flex;
  align-items: center;
  gap: 16rpx;
}

.warn-icon { font-size: 36rpx; }

.warn-body {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 6rpx;
}

.warn-title {
  font-size: 26rpx;
  color: var(--accent-orange);
  font-weight: 600;
}

.warn-desc {
  font-size: 22rpx;
  color: var(--text-tertiary);
  line-height: 1.5;
}

.warn-arrow {
  font-size: 28rpx;
  color: var(--accent-orange);
  font-weight: 600;
  padding: 8rpx;
}

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

.mgmt-hint {
  font-size: 20rpx;
  color: var(--mgmt-hint);
  line-height: 1.4;
}

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
