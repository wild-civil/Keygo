# Phase 3 收口与授权体系设计（含 Phase 4 重定义）

> 本文档把「Phase 3 连接可靠性增强 / Phase 4 GATT 加密门控重做 / 首绑管理员 / 限时·限次绑定码」四件事的关系、依赖、执行顺序、待拍板决策固化下来，供后续逐期实现。
> 形成于 2026-07-13，基于 `docs/KeyGo_本地化绑定与临时授权方案_v1.0.0.md`（§14/§15）、`docs/加密绑定优化方案设计.md`、以及 `code/CH582M` + `app/BLE_Key_Go_App` 现状。

---

## 一、核心认知：四件事不是并列，而是三层依赖

```
L0  基础设施层   Phase 3 连接可靠性收口              （让上面都稳）
L1  链路层身份   Phase 4 认证配对(Passkey=绑定码)    （关 Just-Works 缺口）
L2  应用层授权   首绑管理员 + 限时/限次绑定码          （同一原语的两个特例）
```

四件事有强依赖：**L2 的所有协议升级必须先有 `fwsec` 版本协商闸门**（否则一改固件，旧 App 连不上）；而 `fwsec` 当前**完全不存在**（FF02 只报 `v` 字符串，无能力协商）。

---

## 二、Phase 3 连接可靠性「收口」（不是没做，是没验、没收口）

### 2.1 当前已落地能力（核实于 2026-07-13）
| 能力 | 落点 | 状态 |
|---|---|---|
| 写队列 `enqueueWrite`（命令+配置共用，串行化 GATT 写） | `utils/command-queue.js` + `ble.js` | ✅ 已落地 |
| 未授权连接 30s 超时强断 `keygo_unbound_kicked` 持久化抑制重连 | 固件 `keygo_core.c` + `ble.js` | ✅ 已落地（commit 31f3f59 真机 PASS） |
| 原生前台扫描/重连（Keygo-Foreground 三模式） | 原生插件 + `ble.js` | ✅ 已落地（待真机验证三模式） |
| 错误码可读化 + 命令结果等待 `_waitCmdResult` | `readable-errors.js` + `ble-binding.js` | ✅ 已落地 |
| 连接/会话/绑定 App 侧分层重构（`ble-binding.js` 拆分） | `stores/ble-binding.js` | ✅ 已落地 |

### 2.2 收口还差什么（清单）
- [ ] **真机验收清单**：把上面能力逐项跑通并签字（尤其后台三模式：舒适/极速/省电）。
- [ ] **T2 极速 GPS 围栏**：`utils/geofence.js` + AlarmManager 60s 心跳尚未落地。
- [ ] **T3 配置(uc/lc/阈值)断电不持久化**：`KeyGo_SaveConfig` 仅 `cooldown_changed` 触发 → 改 uc 不落盘（根因已定位，待改 `if(changed)`）。
- [ ] **T4 重连不自动回推配置**：注释声称有、实际无调用，仅手动下发。
- [ ] **弱网/超长签名重连时写队列残留、竞态**系统验证。

### 2.3 收口建议
不新增大功能，立一份「真机验收清单」逐项跑通 + 顺手补 T2/T3/T4。这是质量门禁，**不阻塞 L1/L2**。

---

## 三、Phase 4「GATT 门控重做」——命名有陷阱，重做会重蹈覆辙

### 3.1 重要纠偏
当前记忆里「Phase 4 = GATT 加密门控重做」是**过时命名**。v3.32.1 的 `GATT_PERMIT_ENCRYPT_WRITE/READ` 门控**于 2026-07-10 有意回退**（FF03/FF04 改回纯读写），且这一回退**正确**：

- 无头设备 Just-Works 配对**无 MITM 能力**，强制 `GATT_PERMIT_ENCRYPT` 会触发系统配对弹窗 → 破坏 App 自动联动（序列号读不到、RSSI 收不到、绑定态无法恢复）。
- 安全边界早已定稿：**应用层 BIND + AUTH(HMAC) + C1 签名**，不依赖链路层 passkey。

→ **「重做 GATT 门控」如果还是 `GATT_PERMIT_ENCRYPT`，会原样踩回那个坑。**

