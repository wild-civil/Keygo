<template>
  <view class="bt-banner-root">
    <!-- ★ 蓝牙关闭横幅（模仿 nRF Connect）：系统弹窗期间保持红色 -->
    <!-- ★ 2026-07-25 修复(MP 红绿同显根因): 原 v-show="..." 在自定义组件里被编译为 hidden 属性，
         而微信小程序自定义组件不支持 hidden → v-show 完全失效，红绿 banner 始终渲染。
         改 v-if 彻底从 DOM 移除。App 端 v-show 也兼容（互斥条件本就满足）。 -->
    <view class="bt-off-banner" v-if="!bleStore.connected && bleStore.btState === 'off'">
      <text class="bt-off-icon">🔴</text>
      <text class="bt-off-text">蓝牙已关闭</text>
      <button class="bt-enable-btn" @tap="handleEnableBluetooth">开启</button>
    </view>
    <!-- ★ 绿色"正在开启"横幅：与底部系统弹窗同步出现/消失，模仿 nRF Connect。
         ★ App 与小程序都保留渲染（用户要求双端启用）。just_enabled 仅由 Android 原生广播 /
         requestEnableBluetoothAndroid 赋值（见 stores/ble.js ①+② 运行时门控：非 Android 环境
         绝不设置 just_enabled），故小程序/iOS 下不会误触发，无"红绿同显"风险，不影响功能。 -->
    <view class="bt-on-banner" v-if="!bleStore.connected && bleStore.btState === 'just_enabled'">
      <text class="bt-on-icon">🟢</text>
      <text class="bt-on-text">正在开启蓝牙...</text>
    </view>
  </view>
</template>

<script setup>
// ★ 原连接页内联横幅抽出的全局组件（方案1，v3.36.3fix11.3）。
// 仅由 main.vue 在「连接页(0) / 控制页(1)」渲染，配置页/帮助页不显示。
// 自身按 btState + connected 决定红/绿/无，开启逻辑与原 index.vue 完全一致。
import { watch } from 'vue'
import { useBleStore } from '@/stores/ble.js'
import { toast } from '@/utils/toast.js'

const bleStore = useBleStore()

// ★ [A1-DIAG] 绿 banner 渲染侧诊断：一旦 btState===just_enabled 立即打印（含 plus 信息），
//   用来判定纯 MP 是否真的走到绿 banner，以及此时 plus 是否意外存在。
watch(() => bleStore.btState, (nv) => {
  if (nv === 'just_enabled') {
    console.log('[A1-DIAG][BtBanner] 绿banner渲染 | btState=just_enabled | plus=' + (typeof plus) +
      ' os=' + (typeof plus !== 'undefined' && plus.os ? plus.os.name : '?'))
  }
})

// ★ 防止用户在模拟器里死递归弹 Modal
let _enableBluetoothLocked = false

