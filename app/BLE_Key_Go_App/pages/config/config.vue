<template>
  <view class="page-config" :class="themeClass">
    <!-- ★ v3.23: 智能重连模式选择（全局设置，无需连接） -->
    <view class="reconnect-mode-section">
      <view class="section-title">🔁 智能重连模式</view>
      <view class="mode-cards">
        <view class="mode-card"
          :class="{ active: bleStore.autoReconnectMode === 'comfort' }"
          @tap="handleModeChange('comfort')">
          <view class="mode-card-header">
            <text class="mode-icon">🌙</text>
            <text class="mode-name">舒适模式</text>
            <text class="mode-badge" v-if="bleStore.autoReconnectMode === 'comfort'">当前</text>
          </view>
          <text class="mode-desc">断连后自动轮询，靠近车辆即可自动连接</text>
          <text class="mode-power">额外功耗 ≈ 0.1%/天</text>
        </view>

        <view class="mode-card"
          :class="{ active: bleStore.autoReconnectMode === 'power_saver' }"
          @tap="handleModeChange('power_saver')">
          <view class="mode-card-header">
            <text class="mode-icon">🔋</text>
            <text class="mode-name">省电模式</text>
            <text class="mode-badge" v-if="bleStore.autoReconnectMode === 'power_saver'">当前</text>
          </view>
          <text class="mode-desc">仅打开 App 时扫描连接，零后台功耗</text>
          <text class="mode-power">额外功耗 = 0</text>
        </view>

        <view class="mode-card"
          :class="{ active: bleStore.autoReconnectMode === 'speed' }"
          @tap="handleModeChange('speed')">
          <view class="mode-card-header">
            <text class="mode-icon">⚡</text>
            <text class="mode-name">极速模式</text>
            <text class="mode-badge" v-if="bleStore.autoReconnectMode === 'speed'">当前</text>
          </view>
          <text class="mode-desc">基于地理围栏，走到车边自动连好</text>
          <text class="mode-power">后台 GPS 静默监听，额外耗电 ~0.5%/天</text>
        </view>
      </view>

      <!-- ★ v3.23 Phase 3: 极速模式围栏信息 -->
      <view class="geofence-info" v-if="bleStore.autoReconnectMode === 'speed' && parkingInfo">
        <view class="geofence-row">
          <text class="geofence-label">📍 停车位置</text>
          <text class="geofence-action" @tap="handleUpdateParking">更新</text>
        </view>
        <view class="geofence-row">
          <text class="geofence-val">{{ parkingInfo.latText }}, {{ parkingInfo.lngText }}</text>
        </view>
        <view class="geofence-row">
          <text class="geofence-meta">保存时间：{{ parkingInfo.timeText }}</text>
          <text class="geofence-meta">围栏半径：{{ geofenceRadius }}m</text>
        </view>
        <view class="geofence-row" v-if="monitorActive">
          <text class="geofence-status-dot">●</text>
          <text class="geofence-status-text">GPS 后台监控中</text>
        </view>
        <view class="geofence-row" v-else-if="!bleStore.connected">
          <text class="geofence-status-dot dim">●</text>
          <text class="geofence-status-text dim">GPS 监控待启动</text>
        </view>
      </view>
    </view>

    <view class="divider"></view>

    <!-- 连接状态提示 -->
    <view class="conn-warning" v-if="!bleStore.connected">
      <text>⚠️ 请先在「连接」页面连接设备</text>
    </view>

    <template v-else>
      <view class="section-title">RSSI 阈值设置（手机端保存，连接时自动下发）</view>

      <!-- 解锁阈值 -->
      <view class="config-item">
        <view class="config-header">
          <text class="config-label">🔓 解锁阈值</text>
          <text class="config-value">{{ localConfig.unlock }} dBm</text>
        </view>
        <view class="config-desc">RSSI 高于此值持续 {{ localConfig.uc }} 次 → 触发解锁</view>
        <slider class="config-slider" :min="-90" :max="-20" :step="1"
          :value="localConfig.unlock" @change="onUnlockChange"
          :activeColor="sliderActiveGreen" :backgroundColor="sliderTrackColor"
          block-size="24" />
        <view class="slider-labels">
          <text>-90</text>
          <text>-20</text>
        </view>
      </view>

      <!-- 锁车阈值 -->
      <view class="config-item">
        <view class="config-header">
          <text class="config-label">🔒 锁车阈值</text>
          <text class="config-value">{{ localConfig.lock }} dBm</text>
        </view>
        <view class="config-desc">RSSI 低于此值持续 {{ localConfig.lc }} 次 → 触发锁车</view>
        <slider class="config-slider" :min="-90" :max="-20" :step="1"
          :value="localConfig.lock" @change="onLockChange"
          :activeColor="sliderActiveOrange" :backgroundColor="sliderTrackColor"
          block-size="24" />
        <view class="slider-labels">
          <text>-90</text>
          <text>-20</text>
        </view>
      </view>

      <view class="divider"></view>
      <view class="section-title">确认次数设置（手机端保存）</view>

      <view class="config-item">
        <view class="config-header">
          <text class="config-label">解锁确认次数</text>
          <text class="config-value">{{ localConfig.uc }} 次</text>
        </view>
        <view class="config-desc">连续满足解锁条件的次数（越多越不容易误触发）</view>
        <view class="stepper">
          <button class="step-btn" @tap="onUcChange(-1)">-</button>
          <text class="step-value">{{ localConfig.uc }}</text>
          <button class="step-btn" @tap="onUcChange(1)">+</button>
        </view>
      </view>

      <view class="config-item">
        <view class="config-header">
          <text class="config-label">锁车确认次数</text>
          <text class="config-value">{{ localConfig.lc }} 次</text>
        </view>
        <view class="config-desc">连续满足锁车条件的次数（建议比解锁更多次）</view>
        <view class="stepper">
          <button class="step-btn" @tap="onLcChange(-1)">-</button>
          <text class="step-value">{{ localConfig.lc }}</text>
          <button class="step-btn" @tap="onLcChange(1)">+</button>
        </view>
      </view>

      <view class="divider"></view>
      <view class="section-title">其他设置（手机端保存）</view>

      <view class="config-item">
        <view class="config-header">
          <text class="config-label">📡 固件 RSSI 读取间隔</text>
          <text class="config-value">{{ localConfig.interval }} ms</text>
        </view>
        <view class="config-desc">KeyGo 设备通过 BLE GAP 读取 RSSI 的周期（越短反应越快，略增功耗）</view>
        <slider class="config-slider" :min="100" :max="2000" :step="100"
          :value="localConfig.interval" @change="onIntervalChange"
          :activeColor="sliderActiveGreen" :backgroundColor="sliderTrackColor"
          block-size="24" />
        <view class="slider-labels">
          <text>100ms</text>
          <text>2000ms</text>
        </view>
      </view>

      <view class="config-item">
        <view class="config-header">
          <text class="config-label">⚡ 响应速度</text>
          <text class="config-value">{{ krLabel(localConfig.kr) }}</text>
        </view>
        <view class="config-desc">卡尔曼滤波器响应灵敏度（越快速响应越快，但偶尔可能误触发）</view>
        <view class="kr-presets">
          <button
            v-for="preset in krPresets"
            :key="preset.value"
            class="kr-preset"
            :class="{ active: localConfig.kr === preset.value }"
            :style="krPresetStyle(preset.value)"
            @tap="localConfig.kr = preset.value">
            {{ preset.label }}
          </button>
        </view>
        <view class="kr-hint">{{ krDesc(localConfig.kr) }}</view>
      </view>

      <view class="config-item">
        <view class="config-header">
          <text class="config-label">断连自动锁车延时</text>
          <text class="config-value">{{ localConfig.dlock }} ms</text>
        </view>
        <view class="config-desc">蓝牙断开连接后，延迟多久自动锁车（0=不自动锁车）</view>
        <slider class="config-slider" :min="0" :max="30000" :step="1000"
          :value="localConfig.dlock" @change="onDlockChange"
          :activeColor="sliderActivePink" :backgroundColor="sliderTrackColor"
          block-size="24" />
        <view class="slider-labels">
          <text>0</text>
          <text>30s</text>
        </view>
      </view>

      <!-- 下发配置按钮 -->
      <view class="submit-section">
        <button class="btn-submit" @tap="handleSubmit" :disabled="!bleStore.connected">
          下发配置到设备
        </button>
        <text class="submit-hint">阈值/确认次数/间隔/断连续锁 → 保存到手机本地（每台 KeyGo 设备独立配置）</text>
      </view>
    </template>
  </view>
