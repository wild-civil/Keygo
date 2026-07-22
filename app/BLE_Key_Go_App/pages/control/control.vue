<template>
  <view class="page-control" :class="themeClass">
    <!-- ★ 连接状态提示 -->
    <view class="conn-warning" v-if="!bleStore.connected">
      <text v-if="bleStore.reconnectMode === 'active' || bleStore.reconnectMode === 'paused'">🔄 设备离线，正在自动重连中...</text>
      <text v-else>⚠️ 设备未连接</text>
      <!-- ★ 2026-07-22: 手动断开后"重新连接"按钮（已知设备记忆驱动，OS 占用也能接管 ACL） -->
      <view class="reconnect-block" v-if="bleStore.knownDeviceId">
        <view class="reconnect-info">
          <text class="reconnect-label">已知设备</text>
          <text class="reconnect-name">{{ bleStore.knownDeviceName }}</text>
          <text class="reconnect-mac">{{ bleStore.knownDeviceId }}</text>
          <text v-if="bleStore.customNameForMac(bleStore.knownDeviceId)" class="device-alias-tag">已命名</text>
        </view>
        <button class="reconnect-btn" @tap="handleReconnect">重新连接</button>
      </view>
    </view>

    <template v-else>
      <!-- ★ v3.36.3-fix5: 连接态设备名条(显示 customDeviceName) + 已命名徽章 -->
      <view class="device-tag" v-if="bleStore.deviceId">
        <view class="device-tag-text">
          <text class="device-tag-name">{{ bleStore.connectedDisplayName }}</text>
          <text class="device-tag-mac">{{ bleStore.deviceId }}</text>
        </view>
        <text v-if="bleStore.customDeviceName" class="device-alias-tag">已命名</text>
      </view>
      <!-- ★ v3.15-#21: Status Notify 过期警告 — 设备连接中但推送超时（静默断连） -->
      <view class="stale-warning" v-if="bleStore.statusStale">
        <text>⚠️ 设备状态已过期，连接可能已中断</text>
      </view>

      <!-- ★ 车辆状态大卡 -->
      <view class="car-card" :class="{ unlocked: bleStore.isUnlocked }">
        <view class="car-icon">{{ carIcon }}</view>
        <view class="car-status">
          <text class="car-state-text">{{ bleStore.stateText }}</text>
          <text class="car-rssi">信号: {{ bleStore.filteredRssi > -999 ? bleStore.filteredRssi + ' dBm' : '---' }}</text>
          <!-- ▼ ★ v3.15: 电池电量 — 默认 emoji 图标
               如需切换为 CSS 电池组件，注释下面 18 行，取消注释 19~24 行 -->
          <view class="car-battery" :class="bleStore.batteryColor" v-if="bleStore.batteryLevel >= 0">
            <text class="batt-icon">{{ bleStore.batteryIcon }}</text>
            <text class="batt-text">{{ bleStore.batteryText }}</text>
          </view>
		  <!-- ▲ v3.15-css emoji 图标─────────────────────────────────── -->
          <!-- ▼ v3.15-css: CSS 电池组件（备用方案） ────────────────── -->
          <!-- <view class="car-battery" :class="bleStore.batteryColor" v-if="bleStore.batteryLevel >= 0">
            <view class="batt-shell">
              <view class="batt-fill" :style="{ width: bleStore.batteryLevel + '%' }"></view>
            </view>
            <view class="batt-cap"></view>
            <text class="batt-text">{{ bleStore.batteryText }}</text>
          </view> -->
          <!-- ▲ v3.15-css CSS 电池图标────────────────────────────────────────────── -->
          <text class="car-cooldown" v-if="bleStore.manualCooldown">⏳ RSSI 状态机冷却中...</text>
        </view>
      </view>



      <!-- ★ RSSI 实时信息 -->
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

      <!-- ★ 主要控制按钮 -->
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
        <button class="sec-btn" @tap="handleThird">
          <text class="sec-icon">{{ thirdBtn.icon }}</text>
          <text class="sec-text">{{ thirdBtn.text }}</text>
        </button>
        <button class="sec-btn" @tap="handleStatus">
          <text class="sec-icon">🔄</text>
          <text class="sec-text">刷新状态</text>
        </button>
      </view>

      <!-- ★ 手动 RSSI 模拟 -->
      <view class="rssi-sim-section">
        <view class="rssi-sim-title">📶 手动 RSSI 模拟</view>
        <view class="rssi-sim-hint">KeyGo 设备无原生 RSSI 时，手动注入信号值测试逻辑</view>
        <view class="rssi-presets">
          <button class="rssi-preset near" @tap="setRSSI(-30)">-30 极近</button>
          <button class="rssi-preset close" @tap="setRSSI(-40)">-40 很近</button>
          <button class="rssi-preset mid" @tap="setRSSI(-55)">-55 中等</button>
          <button class="rssi-preset far" @tap="setRSSI(-75)">-75 远</button>
        </view>
      </view>

      <!-- ★ v3.12: RSSI 冷却时间（设备级配置，写入 DataFlash，所有手机共用） -->
      <view class="rssi-sim-section">
        <view class="rssi-sim-title">⏱ RSSI 状态机冷却时长（设备级）</view>
        <view class="rssi-sim-hint">手动解锁/锁车后状态机暂停时间（当前：{{ bleStore.manualCooldownMs / 1000 }}s）</view>
        <view class="rssi-sim-sub-hint">⚠ 设备级配置：修改后写入设备 Flash，所有连接此设备的手机共用此值</view>
        <view class="rssi-presets">
          <button
            v-for="slot in cooldownSlots"
            :key="slot.ms"
            class="rssi-preset"
            :class="{ active: bleStore.manualCooldownMs === slot.ms }"
            :style="{ background: bleStore.manualCooldownMs === slot.ms ? 'var(--accent)' : 'var(--bg-card)', color: bleStore.manualCooldownMs === slot.ms ? '#fff' : 'var(--text-tertiary)', borderColor: bleStore.manualCooldownMs === slot.ms ? 'var(--accent)' : 'var(--border)' }"
            @tap="handleCooldownChange(slot.ms)">
            {{ slot.label }}
          </button>
        </view>
      </view>

      <!-- ★ Phase 2: 设备模式（汽车/电瓶车）— 控制模式切换，置于控制页底部 -->
      <view class="mode-section">
        <view class="section-title">🚗/🛵 设备模式（汽车 / 电瓶车）</view>
        <view class="mode-cards">
          <view class="mode-card"
            :class="{ active: bleStore.deviceMode === 'car' }"
            @tap="handleDeviceModeChange('car')">
            <view class="mode-card-header">
              <text class="mode-icon">🚗</text>
              <text class="mode-name">汽车</text>
              <text class="mode-badge" v-if="bleStore.deviceMode === 'car'">当前</text>
            </view>
            <text class="mode-desc">解锁 / 锁车 / 后备箱</text>
          </view>
          <view class="mode-card"
            :class="{ active: bleStore.deviceMode === 'ebike' }"
            @tap="handleDeviceModeChange('ebike')">
            <view class="mode-card-header">
              <text class="mode-icon">🛵</text>
              <text class="mode-name">电瓶车</text>
              <text class="mode-badge" v-if="bleStore.deviceMode === 'ebike'">当前</text>
            </view>
            <text class="mode-desc">解锁 / 锁车 / 骑行（双击）</text>
          </view>
        </view>
        <view class="config-desc" style="margin-top:10rpx;">模式存于设备，切换后重启仍保持；首次使用建议在「帮助」页了解二者差异。</view>
      </view>

      <!-- ★ 2026-07-19 / v3.36.2: 电瓶车「靠近直接进入骑行模式」偏好（仅电瓶车模式可见）。
           固件 RSSI 状态机驱动「靠近自动解锁」；开启后靠近即通电骑行(而非仅解锁)。
           偏好存固件 DataFlash(经 EPRX 命令下发)，无App模式(手机 App 不在场)也生效。详见设计文档。
           v3.36.2 起下方「仅解锁 / 直接骑行」双选项由纵向改为横向并排（更贴合电瓶车双档直觉）。 -->
      <view class="prox-ride-section" v-if="bleStore.deviceMode === 'ebike'" style="margin-top:30rpx;">
        <view class="section-title">🛵 靠近进入模式（电瓶车专属）</view>
        <view class="config-desc">靠近解锁由设备按信号强度自动触发。选择靠近时设备的行为：</view>
        <!-- ★ v3.36.2: 横向排布容器（mode-cards--row）；设备模式切换卡保持纵向不受影响 -->
        <view class="mode-cards mode-cards--row">
          <view class="mode-card"
            :class="{ active: proxRideVisual === 0 }"
            @tap="onToggleProxRide(0)">
            <view class="mode-card-header">
              <text class="mode-icon">🔓</text>
              <text class="mode-name">仅解锁</text>
            </view>
            <text class="mode-desc">靠近只解锁，骑行需手动</text>
          </view>
          <view class="mode-card"
            :class="{ active: proxRideVisual === 1 }"
            @tap="onToggleProxRide(1)">
            <view class="mode-card-header">
              <text class="mode-icon">⚡</text>
              <text class="mode-name">直接骑行</text>
            </view>
            <text class="mode-desc">靠近即通电骑行</text>
          </view>
        </view>
        <view class="config-desc" style="color:var(--accent-orange);margin-top:10rpx;" v-if="!bleStore.connected">⚠️ 需先连接设备才能切换（设置由设备实时回灌）。</view>
      </view>
    </template>
  </view>
