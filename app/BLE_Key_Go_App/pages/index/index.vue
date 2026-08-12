<template>
  <view class="page-index" :class="themeClass">

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
      <view class="status-rssi" v-show="bleStore.connected">
        <text class="rssi-value">{{ bleStore.displayRssi > -999 ? bleStore.displayRssi : '---' }}</text>
        <text class="rssi-unit">dBm</text>
      </view>
      <!-- ★ v3.36.1: 电池电量 — 缩小整行，置于「已连接」框(🔗)内底部；断开后 batteryLevel 重置为 -1 自动隐藏 --> <!-- 2026-07-25: 电池卡加 connected 守卫(bleStore.connected)，未连接不再显示旧电量 -->
      <!-- ★ 2026-08-09 (P0-①): 显示条件新增 batteryLevel===255(固件不支持电量)，让其显示 🚫+不支持，而非整块隐藏 -->
      <view class="card-batt" v-if="bleStore.connected && (bleStore.batteryLevel >= 0 || bleStore.batteryLevel === 255)" :class="bleStore.batteryColor"> 
        <text class="batt-icon">{{ bleStore.batteryIcon }}</text>
        <text class="batt-text">{{ bleStore.batteryText }}</text>
      </view>
    </view>

    <!-- ★ 信号强度条 -->
    <view class="signal-section" v-show="bleStore.connected">
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

    <!-- ★ v3.36.1: 连接页补充 — 芯片温度（信号强度下方，与控制页同源）；电池已移至「已连接」框下方 -->
    <!-- ★ 2026-07-19: 温度遥测本就是连接态数据，必须 connected 才显示；断连后即便 deviceTempC
         因时序残留旧值也不应再显示，故加 bleStore.connected 守卫（与断连置 null 双保险）。 -->
    <view class="conn-extra" v-show="bleStore.connected && bleStore.deviceTempC !== null">
      <view class="temp-card" v-if="bleStore.connected && bleStore.deviceTempC !== null" :class="tempClass">
        <view class="temp-head">
          <text class="temp-icon">🌡️</text>
          <text class="temp-label">芯片温度</text>
          <text class="temp-tag">{{ tempTag }}</text>
        </view>
        <view class="temp-body">
          <text class="temp-value">{{ bleStore.deviceTempC }}<text class="temp-unit">°C</text></text>
        </view>
        <view class="temp-bar">
          <view class="temp-bar-fill" :style="{ width: tempPercent + '%' }"></view>
        </view>
        <view class="temp-bar-marks">
          <text>-10</text><text>15</text><text>40</text><text>65</text><text>90</text>
        </view>
      </view>
    </view>

    <!-- ★ v3.31 方案B-修正②: 开关打开即「始终显示」进度卡片（解锁区/锁车区/中间区都显示），deviceUc<1(旧固件/未同步)不显示 -->
    <view class="progress-card" v-show="bleStore.connected && bleStore.showProgressCard && bleStore.deviceUc >= 1">
      <!-- 自动锁关闭（手动模式）→ 直接说明为什么不会自动锁车，这是「没法锁车」最常见原因 -->
      <text class="progress-tip" v-if="bleStore.autoLockEnabled === 0">
        ⚠️ 自动锁已关闭（手动模式），RSSI 不会自动解锁/锁车，请用手动按键
      </text>

      <template v-if="bleStore.autoLockEnabled !== 0">
        <!-- 中间区间：未达任一阈值 → 仅标题文字 + 灰色条，不要 RSSI 数值和提示 -->
        <template v-if="bleStore.thresholdZone === 0">
          <view class="progress-header">
            <text class="progress-label">📍 中间区间</text>
          </view>
          <view class="progress-bar-bg">
            <view class="progress-bar-fill neutral" :style="{ width: bleStore.rssiPercent + '%' }"></view>
          </view>
        </template>

        <!-- 解锁区 -->
        <template v-else-if="bleStore.thresholdZone === 1">
          <view class="progress-header">
            <text class="progress-label">🔓 解锁进度</text>
            <!-- ★ v3.33.2 P1: 已解锁后固件计数器归零(ucnt=0)导致进度从 0 重新计数，
                 但 LED 已亮、车已解锁 → 视觉矛盾。已解锁时定格 N/N 不再重计数。 -->
            <text class="progress-value">{{ bleStore.isUnlocked ? bleStore.deviceUc : Math.min(bleStore.unlockProgress, bleStore.deviceUc) }}/{{ bleStore.deviceUc }}</text>
          </view>
          <view class="progress-bar-bg">
            <view class="progress-bar-fill" :style="{ width: (bleStore.isUnlocked ? 100 : (bleStore.deviceUc > 0 ? Math.min(bleStore.unlockProgress, bleStore.deviceUc) / bleStore.deviceUc * 100 : 0)) + '%' }"></view>
          </view>
        </template>

        <!-- 锁车区 -->
        <!-- ★ v3.33.2 P1: 已锁车后固件计数器归零→进度重计，与 LED 已灭矛盾。已锁时定格 N/N。 -->
        <template v-else>
          <view class="progress-header">
            <text class="progress-label">🔒 锁车进度</text>
            <text class="progress-value lock">{{ bleStore.deviceState === 'LOCKED' ? bleStore.deviceLc : Math.min(bleStore.lockProgress, bleStore.deviceLc) }}/{{ bleStore.deviceLc }}</text>
          </view>
          <view class="progress-bar-bg">
            <view class="progress-bar-fill lock" :style="{ width: (bleStore.deviceState === 'LOCKED' ? 100 : (bleStore.deviceLc > 0 ? Math.min(bleStore.lockProgress, bleStore.deviceLc) / bleStore.deviceLc * 100 : 0)) + '%' }"></view>
          </view>
        </template>

        <!-- 配置一致性提示 -->
        <text class="progress-tip" v-if="bleStore.deviceUc >= 0 && bleStore.deviceUc !== bleStore.unlockCountRequired">
          ⚠️ 设备确认次数 uc={{ bleStore.deviceUc }} 与 App 设置 {{ bleStore.unlockCountRequired }} 不一致，配置可能未下发
        </text>
      </template>
    </view>

    <!-- ★ v3.25: 极速模式距离显示（仅 speed 模式 + 未连接 + 有停车位置时显示） -->
    <view class="geofence-card" v-show="!bleStore.connected && bleStore.autoReconnectMode === 'speed' && bleStore.parkingLocation">
      <view class="geofence-header">
        <text class="geofence-icon">🅿️</text>
        <text class="geofence-title">停车位置</text>
        <text class="geofence-time" v-if="bleStore.parkingLocation">· {{ parkingTimeAgo }}</text>
      </view>
      <view class="geofence-body">
        <view class="geofence-distance-row">
          <text class="geofence-dist-label">距停车点</text>
          <text class="geofence-dist-value" :class="{ arrived: bleStore.geofenceDistance >= 0 && bleStore.geofenceDistance < 10 }">
            {{ bleStore.geofenceDistanceText }}
          </text>
        </view>
        <!-- 距离进度条：离车越近越满 -->
        <view class="geofence-bar-bg">
          <view class="geofence-bar-fill" :style="{ width: geofenceBarPercent + '%' }"
            :class="{ far: geofenceBarPercent < 30, mid: geofenceBarPercent >= 30 && geofenceBarPercent < 60, near: geofenceBarPercent >= 60 }">
          </view>
        </view>
        <text class="geofence-hint" v-if="bleStore.geofenceDistance >= 0 && bleStore.geofenceDistance < 100">
          🟢 已进入 100m 围栏，BLE 扫描已激活
        </text>
        <text class="geofence-hint" v-else-if="bleStore.geofenceDistance >= 100 && bleStore.geofenceDistance < 500">
          正在接近中，距围栏还有 {{ bleStore.geofenceDistance - 100 }}m
        </text>
        <text class="geofence-hint dim" v-else>
          等待 GPS 定位更新...
        </text>
      </view>
    </view>

    <!-- ★ 2026-07-22/23: 手动断开后"重新连接"入口（knownDevicesList 驱动，多设备展开为列表）
         ★ v3.36.3fix11.6: v-show→v-if，防御 MP 上 connected 过渡态时卡片残余（_onUniBtAdapterStateChange
         在设 btState='off' 与 _handleBtOff→connected=false 之间,DOM 可能暂存 v-show 的 display:none 未刷）。
         v-if 在 connected 变为 truthy 时将卡片彻底从 DOM 移除，消除跨端渲染不一致。 -->
    <!-- 整个重连卡片容器绑 @tap=onListTap：点卡片内任意空白(含「已知设备」标题、列表空隙)→ 收起展开项。
         连接/删除/⋯ 按钮均 @tap.stop 拦截，不会冒泡到这里，故不会误收起。 -->
    <view class="reconnect-card" v-if="!bleStore.connected && bleStore.knownDevicesList.length" @tap="onListTap">
      <!-- 多设备：展开为可滚动列表 -->
      <template v-if="bleStore.knownDevicesList.length > 1">
        <text class="reconnect-label">已知设备 ({{ bleStore.knownDevicesList.length }})</text>
        <scroll-view class="known-list" scroll-y @tap="onListTap">
          <!-- ★ 2026-08-09 P1-②(改): iOS 风左滑。前景 foreground 层随手指左移，露出背后 default/remove 按钮；
               右侧 ⋯ 图标点击=toggleItem 滑动展开(与左滑同一套 UI，不再弹 ActionSheet)；
               已展开时点前景空白/列表空白→收起。openMac 记录当前展开项，互斥(一项展开收起其他)。
               单设备卡不走左滑(见下方 template)。 -->
          <!--
            ★ 2026-08-09 临时注释：左滑手势(从右向左滑露出 默认/删除) 已禁用。
            原因：在 uni-app 的 <scroll-view> 内，手写 touch 判定无法真正拦住原生纵向滚动——
            scroll-view 在更底层捕获 touch 事件，子元素 e.stopPropagation() 对原生滚动无效，
            导致「横向意图被锁定后，屏幕仍在纵向滑动」两者并发。该冲突在可滚动列表里近乎无解
            （除非自实现虚拟滚动），故先撤掉左滑，保留 ⋯ 点击滑出 作为唯一展开入口（更稳定、零冲突）。
            如日后要恢复，需改用 catch:touchmove 拦截 + 自实现滚动，或把列表改为非滚动容器。
            相关函数 onItemTouchStart/Move/End 已一并注释保留，便于日后回滚。
          -->
          <view class="known-item" v-for="d in bleStore.knownDevicesList" :key="d.mac" :class="{ 'is-open': openMac === d.mac }">
            <!-- @touchstart="onItemTouchStart($event)" -->
            <!-- @touchmove="onItemTouchMove($event)" -->
            <!-- @touchend="onItemTouchEnd($event, d.mac)" -->
            <!-- 背后操作层(默认/取消默认 + 删除)。已默认设备显示「取消默认」，否则「默认」。 -->
            <view class="known-item-back">
              <view class="back-btn back-default" @tap.stop="handleSetDefault(d.mac)">
                <text class="back-icon">{{ d.isDefault ? '✓' : '☆' }}</text>
                <text>{{ d.isDefault ? '取消默认' : '默认' }}</text>
              </view>
              <view class="back-btn back-remove" @tap.stop="handleRemoveDevice(d.mac)">
                <text class="back-icon">🗑</text>
                <text>删除</text>
              </view>
            </view>
            <!-- 前景内容层(随左滑位移)。@tap: 已展开时点空白处(非按钮)→收起；
                 连接/删除/⋯ 按钮用 @tap.stop 拦截，不会触发收起。 -->
            <view class="known-item-front" :style="{ transform: (openMac === d.mac ? 'translateX(-' + backWidth + 'px)' : 'translateX(0)') }"
              @tap="onFrontTap(d.mac)">
              <view class="reconnect-info">
                <text class="reconnect-name">{{ d.displayName }}</text>
                <text class="reconnect-mac">{{ d.mac }}</text>
                <view v-if="d.customName || d.isDefault" class="device-tags">
                  <text v-if="d.customName" class="device-alias-tag">已命名</text>
                  <text v-if="d.isDefault" class="device-default-tag">默认</text>
                </view>
              </view>
              <view class="known-item-actions">
                <button class="reconnect-btn" @tap.stop="handleReconnect(d.mac)">连接</button>
                <text class="more-btn" @tap.stop="toggleItem(d.mac)">⋯</text>
              </view>
            </view>
          </view>
        </scroll-view>
      </template>
      <!-- 单设备：与多设备列表统一交互(⋯ 滑出 默认/取消默认 + 删除)。
           注：单卡无 scroll-view 包裹，reconnect-card 已绑 @tap=onListTap，点空白天然可收起。 -->
      <template v-else>
        <view class="known-item single-item" :class="{ 'is-open': openMac === bleStore.knownDeviceId }">
          <!-- 背后操作层：单设备默认/取消默认 + 删除 -->
          <view class="known-item-back">
            <view class="back-btn back-default" @tap.stop="handleSetDefault(bleStore.knownDeviceId)">
              <text class="back-icon">{{ isDefaultDevice(bleStore.knownDeviceId) ? '✓' : '☆' }}</text>
              <text>{{ isDefaultDevice(bleStore.knownDeviceId) ? '取消默认' : '默认' }}</text>
            </view>
            <view class="back-btn back-remove" @tap.stop="handleRemoveDevice(bleStore.knownDeviceId)">
              <text class="back-icon">🗑</text>
              <text>删除</text>
            </view>
          </view>
          <!-- 前景内容层：信息 + 重新连接 + ⋯ -->
          <view class="known-item-front" :style="{ transform: (openMac === bleStore.knownDeviceId ? 'translateX(-' + backWidth + 'px)' : 'translateX(0)') }"
            @tap="onFrontTap(bleStore.knownDeviceId)">
            <view class="reconnect-info">
              <text class="reconnect-label">已知设备</text>
              <text class="reconnect-name">{{ bleStore.knownDeviceName }}</text>
              <text class="reconnect-mac">{{ bleStore.knownDeviceId }}</text>
              <view v-if="bleStore.customNameForMac(bleStore.knownDeviceId) || isDefaultDevice(bleStore.knownDeviceId)" class="device-tags">
                <text v-if="bleStore.customNameForMac(bleStore.knownDeviceId)" class="device-alias-tag">已命名</text>
                <text v-if="isDefaultDevice(bleStore.knownDeviceId)" class="device-default-tag">默认</text>
              </view>
            </view>
            <view class="known-item-actions">
              <button class="reconnect-btn" @tap.stop="handleReconnect(bleStore.knownDeviceId)">重新连接</button>
              <text class="more-btn" @tap.stop="toggleItem(bleStore.knownDeviceId)">⋯</text>
            </view>
          </view>
        </view>
      </template>
    </view>

    <!-- 设备扫描区域 -->
    <view class="section" v-show="!bleStore.connected">
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
            <text class="device-name">{{ deviceDisplayName(device) }}</text>
            <text class="device-id">{{ device.deviceId }}</text>
            <text v-if="device.nameIsFallback" class="device-occupied-tag">⚠ 设备占用中</text>
            <view v-if="bleStore.customNameForMac(device.deviceId) || bleStore.isPairedDevice(device.deviceId)" class="device-tags">
              <text v-if="bleStore.customNameForMac(device.deviceId)" class="device-alias-tag">已命名</text>
              <text v-if="bleStore.isPairedDevice(device.deviceId)" class="device-paired-tag">✓ 已配对</text>
            </view>
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
            <text class="mgmt-label">设备名称 ✍ </text>
            <text class="mgmt-val" v-if="bleStore.customDeviceName">{{ bleStore.customDeviceName }}</text>
            <text class="mgmt-val name-hint" v-else>点击设置（如车牌号）</text>
            <text class="mgmt-arrow">›</text>
          </view>
          <view class="mgmt-row" @tap="openBindModal">
            <text class="mgmt-label">设备绑定 🔐 </text>
            <text class="mgmt-val" v-if="bleStore.sessionAuthed">已验证</text>
            <text class="mgmt-val name-hint" v-else-if="!bleStore.isBound">未绑定·点击绑定</text>
            <!-- ★ B1 修复(v3.36.3fix11.6): 验证失败不再用浅色小字，
                 改用红色徽章醒目提示用户"需立即处理"，并提供"重绑"暗示。 -->
            <text class="mgmt-val bind-failed-badge" v-else-if="bleStore._autoAuthState === 'failed'">⚠ 验证失败（点击重绑）</text>
            <text class="mgmt-val" v-else>{{ bindLabel }}</text>
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
      <button class="action-btn" :class="thirdAction.cls" @tap="thirdAction.handler">
        <text class="action-icon">{{ thirdAction.icon }}</text>
        <text class="action-text">{{ thirdAction.text }}</text>
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

    <!-- ★ 设备绑定弹窗（fixed 覆盖层，脱离 swiper，input 可靠） -->
    <BindModal :visible="bindModalVisible" @close="bindModalVisible = false" />
  </view>
