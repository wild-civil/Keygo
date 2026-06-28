<template>
  <view class="page-config" :class="themeClass">
    <!-- 连接状态提示 -->
    <view class="conn-warning" v-if="!bleStore.connected">
      <text>⚠️ 请先在「连接」页面连接设备</text>
    </view>

    <template v-else>
      <view class="section-title">RSSI 阈值设置</view>

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
      <view class="section-title">确认次数设置</view>

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
      <view class="section-title">其他设置</view>

      <view class="config-item">
        <view class="config-header">
          <text class="config-label">RSSI 采样间隔</text>
          <text class="config-value">{{ localConfig.interval }} ms</text>
        </view>
        <view class="config-desc">设备端 RSSI 采样频率</view>
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
        <text class="submit-hint">配置将保存到 ESP32 的 NVS 中，断电不丢失</text>
      </view>
    </template>
  </view>
</template>

<script setup>
import { reactive, computed, watch, onMounted } from 'vue'
import { useBleStore } from '@/stores/ble.js'
import { useThemeStore } from '@/stores/theme.js'
import { toast } from '@/utils/toast.js'

const bleStore = useBleStore()
const themeStore = useThemeStore()
const themeClass = computed(() => themeStore.themeClass)

// ★ slider 组件属性需要实际颜色值（不能传 CSS 变量）
const sliderTrackColor = computed(() => themeStore.isDark ? '#2a2a5e' : '#e0e4e8')
const sliderActiveGreen = computed(() => themeStore.isDark ? '#00ff88' : '#00aa55')
const sliderActiveOrange = computed(() => themeStore.isDark ? '#ff8800' : '#cc6600')
const sliderActivePink = computed(() => themeStore.isDark ? '#ff4488' : '#cc3366')

const localConfig = reactive({
  unlock: -45,
  lock: -65,
  uc: 5,
  lc: 10,
  interval: 500,
  dlock: 5000,
})

function syncFromStore() {
  localConfig.unlock = bleStore.unlockThreshold
  localConfig.lock = bleStore.lockThreshold
  localConfig.uc = bleStore.unlockCountRequired
  localConfig.lc = bleStore.lockCountRequired
  localConfig.interval = 500
  localConfig.dlock = bleStore.disconnectLockDelayMs
}

onMounted(() => { syncFromStore() })

watch(() => bleStore.unlockThreshold, () => { localConfig.unlock = bleStore.unlockThreshold })
watch(() => bleStore.lockThreshold, () => { localConfig.lock = bleStore.lockThreshold })
watch(() => bleStore.unlockCountRequired, () => { localConfig.uc = bleStore.unlockCountRequired })
watch(() => bleStore.lockCountRequired, () => { localConfig.lc = bleStore.lockCountRequired })

function onUnlockChange(e) { localConfig.unlock = e.detail.value }
function onLockChange(e) { localConfig.lock = e.detail.value }
function onUcChange(delta) { localConfig.uc = Math.max(1, Math.min(20, localConfig.uc + delta)) }
function onLcChange(delta) { localConfig.lc = Math.max(1, Math.min(30, localConfig.lc + delta)) }
function onIntervalChange(e) { localConfig.interval = e.detail.value }
function onDlockChange(e) { localConfig.dlock = e.detail.value }

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

.submit-hint {
  font-size: 22rpx;
  color: var(--text-muted);
  margin-top: 12rpx;
}
</style>
