# 主题系统 Bug 修复复盘

> 日期：2026-06-28  
> 涉及文件：8 个  
> 目标：实现亮色 / 暗色 / 跟随系统三套主题，且 auto 模式实时跟随手机系统主题变化

---

## 一、Bug 总览

| # | Bug 现象 | 严重度 | 根因 |
|---|---------|--------|------|
| 1 | 暗色模式下内容区白色背景 | 🔴 高 | `swiper-item`/`scroll-view` 原生组件有平台默认白底，不继承父级 CSS 变量 |
| 2 | 亮色/暗色手动切换后页面不刷新 | 🔴 高 | Pinia getter 直接赋值给 `const` 丢失响应性，`themeClass` 永远是初始快照 |
| 3 | auto 模式永远显示亮色，不跟随系统 | 🟡 中 | `getSystemTheme()` 只读 `info.theme`，Android 平台该字段为 `undefined` |
| 4 | auto 模式不能实时跟随系统主题变化 | 🟡 中 | `uni.onThemeChange()` 仅小程序有效，独立 App 无回调 |

---

## 二、逐 Bug 修复详情

### Bug 1：暗色模式内容区白色背景

**文件**：`pages/main/main.vue`

**根因**：`main.vue` 使用 `<swiper>` + `<swiper-item>` + `<scroll-view>` 原生组件承载子页面。这些原生组件**自带平台默认白色背景**，不继承父级 `.theme-dark` 中定义的 CSS 变量。

**修复**：在 `.tab-swiper`、`:deep(swiper-item)`、`.swiper-scroll` 三个位置显式设置 `background: var(--bg-page)`

```css
.tab-swiper {
  flex: 1;
  width: 100%;
  background: var(--bg-page);           /* ← 新增 */
}

:deep(swiper-item) {
  background: var(--bg-page);            /* ← 新增 */
}

.swiper-scroll {
  height: 100%;
  background: var(--bg-page);            /* ← 新增 */
}
```

---

### Bug 2：Pinia getter 丢失响应性

**文件**（6 个）：
- `pages/login/login.vue`
- `pages/index/index.vue`
- `pages/control/control.vue`
- `pages/config/config.vue`
- `pages/main/main.vue`
- `components/CustomTabBar.vue`

**根因**：每个组件中 `const themeClass = themeStore.themeClass` 在 `<script setup>` 中被**立即求值**为字符串字面量。Pinia 的 computed getter 赋值给 `const` 后变成快照，后续 `themeStore` 内部状态变化不会触发更新。

```js
// ❌ 错误：快照，只读一次
const themeClass = themeStore.themeClass

// ✅ 正确：用 Vue computed 保持响应链路
import { computed } from 'vue'
const themeClass = computed(() => themeStore.themeClass)
```

**修复**：全部 6 个文件统一改为 `computed(() => themeStore.themeClass)`，同时补充缺失的 `import { computed } from 'vue'`。

---

### Bug 3：Android 系统主题检测失败

**文件**：`stores/theme.js`

**根因**：uni-app 在不同平台使用**不同的字段名**存储系统主题：

| 平台 | 字段 |
|------|------|
| 微信小程序 | `wxInfo.theme` |
| iOS / 部分版本 | `info.theme` |
| **Android** | `info.osTheme` |
| 宿主（微信等） | `info.hostTheme` |

旧代码只检查了 `info.theme`，Android 永远返回 `undefined` → fallback 锁死在 `'light'`。

**修复**：按优先级逐级降级检测

```js
const t = info.theme || info.osTheme || info.hostTheme
```

同时添加日志输出三个字段的实际值方便调试。

---

### Bug 4：auto 模式不能实时跟随系统

**文件**：`stores/theme.js` + `App.vue`

**根因**：`uni.onThemeChange()` 是**微信小程序专属 API**，在独立 Android App 上注册后永远不会触发。App 无法感知用户切换了系统主题。

