# KeyGo v3.34 耳机式自动解锁 / 凭证硬化 —— 设计 + 落地清单

> 目标：让 KeyGo 像蓝牙耳机一样——**已配对手机靠近即无感解锁、离开即落锁，日常无需 App 常驻/后台服务**。
> 状态：本文档为纯设计，未写任何代码。所有结论均来自对 `code/CH582M` 固件与 `app/BLE_Key_Go_App` 的实读核查（2026-07-15）。
> 分支：当前在 `codebuddy` 分支迭代（已从 `main` 切出）；本文档各 Phase 独立提交，互不阻塞。

---

## 0. 已定结论与关键事实（讨论基线）

### 0.1 已采纳的决策（前面讨论确定）
- **凭证模型 = B（bond + 配对 Passkey / MITM）**：密码 = 绑定码，复用现有 `bindKey` 体系。安全与真·无感兼得。
- **AUTO 模式默认开**：开箱即耳机体验，App 内可关。
- **Keygo-Foreground 前台服务日常退役**：靠 OS 自动重连，无常驻前台服务；保留轻量「亮屏/解锁广播→重连」唤醒 + 可选默认关的「高可靠模式」。

### 0.2 经实读确认的关键事实（重要，修正了早期设想）
1. **CH582M 已有完整 RSSI 自动解锁基础设施，且 AUTO 默认已开。**
   - `g_cfgAutoLockEnable = 1`（默认开）— `keygo_core.c:115`。
   - 卡尔曼滤波 + `GAPRole_ReadRssiCmd` + `peripheralRssiCB` + `KeyGo_RssiProcess` 全链路已在 — `peripheral.c:134/147/354-356/588/620/678-680`、`keygo_core.c:622-642`。
   - 阈值/计数/离开落锁分支已落地：`g_cfgUnlockThreshold=-45`、`g_cfgLockThreshold=-65`、`g_cfgUnlockCount=2`、`g_cfgLockCount=3`、`g_cfgDisconnectLockMs=5000` — `keygo_core.c:109-115`、锁车分支 `keygo_core.c:721-`。
   - **含义**：Phase 3「AUTO + RSSI + 离开落锁」大半已存在，剩余工作是「硬化 + 确认默认开 + 调阈值」，而非从零实现。
2. **解锁闸门当前用 `!LINK_ENCRYPTED && !sessionAuthed`**（`keygo_core.c:699-700`）。
   - 现状 Just Works 下 `LINK_ENCRYPTED` 对任何配对手机为真 → 任何手机可 RSSI 解锁（已知取舍，代码注释已写明）。
   - **Passkey 启用后，`LINK_ENCRYPTED` 仅对「输码配对成功的手机」为真 → 该闸门自动变安全，无需改这行。**
3. **两套信任存储（架构底色）：**
   - Bond 表（SNV `0x07E00`/物理 `0x77E00`）：协议栈管，存 LTK。`Bonding_EraseAll` 当前**不清它**（见 Phase 1 的 bug）。
   - 主人信任列表（DataFlash `0x7100`，容量 8）：仅 AUTH 过 `bindKey` 才写入，解锁门控 `Bonding_IsSessionAuthed` 查它。
4. **passkey 能力齐备但被禁用：** `mitm=0` + `ioCap=NO_INPUT_NO_OUTPUT`（`bonding.c:124-130`）；`Bonding_PasscodeCB` 是空壳（只 `PRINT`，从不调 `GAPBondMgr_PasscodeRsp`，`bonding.c:743-750`）。启用只需填实管线。
   - `GAPBOND_PERI_MITM_PROTECTION`(0x401)、`GAPBOND_IO_CAP_*` 全枚举、`gapBondCBs_t.passcodeCB`、`GAPBondMgr_PasscodeRsp`(0x79) 均在 `CH58xBLE_LIB.h` 定义。
   - ESP32C3 端口：`ESP_LE_AUTH_REQ_SC_BOND` + `ESP_IO_CAP_DISP_ONLY` 完整支持（`BLE_Key_Go_v3_6.ino`）。
   - 仓库**无 NRF528xx 代码**（仅 CH582M + ESP32C3 两端口）。

