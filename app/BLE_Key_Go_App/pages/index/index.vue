<template>
  <view class="page-index">
    <!-- ★ 顶部状态卡片（继承 v3.0 设计：已连接/已配对 边框颜色区分） -->
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

    <!-- ★ 信号强度条（继承 v3.0 设计：距离+百分比条+阈值） -->
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

    <!-- ★ 首次配对提示 -->
    <view class="bind-hint" v-if="bleStore.connected && !bleStore.hasBondedDevices">
      <text class="bind-hint-text">🔐 首次使用，等待手机弹出配对弹窗……</text>
      <text class="takeover-sub">默认配对 PIN: <text class="highlight">123456</text>，配对后获得授权</text>
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

    <!-- ★ 设备管理（继承 v3.0 的 password-mgmt 风格：带箭头的条目式入口） -->
    <view class="password-mgmt" v-if="bleStore.connected && bleStore.isEncrypted">
      <text class="section-title mgmt-title">🔐 设备管理</text>
      <view class="mgmt-rows">
        <!-- 设备名称 -->
        <view class="mgmt-row" @tap="showNameDialog">
          <text class="mgmt-label">设备名称</text>
          <text class="mgmt-val" v-if="bleStore.customDeviceName">{{ bleStore.customDeviceName }}</text>
          <text class="mgmt-val name-hint" v-else>点击设置（如车牌号）</text>
          <text class="mgmt-arrow">›</text>
        </view>
        <!-- 配对 PIN -->
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

    <!-- ★ v3.2: 快捷操作（继承 v3.0 的 quick-actions 设计） -->
    <view class="quick-actions" v-if="bleStore.connected && bleStore.isEncrypted">
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

    <!-- ★ pwModal 通用弹窗（继承 v3.0 的 pin-dialog 设计，适配 v3.2 单 PIN 体系） -->
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
import { reactive } from 'vue'
import { onShow } from '@dcloudio/uni-app'
import { useBleStore } from '@/stores/ble.js'
import { toast } from '@/utils/toast.js'

const bleStore = useBleStore()
let _autoScanDone = false

// ★ 通用 pwModal（继承 v3.0 设计，适配 v3.2 单 PIN + 设备名称）
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
  mode: '',           // 'changePinStep1' | 'changePinStep2' | 'setName'
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

// 保留旧名兼容 onShow 自动扫描调用
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

// ==================== ★ 设备名称（继承 v3.0 弹窗设计） ====================

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

// ==================== ★ PIN 修改（继承 v3.0 两步式 pwModal 设计） ====================

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
  padding: 30rpx;
  padding-bottom: 130rpx;
  min-height: 100vh;
}

