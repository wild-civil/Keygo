# 电瓶车「靠近直接进入骑行模式」切换设计文档 v1.0

> 需求：电瓶车射频钥匙有 3 个按键，解锁/锁车只能控制电瓶车是否解锁（通电），不能直接让车进入骑行模式。当前 App 默认逻辑只按 RSSI 控制电瓶车是否解锁。用户希望加一个可自由切换的选项：
> ① 靠近仅解锁；② 靠近直接进入骑行模式。
> 因为每个人需求不同，选项应可自由更换。

---

## 0. ★ 关键澄清：靠近解锁是谁驱动的？

你原以为「根据 RSSI 控制电瓶车是否解锁」是 App 逻辑，但实测是**固件 RSSI 状态机**在驱动：

`code/CH582M/CH582M_BLE_Slave/APP/keygo_core.c:681` `KeyGo_ProcessStateMachine()` 解锁分支（`:781-809`）：
```c
if (osEncGrants || (sessionAuth && !g_encRequired)) {
    if (rssi >= cfg->unlock) { g_unlockCounter++; if (...) { g_keyState=UNLOCKED; KeyGo_Unlock(); } }
    else if (rssi <= cfg->lock) { ... KeyGo_Lock(); }
}
```
- 这个分支在 `g_encRequired=1`（**无 App 模式**，靠 OS 系统配对加密授权）下**也能触发** —— 手机连上后设备自己按 RSSI 解锁，**不需要 App 在场**。
- **推论**：「靠近进入骑行模式」的偏好**必须存进固件 DataFlash**（设备级、跨手机），不能只放 App。否则无 App 模式靠近时仍只解锁、不骑行，与你的期望不一致。

> **★ 2026-07-19 追加澄清（避免反复绕回）**：你最初设想"App 侧根据电瓶车模式切换开关方式"——这套交互**完全正确**，App 就是控制面板。区别只在于**开关的终态落在哪**：
> - 「靠近自动解锁/骑行」的真正执行者是**固件 RSSI 状态机**，不是 App（App 不在执行链上，无 App 模式下甚至完全不在场）。
> - 若偏好只存 App，无 App 模式靠近时永远只能解锁 → 违背期望。故开关选了之后必须 `EPRX` 下发并**持久化到固件 DataFlash**。
> - App 的职责 = UI 显示（仅 ebike 可见）+ 下发命令 + 连上后对账自愈（防配对抖动丢配置）。
> - 一句话：**App = 控制面板（UI / 下发 / 对账），固件 = 执行者 + 记忆体**。"开关仅 ebike 可见"也与你的设想一致（car 模式下固件/App 都忽略该偏好）。

---

## 1. 设计总览

| 层 | 改动 |
|---|---|
| 固件 | 新增配置字节 `g_ebikeProxMode`（0=仅解锁[默认] / 1=靠近骑行），存 DataFlash |
| 固件 | `HandleCommand` 新增 `EPRX:0\|1` 命令（复用现有文本协议） |
| 固件 | `KeyGo_ProcessStateMachine` 解锁分支：ebike 且 flag=1 时调 `KeyGo_Ride()` 并置 `keyState=UNLOCKED` |
| 固件 | status JSON 新增 `er` 字段，App 据此反映真实态 |
| App | config 页（仅 ebike 可见）分段按钮「①仅解锁 ②直接骑行」 |
| App | 下发 + 连接对账自愈（**完全仿 `noAppMode` 的 `_noAppModeDirty` 机制**） |

---

## 2. 固件细节

### 2.1 配置的存储（参照 `KeyGo_SaveMode` / `KeyGo_LoadMode`）
现状（`keygo_core.c:1346-1373`）：
- 模式存于 `KEYGO_MODE_ADDR`（偏移 0x7300，物理 0x77300），单字节独占一页。
- `KeyGo_SaveMode`：`EEPROM_ERASE(KEYGO_MODE_ADDR, 256)` 后 `EEPROM_WRITE(..., &val, 1)`。
- `KeyGo_LoadMode`：`EEPROM_READ` 该字节，`0xFF` 未初始化视为 car。

**改动**：把 MODE 页扩成 2 字节 —— `[0]=设备模式`, `[1]=ebikeProxMode`。
- `KeyGo_SaveMode` 改为一次擦页后写 2 字节（或新增 `KeyGo_SaveEbikeProx` 写 `[1]` 并保持 `[0]`）。
- `KeyGo_LoadMode` 同时读 `[1]` 到 `g_ebikeProxMode`。
- ⚠️ EEPROM 写只能 1→0，car→ebike 等跨值变更必须先擦页（现有 SaveMode 已做），扩 2 字节时仍沿用「先擦后写」，安全。

> 也可选放 `KEYGO_ENCRYPT_ADDR`（0xFF 页，无 App 模式标志的同页）相邻字节，范式一致；但放 MODE 页语义更聚拢（都是「ebike 行为」），推荐放 MODE 页。

### 2.2 新命令 `EPRX:0|1`（`HandleCommand`，`keygo_core.c:1080`）
仿 `MODE:` 处理（`:1147`）：
```c
if (len > 5 && upper 前缀 "EPRX:") {
    const char *v = cmd + 5;
    uint8_t ep;
    if (KEYGO_STREQ(v, "0", 1)) ep = 0;
    else if (KEYGO_STREQ(v, "1", 1)) ep = 1;
    else return;
    if (g_deviceMode != 1) { KeyGo_SendRawNotify("DENY:NOT_EBIKE"); return; }  // 仅 ebike 有意义
    g_ebikeProxMode = ep;
    KeyGo_SaveEbikeProx(ep);   // 持久化
    KeyGo_NotifyStatus();      // 回状态（含新 er 字段）
    return;
}
```

