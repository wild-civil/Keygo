# 小程序(MP)平台 v-show / v-if / display 切换的坑与正确解法

> 来源：KeyGo App 控制页 `pages/control/control.vue` 与全局红绿 banner 组件 `components/BtStateBanner.vue` 的真实踩坑史（2026-07-24 ~ 2026-07-25）。
> 目标：讲清在 uni-app + 微信小程序（mp-weixin）下，"切换显隐"为什么不能想当然用 `v-show`，以及 swiper 场景下为什么不能用 `v-if`。作为 UI 学习复盘博客素材。

---

## 0. 先给结论（硬规则）

在 mp-weixin 上：

| 需求 | 正确做法 | 错误做法 |
|---|---|---|
| 切换显隐，但**不能卸载 DOM**（如 swiper 内的互斥 UI） | `:class` + CSS `display:none` | `v-if`（卸载打断手势）、`v-show`（不切 display）、`:style="{display}"`（不可靠） |
| 在**自定义组件**内互斥显隐，卸载可接受 | `v-if` ✅ | `v-show` ❌（编译成 `hidden`，自定义组件不支持 → 直接失效） |

一句话：**mp-weixin 上"切 display"要靠 `:class` + CSS；`v-show` 基本不可信，`v-if` 只在允许卸载时用。**

---

## 1. 背景：控制页的两棵互斥大树

控制页（`control.vue`）是一个 `swiper`，里面有两个**互斥**显示的大块：

- `conn-warning`：断连提示卡（"设备未连接 / 正在自动重连"）。
- `control-body`：已连接时的控制 UI（解锁/锁车按钮等）。

同一时刻只应显示一个，但它们**都嵌在 `swiper-item` 里**。这就带来了约束：swiper 的左右滑动手势依赖滑动过程中 DOM 节点的连续存在，如果某个节点被挂载/卸载，手势追踪会"跟丢" → 表现就是用户说的"左右滑动拉扯、屏幕不受控制"。

所以显隐切换必须满足两个看似矛盾的条件：
1. **互斥**（同一时刻只显示一个）；
2. **DOM 始终挂载**（不能卸载，否则 swiper 手势断）。

---

## 2. 三种切换机制的本质

### 2.1 v-if：真·挂载 / 卸载
```html
<view v-if="condition">...</view>
```
- 条件为 false 时，子树**从 DOM 彻底移除**；为 true 时重新创建。
- 优点：隐藏时不占 DOM、省内存，组件状态随卸载自然清理。
- 缺点（本场景致命）：在 swiper 内反复卸载/挂载，会摘除/重建 `swiper-item` 的子节点 → 手势追踪中断。
- 历史：控制页最初用 `v-if` 切这两棵树，重连风暴期间 `connected` 在 false↔true 翻转，子树被来回挂载 → "左右滑动拉扯"。这是 2026-07-24 修复的"晃动根因"。

### 2.2 v-show：只切 display（H5/App 有效，MP 失效）
```html
<view v-show="condition">...</view>
```
- 原理：用 `display:none` 隐藏，**不卸载** DOM。
- 在 **H5 / App** 上没问题（Vue 直接切 `display`）。
- 在 **mp-weixin** 上：Vue 会把 `v-show` 编译成小程序的 `hidden` 属性，而不是切 `display` 样式；而微信小程序的 `hidden` 在**自定义组件**上根本不生效，即便在 page 内的 `<view>` 上 `display` 切换也不可靠。结果就是：**隐藏失效，两棵树同时显示**（断连卡与已连 UI 同屏）。
- 这正是 2026-07-25 发现的问题：控制页改用 `v-show` 后，小程序上"断连提示卡"和"已连接 UI"同时出现。

### 2.3 :style="{display:...}"：内联样式（MP 仍不可靠）
```html
<view :style="{ display: connected ? 'block' : 'none' }">...</view>
```
- 直觉上"直接写内联 style 总能切 display 吧"——但在 mp-weixin 实测仍不稳定（框架对 style 的响应式更新在部分节点上不触发重排）。
- 控制页 2026-07-25 先试了这招，发现仍不可靠，才最终回到 `:class` 方案。

