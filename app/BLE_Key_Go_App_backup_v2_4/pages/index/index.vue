<template>
  <view class="page-index">
    <!-- 顶部状态卡片 -->
    <view class="status-card" :class="{ connected: bleStore.connected, bound: bleStore.isBound }">
      <view class="status-icon">
        <text v-if="bleStore.connected && bleStore.isAuthorized">🔗</text>
        <text v-else-if="bleStore.connected && !bleStore.isAuthorized">⚠️</text>
        <text v-else>📡</text>
      </view>
      <view class="status-info">
        <text class="status-title">
          {{ bleStore.connected
              ? (bleStore.isAuthorized ? '已连接' : '未授权')
              : '未连接' }}
        </text>
        <text class="status-sub" v-if="bleStore.connected">
          {{ bleStore.deviceName }}
          <text v-if="bleStore.isBound" class="badge-bound">已绑定</text>
          <text v-else class="badge-unbound">未绑定</text>
          | {{ bleStore.stateText }}
        </text>
        <text class="status-sub" v-else>扫描下方设备进行连接</text>
      </view>
      <view class="status-rssi" v-if="bleStore.connected && bleStore.isAuthorized">
        <text class="rssi-value">{{ bleStore.filteredRssi > -999 ? bleStore.filteredRssi : '---' }}</text>
        <text class="rssi-unit">dBm</text>
      </view>
    </view>

    <!-- 信号强度条（已连接时显示） -->
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
    <view class="section">
      <view class="section-header">
        <text class="section-title">附近设备</text>
        <button class="btn-scan" @tap="handleScan" :disabled="bleStore.scanning">
          {{ bleStore.scanning ? '扫描中...' : '扫描设备' }}
        </button>
      </view>

      <!-- 扫描中动画 -->
      <view class="scanning-hint" v-if="bleStore.scanning">
        <view class="scanning-dot"></view>
        <text>正在搜索 KeyGo 设备 ...</text>
      </view>

      <!-- 设备列表 -->
      <view class="device-list" v-if="bleStore.devices.length > 0">
        <view class="device-item" v-for="device in bleStore.devices" :key="device.deviceId"
          :class="{ active: bleStore.deviceId === device.deviceId }" @tap="handleConnect(device)">
          <view class="device-info">
            <!-- ★ v2.2: 设备名已由 ble.js 从 advertisData/name/localName 三级取最长 -->
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

      <!-- 空状态 -->
      <view class="empty-state" v-if="!bleStore.scanning && bleStore.devices.length === 0">
        <text class="empty-icon">🔍</text>
        <text class="empty-text">点击"扫描设备"搜索附近 KeyGo 设备</text>
        <text class="empty-sub">确保 ESP32-C3 已上电并广播中（LED 闪烁）</text>
      </view>
    </view>

    <!-- ★ v2.3: 设备已绑定到其他手机 → 引导用配对模式接管 -->
    <view class="bind-hint takeover" v-if="bleStore.connected && bleStore.isBound && !bleStore.isAuthorized && !bleStore.pairingMode">
      <text class="bind-hint-text">⚠️ 此设备已绑定到其他手机</text>
      <text class="takeover-sub">方式一：按设备上的配对按键（PIN 9 短按），进入配对模式后即可接管</text>
      <text class="takeover-sub">如需彻底重置，长按（PIN 9） 5秒可恢复出厂设置</text>
      <!-- ★ v2.4: 方式二：输入主人分享的密钥 -->
      <view class="share-guest-section">
        <text class="takeover-sub share-or-line">──────── 或使用分享密钥 ────────</text>
        <view class="share-guest-row">
          <input class="share-guest-input" v-model="shareKeyInput" placeholder="8位分享密钥" maxlength="8" />
          <button class="btn-share-auth" @tap="handleAuthWithShareKey">验证并接管</button>
        </view>
      </view>
    </view>

    <!-- ★ v2.3: 配对模式激活 + 已绑定 → 当前手机可接管设备 -->
    <view class="bind-hint takeover-active" v-if="bleStore.connected && bleStore.isBound && bleStore.isAuthorized && bleStore.pairingMode">
      <text class="bind-hint-text">🟢 配对模式已开启，可以接管此设备</text>
      <text class="takeover-sub">验证设备密码后即可将设备绑定到当前手机</text>
      <button class="btn-bind" @tap="handleBind">验证并接管设备</button>
    </view>

    <!-- ★ v2.2: 绑定状态提示 -->
    <view class="bind-hint" v-if="bleStore.connected && !bleStore.isBound && bleStore.isAuthorized">
      <text class="bind-hint-text">🔐 设备未绑定，点击下方按钮完成绑定（仅首次需要）</text>
      <button class="btn-bind" @tap="handleBind">锁定此设备</button>
    </view>
    <!-- ★ v2.3: 绑定后提示修改密码 -->
    <view class="bind-hint paired" v-if="bleStore.connected && bleStore.isBound && bleStore.isAuthorized && !bleStore.pairingMode && bleStore.pinDefault">
      <text class="bind-hint-text">🔐 设备使用出厂默认密码，建议立即修改</text>
      <button class="btn-bind" @tap="handleChangePin">修改密码</button>
    </view>
    <view class="bind-hint paired" v-if="bleStore.pairingMode && !bleStore.isBound">
      <text class="bind-hint-text">🟢 配对模式已开启（30秒窗口），新设备可连接绑定</text>
    </view>

    <!-- ★ v2.4: 主人分享密钥管理 -->
    <view class="bind-hint share-owner" v-if="bleStore.connected && bleStore.isBound && bleStore.isAuthorized && !bleStore.pairingMode">
      <text class="bind-hint-text">🔑 主人分享密钥</text>
      <text class="share-owner-desc">生成一个临时密钥分享给他人，对方无需按配对按钮即可接管设备</text>
      <!-- 无活跃密钥 → 显示生成按钮 -->
      <view v-if="!bleStore.shareActive && !shareKeyGenerated" class="share-owner-actions">
        <button class="btn-share-gen" @tap="showShareGenDialog">生成分享密钥</button>
      </view>
      <!-- 有活跃密钥 → 显示密钥信息 -->
      <view v-if="bleStore.shareActive || shareKeyGenerated" class="share-key-display">
        <view class="share-key-row">
          <text class="share-key-label">密钥：</text>
          <text class="share-key-value">{{ shareKeyGenerated || (bleStore.shareActive ? '******' : '') }}</text>
          <text class="share-key-copy" v-if="shareKeyGenerated" @tap="copyShareKey">复制</text>
        </view>
        <view class="share-key-expiry" v-if="bleStore.shareExpiry > 0">
          <text>剩余有效：{{ formatShareExpiry(bleStore.shareExpiry) }}</text>
        </view>
        <view class="share-owner-actions">
          <button class="btn-share-revoke" @tap="handleRevokeShareKey">撤销密钥</button>
        </view>
      </view>
    </view>

    <!-- ★ v2.4: 分享密钥生成弹窗（选择有效期） -->
    <view class="pin-overlay" v-if="shareGenDialog.visible" @tap.stop>
      <view class="pin-dialog" @tap.stop>
        <text class="pin-title">生成分享密钥</text>
        <text class="pin-hint">选择密钥有效期，生成后分享给他人即可</text>
        <view class="share-duration-options">
          <view class="share-dur-item" :class="{ active: shareGenDialog.duration === 1 }" @tap="shareGenDialog.duration = 1">1 小时</view>
          <view class="share-dur-item" :class="{ active: shareGenDialog.duration === 6 }" @tap="shareGenDialog.duration = 6">6 小时</view>
          <view class="share-dur-item" :class="{ active: shareGenDialog.duration === 24 }" @tap="shareGenDialog.duration = 24">24 小时</view>
          <view class="share-dur-item" :class="{ active: shareGenDialog.duration === 72 }" @tap="shareGenDialog.duration = 72">3 天</view>
          <view class="share-dur-item" :class="{ active: shareGenDialog.duration === 168 }" @tap="shareGenDialog.duration = 168">7 天</view>
        </view>
        <view class="pin-actions">
          <button class="pin-btn pin-cancel" @tap="shareGenDialog.visible = false">取消</button>
          <button class="pin-btn pin-confirm" @tap="handleGenerateShareKey">生成</button>
        </view>
      </view>
    </view>

    <!-- ★ v2.3: PIN 输入弹窗 -->
    <view class="pin-overlay" v-if="pinModal.visible" @tap.stop>
      <view class="pin-dialog" @tap.stop>
        <text class="pin-title">{{ pinModal.title }}</text>
        <text class="pin-hint">{{ pinModal.hint }}</text>
        <input class="pin-input" v-model="pinModal.value" type="number" :password="true"
               :maxlength="pinModal.isNewPin ? 16 : 6" :placeholder="pinModal.placeholder" />
        <text class="pin-default-hint" v-if="pinModal.showDefaultHint">出厂默认密码: 123456</text>
        <view class="pin-actions">
          <button class="pin-btn pin-cancel" @tap="pinModal.visible = false">取消</button>
          <button class="pin-btn pin-confirm" @tap="pinModal.onConfirm">确定</button>
        </view>
      </view>
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

    <!-- 断开 / 解绑 -->
    <view class="disconnect-section" v-if="bleStore.connected">
      <button class="btn-disconnect" @tap="handleDisconnect">断开连接</button>
      <button class="btn-unbind" v-if="bleStore.isBound && bleStore.isAuthorized" @tap="handleUnbind">解除绑定</button>
    </view>
  </view>
