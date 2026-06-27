<template>
  <view class="login-container">
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
            <text class="step-desc">配对成功后，以后打开 App 自动连接，无需任何操作</text>
          </view>
        </view>

        <view class="guide-step">
          <text class="step-num">4</text>
          <view class="step-content">
            <text class="step-title">换手机</text>
            <text class="step-desc">按一下 ESP32 物理按钮（PIN 9）清除绑定，新手机重新配对即可</text>
          </view>
        </view>
      </view>
    </view>

    <!-- 物理按键说明 -->
    <view class="login-card" style="margin-top: 24rpx;">
      <text class="card-title">🔘 物理按键（ESP32 PIN 9）</text>
      <view class="info-rows">
        <view class="info-row">
          <text class="info-label">短按 (&lt;2s)</text>
          <text class="info-val">删除所有已配对设备（进入配对模式）</text>
        </view>
        <view class="info-row">
          <text class="info-label">长按 (&gt;5s)</text>
          <text class="info-val">恢复出厂设置（PIN + 配置全部重置）</text>
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

    <!-- 底部 -->
    <view class="login-footer">
      <text class="footer-text">BLE KeyGo v3.2 · 纯本地 · 安全可靠</text>
      <text class="footer-ver">Built on ESP32 Arduino BLE + uni-app</text>
    </view>
  </view>
</template>

<script setup>
// v3.2: 纯信息展示页，无需用户登录
</script>

<style scoped>
.login-container {
  min-height: 100vh;
  background: linear-gradient(180deg, #0a0a1a 0%, #1a1a2e 50%, #12122a 100%);
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 60rpx 40rpx;
}

/* ---- Header ---- */
.login-header {
  display: flex;
  flex-direction: column;
  align-items: center;
  margin-bottom: 48rpx;
}

.login-logo { font-size: 80rpx; margin-bottom: 20rpx; }
.login-title { font-size: 44rpx; font-weight: 700; color: #fff; letter-spacing: 4rpx; }
.login-subtitle { font-size: 24rpx; color: #8899bb; margin-top: 12rpx; }

/* ---- Card ---- */
.login-card {
  width: 100%;
  max-width: 600rpx;
  background: rgba(22, 33, 62, 0.8);
  border: 1rpx solid #2a2a5e;
  border-radius: 24rpx;
  padding: 40rpx;
  backdrop-filter: blur(20rpx);
}

.card-title { font-size: 28rpx; font-weight: 600; color: #fff; margin-bottom: 24rpx; display: block; }

/* ---- Guide Steps ---- */
.guide-steps { display: flex; flex-direction: column; gap: 24rpx; }

.guide-step { display: flex; gap: 16rpx; align-items: flex-start; }

.step-num {
  width: 48rpx; height: 48rpx; border-radius: 50%;
  background: linear-gradient(135deg, #00d4ff, #0099cc);
  color: #fff; font-size: 24rpx; font-weight: 700;
  display: flex; align-items: center; justify-content: center;
  flex-shrink: 0;
}

.step-content { flex: 1; }

.step-title { font-size: 26rpx; font-weight: 600; color: #e8edf4; display: block; margin-bottom: 4rpx; }

.step-desc { font-size: 22rpx; color: #8899bb; line-height: 1.5; }

.highlight { color: #00d4ff; font-weight: 700; }

/* ---- Info Rows ---- */
.info-rows { display: flex; flex-direction: column; gap: 16rpx; }

.info-row { display: flex; gap: 16rpx; align-items: flex-start; }

.info-label {
  font-size: 22rpx; color: #00d4ff; font-weight: 600;
  background: rgba(0, 212, 255, 0.1); padding: 4rpx 12rpx;
  border-radius: 8rpx; flex-shrink: 0; min-width: 140rpx; text-align: center;
}

.info-val { font-size: 22rpx; color: #8899bb; line-height: 1.6; padding-top: 4rpx; }

/* ---- Info Tips ---- */
.info-tip {
  display: flex; align-items: center; margin-top: 16rpx;
  padding: 12rpx 16rpx; background: rgba(0, 212, 255, 0.06);
  border-radius: 12rpx;
}

.tip-icon { font-size: 24rpx; margin-right: 12rpx; }
.tip-text { font-size: 22rpx; color: #99bbdd; flex: 1; }

/* ---- Footer ---- */
.login-footer {
  margin-top: auto; padding-top: 60rpx;
  display: flex; flex-direction: column; align-items: center; gap: 8rpx;
}

.footer-text { font-size: 22rpx; color: #556677; }
.footer-ver { font-size: 20rpx; color: #445566; }
</style>
