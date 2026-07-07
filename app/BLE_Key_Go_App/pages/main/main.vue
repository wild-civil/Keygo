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
          <ConfigPage :active="tabIndex === 2" />
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
import { ref, computed } from 'vue'
import { onShow } from '@dcloudio/uni-app'
import { useBleStore } from '@/stores/ble.js'
import { useThemeStore } from '@/stores/theme.js'
import IndexPage from '@/pages/index/index.vue'
import ControlPage from '@/pages/control/control.vue'
import ConfigPage from '@/pages/config/config.vue'
import LoginPage from '@/pages/login/login.vue'

const bleStore = useBleStore()
const themeStore = useThemeStore()
const themeClass = computed(() => themeStore.themeClass)

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
  themeStore.applyNavBar()
  if (bleStore.connected) return
  if (_autoScanDone) return
  _autoScanDone = true

  // ★ 冷启动修复：先仅打开适配器（不申请权限、BT 已开无弹窗），
  //   否则 startScanDevices 内 _checkBluetoothState 读到 not-init→false 抛 "蓝牙未开启"。
  try {
    await bleStore.ensureAdapterReady()
  } catch (e) {
    console.warn('[Main] ensureAdapterReady 失败:', e?.message || e)
  }

  const savedId = uni.getStorageSync('ble_device_id')
  if (savedId) {
    // ★ 冷启动修复：先确保蓝牙适配器已打开（含权限/打开），
    //   否则 cold start 下 getBluetoothAdapterState "not init" → tryAutoConnect 误抛 "蓝牙未开启"
    //   → 红 banner + 未捕获异常。有已知设备才初始化，避免新用户一打开就弹权限框。
    try {
      await bleStore.prepareForAutoConnect()
      const connected = await bleStore.tryAutoConnect()
      if (!connected) {
        tabIndex.value = 0
        await bleStore.startScanDevices(12)
      }
    } catch (err) {
      /* ★ v3.15: 兜底捕获 tryAutoConnect/startScanDevices 中的未处理 rejection
       *   防止蓝牙关闭、权限不足等场景下产生 unhandled rejection 崩溃 */
      console.error('[Main] 自动连接/扫描失败:', err?.message || err)
    }
  } else {
    try {
      await bleStore.startScanDevices(12)
    } catch (err) {
      console.error('[Main] 扫描失败:', err?.message || err)
    }
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
  background: var(--bg-page);
}

/* ★ swiper-item 原生组件有默认白色背景，需要显式覆盖 */
:deep(swiper-item) {
  background: var(--bg-page);
}

.swiper-scroll {
  height: 100%;
  background: var(--bg-page);
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