</template>

<script setup>
import { reactive, computed, watch } from 'vue'
import { onShow } from '@dcloudio/uni-app'
import { useBleStore } from '@/stores/ble.js'
import { useThemeStore } from '@/stores/theme.js'
import { toast } from '@/utils/toast.js'
// ★ v3.23 Phase 3: 地理围栏工具
import { getParkingLocation, GEOFENCE_RADIUS, isGeofenceMonitorActive } from '@/utils/geofence.js'

const bleStore = useBleStore()
const themeStore = useThemeStore()
const themeClass = computed(() => themeStore.themeClass)

// ★ localConfig 和 syncFromStore 必须在 onShow 之前声明
//    const 有暂时死区(TDZ)，在声明行之前访问会抛 ReferenceError
const localConfig = reactive({
  unlock: -45,
  lock: -65,
  uc: 2,
  lc: 3,
  interval: 500,
  dlock: 5000,
  kr: 15,   // ★ 与 CH582M / ESP32C3 默认 kf_r=15.0 一致
})

function syncFromStore() {
  localConfig.unlock = bleStore.unlockThreshold
  localConfig.lock = bleStore.lockThreshold
  localConfig.uc = bleStore.unlockCountRequired
  localConfig.lc = bleStore.lockCountRequired
  localConfig.interval = bleStore.rssiReadPeriodMs || 500
  localConfig.dlock = bleStore.disconnectLockDelayMs
  localConfig.kr = bleStore.kalmanR || 15
}

