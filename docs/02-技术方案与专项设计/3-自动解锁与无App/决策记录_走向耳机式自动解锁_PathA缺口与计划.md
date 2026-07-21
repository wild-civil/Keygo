# 决策记录：确认走向耳机式自动解锁（Path A）+ 缺口与计划

> 日期：2026-07-15
> 背景：实测恢复出厂后重连无 passkey 弹窗，经串口核实根因；用户确认选择 **Path A（要耳机式自动解锁体验）**。
> 本文是对 `docs/Phase4_耳机式自动解锁与凭证硬化_设计落地清单.md` 的**实测补充与决策固化**，非重复设计。

---

## 1. 实测澄清（与早期设想的关键偏差）

- 固件 Phase1+2（commit `3c693f5`）已烧入：串口 `[BOND] init done, owners=1, bonding=1, mitm=1`，证明 `mitm=1` 已生效。
- 但正常连接全程是 GATT AUTH（`NONCE → AUTH:OK`），**从未触发 `Bonding_PasscodeCB`、从未出现 `bond saved`** → 说明 App 正常连接**只做 GATT + 应用层挑战应答，从不调 `createBond()`**。
- 结论：**Phase2 的 passkey 保护当前处于"休眠"**——只有手机侧主动配对（系统蓝牙设置点"配对"，或 App 首绑调 `createBond()`）才会触发 passkey 弹窗。正常流程根本不走配对。
- 因此"耳机体验"尚未成立：缺的是 **App 首绑触发 `createBond`** 这一半（Phase2 的 App 半边）。

## 2. owners=1 异常已澄清（非 bug）

- 本次串口从头到尾**无 `RESET:*`**，重启前最后一条是 `C1:LOCK`（App 带签名锁车指令），约 2s 后直接重启 → 这是**掉电/手动复位，不是隐藏键 8s 工厂复位**。
- RAW 通道正常（`NONCE:`/`AUTH:OK` flush 成功）；复位提示也走 RAW 通道（`RESET:OK` 必现），它没出现 ⇒ 复位未触发。
- `owners=1` + `config magic mismatch` 是烧录后 DataFlash 里的**旧数据**（旧信任列表 + 新固件 magic 不符→默认、模式从未写→255），什么都没被擦。
- 真验证 Phase1 以串口 `RESET:OK` + 重启后 `owners=0` 为准。

## 3. 决策：Path A（要耳机式自动解锁）

用户明确选择"要耳机体验"。即保留：
- 解锁闸门中的 `LINK_ENCRYPTED` 分支（bond 后 OS 自动重连 + 静默加密 → RSSI 解锁，无需 App）。
- 保留 autoConnect 基建（前台服务/亮屏唤醒），否则激进 ROM 下失去后台重连 → 耳机体验失效。

### 关于 Trae "BLE 没有 OS 特权，做不了耳机体验"——部分纠正
- 耳机体验内核（靠近自动重连 + 静默重加密 + RSSI 解锁）是 **BLE 规范标准行为**，每个已配对 BLE 设备都有，与经典蓝牙 OS 特权无关 → Trae 这点说错。
- Trae 那点"特权"仅指：通用 BLE GATT 外设不像 A2DP 耳机被 OS 当系统音频设备后台主动连。但这是否"脱离 App"取决于**有没有 autoConnect 上下文**（前台服务/亮屏唤醒），我方已搭好、与 passkey 正交。passkey 只决定"谁能 bond"，不决定"能不能自动连"。

## 4. 已做（已提交 `3c693f5`）

- Phase1 修 SNV 清除 bug（`Bonding_ClearSnvBonds` 清协议栈 LTK）。
- Phase2 固件启用 passkey/MITM（`mitm=1`、`DISPLAY_ONLY`、`Bonding_PasscodeCB` 回送绑定码、一次性迁移标记 `KEYGO_SECEP_ADDR`）。

## 5. 还没做（待办，按依赖排序）

