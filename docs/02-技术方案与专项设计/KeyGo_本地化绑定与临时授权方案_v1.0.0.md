# KeyGo 本地化绑定与临时授权方案 v1.0.0

> 状态：方案讨论中（仅设计，未落地代码）
> 适用版本：App 当前主线 / 固件 CH582M（待确认是否迁移 ESP32C3）
> 草拟时间：2026-07-10
> 目标：在不联网、不服务器、不数据库的前提下，用纯本地机制解决"谁的控制指令能被执行"的问题，并预留"临时访客授权"能力。
>
> 本文与 `KeyGo_安全加固与加密规划_v1.0.0.md` 互补：**安全规划文档**负责"固件如何拦截未授权写"的底层机制（对应本文的方案 B）；**本文**负责"绑定/访客的产品形态、本地数据结构、交互流程、待拍板决策"。

---

## 0. 文档目的与定位

- 本方案**只讨论设计，不改动任何代码**。
- 核心约束来自用户诉求：**省钱、不联网、不依赖服务器与数据库**，纯本地实现。
- 方案的本质是把"能不能控"的判断，从"谁连上了"变成"谁被授权了"，且授权信息**落在设备侧**（而非仅记在 App 里）。

---

## 1. 用户原始诉求拆解

| # | 诉求 | 说明 |
|---|------|------|
| 1 | **不联网** | 不注册账号、不上云、不数据库；规避服务器/域名/合规成本。 |
| 2 | **任何设备都能连** | BLE 连接本身不受限（沿用现状，便利性优先，也利于首次配对）。 |
| 3 | **未绑定需绑定** | 第一次连上某台设备时，必须走一次绑定流程才能拥有控制权。 |
| 4 | **绑定后自动连接** | 已绑定的手机之后自动连接（沿用现有自动重连逻辑，仅加授权门槛）。 |
| 5 | **解绑方式** | 两种设想：(a) 在手机系统蓝牙设置里"忽略此设备"；(b) 在 App 内帮助/设置里提供"解除绑定"入口（待定哪种或两者都要）。 |
| 6 | **绑定用配对码** | 首次绑定需要输入一个配对码（`bindPassword`），证明"你是所有者"。 |
| 7 | **后期：临时访客码** | 通过 App 或小程序**本地随机生成**一个连接码，可设"使用时长/使用次数"，方便临时把车挪一下（如借人、维修、挪车）。 |

---

## 2. 核心概念澄清：BLE 的"绑定" ≠ App 记住 MAC

这是整个方案的根基，必须先对齐认知：

### 2.1 连接不受限是 BLE 的天然特性
任何手机都能"连上"一只耳机/手环——连接（Connection）这一步不鉴权。你设想的"设备可以连接"正是这个特性，**无需额外处理**。

### 2.2 "能连但不能控"靠的是 Bonding + GATT 权限位
耳机/手环"拒绝未配对连接"的真实实现方式：
- 控制通道（Characteristic）被设置为 **`GATT_PERMIT_ENCRYPT_WRITE` / `GATT_PERMIT_AUTHEN_WRITE`**。
- 未配对（未 Bonding）的手机连上是能连，但一写控制指令就被拒（`ATT_ERR_INSUFFICIENT_ENCRYPT` / `INSUFFICIENT_AUTHEN`）。
- 配对（Bonding）后，链路层用长期密钥 **LTK** 加密，之后每次连接 OS 自动加密，控制指令才被放行。

> 结论：**"拒绝未配对"是设备的 GATT 权限门控，不是 App 里记个 MAC。** 只在 App 里记 MAC 属于"自己手机上的便利标签"，设备侧仍谁连都能控。

### 2.3 CH582M SDK 原生支持这套机制
`code/CH582M` 的 SDK 头（`CH58xBLE_ROM.h`）已定义：
- `LINK_BOUND`、`GAP_BOND_COMPLETE_EVENT` —— 配对完成事件
- `SNVAddr` —— 存 LTK / 绑定信息的非易失存储
- `GATT_PERMIT_ENCRYPT` / `GATT_PERMIT_AUTHEN_*` —— 特征值权限位

所以"耳机式拒绝"在 CH582M 上**技术上完全可行**，只是当前 `peripheral_main.c`（v3.16）是裸骨架，**没有启用**——控制指令目前谁连都能发（见安全规划 V-01）。

---

## 3. 总体架构：三层授权模型

把诉求翻译成三层机制：

| 层级 | 名称 | 机制 | 谁拥有 | 失败表现 |
|------|------|------|--------|----------|
| **L0** | 连接层 | 任何人可 BLE 连接（无门控） | 任何人 | ——（永远允许） |
| **L1** | 所有者绑定（owner） | Bonding（链路加密）+ 设备信任列表 + 可选 `bindPassword` | 设备所有者（1~N 台手机） | 未绑定手机连上但控制指令被拒 |
| **L2** | 访客临时码（guest） | 设备内"临时授权槽"，带过期时间/使用次数 | 被 owner 发放临时码的人 | 码过期/次数用尽后控制指令被拒 |

**身份 × 能力矩阵**（设备侧判断）：

| 连接方身份 | 能连？ | 能读状态？ | 能发控制指令？ | 条件 |
|-----------|--------|-----------|---------------|------|
| 陌生人（未 Bonding/未授权） | ✅ | 部分（公开信息） | ❌ | 控制特征需加密/授权写 |
| 已 Bonding 但非本机（未 BIND） | ✅ | ✅ | ❌（无授权 key） | challenge-response 失败 |
| 已 BIND 所有者 | ✅ | ✅ | ✅ | 持 `bindKey`，加密链路 |
| Guest（临时码有效） | ✅ | ✅ | ✅（限临时权限） | 码在有效期内且次数未耗尽 |

---

## 4. 两种绑定强度方案对比（关键决策）

