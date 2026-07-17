# KeyGo 授权体系 v1 —— per-phone 身份 + RSSI 阈值跟随

- **版本**：固件 `KEYGO_FW_VERSION` `3.35.0` → `3.36.0`；`KEYGO_FWSEC` `1` → `2`
- **日期**：2026-07-17
- **作者**：KeyGo（CH582M 主固件 + uni-app App）
- **关联提交**：（待烧录验证后提交；本次改动不自动 commit，先交用户真机测试）

---

## 0. 背景与要根治的问题

之前信任模型 = **基于共享密钥**（`bindKey = SHA256(code||serial)`，全 8 个 owner 算出来是**同一个值**）。
由此带来两个同源缺陷：

1. **per-phone 缺失**：所有 owner 共用一把密钥，固件无法区分「是哪台手机」，于是
   - 无法做 per-phone 的精细化撤销/审计；
   - 身份锚只能靠「密钥命中」，而所有密钥相同 → 本质上没有 per-phone 身份。
2. **RSSI 阈值不跟随**：自动解锁/上锁阈值（`g_cfgUnlockThreshold` / `g_cfgLockThreshold`）是**全局单一值**。
   但每台手机 BLE 发射功率/天线/壳料不同，同一距离下 RSSI 不同 → 全局阈值对 A 手机合适、对 B 手机就「过早/过晚」解锁。
   状态机在 `keygo_core.c: KeyGo_ProcessStateMachine()` 里直接读全局阈值，没有「按当前连接手机」选阈值的能力。

本设计一次性根治二者：给每台手机一个**稳定且唯一的 phoneId**，派生**各自不同的 per-phone 密钥**；并在信任条目里存**每 owner 的 RSSI 阈值**，状态机按「当前已鉴权 owner」选阈值。

---

## 1. 密钥体系（fwsec=2）

```
gk        = SHA256( utf8(code) || utf8(serial) )[0:16]      // 组密钥：全家共享，由「当前有效码+序列号」随时可重算，不落盘
phoneKey  = HMAC-SHA256( gk, phoneId )[0:16]                 // 每手机独立密钥；phoneId 由 App 生成并持久化（8 字节随机）
```

- `serial` = FF04 的 MAC 十六进制串（12 字符大写），固件/App 同源。
- `phoneId` = App 首次运行时生成的 8 字节随机数（hex 16 字符），存 `uni storage: keygo_phone_id`，**每台手机+每次装机唯一**（重装 App 视为新手机，会新增一条 owner；旧条目可手动 UNBIND）。
- 旧 App（fwsec<2，不发 phoneId）走**兼容分支**：AUTH 用 `gk` 校验、BIND 写入 `phoneId=0 / phoneKey=gk` 的「遗留条目」。

### 为什么 gk 不落盘
`gk` 完全由「当前有效绑定码 + 序列号」决定，固件上电即有这两样，随时 `Bonding_DeriveKey` 重算。
因此信任条目**只需存 phoneKey**（不必再存一份 gk），省出空间给 per-phone 字段；且 `SETCODE` 改码后，固件用新 gk 重新 `HMAC(gk, phoneId)` 即可刷新所有 owner 的 phoneKey，无需持久化 gk。

---

## 2. 信任条目新布局（DataFlash，单页 256B）

```c
#define BOND_PHONE_ID_LEN  8
#define BOND_KEY_LEN      16   /* phoneKey 长度（=gk 长度）*/
typedef struct __attribute__((packed)) {
    uint8_t  phoneId[BOND_PHONE_ID_LEN]; // 8  稳定每手机 id（全 0xFF = 空槽；全 0x00 = 遗留条目）
    uint8_t  phoneKey[BOND_KEY_LEN];     // 16 per-phone 密钥 = HMAC(gk, phoneId)
    int16_t  rssiUnlock;                 // 2  本 owner 解锁 RSSI 阈值（绑定初始化=全局配置值）
    int16_t  rssiLock;                   // 2  本 owner 锁车 RSSI 阈值
    uint8_t  role;                       // 1  0=owner（管理员/guest 预留）
} bondEntry_t;                           // packed = 29 字节
```

