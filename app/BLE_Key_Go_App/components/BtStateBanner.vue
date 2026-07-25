<template>
  <view class="bt-banner-root">
    <!-- ★ 蓝牙关闭横幅（模仿 nRF Connect）：系统弹窗期间保持红色 -->
    <view class="bt-off-banner" v-show="!bleStore.connected && bleStore.btState === 'off'">
      <text class="bt-off-icon">🔴</text>
      <text class="bt-off-text">蓝牙已关闭</text>
      <button class="bt-enable-btn" @tap="handleEnableBluetooth">开启</button>
    </view>
    <!-- ★ 绿色"正在开启"横幅：与底部系统弹窗同步出现/消失，模仿 nRF Connect -->
    <view class="bt-on-banner" v-show="!bleStore.connected && bleStore.btState === 'just_enabled'">
      <text class="bt-on-icon">🟢</text>
      <text class="bt-on-text">正在开启蓝牙...</text>
    </view>
  </view>
</template>

<script setup>
// ★ 原连接页内联横幅抽出的全局组件（方案1，v3.36.3fix11.3）。
// 仅由 main.vue 在「连接页(0) / 控制页(1)」渲染，配置页/帮助页不显示。
// 自身按 btState + connected 决定红/绿/无，开启逻辑与原 index.vue 完全一致。
import { useBleStore } from '@/stores/ble.js'
import { toast } from '@/utils/toast.js'

const bleStore = useBleStore()

// ★ 防止用户在模拟器里死递归弹 Modal
let _enableBluetoothLocked = false

async function handleEnableBluetooth() {
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