这是必须首先拍板的点。

### 方案 A：纯 App 记 MAC（伪绑定）
- **做法**：App 本地存 `{mac, 已绑定标志}`；设备固件**不改**，仍谁连都能控。
- **"绑定"含义**：仅本机 App 的一个便利标签——只影响"本机是否参与自动重连"，**不提供任何真实安全**。
- **优点**：零固件改动，工作量极小，当天可上线。
- **缺点**：任何人拿另一台手机连上就能开锁；"拒绝未配对"只是假象。等同于现状套了个壳。

### 方案 B：固件 Bonding + 信任列表（真绑定）
- **做法**：固件启用 GAPBondMgr；控制特征加 `GATT_PERMIT_ENCRYPT/AUTHEN_WRITE`；Bonding 后把对端身份写入**信任列表**（SNV flash，断电不丢）；控制指令改 challenge-response，校验授权 key。
- **优点**：真正的"能连不能控"，与耳机/手环同等级别；绑定信息在设备侧，换手机/重装 App 仍可信。
- **缺点**：需改 CH582M 固件（或迁移 ESP32C3）；需约定固件版本协商（旧 App 连不上新固件）；配对手感需 UX 验证。

### 对比表

| 维度 | 方案 A（记 MAC） | 方案 B（固件 Bonding） |
|------|----------------|----------------------|
| 真实安全性 | ❌ 无 | ✅ 强（链路加密 + 设备侧授权） |
| 防陌生人直开 | ❌ | ✅ |
| 固件改动 | 无 | 中~大 |
| App 改动 | 小（加本地存储） | 中（配对/加密连接流程） |
| 解绑可靠性 | 仅删本地记录 | 设备侧+本地双侧清除 |
| 多手机共享 | 各自记 MAC（互不认） | 信任列表 N 条 |
| 与现状自动重连 | 直接可用 | 加 `isBound` 门槛即可 |
| 后期临时码 | 只能 App 侧模拟（仍不安全） | 设备侧 guestSlot（真安全） |

> **建议：方案 B。** 否则"绑定"形同虚设，且方案 A 无法支撑后期"临时访客码"的真实安全性。仓库 `code/ESP32C3`（v3.0~v3.13）已有 `connPassword`/`bindPassword`/信任列表/物理配对键/Bonding 的完整模型，可直接当参考实现。

---

## 5. 详细数据结构设计

### 5.1 固件侧（方案 B 下的 CH582M）

**(a) 信任列表条目 `trustedPeer`**
```
trustedPeer {
  uint8  peerAddr[6];     // 对端手机蓝牙 MAC
  uint8  peerAddrType;    // PUBLIC / RANDOM
  uint8  role;            // 0=owner, 1=guest
  uint8  bindKey[16];     // 与 owner 共享的授权 key（HMAC 种子）
  uint32 addedAt;         // 绑定时间戳
}
```
- 存于 SNV（flash），容量有限——CH582M 建议支持 **2~8 条**（owner 为主，guest 占用其余）。
- `bindKey` **不存明文密码**，存密码派生后的 key（见 §8 安全细节）。

**(b) 绑定密码 `bindPassword`**
- 固化或首次设置（类似出厂默认码，如 `123456`，首次绑定后建议可改）。
- 仅用于**建立 Bonding 后**的授权 key 派生，不裸传。

**(c) 临时授权槽 `guestSlot`（后期 L2）**
```
guestSlot {
  uint8  codeHash[16];    // 临时码派生哈希（不存明文）
  uint32 expiresAt;       // 过期绝对时间（RTC）
  int16  remainCount;     // 剩余可用次数（-1 = 不限次仅按时长）
  uint8  perms;           // 权限位：开锁/锁车/后备箱...
  uint8  usedBy[6];       // 最近使用者（可选，防同码多设备蹭）
}
```
- 单槽（或少量槽）即可，覆盖"临时挪车"场景。
- 过期或次数归零 → 槽自动清空，控制指令恢复拒绝。

**(d) GATT / 指令接口（新增或复用）**
| 指令/特征 | 方向 | 说明 |
|-----------|------|------|
| `BIND` | App→设备 | 在 Bonding 加密链路上，提交 `bindPassword` 派生 key，写入信任列表 |
| `UNBIND` | App→设备 | 清除本机在信任列表的条目（需先授权） |
| `GUEST_ADD` | owner→设备 | 下发临时码哈希 + 时长/次数/权限，占 guestSlot |
| `GUEST_REVOKE` | owner→设备 | 立即清空 guestSlot |
| `GET_NONCE` | App→设备 | 取一次性随机数，用于 challenge-response |
| `STATUS` | 设备→App | 返回绑定状态、guestSlot 剩余、授权身份 |

**(e) 固件版本协商**
- 在现有 FF02 加 `fwsec` 版本字段，App 按版本走"旧（裸）/新（加密授权）"路径，避免旧 App 连不上新固件（破坏兼容）。

### 5.2 App 侧

**(a) 现有预留**（已存在，作为接入点）
- `stores/ble.js` 的 `isBound` 标志、`_shouldAutoReconnect` 内 `if (!this.isBound) return false`（现已预留未启用）。
- `stores/user.js` 的 `getBindKey()`（现状为"文档剧场"，需在 `BIND` 后真正落库）。

**(b) 本地存储结构（持久化）**
```
boundDevices: [
  {
    mac: "AA:BB:CC:DD:EE:FF",
    name: "KeyGo-XXXXXX",
    role: "owner",            // owner / guest
    bonded: true,             // 是否已 Bonding（OS 层）
    bindKeyHash: "...",       // 本地缓存的授权 key 派生值（非明文）
    boundAt: 1710000000,
    guestSlot: null | {       // 若本机作为 owner，缓存的临时码发放记录
      code: "临时码明文(仅本机可见)", 
      expiresAt, remainCount, perms, issuedAt
    }
  }
]
```
- 存于 `uni.setStorageSync('keygo_bound_devices', ...)` 或 `stores/user.js` 现有结构内。
- 明文临时码**只留在本机**，不下发时不在设备侧存明文。