/* ★ 状态卡片（继承 v3.0 设计） */
.status-card {
  background: linear-gradient(135deg, #1a1a3e 0%, #16213e 100%);
  border-radius: 24rpx;
  padding: 40rpx;
  display: flex;
  align-items: center;
  margin-bottom: 30rpx;
  border: 2rpx solid #2a2a5e;
  transition: all 0.3s;
}

.status-card.connected {
  background: linear-gradient(135deg, #0a1628 0%, #0d2137 100%);
  border-color: #00d4ff33;
}

.status-card.bonded {
  border-color: #00ff8833;
}

.badge-bound {
  background: #00ff8833;
  color: #00ff88;
  font-size: 20rpx;
  padding: 2rpx 10rpx;
  border-radius: 8rpx;
  margin-left: 8rpx;
}

.badge-unbound {
  background: #ff880033;
  color: #ffaa00;
  font-size: 20rpx;
  padding: 2rpx 10rpx;
  border-radius: 8rpx;
  margin-left: 8rpx;
}

.custom-name-display {
  color: #00d4ff;
  font-weight: bold;
  font-size: inherit;
}

.status-icon {
  font-size: 48rpx;
  margin-right: 24rpx;
}

.status-info {
  flex: 1;
}

.status-title {
  font-size: 32rpx;
  font-weight: 600;
  color: #fff;
  display: block;
}

.status-sub {
  font-size: 24rpx;
  color: #8899aa;
  margin-top: 6rpx;
  display: block;
}

.status-rssi {
  text-align: center;
}

.rssi-value {
  font-size: 44rpx;
  font-weight: 700;
  color: #00d4ff;
  display: block;
}

.rssi-unit {
  font-size: 20rpx;
  color: #8899aa;
}

/* ★ 信号强度（继承 v3.0 设计） */
.signal-section {
  background: #1a1a3e;
  border-radius: 16rpx;
  padding: 24rpx;
  margin-bottom: 30rpx;
}

.signal-header {
  display: flex;
  justify-content: space-between;
  margin-bottom: 16rpx;
}

.signal-label {
  font-size: 26rpx;
  color: #8899aa;
}

.signal-dist {
  font-size: 26rpx;
  color: #00d4ff;
}

.signal-bar-bg {
  height: 12rpx;
  background: #2a2a5e;
  border-radius: 6rpx;
  overflow: hidden;
  margin-bottom: 16rpx;
}

.signal-bar-fill {
  height: 100%;
  border-radius: 6rpx;
  transition: width 0.5s ease;
}

.signal-bar-fill.weak { background: linear-gradient(90deg, #ff4444, #ff8800); }
.signal-bar-fill.medium { background: linear-gradient(90deg, #ff8800, #ffdd00); }
.signal-bar-fill.strong { background: linear-gradient(90deg, #00d4ff, #00ff88); }

.signal-thresholds {
  display: flex;
  justify-content: space-between;
  font-size: 22rpx;
  color: #556677;
}

/* 设备区域 */
.section {
  background: #1a1a3e;
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
  color: #fff;
}

.btn-scan {
  background: #00d4ff22;
  color: #00d4ff;
  font-size: 24rpx;
  padding: 12rpx 24rpx;
  border-radius: 20rpx;
  border: 1rpx solid #00d4ff44;
}

.scanning-hint {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 30rpx 0;
  color: #8899aa;
  font-size: 24rpx;
}

.scanning-dot {
  width: 16rpx;
  height: 16rpx;
  background: #00d4ff;
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
  background: #16213e;
  transition: background 0.2s;
}

.device-item.active {
  background: #00d4ff11;
  border: 1rpx solid #00d4ff33;
}

.device-info {
  flex: 1;
}

.device-name {
  font-size: 28rpx;
  color: #fff;
  display: block;
}

.device-id {
  font-size: 20rpx;
  color: #556677;
  margin-top: 4rpx;
  display: block;
}

.device-rssi {
  text-align: center;
  margin-right: 16rpx;
}

.device-rssi-val {
  font-size: 28rpx;
  font-weight: 600;
  color: #00d4ff;
  display: block;
}

.device-rssi-unit {
  font-size: 18rpx;
  color: #556677;
}

.device-arrow {
  font-size: 36rpx;
  color: #556677;
}

.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 60rpx 0;
}

.empty-icon {
  font-size: 60rpx;
  margin-bottom: 16rpx;
}

.empty-text {
  font-size: 26rpx;
  color: #8899aa;
}

.empty-sub {
  font-size: 22rpx;
  color: #556677;
  margin-top: 8rpx;
}

/* ★ 配对提示（继承 v3.0 bind-hint 设计） */
.bind-hint {
  background: #332200;
  border: 1rpx solid #664400;
  border-radius: 16rpx;
  padding: 24rpx;
  margin-bottom: 30rpx;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 16rpx;
}

.bind-hint.paired {
  background: #003322;
  border-color: #006644;
}

.bind-hint.takeover-active {
  background: #003322;
  border-color: #00ff8866;
}

.bind-hint.takeover-active .bind-hint-text {
  color: #00ff88;
}

/* ★ 默认 PIN 警告卡片 */
.default-pin-warn {
  background: linear-gradient(135deg, #332200, #2a1a00);
  border: 1rpx solid #ff880044;
  border-radius: 16rpx;
  padding: 24rpx;
  margin-bottom: 30rpx;
  display: flex;
  align-items: center;
  gap: 16rpx;
}

.warn-icon {
  font-size: 36rpx;
}

.warn-body {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 6rpx;
}

.warn-title {
  font-size: 26rpx;
  color: #ffaa00;
  font-weight: 600;
}

.warn-desc {
  font-size: 22rpx;
  color: #8899aa;
  line-height: 1.5;
}

.warn-arrow {
  font-size: 28rpx;
  color: #ffaa00;
  font-weight: 600;
  padding: 8rpx;
}

.bind-hint-text {
  color: #ffaa00;
  font-size: 24rpx;
  text-align: center;
}

.bind-hint.paired .bind-hint-text {
  color: #00ff88;
}

.takeover-sub {
  color: #8899aa;
  font-size: 22rpx;
  text-align: center;
  line-height: 1.6;
}

.highlight {
  color: #00d4ff;
  font-weight: 700;
}

/* ★ 设备管理（继承 v3.0 password-mgmt 设计） */
.password-mgmt {
  background: #1a1a3e;
  border-radius: 16rpx;
  padding: 24rpx;
  margin-bottom: 24rpx;
}

.mgmt-title {
  margin-bottom: 16rpx;
}

.mgmt-rows {
  margin-bottom: 12rpx;
}

.mgmt-row {
  display: flex;
  align-items: center;
  padding: 20rpx 0;
  border-bottom: 1rpx solid #2a2a5e;
}

.mgmt-row:last-child {
  border-bottom: none;
}

.mgmt-label {
  flex: 1;
  font-size: 26rpx;
  color: #ccd;
}

.mgmt-val {
  font-size: 24rpx;
  color: #6677aa;
  margin-right: 12rpx;
}

.mgmt-val.name-hint {
  color: #888;
  font-size: 24rpx;
}

.mgmt-arrow {
  font-size: 28rpx;
  color: #556677;
}

.mgmt-hint {
  font-size: 20rpx;
  color: #ff880088;
  line-height: 1.4;
}

/* ★ 快捷操作（继承 v3.0 设计） */
.quick-actions {
  display: flex;
  gap: 16rpx;
  margin-bottom: 30rpx;
}

.action-btn {
  flex: 1;
  background: #1a1a3e;
  border-radius: 16rpx;
  padding: 30rpx 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  border: 1rpx solid #2a2a5e;
}

.action-btn:active {
  opacity: 0.7;
}

.action-icon {
  font-size: 44rpx;
  margin-bottom: 8rpx;
}

.action-text {
  font-size: 24rpx;
  color: #fff;
}

.unlock-btn { border-color: #00d4ff44; }
.lock-btn { border-color: #ff880044; }
.trunk-btn { border-color: #00ff8844; }

/* 断开连接 */
.disconnect-section {
  display: flex;
  justify-content: center;
}

.btn-disconnect {
  background: transparent;
  color: #ff4444;
  font-size: 24rpx;
  padding: 16rpx 48rpx;
  border: 1rpx solid #ff444444;
  border-radius: 20rpx;
}

/* ★ pwModal 弹窗（继承 v3.0 pin-dialog 设计） */
.pin-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.7);
  display: flex;
  justify-content: center;
  align-items: center;
  z-index: 999;
}

.pin-dialog {
  width: 560rpx;
  background: #1a1a3e;
  border-radius: 24rpx;
  padding: 48rpx 40rpx;
  border: 1rpx solid #2a2a5e;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 24rpx;
}

.pin-title {
  font-size: 32rpx;
  font-weight: 600;
  color: #fff;
}

.pin-hint {
  font-size: 24rpx;
  color: #8899aa;
  text-align: center;
  line-height: 1.5;
}

.pin-input-wrap {
  width: 100%;
}

.pin-input {
  width: 100%;
  height: 80rpx;
  background: #16213e;
  border: 1rpx solid #2a2a5e;
  border-radius: 12rpx;
  font-size: 28rpx;
  color: #fff;
  text-align: center;
  letter-spacing: 8rpx;
  padding: 0 24rpx;
  box-sizing: border-box;
}

.pin-default-hint {
  font-size: 22rpx;
  color: #ffaa00;
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
  color: #8899aa;
  border: 1rpx solid #2a2a5e;
}

.pin-confirm {
  background: linear-gradient(135deg, #00d4ff 0%, #0088cc 100%);
  color: #fff;
}
</style>
