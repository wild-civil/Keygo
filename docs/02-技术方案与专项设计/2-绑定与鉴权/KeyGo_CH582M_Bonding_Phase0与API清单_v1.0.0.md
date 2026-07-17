# KeyGo CH582M Bonding — Phase 0 验证清单与 SDK API 清单 v1.0.0

> 状态：实施准备（基于真实 SDK 头扒出的 API，非臆测）
> 适用：App 当前主线 / 固件 CH582M（方案 B 落地）
> 草拟：2026-07-10
> 配套：设计见 `KeyGo_本地化绑定与临时授权方案_v1.0.0.md`；骨架代码见 `code/CH582M/CH582M_BLE_Slave/APP/bonding.c` / `bonding.h`

---

## 0. 目的

把"方案 B（固件 Bonding + 信任列表）"从设计推进到可验证的第一步：
1. 从 CH582M SDK 头里**真实扒出** Bonding / SNV / GATT 权限的 API 与常量（带 `文件:行号`），避免凭记忆写错。
2. 列出 **Phase 0（仅验证链路加密 + 权限门控）** 的可执行清单，每一步都有观察点与验收标准。
3. 明确**已确认的设计推论**与**待确认开放项**，作为后续 Phase 1 的实施基线。

所有 `文件:行号` 均来自仓库内 `code/CH582M/CH582M_BLE_Slave/`。

---

## 1. 从 SDK 头扒出的真实 API 清单

### 1.1 初始化 / SNV 配置（链路加密持久化）

| 符号 | 含义 | 位置 | 用途 |
|------|------|------|------|
| `bleConfig_t` | BLE 库初始化结构体（含 SNV 配置） | `LIB/CH58xBLE_LIB.h:127` | `CH58X_BLEInit()` 里填充 |
| `SNVAddr` / `SNVBlock` / `SNVNum` | SNV flash 起始地址 / 块大小 / 块数 | `LIB/CH58xBLE_LIB.h:131-133` | 设 `SNVAddr` 即开启 Bonding 持久化（为 NULL 则不存 LTK） |
| `BLE_SNV == TRUE` 且 `BLE_SNV_ADDR = 0x77E00 - FLASH_ROM_MAX_SIZE` | SNV 已启用，块 256、数 1 | `HAL/include/config.h:91-102` | **结论：Bonding 的 LTK 已由协议栈自动持久化，我们不用管 LTK 存储** |
| `cfg.SNVAddr = ...; cfg.readFlashCB = Lib_Read_Flash; cfg.writeFlashCB = Lib_Write_Flash` | 实际赋值 | `HAL/MCU.c:99-110` | 已接 EEPROM 回调 |
| `Lib_Read_Flash` / `Lib_Write_Flash` | SNV 的 flash 读写回调（内部调 `EEPROM_*`） | `HAL/MCU.c:45-67` | 协议栈用它们落盘 LTK |

### 1.2 GAP Bond Manager 参数与配对模式

| 符号 | 值 | 位置 | 用途 |
|------|----|------|------|
| `GAPBondMgr_SetParameter(param, len, *val)` | — | `LIB/CH58xBLE_LIB.h:4062` | 设置下面所有 PERI_* 参数 |
| `GAPBOND_PERI_PAIRING_MODE` | `0x400` | `LIB/CH58xBLE_LIB.h:1116` | 配对模式 |
| `GAPBOND_PERI_MITM_PROTECTION` | `0x401` | `LIB/CH58xBLE_LIB.h:1118` | MITM（passkey）保护开关 |
| `GAPBOND_PERI_IO_CAPABILITIES` | `0x402` | `LIB/CH58xBLE_LIB.h:1119` | I/O 能力 |
| `GAPBOND_PERI_OOB_ENABLED` | `0x403` | `LIB/CH58xBLE_LIB.h:1120` | OOB |
| `GAPBOND_PERI_DEFAULT_PASSCODE` | `0x407`（uint32_t, 0~999999） | `LIB/CH58xBLE_LIB.h:1124` | 默认配对码 |
| `GAPBOND_ERASE_ALLBONDS` | `0x410` | `LIB/CH58xBLE_LIB.h:1133` | 擦除全部绑定（丢机/恢复出厂用） |
| `GAPBOND_PAIRING_MODE_NO_PAIRING` | `0x00` | `LIB/CH58xBLE_LIB.h:1154` | 不允许配对 |
| `GAPBOND_PAIRING_MODE_WAIT_FOR_REQ` | `0x01` | `LIB/CH58xBLE_LIB.h:1155` | 等从机安全请求/中心请求（**推荐**） |
| `GAPBOND_PAIRING_MODE_INITIATE` | `0x02` | `LIB/CH58xBLE_LIB.h:1156` | 主动发起配对 |
| `GAPBOND_IO_CAP_DISPLAY_ONLY` | `0x00` | `LIB/CH58xBLE_LIB.h:1159` | 仅显示 |
| `GAPBOND_IO_CAP_KEYBOARD_ONLY` | `0x02` | `LIB/CH58xBLE_LIB.h:1162` | 仅键盘 |
| `GAPBOND_IO_CAP_NO_INPUT_NO_OUTPUT` | `0x03` | `LIB/CH58xBLE_LIB.h:1163` | 无输入输出（**无头设备用这个**） |

