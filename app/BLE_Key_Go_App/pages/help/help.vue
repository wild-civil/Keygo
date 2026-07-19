<template>
  <view class="login-container" :class="themeClass">
    <!-- 头部 -->
    <view class="login-header">
      <text class="login-logo">🔑</text>
      <text class="login-title">KeyGo·钥启程</text>
      <text class="login-subtitle">使用帮助 · v3.36.2</text>
    </view>

    <!-- ★ v3.32.2-fix: 快速上手 + 首次绑定向导 合并为一张卡 -->
    <view class="login-card">
      <text class="card-title">🚀 快速上手（首次绑定）</text>

      <view class="guide-steps">
        <view class="guide-step">
          <text class="step-num">1</text>
          <view class="step-content">
            <text class="step-title">开蓝牙 + 定位</text>
            <text class="step-desc">系统蓝牙开启，并授予 App「始终允许」定位权限（后台扫描重连需要）</text>
          </view>
        </view>

        <view class="guide-step">
          <text class="step-num">2</text>
          <view class="step-content">
            <text class="step-title">连接设备</text>
            <text class="step-desc">前往「连接」页扫描，点击你的 KeyGo 设备</text>
          </view>
        </view>

        <view class="guide-step">
          <text class="step-num">3</text>
          <view class="step-content">
            <text class="step-title">选择设备模式</text>
            <text class="step-desc">汽车（解锁/锁车/后备箱）或电瓶车（解锁/锁车/骑行），可在「控制」页底部随时切换</text>
          </view>
        </view>

        <view class="guide-step">
          <text class="step-num">4</text>
          <view class="step-content">
            <text class="step-title">输入绑定码</text>
            <text class="step-desc">默认 <text class="highlight">123456</text>（建议首次绑定后修改）→ 手机弹出系统配对框 → 配对成功 → App 自动完成密钥验证</text>
          </view>
        </view>

        <view class="guide-step">
          <text class="step-num">5</text>
          <view class="step-content">
            <text class="step-title">当钥匙用</text>
            <text class="step-desc">返回「控制」页解锁 / 锁车。重连策略有三档（「我的」→ 重连模式）：舒适（亮屏自动连，默认）/ 极速（GPS+运动感知，通勤无感）/ 手动（纯手动，不自动连）。开启「无App模式」后，即使 App 没运行，手机走近也会由设备自动解锁。</text>
          </view>
        </view>
      </view>
    </view>

    <!-- 物理按键说明 -->
    <view class="login-card" style="margin-top: 24rpx;">
      <text class="card-title">🔘 设备物理按键</text>
      <view class="info-rows">
        <view class="info-row">
          <text class="info-label">8s 长按</text>
          <text class="info-val">恢复出厂设置（所有配置参数恢复默认）。LED 反馈：按住 5 秒后慢闪警示，8 秒后快闪表示已恢复出厂；过程中松开即取消</text>
        </view>
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
	
	<!-- ★ v3.21: 电池优化豁免 -->
	<view class="login-card battery-card" style="margin-top: 24rpx;" @tap="handleBatteryOpt">
	  <view class="battery-row">
	    <text class="card-title">🔋 电池优化豁免</text>
	    <view class="battery-badge" :class="{ ok: batteryOptimized }">
	      <text>{{ batteryOptimized ? '✅ 已豁免' : '⚠️ 未豁免' }}</text>
	    </view>
	  </view>
	  <view class="battery-desc">
	    将 KeyGo 加入电池优化白名单，防止系统休眠后中断蓝牙连接。点击此处可<text class="highlight">随时修改</text>设置。
	  </view>
	  <!-- 操作步骤 -->
	  <view class="battery-steps" v-if="!batteryOptimized">
	    <view class="battery-step-item">
	      <text class="battery-step-num">1</text>
	      <text class="battery-step-text">点击卡片，打开「应用信息」页</text>
	    </view>
	    <view class="battery-step-item">
	      <text class="battery-step-num">2</text>
	      <text class="battery-step-text">找到「耗电详情」或「应用启动管理」</text>
	    </view>
	    <view class="battery-step-item">
	      <text class="battery-step-num">3</text>
	      <text class="battery-step-text">选择「手动管理」→ 开启「允许后台运行」</text>
	    </view>
	  </view>
	  <view class="battery-arrow">→</view>
	</view>

    <!-- ★ Phase 2: 设备模式说明 -->
    <view class="login-card" style="margin-top: 24rpx;">
      <text class="card-title">🚗/🛵 设备模式说明</text>
      <view class="info-rows">
        <view class="info-row"><text class="info-label">汽车</text><text class="info-val">解锁 / 锁车 / 后备箱——适合汽车遥控场景</text></view>
        <view class="info-row"><text class="info-label">电瓶车</text><text class="info-val">解锁 / 锁车 / 骑行（双击）——「骑行」会向车辆输出快速双击脉冲，模拟原遥控双击启动</text></view>
        <view class="info-row"><text class="info-label">靠近进入模式</text><text class="info-val">电瓶车专属：靠近时选择「仅解锁」或「直接骑行」。该偏好存于设备，切到汽车模式时不生效（开关自动隐藏），切回电瓶车后自动恢复</text></view>
      </view>
      <view class="info-tip"><text class="tip-icon">💡</text><text class="tip-text">模式存于设备（DataFlash），可在「控制」页底部随时切换；切换后重启仍保持</text></view>
    </view>

    <!-- ★ v3.36: 无App模式 与 三模式 关系 -->
    <view class="login-card" style="margin-top: 24rpx;">
      <text class="card-title">📡 无App模式 与 重连三模式</text>
      <view class="info-tip">
        <text class="tip-icon">💡</text>
        <text class="tip-text"><b>三模式（舒适/极速/手动）</b>管的是「App 运行时怎么重连设备」，不控制设备级自动解锁。</text>
      </view>
      <view class="info-tip">
        <text class="tip-icon">💡</text>
        <text class="tip-text"><b>无App模式</b>让手机系统把 KeyGo 当成已配对设备，<b>App 关着也能自动解锁</b>（设备级舒适进入）。开启后走近即解锁，与 App 是否运行无关。</text>
      </view>
      <view class="info-tip">
        <text class="tip-icon">⚠️</text>
        <text class="tip-text"><b>撤销某台手机</b>：在<b>自定义基座</b>下，App 内解绑会<b>自动删掉系统蓝牙配对</b>（UNBIND 联动删 SMP 配对），一步到位；<b>标准基座</b>因无原生插件能力，仍需手动在系统蓝牙「忽略此设备」。</text>
      </view>
      <view class="info-tip">
        <text class="tip-icon">🔲</text>
        <text class="tip-text">✅ 已实现（自定义基座）：解绑时自动删系统配对，一步到位（设备侧清 LTK + 手机侧删 OS 配对）。</text>
      </view>
    </view>

    <!-- ★ Phase 2: 常见错误排查 -->
    <view class="login-card" style="margin-top: 24rpx;">
      <text class="card-title">🛠 常见错误排查</text>
      <view class="info-rows">
        <view class="info-row"><text class="info-label">操作太频繁</text><text class="info-val">连点触发，稍候 1~2 秒再试</text></view>
        <view class="info-row"><text class="info-label">指令冲突</text><text class="info-val">蓝牙瞬时写冲突，重试一次即可</text></view>
        <view class="info-row"><text class="info-label">设备未绑定</text><text class="info-val">前往「配置」页绑定，默认码 123456</text></view>
        <view class="info-row"><text class="info-label">验证失败</text><text class="info-val">绑定关系异常，请重新绑定</text></view>
        <view class="info-row"><text class="info-label">发送失败</text><text class="info-val">检查蓝牙是否仍连接，或重连设备</text></view>
        <view class="info-row"><text class="info-label">模式不支持</text><text class="info-val">当前设备模式不支持该操作（如汽车模式点「骑行」）</text></view>
      </view>
    </view>
	
	<!-- BLE Bonding 安全（v3.36.0 实际模型） -->
	<view class="login-card" style="margin-top: 24rpx;">
	  <text class="card-title">🔒 BLE Bonding 安全（v3.36.0）</text>
	  <view class="info-tip">
	    <text class="tip-icon">✅</text>
	    <text class="tip-text">链路层加密（LESC）：配对后密钥(LTK)存芯片 SNV，重连自动加密，无需记密码</text>
	  </view>
	  <view class="info-tip">
	    <text class="tip-icon">✅</text>
	    <text class="tip-text">per-phone 鉴权（授权体系 v1）：每台手机密钥 = HMAC(gk, phoneId)，各不相同，互不可伪造</text>
	  </view>
	  <view class="info-tip">
	    <text class="tip-icon">✅</text>
	    <text class="tip-text">per-phone RSSI 阈值跟随：每台手机的「解锁/锁车阈值」独立保存，各用各的</text>
	  </view>
	  <view class="info-tip">
	    <text class="tip-icon">✅</text>
	    <text class="tip-text">信任列表持久化（DataFlash，最多 8 把钥匙）：绑定关系断电不丢，互不互踢</text>
	  </view>
	  <view class="info-tip">
	    <text class="tip-icon">✅</text>
	    <text class="tip-text">控制指令 C1 签名（per-command HMAC + 会话盐 + 序号）防重放一直开启</text>
	  </view>
	  <view class="info-tip">
	    <text class="tip-icon">🔲</text>
	    <text class="tip-text">✅ UNBIND 联动删系统配对（收口无App撤销缺口，自定义基座已落地）；🔲 多管理员 / 临时授权</text>
	  </view>
	</view>

    <!-- ★ v3.36: 规划中 / 待核对功能 -->
    <view class="login-card" style="margin-top: 24rpx;">
      <text class="card-title">📋 规划中功能（待核对）</text>
      <view class="info-tip">
        <text class="tip-icon">🔲</text>
        <text class="tip-text">多管理员 / 锁定列表（多 owner 精细管理）</text>
      </view>
      <view class="info-tip">
        <text class="tip-icon">🔲</text>
        <text class="tip-text">✅ UNBIND 联动删系统配对（收口无App撤销缺口，自定义基座下解绑自动删 OS 配对，已落地）。</text>
      </view>
      <view class="info-tip">
        <text class="tip-icon">🔲</text>
        <text class="tip-text">极速模式 GPS 围栏真机落地（框架已搭，无 GMS 设备自动降级舒适模式）</text>
      </view>
      <view class="info-tip">
        <text class="tip-icon">🔲</text>
        <text class="tip-text">配置(uc/lc/阈值)断电持久化一致性（当前仅 cooldown 变化才落盘，重启可能回退）</text>
      </view>
      <view class="info-tip">
        <text class="tip-icon">🔲</text>
        <text class="tip-text">带屏设备 LESC+MITM passkey、远程临时授权</text>
      </view>
    </view>

    <!-- 底部 -->
    <view class="login-footer">
      <text class="footer-text">BLE KeyGo v3.36.2 · 纯本地 · 安全可靠</text>
      <text class="footer-ver">Built on uni-app</text>
    </view>
  </view>
