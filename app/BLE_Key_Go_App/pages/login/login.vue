<template>
  <view class="login-container" :class="themeClass">
    <!-- 头部 -->
    <view class="login-header">
      <text class="login-logo">🔑</text>
      <text class="login-title">BLE KeyGo</text>
      <text class="login-subtitle">使用帮助 · 快速指南</text>
    </view>

    <!-- 快速指南卡片 -->
    <view class="login-card">
      <text class="card-title">📖 快速指南</text>

      <view class="guide-steps">
        <view class="guide-step">
          <text class="step-num">1</text>
          <view class="step-content">
            <text class="step-title">首次连接</text>
            <text class="step-desc">打开「连接」页 → 扫描设备 → 点击连接 → 手机弹出配对框 → 输入 PIN</text>
          </view>
        </view>

        <view class="guide-step">
          <text class="step-num">2</text>
          <view class="step-content">
            <text class="step-title">输入配对 PIN</text>
            <text class="step-desc">默认 PIN: <text class="highlight">123456</text>（建议首次配对后修改）</text>
          </view>
        </view>

        <view class="guide-step">
          <text class="step-num">3</text>
          <view class="step-content">
            <text class="step-title">自动连接</text>
            <text class="step-desc">配对成功后，打开 App 自动连接，无需任何操作</text>
          </view>
        </view>

        <view class="guide-step">
          <text class="step-num">4</text>
          <view class="step-content">
            <text class="step-title">恢复出厂</text>
            <text class="step-desc">长按设备按键 5 秒恢复出厂设置，所有参数恢复默认</text>
          </view>
        </view>
      </view>
    </view>

    <!-- 物理按键说明 -->
    <view class="login-card" style="margin-top: 24rpx;">
      <text class="card-title">🔘 设备物理按键</text>
      <view class="info-rows">
        <view class="info-row">
          <text class="info-label">&gt;5s 长按</text>
          <text class="info-val">恢复出厂设置（所有配置参数恢复默认）</text>
        </view>
      </view>
    </view>

    <!-- BLE Bonding 说明 -->
    <view class="login-card" style="margin-top: 24rpx;">
      <text class="card-title">🔒 BLE Bonding 安全</text>
      <view class="info-tip">
        <text class="tip-icon">✅</text>
        <text class="tip-text">BLE 链路层加密，符合 Apple CarKey / 车载蓝牙标准</text>
      </view>
      <view class="info-tip">
        <text class="tip-icon">✅</text>
        <text class="tip-text">配对密钥持久化，无需记密码，无需联网</text>
      </view>
      <view class="info-tip">
        <text class="tip-icon">✅</text>
        <text class="tip-text">PIN 仅用于首次配对，配对后密钥存在手机安全芯片中</text>
      </view>
    </view>

    <!-- 主题切换 -->
    <view class="login-card theme-card" style="margin-top: 24rpx;">
      <text class="card-title">🎨 外观主题</text>
      <view class="theme-options">
        <view
          v-for="opt in themeOptions"
          :key="opt.value"
          :class="['theme-option', { active: themeStore.mode === opt.value }]"
          @tap="themeStore.setMode(opt.value)"
        >
          <text class="theme-option-icon">{{ opt.icon }}</text>
          <text class="theme-option-label">{{ opt.label }}</text>
        </view>
      </view>
      <text class="theme-hint">
        当前生效：{{ themeStore.isDark ? '🌙 深色模式' : '☀️ 浅色模式' }}
        <text v-if="themeStore.mode === 'auto'">（跟随系统）</text>
      </text>
    </view>

    <!-- 底部 -->
    <view class="login-footer">
      <text class="footer-text">BLE KeyGo v3.2 · 纯本地 · 安全可靠</text>
      <text class="footer-ver">Built on uni-app</text>
    </view>
  </view>
</template>

<script setup>
import { ref, computed } from 'vue'
import { onShow } from '@dcloudio/uni-app'
import { useThemeStore } from '@/stores/theme.js'

const themeStore = useThemeStore()
const themeClass = computed(() => themeStore.themeClass)

onShow(() => {
  themeStore.applyNavBar()
})

