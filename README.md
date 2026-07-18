# KeyGo · 钥启程 （BLE 智能车钥匙）

> English version: [README_EN.md](README_EN.md)

> 一个基于 BLE 的车钥匙替代方案：用手机 App 连接 BLE MCU/SOC 固件模块，通过 RSSI 距离判断实现「走近解锁、走远锁车」的舒适进入体验；并支持与设备做**真实绑定鉴权**（绑定码 + HMAC 挑战应答），不再是裸连即开。

**两大部分**：
- **固件**：运行在 BLE MCU/SOC 上，接管原车钥匙的解锁 / 锁车 / 第三键（后备箱或骑行）三个物理按钮
  - 早期用 **ESP32C3**（Arduino）完成原型验证
  - 当前主力平台 **WCH CH582M**（RISC-V BLE SoC, MounRiver Studio）
  - 后续计划移植到 **nRF528xx** 等其他 BLE MCU/SOC
- **App**：**uni-app（Vue 3 + Pinia）** Android 应用，负责 BLE 连接、RSSI 监测、智能重连、绑定鉴权、双模式切换

---

## 当前主线

- **主分支（mainline）**：`main` —— 稳定主线，汇总 `codex`（安全加固 / Codex 接手）与 `workbuddy`（本期优化 / UI 打磨 / 双模式）的工作。
- **开发分支**：
  - `workbuddy`（当前所在）：基于 `main`，承载本期「优化逻辑 + 美化 UI」增量（手动模式重启自动验证绑定 / 禁用断连自动锁 UI / 绑定页版本文案 / 主按钮禁用态美化 / 双模式切换入口迁移到控制页）。
  - `codex`：基于 `main`，承载 v3.32.x 安全加固（先配对后 BIND、HMAC 挑战应答恢复）与 Codex 接手探索。
- 固件 `KEYGO_FW_VERSION`：`3.36.1`（与 App 版本号一致，无需重烧）。
- App 版本标注：`v3.36.1`（与固件一致；见 `stores/ble.js` 的 `APP_VERSION` 常量）。
- 协议能力：`fwsec=2`（授权体系 v1：per-phone 身份 + RSSI 阈值跟随）。
- 本版状态：**【v3.36 授权体系 v1 落地：per-phone 密钥 + RSSI 阈值跟随 + 无App模式(设备级舒适进入)】**
- 下阶段准备优化：**Phase 4: GATT 加密门控（重做）；UNBIND 联动删 SMP 配对；多管理员 / 临时授权**

---

## 实际功能

| 功能 | 怎么做的 | 限制 / 状态 |
|------|----------|------|
| **走近自动解锁** | App 持续连接设备，根据 RSSI 信号强度判断距离，超过阈值 + 连续确认次数后自动发解锁命令 | 仅当 App 与设备保持 BLE 连接时生效 |
| **离开自动锁车** | RSSI 低于锁车阈值 + 连续确认次数 → 自动发锁车命令；BLE 意外断连也触发锁车 | 断连时可能已离开很远，属兜底保护 |
| **手动控制** | App 上点击按钮，通过 BLE GATT Write 发送 `UNLOCK` / `LOCK` / 第三键 | 需要设备在蓝牙范围内 |
| **设备绑定（真实鉴权）** | 绑定码 → `gk = SHA256(绑定码‖序列号)` → `phoneKey = HMAC-SHA256(gk, phoneId)[0:16]`；每台手机因 `phoneId` 不同而持有**独立密钥**（per-phone，v3.36）；后续每次连接设备发 `NONCE` → App 回 `AUTH:<phoneId>:<HMAC-SHA256(nonce, phoneKey)>` | 已落地（v3.36.0 / fwsec=2）；绑定码默认 `123456`，**建议首绑后改** |
| **per-phone RSSI 阈值跟随** | 每台手机在 AUTH 后把「自己的」解锁/锁车阈值写入对应 owner 条目；设备状态机按当前已鉴权 owner 选阈值 | 已落地（v3.36.0）；不同手机发射功率/天线不同，全局阈值不通用的问题根治 |
| **无App模式（设备级舒适进入）** | 固件 HID 被动锚点（v3.34）：手机 OS 把 KeyGo 识别为已配对 HID/手表，**App 未运行**时 OS 也会加密重连，设备在「OS 已加密 + RSSI 达标」时自行解锁 | 已落地（v3.34.0）；绕过 AUTH，撤销需注意（见下） |
| **参数可调** | RSSI 解锁/锁车阈值、确认次数、采样间隔、Kalman 滤波参数均可在 App 上修改并下发到设备 | 参数调不好可能导致误触发或延迟 |
| **电池监测** | 设备通过 BLE Notify 上报电压/电量，App 显示并低于 20% 提醒 | 仅支持 18650 锂电池（电压→电量映射基于放电曲线）；当前开发板走内部 VBAT 通道，LDO@3.3V 下读数恒定，画板后改外置分压+MOS 才准 |
| **芯片温度** | 设备上报芯片温度（FF02 `t` 字段，CH582M TSENSE 5s 节流采样），连接页显示，断连自动隐藏 | 已落地（CH582M 内部传感器；可关开关见 `docs/03-复盘与问题分析/3-安全模型实测/温度电压采集与功耗分析_未来方向_BLE6.md`） |
| **Android 前台服务** | 原生 Android Foreground Service + 常驻通知 + 电池优化豁免引导，尽可能不被系统杀死 | 荣耀/小米等深度管控机型锁屏 2h+ 仍可能被杀 |
| **设备双模式（汽车/电瓶车）** | 模式存设备 DataFlash（非物理拨档）；前两键相同（解锁/锁车），第三键差异：car=后备箱、`ebike`=骑行（双脉冲） | Phase 2 代码已落地，待重烧联调 |
| **未授权连接 30s 超时** | 连上但不绑定/不鉴权的连接，30s 后设备主动强断，防单连接槽被占（DoS 防护） | 已落地（commit 31f3f59） |
| **RSSI 自动解锁安全闸门** | 解锁前要求「链路已加密（配对）」或「会话已鉴权（AUTH）」其一，防陌生人用 RSSI 蹭开 | 已落地（2026-07-12） |

