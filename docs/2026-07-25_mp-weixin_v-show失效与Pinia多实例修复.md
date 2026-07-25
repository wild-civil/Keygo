# mp-weixin 上 v-show 失效与 Pinia 多实例的修复（2026-07-25）

> **TL;DR**：本次修复 MP 端状态错乱——红绿 banner 同显、控制页断连提示卡连接后仍显示。共 **4 处修复**：
> ① **Pinia 多实例**（每个 Page 拿到独立 Pinia → 独立 store → 控制页 connected=true、连接页 connected=false）→ `main.js` 挂 `globalThis` 单例化；
> ② **v-show 在 mp-weixin 失效**（自定义组件 + page 内 view 都失效）→ `BtStateBanner.vue` v-show→v-if；
> ③ **`:style="{display:...}"` 在 mp-weixin 也不可靠**（用户重传后仍显示卡）→ `pages/control/control.vue` 改 `:class` + CSS `display:none`（保子树不卸载，不破 swiper 手势）；
> ④ **`uni.getConnectedBluetoothDevices` 在 mp-weixin 漏报**——已连设备常返回空列表，使"假断连保护"反而把 GATT 仍活的设备判真断连 → `connected` 被翻 false → 卡重现。修复：`_verifyThenDisconnect` 与 `_verifyConnection` 在系统列表查不到时改做 **GATT 活性探针**（`getBLEDeviceServices` 短超时）二次确认。

---

## 1. 问题现象

### 1.1 红绿 banner 同显（用户截图 14:25）
- 控制页（tabIndex=1）顶部同时显示：
  - 🔴 红 banner「蓝牙已关闭 [开启]」
  - 🟢 绿 banner「正在开启蓝牙…」
- 但**设备实际已连接**（下方车辆大卡 + 温度 24°C + 100% 电量 + 解锁/锁车/骑行按钮正常显示，RSSI -65dBm 在更新）。
- App 端正常、MP 端异常。

### 1.2 控制页断连提示卡连接后仍显示（用户截图 14:37）
- 控制页顶部同时显示：
  - 🟡 黄 banner「🔄 设备离线，正在自动重连中…」+ 已知设备 + 重新连接按钮（来自 `.conn-warning`，`v-show="!connected"`）
  - 🟢 已连接 UI（来自 `.control-body`，`v-show="connected"`）
- 同显 → `connected` 必须同时为 true 和 false。
- 用户体感：「已知设备卡只在设备真断连时显示，连接后不应该显示才对啊」。

---

## 2. 根因 1（决定性）：Pinia 多实例

### 2.1 机制
uni-app 编译 mp-weixin 时，`pages.json` 注册的每个 Page（`pages/main`、`pages/index`、`pages/control`、`pages/config`、`pages/help`）都是**独立 Page**。每个 Page 加载时各自调 `main.js` 的 `createApp()`，原代码每次 `new createPinia()` → **每个 Page 拿到独立 Pinia 实例** → Pinia 上的同名 store（bleStore/themeStore）是**完全不同的对象**。

### 2.2 关键证据（用户截图 14:25）
- 控制页 UI 正常显示（`v-show="connected"` 成立）→ control.vue 视角 `connected=true`。
- 连接页显示「设备未连接」卡（`v-if="!connected"` 成立）→ index.vue 视角 `connected=false`。
- 同一时间、同一 app 不可能两个 `connected` 值 → **Pinia 多实例坐实**。

虽然 `main.vue` 通过 swiper-item 引用 `<IndexPage />` 和 `<ControlPage />` 看起来像子组件，但 mp-weixin 编译产物里它们**仍以独立 Page 形式被引用**（uni-app 编译行为），各自 createApp → 独立 Pinia → 独立 bleStore。

---

## 3. 根因 2（决定性）：v-show 在 mp-weixin 失效

### 3.1 已知结论（CSDN hbiao68/2019）
- **自定义组件**（如 `<BtStateBanner>`）不支持 `hidden` 属性 → v-show 在自定义组件上失效。
- **原生基础组件**（如 `<view>`）支持 `hidden` 属性 → v-show 在 page 内的 view 应该 work。