</template>

<script setup>
import { computed, ref, watch } from 'vue'
import { onShow } from '@dcloudio/uni-app'
import { useBleStore } from '@/stores/ble.js'
import { useThemeStore } from '@/stores/theme.js'
import { toast } from '@/utils/toast.js'
import { cmdErrorMsg } from '@/utils/readable-errors.js'

const bleStore = useBleStore()
const themeStore = useThemeStore()
const themeClass = computed(() => themeStore.themeClass)

onShow(() => {
  themeStore.applyNavBar()
})

async function handleUnlock() {
  try {
    await bleStore.unlock()
    toast.success('解锁成功')
  } catch (err) {
    toast.error(cmdErrorMsg(err))
  }
}

async function handleLock() {
  try {
    await bleStore.lock()
    toast.success('锁车成功')
  } catch (err) {
    toast.error(cmdErrorMsg(err))
  }
}

async function handleTrunk() {
  try {
    await bleStore.trunk()
    toast.success('后备箱已触发')
  } catch (err) {
    toast.error(cmdErrorMsg(err))
  }
}

async function handleRide() {
  try {
    await bleStore.ride()
    toast.success('骑行已触发')
  } catch (err) {
    toast.error(cmdErrorMsg(err))
  }
}

// ★ Phase 2: 第三键按设备模式切换（car=后备箱 / ebike=骑行）
const thirdBtn = computed(() => {
  if (bleStore.deviceMode === 'ebike') {
    return { icon: '🛵', text: '骑行', handler: handleRide }
  }
  return { icon: '🚗', text: '后备箱', handler: handleTrunk }
})