---

## 1. 落地总顺序与提交切分

```
Phase 1  修 SNV bond 清除 bug（最小独立提交，安全必做）
   └─ 覆盖：出厂复位 + UNBIND:ALL + 单设备 UNBIND
Phase 2  启用 passkey/MITM 配对（凭证硬化，让 Phase 3 的 AUTO 变安全）
   └─ 复用绑定码作 passkey；配对即绑定事件
Phase 3  AUTO 模式确认 + RSSI 阈值调优 + 离开落锁（已大部分实现，硬化为主）
   └─ 闸门随 Phase 2 自动安全化；确认默认开；阈值/计数调优
Phase 4  App 瘦身（退役前台服务 + 亮屏轻量唤醒 + 可选高可靠模式）
   └─ 省电、去位置权限、降原生 bug 面
```
> 顺序逻辑：Phase 1 与凭证模型无关、必须先修（否则「恢复出厂」形同虚设）；Phase 2 让已存在的 AUTO 从「裸」变「安全」；Phase 3 在 Phase 2 之后验收；Phase 4 是体验收尾。

---

## 2. Phase 1：修 SNV bond 清除 bug（最小独立提交）

### 2.1 问题复现链（已确认会出）
1. 出厂复位 / `UNBIND:ALL` → 调 `Bonding_EraseAll`（`bonding.c:302-308`）。
2. 该函数**只** `EEPROM_ERASE` 主人信任列表（DataFlash `0x7100`），**完全不碰 SNV 的 LTK 表**（`0x07E00`/`0x77E00`，协议栈自管）。
3. 旧配对手机的 bond（LTK）仍留 SNV → OS 照常自动重连 → `LINK_ENCRYPTED=true`。
4. 解锁闸门 `!LINK_ENCRYPTED && !sessionAuthed` 因前者为真**直接放行** → **旧手机复位/解绑后仍可 RSSI 自动解锁**。
5. 与「恢复出厂 = 清掉所有绑定」语义直接矛盾。

### 2.2 改动点
- **`Bonding_EraseAll`（`bonding.c:302`）内追加**（覆盖出厂复位 + `UNBIND:ALL` 两条路径，因二者共用此函数）：
  ```c
  GAPBondMgr_SetParameter(GAPBOND_ERASE_ALLBONDS, 0, NULL);  // 0x410, lib 已定义
  ```
- **单设备 `UNBIND`（建议同修，避免「只删信任列表、SNV 残留仍能解锁」）：**
  - `Bonding_RemoveAt`（`bonding.c:290-300`）应在删信任列表项后，对该设备调 `GAPBOND_ERASE_SINGLEBOND`（`0x417`，"Must provide address type followed by device address"）。
  - **⚠ 已知难点**：手机多用**随机私有地址（旋转）**，SNV bond 以身份地址/IRK 为键。单删需解析出该连接的**身份地址**再传 `GAPBOND_ERASE_SINGLEBOND`。若实现成本高，可采用**网关策略（见 §2.3 备选）**规避。
- `GAPBOND_ERASE_ALLBONDS`(0x410) / `GAPBOND_ERASE_SINGLEBOND`(0x417) 均在 `CH58xBLE_LIB.h:1133/1140` 定义，全仓此前**零调用**。

### 2.3 备选网关策略（推荐一并评估）
将解锁闸门改为「**信任列表权威**」：`LINK_ENCRYPTED && Bonding_IsOwner(connHandle)`（或 `sessionAuthed`）。
- 这样单设备 UNBIND 只需从信任列表移除即生效，**不必做脆弱的 SNV 单删**（随机地址旋转问题消失）。
- 前提：能把「当前连接」映射到信任列表身份（bond 解析出的身份地址 vs 信任列表存的项）。实现细节列为 Phase 2 的关联 spike。
- 取舍：闸门语义从「bond 即解锁」收紧为「bond 且是主人」。与「passkey=绑定码、配对即入主人列表」模型天然一致。

