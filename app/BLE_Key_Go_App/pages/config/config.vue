<template>
  <view class="page-config" :class="themeClass">

    <!-- 基座状态横幅：标准基座不支持 App 原生系统配对，但无App模式由固件发起配对，两者皆可用 -->
    <view
      v-if="!pluginReady"
      style="margin:12rpx 24rpx 4rpx;padding:18rpx 20rpx;border-radius:12rpx;background:#fff7ed;border:1rpx solid #fed7aa;color:#9a3412;font-size:24rpx;line-height:1.5;"
    >
      🟠 标准基座：App 原生配对不可用，但「无 App 模式」由设备端发起系统配对，照常可用。
    </view>
    <view
      v-else
      style="margin:12rpx 24rpx 4rpx;padding:18rpx 20rpx;border-radius:12rpx;background:#ecfdf3;border:1rpx solid #a7f3d0;color:#047857;font-size:24rpx;line-height:1.5;"
    >
      🟢 自定义基座：原生插件已加载，系统配对弹窗可用。
    </view>

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
          <text class="mode-desc">解锁手机即可自动连接，零后台功耗</text>
          <text class="mode-power">仅亮屏时触发扫描，几乎无额外耗电</text>
        </view>

        <view class="mode-card"
          :class="{ active: bleStore.autoReconnectMode === 'manual' }"
          @tap="handleModeChange('manual')">
          <view class="mode-card-header">
            <text class="mode-icon">🖐️</text>
            <text class="mode-name">手动模式</text>
            <text class="mode-badge" v-if="bleStore.autoReconnectMode === 'manual'">当前</text>
          </view>
          <text class="mode-desc">完全手动，不自动解锁车、断连也不自动锁车</text>
          <text class="mode-power">适合露营等贴身场景，后台零功耗、由你点按钮控制</text>
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

      <!-- ★ v3.24-fixb: 设备自动锁状态可视化（来自 FF02 al 字段，确认模式真正下发到固件） -->
      <view class="autolock-status" v-if="bleStore.connected">
        <text class="al-label">🔒 设备自动锁</text>
        <text class="al-value" :class="autoLockClass">{{ autoLockText }}</text>
        <text class="al-hint" v-if="bleStore.autoReconnectMode === 'manual' && bleStore.autoLockEnabled === 0">
          手动模式已生效，RSSI 抖动不会自动解锁/上锁
        </text>
        <text class="al-hint" v-else-if="bleStore.autoReconnectMode === 'manual' && bleStore.autoLockEnabled !== 0">
          未生效：请确认已连接，或重新进入手动模式以下发配置
        </text>
      </view>

      <!-- ★ v3.23 Phase 3: 极速模式围栏信息 -->
      <view class="geofence-info" v-if="bleStore.autoReconnectMode === 'speed' && parkingInfo">
        <view class="geofence-row">
          <text class="geofence-label">📍 停车位置</text>
          <text class="geofence-dist-inline" v-if="geofenceDistText">{{ geofenceDistText }}</text>
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
      <view class="config-desc" style="margin: 0 0 10px; color: #6b7280;">{{ confirmHint }}</view>

      <view class="config-item">
        <view class="config-header">
          <text class="config-label">📊 连接页显示确认进度条</text>
		  <switch :checked="localConfig.showProgress" @change="onToggleProgress" color="#3b82f6" style="transform: scale(0.7);" />
        </view>
        <view class="config-desc">开启后，连接页会在走近/走远时显示「解锁/锁车进度 N/总」（需固件 v3.31+ 上报进度）</view>
        <!-- <switch :checked="localConfig.showProgress" @change="onToggleProgress" color="#3b82f6" style="transform: scale(0.7);" /> -->
      </view>

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
          :disabled="bleStore.autoReconnectMode === 'manual'"
          block-size="24" />
        <view class="slider-labels">
          <text>0</text>
          <text>30s</text>
        </view>
        <view v-if="bleStore.autoReconnectMode === 'manual'" class="config-desc config-disabled-hint">
          ⚙️ 手动模式下断连自动锁已禁用，此设置不生效（固件收到 autolock=0 后跳过断连自动锁）
        </view>
      </view>

      <!-- ★ 2026-07-16: 无 App 模式（固件 SMP 加密门控，基座无关，推荐） -->
      <view class="section-title">🔓 无 App 模式（舒适进入）</view>
      <view class="config-item">
        <view class="config-header">
          <text class="config-label">启用无 App 模式</text>
          <!-- ★ uni-app 原生 switch 不响应 :checked/:key 程序化变更，改用纯 CSS toggle，由 Vue :class 驱动，100% 响应式 -->
          <view class="toggle-track" :class="{ 'toggle-on': noAppMode }" @tap="onTapNoAppMode">
            <view class="toggle-knob" :class="{ 'toggle-knob-on': noAppMode }"></view>
          </view>
        </view>
        <view class="config-desc">开启后，固件在（重）连时主动发起系统配对，手机弹「输入配对码」窗，输入下方<text style="font-weight:bold;">系统配对码</text> → 系统级加密重连。配对成功后无需打开 App、揣兜里即可自动解锁（耳机体验），标准/自定义基座均可。</view>
        <view class="config-desc">关闭（默认）则回到明文 BIND+AUTH，任何手机/基座可用，但需 App 在前台或后台维持连接才能解锁。</view>
        <view class="config-desc config-disabled-hint" v-if="!bleStore.connected">⚠️ 需先连接设备才能切换（开关状态由设备实时回灌）。</view>
        <view class="config-desc config-disabled-hint" v-else-if="bleStore.fwSec < 1">⚠️ 当前固件较旧，可能不支持无 App 模式（需固件 ≥ 3.33.4）。</view>
      </view>
      <view class="config-item">
        <view class="config-header">
          <text class="config-label">系统配对码（6 位数字）</text>
          <input
            class="passcode-input"
            type="number"
            maxlength="6"
            v-model="sysPasscode"
            placeholder="123456"
            @blur="onPasscodeBlur"
            @confirm="onPasscodeBlur"
            style="width:200rpx;text-align:right;font-size:26rpx;border:1rpx solid #d1d5db;border-radius:8rpx;padding:6rpx 12rpx;" />
        </view>
        <view class="config-desc">仅用于无 App 模式的系统层配对（确认是你的手机），<text style="font-weight:bold;">与绑定码完全独立</text>。开启无 App 模式时下发，之后断重连系统弹窗请输入此码。首次配对即生效；已配对后想改码，需先在手机系统蓝牙里「忽略此设备」再重连才会重新弹窗。</view>
      </view>

      <!-- ★ 设备绑定：抽出为独立 BindModal 弹窗（fixed 覆盖层，脱离 swiper/scroll-view
           文档流，input 可靠）。配置页此处仅显示状态与入口，实际操作在弹窗内完成。 -->
      <view class="divider"></view>
      <view class="section-title">🔐 设备绑定（应用层鉴权）</view>
      <view class="config-desc">已连接设备固件版本：<text class="fw-ver">{{ bleStore.fwVersion || '未知' }}</text>
        <text v-if="!bleStore.fwVersion" class="fw-warn">（未读到版本，先连接设备）</text>
        <text v-else-if="isFirmwareAtLeast(bleStore.fwVersion)" class="fw-ok">（✅ 新固件，支持延迟发送回包，可正常绑定）</text>
        <text v-else class="fw-warn">（⚠️ 固件过旧，绑定时回包易丢失，建议升级到 ≥3.30.2）</text></view>

      <view class="bind-status" :class="bindStatusClass">
        <text class="bind-dot">●</text>
        <text class="bind-text">{{ bindStatusText }}</text>
      </view>

      <button class="btn-bind" style="margin-top:20rpx;" @tap="openBindModal">
        {{ bleStore.isBound ? '管理绑定 / 重新绑定' : '去绑定设备' }}
      </button>

      <!-- ★ v3.25: 未保存修改提示（草稿态） -->
      <view class="unsaved-tip" v-if="isDirty">
        <text class="unsaved-icon">⚠️</text>
        <text class="unsaved-text">有未下发的修改，设备不会生效。点击「下发配置到设备」保存，或离开本页将自动丢弃。</text>
      </view>

      <!-- 下发配置按钮 -->
      <view class="submit-section">
        <button class="btn-submit" :class="{ dirty: isDirty }" @tap="handleSubmit" :disabled="!bleStore.connected">
          下发配置到设备
        </button>
        <text class="submit-hint">阈值/确认次数/间隔/断连续锁 → 保存到手机本地（每台 KeyGo 设备独立配置）</text>
      </view>
    </template>

    <!-- ★ 设备绑定弹窗（fixed 覆盖层，脱离 swiper，input 可靠） -->
    <BindModal :visible="bindModalVisible" @close="bindModalVisible = false" />
  </view>