### 3.2 实证推翻（用户截图 14:37）
- 控制页的 `.conn-warning` 和 `.control-body` **都是 page 内的 view**，按 CSDN 说法 v-show 应该 work。
- 实测：两个互斥卡**同时显示** → v-show 在 mp-weixin page 内的 view 上**也失效**。
- 推测：uni-app 编译 mp-weixin 时 v-show 的实现可能不严格用 `hidden` 属性，或在某些条件下被忽略。**不论原因，结果是 v-show 在 MP 上不可靠**。

### 3.3 同时存在的两个根因
- 根因 1 让 `connected` 在不同 page 不同步（控制页 true、连接页 false）。
- 根因 2 让 v-show 不真切换 display（即使条件满足，元素仍渲染）。
- 两个机制叠加 → 用户看到的「断连提示 + 已连接 UI 同显」完美解释。

---

## 4. 修复

### 4.1 修复 1：`main.js` Pinia 全局单例化（修根因 1）

```js
import { createSSRApp } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import App from './App.vue'

// ★ 2026-07-25 mp-weixin 多实例修复：每个 Page 加载都会调用一次 createApp()，
//   默认每次都会 new 一个新 Pinia，导致 bleStore/themeStore 在每个页面独立。
//   解决：把 Pinia 实例挂到 globalThis 上（uni-app 编译 mp-weixin 时 main.js
//   会被各 page 内联，模块级变量不是真正全局；globalThis = wx 全局对象，跨 page 共享）。
const PINIA_KEY = '__keygoSharedPinia'

export function createApp() {
  let pinia = globalThis[PINIA_KEY]
  if (!pinia) {
    pinia = createPinia()
    globalThis[PINIA_KEY] = pinia
  }
  setActivePinia(pinia)   // 强制激活共享 Pinia
  const app = createSSRApp(App)
  app.use(pinia)
  return { app }
}
```

**关键点**：
- 必须用 `globalThis`（= wx 全局对象）而非模块级变量：uni-app 编译 mp-weixin 时 `main.js` 会被各 page 内联，模块级 `let` 在每个 page 是独立的。
- 必须 `setActivePinia`：让各 page setup 期间 `useStore()` 拿到共享 Pinia 上的 store。
- 副作用：所有页面的 store 必须共享同一个 Pinia（项目只有 ble 和 theme 两个，均兼容）。

### 4.2 修复 2：`BtStateBanner.vue` v-show → v-if（修根因 2，自定义组件场景）

```html
<!-- 原 -->
<view class="bt-off-banner" v-show="!bleStore.connected && bleStore.btState === 'off'">
<view class="bt-on-banner" v-show="!bleStore.connected && bleStore.btState === 'just_enabled'">

<!-- 改 -->
<view class="bt-off-banner" v-if="!bleStore.connected && bleStore.btState === 'off'">
<view class="bt-on-banner" v-if="!bleStore.connected && bleStore.btState === 'just_enabled'">
```

**关键点**：
- 互斥条件本就成立（`'off'` 和 `'just_enabled'` 互斥），改 v-if 不会引入显示问题。
- App 端 v-if 也兼容（条件本就互斥）。

### 4.3 修复 3：`pages/control/control.vue` v-show → `:class` + CSS `display:none`（修根因 2，page 内 view 场景，且不能用 v-if）

```html
<!-- 原 -->
<view class="conn-warning" v-show="!bleStore.connected">
<view v-show="bleStore.connected" class="control-body">

<!-- 一度改 :style（见下） -->
<view class="conn-warning" :style="{ display: bleStore.connected ? 'none' : '' }">
<view :style="{ display: bleStore.connected ? '' : 'none' }" class="control-body">

<!-- ★ 2026-07-25 最终方案：:style 在 mp-weixin 也不可靠 → 改 :class 切 display:none -->
<view class="conn-warning" :class="{ 'is-hidden': bleStore.connected }">
<view :class="{ 'is-hidden': !bleStore.connected }" class="control-body">
```
```css
/* 元素仍挂载(不破坏 swiper 手势)，仅隐藏渲染 */
.conn-warning.is-hidden,
.control-body.is-hidden { display: none; }
```

