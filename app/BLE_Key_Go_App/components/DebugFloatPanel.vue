<template>
  <!-- 仅开发期显示，用户关闭后从 DOM 移除 -->
  <view v-if="!state.closed" class="debug-float-root" :class="{ collapsed: !state.visible }">
    <!-- 展开面板 -->
    <view v-if="state.visible" class="debug-panel">
      <view class="debug-header">
        <text class="debug-title">DEV 调试</text>
        <view class="debug-actions">
          <text class="debug-btn" @click="toggle">收起</text>
          <text class="debug-btn debug-btn-close" @click="close">×</text>
        </view>
      </view>

      <view class="debug-section">
        <view class="debug-row">
          <text class="debug-label">模式</text>
          <text class="debug-val">{{ bleStore.autoReconnectMode || '?' }}</text>
        </view>
        <view class="debug-row">
          <text class="debug-label">连接</text>
          <text class="debug-val" :class="bleStore.connected ? 'ok' : 'off'">
            {{ bleStore.connected ? '已连接' : '未连接' }}
          </text>
        </view>
        <view class="debug-row">
          <text class="debug-label">前台服务</text>
          <text class="debug-val" :class="fgActive ? 'ok' : 'off'">
            {{ fgText }}
          </text>
        </view>
        <view class="debug-row">
          <text class="debug-label">已知设备</text>
          <text class="debug-val">{{ knownDevice || '无' }}</text>
        </view>
      </view>

      <view class="debug-divider" />

      <view class="debug-section">
        <view class="debug-row">
          <text class="debug-label">亮屏</text>
          <text class="debug-val">{{ fmtAgo(state.lastScreenOnTime) }}</text>
        </view>
        <view class="debug-row">
          <text class="debug-label">发现设备</text>
          <text class="debug-val">{{ lastFoundText }}</text>
        </view>
        <view class="debug-row">
          <text class="debug-label">重连结果</text>
          <text class="debug-val" :class="lastReconnectClass">
            {{ lastReconnectText }}
          </text>
        </view>
      </view>

      <view class="debug-divider" />

      <scroll-view class="debug-logs" scroll-y>
        <view v-for="(log, idx) in state.logs.slice(0, 8)" :key="idx" class="debug-log-line">
          <text class="debug-log-time">{{ log.time }}</text>
          <text class="debug-log-text" :class="log.type">{{ log.text }}</text>
        </view>
      </scroll-view>
    </view>

    <!-- 收起态：小圆点 -->
    <view v-else class="debug-bubble" @click="toggle">
      <text class="debug-bubble-text">DEV</text>
    </view>
  </view>
</template>

<script setup>
import { computed } from 'vue'
import { useBleStore } from '@/stores/ble.js'
import {
  debugState,
  toggleDebugPanel,
  closeDebugPanel,
  fmtAgo,
} from '@/utils/debug-panel.js'

const state = debugState
const bleStore = useBleStore()

const toggle = () => toggleDebugPanel()
const close = () => closeDebugPanel()

const fgActive = computed(() => state.foregroundStatus?.active || bleStore._foregroundServiceActive || false)
const fgText = computed(() => {
  if (state.foregroundStatus?.active || bleStore._foregroundServiceActive) {
    const isNative = state.foregroundStatus?.native || bleStore._foregroundServiceNative
    return isNative ? '原生 ✓' : 'JS ✓'
  }
  return '未启动'
})

const knownDevice = computed(() => {
  const id = bleStore.deviceId || uni.getStorageSync('ble_device_id') || ''
  return id
})

const lastFoundText = computed(() => {
  const d = state.lastDeviceFound
  if (!d) return '--'
  return `${d.name || '?'} ${d.rssi}dBm (${fmtAgo(d.time)})`
})

const lastReconnectText = computed(() => {
  const r = state.lastReconnectResult
  if (!r) return '--'
  return `${r.ok ? '✓' : '✗'} ${r.text} (${fmtAgo(r.time)})`
})

const lastReconnectClass = computed(() => {
  const r = state.lastReconnectResult
  return r?.ok ? 'ok' : (r ? 'error' : '')
})
</script>

<style scoped>
.debug-float-root {
  position: fixed;
  right: 24rpx;
  bottom: 160rpx; /* 避开 TabBar */
  z-index: 99999;
  max-width: 520rpx;
}

.debug-float-root.collapsed {
  max-width: auto;
  width: auto;
}

.debug-panel {
  background: rgba(0, 0, 0, 0.82);
  border: 1rpx solid rgba(255, 255, 255, 0.18);
  border-radius: 16rpx;
  padding: 16rpx;
  box-shadow: 0 8rpx 24rpx rgba(0, 0, 0, 0.45);
  backdrop-filter: blur(6rpx);
  min-width: 360rpx;
}

.debug-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 12rpx;
}

.debug-title {
  font-size: 22rpx;
  font-weight: 700;
  color: #ffdd00;
  letter-spacing: 1rpx;
}

.debug-actions {
  display: flex;
  align-items: center;
  gap: 16rpx;
}

.debug-btn {
  font-size: 20rpx;
  color: #aaccff;
  padding: 4rpx 8rpx;
}

.debug-btn-close {
  font-size: 28rpx;
  color: #ff8888;
  font-weight: 700;
}

.debug-section {
  margin-bottom: 8rpx;
}

.debug-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 4rpx 0;
  font-size: 22rpx;
  line-height: 1.35;
}

.debug-label {
  color: #99aabb;
  flex-shrink: 0;
  margin-right: 16rpx;
}

.debug-val {
  color: #ffffff;
  text-align: right;
  word-break: break-all;
  max-width: 320rpx;
}

.debug-val.ok { color: #00ff88; }
.debug-val.off { color: #ff8888; }
.debug-val.error { color: #ff5555; }

.debug-divider {
  height: 1rpx;
  background: rgba(255, 255, 255, 0.12);
  margin: 8rpx 0;
}

.debug-logs {
  max-height: 220rpx;
  margin-top: 4rpx;
}

.debug-log-line {
  display: flex;
  font-size: 18rpx;
  line-height: 1.4;
  padding: 2rpx 0;
  color: #ccddee;
}

.debug-log-time {
  color: #8899aa;
  margin-right: 10rpx;
  flex-shrink: 0;
}

.debug-log-text { word-break: break-all; }
.debug-log-text.success { color: #00ff88; }
.debug-log-text.error { color: #ff8888; }
.debug-log-text.warning { color: #ffaa00; }
.debug-log-text.screen { color: #00d4ff; }
.debug-log-text.device { color: #ffdd00; }

.debug-bubble {
  width: 84rpx;
  height: 84rpx;
  border-radius: 50%;
  background: rgba(0, 0, 0, 0.75);
  border: 1rpx solid rgba(255, 221, 0, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: 0 4rpx 16rpx rgba(0, 0, 0, 0.4);
}

.debug-bubble-text {
  font-size: 20rpx;
  color: #ffdd00;
  font-weight: 700;
}
</style>