</template>

<script setup>
import { reactive, ref, computed, watch } from 'vue'
import { onShow } from '@dcloudio/uni-app'
import { useBleStore } from '@/stores/ble.js'
import { useThemeStore } from '@/stores/theme.js'
import { toast } from '@/utils/toast.js'
import BindModal from '@/components/BindModal.vue'
// ★ v3.23 Phase 3: 地理围栏工具
import { getParkingLocation, GEOFENCE_RADIUS, isGeofenceMonitorActive } from '@/utils/geofence.js'
// ★ v3.32.2-fix③: 固件版本比较（判断是否 ≥3.30.2 支持延迟发送回包）
import { isFirmwareAtLeast } from '@/utils/firmware.js'

const bleStore = useBleStore()
const themeStore = useThemeStore()
const themeClass = computed(() => themeStore.themeClass)

// ★ 2026-07-16: 无 App 模式开关（固件 ENCRYPT 门控，基座无关）
const noAppMode = computed(() => bleStore.noAppMode)
const sysPasscode = ref(uni.getStorageSync('keygo_sys_passcode') || '123456')
const pluginReady = ref(false)
async function onToggleNoAppMode(e) {
  const on = e.detail.value
  if (on) {
    const code = (sysPasscode.value || '').trim()
    if (!/^\d{6}$/.test(code)) {
      uni.showToast({ title: '系统配对码需为 6 位数字', icon: 'none' })
      bleStore.setNoAppMode(false)   // 回退开关
      return
    }
    // 先下发系统配对码（与绑定码独立），再开启无 App 模式
    const ok = await bleStore.setSysPasscode(code)
    if (!ok) {
      uni.showToast({ title: '系统配对码下发失败', icon: 'none' })
      bleStore.setNoAppMode(false)
      return
    }
    uni.showToast({ title: '系统配对码已设为 ' + code + '，断开重连后请在系统弹窗输入它', icon: 'none', duration: 3000 })
  }
  bleStore.setNoAppMode(on)
}