**(c) 与自动重连衔接**
- 已绑定设备：沿用现有三模式重连；连接后 OS 自动加密（bonded）；`isBound` 门槛放行控制。
- 未绑定设备：连上但不参与控制，UI 提示"需绑定"。

---

## 6. 交互流程

### 6.1 首次绑定（owner，L1）
1. 手机扫描到 KeyGo，点击连接（L0 任意可连）。
2. 触发 Bonding：
   - 路径一（推荐）：设备物理按键进入 30s 配对窗口（ESP32C3 已有此模型），期间 App 发 `BIND`；
   - 路径二：App 内"绑定"按钮，提示用户输入 `bindPassword`（默认码或已知码）。
3. Bonding 完成后链路加密，App 经加密通道提交 `bindPassword` 派生 key → 设备写入信任列表（SNV）。
4. 设备返回成功，App 本地存 `boundDevices` 条目，`isBound=true`。
5. 之后自动重连即放行控制。

> 关键：**先 Bonding 加密，再传密码派生 key**，绝不明文裸传（防嗅探）。

### 6.2 自动重连（已绑定）
- 流程与现状一致（舒适/手动/极速三模式）。
- 连接建立后 OS 自动以 LTK 加密（无需用户再操作）。
- `isBound` 为真 → 控制指令放行。

### 6.3 临时访客码（guest，L2，后期）
1. owner 在 App 内点"发放临时码"：
   - 本地**随机生成**一个码（如 6~8 位，或更长随机串），**不经服务器**。
   - 设置 `使用时长`（如 30 分钟）和/或 `使用次数`（如 3 次），及权限（仅开锁？开锁+锁车？）。
2. App 经加密通道把码哈希 + 参数下发给设备 `GUEST_ADD`，占 `guestSlot`。
3. 发放渠道（二选一或都做）：
   - App 内生成**二维码**让访客扫（访客手机装 KeyGo App 后扫码自动填入码）；
   - 独立**微信小程序**也支持同样逻辑（扫码/输码），便于没装 App 的人临时用。
4. 访客手机连上设备 → 输入/扫入临时码 → App 提交 `codeHash` → 设备比对 `guestSlot` → 授权临时控制。
5. 过期或次数归零 → `guestSlot` 自动清空，控制指令恢复拒绝；owner 也可随时 `GUEST_REVOKE` 提前撤销。

### 6.4 解绑（两种路径都建议支持）
- **App 内"解除绑定"**：设备侧清信任列表本机条目（`UNBIND`）+ App 本地删 `boundDevices` 对应项。两侧都清，最干净。
- **系统蓝牙"忽略此设备"**：仅删手机侧 Bond 信息（LTK），**设备侧信任列表仍残留** → 建议 App 侧也提供清除，或在设备侧靠"信任列表满时淘汰最旧/或物理键长按清全部"兜底。
- 推荐：**两者都提供**，并在 App 帮助里说明差异。

---

## 7. 固件工作量评估

| 设备 | 现状 | 方案 B 工作量 | 备注 |
|------|------|--------------|------|
| **CH582M**（当前 App 实际连接） | `peripheral_main.c` 裸骨架，无鉴权 | 中~大：启用 GAPBondMgr、控制特征加 `GATT_PERMIT_ENCRYPT/AUTHEN_WRITE`、实现信任列表 SNV 读写、`bindPassword` 校验、`guestSlot` | 需重新烧录验证；当前 `peripheral_main.c` 才 8.5KB，几乎从零加 |
| **ESP32C3**（仓库已有参考） | v3.0~v3.13 已有 `connPassword`/`bindPassword`/信任列表/物理配对键/Bonding（`onPassKeyRequest`/`BLE_SM_IO_CAP_DISP_ONLY`） | 小：基于现有模型裁剪/对接即可 | **最省力路线**，建议优先考虑是否迁移 |

> 待确认：**KeyGo 实际量产设备到底是 CH582M 还是 ESP32C3？** 这决定工作量量级。若确为 CH582M，可把 ESP32C3 那套模型作为移植参考。

---

## 8. 安全细节提醒（必须遵守）

- **密码永不裸传**：4~6 位 `bindPassword` 若明文走 GATT 易被嗅探。必须先 **Bonding 加密链路再传密码派生 key**（ESP32C3 模型即如此）。
- **challenge-response 防重放**：控制指令用 `HMAC(nonce, bindKey)`，nonce 每次不同 → 旧指令重放被拒（对应安全规划 P1-1）。
- **授权 key 不存明文**：设备与 App 都存 key 派生值，不存密码原文。
- **guestSlot 不存明文码**：只存 `codeHash`，降低泄露风险。
- **广播隐匿**（后续）：设备名/厂商指纹可随机化，干扰定向定位（安全规划 P1-2），但与现有 name 识别逻辑需联动改造。

---

## 9. 与现有安全规划文档的衔接

本文方案 B 的固件实现，即安全规划文档的：
- **P0-1**（启用 GATT 加密 + Bonding）→ 本文 §5.1(d) 的权限位与 Bonding。
- **P0-2**（落地真实绑定鉴权，替代 V-02 虚假模型）→ 本文 §5.1(a)(b) 信任列表 + `BIND` + challenge-response。
- V-01~V-09 漏洞清单是方案 B 要消灭的目标。

两张表的对齐：

| 安全规划 | 本文对应 |
|----------|----------|
| V-01 锁指令零鉴权 | 方案 B 的信任列表 + 权限门控 |
| V-02 绑定密码剧场 | 本文 §6.1 真实 BIND 流程 |
| V-04 特征免加密 | §5.1(d) `GATT_PERMIT_ENCRYPT` |
| P0-1 / P0-2 | §4 方案 B 的固件落地 |