---

## 设备双模式（Phase 2：汽车 / 电瓶车）

一机两用，差异仅第三键：

| 模式 | 前两键 | 第三键 | 固件行为 |
|------|--------|--------|----------|
| **汽车 `car`（默认）** | 解锁 / 锁车 | 🚗 后备箱（`TRUNK`） | 单脉冲触发后备箱 |
| **电瓶车 `ebike`** | 解锁 / 锁车 | 🛵 骑行（`RIDE`） | 快速双击脉冲（2×100ms@150ms），LED 同步亮灭模拟「按了两下开关」 |

- **模式存储**：DataFlash 新增 `MODE_ADDR`（偏移 `0x7300` / 物理 `0x77300`），App 首绑或控制页底部切换（非物理拨档）。
- **切换入口**：控制页底部「设备模式」卡片（`control.vue`），属控制范畴。
- **状态同步**：FF02 状态 JSON 新增 `"m":0|1` 字段；控制页顶部大卡图标随模式切换（🚗/🛵）；连接页第三快捷键也模式驱动。
- **接口**：配置命令 `MODE:car`/`MODE:ebike`（走 FF03，受加密门控 + 绑定保护）；控制命令 `RIDE`（电瓶车双脉冲 / 汽车回 `DENY:NOT_SUPPORTED`）。
- `[待完成]` 管理员锁定模式列（防误切）；多管理员。

---

## 智能重连（三种模式）

这是本项目最核心的部分。断开连接后 App 如何重新找到设备？不同用户需求完全不同，所以提供三种模式：

| | 极速模式 | 舒适模式（默认） | 手动模式（原「省电模式」） |
|:--|:--|:--|:--|
| **怎么工作的** | 蓝牙断开时记录停车 GPS 位置 → 建围栏 → 进入围栏时触发 BLE 扫描；同时加速度计检测运动 → 条件触发扫描 | 断开后注册 `ACTION_SCREEN_ON` 广播 → 用户亮屏/解锁手机时触发 8s BLE 扫描并连接 | 完全手动：不自动连接、也不自动锁车。连接后向固件下发 `autolock=0` 关闭 RSSI 自动锁，仅响应手动 UNLOCK/LOCK/第三键 |
| **什么时候能连上** | 走到车附近（进入 GPS 围栏）时自动连，理想情况到车边就已连好 | 亮屏后 2-8 秒内连上 | 用户手动点击连接 / 开锁时 |
| **需要什么权限** | 后台定位 + 加速度计 | 无额外权限 | 无额外权限 |
| **后台干了什么** | GPS 围栏（Google Geofence API）+ AlarmManager 心跳兜底（无 GMS 设备降级） | 无任何后台任务（纯事件驱动，亮屏才触发） | 无（不启动任何保活 / 后台扫描，切换时停前台服务） |
| **适合谁** | 每日通勤、愿意授权定位换取无感体验 | 大多数用户 | 露营等贴身场景：RSSI 抖动会导致反复自动连 / 自动锁 |
| **已知问题** | 无 GMS 设备（华为/部分荣耀）围栏不可用，自动降级到舒适模式 | 亮屏后不靠近车就不会连上（符合预期，因为本来就没后台扫描） | 必须每次手动操作，无任何自动重连 |

### 舒适模式的设计动机

旧方案在断开后每 2 分钟定时扫描一次。在荣耀 MagicOS 等深度管控系统上，锁屏 2 小时后系统会将持续有后台行为的 App 标记为「高耗电应用」并杀死 —— 定时扫描反而加速了被杀。

**现在舒适模式不做任何后台轮询**，等待系统自然广播 `ACTION_SCREEN_ON` 才触发扫描。系统找不到标记你的理由，存活概率大幅提升。

```
断开连接 → registerScreenOnReceiver()
    ↓
用户亮屏/解锁 → ACTION_SCREEN_ON / ACTION_USER_PRESENT
    ↓
_onScreenOn() → 检查：已连接？蓝牙关？30s内刚扫过？
    ↓
startScan(8s, service UUID 过滤) → 发现目标设备
    ↓
connectDevice() → 成功后停扫描
    ↓
8s 内未连上 → 30s 后重试，最多 3 次
```

