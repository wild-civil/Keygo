# 电瓶车「骑行态显示」设计文档 v1.0

> 需求：电瓶车按下「骑行」(双击脉冲) 后，控制页应显示「骑行模式」，而非「已锁车」或「已解锁」。
> 因为电瓶车的骑行模式（解锁 + 直接启动骑行）和汽车「解锁后还要自己拧油门」语义不同，也和汽车/电瓶车共用的「后备箱」(一次性脉冲、不改锁态) 完全不同 —— 应作为一个独立、持续的状态呈现给用户。
> 关联设计：靠近骑行切换偏好见 `../3-自动解锁与无App/KeyGo_电瓶车靠近骑行切换设计v1.0.0.md`。

---

## 0. 背景与根因（为什么要做这个）

v3.36.3-fix8 之前，手动按下「骑行」后控制页仍显示「已锁车」。根因：

- 固件手动 RIDE 命令分支（`keygo_core.c` `HandleCommand` 的 `RIDE:` 段）只调 `KeyGo_Ride()`，**没有置 `g_keyState`**；
- 状态报文 `st` 字段纯由 `g_keyState` 推导 → 固件仍报 `LOCKED` → App `stateText` 显「已锁车」；
- 协议里**本就没有"骑行"这个状态**，App 的 `stateText` 只认 `LOCKED / UNLOCKED / ACTION`。

副作用：固件以为还锁着 → 离场 RSSI 状态机虽会自动锁车（判断用 `!= LOCKED`，碰巧正确），但再次进近 proximity 又会重复发 ride 双脉冲。

---

## 1. 设计决策（用户拍板）

| 决策点 | 选择 | 理由 |
|---|---|---|
| ① 骑行是否独立状态 | **是**，独立 `KSTATE_RIDE` | 语义区别于「已解锁」与「后备箱」；用户一眼确认"这是骑行态的车" |
| ② 「骑行模式」显示到何时 | **显示到锁车为止** | 最直观，符合"我现在处在骑行态"的持续认知；与 proximity 骑行态统一 |

范围约束：**仅电瓶车（ebike）** 进入 RIDE 态；car 模式第三键是后备箱，RIDE 被固件 `DENY:NOT_SUPPORTED`，UI 不变。

---

## 2. 固件改动（v3.36.3-fix8，commit `7d3746d`）

### 2.1 新增枚举 `KSTATE_RIDE`
`include/peripheral.h`：
```c
typedef enum {
    KSTATE_LOCKED   = 0,
    KSTATE_UNLOCKED = 1,
    KSTATE_ACTION   = 2,
    KSTATE_RIDE     = 3   // 电瓶车骑行态（解锁+启动骑行），st 报 "RIDE"，App 显示「骑行模式」
} KeyState_t;
```

### 2.2 `KeyGo_Ride()` 入口置 RIDE
`keygo_core.c`：
```c
void KeyGo_Ride(void)
{
    g_keyState = KSTATE_RIDE;      // ★ 骑行态=已解锁语义
    if (g_rideStep != 0) return;   // 上一轮双脉冲未结束，忽略（keyState 已置 RIDE）
    ...
}
```

### 2.3 靠近骑行分支去重
`KeyGo_ProximityAct()` 原显式置 `g_keyState=KSTATE_UNLOCKED` 再调 `KeyGo_Ride()`，现改由 `KeyGo_Ride()` 内部置 RIDE（去掉重复赋值）：
```c
if (g_deviceMode == 1 && g_ebikeProxMode == 1) {
    KeyGo_Ride();   // 内部置 KSTATE_RIDE
}
```

### 2.4 状态报文 `st` 映射新增 RIDE
`KeyGo_BuildStatusJson()`：
```c
g_keyState == KSTATE_LOCKED   ? "LOCKED"   :
g_keyState == KSTATE_UNLOCKED ? "UNLOCKED" :
g_keyState == KSTATE_RIDE     ? "RIDE"     : "ACTION",
```