---

## 10. 待拍板决策清单

| # | 决策点 | 选项 | 状态 |
|---|--------|------|------|
| **D1** | 绑定强度 | A 记 MAC / B 固件 Bonding | ✅ **已确认：方案 B**（真安全，支撑临时码） |
| **D2** | 量产设备 | CH582M / ESP32C3 | ✅ **已确认：CH582M**（ESP32C3 仅验证用，NimBLE bug 多已弃；后期拟移植 NRF528XX） |
| **D3** | 临时码是否做 | 先做 owner / owner + 后期 guest | ✅ **已确认：先 owner，分步走**（guest 留作后期） |
| **D4** | 临时码形态 | 静态已知码 / 随机时效码（时长+次数） | ⏳ 待定（D3 先 owner，guest 阶段再定） |
| **D5** | 发放渠道 | App 内二维码 / 独立小程序 / 两者 | ⏳ 待定（guest 阶段） |
| **D6** | 多手机/家庭 | 单 owner / 信任列表 N 条 | ✅ **已确认：多手机**，单设备绑定 **8 或 16** 台手机（容量待最终定，建议先 8） |
| **D7** | 解绑 | 仅系统忽略 / App 内解除 + 系统忽略都做 | ✅ **已确认：双侧清除都做** |
| **D8** | 配对触发 | 物理键 30s 窗口 / App 内输入 bindPassword | ✅ **已确认：输绑定码即可**（默认码，无强制 30s 窗口）；物理键作可选增强见 §12.3 |

---

## 11. 后续 TODO（方案确认后转任务，不在此文档实现）

- [ ] 确认量产固件平台（CH582M vs ESP32C3）→ D2
- [ ] 固件：启用 GAPBondMgr + 控制特征 `GATT_PERMIT_ENCRYPT/AUTHEN_WRITE`（P0-1）
- [ ] 固件：信任列表 SNV 读写 + `BIND`/`UNBIND` 指令（P0-2）
- [ ] 固件：`bindPassword` 校验 + challenge-response（HMAC nonce）
- [ ] 固件：FF02 加 `fwsec` 版本协商字段
- [ ] App：`isBound` / `_shouldAutoReconnect` 门槛正式启用
- [ ] App：配对/加密连接流程接入（`utils/ble.js`）
- [ ] App：`boundDevices` 本地持久化结构
- [ ] App：绑定/解绑 UI（设置/帮助页）
- [ ] 后期：guestSlot 固件实现 + `GUEST_ADD`/`GUEST_REVOKE`
- [ ] 后期：App 临时码生成（随机+时长/次数）+ 二维码
- [ ] 后期：小程序端临时码逻辑（可选）
- [ ] 验收：未配对直连被拒 / 已绑正常开 / 临时码过期失效（对齐安全规划 §3）

---

---

## 12. 续谈：CH582M 落地现实、多手机细节与首绑信任锚（2026-07-10 17:35）

### 12.1 已确认决策汇总
- **D1 = 方案 B**：固件 Bonding + 信任列表，真安全。
- **D2 = CH582M**：量产设备锁死为 CH582M。ESP32C3 因 Arduino + NimBLE 各种 bug 仅作验证，已弃；**后期拟移植 NRF528XX 系列**（其 BLE 栈更成熟，Bonding/小程序生态更好）。
- **D3 = 先 owner**：本期只做所有者绑定，guest 临时码留作后期（故 D4/D5 暂不决议）。
- **D6 = 多手机**：信任列表支持 N 条 owner。

### 12.2 CH582M 固件落地的现实约束（方案 B 的工作量来源）
CH582M 是 WCH 的 RISC-V BLE MCU，其 BLE 协议栈（BLE_LIB / TMOS 调度）与 TI 的 GAPBondMgr 思路类似但 API 不同。当前 `peripheral_main.c`(v3.16) 是裸外设骨架（约 8.5KB），**没有任何 Bonding / 权限位 / 信任列表代码**。从零要补：
1. **启用 Bonding**：配置 GAP Bond Manager（IO Cap、配对模式、LTK 存储策略）。CH582M 栈支持 `LINK_BOUND` / `GAP_BOND_COMPLETE_EVENT`，但需确认具体 API 名与 SNV 落盘路径（WCH 栈的 SNV 实现与 TI 不同，需实测）。
2. **控制特征加权限位**：`GATT_PERMIT_ENCRYPT_WRITE` / `GATT_PERMIT_AUTHEN_WRITE`（SDK 头 `CH58xBLE_ROM.h` 已定义常量）。
3. **信任列表 SNV 读写**：把 `trustedPeer`（§5.1a）持久化到 flash，断电不丢。按 D6 单设备绑定 **8 或 16** 台手机，容量可行（存储论证见 §12.6）。
4. **bindPassword 校验 + challenge-response**：`BIND` 指令在加密链路上提交密码派生 key；控制指令改 HMAC(nonce, bindKey)。
5. **固件版本协商**：FF02 加 `fwsec`，避免旧 App 连不上新固件。

> ⚠️ 注意：上述具体 API 名/宏需对照 CH582M 实际 SDK 头文件逐项核实（本文档不臆造寄存器级细节）。落地时第一步应是"把 Bonding demo 跑通 + 抓 Bond 完成事件"，再叠加权限位与信任列表。

### 12.3 首绑的信任锚与配对触发（D8 已确认：输绑定码即可）
**问题**：设备出厂后没有 owner。若"谁先连上并发 BIND 谁就是 owner"，陌生人抢先绑定可把真主锁门外。

