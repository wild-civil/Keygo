# KeyGo 主固件 HID 改造分步计划（方案 A / 无App模式落地）

> 日期：2026-07-16
> 状态：**已按策略 A 实施（固件 v3.34.0，2026-07-16），待真机验收**
> 关联决策：[决策记录_走向耳机式自动解锁_PathA缺口与计划](../决策记录_走向耳机式自动解锁_PathA缺口与计划.md)
> 关联验证：[code/CH582M/HID_Spike_笔记.md](../../code/CH582M/HID_Spike_笔记.md)（Spike 探针真机结论）

---

## 1. 背景与目标

**方案 A 决策**（见决策记录）已确认：要"耳机式"体验 —— 设备被 OS 当作 HID 外设，**无 App 参与**也能自动重连 + 静默加密 + RSSI 自动解锁。

**Spike 探针（已真机验证）** 证明：
1. 设备 GATT 同时挂 `0x1812(HID)` + `0xFF00(业务GATT)` 可共存；
2. 注册 HID 服务后，Android **无 App** 也会主动 `CONNECTED` + `LINK_ENCRYPTED`（OS 接管重连）；
3. 重连速度两大来源：固件广播间隔（可控）+ OS 后台低频扫描调度（主因，固件不可控）；
4. 阶段1 把广播间隔压到 20ms 高占空比后，重连最快 1.6s、多数 3~9s 波动（可接受）。

**本计划目标**：把 Spike 验证过的「四件套」移植进**主固件 `CH582M_BLE_Slave`**，接入 v3.33.5 的 RSSI 自解闸门，使产品具备"靠近自动加密重连 + RSSI 解锁"。Spike 只是探针，价值在主固件落地才算数。

---

## 2. 主固件已有基础（避免重复造轮子）

| 能力 | 主固件现状 | 说明 |
|---|---|---|
| ✅ 断连重启广播 | **已有**（v3.13 `Peripheral_LinkTerminated` + 重试兜底 + 复位兜底） | 四件套第③件**已具备**，无需重做 |
| ✅ 无App模式开关 | 已有 `g_encRequired` + `ENCRYPT:1` 指令 + `Bonding_ApplyPairingMode()`（支持 OS 配对/MITM） | 方案A 的"OS 加密重连"前提已通 |
| ✅ 观测埋点 | 已有 v3.33.5 `[OBS] CONNECTED/DISCONNECTED/LINK_ENCRYPTED` + status 加 `conn/enc` | 直接复用验证重连 |
| ⚠️ 白名单 | `Bonding_Init` **未显式设** `GAPBOND_AUTO_SYNC_WL` | 需补（对齐 Spike 修复 bug1） |
| ❌ HID 服务 | **未注册**（核心缺口） | 本计划重点 |
| ❌ 高占空比 | 仍是 `DEFAULT_ADVERTISING_INTERVAL` | 需改 `TGAP_DISC_ADV_INT` |

---

## 3. 四件套迁移映射

| # | 件 | Spike 做法 | 主固件动作 |
|---|---|---|---|
| ① | 叠加 HID 服务 | `Hid_AddService()` + 广播含 `0x1812` | 引入 HID Profile + 注册（见 §5 难点） |
| ② | 关白名单 | `AUTO_SYNC_WL=FALSE`（hiddev.c + keygo_hid.c 双处） | `Bonding_Init` 显式 `GAPBOND_AUTO_SYNC_WL=FALSE` |
| ③ | 断连重启广播 | 显式 `GAPROLE_ADVERT_ENABLED=TRUE` | **复用 v3.13 已有逻辑**，不动 |
| ④ | 高占空比 | `TGAP_DISC_ADV_INT_MIN=32/MAX=48`（20/30ms） | `Peripheral_Init` 改 TGAP 设置（替换 `DEFAULT_ADVERTISING_INTERVAL`） |

---

## 4. 核心难点：HID 框架 vs 主固件自定义 GAPRole 冲突 ⚠️

**这是本计划最大风险点，单列。**

- WCH HID dev 框架（`hiddev.c`）内部会调用 `GAPRole_PeripheralStartDevice` **接管 GAP 状态机**，并自带 bonding / 协议模式 / 挂起处理。
- 主固件用自己的 `Peripheral_PeripheralCBs`（`gapRolesCBs_t`）+ 丰富业务（`Peripheral_LinkEstablished/Terminated`：断连锁车、RSSI 状态机、命令路由、30s 超时强断、重试复位）。
- **两者不能并存同一 GAP Role。** 两条路：

