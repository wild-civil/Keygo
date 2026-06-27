<template>
  <view class="app-root">
    <router-view />
    <!-- ★ 自定义 TabBar（仅一份，App.vue 全局渲染） -->
    <CustomTabBar />
  </view>
</template>

<script setup>
import { onLaunch } from '@dcloudio/uni-app'
import CustomTabBar from '@/components/CustomTabBar.vue'

onLaunch(() => {
  console.log('[BLE-Key-Go] App launched')
  // 初始化蓝牙适配器
  uni.openBluetoothAdapter({
    success: () => {
      console.log('[BLE] 蓝牙适配器初始化成功')
    },
    fail: (err) => {
      console.error('[BLE] 蓝牙适配器初始化失败', err)
    }
  })
})
</script>

<style>
page {
  background-color: #0f0f1a;
  color: #e0e0e0;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
}

.app-root {
  min-height: 100vh;
}

/* 全局通用样式 */
button {
  border: none;
  border-radius: 12rpx;
  font-size: 28rpx;
}

button::after {
  border: none;
}
</style>
