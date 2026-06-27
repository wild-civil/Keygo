<template>
  <view class="page-control">
    <!-- 连接状态提示 -->
    <view class="conn-warning" v-if="!bleStore.connected">
      <text>⚠️ 请先在「连接」页面连接设备</text>
    </view>
    <view class="conn-warning" v-else-if="!bleStore.isAuthorized">
      <text v-if="bleStore.connNeeded && !bleStore.connVerified">🔑 请先输入连接密码</text>
      <text v-else-if="bleStore.connVerified && bleStore.bindNeeded">🔒 请先输入绑定密码</text>
      <text v-else-if="bleStore.connLocked">🚫 连接密码已锁定</text>
      <text v-else>🔒 设备未授权，请先在「连接」页面完成验证</text>
      <button class="btn-go-link" @tap="goToIndex">前往验证</button>
    </view>

    <template v-else>
      <!-- 车辆状态大卡 -->
      <view class="car-card" :class="{ unlocked: bleStore.isUnlocked }">
        <view class="car-icon">🚗</view>
        <view class="car-status">
          <text class="car-state-text">{{ bleStore.stateText }}</text>
          <text class="car-rssi">信号: {{ bleStore.filteredRssi > -999 ? bleStore.filteredRssi + ' dBm' : '---' }}</text>
          <text class="car-cooldown" v-if="bleStore.manualCooldown">⏳ RSSI 状态机冷却中...</text>
        </view>
      </view>

      <!-- RSSI 实时信息 -->
      <view class="info-grid">
        <view class="info-item">
          <text class="info-label">原始 RSSI</text>
          <text class="info-value">{{ bleStore.rssi > -999 ? bleStore.rssi : '---' }} dBm</text>
        </view>
        <view class="info-item">
          <text class="info-label">滤波 RSSI</text>
          <text class="info-value">{{ bleStore.filteredRssi > -999 ? bleStore.filteredRssi : '---' }} dBm</text>
        </view>
        <view class="info-item">
          <text class="info-label">解锁阈值</text>
          <text class="info-value">{{ bleStore.unlockThreshold }} dBm</text>
        </view>
        <view class="info-item">
          <text class="info-label">锁车阈值</text>
          <text class="info-value">{{ bleStore.lockThreshold }} dBm</text>
        </view>
      </view>

      <!-- 主要控制按钮 -->
      <view class="main-actions">
        <button class="ctrl-btn unlock" @tap="handleUnlock">
          <view class="ctrl-btn-icon">🔓</view>
          <text class="ctrl-btn-text">解锁</text>
          <text class="ctrl-btn-hint">按原车解锁键</text>
        </button>
        <button class="ctrl-btn lock" @tap="handleLock">
          <view class="ctrl-btn-icon">🔒</view>
          <text class="ctrl-btn-text">锁车</text>
          <text class="ctrl-btn-hint">按原车锁车键</text>
        </button>
      </view>

      <view class="secondary-actions">
        <button class="sec-btn" @tap="handleTrunk">
          <text class="sec-icon">🚗</text>
          <text class="sec-text">后备箱</text>
        </button>
        <button class="sec-btn" @tap="handleStatus">
          <text class="sec-icon">🔄</text>
          <text class="sec-text">刷新状态</text>
        </button>
      </view>

      <!-- 手动 RSSI 模拟（用于无原生 RSSI 的 ESP32） -->
      <view class="rssi-sim-section">
        <view class="rssi-sim-title">📶 手动 RSSI 模拟</view>
        <view class="rssi-sim-hint">ESP32 无原生 RSSI 时，手动注入信号值测试逻辑</view>
        <view class="rssi-presets">
          <button class="rssi-preset near" @tap="setRSSI(-30)">-30 极近</button>
          <button class="rssi-preset close" @tap="setRSSI(-40)">-40 很近</button>
          <button class="rssi-preset mid" @tap="setRSSI(-55)">-55 中等</button>
          <button class="rssi-preset far" @tap="setRSSI(-75)">-75 远</button>
        </view>
      </view>
    </template>
  </view>
</template>

<script setup>
import { useBleStore } from '@/stores/ble.js'
import { toast } from '@/utils/toast.js'
import { sendConfig } from '@/utils/ble.js'

const bleStore = useBleStore()

function goToIndex() {
  uni.switchTab({ url: '/pages/index/index' })
}

async function handleUnlock() {
  try {
    await bleStore.unlock()
    toast.success('解锁成功')
  } catch {
    toast.error('发送失败，请检查连接')
  }
}