### 1.3 Bond Manager 回调注册

| 符号 | 含义 | 位置 |
|------|------|------|
| `GAPRole_PeripheralStartDevice(taskid, gapBondCBs_t *pCB, gapRolesCBs_t *pAppCallbacks)` | **注册入口**；当前 `peripheral.c` 第二参传 `NULL` | `LIB/CH58xBLE_LIB.h:4379` |
| `gapBondCBs_t { passcodeCB; pairStateCB; oobCB; }` | 回调表结构 | `LIB/CH58xBLE_LIB.h:2251-2256` |
| `pfnPasscodeCB_t(deviceAddr, connectionHandle, uiInputs, uiOutputs)` | passcode 回调签名 | `LIB/CH58xBLE_LIB.h:2215-2219` |
| `pfnPairStateCB_t(connectionHandle, state, status)` | 配对状态回调签名 | `LIB/CH58xBLE_LIB.h:2224-2227` |
| `GAPBOND_PAIRING_STATE_STARTED/COMPLETE/BONDED/BOND_SAVED` | `0x00/0x01/0x02/0x03` | `LIB/CH58xBLE_LIB.h:1175-1179` |

> **关键**：`peripheral.c` 的 `GAPRole_PeripheralStartDevice(Peripheral_TaskID, NULL, &Peripheral_PeripheralCBs)` 第二参是 `NULL` → 只要改成 `&Bonding_BondCBs`，Bonding 回调即接入。骨架已在 `bonding.c` 提供 `Bonding_BondCBs`。

### 1.4 GAP 配对事件（在 `Peripheral_ProcessGAPMsg` 里新增 case）

| 事件 | 值 | 位置 |
|------|----|------|
| `GAP_AUTHENTICATION_COMPLETE_EVENT` | `0x0A` | `LIB/CH58xBLE_LIB.h:731` |
| `GAP_PASSKEY_NEEDED_EVENT` | `0x0B` | `LIB/CH58xBLE_LIB.h:732` |
| `GAP_SLAVE_REQUESTED_SECURITY_EVENT` | `0x0C` | `LIB/CH58xBLE_LIB.h:733` |
| `GAP_BOND_COMPLETE_EVENT` | `0x0E` | `LIB/CH58xBLE_LIB.h:735` |
| `GAP_PAIRING_REQ_EVENT` | `0x0F` | `LIB/CH58xBLE_LIB.h:736` |

### 1.5 链路状态标志（执行控制指令前判断）

| 标志 | 值 | 位置 | 含义 |
|------|----|------|------|
| `LINK_AUTHENTICATED` | `0x02` | `LIB/CH58xBLE_LIB.h:309` | 已认证 |
| `LINK_BOUND` | `0x04` | `LIB/CH58xBLE_LIB.h:310` | 已绑定 |
| `LINK_ENCRYPTED` | `0x10` | `LIB/CH58xBLE_LIB.h:311` | 已加密 |

### 1.6 GATT 权限位（控制特征加门控）

