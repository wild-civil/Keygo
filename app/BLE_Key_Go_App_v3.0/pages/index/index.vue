<template>
  <view class="page-index">
    <!-- 顶部状态卡片 -->
    <view class="status-card" :class="{ connected: bleStore.connected, bound: bleStore.isBound }">
      <view class="status-icon">
        <text v-if="bleStore.isAuthorized">🔗</text>
        <text v-else-if="bleStore.connected && bleStore.connLocked">🚫</text>
        <text v-else-if="bleStore.connected">🔐</text>
        <text v-else>📡</text>
      </view>
      <view class="status-info">
        <text class="status-title">
          {{ bleStore.isAuthorized ? '已连接' : (bleStore.connected ? (bleStore.connLocked ? '已锁定' : '验证中...') : '未连接') }}
          <text v-if="bleStore.isAuthorized && bleStore.customName" class="custom-name-display">{{ bleStore.customName }}</text>
        </text>
        <text class="status-sub" v-if="bleStore.connected">
          {{ bleStore.deviceName }}
          <text v-if="bleStore.isBound" class="badge-bound">已绑定</text>
          <text v-else class="badge-unbound">未绑定</text>
          <text v-if="bleStore.trustCount > 0" class="badge-trust">{{ bleStore.trustCount }} 信任</text>
          | {{ bleStore.stateText }}
        </text>
        <text class="status-sub" v-else>扫描下方设备进行连接</text>
      </view>
      <view class="status-rssi" v-if="bleStore.connected && bleStore.isAuthorized">
        <text class="rssi-value">{{ bleStore.filteredRssi > -999 ? bleStore.filteredRssi : '---' }}</text>
        <text class="rssi-unit">dBm</text>
      </view>
    </view>

    <!-- 信号强度条 -->
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

    <!-- ★ v3.0: 连接密码锁定提示 -->
    <view class="auth-section lockout" v-if="bleStore.connected && bleStore.connLocked">
      <view class="auth-icon">🚫</view>
      <text class="auth-title">连接密码已锁定</text>
      <text class="auth-hint">密码错误次数过多，请等待 {{ bleStore.connLockSec }} 秒后重试</text>
      <text class="auth-hint-sub">或按设备配对按钮（PIN 9 短按）进入配对模式</text>
    </view>

    <!-- ★ v3.0: 连接密码输入 -->
    <view class="auth-section" v-if="bleStore.connected && bleStore.connNeeded && !bleStore.connVerified && !bleStore.connLocked">
      <view class="auth-icon">🔑</view>
      <text class="auth-title">输入连接密码</text>
      <text class="auth-hint" v-if="bleStore.connDefault">出厂默认连接密码: <text class="highlight">1234</text></text>
      <text class="auth-hint" v-else>此设备已设置自定义连接密码</text>
      <view class="auth-input-row">
        <input class="auth-input" v-model="connPasswordInput" type="number" :password="true"
               maxlength="6" placeholder="4-6 位连接密码" @confirm="handleConnSubmit" />
        <button class="auth-btn" @tap="handleConnSubmit">验证</button>
      </view>
      <text class="auth-hint-sub">输入设备连接密码以建立信任</text>
    </view>

    <!-- ★ v3.0: 绑定密码输入（连接密码已通过，还需验证绑定密码） -->
    <view class="auth-section" v-if="bleStore.connected && bleStore.connVerified && bleStore.bindNeeded && !bleStore.isAuthorized">
      <view class="auth-icon">🔒</view>
      <text class="auth-title">输入绑定密码</text>
      <text class="auth-hint" v-if="bleStore.bindDefault">出厂默认绑定密码: <text class="highlight">123456</text></text>
      <text class="auth-hint" v-else>此设备已被绑定，请输入绑定密码</text>
      <view class="auth-input-row">
        <view class="auth-input-wrap">
          <input v-if="showBindPwd" class="auth-input" v-model="bindPasswordInput"
                 type="text" maxlength="36" placeholder="4-12位，支持中文" @confirm="handleBindSubmit" />
          <input v-else class="auth-input" v-model="bindPasswordInput"
                 type="text" password maxlength="36" placeholder="4-12位，支持中文" @confirm="handleBindSubmit" />
          <text class="pwd-toggle" @tap="toggleBindPwd">{{ showBindPwd ? '🙈' : '👁' }}</text>
        </view>
        <button class="auth-btn" @tap="handleBindSubmit">验证</button>
      </view>
      <text class="auth-hint-sub">正确输入绑定密码即可接管设备</text>
    </view>

    <!-- 设备未绑定 + 已授权 → 提示修改密码 -->
    <view class="auth-section warn" v-if="bleStore.connected && bleStore.isBound && bleStore.isAuthorized && bleStore.bindDefault">
      <view class="auth-icon">⚠️</view>
      <text class="auth-title">建议修改绑定密码</text>
      <text class="auth-hint">设备绑定密码仍为出厂默认 <text class="highlight">123456</text></text>
      <button class="auth-btn-full" @tap="showChangeBindDialog">修改绑定密码</button>
    </view>

    <!-- ★ v3.0: 密码变更失败提示（连接密码已改但当前未重新验证） -->
    <view class="auth-section warn" v-if="bleStore.connected && bleStore.isAuthorized && bleStore.connDefault">
      <text class="auth-title" style="font-size:24rpx">连接密码仍为出厂默认 <text class="highlight">1234</text>，建议修改</text>
      <button class="auth-btn-full" @tap="showChangeConnDialog">修改连接密码</button>
    </view>

    <!-- 设备扫描区域 -->
    <view class="section" v-if="!bleStore.connected">
      <view class="section-header">
        <text class="section-title">附近设备</text>
        <button class="btn-scan" @tap="handleScan" :disabled="bleStore.scanning">
          {{ bleStore.scanning ? '扫描中...' : '扫描设备' }}
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

    <!-- ★ v3.0: 配对模式提示 -->
    <view class="bind-hint takeover-active" v-if="bleStore.pairingMode">
      <text class="bind-hint-text">🟢 配对模式已开启（30秒窗口）</text>
      <text class="takeover-sub">所有密码已跳过，当前连接可直接控制设备</text>
    </view>

    <!-- 已连接操作入口 -->
    <view class="quick-actions" v-if="bleStore.connected && bleStore.isAuthorized">
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

    <!-- ★ v3.1: 设备名称 -->
    <view class="password-mgmt" v-if="bleStore.connected && bleStore.isAuthorized">
      <text class="section-title mgmt-title">📝 设备名称修改</text>
      <view class="mgmt-rows">
        <view class="mgmt-row" @tap="showNameDialog">
          <text class="mgmt-label">设备名称</text>
          <text class="mgmt-val" v-if="bleStore.customName">{{ bleStore.customName }}</text>
          <text class="mgmt-val name-hint" v-else>点击设置（如车牌号）</text>
          <text class="mgmt-arrow">›</text>
        </view>
      </view>
    </view>

    <!-- 密码管理 -->
    <view class="password-mgmt" v-if="bleStore.connected && bleStore.isAuthorized">
      <text class="section-title mgmt-title">🔐 密码管理</text>
      <view class="mgmt-rows">
        <view class="mgmt-row" @tap="showChangeConnDialog">
          <text class="mgmt-label">修改连接密码</text>
          <text class="mgmt-val" v-if="bleStore.connDefault">默认 1234</text>
          <text class="mgmt-val" v-else>已自定义</text>
          <text class="mgmt-arrow">›</text>
        </view>
        <view class="mgmt-row" @tap="showChangeBindDialog">
          <text class="mgmt-label">修改绑定密码</text>
          <text class="mgmt-val" v-if="bleStore.bindDefault">默认 123456</text>
          <text class="mgmt-val" v-else>已自定义</text>
          <text class="mgmt-arrow">›</text>
        </view>
      </view>
      <view class="mgmt-hint">
        <text>修改连接密码将清空信任列表，所有设备需重新验证</text>
      </view>
    </view>

    <!-- 断开连接 -->
    <view class="disconnect-section" v-if="bleStore.connected">
      <button class="btn-disconnect" @tap="handleDisconnect">断开连接</button>
    </view>

    <!-- ★ v3.0: 密码输入弹窗（通用） -->
    <view class="pin-overlay" v-if="pwModal.visible" @tap.stop>
      <view class="pin-dialog" @tap.stop>
        <text class="pin-title">{{ pwModal.title }}</text>
        <text class="pin-hint">{{ pwModal.hint }}</text>
        <view class="pin-input-wrap">
          <!-- 纯数字模式（连接密码）：始终密码模式 -->
          <input v-if="pwModal.isNumeric" class="pin-input" v-model="pwModal.value"
                 type="number" password :maxlength="pwModal.maxLen" :placeholder="pwModal.placeholder" />
          <!-- 文本模式 + 隐藏密码：绑定密码修改、名称（密码态） -->
          <input v-else-if="!pwModal.showPassword" class="pin-input" v-model="pwModal.value"
                 type="text" password :maxlength="pwModal.maxLen" :placeholder="pwModal.placeholder" />
          <!-- 文本模式 + 显示密码：中文输入（明文态） -->
          <input v-else class="pin-input" v-model="pwModal.value"
                 type="text" :maxlength="pwModal.maxLen" :placeholder="pwModal.placeholder" />
          <text v-if="!pwModal.isNumeric" class="pwd-toggle" @tap="togglePwdVisible">
            {{ pwModal.showPassword ? '🙈' : '👁' }}
          </text>
        </view>
        <text class="pin-default-hint" v-if="pwModal.showDefault">{{ pwModal.defaultHint }}</text>
        <view class="pin-actions">
          <button class="pin-btn pin-cancel" @tap="pwModal.visible = false">取消</button>
          <button class="pin-btn pin-confirm" @tap="pwModal.onConfirm">{{ pwModal.confirmText || '确定' }}</button>
        </view>
      </view>
    </view>
  </view>