async function handleEnableBluetooth() {
  // ★ [A1-DIAG] 点击「开启」按钮的入口诊断：确认真机点按钮时 plus 是否存在（区分纯 MP / 基座）
  console.log('[A1-DIAG][BtBanner] 点击开启按钮 | plus=' + (typeof plus) + ' os=' + (typeof plus !== 'undefined' && plus.os ? plus.os.name : '?'))
  if (_enableBluetoothLocked) {
    console.log('[BtBanner] enableBluetooth 防抖，跳过重复调用')
    return
  }

  // #ifdef APP-PLUS
  // ★ App 平台：先申请运行时权限
  if (typeof plus !== 'undefined' && plus.os.name === 'Android') {
    console.log('[BtBanner] ★★★ App-Plus Android，先申请权限 ★★★')
    const perms = ['android.permission.ACCESS_FINE_LOCATION', 'android.permission.ACCESS_COARSE_LOCATION']
    try {
      const VERSION = plus.android.importClass('android.os.Build$VERSION')
      if (VERSION.SDK_INT >= 31) {
        perms.push('android.permission.BLUETOOTH_SCAN', 'android.permission.BLUETOOTH_CONNECT')
      }
    } catch (e) {}

    const permResult = await new Promise((resolve) => {
      plus.android.requestPermissions(perms, resolve, (err) => {
        console.error('[BtBanner] requestPermissions 异常:', JSON.stringify(err))
        resolve({ granted: [], deniedAlways: perms, deniedPresent: [] })
      })
    })
    const denied = (permResult.deniedAlways || []).concat(permResult.deniedPresent || [])
    if (denied.length > 0) {
      uni.showModal({
        title: '需要授予权限',
        content: 'BLE车钥匙需要「位置信息」权限才能扫描蓝牙设备。\n\n请前往系统设置中开启定位权限。',
        confirmText: '去设置',
        cancelText: '取消',
        success: (res) => {
          if (res.confirm) {
            const Intent = plus.android.importClass('android.content.Intent')
            const Settings = plus.android.importClass('android.provider.Settings')
            const Uri = plus.android.importClass('android.net.Uri')
            const main = plus.android.runtimeMainActivity()
            const intent = new Intent()
            intent.setAction(Settings.ACTION_APPLICATION_DETAILS_SETTINGS)
            intent.setData(Uri.parse('package:' + main.getPackageName()))
            main.startActivity(intent)
          }
        }
      })
      return
    }
    console.log('[BtBanner] 权限已通过 ✓')
  }
  // #endif

  // ★ 模仿 nRF Connect: 不显示 loading toast，让系统蓝牙弹窗直接弹出
  //   用户看到的是: 红色 banner → 点击"开启" → 蓝色"正在开启"banner → 系统底窗
  //   不做任何中间提示，不遮挡系统弹窗
  try {
    const ok = await bleStore.enableBluetooth()
    if (ok) {
      if (!bleStore.connected) {
        bleStore.tryAutoConnect()
      }
    } else {
      // btState 已经反映真实状态，banner 会自然切换，不额外 toast
    }
  } catch (err) {
    const msg = String(err?.errMsg || err?.message || err || '')
    const code = err?.code ?? err?.errCode

    // #ifdef APP-PLUS
    // ★ code=10001: 原生弹窗被拒绝/超时 → btState 已是 'off'，红 banner 自然保持，不弹额外 Modal
    if (code === 10001 || msg.includes('not available')) {
      // 静默：btState 已经是 'off'，红色 banner 会保持显示，不打扰用户
    } else if (msg.includes('timeout') || msg.includes('超时')) {
      toast.info('操作超时，请检查蓝牙后重试')
    } else if (code === 'PERMISSION_DENIED') {
      uni.showModal({
        title: '权限不足',
        content: 'BLE车钥匙需要「位置信息」权限。\n\n请到系统设置中授权后重新打开 App。',
        confirmText: '知道了'
      })
    } else {
      toast.error('蓝牙开启失败: ' + (msg || code))
    }
    // #endif
    // #ifndef APP-PLUS
    if (code === 10001 || msg.includes('not available')) {
      // 静默：btState 已经是 'off'，红色 banner 保持显示
    } else {
      toast.error('蓝牙开启失败')
    }
    // #endif
  }
}
</script>

<style scoped>
.bt-banner-root {
  flex-shrink: 0;
}

/* ===== 蓝牙关闭横幅（模仿 nRF Connect） ===== */
.bt-off-banner {
  background: #FFF3F3;
  border: 1rpx solid #FFCDD2;
  border-radius: 12rpx;
  padding: 20rpx 24rpx;
  display: flex;
  align-items: center;
  gap: 12rpx;
  margin: 16rpx 24rpx 12rpx;
  min-height: 72rpx;
  box-sizing: border-box;
}

.bt-off-icon { font-size: 28rpx; }

.bt-off-text {
  flex: 1;
  font-size: 26rpx;
  color: #D32F2F;
  font-weight: 500;
}

.bt-enable-btn {
  background: #D32F2F;
  color: #fff;
  font-size: 24rpx;
  padding: 8rpx 28rpx;
  border-radius: 20rpx;
  border: none;
}

/* 绿色成功 banner — 用户允许开启蓝牙后短暂显示，1.5s 后自动消失 */
.bt-on-banner {
  background: #E8F5E9;
  border: 1rpx solid #A5D6A7;
  border-radius: 12rpx;
  padding: 20rpx 24rpx;
  display: flex;
  align-items: center;
  gap: 12rpx;
  margin: 16rpx 24rpx 12rpx;
  min-height: 72rpx;
  box-sizing: border-box;
  animation: bt-on-fadein 0.3s ease;
}

@keyframes bt-on-fadein {
  from { opacity: 0; transform: translateY(-8rpx); }
  to   { opacity: 1; transform: translateY(0); }
}

.bt-on-icon { font-size: 28rpx; }

.bt-on-text {
  flex: 1;
  font-size: 26rpx;
  color: #2E7D32;
  font-weight: 600;
}
</style>