### 3.2 正确的 Phase 4 = 认证配对（Passkey=绑定码）

见 `docs/加密绑定优化方案设计.md`，要点：
- **不动 GATT 权限位**，改 **SMP 从 Just Works → Passkey Entry（`mitm=1`）**，passkey 就是绑定码。
- 无头设备**不需要屏幕**：passkey 由固件代码提供（`Bonding_CodeToPasskey` 把 `g_curBindCode` 转 6 位数字），手机弹系统键盘输入（`KeygoForegroundModule.setPin` 静默预填）。
- 收益：陌生人**不输入码无法配对** → `LINK_ENCRYPTED` 仅来自「知道绑定码的人」→ Just-Works 缺口关闭；且 OS 自动加密重连仍可用。闸门 `LINK_ENCRYPTED || IsSessionAuthed` **零改动**。

### 3.3 T8「待带屏设备再加回」是过时判断
该方案**不需要带屏**。真正阻塞点是两个：
1. 未真机验证 **CH582 SMP 是否支持 `DISPLAY_ONLY`+固定 passcode 且不回退 Just Works**（设计文档 §7 风险）；
2. 当前 **C1 签名 + AUTH 已堵住「陌生人直开」**，链路层缺口只剩「知道绑定码的陌生人配对」这一**更小**风险，优先级自然降低。

### 3.4 结论
Phase 4 改名为「**认证配对（Passkey=绑定码）收口**」，且排在授权体系**之后**做。

---

## 四、首绑管理员 + 限时/限次绑定码 —— 核心洞察：同一原语

这两件事不是独立功能，而是 `docs/02-技术方案与专项设计/KeyGo_本地化绑定与临时授权方案_v1.0.0.md` §14.3.5（多 owner+管理员）和 §6.3（guest 临时码）的具象化。

### 4.1 admin 身份 与 guest 临时身份 = 同一个「授权条目」的两个特例

```c
authEntry {
  identityId[16];     // phoneId 或 guestCodeHash
  bindKey[16];        // SHA256(code||serial||identityId)[0:16]
  role: OWNER | GUEST;
  isAdmin: bool;      // 仅 owner
  expiresAt: uint32;  // guest 用，owner=0(永久)
  remainCount: int16; // guest 用，-1=不限次仅按时长
  perms: uint8;       // 权限位
}
```

- **首绑管理员** = 第一条 OWNER entry，`isAdmin=1`。
- **限时/限次绑定码** = 一条 GUEST entry，带 `expiresAt`/`remainCount`。
- 「管理员删某台手机」=`RMOWNER`（固件强制本连接 `isAdmin` 才执行）；「管理员发临时码」=`GUEST_ADD`。二者**共用 AUTH 路由**（按 `identityId` 找 key 验 HMAC）。

→ **强烈建议合并设计为一个「授权体系」**，而不是分两期各写一套条目管理。

### 4.2 单码模型障碍（必须正视）
当前固件**只有 `g_curBindCode` 一个槽**。若临时码去 `SETCODE` 顶替 owner 码 → owner 被夺权、且 guest 走后仍留着 guest 的 key。

✅ 优雅解（与上面条目模型融合）：**guest 不碰 owner 码**。guest 用自己的临时码派生**独立 key**（`bindKey=SHA256(guestCode||serial)`），设备侧 guestSlot 存该 key。这样**不需要「第二码」，只需要「第二条目」**——天然落在上面的 `authEntry` 结构上。

### 4.3 限时/限次绑定码实现路线（待拍板）
| 路线 | 做法 | 优劣 |
|---|---|---|
| **A. 独立 guest entry**（推荐） | 固件 guestSlot 存 guestCode 派生的独立 key + 过期/计数 | 功能正确、不夺 owner 权；需固件 guestSlot |
| **B. SETCODE 顶替**（单码模型） | 临时码 `SETCODE` 覆盖当前码，到期再改回 | 省事但 owner 被顶掉、有安全/体验风险，**不推荐** |