**为什么不能用 v-if？** control.vue 第 4-8 行注释（v3.24 修复记录）明确：原用 v-if 切换两棵大树，重连风暴期间 `connected` 翻转 → 子树反复挂载/卸载 → swiper 手势被打断。故必须保留子树（只切 display）。

**为什么从 `:style` 改成 `:class`？** 用户重传 `:style` 方案后，**控制页连接后仍显示已知设备卡**——证实 `:style="{display:...}"` 在 mp-weixin 上同样切不动 display（与 v-show 同源问题）。class 切换 `display:none` 是 mp-weixin 上最可靠的隐藏手段（`:class` 绑定是核心特性，远稳定于内联 display 的运行时 patch），且 DOM 仍挂载 → 手势不受影响。

### 4.4 修复 4（逻辑根因）：`_verifyThenDisconnect` / `_verifyConnection` 改用 GATT 活性探针（stores/ble.js）

**问题**：`_verifyThenDisconnect`（全局断连监听器路径）原仅用 `uni.getConnectedBluetoothDevices({ services })` 做系统级确认。该 API **在微信小程序上极不可靠**——已连接的设备经常返回空列表（漏报）。于是"假断连保护"反把 GATT 仍活的设备判成真断连 → `_handleDisconnect()` → `connected=false` → 控制页"已知设备"卡重现。这制造了"连着却显示卡"的现象，与保护初衷完全相反。

**修复**：系统列表仅作"快速放行"信号（命中必为假断连）；查不到 / 查询失败时，改做 **GATT 活性探针**二次确认：

```js
async _verifyThenDisconnect(deviceId) {
  // ① 系统级确认（Android 可靠；mp-weixin 可能漏报，故不作为"已断连"唯一证据）
  try {
    const devices = await new Promise((resolve, reject) => {
      uni.getConnectedBluetoothDevices({ services: [BLE_CONFIG.serviceUUID],
        success: (res) => resolve(res.devices || []), fail: reject })
    })
    if (devices.some(d => d.deviceId === deviceId)) {
      console.log('[Store] ⚠ 设备仍在系统已连接列表 → 假断连，忽略')
      return
    }
  } catch (e) { console.warn('[Store] 系统级确认失败，转 GATT 探针:', e?.message || e) }
  // ② 系统列表查不到：可能真断连，也可能 mp-weixin 漏报 → GATT 探针二次确认
  const alive = await this._isGattAlive(deviceId)
  if (alive) { console.log('[Store] ⚠ GATT 仍活 → 假断连，忽略'); return }
  console.log('[Store] 系统列表+GATT 均确认断连 → 真正断连')
  this._handleDisconnect()
}

// GATT 活性探针：连上后服务已发现 → ~200ms 返回；真断连 → 超时失败。比 getConnectedBluetoothDevices 可靠。
async _isGattAlive(deviceId) {
  if (!deviceId) return false
  try {
    await Promise.race([
      getBLEDeviceServices(deviceId),
      new Promise((_, reject) => setTimeout(() => reject(new Error('GATT_PROBE_TIMEOUT')), 1500))
    ])
    return true
  } catch (e) { return false }
}
```

`_verifyConnection`（onShow 路径）的"系统列表查不到"分支同样加了 GATT 探针兜底（原本会直接 `_handleDisconnect`，导航回控制页时 mp-weixin 漏报即翻 `connected=false` → 卡重现）。

**副作用**：真断连检测延迟 ≈ GATT 探针超时（1.5s），可接受（优先避免误判导致卡乱闪）。

---

## 5. 验证步骤

四处修复都是**纯 JS**，**重传 MP 体验版即生效**，不需要升 manifest versionCode。重传后预期：