| 常量 | 值 | 位置 |
|------|----|------|
| `GATT_PERMIT_READ` | `0x01` | `LIB/CH58xBLE_ROM.h:656` |
| `GATT_PERMIT_WRITE` | `0x02` | `LIB/CH58xBLE_ROM.h:657` |
| `GATT_PERMIT_AUTHEN_READ` | `0x04` | `LIB/CH58xBLE_ROM.h:658` |
| `GATT_PERMIT_AUTHEN_WRITE` | `0x08` | `LIB/CH58xBLE_ROM.h:659` |
| `GATT_PERMIT_AUTHOR_READ` | `0x10` | `LIB/CH58xBLE_ROM.h:660` |
| `GATT_PERMIT_AUTHOR_WRITE` | `0x20` | `LIB/CH58xBLE_ROM.h:661` |
| `GATT_PERMIT_ENCRYPT_READ` | `0x40` | `LIB/CH58xBLE_ROM.h:662` |
| `GATT_PERMIT_ENCRYPT_WRITE` | `0x80` | `LIB/CH58xBLE_ROM.h:663` |

> **改动点（已在源码注释标好）**：`Profile/gattprofile.c` 中
> - `simpleProfilechar1UUID`（CHAR1，FF01 配置）权限 `GATT_PERMIT_WRITE` → `| GATT_PERMIT_ENCRYPT_WRITE`（行 98，注释"到时候需要配对再加密"）
> - `simpleProfilechar3UUID`（CHAR3，FF03 命令）权限 `GATT_PERMIT_WRITE` → `| GATT_PERMIT_ENCRYPT_WRITE`（行 142，同上注释）
> - `simpleProfilechar4UUID`（CHAR4，FF04 序列号）`GATT_PERMIT_READ` → `| GATT_PERMIT_ENCRYPT_READ`（行 161）
> 加 `ENCRYPT` 后，未加密链路写/读这些特征会被 ATT 层拒绝（`ATT_ERR_INSUFFICIENT_ENCRYPT 0x0f`）。
>
> ⚠️ **2026-07-10 设计回退（重要）**：Phase 0 落地的 FF03/FF04 加密门控在 App 联动联调中发现严重问题——
> 无头设备 Just Works 配对**无任何防中间人能力**，却强制每次连接/读序列号都弹系统配对框；且 Android 在"读加密特征失败"时
> `readBLECharacteristicValue` 直接 `fail`，App 无可靠的重试-等待配对完成机制，导致序列号永远读不到 → 绑定态无法恢复 → 配置页恒显"未绑定"，
> 并反复触发配对弹窗、连接不稳使 FF02 状态(RSSI)也收不到。**结论**：对 No-IO 设备，链路加密门控弊大于利，
> **安全边界改由应用层 `BIND` + `AUTH`(HMAC 挑战应答) 承担**。已回退 FF03/FF04 的 `ENCRYPT_*` 权限（改回纯 `GATT_PERMIT_WRITE` / `GATT_PERMIT_READ`），
> Bond Manager 仍保留 `WAIT_FOR_REQ` 配置（仅当访问加密属性才触发，现已不触发，等效休眠）。详见 §3b-0。

### 1.7 信任列表自身存储（应用层数据，非 LTK）

| API | 位置 | 说明 |
|-----|------|------|
| `EEPROM_READ(addr, pBuf, len)` | `CH58x_common.h`（keygo_core.c:11 引入） | 读 DataFlash，`len` 为字节 |
| `EEPROM_ERASE(addr, len)` | 同上（keygo_core.c:788） | 擦除，`len` 需页对齐（256） |
| `EEPROM_WRITE(addr, pBuf, len)` | 同上（keygo_core.c:819） | 写 DataFlash |
| `tmos_snv_read(id, len, *pBuf)` | `LIB/CH58xBLE_LIB.h:2729` | **仅有 read，无 `tmos_snv_write` 暴露** |