### 2.4 验收标准
- [ ] 设备复位/UNBIND:ALL 后，旧配对手机**无法**再 OS 自动重连解锁（需重新输码配对）。
- [ ] 串口日志：`[BOND] EraseAll: trust + SNV cleared` 类确认（自加）。
- [ ] 单设备 UNBIND 后该手机同样失权（走 §2.2 单删或 §2.3 网关策略其一）。
- [ ] 不影响正常 bond 持久化（重新配对后仍记得，无需每次重配）。

### 2.5 风险 / 回滚
- 低风险。回滚只需移除新增的 `GAPBondMgr_SetParameter` 调用。
- 注意：此改动会使「已配对但未在信任列表」的旧手机失效——这正是预期行为。

---

## 3. Phase 2：启用 passkey/MITM 配对（凭证硬化）

### 3.1 设计：passkey = 绑定码，配对即绑定事件
- 配对时设备以 `DISPLAY_ONLY` 身份，把**绑定码**作为 passkey 提供给协议栈：`GAPBondMgr_PasscodeRsp(connHandle, SUCCESS, bindCode六位)`。
- 手机系统弹窗「输入密码」→ 用户输绑定码（他本就知道，或从 App 看到）→ MITM 认证 bond（Legacy Passkey，TK=绑定码）。
- **配对成功 = 该手机成为「主人」候选**：在 `Bonding_PairStateCB` 的 `BLE_LINK_ESTABLISHED`/bonded 回调里，把该连接写入信任列表（受容量 8 限制），等价于原 `BIND` 命令的写入动作。
- 之后日常：OS 自动重连 → `LINK_ENCRYPTED`（仅输码配对手机可得）→ 闸门放行 → 无感解锁。**全程零 App、零后台。**

### 3.2 改动点
- **`Bonding_Init`（`bonding.c:124-130`）：**
  ```c
  uint8_t ioCap = GAPBOND_IO_CAP_DISPLAY_ONLY;   // 原 NO_INPUT_NO_OUTPUT
  uint8_t mitm  = 1;                              // 原 0
  ```
- **实现 `Bonding_PasscodeCB`（`bonding.c:743-750`，现为空壳）：**
  ```c
  // 设备无屏无键，passkey 即绑定码（复用 bindKey 体系，已在 Bonding_LoadBindCode 载入）
  GAPBondMgr_PasscodeRsp(connectionHandle, SUCCESS, g_bindCodeNumeric);
  ```
  - `g_bindCodeNumeric` 需由 `Bonding_LoadBindCode` 载入的绑定码字符串转 6 位数值；若绑定码非纯数字需先做映射（见 §3.4 子决策）。
- **`Bonding_PairStateCB`：bonded 成功时写入信任列表**（替代/合并原 `BIND` 命令的信任列表写入）。
- **解锁闸门（`keygo_core.c:699-700`）：Phase 2 后 `LINK_ENCRYPTED` 已仅对输码手机为真 → 闸门自动安全，不改；若采用 §2.3 网关策略则顺带收紧为「bond 且 owner」。**

### 3.3 子决策（需拍板）
- **D1 passkey 来源：**
  - (推) **复用绑定码**：用户已知，弹窗输入最自然；与 `bindKey` 同源，双密合一，App 大幅简化。
  - 随机生成：更安全但需额外「看设备屏/App 显示」步骤，体验差。
- **D2 `BIND` 命令是否保留：** 推荐**保留但弱化**——passkey 配对已是主绑定路径；`BIND` 命令保留作「已配对但未写信任列表」的兜底 / 兼容旧 App。避免破坏现有协议兼容性，也利于 `fwsec` 不升版本。
- **D3 LESC vs Legacy：** CH582M 廉价 RISC-V 大概率仅 **Legacy Passkey**（非 P-256 Secure Connections）。Legacy 对本威胁模型已足够（抗随手配对 + 被动嗅探）。**真机烧录须实测确认走哪条**，并在日志打印配对方式。