码长方案（见 `docs/绑定安全设计与码长方案.md`）：owner/出厂码可保持 6 位数字；生成的临时共享码用 **12 位字母数字随机串**（单码模型下 KDF 仅单次 SHA256 无慢哈希，6 位数字≈20bit 秒破，12 位字母数字≈72bit 不可破）。

---

## 五、`fwsec` 版本协商（L2 的硬前置，当前完全没有）

### 5.1 为什么必须有它
L2 的所有协议升级（多 owner 路由、guest entry、phoneId KDF、`RMOWNER`/`GUEST_ADD` 命令）都是**破坏性改动**。没有协商闸门，一烧新固件，**旧 App 连不上**，且无法从 App 端区分设备跑的是哪版。

### 5.2 落地形态
- 固件：`FF02` status JSON 增加 `fwsec` 能力字段（如 `fwsec: 2` 表示支持授权体系 v2）；旧固件无该字段 → App 走旧裸路径。
- App：连接后读 `fwsec`，按版本选择「旧单码路径 / 新授权体系路径」。
- 这是所有 L2 工作的**第一道工序**。

---

## 六、依赖图与推荐执行顺序

```
[1] Phase 3 收口（质量门，不阻塞）
    └─ 真机验收清单 + 补 T2/T3/T4
         │
[2] ★ fwsec 版本协商（硬前置，当前完全没有）
    └─ FF02 加 fwsec 字段 + App 按版本走旧/新协议路径
         │
[3] 授权体系 v1：首绑管理员 + 多 owner
    ├─ 固件：per-identity authEntry + phoneId KDF + BIND/AUTH 带 identityId + RMOWNER + WHOAMI(status 回 admin)
    └─ App：phoneId 生成持久化 + 仅 admin 可见的「设备管理」面板
         │
[4] 授权体系 v2：限时/限次绑定码（guest entry）
    ├─ 固件：authEntry 加 expiresAt/remainCount/perms + GUEST_ADD/REVOKE + 过期/计数清零
    └─ App：生成 12 位字母数字随机码 + 设时长/次数/权限 + 二维码分享
         │
[5] Phase 4 认证配对（Passkey=绑定码）
    └─ 真机验证 CH582 SMP passkey → bonding.c ioCap/mitm → App setPin 静默预填
```

**为什么这个顺序**
- `[2]` 是协议升级总闸门，没有它任何 L2 改动都会破坏旧 App。
- `[3][4]` 比 `[5]` 紧迫：C1+AUTH 已堵「陌生人直开」，链路层缺口只是「知道码的陌生人配对」这一更小风险；且 guest/admin 是用户明确要的产品能力。
- `[4]` 复用 `[3]` 的条目基础设施，故顺排其后。

---

## 七、待拍板决策（5 项）

1. **Phase 4 范围纠偏**：接受把「GATT 门控重做」改名为「**认证配对（Passkey=绑定码）**」吗？还是确实要链路层加密门控（那会带回强制配对弹窗问题）？
2. **授权体系合并**：admin + guest 共用 `authEntry` 统一设计（推荐），还是分两期各做？
3. **fwsec 破坏性升级**：接受「新固件要求新 App、旧 App 连不上」（需双轨兼容旧裸路径）？
4. **限时/限次绑定码载体**：独立 guest entry（推荐，需固件 guestSlot）还是 SETCODE 顶替（省事但有夺权风险）？
5. **先做 Phase 3 收口再动协议升级？** 建议——先把已写能力验证扎实，再上破坏性改动。

---

## 八、与既有文档/台账的关系

- §14/§15（多 owner+管理员、执行顺序总纲）是本文 L2 的**决策基础**，本文把首绑管理员 + 限时/限次码合并为「授权体系」并上移为 L2。
- T8（台账待带屏设备再加回 GATT 门控）= 本文 §3.3 已证伪过时。
- T2/T3/T4（配置围栏/持久化/回推）= 本文 §2.2 Phase 3 收口项。
- `docs/加密绑定优化方案设计.md` 的「认证配对 Passkey=绑定码」= 本文 §3.2 的 Phase 4 正式落点。
- 实施前必须先用 `codex` 分支验证 **CH582 SMP passkey 行为**（见 `docs/Codex接手指南_已完成与待办.md` §3.5）。