### 打开 App 自动连已知设备里信号最强者（方案B）

默认行为：**打开 App（onShow）会先直连缓存设备（最快，无需扫描）；直连失败或缓存过期时，自动扫描并连接「已知设备集合」里 RSSI 最强的那台。**

- 「已知设备集合」当前 = 缓存的 `ble_device_id`（过渡期）。**非已知设备绝不会自动连接**，避免误连邻居家/陌生人的车钥匙（方案B 安全边界）。
- 多台已知设备同时在线时，按信号强度自动选最强的那台。
- 首次使用（无 `ble_device_id` 缓存）不自动连任何设备，需手动在扫描列表里挑一次；之后该设备进入已知集合。
- 预留「设备绑定」接入点：后续把已知集合换成受信任序列号列表即可，内部逻辑不变（见 `stores/ble.js` 中 `autoConnectBest` 的 `knownSet` / `TODO ①`）。

> 实现要点：`utils/ble.js` 的 `startScan` **不再传 `services` 硬件过滤**（Android 12+ 上带过滤的发现常返回空，导致扫不到设备），设备识别改由扫描回调内的「名字前缀 / 广播 UUID」二次过滤完成，发现更可靠。

### 断连状态机（reconnectMode）

所有自动重连/不重连的决策都看这个状态，避免「刚断连又秒重连」「用户主动断开后又自动连上」等竞态：

| 状态 | 含义 | 何时进入 / 谁负责 |
|------|------|------------------|
| `idle` | 空闲，允许自动重连 | 连接成功、或重连彻底放弃后 |
| `active` | 正在重连循环（指数退避） | 异常断连 `_handleDisconnect` → `_startReconnect` |
| `paused` | 临时挂起（退避等待 / 蓝牙关闭） | 退避等待期、蓝牙关闭时 |
| `dormant` | **用户主动断开 / 未授权连接被踢**，禁止一切自动重连 | `disconnect()` / 收到 `BIND:TIMEOUT` |

统一闸门 `_shouldAutoReconnect()`：`connected` / `dormant` / `btState=off` 任一成立 → 返回 `false`，`tryAutoConnect`、`autoConnectBest`、`_onScreenOn` 均先过此闸门。

> ⚠️ **已知限制（待优化）**：`dormant` 是内存态，App 进程被杀后随 `reconnectMode` 重置回 `idle`；而 `ble_device_id` 缓存持久化在本地存储。因此**当前手动断开仅在「同一 App 会话内」有效**——重新打开 App 会按已知设备缓存再次自动连接。若希望「手动断开 = 跨重启都不自动连」，需把「用户主动断开」意图持久化（新增 `ble_manual_disconnect` 标记），见下方「断连逻辑修复」讨论。`[待完成 / Phase 3]`

---

## 无App模式（设备级舒适进入）与三模式的关系 ★ 重要

这是最容易混淆的一组概念，务必分清两层：

- **App 三模式（舒适 / 手动 / 极速）**：描述的是 **App 运行时** 如何维持 / 恢复与设备的连接（即"重连策略"），不控制"设备级自动解锁"。
- **无App模式（v3.34，固件 HID 被动锚点）**：让手机 OS 把 KeyGo 识别为已配对 HID/手表，**即使 App 未运行**，OS 也会在走近时自动建立加密重连；固件在「OS 已加密重连 + RSSI 达标」时**自行解锁**（舒适进入），全程不需要 App。

**二者互补，边界如下：**
- 启用无App模式 → 走近即由**设备**自动解锁，**与 App 是否运行无关**。
- App 三模式只在 App 打开 / 保活时影响"App 这侧的连接与自动重连"。
- 极速模式的 GPS / 加速度计在进入无App模式后是**冗余**的（设备已自行做舒适进入）；但极速模式在"需要 App 主动重连 / 控车"的场景仍有价值。
- 手动模式（关掉一切自动）与无App模式**可以叠加**：手动模式管"App 不自动连"，无App模式管"设备自己解锁"——若你只想纯手动、连设备级自动解锁也不要，应**在系统蓝牙里忽略此设备**关闭无App模式。

> ⚠️ **撤销注意（关键）**：无App模式绕过了 AUTH（设备只认 OS 加密 + RSSI）。因此**撤销某台手机必须同时做两件事**：
> ① App 内 `UNBIND`（删其 `phoneKey`，控车门关闭）；
> ② 在该手机**系统蓝牙里「忽略此设备」**（删 OS SMP 配对）。
> 只做 ① 不够——它仍可能被 OS 自动重连并触发无App自动解锁。`[规划中：UNBIND 联动自动删 SMP 配对]`（见 Phase 4）

---

## 设备绑定与安全模型

### 信任模型（v3.36 / fwsec=2，per-phone）