> **重要结论**：`tmos_snv_write` 在头文件里**未声明**，不能用于信任列表。信任列表复用 `keygo_core.c` 已验证的 `EEPROM_READ/ERASE/WRITE` 原语，另开一个 DataFlash 页：
> - 配置区 `KEYGO_CFG_ADDR` = `0x77000`（keygo_core.c:723，占 256B 页）
> - BLE SNV（LTK）= `0x77E00`（协议栈自管，**勿碰**）
> - **信任列表 = `0x77100`**（256B 页；8 条≈224B 单页够；改 16 条≈448B 则需 2 页，骨架已按页数自动擦写）

---

## 2. 关键发现与设计推论

1. **LTK 持久化已由协议栈托管**：`BLE_SNV==TRUE` 已开，配对成功后 LTK 自动写入 `0x77E00` 的 SNV，重连时 OS 自动加密。**我们绝不自己写 LTK**，只管应用层信任列表。
2. **无头设备（无屏无键）的配对模型**：设备无法显示/输入 passkey → 不能用 BLE 层 passkey MITM。采用 **Just Works / LESC 仅做链路加密**（`IO_CAP_NO_INPUT_NO_OUTPUT` + `MITM=0`），**真正的所有者鉴权放在应用层 `BIND` 指令里用 `bindPassword` 完成**（challenge-response）。这正是方案文档 §3 的"L0 加密链路 + L1 应用层授权"分层。
3. **`tmos_snv_write` 不可用** → 信任列表用 `EEPROM_*` 自己的页（§1.7）。
4. **权限改动点已预判**：`gattprofile.c` 的 CHAR1/CHAR3/CHAR4 注释明确写了"到时候需要配对再加密"，改动点零歧义。
5. **注册入口已定位**：`GAPRole_PeripheralStartDevice` 第二参当前 `NULL`，改为 `&Bonding_BondCBs` 即接入。

---

## 3. Phase 0 验证清单（仅验证"链路加密 + 权限门控"，不做完整绑定逻辑）

> 目标：用最小改动确认 Bonding 链路能建立、LTK 能持久化、控制特征能被加密门控拦截。每一步用 **nRF Connect / LightBlue** 或 **WCH 串口日志**观察。

### P0-1：确认 SNV 配置有效（不动代码）
- [ ] 读 `config.h` 确认 `BLE_SNV==TRUE`、`BLE_SNV_ADDR=0x77E00-...`、`SNV_BLOCK=256`、`SNV_NUM=1`。
- [ ] 串口日志应无 `SNV config error...`（MCU.c:100 的越界检查）。
- 验收：SNV 区域合法，Bonding 持久化基础成立。

### P0-2：最小 Bonding 使能（✅ 已落地 2026-07-10）
- [x] `peripheral.c` 的 `GAPRole_PeripheralStartDevice(Peripheral_TaskID, &Bonding_BondCBs, &Peripheral_PeripheralCBs)` 第二参已改为 `&Bonding_BondCBs`（原 `NULL`）。
- [x] `Bonding_Init()` 已在 `Peripheral_Init()` 里调用（设置 `GAPBOND_PERI_PAIRING_MODE=WAIT_FOR_REQ`、`IO_CAP=NO_INPUT_NO_OUTPUT`、`MITM=0`，并 `Bonding_Load()` 载入信任列表）。
- [x] 配对事件由已注册的 `Bonding_PairStateCB` 回调打印（`[BOND] pairing complete / bonded / bond saved`），**无需**在 `Peripheral_ProcessGAPMsg` 额外加 `GAP_BOND_COMPLETE_EVENT` case（CH582M 把配对事件路由到注册回调）。
- [x] `obj/APP/subdir.mk` 已将 `bonding.c` 加入 `C_SRCS/C_DEPS/OBJS`（MRS 重扫目录也会自动纳入）。
- 验收：编译通过，设备照常广播/连接，串口可见 `[BOND] init done, owners=N`。

### P0-3：用手机配对，确认 Bonding 建立
- [ ] 手机（nRF Connect）连上 KeyGo → 触发配对（系统弹"配对/配对码"）。
- [ ] 串口应打印 `[BOND] pairing complete` / `bonded` / `bond saved (LTK in SNV)`。
- [ ] 手机蓝牙设置里 KeyGo 显示为"已配对"。
- 验收：配对流程跑通，`pairStateCB` 收到 `BOND_SAVED`。

