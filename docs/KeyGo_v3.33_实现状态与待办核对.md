# KeyGo v3.33 实现状态与待办核对清单

> 用途：记录 v3.33 已落地能力 + 未实现/待核对项，便于后期逐一核对。
> 草拟：2026-07-13（帮助页优化时同步整理）
> 关联：帮助页 `app/BLE_Key_Go_App/pages/login/login.vue` 的「规划中功能」卡片仅列摘要，本文件为完整台账。

图例：✅ 已落地 ｜ 🔲 未实现/待核对 ｜ ⚠️ 已知偏差

---

## 一、已落地（✅）

| 模块 | 能力 | 备注 |
|------|------|------|
| Phase 2 双模式 | 汽车 / 电瓶车双模式，模式存 DataFlash（MODE_ADDR 0x7300） | 切换入口在「控制」页底部 |
| RIDE | ebike 双脉冲（PA6，100ms ON / 150ms GAP / 100ms ON）+ LED 独立闪烁 2 次 | LED 与脉冲解耦，杜绝卡死；闪烁节奏 `LED_RIDE_BLINK_TICKS` 可调 |
| 后备箱 | 单路长脉冲（PA6，~2s）+ LED 闪烁 5 次 | `GPIO_PULSE_TRUNK_TICKS` |
| BLE Bonding | 链路层加密（LESC Just Works）+ 应用层 BIND/AUTH(HMAC-SHA256) + 信任列表持久化（DataFlash，≤8 钥匙） | 见 `docs/02-技术方案与专项设计/KeyGo_CH582M_Bonding_Phase0与API清单_v1.0.0.md` |
| 安全门控 | 未绑定→`DENY:NOT_BOUND`；已绑未鉴权→`DENY:AUTH_REQ:<nonce>`；未授权连接 30s 超时强断 | 方案 A+B 合并 |
| RSSI 自动 | Kalman 滤波 + 解锁/锁车进度可见（FF02 `uc/lc/ucnt/lcnt/th`） | v3.31 方案 B |
| 断连处理 | 断连自动锁车（可配延时）、断连清理取消残留定时器 | — |
| App 端 | 先配对再 BIND、可读错误码（readable-errors）、命令队列、原生前台扫描/重连、主题切换、电池优化豁免 | — |
| 修复 | RIDE LED 卡死 / 调参不生效、事件位冲突（0x0100→0x0040）、LED 回调误用宏 | 详见 git 历史 af3397d |

---

## 二、未实现 / 待核对（🔲）—— 后期逐一核对

| # | 项 | 现状 | 建议核对点 |
|---|----|------|-----------|
| T1 | 管理员 / 锁定列表（多 owner 管理） | 当前单 owner 模型，MEMORY 标 TODO | 是否需多钥匙管理？UI 入口？ |
| T2 | 极速模式 GPS 围栏落地 | 已搭框架（utils/geofence.js + AlarmManager 心跳），未真机验证 | 真机验证围栏触发 + 厂商强杀对抗 |
| T3 | 配置(uc/lc)断电持久化一致性 | **当前 per-phone RAM，重启回退默认**（见 T3 说明） | 是否改为持久化？见下方② |
| T4 | App 连接成功自动回推配置 | 代码注释声称「每次连接自动下发」，但未见实际调用（仅手动「下发配置到设备」） | 是否补 auto-push？ |
| T5 | 固件版本号上报 | FF02 `v` 仍为 `3.31.0-b1`，帮助页已写 v3.33 | 是否 bump `KEYGO_FW_VERSION`→`3.33.0`（需重烧） |
| T6 | 带屏设备 LESC+MITM passkey | 当前无头设备 Just Works，预留 `ENCRYPT_*` 回加位 | 仅当换带屏硬件 |
| T7 | 远程临时授权 | 方案文档 § 临时授权，未实现 | 优先级待定 |
| T8 | GATT 加密门控 | 2026-07-10 已回退（FF03/FF04 改回纯 WRITE/READ） | 待带屏设备再加回 |
| T9 | 后台重连三模式真机验证 | 舒适/极速/省电逻辑已写，未全面真机验证 | 真机逐项验证 |
| T10 | RIDE 独立引脚硬件落地 | 当前默认复用 PA6（TRUNK 脚），硬件未单独走线 | 若需独立 RIDE 脚改 `PIN_RIDE_GPIO` |
| T11 | 多语言 / 无障碍 | 未做 | 待定 |

---

## 三、已知偏差 / 待决策（⚠️）

### ② 配置(uc/lc)重启回退 —— 对应 T3
- **现象**：App 下发 uc=3 后，设备重启又显示 `uc=2` + 「配置可能未下发」。
- **根因**（已定位，未改）：
  1. 固件默认 `g_cfgUnlockCount=2`，而 App 默认 `unlockCountRequired=3` → 基线就不一致。
  2. `uc/lc` 写入了 SaveConfig 的 DataFlash 缓冲，但 `KeyGo_SaveConfig()` 仅在 `cooldown_changed` 时调用（`keygo_core.c` ~1019 行）。若本次下发只改了 uc（cooldown 未变）→ 只改 RAM、不落盘 → 重启 revert。
  3. App 侧**未在重连时自动回推配置**（T4），故重启后设备=默认 2、App 本地=3 → 告警恒显。
- **修复方向**：① 把 `if (cooldown_changed)` 改为 `if (changed)` 让 uc/lc/阈值一并持久化；② 对齐默认值（固件 uc 改 3）；③ 补 App 重连自动回推。需重烧验证。

### 安全边界说明（2026-07-10 定稿）
- 无头设备 Just Works 链路层**无 MITM 能力**，强制配对反而破坏 App 联动（序列号读不到、绑定态无法恢复、反复弹配对、RSSI 收不到）。
- **安全边界 = 应用层 BIND + AUTH(HMAC)**，不依赖链路层 passkey。信任模型基于「共享密钥」而非 MAC（规避随机私有地址）。

---

## 四、核对记录（逐条打勾）
> 后期每核对完一项，在此记录结论与 commit。

- [ ] T1 多管理员
- [ ] T2 GPS 围栏真机
- [ ] T3 配置持久化（见②修复）
- [ ] T4 App 自动回推
- [ ] T5 固件版本号 bump
- [ ] T6~T11 见上
