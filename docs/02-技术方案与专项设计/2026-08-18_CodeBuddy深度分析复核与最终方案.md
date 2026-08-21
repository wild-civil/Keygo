# CodeBuddy 深度分析复核（PPCP/连接参数/6s 根因）—— 最终裁定

> 日期：2026-08-18
> 目的：逐条验证 CodeBuddy 深度分析的正确性，并确认我方修复方向是否成立。
> 依据：CH58xBLE_ROM.h（协议栈头文件，含 gapRole/gapPeriConnectParams 定义）、WCH 官方例程 Peripheral、App stores/ble.js、用户两个 commit（2e8368f/2b8cd0e）。

---

## 一、逐条裁定 CodeBuddy 的论断

| # | CodeBuddy 论断 | 裁定 | 代码/规范依据 |
|---|----------------|------|---------------|
| 1 | `PERI_CONN_PARAM_UUID 0x2A04`（PPCP）是协议栈内置特征 | ✅ **正确** | `CH58xBLE_ROM.h:361` 定义；`GGS_PERI_CONN_PARAM_ATT=4`（L801）是 GAP 服务第 4 属性 |
| 2 | GAPROLE_MIN/MAX 会被协议栈写入 PPCP | ✅ **基本正确** | `gapPeriConnectParams_t` 注释（L1864-1866）："used to compare against connection events and **request connection parameter updates with the central**"——TI 栈（WCH 基于 TI）在连接建立后按 GAPROLE_MIN/MAX 与实际间隔比较，不符则自动发起参数更新请求 |
| 3 | 广播里 `GAP_ADTYPE_SLAVE_CONN_INTERVAL_RANGE` 只是"提示字节"，Android 基本无视 | ✅ **正确** | 该 AD type（0x12）仅供扫描端参考；社区共识（[SO: BLE Connection Parameters for Android/iOS](https://stackoverflow.com/questions/22514333/bluetooth-low-energy-connection-parameters-for-android-ios-and-win8)）：**Android 建链初始间隔由系统策略决定（通常 30~50ms 或 7.5ms），不从广播读取**。你 2e8368f 改的广播字段（ADV_FAST 30/60ms）**对 Android 建链基本无效**（对 iOS/其他从机采纳场景可能有微弱作用） |
| 4 | PPCP 实际声明的是 160~320ms 慢参数（DEFAULT_DESIRED_*） | ✅ **正确** | `peripheral.c:260-261` 初始化：`desired_min=128(160ms)` / `desired_max=256(320ms)` → `GAPRole_SetParameter(GAPROLE_MIN/MAX_CONN_INTERVAL)` |
| 5 | "PPCP 走反了"：fast 靠建链后 80ms 协商补 → 6s 慢的根因 | ✅ **核心正确** | 结合 #2：协议栈连接建立后按 GAPROLE 期望（160~320ms）**自动**请求参数更新 → 链路落入慢窗口 → 80ms 后固件才发 AUTH_FAST(40/80ms) 覆盖 → **GATT 初始化（服务发现/读SN/订阅FF02/AUTH）挤在"慢→快"过渡期** |
| 6 | 方案 A：PPCP 直接声明 fast + AUTH 后切省电 | ✅ **方向正确，但需精化** | 见第二节"关键补充" |
| 7 | App 固定 1000ms 盲等"低估风险"（需保 MTU 就绪） | ⚠️ **部分正确** | 1000ms 确实为 GATT 就绪/MTU 留缓冲；但 `setBLEMTU` 已是异步不阻塞（utils/ble.js:781），FF02 首帧到达可作为真实就绪信号。**"改信号判定"方向对，保留短兜底即可** |
| 8 | fast 被拒无重试 → 回慢窗口 6s 复发 | ✅ **正确（真实风险）** | 当前无"被拒后重试更宽区间"逻辑；被拒即维持现状 |
| 9 | 断开 1500ms 是"上限非固定"（我上一轮已指出） | ✅ 与我一轮结论一致 | `disconnect()` 3573 行命中断连事件即 resolve |

---

## 二、关键补充：CodeBuddy 方案 A 的落地点（他漏了 App 侧大头）

CodeBuddy 的固件侧分析（#1-#6）**正确且治本**，但他没有把两件事串起来：

### 事实 A：连接慢 = 固件侧"慢窗口过渡" + App 侧"固定 1.7s 盲等"两个独立来源

```
固件侧（CodeBuddy 已定位）：
T0  连接建立（Android 初始 ~30-50ms，快）
T0+ε 协议栈按 GAPROLE 期望(160~320ms)自动请求参数更新 → 链路落入慢窗口 ★ 拖累 GATT 初始化
T0+80ms 固件发 AUTH_FAST(40/80ms) → 手机接受后回到快窗口（Δ≈0.3~1s）
      ↓ 服务发现/读SN/订阅FF02 全在"慢→快"过渡里跑

App 侧（CodeBuddy 未提）：
connect() 开头无条件 closeBLEConnection + 700ms（stores/ble.js:3448-3460）  ← 0.7s 纯浪费
connect() 末尾固定 await 1000ms（3516）                                    ← 1.0s 盲等
```

**实测 6s ≈ 固件慢窗口过渡（~1s）+ App 固定 1.7s + Android 建链本身（~1-2s）+ GATT 初始化（~1-2s）**。CodeBuddy 只解决了固件侧；App 侧 1.7s 是**独立且必然可省**的。

### 事实 B：方案 A 的精确落地 = 只改 GAPROLE_MIN/MAX 为 fast，不要动 DEFAULT_DESIRED_*

| 参数 | 用途 | 当前值 | 方案 A 改后 |
|------|------|--------|-------------|
| `GAPROLE_MIN/MAX_CONN_INTERVAL`（peripheral.c:260-261 初始化） | 连接建立时协议栈自动协商的期望值 | 160/320ms（慢） | **32/64（40/80ms，快）** ← 改这里 |
| `DEFAULT_DESIRED_*`（SBP_PARAM_UPDATE_EVT 用） | AUTH 后切回的省电值 | 160/320ms/LAT=2 | **保持 160/320ms 不动**（省电） |

**关键**：`GAPROLE_MIN/MAX` 与 `DEFAULT_DESIRED_*` **当前都等于 160/320ms**（同一组宏），所以 CodeBuddy 说"改 DEFAULT_DESIRED_* 会全改 fast 导致待机费电"——**正确，所以不能改 DEFAULT_DESIRED_***，要**新增独立宏**（如 `CONN_INIT_FAST_MIN/MAX=32/64`）只用于 `Peripheral_Init` 的 GAPROLE 初始化。AUTH 后 `SBP_PARAM_UPDATE_EVT` 仍用 DEFAULT_DESIRED_* 切回省电，机制零改动。

### 事实 C：与用户已做的 2e8368f 的关系

用户 2e8368f 改的是**广播字段**（ADV_FAST_*）→ 对 Android 建链基本无效（#3）。
**真正该改的是 `GAPROLE_MIN/MAX`**（peripheral.c:260-261）——协议栈自动协商用这个，不是广播字段。
所以方案 A 是对 2e8368f 的**修正补强**：把"建链即 fast"从"广播提示"（无效）移到"GAPROLE 期望"（有效）。

---

## 三、最终修复方案（固件 + App 联合）

### 固件侧（治本，CodeBuddy 方案 A 精化）
1. `peripheral.h` 新增 `CONN_INIT_FAST_MIN_CONN_INTERVAL 32` / `CONN_INIT_FAST_MAX_CONN_INTERVAL 64`（40/80ms）独立宏；
2. `peripheral.c` `Peripheral_Init` 的 `desired_min/max` 改用上述 fast 宏（**不再用 DEFAULT_DESIRED_***）→ 协议栈连接建立即按 40/80ms 协商；
3. `SBP_PARAM_UPDATE_EVT` / `SBP_AUTH_FAST_PARAM_EVT` 保持现状（AUTH 后切回 160/320ms 省电）——**注意**：AUTH_FAST 请求（40/80ms）与 GAPROLE 初始期望（40/80ms）重复，可保留作"手机未采纳初始值时再推一次"的兜底，无冲突。

### App 侧（独立可省 1.7s，与固件侧正交）
1. `connect()` 预清理条件化：`if (this.connected)` 才 close+700ms（对齐 `_doReconnect` 2526 行）；
2. 固定 1000ms 盲等 → "FF02 订阅成功/首帧到达"判定 + 短兜底（~300ms）；
3. `reconnectDisconnected` 的 closeBLEConnection 加 2s 硬超时（健壮性）。

### 预期收益
- 固件侧：GATT 初始化从"慢窗口"挪到"快窗口"，服务发现/读SN/订阅FF02 提速 ~1s；
- App 侧：省 1.7s 固定等待；
- 合计：**6s → ~3s 级**（剩余 = Android 建链本身 ~1-2s + GATT 初始化在 fast 窗口 ~1s）。

---

## 四、结论

1. **CodeBuddy 深度分析核心正确**（#1-#6，#8）：PPCP/GAPROLE 声明慢参数 + 协议栈自动协商 → 建链后落入慢窗口 → GATT 初始化被拖慢，是连接慢的固件侧根因。**比我们上一轮"广播声明"的定性更准确**——广播字段对 Android 无效，GAPROLE 期望才有效。
2. **我方修复方向（App 侧 1.7s）依然正确且独立**，与 CodeBuddy 的固件侧方案正交互补，不是替代。
3. **两者合起来才是完整答案**：固件改 GAPROLE 初始期望为 fast + App 去掉固定等待。

> ⚠️ 验证铁律：方案 A 落地后必须真机抓固件串口 `[DIAG] LinkEst int=...`，确认连接建立时实际间隔已是 40~80ms（而非 160~320ms），再实测绑定耗时；若某 ROM 仍显示慢间隔，则该手机忽略从机协商（平台行为，无解）。

---

## 五、二轮复核：CodeBuddy 对我方复核的验证（2026-08-18 二次）

CodeBuddy 对我上一轮复核做了代码级验证，结论：**我方复核基本准确，2 处需精确化**。逐条裁定：

| # | CodeBuddy 的说法 | 裁定 | 证据 |
|---|------------------|------|------|
| 1 | 「方案 A 新增独立宏」完全正确 | ✅ **正确** | `peripheral.c:260-261`（GAPROLE 初始化）与 `peripheral.c:529`（SBP_PARAM_UPDATE_EVT）**确实共用同一组 `DEFAULT_DESIRED_*`** → 直接改它会导致 AUTH 后"省电值"也变 fast，待机功耗失控 |
| 2 | 「700ms 并非无条件浪费，是保守但必要」 | ⚠️ **比我的表述更准确** | `connect()` 3460 行确实无条件 `await 700ms`，但注释 3447 说明其用途是"清理可能的 stale ACL，避免下次复用旧 GATT → 冷窗 → 10007"。**与 `_doReconnect` 的条件化（2573 行 `if (this.connected)`）对比**：`connect()` 手动路径未条件化，属"保守但可优化"，不是"纯浪费" |
| 3 | 「广播字段对 Android 无效」 | ✅ **与我一致** | `peripheral.c:229-232` 是扫描响应的 AD type 0x12，Android 建链初始间隔由系统策略决定，不读广播 |
| 4 | 「fast 被拒无重试」真实存在 | ✅ **正确，且可修** | `peripheral.c:542-545` 只发一次 `GAPRole_PeripheralConnParamUpdateReq`；**但 `gapLinkUpdateEvent_t`（CH58xBLE_ROM.h:2168-2177）有 `status` 字段**（L2172），可在 `GAP_LINK_PARAM_UPDATE_EVENT` 回调中判断请求结果 → "被拒重试"**技术上可行** |
| 5 | 落地细节：可复用 `AUTH_FAST_*` 用于 Init，或新增 `CONN_INIT_FAST_*` | ✅ **合理** | Init 后 80ms 会再发一次同样的 fast，重复无害；直接复用 `AUTH_FAST_*`（32/64=40/80ms）最简 |

### 二轮复核的最终结论

1. **三方（deepseek 首轮 → CodeBuddy 深度 → deepseek 复核）已收敛到同一方案**：
   - 固件：`Peripheral_Init` 的 GAPROLE 初始期望改为 fast（40/80ms），`SBP_PARAM_UPDATE_EVT` 保持 DEFAULT（160/320ms）省电；
   - App：1000ms 盲等 → FF02 到达信号判定；700ms 预清理条件化（仅 stale ACL 时等）。
2. **精确化修正**（CodeBuddy 优于我方表述的点）：700ms 是"有条件下必要"，不是"无条件浪费"——条件化时需谨慎判断 stale ACL 是否存在（不能简单 `!this.connected` 就跳过，因为僵尸连接场景 connected=false 但 OS 侧仍有残留）。**建议条件 = `this.deviceId` 非空（本会话连过）且 OS 未确认断开**，或保守起见保留但可缩短。
3. **新增可行加固**（CodeBuddy 提出，已确认可实现）：`GAP_LINK_PARAM_UPDATE_EVENT` 回调里查 `status`，fast 被拒则重试更宽区间（如 40/80ms → 60/120ms）。