- 信任列表容量 8，存 DataFlash（偏移 `KEYGO_BOND_ADDR = 0x7100` 相对 / 物理 `0x77100`）；LTK 由协议栈经 SNV（偏移 `0x07E00`，已扩容至 8 块）自动持久化，支持 8 owner 互不互踢。
- **密钥派生链**：
  - `gk[16] = SHA256(utf8(绑定码) ‖ utf8(序列号))[0:16]`（组密钥，**不落盘**，随时可重算）
  - `phoneKey[16] = HMAC-SHA256(gk, phoneId)[0:16]`（每手机独立密钥，`phoneId` = App 生成的 8 字节随机，持久化于 `keygo_phone_id`）
  - 旧 App（fwsec<2）兼容：不发 `phoneId` → 退化为 `phoneKey = gk`
- **挑战应答**：设备发 `NONCE(16B)` → 手机回 `AUTH:<phoneIdHex16>:<HMAC-SHA256(nonce, phoneKey) 十六进制>`；设备按 `phoneId` 定位 owner 并校验其 `phoneKey`。`NONCE` 一次性。
- **per-phone RSSI 阈值**：每台手机 AUTH 后下发 `RSSISET:<unlock>:<lock>`，写入对应 owner 条目；状态机按当前已鉴权 owner 选阈值（见 FF02 `ou/ol`）。
- 手动控车门控：设备端 `Bonding_Count()==0` → `DENY:NOT_BOUND`；否则 `!会话已鉴权` → `DENY:AUTH_REQ` 并下发 `NONCE`。
- 默认绑定码 `123456`（占位，**建议首绑后改**）。信任基于共享绑定码（非 MAC，因随机私有地址）。
- **信任表格式魔数** `'KGNT'`：新固件加载到旧格式会自动清空，各手机重新绑定一次（一次性代价）。

### 安全加固时间线
- **RSSI 自动解锁缺口（2026-07-12 落地）**：`KeyGo_ProcessStateMachine()` 闸门改为「链路已加密（配对）」或「会话已鉴权（AUTH）」其一成立才允许 RSSI 解锁，杜绝陌生人用 RSSI 蹭开。
- **DoS 防护：未授权连接 30s 超时（2026-07-12，commit 31f3f59）**：连上不绑定占槽 → 超时先发 `BIND:TIMEOUT:30S` 通知，再延迟强断，App 收到后停重连。
- **v3.32.0（2026-07-13，commit 77c6806）**：① 先配对再 `BIND`（Just Works 配对 → 链路加密 → 发 `BIND:code`，堵明文嗅探）；② BIND 成功后补 `NONCE → AUTH(HMAC)` 兜底鉴权；③ 改码前置 `_authWithKey` 校验。
- **v3.32.1（GATT 加密门控，已回退）**：曾把 FF01/FF02-CCCD/FF03 权限升为 `GATT_PERMIT_AUTHEN_WRITE/READ`，未配对连接读不了。后因配对后补订 FF02 的时序问题在 `codex` 分支 `git revert`，**待 Phase 4 重做 `[待完成]`**。
- **v3.34.0（2026-07-16，无App模式）**：主固件 HID 被动锚点，OS 加密重连 + RSSI 自动解锁，无需 App 运行。
- **v3.36.0（2026-07-17，授权体系 v1）**：per-phone 身份（`phoneKey = HMAC(gk, phoneId)`）+ per-phone RSSI 阈值跟随（`RSSISET`）；`fwsec=2`；AUTH 格式升级为 `AUTH:<phoneId>:<hmac>`；SNV 扩容至 8 owner 互不互踢（独立提交）。

### 关键安全认知（实测纠偏）
- 普通手机蓝牙设置**搜不到** KeyGo（需 nRF Connect 等工具主动连），故「路人随手开」不成立。
- 真实残余风险（窄化）：已配对（bonded）过的攻击者手机，OS 自动重连 → `LINK_ENCRYPTED` → 满足 RSSI 闸门 → 走近解锁。配对与绑定码相互独立，30s 超时只防占槽，挡不住已配对者。
- **App 被杀后 RSSI 解锁实测不生效**：解锁需活跃连接，连接靠前台服务维持；App 死 → 无连接 → 不解锁。故该漏洞门槛 = 「运行 KeyGo App + 曾用工具配对的蓄意者」，非路人。
- 控制命令 `UNLOCK/LOCK` 的 **C1 签名（per-command HMAC + 会话盐 + 自增序号）防重放一直开着**，非「HMAC 被注释」。
- **SMP 配对码（g_sysPasscode）保持全局**：per-phone SMP 配对码收益边际（AUTH 已 per-phone 把控车门），且 SMP 在 AUTH 前发生、固件尚不知对端 `phoneId`，时序上不划算；撤销控制靠 `UNBIND` + 删 SMP 配对（已落地：自定义基座下 App 解绑自动删 OS 配对）。

### `[待完成]` 安全增强
- **UNBIND 联动删 SMP 配对（已落地，自定义基座）**（收口无App模式撤销缺口）：App 解绑时联动原生 `removeBond` 删除手机端系统蓝牙配对，配合固件侧 `Bonding_ClearSnvBonds` 清设备 SNV LTK，两端合力使被撤销手机即便无App模式也无法自动解锁。标准基座无原生插件能力，仍需手动忽略设备。
- **AUTH 失败限流**、**绑定码强制改**、**多管理员 / 临时授权**。
- **Phase 4：GATT 加密门控重做**（修复 v3.32.1 的订阅时序问题）。
- **认证配对 Passkey = 绑定码**（可选收口「已配对者 RSSI 解锁」缺口）：需先验证 CH582 SMP 支持「无头设备 + 固定 passcode + mitm=1 不回退 Just Works」。

