# Phase 2 · UI 打磨与双模式兼容设计（v1.0）

> 状态：代码已落地（2026-07-13 写完，固件待烧录 / App 待联调）
> 日期：2026-07-13
> 范围：错误提示友好化 + 绑定流程引导（帮助页）+ 汽车/电瓶车双模式兼容
> 关联文档：`KeyGo_v3.23_智能重连模式设计v1.0.1.md`、`stores/ble.js` 顶部 TOC

---

## 1. 背景与目标

KeyGo 当前命令集为「解锁 / 锁车 / 后备箱」，面向**汽车**场景。但大量**电瓶车**也适用本设备，其常见遥控手势为「解锁 / 锁车 / 双击骑行」。两套场景的前两个动作完全重合，差异仅在第三个键的语义。

**目标**：让同一设备兼容汽车与电瓶车两类场景，App UI 随设备模式自适应渲染，并借 Phase 2 顺手完成错误提示友好化与绑定流程向导化。

### 1.1 已确认的关键决策（来自 2026-07-13 讨论）

| 议题 | 决策 |
|---|---|
| 模式存储 / 选择 | **DataFlash + App 首绑时选择**（零硬件成本，可后续改） |
| 电瓶车「骑行」触发 | **App 按钮发 `RIDE` 命令**（与汽车后备箱同构） |
| 模式可否更改 | **当前 = App 内可改**；「首绑手机(管理员)才能改」列为后续加固 TODO |
| 电瓶车「骑行」具体驱动 | 固件输出**「快速双击」脉冲**（模拟电瓶车遥控双击启动骑行） |
| 首启默认模式 | **`car`**（MODE_ADDR 未初始化时） |
| 模式上报方式 | **复用现有短键状态 JSON**，新增 `m` 字段（最省事） |

---

## 2. 设备模式模型

- **枚举**：`car = 0` / `ebike = 1`
- **权威源**：设备每次状态上报携带 `m` 字段；App 以设备上报为准。
- **本地兜底**：App 按序列号缓存模式（`keygo_mode_<serial>`），用于「连接前就能渲染正确 UI」；**连接后设备 `m` 覆盖本地缓存**。
- **默认**：`MODE_ADDR` 未初始化（全 0xFF）→ 视为 `car`。
- **可改**：设置页切换 → 发 `MODE:` 配置命令写 DataFlash → 设备下次状态包带回新 `m`。

### 2.1 DataFlash 地址约定（沿用现有基准）

| 用途 | 偏移（相对 DataFlash 基址 0x70000） | 物理地址 |
|---|---|---|
| CFG | 0x7000 | 0x77000 |
| BOND | 0x7100 | 0x77100 |
| BINDCODE | 0x7200 | 0x77200 |
| **MODE（新增）** | **0x7300** | **0x77300** |

> ⚠ 注意：WCH DataFlash 的 StartAddr 是**相对基址的偏移**，非物理地址（历史坑见长期记忆「DataFlash 地址基准错误」）。

---

## 3. 接口约定

### 3.1 状态 JSON 扩展（复用短键）

现有格式（`keygo_core.c` 内构造，`STATUS_JSON_MAX_LEN = 200` 仍有余量）：

```json
{"c":1,"st":"LOCKED","r":-40,"f":-42,"d2":"我的车"}
```

新增 `m` 字段后：

```json
{"c":1,"st":"LOCKED","r":-40,"f":-42,"d2":"我的车","m":1}
```

- `m=0` → car；`m=1` → ebike
- 固件构造位置：`code/CH582M/CH582M_BLE_Slave/APP/keygo_core.c` 状态构造函数（缓冲区 `json[STATUS_JSON_MAX_LEN]`）
- App 解析位置：`stores/ble.js` → `_parseSingleStatus`（section 10，约 L2652），新增 `if (data.m !== undefined) this.deviceMode = data.m ? 'ebike' : 'car'`

### 3.2 新增配置命令 `MODE`

| 命令 | 行为 |
|---|---|
| `MODE:car` | 写 `MODE_ADDR = 0`，回 STATUS 带 `m:0` |
| `MODE:ebike` | 写 `MODE_ADDR = 1`，回 STATUS 带 `m:1` |