onShow(() => {
  themeStore.applyNavBar()
  // ★ BugFix: 传入 SN 才能读设备专属配置 ble_config_v1_{SN}
  //   不传 SN 只会读旧版全局 ble_config_v1，切后台再切回时找不到设备专属配置导致重置为默认值
  bleStore._restoreConfig(bleStore.serialNumber || undefined)
  syncFromStore()
})

// ★ v3.23: 智能重连模式切换
function handleModeChange(mode) {
  if (mode === bleStore.autoReconnectMode) return
  bleStore.setAutoReconnectMode(mode)
}

// ★ v3.23 Phase 3: 极速模式围栏信息
const geofenceRadius = GEOFENCE_RADIUS

/** 后台 GPS 围栏监控是否正在运行 */
const monitorActive = computed(() => {
  if (bleStore.autoReconnectMode !== 'speed') return false
  if (bleStore.connected) return false
  return isGeofenceMonitorActive()
})

const parkingInfo = computed(() => {
  const p = getParkingLocation()
  if (!p) return null
  const d = new Date(p.savedAt)
  return {
    latText: p.lat.toFixed(6),
    lngText: p.lng.toFixed(6),
    timeText: `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`,
    lat: p.lat,
    lng: p.lng,
    savedAt: p.savedAt,
  }
})

async function handleUpdateParking() {
  uni.showLoading({ title: '定位中...' })
  const ok = await bleStore.saveCurrentParkingLocation()
  uni.hideLoading()
}

// ★ slider 组件属性需要实际颜色值（不能传 CSS 变量）
const sliderTrackColor = computed(() => themeStore.isDark ? '#2a2a5e' : '#e0e4e8')
const sliderActiveGreen = computed(() => themeStore.isDark ? '#00ff88' : '#00aa55')
const sliderActiveOrange = computed(() => themeStore.isDark ? '#ff8800' : '#cc6600')
const sliderActivePink = computed(() => themeStore.isDark ? '#ff4488' : '#cc3366')

watch(() => bleStore.unlockThreshold, () => { localConfig.unlock = bleStore.unlockThreshold })
watch(() => bleStore.lockThreshold, () => { localConfig.lock = bleStore.lockThreshold })
watch(() => bleStore.unlockCountRequired, () => { localConfig.uc = bleStore.unlockCountRequired })
watch(() => bleStore.lockCountRequired, () => { localConfig.lc = bleStore.lockCountRequired })
watch(() => bleStore.rssiReadPeriodMs, () => { localConfig.interval = bleStore.rssiReadPeriodMs || 500 })
watch(() => bleStore.disconnectLockDelayMs, () => { localConfig.dlock = bleStore.disconnectLockDelayMs })
watch(() => bleStore.kalmanR, () => { localConfig.kr = bleStore.kalmanR || 15 })