### 策略 A（推荐首试，低风险）：被动 HID 锚点
- 保留主固件自定义 GAPRole 不动；仅引入 HID GATT 服务 + Report Map，并在广播 UUID 列表加入 `HID_SERV_UUID(0x1812)`，让 OS 扫描即识别为 HID。
- **风险**：若 HID 服务仅靠 GATT 注册、框架未接管，Report Map 可能为空 → OS 不识别为合法 HID → 不自动重连。
- **验收闸门**：真机烧录后，"系统蓝牙忘记→重配对→关蓝牙再开"，看 `[OBS] LINK_ENCRYPTED` 是否**自发**出现（无 App）。通过 = 策略 A 成立。

### 策略 B（兜底，高风险）：HID 框架接管 + 业务桥接
- 用 `HidDev_Register` 接管 GAP，把 `Peripheral_LinkEstablished/Terminated` 的业务逻辑塞进 HID 的 `pfnStateChange` 回调。
- 重写量较大，需逐一迁移断连锁车 / RSSI / 命令路由 / 30s 超时 / 重试复位。
- **仅在策略 A 真机验收失败时启用。**

---

## 5. 分步实施（建议顺序）

- **Step 0 准备**：从 Spike / `CH583EVT` 复制 HID Profile 源文件（`hiddev.c/.h`、`hidconsumerservice.c/.h`、`battservice.c/.h`）到主固件 `Profile/` 目录；确认 MRS 工程把新 `.c` 加入编译。
- **Step 1 高占空比**：`Peripheral_Init` 中 `TGAP_DISC_ADV_INT_MIN=32 / MAX=48`。⚠️ 量产应加"高占空比 N 秒后转低占空比"降速定时器省电。
- **Step 2 关白名单**：`Bonding_Init` 显式 `GAPBOND_AUTO_SYNC_WL=FALSE`（防手机 RPA 轮换后断连重连被拒，对齐 Spike bug1）。
- **Step 3 广播含 HID UUID**：`advertData` 的 16-bit UUID 列表加入 `HID_SERV_UUID`；`appearance` 暂保持 `GENERIC_WATCH`（避免图标变化），观察 OS 是否仍按 HID 处理（HOGP 主要靠 GATT DB 中 `0x1812`）。
- **Step 4 HID 服务接入**：用**策略 A**，注册 `Hid_AddService()` + Report Map；若策略 A 验收不过，切换**策略 B**。
- **Step 5 接 RSSI 自解闸门**：确认 `g_encRequired`（无App模式）+ `LINK_ENCRYPTED` 仍作为解锁闸门（v3.33.5 已埋 `conn/enc`）；验证"断连→OS 自动加密重连→RSSI 达阈自动解锁"全链路。
- **Step 6 编译 / 烧录 / 真机验收**：
  - MRS 清 obj 重新编译主固件；
  - 手机"忘记设备→重新配对"（避免旧 bond 半残）；
  - 关蓝牙再开，看是否自发 `[OBS] LINK_ENCRYPTED`（无App自动重连）；
  - 远近走动测重连速度（预期 1.6s~9s 波动，对齐 Spike）；
  - 验证业务 GATT（`FF01`/`FF03`）仍正常（`BIND`/`AUTH`/控车）。

---

## 6. 风险与已知坑

- **HID 框架 GAP 接管冲突**（见 §4）——本计划头号风险。
- **白名单 + RPA**（Spike bug1，已解决，照搬即可）。
- **高占空比耗电**（量产需降速定时器）。
- **编译依赖**：HID 服务规范要求 Battery 服务；主固件已有 `Battery_AddService`（注意头文件名 `battery_service.h` vs Spike 的 `battservice.h`，include 名不同）。
- **版本号**：验收通过后 `KEYGO_FW_VERSION` 建议升一档（如 `3.33.5 → 3.34.0`）标记 HID 锚点落地。

---

## 7. 与已有文档关系

- 决策依据：[决策记录_走向耳机式自动解锁_PathA缺口与计划](../决策记录_走向耳机式自动解锁_PathA缺口与计划.md)
- Spike 验证详录：[code/CH582M/HID_Spike_笔记.md](../../code/CH582M/HID_Spike_笔记.md)
- 重连模式设计：[KeyGo_v3.23_智能重连模式设计v1.0.1](KeyGo_v3.23_智能重连模式设计v1.0.1.md)
- 已落地观测埋点：commit `1402822`（v3.33.5）
- 已落地 Spike 探针：commit `fa16e50`