- **权限**：走 FF03（已受 GATT 加密门控 v3.32.1 + 绑定信任列表保护），未配对/未绑定设备不可调用。
- **App 调用**：`sendConfig('MODE:ebike')`（复用现有配置下发通道 `utils/ble.js` + 写队列）。

### 3.3 新增控制命令 `RIDE`

- **触发**：电瓶车模式下第三键点击 → App 发 `RIDE`（`command-queue` / `sendCommand` 增加合法命令分支）。
- **固件行为（ebike）**：驱动**「快速双击」脉冲**——在输出控制线上产生两次快速通断（模拟电瓶车原遥控「双击启动骑行」手势）。具体脉冲参数（单次宽度 / 间隔）由固件定，建议 `2 × 100ms @ 间隔 150ms`（待固件确认）。
- **固件行为（car）**：`RIDE` 在 car 模式无意义 → 回 `DENY:NOT_SUPPORTED`（或静默忽略），App 对应提示「当前模式不支持该操作」。
- **通道**：与 `UNLOCK/LOCK/TRUNK` 同（FF03 + 签名）。
- **状态**：骑行若是一次性动作、无持续状态，则**不产生新 `st`**；若需「骑行中」常显，则 `st` 增 `RIDE` 终态（见 §7 风险点，待定）。

### 3.4 命令集对照

| 键位 | 汽车（car） | 电瓶车（ebike） |
|---|---|---|
| 键 1 | UNLOCK（解锁） | UNLOCK（解锁） |
| 键 2 | LOCK（锁车） | LOCK（锁车） |
| 键 3 | TRUNK（后备箱） | RIDE（骑行 / 快速双击） |

---

## 4. App 改动清单

### 4.1 `stores/ble.js`
- 新增响应式 state：`deviceMode`（默认 `'car'`）。
- `_parseSingleStatus`：解析 `data.m` → `deviceMode`（权威，覆盖本地缓存）。
- 新增 action `setDeviceMode(mode)`：经 `sendConfig('MODE:' + mode)` 下发 → 乐观更新 `deviceMode` → 写本地缓存 `keygo_mode_<serial>`。
- 连接建立后：先用本地缓存渲染，收到设备 `m` 后校正。
- `command-queue` / `sendCommand`：将 `'RIDE'` 纳入合法控制命令（与 `UNLOCK/LOCK/TRUNK` 同处理，受 `_waitCmdResult` 成功判定 + `CMD:FAIL`/`DENY` 拒绝逻辑保护）。

### 4.2 `pages/control/control.vue`（控制页）
- 第三键配置由 `deviceMode` 计算：
  - `car` → 文案「后备箱」、图标、发 `TRUNK`
  - `ebike` → 文案「骑行」、图标、发 `RIDE`
- 状态文字「已解锁 / 已锁车」两模式通用；若固件支持 `st=RIDE`，ebike 可显「骑行中」。
- 前两键（解锁/锁车）布局两模式一致，仅第三键语义/图标/命令随模式变。

### 4.3 `pages/help/help.vue`（**新建**）
- **绑定流程向导（原 Phase 2 ②，移入帮助页）**，6 步：
  1. 开蓝牙 + 定位（带系统设置跳转按钮）
  2. 扫描并选择设备
  3. **选模式：汽车 / 电瓶车**（写入 `MODE`）
  4. 输入绑定码（默认 `123456`，附说明与「一键默认码绑定」兜底）
  5. 自动配对 + AUTH（已有逻辑）
  6. 完成，返回控制页
- **模式说明**：car vs ebike 差异图解（三键语义对照表）。
- **错误排查**：列出 `readable-errors.js` 各错误码含义 + 处理建议（可操作指引，而非孤立 toast）。
- 注册 `pages.json` 路由，并在 `main` 页提供「帮助」入口。

### 4.4 `utils/readable-errors.js`（扩展）
- 新增绑定类 / 模式类错误码与文案：
  - `BIND_FAIL`：绑定失败，请确认绑定码或重试
  - `PAIR_REQUIRED`：请先在系统蓝牙中完成配对
  - `MODE_SET_FAIL`：模式切换失败，请重试
  - `NOT_SUPPORTED`：当前模式不支持该操作