**D8 决策（2026-07-10 19:23）**：
- **主流程 = 输绑定码即可**：App 连接后输入出厂默认 `bindPassword`（贴于设备/说明书），在加密链路上提交密码派生 key → 写信任列表。**不做强制 30s 窗口**（30s 太长），**不强制物理键**（否则"被锁在车外进不来"时无法绑定，违背可用性）。
- **物理键作可选增强（写入文档）**：可在高安全场景下要求"绑定时短按一次物理键"作为信任锚（防陌生人仅凭码抢绑）。但需注意：这会把"锁门外无法触键"的可用性矛盾重新引入，故**仅作可选硬化，非强制**。

**默认码加固建议**：首次成功绑定后，强制修改默认 `bindPassword`（或使其自动失效），类比改路由器默认管理员密码，杜绝"码泄露后被他人抢绑"。

### 12.4 多手机（D6）的细化设计
信任列表 N 条 owner，需明确"加/删/冲突"规则：

| 场景 | 机制 |
|------|------|
| **加第 1 个 owner** | 物理键 30s 窗口 + 默认码（§12.3）。 |
| **加第 2~N 个 owner** | 两种可选：(a) 仍走物理键窗口（最安全，任何新增都需物理接触）；(b) 已绑定 owner 经 App 远程授权新增（便利但有被已绑手机滥发风险）。**建议 (a)**，至少首版。 |
| **槽满（N 已达上限）** | 拒绝新增，提示"先解绑一台"；或物理键长按清全部（见下）。 |
| **丢手机/踢人** | owner App 发 `UNBIND(specificPeer)` 删指定条目；被删手机失去控制权。 |
| **唯一 owner 手机丢失** | 物理键长按 X 秒 → 清整个信任列表（factory reset 信任区），回到"待绑定"态，重新走 §12.3。 |
| **系统蓝牙"忽略此设备"** | 仅删手机侧 LTK；**设备侧信任列表仍残留** → 必须配合 App 内 `UNBIND` 或物理键清全，否则设备仍认这台（但手机已不加密连）。D7 倾向于"双侧清除都提供"。 |

### 12.5 分阶段实施建议（对应 D3 先 owner）
- **Phase 0（验证）**：CH582M 跑通 Bonding demo，抓 `GAP_BOND_COMPLETE_EVENT`，确认 LTK/SNV 落盘。
- **Phase 1（owner 绑定，本期）**：物理键 30s 窗口 + 默认码 → `BIND` 写信任列表；控制特征加 `GATT_PERMIT_ENCRYPT/AUTHEN_WRITE`；`UNLOCK` 等改 challenge-response；App 侧 `isBound`/`_shouldAutoReconnect` 启用 + `boundDevices` 持久化 + 绑定/解绑 UI。
- **Phase 2（多手机完善）**：信任列表 N 条、远程/物理新增、丢机清全。
- **Phase 3（guest 临时码，后期）**：`guestSlot` + `GUEST_ADD`/`GUEST_REVOKE` + App 随机时效码 + 二维码（D4/D5 此时决议）。
- **Phase 4（移植）**：向 NRF528XX 系列移植（API 更成熟，工作量相对可控）。

### 12.6 存储与寿命：绑定参数放哪？会损耗吗？要外置 EEPROM 吗？
**结论：绑定信息放 CH582M 内部 DataFlash（经 BLE 栈 SNV 管理）即可，无需外置 EEPROM。** 理由：
- **写入频率极低**：绑定/解绑是偶发操作（一台设备一辈子绑几次），不是高频日志。即使 8~16 条反复增删，累计擦写对 flash 寿命（典型 ~1 万次/扇区）也微不足道。
- **SNV 是扇区级磨损管理**：WCH BLE 栈 SNV 以 flash 扇区为单位，平时只做 record 追加写（program），仅在扇区满/整理（compaction）时才整扇区擦除，并非每次绑定都整擦。绑定低频 → 几乎不触发擦除。
- **容量充足**：单条 `trustedPeer`（含 LTK 等 Bonding 记录）约数十字节；8 条 < 1KB，16 条也在 KB 级，远小于 DataFlash 可用区。

**注意（须 SDK 实测核实，不臆造寄存器细节）**：
- SNV 区须在链接脚本 / Flash 划分中**预留最后若干扇区**，避免被固件覆盖（WCH 栈有 SNV 起始地址 / 扇区数配置项，需核对）。
- 扇区大小、endurance 具体数值、SNV API 名需对照 CH582M SDK 头与手册确认。
- **何时才需外置 EEPROM**：仅当后期加入**高频写入**数据（如里程/使用次数计数、实时遥测）时，才考虑外置 EEPROM 或做 flash 磨损均衡；绑定本身不需要。

### 12.7 固件模块化编程约定
- `peripheral_main.c` 保持为 **BLE 外设骨架 + 主循环**，不堆绑定逻辑。
- **新增独立文件**承载绑定/授权：`bonding.c` / `bind_mgr.c`（信任列表 SNV 读写、`BIND`/`UNBIND` 指令、challenge-response）、`guest_mgr.c`（后期 guestSlot）。
- 头文件 `bonding.h` 暴露 API 给 `peripheral_main.c` 调用，保持关注点分离，便于单测与向 NRF528XX 移植。

### 12.8 本期（owner）决策收尾
- **D6 容量**：单设备绑定 **8 或 16** 台手机（待最终定，建议先 8）。
- **D7 解绑**：**App 内解除 + 系统忽略，双侧清除都做**。
- **D8 配对触发**：**输绑定码即可（默认码）**；物理键作可选增强（非强制）。
- **D4 / D5**（guest 临时码）：本期不做，留后期阶段决议。

> 本文为讨论底稿。已确认部分（D1/D2/D3/D6/D7/D8）见 §10 与本节；D4/D5 待 guest 阶段决议。

---

## 13. 数据实际存储分层（2026-07-12 落地复盘）