</template>

<script setup>
import { ref, computed } from 'vue'
import { onShow } from '@dcloudio/uni-app'
import { useThemeStore } from '@/stores/theme.js'
import {
  isIgnoringBatteryOptimizations,
  openBatteryOptimizationSettings,
} from '@/utils/power-saver.js'

const themeStore = useThemeStore()
const themeClass = computed(() => themeStore.themeClass)

// ★ v3.21: 电池优化豁免状态（必须在 onShow 之前声明）
const batteryOptimized = ref(false)

onShow(() => {
  themeStore.applyNavBar()
  // #ifdef APP-PLUS
  batteryOptimized.value = isIgnoringBatteryOptimizations()
  // #endif
})

const themeOptions = ref([
  { value: 'light', label: '浅色', icon: '☀️' },
  { value: 'dark', label: '深色', icon: '🌙' },
  { value: 'auto', label: '跟随系统', icon: '🔄' },
])

function handleBatteryOpt() {
  // #ifdef APP-PLUS
  uni.setStorageSync('battery_opt_pending', 1)
  openBatteryOptimizationSettings()
  // #endif
}
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

/* ★ v3.21: 电池优化卡片 */
.battery-card {
  position: relative;
  cursor: pointer;
  transition: transform 0.15s, border-color 0.2s;
}