### 3.4 验收标准
- [ ] 真机：手机配对 KeyGo 弹「输入密码」→ 输绑定码 → 配对成功（MITM 认证，非 Just Works）。
- [ ] 错误码配对失败：输错码 → 配对被拒，LTK 不写入，无法解锁。
- [ ] 配对成功后该手机靠近自动解锁、离开自动落锁（结合 Phase 3 验收）。
- [ ] **陌生手机无码 `createBond` → 配对被拒（无弹窗可输/输错即失败）→ 不能解锁。**
- [ ] 串口日志打印配对方式（Legacy/LESC）与 passkey 来源，便于真机确认。
- [ ] 旧已配对（Just Works）手机：启用 passkey 后旧 bond 仍在 SNV，但其 `LINK_ENCRYPTED` 是否仍为真取决于协议栈——建议 Phase 1 清 SNV 后统一重新配对，避免新旧混用。

### 3.5 风险 / 回滚
- **首次配对多一步系统输码**：部分国产 ROM 偶发卡，需在 App 帮向导说明「去系统蓝牙设置输码」。
- 回滚：`mitm=0` + `ioCap=NO_INPUT_NO_OUTPUT` 即退回 Just Works。
- 若 Legacy 实测有兼容问题，至少保留「可关 passkey 回退 Just Works」的编译开关。

---

## 4. Phase 3：AUTO 模式确认 + RSSI 阈值调优 + 离开落锁（已大部分实现）

### 4.1 现状盘点（实读确认已存在，非从零）
- AUTO 默认开：`g_cfgAutoLockEnable = 1`（`keygo_core.c:115`）。
- 卡尔曼 RSSI：`KeyGo_RssiProcess`（`keygo_core.c:622-642`），SPIKE 滤波 + 卡尔曼。
- 解锁：`g_filteredRSSI > g_cfgUnlockThreshold(-45)` 连续 `g_cfgUnlockCount(2)` 次 → `KSTATE_UNLOCKED`（`keygo_core.c:707-720`）。
- 离开落锁：`g_filteredRSSI < g_cfgLockThreshold(-65)` 连续 `g_cfgLockCount(3)` 次 → 锁车；断连 `g_cfgDisconnectLockMs(5000)` 后自动锁（`keygo_core.c:721-`、`g_cfgDisconnectLockMs`）。
- 读取：`GAPRole_ReadRssiCmd` 周期 `g_cfgRssiPeriodMs(500)`（`peripheral.c:354-356`）。

### 4.2 改动点（硬化 + 调优，非重写）
- **闸门安全性**：Phase 2 完成后 `LINK_ENCRYPTED` 仅对输码手机为真，闸门（`keygo_core.c:699-700`）天然安全，无需改。若采用 §2.3 网关策略则同步收紧。
- **AUTO 默认开确认**：已是 `1`；需在 App 控制页给**醒目开关 + 状态反馈**（「自动解锁：开/关」+ 安全提示），开关走现有 FF01 `autolock=0/1`。
- **阈值/计数调优（真机实测定）**：`-45/-65` 与 `uc=2/lc=3` 为经验值，需在实测中确认「贴身解锁、远离落锁、不误触」的平衡；建议保留 App 可调（已是）。
- **（可选）AUTO 主开关语义统一**：当前 `g_cfgAutoLockEnable` 已充当「靠近解锁 + 离开落锁」总开关，语义自洽，无需新增字段。

### 4.3 验收标准
- [ ] 已配对手机：走近（RSSI 进解锁区）→ 自动解锁；走远（进锁车区/断连 5s）→ 自动落锁。
- [ ] 贴身抖动（露营等）不反复解锁/落锁（手动冷却 + 计数已防）。
- [ ] App 开关可关 AUTO → 仅手动命令控车，行为符合预期。
- [ ] 陌生未配对手机：连不上（passkey 挡）+ 不解锁。

---

## 5. Phase 4：App 瘦身（退役前台服务）

### 5.1 设计
- **常驻前台服务 Keygo-Foreground 日常退役**：去掉位置权限 + 电池优化豁免弹窗 + 15s 复活/原生 bug 面。
- **轻量亮屏唤醒（非前台）**：把现有 `SCREEN_ON`/`USER_PRESENT` → `tryAutoConnect` 从「前台服务内常驻监听」改为 **manifest 注册的 BroadcastReceiver**（轻量、不持前台服务）。用户一亮屏/解锁即顺手重连，几乎零耗电，专治「ROM 杀后台不重连」。
- **可选「高可靠模式」（默认关）**：用户主动开启时，才起轻量前台服务兜底顽固 ROM（MIUI/HyperOS/EMUI/ColorOS）。默认关 = 省电，需要时开 = 稳。
- 现有「舒适/极速/省电」三模式基本坍缩为「省电模式」（仅 `onShow` + 亮屏唤醒），复杂度大降。