> 本节记录**已落地代码**的真实存取位置，是对 §5 设计稿的纠偏与落地补充。
> 核心认知：**KeyGo 的数据分三层存，并不都在手机里**。排查「换手机/清缓存后 XX 没了」类问题，先回看本节。

### 13.1 总表：各类数据存哪、什么性质

| 数据 | 主要存哪 | 具体位置 | 性质 | 清手机缓存/换手机 | 设备重启 |
|------|----------|----------|------|-------------------|----------|
| **自定义设备名** | 📱 手机 | `ble_device_names`（按 SN 索引 `{SN:{name,lastSeen}}`） | per-phone 个性化 | 丢失 | 仍在（手机侧）；固件 `d2` 字段仅回显 |
| **RSSI 等参数**（unlock/lock/uc/lc/interval/dlock/kalmanR） | 📱 手机 | `ble_config_v1_{SN}` | per-phone 个性化 | 丢失 | 仍在手机；**固件用默认值**，重连再下发 |
| └ 其中 `cooldown_ms`（手动冷却） | 🔧 固件 | DataFlash `KEYGO_CFG_ADDR`(0x77000) | per-device | 不影响 | 仍在（固化硬件） |
| **已绑定·持钥** `bindKey` | 📱 手机 | `keygo_bindkey_{SN}`（hex，16 字节 = 32 hex） | per-phone | 丢失（需重验证/重绑） | 仍在手机 |
| **已绑定·设备信任** | 🔧 固件 | DataFlash `KEYGO_BOND_ADDR`(0x77100) 信任列表（bindKey+owner 槽） | per-device | 不影响 | 仍在（固化硬件） |
| BLE 系统配对 LTK | 🔧 固件+OS | SNV `0x77E00`（协议栈自管） | per-device | 不影响 | 仍在 |
| **本连接已验证** `sessionAuthed` | 🔥 都不存 | 实时会话态 | 每次连接现做 | — | 每次断连固件清零，重连须重做 |
| **序列号 SN**（真实身份） | 🔩 硬件固有 | 由芯片 MAC 派生（FF04 读） | 设备内在 | 不影响 | 不变 |
| `deviceId`（MAC 地址） | 📱 手机 | `ble_device_id`（上次 MAC） | 临时直连提示 | 丢失 | **每次连接都变**（随机私有地址） |
| 智能重连模式 | 📱 手机 | `ble_auto_reconnect_mode`（全局） | per-phone | 丢失 | 仍在 |
| 固件版本号 | 🔥 不存 | FF02 status `v` 字段实时读 | 会话 | — | — |

### 13.2 三个关键纠偏（§5 设计稿到落地的偏离）

**① RSSI 阈值「看起来是设备参数，其实主要是手机个性化」。**
App 里 `unlockThreshold`/`lockThreshold` 等只存在手机 `ble_config_v1_{SN}`。每次连接，App 经 `_syncConfigToDevice()` 把它们**下发到固件 RAM 临时生效**（`keygo_core.c` 注释明确：「unlock/lock/uc/lc 仅存 RAM，由手机每次连接后下发」）。**固件不持久化它们**——设备重启后固件用代码默认值，等你手机重连再覆盖。真正写进固件 DataFlash 的只有 `cooldown_ms`（注释称「设备级参数，所有手机共用」）。
→ 所以「我把阈值调好，换台手机连这锁」→ 那台手机会用它的默认值，除非它也调过。

**② `deviceId`(MAC) 手机存了，但每次连接都变，不能当身份。**
Android/iOS BLE 用随机私有地址，每次重连 MAC 都不同。手机存它（`ble_device_id`）只作「上次连的那个，优先直连加速」的提示。真正稳定的身份是 **SN（序列号）**——由芯片 MAC 派生、烧在硬件里、FF04 读取，不随连接变。所以 `bindKey`、设备名、配置全用 `_{SN}` 作索引键，而不是用 MAC。

**③ 「已绑定」是两端各存一半，缺一不可（与 §5.1 设计一致，但落地为「基于共享密钥」而非「基于 MAC」）。**
- 📱 手机存 `bindKey`（= `SHA256(绑定码‖SN)[:16]`）→ 证明「我这部手机有钥匙」。
- 🔧 固件存信任列表（`bindKey`+owner 槽）→ 证明「这把锁认这个钥匙」。
- 🔥 `sessionAuthed` 是「本条连接把钥匙亮给固件看了」的实时会话，断连即清、重连必重做（见 13.3）。

> 落地变更（2026-07-10）：§5.1(a) 原设计 `trustedPeer` 以 `peerAddr`(MAC) 为身份与查找键。因 BLE 随机私有地址每次变，已改为**「基于共享密钥」**——`BIND:<code>` 用默认绑定码作恢复凭证（可首绑/覆盖重绑），`AUTH` 用存储 `bindKey` 校验 `HMAC(nonce,bindKey)`，**不按 MAC 查找**。固件落盘仍写 `peerAddr` 仅作非空槽标记（`Bonding_Load` 靠全 `0xFF` 判空）。

### 13.3 为什么「绑定过、重启 APP 仍显示待验证」是设计必然（非 bug）

`sessionAuthed`（本连接已验证）是实时会话态、**哪都不持久化**。固件 `bonding.c:Bonding_ConnTerminated()` 在**每次断连清零**（`s_sessionAuthed=0`，nonce 一次性）。所以：

- **「已绑定」=「我手机里有这把钥匙」**（`bindKey` 持久，重启即 true → 立刻显示「已绑定」）。
- **「待验证」=「这条连接还没把钥匙亮给固件看」**（实时会话，每次重连都要做 NONCE→AUTH 挑战应答）。