function handleThird() {
  thirdBtn.value.handler()
}

// ★ Phase 2: 顶部大卡图标随模式切换
const carIcon = computed(() => bleStore.deviceMode === 'ebike' ? '🛵' : '🚗')

async function handleStatus() {
  try {
    await bleStore.sendCommand('STATUS')
    toast.info('状态已刷新')
  } catch {
    toast.error('刷新失败')
  }
}

// ★ 2026-07-22: 手动断开后一键重新连接（OS 已占用同 ACL 时也能接管，connect 不受 dormant 门控）
async function handleReconnect() {
  const id = bleStore.knownDeviceId
  if (!id) return
  uni.showLoading({ title: '连接中...', mask: true })
  try {
    await bleStore.connect(id, bleStore.deviceName || 'KeyGo')
    uni.hideLoading()
    toast.success('连接成功')
  } catch (e) {
    uni.hideLoading()
    toast.error('连接失败，请重试')
  }
}

async function setRSSI(value) {
  try {
    await bleStore.updateConfig({ rssi: value })
    toast.info(`RSSI 已设为 ${value}`)
  } catch {
    toast.error('RSSI 设置失败')
  }
}

// ★ v3.7: 冷却时间预设
const cooldownSlots = [
  { ms: 3000, label: '3s 快速' },
  { ms: 5000, label: '5s 标准' },
  { ms: 8000, label: '8s 默认' },
  { ms: 15000, label: '15s 长冷却' },
]