### P0-4：LTK 持久化（断电不丢）
- [ ] 配对后**断电重启设备**，手机不取消配对。
- [ ] 手机重连 KeyGo → 应**自动加密**（不再弹配对框），串口无重新配对日志。
- 验收：LTK 在 SNV 存活，重连自动加密——证明持久化 OK。

### P0-5：控制特征被加密门控（⚠️ 已回退 2026-07-10）
- [x] ~~`gattprofile.c` 的 CHAR3（FF03 命令）权限：`GATT_PERMIT_WRITE | GATT_PERMIT_ENCRYPT_WRITE`。~~
- [x] ~~`gattprofile.c` 的 CHAR4（FF04 序列号）权限：`GATT_PERMIT_READ | GATT_PERMIT_ENCRYPT_READ`（防未加密读取泄露设备 MAC）。~~
- [x] `SIMPLEPROFILE_CHAR3_LEN` 由 50 → 80，以容纳 `AUTH:<64hex>`（≈69 字节）指令。**此改动保留**（长度无关加密）。
- ⚠️ **回退**：FF03/FF04 的 `ENCRYPT_*` 权限已于 2026-07-10 联调后移除（改回纯 `GATT_PERMIT_WRITE` / `GATT_PERMIT_READ`）。
  原因：无头设备 Just Works 无 MITM 防护，强制配对反而破坏 App 联动（序列号读不到、绑定态无法恢复、反复弹配对、RSSI 收不到）。
  **安全边界改由应用层 `BIND`+`AUTH`(HMAC) 承担**，详见 §3b-0。
- 说明：FF01（RSSI/配置）本就**未**加 ENCRYPT。

### P0-6：定位从机主动加密请求 API（开放项补完）
- [ ] 搜 `GAP_SLAVE_REQUESTED_SECURITY` / `SlaveSecurityReq` / `GAP_SecurityRequest`，确认从机在连接建立后主动发安全请求的函数名（当前头里只见到事件 `0x0C`，未确认发起函数）。
- 验收：Phase 1 能从 `Peripheral_LinkEstablished` 主动触发加密，不等中心发起。

**Phase 0 完成判据**：P0-3~P0-5 全绿 → 链路加密 + 权限门控已验证，可进入 Phase 1（信任列表 + `BIND` 指令 + challenge-response + 解绑 UI）。

---

## 4. 待确认 / 开放项

| # | 项 | 现状 | 处理 |
|---|----|------|------|
| O1 | 从机主动发起加密请求的函数名 | 头里只见事件 `0x0C`，未见发起函数 | **已决策不需**：`WAIT_FOR_REQ` 下由手机端（nRF/App）发起配对即建立加密链路，无需设备主动触发。保留待深挖。 |
| O2 | LESC（LE Secure Connections）是否默认 | 头未直接见 LESC 开关 | 无头设备用 Just Works；LESC/Legacy 仅决定配对算法，不影响应用层 BIND 鉴权。抓包可确认，非阻塞。 |
| O3 | `tmos_snv_write` 缺失 → 信任列表必须用 `EEPROM_*` | 已确认 | 已采用，无需改 |
| O4 | 信任列表容量 8 还是 16 | **已确认：8**（用户 2026-07-10 拍板） | `BOND_ENTRY_MAX=8`，单页 256B 够 |
| O5 | 默认 `bindPassword` 出厂值/贴标/首次绑定后强制改 | 默认码占位 `123456`（打印于设备/说明书） | `bonding.c` 的 `DEFAULT_BIND_CODE`；每芯片烧不同码/二维码标签属生产项，Phase 1 先用统一占位码 |
| O6 | `BIND` 指令走哪个 GATT 特征 | **已确认：复用 FF03 命令通道**（App `ble.js:18` 注释已对齐） | 不新增 GATT 特征，降低改动面 |

---

## 3b. Phase 1（固件侧已落地 2026-07-10，App 侧待做）

> 固件已实现真实密码学 + BIND/AUTH/UNBIND + 会话门控；App 侧（SHA256/HMAC、BIND/AUTH 命令、isBound 状态、绑定/解绑 UI）为 ② 续作。