---

## BLE 通信协议

设备名格式：`KeyGo-{MAC后6位}`，例如 `KeyGo-A1B2C3`

| UUID | 类型 | 方向 | 用途 | 数据格式 |
|------|------|------|------|----------|
| `0000FF00-...` | Service | — | KeyGo 主服务 | — |
| `0000FF01-...` | Write | App→设备 | 配置下发 | `unlock=-45 lock=-65 uc=3 lc=5 interval=500 kf_r=15.0 autolock=1 mode=car`（`autolock=0` 关闭固件 RSSI 自动锁；`mode=car|ebike` 切换双模式） |
| `0000FF02-...` | Read, Notify | 设备→App | 状态上报 | JSON：`{"c":1,"st":"LOCKED","r":-52,"f":-52,"b":85,"t":32.5,"d2":"","cd":8000,"kr":15,"al":1,"bn":1,"v":"3.36.1","m":0,"uc":3,"lc":5,"ucnt":1,"lcnt":0,"th":1,"ou":-45,"ol":-65,"fwsec":2}` |
| `0000FF03-...` | Write | App→设备 | 控制 / 绑定命令 | `UNLOCK` / `LOCK` / `TRUNK` / `RIDE` / `BIND:code\0phoneIdHex` / `AUTH:phoneIdHex:hmac` / `SETCODE:new` / `UNBIND` / `RSSISET:unlock:lock` / `STATUS` / `MODE:car|ebike` |
| `0000FF04-...` | Read | 设备→App | 设备序列号（永久唯一） | ASCII 字符串，配对绑定用 |

- 广播间隔：50ms，任意 ≥1s 扫描窗口能捕获
- FF01 / FF02-CCCD / FF03 当前权限：`GATT_PERMIT_READ` + `GATT_PERMIT_WRITE`（**未加密门控**，见 Phase 4 `[待完成]`）；FF04 保留可读。

### FF02 状态字段说明（设备→App，周期上报）

> ⚠️ 这是**状态上报**窗口，不参与解锁/锁车决策（决策在固件状态机）。

| 键 | 含义 | 示例值 |
|----|------|--------|
| `c` | 连接标志（恒为 1） | `1` |
| `st` | 当前锁状态 | `LOCKED` / `UNLOCKED` / `ACTION` |
| `r` | 实时 RSSI (dBm) | `-52` |
| `f` | Kalman 滤波后 RSSI | `-52` |
| `d2` | 设备自定义名称 | `""` |
| `cd` | 手动命令冷却时间 (ms) | `8000` |
| `kr` | Kalman R 参数（滤波强度） | `15` |
| `al` | 自动锁使能状态 | `1`=开启（舒适/极速模式）/ `0`=关闭（手动模式） |
| `bn` | 已绑定标志 | `1`=已绑定 / `0`=未绑定 |
| `v` | 固件版本号 | `3.32.2` |
| `m` | 设备模式 | `0`=汽车 / `1`=电瓶车 |
| `uc` | 设备当前解锁确认次数配置（回显验证下发是否落地） | `3` |
| `lc` | 设备当前锁车确认次数配置 | `5` |
| `ucnt` | 当前解锁进度计数 | `1` |
| `lcnt` | 当前锁车进度计数 | `0` |
| `th` | 当前区间：`0` 中性 / `1` 解锁区 / `2` 锁车区 | `1` |
| `ou` | **当前生效的解锁 RSSI 阈值**（owner 专属或全局，v3.36） | `-45` |
| `ol` | **当前生效的锁车 RSSI 阈值**（owner 专属或全局，v3.36） | `-65` |
| `fwsec` | 协议能力版本（1=原基线，2=授权体系 v1） | `2` |
| `t` | 芯片温度 (°C)，CH582M 内部 TSENSE 采样（5s 节流）；断连/未采时为 `null` 不出现 | `32.5` |

### 确认进度上报（方案 B，已落地）
FF02 已增加 `uc/lc/ucnt/lcnt/th` 字段，状态机在计数器变化时立即上报 + 1s 心跳保活，流量与采样间隔解耦。App 主界面据此显示「🔓 解锁进度 ucnt/uc」进度条，并在 `uc` 与 App 设置不一致时提示「配置可能未下发」。

> ⚠️ **已知偏差（待修 `[待完成]`）**：配置项 `uc/lc/阈值` 仅在 `cooldown` 变化时落盘（`KeyGo_SaveConfig` 仅 `cooldown_changed` 触发），只改 `uc` 不持久化 → 重启 revert 回默认值；App 重连也**未自动回推配置**。修复方向：① `if(cooldown_changed)` → `if(changed)`；② 对齐默认值（固件 `uc` 默认 → 3）；③ 补 App 重连自动回推。记录见 `docs/03-复盘与问题分析/KeyGo_v3.32.2_实现状态与待办核对.md`。

---

