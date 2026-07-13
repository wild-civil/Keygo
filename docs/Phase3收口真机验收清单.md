# Phase 3 收口 · 真机验收清单（含 fwsec 能力字段验证）

> 目的：把「Phase 3 连接可靠性」已落地能力逐项在真机跑通并签字，作为质量门禁；同时验证本次 [2] 新增的 `fwsec` 安全协议能力字段。
> 形成于 2026-07-14，对应 `docs/Phase3收口与授权体系设计.md` 的 [1]（Phase3 收口）+ [2]（fwsec 版本协商）。
> 固件版本：**v3.33.0**（新增 `fwsec`）；此前基线 v3.32.2。

---

## 〇、本次改动摘要（2026-07-14）

| 项 | 落点 | 说明 |
|---|---|---|
| 固件 `fwsec` 能力字段 | `keygo_core.c` `KeyGo_NotifyStatus` | FF02 status JSON 末尾新增 `"fwsec":1` |
| 固件能力宏 | `keygo_core.c` `KEYGO_FWSEC=1` | 语义：1=当前基线(BIND/AUTH/C1/单码/双模式) |
| 固件版本号 | `keygo_core.c` `KEYGO_FW_VERSION="3.33.0"` | 涨版本，作烧录探针 |
| JSON 缓冲扩容 | `STATUS_JSON_MAX_LEN` 224→256 | 容纳新字段，防截断 |
| App 状态字段 | `stores/ble.js` `fwSec:-1` | -1=未收状态 / 0=旧固件 / 1=基线 |
| App 解析分流骨架 | `stores/ble.js` `_handleStatus` | 读 `data.fwsec`，无字段视为 0，供后续协议分流 |

> ★ 认知修正（相对旧台账）：
> - **T3（配置断电不持久化）不是 bug**，是有意的 per-phone 设计（uc/lc/阈值只存 RAM，由手机每次连接回推）。**本次不改**，改了会破坏多手机各自配置。
> - **T4（重连回推配置）已实现**：自动重连、手动连接、亮屏连接三条路径均在 SN 就绪后调用 `_syncConfigToDevice()`。**本次不改**，仅列入下方验收。

---

## 一、烧录 / 版本确认（前置，一票否决）

- [ ] MounRiver **Clean + Rebuild**（避免增量编译吃旧 .o），重新烧录。
- [ ] 串口上电日志出现 `[INIT] FW Version: 3.33.0`（不是 3.32.x → 说明烧的是旧 hex）。
- [ ] App 连接后控制台 `fwVersion` = `3.33.0`。
- [ ] App 控制台出现 `[Store] 设备安全协议能力 fwsec = 1`。
- [ ] 串口 `[CRYPTO] sha256 self-test: PASS`（确认真 HMAC，非降级假鉴权）。
- [ ] 串口 `[BOND] init done, owners=N`，重启后 owners 不清零（DataFlash 存活）。

---

## 二、[2] fwsec 能力字段验证

- [ ] 新固件(v3.33.0)：App `fwSec === 1`，`_handleStatus` 日志打印一次。
- [ ] 旧固件(v3.32.x，无 fwsec 字段)：App `fwSec === 0`（走 else 分支），不报错、旧功能正常。
- [ ] status JSON 未被截断：串口无 `[WARN] NotifyStatus JSON trunc`；App 能正常解析所有字段（st/r/f/uc/lc/m 等均在）。
- [ ] 自定义名称 d2 取最长(20字符)时，JSON 仍不截断（256 余量验证）。

---

## 三、[1] Phase 3 已实现能力逐项验收

### 3.1 写队列串行化（`utils/command-queue.js` + `enqueueWrite`）
- [ ] 快速连点解锁/锁车：命令按序执行，不出现 GATT 写冲突崩溃。
- [ ] 提交配置的同时点控制按钮：不丢命令（配置写与手动命令共用队列串行）。
- [ ] 极端：连点 10 次，最终设备状态与最后一次意图一致。