// ★ 自定义 toggle 点击封装（替代原生 switch @change，避免原生组件不响应程序化 :checked 的坑）
function onTapNoAppMode() {
  onToggleNoAppMode({ detail: { value: !bleStore.noAppMode } })
}

// ★ 系统配对码失焦/回车校验：若不是 6 位数字（不足 6 位或含字符），提示并联动关闭无 App 模式
//   ★ 修复：Android 软键盘「完成」会同时派发 @blur 与 @confirm，导致本函数同帧执行两次
//     —— 第1次关开关并吐「已关闭」toast，第2次已读到 false 走 else 分支把 toast 覆盖成无后缀版。
//     加重入守卫（400ms）只在首次触发时处理，避免双触发产生的错误 toast/竞态。
let _passcodeBlurGuard = 0
function onPasscodeBlur() {
  const _now = Date.now()
  if (_now - _passcodeBlurGuard < 400) return
  _passcodeBlurGuard = _now
  const code = (sysPasscode.value || '').trim()
  try { uni.setStorageSync('keygo_sys_passcode', code) } catch (e) { /* 忽略 */ }
  if (!/^\d{6}$/.test(code)) {
    if (bleStore.noAppMode) {
      console.log('[无App] 配对码非法(' + code + ')，关闭无 App 模式')
      bleStore.setNoAppMode(false)
      uni.showToast({ title: '系统配对码需为 6 位数字，已关闭无 App 模式', icon: 'none' })
    } else {
      uni.showToast({ title: '系统配对码需为 6 位数字', icon: 'none' })
    }
  }
}

// ★ 设备绑定弹窗（fixed 覆盖层，脱离 swiper/scroll-view 文档流，input 可靠）
const bindModalVisible = ref(false)
function openBindModal() {
  if (!bleStore.connected) {
    toast.info('请先连接设备')
    return
  }
  bindModalVisible.value = true
}

// ★ 2026-07-14: 设备复位/被其他手机解绑后，store 置 needsRebind → 自动弹首绑界面
watch(() => bleStore.needsRebind, (v) => {
  if (v && bleStore.connected) {
    bleStore.needsRebind = false
    bindModalVisible.value = true
  }
})

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
  showProgress: true,  // ★ v3.31 方案B-修正: 连接页「确认进度」卡片开关（手机端偏好）
})

// ★ v3.25: 切回页面时用于强制 slider 重渲染的计数（解决 uni-app slider 非受控不回弹）
const configReloadKey = ref(0)