### 3b-1 新增文件
- `APP/crypto_sha256.c` / `.h`：标准 **SHA-256 + HMAC-SHA256**（FIPS-180-4 / FIPS-198），带 `sha256_self_test()`（标准向量 `abc` 与 HMAC 向量），上电跑一次、串口 `PASS/FAIL`。SDK 无 SHA/HMAC，此为自实现。

### 3b-0 ★ 安全边界决策（2026-07-10 联调后定稿）
- **链路加密门控已移除**：FF03/FF04 改回纯 `GATT_PERMIT_WRITE` / `GATT_PERMIT_READ`（无 `ENCRYPT_*`）。
  理由：无头设备（无屏无键）仅能 Just Works / LESC，**链路层无任何防中间人能力**；强制配对反而破坏 App 联动
  （序列号读不到→绑定态无法恢复、配置页恒显"未绑定"、反复弹配对框、连接不稳致 FF02 状态/RSSI 收不到）。
- **安全边界 = 应用层 `BIND` + `AUTH`(HMAC 挑战应答)**：
  - 控制指令（UNLOCK/LOCK/…）须经会话鉴权（`s_sessionAuthed`，由 `BIND` 成功或 `AUTH` 成功置位，断连清零）；
  - 未绑定设备 `Bonding_Count()==0` → `DENY:NOT_BOUND`；已绑定但未鉴权 → `DENY:AUTH_REQ:<nonce>`；
  - 序列号(=MAC)明文可读，用于 KDF 派生 `bindKey`，但**无 bindCode 无法派生 key、无法 BIND/AUTH**，故无密钥泄露风险。
- **Bond Manager 保留 `WAIT_FOR_REQ`**：仅当访问加密属性才由系统触发配对，现已不触发（等效休眠），便于将来若换带屏设备启用 LESC+MITM 时直接加回 `ENCRYPT_*` 权限即可。

> ⚠️ **2026-07-10 二次修复（v3.30-fix）：信任模型从「基于 MAC」改为「基于共享密钥」**。
> 现象：烧录 v3.30 后 `BIND:FAIL:NOT_OWNER`、控制无反应。根因：**Android/iOS 的 BLE 地址是随机化私有地址，每次连接都变**，
> 而原实现用 `peerAddr`(MAC) 做 owner 身份与 `AUTH` 查找（`Bonding_IsOwner`/`Bonding_Find`），导致**同一台手机二次连接也找不到 owner**
> → `BIND:FAIL:NOT_OWNER`、`AUTH:FAIL:NO_PEER`，命令被拒。
> 修复（`APP/bonding.c` 三个处理函数）：
> - `BIND:<code>`：默认绑定码（贴机身）即所有权/恢复凭证，**已知默认码即可首绑或覆盖重绑**，去除 NOT_OWNER 死锁；
> - `AUTH:<hmac>`：用存储的 `bindKey` 校验 `HMAC(nonce, bindKey)`，**不再按 MAC 查找 owner**，与对端地址无关；
> - `UNBIND[:ALL]`：门控改为「须先 AUTH 会话鉴权（证明持有密钥）」，不再依赖 MAC 身份；
> - 绑定落盘时仍写 `peerAddr` 仅作「非空槽」标记（`Bonding_Load` 靠全 0xFF 判空，否则绑定会丢）；
> - 单 owner 模型，密钥即身份，彻底规避 MAC 随机化问题。
> App 侧配套修复（`stores/ble.js`、`control.vue`、`index.vue`、`config.vue`）：`sendCommand` 校验 `ensureSession()` 结果，未绑定/鉴权失败即抛 `NOT_BOUND`/`AUTH_FAIL` 错误（杜绝"解锁成功"假成功）；配置页"已绑定"分支也提供"重新绑定"输入框。

### 3b-2 密钥派生（KDF，两端一致）
```
bindKey[16] = SHA256( 绑定码ASCII || 序列号ASCII )[0:16]
序列号      = FF04 读取的 MAC 十六进制串（12 字符，大写，如 "A1B2C3D4E5F6"）
```
- 设备端：`Bonding_DeriveKey()` 用自身 MAC 构造序列号。
- App 端：读 FF04（**明文读**，已无加密门控）得到序列号，用用户输入的绑定码 + 序列号算出同一 `bindKey`，本地保存用于后续 AUTH。