- 8 条 × 29 = 232B，+ 4B 格式魔数 `0x4B474E54`("KGNT") = 236B ≤ 256B → **仍为 1 页**（`BOND_PAGES` 自动保持 1）。
- **升级兼容**：旧固件写入的是 28B/条无魔数格式。新固件 `Bonding_Load` 读到非 `KGNT` 魔数即判定为旧格式 → `Bonding_EraseAll()` 清空，用户重新绑定一次即可（一次性，fwsec 破坏性升级固有代价）。
- 旧布局的 `peerAddr[6]` 已删除：随机私有地址(RPA)每次连接都变，本就不能做身份锚，留着徒占空间。

---

## 3. FF03 协议变更（fwsec=2）

### 3.1 BIND
- **新格式（fwsec≥2）**：`BIND:<code>\0<phoneIdHex16>`
  - 用 `0x00` 作分隔符（绑定码为 ASCII 文本，不含 NUL，安全）。
  - 例：`BIND:123456\0A1B2C3D4E5F60718`（code=123456，phoneId=A1B2C3D4E5F60718）
- **遗留格式（兼容）**：`BIND:<code>`（无 NUL）→ 写入 `phoneId=0 / phoneKey=gk`。
- 固件：校验码匹配当前有效码 → 算 `gk` → `phoneKey = HMAC(gk, phoneId)`（遗留则 `phoneKey=gk`）→ 按 `phoneId` 查重（已存在则刷新 phoneKey，不存在且未满则新增）→ 初始化 `rssiUnlock/rssiLock = 当前全局配置` → 置会话鉴权。
- 回包不变：`BIND:OK:<saltHex32>` / `BIND:FAIL:*`。

### 3.2 AUTH
- **新格式（fwsec≥2）**：`AUTH:<phoneIdHex16>:<hmacHex64>`
  - `hmac = HMAC-SHA256(nonce, phoneKey)`。
- **遗留格式（兼容）**：`AUTH:<hmacHex64>`（69 字节）→ 算 `gk`，校验 `HMAC(nonce, gk)`；命中即鉴权，但 `s_authedOwnerIdx=-1`（无 per-phone 身份，状态机用全局阈值）。
- 固件：新格式按 `phoneId` 定位 owner，校验其 `phoneKey`；命中写 `s_authedOwnerIdx`。
- 回包不变：`AUTH:OK` / `AUTH:FAIL:*`。

### 3.3 RSSISET（新增，per-phone 阈值跟随的核心写入口）
- 格式：`RSSISET:<unlock>:<lock>`（有符号十进制 RSSI，如 `RSSISET:-45:-65`）。
- 前置：**必须已会话鉴权**且 `s_authedOwnerIdx ≥ 0`（即本机知道自己是谁）。
- 固件：把当前 owner 的 `rssiUnlock/rssiLock` 改写为指定值，`Bonding_Save()` 落盘。
- 回包：`RSSISET:OK` / `RSSISET:FAIL:NO_AUTH` / `RSSISET:FAIL:SHORT`。
- **App 行为**：完成 AUTH 后（以及用户在配置页改阈值且已鉴权时）自动下发 `RSSISET:<本机配置的解锁阈值>:<本机配置的锁车阈值>`，使「本机阈值」= 用户为这台手机设的值 → 即「RSSI 阈值跟随」。

### 3.4 其余命令（NONCE / UNBIND / SETCODE / C1 / ENCRYPT）协议不变
- `SETCODE` 改码后：固件用新 `gk` 重新算每个 owner 的 `phoneKey = HMAC(gk, phoneId)`（遗留条目 `phoneId=0` → `phoneKey=gk`），保证改码后所有手机仍能 AUTH。
- `C1` 签名校验：遍历 owner 用各 `phoneKey` 验（与旧逻辑用 `bindKey` 验同构，仅字段名变）。

---

## 4. 状态机阈值选择（keygo_core.c）

`KeyGo_ProcessStateMachine()` 与 `KeyGo_NotifyStatus()` 的 `th` 计算，原直接用全局
`g_cfgUnlockThreshold / g_cfgLockThreshold`。现改为：

```
若 s_authedOwnerIdx >= 0：用 s_bondTbl[idx].rssiUnlock / .rssiLock   // 当前已鉴权手机自己的阈值
否则：用全局 g_cfgUnlockThreshold / g_cfgLockThreshold              // 纯 OS 无App模式（无 owner 身份）走家庭默认
```