</template>


<script setup>
import { reactive, ref } from 'vue'
import { onShow } from '@dcloudio/uni-app'
import { useBleStore } from '@/stores/ble.js'
import { toast } from '@/utils/toast.js'

const bleStore = useBleStore()

// ★ 防止每次切 tab 都重新扫描：仅首次 onShow 自动扫描
let _autoScanDone = false

// ★ v2.4: 分享密钥相关状态
const shareKeyInput = ref('')
const shareKeyGenerated = ref('')  // 本地保存生成的密钥明文（显示用）
const shareGenDialog = reactive({
  visible: false,
  duration: 24  // 默认 24 小时
})

// ★ v2.3: PIN 输入弹窗状态
const pinModal = reactive({
  visible: false,
  title: '',
  hint: '',
  placeholder: '',
  value: '',
  showDefaultHint: false,
  isNewPin: false,
  mode: '',        // 'bind' | 'change'
  oldPin: '',
  onConfirm: () => {}
})

onShow(() => {
  if (bleStore.connected) return  // 已连接，不需要扫描

  if (_autoScanDone) return       // 已扫描过，不重复触发
  _autoScanDone = true

  const savedId = uni.getStorageSync('ble_device_id')
  if (savedId) {
    bleStore.tryAutoConnect().then(connected => {
      if (!connected) {
        handleScan()
      }
    })
  } else {
    handleScan()
  }
})