1. **Phase2 App 半边（关键缺口）**：首绑流程调 `device.createBond()`，触发系统 passkey 弹窗输绑定码，持久化 LTK。这是让 passkey 活起来 + 耳机体验成立的必需缺口。
2. **Phase4 修订：不能一刀切退役前台服务**：保留 autoConnect 基建（前台扫描/亮屏唤醒），否则激进 ROM 下失去后台重连 → 耳机体验失效。原 Phase4 §5 的"常驻前台服务日常退役"需收敛为"可选高可靠模式（默认开/常驻按需）"。
3. **Phase3 AUTO 调阈 + 真机验收**：阈值/卡尔曼/确认计数真机实测定。
4. **guest 临时码机制（限事件/次数/时间）**：App + 固件临时码表，与 passkey/owner 正交（见 §6）。
5. **多 owner/管理员体系（Phase5，`fwsec` 升 2）**：首绑=管理员可删后绑；与 Phase1 单删 SNV 难点相关（随机私有地址旋转）。
6. **版本号** `3.33.3` → 建议验证通过后升 `3.33.4`，标记 passkey/owner 体系变更。

## 6. 关键考量（纠偏 guest 论断）

> **"guest 临时码走 App 层 AUTH，它不产生加密链路，所以 guest 永远拿不到'脱离 App 自动 RSSI 解锁'"——确认成立。**

理由：
- guest 走 App/小程序层 `NONCE/AUTH` 挑战应答，**不产生加密链路**（无 bond、无 LTK）。
- 解锁闸门 `LINK_ENCRYPTED || sessionAuthed`：guest 的 `LINK_ENCRYPTED` 永远为假；`sessionAuthed` 仅在 App 主动连上并完成 AUTH 时为真，App 不连即失效。
- 因此 guest **必须有 App 在场**才能解锁，无法"脱离 App"。要"脱离 App 自动解锁"必须 `LINK_ENCRYPTED`，即必须 bond → 必须 passkey。
- 补充（重要，见 `已验证事实_安全模型实测与纠偏.md` §1-2）：**即便 owner，当前真机上"App 被杀走近解锁"也尚未生效**——裸系统不维持已配对 BLE 连接，重连靠 App 前台服务。所以"脱离 App"对所有人都难，Path A 正是要保留 autoConnect 基建把 owner 这一侧补上；guest 则结构性被排除。

其它考量：
- **passkey 是耳机体验的安全前提**：否则任何装 App 的陌生人 Just-Works `createBond` 即拿加密链路 → RSSI 自动解锁，等于"谁装 App 谁主人"。passkey 把"能 bond"锁成"知道绑定码才能 bond"。
- **已配对手机（家人/自己）即使被别人拿也能解锁**——与车钥匙/耳机同模型，设计内取舍，非漏洞。
- **guest 与 passkey 正交**：guest 解决"短期借出"，owner/bond 解决"长期共享 + 自动解锁"；两者都该做，互不替代。

## 7. 下一步

- 落地 Phase2 App 半边 `createBond` 触发 + 配套"系统蓝牙输码"引导；随后真机看 passkey 弹窗 + 之后耳机式自动解锁。
- 同步修订 Phase4 为"保留 autoConnect 基建（前台服务/亮屏唤醒）"。

---

## 8. 2026-07-21 重新分析：耳机类比 + 「无 App / 完全无进程」+ per-phone 真实可能性

> 背景：用户指出"蓝牙耳机/手环靠近就直接连上，不用 App，我们之前不就是这么做的吗？"。本节能纠正 §6.55 的过度悲观表述，并基于已提交的 v3.36.0（`1811e57` 授权体系 v1 / `9ceadff` 8-SNV 扩容 / `cf1c09c` UNBIND 联动删 SMP 配对）重新评估 per-phone 在"无 App、甚至无进程"下是否可能。

### 8.1 耳机类比成立（已绑定 + 配对 = OS 自动重连，零 App）

- **协议事实**：BLE 设备一旦 **bond（系统级配对）**，手机 OS 蓝牙栈把该链路登记进"自动重连表"。进范围 → OS 自动扫到 → 自动连 + 自动加密。**全程系统级，零 App**。耳机、手环、Tile 全是这条路。
- **KEYGO 同理**：只要被正确 bond（passkey 配对），OS 就会这么对它。这与 commit `cf1c09c`（UNBIND 联动删系统蓝牙配对）一致——bond 是 OS 级事实，因此 OS 自动重连天然成立。
- **关键内部差别（解释为何我们写了前台服务）**：耳机用的是**系统级 profile**（A2DP/HID/健康），OS 原生保活；KEYGO 是**裸 GATT 外设**，无系统 profile 客户端，OS 自动重连依赖一条 `connectGatt(autoConnect=true)` 的 GATT 注册。我们的 `Keygo-Foreground` 前台服务**本质就是替 KEYGO 持有这条 GATT 重连注册并主动后台扫/连**，从而给到用户"靠近自动连"的耳机式体验。前台服务**不碰阈值逻辑**——RSSI 是设备自己采的。