### 3.2 未授权连接 30s 超时强断（commit 31f3f59 已 PASS，回归确认）
- [ ] 陌生手机连上但不绑定：约 30s 后收到 `BIND:TIMEOUT:30S`，随后被强断。
- [ ] 被踢后：App 置 `reconnectMode='dormant'`、停原生扫描、持久化 `keygo_unbound_kicked`，不自动重连。
- [ ] 车主手动 `connect()`：清除 `keygo_unbound_kicked` 标记，恢复正常重连。
- [ ] 正常绑定/AUTH 成功：`KeyGo_CancelUnauthTimer()` 生效，不被误踢。

### 3.3 原生前台扫描 / 重连三模式（Keygo-Foreground）
- [ ] **舒适模式**：熄屏后亮屏(SCREEN_ON/USER_PRESENT) → 8s 扫描 → 自动连上。
- [ ] **极速模式**：GPS 围栏 + 60s 心跳；离开再返回自动重连（注：GPS 围栏 T2 若未落地，此项标记 N/A）。
- [ ] **省电模式**：仅 App onShow 时扫描重连。
- [ ] 前台服务常驻：通知栏图标在，App 切后台不被秒杀（需电池优化豁免 + 位置"始终允许"）。
- [ ] 厂商强杀对抗：主流国产 ROM 上锁屏 10 分钟后仍能亮屏重连（尽力项）。

### 3.4 错误码可读化 + 命令结果等待（`readable-errors.js` + `_waitCmdResult`）
- [ ] 各类失败(NOT_BOUND/AUTH_REQ/TOO_FAST/CONFLICT/断连)显示对应可读文案，不再统一"发送失败"。
- [ ] "解锁成功但车没开"不再误报成功：无 CMD:FAIL/DENY 且超时才判定，负向结果正确 toast。

### 3.5 T4 配置回推（三路径，已实现，回归验证）
- [ ] 设备断电重启（RAM 阈值清空）后，App 自动重连 → 阈值被回推 → 串口 `[CONFIG] updated: ...` 与 App 当前配置一致。
- [ ] 手动断开再手动连接：配置同样回推（`connect()` 路径 2338 行）。
- [ ] 熄屏后亮屏自动连上：配置同样回推（亮屏路径 1571 行）。
- [ ] 在 App 改阈值(uc/lc/unlock/lock) → 立即下发 → 断电重连后仍是新值（因每次回推）。

### 3.6 T3 per-phone 语义确认（有意设计，非 bug）
- [ ] 甲手机设 uc=2 连上；乙手机设 uc=4 连上 → 各自连接期间设备用各自的值（RAM 覆盖，不写 Flash）。
- [ ] cooldown_ms 修改后写 Flash：断电重启仍保留（设备级参数，与阈值不同）。

### 3.7 弱网 / 竞态（尽力项）
- [ ] 弱信号边缘反复断连重连：写队列无残留死锁，`_configWriteBusy` 不卡死。
- [ ] 连续超长签名命令 + 重连交叉：无命令永久挂起。

---

## 四、结论签字

| 模块 | 结果(PASS/FAIL/NA) | 备注 |
|---|---|---|
| 烧录版本确认 |  |  |
| fwsec 字段 |  |  |
| 写队列 |  |  |
| 30s 超时强断 |  |  |
| 三模式重连 |  |  |
| 错误码/命令等待 |  |  |
| T4 配置回推 |  |  |
| T3 per-phone |  |  |

- 验收人：________  日期：________
- 结论：□ 通过，可进入 [3] 授权体系 v1　□ 有阻塞项（见备注）

---

## 五、后续（不在本次范围）

- **T2 极速 GPS 围栏**（`utils/geofence.js` + AlarmManager 60s 心跳）：新功能，非收口项，留待专项。
- **[3] 授权体系 v1**：per-identity authEntry + phoneId KDF + 多 owner/管理员（需先锁 3 项待拍板决策，见设计文档 §7）。届时 `fwsec` 升到 2，App 按 `this.fwSec >= 2` 分流。
