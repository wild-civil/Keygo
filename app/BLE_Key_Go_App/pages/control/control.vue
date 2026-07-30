<template>
  <view class="page-control" :class="themeClass">
    <!-- ★ 连接状态提示 -->
    <!-- ★ 2026-07-24 修复(晃动根因·关键)：原用 v-if 切换「断连提示」与「控制 UI」两棵大树。
         重连风暴期间 connected 在 false↔true 间翻转 → 整棵控制 UI 子树被反复挂载/卸载 →
         父 swiper(swiper-item) 内部 DOM 节点被摘除/重建 → 滑动手势追踪被打断 →
         「左右滑动拉扯 / 屏幕不受控制」。改为 v-show（仅切换 display，不挂载/卸载节点），
         swiper-item 内容 DOM 结构全程稳定 → 手势不再被打断。
         ★ 2026-07-25 修复(MP 失效)：v-show 在 mp-weixin 编译后实际不切 display（连 page 内的 view 也失效），
           控制页出现"断连提示卡"与"已连接 UI"同时显示的矛盾。改用 :style="{display: ...}"
           直接写内联 style="display:none" → DOM 树不动（保留 v-show 的子树不卸载优点，手势不受影响），
           但 display 真切换。-->
    <!-- ★ 2026-07-25 修复(MP 渲染): 先试 :style="{display:...}" 在 mp-weixin 上仍不可靠，
         改用 :class 切 display:none（元素仍挂载，保留 swiper 手势稳定，避开 v-if 卸载陷阱）。 -->
    <view class="conn-warning" :class="{ 'is-hidden': bleStore.connected }">
      <text v-if="bleStore.reconnectMode === 'active' || bleStore.reconnectMode === 'paused'">🔄 设备离线，正在自动重连中...</text>
      <text v-else>⚠️ 设备未连接</text>
      <!-- ★ 2026-07-22: 手动断开后"重新连接"按钮（已知设备记忆驱动，OS 占用也能接管 ACL） -->
      <view class="reconnect-block" v-if="bleStore.knownDevicesList.length">
        <!-- 多设备：展开为可滚动列表 -->
        <template v-if="bleStore.knownDevicesList.length > 1">
          <text class="reconnect-label">已知设备 ({{ bleStore.knownDevicesList.length }})</text>
          <scroll-view class="known-list" scroll-y>
            <view class="known-item" v-for="d in bleStore.knownDevicesList" :key="d.mac">
              <view class="reconnect-info">
                <text class="reconnect-name">{{ d.displayName }}</text>
                <text class="reconnect-mac">{{ d.mac }}</text>
                <view v-if="d.customName || d.isDefault" class="device-tags">
                  <text v-if="d.customName" class="device-alias-tag">已命名</text>
                  <text v-if="d.isDefault" class="device-default-tag">默认</text>
                </view>
              </view>
              <view class="known-item-actions">
                <button class="reconnect-btn" @tap="handleReconnect(d.mac)">连接</button>
                <button v-if="!d.isDefault" class="default-btn" @tap="handleSetDefault(d.mac)">默认</button>
              </view>
            </view>
          </scroll-view>
        </template>
        <!-- 单设备：维持原单卡 -->
        <template v-else>
          <view class="reconnect-info">
            <text class="reconnect-label">已知设备</text>
            <text class="reconnect-name">{{ bleStore.knownDeviceName }}</text>
            <text class="reconnect-mac">{{ bleStore.knownDeviceId }}</text>
            <text v-if="bleStore.customNameForMac(bleStore.knownDeviceId)" class="device-alias-tag">已命名</text>
          </view>
          <button class="reconnect-btn" @tap="handleReconnect(bleStore.knownDeviceId)">重新连接</button>
        </template>
      </view>
    </view>

    <!-- ★ 2026-07-24: 控制 UI 用 v-show 切换(非 v-if)，重连时子树不卸载 → 不打断 swiper 手势
         ★ 2026-07-25 修复(MP 失效): v-show 在 mp-weixin 上不切 display → 与断连提示卡同显。改 :style。 -->
    <view :class="{ 'is-hidden': !bleStore.connected }" class="control-body">
      <!-- ★ 2026-07-23: 设备身份移到车辆大卡顶部(car-identity)，不再单独显示 MAC 行/已命名徽章 -->
      <!-- ★ v3.15-#21: Status Notify 过期警告 — 设备连接中但推送超时（静默断连） -->
      <!-- ★ 2026-07-24: 改用 v-show，避免重连期间小节点挂载/卸载（次要，防御性） -->
      <view class="stale-warning" v-show="bleStore.statusStale">
        <text>⚠️ 设备状态已过期，连接可能已中断</text>
      </view>

      <!-- ★ 车辆状态大卡 -->
      <view class="car-card" :class="{ unlocked: bleStore.isUnlocked }">
      <view class="car-icon">{{ carIcon }}</view>
      <!-- ★ 2026-07-23: 设备身份(自定义名/出厂名)下移到图标下方，与锁车状态同行(标题栏：左名右状态) -->
      <view class="car-head">
        <text class="car-identity" v-if="bleStore.deviceId">{{ bleStore.controlTopName }}</text>
        <text class="car-state-text">{{ bleStore.stateText }}</text>
      </view>
      <view class="car-status">
        <!-- ★ 2026-07-24 修复：控制页头条「信号」由未节流的 filteredRssi 改为受节流的 displayRssi
             解决的问题：
               原绑定 filteredRssi（每条 FF02 报文直写、零节流）。
               后台锁屏回前台 / GATT 上下文重建期间，FF02 暂停后重建会产生 RSSI 过渡噪声，
               被逐条反映 → 数字狂跳。此问题是「数字乱跳」的真因，已真机证实(连接页因绑 displayRssi 而稳)。
             改动效果：
               displayRssi 直接取固件 Kalman 滤波值 f（本身已平滑），并受 rssiReadPeriodMs
               节流（节流窗口 = 固件采样间隔，默认 500ms；设 200/300ms 即跟随），
               与连接页大号 RSSI 同节奏、同平滑源，后台噪值被抹平。
             可能的影响（均已评估，无功能丢失）：
               1. 刷新频率由「每条 FF02」降为「小于等于每 rssiReadPeriodMs 一次」，比 raw 慢，
                  但仍是平滑值；连接页本就如此，显示一致性更好。
               2. 同源修复：info-grid「原始 RSSI / 滤波 RSSI」也已改为受节流的 rawRssiDisplay / displayRssi
                  （见下方 info-grid），降低控制页 re-render 频率，缓解 connected 稳定时的轻微抖动。
                  ★ 但「重连期间左右滑动拉扯」的真正主因并非 RSSI 重渲染，而是下方顶层
                  v-if(connected)/v-else 子树反复挂载/卸载（打断父 swiper 手势），已改为 v-show 根治。
               3. filteredRssi / rssi 仍照常每条 FF02 更新供内部逻辑使用，仅 UI 展示层改绑节流值。
               4. 占位判定（大于 -999）与 displayRssi / rawRssiDisplay 初值(-999)一致，未连接/无值时仍显示占位符。 -->
        <text class="car-rssi">信号: {{ bleStore.displayRssi > -999 ? bleStore.displayRssi + ' dBm' : '---' }}</text>
          <!-- ▼ ★ v3.15: 电池电量 — 默认 emoji 图标
               如需切换为 CSS 电池组件，注释下面 18 行，取消注释 19~24 行 -->
          <!-- ★ 2026-07-24: 改 v-show，避免重连期间电量从-1→100 时块状节点挂载打断 swiper 手势 -->  <!-- 2026-07-25: 控制页电池同样加 connected 守卫(bleStore.connected)，保留 v-show 不破坏 swiper 手势 -->
          <view class="car-battery" :class="bleStore.batteryColor" v-show="bleStore.connected && bleStore.batteryLevel >= 0"> 
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
          <!-- ★ 2026-07-24 修复（同源）：原始 RSSI 改用受节流的 rawRssiDisplay（=固件上报 r），不再绑每条 FF02 直写的 rssi。
               保留 raw vs filtered 诊断差异，但刷新受 rssiReadPeriodMs 节流，杜绝高频重渲染打断 swiper 手势。 -->
          <text class="info-label">原始 RSSI</text>
          <text class="info-value">{{ bleStore.rawRssiDisplay > -999 ? bleStore.rawRssiDisplay : '---' }} dBm</text>
        </view>
        <view class="info-item">
          <!-- ★ 2026-07-24 修复（同源）：滤波 RSSI 改用受节流的 displayRssi（=固件 Kalman 滤波 f），与头条同源同节奏。 -->
          <text class="info-label">滤波 RSSI</text>
          <text class="info-value">{{ bleStore.displayRssi > -999 ? bleStore.displayRssi : '---' }} dBm</text>
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
      <!-- ★ 2026-07-24: 改 v-show，避免重连期间 deviceMode 生效时整段挂载打断 swiper 手势 -->
      <view class="prox-ride-section" v-show="bleStore.deviceMode === 'ebike'" style="margin-top:30rpx;">
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
    </view>
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
  bleStore.flushStagedDisplay()   // ★ 2026-07-24: 回前台立即提交最新暂存显示，避免回放历史
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