.battery-card:active {
  transform: scale(0.98);
  border-color: var(--accent);
}

.battery-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12rpx;
}

.battery-badge {
  font-size: 20rpx;
  padding: 4rpx 16rpx;
  border-radius: 20rpx;
  background: var(--orange-alpha-27);
  color: var(--accent-orange);
}

.battery-badge.ok {
  background: var(--green-alpha-27);
  color: var(--accent-green);
}

.battery-desc {
  font-size: 22rpx;
  color: var(--login-step-desc);
  line-height: 1.6;
  padding-right: 40rpx;
}

.battery-steps {
  margin-top: 16rpx;
  padding-top: 16rpx;
  border-top: 1rpx solid var(--border-light);
  display: flex;
  flex-direction: column;
  gap: 10rpx;
}

.battery-step-item {
  display: flex;
  align-items: flex-start;
  gap: 12rpx;
}

.battery-step-num {
  width: 36rpx;
  height: 36rpx;
  border-radius: 50%;
  background: var(--alpha-20);
  color: var(--accent);
  font-size: 20rpx;
  font-weight: 700;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  margin-top: 2rpx;
}

.battery-step-text {
  font-size: 22rpx;
  color: var(--login-step-desc);
  line-height: 1.5;
  flex: 1;
}

.battery-arrow {
  position: absolute;
  right: 40rpx;
  top: 50%;
  transform: translateY(-50%);
  font-size: 32rpx;
  color: var(--text-muted);
}

/* ---- Footer ---- */
.login-footer {
  margin-top: auto; padding-top: 60rpx;
  display: flex; flex-direction: column; align-items: center; gap: 8rpx;
}

.footer-text { font-size: 22rpx; color: var(--text-muted); }
.footer-ver { font-size: 20rpx; color: var(--login-footer-ver); }
</style>