// ★ v3.25: 草稿态检测 —— localConfig(编辑草稿) 是否偏离 store(已下发/已保存) 的值
const isDirty = computed(() => {
  return localConfig.unlock !== bleStore.unlockThreshold
    || localConfig.lock !== bleStore.lockThreshold
    || localConfig.uc !== bleStore.unlockCountRequired
    || localConfig.lc !== bleStore.lockCountRequired
    || localConfig.interval !== (bleStore.rssiReadPeriodMs || 500)
    || localConfig.dlock !== bleStore.disconnectLockDelayMs
    || localConfig.kr !== (bleStore.kalmanR || 15)
    || localConfig.showProgress !== bleStore.showProgressCard
})

// ★ v3.31.0 / 2026-07-13: 把「确认次数(样本数)」换算成用户能直接理解的语义。
//   固件 uc/lc 字面 = 连续几次滤波 RSSI 在阈值内；时间 = 次数 × 采样间隔(interval)。
//   采样间隔与 App 显示节流同源，故手机改「固件 RSSI 读取间隔」会同步影响这里的换算。
const confirmHint = computed(() => {
  const ms = localConfig.interval || 500
  const ucSec = (localConfig.uc * ms / 1000)
  const lcSec = (localConfig.lc * ms / 1000)
  return `解锁确认 ${localConfig.uc} 次 = 需连续 ${localConfig.uc} 次滤波 RSSI 在阈值内 ≈ ${ucSec.toFixed(1)}s；` +
         `锁车确认 ${localConfig.lc} 次 ≈ ${lcSec.toFixed(1)}s（采样间隔 ${ms}ms）`
})

// ★ v3.25: 配置页以 swiper 组件形式嵌入 main.vue，切 tab 只改 tabIndex、不触发页面生命周期，
//   故由 main 传入 active(是否为当前配置 tab) 来感知「进入/离开配置 tab」。
const props = defineProps({
  active: { type: Boolean, default: true },
})

// ★ v3.25: 用 store 已保存值重建编辑态（即丢弃草稿）。
//   Object.assign 保证响应式覆盖；configReloadKey++ 强制 slider 重渲染到正确 value
//   （uni-app slider 非受控，仅靠 :value 不回弹）
function resetToSaved() {
  Object.assign(localConfig, {
    unlock: bleStore.unlockThreshold,
    lock: bleStore.lockThreshold,
    uc: bleStore.unlockCountRequired,
    lc: bleStore.lockCountRequired,
    interval: bleStore.rssiReadPeriodMs || 500,
    dlock: bleStore.disconnectLockDelayMs,
    kr: bleStore.kalmanR || 15,
    showProgress: bleStore.showProgressCard,
  })
  configReloadKey.value++
}

// ★ v3.25: 离开配置 tab(active true→false) 即丢弃草稿并提示；
//   进入/回到配置 tab(false→true) 静默重置为已保存值；
//   锁屏/切后台(active 不变) 保留草稿。immediate 处理首次挂载同步。
watch(() => props.active, (now, was) => {
  if (now === was) return
  // ★ BugFix: 传入 SN 才能读设备专属配置 ble_config_v1_{SN}
  bleStore._restoreConfig(bleStore.serialNumber || undefined)
  if (!now) {
    if (was === true && isDirty.value) toast.info('已撤销未保存的修改')
    resetToSaved()
  } else {
    resetToSaved()
  }
}, { immediate: true })