---

## 8. 实施记录（策略 A · 被动锚点 · v3.34.0 · 2026-07-16）

**决策**：按策略 A 走——保留主固件自定义 `GAPRole`（`Peripheral_PeripheralCBs` 的断连锁车/RSSI/命令路由/30s 超时全保留），仅叠加 HID-over-GATT 服务数据库，让 OS 把设备当 HID 外设、已配对时自动重连。

**关键工程取舍（慢工出细活）**：
- **未照搬 Spike 的 WCH `hiddev.c`/`hidconsumerservice.c`**。那套文件会 `GAPRole_PeripheralStartDevice` 接管 GAP，且与主固件已存在的 `battery_service.c`（同名不同 API `Battery_*`）、`scanparamservice` 冲突（重复 `0x180F` 服务 / 缺失句柄依赖）。
- **改为自包含模块 `Profile/keygo_hid.c` + `Profile/keygo_hid.h`**：精确复刻 Spike 验证过的 HID GATT 属性表（Service `0x1812` + Information + Report Map + Control Point + Protocol Mode + 入报告+CCCD + Reference + Feature），但**去掉「包含电池服务」可选属性**（HID-over-GATT 规范中可选，主固件已有独立 `0x180F` 电池服务），实现零外部耦合。
- HID 专属常量用 `KG_` 前缀在 `keygo_hid.h` 自包含定义（取值对齐 WCH 例程 / BLE HID 规范），通用 ATT/GATT UUID 仍引用主固件 LIB（`CH58xBLE_ROM.h`），避免宏重定义。
- 自带读/写回调（`KeyGo_HidReadAttrCB`/`KeyGo_HidWriteAttrCB`），复刻 WCH 语义：Report Map 支持 offset 长读、Protocol Mode/Control Point/CCCD 合规读写（被动锚点不实际发送 HID 报告）。

**改动文件清单**：
| 文件 | 改动 |
|---|---|
| `Profile/keygo_hid.h`（新） | HID 锚点模块头：常量 + `KeyGo_Hid_AddService()` 接口 |
| `Profile/keygo_hid.c`（新） | HID GATT 属性表 + 读/写回调 + 服务注册 |
| `APP/peripheral.c` | ① `#include "keygo_hid.h"` ② `Peripheral_Init` 调 `KeyGo_Hid_AddService()` ③ `Peripheral_BuildAdvertData` 16-bit UUID 列表加入 `HID_SERV_UUID(0x1812)` ④ 高占空比广播(32/48=20/30ms) 仅 `g_encRequired=1`(无App模式) 启用，普通模式维持 50ms |
| `APP/bonding.c` | ① `Bonding_Init` 显式 `GAPBOND_AUTO_SYNC_WL=FALSE`（修 RPA 轮换重连被拒，对齐 Spike bug1）② `Bonding_ApplyPairingMode` 随 `encRequired` 同步广播占空比 |
| `APP/include/keygo_core.h` | `KEYGO_FW_VERSION` `3.33.5 → 3.34.0` |

**MRS 工程**：`.cproject` 用文件夹自动包含（排除列表未逐文件列 `.c`），`keygo_hid.c` 放入 `Profile/` 即自动编入，**无需改工程文件**。

**验收闸门（同 Spike）**：烧录后手机「系统蓝牙忘记→重配对(ENCRYPT:1 使无App模式)→关蓝牙再开」，串口看是否自发 `[OBS] LINK_ENCRYPTED`（无 App 自动重连）。四件套第③件「断连重启广播」v3.13 已具备，本版未动。

**已知风险 / 待办**：
- ★ 策略 A 验收核心假设：仅 GATT 注册 HID 库 + 广播含 `0x1812` 即可让 OS 识别为合法 HID 并自动重连（Spike 用完整 `HidDev_Register` 接管 GAP 已证；本版未接管 GAP，若真机验收 `[OBS] LINK_ENCRYPTED` **不自发**，则回退策略 B：用 WCH `HidDev_Register` 接管 GAP，把 `Peripheral_LinkEstablished/Terminated` 业务桥接进 HID 的 `pfnStateChange`）。
- 量产应加「高占空比 N 秒后转低占空比」降速定时器省电（本版无App模式常驻 20ms，测试期可接受）。
- 编译/烧录/真机验收由用户执行（本环境无 CH582 工具链，未编译验证）。