</template>


<script setup>
import { reactive, computed, ref, watch } from 'vue' // import { reactive, computed, watch } from 'vue'
import { onShow } from '@dcloudio/uni-app'
import { useBleStore } from '@/stores/ble.js'
import { useThemeStore } from '@/stores/theme.js'
import { toast } from '@/utils/toast.js'
import BindModal from '@/components/BindModal.vue'
const bleStore = useBleStore()
const themeStore = useThemeStore()
const themeClass = computed(() => themeStore.themeClass)

// ★ 2026-07-12: 绑定态文案——区分"已验证/自动验证中/验证失败需手动"，避免"待验证"像报错
const bindLabel = computed(() => {
  if (bleStore.sessionAuthed) return '已验证'
  if (bleStore._autoAuthState === 'running') return '已绑定·验证中…'
  if (bleStore._autoAuthState === 'failed') return '已绑定·验证失败'
  return '已绑定·待验证'
})

// ★ v3.25: 极速模式距离显示 — 停车时间相对描述
const parkingTimeAgo = computed(() => {
  const p = bleStore.parkingLocation
  if (!p || !p.savedAt) return ''
  const diff = Date.now() - p.savedAt
  if (diff < 60000) return '刚刚'
  if (diff < 3600000) return `${Math.floor(diff / 60000)}分钟前`
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}小时前`
  return `${Math.floor(diff / 86400000)}天前`
})

// ★ v3.25: 极速模式距离进度条（越近越满）
//   500m → 0%, 10m → 100%（指数映射让近距离变化更灵敏）
const geofenceBarPercent = computed(() => {
  const d = bleStore.geofenceDistance
  if (d < 0) return 0
  if (d <= 10) return 100
  if (d >= 500) return 0
  // 指数衰减：距离折半 → 进度提升 20%
  // 500m→0%, 250m→20%, 125m→40%, 60m→60%, 30m→80%, 10m→100%
  // 公式: percent = 20 * (9 - log2(d/10))，clamp [0, 100]
  const ratio = d / 10
  const pct = 20 * (9 - Math.log2(ratio))
  return Math.max(0, Math.min(100, Math.round(pct)))
})

// ★ v3.14 phantom-connected 诊断 watcher 已移除（根因修复见 commit d240db4：P1 进度条定格）。
//   若日后再出现 connected 状态异常跳变，可在此临时恢复该 sync-watch 抓调用栈。

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

// ★ 设备绑定弹窗（fixed 覆盖层，脱离 swiper/scroll-view 文档流，input 可靠）
const bindModalVisible = ref(false)
function openBindModal() {
  if (!bleStore.connected) {
    toast.info('请先连接设备')
    return
  }
  bindModalVisible.value = true
}

// ★ 2026-08-09 P1-②(改): 多设备列表「⋯ 点击滑出」状态。
//   openMac: 当前展开(露出背后操作)的设备 MAC，互斥(只一个)；''=全收起。
//   backWidth: 背后操作层宽度(px)，由 CSS 决定(rpx→px 需运行时量，这里给估值 168px=两个按钮)。
//   展开入口：⋯ 图标点击(toggleItem) → 同一套 translateX 滑动 UI。
//   收起入口：① 已展开点前景空白处(onFrontTap) ② 点列表空白(onListTap) ③ ⋯ 再点(toggleItem 互斥)。
//   ★ 左滑手势已禁用(见 template 内注释)：uni-app scroll-view 内手写 touch 无法拦住原生纵向滚动，
//     导致横滑与屏幕纵滑并发。onItemTouchStart/Move/End 暂注释保留，便于日后回滚。
const openMac = ref('')
const backWidth = 168

// // —— 以下为左滑手势实现(2026-08-09 起禁用，保留待回滚) ——
// let _touchStartX = 0
// let _touchStartY = 0
// let _touchDir = ''        // '' | 'h' | 'v'
// let _touchStartOpen = ''
// let _touchMoved = false   // 本回合是否发生过有效横滑(用于区分「点击」与「滑动」)
// function onItemTouchStart(e) {
//   _touchStartX = e.touches[0].clientX
//   _touchStartY = e.touches[0].clientY
//   _touchDir = ''
//   _touchStartOpen = openMac.value
//   _touchMoved = false
// }
// function onItemTouchMove(e) {
//   const dx = e.touches[0].clientX - _touchStartX
//   const dy = e.touches[0].clientY - _touchStartY
//   if (!_touchDir && (Math.abs(dx) > 8 || Math.abs(dy) > 8)) {
//     _touchDir = Math.abs(dx) > Math.abs(dy) ? 'h' : 'v'
//   }
//   if (_touchDir === 'v') return
//   if (_touchDir !== 'h') return
//   _touchMoved = true
//   e.stopPropagation && e.stopPropagation()
// }
// function onItemTouchEnd(e, mac) {
//   if (_touchDir !== 'h') { _touchDir = ''; return }
//   const dx = (e.changedTouches[0].clientX) - _touchStartX
//   if (dx < -40) openMac.value = mac
//   else if (_touchStartOpen === mac) openMac.value = ''
//   _touchDir = ''
// }

// ★ ⋯ 图标点击：展开/收起切换(toggle)——同一套滑动 UI 的唯一展开入口。
function toggleItem(mac) {
  if (!mac) return
  openMac.value = openMac.value === mac ? '' : mac
}

// ★ 判断某 MAC 是否当前默认设备(mac 规范化：去冒号大写)。
//   多设备列表项用 d.isDefault 字段，单设备卡无该字段故用此函数。
function isDefaultDevice(mac) {
  if (!mac) return false
  const key = String(mac).replace(/:/g, '').toUpperCase()
  return (bleStore.defaultDeviceId || '') === key
}

// ★ 前景空白处(非按钮)点击：若该项已展开 → 收起；否则无动作。
//   连接/删除/⋯ 按钮均带 @tap.stop，不会冒泡到这里。
function onFrontTap(mac) {
  if (openMac.value === mac) openMac.value = ''   // 已展开 → 收起
}

// ★ 列表空白(scroll-view 自身)点击：收起所有展开项。
function onListTap() {
  if (openMac.value) openMac.value = ''
}

// ★ 2026-07-14: 设备复位/被其他手机解绑后，store 置 needsRebind → 自动弹首绑界面
watch(() => bleStore.needsRebind, (v) => {
  if (v && bleStore.connected) {
    bleStore.needsRebind = false
    bindModalVisible.value = true
  }
})

onShow(async () => {
  // ★ 2026-07-24: 回前台立即提交显示暂存（staging），保证第一帧即显示当前真实态，
  //   且【不回放】后台/重连积压的历史包（burst 已合并为最新一次）。旧注释（EMA+500ms 节流）
  //   已随「入口流合并」方案退役：现在后台每包只覆盖非响应式 _stagedDisplay，合并提交 → 无回放。
  bleStore.flushStagedDisplay()
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
  if (bleStore.autoReconnectMode === 'comfort' || bleStore.autoReconnectMode === 'manual') {
    // 舒适/手动模式：onShow（App 打开/回前台）即尝试「前台」自动连接。
    // 手动模式用户要求「打开 App 也要自动连」，故放行前台；但后台重连(心跳/亮屏扫描/原生扫描)
    // 仍由 _shouldAutoReconnect 的 manual&&!isForeground 拦死，不会在锁屏后刷连接。
    // 闸门：用户主动断开(dormant) / 已连接 / 蓝牙关 → 不自动连；idle 避免重入。
    if (bleStore.reconnectMode === 'idle' && bleStore._shouldAutoReconnect(true, true)) {
      bleStore.tryAutoConnect()
    }
  } else if (bleStore.autoReconnectMode === 'speed') {
    // ★ Phase 3: 极速模式 → GPS 围栏检测（内部已含 _shouldAutoReconnect 闸门）
    if (!bleStore.connected) {
      // ★ v3.25.1-fix: 重启后恢复停车位置 + 围栏监控（修复重启无距离显示的 bug）
      bleStore._restoreSpeedModeState()
      bleStore.checkGeofenceApproach()
    }
  }
})

// ==================== 扫描 & 连接 ====================

// ★ v3.36.3fix11.3: handleEnableBluetooth（含权限申请）已迁至全局组件 BtStateBanner.vue，
//   连接页横幅改为在 main.vue 统一渲染，此处不再保留重复实现。

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
    // 只删"自动重连记忆"，保留 ble_last_device_id（knownDeviceId 来源）→ 断开后不自动冷启重连，但按钮仍可一键接管
    uni.removeStorageSync('ble_device_id')
    bleStore.devices = []
    toast.info('已断开连接')
  } else {
    toast.error('断开失败，请重试')
  }
}

// ★ 2026-07-22/23: 手动断开后一键重新连接（OS 占用时也能接管 ACL；可指定 targetMac 用于多设备列表）
// ★ P0-② (2026-08-09): 无 targetMac（重连已断开的当前设备）→ 走 reconnectDisconnected()，
//   显式清除 dormant + 用 lastDeviceId 直连，保证「断开后必能重连」。
async function handleReconnect(targetMac) {
  if (!targetMac) {
    uni.showLoading({ title: '连接中...', mask: true })
    try {
      const ok = await bleStore.reconnectDisconnected()
      uni.hideLoading()
      if (ok) {
        toast.success('连接成功')
        bleStore.devices = []
      } else toast.error('连接失败，请重试')
    } catch (e) {
      uni.hideLoading()
      toast.error('连接失败，请重试')
    }
    return
  }
  const id = targetMac
  if (!id) return
  uni.showLoading({ title: '连接中...', mask: true })
  try {
    await bleStore.connect(id, bleStore._resolveFactoryName(id))
    uni.hideLoading()
    toast.success('连接成功')
    bleStore.devices = []
  } catch (e) {
    uni.hideLoading()
    toast.error('连接失败，请重试')
  }
}

// ★ 2026-07-23 ④: 默认设备切换(toggle)。
//   点非默认设备 → 设为默认；点已默认设备 → 取消默认(回到无默认状态)。
function handleSetDefault(mac) {
  if (!mac) return
  const key = String(mac).replace(/:/g, '').toUpperCase()
  if ((bleStore.defaultDeviceId || '') === key) {
    bleStore.clearDefaultDevice()
    toast.success('已取消默认设备')
  } else {
    bleStore.setDefaultDevice(mac)
    toast.success('已设为默认设备')
  }
}

// ★ 2026-08-09 P1-②: 从已知设备列表主动删除一台 KeyGo（清本地全部痕迹：已知集合/自定义名/默认/重连锚点）
function handleRemoveDevice(mac) {
  if (!mac) return
  uni.showModal({
    title: '删除设备',
    content: '将从此手机移除该 KeyGo（含自定义名称），设备端绑定不受影响。确定删除？',
    confirmText: '删除',
    confirmColor: '#e64340',
    success: (res) => {
      if (!res.confirm) return
      const ok = bleStore.removeKnownDevice(mac)
      if (ok) toast.success('已删除')
      else toast.info('该设备不在已知列表')
    }
  })
}

// ★ 2026-07-23: 扫描列表展示名，有自定义名时组合为「自定义名 ( 出厂名 )」，否则出厂名
function deviceDisplayName(device) {
  const custom = bleStore.customNameForMac(device.deviceId)
  const factory = device.name || (device.deviceId ? bleStore._resolveFactoryName(device.deviceId) : '') || 'KeyGo'
  return bleStore._formatDisplayName(custom, factory)
}

// ==================== 车辆控制 ====================

async function handleUnlock() {
  try {
    await bleStore.unlock()
    toast.success('解锁指令已发送')
  } catch (err) {
    toast.error((err && err.message) || '发送失败')
  }
}

async function handleLock() {
  try {
    await bleStore.lock()
    toast.success('锁车指令已发送')
  } catch (err) {
    toast.error((err && err.message) || '发送失败')
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

async function handleRide() {
  try {
    await bleStore.ride()
    toast.success('骑行指令已发送')
  } catch {
    toast.error('发送失败')
  }
}

// ★ Phase 2: 连接页第三键按设备模式驱动（car=后备箱 / ebike=骑行）
// ★ v3.36.1: 连接页芯片温度卡片 — 温度等级配色/标签/刻度条百分比（与控制页同源）
const TEMP_BAR_MIN = -10
const TEMP_BAR_MAX = 90
const tempClass = computed(() => {
  const t = bleStore.deviceTempC
  if (t === null) return ''
  if (t < 20) return 'temp-cold'
  if (t <= 45) return 'temp-normal'
  if (t <= 65) return 'temp-warm'
  return 'temp-hot'
})
const tempTag = computed(() => {
  const c = tempClass.value
  return c === 'temp-cold' ? '偏低' :
         c === 'temp-hot' ? '过热' :
         c === 'temp-warm' ? '偏高' : '正常'
})
const tempPercent = computed(() => {
  const t = bleStore.deviceTempC
  if (t === null) return 0
  const p = (t - TEMP_BAR_MIN) / (TEMP_BAR_MAX - TEMP_BAR_MIN) * 100
  return p < 0 ? 0 : p > 100 ? 100 : p
})

const thirdAction = computed(() => {
  if (bleStore.deviceMode === 'ebike') {
    return { icon: '🛵', text: '骑行', handler: handleRide, cls: 'ride-btn' }
  }
  return { icon: '🚗', text: '后备箱', handler: handleTrunk, cls: 'trunk-btn' }
})

// ==================== 设备名称 ====================

function showNameDialog() {
  if (!bleStore.connected) {
    toast.info('请先连接设备')
    return
  }
  if (!bleStore.isBound) {
    toast.info('请先绑定设备后再设置名称')
    return
  }
  pwModal.mode = 'setName'
  pwModal.title = '设置设备名称'
  pwModal.hint = bleStore.customDeviceName
    ? '清空输入框并保存可恢复为出厂名称'
    : '给设备起个名字，如车牌号、车型等'
  pwModal.placeholder = '设备名称（最长20字符，支持中文）'
  pwModal.value = bleStore.customDeviceName || ''
  pwModal.showDefaultHint = false
  pwModal.defaultHint = ''
  pwModal.maxLen = 20
  pwModal.confirmText = '保存'
  pwModal.onConfirm = handleSetName
  pwModal.visible = true
}

// ★ 恢复默认名称 = 在名称弹窗里清空输入框并保存（handleSetName 已支持空名，
//   经 setDeviceName('') 同步清空 SN + MAC 两份本地存储，见 ble.js）

async function handleSetName() {
  const name = pwModal.value.trim()
  const isRestore = !name
  pwModal.visible = false
  uni.showLoading({ title: isRestore ? '恢复中...' : '保存中...', mask: true })
  try {
    await bleStore.setDeviceName(name)
    uni.hideLoading()
    toast.success(isRestore ? '已恢复默认名称' : '设备名称已更新')
  } catch (err) {
    uni.hideLoading()
    toast.error(err.message || '操作失败')
  }
}

</script>

<style scoped>
/* ★ v3.36.3fix11.4 (2026-07-25) Problem B: 页根 100vh→100%，精确贴合 scroll-view 可视区，
   消除未连接时“死滚动”（详见 stores/ble.js APP_VERSION 注释）。 */
.page-index {
  min-height: 100%;
  box-sizing: border-box; /* v3.36.3fix11.4 补充: border-box 使 min-height:100% 已含纵向 padding，消除 padding 造成的残余死滚 */
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
  position: relative;
  margin-bottom: 30rpx;
  border: 2rpx solid var(--border);
  transition: all 0.3s;
}

.status-card.connected {
  background: var(--gradient-connected);
  border-color: var(--alpha-33);
}

.status-card.reconnecting {
  background: var(--gradient-warn-card);
  border-color: var(--border-warning);
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

/* ===== 连接页补充：电池 + 芯片温度（v3.36.1，与控制页同源） ===== */
.conn-extra { margin-bottom: 30rpx; }
/* 连接页电量胶囊：缩在「已连接」框(🔗)内、最左一列的小标签
   - position:absolute  → 脱离正常布局流，不占高度，所以整个框的高度不会因为它而变化
   - left   → 距「卡片左边框」的水平距离（单位 rpx）。想更靠左就调小；想靠右就调大。
              🔗 图标本身在内容区最左边（卡片 padding=40rpx 处），这里设 12rpx 比图标再往左贴一点。
              注意别小于 ~8rpx，否则会戳到卡片圆角外。
   - top / bottom → 决定胶囊在「🔗 上方」还是「🔗 下方」（二选一，别同时写）：
              ★ 想放在 🔗 上方 → 用 top（如 top:14rpx，距卡片顶边 14rpx；🔗 在卡片里竖居中，故视觉上在它之上）
              ★ 想放回 🔗 下方 → 把下面这行 top 改成 bottom:14rpx（距卡片底边 14rpx）即可
              数值越大离边越远、越小越贴边。
   - 因为和 🔗 同属最左一列，视觉上就是「🔗 正上/正下方的小电量标」
   - 其它（padding/border-radius/font-size）只控制这个小胶囊自身的胖瘦和字号，不影响框布局 */
.card-batt {
  position: absolute;
  left: 12rpx;            /* ★ 想更靠左就调小这个值（如 8rpx） */
  top: 14rpx;             /* ★ 放在 🔗 上方：用 top；想放下方就改回 bottom:14rpx */
  display: inline-flex;
  align-items: center;
  gap: 4rpx;
  padding: 2rpx 10rpx;
  border-radius: 10rpx;
  font-size: 20rpx;
  line-height: 1.2;
}
.card-batt .batt-icon { font-size: 22rpx; }
.card-batt .batt-text { font-weight: 600; }
.card-batt.batt-high   { background: rgba(52, 199, 89, 0.15); color: var(--accent-green); }
.card-batt.batt-mid    { background: rgba(255, 169, 0, 0.15);  color: var(--accent-yellow); }
.card-batt.batt-low    { background: rgba(255, 69, 58, 0.15);  color: var(--accent-red); }
.card-batt.batt-unknown { background: rgba(142, 142, 147, 0.15); color: var(--text-muted); }
/* ★ 2026-08-09 (P0-①): 固件声明不支持电量(V03 无 ADC) — 橙色警示区分于未知灰 */
.card-batt.batt-unsupported { background: rgba(255, 169, 0, 0.15); color: var(--accent-yellow); }

.temp-card {
  background: var(--bg-card);
  border: 2rpx solid var(--border);
  border-radius: 20rpx;
  padding: 28rpx 30rpx;
  transition: all 0.3s;
}
.temp-head {
  display: flex;
  align-items: center;
  gap: 12rpx;
  margin-bottom: 14rpx;
}
.temp-icon { font-size: 32rpx; }
.temp-label { font-size: 26rpx; color: var(--text-muted); }
.temp-tag {
  margin-left: auto;
  font-size: 22rpx;
  padding: 4rpx 16rpx;
  border-radius: 20rpx;
  font-weight: 600;
}
.temp-body { text-align: center; margin: 6rpx 0 18rpx; }
.temp-value {
  font-size: 50rpx;
  font-weight: 800;
  line-height: 1;
  color: var(--text-primary);
}
.temp-unit { font-size: 32rpx; font-weight: 600; margin-left: 6rpx; color: var(--text-tertiary); }
.temp-bar {
  position: relative;
  height: 14rpx;
  border-radius: 10rpx;
  background: var(--bg-track, #e5e5ea);
  overflow: hidden;
}
.temp-bar-fill {
  position: absolute;
  left: 0; top: 0; bottom: 0;
  border-radius: 10rpx;
  transition: width 0.5s ease, background-color 0.3s;
}
.temp-bar-marks {
  display: flex;
  justify-content: space-between;
  margin-top: 10rpx;
  font-size: 22rpx;
  font-weight: 500;
  color: var(--text-tertiary);
  letter-spacing: 0.5rpx;
}
.temp-card.temp-cold .temp-bar-fill { background: #30b0c7; }
.temp-card.temp-cold .temp-tag { background: rgba(48,176,199,0.18); color: #30b0c7; }
.temp-card.temp-cold .temp-value { color: #30b0c7; }
.temp-card.temp-normal .temp-bar-fill { background: var(--accent-green); }
.temp-card.temp-normal .temp-tag { background: rgba(52,199,89,0.18); color: var(--accent-green); }
.temp-card.temp-warm .temp-bar-fill { background: var(--accent-yellow); }
.temp-card.temp-warm .temp-tag { background: rgba(255,169,0,0.18); color: var(--accent-yellow); }
.temp-card.temp-warm .temp-value { color: var(--accent-yellow); }
.temp-card.temp-hot .temp-bar-fill { background: var(--accent-red); }
.temp-card.temp-hot .temp-tag { background: rgba(255,69,58,0.18); color: var(--accent-red); }
.temp-card.temp-hot .temp-value { color: var(--accent-red); }
.temp-card.temp-hot { border-color: rgba(255,69,58,0.33); }

/* ===== v3.31 方案B: 确认进度卡片 ===== */
.progress-card {
  background: var(--bg-card);
  border-radius: 16rpx;
  padding: 20rpx 24rpx;
  margin-bottom: 24rpx;
}
.progress-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 14rpx;
}
.progress-label {
  font-size: 26rpx;
  color: var(--text-strong);
}
.progress-value {
  font-size: 30rpx;
  font-weight: 700;
  color: var(--accent, #3b82f6);
}
.progress-bar-bg {
  height: 14rpx;
  background: var(--bg-track, #e5e7eb);
  border-radius: 7rpx;
  overflow: hidden;
}
.progress-bar-fill {
  height: 100%;
  background: var(--accent, #3b82f6);
  border-radius: 7rpx;
  transition: width 0.2s ease;
}
.progress-bar-fill.lock {
  background: #ef4444;
}
.progress-bar-fill.neutral {
  background: #9ca3af;
}
.progress-value.lock {
  color: #ef4444;
}
.progress-tip {
  display: block;
  margin-top: 12rpx;
  font-size: 22rpx;
  color: #f59e0b;
}

/* ===== 设备区域 ===== */
.section {
  background: var(--bg-card);
  border-radius: 16rpx;
  padding: 24rpx;
  margin-bottom: 30rpx;
}

/* ★ 2026-07-22: 手动断开后"重新连接"卡片 — 与 .section/.status-card 等宽对齐 */
.reconnect-card {
  display: flex;
  align-items: center;
  justify-content: space-between;
  background: var(--bg-card);
  border-radius: 16rpx;
  padding: 24rpx;
  margin: 0 0 30rpx;          /* 横向无外边距 → 与上/下卡片等宽；纵向 30rpx 保持节奏一致 */
  box-sizing: border-box;
}
.reconnect-info { display: flex; flex-direction: column; min-width: 0; flex: 1 1 auto; } /* ★ flex:1 占满剩余空间 → 强制把按钮顶到最右 */
.reconnect-label { font-size: 22rpx; color: var(--text-muted); margin-bottom: 6rpx; }
.reconnect-name { font-size: 28rpx; color: var(--text-primary); font-weight: 600; line-height: 1.3; }
.reconnect-mac { font-size: 22rpx; color: var(--text-tertiary); margin-top: 2rpx; }
.reconnect-btn {
  flex: 0 0 auto;              /* ★ 不伸缩、按内容宽度，配合左侧 flex:1 稳定靠右 */
  margin-left: 20rpx;
  width: auto;
  background: var(--alpha-12); /* 与"扫描设备"(.btn-scan)完全一致：透明强调色底 */
  color: var(--accent);
  border: 1rpx solid var(--alpha-27);
  border-radius: 20rpx;
  padding: 12rpx 24rpx;       /* 与 .btn-scan 完全一致：不写 line-height，沿用与 .btn-scan 相同的默认行高，避免按钮被撑高 */
  font-size: 24rpx;
}
.reconnect-btn:active { opacity: 0.7; }

/* ★ 2026-07-23 ②④ / 2026-08-09 改: 多设备重连列表（iOS 风左滑） */
.known-list { max-height: 320rpx; margin-top: 10rpx; }
/* 外层：相对定位 + 溢出隐藏，承载「前景层 + 背后操作层」 */
.known-item {
  position: relative;
  overflow: hidden;
  background: var(--bg-card-alt);   /* 背后层底色：前景左移时露出的底层，避免刺眼亮边 */
  border-top: 1rpx solid var(--border);
}
.known-item:first-child { border-top: none; }
.single-item { margin-top: 10rpx; }   /* 单设备卡与多设备列表首项视觉间距一致 */
/* 背后操作层：铺在右侧，前景左移时露出 */
.known-item-back {
  position: absolute;
  top: 8rpx; right: 8rpx; bottom: 8rpx;
  display: flex;
  align-items: stretch;
  gap: 8rpx;
  border-radius: 16rpx;
  overflow: hidden;
  opacity: 0;
  transition: opacity 0.2s ease;
}
/* ② 展开时背后层渐入，强化「滑出菜单」的视觉反馈 */
.known-item.is-open .known-item-back { opacity: 1; }
.back-btn {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 4rpx;
  width: 84px;            /* px：与脚本 backWidth(168px=2*84) 对应，露出两个按钮 */
  color: #fff;
  font-size: 22rpx;
  line-height: 1.2;
  transition: transform 0.12s ease, filter 0.12s ease;
}
.back-icon { font-size: 30rpx; line-height: 1; }
.back-default { background: var(--accent); }
.back-remove { background: #e64340; }
.back-btn:active { transform: scale(0.94); filter: brightness(0.9); }
/* 前景内容层：默认铺满，左滑 translateX 露出背后 */
.known-item-front {
  position: relative;
  z-index: 1;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 18rpx 0;
  background: var(--bg-card);   /* 盖住背后层，避免位移前透出；用主题卡片色同步夜间模式 */
  transition: transform 0.2s ease, box-shadow 0.2s ease;
  will-change: transform;
}
/* ② 展开视觉提示：已展开项前景层加投影，暗示「可点外部收起」且强化层次 */
.known-item.is-open .known-item-front {
  box-shadow: -6rpx 0 16rpx rgba(0, 0, 0, 0.18);
}
.known-item-actions { display: flex; align-items: center; flex: 0 0 auto; margin-left: 16rpx; }
.more-btn {
  margin-left: 16rpx;
  width: 48rpx;
  text-align: center;
  font-size: 36rpx;
  color: var(--text-muted);
  line-height: 1;
}
.more-btn:active { opacity: 0.6; }
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

/* ★ v3.35: 异名设备(可能已被占用)的警示徽标 */
.device-occupied-tag {
  display: inline-block;
  margin-top: 8rpx;
  padding: 2rpx 12rpx;
  font-size: 20rpx;
  line-height: 1.4;
  color: #fff;
  background: #e6a23c;
  border-radius: 8rpx;
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

/* ★ 2026-07-30: 「已命名 / 默认 / 已配对」等徽章横向排布容器 */
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
/* ★ v3.36.3-fix5: 「已命名」徽章（设备已设自定义名），扫描列表/重连卡通用 */
.device-alias-tag {
  align-self: flex-start;
  margin-top: 4rpx;
  font-size: 18rpx;
  color: var(--accent);
  background: var(--alpha-12);
  border-radius: 8rpx;
  padding: 2rpx 10rpx;
}

/* ★ 2026-07-23: 「已配对」徽章（本机连过的设备），绿色，扫描列表防误连陌生人设备 */
.device-paired-tag {
  align-self: flex-start;
  margin-top: 4rpx;
  margin-left: 8rpx;
  font-size: 18rpx;
  color: #2ecc71;
  background: rgba(46, 204, 113, 0.14);
  border-radius: 8rpx;
  padding: 2rpx 10rpx;
}

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

/* ★ B1 修复(v3.36.3fix11.6): 验证失败红色徽章，醒目提示用户 */
.bind-failed-badge {
  color: #D32F2F;
  font-weight: 700;
  background: rgba(211, 47, 47, 0.12);
  padding: 6rpx 18rpx;
  border-radius: 14rpx;
  font-size: 18rpx; /* 之前是24rpx 我觉得有点大调小了 */
}
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
.ride-btn { border-color: var(--alpha-27); } /* 之前用的 var(--accent)  有点太深了*/

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

/* ===== ★ v3.25: 极速模式距离显示卡片 ===== */
.geofence-card {
  background: var(--bg-card);
  border-radius: 16rpx;
  padding: 24rpx;
  margin-bottom: 30rpx;
  border: 1rpx solid var(--border);
}

.geofence-header {
  display: flex;
  align-items: center;
  margin-bottom: 16rpx;
}

.geofence-icon { font-size: 32rpx; margin-right: 8rpx; }

.geofence-title {
  font-size: 26rpx;
  font-weight: 600;
  color: var(--text-primary);
}

.geofence-time {
  font-size: 22rpx;
  color: var(--text-muted);
  margin-left: 6rpx;
}

.geofence-distance-row {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  margin-bottom: 12rpx;
}

.geofence-dist-label {
  font-size: 24rpx;
  color: var(--text-tertiary);
}

.geofence-dist-value {
  font-size: 32rpx;
  font-weight: 700;
  color: var(--accent);
  transition: color 0.3s;
}

.geofence-dist-value.arrived {
  color: var(--accent-green);
}

.geofence-bar-bg {
  height: 10rpx;
  background: var(--border);
  border-radius: 5rpx;
  overflow: hidden;
  margin-bottom: 12rpx;
}

.geofence-bar-fill {
  height: 100%;
  border-radius: 5rpx;
  transition: width 1s ease;
}

.geofence-bar-fill.far  { background: linear-gradient(90deg, #90CAF9, #42A5F5); }
.geofence-bar-fill.mid  { background: linear-gradient(90deg, #FFB74D, #FF9800); }
.geofence-bar-fill.near { background: linear-gradient(90deg, #81C784, #4CAF50); }

.geofence-hint {
  font-size: 22rpx;
  color: var(--accent-green);
}

.geofence-hint.dim {
  color: var(--text-muted);
}
</style>