1. **控制页和连接页的 `connected` 状态同步**（设备实际连接时两页 UI 一致）。
2. **已知设备卡只在设备真断连时显示**，连接后稳定隐藏（修复 4：mp-weixin `getConnectedBluetoothDevices` 漏报不再误翻 `connected`）。
3. **红绿 banner 不再同显**——蓝牙已开时无 banner，蓝牙关时只红 banner。
4. **控制页 swiper 左右滑动手势顺畅**（子树不卸载，`:class` 切 display:none 不影响手势）。

**版本号**：待 MP 验证四处修复都生效后再升 `v3.36.3fix11.5`（fix11.4 仍是 fix11.3 提交的诊断日志占位编号）。

---

## 6. 教训（写到 memory，供后续参考）

### 6.1 之前判断的修正
- **之前错误判断**：「just_enabled 在纯 MP 代码层不可达」——此判断本身没错（A1 三处赋值点都受 plus 门控或 `#ifdef APP-PLUS` 保护），但**无法解释截图红绿同显**。
- **正确解释**：红绿同显不是 `just_enabled` 真的被设置了，是**v-show 失效让两个 banner 始终渲染 + Pinia 多实例让状态在不同 page 不同步**。红绿 banner 之所以"刚好同时显示"，是因为它们被固定渲染，与 `btState` 值无关。

### 6.2 教训
- 用户描述的"红绿同显"是表象，背后机制可能与字段赋值无关。下次遇到 v-show/v-if 行为不符时，**优先怀疑编译产物**（mp-weixin 的 v-show 编译行为），不要只在赋值逻辑里找原因。
- `v-show` 与 `:style="{display:...}"` 在 mp-weixin 上**都不可靠**（自定义组件 + page 内 view 均失效；内联 display 运行时 patch 也不可靠）。需要"切 display 但不卸载子树"的场景，统一用 `:class` 切换 `display:none`（比 `:style` 内联 display 更稳定），且绝不能用 `v-if`（会破坏 swiper 手势，见 v3.24 注释）。
- `Pinia` 在 mp-weixin 上**不是自动单例的**——每个 Page 独立 createApp → 独立 Pinia。需要单例化时，用 `globalThis` + `setActivePinia`（不能用模块级变量，main.js 会被各 page 内联）。
- `uni.getConnectedBluetoothDevices` 在 mp-weixin 上**漏报严重**——已连设备常返回空列表。凡用它做"是否已连接"的系统级确认，在 mp-weixin 必须用 **GATT 活性探针**（`getBLEDeviceServices` 短超时）二次确认，否则会把 GATT 仍活的设备误判失效（典型如 `_verifyThenDisconnect` / `_verifyConnection` 这类"假断连保护"在 mp-weixin 反而反向出错）。
- **CSDN 2019 的 v-show 失效结论需要更新**：当时只说自定义组件失效，2026 年实测 page 内 view 也失效（可能是 uni-app 或 wx 小程序底层升级导致）。做 MP 适配时不要轻信旧结论。

---

## 7. 相关文件

- `app/BLE_Key_Go_App/main.js` — Pinia 单例化修复
- `app/BLE_Key_Go_App/components/BtStateBanner.vue` — v-show → v-if
- `app/BLE_Key_Go_App/pages/control/control.vue` — v-show → `:class`（第 9、46 行）+ CSS `.is-hidden{display:none}`（第 ~420 行）
- `app/BLE_Key_Go_App/stores/ble.js` — `_verifyThenDisconnect` / `_verifyConnection` 加 GATT 活性探针（`_isGattAlive`，1.5s 超时），修 mp-weixin `getConnectedBluetoothDevices` 漏报误判

## 8. 未来工作

- **index.vue** 也有 5 处 v-show（第 27、39、58、78、195 行），按本修复同样的模式检查是否需要改 `:style`。本次未改，因用户未报告 index 页 v-show 相关问题。
- **A1-DIAG 日志**（store 三处 STACK + BtBanner `plus` 探测）暂保留——它们对验证 `just_enabled` 不可达仍有用，修复后绿 banner 不再误触发，触发时必是真问题。
- **v3.36.3fix11.4 诊断日志**（`_reconcileBtState` 处 `[fix11.4-DIAG]`）继续保留，等用户复现 ② 后处理。