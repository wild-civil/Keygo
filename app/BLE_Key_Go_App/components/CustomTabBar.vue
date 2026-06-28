<template>
  <view class="custom-tabbar" :class="themeClass">
    <view
      v-for="tab in tabs"
      :key="tab.path"
      class="tabbar-item"
      :class="{ active: currentPath === tab.path }"
      @tap="switchTab(tab.path)"
    >
      <text class="tabbar-icon">{{ tab.icon }}</text>
      <text class="tabbar-text">{{ tab.text }}</text>
    </view>
  </view>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { useThemeStore } from '@/stores/theme.js'

const themeStore = useThemeStore()
const themeClass = computed(() => themeStore.themeClass)

const currentPath = ref('')

function updatePath() {
  try {
    const pages = getCurrentPages()
    if (pages.length > 0) {
      currentPath.value = '/' + pages[pages.length - 1].route
    }
  } catch (_) { /* ignore */ }
}

onMounted(() => {
  updatePath()
})

const tabs = [
  { path: '/pages/index/index',   icon: '📡', text: '连接' },
  { path: '/pages/control/control', icon: '🎮', text: '控制' },
  { path: '/pages/config/config',   icon: '⚙️', text: '配置' },
  { path: '/pages/login/login',     icon: '👤', text: '我的' },
]

function switchTab(path) {
  if (currentPath.value === path) return
  currentPath.value = path
  uni.switchTab({
    url: path,
    fail: () => updatePath()
  })
}
</script>

<style scoped>
.custom-tabbar {
  position: fixed;
  bottom: 0;
  left: 0;
  right: 0;
  height: 98rpx;
  display: flex;
  align-items: center;
  justify-content: space-around;
  background: var(--bg-tabbar);
  border-top: 1rpx solid var(--border-light);
  padding-bottom: env(safe-area-inset-bottom);
  box-sizing: content-box;
  z-index: 9999;
  transition: background 0.3s, border-color 0.3s;
}

.tabbar-item {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  flex: 1;
  height: 98rpx;
  transition: all 0.2s;
}

.tabbar-icon {
  font-size: 32rpx;
  line-height: 1.2;
  opacity: 0.5;
  transition: all 0.2s;
}

.tabbar-text {
  font-size: 20rpx;
  color: var(--text-muted);
  line-height: 1.3;
  transition: all 0.2s;
}

.tabbar-item.active .tabbar-icon {
  opacity: 1;
  transform: scale(1.1);
}

.tabbar-item.active .tabbar-text {
  color: var(--accent);
  font-weight: 600;
}

.tabbar-item:active {
  opacity: 0.7;
}
</style>