### 8.2 纠正 §6.55「裸系统不维持已配对 BLE 连接」

- 该表述**过于悲观 / 可能混淆了测试变量**：2026-07-13 那次"前台服务死 → 不保活"的测试，大概率是**撤掉了我们自己的 GATT 注册**导致无人驱动重连，而非"OS 本身不能自动重连已绑设备"。
- 更精确的结论：**干净 OS（原生 Android / iPhone）下，bonded 设备 OS 确实会自动重连（耳机实证）**；**国产 ROM（小米/华为/OPPO/vivo…）会杀"非系统 App 的 GATT 自动重连注册"**，才需要前台服务兜底。
- 因此前台服务是**针对国产 ROM 的可靠性兜底**，不是逻辑必须。

### 8.3 per-phone 真实缺口（基于 v3.36.0 代码，非原理性不可能）

- v3.36.0 已做 per-phone 身份（`phoneId` 锚）+ 每 owner 阈值（`rssiUnlock/rssiLock`）+ `RSSISET` 写入口，见 `授权体系v1_per-phone与RSSI阈值跟随.md` §4 与 `bonding.c:29-31`、`keygo_core.c:806-813`。
- **但阈值选择逻辑**：`若 s_authedOwnerIdx>=0 用 owner 阈值，否则用全局`（文档 §4）。而 `s_authedOwnerIdx` **仅在 App 发 AUTH/BIND/C1 时写入**（`Bonding_ConnTerminated` 断开即清 -1）。
- `peripheral.c` 的 `LINK_ENCRYPTED` **只用于门控解锁**（`g_encRequired` + `linkDB_State(...,LINK_ENCRYPTED)`），**没有任何代码在加密完成时识别"这是哪台 owner"**。
- **结论**：在「已绑定 + 配对 + 无 App」场景下，手机 A、B 连上后 `s_authedOwnerIdx=-1` → 状态机用**全局阈值**，per-phone **当前不生效**。这与"无 App 用全局阈值"的设计注释一致（keygo_core.c:807）。

### 8.4 「无 App / 完全无进程」+ per-phone 可能性矩阵

| 维度 | 无 App（UI 不开，前台服务在） | 完全无进程（连前台服务都不要） |
|---|---|---|
| 自动重连 + 加密（连接保活） | 全平台稳（前台服务 active scan/connect） | 干净 OS 可靠（=耳机）；国产 ROM 不稳（杀 GATT 重连注册）→ 需前台服务兜底 |
| per-phone 阈值（**当前 v3.36.0**） | ❌ 不生效 → 全局阈值（需 App AUTH） | ❌ 不生效 → 全局阈值 |
| per-phone 阈值（**补 LINK_ENCRYPTED 认 owner 后**） | ✅ 生效 | ✅ 生效（纯固件侧，与有无进程无关） |

**核心澄清**：per-phone 阈值是否生效，**与"有没有进程"无关**——它只取决于固件能否在**无 App**时识别当前 owner。当前卡在"识别 owner 只发生在 App AUTH"。补齐后，只要 OS 把连接建起来（加密），固件即认 owner、用其阈值，无论 App/前台服务是否在跑。

### 8.5 要真正达成「无 App + 完全无进程 + per-phone」还差什么

1. **（自动重连侧，已具备基建）** 保留 `Keygo-Foreground` 作为国产 ROM 兜底；干净 OS 可零进程。无需新开发。
2. **（per-phone 侧，唯一真实缺口）** 固件在 `LINK_ENCRYPTED` 时**识别当前连接对应哪条 owner** 并写入 `s_authedOwnerIdx`，使状态机用该 owner 阈值。即「路线 A / IRK」：
   - bond 后 OS 重连用该手机专属 LTK 加密，BLE 栈内部必已定位该 bond（否则取不到 LTK）→ 可拿到 bond 身份（IRK / 索引）。
   - 绑定（BIND 触发 `createBond`）时把 BLE 栈 bond 身份（IRK 或 bond 索引）一并存入 `bondEntry_t`，与 `phoneId` 关联；`LINK_ENCRYPTED` 时据栈给的 bond 身份反查 owner → 设 `s_authedOwnerIdx`。
   - **✅ WCH 栈 API 已验证（2026-07-21）**：栈无"加密回调直接给 IRK/bond 索引"的 API（加密靠 `linkDB_State(LINK_ENCRYPTED)` 查询，`peripheral.c:511-513` 已用；`pfnPairStateCB_t` 仅 pairing 过程触发、纯 OS 静默重连不触发）。但自解 owner 全部积木已确认存在：`GAP_ResolvePrivateAddr(pIRK,pAddr)`(=ah(), `CH58xBLE_ROM.h:4050` JT75)、`tmos_snv_read(devIRKNvID(bondIdx),KEYLEN,buf)`(`:2753` JT107 + `:1235`)、对端 RPA=`gapEstLinkReqEvent_t.devAddr`(`:2151-2161`) 或 `linkDBItem_t.addr`(`:1299-1316`)、配对捕获=`GAP_BOND_COMPLETE_EVENT`/`pairStateCB(BOND_SAVED)`(`:745`/`:1183-1187`)。详见 §8.7。不影响安全（门控仍是 OS 加密）。