- 绑定向导内联引导：出错时给出**可操作步骤**，而非只弹 toast。

### 4.5 设置页（`pages/config`，模式切换）
- 新增「设备模式」单选（汽车 / 电瓶车）。
- 调用 `setDeviceMode` → `MODE:` 命令；切换后提示「已切换，设备响应后生效」。

---

## 5. 固件改动清单（`code/CH582M`）

- `keygo_core.c`：
  - 新增宏 `MODE_ADDR`（偏移 `0x7300`）。
  - 启动读 `MODE_ADDR` → `g_deviceMode`（默认 `car`）。
  - 状态 JSON 构造追加 `"m":g_deviceMode`。
  - 新增 `MODE:car` / `MODE:ebike` 配置命令解析 → 写 `MODE_ADDR` + 回 STATUS。
  - 新增 `RIDE` 控制命令解析：ebike → 输出「快速双击」脉冲；car → 回 `DENY:NOT_SUPPORTED`。
  - （可选）`st` 增 `RIDE` 终态（取决于 §7 决策）。
- 权限：MODE / RIDE 走 FF03，已受 v3.32.1 GATT 加密门控 + 绑定保护，无需额外处理。
- **须重新编译烧录**（命令解析与状态字段为编译期逻辑）。

---

## 6. 验收标准

### 固件
- [ ] 默认模式 `car`；`MODE_ADDR` 未初始化启动为 `car`。
- [ ] 收到 `MODE:ebike` 写 DataFlash，**断电重启仍为 ebike**。
- [ ] 状态包含 `m` 字段且与当前模式一致。
- [ ] ebike 下 `RIDE` 驱动「快速双击」脉冲；car 下 `RIDE` 被拒（`DENY:NOT_SUPPORTED`）。
- [ ] `MODE` / `RIDE` 需配对 + 绑定，未授权设备无法调用。

### App
- [ ] 连接后 `deviceMode` 由设备 `m` 驱动；重连后 UI 正确渲染对应模式。
- [ ] `car` 模式：三键 = 解锁 / 锁车 / 后备箱。
- [ ] `ebike` 模式：三键 = 解锁 / 锁车 / 骑行，骑行发 `RIDE`。
- [ ] 设置页切模式 → 设备响应且**持久化**（重启后不变）。
- [ ] 帮助页含完整绑定向导（6 步）+ 模式说明 + 错误排查。
- [ ] 绑定错误给出内联可操作引导。
- [ ] 错误码文案覆盖绑定 / 模式类（`readable-errors.js` 扩展项）。

---

## 7. 风险与待确认

1. **RIDE 脉冲参数**：「快速双击」的单次宽度 / 间隔需固件定（建议 `2×100ms @ 150ms`）。
2. **RIDE 是否产生独立状态**：若仅一次性动作，则无 `st=RIDE`，UI 不显「骑行中」；若需常显，固件增 `st=RIDE`。影响 UI 设计，待定。
3. **模式切换竞态**：App 乐观更新 `deviceMode` vs 设备回包，以设备 `m` 为准（回包到达即校正）。
4. **帮助页入口**：置于 `main` 页（建议），需确认入口位置与图标。
5. **老设备兼容**：既有设备 DataFlash 无 `MODE_ADDR` → 默认 `car`，完全兼容，无需迁移。
6. **管理员锁定（后续 TODO）**：首绑手机才能改模式，需固件记录 binder 标识（当前仅存 `bindKey`/信任列表，未存 binder 身份），列为后续加固。

---

## 8. 实施顺序建议

1. **固件**：`MODE_ADDR` + 状态 `m` + `MODE` 命令 + `RIDE` 命令（含烧录真机验证）。
2. **App store**：`deviceMode` 解析 + `setDeviceMode` + 本地缓存。
3. **control.vue**：模式驱动按钮（文案 / 图标 / 命令）。
4. **readable-errors** 扩展 + 绑定向导内联引导。
5. **帮助页** + 绑定流程向导（6 步）+ 模式说明 + 错误排查。
6. **设置页**模式切换入口。
7. **真机联调**验收（car / ebike 各一轮）。