**修复**：实现业界标准的「onShow 即时检测 + 轻量轮询」双保险

| 触发时机 | 行为 |
|----------|------|
| `App.vue onShow`（回到前台） | 立刻读取 `getSystemTheme()`，有变化立即更新 |
| `App.vue onHide`（进入后台） | 停止轮询，省电 |
| auto 模式运行时 | 每 3 秒读取 `getSystemTheme()`，检测到变化立即更新 |
| 切换到 light/dark 模式 | 停止轮询，省电 |

**结构**：

```
theme.js 新增：
  startPoll()     → 启动 3s 轮询（仅 auto 模式）
  stopPoll()      → 清除定时器
  onAppShow()     → 即时检测 + 恢复轮询
  onAppHide()     → 停止轮询

App.vue 新增：
  onShow(() => themeStore.onAppShow())
  onHide(() => themeStore.onAppHide())
```

**耗电分析**：`getSystemInfoSync()` 是纯内存同步读取（无 IO、无网络、无传感器），每次 <1ms。仅 auto 模式下 App 在前台时每 3 秒执行一次，切后台即停。对比 BLE RSSI 轮询（800ms/次蓝牙扫描），开销可忽略。

---

## 三、改动文件清单

| 文件 | 改动内容 |
|------|----------|
| `stores/theme.js` | 修复系统主题检测（osTheme/hostTheme）；新增轮询机制 + onAppShow/onAppHide；setMode 衔接轮询启停 |
| `App.vue` | 新增 `onShow`/`onHide` 生命周期绑定到 themeStore |
| `pages/main/main.vue` | 原生容器显式背景色 + themeClass 改为 computed |
| `pages/index/index.vue` | themeClass 改为 computed |
| `pages/control/control.vue` | themeClass 改为 computed |
| `pages/config/config.vue` | themeClass 改为 computed |
| `pages/login/login.vue` | themeClass 改为 computed |
| `components/CustomTabBar.vue` | themeClass 改为 computed |

---

## 四、最终架构

```
┌──────────────────────────────────────────────────────────────┐
│                       主题系统架构                            │
├──────────────────────────────────────────────────────────────┤
│  CSS 变量层 (App.vue)                                        │
│    .theme-dark { --bg-page: #0f0f1a; --text-primary: #fff… } │
│    .theme-light { --bg-page: #f0f2f5; --text-primary: #1a1a2e… } │
│                                                              │
│  响应式 class (各页面根 view)                                  │
│    :class="themeClass"  →  'theme-dark' 或 'theme-light'     │
│    themeClass = computed(() => themeStore.themeClass)         │
│                                                              │
│  主题 Store (stores/theme.js)                                 │
│    mode ∈ { light, dark, auto }                              │
│    auto 模式：systemTheme ← getSystemTheme()                  │
│    auto 轮询：setInterval 3s → 检测变化 → 自动更新            │
│    生命周期：onShow 即时检测  |  onHide 停止轮询              │
│                                                              │
│  导航栏 (uni.setNavigationBarColor)                           │
│    applyNavBar() → 暗色: #1a1a2e / 亮色: #ffffff             │
└──────────────────────────────────────────────────────────────┘
```

---

## 五、经验教训

1. **Pinia getter 不能直接赋值给 `const`**：在 `<script setup>` 中 `const x = store.someGetter` 是立即求值，丢失响应性。正确做法是 `computed(() => store.someGetter)`。

2. **uni-app 原生组件不继承 CSS 变量**：`swiper-item`、`scroll-view` 等平台原生组件有独立渲染层，需显式设置 `background: var(--bg-page)`。

3. **uni-app 跨平台字段名不一致**：系统主题在 iOS 是 `info.theme`，Android 是 `info.osTheme`，宿主环境是 `info.hostTheme`，必须三级降级检测。

4. **`uni.onThemeChange()` 仅小程序有效**：独立 App 必须自行实现轮询或利用 onShow 重新检测，这是整个 uni-app 生态的常见做法。
