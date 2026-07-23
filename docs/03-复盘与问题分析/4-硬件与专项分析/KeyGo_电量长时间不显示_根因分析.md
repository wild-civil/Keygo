# 「App 长时间不显示电量」根因分析

> 现象：连接成功后，控制页电池区域长时间显示 `---`（即 `batteryLevel === -1`），有时要很久才出现，甚至一直不出现。
> 状态：根因已定位（2026-07-23）。**修复决策（2026-07-24）**：① App 侧 `_fetchBatteryLevel` GATT 读取重试（3 次退避）**现已实施**；② 固件「连接即推送电量」**刻意推迟到「外部 ADC 采集真实电池」那一轮固件改动一起 bump**（避免同一 `battery_service.c` 刷两次固件）。详见 §3。

---

## 1. App 侧电量的全部数据源

控制页 `batteryLevel`（`stores/ble.js`）只来自以下 **3 个独立源**，且彼此不互补：

| # | 数据源 | 代码位置 | 触发条件 | 可靠性 |
|---|---|---|---|---|
| ① | **扫描缓存** `cached.batteryLevel` | `ble.js` 连接收尾（约 2664 行） | 连接前刚做过一次**带电池 Service Data 的扫描** | 仅"先扫后连"时有值；从前台服务/已知设备列表直接重连时为空 |
| ② | **GATT Read 兜底** `_fetchBatteryLevel()` | `ble.js` ~2087 行，连接后延迟 2.5s 读一次 | `batteryLevel < 0` 时才读 | **一次性**，且代码注释自承"偶发 property not support，疑似手机 GATT 缓存缺 READ 位" → 失败即放弃 |
| ③ | **Battery Notify**（`0x2A19` CCCD 订阅） | `ble.js` 订阅 + `battery_service.c` `Battery_Notify()` | 固件 `Battery_UpdateLevel()` 检测到**电量变化**时推送 | 仅"电量变化"才推（见下） |

> 注意：电量**不在** FF02 status JSON 里（该 JSON 无电池字段），不要误以为来自 FF02 Notify。

---

## 2. 固件侧根因（核心）

`Profile/battery_service.c` 的 `Battery_UpdateLevel()`：
```c
if (newLevel != batteryLevel) {       // ★ 只有"电量真正变化"才 Notify
    batteryLevel = newLevel;
    PRINT("[BATT] Level updated: %d%% ...\n", batteryLevel, vdd_mV, adcVal);
    Battery_Notify();
}
```
`SBP_BATTERY_CHECK_EVT`（`peripheral.c`，每 `SBP_BATTERY_CHECK_PERIOD = 48000 tick ≈ 30s` 触发一次）调用 `Battery_UpdateLevel()`，但**只在 `newLevel != batteryLevel` 时**才 `Battery_Notify()` 推给已连接的手机。

而 `Battery_Notify()` **仅在两处被调用**：`Battery_UpdateLevel()` 内部（变化才推）。**连接建立时没有任何主动推送。**

### 关键推论
对一台电压基本恒定的 KeyGo（典型如 LDO 稳压 3.3V，或缓慢放电、一次会话内不跨 1% 边界的纽扣电池）：
- 连接期间电量几乎**不变** → `newLevel == batteryLevel` → **永不 Notify**；
- 于是 App 的 ③号源（最稳定、常驻的推送通道）**整段会话都收不到任何电量**；
- 若此时 ①扫描缓存为空（直接重连/前台服务拉起）**且** ②一次性 GATT Read 又失败（注释已承认偶发）→ `batteryLevel` 恒为 `-1` → 控制页**永久显示 `---`**，直到电平恰巧变化或下次重连。

这正是"过很长时间都不显示电量"的成因：**缺一个"连接即推送当前电量"的主动通道，且唯一的兜底 GATT Read 既一次性又脆弱。**

---

## 3. 推荐修复与实施状态

| 修复项 | 位置 | 状态 |
|---|---|---|
| ① App GATT 读取重试（3 次退避） | `stores/ble.js` `_fetchBatteryLevel()` | ✅ **已实施**（2026-07-24） |
| ② 固件连接即推送电量 | `peripheral.c` 连接事件 + `battery_service.c` | ⏸ **推迟**：随「外部 ADC 采集」固件轮一起 bump |
| ③ 固件每次检查都推（可选） | `SBP_BATTERY_CHECK_EVT` | ⏸ 随 ② 一并考虑 |

### 3.1 固件：连接建立后主动推一次当前电量（主修复 · 推迟到外部 ADC 轮）
> ⚠ **开发修复指南 / TODO**：此修复**不要现在单独做**。当前电量取自 3.3V 引脚（恒 ~100%，不变化 → `Battery_Notify` 整段会话不触发，问题主要在前台服务/已知设备直接重连场景）；后续要切到**外部 ADC 采集真实电池**，届时电平会变化、变化 Notify 才生效，但重连后电平≈上次值仍会长时间不推。故在「外部 ADC」那一轮固件改动里**一并**做：
>
> 在 `peripheral.c` 连接成功处理（`g_deviceConnected = 1` 段，约 766 行）里，**延迟约 3s**（确保手机已订阅 CCCD，App 侧 `~800ms` 后订阅 Battery Notify）后调一次：
```c
Battery_UpdateLevel();   // 刷新最新测量
Battery_Notify();        // 主动把当前电量推给已连接手机
```
> 实现：新增 `SBP_BATTERY_INIT_NOTIFY_EVT`（或复用现有定时器），连接时 `tmos_start_task(..., ~3000 tick)`，事件里 `Battery_UpdateLevel(); Battery_Notify();`。
> - 若手机尚未订阅 CCCD，`Battery_Notify()` 内部会按 `battLevelClientCharCfg` 判断直接 return，安全无副作用；
> - 手机侧 `_fetchBatteryLevel` 的 GATT Read（重试 3 次，2.5s 起）与该推送双保险，任一成功即得值。
> - 该轮需 bump `KEYGO_FW_VERSION`（接续当前 fix8 之后）。

### 3.2 固件（可选增强）：电量检查改为"每次都推"
将 `SBP_BATTERY_CHECK_EVT` 改为每次都 `Battery_Notify()`（不只变化才推）。代价是每 30s 多一帧 Notify（带宽可忽略，未订阅时自动丢弃），好处是"手机晚订阅"也能在下个 30s 周期拿到值。可与 3.1 择一或并存（同随外部 ADC 轮落地）。

### 3.3 App：硬化 GATT Read 兜底（辅助 · 已实施）
`_fetchBatteryLevel()` 已由"读一次放弃"改为**重试 3 次（退避 800ms）**，覆盖"偶发 property not support"的 GATT 缓存瞬态；重试途中若被 Notify/广播补到则提前退出。代码内已注释指向本节的固件推迟说明。

---

## 4. 影响面与风险
- 仅新增"连接即推送电量"，不改既有变化推送与状态机；不影响 `fwsec`、不改 `KSTATE_*` 语义；
- 若采用 3.2（每次都推），略增 BLE 广播外流量，但 Battery Service 本就低频，可接受；
- 需 bump `KEYGO_FW_VERSION` 到 `3.36.3-fix9`（若动固件）。

---

## 5. 验证清单
1. 重编固件（fix9）+ 重编 App；
2. 从前台服务/已知设备列表**直接重连**（无新鲜扫描）→ 控制页应在数秒内显示电量，而非 `---`；
3. GATT Read 故意制造失败场景下，仍由固件推送拿到电量；
4. 电量真实变化时 Notify 仍正常刷新；
5. 连接期间 RSSI/状态机/解锁命令不受影响。