// ★ 2026-07-22/23: 手动断开后一键重新连接（可指定 targetMac 用于多设备列表）
async function handleReconnect(targetMac) {
  const id = targetMac || bleStore.knownDeviceId
  if (!id) return
  uni.showLoading({ title: '连接中...', mask: true })
  try {
    await bleStore.connect(id, bleStore._resolveFactoryName(id))
    uni.hideLoading()
    toast.success('连接成功')
  } catch (e) {
    uni.hideLoading()
    toast.error('连接失败，请重试')
  }
}

// ★ 2026-07-23 ④: 把指定设备设为默认(在重连列表中置顶)
function handleSetDefault(mac) {
  if (!mac) return
  bleStore.setDefaultDevice(mac)
  toast.success('已设为默认设备')
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
/* ★ v3.36.3fix11.4 (2026-07-25) Problem B: 页根 100vh→100%，消除死滚动（详见 ble.js 注释）。 */
.page-control {
  min-height: 100%;
  box-sizing: border-box; /* v3.36.3fix11.4 补充: border-box 使 min-height:100% 已含纵向 padding，消除 padding 残余死滚 */
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

/* ★ 2026-07-25 修复(MP 渲染): v-show/:style 在 mp-weixin 上 display 切换均不可靠，
   统一用 class 切 display:none。元素仍挂载(不破坏 swiper 手势)，仅隐藏渲染。 */
.conn-warning.is-hidden,
.control-body.is-hidden { display: none; }

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

/* ★ 2026-07-23 ②④: 多设备重连列表 */
.known-list { max-height: 320rpx; margin-top: 10rpx; }
.known-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 18rpx 0;
  border-top: 1rpx solid var(--border);
}
.known-item:first-child { border-top: none; }
.known-item-actions { display: flex; align-items: center; flex: 0 0 auto; margin-left: 16rpx; }
.default-btn {
  margin-left: 12rpx;
  width: auto;
  background: transparent;
  color: var(--text-muted);
  border: 1rpx solid var(--border);
  border-radius: 20rpx;
  padding: 12rpx 20rpx;
  font-size: 22rpx;
}
.default-btn:active { opacity: 0.7; }
/* ★ 2026-07-30: 重连卡内「已命名 / 默认」等徽章横向排布容器（不挤占名称/地址的纵向布局） */
.device-tags {
  display: flex;
  flex-direction: row;
  flex-wrap: wrap;
  align-items: center;
  gap: 8rpx;
  margin-top: 6rpx;
  min-height: 28rpx;
}
.device-tags .device-alias-tag,
.device-tags .device-default-tag,
.device-tags .device-paired-tag {
  align-self: auto;
  margin-top: 0;
  margin-left: 0;
}
.device-default-tag {
  align-self: flex-start;
  margin-top: 4rpx;
  margin-left: 8rpx;
  font-size: 18rpx;
  color: #fff;
  background: var(--accent);
  border-radius: 8rpx;
  padding: 2rpx 10rpx;
}

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
/* ★ 2026-07-23: 车辆大卡标题栏（图标下方：自定义名 + 空格 + 锁车状态，整体居中） */
.car-head {
  display: flex;
  justify-content: center;
  align-items: baseline;
  gap: 16rpx; /* ★ 自定义名 与 锁车状态 之间的空格 */
  margin-bottom: 14rpx;
}

.car-identity { 
  color: var(--accent);
  font-weight: bold;
  font-size: 32rpx; /* ★ 自定义名字体大小 */
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 60%;
}


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
  font-size: 32rpx; /* ★ 控制页面 锁车状态 字体大小 */
  font-weight: 700;
  color: var(--text-primary);
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