3. 真机验收：干净 OS 关前台服务验证自动重连；两种 ROM 下验 per-phone 阈值随 owner 切换。

### 8.6 一句话结论

- **自动重连**：耳机模型成立，已具基建；"完全无进程"在干净 OS 即可，国产 ROM 需轻量前台服务兜底。
- **per-phone**：当前（v3.36.0）**必须 App AUTH 才生效**，无 App 走全局阈值；补齐"加密时认 owner"一块固件后即生效，且与有无进程无关。
- 所以用户目标"无 App + 无进程 + per-phone" = **自动重连可达（看 OS），per-phone 还差一块固件（LINK_ENCRYPTED 认 owner）**，**路线 A 已验证可行、待编码**（详见 §8.7）。

### 8.7 路线 A 实施方案（已验证，待编码，2026-07-21）

**验证结论**：WCH 栈**无**"加密回调直接给 IRK/bond 索引"的 API；加密状态靠 `linkDB_State(connHandle, LINK_ENCRYPTED)` 查询（`peripheral.c:511-513` 已用），`pfnPairStateCB_t` 仅在校对/pairing 过程触发（`STARTED/COMPLETE/BONDED/BOND_SAVED`），**纯 OS 静默重连不触发**。但自解 owner 的全部积木已确认存在，故"无 App 认 owner"可行。

| 能力 | API | 位置 |
|---|---|---|
| 对端当前 RPA | `gapEstLinkReqEvent_t.devAddr` / `devAddrType`（或 `linkDBItem_t.addr`） | `CH58xBLE_ROM.h:2151-2161` / `:1299-1316` |
| RPA↔IRK 比对（=ah()） | `GAP_ResolvePrivateAddr(pIRK, pAddr)` → SUCCESS 命中 | `:4050`（JT75） |
| 读已存对端 IRK | `tmos_snv_read(devIRKNvID(bondIdx), KEYLEN, buf)` | `:2753`（JT107）+ `:1235` |
| 配对完成捕获映射 | `GAP_BOND_COMPLETE_EVENT` / `pairStateCB(BOND_SAVED)` | `:745` / `:1183-1187` |
| 备用 ah() | `LL_Encrypt(key, plain, enc)` | `:2841`（JT23） |

bond IRK 在 NV 按 `bondIdx` 存：`devIRKNvID(bondIdx) = calcNvID(bondIdx, GAP_BOND_DEV_IRK_OFFSET) + BLE_NVID_GAP_BOND_START`（`CH58xBLE_ROM.h:1231-1237`）；`GAPBondMgr_GetParameter(GAPBOND_BOND_COUNT,...)` 已在 `bonding.c:117` 用过，可直接参考。

**实施步骤（待编码，不改当前行为）**：
1. `bondEntry_t` 增加 `uint8_t devIrk[KEYLEN]` 字段（与 `phoneId` 同条目；信任表容量/页数不变，仅扩单条长度，需同步 `BOND_ENTRY_SIZE` 与 DataFlash 页布局）。
2. **绑定完成时**（`pairStateCB` 收到 `GAPBOND_PAIRING_STATE_BOND_SAVED`，由 `connectionHandle` 取对端 addr）：遍历 `bondIdx ∈ [0, bondCount)`，`tmos_snv_read(devIRKNvID(bondIdx), KEYLEN, irkBuf)` 读 IRK，再 `GAP_ResolvePrivateAddr(irkBuf, peerAddr)` → 命中者即本手机；将该 IRK 抄入对应 `phoneId` owner 条目并 `Bonding_Save()`。
3. **`LINK_ENCRYPTED` 时**（在 `peripheral.c` 现有 `linkDB_State(..., LINK_ENCRYPTED)` 闸门处加一句）：由 `gapEstLinkReqEvent_t.devAddr`（或 `linkDB_Find(connHandle)->addr`）取对端 addr，遍历本表 `GAP_ResolvePrivateAddr(entry.devIrk, peerAddr)` → 命中即设 `s_authedOwnerIdx = idx`；此后状态机按 `授权体系v1 §4` 用该 owner 的 `rssiUnlock/rssiLock`。
4. 断开（`Bonding_ConnTerminated`）按现状清 `s_authedOwnerIdx = -1`，下次重连再认。