## 目录结构（当前真实文件）

```
KeyGo/
├── README.md                         # 本文件
├── app/BLE_Key_Go_App/               # uni-app 手机端工程（HBuilderX + Vite）
│   ├── pages/
│   │   ├── index/                    # 设备扫描 & 连接（第三快捷键模式驱动）
│   │   ├── control/                  # 手动解锁/锁车/第三键 + 底部双模式切换 + 顶部大卡图标
│   │   ├── config/                   # RSSI阈值/确认次数/Kalman参数/断连自动锁滑块
│   │   ├── help/                     # 帮助页（3步上手向导 + 绑定安全模型 + 模式说明，由 login.vue 迁来）
│   │   ├── login/                    # 遗留帮助页（已迁 help.vue，待清理 [待完成]）
│   │   └── main/                     # TabBar 容器
│   ├── stores/
│   │   ├── ble.js                    # ★ 核心状态机（~4100行，连接/重连/三种模式/会话鉴权）
│   │   ├── ble-binding.js            # 绑定层模块级状态（B 命名空间：_bindKey/_sessionSalt/waiter 等）
│   │   ├── theme.js                  # 主题（暗色/亮色）
│   │   └── user.js                   # 用户偏好（如进度条开关）
│   ├── utils/
│   │   ├── ble.js                    # uni BLE API 封装（startScan 二次过滤发现）
│   │   ├── ble-native.js             # 原生 BLE 调用封装
│   │   ├── command-queue.js          # GATT 写队列 enqueueWrite + isGattConflict（防 GATT_BUSY 抢通道）
│   │   ├── crypto.js                 # deriveBindKey（SHA256 KDF，与固件同源）
│   │   ├── firmware.js               # 固件版本比较 isFirmwareAtLeast（≥3.30.2 支持延迟回包）
│   │   ├── foreground-service.js     # Android 前台服务 + 亮屏广播
│   │   ├── geofence.js               # 极速模式 GPS 围栏（GEOFENCE_RADIUS 等）
│   │   ├── power-saver.js            # 手动模式逻辑（原「省电模式」）
│   │   ├── readable-errors.js        # 错误码 → 用户可读文案（ERROR_MSGS / cmdErrorMsg / throwError）
│   │   ├── debug-panel.js            # DEV 调试面板逻辑
│   │   ├── swipe.js                  # Tab 滑动管理
│   │   └── toast.js                  # 统一 toast（success/error）
│   ├── components/
│   │   ├── BindModal.vue             # ★ 绑定弹窗（首绑/接管/重新验证/改码/解绑/恢复出厂 + 诊断区 + 固件版本徽标）
│   │   ├── CustomTabBar.vue          # 自定义底部 Tab（Ⓠ 帮助）
│   │   └── DebugFloatPanel.vue       # 浮层调试面板
│   ├── nativeplugins/
│   │   └── Keygo-Foreground/         # 原生 Android 插件（前台扫描/重连/自动 AUTH）
│   │       ├── android/keygo-foreground.aar  # 编译产物（改 _build/source/*.java 需 Python 直写 + build_aar.bat）
│   │       ├── _build/source/        # Java 源（KeygoBleScanService / KeygoForegroundModule）
│   │       └── package.json          # 插件 manifest
│   ├── manifest.json                 # App 权限/原生插件声明（versionCode 改 .java 后须 +1）
│   ├── pages.json / main.js / App.vue / index.html / vite.config.js
│   └── static/                       # 图片资源
│
├── code/
│   ├── ESP32C3/                      # 早期原型（Arduino .ino，v1 ~ v3.13，已归档）
│   └── CH582M/CH582M_BLE_Slave/      # 当前主力固件（MounRiver Studio，v3.13+）
│       ├── APP/
│       │   ├── peripheral.c          # GAP/GATT 服务、广播、连接管理、断连自动锁闸门、未授权30s超时
│       │   ├── keygo_core.c          # 业务核心（RSSI状态机/Kalman/命令执行/绑定/双模式/RIDE双脉冲/配置持久化）
│       │   ├── bonding.c             # 绑定/配对（Just Works；GAPBOND_PERI_BONDING_ENABLED）
│       │   ├── crypto_sha256.c       # 自研 SHA256（WCH 库无 SHA/HMAC/HWRNG）
│       │   ├── peripheral_main.c     # main() + WWDG 软看门狗
│       │   └── include/
│       │       ├── appearance.h      # 广播/外观
│       │       ├── bonding.h
│       │       ├── crypto_sha256.h
│       │       ├── keygo_core.h      # 业务常量/偏移（MODE_ADDR 等）/ extern 声明
│       │       └── peripheral.h      # TMOS 事件位分配（★ 新增事件位必须核对无冲突）
│       ├── HAL/                       # LED、按键等硬件抽象
│       └── Profile/                   # Battery / DeviceInfo / GATT 服务实现
│
└── docs/                             # 设计文档 & 复盘（详见 docs/README.md 索引）
    ├── 01-项目规划与立项/            # 项目规划、立项书、硬件方案/供电驱动、市场对比
    ├── 02-技术方案与专项设计/        # 授权体系 v1、无App模式、安全加固规划、智能重连、双模式、各专项
    ├── 03-复盘与问题分析/            # 版本总结、专题分析、温度/功耗与未来方向、BLE 连接/扫描复盘
    ├── 自己看/                       # 离线打包、原生调试、UI 描述对照表等实操记录（不构成设计决策）
    ├── git协作.md                    # 团队分支模型与首次 push 约定（顶层，协作类）
    └── Codex接手指南_已完成与待办.md  # 给接手 AI/同学的上文速览（顶层，接手类）
```