async function handleCooldownChange(value) {
  try {
    await bleStore.updateConfig({ cooldown_ms: value })
    toast.info(`冷却时间已设为 ${value / 1000}s`)
  } catch {
    toast.error('设置失败')
  }
}

// ★ Phase 2: 设备模式切换（汽车/电瓶车）— 从配置页迁移至控制页底部
async function handleDeviceModeChange(mode) {
  if (mode === bleStore.deviceMode) return
  uni.showLoading({ title: '切换中...' })
  try {
    await bleStore.setDeviceMode(mode)
    uni.hideLoading()
    toast.success('已切换为' + (mode === 'ebike' ? '电瓶车' : '汽车') + '，设备响应后生效')
  } catch (err) {
    uni.hideLoading()
    toast.error(cmdErrorMsg(err))
  }
}

// ★ 2026-07-19: 电瓶车「靠近直接进入骑行模式」偏好（固件 g_ebikeProxMode 镜像）。
//   仅电瓶车模式可见/有意义；car 模式 UI 隐藏且下发会被固件 DENY 兜底。详见设计文档。
const proxRideVisual = ref(bleStore.ebikeProxMode)
watch(() => bleStore.ebikeProxMode, (v) => { proxRideVisual.value = v })
async function onToggleProxRide(v) {
  if (v === proxRideVisual.value) return
  proxRideVisual.value = v   // 视觉立即翻转
  bleStore.setEbikeProxMode(v === 1)
}
</script>

<style scoped>
.page-control {
  min-height: 100vh;
  background: var(--bg-page);
  color: var(--text-primary);
  padding: 30rpx 30rpx 30rpx;
  transition: background-color 0.3s, color 0.3s;
}

/* ===== 连接警告 ===== */
.conn-warning {
  background: var(--bg-warning);
  border: 1rpx solid var(--border-warning);
  border-radius: 16rpx;
  padding: 24rpx;
  text-align: center;
  color: var(--accent-orange);
  font-size: 26rpx;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 16rpx;
  margin-bottom: 24rpx;
}

/* ★ 2026-07-22: 手动断开后"重新连接"块 — 置于连接警告框内，信息左/按钮右，与连接页等宽对齐 */
.reconnect-block {
  margin-top: 8rpx;
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
}
.reconnect-info { display: flex; flex-direction: column; align-items: flex-start; min-width: 0; flex: 1 1 auto; } /* ★ flex:1 占满剩余空间 → 强制把按钮顶到最右 */
.reconnect-label { font-size: 22rpx; color: var(--text-tertiary); margin-bottom: 4rpx; }
.reconnect-name { font-size: 28rpx; color: var(--text-primary); font-weight: 600; }
.reconnect-mac { font-size: 22rpx; color: var(--text-muted); margin-top: 2rpx; }
.reconnect-btn {
  flex: 0 0 auto;              /* ★ 不伸缩、按内容宽度，配合左侧 flex:1 稳定靠右 */
  margin-left: 20rpx;
  width: auto;
  background: var(--alpha-12); /* 与"扫描设备"(.btn-scan)完全一致：透明强调色底 */
  color: var(--accent);
  border: 1rpx solid var(--alpha-27);
  border-radius: 20rpx;
  padding: 12rpx 24rpx;       /* 与 .btn-scan 完全一致：不写 line-height，沿用默认行高，避免按钮被撑高 */
  font-size: 24rpx;
}
.reconnect-btn:active { opacity: 0.7; }