**注意**：静默重连不触发 `pairStateCB`，认 owner 必须挂在 `LINK_ENCRYPTED` 查询路径（不要指望配对回调）。IRK 解析是只读 NV 的纯函数，不影响安全门控（门控仍是 OS 加密）。

**真机验收**：干净 OS 关前台服务验证自动重连；多台已绑手机分别走近，验 per-phone 阈值随 owner 切换；非法/未绑手机连上走全局阈值。

### 8.8 方案 E（LTK 指纹，Trae 提议，已核实可行）与组合策略（2026-07-21）

**Trae 对照（参考其分析）**：路线 A 用 IRK/栈 bond 身份做锚；方案 E 用 LTK 指纹（自取当前链路 LTK、遍历本表比对）。两者根本思路一致——"绑定时建 owner↔bond 映射，重连时反查 owner 设 `s_authedOwnerIdx`"。

**核实 Trae 的关键断言（均成立）**：
- `linkDB_PerformFunc( pfnPerformFuncCB_t )`（JT32，`CH58xBLE_ROM.h:2988`）：对每条连接调回调，签名 `void (*)(linkDBItem_t*)`（`:1321`）。KEYGO 仅 1 连接，直接拿本连接项。
- `linkDBItem_t.pEncParams`（`encParams_t*`, `:1312`）→ `encParams_t.ltk[KEYLEN]`（`:1284`）即当前链路 LTK。**注意：无 `linkDB_Find` 公开 API**，取本连接项须用 `linkDB_PerformFunc`（对端 addr 已由 `gapEstLinkReqEvent_t` 提供，但取 LTK 仍需 PerformFunc）。
- LTK 每 bond 唯一且重连稳定 → 存 `ltkFingerprint[4]`（LTK 前 4 字节）可 O(bondCount) 比对。

**路线 A 与方案 E 的真实差异（修正"IRK 未验证"前提）**：
- 路线 A 已在 2026-07-21 验证通过（**非开放问题**）：对端 RPA（`gapEstLinkReqEvent_t.devAddr`）+ `GAP_ResolvePrivateAddr`(JT75) + `tmos_snv_read(devIRKNvID)` 自解，无需栈给 bondIdx。
- **方案 E 的独有优势 = 地址类型无关**：若对端手机用**公共/静态地址**（不分发 IRK、不走 RPA），路线 A 的 IRK 解析无解；而 LTK 每 bond 必有，方案 E 仍可命中。故方案 E 是更通用的兜底。
- 两者复杂度同为 O(bondCount)，均只读 NV、不影响安全门控（门控仍是 OS 加密）。

**组合策略（推荐）**：
1. `bondEntry_t` 同时存 `devIrk[KEYLEN]`（路线 A）与 `ltkFingerprint[4]`（方案 E）；绑定时一并写入（`pairStateCB(BOND_SAVED)` 处：`pEncParams->ltk` 取指纹 + `tmos_snv_read(devIRKNvID)` 取 IRK）。
2. `LINK_ENCRYPTED` 上升沿：① 先试方案 E——`linkDB_PerformFunc` 取 `pEncParams->ltk` 指纹，遍历本表命中即设 `s_authedOwnerIdx`；② 方案 E 未中再试路线 A——对端 RPA + `GAP_ResolvePrivateAddr` 反解；③ 都不中→全局阈值兜底。
3. 升级兼容：旧手机无 `ltkFingerprint`/`devIrk` → 自动走全局，不失能；升级后首次 BIND/AUTH 自动补写。

**结论**：路线 A 与方案 E 互不冲突、可组合；方案 E（LTK 指纹）因地址类型无关，建议作为主路径，路线 A（IRK）作补充。取本连接项用 `linkDB_PerformFunc`（`linkDB_Find` 不存在）。