async function handleScan() {
  if (bleStore.scanning) return
  try {
    await bleStore.startScanDevices(12)  // ★ v2.2: 延长到12秒，NimBLE 设备名上报可能稍慢
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
    await bleStore.connect(device.deviceId, device.name)  // device.name 已由 ble.js 计算好
    uni.hideLoading()
    toast.success('连接成功')
    // 连接成功后清空扫描列表
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
  _autoScanDone = false     // 重置，允许下次手动扫描
  toast.info('已断开连接')
}

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

// ★ v2.3: 绑定（需 PIN 验证）
async function handleBind() {
  // 弹出 PIN 输入弹窗
  pinModal.mode = 'bind'
  pinModal.title = '输入设备密码'
  pinModal.hint = '请输入 6 位设备密码以完成绑定'
  pinModal.placeholder = '请输入出厂密码 123456'
  pinModal.value = ''
  pinModal.showDefaultHint = true
  pinModal.isNewPin = false
  pinModal.onConfirm = handlePinConfirm
  pinModal.visible = true
}

// ★ v2.3: PIN 弹窗确认回调
async function handlePinConfirm() {
  const pin = pinModal.value.trim()
  if (!pin) {
    toast.info('请输入密码')
    return
  }

  pinModal.visible = false

  if (pinModal.mode === 'bind') {
    await doBind(pin)
  } else if (pinModal.mode === 'change') {
    // 修改密码：先输入旧密码弹窗 → 再输入新密码
    pinModal.oldPin = pin
    pinModal.mode = 'newPin'
    pinModal.title = '设置新密码'
    pinModal.hint = '请输入 4-16 位新密码'
    pinModal.placeholder = '新密码（4-16位）'
    pinModal.value = ''
    pinModal.showDefaultHint = false
    pinModal.isNewPin = true
    pinModal.onConfirm = handleNewPinConfirm
    pinModal.visible = true
  } else if (pinModal.mode === 'newPin') {
    await doChangePin(pinModal.oldPin, pin)
  }
}

// ★ v2.3: 新密码确认回调
async function handleNewPinConfirm() {
  const newPin = pinModal.value.trim()
  if (newPin.length < 4 || newPin.length > 16) {
    toast.info('新密码须为 4-16 位')
    return
  }
  pinModal.visible = false
  await doChangePin(pinModal.oldPin, newPin)
}

// ★ v2.3: 执行绑定
async function doBind(pinCode) {
  uni.showLoading({ title: '验证密码...', mask: true })
  try {
    await bleStore.bind(pinCode)
    uni.hideLoading()
    toast.success('绑定成功')
    // 提示修改密码
    if (bleStore.pinDefault) {
      setTimeout(() => {
        uni.showModal({
          title: '安全提醒',
          content: '设备当前使用出厂默认密码 123456，建议立即修改以确保安全。',
          confirmText: '去修改',
          cancelText: '稍后',
          success: (res) => {
            if (res.confirm) handleChangePin()
          }
        })
      }, 500)
    }
  } catch (err) {
    uni.hideLoading()
    if (err.message === 'PIN 码错误') {
      toast.error('密码错误，请重试（出厂默认: 123456）')
    } else {
      toast.error(err.message || '绑定失败')
    }
  }
}

// ★ v2.3: 修改密码入口
function handleChangePin() {
  if (!bleStore.connected || !bleStore.isAuthorized) {
    toast.info('请先连接设备')
    return
  }
  pinModal.mode = 'change'
  pinModal.title = '输入当前密码'
  pinModal.hint = '请输入设备当前密码以验证身份'
  pinModal.placeholder = '当前密码'
  pinModal.value = ''
  pinModal.showDefaultHint = bleStore.pinDefault
  pinModal.isNewPin = false
  pinModal.onConfirm = handlePinConfirm
  pinModal.visible = true
}

// ★ v2.3: 执行修改密码
async function doChangePin(oldPin, newPin) {
  uni.showLoading({ title: '修改中...', mask: true })
  try {
    const ok = await bleStore.changePin(oldPin, newPin)
    uni.hideLoading()
    if (ok) {
      toast.success('密码修改成功')
    } else {
      toast.error('密码修改失败，请重试')
    }
  } catch (err) {
    uni.hideLoading()
    toast.error(err.message || '修改失败')
  }
}

async function handleUnbind() {
  uni.showModal({
    title: '解除绑定',
    content: '解除后设备将恢复出厂状态，任何手机都可以连接绑定。确定继续？',
    success: async (res) => {
      if (res.confirm) {
        uni.showLoading({ title: '解除中...' })
        try {
          await bleStore.unbind()
          uni.hideLoading()
          toast.success('已解除绑定')
        } catch {
          uni.hideLoading()
          toast.error('解除失败')
        }
      }
    }
  })
}

// ★ v2.4: 显示分享密钥生成弹窗
function showShareGenDialog() {
  shareGenDialog.duration = 24
  shareGenDialog.visible = true
}

// ★ v2.4: 生成分享密钥
async function handleGenerateShareKey() {
  shareGenDialog.visible = false
  shareKeyGenerated.value = ''
  uni.showLoading({ title: '生成中...', mask: true })
  try {
    const key = await bleStore.generateShareKey(shareGenDialog.duration)
    uni.hideLoading()
    shareKeyGenerated.value = key
    toast.success('分享密钥已生成')
    // 3秒后自动隐藏明文显示（安全考虑）
    setTimeout(() => {
      if (shareKeyGenerated.value === key) {
        // 仍然保持生成状态，但明文只在连接存续期间保留
      }
    }, 30000)
  } catch (err) {
    uni.hideLoading()
    toast.error(err.message || '生成失败')
  }
}

// ★ v2.4: 复制分享密钥
function copyShareKey() {
  if (!shareKeyGenerated.value) return
  uni.setClipboardData({
    data: shareKeyGenerated.value,
    success: () => {
      toast.success('已复制到剪贴板')
    }
  })
}

// ★ v2.4: 撤销分享密钥
async function handleRevokeShareKey() {
  uni.showLoading({ title: '撤销中...', mask: true })
  try {
    await bleStore.revokeShareKey()
    uni.hideLoading()
    shareKeyGenerated.value = ''
    toast.success('分享密钥已撤销')
  } catch (err) {
    uni.hideLoading()
    toast.error(err.message || '撤销失败')
  }
}

// ★ v2.4: 通过分享密钥验证并接管设备（客人端）
async function handleAuthWithShareKey() {
  const key = shareKeyInput.value.trim()
  if (!key || key.length < 4) {
    toast.info('请输入完整的分享密钥')
    return
  }
  uni.showLoading({ title: '验证中...', mask: true })
  try {
    await bleStore.bindWithShareKey(key)
    uni.hideLoading()
    shareKeyInput.value = ''
    toast.success('接管成功！设备已绑定到当前手机')
  } catch (err) {
    uni.hideLoading()
    if (err.message && err.message.includes('无效')) {
      toast.error('密钥无效或已过期，请向主人重新获取')
    } else if (err.message && err.message.includes('超时')) {
      toast.error('绑定超时，请重试')
    } else {
      toast.error(err.message || '验证失败')
    }
  }
}

// ★ v2.4: 格式化剩余时间
function formatShareExpiry(seconds) {
  if (seconds <= 0) return '已过期'
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  if (h > 24) {
    const d = Math.floor(h / 24)
    return `${d} 天 ${h % 24} 小时`
  }
  if (h > 0) return `${h} 小时 ${m} 分钟`
  return `${m} 分钟`
}
</script>

<style scoped>
.page-index {
  padding: 30rpx;
  padding-bottom: 130rpx;  /* ★ 为自定义 tabBar 留空间 */
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

/* ★ v2.2: 绑定提示区域 */
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

.bind-hint-text {
  color: #ffaa00;
  font-size: 24rpx;
  text-align: center;
}

.bind-hint.paired .bind-hint-text {
  color: #00ff88;
}

/* ★ v2.3: 设备已绑定到其他手机 */
.bind-hint.takeover {
  background: #332211;
  border-color: #ff660044;
}

.bind-hint.takeover .bind-hint-text {
  color: #ff8800;
}

/* ★ v2.3: 配对模式激活，可接管设备 */
.bind-hint.takeover-active {
  background: #003322;
  border-color: #00ff8866;
}

.bind-hint.takeover-active .bind-hint-text {
  color: #00ff88;
}

.takeover-sub {
  color: #8899aa;
  font-size: 22rpx;
  text-align: center;
  line-height: 1.6;
}

.btn-bind {
  background: linear-gradient(135deg, #00d4ff 0%, #0088cc 100%);
  color: #fff;
  font-size: 26rpx;
  font-weight: 600;
  padding: 16rpx 48rpx;
  border-radius: 20rpx;
}

.btn-bind:active {
  opacity: 0.8;
}

.btn-unbind {
  background: transparent;
  color: #ffaa00;
  font-size: 24rpx;
  padding: 16rpx 48rpx;
  border: 1rpx solid #ffaa0044;
  border-radius: 20rpx;
  margin-left: 16rpx;
}

.disconnect-section {
  display: flex;
  justify-content: center;
  flex-wrap: wrap;
  gap: 16rpx;
}

/* ★ v2.3: PIN 输入弹窗 */
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

/* ★ v2.4: 主人分享密钥管理 */
.bind-hint.share-owner {
  background: #112244;
  border-color: #3366aa44;
}

.bind-hint.share-owner .bind-hint-text {
  color: #66aaff;
}

.share-owner-desc {
  color: #8899aa;
  font-size: 22rpx;
  text-align: center;
  line-height: 1.5;
}

.share-owner-actions {
  display: flex;
  gap: 16rpx;
  margin-top: 8rpx;
}

.btn-share-gen {
  background: linear-gradient(135deg, #6677ff 0%, #4466cc 100%);
  color: #fff;
  font-size: 26rpx;
  font-weight: 600;
  padding: 16rpx 48rpx;
  border-radius: 20rpx;
}

.btn-share-gen:active {
  opacity: 0.8;
}

.btn-share-revoke {
  background: transparent;
  color: #ff6666;
  font-size: 24rpx;
  padding: 12rpx 36rpx;
  border: 1rpx solid #ff666644;
  border-radius: 20rpx;
}

/* ★ v2.4: 生成的密钥展示 */
.share-key-display {
  width: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12rpx;
}

.share-key-row {
  display: flex;
  align-items: center;
  gap: 8rpx;
  background: #0a0a1e;
  border: 1rpx solid #334466;
  border-radius: 12rpx;
  padding: 16rpx 24rpx;
}

.share-key-label {
  color: #8899aa;
  font-size: 24rpx;
}

.share-key-value {
  color: #66ffaa;
  font-size: 28rpx;
  font-weight: 700;
  letter-spacing: 6rpx;
  font-family: 'Courier New', monospace;
}

.share-key-copy {
  color: #00d4ff;
  font-size: 22rpx;
  padding: 6rpx 16rpx;
  border: 1rpx solid #00d4ff44;
  border-radius: 8rpx;
  margin-left: 8rpx;
}

.share-key-expiry {
  color: #ffaa00;
  font-size: 22rpx;
}

/* ★ v2.4: 客人端分享密钥输入 */
.share-guest-section {
  width: 100%;
  margin-top: 16rpx;
  padding-top: 16rpx;
  border-top: 1rpx solid #ffffff11;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12rpx;
}

.share-or-line {
  color: #555577;
  font-size: 20rpx;
}

.share-guest-row {
  display: flex;
  width: 100%;
  gap: 12rpx;
}

.share-guest-input {
  flex: 1;
  height: 64rpx;
  background: #0a0a1e;
  border: 1rpx solid #334466;
  border-radius: 12rpx;
  font-size: 26rpx;
  color: #66ffaa;
  text-align: center;
  letter-spacing: 4rpx;
  padding: 0 16rpx;
  font-family: 'Courier New', monospace;
}

.btn-share-auth {
  background: linear-gradient(135deg, #6677ff 0%, #4466cc 100%);
  color: #fff;
  font-size: 24rpx;
  font-weight: 600;
  padding: 0 28rpx;
  height: 64rpx;
  border-radius: 12rpx;
  white-space: nowrap;
}

.btn-share-auth:active {
  opacity: 0.8;
}

/* ★ v2.4: 分享密钥生成弹窗 - 有效期选择 */
.share-duration-options {
  display: flex;
  flex-wrap: wrap;
  gap: 16rpx;
  justify-content: center;
  width: 100%;
}

.share-dur-item {
  padding: 14rpx 28rpx;
  background: #16213e;
  border: 1rpx solid #2a2a5e;
  border-radius: 12rpx;
  color: #8899aa;
  font-size: 24rpx;
}

.share-dur-item.active {
  background: #6677ff22;
  border-color: #6677ff;
  color: #66aaff;
}
</style>