async function handleLock() {
  try {
    await bleStore.lock()
    toast.success('锁车成功')
  } catch {
    toast.error('发送失败，请检查连接')
  }
}

async function handleTrunk() {
  try {
    await bleStore.trunk()
    toast.success('后备箱已触发')
  } catch {
    toast.error('发送失败')
  }
}

async function handleStatus() {
  try {
    await bleStore.sendCommand('STATUS')
    toast.info('状态已刷新')
  } catch {
    toast.error('刷新失败')
  }
}

async function setRSSI(value) {
  try {
    // 通过 FF01 写入 rssi=xxx 来注入模拟 RSSI
    await sendConfig(bleStore.deviceId, { rssi: value })
    toast.info(`RSSI 已设为 ${value}`)
  } catch {
    toast.error('RSSI 设置失败')
  }
}
</script>

<style scoped>
.page-control {
  padding: 30rpx;
  padding-bottom: 130rpx;  /* ★ 为自定义 tabBar 留空间 */
}

.conn-warning {
  background: #332200;
  border: 1rpx solid #664400;
  border-radius: 16rpx;
  padding: 24rpx;
  text-align: center;
  color: #ffaa00;
  font-size: 26rpx;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 16rpx;
  margin-bottom: 24rpx;
}

.btn-go-link {
  width: 240rpx;
  height: 60rpx;
  border-radius: 12rpx;
  background: linear-gradient(135deg, #00d4ff 0%, #0088cc 100%);
  color: #fff;
  font-size: 24rpx;
  font-weight: 600;
  display: flex;
  align-items: center;
  justify-content: center;
}

/* 车辆状态卡片 */
.car-card {
  background: linear-gradient(135deg, #1a1a3e 0%, #16213e 100%);
  border-radius: 24rpx;
  padding: 50rpx;
  text-align: center;
  margin-bottom: 30rpx;
  border: 2rpx solid #2a2a5e;
  transition: all 0.3s;
}

.car-card.unlocked {
  background: linear-gradient(135deg, #0a2818 0%, #0d3721 100%);
  border-color: #00ff8833;
}

.car-icon {
  font-size: 80rpx;
  margin-bottom: 16rpx;
}

.car-state-text {
  font-size: 36rpx;
  font-weight: 700;
  color: #fff;
  display: block;
}

.car-rssi {
  font-size: 24rpx;
  color: #8899aa;
  margin-top: 8rpx;
  display: block;
}

.car-cooldown {
  font-size: 22rpx;
  color: #ffaa00;
  margin-top: 6rpx;
  display: block;
}

/* 信息网格 */
.info-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16rpx;
  margin-bottom: 30rpx;
}

.info-item {
  background: #1a1a3e;
  border-radius: 16rpx;
  padding: 24rpx;
}

.info-label {
  font-size: 22rpx;
  color: #556677;
  display: block;
  margin-bottom: 8rpx;
}

.info-value {
  font-size: 28rpx;
  font-weight: 600;
  color: #00d4ff;
}

/* 主要控制按钮 */
.main-actions {
  display: flex;
  gap: 20rpx;
  margin-bottom: 20rpx;
}

.ctrl-btn {
  flex: 1;
  border-radius: 24rpx;
  padding: 40rpx 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  border: 2rpx solid;
}

.ctrl-btn:active {
  transform: scale(0.96);
}

.ctrl-btn.unlock {
  background: linear-gradient(135deg, #0d2818 0%, #0a1a10 100%);
  border-color: #00ff8844;
}

.ctrl-btn.lock {
  background: linear-gradient(135deg, #281a1a 0%, #1a0a0a 100%);
  border-color: #ff444444;
}

.ctrl-btn-icon {
  font-size: 56rpx;
  margin-bottom: 12rpx;
}

.ctrl-btn-text {
  font-size: 30rpx;
  font-weight: 600;
  color: #fff;
}

.ctrl-btn-hint {
  font-size: 20rpx;
  color: #556677;
  margin-top: 6rpx;
}

/* 次要操作 */
.secondary-actions {
  display: flex;
  gap: 20rpx;
}

.sec-btn {
  flex: 1;
  background: #1a1a3e;
  border-radius: 16rpx;
  padding: 24rpx 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  border: 1rpx solid #2a2a5e;
}

.sec-btn:active {
  opacity: 0.7;
}

.sec-icon {
  font-size: 36rpx;
  margin-bottom: 6rpx;
}

.sec-text {
  font-size: 24rpx;
  color: #8899aa;
}
</style>
