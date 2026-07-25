# mp-weixin 下 Pinia 非单例：用 globalThis 共享同一份 Store

> 来源：KeyGo App `main.js` 的 mp-weixin 多实例修复（2026-07-25）。现象：控制页 `connected=true`、连接页 `connected=false` 状态矛盾；红绿 banner 与控制 UI 不同步。
> 目标：讲清 uni-app 编译到微信小程序后"每 Page 独立 App 实例"导致的 store 不一致，以及如何用 `globalThis` 强制单例。前端架构复盘素材。

---

## 0. 现象（bug）

多 tab 小程序里，蓝牙连接状态在**不同页面表现不一致**：
- 控制页（tab 1）显示"已连接"（banner 隐藏、控制 UI 出现）；
- 切到连接页（tab 0）却显示"未连接"（红 banner 出现、提示去连接）。

同一份 `bleStore.connected`，在两个 page 里读到不同值 → 状态矛盾，UI 精神分裂。

---

## 1. 根因：mp-weixin 是"多 Page"架构，不是 SPA

uni-app 编译到微信小程序时，**每个 Page 是独立的小程序页面**，各自会执行一次 `createApp()`（main.js 被各 page 内联打包）。

问题在于：模块级变量在 mp-weixin **不是真正全局**——每个 page 的 bundle 独立，模块作用域互不共享。所以：

```js
// 模块级单例在 mp-weixin 下失效：每个 page 都会跑一次，得到各自的实例
const pinia = createPinia()   // ❌ 每 page 一份
```

每次 `createApp()` 都 `new` 一个新 Pinia → `bleStore` / `themeStore` 在**每个页面各有一份**，互不连通。H5/App 平台是单页 SPA，模块级单例有效，所以只在 mp-weixin 暴露。

---

## 2. 解法：把 Pinia 挂到 globalThis

`globalThis` 在 mp-weixin 上等价于微信的**全局对象**（跨 page 共享），用它当"真·全局"存放唯一的 Pinia 实例：

```js
import { createSSRApp } from 'vue'
import { createPinia, setActivePinia } from 'pinia'

const PINIA_KEY = '__keygoSharedPinia'

export function createApp() {
  let pinia = globalThis[PINIA_KEY]
  if (!pinia) {
    pinia = createPinia()            // 首次创建
    globalThis[PINIA_KEY] = pinia    // 挂到全局，后续 page 复用
  }
  setActivePinia(pinia)              // 强制激活同一份，确保 useBleStore 拿到共享实例
  const app = createSSRApp(App)
  app.use(pinia)
  return { app }
}
```

要点：
- **第一次** `createApp()` 创建 Pinia 并缓存到 `globalThis`；**之后**所有 page 复用同一份。
- `setActivePinia(pinia)` 保证各 page 内 `useBleStore()` / `useThemeStore()` 拿到的是共享实例。
- 副作用：所有页面必须共用同一个 Pinia（KeyGo 只有 `ble` 和 `theme` 两个 store，均兼容）。

---

## 3. 为什么这关系到 UI

修复后，红绿 banner（`main.vue` 内的 `BtStateBanner`）读的是 `bleStore`，控制 UI 读的也是同一份 `bleStore` → **跨页状态终于一致**，banner 显示与页面内容不再打架。这正是"UI 复盘"里值得记的一笔：**很多"UI 不同步"的表象，根子在状态层架构，不在样式**。

---

## 4. 知识点速记

| 概念 | 要点 |
|---|---|
| SPA vs 多 Page | H5/App 单实例；小程序每 Page 独立 bundle，模块级单例失效 |
| `globalThis` | mp-weixin = 微信全局对象，跨 page 共享，适合放"真全局"单例 |
| `setActivePinia` | Pinia 显式激活某个实例，确保 `useXxxStore()` 命中目标 |
| 状态一致性 | UI 不同步常是状态层问题（实例分裂），先查 store 是否同一份 |

---

## 5. 经验法则

- 在 uni-app **跨端**项目里，凡需要"跨 page 共享"的实例（Pinia、全局事件总线、单例服务），**必须挂到 `globalThis`/专用全局对象**，别依赖模块级变量。
- 遇到"同一 store 在 A 页和 B 页状态不一样"，第一反应：是不是**多实例**了（尤其 mp-weixin / 小程序平台）。
- 共享单例时评估副作用：所有消费者都得接受同一份状态，避免页间意外串状态。