### 3b-3 FF03 指令协议（明文链路 + 应用层 AUTH 门控）
| 手机→设备 | 说明 |
|-----------|------|
| `BIND:<绑定码>` | 首绑校验默认码 `123456`；owner 重绑可改码。成功回 `BIND:OK`，并置本连接会话鉴权 |
| `NONCE` | 设备生成一次性 nonce（16B），回 `NONCE:<32hex>` |
| `AUTH:<64hex>` | `HMAC-SHA256(nonce, bindKey)` 的 64 hex；校验通过回 `AUTH:OK` 并置会话鉴权 |
| `UNBIND` | 解绑自己（须为 owner），回 `UNBIND:OK` |
| `UNBIND:ALL` | 清空信任列表（恢复出厂），回 `UNBIND:OK` |
| 其余（UNLOCK/LOCK/TRUNK/STATUS/NAME…） | 控制类：须经会话鉴权才执行 |

### 3b-4 设备→手机回写（FF02 Notify 短报文，前缀区分）
- `BIND:OK` / `BIND:FAIL:CODE|NOT_OWNER|SHORT|SAVE`
- `NONCE:<32hex>`
- `AUTH:OK` / `AUTH:FAIL[:NO_NONCE|NO_PEER|BAD_HEX]`
- `UNBIND:OK` / `UNBIND:FAIL:NOT_OWNER`
- `DENY:NOT_BOUND`（设备未绑定时控制被拒）
- `DENY:AUTH_REQ:<32hex>`（已绑定但本连接未鉴权，内联带 nonce，App 据此算 HMAC 回 AUTH）

### 3b-5 门控逻辑（`Peripheral_HandleFF03`）
1. BIND/NONCE/AUTH/UNBIND → 走绑定层，不门控。
2. 控制指令：`Bonding_Count()==0` → `DENY:NOT_BOUND`；`!Bonding_IsSessionAuthed()` → `DENY:AUTH_REQ:<nonce>`；否则执行 `KeyGo_HandleCommand`。
3. 会话鉴权在 **BIND 成功** 或 **AUTH 成功** 后置位，**断连清零**（`Bonding_ConnTerminated`）。

### 3b-6 验收（待用户烧录 + nRF Connect / App）
- [ ] 上电串口见 `[CRYPTO] sha256 self-test: PASS`、`[BOND] init done, owners=0`。
- [ ] **不再弹系统配对框**（已移除加密门控，链路纯明文；安全由应用层 AUTH 保证）。
- [ ] 连上即读 FF04 拿到序列号（明文）→ App 恢复绑定态；配置页"未绑定"/"已绑定"正确显示。
- [ ] 配置页「绑定设备」输 `123456` → 回 `BIND:OK`；串口 `owner added`；状态变「已绑定·本连接已验证」。
- [ ] 写 `NONCE` → 回 `NONCE:<hex>`；用 key 算 HMAC 写 `AUTH:<hex>` → 回 `AUTH:OK`。
- [ ] AUTH 后写 `UNLOCK` → 执行；未 AUTH 写 `UNLOCK` → `DENY:AUTH_REQ:<nonce>`。
- [ ] 断连重连后 App `ensureSession` 自动重跑 AUTH（会话态已清）。
- [ ] FF02 状态(RSSI)稳定刷新（连接不再被配对打断）。

---

## 5. 与方案文档对应

- 本文 §1.6 + §3 P0-5 = 方案文档 §5.1(d) 权限位、§12.2 工作项 2。
- 本文 §2.2（无头设备 Just Works + 应用层授权）= 方案文档 §12.3（D8 输绑定码）+ §3 L1。
- 本文 §1.7 + 骨架 `bonding.c` = 方案文档 §5.1(a)(b) 信任列表、§12.6 存储论证。
- 本文 §3 = 方案文档 §12.5 Phase 0。
- 本文 §3b = 方案文档 §5.1(c) bindKey 派生 + §12.3 应用层鉴权 + challenge-response。