function onUnlockChange(e) { localConfig.unlock = e.detail.value }
function onLockChange(e) { localConfig.lock = e.detail.value }
function onUcChange(delta) { localConfig.uc = Math.max(1, Math.min(20, localConfig.uc + delta)) }
function onLcChange(delta) { localConfig.lc = Math.max(1, Math.min(30, localConfig.lc + delta)) }
function onIntervalChange(e) { localConfig.interval = e.detail.value }
function onDlockChange(e) { localConfig.dlock = e.detail.value }

// ★ v3.13: 卡尔曼 R 值档位预设（等比分布，每档体感步进一致）
const krPresets = [
  { value: 2,  label: '🟢 极速' },
  { value: 5,  label: '🟡 快速' },
  { value: 15, label: '🔵 标准' },
  { value: 50, label: '⚪ 稳定' },
]

function krLabel(val) {
  const found = krPresets.find(p => p.value === val)
  return found ? found.label : `R=${val}`
}

function krDesc(val) {
  if (val <= 2) return 'R=2，测量值权重极重，响应极快，适合信号稳定的环境'
  if (val <= 5) return 'R=5，响应较快，日常使用推荐'
  if (val <= 15) return 'R=15，平衡速度与稳定，出厂默认'
  return 'R=50，极度平滑，几乎不会误触发，适合信号波动大的环境'
}

function krPresetStyle(val) {
  const isActive = localConfig.kr === val
  if (isActive) return { background: 'var(--accent)', color: '#fff', borderColor: 'var(--accent)' }
  return { background: 'var(--bg-card)', color: 'var(--text-tertiary)', borderColor: 'var(--border)' }
}

async function handleSubmit() {
  if (localConfig.unlock <= localConfig.lock) {
    toast.error('解锁阈值必须大于锁车阈值')
    return
  }
  uni.showLoading({ title: '下发配置中...' })
  try {
    await bleStore.updateConfig({
      unlock: localConfig.unlock,
      lock: localConfig.lock,
      uc: localConfig.uc,
      lc: localConfig.lc,
      interval: localConfig.interval,
      dlock: localConfig.dlock,
      kr: localConfig.kr,
    })
    uni.hideLoading()
    toast.success('配置已下发并保存')
  } catch (err) {
    uni.hideLoading()
    toast.error('下发失败，请检查连接')
  }
}
</script>

<style scoped>
.page-config {
  min-height: 100vh;
  background: var(--bg-page);
  color: var(--text-primary);
  padding: 30rpx 30rpx 30rpx;
  transition: background-color 0.3s, color 0.3s;
}

.conn-warning {
  background: var(--bg-warning);
  border: 1rpx solid var(--border-warning);
  border-radius: 16rpx;
  padding: 24rpx;
  text-align: center;
  color: var(--accent-orange);
  font-size: 26rpx;
}

.section-title {
  font-size: 28rpx;
  font-weight: 600;
  color: var(--text-primary);
  margin-bottom: 20rpx;
  margin-top: 10rpx;
}

.divider {
  height: 1rpx;
  background: var(--border);
  margin: 30rpx 0;
}

.config-item {
  background: var(--bg-card);
  border-radius: 16rpx;
  padding: 24rpx;
  margin-bottom: 20rpx;
}

.config-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 8rpx;
}

.config-label {
  font-size: 26rpx;
  color: var(--config-label);
}

.config-value {
  font-size: 26rpx;
  font-weight: 600;
  color: var(--accent);
}

.config-desc {
  font-size: 22rpx;
  color: var(--text-muted);
  margin-bottom: 16rpx;
}

.config-slider { margin: 0; }

.slider-labels {
  display: flex;
  justify-content: space-between;
  font-size: 18rpx;
  color: var(--text-muted);
  margin-top: -8rpx;
}

/* ===== 步进器 ===== */
.stepper {
  display: flex;
  align-items: center;
  justify-content: center;
  margin-top: 16rpx;
}

.step-btn {
  width: 64rpx;
  height: 64rpx;
  background: var(--border);
  color: var(--accent);
  font-size: 32rpx;
  border-radius: 12rpx;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  line-height: 64rpx;
}