### 2.3 状态机解锁分支（★ 重要修正点）
`keygo_core.c:804` 当前：
```c
if (g_unlockCounter >= g_cfgUnlockCount && g_keyState != KSTATE_UNLOCKED) {
    g_keyState = KSTATE_UNLOCKED;
    KeyGo_Unlock();
    ...
}
```
改为（仅 ebike + flag）：
```c
if (g_unlockCounter >= g_cfgUnlockCount && g_keyState != KSTATE_UNLOCKED) {
    if (g_deviceMode == 1 && g_ebikeProxMode) {
        g_keyState = KSTATE_UNLOCKED;   // ★ 必须置，否则状态机仍认为 LOCKED（见下）
        KeyGo_Ride();                   // 双脉冲骑行
    } else {
        g_keyState = KSTATE_UNLOCKED;
        KeyGo_Unlock();
    }
    ...
}
```
**为什么必须 `g_keyState = KSTATE_UNLOCKED`？** 经核查 `KeyGo_Ride()`（`keygo_core.c:464`）**只发双脉冲 + 闪 LED，并不设置 `g_keyState`**（对比 `KeyGo_Unlock` `:1123`、`KeyGo_Lock` `:1138` 都会设）。若不在此处补设：
- 离场（RSSI 掉到 lock 阈值）时，状态机判断 `g_keyState != KSTATE_LOCKED` 才锁（`:816`）——此时 keyState 仍是 LOCKED，分支不触发 `KeyGo_Lock`，**车实际在骑行/通电态却不被锁**；
- LED 闪烁结束后按 `g_keyState` 恢复（`:529`），会恢复成「灭」（LOCKED 态），与「已骑行」矛盾；
- 下次靠近时 `g_keyState != KSTATE_UNLOCKED` 为真，又会调 `KeyGo_Unlock`，逻辑混乱。
→ **在 proximity 路径显式置 `KSTATE_UNLOCKED` 是必做项**，与 `KeyGo_Unlock` 行为对齐。

### 2.4 status JSON 加 `er` 字段
`KeyGo_NotifyStatus`（`keygo_core.c:869`）的 snprintf（`:910`）追加 `,\"er\":%d` 与参数 `(int)g_ebikeProxMode`。
- `STATUS_JSON_MAX_LEN=272`，当前 JSON 有余量，加一个字段安全。
- App 解析后反映开关真实态，用于对账。

---

## 3. App 细节

### 3.1 状态与下发（仿 `noAppMode` 范式）
`stores/ble.js:4142` `setNoAppMode` 范式：
- 本地状态 `ebikeProxMode`（默认 false=仅解锁）；
- `_ebikeProxModeDirty` 脏标记：切换后即使未连接也先记录期望态，连上后由 status 对账自愈；
- 连接建立 / status 回调里比对设备 `er` 与本地 `ebikeProxMode`，不一致则 `enqueueWrite(() => rawSendCommand(this.deviceId, this.ebikeProxMode ? 'EPRX:1' : 'EPRX:0'))`，一致则清脏标记。
- 设备模式非 ebike 时，该开关在 UI 隐藏且不对账。

### 3.2 UI（config.vue，仅 ebike 可见）
分段按钮：
```
靠近时：[ ①仅解锁 ] [ ②直接骑行 ]
```
- 文案明确告知：「② 靠近即通电骑行」（避免用户误以为只是解锁）。
- 切换即调 store 设置（乐观更新 + 脏标记对账）。

---

## 4. 边界与安全性
- **默认 = 仅解锁**（= 现状行为），切换是「更激进」选项，安全默认值成立。
- **未降低安全性**：proximity 触发仍走 `osEncGrants || sessionAuth` 闸门（`:781`），与解锁完全一致。
- **与手动 RIDE 不冲突**：手动 `RIDE` 命令（`:1160`）随时可点；靠近骑行是自动路径，二者独立。
- **离场锁车**：因 §2.3 已置 `KSTATE_UNLOCKED`，离场仍能正常 `KeyGo_Lock()`，符合预期。
- **恢复出厂**：BOOT 长按恢复出厂应同时清 `g_ebikeProxMode`（回到仅解锁默认），与模式重置一致。

---

## 5. 风险与验证清单
1. 烧录后：ebike + `EPRX:1`，手机靠近 → 设备应发双脉冲（骑行）且 `keyState=UNLOCKED`、LED 反映解锁；走远 → 正常锁车。
2. `EPRX:0`（默认）：靠近仅解锁，行为与现状一致。
3. car 模式发 `EPRX:1` → 设备回 `DENY:NOT_EBIKE`，App 不报错。
4. 无 App 模式（OS 加密重连）下靠近：应仍按 `g_ebikeProxMode` 执行（验证配置确实在固件侧生效，不依赖 App 在场）。
5. 连接对账自愈：配对抖动 / 重启后，`er` 与本地开关最终一致。
6. 恢复出厂后 `er` 回到 0。

---

## 6. 与 O3 阶段 b 的关系
两者独立，但**都动固件**，建议合并到**同一次固件版本**烧录验证，减少来回。工作量：固件（HandleCommand + 状态机分支 + Flash 持久化 + status 字段）中；App（UI 分段 + store + 对账）中低。

---

## 7. 待办 / 开放问题
- [ ] 确认 `KeyGo_Ride` 是否需在状态机外也被要求置 `keyState`（手动 RIDE 命令是否也想反映解锁态？本文仅要求在 proximity 路径补设，手动 RIDE 维持现状，待定）。
- [ ] 决定 `g_ebikeProxMode` 存 MODE 页 `[1]` 还是 ENCRYPT 页相邻字节。
- [ ] config.vue UI 文案最终版。
- [ ] 真机验证无 App 模式靠近骑行、离场锁车、对账自愈。