> 📁 docs 已按主题归入上述子目录，完整索引见 [`docs/README.md`](docs/README.md)。

---

## 开发 & 运行

### 固件

**当前平台：CH582M**

1. 安装 **MounRiver Studio**（WCH 官方 IDE）
2. 打开 `code/CH582M/CH582M_BLE_Slave/CH582M_BLE_Slave.wvproj`
3. 编译 → 通过 WCH-Link 烧录到 CH582M 开发板
4. 上电后开始 BLE 广播，设备名 `KeyGo-XXXXXX`

关键硬件：CH582M（RISC-V 60MHz, BLE 5.0），18650 锂电池供电，继电器模块接管原车钥匙按键。

**早期平台：ESP32C3（已归档）**

- 目录：`code/ESP32C3/`，Arduino `.ino` 工程，v1 ~ v3.13 的完整演进保留了 12 个版本快照
- 用 Arduino IDE 打开 `.ino` 文件即可编译烧录
- ESP32C3 完成了全部核心功能的原型验证，v3.13 后主线迁移到 CH582M

**计划移植**：nRF528xx（Nordic nRF5 SDK / Zephyr）等其他 BLE MCU/SOC `[待完成]`，欢迎贡献。

### App

1. 用 **HBuilderX** 打开 `app/BLE_Key_Go_App`
2. 运行到 Android 真机（需开启开发者模式 + USB 调试）
3. 原生插件（前台服务）**必须用「自定义调试基座」或「离线打包」**构建，标准基座不生效
4. 授予蓝牙、定位、通知权限
5. 打开 App → 扫描 KeyGo 设备 → 连接 → 控制 / 配置 / 绑定

> ⚠️ **原生插件改动铁律**：改 `_build/source/*.java` 重编 `android/keygo-foreground.aar` 后，必须 ① `manifest.json` 的 `versionCode` +1；② 重新制作自定义调试基座并重装；③ 标准基座不支持原生插件。否则 HBuilderX 缓存旧基座，新 aar 永远上不了手机。

### 快速自检

1. 固件上电，手机蓝牙扫描应能看到 `KeyGo-XXXXXX`
2. App 连接成功后，`FF02` 应持续推送 RSSI 状态 JSON
3. 靠近/远离设备，RSSI 应相应变化（越近数值越大，如 -30 > -60）
4. 绑定后断连重连，应在「保护范围内」自动完成 AUTH（诊断区显示「已通过 AUTH」）

---

## 版本演进

```
v1    初版：单 BLE 栈 + 简单 RSSI 阈值判断（ESP32C3 / Arduino，连接不稳定）
v2    双栈重构：NimBLE / Bluedroid 双栈 + 断连锁车兜底（ESP32C3）
v2.1  合并版：Kalman 滤波 + RSSI 尖峰丢弃 + 滞后状态机（ESP32C3）
v2.2  MAC 白名单 + 设备唯一序列号 + 物理按键配对（ESP32C3）
v3.13 迁移到 CH582M 平台，18650 电池电压检测上线 ← 平台切换点
v3.14 电池监测完善（GATT Read 电量 + BLE Notify 电压）
v3.16 软看门狗（WWDG 2.5s 超时复位，防固件卡死）
v3.22 电池优化豁免引导（对抗 Android 系统后台查杀）
v3.23 智能重连三种模式框架（极速/舒适/省电）
  └─ v1.0.1 舒适模式重构：定时轮询 → 亮屏触发，零后台 polling
v3.24 三种重连模式更名（省电 → 手动）+ 固件自动锁开关（autolock）
v3.31 App：RSSI 显示层节流联动 + 回前台保留旧值 + 确认次数→时间换算；FF02 上报确认进度（方案B）
v3.32.0 安全：先配对再 BIND + HMAC 挑战应答恢复（commit 77c6806）
v3.32.1 GATT 加密门控（已回退，待 Phase 4 重做）
v3.32.2-fix 手动模式断连不自动锁 + 帮助页重构(login→help, 合并上手向导)（commit 6a61787）
  └─ workbuddy 分支增量：①手动模式重启后自动验证绑定 ②手动模式禁用断连自动锁(UI) ③绑定页固件版本文案修正 + 主按钮禁用态美化
v3.33.x 无App模式探针 + 主固件观测点预埋（[OBS] 连/断/加密）
v3.34.0 无App模式：主固件 HID 被动锚点，OS 加密重连 + RSSI 自动解锁（设备级舒适进入）
v3.36.0 授权体系 v1：per-phone 身份(phoneKey=HMAC(gk,phoneId)) + per-phone RSSI 阈值跟随(RSSISET)；
         SNV 扩容至 8 owner 互不互踢；fwsec=2；AUTH 格式升级；FF02 增加 ou/ol/fwsec
```

