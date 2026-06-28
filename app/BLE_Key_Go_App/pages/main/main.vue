<template>
  <view class="main-root" :class="themeClass">
    <!-- ★ swiper 承载 4 个 tab 页面，支持平滑滑动切换 -->
    <swiper
      class="tab-swiper"
      :current="tabIndex"
      duration="300"
      easing-function="easeOutCubic"
      @change="onSwiperChange"
    >
      <swiper-item>
        <scroll-view scroll-y class="swiper-scroll">
          <IndexPage />
        </scroll-view>
      </swiper-item>
      <swiper-item>
        <scroll-view scroll-y class="swiper-scroll">
          <ControlPage />
        </scroll-view>
      </swiper-item>
      <swiper-item>
        <scroll-view scroll-y class="swiper-scroll">
          <ConfigPage />
        </scroll-view>
      </swiper-item>
      <swiper-item>
        <scroll-view scroll-y class="swiper-scroll">
          <LoginPage />
        </scroll-view>
      </swiper-item>
    </swiper>

    <!-- ★ 自定义底部 tab 栏 -->
    <view class="custom-tabbar">
      <view
        v-for="(tab, i) in tabs"
        :key="i"
        class="tabbar-item"
        :class="{ active: tabIndex === i }"
        @tap="switchTab(i)"
      >
        <text class="tabbar-icon">{{ tab.icon }}</text>
        <text class="tabbar-text">{{ tab.name }}</text>
      </view>
    </view>
  </view>
</template>

<script setup>
import { ref } from 'vue'
import { onShow } from '@dcloudio/uni-app'
import { useBleStore } from '@/stores/ble.js'
import { useThemeStore } from '@/stores/theme.js'
import IndexPage from '@/pages/index/index.vue'
import ControlPage from '@/pages/control/control.vue'
import ConfigPage from '@/pages/config/config.vue'
import LoginPage from '@/pages/login/login.vue'

const bleStore = useBleStore()
const themeStore = useThemeStore()
const themeClass = themeStore.themeClass

const tabs = [
  { icon: '📡', name: '连接', path: '/pages/index/index' },
  { icon: '🎮', name: '控制', path: '/pages/control/control' },
  { icon: '⚙️', name: '配置', path: '/pages/config/config' },
  { icon: '❓', name: '帮助', path: '/pages/login/login' },
]

const tabIndex = ref(0)

function switchTab(i) {
  tabIndex.value = i
}

function onSwiperChange(e) {
  tabIndex.value = e.detail.current
}

// ★ 首次显示时的自动扫描
let _autoScanDone = false
onShow(async () => {
  if (bleStore.connected) return
  if (_autoScanDone) return
  _autoScanDone = true

  const savedId = uni.getStorageSync('ble_device_id')
  if (savedId) {
    bleStore.tryAutoConnect().then(async connected => {
      if (!connected) {
        tabIndex.value = 0
        await bleStore.startScanDevices(12)
      }
    })
  } else {
    await bleStore.startScanDevices(12)
  }
})
</script>

<style scoped>
.main-root {
  width: 100vw;
  height: 100vh;
  display: flex;
  flex-direction: column;
  background: var(--bg-page);
  overflow: hidden;
  transition: background 0.3s;
}

.tab-swiper {
  flex: 1;
  width: 100%;
}

.swiper-scroll {
  height: 100%;
}

/* ★ 自定义底部 tab 栏 */
.custom-tabbar {
  display: flex;
  height: 100rpx;
  background: var(--bg-tabbar);
  border-top: 1rpx solid var(--border-light);
  padding-bottom: env(safe-area-inset-bottom);
  flex-shrink: 0;
  transition: background 0.3s, border-color 0.3s;
}

.tabbar-item {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 4rpx;
  transition: all 0.2s;
  opacity: 0.5;
}

.tabbar-item.active {
  opacity: 1;
}

.tabbar-icon {
  font-size: 36rpx;
  line-height: 1;
}

.tabbar-text {
  font-size: 20rpx;
  color: var(--accent);
}
</style>