.step-value {
  font-size: 36rpx;
  font-weight: 700;
  color: var(--text-primary);
  margin: 0 40rpx;
  min-width: 60rpx;
  text-align: center;
}

/* ===== 提交按钮 ===== */
.submit-section {
  margin-top: 40rpx;
  display: flex;
  flex-direction: column;
  align-items: center;
}

.btn-submit {
  width: 100%;
  background: var(--gradient-accent);
  color: #fff;
  font-size: 30rpx;
  font-weight: 600;
  padding: 28rpx 0;
  border-radius: 16rpx;
}

.btn-submit:active { opacity: 0.8; }
.btn-submit[disabled] { opacity: 0.3; }

/* ===== 卡尔曼 R 档位 ===== */
.kr-presets {
  display: flex;
  gap: 16rpx;
  margin-bottom: 8rpx;
}

.kr-preset {
  flex: 1;
  height: 64rpx;
  border-radius: 14rpx;
  font-size: 24rpx;
  font-weight: 600;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 2rpx solid;
  padding: 0;
  transition: all 0.2s;
}

.kr-preset:active { opacity: 0.75; }

.kr-hint {
  font-size: 20rpx;
  color: var(--text-muted);
  margin-top: 8rpx;
}

.submit-hint {
  font-size: 22rpx;
  color: var(--text-muted);
  margin-top: 12rpx;
}

/* ===== ★ v3.23: 智能重连模式选择 ===== */
.reconnect-mode-section {
  background: transparent;
  margin-bottom: 10rpx;
}

.mode-cards {
  display: flex;
  flex-direction: column;
  gap: 16rpx;
}

.mode-card {
  background: var(--bg-card);
  border-radius: 16rpx;
  padding: 24rpx;
  border: 2rpx solid var(--border);
  transition: all 0.25s ease;
}

.mode-card:active {
  opacity: 0.7;
  transform: scale(0.98);
}

.mode-card.active {
  border-color: var(--accent);
  background: var(--alpha-05);
}

.mode-card-disabled {
  opacity: 0.5;
}

.mode-card-header {
  display: flex;
  align-items: center;
  gap: 12rpx;
  margin-bottom: 8rpx;
}

.mode-icon {
  font-size: 36rpx;
}

.mode-name {
  font-size: 28rpx;
  font-weight: 600;
  color: var(--text-primary);
  flex: 1;
}

.mode-badge {
  background: var(--accent);
  color: #fff;
  font-size: 20rpx;
  padding: 4rpx 16rpx;
  border-radius: 20rpx;
  font-weight: 500;
}

.mode-soon {
  background: var(--border);
  color: var(--text-muted);
  font-size: 20rpx;
  padding: 4rpx 16rpx;
  border-radius: 20rpx;
}

.mode-desc {
  display: block;
  font-size: 24rpx;
  color: var(--text-secondary);
  margin-bottom: 6rpx;
  line-height: 1.5;
}

.mode-power {
  display: block;
  font-size: 20rpx;
  color: var(--text-muted);
}

/* ★ v3.23 Phase 3: 极速模式围栏信息面板 */
.geofence-info {
  margin-top: 16rpx;
  background: var(--alpha-06);
  border: 1rpx solid var(--border);
  border-radius: 12rpx;
  padding: 20rpx 24rpx;
}

.geofence-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 6rpx;
}

.geofence-row:last-child {
  margin-bottom: 0;
}

.geofence-label {
  font-size: 24rpx;
  font-weight: 600;
  color: var(--text-primary);
}

.geofence-val {
  font-size: 22rpx;
  color: var(--text-secondary);
  font-family: monospace;
}

.geofence-action {
  font-size: 22rpx;
  color: var(--accent);
  padding: 4rpx 16rpx;
  border: 1rpx solid var(--accent);
  border-radius: 8rpx;
}

.geofence-meta {
  font-size: 20rpx;
  color: var(--text-muted);
}

/* ★ v3.23.1: GPS 监控状态指示 */
.geofence-status-dot {
  font-size: 20rpx;
  color: #22c55e;        /* 绿色：运行中 */
  margin-right: 8rpx;
}

.geofence-status-dot.dim {
  color: var(--text-muted); /* 灰色：待启动 */
}

.geofence-status-text {
  font-size: 20rpx;
  color: var(--text-secondary);
}

.geofence-status-text.dim {
  color: var(--text-muted);
}
</style>