固件对 UNLOCK/LOCK/配置指令要求「本连接已 AUTH」，故 `sessionAuthed` **不可跳过**（跳过=放弃绑定安全意义）。App 侧 `_maybeAutoAuth()` 在重连后自动、无感地重做该证明（约 1s 翻「已验证」），UI 文案区分「自动验证中…/验证失败请重绑/本连接已验证」，避免「待验证」像报错。

### 13.4 换机 / 恢复出厂的行为矩阵

| 场景 | 现象 | 处理 |
|------|------|------|
| **换手机** | 新手机无 `keygo_bindkey_{SN}` → 显示未绑定 | 用**原绑定码**走 `BIND` 重建手机侧 key（固件信任列表还在，不必清绑） |
| **清 App 缓存** | `ble_config_v1_{SN}`/`ble_device_names`/`keygo_bindkey_{SN}` 全丢 → 设备名、阈值、绑定态复位 | 重新绑 + 重设阈值；固件侧不受影响 |
| **设备恢复出厂**（`UNBIND:ALL`） | 固件信任列表清 → 手机有 `bindKey` 也验证不过 | 手机侧 `UNBIND:ALL` 清本地 key 后重新 `BIND` |
| **系统蓝牙忽略此设备** | 仅删手机侧 LTK；**固件信任列表仍残留** | 须配合 App 内 `UNBIND`（双侧清除，对应 D7） |

---

## 14. 深度诊断整改引导（2026-07-12，commit e3f41df 后补充）

> 目的：**只记录分析结论与整改方案，不改代码**，供后续讨论/实现作引导。
> 背景：本次 `e3f41df` 修复了「DataFlash 地址基准误用物理地址→绑定/配置掉电即丢」的真因，并已真机验证（重启绑定恢复、`AUTH:OK`）。提交后做全量代码审查，发现若干**潜在**隐患（非活跃 bug），以及「首绑手机能否管理已绑手机」的产品讨论。汇总如下。

### 14.0 已落地加固（含于 e3f41df，行为不变）
- **AUTH 常量时间比较**：`bonding.c` 新增自包含 `ct_eq()`，HMAC 校验由 `tmos_memcmp(...)==0` 改为 `!ct_eq()`。安全关键路径不再押注「SDK 不改动 `tmos_memcmp` 返回值语义」，消除「未来 SDK 改语义致鉴权被绕过/误拒」隐患（`crypto_sha256.c` 早已因同理由改用本地比较，现两端一致）。
- **编译期区域护栏**：`bonding.h` 加 `#error`——CFG/BOND/BINDCODE 互不重叠、BINDCODE 右界 < SNV(0x07E00)。重点拦死「信任列表扩到 16 条 → `BOND_PAGES=2` 静默擦掉绑定码页 0x7200」的雷。

### 14.1 待整改清单（按严重度）
| # | 项 | 严重度 | 现状 | 是否破坏兼容 |
|---|------|--------|------|--------------|
| 14.3.1 | `!g_cryptoOk` 降级分支删除（fail-closed） | 高-潜在后门 | crypto 自测失败即「已绑定放行」，现 crypto 已修是死代码 | 否（仅失败路径行为变安全） |
| 14.3.2 | 单 owner 收敛（死代码拧清） | 中-设计气味 | BIND 写死 slot0，多 owner 函数休眠；`Bonding_Load` 可能虚高 count | 否 |
| 14.3.3 | 首绑 `SaveBindCode()` 返回值补 WARNING | 低-静默 | 自定义码页瞬时写失败无提示 | 否（纯诊断） |
| 14.3.4 | stale 注释纠偏 | 低-文档 | 注释仍写「已绑可用默认码 takeover」，实际已改「须匹配当前码」 | 否 |
| 14.3.5 | **方案 A：真多手机 + 管理员** | 中-产品 | 共享密钥无法表达「首绑管其他」 | **是**（BIND/AUTH 协议带 phoneId，需 fwsec 协商） |
| 14.3.6 | **备选：任意手机可清全部** | 低-产品 | `UNBIND:ALL` 已现成 | 否（仅加 App UI） |

### 14.2 整改详情

#### 14.3.1 降级分支删除（fail-closed）
- **现状**：`Bonding_HandleAuthResp` 存在 `if (!g_cryptoOk) { if (Bonding_Count()>0) s_sessionAuthed=1; ... }` 分支——crypto 自测失败时「已绑定即放行」。当前 `g_cryptoOk=1`（`AUTH:OK` 实证）是死代码，但作为**潜在后门**仍留着：一旦某天自测偶发失败，绑定设备会被无条件放行。
- **整改**：删除该分支，改为 fail-closed：
  ```c
  if (!g_cryptoOk) {
      KeyGo_SendRawNotify("AUTH:FAIL:CRYPTO");
      PRINT("[AUTH] crypto self-test failed, refuse all auth (fail-closed)\n");
      return 4;
  }
  ```
  即 crypto 不可信时**一律拒绝鉴权**，绝不降级放行。
- **影响**：更安全的默认；仅在 crypto 真坏时所有手机连不上（此时应修 crypto，而非放行）。风险极低（当前 `g_cryptoOk=1` 实证）。

#### 14.3.2 单 owner 收敛
- **现状**：`Bonding_HandleBindCmd` 写死 `s_bondTbl[0]`、`s_bondCount=1`（`bonding.c:432-435`）；但 `Bonding_Find/Count/AddOwner/RemoveOwner` 仍按 8 条表逻辑跑。`Bonding_Load` 把任意 `peerAddr` 非全 `0xFF` 的槽数成 owner → 若 Flash 有历史脏数据，`count` 虚高（影响 UI `bn` 与 `DENY` 门控，不影响 AUTH）。
- **整改（两种取向）**：
  - (a) **保持真单 owner**：BIND 只允许 `s_bondCount==0` 或覆盖 slot0；`Bonding_Load` 改为「只认 slot0 非空」，count 恒为 0 或 1；`AddOwner/RemoveOwner` 等明确标注「未使用」或删除。
  - (b) **顺带实现真多 owner**（见 14.3.5 方案 A）——此时这些函数才是活的，无需收敛。