/* ★ v3.36.3-fix5: 「已命名」徽章（设备已设自定义名），重连卡/连接态设备名条通用 */
.device-alias-tag {
  align-self: flex-start;
  margin-top: 4rpx;
  font-size: 18rpx;
  color: var(--accent);
  background: var(--alpha-12);
  border-radius: 8rpx;
  padding: 2rpx 10rpx;
}
.device-tag {
  display: flex;
  align-items: center;
  justify-content: space-between;
  background: var(--bg-card);
  border-radius: 16rpx;
  padding: 20rpx 24rpx;
  margin-bottom: 20rpx;
}
.device-tag-text { display: flex; flex-direction: column; min-width: 0; }
.device-tag-name { font-size: 30rpx; color: var(--text-primary); font-weight: 600; }
.device-tag-mac { font-size: 22rpx; color: var(--text-muted); margin-top: 4rpx; }


/* ★ v3.15-#21: Status 过期警告 — 比断连警告更严重（无声中断） */
.stale-warning {
  background: rgba(255, 69, 58, 0.12);
  border: 1rpx solid rgba(255, 69, 58, 0.3);
  border-radius: 16rpx;
  padding: 20rpx 24rpx;
  text-align: center;
  color: var(--accent-red);
  font-size: 26rpx;
  font-weight: 600;
  margin-bottom: 24rpx;
}

/* ===== 车辆状态卡片 ===== */
.car-card {
  background: var(--gradient-card);
  border-radius: 24rpx;
  padding: 50rpx;
  text-align: center;
  margin-bottom: 30rpx;
  border: 2rpx solid var(--border);
  transition: all 0.3s;
}

.car-card.unlocked {
  background: var(--gradient-unlock);
  border-color: var(--green-alpha-33);
}

.car-icon { font-size: 80rpx; margin-bottom: 16rpx; }

.car-state-text {
  font-size: 36rpx;
  font-weight: 700;
  color: var(--text-primary);
  display: block;
}

.car-rssi {
  font-size: 24rpx;
  color: var(--text-tertiary);
  margin-top: 8rpx;
  display: block;
}

.car-cooldown {
  font-size: 22rpx;
  color: var(--accent-orange);
  margin-top: 6rpx;
  display: block;
}

/* ★ v3.15: 电池电量指示器 — 双模式可选
 *   - emoji 模式（默认）：.batt-icon 显示 🔋/🪫 图标
 *   - CSS 组件模式：注释掉 emoji 行，启用 .batt-shell/.batt-fill/.batt-cap
 *   ── emoji 样式 ── */
.batt-icon { font-size: 24rpx; }
.batt-text { font-weight: 600; }

/* ── CSS 组件样式（备用） ── */
.car-battery {
  display: inline-flex;
  align-items: center;
  gap: 6rpx;
  margin-top: 10rpx;
  padding: 4rpx 16rpx;
  border-radius: 12rpx;
  font-size: 22rpx;
}

/* ── 电池外壳 ── */
.batt-shell {
  width: 40rpx;
  height: 22rpx;
  border: 2.5rpx solid currentColor;
  border-radius: 4rpx;
  position: relative;
  overflow: hidden;
  flex-shrink: 0;
}

/* ── 电池正极帽 ── */
.batt-cap {
  width: 5rpx;
  height: 10rpx;
  border: 2.5rpx solid currentColor;
  border-left: none;
  border-radius: 0 3rpx 3rpx 0;
  margin-left: -2rpx;
  flex-shrink: 0;
}

/* ── 电池填充层（width 由 :style 绑定 batteryLevel 百分比控制） ── */
.batt-fill {
  position: absolute;
  top: 1.5rpx;
  left: 1.5rpx;
  bottom: 1.5rpx;
  background: currentColor;
  border-radius: 2rpx;
  /* 平滑过渡：电量变化时填充宽度有 0.4s 动画 */
  transition: width 0.4s ease;
}

.car-battery.batt-high   { background: rgba(52, 199, 89, 0.15); color: var(--accent-green); }
.car-battery.batt-mid    { background: rgba(255, 169, 0, 0.15);  color: var(--accent-yellow); }
.car-battery.batt-low    { background: rgba(255, 69, 58, 0.15);  color: var(--accent-red); }
.car-battery.batt-unknown { background: rgba(142, 142, 147, 0.15); color: var(--text-muted); }


/* ===== 信息网格 ===== */
.info-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16rpx;
  margin-bottom: 30rpx;
}

.info-item {
  background: var(--bg-card);
  border-radius: 16rpx;
  padding: 24rpx;
}

