<template>
  <view class="app-root">
    <router-view />
    <CustomTabBar />
  </view>
</template>

<script setup>
import { onLaunch, onShow, onHide } from '@dcloudio/uni-app'
import CustomTabBar from '@/components/CustomTabBar.vue'
import { useThemeStore } from '@/stores/theme.js'

const themeStore = useThemeStore()

onLaunch(() => {
  console.log('[BLE-KeyGo] App launched')

  // ★ 初始化主题（读取持久化 → 检测系统主题 → 监听变化 → 启动 auto 轮询）
  themeStore.init()

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

// ★ App 回到前台 → 立刻重新检测系统主题（覆盖用户在系统设置切换主题的场景）
onShow(() => {
  themeStore.onAppShow()
})

// ★ App 进入后台 → 停止轮询省电
onHide(() => {
  themeStore.onAppHide()
})
</script>

<style>
/* ============================================================
   ★★ 全局主题变量定义 ★★

   原理（参考 my-uniapp 验证过的方案）：
   - 各页面根 view 绑定 :class="themeClass"（值为 'theme-dark' 或 'theme-light'）
   - 所有颜色通过 var(--xxx) 引用
   - 切换 class → 自动切换整套配色，不依赖 JS setProperty
   - 自定义 TabBar 是 Vue 组件，同样跟随 CSS 变量
   - 导航栏通过 uni.setNavigationBarColor() 动态适配（见 theme.js）

   ★ 新增变量：alpha 渐变、RSSI 预设、login 特殊色 等
   ============================================================ */

/* ===== page 基础 =====
   注意：page 是原生容器，位于根 view 之上，不能绑定 :class="themeClass"，
        所以 CSS 变量不会从子级向父级反向继承。
        页面背景由各页面根 view 的 background: var(--bg-page) 负责，
        这里只设置 page 的兜底色保证全屏无白边。 */
page {
  background-color: #0f0f1a;           /* 兜底（仅 .theme-dark 下可见，亮色下被子 view 覆盖） */
  color: var(--text-primary);
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  /* transition 需要放在可以应用 themeClass 的元素上 */
}

.app-root {
  min-height: 100vh;
}

/* ===== 全局通用样式 ===== */
button {
  border: none;
  border-radius: 12rpx;
  font-size: 28rpx;
}
button::after {
  border: none;
}

/* ============================================================
   ★ 暗色主题（默认）
   ============================================================ */
.theme-dark {
  color-scheme: dark;

  /* ---- 背景 ---- */
  --bg-page:            #0f0f1a;
  --bg-card:            #1a1a3e;
  --bg-card-alt:        #16213e;
  --bg-darker:          #0a0a1a;
  --bg-tabbar:          #12122a;
  --bg-overlay:         rgba(0, 0, 0, 0.7);
  --bg-input:           #16213e;

  /* ---- 边框 ---- */
  --border:             #2a2a5e;
  --border-light:       #1e1e3e;

  /* ---- 文字 ---- */
  --text-primary:       #ffffff;
  --text-secondary:     #ccddee;
  --text-tertiary:      #8899aa;
  --text-muted:         #556677;

  /* ---- 状态背景 ---- */
  --bg-warning:         #332200;
  --border-warning:     #664400;
  --bg-success:         #003322;
  --border-success:     #006644;
  --bg-connected:       #0a1628;
  --bg-unlocked:        #0a2818;

  /* ---- 强调色 ---- */
  --accent:             #00d4ff;
  --accent-dark:        #0088cc;
  --accent-green:       #00ff88;
  --accent-orange:      #ffaa00;
  --accent-red:         #ff4444;
  --accent-yellow:      #ffdd00;
  --accent-pink:        #ff4488;

  /* ---- Alpha 透明辅助色 ---- */
  --alpha-06:           rgba(0, 212, 255, 0.06);
  --alpha-07:           rgba(0, 212, 255, 0.07);
  --alpha-10:           rgba(0, 212, 255, 0.10);
  --alpha-12:           rgba(0, 212, 255, 0.12);
  --alpha-20:           rgba(0, 212, 255, 0.20);
  --alpha-27:           rgba(0, 212, 255, 0.27);
  --alpha-33:           rgba(0, 212, 255, 0.33);

  --green-alpha-27:     rgba(0, 255, 136, 0.27);
  --green-alpha-33:     rgba(0, 255, 136, 0.33);
  --green-alpha-40:     rgba(0, 255, 136, 0.40);

  --orange-alpha-08:    rgba(255, 136, 0, 0.08);
  --orange-alpha-27:    rgba(255, 136, 0, 0.27);
  --orange-alpha-33:    rgba(255, 136, 0, 0.33);

  --red-alpha-27:       rgba(255, 68, 68, 0.27);

  --yellow-alpha-27:    rgba(255, 221, 0, 0.27);

  /* ---- 渐变 ---- */
  --gradient-card:      linear-gradient(135deg, #1a1a3e 0%, #16213e 100%);
  --gradient-connected: linear-gradient(135deg, #0a1628 0%, #0d2137 100%);
  --gradient-unlock:    linear-gradient(135deg, #0d2818 0%, #0a1a10 100%);
  --gradient-lock:      linear-gradient(135deg, #281a1a 0%, #1a0a0a 100%);
  --gradient-accent:    linear-gradient(135deg, #00d4ff 0%, #0088cc 100%);
  --gradient-warn-card: linear-gradient(135deg, #332200, #2a1a00);

  /* ---- Login 页专用 ---- */
  --login-bg:           linear-gradient(180deg, #0a0a1a 0%, #1a1a2e 50%, #12122a 100%);
  --login-card-bg:      rgba(22, 33, 62, 0.8);
  --login-sub-color:    #8899bb;
  --login-step-desc:    #8899bb;
  --login-step-title:   #e8edf4;
  --login-info-val:     #8899bb;
  --login-tip-text:     #99bbdd;
  --login-footer-ver:   #445566;

  /* ---- RSSI 预设按钮 ---- */
  --rssi-near-bg:       #1a3a1a;
  --rssi-close-bg:      #1a2a3a;
  --rssi-mid-bg:        #2a2a1a;
  --rssi-far-bg:        #2a1a1a;
  --rssi-far-color:     #ff8888;
  --rssi-far-border:    rgba(255, 136, 136, 0.27);

  /* ---- 其他 ---- */
  --config-label:       #e0e0e0;
  --signal-empty:       #ccd;
  --signal-empty-muted: #667;
  --mgmt-val:           #6677aa;
  --mgmt-hint:          rgba(255, 136, 0, 0.53);
}

/* ============================================================
   ★ 亮色主题
   ============================================================ */
.theme-light {
  color-scheme: light;

  /* ---- 背景 ---- */
  --bg-page:            #f0f2f5;
  --bg-card:            #ffffff;
  --bg-card-alt:        #f5f7fa;
  --bg-darker:          #e8ecf0;
  --bg-tabbar:          #ffffff;
  --bg-overlay:         rgba(0, 0, 0, 0.35);
  --bg-input:           #f5f7fa;

  /* ---- 边框 ---- */
  --border:             #e0e4e8;
  --border-light:       #eceef2;

  /* ---- 文字 ---- */
  --text-primary:       #1a1a2e;
  --text-secondary:     #3a3a5a;
  --text-tertiary:      #667788;
  --text-muted:         #99aabb;

  /* ---- 状态背景 ---- */
  --bg-warning:         #fff3e0;
  --border-warning:     #ffcc80;
  --bg-success:         #e0f5e9;
  --border-success:     #a0d9bb;
  --bg-connected:       #d8ecff;
  --bg-unlocked:        #d2f5e0;

  /* ---- 强调色（亮色下降低饱和度提高对比度）---- */
  --accent:             #0077cc;
  --accent-dark:        #005fa3;
  --accent-green:       #00aa55;
  --accent-orange:      #cc6600;
  --accent-red:         #cc2222;
  --accent-yellow:      #bb9900;
  --accent-pink:        #cc3366;

  /* ---- Alpha 透明辅助色 ---- */
  --alpha-06:           rgba(0, 119, 204, 0.05);
  --alpha-07:           rgba(0, 119, 204, 0.065);
  --alpha-10:           rgba(0, 119, 204, 0.08);
  --alpha-12:           rgba(0, 119, 204, 0.10);
  --alpha-20:           rgba(0, 119, 204, 0.18);
  --alpha-27:           rgba(0, 119, 204, 0.22);
  --alpha-33:           rgba(0, 119, 204, 0.28);

  --green-alpha-27:     rgba(0, 170, 85, 0.22);
  --green-alpha-33:     rgba(0, 170, 85, 0.28);
  --green-alpha-40:     rgba(0, 170, 85, 0.35);

  --orange-alpha-08:    rgba(204, 102, 0, 0.07);
  --orange-alpha-27:    rgba(204, 102, 0, 0.22);
  --orange-alpha-33:    rgba(204, 102, 0, 0.28);

  --red-alpha-27:       rgba(204, 34, 34, 0.22);

  --yellow-alpha-27:    rgba(187, 153, 0, 0.22);

  /* ---- 渐变 ---- */
  --gradient-card:      linear-gradient(135deg, #ffffff 0%, #f5f7fa 100%);
  --gradient-connected: linear-gradient(135deg, #d8ecff 0%, #e8f4ff 100%);
  --gradient-unlock:    linear-gradient(135deg, #d2f5e0 0%, #e0f5e8 100%);
  --gradient-lock:      linear-gradient(135deg, #fce6e4 0%, #f5ddd8 100%);
  --gradient-accent:    linear-gradient(135deg, #0077cc 0%, #005fa3 100%);
  --gradient-warn-card: linear-gradient(135deg, #fff3e0, #ffeacc);

  /* ---- Login 页专用 ---- */
  --login-bg:           linear-gradient(180deg, #dce4f0 0%, #e8edf5 50%, #f0f4fa 100%);
  --login-card-bg:      rgba(255, 255, 255, 0.85);
  --login-sub-color:    #667788;
  --login-step-desc:    #667788;
  --login-step-title:   #2a2a44;
  --login-info-val:     #667788;
  --login-tip-text:     #556678;
  --login-footer-ver:   #8899aa;

  /* ---- RSSI 预设按钮 ---- */
  --rssi-near-bg:       #d2f5e0;
  --rssi-close-bg:      #d8ecff;
  --rssi-mid-bg:        #fff2db;
  --rssi-far-bg:        #fce6e4;
  --rssi-far-color:     #cc5555;
  --rssi-far-border:    rgba(204, 85, 85, 0.22);

  /* ---- 其他 ---- */
  --config-label:       #3a3a5a;
  --signal-empty:       #667788;
  --signal-empty-muted: #99aabb;
  --mgmt-val:           #667788;
  --mgmt-hint:          rgba(204, 102, 0, 0.5);
}
</style>