### 2.4 :class + CSS display:none：MP 上唯一稳的解法 ✅
```html
<view class="conn-warning"   :class="{ 'is-hidden': bleStore.connected }">
<view class="control-body"   :class="{ 'is-hidden': !bleStore.connected }">
```
```css
.conn-warning.is-hidden,
.control-body.is-hidden { display: none; }
```
- 切的是**类名**，浏览器/小程序对 class 驱动的样式重算处理最可靠。
- DOM **始终挂载**（满足 swiper 手势要求），只是 `display:none` 隐藏渲染。
- 实测在 mp-weixin、App、H5 三端都稳定。这就是当前线上方案。

> 关键认知：`v-show` 和 `:style display` 在 MP 上"切不动"，不是你代码写错，是**平台编译层面的限制**——class 驱动样式是框架最优先保证的路径，所以绕回 class 才稳。

---

## 3. 为什么 swiper 里不能用 v-if（手势打断原理）

swiper 的手势（touchstart → touchmove → touchend）会在 `touchstart` 时记录起始目标节点，并在 move 过程中持续追踪该节点链。若在 move 中途把某棵子树 `v-if` 卸载：

1. 被追踪的 DOM 节点从树中消失；
2. 框架手势引擎拿不到后续事件的命中目标 → 判定手势异常；
3. 表现：滑动卡顿、左右"拉扯"、有时整页不受控制。

而 `display:none` 只是"不渲染、不可点"，节点仍在树中、仍在事件链上 → 手势追踪链不断 → 滑动丝滑。

**经验法则**：凡是嵌在 `swiper` / `swiper-item` 内、且需要在"显示/隐藏"间频繁切换的 UI，**一律用 `:class` + `display:none`，绝不用 `v-if`。**

---

## 4. 为什么 BtStateBanner.vue 里反而用 v-if（反例的正解）

`components/BtStateBanner.vue` 是抽出的全局红绿 banner，两个互斥横幅：
```html
<view class="bt-off-banner" v-if="!bleStore.connected && bleStore.btState === 'off'">       🔴 蓝牙已关闭 </view>
<view class="bt-on-banner"  v-if="!bleStore.connected && bleStore.btState === 'just_enabled'"> 🟢 正在开启蓝牙... </view>
```
这里**故意用 `v-if` 而不是 `:class`**，原因有二：

1. **不在 swiper 内**：banner 根节点是普通 flex 容器，没有手势链约束，卸载不影响任何滑动。
2. **v-show 在这里更糟**：该组件是**自定义组件**，`v-show` 会被编译成 `hidden` 属性，而小程序自定义组件不支持 `hidden` → `v-show` **完全失效**，红绿 banner 会同时渲染（这正是 2026-07-25 修的"红绿同显根因"）。改用 `v-if` 从 DOM 彻底移除，反而最干净。

> 所以"能不能用 v-if"取决于**上下文**：在 swiper 内互斥 → 禁用（手势）；在普通自定义组件内互斥 → 可用，且比 `v-show` 更可靠。

---

## 5. 决策树（落地用）

```
需要切换显隐？
├─ 在 swiper / swiper-item 内？
│   ├─ 是 → 必须保留 DOM → 用  :class + CSS display:none   （禁用 v-if）
│   └─ 否 → 卸载可接受？
│       ├─ 是（如自定义组件内互斥 banner）→ 用 v-if  ✅（v-show 在 MP 自定义组件失效）
│       └─ 否（H5/App 专用、或想保留状态）→ 用 v-show（仅 H5/App 可信）
└─ 跨端都要稳 → 无脑 :class + display:none（最通用）
```

---

## 6. 一句话总结

| 机制 | DOM 是否保留 | MP 上切 display 是否可靠 | swiper 内是否可用 |
|---|---|---|---|
| `v-if` | ❌ 卸载 | —（直接移除） | ❌ 打断手势 |
| `v-show` | ✅ 保留 | ❌ 编译成 `hidden`，自定义组件失效 | ✅（但 MP 上隐藏无效） |
| `:style display` | ✅ 保留 | ⚠️ 不可靠 | ✅（但 MP 上隐藏可能失效） |
| `:class` + CSS `display:none` | ✅ 保留 | ✅ 可靠 | ✅ 推荐 |

**通用安全牌：`:class` + `display:none`，既保 DOM 又跨端稳；`v-if` 只在允许卸载、且不在 swiper 内时使用。**