.info-label {
  font-size: 22rpx;
  color: var(--text-muted);
  display: block;
  margin-bottom: 8rpx;
}

.info-value {
  font-size: 28rpx;
  font-weight: 600;
  color: var(--accent);
}

/* ===== 主要控制按钮 ===== */
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

.ctrl-btn:active { transform: scale(0.96); }

.ctrl-btn.unlock {
  background: var(--gradient-unlock);
  border-color: var(--green-alpha-27);
}

.ctrl-btn.lock {
  background: var(--gradient-lock);
  border-color: var(--red-alpha-27);
}

.ctrl-btn-icon { font-size: 56rpx; margin-bottom: 12rpx; }

.ctrl-btn-text {
  font-size: 30rpx;
  font-weight: 600;
  color: var(--text-primary);
}

.ctrl-btn-hint {
  font-size: 20rpx;
  color: var(--text-muted);
  margin-top: 6rpx;
}

/* ===== 次要操作 ===== */
.secondary-actions {
  display: flex;
  gap: 20rpx;
}

.sec-btn {
  flex: 1;
  background: var(--bg-card);
  border-radius: 16rpx;
  padding: 24rpx 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  border: 1rpx solid var(--border);
}

.sec-btn:active { opacity: 0.7; }
.sec-icon { font-size: 36rpx; margin-bottom: 6rpx; }
.sec-text { font-size: 24rpx; color: var(--text-tertiary); }

/* ===== 手动 RSSI 模拟 ===== */
.rssi-sim-section {
  background: var(--bg-card);
  border-radius: 16rpx;
  padding: 24rpx;
  margin-top: 30rpx;
}

.rssi-sim-title {
  font-size: 24rpx;
  color: var(--text-secondary);
  margin-bottom: 8rpx;
}

.rssi-sim-hint {
  font-size: 20rpx;
  color: var(--signal-empty-muted);
  margin-bottom: 16rpx;
}

/* ★ v3.12: 设备级配置提示 */
.rssi-sim-sub-hint {
  font-size: 18rpx;
  color: var(--accent-orange);
  margin-bottom: 12rpx;
  margin-top: -12rpx;
}

.rssi-presets {
  display: flex;
  gap: 12rpx;
  flex-wrap: wrap;
}

.rssi-preset {
  flex: 1;
  min-width: 130rpx;
  height: 56rpx;
  border-radius: 12rpx;
  font-size: 22rpx;
  font-weight: 600;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1rpx solid;
  padding: 0;
}

.rssi-preset.near { background: var(--rssi-near-bg); color: var(--accent-green); border-color: var(--green-alpha-27); }
.rssi-preset.close { background: var(--rssi-close-bg); color: var(--accent); border-color: var(--alpha-27); }
.rssi-preset.mid { background: var(--rssi-mid-bg); color: var(--accent-yellow); border-color: var(--yellow-alpha-27); }
.rssi-preset.far { background: var(--rssi-far-bg); color: var(--rssi-far-color); border-color: var(--rssi-far-border); }

.rssi-preset:active { opacity: 0.7; }

/* ===== ★ Phase 2: 设备模式切换（控制页底部） ===== */
.mode-section {
  margin-top: 30rpx;
}

.section-title {
  font-size: 28rpx;
  font-weight: 600;
  color: var(--text-secondary);
  margin-bottom: 16rpx;
}

.config-desc {
  font-size: 19rpx;
  color: var(--text-muted);
  line-height: 1.5;
  margin-left: 8rpx;
}

.mode-cards {
  display: flex;
  flex-direction: column;
  gap: 16rpx;
}

/* ★ v3.36.2 (2026-07-19): 电瓶车「靠近进入模式」双选项横向并排（各占 50%）；
   设备模式切换卡(mode-section 内 .mode-cards)仍保持纵向，故单独加修饰类而非改全局 .mode-cards。 */
.mode-cards--row {
  flex-direction: row;
}
.mode-cards--row .mode-card {
  flex: 1;
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

.mode-desc {
  display: block;
  font-size: 24rpx;
  color: var(--text-secondary);
  margin-bottom: 6rpx;
  line-height: 1.5;
}
</style>