- **建议**：若不做 14.3.5，先走 (a) 把语义拧清，避免脏数据误导 UI/门控。

#### 14.3.3 首绑 WARNING
- **现状**：`Bonding_HandleBindCmd` 调 `Bonding_SaveBindCode()` 后未检查返回值（`bonding.c:439` 周边仅对 `Bonding_Save()` 有 WARN，`SaveBindCode` 的返回值被忽略）。
- **整改**：若 `SaveBindCode()` 返回非 0，补 `PRINT("[BIND] WARNING: SaveBindCode failed; custom code NOT persisted, reboot will fall back to default")`；并在回包加 `BIND:WARN:CODE_NV`，让 App 弹「绑定码未持久化，设备重启后需重绑」。
- **影响**：纯诊断增强，无行为破坏；低概率（持久化已修好）但能避免「重启后自定义码回退默认、信任 key 却按自定义派生 → 重绑 `FAIL:ALREADY_BOUND`」的困惑。

#### 14.3.4 注释纠偏
- `bonding.h/c` 顶部仍写「已绑可用默认码 takeover / 覆盖重绑」。实际代码已改为：**默认码仅在 `Bonding_Count()==0`（首绑）时作恢复凭证；已绑后用自定义码覆盖重绑须匹配当前有效码 `g_curBindCode`**（忘码者走 `AUTH`→`SETCODE` 恢复，不砖机）。
- 整改：统一改为准确表述，删除 stale 的「takeover」措辞，避免后续维护者误以为「已绑设备任何人拿默认码可夺回」（这是更危险的模型）。

#### 14.3.5 方案 A：真多手机 + 管理员（首绑手机可删其他）
- **动机**：用户诉求「首绑手机连上设备后，可删除已绑的其他手机」，且「管理入口只显示在首绑手机上」。当前**共享密钥模型无法表达**——所有手机派生同一 key、无身份、无 admin，固件分不清谁是谁。
- **核心改造：每手机独立身份 + 管理员标志**（死代码 `Bonding_AddOwner/RemoveOwner` 可直接复用为活逻辑）：
  1. **每手机生成 `phoneId`**：App 首次运行生成随机 UUID，**持久化于 `keygo_bindkey_{SN}` 同级存储**（不要用 MAC——BLE 随机私有地址每次变，且换手机应视为新身份）。
  2. **KDF 改每机唯一**：`bindKey[16] = SHA256(bindCode || serial || phoneId)[0:16]`。
  3. **BIND 协议升级**：`BIND:<code>:<phoneIdHex>`
     - 首绑（`Bonding_Count()==0`）：记此 `phoneId` 为 `admin=1`，写条目 `{phoneId, key, admin}`。
     - 已绑后再 BIND：须**先 AUTH**（证明已是绑定手机），才允许追加 `admin=0` 的新条目。
  4. **AUTH 协议升级**：`AUTH:<phoneIdHex>:<hmacHex>`，固件按 `phoneId` 找对应条目、用该条目 key 验 `HMAC(nonce,key)`。
  5. **新增 `RMOWNER:<phoneIdHex>`**：仅当**本连接鉴权身份 `admin==1`** 才执行删除（固件强制，App UI 绕不过）。
  6. **新增 `WHOAMI` / status 回 `admin:1`**：App 据此决定是否显示「设备管理」面板（第一层门控）。
  7. **恢复安全网保留**：用默认码 `123456` 走首绑路径 = 夺回 admin 并清空其他人（防 admin 手机丢失/卸载后无法管理）。
- **容量论证**：8 条目 ×（phoneId 16B + key 16B + admin 标志 + 对齐）≈ 224B，恰 1 页（`BOND_PAGES=1`），与「保持 8 条」一致，**不触发 14.0 护栏**。
- **兼容性代价**：BIND/AUTH 协议带 `phoneId` 后，**老 App 不兼容** → 必须启用 §5.1(e) 的 `fwsec` 版本协商（旧 App 走旧裸路径 / 新 App 走新身份路径）。
- **工作量**：固件 `bonding.c`（BIND/AUTH/RMOWNER/WHOAMI）+ App `stores/ble.js`/`utils/crypto.js`/`components/BindModal.vue`，中等。

#### 14.3.6 备选：任意手机可清全部（UNBIND:ALL 现成）
- **动机**：若用户其实只需「卖车/清设备时一键清空」，无需区分 admin。
- **现状**：`UNBIND:ALL` 已能清全部（`Bonding_EraseAll`），且**任何已鉴权手机都能发**。
- **整改（若选此）**：仅补 App UI——已绑定且已鉴权时显示「解除绑定（清空所有手机）」按钮，二次确认后发 `UNBIND:ALL`。
- **取舍**：实现成本极低（几乎零固件改动），但**无「选择性删某台」能力**，且任何绑定手机都能清（含借出的手机误清）。与 14.3.5 二选一。

### 14.3 整改优先级建议
- **P0（安全）**：14.3.1 降级分支 fail-closed。
- **P1（健壮）**：14.3.3 首绑 WARNING、14.3.4 注释纠偏。
- **P2（产品，需拍板）**：14.3.5 方案 A **或** 14.3.6 备选。
- **P3（整洁）**：14.3.2 单 owner 收敛（若不做方案 A 则必做）。

### 14.4 待用户拍板
- **Q1**：多手机管理走 **方案 A（真多手机+管理员）** 还是 **备选（任意手机可清全部）**？
- **Q2**：若走方案 A，`phoneId` 用 **App 首次运行随机 UUID**（非 MAC）是否认可？（推荐，理由见 14.3.5①）