---

## 下阶段规划（Next Phase）

> 当前（workbuddy 分支，主线 `main`）已实现：**授权体系 v1（per-phone + RSSI 跟随）+ 无App模式 + 三模式重连 + 双模式**。下一阶段聚焦加密门控与撤销闭环。

### Phase 4：GATT 加密门控（重做） `[待完成]`
- 重做 v3.32.1 被回退的 FF01/FF02-CCCD/FF03 加密门控，修复「配对后补订 FF02 订阅时序」问题
- **UNBIND 联动删 SMP 配对（已落地，自定义基座）**（收口无App模式撤销缺口）：App 解绑时联动原生 `removeBond` 删除手机端系统蓝牙配对，配合固件侧 `Bonding_ClearSnvBonds` 清设备 SNV LTK，两端合力使被撤销手机即便无App模式也无法自动解锁
- 认证配对 Passkey = 绑定码（可选收口「已配对者 RSSI 解锁」缺口）：需先验证 CH582 SMP 支持「无头设备 + 固定 passcode + mitm=1 不回退 Just Works」

### 其他待办 `[待完成]`
- 配置项 `uc/lc/阈值` 持久化修复（仅 cooldown 变化才落盘的问题）+ App 重连自动回推
- `dormant` 跨重启持久化（手动断开 = 跨重启都不自动连）
- 绑定码强制改、多管理员、设备模式管理员锁定、临时授权
- AUTH 失败限流
- iOS 支持（前台服务/亮屏广播原生插件仅 Android）
- nRF528xx 移植
- `login/` 遗留页面清理

---

## 已知限制

- **仅支持 Android**：uni-app 可编译 iOS 版本，但前台服务、亮屏广播等原生插件仅 Android 实现
- **BLE 范围约 10-15m**：实际受环境、手机蓝牙芯片影响，RSSI 波动大（墙壁/人体遮挡）
- **深度管控机型**：荣耀 MagicOS、小米 MIUI 锁屏 2h+ 后即使有前台服务也可能被系统杀死
- **RSSI 不是精确距离**：同一距离不同角度 RSSI 可差 10-15dBm，依赖 Kalman 滤波 + 连续确认次数来降低误判
- **GPS 围栏依赖 GMS**：华为/部分荣耀设备 Google Geofence 不可用，极速模式自动降级
- **无App模式撤销缺口**：仅 `UNBIND` 不够，需同时在系统蓝牙忽略设备（规划中由固件联动删除 SMP 配对）
- **仅作学习研究**：未经车厂安全认证，请勿用于实际车辆

---

## 相关文档

完整文档已按主题分类，详见 [`docs/README.md`](docs/README.md) 总索引。精选：

- **授权体系 v1（per-phone + RSSI 跟随）**：`docs/02-技术方案与专项设计/授权体系v1_per-phone与RSSI阈值跟随.md`
- **无App模式（HID 改造）**：`docs/02-技术方案与专项设计/KeyGo_无App模式_主固件HID改造分步计划.md`
- **实现状态台账**：`docs/03-复盘与问题分析/KeyGo_v3.32.2_实现状态与待办核对.md`（✅已落地 / 🔲未实现 / ⚠️已知偏差）
- **智能重连**：`docs/02-技术方案与专项设计/KeyGo_v3.23_智能重连模式设计v1.0.1.md`
- **安全加固规划**：`docs/02-技术方案与专项设计/KeyGo_安全加固与加密规划_v1.0.0.md`
- **加密绑定优化**：`docs/02-技术方案与专项设计/加密绑定优化方案设计.md`
- **已验证事实**：`docs/03-复盘与问题分析/已验证事实_安全模型实测与纠偏.md`
- **Codex 接手指南**：`docs/Codex接手指南_已完成与待办.md`
- **双模式设计**：`docs/02-技术方案与专项设计/Phase2_UI打磨与双模式兼容设计.md`
- **后台保活**：`docs/03-复盘与问题分析/KeyGo_v3.22_电池优化豁免机制详解.md`
- **BLE 稳定性**：`docs/03-复盘与问题分析/2-连接与扫描复盘/BLE连接稳定性问题复盘_v2.2.md` / `docs/03-复盘与问题分析/2-连接与扫描复盘/BLE扫描_设备发现机制复盘_v2.2.md`
- **硬件**：`docs/01-项目规划与立项/BLE车钥匙_舒适进入_硬件方案设计.md`
- **离线打包实操**：`docs/自己看/离线打包与AndroidStudio原生调试指南.md`
- **硬件供电与驱动设计**：`docs/01-项目规划与立项/3-硬件/KeyGo_硬件供电与驱动设计.md`
- **温度/电压功耗分析与未来方向（含 BLE 6.0）**：`docs/03-复盘与问题分析/3-安全模型实测/温度电压采集与功耗分析_未来方向_BLE6.md`
- **UI 描述对照表（大白话↔CSS 速查）**：`docs/自己看/UI描述对照表.md`

---

## 许可证

本项目仅供学习与研究使用。商业用途请联系作者。