### 2.5 手动 RIDE 命令后补 `KeyGo_NotifyStatus()`
原 `RIDE:` / `TRUNK:` 分支**不推送状态**（而 `UNLOCK` / `LOCK` 会），导致 App 要等下一个周期通知才刷新。补齐一致：
```c
if (g_deviceMode == 1) {
    KeyGo_Ride();
    KeyGo_NotifyStatus();   // 骑行改变 keyState，立即推送状态让 App 显示「骑行模式」
    ...
}
```

### 2.6 RIDE = 已解锁语义（所有比较点）
RIDE 在以下"已解锁"语义处一律等同已解锁（改动点）：
- **LED 恢复**：长按提前松手 / trunk 闪烁结束 / ride 闪烁结束 / obs 闪烁结束 + 上电同步（`peripheral_main.c`），判断由 `== KSTATE_UNLOCKED` 改为 `== UNLOCKED || == RIDE`；
- **断连自动锁车**（`peripheral.c` 两处）：`g_keyState == KSTATE_UNLOCKED || KSTATE_RIDE`；
- **进近解锁触发防重入**：`keygo_core.c` 进近分支 `g_keyState != KSTATE_UNLOCKED` 改为 `!= UNLOCKED && != RIDE`（已在骑行态时再次进近不再重复发双脉冲）；
- **离场锁车触发**：本就用 `g_keyState != KSTATE_LOCKED`，RIDE 自然纳入 → 骑行中离场自动锁车。✅ 无需改。

> 手动解锁 `KeyGo_Unlock()`（普通进近解锁）保持 `KSTATE_UNLOCKED` 不变。

### 2.7 版本
`include/keygo_core.h`：`KEYGO_FW_VERSION` `3.36.3-fix4` → `3.36.3-fix8`（fix5/6/7 为 App UI 改动，未 bump 固件）。

---

## 3. App 改动（stores/ble.js）

### 3.1 `stateText` 映射
```js
stateText: (state) => {
  const map = { 'LOCKED': '已锁车', 'UNLOCKED': '已解锁', 'RIDE': '骑行模式', 'ACTION': '执行中...' }
  return map[state.deviceState] || state.deviceState
},
```

### 3.2 `isUnlocked` 纳入 RIDE
骑行态卡片走绿色样式、连接页进度条满格（等同已解锁）：
```js
isUnlocked: (state) => state.connected && (state.deviceState === 'UNLOCKED' || state.deviceState === 'RIDE'),
```

### 3.3 命令等待不卡
`_waitCmdResult` 收到非 `ACTION` 状态即 resolve；手动 RIDE 已补 `KeyGo_NotifyStatus()` 即时推送 `st=RIDE`，骑行命令立即确认、不卡等。

> 无协议破坏性变更，`fwsec` 不变；旧 App 收到未知 `st="RIDE"` 走兜底显示原串。

---

## 4. 行为确认

| 场景 | 固件 `st` | App 控制页 |
|---|---|---|
| 锁车 | `LOCKED` | 已锁车 |
| 解锁 / 靠近仅解锁 | `UNLOCKED` | 已解锁 |
| **按下骑行 / 靠近进入骑行** | `RIDE` | **骑行模式**（绿色卡片） |
| car 模式按骑行 | `DENY:NOT_SUPPORTED` | 不变 |
| 骑行中离场 / 手动锁车 | `LOCKED` | 回「已锁车」 |

「骑行模式」显示**持续到锁车为止**（锁车 / 离场锁车 → `LOCKED` → 回「已锁车」）。

---

## 5. 验证清单
1. 重编固件 fix8 + 重编 App 到手机；
2. ebike 模式点「骑行」→ 控制页**即时**显示「骑行模式」、卡片绿色；
3. 离场（RSSI 低于 lock 阈值）自动锁车 → 回「已锁车」；
4. 已在骑行态时再次进近**不再重复发双脉冲**（进近防重入）；
5. 骑行中 LED 亮、断连后按配置锁车。