### 5.2 改动点
- `nativeplugins/Keygo-Foreground/`：`KeygoBleScanService` 由「常驻前台服务」改为「按需/可选启动」；`SCREEN_ON`/`USER_PRESENT` 监听移出前台服务、改为 manifest Receiver。
- `stores/ble.js`：重连路径依赖关系调整（亮屏唤醒走 Receiver，而非前台服务总线 `BleScanEventBus`）。
- `pages/control/control.vue` / 设置页：新增「自动解锁」开关 + 「高可靠模式（可选）」开关。
- 移除对位置权限的硬性依赖（若仅前台服务用到）。

### 5.3 关键风险（本阶段最大不确定性）
- **Android 后台广播/启动限制**：`SCREEN_ON`/`USER_PRESENT` 在 App 被强杀后，manifest Receiver 能否被系统派发并拉起重连，因 ROM 而异（Pixel/三星稳，国产激进 ROM 可能不派发）。**这是 Phase 4 能否「退役前台服务」的核心实测点**，必须在目标 ROM 真机验证；若失败则回退「保留可选高可靠模式默认开」。
- 退化体验：ROM 抽风时偶尔走到车边没自动开，掏手机开一下 App 即连（可接受，耳机也偶有）。

### 5.4 验收标准
- [ ] 日常无前台服务常驻（设置里看不到 KeyGo 前台通知）；无位置权限弹窗。
- [ ] 亮屏/解锁手机 → 自动重连并尝试解锁（目标 ROM 实测）。
- [ ] 高可靠模式开启时，顽固 ROM 下仍稳定保连。
- [ ] 省电：对比 Phase 前，待机耗电与自启次数下降（可用 Android 电池统计粗评）。

---

## 6. 待核清单（阻塞 / 非阻塞）

**阻塞（Phase 2 前必核）：**
- [ ] **CH582M 实机配对方式**：Legacy Passkey 还是 LESC？日志打印确认（`Bonding_PairStateCB` 内）。决定 MITM 强度与弹窗形态。
- [ ] **passkey 与 `bindKey` 数值映射**：绑定码若为字母/长码，需映射到 6 位数值 passkey（或约束绑定码为 6 位纯数字）。
- [ ] **单设备 UNBIND 的 SNV 单删可行性**（§2.2）：随机私有地址下能否解析身份地址调 `GAPBOND_ERASE_SINGLEBOND`；否则走 §2.3 网关策略。

**非阻塞（可在各 Phase 内顺带）：**
- [ ] `BIND` 命令与 passkey 配对双路径共存时的信任列表去重/容量边界。
- [ ] App 帮向导补「系统蓝牙输码」引导步骤（Phase 2 配套 UX）。
- [ ] `fwsec` 是否需升：若 `BIND` 协议不变、仅加 passkey 网关，建议不升（向后兼容）；若重构绑定事件则升 `fwsec=2` 并加协商分流。

---

## 7. 版本与 fwsec 规划
- 固件 `KEYGO_FW_VERSION` 当前 `3.33.2`（3.33.x 待烧录批次）。本次 Phase 1~4 建议并入下一烧录批次，版本号随该批次定（不在 App help 侧乱跳）。
- `fwsec`：如 §6 所述，优先保持兼容不升；仅当绑定协议重构才升 `2`。
- 每个 Phase 独立 commit，便于真机逐个验收、出问题单点回滚。

## 8. 回滚与灰度
- Phase 1/2 均有编译级回退（`mitm=0`、`GAPBOND_ERASE` 调用移除）。
- 建议顺序烧录验收：先 Phase 1+2（安全地基）→ Phase 3 实测 → Phase 4 实测；每步真机签字后再进下一步。
- 所有改动需 MounRiver **Clean + Rebuild** 重烧；App 侧改原生插件须 `versionCode+1` + 重做自定义调试基座。