const themeOptions = ref([
  { value: 'light', label: '浅色', icon: '☀️' },
  { value: 'dark', label: '深色', icon: '🌙' },
  { value: 'auto', label: '跟随系统', icon: '🔄' },
])
</script>

<style scoped>
.login-container {
  min-height: 100vh;
  background: var(--login-bg);
  color: var(--text-primary);
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 60rpx 40rpx 30rpx;
  transition: background-color 0.3s, color 0.3s;
}

/* ---- Header ---- */
.login-header {
  display: flex;
  flex-direction: column;
  align-items: center;
  margin-bottom: 48rpx;
}

.login-logo { font-size: 80rpx; margin-bottom: 20rpx; }
.login-title { font-size: 44rpx; font-weight: 700; color: var(--text-primary); letter-spacing: 4rpx; }
.login-subtitle { font-size: 24rpx; color: var(--login-sub-color); margin-top: 12rpx; }

/* ---- Card ---- */
.login-card {
  width: 100%;
  max-width: 600rpx;
  background: var(--login-card-bg);
  border: 1rpx solid var(--border);
  border-radius: 24rpx;
  padding: 40rpx;
  backdrop-filter: blur(20rpx);
}

.card-title { font-size: 28rpx; font-weight: 600; color: var(--text-primary); margin-bottom: 24rpx; display: block; }

/* ---- Guide Steps ---- */
.guide-steps { display: flex; flex-direction: column; gap: 24rpx; }
.guide-step { display: flex; gap: 16rpx; align-items: flex-start; }

.step-num {
  width: 48rpx; height: 48rpx; border-radius: 50%;
  background: var(--gradient-accent);
  color: #fff; font-size: 24rpx; font-weight: 700;
  display: flex; align-items: center; justify-content: center;
  flex-shrink: 0;
}

.step-content { flex: 1; }
.step-title { font-size: 26rpx; font-weight: 600; color: var(--login-step-title); display: block; margin-bottom: 4rpx; }
.step-desc { font-size: 22rpx; color: var(--login-step-desc); line-height: 1.5; }
.highlight { color: var(--accent); font-weight: 700; }

/* ---- Info Rows ---- */
.info-rows { display: flex; flex-direction: column; gap: 16rpx; }

.info-row { display: flex; gap: 16rpx; align-items: flex-start; }

.info-label {
  font-size: 22rpx; color: var(--accent); font-weight: 600;
  background: var(--alpha-10); padding: 4rpx 12rpx;
  border-radius: 8rpx; flex-shrink: 0; min-width: 140rpx; text-align: center;
}

.info-val { font-size: 22rpx; color: var(--login-info-val); line-height: 1.6; padding-top: 4rpx; }

/* ---- Info Tips ---- */
.info-tip {
  display: flex; align-items: center; margin-top: 16rpx;
  padding: 12rpx 16rpx; background: var(--alpha-06);
  border-radius: 12rpx;
}

.tip-icon { font-size: 24rpx; margin-right: 12rpx; }
.tip-text { font-size: 22rpx; color: var(--login-tip-text); flex: 1; }

/* ---- 主题切换 ---- */
.theme-options {
  display: flex;
  gap: 12rpx;
  margin-bottom: 16rpx;
}

.theme-option {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6rpx;
  padding: 16rpx 8rpx;
  border-radius: 12rpx;
  border: 2rpx solid var(--border);
  background: var(--bg-card-alt);
  transition: all 0.2s;
}

.theme-option.active {
  border-color: var(--accent);
  background: var(--alpha-10);
}

.theme-option-icon { font-size: 32rpx; }
.theme-option-label { font-size: 22rpx; color: var(--text-secondary); }

.theme-option.active .theme-option-label {
  color: var(--accent);
  font-weight: 600;
}

.theme-hint {
  font-size: 22rpx;
  color: var(--text-tertiary);
  text-align: center;
  display: block;
}

/* ---- Footer ---- */
.login-footer {
  margin-top: auto; padding-top: 60rpx;
  display: flex; flex-direction: column; align-items: center; gap: 8rpx;
}

.footer-text { font-size: 22rpx; color: var(--text-muted); }
.footer-ver { font-size: 20rpx; color: var(--login-footer-ver); }
</style>