onShow(() => {
  themeStore.applyNavBar()
  // ★ 2026-07-15: 探测原生插件是否可用（决定 passkey 开关的警告提示）
  try { pluginReady.value = !!uni.requireNativePlugin('Keygo-Foreground') } catch (e) { pluginReady.value = false }
  // ★ BugFix: 传入 SN 才能读设备专属配置 ble_config_v1_{SN}
  //   不传 SN 只会读旧版全局 ble_config_v1，切后台再切回时找不到设备专属配置导致重置为默认值
  bleStore._restoreConfig(bleStore.serialNumber || undefined)
  // ★ v3.25: 切后台再回来(active 仍为 true)不重置 localConfig，保留草稿；
  //   切 tab 的草稿管理由 props.active watch 负责
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

// ★ v3.24-fixb: 设备自动锁状态文案（来自 FF02 al 字段）
const autoLockText = computed(() => {
  const v = bleStore.autoLockEnabled
  if (v === -1) return '同步中…'
  return v === 0 ? '已关闭' : '已开启'
})
const autoLockClass = computed(() => {
  const v = bleStore.autoLockEnabled
  if (v === -1) return 'al-sync'
  return v === 0 ? 'al-off' : 'al-on'
})

const parkingInfo = computed(() => {
  // ★ v3.25-fix: 优先读取 bleStore.parkingLocation（响应式，手动更新后自动刷新）
  const p = bleStore.parkingLocation || getParkingLocation()
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

// ★ v3.25-fix: 实时距离小字显示（读取 bleStore 响应式 geofenceDistance）
// ★ v3.25.2: 增加误差显示
const geofenceDistText = computed(() => {
  if (bleStore.geofenceDistance < 0) return ''
  // ★ DEV-ONLY: 置信度显示，量产前删除`, 1σ` →  若想显示概率，可将其替换为` , 68.2%置信`
  let errSuffix = ''
  const acc = bleStore.geofenceAccuracy
  if (acc > 0 && acc < 999) {
    errSuffix = `(±${Math.round(acc)}m, 1σ)` // `(±${Math.round(acc)}m)`为精度误差
  }
  if (bleStore.geofenceDistance < 10) return `· 已到达 (<10m)`
  if (bleStore.geofenceDistance < 1000) return `· ${bleStore.geofenceDistance}m ${errSuffix}`
  return `· ${(bleStore.geofenceDistance / 1000).toFixed(1)}km ${errSuffix}`
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
watch(() => bleStore.showProgressCard, () => { localConfig.showProgress = bleStore.showProgressCard })

function onUnlockChange(e) { localConfig.unlock = e.detail.value }
function onLockChange(e) { localConfig.lock = e.detail.value }
function onUcChange(delta) { localConfig.uc = Math.max(1, Math.min(20, localConfig.uc + delta)) }
function onLcChange(delta) { localConfig.lc = Math.max(1, Math.min(30, localConfig.lc + delta)) }
function onIntervalChange(e) { localConfig.interval = e.detail.value }
function onDlockChange(e) { localConfig.dlock = e.detail.value }
// ★ v3.31 方案B-修正: 进度条开关是手机端偏好，不入下发配置，直接写 store 并持久化
function onToggleProgress(e) {
  localConfig.showProgress = e.detail.value
  bleStore.showProgressCard = e.detail.value
  bleStore._persistConfig()
}

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







const bindStatusText = computed(() => {
  if (!bleStore.isBound) return '未绑定'
  if (bleStore.sessionAuthed) return '已绑定 · 本连接已验证'
  if (bleStore._autoAuthState === 'running') return '已绑定 · 自动验证中…'
  if (bleStore._autoAuthState === 'failed') return '已绑定 · 验证失败，请重绑'
  return '已绑定 · 连接待验证'
})
const bindStatusClass = computed(() => {
  if (!bleStore.isBound) return 'unbound'
  if (bleStore.sessionAuthed) return 'authed'
  if (bleStore._autoAuthState === 'failed') return 'bound-failed'
  return 'bound'   // running / 待验证 用中性色，避免"待验证"像报错需手动
})



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
/* ★ v3.32.2-fix③: 固件版本文案配色 */
.fw-ver { font-weight: 600; color: var(--text-primary); }
.fw-ok  { color: #2ecc71; }
.fw-warn{ color: #e67e22; }
/* ★ v3.32.2-fix②: 手动模式下滑块置灰提示 */
.config-disabled-hint {
  color: var(--text-muted);
  margin-top: 8rpx;
}
.config-desc .hl {
  color: var(--text-primary);
  font-weight: 600;
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

/* ★ v3.25: 有未保存修改时，按钮高亮提示待下发 */
.btn-submit.dirty {
  box-shadow: 0 0 0 4rpx rgba(255, 68, 136, 0.3);
}

/* ★ v3.25: 未保存修改提示条 */
.unsaved-tip {
  display: flex;
  align-items: flex-start;
  gap: 10rpx;
  background: rgba(230, 126, 34, 0.12);
  border: 1rpx solid rgba(230, 126, 34, 0.4);
  border-radius: 12rpx;
  padding: 16rpx 20rpx;
  margin-bottom: 24rpx;
}

.unsaved-icon {
  font-size: 26rpx;
  line-height: 1.5;
}

.unsaved-text {
  flex: 1;
  font-size: 22rpx;
  color: #e67e22;
  line-height: 1.5;
}

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

/* ★ v3.24-fixb: 设备自动锁状态可视化 */
.autolock-status {
  margin-top: 16rpx;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12rpx;
  background: var(--alpha-06);
  border: 1rpx solid var(--border);
  border-radius: 12rpx;
  padding: 18rpx 22rpx;
}

.al-label {
  font-size: 26rpx;
  color: var(--text);
}

.al-value {
  font-size: 26rpx;
  font-weight: 600;
  padding: 4rpx 16rpx;
  border-radius: 20rpx;
}

.al-on {
  color: #2ecc71;
  background: rgba(46, 204, 113, 0.15);
}

.al-off {
  color: #e67e22;
  background: rgba(230, 126, 34, 0.15);
}

.al-sync {
  color: var(--text-muted);
  background: var(--alpha-05);
}

.al-hint {
  flex-basis: 100%;
  font-size: 22rpx;
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

.geofence-dist-inline {
  font-size: 20rpx;
  color: var(--accent);
  flex: 1;
  margin-left: 8rpx;
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

/* ===== ★ ② 设备绑定 ===== */
.bind-status {
  display: flex;
  align-items: center;
  gap: 12rpx;
  background: var(--alpha-06);
  border: 1rpx solid var(--border);
  border-radius: 12rpx;
  padding: 18rpx 22rpx;
  margin-bottom: 20rpx;
}

.bind-dot {
  font-size: 22rpx;
}

.bind-text {
  font-size: 26rpx;
  font-weight: 600;
}

.bind-status.unbound .bind-dot { color: var(--text-muted); }
.bind-status.unbound .bind-text { color: var(--text-secondary); }
.bind-status.bound .bind-dot { color: #e67e22; }
.bind-status.bound .bind-text { color: #e67e22; }
.bind-status.authed .bind-dot { color: #2ecc71; }
.bind-status.authed .bind-text { color: #2ecc71; }

.bind-input-wrap {
  width: 100%;
}
.bind-input {
  width: 100%;
  background: var(--bg-card);
  border: 2rpx solid var(--border);
  border-radius: 12rpx;
  padding: 20rpx 24rpx;
  font-size: 28rpx;
  color: var(--text-primary);
  margin: 16rpx 0 20rpx;
  box-sizing: border-box;
}

.btn-bind {
  width: 100%;
  background: var(--gradient-accent);
  color: #fff;
  font-size: 28rpx;
  font-weight: 600;
  padding: 24rpx 0;
  border-radius: 14rpx;
}

.btn-bind:active { opacity: 0.8; }
.btn-bind[disabled] { opacity: 0.3; }

.btn-bind-default {
  width: 100%;
  background: transparent;
  color: var(--accent);
  border: 2rpx solid var(--accent);
  font-size: 26rpx;
  font-weight: 600;
  padding: 22rpx 0;
  border-radius: 14rpx;
  margin-top: 16rpx;
}
.btn-bind-default:active { opacity: 0.7; }
.btn-bind-default[disabled] { opacity: 0.3; }

.bind-actions {
  display: flex;
  gap: 20rpx;
  margin-top: 16rpx;
}

.btn-unbind,
.btn-unbind-all {
  flex: 1;
  font-size: 26rpx;
  font-weight: 600;
  padding: 22rpx 0;
  border-radius: 14rpx;
  border: 2rpx solid;
}

.btn-unbind {
  background: transparent;
  color: var(--accent-orange);
  border-color: var(--accent-orange);
}

.btn-unbind-all {
  background: transparent;
  color: #e74c3c;
  border-color: #e74c3c;
}

.btn-unbind:active,
.btn-unbind-all:active { opacity: 0.7; }
.btn-unbind[disabled],
.btn-unbind-all[disabled] { opacity: 0.3; }

.bind-hint {
  font-size: 22rpx;
  color: var(--accent-orange);
  background: rgba(230, 126, 34, 0.1);
  border: 1rpx solid rgba(230, 126, 34, 0.3);
  border-radius: 10rpx;
  padding: 14rpx 18rpx;
  margin-top: 16rpx;
  line-height: 1.5;
}


/* ★ 无 App 模式自定义 toggle（替代原生 switch，纯 View+CSS，响应式可靠） */
.toggle-track {
  width: 88rpx; height: 48rpx;
  background: #d1d5db; border-radius: 24rpx;
  display: flex; align-items: center;
  transition: background 0.2s;
  padding: 4rpx;
}
.toggle-track.toggle-on {
  background: #3b82f6;
}
.toggle-knob {
  width: 40rpx; height: 40rpx;
  background: #fff; border-radius: 20rpx;
  box-shadow: 0 1px 3px rgba(0,0,0,0.2);
  transition: transform 0.2s ease;
}
.toggle-knob-on {
  transform: translateX(40rpx);
}
</style>