新增 API：`Bonding_GetActiveOwnerRssi(int16_t *unlock, int16_t *lock)` 返回 1=用了 owner 阈值 / 0=用了全局。
status JSON 增加 `"ou":<u>,"ol":<l>`（当前生效的解锁/锁车阈值，便于 App 调试显示）。

---

## 5. App 侧改动（stores/ble.js + utils/crypto.js）

- `crypto.js` 新增 `derivePhoneKey(gkBytes, phoneIdBytes)` = `hmacSha256Bytes(gk, phoneId)[0:16]`。
- 新增 `getPhoneId()`：懒生成 8 字节随机、持久化 `keygo_phone_id`，返回 hex。
- `B._bindKey` 语义从「gk」升级为「phoneKey」：
  - `bindDevice`：`gk = deriveBindKey(code, sn)`；`pk = derivePhoneKey(gk, phoneId)`；存 `pk`；BIND 带 phoneId；AUTH 兜底用 `pk`。
  - `ensureSession` / `_authWithKey` / `DENY:AUTH_REQ` 回 AUTH：fwsec≥2 且 phoneId 就绪时发 `AUTH:<phoneId>:<hmac>`，否则遗留 `AUTH:<hmac>`。
  - `verifyBindCode`：改比 `derivePhoneKey(deriveBindKey(code,sn), phoneId)`（不再直接比 gk）。
  - `changeBindCode`：改码后用 `derivePhoneKey(deriveBindKey(newCode,sn), phoneId)` 覆写 `B._bindKey` 与持久化。
  - `_signCommand`（C1）：仍用 `B._bindKey`（现为 phoneKey），与固件 `VerifySignedCmd` 用 owner.phoneKey 验一致。
- AUTH 成功（`_handleBindingNotify` 的 `AUTH:OK`）后，追加下发 `RSSISET:<本机解锁阈值>:<本机锁车阈值>`（仅 fwsec≥2）。

> 注意：fwsec=2 是**协调升级**——新固件 + 新 App 配套。旧 App 连新固件：走遗留兼容分支（gk）仍可控制，但无 per-phone 身份、RSSI 阈值不跟随；其条目为遗留条目，可被新 App 手机 AUTH 时按 gk 校验。

---

## 6. 真机测试清单（交用户）

1. **烧录 3.36.0**：上电串口应见 `[INIT] FW Version: 3.36.0`；`[BOND] init done ...`；`Bonding_Load` 因格式魔数不符应打印一次「旧格式→清空」（旧绑定失效，需重绑）。
2. **两台手机各绑一次**：均走 `BIND:<code>\0<phoneId>` → `BIND:OK`；固件 `[DIAG] appOwners=2`。
3. **互踢消失**：两台手机同时近场，不再互相踢（沿用 step1 的 8-SNV 扩容）；串口 `Bonding_DumpStatus` 见 2 条 `key=... phoneId=...`。
4. **per-phone 密钥不同**：串口 `[DIAG]` 两条 owner 的 `key=`（前 4 字节）应**不同**（旧版全相同）。
5. **RSSI 阈值跟随**：手机 A 配 `unlock=-40 lock=-60`，手机 B 配 `unlock=-55 lock=-75`；各自近场，串口应见 A 用 -40/-60、B 用 -55/-75 触发解锁/上锁（status JSON `ou/ol` 随之不同）。
6. **遗留兼容**：用未升级的旧 App（fwsec=1）连新固件，仍能用 gk AUTH 控车（无 per-phone、阈值走全局）。
7. **改码传播**：手机 A `SETCODE` 改码 → A、B 均能用新码 AUTH（固件已重算两owner 的 phoneKey）。
8. **UNBIND:0 精准解绑**：手机 A 解绑自己 → `appOwners` 变 1，B 不受影响（不被踢）。

---

## 7. 破坏性说明

- 改信任表布局 = 一次性重分区，旧 owner/LTK 失效，各手机需**重新绑定一次**（仅一次）。
- 升级后旧 App 仍可基础控车（gk 兼容），但建议同步升级 App 以享 per-phone + RSSI 跟随。
- App 需重做自定义调试基座（改了 `stores/ble.js`/`crypto.js` 属 JS 层，标准基座不生效原生插件；本次未改原生插件 `.java`，但 JS 改动需重编基座/重跑让手机吃到新 JS）。