</template>


<script setup>
import { reactive, ref } from 'vue'
import { onShow } from '@dcloudio/uni-app'
import { useBleStore } from '@/stores/ble.js'
import { toast } from '@/utils/toast.js'

const bleStore = useBleStore()

let _autoScanDone = false

// ★ v3.0: 密码输入绑定
const connPasswordInput = ref('')
const bindPasswordInput = ref('')
const showBindPwd = ref(false)   // 绑定密码显示/隐藏切换

function toggleBindPwd() {
  showBindPwd.value = !showBindPwd.value
}

function togglePwdVisible() {
  pwModal.showPassword = !pwModal.showPassword
}

// ★ v3.0: 通用密码弹窗
const pwModal = reactive({
  visible: false,
  title: '',
  hint: '',
  placeholder: '',
  value: '',
  showDefault: false,
  defaultHint: '',
  isNumeric: true,
  maxLen: 6,
  confirmText: '确定',
  mode: '',        // 'changeConn' | 'changeBind' | 'changeConnStep2' | 'changeBindStep2' | 'setName'
  oldPass: '',
  showPassword: false,
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

async function handleScan() {
  if (bleStore.scanning) return
  try {
    await bleStore.startScanDevices(12)
    if (bleStore.devices.length === 0) {
      toast.info('未发现设备，请确认 ESP32 已上电')
    }
  } catch (err) {
    toast.error('请先打开手机蓝牙')
  }
}

async function handleConnect(device) {
  uni.showLoading({ title: '连接中...', mask: true })
  try {
    await bleStore.connect(device.deviceId, device.name)
    uni.hideLoading()
    toast.success('连接成功')
    // 重置输入
    connPasswordInput.value = ''
    bindPasswordInput.value = ''
    showBindPwd.value = false
    bleStore.devices = []
  } catch (err) {
    uni.hideLoading()
    toast.error('连接失败，请重试')
  }
}

async function handleDisconnect() {
  await bleStore.disconnect()
  uni.removeStorageSync('ble_device_id')
  bleStore.devices = []
  _autoScanDone = false
  toast.info('已断开连接')
}

// ★ v3.0: 连接密码验证
async function handleConnSubmit() {
  const pwd = connPasswordInput.value.trim()
  if (!pwd) {
    toast.info('请输入连接密码')
    return
  }

  uni.showLoading({ title: '验证中...', mask: true })
  try {
    await bleStore.verifyConnPassword(pwd)
    uni.hideLoading()
    connPasswordInput.value = ''
    toast.success('连接密码正确')
  } catch (err) {
    uni.hideLoading()
    toast.error(err.message || '验证失败')
  }
}

// ★ v3.0: 绑定密码验证
async function handleBindSubmit() {
  const pwd = bindPasswordInput.value.trim()
  if (!pwd) {
    toast.info('请输入绑定密码')
    return
  }

  uni.showLoading({ title: '验证中...', mask: true })
  try {
    await bleStore.verifyBindPassword(pwd)
    uni.hideLoading()
    bindPasswordInput.value = ''
    toast.success('授权成功！')

    // 如果是默认密码，提示修改
    if (bleStore.bindDefault) {
      setTimeout(() => {
        uni.showModal({
          title: '安全提醒',
          content: '绑定密码仍为出厂默认 123456，建议立即修改。',
          confirmText: '去修改',
          cancelText: '稍后',
          success: (res) => {
            if (res.confirm) showChangeBindDialog()
          }
        })
      }, 500)
    }
  } catch (err) {
    uni.hideLoading()
    bindPasswordInput.value = ''
    if (err.message && err.message.includes('断开')) {
      toast.error('绑定密码错误，连接已断开，请重新连接')
    } else {
      toast.error(err.message || '验证失败')
    }
  }
}

async function handleUnlock() {
  try {
    await bleStore.unlock()
    toast.success('解锁指令已发送')
  } catch { toast.error('发送失败') }
}

async function handleLock() {
  try {
    await bleStore.lock()
    toast.success('锁车指令已发送')
  } catch { toast.error('发送失败') }
}

async function handleTrunk() {
  try {
    await bleStore.trunk()
    toast.success('后备箱指令已发送')
  } catch { toast.error('发送失败') }
}

// ★ v3.1: 设备命名弹窗
function showNameDialog() {
  if (!bleStore.connected || !bleStore.isAuthorized) {
    toast.info('请先连接并验证设备')
    return
  }
  pwModal.mode = 'setName'
  pwModal.showPassword = false
  pwModal.title = '设置设备名称'
  pwModal.hint = '给设备起个名字，如车牌号、车型等'
  pwModal.placeholder = '设备名称（最长20字符，支持中文）'
  pwModal.value = bleStore.customName || ''
  pwModal.showDefault = false
  pwModal.defaultHint = ''
  pwModal.isNumeric = false
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

// ★ v3.0: 修改连接密码弹窗
function showChangeConnDialog() {
  if (!bleStore.connected || !bleStore.isAuthorized) {
    toast.info('请先连接并验证设备')
    return
  }
  pwModal.mode = 'changeConn'
  pwModal.title = '输入当前连接密码'
  pwModal.hint = '验证身份后方可修改连接密码'
  pwModal.placeholder = '当前连接密码'
  pwModal.value = ''
  pwModal.showDefault = bleStore.connDefault
  pwModal.defaultHint = '出厂默认: 1234'
  pwModal.isNumeric = true
  pwModal.maxLen = 6
  pwModal.confirmText = '下一步'
  pwModal.onConfirm = handleChangeConnStep1
  pwModal.visible = true
}

async function handleChangeConnStep1() {
  const oldPwd = pwModal.value.trim()
  if (!oldPwd) {
    toast.info('请输入当前连接密码')
    return
  }

  pwModal.oldPass = oldPwd
  pwModal.mode = 'changeConnStep2'
  pwModal.title = '设置新连接密码'
  pwModal.hint = '4-6 位数字，修改后将清空信任列表'
  pwModal.placeholder = '新连接密码（4-6位）'
  pwModal.value = ''
  pwModal.showDefault = false
  pwModal.defaultHint = ''
  pwModal.isNumeric = true
  pwModal.maxLen = 6
  pwModal.confirmText = '确认修改'
  pwModal.onConfirm = handleChangeConnStep2
  // 复用同一个弹窗
}

async function handleChangeConnStep2() {
  const newPwd = pwModal.value.trim()
  if (!newPwd || newPwd.length < 4) {
    toast.info('连接密码至少 4 位')
    return
  }

  pwModal.visible = false
  uni.showLoading({ title: '修改中...', mask: true })
  try {
    await bleStore.changeConnPassword(pwModal.oldPass, newPwd)
    uni.hideLoading()
    toast.success('连接密码已修改，信任列表已清空')
  } catch (err) {
    uni.hideLoading()
    toast.error(err.message || '修改失败')
  }
}

// ★ v3.0: 修改绑定密码弹窗
function showChangeBindDialog() {
  if (!bleStore.connected || !bleStore.isAuthorized) {
    toast.info('请先连接并验证设备')
    return
  }
  pwModal.mode = 'changeBind'
  pwModal.showPassword = false
  pwModal.title = '输入当前绑定密码'
  pwModal.hint = '验证身份后方可修改绑定密码'
  pwModal.placeholder = '当前绑定密码'
  pwModal.value = ''
  pwModal.showDefault = bleStore.bindDefault
  pwModal.defaultHint = '出厂默认: 123456'
  pwModal.isNumeric = false
  pwModal.maxLen = 36
  pwModal.confirmText = '下一步'
  pwModal.onConfirm = handleChangeBindStep1
  pwModal.visible = true
}

async function handleChangeBindStep1() {
  const oldPwd = pwModal.value.trim()
  if (!oldPwd) {
    toast.info('请输入当前绑定密码')
    return
  }

  pwModal.oldPass = oldPwd
  pwModal.mode = 'changeBindStep2'
  pwModal.showPassword = false
  pwModal.title = '设置新绑定密码'
  pwModal.hint = '4-12 位，支持中文字符'
  pwModal.placeholder = '新绑定密码（4-12位，支持中文）'
  pwModal.value = ''
  pwModal.showDefault = false
  pwModal.defaultHint = ''
  pwModal.isNumeric = false
  pwModal.maxLen = 36
  pwModal.confirmText = '确认修改'
  pwModal.onConfirm = handleChangeBindStep2
}

async function handleChangeBindStep2() {
  const newPwd = pwModal.value.trim()
  if (!newPwd || newPwd.length < 4) {
    toast.info('绑定密码至少 4 个字符')
    return
  }

  pwModal.visible = false
  uni.showLoading({ title: '修改中...', mask: true })
  try {
    await bleStore.changeBindPassword(pwModal.oldPass, newPwd)
    uni.hideLoading()
    toast.success('绑定密码修改成功')
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

/* 状态卡片 */
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

.status-card.bound {
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

.badge-trust {
  background: #6677ff33;
  color: #66aaff;
  font-size: 20rpx;
  padding: 2rpx 10rpx;
  border-radius: 8rpx;
  margin-left: 4rpx;
}

.custom-name-display {
  color: #00d4ff;
  font-weight: bold;
  font-size: inherit;
}

.mgmt-val.name-hint {
  color: #888;
  font-size: 24rpx;
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

/* 信号强度 */
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

/* ★ v3.0: 验证区块 */
.auth-section {
  background: #1a1a3e;
  border: 1rpx solid #2a2a5e;
  border-radius: 16rpx;
  padding: 32rpx 24rpx;
  margin-bottom: 24rpx;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 16rpx;
}

.auth-section.lockout {
  border-color: #ff444466;
  background: #2a1111;
}

.auth-section.warn {
  border-color: #ffaa0066;
  background: #2a2211;
}

.auth-icon {
  font-size: 48rpx;
}

.auth-title {
  font-size: 28rpx;
  font-weight: 600;
  color: #fff;
  text-align: center;
}

.auth-hint {
  font-size: 24rpx;
  color: #8899aa;
  text-align: center;
  line-height: 1.5;
}

.auth-hint-sub {
  font-size: 20rpx;
  color: #556677;
  text-align: center;
}

.highlight {
  color: #00d4ff;
  font-weight: 700;
}

.auth-input-row {
  display: flex;
  width: 100%;
  gap: 12rpx;
}

.auth-input-wrap {
  flex: 1;
  position: relative;
  display: flex;
  align-items: center;
}

.auth-input {
  flex: 1;
  width: 100%;
  height: 72rpx;
  background: #0d1a2e;
  border: 1rpx solid #334466;
  border-radius: 12rpx;
  font-size: 26rpx;
  color: #fff;
  text-align: center;
  letter-spacing: 6rpx;
  padding: 0 56rpx 0 20rpx;
}

.auth-btn {
  background: linear-gradient(135deg, #00d4ff 0%, #0088cc 100%);
  color: #fff;
  font-size: 26rpx;
  font-weight: 600;
  padding: 0 32rpx;
  height: 72rpx;
  border-radius: 12rpx;
  white-space: nowrap;
}

.auth-btn-full {
  background: linear-gradient(135deg, #00d4ff 0%, #0088cc 100%);
  color: #fff;
  font-size: 26rpx;
  font-weight: 600;
  padding: 14rpx 40rpx;
  border-radius: 20rpx;
}

.auth-btn:active, .auth-btn-full:active {
  opacity: 0.8;
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

/* 配对模式提示 */
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

.bind-hint.takeover-active {
  background: #003322;
  border-color: #00ff8866;
}

.bind-hint.takeover-active .bind-hint-text {
  color: #00ff88;
}

.bind-hint-text {
  color: #ffaa00;
  font-size: 24rpx;
  text-align: center;
}

.takeover-sub {
  color: #8899aa;
  font-size: 22rpx;
  text-align: center;
  line-height: 1.6;
}

/* 快捷操作 */
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

/* 密码管理 */
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

.mgmt-arrow {
  font-size: 28rpx;
  color: #556677;
}

.mgmt-hint {
  font-size: 20rpx;
  color: #ff880088;
  line-height: 1.4;
}

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

/* ★ v3.0: 密码弹窗 */
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
  position: relative;
  display: flex;
  align-items: center;
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
  padding: 0 56rpx 0 24rpx;
}

.pwd-toggle {
  position: absolute;
  right: 12rpx;
  font-size: 32rpx;
  line-height: 1;
  padding: 8rpx;
  z-index: 2;
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
