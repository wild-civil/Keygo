# 蓝牙开启交互：modal 双弹 vs banner 引导（autoEnable 门控）

> 来源：KeyGo App `stores/ble.js` 的 `initBluetooth({ autoEnable })` 门控（fix11.1，commit 8f1181d）。现象：冷启动/自动连时蓝牙未开，系统"开启蓝牙"框与 App 自身权限框**双弹**，体验差。
> 目标：讲清"何时该打断用户弹 modal、何时该用内联 banner 引导"的交互设计取舍。UI/UX 复盘素材。

---

## 0. 现象（bad）

App 冷启动走自动连流程，若此时系统蓝牙是关的：
1. 系统弹出"KeyGo 想要开启蓝牙"的系统对话框；
2. 同时 App 自身可能弹权限/提示框；
→ **两个弹窗叠在一起（双弹）**，用户一脸懵，尤其刚打开 App 还没操作就被系统框打断。

---

## 1. 机制：autoEnable 控制"是否自动触发系统开启框"

`initBluetooth` 接收一个 `autoEnable` 参数，决定"蓝牙未开启时，是否主动去触发系统的开启蓝牙流程"：

```js
// stores/ble.js —— 自动连准备路径
this._ensureGlobalListeners()
this._ensureForegroundService()
try {
  // ★ fix11.1: 自动连准备路径传 autoEnable:false → BT 关时不弹系统框（由红 banner 引导），避免冷启动双弹
  await initBluetooth({ autoEnable: false })   // 打开适配器 + 申请权限
  this._adapterReady = true
  await this._reconcileBtState()
}
```

- `autoEnable: true`（默认）：蓝牙关 → 主动拉起系统"开启蓝牙"框。
- `autoEnable: false`：蓝牙关 → **不弹系统框**，仅把状态记为 `off`，交给 UI 引导。

---

## 2. 修复：被动流程不弹框，改用红 banner 引导

区分"主动操作"和"被动/后台流程"：

| 路径 | autoEnable | 蓝牙关时行为 | 理由 |
|---|---|---|---|
| 用户**手动**点"连接"按钮 | `true`（默认） | 弹系统框开启蓝牙 | 用户主动操作，打断可接受 |
| **冷启动 / 自动连**准备路径 | `false` | 不弹框，红 banner 显示"蓝牙已关闭，点击开启" | 被动流程，避免打扰；由用户自己点 banner 触发 |

红 banner 即 `BtStateBanner`（见《小程序 v-show/v-if/display 切换》篇），仅显示在连接页/控制页：
```html
<BtStateBanner v-show="tabIndex === 0 || tabIndex === 1" />
```
用户看到红 banner → 主动点"开启" → 此时才触发系统框（用户主动，合理）。

---

## 3. 绿 banner：just_enabled 瞬时态（已知排查点）

`BtStateBanner` 里红/绿两条 banner 用 `v-if` 互斥：
```html
<view class="bt-off-banner"  v-if="!bleStore.connected && bleStore.btState === 'off'">        🔴 蓝牙已关闭 </view>
<view class="bt-on-banner"   v-if="!bleStore.connected && bleStore.btState === 'just_enabled'"> 🟢 正在开启蓝牙... </view>
```
- 绿 banner 对应 `btState === 'just_enabled'`：蓝牙刚被开启、系统正在就绪的**瞬时态**，提示"正在开启"。
- 已知分析：该状态的触发链路在**纯 mp-weixin**环境曾被判定为不可达（仅原生插件 / 自定义调试基座路径会赋值），真机纯 mp-weixin 若出现绿 banner 与代码预期矛盾时，应优先怀疑**测的是自定义基座而非纯 MP 包**，而非代码逻辑。属已知排查点，落地时以真机日志为准。

---

## 4. 知识点：交互设计原则

- **主动操作才打断（modal）**：用户点了按钮 → 弹系统框/确认框，符合预期。
- **被动/后台流程用内联引导（banner/inline）**：冷启动、自动重连、心跳等"用户没主动要"的时机，**不要**自动弹系统框，改在界面上给出轻量引导，让用户自己决定。
- **避免冷启动双弹**：系统框 + 自绘框同时出现最伤体验，用"被动路径不弹、引导代替"化解。
- banner 优于 modal 的点：不阻断手势、不抢焦点、可常驻提示，适合"状态类"信息（蓝牙关、未连接、重连中）。

---

## 5. 经验法则

- 系统级弹窗（蓝牙 / 定位 / 通知 / 相册）**谨慎自动触发**，尤其在冷启动、后台、自动流程里。
- 区分"用户主动触发"与"系统/后台触发"，前者可 modal，后者走内联引导。
- 状态类提示优先 banner/inline，确认类/危险操作才用 modal。
